/**
 * The lines in the Library's bottom-right corner (docs/agents/SPEC.md section 10.7): which plan
 * is running, and how much of each window has been USED.
 *
 * Used, the same way the plan's own clients report it, so the two can be read side by side
 * without arithmetic - a remaining figure beside a used one looks like a contradiction rather
 * than the same fact twice.
 *
 * Two things make this less simple than copying a number, and both are the reason this is a
 * tested function rather than three lines of JSX:
 *
 *  - **The numbers age.** They are sampled inside runs and, between runs, from an endpoint
 *    that is itself rate limited - or, with a long-lived token, not at all, so that days can
 *    pass between two samples. A percentage with no age on it is a percentage that lies
 *    quietly, so a stale one says how old it is and why there is no newer one. It is still
 *    shown: the card used to vanish once the service called the sample unavailable (a day
 *    old), which left "can I afford tonight" with no answer at all in three places at once.
 *  - **A window that has reset is not stale, it is empty.** Past its `resetsAt`, the last
 *    sample describes a window that no longer exists: the honest answer is 0 % used, not the
 *    figure from before the rollover.
 */

import type { PlanStatus } from '../../api/types.ts'

/** After this, a sample is old enough to say so beside the number. */
export const STALE_MS = 20 * 60_000

export interface PlanLine {
  /** 'five_hour' | 'seven_day', as the endpoint names them. */
  readonly window: string
  /** What the corner calls it. */
  readonly label: string
  /** Percent of the window consumed as last MEASURED, 0 to 100, rounded to a whole number. */
  readonly usedPct: number
  /**
   * Estimated percent spent since that measurement, or null when nothing can price it. The
   * two are kept apart on purpose: one was read off the plan, the other is arithmetic, and a
   * reader deciding whether tonight is affordable should be able to tell which is which.
   */
  readonly sincePct: number | null
  /** True when this window has rolled over since the sample: the number is a fresh 0. */
  readonly reset: boolean
  /**
   * The window with the most used. Not drawn any more: the week is almost always the fullest,
   * because it is far the larger budget, so a mark on it carried no information. Kept because
   * the reading is still true and a caller may want it.
   */
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
  /** The word for what the percentages measure, said once in the head. */
  readonly unit: 'used'
  /** Why they are not refreshing, when the service knows; for the tooltip. */
  readonly reason: string | null
  /** Runs that have finished since the newest measurement and are therefore not in it. */
  readonly runsSince: number
  /** The age line, always shown; the release button sits beside it. */
  readonly ageText: string
  /** The five-hour release: may it be granted, is one live, and until when. */
  readonly release: { readonly enabled: boolean; readonly active: boolean; readonly pct: number; readonly until: string | null }
}

/** The two windows everyone has; the rest are named from their key. */
const LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'week' }

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

/** `0m old`, `3h old`, `2d old`: the age at the resolution it deserves. */
export function ageLabel(ageMin: number): string {
  if (ageMin < 60) return `${ageMin}m old`
  if (ageMin < 48 * 60) return `${Math.floor(ageMin / 60)}h old`
  return `${Math.floor(ageMin / (24 * 60))}d old`
}

/** The corner's content for this plan status, as of `now`; null only when nothing was ever measured. */
export function planCorner(plan: PlanStatus | undefined, now: number): PlanCorner | null {
  if (!plan || plan.windows.length === 0) return null
  const sampled = plan.sampledAt === null ? null : Date.parse(plan.sampledAt)
  const ageMin = sampled === null || Number.isNaN(sampled) ? null : Math.max(0, Math.floor((now - sampled) / 60_000))

  /*
   * What each window is behind by. Only the two the estimate knows: a per-model week is not
   * priced by the calibration, and guessing there would be worse than saying nothing.
   */
  const since: Record<string, number | null> = { five_hour: plan.sinceSample?.fiveHour ?? null, seven_day: plan.sinceSample?.sevenDay ?? null }

  const lines: Array<Omit<PlanLine, 'tightest'>> = []
  for (const w of plan.windows) {
    const resetsAt = plan.resets[w.window] ?? w.resetsAt
    const parsed = resetsAt === null || resetsAt === undefined ? NaN : Date.parse(resetsAt)
    const reset = !Number.isNaN(parsed) && parsed <= now
    const used = reset ? 0 : w.utilization
    // A window that has rolled over owes nothing to the runs before the rollover either.
    const est = reset ? null : since[w.window] ?? null
    lines.push({
      window: w.window,
      label: windowLabel(w.window),
      usedPct: Math.max(0, Math.min(100, Math.round(used))),
      sincePct: est !== null && est > 0 ? Math.round(est * 10) / 10 : null,
      reset,
    })
  }
  if (lines.length === 0) return null
  lines.sort((a, b) => (RANK[a.window] ?? 2) - (RANK[b.window] ?? 2) || a.window.localeCompare(b.window))
  // The fullest window is the one that stops the next run, whichever it is. It carries a mark
  // so the binding limit is visible without reading three numbers and comparing them - which
  // is the whole reason the per-model windows are shown at all.
  const tightest = lines.reduce((a, b) => (b.usedPct > a.usedPct ? b : a))

  return {
    plan: plan.subscription !== null && plan.subscription !== '' ? plan.subscription : null,
    unit: 'used',
    lines: lines.map((l) => ({ ...l, tightest: l.window === tightest.window })),
    ageMin,
    // A window that has reset carries no stale figure, so an old sample behind a full window
    // is not worth flagging - only one whose number is still being shown.
    stale: ageMin !== null && ageMin * 60_000 > STALE_MS && lines.some((l) => !l.reset),
    /** How many runs the shown figures do not include yet. */
    runsSince: plan.sinceSample?.runs ?? 0,
    // Always said, even at zero: the age is the line the release button stands next to, and a
    // line that appears and disappears takes the button with it.
    ageText: ageMin === null ? 'never measured' : ageLabel(ageMin),
    release: {
      enabled: plan.override?.enabled ?? false,
      active: plan.override?.active ?? false,
      pct: plan.override?.pct ?? 90,
      until: plan.override?.expiresAt ?? null,
    },
    // Why there is nothing newer: while the sample counts as available the live reason is
    // the one that speaks; once the service calls it unavailable, its own reason says why.
    reason: plan.available ? plan.liveReason : (plan.reason ?? plan.liveReason),
  }
}
