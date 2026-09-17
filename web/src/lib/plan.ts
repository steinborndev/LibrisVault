/**
 * Pure helpers around the plan status (docs/agents/SPEC.md section 8, A5): what a Fellow
 * costs against the week's research budget, what the whole roster costs, and the one-line
 * share summary. Kept out of the components so the arithmetic is testable - and so the four
 * places that show a budget figure cannot each grow their own version of it.
 *
 * THE BUDGET, IN ONE PARAGRAPH. The Fellows may spend `researchShareWeekPct` of the plan's
 * seven-day window (10 by default); above `reserveWeekPct` nothing runs at all. The service
 * measures that spend in one of two units, and which one it uses is not a setting: while a
 * run in the current week reported a window delta, it counts POINTS (percent of the plan's
 * own window) against the share; with no such measurement it counts USD against
 * `share/100 * planWeekUsd`. Both are "the budget", and they do NOT agree - this vault reads
 * 42% of the week in USD and 107% in points for the same Fellow, because `planWeekUsd`
 * prices the window more generously than the measurements do. So every figure here is a
 * PERCENT of the budget, computed in whichever unit the gate is currently deciding in: one
 * number, always the one that governs, and the absolute figure alongside it for the tooltip.
 */

import type { PlanStatus } from '../api/types.ts'

/** What one run costs at list price. One table, because three screens quote it. */
/**
 * What a run of a kind costs, as the service measured it (`pipeline/run-cost.ts`), priced on a
 * factor-1 model so a caller scales it by the model it is asking about. `GET /agents` carries
 * one of these; the table below is what a vault with no history of its own falls back to, and
 * every entry of it is replaced as soon as three runs of that kind have settled.
 */
export type Prices = Readonly<Record<string, number>>
export const MODEL_FACTOR: Record<string, number> = { 'sonnet-5': 1, 'opus-5': 2.5, 'fable-5-1': 5 }

/**
 * What one run of each KIND costs, as the gate prices it (`pipeline/planner.ts` KIND_COST_USD).
 *
 * The reference the service itself starts from, kept here for the same reason: a board that
 * has not been told the measured table yet prices a night the way a fresh vault would. A
 * planning run is in it because the gate holds those too - a plan spends plan points like
 * anything else, and a night's total that left them out would be short by one per task.
 */
export const KIND_USD: Record<string, number> = { 'research-step': 2, research: 6, 'research-expand': 3, plan: 0.4 }

/** One run of this kind on this model, in USD. */
export const kindUsd = (kind: string, model: string, costs?: Prices): number =>
  Math.round((costs?.[kind] ?? KIND_USD[kind] ?? KIND_USD['research-step']!) * (MODEL_FACTOR[model] ?? 1) * 100) / 100

/**
 * The kind a Fellow's run will be, from its art and its step (`planner.ts` kindsForTask):
 * a deepen task only ever extends pages, and for the other two `small` may take a
 * single-question step where `standard` and `deep` may also sweep.
 *
 * The art matters because the kinds are priced apart. Without it a librarian was quoted a
 * sweep's price beside an extension's duration - one number from its art and the other from
 * its depth, in the same line of the same card.
 */
export const stepKind = (step: string, art?: string): string =>
  art === 'deepen' ? 'research-expand' : step === 'small' ? 'research-step' : 'research'

/** What one run of a Fellow at this pace costs, measured where the service has measured it. */
export const runUsd = (step: string, model: string, costs?: Prices, art?: string): number =>
  kindUsd(stepKind(step, art), model, costs)

/**
 * What {@link pointsPerUsd} needs of a plan, and no more: `PlanStatus` satisfies it, and so
 * does a forecast's own input, which is how a caller can price a night without the payload.
 */
export interface Calibrated {
  readonly calibration: { readonly perModel: Record<string, { readonly sevenDay: number | null; readonly n: number }> }
}

/**
 * A model's points per USD, and whether it had to be borrowed.
 *
 * Its own calibration needs three measured runs; a model that has never run has none, which
 * used to mean no figure at all - and the models without one are opus and fable, the two the
 * figure matters most for. So another calibrated model's rate stands in, UNSCALED: the model
 * factor is already inside the USD amount this rate multiplies, and applying it a second time
 * would price an opus run at 6.25 sonnet runs instead of 2.5.
 */
export function pointsPerUsd(plan: Calibrated | undefined, model: string): { ppu: number; estimated: boolean } | null {
  const own = plan?.calibration.perModel[model]
  if (own && own.sevenDay !== null && own.n >= 3) return { ppu: own.sevenDay, estimated: false }
  const lent = Object.values(plan?.calibration.perModel ?? {})
    .filter((c) => c.sevenDay !== null && c.n >= 3)
    .sort((a, b) => b.n - a.n)[0]
  return lent === undefined ? null : { ppu: lent.sevenDay!, estimated: true }
}

/** What a pace costs per week: USD always, points where the calibration reaches. */
export function weeklyProjection(
  plan: PlanStatus | undefined,
  input: { stepUsd: number; stepsPerDay: number; model: string },
): { usd: number; weekPct: number | null } {
  const usd = Math.round(input.stepUsd * input.stepsPerDay * 7 * 100) / 100
  const rate = pointsPerUsd(plan, input.model)
  return { usd, weekPct: rate === null ? null : Math.round(usd * rate.ppu * 10) / 10 }
}

export interface BudgetShare {
  /** Percent of the week's research budget. 100 is exactly the budget, more is over it. */
  readonly pct: number
  /** The same claim in the unit the gate decides in, with the limit it is measured against. */
  readonly used: number
  readonly limit: number
  readonly unit: 'points' | 'usd'
  /** True when a model's own calibration was missing and another's stood in. */
  readonly estimated: boolean
  /** True when the USD limit came from the calibration rather than the plan-size setting. */
  readonly measured: boolean
}

/**
 * One line for a tooltip: the claim behind the percent, and how much that limit is worth
 * trusting. Points are a real unit - percent of the plan's own window, which is what the gate
 * counts. USD is not: the plan states no dollar budget anywhere, so the limit is an inference
 * from a counter that moves in whole percent, and it is written in whole dollars and hedged
 * accordingly. The percent stays the number to read; this says what it rests on.
 */
export const shareDetail = (s: BudgetShare): string =>
  s.unit === 'points'
    ? `about ${s.used.toFixed(1)} of the week's ${s.limit.toFixed(0)} research points${s.estimated ? ', estimated from another model' : ''}`
    : `roughly ${s.used.toFixed(0)} of about ${s.limit.toFixed(0)} USD a week${s.measured ? ' - a rough figure: the plan states no dollar budget, and this is what runs were measured to take out of it' : ' (from the configured plan size)'}`

/**
 * What one pace claims of the week's research budget. Null only when there is no plan at all
 * - with one, the USD path always answers, so the figure never goes missing the way the old
 * points-only projection did.
 */
export function weekShare(
  plan: PlanStatus | undefined,
  input: { stepUsd: number; stepsPerDay: number; model: string },
): BudgetShare | null {
  if (plan === undefined) return null
  const usd = input.stepUsd * input.stepsPerDay * 7
  const rate = pointsPerUsd(plan, input.model)
  // The gate's own choice: points while a run this week measured one, USD otherwise.
  if (plan.shares.unit === 'points' && rate !== null) {
    const limit = plan.settings.researchShareWeekPct
    const used = usd * rate.ppu
    return { pct: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0, used: Math.round(used * 10) / 10, limit, unit: 'points', estimated: rate.estimated, measured: false }
  }
  const limit = plan.shares.week
  return { pct: limit > 0 ? Math.round((usd / limit) * 1000) / 10 : 0, used: Math.round(usd * 100) / 100, limit, unit: 'usd', estimated: false, measured: plan.planUsd.measured }
}

/** One Fellow's pace, as the roster states it. */
export interface FellowPace {
  readonly model: string
  readonly step: string
  readonly quotaRunsPerDay: number
}

/**
 * What the whole roster claims of the week, added up. Every Fellow that exists counts at its
 * configured pace - what the standing arrangement costs if each runs its quota, not what
 * tonight's plan happens to hold.
 */
export function rosterShare(plan: PlanStatus | undefined, fellows: readonly FellowPace[], costs?: Prices): BudgetShare | null {
  if (plan === undefined) return null
  const parts = fellows
    .map((f) => weekShare(plan, { stepUsd: runUsd(f.step, f.model, costs), stepsPerDay: f.quotaRunsPerDay, model: f.model }))
    .filter((s): s is BudgetShare => s !== null)
  if (parts.length === 0) {
    const empty = weekShare(plan, { stepUsd: 0, stepsPerDay: 0, model: 'sonnet-5' })
    return empty
  }
  const unit = parts[0]!.unit
  const used = parts.reduce((n, s) => n + s.used, 0)
  const limit = parts[0]!.limit
  return {
    pct: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0,
    used: Math.round(used * 100) / 100,
    limit,
    unit,
    estimated: parts.some((s) => s.estimated),
    measured: parts[0]!.measured,
  }
}

/** `3.2 of 10 points this week` or `41.20 of 100 USD this week`. */
export function shareLine(plan: PlanStatus): string {
  const unit = plan.shares.unit === 'points' ? 'points' : 'USD'
  const fmt = (n: number): string => (plan.shares.unit === 'points' ? n.toFixed(1) : n.toFixed(2))
  return `${fmt(plan.shares.weekUsed)} of ${fmt(plan.shares.week)} ${unit} this week`
}
