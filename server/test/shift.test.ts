/**
 * Milestone A1 (docs/tasks/TASKS-A1.md): the Fellow service's planning run, proposals and
 * decisions, and the night shift, against a real git vault with a fake agent and a pinned
 * clock. Acceptance: proposals appear after the night, the undecided top one runs the next
 * night, the quota stops the second.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { SqliteAgentStore, type AgentRecord } from '../src/db/agents.js'
import { SqliteAgentRunStore } from '../src/db/agent-runs.js'
import { SqliteProposalStore, type ProposalRecord } from '../src/db/proposals.js'
import { SqliteShiftStore } from '../src/db/shifts.js'
import { NotebookWriter } from '../src/pipeline/notebook.js'
import { FellowService, type GateBlock } from '../src/pipeline/fellows.js'
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
import type { ReadingEntry } from '../src/pipeline/reading-list.js'
import { MemoryUsageSampleStore } from '../src/db/usage-samples.js'
import type { PlanSettings } from '../src/pipeline/usage-monitor.js'
import { UsageMonitor } from '../src/pipeline/usage-monitor.js'

const INTENT = 'How well can ground-based transit photometry constrain exoplanet atmospheres, and where do the systematics come from?'

const CANDIDATES: Candidate[] = [
  { id: 'C1', kind: 'open-question', text: 'Does the precision hold for fainter hosts?', sourcePages: ['wiki/meta/agents/ada.md'], weight: 3 },
  { id: 'C2', kind: 'gap', text: 'Limb Darkening', sourcePages: ['wiki/concepts/Transit Photometry.md'], weight: 1.1 },
]

const TWO_PROPOSALS = {
  proposals: [
    { candidate: 'C1', kind: 'research-step', topic: 'Does the transit photometry precision hold for faint host stars?', rationale: 'Bears on the systematics of ground-based transit photometry that constrain atmospheres.', lens: 'broad' },
    { candidate: 'C2', kind: 'research-step', topic: 'Limb darkening models in transit photometry of exoplanet atmospheres', rationale: 'Limb darkening is a systematic of transit photometry.', lens: 'broad' },
  ],
  nothing_worth_a_run: false,
  intent_covered: false,
  reason: '',
}

const DRIFT_PROPOSAL = {
  proposals: [{ candidate: 'C1', kind: 'research-step', topic: 'Sourdough starter hydration ratios', rationale: 'Bread baking at home.', lens: 'broad' }],
  nothing_worth_a_run: false,
  intent_covered: false,
  reason: '',
}

const NOTHING = { proposals: [], nothing_worth_a_run: true, intent_covered: true, reason: 'the library answers the intent as far as it can' }

const at = (d: number, h: number, mi = 0): Date => new Date(2026, 8, d, h, mi)

interface Harness {
  vaultRoot: string
  db: Db
  calls: RunAgentOptions[]
  clock: { now: Date }
  planAnswer: () => unknown
  committedPages: () => string[]
  researchOk: () => boolean
  gate: () => GateBlock | null
  /** The shift's injected waits (A5 D5): each advances the clock instead of sleeping. */
  sleeps: number[]
  candidates: () => Candidate[]
  /** Reading list entries the service wrote for the planner. */
  reading: ReadingEntry[]
  /** What the reconcile pass reports as newly arrived in the vault. */
  readingFiled: Array<{ entry: ReadingEntry; page: string }>
  runner: MaintenanceRunner
  service: FellowService
  shift: NightShift
  shifts: SqliteShiftStore
  proposals: SqliteProposalStore
  agents: SqliteAgentStore
  commitMutex: Mutex
  events: EventBus
  runs: SqliteAgentRunStore
  /** The usage monitor, when the harness was built with one (A5). */
  usage?: UsageMonitor
  /** What the fake runner reports as the plan windows before and after each run. */
  windows: { before: [number, number]; after: [number, number] }
  planSettings: PlanSettings
}

const sdkUsage = (five: number, week: number): Record<string, unknown> => ({
  rate_limits_available: true,
  subscription_type: 'max',
  rate_limits: { five_hour: { utilization: five, resets_at: null }, seven_day: { utilization: week, resets_at: null } },
})

function makeHarness(withUsage = false): Harness {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-'))
  fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
  fs.writeFileSync(path.join(vaultRoot, 'wiki', 'index.md'), '# index\n')
  const git = (...args: string[]): string => execFileSync('git', ['-C', vaultRoot, ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed')
  const db = openDb(MEMORY_DB)
  const h: Partial<Harness> = {
    vaultRoot,
    db,
    calls: [],
    clock: { now: at(7, 1, 30) },
    sleeps: [],
    windows: { before: [10, 20], after: [12, 21] },
    planSettings: { researchShareWeekPct: 10, researchShare5hPct: 15, reserve5hPct: 60, reserveWeekPct: 80, planWeekUsd: 1000, plan5hUsd: 80, planName: '' },
  }
  h.planAnswer = () => TWO_PROPOSALS
  h.committedPages = () => ['wiki/questions/Research: Q.md', 'wiki/concepts/New Concept.md']
  h.researchOk = () => true
  h.gate = () => null
  h.candidates = () => CANDIDATES
  h.reading = []
  h.readingFiled = []
  const now = (): Date => h.clock!.now
  const commitMutex = new Mutex()
  const events = new EventBus()
  const runs = new SqliteAgentRunStore(db)
  const usage = withUsage ? new UsageMonitor({ store: new MemoryUsageSampleStore(), runs, settings: () => h.planSettings!, now }) : undefined
  const okResult = (text: string): AgentRunResult => ({ ok: true, result: text, usage: { tokensIn: 12, tokensOut: 3, costUsd: 0.5 }, durationMs: 1, numTurns: 1, sessionId: 's', timedOut: false })
  const runner = new MaintenanceRunner({
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    events,
    commitMutex,
    now,
    runAgent: async (opts) => {
      h.calls!.push(opts)
      await new Promise((r) => setTimeout(r, 15))
      // The plan samples a real SDK session would yield (A5), reported through the hooks and on the result.
      const before = sdkUsage(...h.windows!.before)
      const after = sdkUsage(...h.windows!.after)
      opts.onPlanUsage?.('before', before)
      opts.onPlanUsage?.('after', after)
      const planUsage = opts.onPlanUsage ? { planUsage: { before, after } } : {}
      if (opts.profile === 'query') {
        const answer = h.planAnswer!()
        if (answer === 'FAIL') return { ...okResult(''), ok: false, error: 'planner exploded', ...planUsage }
        return { ...okResult('planned'), usage: { tokensIn: 5, tokensOut: 2, costUsd: 0.4 }, structuredOutput: answer, ...planUsage }
      }
      return h.researchOk!() ? { ...okResult('filed pages'), ...planUsage } : { ...okResult(''), ok: false, error: 'agent exploded', ...planUsage }
    },
    commit: async () => ({ committed: true, hash: 'abc12345', committedPages: h.committedPages!() }),
    runStore: runs,
    ...(usage ? { usage } : {}),
  })
  const agents = new SqliteAgentStore(db)
  const proposals = new SqliteProposalStore(db)
  const service = new FellowService({
    agents,
    runs,
    proposals,
    maintenance: runner,
    notebook: new NotebookWriter({ vaultRoot, commitMutex }),
    // The planner is read-only and has no web: what it names reaches the reading list as data.
    reading: {
      add: async (entries) => {
        h.reading!.push(...entries)
        return { added: entries.length }
      },
      reconcile: async () => h.readingFiled!,
      entries: () => h.reading!.map((e) => ({ ...e, page: e.filed })),
    },
    now,
    candidates: () => h.candidates!(),
    gate: (ctx) => h.gate!() ?? (usage ? usage.gate(ctx) : null),
    ...(usage ? { estimatePct: (cost: number, model: string) => usage.estimatePct(cost, model) } : {}),
  })
  const shifts = new SqliteShiftStore(db)
  const shift = new NightShift({
    fellows: service,
    shifts,
    window: () => ({ start: '01:00', end: '06:00' }),
    now,
    sleep: async (ms) => {
      h.sleeps!.push(ms)
      h.clock!.now = new Date(h.clock!.now.getTime() + ms)
    },
  })
  Object.assign(h, { runner, service, shift, shifts, proposals, agents, commitMutex, events, runs, ...(usage ? { usage } : {}) })
  return h as Harness
}

describe('plan points through the whole path (A5)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness(true)
  })
  afterEach(() => {
    h.db.close()
    fs.rmSync(h.vaultRoot, { recursive: true, force: true })
  })

  it('deltas land on the run rows, three runs calibrate, proposals and the card carry points, the gate refuses in points', async () => {
    const { agent } = await h.service.spawn({ name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false, quotaRunsPerDay: 5 })
    const ada = agent!
    // A wide 5-hour share: this test is about the week's.
    h.planSettings = { ...h.planSettings, researchShare5hPct: 60 }
    // Three manual steps at 0.5 USD, each moving the week by one point and the 5-hour window by two.
    for (let i = 0; i < 3; i++) {
      h.windows = { before: [10 + 2 * i, 20 + i], after: [12 + 2 * i, 21 + i] }
      const { run, refusal } = h.service.step(ada.id, { topic: `Step ${i}` })
      expect(refusal).toBeUndefined()
      await h.service.settled(run!.id)
      h.clock.now = new Date(h.clock.now.getTime() + 60_000)
    }
    const rows = h.runs.list({ agentId: ada.id, kind: 'research-step' })
    expect(rows).toHaveLength(3)
    // The first run diffs against its own before sample; the later ones against the previous run's after sample (the baseline).
    expect(rows.map((r) => r.planPctDelta)).toEqual([{ five_hour: 2, seven_day: 1 }, { five_hour: 2, seven_day: 1 }, { five_hour: 2, seven_day: 1 }])
    expect(h.usage!.calibration()).toEqual({ perModel: { 'sonnet-5': { fiveHour: 4, sevenDay: 2, n: 3 } }, ready: true })
    expect(h.service.card(ada.id)!.spend).toMatchObject({ runsWeek: 3, weekUsd: 1.5, weekPct: 3 })

    // A planning run prices its proposals in points: a 2 USD step is 4 points of the week.
    const planned = h.service.plan(ada.id)
    await h.service.settled(planned.run!.id)
    expect(h.service.pendingProposals(ada.id).map((p) => [p.estCostUsd, p.estPlanPct])).toEqual([[2, 4], [2, 4]])

    // The share holds 10 points; 4 consumed (the planning run took one too) plus 4 fits.
    const fits = h.service.step(ada.id, { topic: 'fits' })
    expect(fits.refusal).toBeUndefined()
    await h.service.settled(fits.run!.id)
    expect(h.usage!.consumption()).toMatchObject({ weekPct: 5, weekRuns: 5 })
    // A share of 6 has no room for another 4-point step.
    h.planSettings = { ...h.planSettings, researchShareWeekPct: 6 }
    const refused = h.service.step(ada.id, { topic: 'no room' }).refusal
    expect(refused).toMatchObject({ code: 'share', error: 'the research share of the week is used up (5 of 6 points, this step about 4)' })
    expect(h.usage!.status({ estCostUsd: 2, model: 'sonnet-5' }).shares).toEqual({ unit: 'points', week: 6, fiveHour: 60, weekUsed: 5, fiveHourUsed: 10, stepsLeftWeek: 0 })
  })
})

describe('planning, proposals and the night shift', () => {
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
  const notebook = (agent: AgentRecord): string => fs.readFileSync(path.join(h.vaultRoot, agent.notebookPath), 'utf8')
  const pending = (id: string): ProposalRecord[] => h.service.pendingProposals(id)

  /**
   * The task rotation (docs/agents/ideas.md, decision 2026-09-07). The unit tests pin the
   * arithmetic; this pins the thing that actually matters - that a different task reaches the
   * prompt each night, and that one answered task does not stop the Fellow.
   */
  it('takes its tasks in turn: a different one reaches the planner each night, and only that one', async () => {
    const ada = await spawn({
      tasks: [
        { text: 'new ground-based transit surveys and their first results', kind: 'watch' },
        { text: 'How far can photometry constrain atmospheric retrievals?', kind: 'explore' },
      ],
    })
    expect(ada.tasks.map((t) => t.kind)).toEqual(['watch', 'explore'])
    expect(ada.intent).toBe('new ground-based transit surveys and their first results')

    await h.shift.run('timer')
    const first = h.calls.filter((c) => c.profile === 'query').at(-1)!.prompt
    expect(first).toContain("Tonight's task (1 of 2): new ground-based transit surveys")
    expect(first).toContain('a watch task')
    // The other task is named as NOT for tonight, so the planner cannot plan against both.
    expect(first).toContain('do not propose against them')
    expect(h.service.get(ada.id)!.taskCursor).toBe(1)

    // Night two: the next task, and a step size that no longer forbids anything but a step.
    h.clock!.now = new Date('2026-09-08T01:10:00.000Z')
    await h.shift.run('timer')
    const second = h.calls.filter((c) => c.profile === 'query').at(-1)!.prompt
    expect(second).toContain("Tonight's task (2 of 2): How far can photometry")
    expect(second).toContain('an explore task')
    expect(h.service.get(ada.id)!.taskCursor).toBe(0)
  })

  it('rests the task the planner answered and keeps the Fellow working the others', async () => {
    const ada = await spawn({
      tasks: [
        { text: 'a watch that never ends', kind: 'watch' },
        { text: 'a question that can be answered', kind: 'explore' },
      ],
    })
    // Night one is the watch task; it finds nothing, which must NOT put the Fellow to sleep,
    // because a different task is up tomorrow.
    h.planAnswer = () => ({ proposals: [], handoffs: [], reading: [], nothing_worth_a_run: true, intent_covered: false, reason: 'quiet field' })
    await h.shift.run('timer')
    expect(h.service.get(ada.id)!.state).toBe('waiting')

    // Night two is the explore task, and the planner reports it answered.
    h.clock!.now = new Date('2026-09-08T01:10:00.000Z')
    h.planAnswer = () => ({ proposals: [], handoffs: [], reading: [], nothing_worth_a_run: true, intent_covered: true, reason: 'answered' })
    await h.shift.run('timer')
    const after = h.service.get(ada.id)!
    expect(after.tasks.map((t) => t.state)).toEqual(['active', 'resting'])
    // The watch is still standing, so the Fellow is not asleep.
    expect(after.state).toBe('waiting')
  })

  it('acceptance: proposals appear after the night, the top undecided one runs the next night, the quota stops the second', async () => {
    const ada = await spawn({ quotaRunsPerDay: 1 })
    expect(ada.state).toBe('proposed')

    // Night 1: nothing to execute yet; the planner writes two proposals.
    const night1 = await h.shift.run('timer')
    expect(night1.cycleDate).toBe('2026-09-07')
    expect(night1.summary.executed).toEqual([])
    expect(night1.summary.planned).toMatchObject([{ agentName: 'Ada', ok: true, proposals: 2, costUsd: 0.4 }])
    expect(night1.summary.costUsd).toBe(0.4)
    const planCall = h.calls.find((c) => c.profile === 'query')!
    expect(planCall).toMatchObject({ model: 'claude-sonnet-5', maxBudgetUsd: 1, timeoutMs: 5 * 60_000 })
    expect(planCall.outputFormat?.type).toBe('json_schema')
    expect(planCall.prompt).toContain('C1 [open-question')
    const afterPlan = h.service.get(ada.id)!
    expect(afterPlan.state).toBe('waiting')
    const [p1, p2] = pending(ada.id)
    expect([p1!.rank, p2!.rank]).toEqual([1, 2])
    expect(p1).toMatchObject({ kind: 'research-step', status: 'proposed', cycleDate: '2026-09-07', estCostUsd: 2, provenance: { candidate: 'open-question' } })
    expect(p1!.scopeScore).toBeGreaterThanOrEqual(0.2)
    expect(notebook(ada)).toContain(`1. research-step · ${p1!.topic} · undecided · about 2.00 USD`)
    expect(h.service.list()[0]).toMatchObject({ pendingProposals: 2, next: { id: p1!.id } })
    // The run log carries the planning run, attributed and costed; the ledger's quota ignores it.
    expect(h.runs.list({ agentId: ada.id })[0]).toMatchObject({ kind: 'plan', costUsd: 0.4, ok: true })
    expect(h.service.card(ada.id)!.quota).toEqual({ runsPerDay: 1, usedToday: 0 })

    // The same night again: the row exists, the timer does nothing.
    expect(await h.shift.tick()).toBeNull()

    // Night 2: the top undecided proposal runs; the second round hits the quota; a new plan follows.
    h.clock.now = at(8, 1, 30)
    const night2 = (await h.shift.tick())!
    expect(night2.cycleDate).toBe('2026-09-08')
    expect(night2.summary.executed).toMatchObject([{ agentName: 'Ada', proposalId: p1!.id, kind: 'research-step', topic: p1!.topic, ok: true, pages: 2, costUsd: 0.5 }])
    expect(night2.summary.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining([expect.stringContaining("used today's quota (1 of 1 runs)")]))
    expect(night2.summary.planned).toMatchObject([{ agentName: 'Ada', ok: true, proposals: 2 }])
    const executed = h.service.getProposal(p1!.id)!
    expect(executed).toMatchObject({ status: 'executed' })
    expect(h.runs.list({ agentId: ada.id }).find((r) => r.id === executed.runId)).toMatchObject({ kind: 'research-step', proposalId: p1!.id, label: p1!.topic })
    expect(h.service.getProposal(p2!.id)!.status).toBe('superseded')
    const fresh = pending(ada.id)
    expect(fresh).toHaveLength(2)
    expect(fresh.every((p) => p.cycleDate === '2026-09-08')).toBe(true)
    expect(h.service.get(ada.id)!.state).toBe('waiting')
    const stepCall = h.calls.find((c) => c.profile === 'research')!
    expect(stepCall.prompt).toContain('<research_step>')
    expect(stepCall.prompt).toContain(p1!.topic)
    expect(h.shifts.list().map((s) => s.cycleDate)).toEqual(['2026-09-08', '2026-09-07'])
    const card = h.service.card(ada.id)!
    expect(card.spend).toMatchObject({ runsToday: 2, todayUsd: 0.9 })
    expect(card.proposals.length).toBeGreaterThanOrEqual(4)
  })

  it('manual mode runs nothing unapproved; an approval runs it and beats the rank', async () => {
    const bo = await spawn({ name: 'Bo', autonomy: 'manual', quotaRunsPerDay: 2 })
    await h.shift.run('timer')
    const [p1, p2] = pending(bo.id)
    expect(h.service.runnable(bo.id)).toBeUndefined()
    expect(notebook(bo)).toContain('Manual mode: a proposal runs only after you approve it.')

    // The user approves the second one during the day; it beats the rank at night.
    const decided = await h.service.decide(p2!.id, { status: 'approved', note: 'this one first', via: 'telegram' })
    expect(decided.proposal).toMatchObject({ status: 'approved', decidedVia: 'telegram', userNote: 'this one first' })
    expect(h.service.runnable(bo.id)?.id).toBe(p2!.id)
    h.clock.now = at(8, 1, 30)
    const night2 = await h.shift.run('timer')
    expect(night2.summary.executed).toMatchObject([{ proposalId: p2!.id }])
    expect(night2.summary.skipped.map((s) => s.reason)).toContain('manual mode and nothing approved')
    // The planner superseded the undecided p1 while the executed p2 keeps its row.
    expect(h.service.getProposal(p1!.id)!.status).toBe('superseded')
    expect(h.service.getProposal(p2!.id)!.status).toBe('executed')

    // Fresh, unapproved proposals: the next night runs nothing.
    h.clock.now = at(9, 1, 30)
    const night3 = await h.shift.run('timer')
    expect(night3.summary.executed).toEqual([])
    expect(pending(bo.id).every((p) => p.status === 'proposed')).toBe(true)
  })

  it('a drift proposal never runs undecided in veto mode, is dropped in auto mode, and runs when approved', async () => {
    h.planAnswer = () => DRIFT_PROPOSAL
    const vi = await spawn({ name: 'Vi' })
    const cy = await spawn({ name: 'Cy', autonomy: 'auto' })
    await h.shift.run('timer')
    const [drift] = pending(vi.id)
    expect(drift!.scopeScore).toBe(0)
    expect(h.service.runnable(vi.id)).toBeUndefined()
    expect(notebook(vi)).toContain('flagged as drift')
    expect(pending(cy.id)).toEqual([])
    expect(h.service.get(cy.id)).toMatchObject({ state: 'sleeping', sleepCode: 'covered' })

    await h.service.decide(drift!.id, { status: 'approved' })
    expect(h.service.runnable(vi.id)?.id).toBe(drift!.id)
  })

  it('auto mode plans and runs the top proposal in the same night', async () => {
    const cy = await spawn({ name: 'Cy', autonomy: 'auto' })
    const night = await h.shift.run('timer')
    expect(night.summary.planned).toMatchObject([{ agentName: 'Cy', proposals: 2 }])
    expect(night.summary.executed).toMatchObject([{ agentName: 'Cy', kind: 'research-step' }])
    expect(h.calls.map((c) => c.profile)).toEqual(['query', 'research'])
    expect(h.service.get(cy.id)!.state).toBe('waiting')
    expect(pending(cy.id)).toHaveLength(1)
  })

  it('decisions: veto, undo, topic edit and reorder; an executed proposal refuses them; vetoes reach the planner', async () => {
    const ada = await spawn({})
    await h.shift.run('timer')
    const [p1, p2] = pending(ada.id)
    expect((await h.service.decide(p1!.id, { status: 'vetoed' })).proposal!.status).toBe('vetoed')
    expect(h.service.runnable(ada.id)?.id).toBe(p2!.id)
    expect((await h.service.decide(p1!.id, { status: 'proposed' })).proposal).toMatchObject({ status: 'proposed', decidedAt: null, decidedVia: null })
    const moved = await h.service.decide(p2!.id, { rank: 1, topic: 'Limb darkening, edited by hand' })
    expect(moved.proposal).toMatchObject({ rank: 1, topic: 'Limb darkening, edited by hand' })
    expect(pending(ada.id).map((p) => [p.id, p.rank])).toEqual([
      [p2!.id, 1],
      [p1!.id, 2],
    ])
    expect(h.service.runnable(ada.id)?.id).toBe(p2!.id)
    // Vetoing everything leaves the Fellow idle until the next plan.
    await h.service.decide(p1!.id, { status: 'vetoed' })
    await h.service.decide(p2!.id, { status: 'vetoed' })
    expect(h.service.get(ada.id)).toMatchObject({ state: 'sleeping', sleepCode: 'idle' })
    expect((await h.service.decide('nope', { status: 'vetoed' })).refusal?.status).toBe(404)

    h.clock.now = at(8, 1, 30)
    await h.shift.run('timer')
    const planPrompt = h.calls.filter((c) => c.profile === 'query').at(-1)!.prompt
    expect(planPrompt).toContain('vetoed these topics recently')
    expect(planPrompt).toContain('Limb darkening, edited by hand')
    const [fresh] = pending(ada.id)
    const run = h.service.execute(fresh!.id)
    expect(run.run).toBeDefined()
    await h.service.settled(run.run!.id)
    expect((await h.service.decide(fresh!.id, { status: 'vetoed' })).refusal).toMatchObject({ status: 409 })
    expect(h.service.execute(fresh!.id).refusal?.error).toContain('executed')
  })

  it('two runs without a knowledge page stall the Fellow; an ingest into its domain wakes it', async () => {
    h.committedPages = () => ['wiki/questions/Research: Q.md', 'wiki/meta/agents/dee.md', 'wiki/hot.md']
    const dee = await spawn({ name: 'Dee', quotaRunsPerDay: 3 })
    const first = h.service.step(dee.id, { topic: 'One' })
    await h.service.settled(first.run!.id)
    expect(h.service.get(dee.id)).toMatchObject({ state: 'sleeping', sleepCode: 'idle' })
    const second = h.service.step(dee.id, { topic: 'Two' })
    await h.service.settled(second.run!.id)
    expect(h.service.get(dee.id)).toMatchObject({ state: 'sleeping', sleepCode: 'stalled' })
    expect(h.service.runnable(dee.id)).toBeUndefined()

    const asleep = await h.shift.run('timer')
    expect(asleep.summary.planned).toEqual([])
    expect(asleep.summary.skipped.map((s) => s.reason)).toContain('sleeps (stalled) and nothing new arrived in its domains')

    h.candidates = () => [...CANDIDATES, { id: 'C3', kind: 'ingest', text: 'new-paper.pdf', sourcePages: ['wiki/sources/New Paper.md'], weight: 2 }]
    h.clock.now = at(8, 1, 30)
    const awake = await h.shift.run('timer')
    expect(awake.summary.planned).toMatchObject([{ agentName: 'Dee', proposals: 2 }])
    expect(h.service.get(dee.id)!.state).toBe('waiting')
  })

  it('no candidates means no planner cost; a planning run that keeps failing retries once, then sleeps as a fault', async () => {
    h.candidates = () => []
    const ada = await spawn({})
    const skipped = h.service.plan(ada.id)
    expect(skipped.skipped).toContain('no open questions and no candidates in astronomy')
    expect(h.service.get(ada.id)).toMatchObject({ state: 'sleeping', sleepCode: 'no-candidates' })
    expect(h.calls).toHaveLength(0)

    // Both attempts fail: one retry, then the Fellow sleeps marked as a fault, not as idle.
    h.candidates = () => CANDIDATES
    h.planAnswer = () => 'FAIL'
    const failed = h.service.plan(ada.id)
    await h.service.settled(failed.run!.id)
    expect(h.calls.filter((c) => c.profile === 'query')).toHaveLength(2)
    expect(h.calls.filter((c) => c.profile === 'query').at(-1)!.prompt).toContain('NOTE: Your previous answer in this cycle could not be used')
    expect(h.service.get(ada.id)).toMatchObject({ state: 'sleeping', sleepCode: 'plan-failed', sleepReason: expect.stringContaining('planner exploded') })
    expect(notebook(ada)).toContain('Nothing planned: the planning run failed')

    // The retry succeeds: the plan of the second attempt is the one that counts.
    let attempt = 0
    h.planAnswer = () => (++attempt === 1 ? { nonsense: true } : TWO_PROPOSALS)
    const recovered = h.service.plan(ada.id)
    await h.service.settled(recovered.run!.id)
    expect(h.service.get(ada.id)).toMatchObject({ state: 'waiting' })
    expect(h.service.pendingProposals(ada.id).length).toBeGreaterThan(0)

    h.planAnswer = () => NOTHING
    const nothing = h.service.plan(ada.id)
    await h.service.settled(nothing.run!.id)
    expect(h.service.get(ada.id)).toMatchObject({ state: 'sleeping', sleepCode: 'covered', sleepReason: 'the library answers the intent as far as it can' })
  })

  it('a publication the planner names reaches the reading list, the ones it could not open included', async () => {
    const ada = await spawn({})
    h.planAnswer = () => ({
      ...TWO_PROPOSALS,
      reading: [
        { title: 'The paper nobody could open', url: 'https://acs.invalid/x', ref: 'doi:10.1/x', domain: 'astronomy', why: 'The only per-cell figures.', access: 'paywalled', blocked: 'HTTP 403' },
        { title: 'An open preprint', url: 'https://arxiv.invalid/2', ref: '', domain: '', why: '', access: 'open', blocked: '' },
      ],
    })
    const planned = h.service.plan(ada.id)
    await h.service.settled(planned.run!.id)

    expect(h.reading.map((e) => e.title)).toEqual(['The paper nobody could open', 'An open preprint'])
    expect(h.reading[0]).toMatchObject({ access: 'paywalled', blocked: 'HTTP 403', by: 'Ada', domain: 'astronomy' })
    // No domain from the planner means the Fellow's own.
    expect(h.reading[1]).toMatchObject({ domain: 'astronomy', access: 'open', blocked: null })
  })

  it('a publication that arrived closes its entry: the Fellow is told and the planner sees it', async () => {
    const ada = await spawn({})
    h.readingFiled = [
      {
        entry: {
          title: 'The preprint Ada asked for',
          url: 'https://arxiv.invalid/1',
          ref: 'arXiv:2506.20907',
          domain: 'astronomy',
          why: 'The only per-facility scatter.',
          found: null,
          by: 'Ada',
          at: '2026-09-06',
          access: 'paywalled',
          blocked: 'HTTP 403',
          filed: 'wiki/sources/The Preprint.md',
          filedAt: '2026-09-08',
        },
        page: 'wiki/sources/The Preprint.md',
      },
    ]
    expect(await h.service.noteFiledReading('2026-09-08')).toBe(1)

    // The Fellow reads it in its own notebook, in its own words.
    const md = fs.readFileSync(path.join(h.vaultRoot, 'wiki/meta/agents/ada.md'), 'utf8')
    expect(md).toContain('The publication you asked for is in the vault: "The preprint Ada asked for" as wiki/sources/The Preprint.md')
    expect(md).toContain('you wanted it because: The only per-facility scatter.')
    expect(ada.name).toBe('Ada')
  })

  it('the gate refuses on the daily budget and the shift records a budget sleep; a timer shift respects the window', async () => {
    const ada = await spawn({})
    await h.shift.run('timer')
    h.gate = () => ({ code: 'budget', reason: 'the daily budget is reached (3 of 3 jobs)' })
    expect(h.service.step(ada.id).refusal).toMatchObject({ code: 'budget' })
    h.clock.now = at(8, 1, 30)
    const night = await h.shift.run('timer')
    expect(night.summary.executed).toEqual([])
    expect(h.service.get(ada.id)).toMatchObject({ state: 'sleeping', sleepCode: 'budget' })
    // Planning is not a step: it still runs behind the budget gate? No: the gate blocks every run.
    expect(night.summary.planned).toEqual([])

    h.gate = () => null
    h.clock.now = at(9, 5, 55)
    const late = await h.shift.run('timer')
    expect(late.summary.skipped.map((s) => s.reason)).toContain('the window has no room left for a research-step')
    expect(late.summary.executed).toEqual([])
    expect(h.shift.status()).toMatchObject({ inWindow: true, cycleDate: '2026-09-09', running: false })
    expect(h.shift.status().nextStartsAt).toBe(at(10, 1).toISOString())
  })

  it('a plan refusal puts the Fellow to sleep with the plan code; the shift waits for a 5-hour reset inside the window and tries again', async () => {
    const ada = await spawn({})
    await h.shift.run('timer')
    h.clock.now = at(8, 1, 30)
    // The 5-hour window resets at 02:00: worth waiting for (D5).
    const resetsAt = at(8, 2, 0).toISOString()
    h.gate = () => (h.clock.now.getTime() < at(8, 2, 0).getTime() ? { code: 'reserve', reason: 'the 5-hour window is at 70%, above the 60% reserve', resetsAt } : null)
    const night = await h.shift.run('timer')
    expect(h.sleeps).toEqual([30 * 60_000 + 30_000])
    expect(night.summary.executed).toMatchObject([{ agentName: 'Ada', kind: 'research-step', ok: true }])
    expect(night.summary.skipped.map((s) => s.reason)).toContain('the 5-hour window is at 70%, above the 60% reserve')
    expect(h.service.get(ada.id)).toMatchObject({ state: 'waiting' })

    // A reset beyond the window (or none) is not waited for: the Fellow sleeps with the plan code.
    h.clock.now = at(9, 1, 30)
    h.gate = () => ({ code: 'share', reason: 'the research share of the week is used up (9 of 10 points, this step about 3)', resetsAt: at(12, 0, 0).toISOString() })
    const blocked = await h.shift.run('timer')
    expect(h.sleeps).toHaveLength(1)
    expect(blocked.summary.executed).toEqual([])
    expect(h.service.get(ada.id)).toMatchObject({ state: 'sleeping', sleepCode: 'plan', sleepReason: expect.stringContaining('wakes when the window resets') })
    // The plan gate holds planning runs as well: they spend plan points too.
    expect(blocked.summary.planned).toEqual([])
    expect(blocked.summary.skipped.map((s) => s.reason)).toContain('the research share of the week is used up (9 of 10 points, this step about 3)')
  })

  it('an intent edit through the API wins over the page and wakes a sleeping Fellow; retire expires proposals', async () => {
    const ada = await spawn({})
    await h.shift.run('timer')
    const [p1] = pending(ada.id)
    await h.service.decide(p1!.id, { status: 'vetoed' })
    h.agents.update(ada.id, { state: 'sleeping', sleepCode: 'covered', sleepReason: 'covered' })
    const updated = await h.service.update(ada.id, { intent: 'A new intent typed in the dashboard' })
    expect(updated).toMatchObject({ intent: 'A new intent typed in the dashboard', sleepCode: 'idle' })
    expect(notebook(ada)).toContain('## Intent\n\nA new intent typed in the dashboard')
    await h.service.retire(ada.id)
    expect(pending(ada.id)).toEqual([])
    expect(h.service.getProposal(p1!.id)!.status).toBe('vetoed')
  })
})

describe('proposal and shift routes', () => {
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
    app = await buildServer({ config, store, chat: new ChatStore(h.db), queue, events: h.events, maintenance: h.runner, logger: false, commitMutex: h.commitMutex, agentRuns: h.runs, fellows: h.service, shift: h.shift })
  })
  afterEach(async () => {
    await app.close()
    h.db.close()
    fs.rmSync(h.vaultRoot, { recursive: true, force: true })
  })

  it('plans, lists and decides proposals, and runs the shift by hand', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false } })
    const { agent } = created.json() as { agent: AgentRecord }

    const list = await app.inject({ method: 'GET', url: '/api/v1/agents' })
    expect((list.json() as { shift: { window: { start: string } } }).shift.window.start).toBe('01:00')

    const planned = await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/plan` })
    expect(planned.statusCode).toBe(202)
    const planRun = (planned.json() as { run: { id: string; kind: string } }).run
    expect(planRun.kind).toBe('plan')
    expect((await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/plan` })).statusCode).toBe(409)
    await h.service.settled(planRun.id)

    const proposals = await app.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}/proposals` })
    const body = proposals.json() as { proposals: ProposalRecord[]; next: ProposalRecord | null }
    expect(body.proposals).toHaveLength(2)
    expect(body.next?.rank).toBe(1)

    const bad = await app.inject({ method: 'POST', url: `/api/v1/proposals/${body.proposals[0]!.id}/decide`, payload: { status: 'maybe' } })
    expect(bad.statusCode).toBe(400)
    const vetoed = await app.inject({ method: 'POST', url: `/api/v1/proposals/${body.proposals[0]!.id}/decide`, payload: { status: 'vetoed', note: 'not now' } })
    expect(vetoed.statusCode).toBe(200)
    expect((vetoed.json() as { proposal: ProposalRecord }).proposal).toMatchObject({ status: 'vetoed', userNote: 'not now', decidedVia: 'dashboard' })
    expect((await app.inject({ method: 'POST', url: '/api/v1/proposals/nope/decide', payload: { status: 'approved' } })).statusCode).toBe(404)

    const status = await app.inject({ method: 'GET', url: '/api/v1/agents/shift' })
    expect(status.statusCode).toBe(200)
    expect((status.json() as { last: unknown }).last).toBeNull()
    const started = await app.inject({ method: 'POST', url: '/api/v1/agents/shift' })
    expect(started.statusCode).toBe(202)
    for (let i = 0; i < 400 && h.shift.isRunning; i++) await new Promise((r) => setTimeout(r, 5))
    expect(h.shift.isRunning).toBe(false)
    const after = (await app.inject({ method: 'GET', url: '/api/v1/agents/shift' })).json() as { last: { trigger: string; summary: { executed: unknown[] } } }
    expect(after.last.trigger).toBe('manual')
    expect(after.last.summary.executed).toHaveLength(1)

    const card = (await app.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}/card` })).json() as { proposals: ProposalRecord[]; spend: { runsToday: number } }
    expect(card.proposals.length).toBeGreaterThanOrEqual(3)
    expect(card.spend.runsToday).toBeGreaterThanOrEqual(2)

    const next = (await app.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}/proposals` })).json() as { next: ProposalRecord | null }
    const run = await app.inject({ method: 'POST', url: `/api/v1/proposals/${next.next!.id}/run` })
    expect(run.statusCode).toBe(409)
    const refused = run.json() as { error: string; code: string }
    expect(refused.error).toContain("used today's quota")
    // The code travels with the refusal: the card needs to tell an overridable quota from a
    // share or a reserve, which it may not override.
    expect(refused.code).toBe('quota')

    // A deliberate manual start passes the quota, by the proposal route and by the step route.
    const anyway = await app.inject({ method: 'POST', url: `/api/v1/proposals/${next.next!.id}/run`, payload: { override: true } })
    expect(anyway.statusCode).toBe(202)
    await h.service.settled((anyway.json() as { run: { id: string } }).run.id)
    const stepAnyway = await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/step`, payload: { override: true } })
    expect(stepAnyway.statusCode).toBe(202)
    await h.service.settled((stepAnyway.json() as { run: { id: string } }).run.id)

    // What the override never passes: the gate that protects the user's own capacity.
    h.gate = () => ({ code: 'reserve', reason: 'the weekly reserve is reached' })
    const hard = await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/step`, payload: { override: true } })
    expect(hard.statusCode).toBe(409)
    expect((hard.json() as { code: string }).code).toBe('reserve')
  })
})
