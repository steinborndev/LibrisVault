import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
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
import { createValidator } from '../src/pipeline/validator.js'
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
  // The validator the writing routes check their own work with (see the rejoin tests below).
  const full: AppContext = { ...ctx, validate: createValidator(vaultRoot), commitMutex: new Mutex() }
  return buildServer(validation === undefined ? full : { ...full, validation })
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
    const body = res.json() as { findings: unknown[]; byRule: unknown[]; total: number; guidance: Record<string, unknown> }
    expect(body.findings).toEqual([])
    expect(body.byRule).toEqual([])
    expect(body.total).toBe(0)
    // The rule tables ride along even on an empty list: the screen renders "nothing standing"
    // from the same response it renders rows from.
    expect(Object.keys(body.guidance).length).toBeGreaterThan(0)
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

/**
 * `POST /api/v1/maintenance/rejoin-links` - the one writing path with no model in it, and,
 * until 2026-09-21, the one that reported nothing about what it had done. Every other run
 * records into the standing list afterwards; this one wrote to the vault and left the list
 * exactly as stale as it found it.
 */
describe('POST /api/v1/maintenance/rejoin-links', () => {
  const page = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(vaultRoot, rel)), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, rel), body)
  }

  /** A vault with one wrapped link in it, in a real repo: the repair commits. */
  const seedVault = (): void => {
    page('wiki/concepts/Carbon Cycle.md', '---\ntype: concept\ntitle: "Carbon Cycle"\n---\n# Carbon Cycle\n\nWhole.\n')
    page(
      'wiki/concepts/Proxy Calibration.md',
      '---\ntype: concept\ntitle: "Proxy Calibration"\n---\n# Proxy Calibration\n\nUnder [[Carbon\nCycle]].\n',
    )
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', vaultRoot, ...args], { stdio: 'pipe' })
    }
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('add', '-A')
    git('commit', '-q', '-m', 'seed')
  }

  it('records what it finds after writing, so a repair shows on the list', async () => {
    const validation = new ValidationStore(db)
    seedVault()
    app = await build(validation)

    // Before: the standing list knows nothing, and the page carries a wrapped link.
    expect(validation.list({ limit: 10 })).toHaveLength(0)
    const res = await app.inject({ method: 'POST', url: '/api/v1/maintenance/rejoin-links' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ fixed: 1 })

    // After: the page was checked. The wrapped link is joined so nothing records it, and the
    // OTHER defects that page carries are on the list - which is what proves a check ran at
    // all. Without the check the list stays empty and the repair is invisible.
    const rules = validation.list({ limit: 50 }).map((f) => f.rule)
    expect(rules).not.toContain('wrapped-link')
    expect(rules).toContain('page-schema')
    expect(rules).toContain('frontmatter')
    expect(fs.readFileSync(path.join(vaultRoot, 'wiki/concepts/Proxy Calibration.md'), 'utf8')).toContain('[[Carbon Cycle]]')
  })

  it('a dry run records nothing, because it changed nothing', async () => {
    const validation = new ValidationStore(db)
    seedVault()
    app = await build(validation)
    const res = await app.inject({ method: 'POST', url: '/api/v1/maintenance/rejoin-links?dry=1' })
    expect(res.json()).toMatchObject({ fixed: 1, commit: null })
    expect(validation.list({ limit: 10 })).toHaveLength(0)
  })
})
