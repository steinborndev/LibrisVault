import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { ValidationStore } from '../src/db/validation.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { buildServer, type AppContext } from '../src/api/server.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { createValidator } from '../src/pipeline/validator.js'
import type { Config } from '../src/config.js'
import {
  applySelection,
  contentHash,
  planForPaths,
  passForRule,
  SingleFlight,
  PlanInFlightError,
} from '../src/pipeline/defect-repair.js'
import { planRepair, emDashPass } from '../src/pipeline/repair.js'

/**
 * The deterministic repair, reachable from the dashboard (TASKS-DEFECT-PATHS phase 3).
 *
 * The passes existed, were tested, and held their locks - in a hand-run CLI. What is new is a
 * SECOND caller, and everything that has to be true of a service writer and is not required of
 * a one-off: the plan filtered to what the list showed, the approval carried forward as a hash,
 * the locks in the order hard rule 1 states, and one commit.
 */
let vault: string
let db: Db
let store: ValidationStore

/** A page with two em-dashes and the frontmatter the passes need. */
const withDashes = (title: string): string =>
  `---\ntype: concept\nstatus: ongoing\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags:\n  - alpha\n---\n\n# ${title}\n\nOne clause — and another — here.\n`

const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true })
  fs.writeFileSync(path.join(vault, rel), text, 'utf8')
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-repair-'))
  fs.mkdirSync(path.join(vault, 'wiki', 'concepts'), { recursive: true })
  // A real vault is a git repository, and the route commits: the route tests below need one
  // or they exercise a failure path rather than the write.
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', vault, ...args], { stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')
  db = openDb(MEMORY_DB)
  store = new ValidationStore(db)
})
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true })
})

describe('the plan', () => {
  it('writes nothing: a fixture vault is byte-identical afterwards', () => {
    write('wiki/concepts/a.md', withDashes('A'))
    const before = fs.readFileSync(path.join(vault, 'wiki/concepts/a.md'), 'utf8')
    planForPaths(vault, 'em-dash', ['wiki/concepts/a.md'])
    expect(fs.readFileSync(path.join(vault, 'wiki/concepts/a.md'), 'utf8')).toBe(before)
  })

  /**
   * THE FILTER, and the measurement behind it: `tag-singleton` would change 26 pages against
   * 14 findings on the live vault. A pass is built vault-wide; the dashboard writes exactly
   * what the list showed, and the vault-wide sweep stays the CLI's job.
   */
  it('is filtered to the pages the findings name, not to what the pass would find', () => {
    write('wiki/concepts/named.md', withDashes('Named'))
    write('wiki/concepts/unchecked.md', withDashes('Unchecked'))
    const plan = planForPaths(vault, 'em-dash', ['wiki/concepts/named.md'])
    expect(plan.pages.map((p) => p.rel)).toEqual(['wiki/concepts/named.md'])
    // And the vault-wide plan does find the other one, which is exactly the surplus 3.2 names.
    const wide = planRepair(vault, 'em-dash', emDashPass)
    expect(wide.edits.map((e) => e.rel).sort()).toEqual(['wiki/concepts/named.md', 'wiki/concepts/unchecked.md'])
  })

  it('names the pages of the selection the pass could not reach', () => {
    write('wiki/concepts/a.md', withDashes('A'))
    write('wiki/concepts/clean.md', '---\ntype: concept\ntags:\n  - alpha\n---\n\nNothing to repair here.\n')
    const plan = planForPaths(vault, 'em-dash', ['wiki/concepts/a.md', 'wiki/concepts/clean.md'])
    expect(plan.pages.map((p) => p.rel)).toEqual(['wiki/concepts/a.md'])
    expect(plan.unchanged).toEqual(['wiki/concepts/clean.md'])
  })

  it('carries a diff and the hash of the content it planned against', () => {
    write('wiki/concepts/a.md', withDashes('A'))
    const page = planForPaths(vault, 'em-dash', ['wiki/concepts/a.md']).pages[0]!
    expect(page.diff).toContain('-')
    expect(page.beforeHash).toBe(contentHash(fs.readFileSync(path.join(vault, 'wiki/concepts/a.md'), 'utf8')))
  })

  it('refuses a rule that has no exposed pass', () => {
    // `title-link` repairs the pages that LINK to a drifted title, never the page the finding
    // stands on, so exposing it would write pages the list never showed.
    expect(() => planForPaths(vault, 'title-name', ['wiki/concepts/a.md'])).toThrow(/no repair pass/)
    expect(passForRule('title-name')).toBeUndefined()
    expect(passForRule('near-duplicate')).toBeUndefined()
    expect(passForRule('em-dash')).toBe('em-dash')
  })
})

describe('the apply', () => {
  const commits: Array<{ message: string; paths: readonly string[] }> = []
  const commit = async (_v: string, message: string, paths: readonly string[]) => {
    commits.push({ message, paths })
    return { committed: true, hash: 'c0ffee1234', committedPages: [...paths] }
  }
  beforeEach(() => {
    commits.length = 0
  })

  const planOf = (paths: string[]) => planRepair(vault, 'em-dash', emDashPass, undefined, paths)
  const approvalOf = (paths: string[]): Map<string, string> =>
    new Map(paths.map((rel) => [rel, contentHash(fs.readFileSync(path.join(vault, rel), 'utf8'))]))

  it('writes only the selection, and makes exactly one commit', async () => {
    write('wiki/concepts/a.md', withDashes('A'))
    write('wiki/concepts/b.md', withDashes('B'))
    const out = await applySelection(vault, planOf(['wiki/concepts/a.md']), 'repair: dashes', approvalOf(['wiki/concepts/a.md']), {
      commitMutex: new Mutex(),
      commit,
      lock: async (_v, rels, fn) => fn(rels, []),
    })
    expect(out.written).toEqual(['wiki/concepts/a.md'])
    expect(commits).toHaveLength(1)
    expect(commits[0]!.paths).toEqual(['wiki/concepts/a.md'])
    expect(fs.readFileSync(path.join(vault, 'wiki/concepts/b.md'), 'utf8')).toContain('—')
  })

  /**
   * THE APPROVAL CHECK. The apply re-plans, which sets `before` to the current content and
   * makes `applyRepair`'s own stale check unreachable outside a microsecond race. The hash is
   * what carries the approval forward: the approval was of a DIFF.
   */
  it('reports a page that changed after the plan as stale, and does not write it', async () => {
    write('wiki/concepts/a.md', withDashes('A'))
    const approved = approvalOf(['wiki/concepts/a.md'])
    // Somebody edits the page between the plan and the apply.
    write('wiki/concepts/a.md', withDashes('A') + '\nA later sentence — added by hand.\n')
    const after = fs.readFileSync(path.join(vault, 'wiki/concepts/a.md'), 'utf8')
    const out = await applySelection(vault, planOf(['wiki/concepts/a.md']), 'repair: dashes', approved, {
      commitMutex: new Mutex(),
      commit,
      lock: async (_v, rels, fn) => fn(rels, []),
    })
    expect(out.stale).toEqual(['wiki/concepts/a.md'])
    expect(out.written).toEqual([])
    expect(commits).toHaveLength(0)
    expect(fs.readFileSync(path.join(vault, 'wiki/concepts/a.md'), 'utf8')).toBe(after)
  })

  /**
   * SKIPPED IS NOT STALE. A held lock means somebody is writing that page right now and the
   * repair can be retried; stale means the diff that was approved no longer describes the
   * page. The two mean different things to the reader, so they are reported apart.
   */
  it('reports a page whose lock is held as busy, not as stale', async () => {
    write('wiki/concepts/a.md', withDashes('A'))
    write('wiki/concepts/b.md', withDashes('B'))
    const paths = ['wiki/concepts/a.md', 'wiki/concepts/b.md']
    const out = await applySelection(vault, planOf(paths), 'repair: dashes', approvalOf(paths), {
      commitMutex: new Mutex(),
      commit,
      lock: async (_v, rels, fn) => fn(rels.filter((r) => r !== 'wiki/concepts/b.md'), ['wiki/concepts/b.md']),
    })
    expect(out.busy).toEqual(['wiki/concepts/b.md'])
    expect(out.stale).toEqual([])
    expect(out.written).toEqual(['wiki/concepts/a.md'])
  })

  it('takes the vault lock OUTSIDE and the commit mutex INSIDE it', async () => {
    write('wiki/concepts/a.md', withDashes('A'))
    const order: string[] = []
    const mutex = new Mutex()
    const wrapped = {
      runExclusive: <T,>(fn: () => Promise<T>): Promise<T> => {
        order.push('mutex in')
        return mutex.runExclusive(fn).finally(() => order.push('mutex out'))
      },
    } as Mutex
    await applySelection(vault, planOf(['wiki/concepts/a.md']), 'repair: dashes', approvalOf(['wiki/concepts/a.md']), {
      commitMutex: wrapped,
      commit,
      lock: async (_v, rels, fn) => {
        order.push('lock in')
        const r = await fn(rels, [])
        order.push('lock out')
        return r
      },
    })
    expect(order).toEqual(['lock in', 'mutex in', 'mutex out', 'lock out'])
  })

  it('refuses to commit without the shared mutex', async () => {
    write('wiki/concepts/a.md', withDashes('A'))
    await expect(
      applySelection(vault, planOf(['wiki/concepts/a.md']), 's', approvalOf(['wiki/concepts/a.md']), {
        commitMutex: undefined as unknown as Mutex,
        commit,
      }),
    ).rejects.toThrow(/never commits outside it/)
  })

  it('does not commit when everything was stale or busy', async () => {
    write('wiki/concepts/a.md', withDashes('A'))
    const out = await applySelection(vault, planOf(['wiki/concepts/a.md']), 's', new Map([['wiki/concepts/a.md', 'wrong']]), {
      commitMutex: new Mutex(),
      commit,
      lock: async (_v, rels, fn) => fn(rels, []),
    })
    expect(out.commit).toBeNull()
    expect(commits).toHaveLength(0)
  })
})

describe('one plan at a time', () => {
  it('refuses a second plan of the same rule and allows another rule', () => {
    const flight = new SingleFlight()
    flight.run('em-dash', () => {
      expect(() => flight.run('em-dash', () => 1)).toThrow(PlanInFlightError)
      expect(flight.run('tag-singleton', () => 2)).toBe(2)
      return 0
    })
    // And the key is free again afterwards, including after a throw.
    expect(flight.run('em-dash', () => 3)).toBe(3)
    expect(() => flight.run('x', () => { throw new Error('boom') })).toThrow('boom')
    expect(flight.run('x', () => 4)).toBe(4)
  })
})

describe('the repair routes', () => {
  let app: FastifyInstance | undefined
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  const serve = async (over: Partial<AppContext> = {}): Promise<FastifyInstance> => {
    const events = new EventBus()
    const jobs = new JobStore(db)
    const config: Config = {
      vaultRoot: vault,
      obsidianVaultName: 'vault',
      auth: null,
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
      ...over,
    })
    return app
  }

  const seed = (): string => {
    write('wiki/concepts/a.md', withDashes('A'))
    execFileSync('git', ['-C', vault, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', vault, 'commit', '-qm', 'fixture'], { stdio: 'ignore' })
    store.record([{ rule: 'em-dash', path: 'wiki/concepts/a.md', message: '2 em-dashes on this page' }], 'job-1')
    return store.list()[0]!.id
  }

  it('resolves ids to paths through the store, never from the body', async () => {
    const id = seed()
    const a = await serve()
    const res = await a.inject({ method: 'POST', url: '/api/v1/validation/repair/plan', payload: { rule: 'em-dash', ids: [id] } })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ pages: Array<{ rel: string }> }>().pages.map((p) => p.rel)).toEqual(['wiki/concepts/a.md'])
  })

  it('rejects the whole request for an unknown id, a mixed rule, or an accepted finding', async () => {
    const id = seed()
    const a = await serve()
    const code = async (payload: { rule: string; ids: string[] }): Promise<number> =>
      (await a.inject({ method: 'POST', url: '/api/v1/validation/repair/plan', payload })).statusCode
    expect(await code({ rule: 'em-dash', ids: [id, 'nope'] })).toBe(404)
    expect(await code({ rule: 'tag-singleton', ids: [id] })).toBe(400)
    expect(await code({ rule: 'em-dash', ids: [] })).toBe(400)
    store.accept(id, 'the dashes are in a quotation')
    expect(await code({ rule: 'em-dash', ids: [id] })).toBe(409)
  })

  it('refuses an approval naming a page the findings do not', async () => {
    const id = seed()
    write('wiki/concepts/other.md', withDashes('Other'))
    const a = await serve()
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/validation/repair/apply',
      payload: { rule: 'em-dash', ids: [id], pages: [{ rel: 'wiki/concepts/other.md', beforeHash: 'x' }] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toContain('not named by the findings')
  })

  /**
   * The post-write sequence (3.5). A write to the vault gets the same check every other run
   * gets: what it introduced lands on the list, what it repaired comes off.
   */
  it('records what the repair introduced and clears what it repaired', async () => {
    const id = seed()
    const a = await serve()
    const planned = await a.inject({ method: 'POST', url: '/api/v1/validation/repair/plan', payload: { rule: 'em-dash', ids: [id] } })
    const pages = planned.json<{ pages: Array<{ rel: string; beforeHash: string }> }>().pages
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/validation/repair/apply',
      payload: { rule: 'em-dash', ids: [id], pages },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ written: string[]; resolved: number; recorded: number }>()
    expect(body.written).toEqual(['wiki/concepts/a.md'])
    // The em-dashes are gone, so the finding is gone.
    expect(fs.readFileSync(path.join(vault, 'wiki/concepts/a.md'), 'utf8')).not.toContain('—')
    expect(body.resolved).toBeGreaterThan(0)
    expect(store.list().some((f) => f.id === id)).toBe(false)
  })
})
