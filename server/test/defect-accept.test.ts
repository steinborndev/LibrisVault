import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { ValidationStore } from '../src/db/validation.js'
import { renderStandingDefects } from '../src/pipeline/maintenance.js'
import { recheckStanding } from '../src/pipeline/standing-recheck.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { buildServer, type AppContext } from '../src/api/server.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import type { Config } from '../src/config.js'

/**
 * Accepting a defect, with a reason (TASKS-DEFECT-PATHS phase 2).
 *
 * A list that cannot be emptied becomes the 406 job-log lines again, one layer up. Six of the
 * nine standing rules need a judgement, and for most of those the judgement is "this is fine" -
 * a tag that really does name one page, two pages that really are different. Without a way to
 * say so, the list only ever grows.
 *
 * An accept is PERMANENT and needs a REASON. A snooze only postpones the reading, and an accept
 * without a reason is indistinguishable from neglect six months on.
 */
let db: Db
let store: ValidationStore

const finding = { rule: 'tag-singleton', path: 'wiki/concepts/a.md', message: 'tag "solo" names exactly one page' }

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new ValidationStore(db)
})

describe('the accept', () => {
  it('takes a finding off the list and keeps its reason', () => {
    store.record([finding], 'job-1')
    const id = store.list()[0]!.id
    const accepted = store.accept(id, 'the page is the only one this could apply to')
    expect(accepted).not.toBe('missing')
    expect(store.list()).toHaveLength(0)
    const row = store.list({ accepted: true })[0]!
    expect(row.acceptedReason).toBe('the page is the only one this could apply to')
    expect(row.acceptedAt).not.toBeNull()
  })

  /**
   * THE GUARANTEE OF THE PHASE. A validator run reports the finding again and again; the
   * accept has to survive every one of them, or the next run puts every accepted defect
   * straight back on the list.
   *
   * See the finding recorded under task 2.2: the guarantee is delivered by acceptance living
   * in its own column with its own filter, NOT by `record()` preserving `resolved_at`.
   */
  it('survives the next validator run, and the run still counts the defect', () => {
    store.record([finding], 'job-1')
    const id = store.list()[0]!.id
    store.accept(id, 'deliberate')
    store.record([finding], 'job-2')
    store.record([finding], 'job-3')
    expect(store.list()).toHaveLength(0)
    expect(store.countsByRule()).toEqual([])
    const row = store.byId(id)!
    expect(row.count).toBe(3)
    expect(row.acceptedAt).not.toBeNull()
  })

  /**
   * The sequence task 2.1 names in its own text: accepted, then genuinely repaired, then the
   * defect returns. Taking the accept back has to show the defect that is standing on disk.
   * This is the test the "preserve resolved_at" reading of 2.2 would fail.
   */
  it('shows a returned defect again when the accept is taken back', () => {
    store.record([finding], 'job-1')
    const id = store.list()[0]!.id
    store.accept(id, 'fine for now')
    // Somebody fixes it anyway: a run reads the page and no longer reports it.
    store.resolveMissing([finding.path], [], { checked: new Set(['tag-singleton']) })
    expect(store.byId(id)!.resolvedAt).not.toBeNull()
    // And later it comes back.
    store.record([finding], 'job-2')
    store.unaccept(id)
    expect(store.list().map((f) => f.id)).toEqual([id])
  })

  it('leaves both ways cleanly: accepted then resolved is off the list either way', () => {
    store.record([finding], 'job-1')
    const id = store.list()[0]!.id
    store.accept(id, 'fine')
    store.resolveMissing([finding.path], [], { checked: new Set(['tag-singleton']) })
    expect(store.list()).toHaveLength(0)
    store.unaccept(id)
    // Resolved and not re-reported: it stays gone, because it IS gone.
    expect(store.list()).toHaveLength(0)
  })

  it('refuses to accept twice and to un-accept what was never accepted', () => {
    store.record([finding], 'job-1')
    const id = store.list()[0]!.id
    expect(store.unaccept(id)).toBe('already')
    store.accept(id, 'fine')
    expect(store.accept(id, 'fine again')).toBe('already')
    expect(store.accept('nope', 'fine')).toBe('missing')
  })

  it('counts accepted findings in no rule chip and no total', () => {
    store.record([finding, { rule: 'orphan', path: 'wiki/b.md', message: 'nothing links here' }], 'job-1')
    const id = store.list().find((f) => f.rule === 'tag-singleton')!.id
    store.accept(id, 'fine')
    expect(store.countsByRule().map((r) => r.rule)).toEqual(['orphan'])
    expect(store.acceptedCount()).toBe(1)
  })
})

describe('the two consequences of the default, both wanted', () => {
  it('stops an accepted MECHANICAL finding reaching the lint-fix prompt', () => {
    // A defect somebody decided may stay must not be handed to a fix run as one that must go.
    store.record([{ rule: 'em-dash', path: 'wiki/a.md', message: 'three of them' }], 'job-1')
    expect(renderStandingDefects(store)).toContain('em-dash')
    store.accept(store.list()[0]!.id, 'the dashes are in a quotation')
    expect(renderStandingDefects(store)).toBe('')
  })

  it('stops the standing re-check re-reading its page, unless something else stands there', () => {
    const read: string[] = []
    const validate = (paths: readonly string[]): [] => {
      read.push(...paths)
      return []
    }
    store.record([finding], 'job-1')
    store.accept(store.list()[0]!.id, 'fine')
    recheckStanding(store, validate)
    expect(read).toEqual([])
    // Another finding on the same page puts it back in the set.
    store.record([{ rule: 'orphan', path: finding.path, message: 'nothing links here' }], 'job-2')
    recheckStanding(store, validate)
    expect(read).toEqual([finding.path])
  })
})

describe('POST/DELETE /api/v1/validation/:id/accept', () => {
  let app: FastifyInstance | undefined
  let vaultRoot: string

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-route-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki'), { recursive: true })
  })
  afterEach(async () => {
    await app?.close()
    app = undefined
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  /** The base product, the way `main.ts` builds one without the Fellows. */
  const serve = async (over: Partial<AppContext> = {}): Promise<{ app: FastifyInstance; id: string }> => {
    store.record([finding], 'job-1')
    const id = store.list()[0]!.id
    const events = new EventBus()
    const jobs = new JobStore(db)
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
    const built = await buildServer({
      config,
      store: jobs,
      chat: new ChatStore(db),
      queue: new IngestQueue({
        store: jobs,
        vaultRoot,
        auth: null,
        events,
        refreshHotCache: async () => 'noop',
        runIngest: async () => {
          throw new Error('not reached')
        },
      }),
      events,
      validation: store,
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
      ...over,
    })
    app = built
    return { app: built, id }
  }

  it('accepts with a reason and answers the updated row', async () => {
    const { app: a, id } = await serve()
    const res = await a.inject({ method: 'POST', url: `/api/v1/validation/${id}/accept`, payload: { reason: 'deliberate' } })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ finding: { acceptedReason: string } }>().finding.acceptedReason).toBe('deliberate')
    const list = await a.inject({ method: 'GET', url: '/api/v1/validation' })
    expect(list.json<{ total: number; accepted: number }>()).toMatchObject({ total: 0, accepted: 1 })
  })

  it('answers 400 for an empty reason, whitespace included', async () => {
    const { app: a, id } = await serve()
    for (const reason of ['', '   ', undefined]) {
      const res = await a.inject({ method: 'POST', url: `/api/v1/validation/${id}/accept`, payload: { reason } })
      expect(res.statusCode).toBe(400)
    }
  })

  it('answers 404 for an unknown id and 409 for one already accepted', async () => {
    const { app: a, id } = await serve()
    expect((await a.inject({ method: 'POST', url: '/api/v1/validation/nope/accept', payload: { reason: 'x' } })).statusCode).toBe(404)
    await a.inject({ method: 'POST', url: `/api/v1/validation/${id}/accept`, payload: { reason: 'x' } })
    expect((await a.inject({ method: 'POST', url: `/api/v1/validation/${id}/accept`, payload: { reason: 'x' } })).statusCode).toBe(409)
  })

  it('returns the accepted rows on request and takes an accept back', async () => {
    const { app: a, id } = await serve()
    await a.inject({ method: 'POST', url: `/api/v1/validation/${id}/accept`, payload: { reason: 'deliberate' } })
    const accepted = await a.inject({ method: 'GET', url: '/api/v1/validation?accepted=1' })
    expect(accepted.json<{ findings: Array<{ id: string }> }>().findings.map((f) => f.id)).toEqual([id])
    expect((await a.inject({ method: 'DELETE', url: `/api/v1/validation/${id}/accept` })).statusCode).toBe(200)
    const back = await a.inject({ method: 'GET', url: '/api/v1/validation' })
    expect(back.json<{ total: number }>().total).toBe(1)
  })

  it('caps the reason rather than storing whatever arrives', async () => {
    const { app: a, id } = await serve()
    await a.inject({ method: 'POST', url: `/api/v1/validation/${id}/accept`, payload: { reason: 'x'.repeat(900) } })
    expect(store.byId(id)!.acceptedReason).toHaveLength(500)
  })
})
