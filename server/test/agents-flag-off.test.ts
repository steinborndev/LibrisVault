/**
 * The acceptance criterion of the merge milestone, as a test (docs/tasks/TASKS-A6.md 1).
 *
 * "With `AGENTS_ENABLED` unset, LibrisVault behaves as it does today." Until this file, no
 * test mentioned the flag at all: the only test occurrences were of the config field, and of
 * those exactly one set it false, incidentally, asserting nothing about it. So the promise the
 * whole merge rests on had no automated check.
 *
 * WHAT THIS FILE CAN AND CANNOT COVER, because the distinction is the whole point of reading
 * it. The extension is gated in two steps:
 *
 *   1. `main.ts` turns the FLAG into PRESENCE: `config.agentsEnabled === true` decides whether
 *      a `FellowService`, a `NightShift`, a `RecapService`, a `UsageMonitor` and a
 *      `LibraryService` are constructed at all (a read-only demo constructs them too and starts
 *      none of them; demo-mode.test.ts covers that side, SPEC.md §12.8).
 *   2. `buildServer` turns PRESENCE into ROUTES: `if (ctx.fellows !== undefined) register…`.
 *
 * This file tests step 2 exhaustively, from both sides. It does NOT test step 1, and that is
 * deliberate rather than an oversight: `startService` opens the database at `defaultDbPath()`,
 * reads the real credential file and starts a filesystem watcher, so a test that booted it
 * would be one environment variable away from writing into the developer's own vault and
 * database. A test must not be able to do that to be worth having. Step 1 is four lines in
 * `main.ts` with no branch worth mocking a whole service tree for; what would genuinely cover
 * it is the flag-off smoke run listed in TASKS-A6 section 8.
 *
 * The consequence to keep in mind: a green run here means the routes are absent whenever the
 * services are, NOT that the flag makes them absent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { ValidationStore } from '../src/db/validation.js'
import { SettingsStore } from '../src/db/settings.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { ReadingListService } from '../src/pipeline/reading-list.js'
import { QuestionsService } from '../src/pipeline/questions.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer, type AppContext } from '../src/api/server.js'
import type { Config } from '../src/config.js'
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

/**
 * Every endpoint that exists only when the extension is wired, one per registrar, with a
 * method that needs no body. `/api/v1/wings` is in here because it rides along in the library
 * registrar, which is easy to forget when reading `server.ts` for what "the Fellow routes" are.
 */
const GATED: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/api/v1/agents'],
  ['GET', '/api/v1/agents/shift'],
  ['GET', '/api/v1/recaps'],
  ['GET', '/api/v1/library/scene'],
  ['GET', '/api/v1/wings'],
  ['GET', '/api/v1/usage/plan'],
  ['GET', '/api/v1/reading-list'],
  ['GET', '/api/v1/questions'],
  ['POST', '/api/v1/questions/archive'],
]

/** Endpoints the base product answers whatever the flag says; the control group. */
const UNGATED: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/api/v1/stats'],
  ['GET', '/api/v1/jobs'],
  ['GET', '/api/v1/health'],
  ['GET', '/api/v1/graph'],
  // The standing validation list (A9, 2026-09-19): the validator runs for every ingest
  // whether or not the research agents exist, so a screen asking a Fellow-only route for it
  // would 404 on every mount with the flag off - which is the class hard rule 8 is about.
  ['GET', '/api/v1/validation'],
]

describe('with the Fellows extension unwired', () => {
  let db: Db
  let vaultRoot: string
  let app: FastifyInstance | undefined

  /** A server with the base product only, the way `main.ts` builds one with the flag unset. */
  const build = async (extra: Partial<AppContext> = {}): Promise<FastifyInstance> => {
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
        authMode: 'local-single-user',
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
    return buildServer({
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
      settings: new SettingsStore(db),
      autoCommit: () => false,
      logger: false,
      ...extra,
    })
  }

  beforeEach(() => {
    db = openDb(MEMORY_DB)
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flagoff-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki'), { recursive: true })
  })
  afterEach(async () => {
    await app?.close()
    app = undefined
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('answers 404 on every route the extension registers', async () => {
    app = await build()
    for (const [method, url] of GATED) {
      const res = await app.inject({ method: method as 'GET', url })
      expect(`${method} ${url} -> ${res.statusCode}`).toBe(`${method} ${url} -> 404`)
    }
  })

  it('still answers the routes the base product owns', async () => {
    app = await build()
    for (const [method, url] of UNGATED) {
      const res = await app.inject({ method: method as 'GET', url })
      expect(`${method} ${url} -> ${res.statusCode}`).toBe(`${method} ${url} -> 200`)
    }
  })

  /*
   * The contract the dashboard reads, and the reason it is asserted as a shape rather than as
   * a value: `health.fellows` is `ctx.fellows !== undefined`, a BOOLEAN, while the startup log
   * banner says 'on' / 'off' for the same idea. A web test written against the banner's
   * strings would assert a contract that does not exist, and `'off'` is truthy, so it would
   * light up every Fellow surface it meant to hide.
   */
  /*
   * Everything TASKS-DEFECT-PATHS adds beside the list. It cannot go in the control group
   * above, because that group asserts a flat 200 and this route legitimately 404s for an
   * unknown finding - which is the answer, not a gate. So it is asserted against a finding
   * that exists. The defect list is the base product's own screen: a row that could not be
   * opened or judged with the flag off would be the same 404-per-mount class hard rule 8 is
   * about, one layer further in.
   */
  it('serves a finding\'s evidence with the flag off', async () => {
    const validation = new ValidationStore(db)
    validation.record([{ rule: 'orphan', path: 'wiki/a.md', message: 'nothing links here' }], null)
    const id = validation.list()[0]!.id
    app = await build({ validation })
    const res = await app.inject({ method: 'GET', url: `/api/v1/validation/${id}/evidence` })
    expect(res.statusCode).toBe(200)
    // And the list itself carries the guidance the screen renders, with the flag off too.
    const list = await app.inject({ method: 'GET', url: '/api/v1/validation' })
    expect(Object.keys((list.json() as { guidance: Record<string, unknown> }).guidance)).toContain('open-question-form')
  })

  /*
   * The one route in this area that must ANSWER with the flag off (decision D4,
   * docs/tasks/TASKS-QUESTIONS.md). The pinboard that sends most reformulations is gated, but
   * the Graph screen's gap backlog is base product and reaches the composer the same way. A
   * route the base product calls has to exist when the flag is off, or it is one 404 per click
   * - which is exactly the rot hard rule 8 names, and the reason this assertion is the inverse
   * of every other one in this file.
   */
  it('answers the reformulation route with the flag off, because the base product calls it', async () => {
    app = await build()
    const res = await app.inject({ method: 'POST', url: '/api/v1/maintenance/research/topic', payload: { text: '' } })
    expect(res.statusCode).not.toBe(404)
  })

  it('reports fellows as a falsy boolean in health, never as a string', async () => {
    app = await build()
    const body = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as { fellows?: unknown }
    expect(body.fellows).toBe(false)
    expect(typeof body.fellows).toBe('boolean')
  })

  /*
   * The counter-test, and the one that makes the two above mean anything. Without it they pass
   * just as happily against a typo in a path or a registrar deleted outright, which is the
   * usual way a gating test rots into a test that only proves 404 is still 404.
   */
  it('registers the reading-list route as soon as its service is present', async () => {
    const reading = new ReadingListService(vaultRoot, new JobStore(db, new EventBus()), {
      commitMutex: new Mutex(),
      autoCommit: () => false,
      byRef: () => undefined,
      byUrl: () => undefined,
    })
    app = await build({ reading })
    const res = await app.inject({ method: 'GET', url: '/api/v1/reading-list' })
    expect(res.statusCode).toBe(200)
  })

  it('registers the pinboard routes as soon as their service is present', async () => {
    app = await build({ questions: new QuestionsService({ vaultRoot, graph: () => null }) })
    const res = await app.inject({ method: 'GET', url: '/api/v1/questions' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ entries: [] })
    const bad = await app.inject({ method: 'POST', url: '/api/v1/questions/archive', payload: { page: 'wiki/x.md', text: 'nothing here' } })
    expect(bad.statusCode).toBe(404)
  })
})
