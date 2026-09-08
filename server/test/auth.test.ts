/**
 * The HTTP auth middleware (src/api/auth.ts, SPEC.md section 9).
 *
 * Written 2026-09-08, when a review found it had no test at all: the one file whose failure
 * mode is "everything is open" was the one nobody was checking. Only `assertBindAllowed` was
 * covered, and that is the config's guard, not the middleware's.
 *
 * Two mechanisms live here and both are load-bearing. The bearer check is the sole barrier
 * that justifies a non-loopback bind. The Origin check is what stands between a hostile web
 * page and a state-changing request to 127.0.0.1 in `local-single-user` mode, where there is
 * no credential at all - and a multipart POST is CORS-"simple", so the browser sends it
 * without asking permission first.
 *
 * Requests go through `app.inject` rather than a socket: the hook is what is under test, and
 * inject runs the whole request lifecycle including it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { SettingsStore } from '../src/db/settings.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer } from '../src/api/server.js'
import type { Config, HttpAuthMode } from '../src/config.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/index.js'

const NO_TOOLS: ToolAvailability = {
  pdftotext: false,
  pdfinfo: false,
  ocrmypdf: false,
  pandoc: false,
  python3: false,
  exiftool: false,
  defuddle: false,
  ytDlp: false,
  deno: false,
}

const TOKEN = 'a-long-enough-secret-token'

describe('the HTTP auth middleware', () => {
  let db: Db
  let vaultRoot: string
  let app: FastifyInstance | undefined

  const build = async (authMode: HttpAuthMode, authToken?: string): Promise<FastifyInstance> => {
    const events = new EventBus()
    const store = new JobStore(db, events)
    const config: Config = {
      vaultRoot,
      obsidianVaultName: 'vault',
      auth: null,
      telegram: null,
      demoMode: false,
      server: {
        host: '127.0.0.1',
        port: 0,
        watchFolder: path.join(vaultRoot, 'inbox'),
        maxUploadBytes: 1024 * 1024,
        authMode,
        ...(authToken !== undefined ? { authToken } : {}),
      },
    }
    const queue = new IngestQueue({
      store,
      vaultRoot,
      auth: null,
      events,
      detectToolsFn: async () => NO_TOOLS,
      commit: async () => ({ committed: false, hash: '', committedPages: [] }),
      refreshHotCache: async () => 'noop',
      runIngest: async () => {
        throw new Error('not reached')
      },
    })
    const maintenance = new MaintenanceRunner({
      vaultRoot,
      auth: null,
      events,
      commitMutex: new Mutex(),
      runAgent: async () => {
        throw new Error('not reached')
      },
      commit: async () => ({ committed: false, hash: '', committedPages: [] }),
    })
    return buildServer({
      config,
      store,
      chat: new ChatStore(db),
      queue,
      events,
      maintenance,
      settings: new SettingsStore(db),
      autoCommit: () => false,
      logger: false,
    })
  }

  beforeEach(() => {
    db = openDb(MEMORY_DB)
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki'), { recursive: true })
  })
  afterEach(async () => {
    await app?.close()
    app = undefined
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  describe('token mode', () => {
    it('refuses a request with no bearer, a wrong one, or an empty one', async () => {
      app = await build('token', TOKEN)
      const unauthorized = async (headers: Record<string, string>): Promise<number> =>
        (await app!.inject({ method: 'GET', url: '/api/v1/stats', headers })).statusCode
      expect(await unauthorized({})).toBe(401)
      expect(await unauthorized({ authorization: `Bearer ${TOKEN}x` })).toBe(401)
      expect(await unauthorized({ authorization: 'Bearer ' })).toBe(401)
      // Not a bearer at all: the scheme has to match, so basic auth is not a way in.
      expect(await unauthorized({ authorization: `Basic ${TOKEN}` })).toBe(401)
      // A token of the right length but the wrong bytes must not pass either - the compare
      // hashes both sides, so equal length is not equal value.
      expect(await unauthorized({ authorization: `Bearer ${'x'.repeat(TOKEN.length)}` })).toBe(401)
    })

    it('lets the right token through, by either header', async () => {
      app = await build('token', TOKEN)
      const ok = await app.inject({ method: 'GET', url: '/api/v1/stats', headers: { authorization: `Bearer ${TOKEN}` } })
      expect(ok.statusCode).toBe(200)
      // `x-auth-token` is the alternative for clients that cannot set Authorization.
      const alt = await app.inject({ method: 'GET', url: '/api/v1/stats', headers: { 'x-auth-token': TOKEN } })
      expect(alt.statusCode).toBe(200)
    })

    it('leaves the health check public, because systemd probes it without a credential', async () => {
      app = await build('token', TOKEN)
      expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200)
      // Exact match only: a path that merely starts with it is not public.
      expect((await app.inject({ method: 'GET', url: '/api/v1/health/../stats' })).statusCode).toBe(401)
      // The query string is stripped before the comparison, so `?x=1` does not close the probe.
      expect((await app.inject({ method: 'GET', url: '/api/v1/health?probe=1' })).statusCode).toBe(200)
    })
  })

  describe('local-single-user mode', () => {
    it('passes every read through without a credential', async () => {
      app = await build('local-single-user')
      expect((await app.inject({ method: 'GET', url: '/api/v1/stats' })).statusCode).toBe(200)
      expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200)
    })
  })

  /*
   * The CSRF guard. It runs in BOTH modes and before the token check, because the threat it
   * answers is a browser that already has whatever credential the user has.
   */
  describe('the cross-origin guard', () => {
    const post = async (headers: Record<string, string>): Promise<number> =>
      (await app!.inject({ method: 'POST', url: '/api/v1/jobs', headers, payload: { url: 'https://example.com/a' } })).statusCode

    it('rejects a state-changing request from a foreign origin', async () => {
      app = await build('local-single-user')
      expect(await post({ origin: 'https://evil.example', host: 'localhost:8420' })).toBe(403)
      // `Origin: null` is what a sandboxed iframe and some redirects send: foreign, not absent.
      expect(await post({ origin: 'null', host: 'localhost:8420' })).toBe(403)
      // Not a URL at all.
      expect(await post({ origin: 'not a url', host: 'localhost:8420' })).toBe(403)
    })

    it('allows the SPA, any loopback origin, and clients that send none', async () => {
      app = await build('local-single-user')
      const notForbidden = async (headers: Record<string, string>): Promise<void> => {
        expect(await post(headers)).not.toBe(403)
      }
      // Same-origin: the SPA's own requests.
      await notForbidden({ origin: 'http://localhost:8420', host: 'localhost:8420' })
      // The Vite dev proxy forwards the browser's origin while rewriting Host; a hostile
      // website can never present a loopback origin, so any port of it is allowed.
      await notForbidden({ origin: 'http://localhost:5173', host: 'localhost:8420' })
      await notForbidden({ origin: 'http://127.0.0.1:9999', host: 'localhost:8420' })
      // curl and the systemd probe send no Origin at all.
      await notForbidden({ host: 'localhost:8420' })
    })

    it('does not stand in front of reads, which a browser may make cross-origin anyway', async () => {
      app = await build('local-single-user')
      const read = await app.inject({ method: 'GET', url: '/api/v1/stats', headers: { origin: 'https://evil.example' } })
      expect(read.statusCode).toBe(200)
    })

    it('runs before the token check, so a foreign origin is 403 and not 401', async () => {
      app = await build('token', TOKEN)
      expect(await post({ origin: 'https://evil.example', host: 'localhost:8420' })).toBe(403)
    })
  })
})
