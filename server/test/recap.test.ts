/**
 * Milestone A2 (docs/tasks/TASKS-A2.md): the recap model from fixtures, its page and
 * Telegram rendering, the answer grammar, the service end to end against a git vault with
 * a fake agent (build, page, summary lines, delivery, answers that change the plan), the
 * scheduler's tick, the routes and the value signal. Acceptance: a morning recap with
 * choices; answering changes the night's plan.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { SqliteAgentStore, type AgentRecord } from '../src/db/agents.js'
import { SqliteAgentRunStore, type AgentRunRecord } from '../src/db/agent-runs.js'
import { SqliteProposalStore, type ProposalRecord } from '../src/db/proposals.js'
import { SqliteShiftStore, EMPTY_SUMMARY } from '../src/db/shifts.js'
import { SqliteRecapStore, MemoryRecapStore } from '../src/db/recaps.js'
import { SqliteValueEventStore, MemoryValueEventStore } from '../src/db/value-events.js'
import { NotebookWriter, notebookPath } from '../src/pipeline/notebook.js'
import { FellowService } from '../src/pipeline/fellows.js'
import { NightShift } from '../src/pipeline/shift.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { buildServer } from '../src/api/server.js'
import type { Config } from '../src/config.js'
import type { AgentRunResult, RunAgentOptions } from '../src/pipeline/agent-runner.js'
import type { Candidate } from '../src/pipeline/candidates.js'
import { parseRecapNotes } from '../src/pipeline/candidates.js'
import {
  RecapService,
  buildRecapModel,
  codeFor,
  parseRecapAnswers,
  parseSummary,
  renderQuietLine,
  renderRecapMessages,
  renderRecapPage,
  summaryInput,
  type RecapModel, withEveryField} from '../src/pipeline/recap.js'

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
  art: 'custom',
  nightly: 'sweep',
  priority: 0,
  state: 'waiting',
  sleepReason: null,
  sleepCode: null,
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
  pages: ['wiki/questions/Research: Faint hosts.md', 'wiki/concepts/Transit Photometry.md', 'wiki/concepts/New Concept.md', 'wiki/hot.md', 'wiki/meta/agents/ada.md'],
  tokensIn: 100,
  tokensOut: 10,
  costUsd: 2.1,
  error: null,
  commitHash: 'abc123',
  startedAt: '2026-09-07T02:00:00.000Z',
  finishedAt: '2026-09-07T02:12:00.000Z',
  agentId: 'a1',
  model: 'claude-sonnet-5',
  proposalId: 'p0',
  answer: 'The run found that faint hosts degrade precision by a factor of three.',
  ...over,
})

const proposal = (over: Partial<ProposalRecord> = {}): ProposalRecord => ({
  id: 'p1',
  agentId: 'a1',
  createdAt: '2026-09-07T05:00:00.000Z',
  cycleDate: '2026-09-07',
  kind: 'research-step',
  topic: 'Limb darkening in transit photometry',
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

const at = (d: number, h: number, mi = 0): Date => new Date(2026, 8, d, h, mi)
const WINDOW = { start: '01:00', end: '06:00' }

describe('recap model from fixtures', () => {
  const fixture = (over: { runs?: AgentRunRecord[]; proposals?: ProposalRecord[]; fellows?: AgentRecord[] } = {}): RecapModel =>
    buildRecapModel({
      cycleDate: '2026-09-07',
      now: at(7, 7, 0),
      since: '2026-09-06T07:00:00.000Z',
      window: WINDOW,
      fellows: over.fellows ?? [agentRecord(), agentRecord({ id: 'a2', name: 'Bo', slug: 'bo', autonomy: 'manual', state: 'sleeping', sleepCode: 'covered', sleepReason: 'the intent is covered' })],
      runsOf: (id) => (over.runs ?? [runRecord()]).filter((r) => r.agentId === id),
      pendingOf: (id) => (over.proposals ?? [proposal(), proposal({ id: 'p2', rank: 2, status: 'approved', topic: 'Approved one' }), proposal({ id: 'p3', rank: 3, scopeScore: 0.1, topic: 'Drifting' })]).filter((p) => p.agentId === id),
      shift: { cycleDate: '2026-09-07', trigger: 'timer', startedAt: '2026-09-07T01:00:00.000Z', finishedAt: '2026-09-07T02:30:00.000Z', summary: { ...EMPTY_SUMMARY, executed: [{ agentId: 'a1', agentName: 'Ada', proposalId: 'p0', runId: 'r1', kind: 'research-step', topic: 'Faint hosts', ok: true, pages: 3, costUsd: 2.1, error: null }], skipped: [{ agentId: 'a2', agentName: 'Bo', reason: 'manual mode and nothing approved' }], costUsd: 2.5 } },
      // Today's window starts less than a day back, the week's seven days back (both in local time).
      usage: (since) => (at(7, 7, 0).getTime() - new Date(since).getTime() < 2 * 24 * 3600_000 ? { costUsd: 3.1, runs: 2 } : { costUsd: 12.4, runs: 9 }),
      valueOf: (id) => (id === 'a1' ? { pageOpens: 4, recapLinks: 1 } : { pageOpens: 5, recapLinks: 2 }),
      readPage: (rel) => (rel === notebookPath('ada') ? '---\ntype: meta\n---\n\n## Open Questions\n\n- Does it hold for faint hosts?\n- Second question?\n' : undefined),
      commitStatus: (hash) => (hash === 'abc123' ? new Map<string, 'A' | 'M' | 'D'>([['wiki/questions/Research: Faint hosts.md', 'A'], ['wiki/concepts/New Concept.md', 'A'], ['wiki/concepts/Transit Photometry.md', 'M'], ['wiki/hot.md', 'M']]) : undefined),
    })

  it('numbers Fellows, codes proposals approved first, splits created and updated pages, and totals', () => {
    const m = fixture()
    expect(m.quiet).toBe(false)
    expect(m.fellows.map((f) => [f.index, f.name])).toEqual([
      [1, 'Ada'],
      [2, 'Bo'],
    ])
    const ada = m.fellows[0]!
    expect(ada.runs).toHaveLength(1)
    expect(ada.runs[0]).toMatchObject({
      pagesCreated: ['wiki/questions/Research: Faint hosts.md', 'wiki/concepts/New Concept.md'],
      pagesUpdated: ['wiki/concepts/Transit Photometry.md'],
      commit: 'abc123',
      costUsd: 2.1,
    })
    expect(ada.proposals.map((p) => [p.code, p.proposalId, p.status, p.drift])).toEqual([
      ['1a', 'p2', 'approved', false],
      ['1b', 'p1', 'proposed', false],
      ['1c', 'p3', 'proposed', true],
    ])
    expect(ada.openQuestions).toEqual(['Does it hold for faint hosts?', 'Second question?'])
    expect(ada.value).toEqual({ pageOpens: 4, recapLinks: 1 })
    expect(m.totals).toEqual({ runs: 1, failed: 0, costUsd: 2.1, pages: 3 })
    expect(m.usage).toEqual({ today: { costUsd: 3.1, runs: 2 }, week: { costUsd: 12.4, runs: 9 } })
    expect(m.value).toEqual({ pageOpens: 5, recapLinks: 2 })
    expect(m.sleeping).toEqual([{ name: 'Bo', reason: 'the intent is covered' }])
    expect(m.shift).toMatchObject({ trigger: 'timer', executed: 1, planned: 0, costUsd: 2.5 })
    expect(codeFor(12, 2)).toBe('12b')
  })

  it('a night without runs and without new proposals is a quiet day', () => {
    const m = fixture({ runs: [], proposals: [proposal({ createdAt: '2026-09-05T05:00:00.000Z' })] })
    expect(m.quiet).toBe(true)
    expect(renderQuietLine(m)).toBe('Recap 2026-09-07: nothing ran tonight. 2 Fellows sleeping (Ada: waiting; Bo: the intent is covered).')
    // A new proposal alone makes a day worth a recap.
    expect(fixture({ runs: [] }).quiet).toBe(false)
  })

  it('renders the page and the Telegram messages with the codes', () => {
    const m = { ...fixture(), fellows: fixture().fellows.map((f, i) => (i === 0 ? { ...f, found: ['One.', 'Two.', 'Three.'] } : f)) }
    const page = renderRecapPage(m)
    expect(page.startsWith('---\ntype: meta\ntitle: "Recap: 2026-09-07"')).toBe(true)
    expect(page).toContain('tags:\n  - meta\n  - recap')
    expect(page).toContain('# Recap: 2026-09-07')
    expect(page).toContain('**Night** 01:00 to 06:00 (timer shift, 1 run(s), 0 plan(s), 2.50 USD)')
    expect(page).toContain('## 1. Ada (astronomy, sonnet-5, waiting)')
    expect(page).toContain('**Ran**: research-step "Faint hosts" · 3 page(s), 2.10 USD, commit abc123')
    expect(page).toContain('Created: [[Research: Faint hosts]], [[New Concept]]')
    expect(page).toContain('Updated: [[Transit Photometry]]')
    expect(page).toContain('**Found**:\n- One.\n- Two.\n- Three.')
    expect(page).toContain('- **1a** research-step · Approved one · about 2.00 USD · approved')
    expect(page).toContain('- **1c** research-step · Drifting · about 2.00 USD · drift, runs only if approved')
    expect(page).toContain('`skip 1` skip tonight')
    expect(page).toContain('## 2. Bo (astronomy, sonnet-5, sleeping: the intent is covered)')
    expect(page).toContain('**Ran**: nothing since the last recap.')
    expect(page).toContain('Notebook: [[ada]]')
    const messages = renderRecapMessages(m)
    expect(messages).toHaveLength(4)
    expect(messages[0]).toContain('Night 01:00 to 06:00')
    expect(messages[1]).toContain('1a research-step · Approved one')
    expect(messages[1]).not.toContain('**')
    expect(messages[1]).not.toContain('[[')
    expect(messages[3]).toContain('Answer with codes')
  })

  it('shows the plan windows, the research share and per-run points when the monitor is wired (A5)', () => {
    const plan = {
      available: true,
      source: 'sdk' as const,
      reason: null,
      liveReason: null, sinceSample: { runs: 0, fiveHour: null, sevenDay: null }, override: { enabled: false, active: false, pct: 90, expiresAt: null }, weekOverride: { enabled: false, active: false, pct: 90, expiresAt: null },
      subscription: 'max',
      planUsd: { week: 1000, fiveHour: 80, measured: false },
      sampledAt: '2026-09-07T06:00:00.000Z',
      windows: [{ window: 'five_hour', utilization: 12, resetsAt: null }, { window: 'seven_day', utilization: 31, resetsAt: null }, { window: 'seven_day_sonnet', utilization: 4, resetsAt: null }],
      resets: {},
      calibration: {
        perModel: { 'sonnet-5': { fiveHour: 1, sevenDay: 0.2, n: 3, points: { fiveHour: 3, sevenDay: 0.6 } } },
        overall: { fiveHour: 1, sevenDay: 0.2, n: 3, points: { fiveHour: 3, sevenDay: 0.6 } },
        ready: true,
      },
      consumption: { weekPct: 3.2, fiveHourPct: 1, weekUsd: 12.4, fiveHourUsd: 2.1, weekRuns: 9, fiveHourRuns: 1 },
      settings: { researchShareWeekPct: 10, researchShare5hPct: 15, reserve5hPct: 60, reserveWeekPct: 80, planWeekUsd: 1000, plan5hUsd: 80, planName: '', fiveHourOverrideEnabled: false, weekOverrideEnabled: false },
      shares: { unit: 'points' as const, week: 10, fiveHour: 15, weekUsed: 3.2, fiveHourUsed: 1, stepsLeftWeek: 17 },
      gate: null,
    }
    const m = buildRecapModel({
      cycleDate: '2026-09-07',
      now: at(7, 7, 0),
      since: '2026-09-06T07:00:00.000Z',
      window: WINDOW,
      fellows: [agentRecord()],
      runsOf: () => [runRecord({ planPctDelta: { five_hour: 2.5, seven_day: 0.4 } })],
      pendingOf: () => [],
      shift: null,
      usage: () => ({ costUsd: 2.1, runs: 1 }),
      valueOf: () => ({ pageOpens: 0, recapLinks: 0 }),
      readPage: () => undefined,
      commitStatus: () => undefined,
      plan,
    })
    expect(m.plan).toMatchObject({ available: true, calibrated: true, shares: { unit: 'points', weekUsed: 3.2 } })
    expect(m.fellows[0]!.runs[0]!.planPct).toEqual({ five_hour: 2.5, seven_day: 0.4 })
    const page = renderRecapPage(m)
    expect(page).toContain('**Plan now**: 5-hour 12%, week 31% (sonnet 4%).')
    expect(page).toContain('**Research share**: 3.2 of 10 points this week, 1 of 15 points in this 5-hour window, about 17 standard step(s) left this week.')
    expect(page).toContain('3 page(s), 2.10 USD, 0.4 points of the week and 2.5 of the 5-hour window, commit abc123')
    const usd = buildRecapModel({ cycleDate: '2026-09-07', now: at(7, 7, 0), since: 's', window: WINDOW, fellows: [], runsOf: () => [], pendingOf: () => [], shift: null, usage: () => ({ costUsd: 0, runs: 0 }), valueOf: () => ({ pageOpens: 0, recapLinks: 0 }), readPage: () => undefined, commitStatus: () => undefined, plan: { ...plan, available: false, reason: 'the SDK reports no plan rate limits for this credential', liveReason: null, sinceSample: { runs: 0, fiveHour: null, sevenDay: null }, override: { enabled: false, active: false, pct: 90, expiresAt: null }, weekOverride: { enabled: false, active: false, pct: 90, expiresAt: null }, windows: [], shares: { unit: 'usd', week: 100, fiveHour: 12, weekUsed: 12.4, fiveHourUsed: 2.1, stepsLeftWeek: 43 } } })
    const text = renderRecapPage(usd)
    expect(text).not.toContain('Plan now')
    expect(text).toContain('**Research share**: 12.4 of 100 USD this week, 2.1 of 12 USD in this 5-hour window, about 43 standard step(s) left this week (USD-equivalent: the SDK reports no plan rate limits for this credential).')
  })

  it('parses the summary answer and builds its input from runs with text', () => {
    const m = fixture()
    const input = summaryInput(m, (id) => (id === 'a1' ? [runRecord()] : []))
    expect(input).toMatchObject([{ agentId: 'a1', name: 'Ada', runs: [{ topic: 'Faint hosts' }] }])
    expect(summaryInput(m, () => [runRecord({ answer: null })])).toEqual([])
    expect(parseSummary({ fellows: [{ agentId: 'a1', lines: ['a', ' ', 'b', 'c', 'd'] }] })?.get('a1')).toEqual(['a', 'b', 'c'])
    expect(parseSummary({ nope: 1 })).toBeUndefined()
  })
})

describe('the answer grammar', () => {
  it('reads picks, vetoes, skips, pauses, notes, model, step and topic edits', () => {
    expect(parseRecapAnswers('1b 2a')?.answers).toEqual([
      { action: 'pick', fellow: 1, letter: 'b' },
      { action: 'pick', fellow: 2, letter: 'a' },
    ])
    expect(parseRecapAnswers('veto 1b, skip 2; pause 3 resume 4')?.answers).toEqual([
      { action: 'veto', fellow: 1, letter: 'b' },
      { action: 'skip', fellow: 2 },
      { action: 'pause', fellow: 3 },
      { action: 'resume', fellow: 4 },
    ])
    expect(parseRecapAnswers('veto 2')?.answers).toEqual([{ action: 'veto', fellow: 2 }])
    expect(parseRecapAnswers('note 1: look at the ESO archive, not arXiv\nmodel 1 opus-5\nstep 2 small')?.answers).toEqual([
      { action: 'note', fellow: 1, text: 'look at the ESO archive, not arXiv' },
      { action: 'model', fellow: 1, value: 'opus-5' },
      { action: 'step', fellow: 2, value: 'small' },
    ])
    expect(parseRecapAnswers('topic 1a: A sharper question')?.answers).toEqual([{ action: 'topic', fellow: 1, letter: 'a', text: 'A sharper question' }])
    expect(parseRecapAnswers('1A')?.answers).toEqual([{ action: 'pick', fellow: 1, letter: 'a' }])
  })

  it('is not fooled by ordinary messages, and reports bad tokens after a real answer', () => {
    expect(parseRecapAnswers('remember: espresso 1:2 ratio')).toBeNull()
    expect(parseRecapAnswers('https://example.org/paper')).toBeNull()
    expect(parseRecapAnswers('veto')).toBeNull()
    expect(parseRecapAnswers('1b and also 2a')).toEqual({ answers: [{ action: 'pick', fellow: 1, letter: 'b' }, { action: 'pick', fellow: 2, letter: 'a' }], errors: ['unknown token "and"', 'unknown token "also"'] })
    expect(parseRecapAnswers('skip x')?.errors).toEqual(['skip needs a Fellow number, not "x"'])
  })
})

/* ------------------------------ end to end harness ------------------------------ */

const CANDIDATES: Candidate[] = [
  { id: 'C1', kind: 'open-question', text: 'Does the precision hold for fainter hosts?', sourcePages: ['wiki/meta/agents/ada.md'], weight: 3 },
  { id: 'C2', kind: 'gap', text: 'Limb Darkening', sourcePages: ['wiki/concepts/Transit Photometry.md'], weight: 1.1 },
]
const PLAN = {
  proposals: [
    { candidate: 'C1', kind: 'research-step', topic: 'Does the transit photometry precision hold for faint host stars?', rationale: 'Systematics of ground-based transit photometry constrain atmospheres.', lens: 'broad' },
    { candidate: 'C2', kind: 'research-step', topic: 'Limb darkening models in transit photometry of exoplanet atmospheres', rationale: 'A systematic of transit photometry.', lens: 'broad' },
  ],
  nothing_worth_a_run: false,
  intent_covered: false,
  reason: '',
}

interface Harness {
  vaultRoot: string
  db: Db
  calls: RunAgentOptions[]
  clock: { now: Date }
  summaryAnswer: (ids: string[]) => unknown
  runner: MaintenanceRunner
  service: FellowService
  shift: NightShift
  recaps: RecapService
  recapStore: SqliteRecapStore<RecapModel>
  telegramSent: string[][]
  telegramOn: boolean
  commitMutex: Mutex
  events: EventBus
  runs: SqliteAgentRunStore
  values: SqliteValueEventStore
  git: (...args: string[]) => string
}

function makeHarness(): Harness {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-'))
  fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
  fs.writeFileSync(path.join(vaultRoot, 'wiki', 'index.md'), '# index\n')
  const git = (...args: string[]): string => execFileSync('git', ['-C', vaultRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
  const db = openDb(MEMORY_DB)
  const h: Partial<Harness> = { vaultRoot, db, calls: [], clock: { now: at(7, 1, 30) }, telegramSent: [], telegramOn: true, git }
  h.summaryAnswer = (ids) => ({ fellows: ids.map((id) => ({ agentId: id, lines: ['Found one thing.', 'It narrows the question.', 'Two things stay open.'] })) })
  const now = (): Date => h.clock!.now
  const commitMutex = new Mutex()
  const events = new EventBus()
  const runs = new SqliteAgentRunStore(db)
  const okResult = (text: string): AgentRunResult => ({ ok: true, result: text, usage: { tokensIn: 12, tokensOut: 3, costUsd: 0.5 }, durationMs: 1, numTurns: 1, sessionId: 's', timedOut: false })
  const runner = new MaintenanceRunner({
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    events,
    commitMutex,
    now,
    runAgent: async (opts) => {
      h.calls!.push(opts)
      await new Promise((r) => setTimeout(r, 5))
      if (opts.profile === 'query') {
        const schema = opts.outputFormat?.schema as { properties?: Record<string, unknown> } | undefined
        if (schema?.properties?.['fellows']) {
          const items = (schema.properties['fellows'] as { items: { properties: { agentId: { enum: string[] } } } }).items.properties.agentId.enum
          const answer = h.summaryAnswer!(items)
          if (answer === 'FAIL') return { ...okResult(''), ok: false, error: 'summary exploded' }
          return { ...okResult('summarised'), usage: { tokensIn: 5, tokensOut: 2, costUsd: 0.3 }, structuredOutput: answer }
        }
        return { ...okResult('planned'), usage: { tokensIn: 5, tokensOut: 2, costUsd: 0.4 }, structuredOutput: PLAN }
      }
      // A research step writes a page for real, so the commit produces a hash with statuses.
      const rel = `wiki/concepts/Finding ${h.calls!.length}.md`
      fs.mkdirSync(path.join(vaultRoot, 'wiki', 'concepts'), { recursive: true })
      fs.writeFileSync(path.join(vaultRoot, rel), '---\ntype: concept\ndomain: astronomy\n---\n\nfound\n')
      return okResult('The step found that faint hosts degrade the precision by a factor of three.')
    },
    runStore: runs,
  })
  const agents = new SqliteAgentStore(db)
  const proposals = new SqliteProposalStore(db)
  const values = new SqliteValueEventStore(db)
  const service = new FellowService({
    agents,
    runs,
    proposals,
    maintenance: runner,
    notebook: new NotebookWriter({ vaultRoot, commitMutex }),
    now,
    candidates: () => CANDIDATES,
    values,
  })
  const shifts = new SqliteShiftStore(db)
  const shift = new NightShift({ fellows: service, shifts, window: () => WINDOW, now })
  const recapStore = new SqliteRecapStore<RecapModel>(db)
  const store = new JobStore(db, events)
  const recaps = new RecapService({
    vaultRoot,
    fellows: service,
    runs,
    recaps: recapStore,
    shifts,
    maintenance: runner,
    jobs: store,
    commitMutex,
    settings: () => ({ window: WINDOW, recapTime: '07:00' }),
    now,
    telegram: () => (h.telegramOn ? async (messages) => { h.telegramSent!.push([...messages]); return [111] } : undefined),
  })
  Object.assign(h, { runner, service, shift, recaps, recapStore, commitMutex, events, runs, values })
  return h as Harness
}

describe('recap service end to end', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => {
    h.db.close()
    fs.rmSync(h.vaultRoot, { recursive: true, force: true })
  })

  const spawn = async (over: Partial<Parameters<FellowService['spawn']>[0]> = {}): Promise<AgentRecord> => {
    const { agent, refusal } = await h.service.spawn({ name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false, ...over })
    expect(refusal).toBeUndefined()
    return agent!
  }

  it('builds the morning recap over the night: page, summary lines, codes, Telegram; answers change the plan', async () => {
    const ada = await spawn({ quotaRunsPerDay: 1 })
    const bo = await spawn({ name: 'Bo', autonomy: 'manual' })
    // Night 1 plans; night 2 runs Ada's top proposal and re-plans.
    await h.shift.run('timer')
    h.clock.now = at(8, 1, 30)
    await h.shift.run('timer')
    h.clock.now = at(8, 7, 0)

    const { row, summaryRun } = await h.recaps.build({ trigger: 'manual' })
    expect(summaryRun?.status).toBe('done')
    expect(row).toMatchObject({ cycleDate: '2026-09-08', quiet: false, path: 'wiki/meta/recaps/Recap 2026-09-08.md', answeredAt: null })
    expect(row.delivered.telegram?.chatIds).toEqual([111])
    const m = row.model
    expect(m.shift).toMatchObject({ trigger: 'timer', executed: 1, planned: 2 })
    expect(m.totals.runs).toBe(1)
    const adaR = m.fellows.find((f) => f.agentId === ada.id)!
    const boR = m.fellows.find((f) => f.agentId === bo.id)!
    expect(adaR.index).toBe(1)
    expect(adaR.runs[0]).toMatchObject({ kind: 'research-step', ok: true, pagesCreated: expect.arrayContaining([expect.stringContaining('wiki/concepts/Finding')]) })
    expect(adaR.found).toEqual(['Found one thing.', 'It narrows the question.', 'Two things stay open.'])
    expect(adaR.proposals.map((p) => p.code)).toEqual(['1a', '1b'])
    expect(boR.found).toEqual([])
    expect(boR.proposals.map((p) => p.code)).toEqual(['2a', '2b'])
    expect(m.summaryCostUsd).toBe(0.3)
    // The page is in the vault and committed by the service.
    const page = fs.readFileSync(path.join(h.vaultRoot, row.path!), 'utf8')
    expect(page).toContain('# Recap: 2026-09-08')
    expect(page).toContain('**Found**:\n- Found one thing.')
    expect(h.git('log', '--format=%s', '-1')).toContain('recap: 2026-09-08')
    expect(h.telegramSent).toHaveLength(1)
    expect(h.telegramSent[0]![0]).toContain('Night 01:00 to 06:00')
    // The summary run was a query run on the default model with the cap.
    const summaryCall = h.calls.find((c) => c.prompt.includes('what it found'))!
    expect(summaryCall).toMatchObject({ profile: 'query', maxBudgetUsd: 1, timeoutMs: 3 * 60_000 })
    expect(summaryCall.model).toBeUndefined()
    expect(h.runs.list({ kind: 'recap' })[0]).toMatchObject({ ok: true, costUsd: 0.3, agentId: null })

    // Answers: Bo's second proposal is picked (manual mode now has something to run), Ada's top one vetoed.
    const outcome = await h.recaps.answer('2026-09-08', [{ action: 'pick', fellow: 2, letter: 'b' }, { action: 'veto', fellow: 1, letter: 'a' }, { action: 'pick', fellow: 9, letter: 'a' }], 'dashboard')
    expect(outcome!.results.map((r) => r.ok)).toEqual([true, true, false])
    expect(outcome!.recap.answeredAt).not.toBeNull()
    expect(h.service.runnable(bo.id)?.id).toBe(boR.proposals[1]!.proposalId)
    expect(h.service.getProposal(adaR.proposals[0]!.proposalId)!.status).toBe('vetoed')
    expect(h.service.runnable(ada.id)?.id).toBe(adaR.proposals[1]!.proposalId)

    // The next night runs what was answered.
    h.clock.now = at(9, 1, 30)
    const night3 = await h.shift.run('timer')
    /*
     * Both answers stand, but only one run is spent on them: the harness gives every Fellow
     * the same planner answer, so Ada's 1b and Bo's 2b are the SAME topic, and the second
     * dedupe (`coveredTonight`) sees the first one finish before the second starts.
     *
     * Bo's is the one the user picked, so it is HELD rather than superseded - still approved,
     * still first in line, with the reason on the record. That is the whole point of the
     * distinction: an already-covered topic costs no run tonight, and a decision the user made
     * is not thrown away to achieve it.
     */
    expect(night3.summary.executed.map((e) => e.proposalId)).toEqual([adaR.proposals[1]!.proposalId])
    expect(h.service.getProposal(boR.proposals[1]!.proposalId)!.status).toBe('approved')
    expect(night3.summary.skipped.find((s) => s.agentName === 'Bo')!.reason).toContain('keeps its place')
  })

  it('skip, pause, resume, note, model, step and topic answers; the Telegram text path', async () => {
    const ada = await spawn({})
    await h.shift.run('timer')
    h.clock.now = at(7, 7, 0)
    const { row } = await h.recaps.build({ trigger: 'manual' })
    const code = row.model.fellows[0]!.proposals[0]!.code

    const reply = await h.recaps.answerText(`skip 1, note 1: check the ESO archive first\nmodel 1 opus-5 step 1 small\ntopic ${code}: A sharper question about limb darkening`)
    expect(reply).toContain('✅ Ada skips the shift of 2026-09-08')
    expect(reply).toContain("✅ note filed in Ada's notebook")
    expect(reply).toContain('✅ Ada now runs on opus-5')
    expect(reply).toContain("✅ Ada's largest step is now small")
    expect(reply).toContain(`✅ ${code} now reads "A sharper question about limb darkening"`)
    const agent = h.service.get(ada.id)!
    expect(agent).toMatchObject({ skipUntil: '2026-09-08', model: 'opus-5', step: 'small' })
    const notebook = fs.readFileSync(path.join(h.vaultRoot, agent.notebookPath), 'utf8')
    expect(notebook).toContain('- Recap note 2026-09-07: check the ESO archive first')
    expect(notebook).toContain('Skipped tonight (2026-09-08) at your request')
    expect(parseRecapNotes(notebook)).toEqual(['check the ESO archive first'])
    expect(h.service.getProposal(row.model.fellows[0]!.proposals[0]!.proposalId)!.topic).toBe('A sharper question about limb darkening')

    // The skipped night runs nothing for Ada but still plans.
    h.clock.now = at(8, 1, 30)
    const night = await h.shift.run('timer')
    expect(night.summary.executed).toEqual([])
    expect(night.summary.skipped.map((s) => s.reason)).toContain('skipped tonight at your request')
    expect(night.summary.planned).toHaveLength(1)

    expect(await h.recaps.answerText('pause 1')).toContain('✅ Ada paused')
    expect(h.service.get(ada.id)!.state).toBe('paused')
    expect(await h.recaps.answerText('resume 1')).toContain('✅ Ada resumed')
    expect(await h.recaps.answerText('remember: espresso')).toBeNull()
    expect(await h.recaps.answerText('9a')).toContain('❌ no Fellow 9')
    expect(await h.recaps.answerText('model 1 gpt')).toContain('❌ unknown model "gpt"')
  })

  it('a quiet day gets one line and no page; a failed summary run keeps the recap', async () => {
    await spawn({})
    h.clock.now = at(7, 7, 0)
    const quiet = await h.recaps.build({ trigger: 'timer' })
    expect(quiet.row).toMatchObject({ quiet: true, path: null })
    expect(quiet.summaryRun).toBeNull()
    expect(fs.existsSync(path.join(h.vaultRoot, 'wiki/meta/recaps'))).toBe(false)
    expect(h.telegramSent[0]).toEqual([expect.stringContaining('Recap 2026-09-07: nothing ran tonight. 1 Fellow sleeping')])

    await h.shift.run('manual')
    h.clock.now = at(7, 7, 30)
    h.summaryAnswer = () => 'FAIL'
    const rebuilt = await h.recaps.build({ trigger: 'manual', force: true })
    expect(rebuilt.row.quiet).toBe(false)
    expect(rebuilt.row.model.summaryNote).toBeNull()
    // No run with a result text: the summary run is skipped entirely, nothing to summarise.
    expect(rebuilt.summaryRun).toBeNull()
  })

  it('the timer builds once per day after the recap time', async () => {
    await spawn({})
    h.clock.now = at(7, 6, 59)
    expect(await h.recaps.tick()).toBeNull()
    h.clock.now = at(7, 7, 1)
    const built = await h.recaps.tick()
    expect(built?.row.cycleDate).toBe('2026-09-07')
    expect(await h.recaps.tick()).toBeNull()
    expect(h.recaps.status()).toMatchObject({ recapTime: '07:00', building: false, nextAt: at(8, 7).toISOString() })
    expect(h.recaps.list().map((r) => r.cycleDate)).toEqual(['2026-09-07'])
    h.telegramOn = false
    h.clock.now = at(8, 7, 1)
    expect((await h.recaps.tick())?.row.delivered.telegram).toBeUndefined()
  })
})

describe('the newest recap keeps its decision half current', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => {
    h.db.close()
    fs.rmSync(h.vaultRoot, { recursive: true, force: true })
  })

  it('shows a plan that landed after the build, and says what a rebuild would add', async () => {
    const { agent } = await h.service.spawn({ name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false })
    const ada = agent!
    await h.shift.run('timer')
    h.clock.now = at(8, 7, 0)
    const { row } = await h.recaps.build({ trigger: 'manual' })
    const built = row.model.fellows[0]!.proposals.length
    expect(built).toBeGreaterThan(0)

    // What happened once: the recap is built, and a planning run lands half an hour later.
    h.clock.now = at(8, 7, 30)
    const planned = h.service.plan(ada.id, { cycleDate: '2026-09-08' })
    await h.service.settled(planned.run!.id)

    const fresh = h.recaps.get(row.cycleDate)!
    expect(fresh.model.fellows[0]!.proposals.map((p) => p.proposalId)).toEqual(
      h.service.pendingProposals(ada.id).map((p) => p.id),
    )
    // Codes are re-issued from the live list, so a code always names what the reader sees.
    expect(fresh.model.fellows[0]!.proposals.map((p) => p.code)).toEqual(['1a', '1b'])
    // The stored row is untouched: history stays as it was recorded.
    expect(h.recapStore.get(row.cycleDate)!.model.fellows[0]!.proposals).toHaveLength(built)
    /*
     * And the reader is told what only a rebuild would pick up. A PLANNING run is not that:
     * the recap's story only ever holds research kinds, so a rebuild would add no line for it -
     * what it produced is the two proposals, counted beside it.
     */
    expect(fresh.model.sinceBuilt).toEqual({ runs: 0, proposals: 2 })
  })

  it('adds the runs that landed after the build, with their facts and without the prose', async () => {
    const { agent } = await h.service.spawn({ name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false })
    const ada = agent!
    await h.shift.run('timer')
    h.clock.now = at(8, 7, 0)
    const { row } = await h.recaps.build({ trigger: 'manual' })
    const before = row.model.fellows[0]!.runs.length

    // A run started by hand, an hour after the recap was built.
    h.clock.now = at(8, 7, 60)
    const step = h.service.step(ada.id, { topic: 'a question asked by hand', override: true })
    await h.service.settled(step.run!.id)

    const fresh = h.recaps.get(row.cycleDate)!
    const runs = fresh.model.fellows[0]!.runs
    expect(runs.length).toBe(before + 1)
    expect(runs.at(-1)).toMatchObject({ topic: 'a question asked by hand', addedAfterBuild: true })
    expect(fresh.model.sinceBuilt).toMatchObject({ runs: 1 })
    // The header follows the body: totals count what the page now lists.
    expect(fresh.model.totals.runs).toBe(runs.length)
    expect(fresh.model.totals.costUsd).toBeGreaterThan(0)
    // The stored row is untouched: a recap is a record of what it recorded.
    expect(h.recapStore.get(row.cycleDate)!.model.fellows[0]!.runs).toHaveLength(before)
  })

  it('shows a Fellow spawned after the build, which was invisible before', async () => {
    await h.service.spawn({ name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false })
    await h.shift.run('timer')
    h.clock.now = at(8, 7, 0)
    const { row } = await h.recaps.build({ trigger: 'manual' })
    expect(row.model.fellows).toHaveLength(1)

    // A second Fellow, spawned after the build, runs its first step.
    h.clock.now = at(8, 7, 30)
    const { agent } = await h.service.spawn({ name: 'Noor', intent: 'Heat transport in ice shelves', homeDomain: 'climate-science', runFirstStep: false })
    const step = h.service.step(agent!.id, { topic: 'its first question', override: true })
    await h.service.settled(step.run!.id)

    const fresh = h.recaps.get(row.cycleDate)!
    expect(fresh.model.fellows.map((f) => f.name)).toEqual(['Ada', 'Noor'])
    const noor = fresh.model.fellows[1]!
    // Numbered after the ones that were there, and its codes carry that number.
    expect(noor.index).toBe(2)
    expect(noor.runs.map((r) => r.topic)).toEqual(['its first question'])
    expect(noor.found).toEqual([])
    expect(fresh.model.sinceBuilt).toMatchObject({ runs: 1 })
    // A day that looked quiet at build time is not quiet any more, so the page stops saying so.
    expect(fresh.model.quiet).toBe(false)
    /*
     * And the row says the same. The cheap flag is what the Library's decisions counter, the
     * Home inbox and the feed's chip read; while it stayed at what the night was built as,
     * they reported nothing to decide over a recap whose body listed the proposals.
     */
    expect(fresh.quiet).toBe(false)
    // The stored row is untouched: freshening is a view, not a write.
    expect(h.recapStore.get(row.cycleDate)?.quiet).toBe(true)
  })

  it('names the publications that reached the vault in this window', async () => {
    await h.service.spawn({ name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false })
    await h.shift.run('timer')
    h.clock.now = at(8, 7, 0)
    const { row } = await h.recaps.build({ trigger: 'manual' })
    // Nothing was on the list, so the recap says nothing about it.
    expect(row.model.readingFiled).toEqual([])
  })

  it('an older recap stays the record of its day', async () => {
    await h.service.spawn({ name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false })
    await h.shift.run('timer')
    h.clock.now = at(8, 7, 0)
    const older = await h.recaps.build({ trigger: 'manual' })
    h.clock.now = at(9, 7, 0)
    const newer = await h.recaps.build({ trigger: 'manual' })
    expect(newer.row.cycleDate).not.toBe(older.row.cycleDate)

    const stored = h.recapStore.get(older.row.cycleDate)!
    const read = h.recaps.get(older.row.cycleDate)!
    expect(read.model.fellows[0]!.proposals).toEqual(stored.model.fellows[0]!.proposals)
    expect(read.model.sinceBuilt).toBeNull()
  })

  it('an older recap shows what became of its proposals, and takes no answers', async () => {
    const { agent } = await h.service.spawn({ name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false })
    await h.shift.run('timer')
    h.clock.now = at(8, 7, 0)
    const older = await h.recaps.build({ trigger: 'manual' })
    expect(older.row.model.fellows[0]!.proposals.some((p) => p.status === 'proposed')).toBe(true)
    await h.service.retire(agent!.id)
    h.clock.now = at(9, 7, 0)
    await h.recaps.build({ trigger: 'manual' })

    // The runs are the record and stay; the proposals and the Fellow's state are the store's.
    const read = h.recaps.get(older.row.cycleDate)!
    expect(read.model.fellows[0]!.runs).toEqual(older.row.model.fellows[0]!.runs)
    expect(read.model.fellows[0]!.proposals.length).toBeGreaterThan(0)
    expect(read.model.fellows[0]!.proposals.every((p) => p.status === 'expired')).toBe(true)
    expect(read.model.fellows[0]!.state).toBe('retired')
    const listed = h.recaps.list().find((r) => r.cycleDate === older.row.cycleDate)!
    expect(listed.model.fellows[0]!.proposals.every((p) => p.status === 'expired')).toBe(true)
    // The stored snapshot is untouched: settling is a read, not a rewrite.
    expect(h.recapStore.get(older.row.cycleDate)!.model.fellows[0]!.proposals.some((p) => p.status === 'proposed')).toBe(true)

    const code = older.row.model.fellows[0]!.proposals[0]!.code
    const refused = await h.recaps.answer(older.row.cycleDate, [{ action: 'pick', fellow: 1, letter: code.slice(1) }, { action: 'skip', fellow: 1 }], 'dashboard')
    expect(refused!.results.map((r) => r.ok)).toEqual([false, false])
    expect(refused!.results[0]!.message).toContain('record of its day')
    expect(h.recapStore.get(older.row.cycleDate)!.answeredAt).toBeNull()
  })

  it('a retired Fellow takes no skip, pause, note, model or step', async () => {
    const { agent } = await h.service.spawn({ name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false })
    await h.shift.run('timer')
    h.clock.now = at(8, 7, 0)
    await h.recaps.build({ trigger: 'manual' })
    // A skip set while it worked is cleared by retiring: there is no night left to skip.
    await h.service.skipTonight(agent!.id)
    expect(h.service.get(agent!.id)!.skipUntil).not.toBeNull()
    await h.service.retire(agent!.id)
    const before = h.service.get(agent!.id)!
    expect(before.skipUntil).toBeNull()
    const reply = await h.recaps.answerText('skip 1\npause 1\nnote 1: later\nmodel 1 opus-5\nstep 1 small')
    expect(reply).toContain('❌ Ada is retired')
    expect(reply).not.toContain('✅')
    expect(h.service.get(agent!.id)).toMatchObject({ state: 'retired', skipUntil: null, model: before.model, step: before.step })
    // The service itself holds the line, whichever door the request comes through.
    expect((await h.service.pause(agent!.id))?.state).toBe('retired')
    expect((await h.service.resume(agent!.id))?.state).toBe('retired')
    expect(h.service.get(agent!.id)!.skipUntil).toBeNull()
  })

  it('an answer comes back with the proposal in the state it just gave it', async () => {
    const { agent } = await h.service.spawn({ name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false })
    await h.shift.run('timer')
    h.clock.now = at(8, 7, 0)
    const { row } = await h.recaps.build({ trigger: 'manual' })
    const first = row.model.fellows[0]!.proposals[0]!
    expect(first.status).toBe('proposed')

    const answered = await h.recaps.answer(row.cycleDate, [{ action: 'pick', fellow: 1, letter: first.code.slice(1) }], 'dashboard')
    expect(answered!.results[0]!.ok).toBe(true)
    // The snapshot would still say "proposed"; the recap that comes back does not.
    const shown = answered!.recap.model.fellows[0]!.proposals.find((p) => p.proposalId === first.proposalId)
    expect(shown?.status ?? 'gone').not.toBe('proposed')
    expect(agent).toBeDefined()
  })
})

describe('recap and value routes', () => {
  let h: Harness
  let app: FastifyInstance
  beforeEach(async () => {
    h = makeHarness()
    const config: Config = {
      vaultRoot: h.vaultRoot,
      obsidianVaultName: 'vault',
      demoMode: false,
      agentsEnabled: true,
      auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
      telegram: null,
      server: { host: '127.0.0.1', port: 0, watchFolder: path.join(h.vaultRoot, 'inbox'), maxUploadBytes: 1024 * 1024, authMode: 'local-single-user' },
    }
    const store = new JobStore(h.db, h.events)
    const queue = new IngestQueue({ store, vaultRoot: h.vaultRoot, auth: config.auth, runIngest: async () => { throw new Error('no agent') } })
    app = await buildServer({ config, store, chat: new ChatStore(h.db), queue, events: h.events, maintenance: h.runner, logger: false, commitMutex: h.commitMutex, agentRuns: h.runs, fellows: h.service, shift: h.shift, recaps: h.recaps })
  })
  afterEach(async () => {
    await app.close()
    h.db.close()
    fs.rmSync(h.vaultRoot, { recursive: true, force: true })
  })

  it('lists, builds, shows and answers recaps; value events attribute pages to their Fellow', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).json()).toMatchObject({ fellows: true })
    const created = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false } })
    const { agent } = created.json() as { agent: AgentRecord }
    await h.shift.run('manual')
    const step = h.service.step(agent.id, { topic: 'A manual step' })
    await h.service.settled(step.run!.id)
    const stepRun = h.runs.list({ agentId: agent.id, kind: 'research-step' })[0]!

    const empty = (await app.inject({ method: 'GET', url: '/api/v1/recaps' })).json() as { recaps: unknown[]; status: { recapTime: string } }
    expect(empty.recaps).toEqual([])
    expect(empty.status.recapTime).toBe('07:00')
    expect((await app.inject({ method: 'GET', url: '/api/v1/recaps/2026-09-07' })).statusCode).toBe(404)

    const built = await app.inject({ method: 'POST', url: '/api/v1/recaps/build', payload: {} })
    expect(built.statusCode).toBe(202)
    for (let i = 0; i < 400 && h.recaps.isBuilding; i++) await new Promise((r) => setTimeout(r, 5))
    const list = (await app.inject({ method: 'GET', url: '/api/v1/recaps' })).json() as { recaps: Array<{ cycleDate: string; path: string | null }> }
    expect(list.recaps[0]).toMatchObject({ cycleDate: '2026-09-07', path: 'wiki/meta/recaps/Recap 2026-09-07.md' })
    const one = (await app.inject({ method: 'GET', url: '/api/v1/recaps/2026-09-07' })).json() as { recap: { model: RecapModel } }
    const codes = one.recap.model.fellows[0]!.proposals.map((p) => p.code)
    expect(codes).toEqual(['1a', '1b'])

    const bad = await app.inject({ method: 'POST', url: '/api/v1/recaps/2026-09-07/answers', payload: { text: 'just a note' } })
    expect(bad.statusCode).toBe(400)
    const answered = await app.inject({ method: 'POST', url: '/api/v1/recaps/2026-09-07/answers', payload: { answers: [{ action: 'pick', fellow: 1, letter: 'b' }], text: 'note 1: prefer ESO data' } })
    expect(answered.statusCode).toBe(200)
    const body = answered.json() as { results: Array<{ ok: boolean; message: string }>; errors: string[]; recap: { answeredAt: string | null } }
    expect(body.results.map((r) => r.ok)).toEqual([true, true])
    expect(body.recap.answeredAt).not.toBeNull()
    expect(h.service.runnable(agent.id)?.id).toBe(one.recap.model.fellows[0]!.proposals[1]!.proposalId)
    expect((await app.inject({ method: 'POST', url: '/api/v1/recaps/2026-09-01/answers', payload: { text: '1a' } })).statusCode).toBe(404)

    // Value events: a page the Fellow's run committed is attributed to it; an unknown page to nobody.
    const page = stepRun.pages.find((p) => p.startsWith('wiki/concepts/'))!
    const ev = await app.inject({ method: 'POST', url: '/api/v1/value-events', payload: { kind: 'page_open', page } })
    expect(ev.statusCode).toBe(202)
    expect((ev.json() as { agentId: string | null }).agentId).toBe(agent.id)
    await app.inject({ method: 'POST', url: '/api/v1/value-events', payload: { kind: 'recap_link', page: 'wiki/concepts/Nobody.md' } })
    await app.inject({ method: 'POST', url: '/api/v1/value-events', payload: { kind: 'recap_link', page: 'wiki/concepts/Nobody.md', agentId: agent.id } })
    const card = (await app.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}/card` })).json() as { value: { pageOpens: number; recapLinks: number } }
    expect(card.value).toEqual({ pageOpens: 1, recapLinks: 1 })
    expect(h.service.valueCounts()).toEqual({ pageOpens: 1, recapLinks: 2 })
    expect((await app.inject({ method: 'POST', url: '/api/v1/value-events', payload: { kind: 'nope' } })).statusCode).toBe(400)
  })
})

describe('a recap stored before A3', () => {
  it('reads with the missing fields filled in', async () => {
    const h = makeHarness()
    try {
      const old = buildRecapModel({ cycleDate: '2026-09-01', now: at(1, 7, 0), since: 's', window: WINDOW, fellows: [], runsOf: () => [], pendingOf: () => [], shift: null, usage: () => ({ costUsd: 0, runs: 0 }), valueOf: () => ({ pageOpens: 0, recapLinks: 0 }), readPage: () => undefined, commitStatus: () => undefined })
      const withoutA3: Record<string, unknown> = { ...old }
      delete withoutA3['unclaimed']
      delete withoutA3['dedupe']
      h.recapStore.put({ cycleDate: '2026-09-01', generatedAt: 'g', path: null, quiet: true, model: withoutA3 as unknown as RecapModel, delivered: {}, answeredAt: null })
      expect(h.recaps.get('2026-09-01')!.model).toMatchObject({ unclaimed: [], dedupe: { merged: [], overlaps: [] } })
      expect(h.recaps.list()[0]!.model.dedupe.merged).toEqual([])
      expect(h.recaps.latest()!.model.unclaimed).toEqual([])
      expect(await h.recaps.answerText('spawn u1')).toContain('no unclaimed request u1')
    } finally {
      h.db.close()
      fs.rmSync(h.vaultRoot, { recursive: true, force: true })
    }
  })
})

describe('memory stores behave like the sqlite ones', () => {
  it('recaps and value events', () => {
    const recaps = new MemoryRecapStore<{ x: number }>()
    recaps.put({ cycleDate: '2026-09-07', generatedAt: 'g', path: null, quiet: true, model: { x: 1 }, delivered: {}, answeredAt: null })
    recaps.put({ cycleDate: '2026-09-08', generatedAt: 'g', path: 'p', quiet: false, model: { x: 2 }, delivered: {}, answeredAt: null })
    expect(recaps.list().map((r) => r.cycleDate)).toEqual(['2026-09-08', '2026-09-07'])
    expect(recaps.update('2026-09-07', { answeredAt: 'a' })?.answeredAt).toBe('a')
    expect(recaps.update('2026-09-09', { answeredAt: 'a' })).toBeUndefined()
    const values = new MemoryValueEventStore()
    values.record({ ts: '2026-09-07T08:00:00.000Z', kind: 'page_open', agentId: 'a1', page: 'p' })
    values.record({ ts: '2026-09-01T08:00:00.000Z', kind: 'recap_link', agentId: 'a1', page: 'p' })
    expect(values.counts('2026-09-05T00:00:00.000Z', 'a1')).toEqual({ pageOpens: 1, recapLinks: 0 })
    expect(values.counts('2026-08-01T00:00:00.000Z')).toEqual({ pageOpens: 1, recapLinks: 1 })
  })
})

/*
 * A recap is stored as JSON and read back with a cast, never migrated, so a row keeps the
 * shape it had on the night it was built. The model has gained five fields since A3, each in
 * its own commit, and several views read them without a guard - `m.dedupe.merged.length`,
 * `m.usage.week.costUsd`, `m.totals.pages`. A recap from before one of those fields therefore
 * did not render a gap, it threw, and the screen around it went too.
 */
describe('a recap stored by an older version', () => {
  const ancient = {
    cycleDate: '2026-09-01',
    generatedAt: '2026-09-01T07:00:00.000Z',
    path: 'wiki/meta/recaps/Recap 2026-09-01.md',
    quiet: false,
    delivered: {},
    answeredAt: null,
    // Exactly what A3 wrote: no dedupe, no plan, no reading lists, no sinceBuilt, and a usage
    // block with only the half that existed then.
    model: {
      cycleDate: '2026-09-01',
      generatedAt: '2026-09-01T07:00:00.000Z',
      quiet: false,
      since: '2026-08-31T07:00:00.000Z',
      window: { start: '01:00', end: '06:00' },
      shift: null,
      totals: { runs: 1, failed: 0, costUsd: 2 },
      usage: { today: { costUsd: 2, runs: 1 } },
      value: { pageOpens: 0, recapLinks: 0 },
      fellows: [],
      sleeping: [],
      summaryNote: null,
      summaryCostUsd: null,
      unclaimed: [],
    },
  }

  it('reads back with every list the views expect, without inventing numbers', () => {
    // The cast is the test: this row does not match today's type, which is the situation.
    const m = withEveryField(ancient as unknown as Parameters<typeof withEveryField>[0]).model
    // The lists a view calls `.length` on are lists.
    expect(m.dedupe.merged).toEqual([])
    expect(m.dedupe.overlaps).toEqual([])
    expect(m.readingFiled).toEqual([])
    expect(m.readingAdded).toEqual([])
    expect(m.unclaimed).toEqual([])
    // The nested numbers a view reads through are readable, and default to zero rather than
    // to a guess: a night that recorded no week usage did not have zero, it had none, and
    // zero is the only honest thing to draw.
    expect(m.usage.week).toEqual({ costUsd: 0, runs: 0 })
    expect(m.totals.pages).toBe(0)
    // What the row DID record survives untouched.
    expect(m.totals.runs).toBe(1)
    expect(m.totals.costUsd).toBe(2)
    expect(m.usage.today).toEqual({ costUsd: 2, runs: 1 })
    // Absent objects stay absent rather than becoming empty shells.
    expect(m.plan).toBeNull()
    expect(m.sinceBuilt).toBeNull()
  })
})
