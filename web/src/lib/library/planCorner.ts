/**
 * The three lines in the Library's bottom-right corner (docs/agents/SPEC.md section 10.7):
 * which plan is running, and how much of the five-hour and the seven-day window is LEFT.
 *
 * The endpoint reports utilisation - what has been used - and the room should say what is
 * still there: standing in the library, the question is how much of the night is affordable,
 * not how much of the day is gone.
 *
 * Two things make this less simple than subtracting from a hundred, and both are the reason
 * this is a tested function rather than three lines of JSX:
 *
 *  - **The numbers age.** They are sampled inside runs and, between runs, from an endpoint
 *    that is itself rate limited. A percentage with no age on it is a percentage that lies
 *    quietly, so a stale one says how old it is.
 *  - **A window that has reset is not stale, it is empty.** Past its `resetsAt`, the last
 *    sample describes a window that no longer exists: the honest answer is a full 100 %,
 *    not the figure from before the reset.
 */

import type { PlanStatus } from '../../api/types.ts'

/** After this, a sample is old enough to say so beside the number. */
export const STALE_MS = 20 * 60_000

export interface PlanLine {
  /** 'five_hour' | 'seven_day', as the endpoint names them. */
  readonly window: string
  /** What the corner calls it. */
  readonly label: string
  /** Percent of the window still available, 0 to 100, rounded to a whole number. */
  readonly leftPct: number
  /** True when this window has rolled over since the sample: the number is a fresh 100. */
  readonly reset: boolean
  /** The window with the least left - the one that stops the next run. */
  readonly tightest: boolean
}

export interface PlanCorner {
  /** The plan's name, or null when neither the user nor the SDK has said. */
  readonly plan: string | null
  readonly lines: readonly PlanLine[]
  /** How old the newest sample is, in minutes; null when nothing has ever been sampled. */
  readonly ageMin: number | null
  /** True when the numbers have stopped refreshing and should be read with that in mind. */
  readonly stale: boolean
  /** Why they are not refreshing, when the service knows; for the tooltip. */
  readonly reason: string | null
}

/** The two windows everyone has; the rest are named from their key. */
const LABEL: Record<string, string> = { five_hour: '5 h', seven_day: 'week' }

/**
 * What to call a window that is not one of the two above.
 *
 * The plan carries per-model weekly limits as well - `seven_day_opus`, `seven_day_fable` -
 * and one of those is often the tightest of the lot. The card used to skip every key it did
 * not know by name, which hid exactly the limit that binds first. Anything `seven_day_x`
 * reads as "week · x"; anything else is its key with the underscores taken out.
 */
export function windowLabel(key: string): string {
  if (LABEL[key] !== undefined) return LABEL[key]!
  const model = key.startsWith('seven_day_') ? key.slice('seven_day_'.length) : null
  if (model !== null) return `week · ${model.replace(/_/g, ' ')}`
  return key.replace(/_/g, ' ')
}

/** Five hours first, then the plain week, then the per-model weeks in their own order. */
const RANK: Record<string, number> = { five_hour: 0, seven_day: 1 }

/** The corner's content for this plan status, as of `now`. */
export function planCorner(plan: PlanStatus | undefined, now: number): PlanCorner | null {
  if (!plan || !plan.available || plan.windows.length === 0) return null
  const sampled = plan.sampledAt === null ? null : Date.parse(plan.sampledAt)
  const ageMin = sampled === null || Number.isNaN(sampled) ? null : Math.max(0, Math.floor((now - sampled) / 60_000))

  const lines: Array<Omit<PlanLine, 'tightest'>> = []
  for (const w of plan.windows) {
    const resetsAt = plan.resets[w.window] ?? w.resetsAt
    const parsed = resetsAt === null || resetsAt === undefined ? NaN : Date.parse(resetsAt)
    const reset = !Number.isNaN(parsed) && parsed <= now
    const left = reset ? 100 : 100 - w.utilization
    lines.push({ window: w.window, label: windowLabel(w.window), leftPct: Math.max(0, Math.min(100, Math.round(left))), reset })
  }
  if (lines.length === 0) return null
  lines.sort((a, b) => (RANK[a.window] ?? 2) - (RANK[b.window] ?? 2) || a.window.localeCompare(b.window))
  // The window with the least left is the one that stops the next run, whichever it is. It
  // carries a mark so the binding limit is visible without reading three numbers and
  // comparing them - which is the whole reason the per-model windows are shown at all.
  const tightest = lines.reduce((a, b) => (b.leftPct < a.leftPct ? b : a))

  return {
    plan: plan.subscription !== null && plan.subscription !== '' ? plan.subscription : null,
    lines: lines.map((l) => ({ ...l, tightest: l.window === tightest.window })),
    ageMin,
    // A window that has reset carries no stale figure, so an old sample behind a full window
    // is not worth flagging - only one whose number is still being shown.
    stale: ageMin !== null && ageMin * 60_000 > STALE_MS && lines.some((l) => !l.reset),
    reason: plan.liveReason,
  }
}
