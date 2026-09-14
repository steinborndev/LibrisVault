/**
 * The "run a step now" button of the Fellow card (docs/agents/SPEC.md section 8.4).
 *
 * Runs per day is a limit on the autopilot, not on the user: a deliberate click may pass it,
 * and the card says so before the click instead of answering with a 409 afterwards. The other
 * refusals - the plan shares, the reserves, the daily budget, a rate-limit pause - guard the
 * user's own capacity and are never overridden, so they still come back as errors.
 *
 * Pure, so the wording and the moment the override is sent are under test.
 */

export interface QuotaState {
  readonly used: number
  readonly runsPerDay: number
}

export interface StepButton {
  readonly label: string
  /** The click only asks; the next one runs. */
  readonly asks: boolean
  /** Send the override with this run. */
  readonly override: boolean
  /** Shown while the question stands. */
  readonly note: string | null
}

const NOTE = "Today's quota holds the night shift back, not you. The plan shares, the reserves and the daily budget still apply."

export function stepButton(quota: QuotaState, confirming: boolean): StepButton {
  const spent = quota.runsPerDay > 0 && quota.used >= quota.runsPerDay
  if (!spent) return { label: 'Run next step now', asks: false, override: false, note: null }
  if (!confirming) return { label: `Run a step anyway · ${quota.used} of ${quota.runsPerDay} used`, asks: true, override: false, note: null }
  return { label: 'Yes, run it now', asks: false, override: true, note: NOTE }
}
