/**
 * Pure helpers around the plan status (docs/agents/SPEC.md section 8, A5): the spawn
 * dialog's projection and the one-line share summary the Library's chip and System's panel
 * show. Kept out of the components so the arithmetic is testable.
 */

import type { PlanStatus } from '../api/types.ts'

/** A model's weekly points per USD, when calibrated. */
export function pointsPerUsd(plan: PlanStatus | undefined, model: string): number | null {
  const cal = plan?.calibration.perModel[model]
  return cal && cal.n >= 3 ? cal.sevenDay : null
}

/**
 * What a Fellow costs per week at its pace: USD always, and percent of the week once the
 * model is calibrated (section 5.1).
 */
export function weeklyProjection(plan: PlanStatus | undefined, input: { stepUsd: number; stepsPerDay: number; model: string }): { usd: number; weekPct: number | null } {
  const usd = Math.round(input.stepUsd * input.stepsPerDay * 7 * 100) / 100
  const ppu = pointsPerUsd(plan, input.model)
  return { usd, weekPct: ppu === null ? null : Math.round(usd * ppu * 10) / 10 }
}

/** `3.2 of 10 points this week` or `41.20 of 100 USD this week`. */
export function shareLine(plan: PlanStatus): string {
  const unit = plan.shares.unit === 'points' ? 'points' : 'USD'
  const fmt = (n: number): string => (plan.shares.unit === 'points' ? n.toFixed(1) : n.toFixed(2))
  return `${fmt(plan.shares.weekUsed)} of ${fmt(plan.shares.week)} ${unit} this week`
}
