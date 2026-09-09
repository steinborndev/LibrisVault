import { describe, expect, it } from 'vitest'
import { pointsPerUsd, shareLine, weeklyProjection } from '../src/lib/plan.ts'
import type { PlanStatus } from '../src/api/types.ts'

const plan = (over: Partial<PlanStatus> = {}): PlanStatus => ({
  available: true,
  source: 'sdk',
  reason: null,
  liveReason: null,
  sinceSample: { runs: 0, fiveHour: null, sevenDay: null },
  override: { enabled: false, active: false, pct: 90, expiresAt: null },
  weekOverride: { enabled: false, active: false, pct: 90, expiresAt: null },
  subscription: 'max',
  sampledAt: 's',
  windows: [{ window: 'five_hour', utilization: 12, resetsAt: null }],
  resets: {},
  calibration: { perModel: { 'sonnet-5': { fiveHour: 1.2, sevenDay: 0.1, n: 3 }, 'opus-5': { fiveHour: null, sevenDay: 0.3, n: 1 } }, ready: true },
  consumption: { weekPct: 3.2, fiveHourPct: 1, weekUsd: 41.2, fiveHourUsd: 2, weekRuns: 5, fiveHourRuns: 1 },
  settings: { researchShareWeekPct: 10, researchShare5hPct: 15, reserve5hPct: 60, reserveWeekPct: 80, planWeekUsd: 1000, plan5hUsd: 80, planName: '5x max' },
  shares: { unit: 'points', week: 10, fiveHour: 15, weekUsed: 3.2, fiveHourUsed: 1, stepsLeftWeek: 30 },
  gate: null,
  ...over,
})

describe('plan helpers', () => {
  it('projects a week in USD and, once calibrated, in points', () => {
    expect(pointsPerUsd(plan(), 'sonnet-5')).toBe(0.1)
    expect(pointsPerUsd(plan(), 'opus-5')).toBeNull()
    expect(pointsPerUsd(undefined, 'sonnet-5')).toBeNull()
    expect(weeklyProjection(plan(), { stepUsd: 2, stepsPerDay: 1, model: 'sonnet-5' })).toEqual({ usd: 14, weekPct: 1.4 })
    expect(weeklyProjection(plan(), { stepUsd: 6, stepsPerDay: 2, model: 'opus-5' })).toEqual({ usd: 84, weekPct: null })
  })

  it('summarises the share in its unit', () => {
    expect(shareLine(plan())).toBe('3.2 of 10.0 points this week')
    expect(shareLine(plan({ shares: { unit: 'usd', week: 100, fiveHour: 12, weekUsed: 41.2, fiveHourUsed: 2, stepsLeftWeek: 29 } }))).toBe('41.20 of 100.00 USD this week')
  })
})
