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
import { taskForTonight, FellowService, type GateBlock } from '../src/pipeline/fellows.js'
import { NightShift, topicOverlap, coveredTonight } from '../src/pipeline/shift.js'
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
import type { AgentTask } from '../src/db/agents.js'
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
  judgeScore: (a: string, b: string) => number
  judgeCalls: Array<Array<[string, string]>>
  committedPages: () => string[]
  researchOk: () => boolean
  gate: () => GateBlock | null
  /** The shift's injected waits (A5 D5): each advances the clock instead of sleeping. */
  sleeps: number[]
  /** The 4th argument is the task the planning run is for; tests assert on it. */
  candidates: (agent?: AgentRecord, runs?: unknown, since?: string | null, task?: AgentTask) => Candidate[]
  /** Reading list entries the service wrote for the planner. */
  reading: ReadingEntry[]
  /** What the reconcile pass reports as newly arrived in the vault. */
  readingFiled: Array<{ entry: ReadingEntry; page: string }>
  /** Job ids held for the night; the fake queue releases them at phase 0. */
  held: string[]
  /** The order phase 0 ran in: `release:<n>` then `drained@<agent runs so far>`. */
  order: string[]
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
    planSettings: { researchShareWeekPct: 10, researchShare5hPct: 15, reserve5hPct: 60, reserveWeekPct: 80, planWeekUsd: 1000, plan5hUsd: 80, planName: '', fiveHourOverrideEnabled: false, weekOverrideEnabled: false },
  }
  h.planAnswer = () => TWO_PROPOSALS
  // No opinion unless a test gives one; NaN is "did not answer", never "not a duplicate".
  h.judgeScore = () => Number.NaN
  h.judgeCalls = []
  h.committedPages = () => ['wiki/questions/Research: Q.md', 'wiki/concepts/New Concept.md']
  h.researchOk = () => true
  h.gate = () => null
  h.candidates = () => CANDIDATES
  h.reading = []
  h.readingFiled = []
  h.held = []
  h.order = []
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
      entries: () => h.reading!.map((e) => ({ ...e, page: e.filed, held: e.filed !== null })),
    },
    now,
    candidates: (agent, runs, since, task) => h.candidates!(agent, runs, since, task),
    gate: (ctx) => h.gate!() ?? (usage ? usage.gate(ctx) : null),
    ...(usage ? { estimatePct: (cost: number, model: string) => usage.estimatePct(cost, model) } : {}),
  })
  const shifts = new SqliteShiftStore(db)
  const shift = new NightShift({
    fellows: service,
    shifts,
    window: () => ({ start: '01:00', end: '06:00' }),
    now,
    // The fake queue: phase 0 releases what is held and waits; the test reads the order.
    ingests: {
      release: () => {
        const ids = h.held!.splice(0)
        h.order!.push(`release:${ids.length}`)
        return ids
      },
      onIdle: async () => {
        h.order!.push(`drained@${h.calls!.length}`)
      },
      statusOf: () => 'done',
    },
    sleep: async (ms) => {
      h.sleeps!.push(ms)
      h.clock!.now = new Date(h.clock!.now.getTime() + ms)
    },
    // Never a real run: the judge is a function under test, not an agent to spawn. Silent by
    // default, so every existing test measures the lexical passes exactly as before.
    judge: async (pairs) => {
      h.judgeCalls!.push(pairs.map((p) => [p.a, p.b]))
      return pairs.map((p) => ({ score: h.judgeScore!(p.a, p.b), reason: 'because' }))
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
    // Three runs at 0.50 USD each, 2 and 1 points apiece: 6 points of five-hour and 3 of week
    // over 1.50 USD, which is the rate - and `points` says how much signal is behind it.
    expect(h.usage!.calibration()).toEqual({
      perModel: { 'sonnet-5': { fiveHour: 4, sevenDay: 2, n: 3, points: { fiveHour: 6, sevenDay: 3 } } },
      // Nothing else ran here, so the plan-wide rate is the same three runs.
      overall: { fiveHour: 4, sevenDay: 2, n: 3, points: { fiveHour: 6, sevenDay: 3 } },
      ready: true,
    })
    expect(h.service.card(ada.id)!.spend).toMatchObject({ runsWeek: 3, weekUsd: 1.5, weekPct: 3 })

    /*
     * A planning run prices its proposals in points, and prices the RUN from the runs already
     * settled (2026-09-15): three research-steps at 0.50 USD are three samples of what a step
     * of this kind on this model costs here, so a proposal is priced at 0.50 rather than at
     * the 2.00 reference the vault started with.
     *
     * The planning run itself is measured too, and joins the calibration before the proposals
     * are priced: 4 points of week over 1.90 USD rather than 3 over 1.50, so the rate is 2.105
     * and a 0.50 USD step is 1.05 points. Summing both sides is what makes a fourth
     * measurement move the rate at all.
     */
    const planned = h.service.plan(ada.id)
    await h.service.settled(planned.run!.id)
    expect(h.service.pendingProposals(ada.id).map((p) => [p.estCostUsd, p.estPlanPct])).toEqual([[0.5, 1.05], [0.5, 1.05]])

    // The share holds 10 points; 4 consumed (the planning run took one too) plus one fits.
    const fits = h.service.step(ada.id, { topic: 'fits' })
    expect(fits.refusal).toBeUndefined()
    await h.service.settled(fits.run!.id)
    expect(h.usage!.consumption()).toMatchObject({ weekPct: 5, weekRuns: 5 })
    // A share of 6 has no room for another 4-point step.
    h.planSettings = { ...h.planSettings, researchShareWeekPct: 6 }
    const refused = h.service.step(ada.id, { topic: 'no room' }).refusal
    // 1.04 and not 1.05: another measured run has joined the calibration since.
    expect(refused).toMatchObject({ code: 'share', error: 'the research share of the week is used up (5 of 6 points, this step about 1.04)' })
    expect(h.usage!.status({ estCostUsd: 2, model: 'sonnet-5' }).shares).toEqual({ unit: 'points', week: 6, fiveHour: 60, weekUsed: 5, fiveHourUsed: 10, stepsLeftWeek: 0 })
  })
})

describe('coveredTonight: the second dedupe, against what already ran', () => {
  const ran = (over: Partial<{ agentId: string; agentName: string; topic: string; ok: boolean }> = {}) => ({
    agentId: 'A',
    agentName: 'Cy',
    topic: 'Limb darkening models in transit photometry of exoplanet atmospheres',
    ok: true,
    ...over,
  })
  const near = 'Limb darkening models in the transit photometry of exoplanet atmospheres'

  it('supersedes an undecided topic another Fellow already ran tonight', () => {
    const hit = coveredTonight({ topic: near, status: 'proposed' }, 'B', [ran()])
    expect(hit).not.toBeNull()
    expect(hit!.hold).toBe(false)
    expect(hit!.run.agentName).toBe('Cy')
    expect(hit!.score).toBeGreaterThanOrEqual(topicOverlap(ran().topic, near))
  })

  it('HOLDS an approved one instead: the run is not spent, the decision still stands', () => {
    const hit = coveredTonight({ topic: near, status: 'approved' }, 'B', [ran()])
    expect(hit).not.toBeNull()
    expect(hit!.hold).toBe(true)
  })

  it('leaves a Fellow its own beat, and ignores a run that failed or a topic that differs', () => {
    // Same Fellow: the pre-shift rule already decided that its own list is its own business.
    expect(coveredTonight({ topic: near, status: 'proposed' }, 'A', [ran()])).toBeNull()
    // A failed run covered nothing.
    expect(coveredTonight({ topic: near, status: 'proposed' }, 'B', [ran({ ok: false })])).toBeNull()
    // A different subject is a different subject.
    expect(coveredTonight({ topic: 'Sourdough starter hydration ratios', status: 'proposed' }, 'B', [ran()])).toBeNull()
    expect(coveredTonight({ topic: near, status: 'proposed' }, 'B', [])).toBeNull()
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

  /*
   * What a machine going down mid-round leaves behind (2026-09-09, from a real one at 01:00).
   *
   * `active` and an open shift row are memory facts written to disk halfway: the row says a
   * run is in flight, and the thing that would have written the end of it - the settle
   * subscription - died with the process. Nothing used to put them right, and the cost was
   * silent, because the shift skips an `active` Fellow in BOTH phases. A Fellow could be
   * taken out of service for good by one interrupted night.
   */
  describe('after a restart interrupted a round', () => {
    it('frees a Fellow left active and closes the open round, before the first tick', async () => {
      const ada = await spawn()
      h.agents.update(ada.id, { state: 'active', sleepReason: null, sleepCode: null }, h.clock.now.toISOString())
      h.shifts.put({
        cycleDate: '2026-09-09',
        trigger: 'timer',
        startedAt: h.clock.now.toISOString(),
        finishedAt: null,
        summary: { executed: [], planned: [], skipped: [], costUsd: 0 },
      })

      h.shift.reconcileInterrupted()

      const freed = h.agents.get(ada.id)!
      expect(freed.state).toBe('sleeping')
      expect(freed.sleepReason).toContain('interrupted by a restart')
      const round = h.shifts.get('2026-09-09')!
      expect(round.finishedAt).not.toBeNull()
      // Marked, not merely closed: an empty summary alone would read as a round that ran and
      // found nothing to do.
      expect(round.summary.interrupted).toBe(true)
    })

    it('leaves a settled round and a sleeping Fellow alone', async () => {
      const ada = await spawn()
      h.shifts.put({
        cycleDate: '2026-09-08',
        trigger: 'timer',
        startedAt: h.clock.now.toISOString(),
        finishedAt: h.clock.now.toISOString(),
        summary: { executed: [], planned: [], skipped: [], costUsd: 0 },
      })
      const before = h.agents.get(ada.id)!

      h.shift.reconcileInterrupted()

      expect(h.agents.get(ada.id)!.updatedAt).toBe(before.updatedAt)
      expect(h.shifts.get('2026-09-08')!.summary.interrupted).toBeUndefined()
    })

    it('resume gets a stuck Fellow out too, without the detour through pause', async () => {
      // The reconciliation runs at startup; this is the escape hatch for a state the user is
      // looking at right now. `resume` used to answer only to `paused` and `blocked`.
      const ada = await spawn()
      h.agents.update(ada.id, { state: 'active', sleepReason: null, sleepCode: null }, h.clock.now.toISOString())
      const back = await h.service.resume(ada.id)
      expect(back?.state).toBe('sleeping')
    })
  })

  /**
   * The task rotation (docs/agents/ideas.md, decision 2026-09-07). The unit tests pin the
   * arithmetic; this pins the thing that actually matters - that a different task reaches the
   * prompt each night, and that one answered task does not stop the Fellow.
   */
  it('runs the ingests held for tonight before any Fellow works, and records them', async () => {
    /*
     * Phase 0 (docs/tasks/TASKS-SWEEP-2026-09.md, chunk 6): what the user queued for the
     * night is released to the ordinary queue and run to the end before planning starts, so
     * the Fellows work on a vault that already holds it. A night with nothing held records
     * nothing about ingests.
     */
    await spawn()
    h.held = ['j1', 'j2']
    await h.shift.run('timer')
    expect(h.order).toEqual(['release:2', 'drained@0'])
    expect(h.calls.length).toBeGreaterThan(0)
    expect(h.shifts.list(1)[0]!.summary.ingests).toEqual({ released: 2, done: 2 })

    h.clock!.now = new Date('2026-09-08T01:10:00.000Z')
    await h.shift.run('timer')
    expect(h.order).toEqual(['release:2', 'drained@0', 'release:0'])
    expect(h.shifts.list(1)[0]!.summary.ingests).toBeUndefined()
  })

  it('takes its tasks in turn: a different one reaches the planner each night, and only that one', async () => {
    // `rotate` is the one-a-night mode; `sweep` (the default since A7 D8) is tested below.
    const ada = await spawn({
      nightly: 'rotate',
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

  /*
   * The full sweep (A7 D8). A night that plans one of three tasks leaves the other two a
   * third of a week apart, which is why "every night delivers a result" needed one planning
   * run PER task rather than one merged run: the schema constrains kind, candidate and the
   * deepen page set per task, and merging them would widen `kind` to the union (A7 section 1).
   */
  it('a sweeping Fellow plans every standing task in one night, each in its own run', async () => {
    const ada = await spawn({
      tasks: [
        { text: 'new ground-based transit surveys and their first results', kind: 'watch' },
        { text: 'How far can photometry constrain atmospheric retrievals?', kind: 'explore' },
      ],
    })
    expect(h.service.get(ada.id)!.nightly).toBe('sweep')

    await h.shift.run('timer')
    const plans = h.calls.filter((c) => c.profile === 'query').map((c) => c.prompt)
    expect(plans).toHaveLength(2)
    expect(plans[0]).toContain("Tonight's task (1 of 2): new ground-based transit surveys")
    expect(plans[1]).toContain("Tonight's task (2 of 2): How far can photometry")
    // Each run is still told about ONE task, so the schema's per-task constraints hold.
    expect(plans[0]).toContain('a watch task')
    expect(plans[1]).toContain('an explore task')
    // A sweep walks the whole list, so there is no turn to keep and the cursor stays put.
    expect(h.service.get(ada.id)!.taskCursor).toBe(0)
  })

  it('keeps every swept task\'s proposals, not only the last run\'s', async () => {
    /*
     * Each planning run supersedes what is still undecided, which is right for a NIGHT and
     * wrong inside one: a sweep plans task after task, so a whole-Fellow supersede lets the
     * last run wipe every earlier task's fresh proposals and the sweep plans three times to
     * end with one task's worth of work.
     */
    const ada = await spawn({
      tasks: [
        { text: 'new ground-based transit surveys and their first results', kind: 'watch' },
        { text: 'How far can photometry constrain atmospheric retrievals?', kind: 'explore' },
      ],
    })
    await h.shift.run('timer')
    const tasks = pending(ada.id).map((p) => p.provenance.task)
    expect(new Set(tasks).size).toBe(2)
  })

  it('a sweeping Fellow with one task plans once, like a rotating one', async () => {
    await spawn({ tasks: [{ text: 'the only task', kind: 'watch' }] })
    await h.shift.run('timer')
    expect(h.calls.filter((c) => c.profile === 'query')).toHaveLength(1)
  })

  it('counts the spawn run as the first task\'s turn, so the first night plans the SECOND task', async () => {
    const ada = await spawn({
      nightly: 'rotate',
      runFirstStep: true,
      tasks: [
        { text: 'the first task', kind: 'explore' },
        { text: 'the second task', kind: 'explore' },
      ],
    })
    // The spawn run is a research run on task 1, not a planning run - the rotation used to
    // advance only when the planner started, which gave task 1 a run AND the first plan.
    expect(h.service.get(ada.id)!.taskCursor).toBe(1)
    // Which is what the next planning run reads: from here the rotation puts task 2 up.
    expect(taskForTonight(h.service.get(ada.id)!.tasks, h.service.get(ada.id)!.taskCursor)).toMatchObject({ index: 1 })
    await h.service.flush()
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
    expect(h.service.card(ada.id)!.quota).toEqual({ runsPerDay: 1, used: 0 })

    // The same night again: the row exists, the timer does nothing.
    expect(await h.shift.tick()).toBeNull()

    // Night 2: the top undecided proposal runs; the second round hits the quota; a new plan follows.
    h.clock.now = at(8, 1, 30)
    const night2 = (await h.shift.tick())!
    expect(night2.cycleDate).toBe('2026-09-08')
    expect(night2.summary.executed).toMatchObject([{ agentName: 'Ada', proposalId: p1!.id, kind: 'research-step', topic: p1!.topic, ok: true, pages: 2, costUsd: 0.5 }])
    expect(night2.summary.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining([expect.stringContaining("used tonight's quota (1 of 1 runs)")]))
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

  /*
   * The gap the pre-shift dedupe cannot see. It reads the proposals as they stand at 01:00;
   * phase 2's planning runs then CREATE proposals, and phase 3 executes them - so two auto
   * Fellows that plan the same topic tonight both spend a run on it, an hour apart, with the
   * first one's pages already in the vault when the second starts.
   */
  it('a topic another Fellow already ran tonight does not run twice', async () => {
    await spawn({ name: 'Cy', autonomy: 'auto' })
    const di = await spawn({ name: 'Di', autonomy: 'auto' })
    const night = await h.shift.run('timer')

    /*
     * One run over the same TOPIC, which is the invariant - not one run in the night. Phase 3
     * runs in rounds since the sweep landed, so Di, whose top proposal was covered, comes
     * round again and spends its night on the one that is not a duplicate.
     */
    const topics = night.summary.executed.map((e) => e.topic)
    expect(new Set(topics).size).toBe(topics.length)
    expect(night.summary.executed[0]).toMatchObject({ agentName: 'Cy' })
    expect(night.summary.merged).toContainEqual(expect.objectContaining({ keptAgentName: 'Cy', droppedAgentName: 'Di' }))
    const dropped = h.service.pendingProposals(di.id)
    expect(dropped.every((p) => p.topic !== night.summary.executed[0]!.topic)).toBe(true)
  })

  /*
   * Stage 1 end to end: the second Fellow to plan tonight is told what the first one claimed.
   * The mechanical dedupe underneath compares strings and cannot see a paraphrase; this is the
   * same question put to the only judge in the loop that reads for meaning.
   */
  it('the planner is told what the other Fellows already claimed tonight', async () => {
    await spawn({ name: 'Cy', autonomy: 'auto' })
    await spawn({ name: 'Di', autonomy: 'auto' })
    await h.shift.run('timer')

    const planPrompts = h.calls.filter((c) => c.profile === 'query' && c.prompt.includes('Candidates ('))
    expect(planPrompts.length).toBeGreaterThanOrEqual(2)
    // The first Fellow to plan had nothing to be told about; the last one did.
    expect(planPrompts[0]!.prompt).not.toContain('already claimed elsewhere')
    const last = planPrompts[planPrompts.length - 1]!.prompt
    expect(last).toContain('already claimed elsewhere')
    expect(last).toContain('Limb darkening models in transit photometry')
    // A Fellow is never shown its own work back: that is its own beat, not a duplicate.
    expect(last).not.toContain('by Di:')
  })

  /*
   * The graded action (section 6.6). The judge is the only measured mechanism that separates a
   * real duplicate from the narrow follow-ups this vault produces, and it is still a model's
   * opinion - so what it may do is bounded by how sure it is, and by whether the user has
   * already decided.
   */
  it('merges only what the judge is sure of, and only an undecided proposal', async () => {
    await spawn({ name: 'Cy', autonomy: 'manual' })
    const di = await spawn({ name: 'Di', autonomy: 'manual' })
    // Above JUDGE_MERGE for every cross-Fellow pair: the words say nothing, the judge is certain.
    h.judgeScore = () => 0.9
    const night = await h.shift.run('timer')

    const merged = night.summary.merged ?? []
    expect(merged.length).toBeGreaterThan(0)
    expect(merged[0]).toMatchObject({ by: 'judge', keptAgentName: 'Cy', droppedAgentName: 'Di', reason: 'because' })
    // The later Fellow loses its copy; the earlier one keeps its work.
    expect(h.service.pendingProposals(di.id)).toHaveLength(0)
    expect(h.service.pendingProposals(h.service.list()[0]!.agent.id).length).toBeGreaterThan(0)
  })

  it('only NOTES what the judge hedges over: the run still happens', async () => {
    await spawn({ name: 'Cy', autonomy: 'manual' })
    const di = await spawn({ name: 'Di', autonomy: 'manual' })
    // Between the note bar and the merge bar - a hedge costs a line, never a run.
    h.judgeScore = () => 0.3
    const night = await h.shift.run('timer')

    const merged = night.summary.merged ?? []
    expect(merged.length).toBeGreaterThan(0)
    expect(merged.every((m) => m.noted === true)).toBe(true)
    // Nothing was superseded: both Fellows keep everything they proposed.
    expect(h.service.pendingProposals(di.id).length).toBeGreaterThan(0)
  })

  it('says nothing at all below the note bar', async () => {
    await spawn({ name: 'Cy', autonomy: 'manual' })
    await spawn({ name: 'Di', autonomy: 'manual' })
    h.judgeScore = () => 0.1
    const night = await h.shift.run('timer')
    expect((night.summary.merged ?? []).filter((m) => m.by === 'judge')).toEqual([])
    // It was asked, though: a band gated on word overlap would have skipped exactly the pairs
    // the judge exists for, because a real paraphrase scores near zero against its own twin.
    expect(h.judgeCalls.length).toBeGreaterThan(0)
  })

  it('never overturns the user: an approved topic is held, not merged', async () => {
    const cy = await spawn({ name: 'Cy', autonomy: 'manual' })
    const di = await spawn({ name: 'Di', autonomy: 'manual' })
    h.judgeScore = () => Number.NaN
    await h.shift.run('timer')
    // Both Fellows get an approved topic, so both run in the same phase, Cy first.
    const cyFirst = h.service.pendingProposals(cy.id)[0]!
    const diFirst = h.service.pendingProposals(di.id)[0]!
    await h.service.decide(cyFirst.id, { status: 'approved' })
    await h.service.decide(diFirst.id, { status: 'approved' })

    // Certain that Di's topic is the question Cy's run just answered.
    h.judgeScore = () => 0.95
    h.clock.now = at(8, 1, 30)
    const night = await h.shift.run('timer')

    expect(night.summary.executed.map((e) => e.agentName)).toEqual(['Cy'])
    // Held, not merged: the user decided this topic and a model's opinion does not undo that.
    expect(h.service.getProposal(diFirst.id)!.status).toBe('approved')
    expect(night.summary.skipped.find((x) => x.agentName === 'Di')!.reason).toContain('keeps its place')
    // Recorded as a judgement rather than as a mechanical fact.
    expect((night.summary.merged ?? []).some((m) => m.by === 'judge' && m.noted === true)).toBe(true)
  })

  it('a judge that fails leaves the lexical passes standing', async () => {
    await spawn({ name: 'Cy', autonomy: 'auto' })
    await spawn({ name: 'Di', autonomy: 'auto' })
    h.judgeScore = () => {
      throw new Error('the judge run failed')
    }
    const night = await h.shift.run('timer')
    // The lexical dedupe from earlier tonight still did its work, and the shift finished.
    const topics = night.summary.executed.map((e) => e.topic)
    expect(new Set(topics).size).toBe(topics.length)
    expect(night.finishedAt).not.toBeNull()
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

  it('auto mode plans and runs in the same night, until its quota says stop', async () => {
    const cy = await spawn({ name: 'Cy', autonomy: 'auto' })
    const night = await h.shift.run('timer')
    expect(night.summary.planned).toMatchObject([{ agentName: 'Cy', proposals: 2 }])
    expect(night.summary.executed).toMatchObject([{ agentName: 'Cy', kind: 'research-step' }])
    expect(h.calls.map((c) => c.profile)).toEqual(['query', 'research'])
    /*
     * Phase 3 runs in rounds now, so the quota is what ends the night rather than the shape of
     * the loop - and a Fellow that has spent it says so, the same as one stopped in phase 1.
     * One task means a quota of one, so one run and then the reason.
     */
    expect(h.service.get(cy.id)).toMatchObject({ state: 'sleeping', sleepCode: 'quota' })
    expect(pending(cy.id)).toHaveLength(1)
  })

  it('plans each task against ITS OWN candidates, not the first task\'s', async () => {
    /*
     * The standing sweep candidate IS the task's text, and for a watch task it is the only
     * candidate that task can stand on by itself. The list used to be built from the ROTATION
     * - and a sweep leaves the cursor alone - so every run of a sweeping Fellow was handed the
     * first task's sweep and told not to propose against the first task. Tasks two and three
     * were offered nothing they were allowed to use.
     */
    await spawn({
      name: 'Cy',
      autonomy: 'auto',
      quotaRunsPerDay: 3,
      tasks: [
        { text: 'What is new in transit photometry?', kind: 'watch' },
        { text: 'What is new in adaptive optics?', kind: 'watch' },
      ],
    })
    // Which task each planning run asked its candidates for.
    const asked: Array<string | undefined> = []
    h.candidates = (_agent, _runs, _since, task) => {
      asked.push(task?.text)
      return CANDIDATES
    }
    h.planAnswer = () => ({ proposals: [], handoffs: [], reading: [], nothing_worth_a_run: true, intent_covered: false, reason: 'noted' })
    await h.shift.run('timer')
    expect(asked).toEqual(['What is new in transit photometry?', 'What is new in adaptive optics?'])
  })

  it('an auto Fellow that sweeps runs every task it planned, one run each', async () => {
    /*
     * The gap the sweep left. Phase 1 skips auto Fellows on purpose - their proposals do not
     * exist when it runs - and phase 3 called `executeOne` once, so a Fellow planned three
     * tasks and ran one of them whatever its runs-per-day allowed.
     */
    const cy = await spawn({
      name: 'Cy',
      autonomy: 'auto',
      quotaRunsPerDay: 3,
      tasks: [
        { text: 'What is new in transit photometry?', kind: 'watch' },
        { text: 'How far can ground-based systematics be bounded?', kind: 'explore' },
        { text: 'What is new in adaptive optics?', kind: 'watch' },
      ],
    })
    /*
     * A topic per planning run. The shared fixture answers every run alike, and three tasks
     * proposing the same topic are deduped into one - which would hide exactly what this
     * test is about.
     */
    const TASKS = [
      'What is new in transit photometry?',
      'How far can ground-based systematics be bounded?',
      'What is new in adaptive optics?',
    ]
    let planned = 0
    h.planAnswer = () => {
      // Echo the task the run is for: the scope score is measured against it, and in auto mode
      // a drifting proposal is dropped rather than run.
      const task = TASKS[planned % TASKS.length]!
      planned += 1
      return {
        proposals: [
          { candidate: 'C1', kind: 'research-step', topic: `${task} First option`, rationale: task, lens: 'broad' },
          { candidate: 'C2', kind: 'research-step', topic: `${task} Second option`, rationale: task, lens: 'broad' },
        ],
        nothing_worth_a_run: false,
        intent_covered: false,
        reason: '',
      }
    }
    const night = await h.shift.run('timer')
    expect(night.summary.planned).toHaveLength(3)
    expect(night.summary.executed).toHaveLength(3)
    // One run per task, not three runs of the task that happened to plan first.
    const tasks = night.summary.executed.map((e) => h.service.getProposal(e.proposalId!)?.provenance.task)
    expect(new Set(tasks).size).toBe(3)
    expect(h.service.get(cy.id)).toMatchObject({ sleepCode: 'quota' })
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

  it('a publication that arrived for a retired Fellow is marked, and its notebook stays closed', async () => {
    const ada = await spawn({})
    await h.service.retire(ada.id)
    const before = fs.readFileSync(path.join(h.vaultRoot, ada.notebookPath), 'utf8')
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
          archivedAt: null,
          oa: null,
        },
        page: 'wiki/sources/The Preprint.md',
      },
    ]
    expect(await h.service.noteFiledReading('2026-09-08')).toBe(1)
    expect(fs.readFileSync(path.join(h.vaultRoot, ada.notebookPath), 'utf8')).toBe(before)
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
          archivedAt: null,
          oa: null,
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

  /**
   * The mark on the reading-list entry is what normally stops a second telling, and it lives
   * in a vault page a human can edit. One stale save took four marks with it on 2026-09-14,
   * and two nights later a Fellow was told the same thing again - so the note has to be
   * idempotent on its own, keyed on the page rather than on the sentence around it (the Notes
   * section is the user's to reword).
   */
  it('tells a Fellow about a publication once, however often its entry is marked', async () => {
    const ada = await spawn({})
    const entry: ReadingEntry = {
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
      archivedAt: null,
      oa: null,
    }
    h.readingFiled = [{ entry, page: 'wiki/sources/The Preprint.md' }]
    expect(await h.service.noteFiledReading('2026-09-08')).toBe(1)
    const notebook = path.join(h.vaultRoot, ada.notebookPath)
    const once = fs.readFileSync(notebook, 'utf8')
    expect(once.split('The publication you asked for').length - 1).toBe(1)

    // The mark was lost and the entry marked again: same publication, same page, and the
    // `why` reworded on the way, which is exactly what a full-text match would miss.
    h.readingFiled = [{ entry: { ...entry, why: 'Reworded since.', filedAt: '2026-09-10' }, page: 'wiki/sources/The Preprint.md' }]
    expect(await h.service.noteFiledReading('2026-09-10')).toBe(1)
    const twice = fs.readFileSync(notebook, 'utf8')
    expect(twice.split('The publication you asked for').length - 1).toBe(1)
    expect(twice).not.toContain('Reworded since.')

    // A different publication is a different note; the key narrows, it does not mute.
    h.readingFiled = [{ entry: { ...entry, title: 'Another one', why: 'Other reason.' }, page: 'wiki/sources/Another One.md' }]
    expect(await h.service.noteFiledReading('2026-09-11')).toBe(1)
    expect(fs.readFileSync(notebook, 'utf8').split('The publication you asked for').length - 1).toBe(2)
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
    expect(updated.agent).toMatchObject({ intent: 'A new intent typed in the dashboard', sleepCode: 'idle' })
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
    expect(refused.error).toContain("used tonight's quota")
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
