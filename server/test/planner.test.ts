/**
 * Milestone A1 (docs/tasks/TASKS-A1.md), the pure parts: candidate computation from a
 * fixture vault, the scope score and drift flag, the planner's schema and answer validation,
 * proposal building, the notebook Plan section, the proposal and shift stores, and the
 * night window arithmetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import type { AgentRecord } from '../src/db/agents.js'
import type { AgentRunRecord } from '../src/db/agent-runs.js'
import type { JobRow } from '../src/db/jobs.js'
import { MemoryProposalStore, SqliteProposalStore, type ProposalRecord, type ProposalStore } from '../src/db/proposals.js'
import { MemoryShiftStore, SqliteShiftStore, EMPTY_SUMMARY, type ShiftStore } from '../src/db/shifts.js'
import { GraphBuilder } from '../src/pipeline/graph.js'
import { computeCandidates, parseOpenQuestions, type Candidate } from '../src/pipeline/candidates.js'
import {
  buildProposals,
  estimateCostUsd,
  FIELD_CAPS,
  isDrift,
  kindsForStep,
  parsePlannerAnswer,
  plannerSchema,
  renderPlanSection,
  renderPlannerPrompt,
  scopeScore,
} from '../src/pipeline/planner.js'
import { windowAt } from '../src/pipeline/shift.js'
import { addDays, knowledgePages, localDate } from '../src/pipeline/fellows.js'
import { notebookPath } from '../src/pipeline/notebook.js'

/** The task every planner prompt is now asked for; the tests judge against this one. */
const TASK = { id: 't1', text: 'x', kind: 'explore' as const, state: 'active' as const }

const INTENT = 'How well can ground-based transit photometry constrain exoplanet atmospheres, and where do the systematics come from?'

const agentRecord = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: 'a1',
  name: 'Ada',
  slug: 'ada',
  intent: INTENT,
  scope: null,
  tasks: [{ id: 't1', text: 'x', kind: 'explore', state: 'active' }],
  taskCursor: 0,
  homeDomain: 'astronomy',
  extraDomains: [],
  lens: 'broad',
  model: 'sonnet-5',
  effort: 'high',
  step: 'standard',
  quotaRunsPerDay: 1,
  quotaWeekPct: null,
  autonomy: 'veto',
  priority: 0,
  state: 'sleeping',
  sleepReason: null,
  sleepCode: 'idle',
  skipUntil: null,
  notebookPath: notebookPath('ada'),
  createdAt: '2026-09-06T08:00:00.000Z',
  updatedAt: '2026-09-06T08:00:00.000Z',
  retiredAt: null,
  ...over,
})

const runRecord = (over: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
  id: 'r1',
  kind: 'research-step',
  label: 'Faint hosts',
  profileKey: 'broad',
  ok: true,
  pages: ['wiki/questions/Research: Faint hosts.md', 'wiki/concepts/Transit Photometry.md'],
  tokensIn: 100,
  tokensOut: 10,
  costUsd: 2.1,
  error: null,
  commitHash: 'abc',
  startedAt: '2026-09-06T09:00:00.000Z',
  finishedAt: '2026-09-06T09:12:00.000Z',
  agentId: 'a1',
  model: 'claude-sonnet-5',
  ...over,
})

const job = (over: Partial<JobRow>): JobRow =>
  ({
    id: 'j1',
    user_id: 'local',
    batch_id: null,
    source: 'upload',
    type: 'pdf',
    original_name: 'faint-hosts.pdf',
    url: null,
    sha256: null,
    status: 'done',
    raw_path: null,
    created_pages: JSON.stringify(['wiki/concepts/Tiny Star.md']),
    error: null,
    attempts: 1,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    created_at: '2026-09-06T10:00:00.000Z',
    started_at: '2026-09-06T10:00:00.000Z',
    finished_at: '2026-09-06T10:05:00.000Z',
    notify_channel: null,
    commit_hash: null,
    duplicate_of: null,
    reverted_at: null,
    outcome: null,
    ...over,
  }) as JobRow

describe('parseOpenQuestions', () => {
  it('reads wrapped bullets under an Open questions section of any case and skips answered ones', () => {
    const md =
      '---\ntype: question\n---\n\n# T\n\n## Working answer\n\ntext\n\n## Open questions\n\n' +
      '- Does the precision hold for fainter hosts,\n  or only the bright star tested?\n' +
      '- Which surveys publish raw light curves? (answered 2026-09-06)\n' +
      '- (none yet)\n' +
      '- ~~Struck through because a later run answered it~~\n' +
      '* A starred bullet\n\n## Sources\n\n- not a question\n'
    expect(parseOpenQuestions(md)).toEqual([
      'Does the precision hold for fainter hosts, or only the bright star tested?',
      'A starred bullet',
    ])
    expect(parseOpenQuestions('# no section')).toEqual([])
  })
})

describe('computeCandidates', () => {
  let vaultRoot: string
  const page = (rel: string, content: string): void => {
    const abs = path.join(vaultRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'candidates-'))
    page('wiki/index.md', '# index\n')
    page(
      'wiki/concepts/Transit Photometry.md',
      '---\ntype: concept\ntitle: "Transit Photometry"\ndomain: astronomy\n---\n\nSee [[Limb Darkening]] and [[Stellar Activity]].\n' + 'x'.repeat(1200),
    )
    page('wiki/concepts/Tiny Star.md', '---\ntype: concept\ndomain: astronomy\n---\n\nshort\n')
    page('wiki/concepts/Sourdough.md', '---\ntype: concept\ndomain: cooking\n---\n\nSee [[Levain]].\n' + 'y'.repeat(1200))
    page(
      'wiki/questions/Research: Faint hosts.md',
      '---\ntype: question\ndomain: astronomy\n---\n\n# R\n\n## Working answer\n\nyes\n\n## Open questions\n\n- Does the precision hold for fainter hosts?\n- Which surveys publish raw light curves?\n',
    )
    page(
      'wiki/meta/agents/ada.md',
      '---\ntype: meta\n---\n\n# Fellow: Ada\n\n## Intent\n\nx\n\n## Open Questions\n\n- Which surveys publish raw light curves?\n- Is limb darkening degenerate with the transit depth?\n\n## Notes\n\n(yours)\n',
    )
  })
  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('collects questions, gaps, stubs and ingests of the Fellow, deduplicated, weighted and capped', () => {
    const graph = new GraphBuilder(vaultRoot).build()
    const candidates = computeCandidates({
      agent: agentRecord(),
      runs: [runRecord()],
      vaultRoot,
      graph,
      jobs: [
        job({}),
        job({ id: 'j2', created_pages: JSON.stringify(['wiki/concepts/Sourdough.md']), original_name: 'bread.pdf' }),
        job({ id: 'j3', finished_at: '2026-09-05T10:05:00.000Z', original_name: 'old.pdf' }),
      ],
      since: '2026-09-06T00:00:00.000Z',
      // A publication the Fellow asked for that has since arrived: the strongest candidate
      // there is, because the question is already written down and the document is here.
      readingFiled: [
        { title: 'The preprint it asked for', page: 'wiki/sources/Preprint.md', why: 'The only per-facility scatter.', filedAt: '2026-09-07' },
        { title: 'One from before the last run', page: 'wiki/sources/Old.md', why: null, filedAt: '2026-09-01' },
      ],
    })
    const byKind = (k: Candidate['kind']): string[] => candidates.filter((c) => c.kind === k).map((c) => c.text)
    expect(byKind('reading')).toEqual([
      '"The preprint it asked for" is in the vault now, as wiki/sources/Preprint.md - you asked for it: The only per-facility scatter.',
    ])
    expect(byKind('open-question')).toEqual([
      'Which surveys publish raw light curves?',
      'Is limb darkening degenerate with the transit depth?',
      'Does the precision hold for fainter hosts?',
    ])
    expect(byKind('gap').sort()).toEqual(['Limb Darkening', 'Stellar Activity'])
    expect(candidates.find((c) => c.kind === 'gap')?.sourcePages).toEqual(['wiki/concepts/Transit Photometry.md'])
    expect(byKind('stub')).toEqual(['Tiny Star'])
    expect(byKind('ingest')).toEqual(['faint-hosts.pdf'])
    // Ids are dense and weights descend: an arrived publication first, then notebook
    // questions, stubs last.
    expect(candidates.map((c) => c.id)).toEqual(candidates.map((_, i) => `C${i + 1}`))
    expect(candidates[0]!.kind).toBe('reading')
    expect(candidates[1]!.kind).toBe('open-question')
    expect(candidates[candidates.length - 1]!.kind).toBe('stub')
  })

  it('does not hand the Fellow every gap the journal names', () => {
    page('wiki/log.md', '# log\n\n- created [[Ghost Page]]\n- created [[Levain]]\n')
    const graph = new GraphBuilder(vaultRoot).build()
    const candidates = computeCandidates({
      agent: agentRecord(),
      // The run touched the journal and the index, as every run does.
      runs: [runRecord({ pages: ['wiki/log.md', 'wiki/index.md', 'wiki/questions/Research: Faint hosts.md'] })],
      vaultRoot,
      graph,
      jobs: [],
      since: null,
    })
    expect(candidates.filter((c) => c.kind === 'gap').map((c) => c.text).sort()).toEqual(['Limb Darkening', 'Stellar Activity'])
  })

  it('works without a graph and without jobs', () => {
    const candidates = computeCandidates({ agent: agentRecord(), runs: [], vaultRoot, graph: null, jobs: [], since: null })
    expect(candidates.map((c) => c.kind)).toEqual(['open-question', 'open-question'])
  })
})

describe('scope score and drift', () => {
  it('scores overlap against the intent and flags unrelated proposals', () => {
    const on = scopeScore('Limb darkening models in transit photometry of exoplanet atmospheres. A systematic of ground-based work.', INTENT)
    const off = scopeScore('Sourdough starter hydration ratios. Bread baking at home.', INTENT)
    expect(on).toBeGreaterThanOrEqual(0.4)
    expect(off).toBe(0)
    expect(isDrift(on)).toBe(false)
    expect(isDrift(off)).toBe(true)
    expect(scopeScore('', INTENT)).toBe(0)
    // Question words of the intent do not count against a proposal (first real plan, 2026-09-06).
    const faint = scopeScore(
      "Determine whether CMI's precision holds for fainter host stars, the more typical case for ground-based transit follow-up, or was only demonstrated on the bright star already tested.",
      INTENT,
    )
    expect(faint).toBeGreaterThanOrEqual(0.2)
  })
})

describe('planner prompt, schema and answer', () => {
  const candidates: Candidate[] = [
    { id: 'C1', kind: 'open-question', text: 'Does the precision hold for fainter hosts?', sourcePages: ['wiki/meta/agents/ada.md'], weight: 3 },
    { id: 'C2', kind: 'gap', text: 'Limb Darkening', sourcePages: ['wiki/concepts/Transit Photometry.md'], weight: 1.1 },
  ]

  it('renders the prompt with candidates, kinds, vetoes and quota', () => {
    const prompt = renderPlannerPrompt({ task: TASK, agent: agentRecord(), candidates, recentLog: ['2026-09-06 · research-step · x · 1 page(s) · 2.00 USD'], vetoed: ['Old topic'], runsLeftToday: 1, kinds: ['research-step', 'research'] })
    expect(prompt).toContain('C1 [open-question; from wiki/meta/agents/ada.md] Does the precision hold')
    expect(prompt).toContain('C2 [gap; from wiki/concepts/Transit Photometry.md] Limb Darkening')
    expect(prompt).toContain('do not propose them again:\n- Old topic')
    expect(prompt).toContain('1 run(s) left today')
    expect(prompt).toContain('research-step (one question')
    expect(prompt).toContain('no web access')
  })

  it('builds a strict schema from the allowed kinds and candidate ids', () => {
    const schema = plannerSchema({ kinds: ['research-step'], candidateIds: ['C1', 'C2'] }) as { properties: Record<string, { items?: { properties: Record<string, { enum?: string[] }> } }>; required: string[] }
    expect(schema.required).toEqual(['proposals', 'handoffs', 'reading', 'nothing_worth_a_run', 'intent_covered', 'reason'])
    expect(schema.properties['proposals']!.items!.properties['candidate']!.enum).toEqual(['C1', 'C2'])
    expect(schema.properties['proposals']!.items!.properties['kind']!.enum).toEqual(['research-step'])
  })

  it('limits the kinds by the step size', () => {
    expect(kindsForStep('small')).toEqual(['research-step'])
    expect(kindsForStep('standard')).toEqual(['research-step', 'research-expand', 'research'])
    expect(kindsForStep('deep')).toEqual(['research-step', 'research-expand', 'research'])
  })

  it('parses a schema-shaped answer and rejects garbage', () => {
    expect(parsePlannerAnswer({ proposals: [], nothing_worth_a_run: true, intent_covered: false, reason: 'all answered' })).toMatchObject({ nothingWorthARun: true, reason: 'all answered' })
    expect(parsePlannerAnswer('nope')).toBeUndefined()
    expect(parsePlannerAnswer({ proposals: [{ candidate: 'C1', kind: 'lint', topic: 'x' }] })).toBeUndefined()
  })

  it('cuts a field over its cap instead of throwing the plan away', () => {
    // What actually happened once: one topic of 592 characters, and the whole night's plan -
    // three proposals and eight handoffs - was discarded as "not the shape the schema asked for".
    const long = `Determine ${'x'.repeat(FIELD_CAPS.topic)} in detail`
    const answer = parsePlannerAnswer({
      proposals: [{ candidate: 'C1', kind: 'research-step', topic: long, rationale: 'r'.repeat(FIELD_CAPS.rationale + 500), lens: 'broad', pages: [] }],
      handoffs: [{ candidate: 'C2', domain: 'climate-science', reason: 'e'.repeat(FIELD_CAPS.handoffReason + 100) }],
      nothing_worth_a_run: false,
      intent_covered: false,
      reason: 'w'.repeat(FIELD_CAPS.reason + 100),
    })!
    expect(answer.proposals).toHaveLength(1)
    expect(answer.proposals[0]!.topic).toHaveLength(FIELD_CAPS.topic)
    expect(answer.proposals[0]!.rationale).toHaveLength(FIELD_CAPS.rationale)
    expect(answer.handoffs[0]!.reason).toHaveLength(FIELD_CAPS.handoffReason)
    expect(answer.reason).toHaveLength(FIELD_CAPS.reason)
    expect(answer.dropped).toEqual([])
  })

  it('drops the one entry it cannot use and keeps the rest of the plan', () => {
    const answer = parsePlannerAnswer({
      proposals: [
        { candidate: 'C1', kind: 'research-step', topic: 'A topic that is fine', rationale: 'r' },
        { candidate: 'C2', kind: 'lint', topic: 'Not a research kind', rationale: 'r' },
        { candidate: 'C3', kind: 'research-step', topic: 'no', rationale: 'too short a topic' },
        { candidate: 'C4', kind: 'research-step', topic: 'Another good one', rationale: 'r' },
      ],
      handoffs: [
        { candidate: 'C5', domain: 'astronomy', reason: 'other domain' },
        { candidate: 'C6', domain: '', reason: 'no domain at all' },
      ],
      nothing_worth_a_run: false,
      intent_covered: false,
      reason: 'mixed',
    })!
    expect(answer.proposals.map((p) => p.candidate)).toEqual(['C1', 'C4'])
    expect(answer.handoffs.map((h) => h.candidate)).toEqual(['C5'])
    expect(answer.dropped).toHaveLength(3)
    expect(answer.dropped.join(' ')).toContain('proposal 2 dropped')
    expect(answer.dropped.join(' ')).toContain('topic too short')
    expect(answer.dropped.join(' ')).toContain('handoff 2 dropped')
  })

  it('takes the publications the planner names, including the ones no run could open', () => {
    const answer = parsePlannerAnswer({
      proposals: [],
      handoffs: [],
      reading: [
        { title: 'A paywalled paper', url: 'https://acs.invalid/x', ref: 'doi:10.1/x', domain: 'Materials-Science', why: 'The only per-cell figures.', access: 'paywalled', blocked: 'HTTP 403' },
        { title: 'An open one', url: 'https://arxiv.invalid/1', ref: '', domain: '', why: '', access: 'open', blocked: '' },
        { title: 'No link, so no request', url: 'not a url', ref: '', domain: '', why: '', access: 'open', blocked: '' },
      ],
      nothing_worth_a_run: false,
      intent_covered: false,
      reason: '',
    })!
    expect(answer.reading.map((r) => r.title)).toEqual(['A paywalled paper', 'An open one'])
    expect(answer.reading[0]).toMatchObject({ domain: 'materials-science', access: 'paywalled', blocked: 'HTTP 403' })
    expect(answer.reading[1]).toMatchObject({ ref: null, why: null, blocked: null })
    expect(answer.dropped.join(' ')).toContain('reading 3 dropped')
    // An older answer without the field is still an answer.
    expect(parsePlannerAnswer({ proposals: [], nothing_worth_a_run: true })!.reading).toEqual([])
  })

  it('states the field limits in both the schema and the prompt, so the model can meet them', () => {
    const schema = plannerSchema({ kinds: ['research-step'], candidateIds: ['C1'], domainKeys: ['astronomy'] }) as {
      properties: Record<string, { maxItems?: number; items?: { properties: Record<string, Record<string, unknown>> } }>
    }
    const item = schema.properties['proposals']!.items!.properties
    expect(schema.properties['proposals']!.maxItems).toBe(3)
    expect(item['topic']).toMatchObject({ maxLength: FIELD_CAPS.topic, minLength: 3 })
    expect(item['rationale']).toMatchObject({ maxLength: FIELD_CAPS.rationale })
    expect(item['pages']).toMatchObject({ maxItems: FIELD_CAPS.pages })
    const prompt = renderPlannerPrompt({ task: TASK, agent: agentRecord(), candidates, recentLog: [], vetoed: [], runsLeftToday: 1, kinds: ['research-step'] })
    expect(prompt).toContain(`at most ${FIELD_CAPS.topic} characters`)
    // The planner writes nothing itself; the reading entries come back as data.
    expect(prompt).toContain('could NOT get')
    expect(prompt).toContain('you must not write to any page')
    expect(prompt).not.toContain('NOTE:')
    const again = renderPlannerPrompt({ task: TASK, agent: agentRecord(), candidates, recentLog: [], vetoed: [], runsLeftToday: 1, kinds: ['research-step'], retryNote: 'its answer did not match the schema' })
    expect(again).toContain('NOTE: its answer did not match the schema')
  })

  it('turns an answer into ranked proposals with provenance, cost and score, dropping what it must', () => {
    const answer = parsePlannerAnswer({
      proposals: [
        { candidate: 'c1', kind: 'research', topic: 'Does the transit photometry precision hold for faint host stars?', rationale: 'Systematics of ground-based transit photometry constrain atmospheres.', lens: 'sota' },
        { candidate: 'C9', kind: 'research-step', topic: 'Unknown origin', rationale: '' },
        { candidate: 'C2', kind: 'research-step', topic: 'Limb darkening in exoplanet transit photometry', rationale: 'A systematic.', lens: 'bogus' },
        { candidate: 'C2', kind: 'research-step', topic: 'limb darkening in exoplanet transit photometry', rationale: 'dup' },
        { candidate: 'C1', kind: 'research-step', topic: 'Third distinct topic about transit photometry', rationale: '' },
        { candidate: 'C1', kind: 'research-step', topic: 'Fourth topic beyond the cap', rationale: '' },
      ],
      nothing_worth_a_run: false,
      intent_covered: false,
      reason: '',
    })!
    let n = 0
    const built = buildProposals({ agent: agentRecord({ step: 'small', model: 'opus-5' }), answer, candidates, kinds: ['research-step'], cycleDate: '2026-09-07', now: '2026-09-07T02:00:00.000Z', newId: () => `p${++n}` })
    expect(built.proposals.map((p) => [p.id, p.rank, p.kind, p.lens])).toEqual([
      ['p1', 1, 'research-step', 'sota'],
      ['p2', 2, 'research-step', 'broad'],
      ['p3', 3, 'research-step', 'broad'],
    ])
    expect(built.proposals[0]).toMatchObject({
      agentId: 'a1',
      cycleDate: '2026-09-07',
      status: 'proposed',
      estCostUsd: 5,
      provenance: { candidate: 'open-question', text: 'Does the precision hold for fainter hosts?', sourcePages: ['wiki/meta/agents/ada.md'] },
    })
    expect(built.proposals[0]!.scopeScore).toBeGreaterThan(0.2)
    expect(built.rejected).toHaveLength(3)
    expect(built.rejected.join('\n')).toContain('names no known candidate (C9)')
    expect(built.rejected.join('\n')).toContain('duplicate topic')
    expect(built.rejected.join('\n')).toContain('beyond the 3-proposal cap')
    expect(estimateCostUsd('research', 'fable-5-1')).toBe(30)
  })

  it('renders the Plan section from pending proposals, or the idle reason', () => {
    const p = (over: Partial<ProposalRecord>): ProposalRecord => ({
      id: 'p1',
      agentId: 'a1',
      createdAt: '2026-09-07T02:00:00.000Z',
      cycleDate: '2026-09-07',
      kind: 'research-step',
      topic: 'Faint hosts',
      lens: 'broad',
      rationale: 'Because.',
      provenance: { candidate: 'open-question', text: 'Does it hold?', sourcePages: ['wiki/meta/agents/ada.md'] },
      pageSet: [],
      estCostUsd: 2,
      estPlanPct: null,
      scopeScore: 0.5,
      rank: 1,
      status: 'proposed',
      decidedAt: null,
      decidedVia: null,
      userNote: null,
      runId: null,
      ...over,
    })
    const text = renderPlanSection({
      pending: [p({ status: 'approved', decidedVia: 'dashboard' }), p({ id: 'p2', rank: 2, topic: 'Drifting', scopeScore: 0.1 })],
      autonomy: 'veto',
      window: { start: '01:00', end: '06:00' },
    })
    expect(text).toContain('Veto window: the top undecided proposal runs at the next night shift (01:00 to 06:00)')
    expect(text).toContain('1. research-step · Faint hosts · approved (dashboard) · about 2.00 USD')
    expect(text).toContain('2. research-step · Drifting · undecided, flagged as drift')
    expect(text).toContain('From: open-question: Does it hold? (wiki/meta/agents/ada.md)')
    expect(renderPlanSection({ pending: [], autonomy: 'veto', window: { start: '01:00', end: '06:00' }, idleReason: 'quota used' })).toBe('Nothing planned: quota used')
    expect(renderPlanSection({ pending: [p({})], autonomy: 'manual', window: { start: '01:00', end: '06:00' } })).toContain('Manual mode')
  })
})

describe('proposal and shift stores', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(MEMORY_DB)
  })
  afterEach(() => {
    db.close()
  })

  const proposal = (over: Partial<ProposalRecord>): ProposalRecord => ({
    id: 'p1',
    agentId: 'a1',
    createdAt: '2026-09-07T02:00:00.000Z',
    cycleDate: '2026-09-07',
    kind: 'research-step',
    topic: 'T',
    lens: 'broad',
    rationale: '',
    provenance: { candidate: 'gap', text: 'X', sourcePages: [] },
    pageSet: [],
    estCostUsd: 2,
    estPlanPct: null,
    scopeScore: 0.4,
    rank: 1,
    status: 'proposed',
    decidedAt: null,
    decidedVia: null,
    userNote: null,
    runId: null,
    ...over,
  })

  const exercise = (store: ProposalStore): void => {
    store.create(proposal({}))
    store.create(proposal({ id: 'p2', rank: 2 }))
    store.create(proposal({ id: 'p3', rank: 1, cycleDate: '2026-09-05', status: 'approved' }))
    store.create(proposal({ id: 'p4', agentId: 'other' }))
    store.create(proposal({ id: 'p5', rank: 3, cycleDate: '2026-09-04' }))
    // Approved first, then newest cycle, then rank.
    expect(store.list({ agentId: 'a1' }).map((p) => p.id)).toEqual(['p3', 'p1', 'p2', 'p5'])
    expect(store.get('p1')?.provenance).toEqual({ candidate: 'gap', text: 'X', sourcePages: [] })
    expect(store.update('p1', { status: 'vetoed', decidedAt: 'now', decidedVia: 'telegram', userNote: 'no', topic: 'edited' })).toMatchObject({ status: 'vetoed', decidedVia: 'telegram', topic: 'edited' })
    expect(store.list({ agentId: 'a1', status: ['proposed'] }).map((p) => p.id)).toEqual(['p2', 'p5'])
    expect(store.expire('a1', '2026-09-05')).toBe(1)
    expect(store.get('p5')?.status).toBe('expired')
    expect(store.get('p3')?.status).toBe('approved')
    expect(store.supersede('a1')).toBe(1)
    expect(store.get('p2')?.status).toBe('superseded')
    expect(store.get('p4')?.status).toBe('proposed')
    expect(store.update('missing', { rank: 2 })).toBeUndefined()
  }

  it('SqliteProposalStore orders, filters, updates, supersedes and expires', () => {
    exercise(new SqliteProposalStore(db))
  })
  it('MemoryProposalStore behaves the same', () => {
    exercise(new MemoryProposalStore())
  })

  const exerciseShifts = (store: ShiftStore): void => {
    expect(store.get('2026-09-07')).toBeUndefined()
    store.put({ cycleDate: '2026-09-07', trigger: 'timer', startedAt: 's', finishedAt: null, summary: EMPTY_SUMMARY })
    store.put({ cycleDate: '2026-09-06', trigger: 'manual', startedAt: 's', finishedAt: 'f', summary: { ...EMPTY_SUMMARY, costUsd: 2.5 } })
    store.put({ cycleDate: '2026-09-07', trigger: 'timer', startedAt: 's', finishedAt: 'f2', summary: { ...EMPTY_SUMMARY, skipped: [{ agentId: 'a', agentName: 'A', reason: 'r' }] } })
    expect(store.get('2026-09-07')).toMatchObject({ finishedAt: 'f2', summary: { skipped: [{ reason: 'r' }] } })
    expect(store.list().map((s) => s.cycleDate)).toEqual(['2026-09-07', '2026-09-06'])
    expect(store.list()[1]?.summary.costUsd).toBe(2.5)
  }
  it('SqliteShiftStore keeps one row per cycle date', () => {
    exerciseShifts(new SqliteShiftStore(db))
  })
  it('MemoryShiftStore behaves the same', () => {
    exerciseShifts(new MemoryShiftStore())
  })
})

describe('night window arithmetic', () => {
  const w = { start: '01:00', end: '06:00' }
  const at = (y: number, mo: number, d: number, h: number, mi: number): Date => new Date(y, mo - 1, d, h, mi)

  it('finds the current window, its cycle date and the next start', () => {
    const before = windowAt(at(2026, 9, 7, 0, 30), w)
    expect(before.current).toBeNull()
    expect(before.next.start).toEqual(at(2026, 9, 7, 1, 0))
    expect(before.next.cycleDate).toBe('2026-09-07')
    const inside = windowAt(at(2026, 9, 7, 3, 0), w)
    expect(inside.current).toMatchObject({ start: at(2026, 9, 7, 1, 0), end: at(2026, 9, 7, 6, 0), cycleDate: '2026-09-07' })
    expect(inside.next.start).toEqual(at(2026, 9, 8, 1, 0))
    const noon = windowAt(at(2026, 9, 7, 12, 0), w)
    expect(noon.current).toBeNull()
    expect(noon.next.cycleDate).toBe('2026-09-08')
    expect(windowAt(at(2026, 9, 7, 6, 0), w).current).toBeNull()
  })

  it('handles a window that spans midnight', () => {
    const late = { start: '23:00', end: '04:00' }
    expect(windowAt(at(2026, 9, 7, 23, 30), late).current).toMatchObject({ cycleDate: '2026-09-08', end: at(2026, 9, 8, 4, 0) })
    expect(windowAt(at(2026, 9, 8, 2, 0), late).current).toMatchObject({ cycleDate: '2026-09-08', start: at(2026, 9, 7, 23, 0) })
    expect(windowAt(at(2026, 9, 8, 5, 0), late).current).toBeNull()
  })

  it('local dates and knowledge pages', () => {
    expect(localDate(at(2026, 9, 7, 1, 30))).toBe('2026-09-07')
    expect(addDays('2026-09-01', -2)).toBe('2026-08-30')
    expect(knowledgePages(['wiki/index.md', 'wiki/hot.md', 'wiki/meta/agents/ada.md', 'wiki/questions/Research: X.md', 'wiki/concepts/A.md', 'wiki/sources/_index.md', '.vault-meta/x'])).toEqual(['wiki/concepts/A.md'])
  })
})
