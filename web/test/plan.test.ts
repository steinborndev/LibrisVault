import { describe, expect, it } from 'vitest'
import { pointsPerUsd, rosterShare, runUsd, shareDetail, shareLine, weekShare, weeklyProjection } from '../src/lib/plan.ts'
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
  planUsd: { week: 1000, fiveHour: 83.33, measured: false },
  consumption: { weekPct: 3.2, fiveHourPct: 1, weekUsd: 41.2, fiveHourUsd: 2, weekRuns: 5, fiveHourRuns: 1 },
  settings: { researchShareWeekPct: 10, researchShare5hPct: 15, reserve5hPct: 60, reserveWeekPct: 80, planWeekUsd: 1000, plan5hUsd: 80, planName: '5x max' },
  shares: { unit: 'points', week: 10, fiveHour: 15, weekUsed: 3.2, fiveHourUsed: 1, stepsLeftWeek: 30 },
  gate: null,
  ...over,
})

describe('plan helpers', () => {
  it('projects a week in USD and, once calibrated, in points', () => {
    expect(pointsPerUsd(plan(), 'sonnet-5')).toEqual({ ppu: 0.1, estimated: false })
    expect(pointsPerUsd(undefined, 'sonnet-5')).toBeNull()
    expect(weeklyProjection(plan(), { stepUsd: 2, stepsPerDay: 1, model: 'sonnet-5' })).toEqual({ usd: 14, weekPct: 1.4 })
  })

  it('lends an uncalibrated model the rate of a calibrated one, unscaled', () => {
    // opus-5 has one measured run, not three, so it borrows sonnet's 0.1 - and only that.
    // The model factor is already in the USD figure the rate multiplies; applying it twice
    // would price an opus run at 6.25 sonnet runs instead of 2.5.
    expect(pointsPerUsd(plan(), 'opus-5')).toEqual({ ppu: 0.1, estimated: true })
    expect(weeklyProjection(plan(), { stepUsd: 6, stepsPerDay: 2, model: 'opus-5' })).toEqual({ usd: 84, weekPct: 8.4 })
    // Nothing calibrated at all: no rate to lend.
    expect(pointsPerUsd(plan({ calibration: { perModel: {}, ready: false } }), 'sonnet-5')).toBeNull()
  })

  it('prices one run from the shared table', () => {
    expect(runUsd('standard', 'sonnet-5')).toBe(6)
    expect(runUsd('deep', 'opus-5')).toBe(15)
    expect(runUsd('small', 'fable-5-1')).toBe(10)
    // An unknown step or model falls back rather than producing NaN.
    expect(runUsd('enormous', 'sonnet-5')).toBe(6)
    expect(runUsd('small', 'whatever')).toBe(2)
  })

  describe('the share of the week\'s research budget', () => {
    it('measures points against the share, which is what the gate does', () => {
      // 6 USD a run, one a day: 42 USD a week at 0.1 points/USD = 4.2 points of the 10 allowed.
      const s = weekShare(plan(), { stepUsd: 6, stepsPerDay: 1, model: 'sonnet-5' })!
      expect(s).toEqual({ pct: 42, used: 4.2, limit: 10, unit: 'points', estimated: false, measured: false })
    })

    it('measures USD against the USD budget when no run has been measured this week', () => {
      const usd = plan({ shares: { unit: 'usd', week: 100, fiveHour: 12, weekUsed: 0, fiveHourUsed: 0, stepsLeftWeek: 50 } })
      const s = weekShare(usd, { stepUsd: 6, stepsPerDay: 1, model: 'sonnet-5' })!
      expect(s).toEqual({ pct: 42, used: 42, limit: 100, unit: 'usd', estimated: false, measured: false })
    })

    it('answers for an uncalibrated model instead of going silent', () => {
      const s = weekShare(plan(), { stepUsd: 15, stepsPerDay: 1, model: 'opus-5' })!
      expect(s.estimated).toBe(true)
      expect(s.pct).toBe(105)
      expect(shareDetail(s)).toContain('estimated from another model')
    })

    it('names a measured window in the detail line, because a smaller number needs its reason', () => {
      const measured = plan({
        shares: { unit: 'usd', week: 39.39, fiveHour: 12, weekUsed: 0, fiveHourUsed: 0, stepsLeftWeek: 6 },
        planUsd: { week: 393.87, fiveHour: 80, measured: true },
      })
      const s = weekShare(measured, { stepUsd: 6, stepsPerDay: 1, model: 'sonnet-5' })!
      expect(s.measured).toBe(true)
      expect(s.pct).toBe(106.6)
      expect(shareDetail(s)).toContain('measured from what a run takes out of the plan')
    })

    it('says nothing without a plan', () => {
      expect(weekShare(undefined, { stepUsd: 6, stepsPerDay: 1, model: 'sonnet-5' })).toBeNull()
    })
  })

  describe('the whole roster', () => {
    it('adds every Fellow at its own pace', () => {
      const fellows = [
        { model: 'sonnet-5', step: 'standard', quotaRunsPerDay: 1 },
        { model: 'sonnet-5', step: 'standard', quotaRunsPerDay: 2 },
      ]
      // 42 + 84 USD a week at 0.1 points/USD = 12.6 points of 10: over the budget.
      const s = rosterShare(plan(), fellows)!
      expect(s.used).toBe(12.6)
      expect(s.limit).toBe(10)
      expect(s.pct).toBe(126)
    })

    it('is zero for an empty roster, not null', () => {
      expect(rosterShare(plan(), [])).toEqual({ pct: 0, used: 0, limit: 10, unit: 'points', estimated: false, measured: false })
    })

    it('marks the whole sum as estimated when one Fellow borrowed a rate', () => {
      expect(rosterShare(plan(), [{ model: 'opus-5', step: 'deep', quotaRunsPerDay: 1 }])!.estimated).toBe(true)
    })
  })

  it('summarises the share in its unit', () => {
    expect(shareLine(plan())).toBe('3.2 of 10.0 points this week')
    expect(shareLine(plan({ shares: { unit: 'usd', week: 100, fiveHour: 12, weekUsed: 41.2, fiveHourUsed: 2, stepsLeftWeek: 29 } }))).toBe('41.20 of 100.00 USD this week')
  })
})
