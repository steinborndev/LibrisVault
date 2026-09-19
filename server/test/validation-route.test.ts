import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { buildServer, type AppContext } from '../src/api/server.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { ValidationStore } from '../src/db/validation.js'
import type { Config } from '../src/config.js'

/**
 * `GET /api/v1/validation` - the standing defect list (A9, 5.2).
 *
 * Base product on purpose: the validator runs for every ingest whether or not the research
 * agents exist, so this route answers with `AGENTS_ENABLED` off. The flag-off suite has it in
 * its control group; this file is about what it returns.
 */
let db: Db
let vaultRoot: string
let app: FastifyInstance | undefined

const build = async (validation: ValidationStore | undefined = undefined): Promise<FastifyInstance> => {
  const store = new JobStore(db)
  const events = new EventBus()
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
      authMode: 'local-single-user',
    },
  }
  const queue = new IngestQueue({
    store,
    vaultRoot,
    auth: null,
    events,
    refreshHotCache: async () => 'noop',
    runIngest: async () => {
      throw new Error('not reached')
    },
  })
  const ctx: AppContext = {
    config,
    store,
    chat: new ChatStore(db),
    queue,
    events,
    maintenance: new MaintenanceRunner({
      vaultRoot,
      auth: null,
      events,
      commitMutex: new Mutex(),
      runAgent: async () => {
        throw new Error('not reached')
      },
      commit: async () => ({ committed: false, hash: '', committedPages: [] }),
    }),
    logger: false,
  }
  return buildServer(validation === undefined ? ctx : { ...ctx, validation })
}

beforeEach(() => {
  db = openDb(MEMORY_DB)
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'valroute-'))
  fs.mkdirSync(path.join(vaultRoot, 'wiki'), { recursive: true })
})

afterEach(async () => {
  await app?.close()
  app = undefined
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

describe('GET /api/v1/validation', () => {
  it('answers with an empty list when nothing has been recorded', async () => {
    app = await build(new ValidationStore(db))
    const res = await app.inject({ method: 'GET', url: '/api/v1/validation' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ findings: [], byRule: [], total: 0 })
  })

  it('answers 200 rather than 404 when the store is not wired at all', async () => {
    // A screen that asks for this must not see a 404 on a service built without the store -
    // the empty list is the honest answer, and hard rule 8's failure mode is exactly the 404.
    app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/v1/validation' })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ total: number }>().total).toBe(0)
  })

  it('returns the standing findings, loudest first, with their rule counts', async () => {
    const validation = new ValidationStore(db)
    validation.record([{ rule: 'em-dash', path: 'wiki/a.md', message: 'three of them' }], 'job-1')
    validation.record([{ rule: 'em-dash', path: 'wiki/a.md', message: 'three of them' }], 'job-2')
    validation.record([{ rule: 'dead-link', path: 'wiki/b.md', message: 'a link to nowhere' }], 'job-2')
    app = await build(validation)

    const body = await app
      .inject({ method: 'GET', url: '/api/v1/validation' })
      .then((r) => r.json<{ findings: Array<{ rule: string; count: number }>; byRule: unknown[]; total: number }>())
    expect(body.total).toBe(2)
    expect(body.findings.map((f) => f.rule)).toEqual(['em-dash', 'dead-link'])
    expect(body.findings[0]?.count).toBe(2)
    expect(body.byRule).toEqual([
      { rule: 'em-dash', findings: 1, occurrences: 2 },
      { rule: 'dead-link', findings: 1, occurrences: 1 },
    ])
  })

  it('filters by rule and bounds the page size', async () => {
    const validation = new ValidationStore(db)
    for (let i = 0; i < 5; i++) {
      validation.record([{ rule: i % 2 === 0 ? 'em-dash' : 'dead-link', path: `wiki/${i}.md`, message: 'x' }], 'job')
    }
    app = await build(validation)
    const filtered = await app
      .inject({ method: 'GET', url: '/api/v1/validation?rule=dead-link' })
      .then((r) => r.json<{ findings: Array<{ rule: string }> }>())
    expect(filtered.findings.map((f) => f.rule)).toEqual(['dead-link', 'dead-link'])

    const limited = await app
      .inject({ method: 'GET', url: '/api/v1/validation?limit=1' })
      .then((r) => r.json<{ findings: unknown[] }>())
    expect(limited.findings).toHaveLength(1)
  })
})
