/**
 * What a run of a given kind usually COSTS (measured 2026-09-15).
 *
 * The sibling of `run-duration.ts`, and it exists for the same reason that one does: the
 * numbers a night is planned with should come from the nights already run. The durations were
 * measured from the start; the prices were four constants, and after ten research runs and
 * seventeen steps the log said they were wrong in both directions - `research` a third above
 * what it actually costs, `plan` and `research-step` below it. A constant cannot notice that.
 *
 * It is not a cosmetic figure. The gate decides with it whether a run still fits the research
 * share, so a price set too high refuses runs that would have fitted and one set too low lets
 * a night overrun the share it was measured against.
 *
 * The median, not the mean, for the same reason as the durations: one run that ran into its
 * budget cap would drag a mean for every ordinary run after it.
 *
 * MODEL is a factor, not a second measurement. A run's cost scales with the model far more
 * sharply than its duration does, so a median mixed across models would price a sonnet run
 * like an opus one. With enough runs of the asked-for model its own median answers; below that
 * the kind's runs are normalised by the factor each was run on and scaled back up to the one
 * being asked about, which is what makes a fresh opus Fellow's first estimate the sonnet
 * median times its factor rather than a guess.
 */

import { MODEL_FACTOR, MODEL_IDS, type AgentModel } from '../db/agents.js'
import { MIN_SAMPLES } from './run-duration.js'

/**
 * Reference prices for a vault with no history of its own (SPEC section 16). Every entry is
 * replaced by the vault's own median as soon as MIN_SAMPLES runs of that kind have settled,
 * so these only ever carry the first few runs of a fresh install.
 */
export const REFERENCE_USD: Readonly<Record<string, number>> = {
  'research-step': 2,
  research: 6,
  'research-expand': 3,
  plan: 0.4,
}

/** What the median needs of a settled run. `AgentRunRecord` satisfies it. */
export interface CostSample {
  readonly kind: string
  readonly ok: boolean
  readonly costUsd: number | null
  /** The SDK model id the run was made on (`claude-sonnet-5`), as the run log stores it. */
  readonly model?: string | null
}

const money = (n: number): number => Math.round(n * 100) / 100

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** The model factor a recorded run was made on, by its SDK id; 1 for anything unrecognised. */
function factorOfId(id: string | null | undefined): number {
  if (id === null || id === undefined) return 1
  for (const key of Object.keys(MODEL_FACTOR) as AgentModel[]) {
    if (MODEL_IDS[key] === id) return MODEL_FACTOR[key]
  }
  return 1
}

/**
 * What one run of this kind on this model is expected to cost, in USD.
 *
 * A free run is not a sample: a run that failed before it spent anything would otherwise pull
 * every estimate toward zero, which is the one direction a price must never drift on its own.
 */
export function typicalRunUsd(history: readonly CostSample[], kind: string, model: AgentModel): number {
  const factor = MODEL_FACTOR[model] ?? 1
  const ofKind = history.filter((r) => r.kind === kind && r.ok && (r.costUsd ?? 0) > 0)
  const own = ofKind.filter((r) => r.model === MODEL_IDS[model])
  if (own.length >= MIN_SAMPLES) return money(median(own.map((r) => r.costUsd!)))
  if (ofKind.length >= MIN_SAMPLES) return money(median(ofKind.map((r) => r.costUsd! / factorOfId(r.model))) * factor)
  return money((REFERENCE_USD[kind] ?? REFERENCE_USD['research-step']!) * factor)
}

/** Every kind's price for this model, for the payload the dashboard forecasts with. */
export function runPrices(history: readonly CostSample[], model: AgentModel): Record<string, number> {
  return Object.fromEntries(Object.keys(REFERENCE_USD).map((k) => [k, typicalRunUsd(history, k, model)]))
}
