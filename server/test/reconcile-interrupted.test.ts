import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { ensureVaultExcludes } from '../src/pipeline/vault-excludes.js'
import { dirtyPaths } from '../src/pipeline/git.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/index.js'
import type { JobRow } from '../src/db/jobs.js'

// Real git repo: the reconcile drains an interrupted run's orphaned pages via commitPaths and
// reads the working tree via dirtyPaths — a mocked git could not exercise either.

const NO_TOOLS = {
  pdftotext: false, pdfinfo: false, ocrmypdf: false, pandoc: false, python3: false,
  exiftool: false, defuddle: false, ytDlp: false, deno: false,
} satisfies ToolAvailability

let repo: string
let db: Db
let store: JobStore

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString()
const write = (rel: string, body = 'x'): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), body)
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-recon-'))
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  write('wiki/log.md', '# Log\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  // What the service does at startup: the run markers are derived state and stay out of vault
  // history, which is also why a recovered run leaves the tree clean.
  ensureVaultExcludes(repo)
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
})
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

const makeQueue = (): IngestQueue =>
  new IngestQueue({
    store,
    vaultRoot: repo,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    detectToolsFn: async () => NO_TOOLS,
  })

/** Seeds a job already advanced to `ingesting`, as an abrupt stop would have left it. */
const seedIngesting = (over: { sha256: string; originalName?: string; batchId?: string }): JobRow => {
  const { job } = store.create({ source: 'drop', type: 'pdf', originalName: 'a.pdf', ...over })
  store.setRawPath(job.id, path.posix.join('.raw', job.id))
  store.transition(job.id, 'preprocessing')
  store.transition(job.id, 'ingesting')
  return store.getOrThrow(job.id)
}

describe('reconcileInterrupted', () => {
  it('recovers a completed-but-uncommitted ingest to done and commits its orphaned pages', async () => {
    const job = seedIngesting({ sha256: 'a' })
    // The crash landed after the agent wrote its pages (incl. the final log entry, which names
    // the job's .raw dir) but before the commit — so the pages sit dirty in the working tree.
    const page = 'wiki/concepts/Recovered.md'
    write(page, '# recovered\n')
    /*
     * The completion MARKER, not a log entry (2.4, and the fallback was removed on
     * 2026-09-19 once no job was left in `ingesting`). The service writes the log itself now,
     * so a crashed run leaves no entry at all - and a truncated log would otherwise have
     * answered "not finished" for every old job (8.8).
     */
    write(`.vault-meta/runs/${job.id}.done`, '')

    const q = makeQueue()
    q.start()
    await q.ready

    const recovered = store.getOrThrow(job.id)
    expect(recovered.status).toBe('done')
    expect(recovered.error).toBeNull()
    // created_pages reflects what actually landed in the recovered commit.
    expect(JSON.parse(recovered.created_pages ?? '[]')).toContain(page)
    // A real commit was made, attributed to this job, and the tree is clean again.
    expect(git('log', '--oneline', '-1')).toMatch(/ingest: a\.pdf \(recovered after restart\)/)
    expect(git('status', '--porcelain').trim()).toBe('')
    expect(git('log', '--diff-filter=A', '--name-only', '--pretty=format:', '-1').split('\n')).toContain(page)
  })

  it('fails a mid-write ingest with no marker but COMMITS its pages so the retry cannot orphan them', async () => {
    const job = seedIngesting({ sha256: 'b' })
    // Dirty page but NO log-md marker for this job → genuinely mid-write, not finished. The page
    // is nonetheless a whole file the agent already wrote; leaving it dirty is the retry-orphan
    // bug (the retry's dirtyBefore snapshot would exclude it from the F4 sweep, and no later pass
    // ever commits it). So reconcile commits it now, then fails the job for a retry to finish.
    const page = 'wiki/concepts/Half.md'
    write(page, '# half\n')

    const q = makeQueue()
    q.start()
    await q.ready

    const recovered = store.getOrThrow(job.id)
    expect(recovered.status).toBe('failed')
    expect(recovered.error).toMatch(/interrupted by a service restart/)
    // The page is now VERSIONED (revertable), not orphaned, and the tree is clean so the retry
    // starts fresh. The commit subject marks it as an incomplete, retry-pending recovery.
    expect(git('log', '--oneline', '-1')).toMatch(/ingest: a\.pdf \(recovered after restart - incomplete run, retry pending\)/)
    expect((await dirtyPaths(repo)).has(page)).toBe(false)
    expect(git('status', '--porcelain').trim()).toBe('')
    expect(git('log', '--diff-filter=A', '--name-only', '--pretty=format:', '-1').split('\n')).toContain(page)
  })

  it('fails a mid-write ingest with nothing written yet, without an empty recovery commit', async () => {
    const job = seedIngesting({ sha256: 'b2' })
    // No dirty pages at all (crash before the first Write) → nothing to commit, just fail.
    const q = makeQueue()
    q.start()
    await q.ready

    expect(store.getOrThrow(job.id).status).toBe('failed')
    // No recovery commit was fabricated over an empty tree.
    expect(git('log', '--oneline', '-1')).toMatch(/base/)
  })

  it('fails a preprocessing job (never reached the agent) without touching the vault', async () => {
    const { job } = store.create({ source: 'drop', type: 'pdf', originalName: 'p.pdf', sha256: 'c' })
    store.transition(job.id, 'preprocessing')
    write('wiki/log.md', `# Log\n- \`.raw/${job.id}/x\`\n`) // even if a marker exists, preprocessing can't be done

    const q = makeQueue()
    q.start()
    await q.ready

    expect(store.getOrThrow(job.id).status).toBe('failed')
  })

  /*
   * The completion marker (2.4). The log-entry check above is the LEGACY path and stays only
   * for jobs that were already `ingesting` when this version started: the service writes the
   * log entry itself now (SPEC.md §12.12), so a crashed run leaves no entry at all, and the
   * marker is the only thing that can say it got to the end.
   */
  it('recovers a run that left its completion marker, with no log entry anywhere', async () => {
    const job = seedIngesting({ sha256: 'marker' })
    const page = 'wiki/concepts/Marked.md'
    write(page, '# marked\n')
    // No log entry: the service writes those, and this run crashed before the service could.
    write(`.vault-meta/runs/${job.id}.done`, '')

    const q = makeQueue()
    q.start()
    await q.ready

    const recovered = store.getOrThrow(job.id)
    expect(recovered.status).toBe('done')
    expect(JSON.parse(recovered.created_pages ?? '[]')).toContain(page)
  })

  it('fails a run that left neither a marker nor a log entry', async () => {
    const job = seedIngesting({ sha256: 'neither' })
    write('wiki/concepts/Halfway.md', '# halfway\n')

    const q = makeQueue()
    q.start()
    await q.ready

    expect(store.getOrThrow(job.id).status).toBe('failed')
  })

  it('does not take another job\'s marker for this one\'s', async () => {
    const job = seedIngesting({ sha256: 'mine' })
    write('wiki/concepts/Mine.md', '# mine\n')
    write('.vault-meta/runs/some-other-job.done', '')

    const q = makeQueue()
    q.start()
    await q.ready

    expect(store.getOrThrow(job.id).status).toBe('failed')
  })

  it('recovers a batch: the first member commits the shared pages, siblings inherit them', async () => {
    const a = seedIngesting({ sha256: 'ba', originalName: 'A.pdf', batchId: 'batch1' })
    const b = seedIngesting({ sha256: 'bb', originalName: 'B.pdf', batchId: 'batch1' })
    write('wiki/concepts/Shared.md', '# shared\n')
    write(`.vault-meta/runs/${a.id}.done`, '')
    write(`.vault-meta/runs/${b.id}.done`, '')

    const q = makeQueue()
    q.start()
    await q.ready

    expect(store.getOrThrow(a.id).status).toBe('done')
    expect(store.getOrThrow(b.id).status).toBe('done')
    // Exactly ONE recovery commit for the batch; the second member found a clean tree.
    const recoveryCommits = git('log', '--oneline').split('\n').filter((l) => /recovered after restart/.test(l))
    expect(recoveryCommits).toHaveLength(1)
    expect(git('status', '--porcelain').trim()).toBe('')
  })
})
