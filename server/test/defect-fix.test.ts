import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { ValidationStore, type StandingFinding } from '../src/db/validation.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { buildServer, type AppContext } from '../src/api/server.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { createValidator } from '../src/pipeline/validator.js'
import type { Config } from '../src/config.js'
import { renderDefectFixPrompt, DEFECT_FIX_RULES } from '../src/pipeline/defect-fix-prompt.js'
import { defectFixBlock, NOTEBOOK_PREFIX } from '../src/pipeline/defect-fix-scope.js'
import { decidePermission } from '../src/pipeline/permissions.js'
import { validateDefectFixCommit } from '../src/pipeline/expand.js'

/**
 * The bound agent run (TASKS-DEFECT-PATHS phase 4).
 *
 * Runs are mocked, as everywhere in this repo. What a test CAN hold is everything around the
 * run: which findings reach it, what the prompt says, what the scope guard refuses, what the
 * notebook condition blocks, and the bookkeeping that only makes sense once a run has finished.
 */
let db: Db
let store: ValidationStore
let vault: string

const finding = (over: Partial<StandingFinding> = {}): StandingFinding => ({
  id: 'f1',
  rule: 'open-question-form',
  path: 'wiki/concepts/a.md',
  message: 'of 3 open question(s) on this page, 2 do(es) not ask anything',
  count: 1,
  firstSeen: '2026-09-01T00:00:00.000Z',
  lastSeen: '2026-09-20T00:00:00.000Z',
  lastJobId: 'job-1',
  resolvedAt: null,
  evidence: null,
  acceptedAt: null,
  acceptedReason: null,
  fixAttempts: 0,
  lastFixAt: null,
  occurrencesAtLastFix: null,
  ...over,
})

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new ValidationStore(db)
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-fix-'))
  fs.mkdirSync(path.join(vault, 'wiki', 'concepts'), { recursive: true })
})
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true })
})

describe('the prompt', () => {
  it('exists for exactly the three rules whose repair needs reading', () => {
    expect([...DEFECT_FIX_RULES].sort()).toEqual(['open-question-form', 'page-schema', 'quote'])
    // near-duplicate deliberately gets no run: merging is forbidden to every writer here, and a
    // run that only cross-referenced the pair would pre-empt the decision it cannot make.
    expect(DEFECT_FIX_RULES.has('near-duplicate')).toBe(false)
    expect(() => renderDefectFixPrompt('near-duplicate', [finding()])).toThrow(/no defect-fix prompt/)
  })

  it('names exactly the pages of the findings and nothing else', () => {
    const prompt = renderDefectFixPrompt('open-question-form', [
      finding({ id: 'a', path: 'wiki/concepts/one.md' }),
      finding({ id: 'b', path: 'wiki/concepts/two.md' }),
      // The same page twice: two findings, one page in the set.
      finding({ id: 'c', path: 'wiki/concepts/two.md' }),
    ])
    expect(prompt).toContain('- wiki/concepts/one.md')
    expect(prompt).toContain('- wiki/concepts/two.md')
    expect(prompt.match(/^- wiki\//gm)).toHaveLength(2)
    expect(prompt).toContain('2 pages')
  })

  it('says the scope is enforced rather than requested', () => {
    const prompt = renderDefectFixPrompt('page-schema', [finding({ rule: 'page-schema' })])
    expect(prompt).toContain('This is enforced')
    expect(prompt).toContain('reverted whole')
  })

  it('hands the quote run the whole quotation, which the message only clips', () => {
    const prompt = renderDefectFixPrompt('quote', [
      finding({
        rule: 'quote',
        message: 'quote not found in the source: "the first eighty characters only"',
        evidence: JSON.stringify({ quote: 'the whole quotation as the page has it', matched: 'the whole', words: 8, matchedWords: 2 }),
      }),
    ])
    expect(prompt).toContain('the whole quotation as the page has it')
    expect(prompt).toContain('2 of 8 words')
    expect(prompt).toContain('NEVER invent a quotation')
  })

  it('tells the question run to leave clean bullets alone', () => {
    const prompt = renderDefectFixPrompt('open-question-form', [finding()])
    expect(prompt).toContain('character for')
    expect(prompt).toContain('do not answer any of them')
  })
})

describe('the scope guard', () => {
  const ctxFor = (pageSet: string[]) => ({ vaultRoot: vault, profile: 'ingest' as const, defectFix: { pageSet } })

  it('refuses a write outside the page set', () => {
    const res = decidePermission(ctxFor(['wiki/concepts/a.md']), 'Edit', {
      file_path: path.join(vault, 'wiki/concepts/b.md'),
      old_string: 'x',
      new_string: 'y',
    })
    expect(res.behavior).toBe('deny')
    expect(res.behavior === 'deny' && res.message).toContain('outside the page set')
  })

  it('refuses a NEW page, which an expand run would be allowed', () => {
    const res = decidePermission(ctxFor(['wiki/concepts/a.md']), 'Write', {
      file_path: path.join(vault, 'wiki/concepts/new.md'),
      content: 'x',
    })
    expect(res.behavior).toBe('deny')
    expect(res.behavior === 'deny' && res.message).toContain('no new page')
  })

  /**
   * THE RULE THAT MAKES THIS A SECOND POLICY. An expand run is additive - every existing body
   * line must survive - and a defect fix REPLACES lines by definition. Reusing the expand
   * policy would refuse exactly the edit it was reused for.
   */
  it('ALLOWS an edit that removes a line inside the set', () => {
    const res = decidePermission(ctxFor(['wiki/concepts/a.md']), 'Edit', {
      file_path: path.join(vault, 'wiki/concepts/a.md'),
      old_string: '- Unclear in this pass whether the figure holds.\n- A second bullet.',
      new_string: '- Does the reported figure hold for the second cohort?',
    })
    expect(res.behavior).toBe('allow')
  })

  it('allows a Write to a page that IS in the set', () => {
    expect(decidePermission(ctxFor(['wiki/concepts/a.md']), 'Write', { file_path: path.join(vault, 'wiki/concepts/a.md'), content: 'x' }).behavior).toBe('allow')
  })

  it('leaves bookkeeping alone, the same set the expand rules exempt', () => {
    for (const rel of ['wiki/index.md', 'wiki/log.md', 'wiki/concepts/_index.md']) {
      expect(decidePermission(ctxFor(['wiki/concepts/a.md']), 'Edit', { file_path: path.join(vault, rel), old_string: 'a', new_string: 'b' }).behavior).toBe('allow')
    }
  })

  it('still refuses a path outside the vault entirely', () => {
    const res = decidePermission(ctxFor(['wiki/concepts/a.md']), 'Write', { file_path: '/etc/passwd', content: 'x' })
    expect(res.behavior).toBe('deny')
    expect(res.behavior === 'deny' && res.message).toContain('outside the vault')
  })
})

describe('the commit check behind it', () => {
  const reader = (status: Array<[string, 'A' | 'M' | 'D']>, pages: Record<string, [string, string]> = {}) => ({
    status: async () => new Map(status),
    before: async (p: string) => pages[p]?.[0] ?? null,
    after: async (p: string) => pages[p]?.[1] ?? null,
  })

  it('accepts a commit that REWROTE a line inside the set', async () => {
    // The whole reason additivity is dropped: this is what a defect fix does.
    const findings = await validateDefectFixCommit(
      reader([['wiki/concepts/a.md', 'M']], { 'wiki/concepts/a.md': ['---\n---\n- old line\n', '---\n---\n- new line\n'] }),
      ['wiki/concepts/a.md'],
    )
    expect(findings).toEqual([])
  })

  it('catches a page outside the set, a deletion, and a new page', async () => {
    const findings = await validateDefectFixCommit(
      reader([
        ['wiki/concepts/a.md', 'M'],
        ['wiki/concepts/elsewhere.md', 'M'],
        ['wiki/concepts/gone.md', 'D'],
        ['wiki/concepts/new.md', 'A'],
      ]),
      ['wiki/concepts/a.md'],
    )
    expect(findings.map((f) => f.rule).sort()).toEqual(['deleted-page', 'outside-set', 'too-many-new'])
    expect(findings.find((f) => f.rule === 'too-many-new')?.detail).toContain('creates none')
  })
})

describe('the notebook condition', () => {
  const nb = `${NOTEBOOK_PREFIX}some-fellow.md`

  it('lets a question repair through while the Fellow is idle', () => {
    const block = defectFixBlock(
      { rule: 'open-question-form', path: nb },
      { fellowsWired: true, ownerOf: () => ({ id: 'a1', name: 'A Fellow', retired: false }), hasRunInFlight: () => false },
    )
    expect(block.fixable).toBe(true)
  })

  it('refuses while that Fellow has a run in flight', () => {
    const block = defectFixBlock(
      { rule: 'open-question-form', path: nb },
      { fellowsWired: true, ownerOf: () => ({ id: 'a1', name: 'A Fellow', retired: false }), hasRunInFlight: () => true },
    )
    expect(block.fixable).toBe(false)
    expect(block.fixable === false && block.why).toContain('run in flight')
  })

  /**
   * The second half, found by the code review: the lock makes a notebook write atomic, it does
   * not make a repair DURABLE. `renderNotebook` regenerates the page and preserves four
   * sections; a repair outside them is undone by the Fellow's next write whatever the locking
   * did.
   */
  it('refuses a rule whose repair lands outside the preserved sections, idle or not', () => {
    for (const rule of ['page-schema', 'quote']) {
      const block = defectFixBlock(
        { rule, path: nb },
        { fellowsWired: true, ownerOf: () => ({ id: 'a1', name: 'A Fellow', retired: false }), hasRunInFlight: () => false },
      )
      expect(block.fixable, rule).toBe(false)
      expect(block.fixable === false && block.why).toContain('regenerated')
    }
  })

  it('renders as a decision with the flag off, rather than asking a Fellow-only route', () => {
    const block = defectFixBlock({ rule: 'open-question-form', path: nb }, { fellowsWired: false, ownerOf: () => undefined })
    expect(block.fixable).toBe(false)
    expect(block.fixable === false && block.why).toContain('not enabled here')
  })

  /**
   * Retirement is final in the Fellow module - `pause()` and `resume()` both return a retired
   * agent untouched - so a retired Fellow has no next notebook write and its page is static.
   * Measured on the live vault: 3 of the 4 notebook findings stand on retired Fellows' pages,
   * so blocking them would take the path away from three quarters of the class to guard against
   * a write that can never happen.
   */
  it('allows a repair on a RETIRED Fellow\'s notebook: it writes nothing again', () => {
    const block = defectFixBlock(
      { rule: 'open-question-form', path: nb },
      { fellowsWired: true, ownerOf: () => ({ id: 'a1', name: 'A Fellow', retired: true }), hasRunInFlight: () => true },
    )
    expect(block.fixable).toBe(true)
  })

  it('still blocks a notebook nothing owns: it may belong to a Fellow this process has not loaded', () => {
    const block = defectFixBlock({ rule: 'open-question-form', path: nb }, { fellowsWired: true, ownerOf: () => undefined, hasRunInFlight: () => false })
    expect(block.fixable).toBe(false)
  })

  it('never blocks a page outside the notebooks', () => {
    expect(defectFixBlock({ rule: 'quote', path: 'wiki/concepts/a.md' }, { fellowsWired: false, ownerOf: () => undefined }).fixable).toBe(true)
  })
})

describe('the attempt counter', () => {
  it('rises on every run that covers the finding, and snapshots its occurrence count', () => {
    store.record([{ rule: 'quote', path: 'wiki/a.md', message: 'quote not found' }], 'job-1')
    store.record([{ rule: 'quote', path: 'wiki/a.md', message: 'quote not found' }], 'job-2')
    const id = store.list()[0]!.id
    expect(store.byId(id)!.count).toBe(2)
    store.markFixAttempt([id])
    const after = store.byId(id)!
    expect(after.fixAttempts).toBe(1)
    expect(after.lastFixAt).not.toBeNull()
    expect(after.occurrencesAtLastFix).toBe(2)
  })

  /**
   * A PARTIAL repair is not a failure. `findingIdentity` normalises numbers out of the message,
   * so three bad bullets going to one keeps the same id and only the count moves - and the row
   * has to be able to tell that apart from a run that changed nothing.
   */
  it('lets a partial repair be told from a run that changed nothing', () => {
    store.record([{ rule: 'open-question-form', path: 'wiki/a.md', message: 'of 5 open question(s), 3 do(es) not ask anything' }], 'j1')
    const id = store.list()[0]!.id
    store.markFixAttempt([id])
    // The same finding, fewer bad bullets: same identity, count up by one.
    store.record([{ rule: 'open-question-form', path: 'wiki/a.md', message: 'of 5 open question(s), 1 do(es) not ask anything' }], 'j2')
    const row = store.byId(id)!
    expect(row.id).toBe(id)
    expect(row.occurrencesAtLastFix).toBe(1)
    expect(row.count).toBe(2)
  })

  it('counts a crashed run too: it spent the try', () => {
    store.record([{ rule: 'quote', path: 'wiki/a.md', message: 'q' }], 'j1')
    const id = store.list()[0]!.id
    store.markFixAttempt([id])
    store.markFixAttempt([id])
    expect(store.byId(id)!.fixAttempts).toBe(2)
  })
})

describe('the run route', () => {
  let app: FastifyInstance | undefined
  const started: Array<{ rule: string; pageSet: readonly string[] }> = []

  afterEach(async () => {
    await app?.close()
    app = undefined
    started.length = 0
  })

  const serve = async (over: Partial<AppContext> = {}, withAuth = true): Promise<FastifyInstance> => {
    const events = new EventBus()
    const jobs = new JobStore(db)
    const config: Config = {
      vaultRoot: vault,
      obsidianVaultName: 'vault',
      auth: withAuth ? { mode: 'oauth' as const, credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' as const } : null,
      telegram: null,
      demoMode: false,
      server: {
        host: '127.0.0.1',
        port: 0,
        watchFolder: path.join(vault, 'inbox'),
        maxUploadBytes: 1024 * 1024,
        authMode: 'local-single-user',
      },
    }
    const maintenance = new MaintenanceRunner({
      vaultRoot: vault,
      auth: withAuth ? { envVar: 'CLAUDE_CODE_OAUTH_TOKEN' as const, credential: 'x' } : null,
      events,
      commitMutex: new Mutex(),
      runAgent: async () => ({
        ok: true,
        result: 'done',
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        durationMs: 0,
        numTurns: 0,
        sessionId: 's',
        timedOut: false,
      }),
      commit: async () => ({ committed: false, hash: '', committedPages: [] }),
    })
    const realStart = maintenance.startDefectFix.bind(maintenance)
    maintenance.startDefectFix = ((rule: string, findings: readonly StandingFinding[], pageSet: readonly string[]) => {
      started.push({ rule, pageSet })
      return realStart(rule, findings, pageSet)
    }) as typeof maintenance.startDefectFix
    app = await buildServer({
      config,
      store: jobs,
      chat: new ChatStore(db),
      queue: new IngestQueue({
        store: jobs,
        vaultRoot: vault,
        auth: null,
        events,
        refreshHotCache: async () => 'noop',
        runIngest: async () => {
          throw new Error('not reached')
        },
      }),
      events,
      validation: store,
      validate: createValidator(vault),
      commitMutex: new Mutex(),
      maintenance,
      logger: false,
      ...over,
    })
    return app
  }

  const seed = (rule = 'open-question-form', p = 'wiki/concepts/a.md'): string => {
    fs.writeFileSync(path.join(vault, p), '---\ntype: concept\n---\n\n## Open questions\n\n- Unclear in this pass.\n', 'utf8')
    store.record([{ rule, path: p, message: 'of 1 open question(s) on this page, 1 do(es) not ask anything' }], 'job-1')
    return store.list().find((f) => f.rule === rule && f.path === p)!.id
  }

  it('starts a run over exactly the pages of the findings', async () => {
    const id = seed()
    const a = await serve()
    const res = await a.inject({ method: 'POST', url: '/api/v1/validation/repair/run', payload: { rule: 'open-question-form', ids: [id] } })
    expect(res.statusCode).toBe(202)
    expect(started).toEqual([{ rule: 'open-question-form', pageSet: ['wiki/concepts/a.md'] }])
    // And the attempt is counted before the run, not after: a crash still spent a try.
    expect(store.byId(id)!.fixAttempts).toBe(1)
  })

  it('refuses the whole request for an unknown id, a mixed rule, or an accepted finding', async () => {
    const id = seed()
    const a = await serve()
    const code = async (payload: { rule: string; ids: string[] }): Promise<number> =>
      (await a.inject({ method: 'POST', url: '/api/v1/validation/repair/run', payload })).statusCode
    expect(await code({ rule: 'open-question-form', ids: [id, 'nope'] })).toBe(404)
    expect(await code({ rule: 'quote', ids: [id] })).toBe(400)
    expect(await code({ rule: 'open-question-form', ids: Array.from({ length: 11 }, () => id) })).toBe(400)
    store.accept(id, 'deliberate')
    expect(await code({ rule: 'open-question-form', ids: [id] })).toBe(409)
    expect(started).toEqual([])
  })

  it('refuses a rule that has no bound run', async () => {
    fs.writeFileSync(path.join(vault, 'wiki/concepts/b.md'), '---\ntype: concept\n---\n', 'utf8')
    store.record([{ rule: 'near-duplicate', path: 'wiki/concepts/b.md', message: 'reads like wiki/concepts/c.md' }], 'job-1')
    const id = store.list().find((f) => f.rule === 'near-duplicate')!.id
    const a = await serve()
    const res = await a.inject({ method: 'POST', url: '/api/v1/validation/repair/run', payload: { rule: 'near-duplicate', ids: [id] } })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toContain('no bound run')
  })

  it('answers 503 without a credential, like every other agent action', async () => {
    const id = seed()
    const a = await serve({}, false)
    expect((await a.inject({ method: 'POST', url: '/api/v1/validation/repair/run', payload: { rule: 'open-question-form', ids: [id] } })).statusCode).toBe(503)
  })

  it('refuses a notebook finding whose Fellow is working, and allows it when idle', async () => {
    const nb = `${NOTEBOOK_PREFIX}f.md`
    fs.mkdirSync(path.join(vault, NOTEBOOK_PREFIX), { recursive: true })
    const id = seed('open-question-form', nb)
    let busy = true
    const fellows = {
      list: () => [{ agent: { id: 'a1', name: 'A Fellow', notebookPath: nb, state: 'sleeping' } }],
      hasRunInFlight: () => busy,
    } as unknown as NonNullable<AppContext['fellows']>
    const a = await serve({ fellows })
    const call = async (): Promise<number> =>
      (await a.inject({ method: 'POST', url: '/api/v1/validation/repair/run', payload: { rule: 'open-question-form', ids: [id] } })).statusCode
    expect(await call()).toBe(409)
    busy = false
    expect(await call()).toBe(202)
  })

  it('renders a notebook row as a decision with the flag off, and asks no Fellow-only route', async () => {
    const nb = `${NOTEBOOK_PREFIX}f.md`
    fs.mkdirSync(path.join(vault, NOTEBOOK_PREFIX), { recursive: true })
    seed('open-question-form', nb)
    const a = await serve()
    const list = await a.inject({ method: 'GET', url: '/api/v1/validation' })
    const row = list.json<{ findings: Array<{ path: string; fixBlock?: { fixable: boolean; why?: string } }> }>().findings.find((f) => f.path === nb)!
    expect(row.fixBlock?.fixable).toBe(false)
    expect(row.fixBlock?.why).toContain('not enabled here')
  })
})

describe('the revert', () => {
  let app: FastifyInstance | undefined
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('re-records the defect it put back, rather than leaving the list wrong', async () => {
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', vault, ...args], { stdio: 'ignore' })
    }
    git('init', '-q')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'test')
    const rel = 'wiki/concepts/a.md'
    const abs = path.join(vault, rel)
    // A page with an em-dash, committed; then a "repair" that removes it, committed.
    fs.writeFileSync(abs, '---\ntype: concept\nstatus: ongoing\ntags:\n  - alpha\n---\n\nA clause — and another.\n', 'utf8')
    git('add', '-A')
    git('commit', '-qm', 'fixture')
    fs.writeFileSync(abs, '---\ntype: concept\nstatus: ongoing\ntags:\n  - alpha\n---\n\nA clause - and another.\n', 'utf8')
    git('add', '-A')
    git('commit', '-qm', 'repair: dashes')
    const hash = execFileSync('git', ['-C', vault, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

    const events = new EventBus()
    const jobs = new JobStore(db)
    app = await buildServer({
      config: {
        vaultRoot: vault,
        obsidianVaultName: 'vault',
        auth: null,
        telegram: null,
        demoMode: false,
        server: { host: '127.0.0.1', port: 0, watchFolder: path.join(vault, 'inbox'), maxUploadBytes: 1024, authMode: 'local-single-user' },
      },
      store: jobs,
      chat: new ChatStore(db),
      queue: new IngestQueue({
        store: jobs,
        vaultRoot: vault,
        auth: null,
        events,
        refreshHotCache: async () => 'noop',
        runIngest: async () => {
          throw new Error('not reached')
        },
      }),
      events,
      validation: store,
      validate: createValidator(vault),
      commitMutex: new Mutex(),
      maintenance: new MaintenanceRunner({
        vaultRoot: vault,
        auth: null,
        events,
        commitMutex: new Mutex(),
        runAgent: async () => {
          throw new Error('not reached')
        },
        commit: async () => ({ committed: false, hash: '', committedPages: [] }),
      }),
      logger: false,
    })
    expect(store.list()).toHaveLength(0)
    const res = await app.inject({ method: 'POST', url: '/api/v1/validation/repair/revert', payload: { commit: hash } })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ reverted: boolean; pages: string[]; recorded: number }>()
    expect(body.reverted).toBe(true)
    expect(body.pages).toEqual([rel])
    // The em-dash is back on disk AND back on the list, in the same request.
    expect(fs.readFileSync(abs, 'utf8')).toContain('—')
    expect(body.recorded).toBeGreaterThan(0)
    expect(store.list().some((f) => f.rule === 'em-dash')).toBe(true)
  })

  it('refuses a malformed hash rather than shelling out with it', async () => {
    const events = new EventBus()
    const jobs = new JobStore(db)
    app = await buildServer({
      config: {
        vaultRoot: vault,
        obsidianVaultName: 'vault',
        auth: null,
        telegram: null,
        demoMode: false,
        server: { host: '127.0.0.1', port: 0, watchFolder: path.join(vault, 'inbox'), maxUploadBytes: 1024, authMode: 'local-single-user' },
      },
      store: jobs,
      chat: new ChatStore(db),
      queue: new IngestQueue({ store: jobs, vaultRoot: vault, auth: null, events, refreshHotCache: async () => 'noop', runIngest: async () => { throw new Error('x') } }),
      events,
      validation: store,
      commitMutex: new Mutex(),
      maintenance: new MaintenanceRunner({ vaultRoot: vault, auth: null, events, commitMutex: new Mutex(), runAgent: async () => { throw new Error('x') }, commit: async () => ({ committed: false, hash: '', committedPages: [] }) }),
      logger: false,
    })
    for (const commit of ['', 'not a hash', '../../etc', 'zzzz']) {
      expect((await app.inject({ method: 'POST', url: '/api/v1/validation/repair/revert', payload: { commit } })).statusCode).toBe(400)
    }
  })
})

describe('the quote rule clears its own finding', () => {
  /**
   * `recheckStanding` hardcodes `checked: VALIDATOR_RULES`, and that set excludes `quote`
   * because a quotation is compared against the artifact the job read - only the ingest path
   * holds one. So without a path of its own, a SUCCESSFUL quote repair would never clear its
   * own finding, `fix_attempts` would rise on every success, and at three the row would call
   * three successes two failures.
   */
  it('is unreachable by the standing re-check, which is why the run needs its own path', async () => {
    const { recheckStanding } = await import('../src/pipeline/standing-recheck.js')
    fs.writeFileSync(path.join(vault, 'wiki/concepts/a.md'), '---\ntype: concept\n---\n\nrepaired.\n', 'utf8')
    store.record([{ rule: 'quote', path: 'wiki/concepts/a.md', message: 'quote not found in the source' }], 'job-1')
    // A validator that reports nothing at all - the page is clean now.
    recheckStanding(store, () => [])
    // And the quote finding is STILL standing, because the re-check never claimed that rule.
    expect(store.list().map((f) => f.rule)).toEqual(['quote'])
  })

  it('is cleared by a check that DID look for it', () => {
    store.record([{ rule: 'quote', path: 'wiki/concepts/a.md', message: 'quote not found in the source' }], 'job-1')
    expect(store.resolveMissing(['wiki/concepts/a.md'], [], { checked: new Set(['quote']) })).toBe(1)
    expect(store.list()).toHaveLength(0)
  })
})

describe('a reformulated question is a new question', () => {
  it('vetoes the proposal standing on the old wording, and nothing else', async () => {
    const { QuestionsService } = await import('../src/pipeline/questions.js')
    const rel = 'wiki/concepts/a.md'
    const abs = path.join(vault, rel)
    fs.writeFileSync(abs, '---\ntype: concept\n---\n\n## Open questions\n\n- Unclear in this pass.\n- A second one, untouched.\n', 'utf8')
    const { questionKey } = await import('../src/pipeline/questions.js')
    const was = ['Unclear in this pass.', 'A second one, untouched.'].map(questionKey)
    const vetoed: Array<{ id: string; note: string }> = []
    const svc = new QuestionsService({
      vaultRoot: vault,
      proposals: () => [
        { id: 'p-old', provenance: { text: 'Unclear in this pass.' } },
        { id: 'p-kept', provenance: { text: 'A second one, untouched.' } },
        { id: 'p-elsewhere', provenance: { text: 'A question from another page.' } },
      ] as never,
      veto: async (id: string, note: string) => {
        vetoed.push({ id, note })
      },
    } as never)
    // The run rewrote the first bullet and left the second alone.
    fs.writeFileSync(abs, '---\ntype: concept\n---\n\n## Open questions\n\n- Does the reported figure hold?\n- A second one, untouched.\n', 'utf8')
    const out = await svc.vetoReformulated(rel, was)
    expect(out).toEqual(['p-old'])
    expect(vetoed).toEqual([{ id: 'p-old', note: 'the question was reformulated on its page' }])
  })

  it('does nothing at all when the Fellows are unwired, without a refusal', async () => {
    const { QuestionsService } = await import('../src/pipeline/questions.js')
    const svc = new QuestionsService({ vaultRoot: vault } as never)
    await expect(svc.vetoReformulated('wiki/concepts/a.md', ['anything'])).resolves.toEqual([])
  })
})
