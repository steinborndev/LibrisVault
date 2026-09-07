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
  it('reports what is LEFT, not what was used, as whole percents', () => {
    const c = planCorner(plan(), NOW)!
    expect(c.lines.map((l) => [l.label, l.leftPct])).toEqual([
      ['5 h left', 76],
      ['week left', 47],
    ])
  })

  it('takes the plan name the user set over the one the SDK guessed', () => {
    expect(planCorner(plan({ subscription: '5x max' }), NOW)!.plan).toBe('5x max')
    expect(planCorner(plan(), NOW)!.plan).toBeNull()
  })

  it('shows a window that has rolled over as empty, not as the figure from before it', () => {
    const c = planCorner(plan({ windows: [{ window: 'five_hour', utilization: 91, resetsAt: ago(60_000) }] }), NOW)!
    expect(c.lines[0]).toMatchObject({ leftPct: 100, reset: true })
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

  it('does not call an old sample stale when every window it describes has since reset', () => {
    const c = planCorner(plan({ sampledAt: ago(6 * 3600_000), windows: [{ window: 'five_hour', utilization: 91, resetsAt: ago(3600_000) }] }), NOW)!
    expect(c.stale).toBe(false)
  })

  it('passes on why the numbers stopped refreshing', () => {
    expect(planCorner(plan({ liveReason: 'Rate limited. Please try again later.' }), NOW)!.reason).toBe('Rate limited. Please try again later.')
  })

  it('says nothing at all when there is nothing measured', () => {
    expect(planCorner(undefined, NOW)).toBeNull()
    expect(planCorner(plan({ available: false }), NOW)).toBeNull()
    expect(planCorner(plan({ windows: [] }), NOW)).toBeNull()
    // A window nobody has a label for is not a line; if that is all there is, there is no card.
    expect(planCorner(plan({ windows: [{ window: 'seven_day_opus', utilization: 5, resetsAt: null }] }), NOW)).toBeNull()
  })
})
