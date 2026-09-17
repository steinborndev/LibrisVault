/**
 * The pinboard of open questions (server/src/pipeline/questions.ts, prototype 2026-09-17):
 * every page's open questions, the strike-through as the archive, and the veto of a
 * proposal planned from an archived question.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Mutex } from '../src/util/mutex.js'
import type { VaultGraph } from '../src/pipeline/graph.js'
import type { ProposalRecord } from '../src/db/proposals.js'
import { QuestionsService, parseQuestionBullets, questionKey, strikeQuestion } from '../src/pipeline/questions.js'

const PAGE = `---
title: Solid electrolytes
domain: battery-technology
---
# Solid electrolytes

## Summary

Two lines of prose.

## Open questions

- Why does the interface resistance climb after ten cycles?
- Does the sulfide route survive
  humid assembly lines, or only the dry rooms
  the papers describe?
- ~~Which vendor ships the thickest film?~~
- (none yet)
- Is the 2024 figure reproducible? (answered in Cycle-life claims)

## Sources

- one
`

describe('parseQuestionBullets', () => {
  it('reads wrapped bullets, keeps struck ones as archived, skips placeholders and answered ones', () => {
    expect(parseQuestionBullets(PAGE)).toEqual([
      { text: 'Why does the interface resistance climb after ten cycles?', archived: false },
      { text: 'Does the sulfide route survive humid assembly lines, or only the dry rooms the papers describe?', archived: false },
      { text: 'Which vendor ships the thickest film?', archived: true },
    ])
    expect(parseQuestionBullets('# nothing here\n\n## Sources\n- x\n')).toEqual([])
  })
})

describe('strikeQuestion', () => {
  it('strikes one bullet through and takes it off again, touching nothing else', () => {
    const struck = strikeQuestion(PAGE, 'Why does the interface resistance climb after ten cycles?', true)!
    expect(struck).toContain('- ~~Why does the interface resistance climb after ten cycles?~~')
    expect(struck.split('\n').length).toBe(PAGE.split('\n').length)
    // The rest of the page is byte for byte the same.
    expect(struck.replace('- ~~Why does the interface resistance climb after ten cycles?~~', '- Why does the interface resistance climb after ten cycles?')).toBe(PAGE)
    expect(parseQuestionBullets(struck)[0]).toEqual({ text: 'Why does the interface resistance climb after ten cycles?', archived: true })
    const restored = strikeQuestion(struck, 'why does the interface resistance climb after ten cycles', false)
    expect(restored).toBe(PAGE)
  })

  it('opens the strike on the first line of a wrapped bullet and closes it on the last', () => {
    const struck = strikeQuestion(PAGE, 'Does the sulfide route survive humid assembly lines, or only the dry rooms the papers describe?', true)!
    expect(struck).toContain('- ~~Does the sulfide route survive\n  humid assembly lines, or only the dry rooms\n  the papers describe?~~')
    expect(parseQuestionBullets(struck)[1]!.archived).toBe(true)
    expect(strikeQuestion(struck, 'Does the sulfide route survive humid assembly lines, or only the dry rooms the papers describe?', false)).toBe(PAGE)
  })

  it('answers null when the question is not there or already stands that way', () => {
    expect(strikeQuestion(PAGE, 'Which vendor ships the thickest film?', true)).toBeNull()
    expect(strikeQuestion(PAGE, 'Why does the interface resistance climb after ten cycles?', false)).toBeNull()
    expect(strikeQuestion(PAGE, 'A question from another page', true)).toBeNull()
    // A bullet outside the section is not a question.
    expect(strikeQuestion(PAGE, 'one', true)).toBeNull()
  })
})

describe('QuestionsService', () => {
  let vaultRoot: string
  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'questions-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'concepts'), { recursive: true })
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', 'Solid electrolytes.md'), PAGE)
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'meta', 'agents', 'ada.md'), '# Ada\n\n## Open questions\n\n- What did the March review miss?\n\n## Notes\n\n- x\n')
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', 'Loose end.md'), '# Loose end\n\n## Open questions\n\n- Where does this belong?\n')
  })
  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })
  const graph = (): VaultGraph =>
    ({
      nodes: [
        { path: 'wiki/concepts/Solid electrolytes.md', title: 'Solid electrolytes', kind: 'knowledge', domain: 'battery-technology' },
        { path: 'wiki/concepts/Loose end.md', title: 'Loose end', kind: 'knowledge', domain: 'unassigned' },
        { path: 'wiki/index.md', title: 'index', kind: 'structural', domain: null },
      ],
    }) as unknown as VaultGraph
  const proposal = (text: string): ProposalRecord =>
    ({ id: 'p1', agentId: 'a1', status: 'proposed', provenance: { candidate: 'open-question', text, sourcePages: [] } }) as unknown as ProposalRecord

  it('lists every page and notebook question with its domain, what is planned and what is running', () => {
    const svc = new QuestionsService({
      vaultRoot,
      graph,
      notebooks: () => [{ path: 'wiki/meta/agents/ada.md', domain: 'astronomy' }],
      proposals: () => [proposal('why does the interface resistance climb after ten cycles')],
      fellowName: () => 'Ada',
      runs: () => [{ id: 'r1', kind: 'research', status: 'running', label: 'What did the March review miss?' }],
    })
    const entries = svc.list()
    expect(entries.map((e) => [e.text.slice(0, 20), e.domain, e.archived])).toEqual([
      ['Why does the interfa', 'battery-technology', false],
      ['Does the sulfide rou', 'battery-technology', false],
      ['Which vendor ships t', 'battery-technology', true],
      ['Where does this belo', null, false],
      ['What did the March r', 'astronomy', false],
    ])
    expect(entries[0]!.planned).toEqual({ proposalId: 'p1', agentId: 'a1', fellow: 'Ada', status: 'proposed' })
    expect(entries[1]!.planned).toBeNull()
    expect(entries[4]!.researching).toEqual({ runId: 'r1' })
    expect(entries[0]!.id).toBe(`wiki/concepts/Solid electrolytes.md#${questionKey(entries[0]!.text)}`)
  })

  it('archives by striking the page, commits behind the mutex, and vetoes the proposal planned from it', async () => {
    const commits: string[][] = []
    const vetoed: string[] = []
    const svc = new QuestionsService({
      vaultRoot,
      graph,
      proposals: () => [proposal('Why does the interface resistance climb after ten cycles?')],
      commitMutex: new Mutex(),
      commit: async (_root, message, paths) => {
        commits.push([message, ...paths])
        return { committed: true, hash: 'abc', committedPages: [...paths] } as never
      },
      veto: async (id) => {
        vetoed.push(id)
      },
    })
    const page = 'wiki/concepts/Solid electrolytes.md'
    expect(await svc.setArchived(page, 'Why does the interface resistance climb after ten cycles?', true)).toEqual({ changed: true, vetoed: ['p1'] })
    expect(fs.readFileSync(path.join(vaultRoot, page), 'utf8')).toContain('- ~~Why does the interface resistance climb after ten cycles?~~')
    expect(commits).toEqual([['questions: archived one on Solid electrolytes', page]])
    expect(svc.list().find((e) => e.text.startsWith('Why does'))?.archived).toBe(true)
    // Already archived: nothing changes and nothing is vetoed twice.
    expect(await svc.setArchived(page, 'Why does the interface resistance climb after ten cycles?', true)).toEqual({ changed: false, vetoed: [] })
    // Restoring takes the strike off and vetoes nothing.
    expect(await svc.setArchived(page, 'Why does the interface resistance climb after ten cycles?', false)).toEqual({ changed: true, vetoed: [] })
    expect(fs.readFileSync(path.join(vaultRoot, page), 'utf8')).toBe(PAGE)
    // Nothing outside wiki/ and nothing with a traversal in it.
    expect(await svc.setArchived('../etc/passwd', 'x', true)).toEqual({ changed: false, vetoed: [] })
    expect(await svc.setArchived('wiki/../.git/config', 'x', true)).toEqual({ changed: false, vetoed: [] })
  })
})
