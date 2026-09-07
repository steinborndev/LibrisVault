/**
 * The plan corner of the Library (web/src/lib/library/planCorner.ts). The numbers are read at
 * a glance and spend real money, and two of the cases - a window that has rolled over, and a
 * sample that has stopped refreshing - are exactly the ones a display gets quietly wrong.
 */

import { describe, it, expect } from 'vitest'
import { planCorner, STALE_MS } from '../src/lib/library/planCorner.ts'
import type { PlanStatus } from '../src/api/types.ts'

const NOW = Date.parse('2026-09-07T15:00:00.000Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const ahead = (ms: number): string => new Date(NOW + ms).toISOString()

const plan = (over: Partial<PlanStatus> = {}): PlanStatus =>
  ({
    available: true,
    source: 'sdk',
    reason: null,
    liveReason: null,
    sinceSample: { runs: 0, fiveHour: null, sevenDay: null },
    subscription: null,
    sampledAt: ago(60_000),
    windows: [
      { window: 'five_hour', utilization: 24, resetsAt: ahead(3600_000) },
      { window: 'seven_day', utilization: 53, resetsAt: ahead(48 * 3600_000) },
    ],
    resets: {},
    calibration: { perModel: {}, ready: false },
    consumption: { weekPct: null, fiveHourPct: null, weekUsd: 0, fiveHourUsd: 0, weekRuns: 0, fiveHourRuns: 0 },
    settings: { researchShareWeekPct: 10, researchShare5hPct: 15, reserve5hPct: 60, reserveWeekPct: 80, planWeekUsd: 1000, plan5hUsd: 80, planName: '' },
    shares: { unit: 'usd', week: 100, fiveHour: 12, weekUsed: 0, fiveHourUsed: 0, stepsLeftWeek: null },
    gate: null,
    ...over,
  }) as PlanStatus

describe('what the corner says', () => {
  it('reports what has been USED, the way the plan\'s own clients do, as whole percents', () => {
    const c = planCorner(plan(), NOW)!
    expect(c.unit).toBe('used')
    expect(c.lines.map((l) => [l.label, l.usedPct])).toEqual([
      ['5h', 24],
      ['week', 53],
    ])
  })

  it('shows every window the plan reports, including the per-model weeks', () => {
    const c = planCorner(
      plan({
        windows: [
          { window: 'seven_day_fable', utilization: 81, resetsAt: ahead(3600_000) },
          { window: 'five_hour', utilization: 27, resetsAt: ahead(3600_000) },
          { window: 'seven_day', utilization: 54, resetsAt: ahead(3600_000) },
        ],
      }),
      NOW,
    )!
    // Five hours, then the plain week, then the per-model ones - and each named, not skipped.
    expect(c.lines.map((l) => l.label)).toEqual(['5h', 'week', 'week · fable'])
    expect(c.lines.map((l) => l.usedPct)).toEqual([27, 54, 81])
  })

  it('marks the fullest window, which is the one that stops the next run', () => {
    const c = planCorner(
      plan({
        windows: [
          { window: 'five_hour', utilization: 27, resetsAt: ahead(3600_000) },
          { window: 'seven_day', utilization: 54, resetsAt: ahead(3600_000) },
          { window: 'seven_day_fable', utilization: 81, resetsAt: ahead(3600_000) },
        ],
      }),
      NOW,
    )!
    expect(c.lines.filter((l) => l.tightest).map((l) => l.label)).toEqual(['week · fable'])
  })

  it('names a window nobody has a label for rather than dropping it', () => {
    const c = planCorner(plan({ windows: [{ window: 'seven_day_oauth_apps', utilization: 5, resetsAt: null }] }), NOW)!
    expect(c.lines.map((l) => l.label)).toEqual(['week · oauth apps'])
  })

  it('takes the plan name the user set over the one the SDK guessed', () => {
    expect(planCorner(plan({ subscription: '5x max' }), NOW)!.plan).toBe('5x max')
    expect(planCorner(plan(), NOW)!.plan).toBeNull()
  })

  it('shows a window that has rolled over as empty, not as the figure from before it', () => {
    const c = planCorner(plan({ windows: [{ window: 'five_hour', utilization: 91, resetsAt: ago(60_000) }] }), NOW)!
    expect(c.lines[0]).toMatchObject({ usedPct: 0, reset: true })
  })

  it('prefers the reset the service tracked over the one on the sample', () => {
    const c = planCorner(plan({ resets: { five_hour: ago(1000) } }), NOW)!
    expect(c.lines.find((l) => l.window === 'five_hour')!.reset).toBe(true)
  })

  it('carries the age, and calls the numbers stale only once they are old', () => {
    expect(planCorner(plan(), NOW)!.stale).toBe(false)
    expect(planCorner(plan({ sampledAt: ago(STALE_MS + 60_000) }), NOW)!.ageMin).toBe(21)
    expect(planCorner(plan({ sampledAt: ago(STALE_MS + 60_000) }), NOW)!.stale).toBe(true)
  })

  it('warns only on a window that is genuinely running out - the thresholds are on the used side', () => {
    // 53 % used is the fullest window here and still nowhere near a warning: the mark says
    // "this one binds first", the colour says "and it is nearly gone".
    const c = planCorner(plan(), NOW)!
    expect(c.lines.map((l) => l.usedPct >= 75)).toEqual([false, false])
  })

  it('does not call an old sample stale when every window it describes has since reset', () => {
    const c = planCorner(plan({ sampledAt: ago(6 * 3600_000), windows: [{ window: 'five_hour', utilization: 91, resetsAt: ago(3600_000) }] }), NOW)!
    expect(c.stale).toBe(false)
  })

  it('carries what has run since the measurement, per window, apart from the measured figure', () => {
    const c = planCorner(plan({ sinceSample: { runs: 3, fiveHour: 6.2, sevenDay: 1.4 } }), NOW)!
    expect(c.runsSince).toBe(3)
    expect(c.lines.map((l) => [l.usedPct, l.sincePct])).toEqual([
      [24, 6.2],
      [53, 1.4],
    ])
  })

  it('estimates nothing for a window that has rolled over - the runs before it are gone too', () => {
    const c = planCorner(
      plan({ sinceSample: { runs: 2, fiveHour: 9, sevenDay: 1 }, windows: [{ window: 'five_hour', utilization: 91, resetsAt: ago(60_000) }] }),
      NOW,
    )!
    expect(c.lines[0]).toMatchObject({ usedPct: 0, sincePct: null })
  })

  it('says nothing rather than guessing where the calibration cannot price a run', () => {
    const c = planCorner(plan({ sinceSample: { runs: 4, fiveHour: null, sevenDay: null } }), NOW)!
    expect(c.lines.every((l) => l.sincePct === null)).toBe(true)
    expect(c.runsSince).toBe(4)
  })

  it('leaves a per-model window without an estimate, because the calibration does not price one', () => {
    const c = planCorner(
      plan({ sinceSample: { runs: 1, fiveHour: 2, sevenDay: 1 }, windows: [{ window: 'seven_day_fable', utilization: 81, resetsAt: ahead(3600_000) }] }),
      NOW,
    )!
    expect(c.lines[0]).toMatchObject({ label: 'week · fable', sincePct: null })
  })

  it('passes on why the numbers stopped refreshing', () => {
    expect(planCorner(plan({ liveReason: 'Rate limited. Please try again later.' }), NOW)!.reason).toBe('Rate limited. Please try again later.')
  })

  it('says nothing at all when there is nothing measured', () => {
    expect(planCorner(undefined, NOW)).toBeNull()
    expect(planCorner(plan({ available: false }), NOW)).toBeNull()
    expect(planCorner(plan({ windows: [] }), NOW)).toBeNull()
  })
})
