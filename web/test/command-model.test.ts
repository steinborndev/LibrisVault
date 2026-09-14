/**
 * The command centre's arithmetic (lib/command/model.ts).
 *
 * Every number the window shows is derived rather than fetched, and a derived number that is
 * merely plausible is the worst kind: it reads as fact. These are the derivations that decide
 * whether the night is drawn honestly.
 */

import { describe, it, expect } from 'vitest'
import {
  artOf,
  runsTonight,
  isSystemPage,
  fellowMinutes,
  minutesFor,
  runMinutes,
  nightBlock,
  nightRoom,
  scheduleFrom,
  shelfOrder,
  shelvesFrom,
  runCount,
  plannedOnly,
  taskBands,
  nightRows,
  type NightRow,
  tasksTonight,
  ticksIn,
  toMinutes,
  windowMinutes,
  ingestSchedule,
  INGEST_FALLBACK_MS,
} from '../src/lib/command/model.ts'
import type { AgentTask, FellowRecord, FellowSummary, GraphNode, ProposalRecord } from '../src/api/types.ts'

const task = (kind: AgentTask['kind'], text: string, state: AgentTask['state'] = 'active'): AgentTask => ({
  id: text.slice(0, 4),
  text,
  kind,
  state,
})

const agent = (over: Partial<FellowRecord> & Pick<FellowRecord, 'id' | 'name'>): FellowRecord =>
  ({
    slug: over.id,
    intent: 'something',
    scope: null,
    tasks: [],
    taskCursor: 0,
    homeDomain: 'biomedicine',
    extraDomains: [],
    lens: 'broad',
    model: 'sonnet-5',
    effort: 'high',
    step: 'standard',
    quotaRunsPerDay: 1,
    quotaWeekPct: null,
    autonomy: 'veto',
    art: 'custom',
    nightly: 'rotate',
    priority: 0,
    state: 'sleeping',
    sleepReason: null,
    sleepCode: null,
    skipUntil: null,
    notebookPath: `wiki/meta/agents/${over.id}.md`,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    retiredAt: null,
    ...over,
  }) as FellowRecord

const summary = (a: FellowRecord): FellowSummary =>
  ({ agent: a, currentRun: null, lastRun: null, runsTonight: 0, pendingProposals: 0, undecidedProposals: 0, queue: [], skipsTonight: false, tonight: [], next: null }) as FellowSummary

/** One standing proposal, as the service reports it in a Fellow's queue. */
const proposal = (over: Partial<ProposalRecord> = {}): ProposalRecord =>
  ({
    id: `p${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'a',
    createdAt: '2026-09-13T23:40:00.000Z',
    cycleDate: '2026-09-14',
    kind: 'research-step',
    topic: 'a topic',
    lens: 'broad',
    rationale: '',
    provenance: { candidate: 'sweep', text: 'a', sourcePages: [], task: 'a' },
    pageSet: [],
    estCostUsd: 2,
    estPlanPct: 0.06,
    scopeScore: 0.8,
    rank: 1,
    status: 'proposed',
    decidedAt: null,
    decidedVia: null,
    userNote: null,
    runId: null,
    ...over,
  }) as ProposalRecord

/** A Fellow with proposals standing from an earlier night, which is what phase 1 runs. */
const withStanding = (a: FellowRecord, pending: number, over: Partial<FellowSummary> = {}): FellowSummary =>
  ({
    ...summary(a),
    pendingProposals: pending,
    undecidedProposals: pending,
    queue: Array.from({ length: pending }, () => proposal({ provenance: { candidate: 'sweep', text: 'x', sourcePages: [], task: a.tasks[0]?.text ?? 'a' } })),
    ...over,
  }) as FellowSummary

const node = (over: Partial<GraphNode>): GraphNode =>
  ({ path: 'wiki/concepts/X.md', title: 'X', type: 'concepts', tags: [], domain: null, kind: 'knowledge', out: 0, in: 0, mtimeMs: 0, size: 100, ...over }) as GraphNode

describe('artOf', () => {
  it('names the art when every task shares one, and calls a mix custom', () => {
    expect(artOf([task('watch', 'a'), task('watch', 'b')])).toBe('watch')
    expect(artOf([task('deepen', 'a')])).toBe('deepen')
    expect(artOf([task('watch', 'a'), task('explore', 'b')])).toBe('custom')
  })

  it('calls a Fellow with no tasks custom rather than guessing one', () => {
    // Nothing to read an art off. Any answer here would be an invention.
    expect(artOf([])).toBe('custom')
  })
})

describe('tasksTonight', () => {
  it('takes every standing task when the Fellow sweeps, the default since A7 D8', () => {
    const a = agent({ id: 'clara', name: 'Clara', nightly: 'sweep', tasks: [task('watch', 'a'), task('explore', 'b'), task('deepen', 'c')] })
    expect(tasksTonight(a).map((t) => t.text)).toEqual(['a', 'b', 'c'])
  })

  it('leaves a resting task out of a sweep too', () => {
    const a = agent({ id: 'h', name: 'H', nightly: 'sweep', tasks: [task('explore', 'a', 'resting'), task('watch', 'b')] })
    expect(tasksTonight(a).map((t) => t.text)).toEqual(['b'])
  })

  it('takes exactly one, at the cursor, when it rotates', () => {
    const a = agent({ id: 'clara', name: 'Clara', taskCursor: 1, tasks: [task('watch', 'a'), task('explore', 'b'), task('deepen', 'c')] })
    expect(tasksTonight(a).map((t) => t.text)).toEqual(['b'])
  })

  it('reads the rotation against the whole list, the way the service does', () => {
    /*
     * The cursor indexes `tasks`, not the active part of it: the service steps OVER a resting
     * task rather than removing it. Read against the filtered list, a cursor of 1 here lands
     * on the third task while the shift would run the second.
     */
    const a = agent({
      id: 'r',
      name: 'R',
      taskCursor: 1,
      tasks: [task('watch', 'a', 'resting'), task('explore', 'b'), task('deepen', 'c')],
    })
    expect(tasksTonight(a).map((t) => t.text)).toEqual(['b'])
  })

  it('steps over a resting task the cursor lands on', () => {
    const a = agent({ id: 'r', name: 'R', taskCursor: 0, tasks: [task('watch', 'a', 'resting'), task('explore', 'b')] })
    expect(tasksTonight(a).map((t) => t.text)).toEqual(['b'])
  })

  it('skips resting tasks and wraps the cursor', () => {
    // A cursor past the end of the ACTIVE list must not fall off it.
    const a = agent({ id: 'hedy', name: 'Hedy', taskCursor: 5, tasks: [task('explore', 'a', 'resting'), task('watch', 'b')] })
    expect(tasksTonight(a).map((t) => t.text)).toEqual(['b'])
  })

  it('gives a paused or fully rested Fellow nothing', () => {
    expect(tasksTonight(agent({ id: 'p', name: 'P', state: 'paused', tasks: [task('watch', 'a')] }))).toEqual([])
    expect(tasksTonight(agent({ id: 'q', name: 'Q', tasks: [task('explore', 'a', 'resting')] }))).toEqual([])
  })
})

describe('shelvesFrom', () => {
  const nodes = [
    node({ domain: 'biomedicine' }),
    node({ domain: 'biomedicine', type: 'questions' }),
    node({ domain: 'finance' }),
    // Structural pages are not what the shelf holds; they organise it.
    node({ domain: 'biomedicine', kind: 'structural' }),
    node({ domain: null }),
  ]

  it('counts knowledge pages and question pages per shelf', () => {
    const [bio] = shelvesFrom({ domains: ['biomedicine'], nodes, gaps: [], fellows: [] })
    expect(bio).toMatchObject({ key: 'biomedicine', pages: 2, questions: 1 })
  })

  it('attributes a gap to the shelf that misses it most', () => {
    // Two of the three pages linking to the missing one are in biomedicine.
    const gaps = [{ title: 'Missing', refBy: [0, 1, 2] }]
    const shelves = shelvesFrom({ domains: ['biomedicine', 'finance'], nodes, gaps, fellows: [] })
    expect(shelves.find((s) => s.key === 'biomedicine')?.gaps).toBe(1)
    expect(shelves.find((s) => s.key === 'finance')?.gaps).toBe(0)
  })

  it('puts a Fellow on its home shelf only', () => {
    /*
     * `extraDomains` widens where a Fellow may work, not where it lives. Counting it on both
     * would count its night twice, and the schedule is the one place that must add up.
     */
    const a = summary(agent({ id: 'clara', name: 'Clara', homeDomain: 'biomedicine', extraDomains: ['finance'] }))
    const shelves = shelvesFrom({ domains: ['biomedicine', 'finance'], nodes, gaps: [], fellows: [a] })
    expect(shelves.find((s) => s.key === 'biomedicine')?.fellows).toHaveLength(1)
    expect(shelves.find((s) => s.key === 'finance')?.fellows).toHaveLength(0)
  })

  it('leaves a retired Fellow off the shelf entirely', () => {
    const a = summary(agent({ id: 'old', name: 'Old', state: 'retired' }))
    expect(shelvesFrom({ domains: ['biomedicine'], nodes, gaps: [], fellows: [a] })[0]!.fellows).toHaveLength(0)
  })
})

describe('shelfOrder', () => {
  it('walks the stored order first, and ranks what nobody placed behind it', () => {
    const mk = (key: string, priority = 0): ReturnType<typeof shelvesFrom>[number] => ({
      key,
      pages: 0,
      questions: 0,
      gaps: 0,
      fellows: [summary(agent({ id: key, name: key, priority, homeDomain: key }))],
    })
    // `late` has a high priority and still comes last: nothing was said about where it goes.
    const order = shelfOrder([mk('late', 9), mk('a'), mk('b')], ['b', 'a'])
    expect(order.map((s) => s.key)).toEqual(['b', 'a', 'late'])
  })

  it('drops the empty shelves and ranks the rest by priority, then by age', () => {
    const mk = (key: string, priority: number, createdAt: string): ReturnType<typeof shelvesFrom>[number] => ({
      key,
      pages: 0,
      questions: 0,
      gaps: 0,
      fellows: [summary(agent({ id: key, name: key, priority, createdAt, homeDomain: key }))],
    })
    const order = shelfOrder([
      mk('a', 0, '2026-01-02'),
      { key: 'empty', pages: 5, questions: 1, gaps: 0, fellows: [] },
      mk('b', 3, '2026-01-03'),
      mk('c', 0, '2026-01-01'),
    ])
    // b first for its priority; then c before a, because it is older.
    expect(order.map((s) => s.key)).toEqual(['b', 'c', 'a'])
  })
})

describe('nightBlock', () => {
  it('reports the gate the service already answered, in the service\'s own words', () => {
    /*
     * The case that stopped a sweep after its first task. Read off `gate` rather than
     * re-derived from the percentages: two implementations of one rule is how a window ends
     * up disagreeing with the shift about the same night.
     */
    const block = nightBlock({
      gate: { window: 'seven_day', reason: 'the week is at 83%, above the 80% reserve', resetsAt: '2026-09-10T12:00:00.000Z' },
    })
    expect(block).toEqual({ reason: 'the week is at 83%, above the 80% reserve', resetsAt: '2026-09-10T12:00:00.000Z', liftable: false })
  })

  it('marks the five-hour window as the one a release can lift', () => {
    const block = nightBlock({ gate: { window: 'five_hour', reason: 'the 5-hour window is at 72%, above the 60% reserve', resetsAt: null } })
    expect(block?.liftable).toBe(true)
  })

  it('is nothing when the gate is open, and nothing when there is no answer to read', () => {
    expect(nightBlock({ gate: null })).toBeNull()
    expect(nightBlock({})).toBeNull()
    // Not measured is not the same as blocked: saying "held" without an answer is a guess.
    expect(nightBlock(undefined)).toBeNull()
  })
})

describe('nightRoom', () => {
  const plan = (five: number, week: number, over?: { active: boolean; pct: number }): Parameters<typeof nightRoom>[0] => ({
    available: true,
    gate: null,
    windows: [
      { window: 'five_hour', utilization: five, resetsAt: '2026-09-09T22:30:00.000Z' },
      { window: 'seven_day', utilization: week, resetsAt: '2026-09-10T12:00:00.000Z' },
    ],
    settings: { reserve5hPct: 60, reserveWeekPct: 80 },
    ...(over ? { override: over } : {}),
  })

  it('leads with the bound that has the least room, not the largest percentage', () => {
    /*
     * 62 % of an 80 % reserve has 18 points left; 50 % of a 60 % one has 10. The week is the
     * bigger number and the five-hour window is the one a night would meet first.
     */
    const room = nightRoom(plan(50, 62))
    expect(room?.tight).toMatchObject({ window: 'five-hour', pct: 50, reserve: 60 })
    expect(room?.other).toMatchObject({ window: 'week', pct: 62, reserve: 80 })
  })

  it('takes a live release as the five-hour reserve', () => {
    // Released to 90 %, the five-hour window has 40 points of room and the week decides.
    expect(nightRoom(plan(50, 62, { active: true, pct: 90 }))?.tight.window).toBe('week')
  })

  it('says nothing while the gate is shut, because the other banner says that', () => {
    expect(nightRoom({ ...plan(50, 83)!, gate: { window: 'seven_day' } })).toBeNull()
  })

  it('says nothing without a measurement to say it from', () => {
    expect(nightRoom(undefined)).toBeNull()
    expect(nightRoom({ available: false, windows: [], settings: { reserve5hPct: 60, reserveWeekPct: 80 } })).toBeNull()
    // A sample that carries only one of the two windows cannot name the tighter of them.
    expect(nightRoom({ available: true, gate: null, windows: [{ window: 'seven_day', utilization: 10, resetsAt: null }], settings: { reserve5hPct: 60, reserveWeekPct: 80 } })).toBeNull()
  })
})

describe('ticksIn', () => {
  it('marks every half hour', () => {
    // 23:30 to 01:00 across midnight: the scale is unwrapped, so this is 1410 to 1500.
    expect(ticksIn(1410, 1500, 30)).toEqual([1440, 1470])
  })

  it('leaves the ends bare, because they are the frame', () => {
    // A mark on 23:00 and on 01:00 would sit on the border of the bar, and a label there
    // hangs off it. Both ends are excluded, the start by value and the end by the loop.
    expect(ticksIn(23 * 60, 25 * 60, 60)).toEqual([24 * 60])
  })

  it('starts at the first step past the start, not at the start rounded down', () => {
    expect(ticksIn(1415, 1500, 30)).toEqual([1440, 1470])
  })

  it('returns nothing rather than looping forever on a step of zero', () => {
    expect(ticksIn(0, 600, 0)).toEqual([])
  })
})

describe('isSystemPage', () => {
  it('names the indexes a run has to touch, and the notebook it writes about itself', () => {
    expect(isSystemPage('wiki/hot.md')).toBe(true)
    expect(isSystemPage('wiki/index.md')).toBe(true)
    expect(isSystemPage('wiki/log.md')).toBe(true)
    expect(isSystemPage('wiki/sources/_index.md')).toBe(true)
    expect(isSystemPage('wiki/meta/agents/clara.md')).toBe(true)
  })

  it('leaves the reading list in, because a Fellow adds to it on purpose', () => {
    // It lives under `wiki/meta/` with the notebooks, and is the one thing there that is a result.
    expect(isSystemPage('wiki/meta/reading-list.md')).toBe(false)
  })

  it('leaves everything a run set out to write', () => {
    expect(isSystemPage('wiki/concepts/Honey Garlic Tofu.md')).toBe(false)
    expect(isSystemPage('wiki/questions/Research: something.md')).toBe(false)
    expect(isSystemPage('wiki/entities/NYT Cooking.md')).toBe(false)
  })
})

describe('scheduleFrom', () => {
  const durations = { 'research-step': 318_000, 'research-expand': 311_000, plan: 86_000, research: 614_000 }

  /*
   * What the overview bar points at (2026-09-14). Twelve hours of scale leave one run about ten
   * pixels wide, so the block a reader hovers there is the whole task - which only works
   * because a task's plan and its runs are laid out together.
   */
  it('groups a night into one band per task, with the fellow and the task on each', () => {
    const a = agent({ id: 'b', name: 'B', autonomy: 'auto', nightly: 'sweep', quotaRunsPerDay: 3, tasks: [task('watch', 'a'), task('deepen', 'b')] })
    const bands = taskBands(scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [summary(a)] }], 1500, durations))
    // Round robin over two tasks with three runs: the first comes round twice.
    expect(bands.map((t) => `${t.text}:${t.plans}p${t.runs}r`)).toEqual(['a:1p2r', 'b:1p1r'])
    expect(bands.map((t) => t.fellowName)).toEqual(['B', 'B'])
    // Each band is the span of its own blocks, and they follow one another without a gap.
    expect(bands[0]!.from).toBe(1500)
    expect(bands[0]!.to).toBe(bands[1]!.from)
    expect(bands[1]!.to - bands[0]!.from).toBe(fellowMinutes(summary(a), durations))
  })

  it('a band reports the run that happened, over the plan that only forecast it', () => {
    // The band spans a plan and its runs, and the plan carries no verdict of its own until the
    // night gives it one. What the reader wants from the band is the strongest thing about it.
    const a = agent({ id: 'v', name: 'V', autonomy: 'auto', quotaRunsPerDay: 1, tasks: [task('watch', 'a')] })
    const f = { ...summary(a), runsTonight: 1, tonight: [{ id: 'a', outcome: 'ran' as const }] } as FellowSummary
    const blocks = scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [f] }], 1500, durations)
    expect(blocks.map((b) => `${b.phase}:${b.outcome}`)).toEqual(['plan:open', 'run:ran'])
    expect(taskBands(blocks).map((t) => t.outcome)).toEqual(['ran'])
  })

  /*
   * A task nothing survived the veto on gets no run booked for it (2026-09-14). The shift will
   * not run a vetoed proposal, so a forecast that gave the task one would say "nothing runs"
   * and draw a run in the same breath - and would book minutes the night never spends.
   */
  it('keeps a vetoed task out of the round, and gives its runs to the tasks that can use them', () => {
    const a = agent({ id: 'x', name: 'X', autonomy: 'auto', nightly: 'sweep', quotaRunsPerDay: 2, tasks: [task('watch', 'a'), task('watch', 'b'), task('watch', 'c')] })
    const f = { ...summary(a), tonight: [{ id: 'a', outcome: 'open' as const }, { id: 'b', outcome: 'vetoed' as const }, { id: 'c', outcome: 'open' as const }] } as FellowSummary
    const bands = taskBands(scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [f] }], 1500, durations))
    expect(bands.map((t) => `${t.text}:${t.plans}p${t.runs}r`)).toEqual(['a:1p1r', 'b:1p0r', 'c:1p1r'])
    // Every task is still planned, so the minutes hold three plans and the two runs that fit.
    expect(fellowMinutes(f, durations)).toBe(3 * 1 + 2 * 5)
  })

  it('lays the night end to end, because the runs are serialized', () => {
    const shelves = [
      { key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [withStanding(agent({ id: 'c', name: 'Clara', tasks: [task('watch', 'a')] }), 1)] },
      { key: 'ml', pages: 0, questions: 0, gaps: 0, fellows: [withStanding(agent({ id: 'a', name: 'Ada', tasks: [task('deepen', 'b')] }), 1)] },
    ]
    const blocks = scheduleFrom(shelves, 1500, durations)
    // One plan and one run each: the plan decides what the night does, the run does it.
    expect(blocks.map((b) => b.phase)).toEqual(['plan', 'run', 'plan', 'run'])
    // Every block starts where the one before it ends - one queue, not one per shelf.
    for (const [i, b] of blocks.entries()) if (i > 0) expect(b.from).toBe(blocks[i - 1]!.to)
    expect(blocks[0]!.shelf).toBe('bio')
  })

  /*
   * The count the quota actually caps (2026-09-14). It used to be read as a supply of tasks -
   * `min(tasks, quota)` - so a Fellow with one standing task and a quota of two was drawn as
   * one run while the shift ran two: phase 3 walks its auto Fellows in ROUNDS and stops on the
   * quota, and one planning run puts up three proposals for one task.
   */
  it('a single task can fill a night, because the quota caps runs and not tasks', () => {
    const a = agent({ id: 'b', name: 'B', autonomy: 'auto', nightly: 'sweep', quotaRunsPerDay: 2, tasks: [task('watch', 'a')] })
    const blocks = scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [summary(a)] }], 1500, durations)
    expect(blocks.map((b) => b.phase)).toEqual(['plan', 'run', 'run'])
    expect(runsTonight(summary(a))).toBe(2)
  })

  it('a Fellow that waits a night runs only what already stands', () => {
    // Veto mode: tonight it plans, tomorrow night the top proposal runs. With nothing standing
    // from an earlier night, tonight is a planning night and the bar says so.
    const a = agent({ id: 'v', name: 'V', autonomy: 'veto', quotaRunsPerDay: 2, tasks: [task('watch', 'a')] })
    expect(scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [summary(a)] }], 1500, durations).map((b) => b.phase)).toEqual(['plan'])
    expect(scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [withStanding(a, 1)] }], 1500, durations).map((b) => b.phase)).toEqual(['plan', 'run'])
    /*
     * Which of the two it is, is the service's answer and not the board's: the queue is built
     * from the rule the shift runs by, so a Fellow that asks first simply has no undecided
     * proposal in it. The board counts what it is given.
     */
    const asks = agent({ ...a, id: 'm', autonomy: 'manual' })
    const holding = { ...summary(asks), pendingProposals: 1, undecidedProposals: 1, queue: [] } as FellowSummary
    expect(scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [holding] }], 1500, durations).map((b) => b.phase)).toEqual(['plan'])
  })

  it('counts the runs this night already made, so the bar does not shrink as the night works', () => {
    // One of the two is done. The block for it carries the mark; the other is still forecast.
    const a = agent({ id: 'b', name: 'B', autonomy: 'auto', nightly: 'sweep', quotaRunsPerDay: 2, tasks: [task('watch', 'a')] })
    const half = { ...summary(a), runsTonight: 1 } as FellowSummary
    const blocks = scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [half] }], 1500, durations)
    expect(blocks.map((b) => b.phase)).toEqual(['plan', 'run', 'run'])
    expect(blocks.map((b) => b.outcome)).toEqual(['open', 'ran', 'open'])
    // And once the quota is spent the night is still drawn as the two runs it made.
    const spent = { ...summary(a), runsTonight: 2 } as FellowSummary
    expect(scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [spent] }], 1500, durations).map((b) => b.outcome)).toEqual(['open', 'ran', 'ran'])
  })

  it('books only the planning run for a task the quota will not carry out', () => {
    /*
     * The trap this exists for: planning is free of `quotaRunsPerDay` and the run it produces
     * is not. A sweeping Fellow on a quota of one plans three tasks and runs one, so drawing
     * three full runs would book about 21 minutes the shift never spends.
     */
    const a = agent({ id: 's', name: 'S', autonomy: 'auto', nightly: 'sweep', quotaRunsPerDay: 1, tasks: [task('watch', 'a'), task('watch', 'b'), task('watch', 'c')] })
    const blocks = scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [summary(a)] }], 1500, durations)
    // Task by task, each plan in front of its own runs: the first task gets the one run there
    // is, the other two are planned and stand for a later night.
    expect(blocks.map((b) => `${b.phase}:${b.text}`)).toEqual(['plan:a', 'run:a', 'plan:b', 'plan:c'])
    expect(blocks.map((b) => b.minutes)).toEqual([1, 5, 1, 1])
    // And the whole Fellow costs the same as its blocks, because it is the same arithmetic.
    expect(fellowMinutes(summary(a), durations)).toBe(8)
    expect(runsTonight(summary(a))).toBe(1)
    // Two of the three tasks get no run of their own; the note under the bar names them.
    expect(plannedOnly(blocks).map((b) => b.text)).toEqual(['b', 'c'])
  })

  it('carries out every task once the quota is raised to match them', () => {
    const a = agent({ id: 's', name: 'S', autonomy: 'auto', nightly: 'sweep', quotaRunsPerDay: 2, tasks: [task('watch', 'a'), task('deepen', 'b')] })
    expect(runsTonight(summary(a))).toBe(2)
    expect(fellowMinutes(summary(a), durations)).toBe(12)
    expect(plannedOnly(scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [summary(a)] }], 1500, durations))).toEqual([])
  })

  it('carries out nothing at a quota of zero, and still plans', () => {
    // A quota of 0 is a real setting: it parks a Fellow without pausing it.
    const a = agent({ id: 'z', name: 'Z', autonomy: 'auto', nightly: 'sweep', quotaRunsPerDay: 0, tasks: [task('watch', 'a')] })
    expect(runsTonight(summary(a))).toBe(0)
    expect(fellowMinutes(summary(a), durations)).toBe(1)
  })

  it('counts what runs, not what is merely on the list', () => {
    /*
     * The number a schedule shows is taken at face value, so it has to be the one that
     * happens. Three tasks against a quota of one is a night that does one and defers two.
     */
    const shelves = (quota: number): ReturnType<typeof shelvesFrom> => [
      {
        key: 'bio',
        pages: 0,
        questions: 0,
        gaps: 0,
        fellows: [summary(agent({ id: 's', name: 'S', autonomy: 'auto', nightly: 'sweep', quotaRunsPerDay: quota, tasks: [task('watch', 'a'), task('watch', 'b'), task('watch', 'c')] }))],
      },
    ]
    expect(runCount(scheduleFrom(shelves(1), 1500, durations))).toBe('1 run, 3 plans')
    expect(runCount(scheduleFrom(shelves(3), 1500, durations))).toBe('3 runs, 3 plans')
    expect(runCount([])).toBe('nothing to run')
    // A night that only plans says so rather than counting the plans as work done.
    expect(runCount(scheduleFrom(shelves(0), 1500, durations))).toBe('3 plans, no run')
  })

  it('carries what the night made of each task onto its block', () => {
    /*
     * The record, not the forecast: the service says what became of a task this cycle and the
     * bar marks the section from that. A task with no outcome yet is `open`, which is what a
     * schedule drawn before the night is.
     */
    const a = agent({
      id: 'o',
      name: 'O',
      autonomy: 'auto',
      nightly: 'sweep',
      quotaRunsPerDay: 3,
      tasks: [task('watch', 'a'), task('watch', 'b'), task('watch', 'c')],
    })
    const withOutcomes = {
      ...summary(a),
      runsTonight: 1,
      tonight: [
        { id: 'a', outcome: 'ran' as const },
        { id: 'b', outcome: 'vetoed' as const },
        { id: 'c', outcome: 'open' as const },
      ],
    }
    const blocks = scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [withOutcomes] }], 1500, durations)
    // The veto is a verdict on the TASK, so it marks the plan that produced the proposals; the
    // run that happened marks the first run block, which is the one the night already made.
    // The vetoed task keeps its plan and its mark, and its share of the runs goes to the two
    // tasks that can still use them.
    expect(blocks.map((b) => `${b.phase}:${b.text}:${b.outcome}`)).toEqual([
      'plan:a:open',
      'run:a:ran',
      'run:a:open',
      'plan:b:vetoed',
      'plan:c:open',
      'run:c:open',
    ])
  })

  it('calls a task open when the service says nothing about it', () => {
    // A Fellow the payload carries no outcomes for: absent is not the same as decided.
    const a = agent({ id: 'q', name: 'Q', tasks: [task('watch', 'a')] })
    const blocks = scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [summary(a)] }], 1500, durations)
    expect(blocks[0]!.outcome).toBe('open')
  })

  it('marks a task whose Fellow asks first, since it does not start on its own', () => {
    const shelves = [{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [summary(agent({ id: 'x', name: 'X', autonomy: 'manual', tasks: [task('watch', 'a')] }))] }]
    expect(scheduleFrom(shelves, 1500, durations)[0]!.waits).toBe(true)
  })

  it('prices a run on its own, and a task as its run plus its planning run', () => {
    // 318 s is 5 minutes of run; with the 86 s plan in front of it the task costs 7.
    expect(runMinutes('watch', durations)).toBe(5)
    expect(runMinutes('deepen', durations)).toBe(5)
  })

  it('counts a task as its run plus its own planning run', () => {
    // 318 s + 86 s = 404 s, which is 7 minutes - not the 5 the run alone would suggest.
    expect(minutesFor('watch', durations)).toBe(7)
    expect(minutesFor('deepen', durations)).toBe(7)
  })

  it('falls back to the measured medians when the service has no history yet', () => {
    expect(minutesFor('watch', {})).toBe(7)
  })
})

/*
 * The night as a list (2026-09-14). The bar says how long and whose; this says WHAT, which is
 * the question shading cannot answer, and it says it in the shift's own order rather than the
 * bar's - the bar groups a Fellow's work together so a task can be pointed at, while the night
 * really runs what already stands, then plans, then what its auto Fellows just planned.
 */
describe('nightRows', () => {
  const durations = { 'research-step': 318_000, 'research-expand': 311_000, plan: 86_000, research: 614_000 }
  const rowsOf = (fellows: FellowSummary[]): NightRow[] => {
    const shelf = { key: 'bio', pages: 0, questions: 0, gaps: 0, fellows }
    return nightRows(shelf, scheduleFrom([shelf], 1500, durations))
  }

  it('names what a standing proposal will do, and prices it by the proposal', () => {
    const a = agent({ id: 'b', name: 'B', autonomy: 'auto', quotaRunsPerDay: 1, tasks: [task('watch', 'ADCs')] })
    const p = proposal({ status: 'approved', kind: 'research', topic: 'Sweep the patent filings', estCostUsd: 6, estPlanPct: 0.19, provenance: { candidate: 'reading', text: 'x', sourcePages: ['wiki/sources/A.md'], task: 'ADCs' } })
    const rows = rowsOf([{ ...summary(a), queue: [p] } as FellowSummary])
    const run = rows.find((r) => r.kind === 'run')!
    expect(run).toMatchObject({ phase: 3, fellowName: 'B', task: 'ADCs', estUsd: 6, estPct: 0.19 })
    expect(run.proposal?.topic).toBe('Sweep the patent filings')
    // A ten-minute sweep, not the five-minute step the task's art would have priced it at.
    expect(run.minutes).toBe(10)
    expect(run.why).toContain('approved')
  })

  it('puts a Fellow that waits a night before the plans, and one that decides for itself after', () => {
    const waits = agent({ id: 'w', name: 'W', autonomy: 'veto', quotaRunsPerDay: 1, tasks: [task('watch', 'a')] })
    const decides = agent({ id: 'd', name: 'D', autonomy: 'auto', quotaRunsPerDay: 1, tasks: [task('watch', 'b')] })
    const stands = (t: string) => proposal({ status: 'approved', provenance: { candidate: 'sweep', text: 'x', sourcePages: [], task: t } })
    const rows = rowsOf([
      { ...summary(waits), queue: [stands('a')] } as FellowSummary,
      { ...summary(decides), queue: [stands('b')] } as FellowSummary,
    ])
    expect(rows.map((r) => `${r.phase}${r.kind[0]}:${r.fellowName}`)).toEqual(['1r:W', '2p:W', '2p:D', '3r:D'])
  })

  it('draws a slot with no proposal yet as the open room it is', () => {
    // Quota of two against one standing proposal: the second run is real, its subject is not.
    const a = agent({ id: 'b', name: 'B', autonomy: 'auto', quotaRunsPerDay: 2, tasks: [task('watch', 'a')] })
    const rows = rowsOf([{ ...summary(a), queue: [proposal({ status: 'approved', provenance: { candidate: 'sweep', text: 'x', sourcePages: [], task: 'a' } })] } as FellowSummary])
    expect(rows.map((r) => r.kind)).toEqual(['plan', 'run', 'open'])
    const open = rows.find((r) => r.kind === 'open')!
    expect(open.proposal).toBeNull()
    // Priced by the Fellow, since nothing is known about what it will do.
    expect(open.estUsd).toBeGreaterThan(0)
    // And in the same currency as the rest of the list, where the calibration reaches.
    expect(open.estPct).toBeNull()
    const priced = nightRows(
      { key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [{ ...summary(a), queue: [] } as FellowSummary] },
      scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [{ ...summary(a), queue: [] } as FellowSummary] }], 1500, durations),
      { points: (amount) => amount * 0.03 },
    )
    expect(priced.find((r) => r.kind === 'open')!.estPct).toBeCloseTo(0.18, 5)
  })

  /*
   * The line the section is drawn along (2026-09-14): a proposal is settled or it is not. An
   * undecided one WILL run for a Fellow that decides for itself, but naming it here would put
   * a decision in front of a reader who came to see what the night does - and Decisions is a
   * whole screen for exactly that, with the rationale, the fit and the two buttons.
   */
  it('shows only what is settled: an undecided proposal is a slot, not a subject', () => {
    const a = agent({ id: 'v', name: 'V', autonomy: 'veto', quotaRunsPerDay: 1, tasks: [task('watch', 'a')] })
    const pending = proposal({ status: 'proposed', topic: 'Something nobody has decided on', provenance: { candidate: 'sweep', text: 'x', sourcePages: [], task: 'a' } })
    const rows = rowsOf([{ ...summary(a), queue: [pending] } as FellowSummary])
    expect(rows.map((r) => r.kind)).toEqual(['plan', 'open'])
    const slot = rows.find((r) => r.kind === 'open')!
    // The row keeps the slot's minutes and price - the night still spends them - and says why
    // it has no subject, without repeating the topic or offering a decision.
    expect(slot.proposal).toBeNull()
    expect(slot.why).toContain('waiting on your decision')
    expect(JSON.stringify(rows)).not.toContain('Something nobody has decided on')

    // Approve the same proposal and the row becomes the run it always was - and moves ahead of
    // the planning run, because a Fellow that waits a night runs what stands before it plans.
    const approved = rowsOf([{ ...summary(a), queue: [{ ...pending, status: 'approved' }] } as FellowSummary])
    expect(approved.map((r) => r.kind)).toEqual(['run', 'plan'])
    expect(approved.find((r) => r.kind === 'run')!.proposal?.topic).toBe('Something nobody has decided on')
  })
})

describe('windowMinutes', () => {
  it('unwraps a window that crosses midnight', () => {
    // 01:00 to 06:00 is a night AFTER 18:00, not thirteen hours before it.
    expect(windowMinutes('01:00', '06:00')).toEqual({ from: 25 * 60, to: 30 * 60 })
  })

  it('keeps an evening start where it is', () => {
    expect(windowMinutes('22:00', '06:00')).toEqual({ from: 22 * 60, to: 30 * 60 })
  })

  it('never returns an end at or before its start', () => {
    // A settings pair that says the same hour twice would otherwise divide by zero downstream.
    const w = windowMinutes('01:00', '01:00')
    expect(w.to).toBeGreaterThan(w.from)
  })

  it('reads the clock the way the settings write it', () => {
    expect(toMinutes('06:30')).toBe(390)
    expect(toMinutes('00:00')).toBe(0)
  })
})

describe('ingestSchedule', () => {
  const job = (id: string, over: Partial<{ hold: 'night' | null; night: boolean; status: string; typicalMs: number | null; createdAt: string; type: string }> = {}) => ({
    id,
    name: `${id}.pdf`,
    type: 'pdf',
    hold: 'night' as const,
    night: true,
    status: 'queued',
    typicalMs: 480_000,
    createdAt: `2026-09-11T10:0${id.slice(-1)}:00.000Z`,
    ...over,
  })

  it('lays the held ingests end to end from the start, oldest first, and skips what is not tonight\'s', () => {
    // Phase 0 of the night: what the user queued for tonight runs before any Fellow, in the
    // order it was added, each block as wide as its kind of ingest usually takes.
    const blocks = ingestSchedule([job('j2'), job('j1'), job('j3', { hold: null, night: false })], 1500)
    expect(blocks.map((b) => [b.id, b.from, b.to])).toEqual([
      ['j1', 1500, 1508],
      ['j2', 1508, 1516],
    ])
    expect(blocks[0]).toMatchObject({ name: 'j1.pdf', type: 'pdf', minutes: 8, phase: 'held' })
  })

  it('keeps a released job in the queue, and says where it stands, until its commit is made', () => {
    // The shift releases a job by clearing its hold; the scene's `night` flag keeps it in
    // the queue while it waits its turn, runs and commits, and the row says which.
    const blocks = ingestSchedule(
      [
        job('j1', { hold: null, status: 'queued' }),
        job('j2', { hold: null, status: 'ingesting' }),
        job('j3', { hold: null, status: 'done' }),
        job('j4', { hold: null, status: 'preprocessing' }),
        job('j5', { hold: null, night: false, status: 'done' }),
      ],
      0,
    )
    expect(blocks.map((b) => [b.id, b.phase])).toEqual([
      ['j1', 'waiting'],
      ['j2', 'running'],
      ['j3', 'committing'],
      ['j4', 'running'],
    ])
  })

  it('gives a type nobody has measured five minutes, and never less than one', () => {
    expect(ingestSchedule([job('j1', { typicalMs: null })], 0)[0]!.minutes).toBe(INGEST_FALLBACK_MS / 60_000)
    expect(ingestSchedule([job('j1', { typicalMs: 1_000 })], 0)[0]!.minutes).toBe(1)
    expect(ingestSchedule([], 0)).toEqual([])
  })
})
