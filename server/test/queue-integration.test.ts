/**
 * M1 acceptance, deterministic slice (SPEC.md §10, TASKS-M1 §4): 10 mixed files through
 * the queue at concurrency 2, against a REAL temporary git vault with REAL preprocessing
 * and REAL commits. The agent run is faked — it writes a unique wiki page per job, the
 * way the real ingest skill writes pages — so the test proves the queue + git + commit
 * orchestration is sound and loses/corrupts nothing under concurrency, without spending
 * tokens. The real end-to-end run (actual agent, full toolchain) is a separate,
 * user-gated step documented in TASKS-M1 §4.
 *
 * Per-file contention on shared vault files (index/log/hot) is the vault's own
 * wiki-lock.sh domain, verified sound in M0; this test uses unique per-job pages and
 * exercises OUR commit serialization, not the vault's locking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue, type IngestRunner } from '../src/pipeline/queue.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/index.js'
import { RunRegistry } from '../src/pipeline/run-registry.js'
import { VaultReconciler } from '../src/pipeline/reconcile.js'
import { EventBus } from '../src/pipeline/events.js'
import { revertCommit } from '../src/pipeline/git.js'
import { Mutex } from '../src/util/mutex.js'

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

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

let db: Db
let store: JobStore
let vaultRoot: string
let srcDir: string

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-git-'))
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'))
  // A real vault-like git repo.
  git(vaultRoot, 'init', '-q')
  // Repo-local identity, the way every other git-using test here sets it. Not decoration: the
  // commands below that WRITE a commit (the seed, and the revert in step 8) fall back to the
  // global git config, and a CI runner has none. A laptop cannot catch this.
  git(vaultRoot, 'config', 'user.email', 't@t')
  git(vaultRoot, 'config', 'user.name', 't')
  git(vaultRoot, 'config', 'commit.gpgsign', 'false')
  fs.mkdirSync(path.join(vaultRoot, 'wiki', 'concepts'), { recursive: true })
  fs.mkdirSync(path.join(vaultRoot, '.raw'), { recursive: true })
  fs.writeFileSync(path.join(vaultRoot, 'wiki', 'index.md'), '# Index\n')
  git(vaultRoot, 'add', '-A')
  git(vaultRoot, 'commit', '-q', '-m', 'init')
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
  fs.rmSync(srcDir, { recursive: true, force: true })
})

describe('M1 acceptance: 10 mixed files at concurrency 2 (deterministic)', () => {
  it('all reach done, every page is committed, and the vault stays consistent', async () => {
    // Fake agent: writes a unique page per ingest AND reports it as a Write tool call the
    // way the real agent does (filesystem transport), so F4 path-scoping can stage it.
    let pageSeq = 0
    const runIngest: IngestRunner = async (opts) => {
      const n = pageSeq++
      // Small async gap so runs genuinely overlap at concurrency 2.
      await new Promise((r) => setTimeout(r, 5))
      const page = path.join(vaultRoot, 'wiki', 'concepts', `Page-${n}.md`)
      fs.writeFileSync(page, `# Page ${n}\n\nIngested content ${n}.\n`)
      opts.onMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: page } }] },
      } as never)
      return {
        ok: true,
        result: `wrote Page-${n}`,
        usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.01 },
        durationMs: 5,
        numTurns: 3,
        sessionId: `s${n}`,
        timedOut: false,
      }
    }

    const queue = new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 2,
      detectToolsFn: async () => NO_TOOLS,
      refreshHotCache: async () => 'noop',
      runIngest,
      // real commitVault + real changedWikiPages (defaults)
    })
    queue.start()

    // 10 mixed (tool-free) sources: .md and .txt, distinct content so no dedupe collisions.
    const jobIds: string[] = []
    for (let i = 0; i < 10; i++) {
      const ext = i % 2 === 0 ? 'md' : 'txt'
      const src = path.join(srcDir, `file${i}.${ext}`)
      fs.writeFileSync(src, `# Source ${i}\n\nUnique body ${i} ${'x'.repeat(i)}.\n`)
      const { job } = await queue.enqueueFile({ sourcePath: src, source: 'drop' })
      jobIds.push(job.id)
    }

    await queue.onIdle()

    // 1. Every job reached done.
    const statuses = jobIds.map((id) => store.getOrThrow(id).status)
    expect(statuses).toEqual(Array(10).fill('done'))

    // 2. Working tree is clean — every page a job wrote is committed (nothing lost).
    expect(git(vaultRoot, 'status', '--porcelain').trim()).toBe('')

    // 3. All 10 pages exist in HEAD.
    const tracked = git(vaultRoot, 'ls-files', 'wiki/concepts').trim().split('\n')
    for (let n = 0; n < 10; n++) {
      expect(tracked).toContain(`wiki/concepts/Page-${n}.md`)
    }

    // 4. The repository is not corrupt.
    expect(() => git(vaultRoot, 'fsck', '--full')).not.toThrow()

    // 5. At least one ingest commit landed, each authored by the service.
    const log = git(vaultRoot, 'log', '--format=%an|%s').trim().split('\n')
    const ingestCommits = log.filter((l) => l.startsWith('vault-service|ingest: '))
    expect(ingestCommits.length).toBeGreaterThan(0)

    // 6. created_pages attribution loses nothing: under the shared-commit-under-mutex
    // design a page may be recorded by the sibling job that swept it into its commit, so
    // an individual job's list can be empty — but the UNION must cover all 10 pages.
    const attributed = new Set<string>()
    for (const id of jobIds) {
      for (const p of JSON.parse(store.getOrThrow(id).created_pages ?? '[]') as string[]) attributed.add(p)
    }
    for (let n = 0; n < 10; n++) {
      expect(attributed).toContain(`wiki/concepts/Page-${n}.md`)
    }

    // 7. F4: each ingest commit contains exactly its OWN page — no sibling sweeping.
    const ingestHashes = git(vaultRoot, 'log', '--format=%H', '--grep=ingest: ')
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(ingestHashes.length).toBe(10) // one commit per ingest, none swept together
    for (const h of ingestHashes) {
      const files = git(vaultRoot, 'show', '--name-only', '--pretty=format:', h).trim().split('\n')
      const pages = files.filter((f) => f.startsWith('wiki/concepts/Page-'))
      expect(pages).toHaveLength(1)
    }

    // 8. Reverting one ingest removes only its page; siblings are untouched.
    //
    // Through the service's own `revertCommit`, which is what the dashboard's button calls -
    // a plain `git revert` cannot do this any more and should not be asked to. Every commit
    // now carries the service-written hub files (SPEC.md §12.12), so every later commit
    // touches them too, and reverting a whole older commit conflicts on the hubs rather than
    // on anything the run wrote. `revertCommit` reverts the commit's own paths and leaves the
    // hubs alone, which is also what reverting means here: the index is regenerated from the
    // pages that remain, and the log is a record of something that really did happen.
    const target = 'wiki/concepts/Page-3.md'
    const targetHash = ingestHashes.find((h) =>
      git(vaultRoot, 'show', '--name-only', '--pretty=format:', h).includes(target),
    )!
    const undone = await revertCommit(vaultRoot, targetHash)
    expect(undone).toMatchObject({ reverted: true })
    expect(fs.existsSync(path.join(vaultRoot, target))).toBe(false)
    expect(fs.existsSync(path.join(vaultRoot, 'wiki', 'concepts', 'Page-4.md'))).toBe(true)
    expect(git(vaultRoot, 'status', '--porcelain').trim()).toBe('')
  })

  it('processes a batch with a duplicate: the dup is skipped, the rest complete', async () => {
    let pageSeq = 0
    const runIngest: IngestRunner = async (opts) => {
      const n = pageSeq++
      const page = path.join(vaultRoot, 'wiki', 'concepts', `B-${n}.md`)
      fs.writeFileSync(page, `# B ${n}\n`)
      opts.onMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: page } }] },
      } as never)
      return {
        ok: true,
        result: 'ok',
        usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
        durationMs: 1,
        numTurns: 1,
        sessionId: 's',
        timedOut: false,
      }
    }
    const queue = new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 2,
      detectToolsFn: async () => NO_TOOLS,
      refreshHotCache: async () => 'noop',
      runIngest,
    })
    queue.start()

    const a = path.join(srcDir, 'a.md')
    fs.writeFileSync(a, 'identical content')
    const dup = path.join(srcDir, 'a-copy.md')
    fs.writeFileSync(dup, 'identical content') // same bytes → same sha256

    const first = await queue.enqueueFile({ sourcePath: a, source: 'drop' })
    const second = await queue.enqueueFile({ sourcePath: dup, source: 'watch' })
    await queue.onIdle()

    expect(store.getOrThrow(first.job.id).status).toBe('done')
    expect(store.getOrThrow(second.job.id).status).toBe('duplicate')
    expect(pageSeq).toBe(1) // the duplicate never ran the agent
  })
})

describe('reconcile: pages no run could stage, under real concurrency', () => {
  it('commits Bash-written pages that every per-run sweep had to sit out', async () => {
    // The real loss, reproduced end to end. The agent writes TWO pages and reports only one
    // as a Write tool call - the second stands for a page created with Bash (a heredoc, a
    // python script, an `mv`), which the commit pathspec cannot see.
    //
    // At concurrency 2 no run is ever the sole vault writer, so the per-run F4 sweep sits
    // out every single time. Before the reconcile pass those second pages stayed on disk,
    // outside git, silently - which is how two dozen of them accumulated over a month.
    let pageSeq = 0
    const runIngest: IngestRunner = async (opts) => {
      const n = pageSeq++
      await new Promise((r) => setTimeout(r, 15))
      const reported = path.join(vaultRoot, 'wiki', 'concepts', `Reported-${n}.md`)
      fs.writeFileSync(reported, `# Reported ${n}\n`)
      opts.onMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: reported } }] },
      } as never)
      // Written, never reported: the F4 blind spot.
      fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', `Unreported-${n}.md`), `# Unreported ${n}\n`)
      return {
        ok: true,
        result: `wrote ${n}`,
        usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.01 },
        durationMs: 5,
        numTurns: 3,
        sessionId: `s${n}`,
        timedOut: false,
      }
    }

    const registry = new RunRegistry()
    const events = new EventBus()
    const commitMutex = new Mutex()
    const queue = new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 2,
      runRegistry: registry,
      commitMutex,
      events,
      detectToolsFn: async () => NO_TOOLS,
      refreshHotCache: async () => 'noop',
      runIngest,
    })
    new VaultReconciler({ vaultRoot, commitMutex, runRegistry: registry, events }).attach()
    queue.start()

    for (let i = 0; i < 4; i++) {
      const src = path.join(srcDir, `f${i}.md`)
      fs.writeFileSync(src, `# Source ${i}\n\nUnique body ${i} ${'x'.repeat(i)}.\n`)
      await queue.enqueueFile({ sourcePath: src, source: 'drop' })
    }
    await queue.onIdle()
    // The pass is scheduled off the last writer's release, so it lands just after idle.
    await new Promise((r) => setTimeout(r, 400))

    const tracked = git(vaultRoot, 'ls-files', 'wiki/concepts').trim().split('\n')
    for (let n = 0; n < 4; n++) {
      expect(tracked).toContain(`wiki/concepts/Reported-${n}.md`)
      // This is the assertion that fails without the reconcile pass.
      expect(tracked).toContain(`wiki/concepts/Unreported-${n}.md`)
    }
    expect(git(vaultRoot, 'status', '--porcelain').trim()).toBe('')
    expect(() => git(vaultRoot, 'fsck', '--full')).not.toThrow()
  })
})

describe('quote integrity after a run (docs/sources/SPEC.md section 7)', () => {
  it('finds the invented quote, keeps the held one, and puts both numbers on the job', async () => {
    const source = ['# A paper', '', 'The trial enrolled 412 adults.', 'The measurement held across every site.'].join('\n')
    /*
     * A run that quotes once faithfully and once from thin air - which is what the check is for,
     * and what the calibration over the live vault found the runs do (section 7.6).
     */
    const runIngest: IngestRunner = async (opts) => {
      const page = path.join(vaultRoot, 'wiki', 'sources', 'A Paper.md')
      fs.mkdirSync(path.dirname(page), { recursive: true })
      fs.writeFileSync(
        page,
        '# A Paper\n\nThe authors write that "the measurement held across every site", and add that\n"every site reported the same funding source".\n',
      )
      opts.onMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: page } }] },
      } as never)
      return {
        ok: true,
        result: 'wrote A Paper',
        usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.01 },
        durationMs: 5,
        numTurns: 2,
        sessionId: 's1',
        timedOut: false,
      }
    }
    const queue = new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 1,
      detectToolsFn: async () => NO_TOOLS,
      refreshHotCache: async () => 'noop',
      runIngest,
    })
    queue.start()
    const src = path.join(srcDir, 'paper.md')
    fs.writeFileSync(src, source)
    const { job } = await queue.enqueueFile({ sourcePath: src, source: 'drop' })
    await queue.onIdle()

    expect(store.getOrThrow(job.id).status).toBe('done')
    // The summary the record shows, on the job row (schema v27).
    expect(JSON.parse(store.getOrThrow(job.id).validation ?? 'null')).toEqual({ quotes: { checked: 2, unverified: 1 } })
    const log = store.logs(job.id).map((l) => `${l.level} ${l.message}`)
    expect(log).toContain('warn quotes: 2 checked, 1 not found in the source')
    expect(log.some((l) => l.includes('validation [quote] wiki/sources/A Paper.md') && l.includes('every site reported the same funding source'))).toBe(true)
    // Advisory only: the page is in the vault exactly as the run wrote it.
    expect(fs.readFileSync(path.join(vaultRoot, 'wiki', 'sources', 'A Paper.md'), 'utf8')).toMatch(/same funding source/)
    expect(git(vaultRoot, 'status', '--porcelain').trim()).toBe('')
  })
})

/**
 * `content_updated:` on the pages a run wrote (SPEC.md §12.13, task 7.3).
 *
 * Found by the first real ingest after 7.3 shipped: four of five new pages carried `updated:`
 * and no `content_updated:`. The field is written by OUR writers, and an ingest's pages are
 * written by the AGENT from the vault's own frontmatter template, which has no such field - so
 * the one path that produces most of the vault's pages was the one path not filling it.
 *
 * Stamped by the service after the run, inside the run's own commit, rather than asked of the
 * agent: a prompt rule holds only as long as every run remembers it, and the point of the
 * field is that a later reader can trust it.
 */
describe('content_updated: after a run', () => {
  const writes = (pages: Record<string, string>): IngestRunner => {
    return async (opts) => {
      for (const [rel, body] of Object.entries(pages)) {
        const abs = path.join(vaultRoot, rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, body)
        opts.onMessage({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: abs } }] },
        } as never)
      }
      return {
        ok: true, result: 'wrote pages', usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
        durationMs: 1, numTurns: 1, sessionId: 's', timedOut: false,
      }
    }
  }
  const run = async (runIngest: IngestRunner): Promise<string> => {
    const queue = new IngestQueue({
      store, vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 1, detectToolsFn: async () => NO_TOOLS, refreshHotCache: async () => 'noop', runIngest,
    })
    queue.start()
    const src = path.join(srcDir, 'doc.md')
    fs.writeFileSync(src, '# A document\n\nSomething to ingest.\n')
    const { job } = await queue.enqueueFile({ sourcePath: src, source: 'drop' })
    await queue.onIdle()
    return job.id
  }
  const read = (rel: string): string => fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
  const field = (rel: string, name: string): string | null =>
    new RegExp(`^${name}:[ \\t]*(.+)$`, 'm').exec(read(rel))?.[1]?.trim() ?? null

  it('stamps a page the run wrote, which the agent never does itself', () => {
    // The agent writes the vault's template: `updated:`, no `content_updated:`.
    return run(writes({ 'wiki/concepts/New Thing.md': '---\ntype: concept\nupdated: 2020-01-01\n---\n\n# New Thing\n' })).then(() => {
      expect(field('wiki/concepts/New Thing.md', 'content_updated')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(field('wiki/concepts/New Thing.md', 'updated')).toBe(field('wiki/concepts/New Thing.md', 'content_updated'))
    })
  })

  it('does NOT stamp the hubs, which are navigation rather than a subject', async () => {
    await run(writes({
      'wiki/concepts/Real.md': '---\ntype: concept\n---\n\n# Real\n',
      'wiki/hot.md': '---\ntype: meta\n---\n\n# Hot\n',
    }))
    expect(field('wiki/concepts/Real.md', 'content_updated')).not.toBeNull()
    expect(field('wiki/hot.md', 'content_updated')).toBeNull()
    // The index and the log are written by the service itself and must not carry it either.
    expect(read('wiki/index.md')).not.toContain('content_updated:')
    expect(read('wiki/log.md')).not.toContain('content_updated:')
  })

  it('does not stamp a bucket hub the run added a line to', async () => {
    await run(writes({
      'wiki/concepts/Real.md': '---\ntype: concept\n---\n\n# Real\n',
      'wiki/concepts/_index.md': '---\ntype: meta\n---\n\n## physics\n\n- [[Real]] - a line\n',
    }))
    expect(field('wiki/concepts/_index.md', 'content_updated')).toBeNull()
  })

  it('leaves a page with no frontmatter exactly as the run wrote it', async () => {
    await run(writes({ 'wiki/concepts/Bare.md': '# Bare\n\nNo frontmatter at all.\n' }))
    expect(read('wiki/concepts/Bare.md')).toBe('# Bare\n\nNo frontmatter at all.\n')
  })

  it('never touches the body', async () => {
    const body = '# Real\n\nA paragraph with --- in it.\n'
    await run(writes({ 'wiki/concepts/Real.md': `---\ntype: concept\n---\n\n${body}` }))
    expect(read('wiki/concepts/Real.md')).toContain(body)
  })

  it('rides in the run\'s own commit, so the vault is clean afterwards', async () => {
    const jobId = await run(writes({ 'wiki/concepts/Real.md': '---\ntype: concept\n---\n\n# Real\n' }))
    expect(git(vaultRoot, 'status', '--porcelain').trim()).toBe('')
    expect(git(vaultRoot, 'show', '--name-only', 'HEAD')).toContain('wiki/concepts/Real.md')
    expect(store.logs(jobId).map((l) => l.message)).toContainEqual(expect.stringContaining('content date:'))
  })
})

/**
 * A revert must not wind the address allocator backwards (2026-09-20).
 *
 * `.vault-meta/address-counter.txt` holds the NEXT address to issue and only moves forward. A
 * recovery commit carries it, so the reservation is versioned with the pages that used it - and
 * that is what made this reachable. Measured on the live vault before it could happen: a
 * recovery commit moved the counter 1200 to 1208 while an EARLIER commit's surviving page held
 * `c-001200`. Reverting it would have put the counter back to 1200 and the next page would have
 * been the second `c-001200` in a vault whose duplicate-address count is zero.
 */
describe('revertCommit and the address allocator', () => {
  const write = (rel: string, body: string): void => {
    const abs = path.join(vaultRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }

  it('undoes the pages but leaves the counter where it is', async () => {
    write('.vault-meta/address-counter.txt', '1200\n')
    write('wiki/concepts/Survivor.md', '---\naddress: c-001200\n---\n\n# Survivor\n')
    git(vaultRoot, 'add', '-A')
    git(vaultRoot, 'commit', '-q', '-m', 'earlier ingest')

    write('.vault-meta/address-counter.txt', '1208\n')
    write('wiki/concepts/Doomed.md', '---\naddress: c-001205\n---\n\n# Doomed\n')
    git(vaultRoot, 'add', '-A')
    git(vaultRoot, 'commit', '-q', '-m', 'ingest: recovered after restart')
    const hash = git(vaultRoot, 'rev-parse', 'HEAD').trim()

    const result = await revertCommit(vaultRoot, hash)
    expect(result.reverted).toBe(true)
    // The page is gone, which is what a revert is for.
    expect(fs.existsSync(path.join(vaultRoot, 'wiki/concepts/Doomed.md'))).toBe(false)
    // The counter is NOT rolled back: the surviving page still holds c-001200, and an address
    // nobody used is simply never issued.
    expect(fs.readFileSync(path.join(vaultRoot, '.vault-meta/address-counter.txt'), 'utf8').trim()).toBe('1208')
    expect(git(vaultRoot, 'status', '--porcelain').trim()).toBe('')
  })

  it('refuses a commit that carries nothing but the counter, rather than making an empty one', async () => {
    write('.vault-meta/address-counter.txt', '1300\n')
    git(vaultRoot, 'add', '-A')
    git(vaultRoot, 'commit', '-q', '-m', 'counter only')
    const result = await revertCommit(vaultRoot, git(vaultRoot, 'rev-parse', 'HEAD').trim())
    expect(result.reverted).toBe(false)
    expect(result.refusal).toBe('already-reverted')
  })
})
