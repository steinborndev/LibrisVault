/**
 * How long a run of a given kind usually takes (docs/agents/ideas.md, "A percentage in every
 * bubble", measured 2026-09-07).
 *
 * There is no progress signal in an agent run: the SDK reports tool calls, not a fraction of
 * the work, so any percentage is an estimate and the only question is which estimate is
 * honest enough to show. What IS predictable is the DURATION of a kind. Measured over this
 * project's own run log, the spread inside a kind is roughly a fifth of its middle - good
 * enough for a coarse number over a figure's head, useless for a progress bar. That is why
 * the client shows it in steps of ten and never as a precise figure.
 *
 * The median, not the mean: one run that ran into its timeout would drag a mean by minutes,
 * and the number it produced would then be wrong for every ordinary run after it.
 *
 * This file only says how long a kind takes. What that means for a run in flight - which
 * phase it has reached, how coarse the number is, that it never reaches 100 - is the scene
 * adapter's business (web/src/lib/library/scene.ts), because those are questions about a
 * drawing rather than about the history.
 */

/** How many of a vault's own settled runs it takes before their median beats the reference. */
export const MIN_SAMPLES = 3

/**
 * How far back the median looks. Older runs describe an older vault and an older version of
 * the skill they ran; a run that took twelve minutes a month ago says little about today.
 */
export const SAMPLE_LIMIT = 40

/**
 * Reference sizes for a vault with no history of its own (SPEC section 16 and the run log
 * measured on 2026-09-07). Deliberately incomplete: a kind that has never been measured is
 * absent rather than guessed, and a run of that kind then carries no percentage at all -
 * saying nothing is honest, inventing a denominator is not.
 *
 * Every entry is replaced by the vault's own median as soon as MIN_SAMPLES runs of that kind
 * have settled, so these only ever carry the first few runs of a fresh install.
 */
export const REFERENCE_MS: Readonly<Record<string, number>> = {
  research: 749_000,
  'research-expand': 590_000,
  'research-step': 392_000,
  plan: 127_000,
  lint: 512_000,
  'hot-cache': 21_000,
}

/** What the median needs of a settled run. `AgentRunRecord` satisfies it. */
/**
 * How long an ingest of each job type typically takes, from the first vault's own history
 * (2026-09-11: PDFs around nine minutes, web pages around seven, a pasted note around four).
 * What the night shift's queue draws its blocks with until the job log has enough of a type.
 */
export const JOB_REFERENCE_MS: Readonly<Record<string, number>> = {
  pdf: 520_000,
  office: 480_000,
  web: 450_000,
  image: 240_000,
  text: 240_000,
  av: 600_000,
  other: 420_000,
}

/** What a job row says about its own duration: the columns the median reads. */
export interface JobDurationSample {
  readonly type: string
  readonly status: string
  readonly started_at: string | null
  readonly finished_at: string | null
}

/**
 * How long an ingest of this type typically takes, in milliseconds, or null for a type
 * nobody has measured or listed. Same rule as {@link typicalRunMs}: the median of the
 * vault's own finished jobs once there are enough of the type, the reference size before.
 */
export function typicalJobMs(history: readonly JobDurationSample[], type: string): number | null {
  const ofType = history
    .filter((j) => j.type === type && j.status === 'done' && j.started_at !== null && j.finished_at !== null)
    .map((j) => Date.parse(j.finished_at!) - Date.parse(j.started_at!))
    .filter((ms) => ms > 0)
  if (ofType.length >= MIN_SAMPLES) return median(ofType)
  return JOB_REFERENCE_MS[type] ?? null
}

export interface DurationSample {
  readonly kind: string
  /** The SDK model the run was pinned to; null when the runner's default ran. */
  readonly model?: string | null
  readonly ok: boolean
  readonly startedAt: string
  readonly finishedAt: string
}

/** The middle value, averaging the two middles of an even set. Null for an empty one. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2)
}

const durationMs = (r: DurationSample): number => Date.parse(r.finishedAt) - Date.parse(r.startedAt)

/**
 * How long a run of this kind typically takes, in milliseconds, or null when nothing says.
 *
 * Failed runs are left out: a run that died in its second minute describes a fault, not the
 * work. The model is preferred but not required - a kind is far more predictive of duration
 * than the model is, so two Opus samples lose to eight of the same kind on any model.
 */
export function typicalRunMs(history: readonly DurationSample[], kind: string, model: string | null | undefined): number | null {
  const ofKind = history.filter((r) => r.kind === kind && r.ok && durationMs(r) > 0)
  if (model !== null && model !== undefined) {
    const sameModel = ofKind.filter((r) => r.model === model)
    if (sameModel.length >= MIN_SAMPLES) return median(sameModel.map(durationMs))
  }
  if (ofKind.length >= MIN_SAMPLES) return median(ofKind.map(durationMs))
  return REFERENCE_MS[kind] ?? null
}
