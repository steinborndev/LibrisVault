/**
 * The "run a step now" button of the Fellow card (docs/agents/SPEC.md section 8.4), and how to
 * READ the quota figure it counts against.
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

/**
 * `noun` is what this screen calls one unit of work. The card says "step" because that is the
 * run kind; the command centre says "task" because that is what its rows are. Same button.
 */
export function stepButton(quota: QuotaState, confirming: boolean, noun = 'step'): StepButton {
  const spent = quota.runsPerDay > 0 && quota.used >= quota.runsPerDay
  if (!spent) return { label: `Run next ${noun} now`, asks: false, override: false, note: null }
  if (!confirming) return { label: `Run a ${noun} anyway · ${quota.used} of ${quota.runsPerDay} used`, asks: true, override: false, note: null }
  return { label: 'Yes, run it now', asks: false, override: true, note: NOTE }
}

export interface QuotaLine {
  readonly text: string
  readonly title: string
}

/**
 * The quota figure, said in a way that names WHICH night it counts (2026-09-15).
 *
 * The screens around it are drawn from the night AHEAD: minutes tonight, tasks tonight, what
 * the shift will run. This number is not - it is the gate's count, and the gate has to cover
 * the present moment, so between four in the morning and the next window it still counts the
 * night that has been. Both are right about different nights, and they used to sit in one line
 * reading "13 min tonight · 2 of 2 runs used", which says the night ahead is already spent.
 *
 * Inside the window there is nothing to tell apart: the two nights are the same night.
 *
 * `windowStart` is the user's own setting and is named only when it is known; the hour the
 * shift opens at is a value, never a constant, and a tooltip that states one the user has
 * since moved is worse than a tooltip that states none.
 */
export function quotaLine(quota: QuotaState, inWindow: boolean, windowStart: string | null): QuotaLine {
  const of = `${quota.used} of ${quota.runsPerDay}`
  if (inWindow) {
    return { text: `${of} used tonight`, title: 'Research runs spent of this quota in the night now running. A planning run never counts against it.' }
  }
  const opens = windowStart === null ? 'when the night window opens' : `when the night window opens at ${windowStart}`
  return {
    text: `${of} used since last night`,
    title:
      `Research runs spent of this quota in the night cycle still in force. It turns ${opens}, ` +
      `not at midnight, so tonight's shift begins at 0 of ${quota.runsPerDay}. A planning run never counts against it.`,
  }
}
