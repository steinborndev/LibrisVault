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
  carriedTonight,
  isSystemPage,
  fellowMinutes,
  minutesFor,
  nightBlock,
  nightRoom,
  scheduleFrom,
  shelfOrder,
  shelvesFrom,
  taskCount,
  tasksTonight,
  ticksIn,
  toMinutes,
  windowMinutes,
} from '../src/lib/command/model.ts'
import type { AgentTask, FellowRecord, FellowSummary, GraphNode } from '../src/api/types.ts'

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
  ({ agent: a, currentRun: null, lastRun: null, runsToday: 0, pendingProposals: 0, next: null }) as FellowSummary

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

  it('lays the night end to end, because the runs are serialized', () => {
    const shelves = [
      { key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [summary(agent({ id: 'c', name: 'Clara', tasks: [task('watch', 'a')] }))] },
      { key: 'ml', pages: 0, questions: 0, gaps: 0, fellows: [summary(agent({ id: 'a', name: 'Ada', tasks: [task('deepen', 'b')] }))] },
    ]
    const blocks = scheduleFrom(shelves, 1500, durations)
    expect(blocks).toHaveLength(2)
    // The second starts where the first ends - one queue, not two.
    expect(blocks[1]!.from).toBe(blocks[0]!.to)
    expect(blocks[0]!.shelf).toBe('bio')
  })

  it('books only the planning run for a task the quota will not carry out', () => {
    /*
     * The trap this exists for: planning is free of `quotaRunsPerDay` and the run it produces
     * is not. A sweeping Fellow on a quota of one plans three tasks and runs one, so drawing
     * three full runs would book about 21 minutes the shift never spends.
     */
    const a = agent({ id: 's', name: 'S', nightly: 'sweep', quotaRunsPerDay: 1, tasks: [task('watch', 'a'), task('watch', 'b'), task('watch', 'c')] })
    const blocks = scheduleFrom([{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [summary(a)] }], 1500, durations)
    expect(blocks.map((b) => b.runs)).toEqual([true, false, false])
    expect(blocks.map((b) => b.minutes)).toEqual([7, 1, 1])
    // And the whole Fellow costs the same as its blocks, because it is the same arithmetic.
    expect(fellowMinutes(a, durations)).toBe(9)
    expect(carriedTonight(a)).toBe(1)
  })

  it('carries out every task once the quota is raised to match them', () => {
    const a = agent({ id: 's', name: 'S', nightly: 'sweep', quotaRunsPerDay: 3, tasks: [task('watch', 'a'), task('deepen', 'b')] })
    expect(carriedTonight(a)).toBe(2)
    expect(fellowMinutes(a, durations)).toBe(14)
  })

  it('carries out nothing at a quota of zero, and still plans', () => {
    // A quota of 0 is a real setting: it parks a Fellow without pausing it.
    const a = agent({ id: 'z', name: 'Z', nightly: 'sweep', quotaRunsPerDay: 0, tasks: [task('watch', 'a')] })
    expect(carriedTonight(a)).toBe(0)
    expect(fellowMinutes(a, durations)).toBe(1)
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
        fellows: [summary(agent({ id: 's', name: 'S', nightly: 'sweep', quotaRunsPerDay: quota, tasks: [task('watch', 'a'), task('watch', 'b'), task('watch', 'c')] }))],
      },
    ]
    expect(taskCount(scheduleFrom(shelves(1), 1500, durations))).toBe('1 of 3 tasks run')
    expect(taskCount(scheduleFrom(shelves(3), 1500, durations))).toBe('3 tasks')
    expect(taskCount([])).toBe('0 tasks')
  })

  it('marks a task whose Fellow asks first, since it does not start on its own', () => {
    const shelves = [{ key: 'bio', pages: 0, questions: 0, gaps: 0, fellows: [summary(agent({ id: 'x', name: 'X', autonomy: 'manual', tasks: [task('watch', 'a')] }))] }]
    expect(scheduleFrom(shelves, 1500, durations)[0]!.waits).toBe(true)
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
