/**
 * "Revert this ingest" (SPEC.md §9's undo mechanism, TASKS-RETRIEVE-adjacent v1.1 quick win).
 *
 * Real git throughout: the whole point of `revertCommit` is that it either fully undoes one
 * commit or leaves the vault byte-for-byte as it found it, and a mocked git could not exercise
 * the conflict/dirty-tree paths that make that guarantee real.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { revertCommit, commitPaths } from '../src/pipeline/git.js'

let repo: string

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString()
const write = (rel: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), body)
}
const head = (): string => git('rev-parse', 'HEAD').trim()
const treeState = (): string => git('status', '--porcelain', '--untracked-files=all').trim()

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-revert-'))
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  write('wiki/index.md', '# Index\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
})
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

/** Commits one page the way an ingest would, returning its hash. */
async function ingest(page: string, body: string): Promise<string> {
  write(page, body)
  const res = await commitPaths(repo, `ingest: ${path.basename(page)}`, [page])
  expect(res.committed).toBe(true)
  return res.hash as string
}

describe('revertCommit', () => {
  it('undoes an ingest as a NEW commit, leaving history intact and the tree clean', async () => {
    const page = 'wiki/concepts/Throwaway.md'
    const hash = await ingest(page, '# throwaway\n')
    expect(fs.existsSync(path.join(repo, page))).toBe(true)

    const res = await revertCommit(repo, hash)

    expect(res.reverted).toBe(true)
    expect(res.hash).toBeTruthy()
    // The page is gone, the tree is clean, and the ORIGINAL commit still exists (undo is
    // itself versioned and reversible — no history rewriting).
    expect(fs.existsSync(path.join(repo, page))).toBe(false)
    expect(treeState()).toBe('')
    expect(git('cat-file', '-t', hash).trim()).toBe('commit')
    expect(git('log', '--oneline', '-1')).toMatch(/revert ingest/)
  })

  it('reverts only its own commit, leaving a later unrelated ingest untouched', async () => {
    const first = await ingest('wiki/concepts/First.md', '# first\n')
    await ingest('wiki/concepts/Second.md', '# second\n')

    const res = await revertCommit(repo, first)

    expect(res.reverted).toBe(true)
    expect(fs.existsSync(path.join(repo, 'wiki/concepts/First.md'))).toBe(false)
    expect(fs.existsSync(path.join(repo, 'wiki/concepts/Second.md'))).toBe(true)
  })

  it('refuses on a dirty tree and changes nothing — an agent may still be writing', async () => {
    const hash = await ingest('wiki/concepts/Page.md', '# page\n')
    // A run in flight: pages on disk that no commit covers yet.
    write('wiki/concepts/HalfWritten.md', '# mid-write\n')
    const before = head()

    const res = await revertCommit(repo, hash)

    expect(res.reverted).toBe(false)
    expect(res.refusal).toBe('dirty-tree')
    expect(res.message).toMatch(/uncommitted changes/)
    expect(head()).toBe(before)
    expect(fs.existsSync(path.join(repo, 'wiki/concepts/Page.md'))).toBe(true)
  })

  it('aborts cleanly on a conflict, leaving NO conflict markers in the vault', async () => {
    const page = 'wiki/concepts/Contested.md'
    const hash = await ingest(page, 'line one\nline two\nline three\n')
    // A later edit rewrites the same lines, so undoing the original cannot apply cleanly.
    write(page, 'line one\nTOTALLY DIFFERENT\nline three\n')
    await commitPaths(repo, 'edit: Contested', [page])
    const before = head()

    const res = await revertCommit(repo, hash)

    expect(res.reverted).toBe(false)
    expect(res.refusal).toBe('conflict')
    // The load-bearing assertion: the vault is exactly as it was — no half-applied revert, no
    // conflict markers that the next ingest would happily read as page content.
    expect(head()).toBe(before)
    expect(treeState()).toBe('')
    expect(fs.readFileSync(path.join(repo, page), 'utf8')).not.toMatch(/<<<<<<<|>>>>>>>/)
    expect(fs.readFileSync(path.join(repo, page), 'utf8')).toContain('TOTALLY DIFFERENT')
  })

  it('reports already-reverted instead of stacking a second empty revert', async () => {
    const hash = await ingest('wiki/concepts/Once.md', '# once\n')
    expect((await revertCommit(repo, hash)).reverted).toBe(true)
    const before = head()

    const second = await revertCommit(repo, hash)

    expect(second.reverted).toBe(false)
    expect(second.refusal).toBe('already-reverted')
    expect(head()).toBe(before)
    expect(treeState()).toBe('')
  })

  it('refuses an unknown or foreign commit', async () => {
    const bogus = await revertCommit(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    expect(bogus.reverted).toBe(false)
    expect(bogus.refusal).toBe('unknown-commit')
  })
})

/**
 * The hub layer's effect on undo (SPEC.md §12.12, found by the M1 integration test on the day
 * the hubs landed).
 *
 * Every run's commit now carries `wiki/index.md` and `wiki/log.md`, so every LATER commit
 * carries them too. `git revert` on a whole older commit therefore conflicts on the hub files
 * rather than on anything the run wrote - which would have broken the undo button for every
 * ingest except the most recent one, silently, the first time somebody used it.
 */
describe('revertCommit and the service-written hubs', () => {
  /** An ingest as the service now makes it: the page, plus the regenerated hubs. */
  async function ingestWithHubs(page: string, body: string, entry: string): Promise<string> {
    write(page, body)
    write('wiki/index.md', `# Index\n\n- [[${path.basename(page, '.md')}]]\n`)
    write('wiki/log.md', `# Operation Log\n\n## ${entry}\n`)
    const res = await commitPaths(repo, `ingest: ${path.basename(page)}`, [page, 'wiki/index.md', 'wiki/log.md'])
    expect(res.committed).toBe(true)
    return res.hash as string
  }

  it('undoes an older ingest although every later commit rewrote the hubs', async () => {
    const first = await ingestWithHubs('wiki/concepts/First.md', '# First\n', 'first')
    await ingestWithHubs('wiki/concepts/Second.md', '# Second\n', 'second')
    await ingestWithHubs('wiki/concepts/Third.md', '# Third\n', 'third')

    const res = await revertCommit(repo, first)
    expect(res.reverted).toBe(true)
    expect(fs.existsSync(path.join(repo, 'wiki/concepts/First.md'))).toBe(false)
    // The siblings and the tree are untouched, which is the guarantee that makes undo usable.
    expect(fs.existsSync(path.join(repo, 'wiki/concepts/Second.md'))).toBe(true)
    expect(fs.existsSync(path.join(repo, 'wiki/concepts/Third.md'))).toBe(true)
    expect(treeState()).toBe('')
  })

  it('leaves the hubs exactly as the newest run left them', async () => {
    const first = await ingestWithHubs('wiki/concepts/First.md', '# First\n', 'first')
    await ingestWithHubs('wiki/concepts/Second.md', '# Second\n', 'second')
    const indexBefore = fs.readFileSync(path.join(repo, 'wiki/index.md'), 'utf8')
    const logBefore = fs.readFileSync(path.join(repo, 'wiki/log.md'), 'utf8')

    expect((await revertCommit(repo, first)).reverted).toBe(true)

    // The index is derived: restoring an old copy would list a page that no longer exists, and
    // the next run regenerates it anyway. The log is a record: the run really did happen.
    expect(fs.readFileSync(path.join(repo, 'wiki/index.md'), 'utf8')).toBe(indexBefore)
    expect(fs.readFileSync(path.join(repo, 'wiki/log.md'), 'utf8')).toBe(logBefore)
  })

  it('refuses a commit that carries nothing but hub bookkeeping', async () => {
    write('wiki/index.md', '# Index\n\nregenerated\n')
    const res = await commitPaths(repo, 'ingest: nothing of its own', ['wiki/index.md'])
    const only = await revertCommit(repo, res.hash as string)
    expect(only).toMatchObject({ reverted: false, refusal: 'already-reverted' })
    expect(only.message).toContain('hub bookkeeping')
  })

  it('still refuses when a later commit really did change the run\'s own page', async () => {
    const first = await ingestWithHubs('wiki/concepts/First.md', '# First\n\nOriginal line.\n', 'first')
    write('wiki/concepts/First.md', '# First\n\nA hand edit that changed the same line.\n')
    await commitPaths(repo, 'edit: by hand', ['wiki/concepts/First.md'])

    const res = await revertCommit(repo, first)
    expect(res).toMatchObject({ reverted: false, refusal: 'conflict' })
    // Nothing half-applied: the hand edit survives untouched.
    expect(fs.readFileSync(path.join(repo, 'wiki/concepts/First.md'), 'utf8')).toContain('A hand edit')
    expect(treeState()).toBe('')
  })
})
