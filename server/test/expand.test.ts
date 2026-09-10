/**
 * Milestone A3 (docs/tasks/TASKS-A3.md): the expand rules and validator over fixtures, and
 * the runner reverting a violating expand commit with a new commit against a real git
 * vault with a fake agent. Acceptance: a violating expand run is reverted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { SqliteAgentStore } from '../src/db/agents.js'
import { SqliteAgentRunStore } from '../src/db/agent-runs.js'
import { SqliteProposalStore } from '../src/db/proposals.js'
import { NotebookWriter } from '../src/pipeline/notebook.js'
import { FellowService } from '../src/pipeline/fellows.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import type { AgentRunResult, RunAgentOptions } from '../src/pipeline/agent-runner.js'
import { bodyLines, isSubsequence, isExemptPath, renderExpandRules, validateExpandCommit, gitCommitReader, type CommitReader } from '../src/pipeline/expand.js'
import { commitFileStatus, readAtRevision, restoreCommitPaths } from '../src/pipeline/git.js'

const PAGE = (body: string, fm = 'type: concept\nupdated: 2026-09-01'): string => `---\n${fm}\n---\n\n${body}\n`

function fakeReader(status: Record<string, 'A' | 'M' | 'D'>, before: Record<string, string>, after: Record<string, string>): CommitReader {
  return {
    status: async () => new Map(Object.entries(status)),
    before: async (p) => before[p] ?? null,
    after: async (p) => after[p] ?? null,
  }
}

describe('expand rules and validator', () => {
  it('reads body lines after the frontmatter and checks subsequences', () => {
    expect(bodyLines(PAGE('# A\n\nline one  \n\nline two'))).toEqual(['# A', 'line one', 'line two'])
    expect(isSubsequence(['a', 'b'], ['a', 'x', 'b', 'y'])).toEqual({ ok: true })
    expect(isSubsequence(['a', 'b'], ['b', 'a'])).toEqual({ ok: false, missing: 'b' })
    expect(isSubsequence([], ['z'])).toEqual({ ok: true })
    expect(isExemptPath('wiki/index.md')).toBe(true)
    expect(isExemptPath('wiki/sources/_index.md')).toBe(true)
    expect(isExemptPath('.vault-meta/x.json')).toBe(true)
    expect(isExemptPath('wiki/concepts/A.md')).toBe(false)
  })

  it('renders the rules with the page set and the date', () => {
    const block = renderExpandRules(['wiki/questions/Research: Q.md', 'wiki/concepts/A.md'], '2026-09-07')
    expect(block).toContain('<research_expand>')
    expect(block).toContain('  - wiki/concepts/A.md')
    expect(block).toContain('## Update 2026-09-07')
    expect(block).toContain('at most 3 new pages')
  })

  /**
   * The two rules that stop a deepening from turning the page into a changelog. Asserted on
   * the wording because the wording IS the mechanism here: the validator allows an insertion
   * anywhere, so where the run puts what it found is decided by this block alone.
   */
  it('tells the run to add in place and to flag rather than delete', () => {
    const block = renderExpandRules(['wiki/concepts/A.md'], '2026-09-07')
    expect(block).toContain('Every edit is ADDITIVE')
    expect(block).toContain('PUT IT WHERE IT BELONGS')
    expect(block).toContain('it is not a changelog')
    expect(block).toContain('CORRECT BY FLAGGING, NEVER BY DELETING')
    expect(block).toContain('> [!contradiction]')
    expect(block).toContain('`> [!stale]`')
    expect(block).not.toContain('at the end of the page.')
  })

  /**
   * An insertion in the middle is what the new wording asks for, and the guarantee has always
   * covered it: every old line still stands, in order. This is the case the old rule forbade
   * by wording and the validator never minded.
   */
  it('accepts an addition made inside a section, not at the end', async () => {
    const set = ['wiki/concepts/A.md']
    const before = '# A\n\n## Clinical Precedent\n\n- first\n\n## Sources\n\n- s1'
    const after = '# A\n\n## Clinical Precedent\n\n- first\n- a third one, found tonight\n\n> [!stale] Superseded\n> The figure above predates the 2026 review.\n\n## Sources\n\n- s1\n- s2'
    const reader = fakeReader(
      { 'wiki/concepts/A.md': 'M' },
      { 'wiki/concepts/A.md': PAGE(before) },
      { 'wiki/concepts/A.md': PAGE(after) },
    )
    expect(await validateExpandCommit(reader, set)).toEqual([])
  })

  it('accepts appended updates, new pages within the cap and frontmatter changes', async () => {
    const set = ['wiki/concepts/A.md']
    const reader = fakeReader(
      { 'wiki/concepts/A.md': 'M', 'wiki/sources/New.md': 'A', 'wiki/index.md': 'M', 'wiki/hot.md': 'M' },
      { 'wiki/concepts/A.md': PAGE('# A\n\nold line\n\n## Sources\n\n- s1') },
      { 'wiki/concepts/A.md': PAGE('# A\n\nold line\n\n## Update 2026-09-07\n\n- new fact\n\n## Sources\n\n- s1\n- s2', 'type: concept\nupdated: 2026-09-07\ntags:\n  - x') },
    )
    expect(await validateExpandCommit(reader, set)).toEqual([])
  })

  it('lets the related footer move and grow, and always includes the Fellow\'s own pages in a manual page set', async () => {
    const reader = fakeReader(
      { 'wiki/concepts/A.md': 'M' },
      { 'wiki/concepts/A.md': PAGE('# A\n\nbody\n\nrelated: [[index]] | [[One]]') },
      { 'wiki/concepts/A.md': PAGE('# A\n\nbody\n\n## Update 2026-09-07\n\n- more\n\nrelated: [[index]] | [[One]] | [[Two]]') },
    )
    expect(await validateExpandCommit(reader, ['wiki/concepts/A.md'])).toEqual([])
    expect(bodyLines('---\nx: 1\n---\n\n# T\n\nrelated: [[a]]\n')).toEqual(['# T'])
  })

  it('flags rewritten and removed lines, pages outside the set, deletions and too many new pages', async () => {
    const set = ['wiki/concepts/A.md']
    const reader = fakeReader(
      { 'wiki/concepts/A.md': 'M', 'wiki/concepts/B.md': 'M', 'wiki/concepts/C.md': 'D', 'wiki/sources/N1.md': 'A', 'wiki/sources/N2.md': 'A', 'wiki/sources/N3.md': 'A', 'wiki/sources/N4.md': 'A' },
      { 'wiki/concepts/A.md': PAGE('# A\n\nthe old claim\n\nkept line'), 'wiki/concepts/B.md': PAGE('# B\n\nb') },
      { 'wiki/concepts/A.md': PAGE('# A\n\nthe corrected claim\n\nkept line'), 'wiki/concepts/B.md': PAGE('# B\n\nb\n\nmore') },
    )
    const findings = await validateExpandCommit(reader, set)
    expect(findings.map((f) => [f.path, f.rule])).toEqual([
      ['wiki/concepts/A.md', 'rewritten'],
      ['wiki/concepts/B.md', 'outside-set'],
      ['wiki/concepts/C.md', 'deleted-page'],
      ['(new pages)', 'too-many-new'],
    ])
    expect(findings[0]!.detail).toContain('the old claim')
  })
})

describe('an expand run against a git vault', () => {
  let vaultRoot: string
  let db: Db
  let calls: RunAgentOptions[]
  let behaviour: 'append' | 'rewrite' | 'outside' | 'self-commit' | 'self-commit-outside'
  let runner: MaintenanceRunner
  let service: FellowService
  const git = (...args: string[]): string => execFileSync('git', ['-C', vaultRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  const write = (rel: string, content: string): void => {
    const abs = path.join(vaultRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  const read = (rel: string): string => fs.readFileSync(path.join(vaultRoot, rel), 'utf8')

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'expand-'))
    write('wiki/index.md', '# index\n')
    write('wiki/concepts/Transit Photometry.md', PAGE('# Transit Photometry\n\nthe original claim\n\n## Sources\n\n- s1'))
    write('wiki/concepts/Other.md', PAGE('# Other\n\nuntouchable'))
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '-m', 'seed')
    db = openDb(MEMORY_DB)
    calls = []
    behaviour = 'append'
    const commitMutex = new Mutex()
    const runs = new SqliteAgentRunStore(db)
    const okResult = (text: string): AgentRunResult => ({ ok: true, result: text, usage: { tokensIn: 12, tokensOut: 3, costUsd: 0.5 }, durationMs: 1, numTurns: 1, sessionId: 's', timedOut: false })
    runner = new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex,
      runAgent: async (opts) => {
        calls.push(opts)
        // The fake agent edits the vault the way a real one would; the runner commits it.
        const target = 'wiki/concepts/Transit Photometry.md'
        if (behaviour === 'append') {
          write(target, read(target) + '\n## Update 2026-09-07\n\n- a new fact\n')
          write('wiki/sources/Fresh Source.md', PAGE('# Fresh Source\n\ncited'))
        } else if (behaviour === 'rewrite') {
          write(target, read(target).replace('the original claim', 'the corrected claim'))
        } else if (behaviour === 'self-commit' || behaviour === 'self-commit-outside') {
          /*
           * The vault's own skill commits, so by the time the service commits there is
           * nothing left. Seen on the first expand run against the production vault
           * (2026-09-08): the run was recorded with no commit and no pages, and the
           * validator was skipped because its guard is a commit hash.
           */
          write(target, read(target) + '\n## Update 2026-09-07\n\n- a new fact\n')
          if (behaviour === 'self-commit-outside') write('wiki/concepts/Other.md', read('wiki/concepts/Other.md') + '\nsneaky edit\n')
          write('wiki/index.md', '# index\n- updated\n')
          git('add', '-A', '--', 'wiki')
          git('commit', '-q', '-m', 'research-expand: the run committing its own work')
          write('.tmp-scratch.txt', 'leftover')
          return okResult('expanded')
        } else {
          write(target, read(target) + '\n## Update 2026-09-07\n\n- fine\n')
          write('wiki/concepts/Other.md', read('wiki/concepts/Other.md') + '\nsneaky edit\n')
        }
        // Bookkeeping every run touches, plus an untracked leftover the revert must tolerate.
        write('wiki/index.md', '# index\n- updated\n')
        write('.tmp-scratch.txt', 'leftover')
        return okResult('expanded')
      },
      runStore: runs,
    })
    service = new FellowService({
      agents: new SqliteAgentStore(db),
      runs,
      proposals: new SqliteProposalStore(db),
      maintenance: runner,
      notebook: new NotebookWriter({ vaultRoot, commitMutex }),
    })
  })
  afterEach(() => {
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const spawnAda = async (): Promise<string> => {
    const { agent } = await service.spawn({ name: 'Ada', intent: 'Transit photometry systematics', homeDomain: 'astronomy', runFirstStep: false, quotaRunsPerDay: 3 })
    return agent!.id
  }

  it('an append-only expand run commits and stays', async () => {
    const id = await spawnAda()
    const step = service.step(id, { kind: 'research-expand', topic: 'Deepen transit photometry', pageSet: ['wiki/concepts/Transit Photometry.md'] })
    expect(step.refusal).toBeUndefined()
    const settled = await service.settled(step.run!.id)
    expect(settled.status).toBe('done')
    expect(calls[0]!.prompt).toContain('<research_expand>')
    expect(calls[0]!.prompt).toContain('  - wiki/concepts/Transit Photometry.md')
    // The notebook joins the manual page set, so the run's open-question append is no violation.
    expect(calls[0]!.prompt).toContain('  - wiki/meta/agents/ada.md')
    // And so does the reading list: every writing run carries that rule (section 10.6), and
    // the first real expand was reverted whole for noting one publication in it.
    expect(calls[0]!.prompt).toContain('  - wiki/meta/reading-list.md')
    expect(calls[0]).toMatchObject({ maxBudgetUsd: 6, timeoutMs: 20 * 60_000 })
    // The notebook rewrite commits after the run's own commit.
    expect(git('log', '--format=%s', '-3')).toContain('maintenance: research-expand')
    expect(read('wiki/concepts/Transit Photometry.md')).toContain('## Update 2026-09-07')
    expect(service.get(id)!.state).toBe('sleeping')
  })

  it('a rewriting expand run is reverted with a new commit and settles failed; the Fellow stays plannable', async () => {
    behaviour = 'rewrite'
    const id = await spawnAda()
    const step = service.step(id, { kind: 'research-expand', topic: 'Deepen transit photometry', pageSet: ['wiki/concepts/Transit Photometry.md'] })
    const settled = await service.settled(step.run!.id)
    expect(settled.status).toBe('error')
    expect(settled.error).toContain('expand run reverted')
    expect(settled.error).toContain('the original claim')
    const log = git('log', '--format=%s', '-4').split('\n')
    const revertAt = log.findIndex((l) => /^revert expand [0-9a-f]{8}$/.test(l))
    const runAt = log.findIndex((l) => l.includes('maintenance: research-expand'))
    expect(revertAt).toBeGreaterThanOrEqual(0)
    expect(runAt).toBeGreaterThan(revertAt)
    expect(read('wiki/concepts/Transit Photometry.md')).toContain('the original claim')
    expect(read('wiki/concepts/Transit Photometry.md')).not.toContain('corrected')
    // The untracked leftover neither blocked the revert nor got committed.
    expect(fs.existsSync(path.join(vaultRoot, '.tmp-scratch.txt'))).toBe(true)
    expect(git('status', '--porcelain', '--', 'wiki').trim()).toBe('')
    const row = service.card(id)!.runs[0]!
    expect(row).toMatchObject({ kind: 'research-expand', ok: false })
    expect(row.error).toContain('reverted')
    expect(service.get(id)).toMatchObject({ state: 'sleeping', sleepCode: 'idle', sleepReason: expect.stringContaining('expand run reverted') })
  })

  it('an edit outside the page set is reverted too, new pages included', async () => {
    behaviour = 'outside'
    const id = await spawnAda()
    const step = service.step(id, { kind: 'research-expand', topic: 'Deepen', pageSet: ['wiki/concepts/Transit Photometry.md'] })
    const settled = await service.settled(step.run!.id)
    expect(settled.status).toBe('error')
    expect(settled.error).toContain('wiki/concepts/Other.md: modified a page the proposal did not list')
    expect(read('wiki/concepts/Other.md')).not.toContain('sneaky')
    expect(read('wiki/concepts/Transit Photometry.md')).not.toContain('## Update')
    expect(service.step(id, { kind: 'research-expand', topic: 'x' }).refusal?.error).toContain('needs a page set')
  })

  /*
   * The run committing its own work (2026-09-08). The service commits what the agent left
   * dirty; when the agent committed first, the service's commit finds a clean tree. What
   * the run DID is then whatever moved HEAD, and everything downstream - the page list, the
   * recap's "changed nothing", and above all the expand validator - has to read it there.
   */
  it('records the commit and the pages when the run committed its own work', async () => {
    behaviour = 'self-commit'
    const id = await spawnAda()
    const step = service.step(id, { kind: 'research-expand', topic: 'Deepen transit photometry', pageSet: ['wiki/concepts/Transit Photometry.md'] })
    const settled = await service.settled(step.run!.id)
    expect(settled.status).toBe('done')
    // The service committed nothing of its own, and the run still carries its commit...
    expect(settled.result?.commit).toBeTruthy()
    // ...and the page it edited, which is what keeps it out of the "changed nothing" count.
    expect(settled.result?.pages).toContain('wiki/concepts/Transit Photometry.md')
    expect(read('wiki/concepts/Transit Photometry.md')).toContain('## Update 2026-09-07')
  })

  it('reverts a self-committed run that broke its page set, which is the hole this closes', async () => {
    behaviour = 'self-commit-outside'
    const id = await spawnAda()
    const step = service.step(id, { kind: 'research-expand', topic: 'Deepen', pageSet: ['wiki/concepts/Transit Photometry.md'] })
    const settled = await service.settled(step.run!.id)
    expect(settled.status).toBe('error')
    expect(settled.error).toContain('expand run reverted')
    expect(settled.error).toContain('wiki/concepts/Other.md')
    expect(read('wiki/concepts/Other.md')).not.toContain('sneaky')
    expect(read('wiki/concepts/Transit Photometry.md')).not.toContain('## Update')
    expect(git('status', '--porcelain', '--', 'wiki').trim()).toBe('')
    expect(service.get(id)).toMatchObject({ state: 'sleeping', sleepCode: 'idle' })
  })

  it('git helpers: file status, content at a revision, restore', async () => {
    write('wiki/concepts/Transit Photometry.md', PAGE('# Transit Photometry\n\nchanged'))
    write('wiki/concepts/Added.md', PAGE('# Added'))
    fs.rmSync(path.join(vaultRoot, 'wiki/concepts/Other.md'))
    git('add', '-A')
    git('commit', '-q', '-m', 'mixed')
    const hash = git('rev-parse', 'HEAD').trim()
    const status = await commitFileStatus(vaultRoot, hash)
    expect([...status.entries()].sort()).toEqual([
      ['wiki/concepts/Added.md', 'A'],
      ['wiki/concepts/Other.md', 'D'],
      ['wiki/concepts/Transit Photometry.md', 'M'],
    ])
    expect(await readAtRevision(vaultRoot, `${hash}^`, 'wiki/concepts/Other.md')).toContain('untouchable')
    expect(await readAtRevision(vaultRoot, hash, 'wiki/concepts/Other.md')).toBeNull()
    const reader = gitCommitReader(vaultRoot, hash)
    expect((await reader.status()).size).toBe(3)
    // The same three, read as a RANGE: what a run that committed twice needs (2026-09-08).
    const asRange = gitCommitReader(vaultRoot, hash, `${hash}^`)
    expect([...(await asRange.status()).entries()].sort()).toEqual([...status.entries()].sort())
    expect(await asRange.before('wiki/concepts/Other.md')).toContain('untouchable')
    const restored = await restoreCommitPaths(vaultRoot, hash, `revert expand ${hash.slice(0, 8)}`)
    expect(restored.reverted).toBe(true)
    expect(read('wiki/concepts/Other.md')).toContain('untouchable')
    expect(fs.existsSync(path.join(vaultRoot, 'wiki/concepts/Added.md'))).toBe(false)
    expect(read('wiki/concepts/Transit Photometry.md')).toContain('the original claim')
    expect((await restoreCommitPaths(vaultRoot, 'deadbeef', 'x')).reverted).toBe(false)
  })
})
