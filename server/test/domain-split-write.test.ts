/**
 * The write of a domain split (docs/tasks/TASKS-DOMAIN-SPLIT.md phase 5 and 6.6), against REAL
 * git in a temp fixture vault, the way `reconcile.test.ts` and the revert tests work: the whole
 * claim of this writer is "one commit, exactly these paths, one revert undoes it", and a mocked
 * git could not show any of that.
 *
 * Synthetic throughout (hard rule 7): domains `alpha` and `other`, pages `Page A01` and so on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { Mutex } from '../src/util/mutex.js'
import { RunRegistry } from '../src/pipeline/run-registry.js'
import { GraphBuilder } from '../src/pipeline/graph.js'
import { commitPaths } from '../src/pipeline/git.js'
import { parseDomainRegistry } from '../src/pipeline/domains.js'
import { renderIndex } from '../src/pipeline/hubs.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { MemoryDomainSplitStore, SqliteDomainSplitStore } from '../src/db/domain-splits.js'
import { JobStore } from '../src/db/jobs.js'
import {
  applyRemainder,
  applySplit,
  listSplits,
  parseSplitRequest,
  planSplit,
  refileText,
  remainderOf,
  revertSplit,
  SplitRefused,
  type SplitRequest,
  type SplitWriterOptions,
} from '../src/pipeline/domain-split-write.js'
import type { withWikiLocks } from '../src/pipeline/wiki-lock.js'

let vault: string
const git = (...args: string[]): string => execFileSync('git', ['-C', vault, ...args], { stdio: 'pipe' }).toString()
const head = (): string => git('rev-parse', 'HEAD').trim()
const status = (): string => git('status', '--porcelain', '--untracked-files=all').trim()
const read = (rel: string): string => fs.readFileSync(path.join(vault, rel), 'utf8')
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true })
  fs.writeFileSync(path.join(vault, rel), text, 'utf8')
}

const REGISTRY = `---
type: meta
title: "Domain Registry"
---

# Domain Registry

Conventions for the human.

## Domains

## alpha

Everything alpha: the first, the second and the third subject.

**Tags:** \`one\`, \`two\`, \`three\`

## other

Something else.
`

const page = (n: string, domain: string, links: string[] = []): string =>
  `---\ntype: concept\ntitle: "Page ${n}"\naddress: c-${n}\ndomain: ${domain}\ncreated: 2026-01-01\nupdated: 2026-01-01\ncontent_updated: 2026-01-01\ntags:\n  - t${n.slice(0, 1)}\n---\n\n# Page ${n}\n\n${links.map((l) => `[[Page ${l}]]`).join(' ')}\n`

/** Twelve alpha pages (A01..A06 become `first`, B01..B04 `second`, C01..C02 stay), two other. */
const PAGES = [
  ...['01', '02', '03', '04', '05', '06'].map((i) => `A${i}`),
  ...['01', '02', '03', '04'].map((i) => `B${i}`),
  'C01',
  'C02',
]

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'split-write-'))
  git('init', '-q')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  write('wiki/meta/domains.md', REGISTRY)
  for (const n of PAGES) write(`wiki/concepts/Page ${n}.md`, page(n, 'alpha', [PAGES[(PAGES.indexOf(n) + 1) % PAGES.length]!]))
  write('wiki/concepts/Page X01.md', page('X01', 'other'))
  write('wiki/concepts/Page X02.md', page('X02', 'other'))
  write('wiki/index.md', renderIndex(vault))
  git('add', '-A')
  git('commit', '-qm', 'fixture')
})
afterEach(() => fs.rmSync(vault, { recursive: true, force: true }))

const REQUEST: SplitRequest = {
  parent: 'alpha',
  parentEntry: { description: 'Alpha, narrowed. Pages on `first` and `second` have their own domains.', tags: ['three'] },
  children: [
    {
      key: 'first',
      description: 'The first subject.',
      tags: ['one'],
      pages: ['A01', 'A02', 'A03', 'A04', 'A05', 'A06'].map((n) => ({ address: `c-${n}`, path: `wiki/concepts/Page ${n}.md` })),
    },
    {
      key: 'second',
      description: 'The second subject.',
      tags: ['two'],
      pages: ['B01', 'B02', 'B03', 'B04'].map((n) => ({ address: `c-${n}`, path: `wiki/concepts/Page ${n}.md` })),
    },
  ],
}

/** The fake lock executor of the existing lock tests' shape: these paths are held by someone else. */
const busyLock =
  (busy: readonly string[]): typeof withWikiLocks =>
  async (_root, rels, fn) =>
    fn(
      rels.filter((r) => !busy.includes(r)),
      rels.filter((r) => busy.includes(r)),
    )

let store: MemoryDomainSplitStore
let registry: RunRegistry
const opts = (over: Partial<SplitWriterOptions> = {}): SplitWriterOptions => ({
  commitMutex: new Mutex(),
  runRegistry: registry,
  autoCommit: () => true,
  store,
  day: '2026-09-23',
  ...over,
})
beforeEach(() => {
  store = new MemoryDomainSplitStore()
  registry = new RunRegistry()
})

const filesOf = (hash: string): string[] =>
  git('show', '--name-only', '--pretty=format:', hash).split('\n').filter(Boolean).sort()

describe('parseSplitRequest', () => {
  it('accepts the fixture request and refuses what the request itself gets wrong', () => {
    expect(parseSplitRequest('alpha', REQUEST).ok).toBe(true)
    const bad = (patch: Record<string, unknown>): string => {
      const r = parseSplitRequest('alpha', { ...REQUEST, ...patch })
      return r.ok ? 'ok' : r.error
    }
    expect(bad({ children: [] })).toMatch(/at least one child/)
    expect(bad({ parentEntry: { description: '', tags: [] } })).toMatch(/parent needs a description/)
    expect(bad({ children: [{ ...REQUEST.children[0], key: 'Not a key' }] })).toMatch(/not a domain key/)
    expect(bad({ children: [{ ...REQUEST.children[0], key: 'unassigned' }] })).toMatch(/reserved/)
    expect(bad({ children: [{ ...REQUEST.children[0], key: 'alpha' }] })).toMatch(/parent's own key/)
    expect(bad({ children: [REQUEST.children[0], { ...REQUEST.children[1], pages: REQUEST.children[0]!.pages }] })).toMatch(
      /listed more than once/,
    )
    expect(bad({ children: [REQUEST.children[0], { ...REQUEST.children[0], pages: [{ address: 'c-C01', path: 'x' }] }] })).toMatch(
      /listed twice/,
    )
  })
})

describe('the registry text of a request', () => {
  it('is plain text: wikilinks and Markdown links become their words', () => {
    const r = parseSplitRequest('alpha', {
      ...REQUEST,
      parentEntry: { description: 'What stays; [[first]] and [[Page A01|the first page]] left.', tags: [] },
      children: [{ ...REQUEST.children[0]!, description: 'See [the guide](https://example.invalid).' }],
    })
    expect(r.ok && r.request.parentEntry.description).toBe('What stays; first and the first page left.')
    expect(r.ok && r.request.children[0]!.description).toBe('See the guide.')
  })
})

describe('refileText', () => {
  it('changes exactly the domain line, keeps its quoting, stamps updated and never content_updated', () => {
    const before = page('A01', 'alpha').replace('domain: alpha', 'domain: "alpha"')
    const after = refileText(before, 'first', '2026-09-23')!
    expect(after).toContain('domain: "first"\n')
    expect(after).toContain('updated: 2026-09-23\n')
    expect(after).toContain('content_updated: 2026-01-01\n')
    const changed = before.split('\n').filter((l, i) => l !== after.split('\n')[i])
    expect(changed).toEqual(['domain: "alpha"', 'updated: 2026-01-01'])
  })
})

describe('the plan', () => {
  it('writes nothing: HEAD and the tree unchanged', () => {
    const before = head()
    const plan = planSplit(vault, REQUEST, new GraphBuilder(vault).build())
    expect(head()).toBe(before)
    expect(status()).toBe('')
    expect(plan.counts).toEqual({ ok: 10, gone: 0, moved: 0, unaddressed: 0 })
    expect(plan.pages.every((p) => p.from === 'domain: alpha' && p.to === `domain: ${p.child}`)).toBe(true)
    expect(plan.registry.sections).toEqual(['alpha', 'first', 'second'])
    expect(plan.index).toEqual([
      { domain: 'alpha', pages: 2 },
      { domain: 'first', pages: 6 },
      { domain: 'second', pages: 4 },
      { domain: 'other', pages: 2 },
    ])
    // The parent keeps two pages, under the shelf minimum: said, not blocked.
    expect(plan.warnings).toContainEqual({ kind: 'parent-small', keeps: 2, min: 25 })
  })

  it('counts a key that is also a tag, inside the child and elsewhere', () => {
    write('wiki/concepts/Page X01.md', page('X01', 'other').replace('  - tX', '  - first'))
    write('wiki/concepts/Page A01.md', page('A01', 'alpha').replace('  - tA', '  - first'))
    const plan = planSplit(vault, REQUEST, new GraphBuilder(vault).build())
    expect(plan.warnings).toContainEqual({ kind: 'key-collision', key: 'first', inside: 1, elsewhere: 1 })
  })

  it('refuses a key the registry already lists', () => {
    expect(() => planSplit(vault, { ...REQUEST, children: [{ ...REQUEST.children[0]!, key: 'other' }] })).toThrow(SplitRefused)
  })
})

describe('the apply', () => {
  it('is ONE commit containing exactly the registry, the index and the written pages', async () => {
    const before = head()
    const r = await applySplit(vault, REQUEST, opts())
    expect(git('rev-list', '--count', `${before}..HEAD`).trim()).toBe('1')
    expect(r.commit).toBe(head())
    const expected = [
      'wiki/index.md',
      'wiki/meta/domains.md',
      ...[...REQUEST.children[0]!.pages, ...REQUEST.children[1]!.pages].map((p) => p.path),
    ].sort()
    expect(filesOf(r.commit)).toEqual(expected)
    expect(git('log', '-1', '--pretty=%s').trim()).toBe('domains: split alpha into 2 (10 pages)')
    expect(status()).toBe('')
    expect(r.written).toHaveLength(10)
    expect(r.skipped).toEqual([])
    expect(r.verified).toBe(true)
  })

  it('changes exactly two lines per page, domain and updated, and never content_updated', async () => {
    const r = await applySplit(vault, REQUEST, opts())
    for (const w of r.written) {
      const diff = git('show', '--pretty=format:', '--unified=0', r.commit, '--', w.path)
      const lines = diff.split('\n').filter((l) => /^[-+](?![-+])/.test(l)).sort()
      expect(lines).toEqual([`+domain: ${w.child}`, '+updated: 2026-09-23', '-domain: alpha', '-updated: 2026-01-01'])
    }
    expect(git('show', r.commit)).not.toMatch(/^[-+]content_updated/m)
  })

  it('writes the narrowed parent and the children directly after it', async () => {
    await applySplit(vault, REQUEST, opts())
    const domains = parseDomainRegistry(read('wiki/meta/domains.md')).domains
    expect(domains.map((d) => d.key)).toEqual(['alpha', 'first', 'second', 'other'])
    expect(domains[0]!.tags).toEqual(['three'])
  })

  it('lists the moved pages under the children in the index', async () => {
    await applySplit(vault, REQUEST, opts())
    const index = read('wiki/index.md')
    const section = (d: string): string => index.slice(index.indexOf(`## ${d}`)).split(/\n## /)[0]!
    expect(index.indexOf('## first')).toBeGreaterThan(index.indexOf('## alpha'))
    expect(section('first')).toContain('Page A01')
    expect(section('second')).toContain('Page B04')
    expect(section('alpha')).not.toContain('Page A01')
    expect(section('alpha')).toContain('Page C01')
  })

  it('skips moved, gone, unaddressed and busy pages with their reasons, and writes none of them', async () => {
    write('wiki/concepts/Page A02.md', page('A02', 'other'))
    fs.rmSync(path.join(vault, 'wiki/concepts/Page A03.md'))
    git('add', '-A')
    git('commit', '-qm', 'by hand')
    const req: SplitRequest = {
      ...REQUEST,
      children: [
        { ...REQUEST.children[0]!, pages: [...REQUEST.children[0]!.pages, { address: null, path: 'wiki/concepts/Page C01.md' }] },
        REQUEST.children[1]!,
      ],
    }
    const r = await applySplit(vault, req, opts({ lock: busyLock(['wiki/concepts/Page A04.md']) }))
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]))
    expect(reasons).toEqual({
      'wiki/concepts/Page A02.md': 'moved',
      'wiki/concepts/Page A03.md': 'gone',
      'wiki/concepts/Page C01.md': 'unaddressed',
      'wiki/concepts/Page A04.md': 'busy',
    })
    expect(r.written).toHaveLength(7)
    const files = filesOf(r.commit)
    for (const p of Object.keys(reasons)) expect(files).not.toContain(p)
    expect(read('wiki/concepts/Page A04.md')).toContain('domain: alpha')
    expect(read('wiki/concepts/Page A02.md')).toContain('domain: other')
  })

  it('refuses the whole apply when the registry or the index is busy, and writes nothing', async () => {
    for (const hub of ['wiki/meta/domains.md', 'wiki/index.md']) {
      const before = head()
      await expect(applySplit(vault, REQUEST, opts({ lock: busyLock([hub]) }))).rejects.toMatchObject({ code: 'registry-busy' })
      expect(head()).toBe(before)
      expect(status()).toBe('')
    }
  })

  it('refuses while a run writes the vault, and with auto-commit off', async () => {
    const end = registry.begin()
    await expect(applySplit(vault, REQUEST, opts())).rejects.toMatchObject({ code: 'run-active' })
    end()
    await expect(applySplit(vault, REQUEST, opts({ autoCommit: () => false }))).rejects.toMatchObject({ code: 'auto-commit-off' })
    expect(status()).toBe('')
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('1')
  })

  it('is counted by RunRegistry while it writes, and not afterwards', async () => {
    let during = -1
    await applySplit(
      vault,
      REQUEST,
      opts({
        commit: async (root, msg, paths) => {
          during = registry.activeRuns
          return commitPaths(root, msg, paths)
        },
      }),
    )
    expect(during).toBe(1)
    expect(registry.activeRuns).toBe(0)
  })

  it('finds a page renamed between plan and apply by its address, and writes it at its new path', async () => {
    planSplit(vault, REQUEST)
    git('mv', 'wiki/concepts/Page A05.md', 'wiki/concepts/Page A05 renamed.md')
    git('commit', '-qm', 'rename')
    const r = await applySplit(vault, REQUEST, opts())
    expect(r.written.map((w) => w.path)).toContain('wiki/concepts/Page A05 renamed.md')
    expect(read('wiki/concepts/Page A05 renamed.md')).toContain('domain: first')
    expect(fs.existsSync(path.join(vault, 'wiki/concepts/Page A05.md'))).toBe(false)
  })

  it('reports a page the read-back does not find with its child key', async () => {
    const r = await applySplit(
      vault,
      REQUEST,
      opts({ afterCommit: () => write('wiki/concepts/Page B02.md', page('B02', 'alpha')) }),
    )
    expect(r.verified).toBe(false)
    expect(r.unverified).toEqual(['wiki/concepts/Page B02.md'])
  })

  it('puts every file back and commits nothing when the commit fails', async () => {
    const before = head()
    await expect(
      applySplit(vault, REQUEST, opts({ commit: async () => Promise.reject(new Error('git broke')) })),
    ).rejects.toThrow('git broke')
    expect(head()).toBe(before)
    expect(status()).toBe('')
  })
})

describe('the remainder', () => {
  it('holds a page set back to the parent after the split, and one re-file moves exactly it', async () => {
    const r = await applySplit(vault, REQUEST, opts())
    const rec = store.get(r.splitId)!
    expect(remainderOf(vault, rec)).toEqual([])
    write('wiki/concepts/Page B03.md', read('wiki/concepts/Page B03.md').replace('domain: second', 'domain: alpha'))
    git('commit', '-qam', 'set back by hand')
    expect(remainderOf(vault, rec)).toEqual([{ address: 'c-B03', path: 'wiki/concepts/Page B03.md', child: 'second' }])
    expect(listSplits(vault, store)[0]!.remainder).toBe(1)

    const out = await applyRemainder(vault, r.splitId, opts())
    // The hand edit left the index as the split rendered it, with the page under its child: the
    // re-file renders the same index again, and an unchanged file is no part of a commit.
    expect(filesOf(out.commit)).toEqual(['wiki/concepts/Page B03.md'])
    expect(git('log', '-1', '--pretty=%s').trim()).toBe('domains: re-file 1 page after the split of alpha')
    expect(store.get(r.splitId)!.commits).toEqual([r.commit, out.commit])
    expect(listSplits(vault, store)[0]!.remainder).toBe(0)
  })

  it('keeps a busy page as remainder, does not count a page moved elsewhere by hand, and re-files it with the index', async () => {
    const r = await applySplit(vault, REQUEST, opts({ lock: busyLock(['wiki/concepts/Page A06.md']) }))
    write('wiki/concepts/Page A01.md', read('wiki/concepts/Page A01.md').replace('domain: first', 'domain: other'))
    git('commit', '-qam', 'elsewhere by hand')
    expect(remainderOf(vault, store.get(r.splitId)!).map((p) => p.address)).toEqual(['c-A06'])
    // The page the split never moved is under the parent in the split's index: this commit is
    // the page and the index, which is stage E7's expectation.
    const out = await applyRemainder(vault, r.splitId, opts())
    expect(filesOf(out.commit)).toEqual(['wiki/concepts/Page A06.md', 'wiki/index.md'])
  })
})

describe('the revert (D17)', () => {
  it('restores the pre-split tree: every page and the registry, the index re-rendered', async () => {
    const pre = head()
    const r = await applySplit(vault, REQUEST, opts({ lock: busyLock(['wiki/concepts/Page A06.md']) }))
    await applyRemainder(vault, r.splitId, opts())
    const out = await revertSplit(vault, r.splitId, opts())
    expect(out.commits).toHaveLength(2)
    expect(git('diff', pre, 'HEAD', '--', '.', ':!wiki/index.md').trim()).toBe('')
    expect(read('wiki/index.md')).toBe(renderIndex(vault))
    expect(read('wiki/index.md')).not.toContain('## first')
    expect(store.get(r.splitId)!.revertedAt).not.toBeNull()
    expect(status()).toBe('')
  })

  it('refuses, naming the pages, while a page outside the split carries one of its keys', async () => {
    const r = await applySplit(vault, REQUEST, opts())
    write('wiki/concepts/Page N01.md', page('N01', 'first'))
    git('add', '-A')
    git('commit', '-qm', 'an ingest filed a page into a child')
    const before = head()
    await expect(revertSplit(vault, r.splitId, opts())).rejects.toMatchObject({
      code: 'orphans',
      detail: { pages: ['wiki/concepts/Page N01.md'] },
    })
    expect(head()).toBe(before)
  })

  it('aborts on a conflict and leaves the tree byte-identical, even after an earlier revert succeeded', async () => {
    const r = await applySplit(vault, REQUEST, opts({ lock: busyLock(['wiki/concepts/Page A06.md']) }))
    await applyRemainder(vault, r.splitId, opts())
    // A later commit rewrites a line the split changed: the split commit's revert conflicts,
    // and the remainder's revert, which went through first, must be undone with it.
    write('wiki/concepts/Page A01.md', read('wiki/concepts/Page A01.md').replace('updated: 2026-09-23', 'updated: 2026-09-24'))
    git('commit', '-qam', 'a later edit')
    const before = head()
    const snapshot = read('wiki/concepts/Page A06.md')
    await expect(revertSplit(vault, r.splitId, opts())).rejects.toMatchObject({ code: 'revert-failed' })
    expect(head()).toBe(before)
    expect(status()).toBe('')
    expect(read('wiki/concepts/Page A06.md')).toBe(snapshot)
    expect(store.get(r.splitId)!.revertedAt).toBeNull()
  })
})

describe('migration 37', () => {
  it('applies on a populated v36 database: every row kept, foreign keys clean', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.filter((m) => m.version <= 36)) {
      db.exec(m.up)
      db.pragma(`user_version = ${m.version}`)
    }
    // Seed a row into every table there is, so "every row count is preserved" means something.
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(
      (t) => t.name,
    )
    new JobStore(db).create({ source: 'drop', type: 'text' })
    db.prepare("INSERT INTO domain_dismissals (user_id, key, dismissed_at) VALUES ('local', 'k', 'x')").run()
    const count = (t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n
    const before = Object.fromEntries(tables.map((t) => [t, count(t)]))
    expect(before['jobs']).toBe(1)
    expect(before['job_logs']).toBeGreaterThan(0)

    db.exec(MIGRATIONS.find((m) => m.version === 37)!.up)
    db.pragma('user_version = 37')

    expect(Object.fromEntries(tables.map((t) => [t, count(t)]))).toEqual(before)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    const s = new SqliteDomainSplitStore(db)
    const rec = s.create('alpha', [{ key: 'first', addresses: ['c-1'] }], 'abc')
    s.addCommit(rec.id, 'def')
    expect(s.get(rec.id)!.commits).toEqual(['abc', 'def'])
    s.decide('alpha', 'fp', 'defer')
    s.decide('alpha', 'fp', 'leave')
    expect(s.decisions('alpha').map((d) => d.decision)).toEqual(['leave'])
    s.restore('alpha', 'fp')
    expect(s.decisions('alpha')).toEqual([])
  })
})
