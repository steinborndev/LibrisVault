/**
 * The usage monitor (docs/agents/SPEC.md sections 8.1 to 8.4, docs/tasks/TASKS-A5.md):
 * plan utilization in the plan's own unit, points of the 5-hour and 7-day windows.
 *
 * Three sources, in the spec's order: the SDK's `usage()` method sampled inside a run,
 * `rate_limit_event` messages during a run, and the raw usage endpoint (cached). From the
 * per-run deltas and the run's cost the monitor learns points per USD per model as a
 * running median, prices proposals, and answers the gate: reserves against the latest
 * utilization, shares against what the Fellows consumed. Without plan data it falls back
 * to USD against the section 16 reference sizes (D3), so the shares still mean something.
 */

import type { AgentRunRecord, AgentRunStore } from '../db/agent-runs.js'
import type { UsageSample, UsageSampleStore, SamplePhase, PlanOverride, PlanOverrideStore } from '../db/usage-samples.js'
import { MODEL_IDS, type AgentModel } from '../db/agents.js'

export interface WindowSample {
  readonly window: string
  readonly utilization: number
  readonly resetsAt: string | null
}

export interface PlanSettings {
  readonly researchShareWeekPct: number
  readonly researchShare5hPct: number
  readonly reserve5hPct: number
  readonly reserveWeekPct: number
  readonly planWeekUsd: number
  readonly plan5hUsd: number
  /** What the user calls their subscription; '' = show what was measured instead. */
  readonly planName: string
  /** Whether the five-hour release may be granted at all (section 8.6). */
  readonly fiveHourOverrideEnabled: boolean
  readonly weekOverrideEnabled: boolean
}

export interface EndpointResult {
  readonly ok: boolean
  readonly json?: unknown
  readonly reason?: string
}

export interface UsageMonitorOptions {
  readonly store: UsageSampleStore
  readonly runs: AgentRunStore
  readonly settings: () => PlanSettings
  /** Live grants that lift a window's bounds (section 8.6); absent = the feature is off. */
  readonly overrides?: PlanOverrideStore
  /** The raw usage endpoint; undefined = none (an API key). */
  readonly fetchEndpoint?: () => Promise<EndpointResult>
  readonly now?: () => Date
  /** How long an endpoint sample stays fresh. */
  readonly cacheMs?: number
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface GateContext {
  readonly estCostUsd: number
  readonly model: AgentModel
  readonly kind: string
}

export interface GateVerdict {
  readonly code: 'reserve' | 'share'
  readonly window: 'five_hour' | 'seven_day'
  readonly reason: string
  readonly resetsAt: string | null
}

export interface Calibration {
  readonly perModel: Readonly<Record<string, { readonly fiveHour: number | null; readonly sevenDay: number | null; readonly n: number }>>
  /** True once any model has at least CALIBRATION_MIN runs with a week delta. */
  readonly ready: boolean
}

export interface Consumption {
  readonly weekPct: number | null
  readonly fiveHourPct: number | null
  readonly weekUsd: number
  readonly fiveHourUsd: number
  readonly weekRuns: number
  readonly fiveHourRuns: number
}

export interface PlanStatus {
  readonly available: boolean
  readonly source: 'sdk' | 'event' | 'endpoint' | null
  readonly reason: string | null
  /** Why the between-runs source is silent, even while old samples are still being shown. */
  readonly liveReason: string | null
  /** The five-hour release (section 8.6): whether it may be granted, and whether one is live. */
  readonly override: {
    readonly enabled: boolean
    readonly active: boolean
    /** What a grant lifts the bounds to, live or not. */
    readonly pct: number
    readonly expiresAt: string | null
  }
  /**
   * The week release (section 8.6a), the same shape. Kept as its own field rather than folded
   * into a map: the two grants are different decisions with different ends, and a reader of
   * this payload should not have to look up which key is which.
   */
  readonly weekOverride: {
    readonly enabled: boolean
    readonly active: boolean
    readonly pct: number
    /** The end of the night this was granted for, never the week's own reset. */
    readonly expiresAt: string | null
  }
  /** Estimated window percent spent by runs that started after the newest sample. */
  readonly sinceSample: { readonly runs: number; readonly fiveHour: number | null; readonly sevenDay: number | null }
  readonly subscription: string | null
  readonly sampledAt: string | null
  readonly windows: readonly WindowSample[]
  /** When each window resets, from the latest sample or the last rate-limit event (known without utilization). */
  readonly resets: Readonly<Record<string, string>>
  readonly calibration: Calibration
  readonly consumption: Consumption
  readonly settings: PlanSettings
  /** The shares as the gate applies them: points when calibrated, USD otherwise. */
  readonly shares: { readonly unit: 'points' | 'usd'; readonly week: number; readonly fiveHour: number; readonly weekUsed: number; readonly fiveHourUsed: number; readonly stepsLeftWeek: number | null }
  /** The gate's answer for a standard step on the default model right now. */
  readonly gate: GateVerdict | null
}

export const CALIBRATION_MIN = 3
export const BASELINE_MAX_AGE_MS = 3 * 60_000
const CALIBRATION_RUNS = 50
const WEEK_MS = 7 * 24 * 3600_000
const FIVE_H_MS = 5 * 3600_000

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** Windows out of the SDK's `rate_limits` shape, tolerant of missing buckets. */
function parseWindows(limits: unknown): WindowSample[] {
  if (limits === null || typeof limits !== 'object') return []
  const out: WindowSample[] = []
  const r = limits as Record<string, unknown>
  for (const key of ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet']) {
    const w = r[key]
    if (w === null || typeof w !== 'object') continue
    const u = num((w as Record<string, unknown>)['utilization'])
    if (u === null) continue
    out.push({ window: key, utilization: u, resetsAt: str((w as Record<string, unknown>)['resets_at']) })
  }
  const scoped = r['model_scoped']
  if (Array.isArray(scoped)) {
    for (const m of scoped) {
      if (m === null || typeof m !== 'object') continue
      const rec = m as Record<string, unknown>
      const u = num(rec['utilization'])
      const name = str(rec['display_name'])
      if (u === null || name === null) continue
      out.push({ window: `model:${name.toLowerCase()}`, utilization: u, resetsAt: str(rec['resets_at']) })
    }
  }
  return out
}

/**
 * The ceiling a five-hour override may lift the bounds to. Not 100: the last tenth of a window
 * stays the user's, so releasing the rest of an afternoon can never leave them with nothing.
 */
export const OVERRIDE_PCT = 90

/** How far the wait between refused endpoint calls doubles: 180 s becomes at most ~48 min. */
const MAX_BACKOFF_STEPS = 4

/**
 * What the plan endpoint says when the credential structurally cannot read it.
 *
 * A long-lived token - `claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN` - is inference-only by
 * design; Claude Code says so itself ("limited to inference-only for security reasons"), and
 * `user:profile` belongs to an interactive sign-in. That is the whole point of the restriction:
 * a token sitting unattended in an environment file should not read the account's profile.
 *
 * So this refusal is not a wait. Retrying it on any schedule is knocking at a door that is
 * locked, and it produced a second, misleading reason ("Rate limited") that sent one
 * investigation down the wrong path.
 */
const SCOPE_REFUSAL = /scope requirement|user:profile/i

/** What to say instead, once we know the door is not going to open. */
const INFERENCE_ONLY =
  'this credential is inference-only by design - a long-lived token carries no user:profile scope - so the plan windows come from runs, not from the endpoint'

/** Whether a refusal is the permanent kind. Pure, so the wording is pinned by a test. */
export const isPermanentRefusal = (reason: string | null): boolean => reason !== null && SCOPE_REFUSAL.test(reason)

/** The SDK's `usage()` response: availability, subscription, windows. */
export function parseSdkUsage(res: unknown): { available: boolean; subscription: string | null; windows: WindowSample[]; reason: string | null } {
  if (res === null || typeof res !== 'object') return { available: false, subscription: null, windows: [], reason: 'no usage response' }
  const r = res as Record<string, unknown>
  const available = r['rate_limits_available'] === true
  const windows = available ? parseWindows(r['rate_limits']) : []
  // The windows come from the API's rate-limit headers, so the sample before the first
  // request of a session carries none (`rate_limits: null`); the runner samples on
  // assistant messages for that reason.
  const reason = !available ? 'the SDK reports no plan rate limits for this credential' : windows.length === 0 ? 'the SDK carried no plan windows yet (no API response in this session)' : null
  return { available: available && windows.length > 0, subscription: str(r['subscription_type']), windows, reason }
}

/** The raw endpoint's JSON: the same buckets, possibly nested under `rate_limits`. */
export function parseEndpointUsage(json: unknown): { available: boolean; windows: WindowSample[]; reason: string | null } {
  if (json === null || typeof json !== 'object') return { available: false, windows: [], reason: 'no usage data' }
  const r = json as Record<string, unknown>
  if (typeof r['error'] === 'object' && r['error'] !== null) {
    const e = r['error'] as Record<string, unknown>
    return { available: false, windows: [], reason: str(e['message']) ?? 'the usage endpoint refused' }
  }
  const windows = parseWindows(r['rate_limits'] ?? r)
  return { available: windows.length > 0, windows, reason: windows.length > 0 ? null : 'the usage endpoint carried no windows' }
}

/**
 * A `rate_limit_event`'s info as a window sample, when it carries utilization. The events
 * seen so far carry the window and its reset time but no utilization; `eventReset` reads
 * those, so the monitor at least knows when the window turns.
 */
/**
 * A `rate_limit_event` as a window sample.
 *
 * The event reports utilization as a FRACTION where the SDK's usage windows report a
 * percentage. Measured on 2026-09-09: two events recorded `seven_day` at 0.83 in the same
 * second that an SDK sample recorded it at 83. Stored unscaled, that number is the newest
 * sample for its window until the next run replaces it, and the gate reads it as "the week is
 * at 0.83%" - so the reserve that stops a night stops nothing, in the one direction that
 * costs money.
 *
 * At exactly 1 the two readings are indistinguishable (1 % or 100 %). It is read as 100 %,
 * because that direction closes the gate rather than opening it.
 */
export function parseRateLimitEvent(info: unknown): WindowSample | null {
  if (info === null || typeof info !== 'object') return null
  const r = info as Record<string, unknown>
  const u = num(r['utilization'])
  const type = str(r['rateLimitType'])
  if (u === null || type === null) return null
  const resets = num(r['resetsAt'])
  return {
    window: type,
    utilization: u <= 1 ? Math.round(u * 100 * 100) / 100 : u,
    resetsAt: resets !== null ? new Date(resets * 1000).toISOString() : null,
  }
}

/** The window and reset time of a `rate_limit_event`, utilization or not. */
export function eventReset(info: unknown): { window: string; resetsAt: string } | null {
  if (info === null || typeof info !== 'object') return null
  const r = info as Record<string, unknown>
  const type = str(r['rateLimitType'])
  const resets = num(r['resetsAt'])
  if (type === null || resets === null) return null
  return { window: type, resetsAt: new Date(resets * 1000).toISOString() }
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** After minus before per window; a window that reset in between counts what it shows after. */
export function deltaBetween(before: readonly WindowSample[], after: readonly WindowSample[]): Record<string, number> {
  const out: Record<string, number> = {}
  const b = new Map(before.map((w) => [w.window, w.utilization]))
  for (const a of after) {
    const prev = b.get(a.window)
    if (prev === undefined) continue
    out[a.window] = Math.round((a.utilization >= prev ? a.utilization - prev : a.utilization) * 100) / 100
  }
  return out
}

const isFellowRun = (r: AgentRunRecord): boolean => r.agentId !== undefined && r.agentId !== null

const KEY_OF_ID: Readonly<Record<string, AgentModel>> = Object.fromEntries(Object.entries(MODEL_IDS).map(([key, id]) => [id, key as AgentModel]))

/** A run row carries the SDK model id, a Fellow its key; the calibration is keyed by the key. */
export const modelKey = (model: string | null | undefined): string => (model === null || model === undefined ? 'default' : (KEY_OF_ID[model] ?? model))

export class UsageMonitor {
  private readonly o: UsageMonitorOptions
  private readonly now: () => Date
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void
  private lastFetch = 0
  private lastReason: string | null = null
  /**
   * Why the ENDPOINT is silent, kept apart from `lastReason`.
   *
   * `lastReason` is cleared by any successful sample, the SDK's included - and the SDK samples
   * only inside runs. So a run cleared the one field that was supposed to explain why nothing
   * refreshes BETWEEN runs, and the explanation vanished exactly when it stopped being obvious.
   * Measured: 390 samples, every one of them from the SDK, and `liveReason` reading null.
   */
  private endpointReason: string | null = null
  /** The reason logged last, so a refusal that repeats every three minutes is said once. */
  private saidReason: string | null = null
  /** Consecutive refusals; the wait between attempts doubles with each one. */
  private failures = 0
  /**
   * Set once the endpoint refuses for a reason no waiting fixes. From then on it is not asked
   * again: the flag lives in memory, so a restart - which is what a changed credential means -
   * gives it another try.
   */
  private closed = false
  private readonly resets = new Map<string, string>()
  private subscription: string | null = null
  private pendingFetch: Promise<void> | null = null

  constructor(opts: UsageMonitorOptions) {
    this.o = opts
    this.now = opts.now ?? ((): Date => new Date())
    this.log = opts.log ?? ((): void => {})
  }

  /** Records the SDK's usage response as samples; returns the windows it carried. */
  recordSdk(res: unknown, phase: SamplePhase, runId: string | null): WindowSample[] {
    const parsed = parseSdkUsage(res)
    this.subscription = parsed.subscription
    if (!parsed.available) {
      this.lastReason = parsed.reason
      return []
    }
    this.lastReason = null
    const ts = this.now().toISOString()
    for (const w of parsed.windows) this.o.store.record({ ts, window: w.window, utilization: w.utilization, resetsAt: w.resetsAt, runId, phase, source: 'sdk' })
    return parsed.windows
  }

  /** Records a `rate_limit_event` when it carries a utilization; remembers the reset time either way. */
  recordEvent(info: unknown, runId: string | null): WindowSample | null {
    const reset = eventReset(info)
    if (reset) this.resets.set(reset.window, reset.resetsAt)
    const w = parseRateLimitEvent(info)
    if (!w) return null
    this.o.store.record({ ts: this.now().toISOString(), window: w.window, utilization: w.utilization, resetsAt: w.resetsAt, runId, phase: 'event', source: 'event' })
    return w
  }

  /**
   * Records why the live source did or did not answer, and says it in the log the first time
   * and whenever it changes.
   *
   * It used to be recorded and never spoken. The endpoint is the ONLY source between runs -
   * the SDK samples inside a run - so a refusal here freezes the plan numbers at whatever the
   * last run saw, and `status()` hid that behind `available`, which stays true for a day after
   * any sample. A silent refusal that stops the only live source is worth one line.
   */
  private note(reason: string | null): void {
    if (isPermanentRefusal(reason)) {
      // Said once, then never asked again. It is a property of the credential, not a moment.
      this.closed = true
      this.lastReason = INFERENCE_ONLY
      this.endpointReason = INFERENCE_ONLY
      if (this.saidReason !== INFERENCE_ONLY) {
        this.saidReason = INFERENCE_ONLY
        this.log('info', `usage: the plan endpoint will not be asked again - ${INFERENCE_ONLY}`)
      }
      return
    }
    this.lastReason = reason
    this.endpointReason = reason
    this.failures = reason === null ? 0 : Math.min(this.failures + 1, MAX_BACKOFF_STEPS)
    if (reason === this.saidReason) return
    this.saidReason = reason
    if (reason === null) this.log('info', 'usage: the plan endpoint answers again')
    else this.log('warn', `usage: the plan endpoint is not answering - ${reason}`)
  }

  /** Fetches the endpoint when the latest endpoint sample is older than the cache; one flight at a time. */
  async refresh(force = false): Promise<void> {
    if (!this.o.fetchEndpoint || this.closed) return
    const cacheMs = this.o.cacheMs ?? 180_000
    /*
     * A refused endpoint is asked back less often, doubling up to half an hour. The one this
     * runs against answers "Rate limited. Please try again later." - asking it again every
     * three minutes cannot help and is part of the problem. A success clears the count.
     */
    const wait = cacheMs * 2 ** this.failures
    if (!force && this.now().getTime() - this.lastFetch < wait) return
    if (this.pendingFetch) return this.pendingFetch
    this.pendingFetch = (async (): Promise<void> => {
      this.lastFetch = this.now().getTime()
      try {
        const result = await this.o.fetchEndpoint!()
        if (!result.ok) {
          this.note(result.reason ?? 'the usage endpoint is unavailable')
          return
        }
        const parsed = parseEndpointUsage(result.json)
        if (!parsed.available) {
          this.note(parsed.reason)
          return
        }
        this.note(null)
        const ts = this.now().toISOString()
        for (const w of parsed.windows) this.o.store.record({ ts, window: w.window, utilization: w.utilization, resetsAt: w.resetsAt, runId: null, phase: 'tick', source: 'endpoint' })
      } catch (err) {
        this.note(`the usage endpoint failed: ${(err as Error).message}`)
      } finally {
        this.pendingFetch = null
      }
    })()
    return this.pendingFetch
  }

  /**
   * The newest sample per window taken before `startedAt` and at most `maxAgeMs` old: the
   * better "before" of a run, since the SDK's own first sample comes after the session's
   * first response (section 8.3). Short on purpose: whatever the account consumed in the
   * gap lands on the run (seen for real: an interactive session between two runs six
   * minutes apart), and the shift's runs follow each other within seconds. Null when any
   * of the two main windows is missing.
   */
  baseline(startedAt: string, maxAgeMs = BASELINE_MAX_AGE_MS): WindowSample[] | null {
    const startMs = Date.parse(startedAt)
    const by = new Map<string, UsageSample>()
    for (const s of this.o.store.list(500)) {
      if (s.ts >= startedAt || startMs - Date.parse(s.ts) > maxAgeMs) continue
      const prev = by.get(s.window)
      if (!prev || s.ts > prev.ts) by.set(s.window, s)
    }
    if (!by.has('five_hour') || !by.has('seven_day')) return null
    return [...by.values()].sort((a, b) => a.window.localeCompare(b.window)).map((s) => ({ window: s.window, utilization: s.utilization, resetsAt: s.resetsAt }))
  }

  /** The newest sample per window, with the source and time of the newest of them. */
  latest(): { windows: WindowSample[]; sampledAt: string | null; source: 'sdk' | 'event' | 'endpoint' | null; available: boolean } {
    const rows = this.o.store.latest()
    if (rows.length === 0) return { windows: [], sampledAt: null, source: null, available: false }
    const newest = rows.reduce((a, b) => (a.ts >= b.ts ? a : b))
    // A sample older than a day says nothing about now.
    const fresh = this.now().getTime() - Date.parse(newest.ts) < 24 * 3600_000
    return {
      windows: rows.map((s) => ({ window: s.window, utilization: s.utilization, resetsAt: s.resetsAt })),
      sampledAt: newest.ts,
      source: newest.source,
      available: fresh,
    }
  }

  private windowOf(name: string): WindowSample | undefined {
    return this.latest().windows.find((w) => w.window === name)
  }

  /** When a window resets: the latest sample's stamp, else the last event's; a past stamp counts as unknown. */
  private resetOf(name: string): string | null {
    const stamp = this.windowOf(name)?.resetsAt ?? this.resets.get(name) ?? null
    return stamp !== null && Date.parse(stamp) > this.now().getTime() ? stamp : null
  }

  /** Points per USD per model and window, medians over the last runs that carry both (D2). */
  calibration(): Calibration {
    const runs = this.o.runs.list({ limit: 400 }).filter((r) => isFellowRun(r) && r.planPctDelta && r.costUsd !== null && r.costUsd > 0.05)
    const byModel = new Map<string, { five: number[]; seven: number[] }>()
    for (const r of runs) {
      const model = modelKey(r.model)
      const bucket = byModel.get(model) ?? { five: [], seven: [] }
      if (bucket.five.length >= CALIBRATION_RUNS) continue
      const d = r.planPctDelta!
      if (d['five_hour'] !== undefined && d['five_hour'] > 0) bucket.five.push(d['five_hour'] / r.costUsd!)
      if (d['seven_day'] !== undefined && d['seven_day'] > 0) bucket.seven.push(d['seven_day'] / r.costUsd!)
      byModel.set(model, bucket)
    }
    const perModel: Record<string, { fiveHour: number | null; sevenDay: number | null; n: number }> = {}
    let ready = false
    for (const [model, b] of byModel) {
      const n = Math.max(b.five.length, b.seven.length)
      perModel[model] = { fiveHour: median(b.five), sevenDay: median(b.seven), n }
      if (b.seven.length >= CALIBRATION_MIN) ready = true
    }
    return { perModel, ready }
  }

  /** The points a run of `costUsd` on `model` would take, per window; null while uncalibrated for that model. */
  estimatePct(costUsd: number, model: string): { fiveHour: number | null; sevenDay: number | null } {
    const cal = this.calibration().perModel[modelKey(model)]
    if (!cal || cal.n < CALIBRATION_MIN) return { fiveHour: null, sevenDay: null }
    const round = (v: number | null): number | null => (v === null ? null : Math.round(v * costUsd * 100) / 100)
    return { fiveHour: round(cal.fiveHour), sevenDay: round(cal.sevenDay) }
  }

  /**
   * What has been spent SINCE the newest sample, in window percent, estimated.
   *
   * The windows are only ever measured inside a run - `usage()` needs an API response in the
   * session (measured: `server/src/cli/usageprobe.ts`) - and the endpoint that could fill the
   * gap is rate limited. So between samples the shown figure is not merely old, it is behind
   * by everything that has run since, and a reader has no way to tell whether that is nothing
   * or a night's work.
   *
   * This closes the gap without spending anything: each settled run's own cost, priced through
   * the same per-model calibration the gate uses. Null while the calibration is not ready -
   * an estimate nobody can check is worse than an honest gap.
   */
  sinceSample(): { readonly runs: number; readonly fiveHour: number | null; readonly sevenDay: number | null } {
    const at = this.latest().sampledAt
    if (at === null) return { runs: 0, fiveHour: null, sevenDay: null }
    const since = Date.parse(at)
    if (Number.isNaN(since)) return { runs: 0, fiveHour: null, sevenDay: null }
    // A run that STARTED before the sample is already in it; one that started after is not.
    const runs = this.o.runs.list({ limit: 200 }).filter((r) => r.costUsd !== null && r.costUsd > 0 && Date.parse(r.startedAt) > since)
    let five = 0
    let seven = 0
    let known = false
    for (const r of runs) {
      const est = this.estimatePct(r.costUsd!, r.model ?? '')
      if (est.fiveHour === null || est.sevenDay === null) continue
      known = true
      five += est.fiveHour
      seven += est.sevenDay
    }
    if (!known) return { runs: runs.length, fiveHour: null, sevenDay: null }
    return { runs: runs.length, fiveHour: Math.round(five * 10) / 10, sevenDay: Math.round(seven * 10) / 10 }
  }

  /** What the Fellows consumed in the current windows: points where measured, USD always. */
  consumption(): Consumption {
    const now = this.now().getTime()
    const weekReset = this.resetOf('seven_day')
    const fiveReset = this.resetOf('five_hour')
    const weekStart = weekReset ? Date.parse(weekReset) - WEEK_MS : now - WEEK_MS
    const fiveStart = fiveReset ? Date.parse(fiveReset) - FIVE_H_MS : now - FIVE_H_MS
    const runs = this.o.runs.list({ limit: 1000 }).filter(isFellowRun)
    let weekPct = 0
    let weekMeasured = false
    let weekUsd = 0
    let weekRuns = 0
    let fivePct = 0
    let fiveMeasured = false
    let fiveUsd = 0
    let fiveRuns = 0
    for (const r of runs) {
      const t = Date.parse(r.startedAt)
      if (t >= weekStart) {
        weekRuns++
        weekUsd += r.costUsd ?? 0
        if (r.planPctDelta?.['seven_day'] !== undefined) {
          weekPct += r.planPctDelta['seven_day']
          weekMeasured = true
        }
      }
      if (t >= fiveStart) {
        fiveRuns++
        fiveUsd += r.costUsd ?? 0
        if (r.planPctDelta?.['five_hour'] !== undefined) {
          fivePct += r.planPctDelta['five_hour']
          fiveMeasured = true
        }
      }
    }
    const r2 = (v: number): number => Math.round(v * 100) / 100
    return { weekPct: weekMeasured ? r2(weekPct) : null, fiveHourPct: fiveMeasured ? r2(fivePct) : null, weekUsd: r2(weekUsd), fiveHourUsd: r2(fiveUsd), weekRuns, fiveHourRuns: fiveRuns }
  }

  /**
   * The gate of section 8.4 as far as measurement allows (D4): the reserves against the
   * latest utilization, the shares against consumption plus the run's estimate, in points
   * when calibrated for the model and in USD-equivalent otherwise. Null = the run may start.
   */
  gate(ctx: GateContext): GateVerdict | null {
    const s = this.o.settings()
    const latest = this.latest()
    /*
     * A live grant lifts BOTH five-hour bounds to the same number (section 8.6). Both, because
     * either alone does nothing: a share of 90 still stops at a reserve of 60, and a reserve of
     * 90 still stops at a share of 15. The week is deliberately untouched - it is the bound
     * that survives every grant, and it is what makes a released afternoon a bounded decision.
     */
    const lifted = this.overrideNow()
    const reserve5h = lifted?.pct ?? s.reserve5hPct
    const share5h = lifted?.pct ?? s.researchShare5hPct
    /*
     * The week can be released too since 8.6a, and both of its bounds go together for the same
     * reason the five-hour ones do: a share of 90 still stops at a reserve of 80, and a reserve
     * of 90 still stops at a share of 10. What keeps this a bounded decision is not the week
     * surviving the grant any more - it is that the grant ends with the night (`grantWeek`).
     */
    const liftedWeek = this.weekOverrideNow()
    const reserveWeek = liftedWeek?.pct ?? s.reserveWeekPct
    const shareWeek = liftedWeek?.pct ?? s.researchShareWeekPct
    if (latest.available) {
      const five = latest.windows.find((w) => w.window === 'five_hour')
      if (five && five.utilization > reserve5h) {
        return { code: 'reserve', window: 'five_hour', reason: `the 5-hour window is at ${five.utilization}%, above the ${reserve5h}% reserve`, resetsAt: five.resetsAt }
      }
      const week = latest.windows.find((w) => w.window === 'seven_day')
      if (week && week.utilization > reserveWeek) {
        return { code: 'reserve', window: 'seven_day', reason: `the week is at ${week.utilization}%, above the ${reserveWeek}% reserve`, resetsAt: week.resetsAt }
      }
    }
    const c = this.consumption()
    const est = this.estimatePct(ctx.estCostUsd, ctx.model)
    const weekReset = this.resetOf('seven_day')
    const fiveReset = this.resetOf('five_hour')
    if (c.weekPct !== null && est.sevenDay !== null) {
      if (c.weekPct + est.sevenDay > shareWeek) {
        return { code: 'share', window: 'seven_day', reason: `the research share of the week is used up (${c.weekPct} of ${shareWeek} points, this step about ${est.sevenDay})`, resetsAt: weekReset }
      }
    } else if (c.weekUsd + ctx.estCostUsd > (shareWeek / 100) * s.planWeekUsd) {
      const budget = Math.round((shareWeek / 100) * s.planWeekUsd * 100) / 100
      return { code: 'share', window: 'seven_day', reason: `the research share of the week is used up (${c.weekUsd.toFixed(2)} of about ${budget} USD, this step about ${ctx.estCostUsd} USD)`, resetsAt: weekReset }
    }
    if (c.fiveHourPct !== null && est.fiveHour !== null) {
      if (c.fiveHourPct + est.fiveHour > share5h) {
        return { code: 'share', window: 'five_hour', reason: `the research share of this 5-hour window is used up (${c.fiveHourPct} of ${share5h} points, this step about ${est.fiveHour})`, resetsAt: fiveReset }
      }
    } else if (c.fiveHourUsd + ctx.estCostUsd > (share5h / 100) * s.plan5hUsd) {
      const budget = Math.round((share5h / 100) * s.plan5hUsd * 100) / 100
      return { code: 'share', window: 'five_hour', reason: `the research share of this 5-hour window is used up (${c.fiveHourUsd.toFixed(2)} of about ${budget} USD, this step about ${ctx.estCostUsd} USD)`, resetsAt: fiveReset }
    }
    return null
  }

  /** The live five-hour grant, or null. Expiry is a comparison, never a timer. */
  overrideNow(): PlanOverride | null {
    return this.o.overrides?.active('five_hour', this.now().toISOString()) ?? null
  }

  /**
   * Releases the rest of the current five-hour window to the Fellows, until that window resets.
   *
   * Refuses without a known reset instant: a grant with no end is exactly what this must never
   * become, and the plan's own `resets_at` is the only bound here that cannot be argued with.
   */
  grantFiveHour(): { readonly ok: true; readonly override: PlanOverride } | { readonly ok: false; readonly reason: string } {
    if (!this.o.overrides) return { ok: false, reason: 'no override store is wired' }
    const now = this.now()
    const live = this.o.overrides.active('five_hour', now.toISOString())
    if (live) return { ok: false, reason: `already released until ${live.expiresAt}` }
    const reset = this.resetOf('five_hour')
    if (reset === null) return { ok: false, reason: 'the 5-hour window has no known reset time yet; run something first so the plan reports one' }
    const expires = Date.parse(reset)
    if (Number.isNaN(expires) || expires <= now.getTime()) return { ok: false, reason: 'the 5-hour window has already reset; nothing to release' }
    const override = this.o.overrides.grant({ window: 'five_hour', pct: OVERRIDE_PCT, grantedAt: now.toISOString(), expiresAt: reset })
    this.log('warn', `usage: the 5-hour window is released to ${OVERRIDE_PCT}% until ${reset}`)
    return { ok: true, override }
  }

  /** Ends a live grant early. */
  revokeFiveHour(): PlanOverride | null {
    const ended = this.o.overrides?.revoke('five_hour', this.now().toISOString()) ?? null
    if (ended) this.log('info', 'usage: the 5-hour release was withdrawn')
    return ended
  }

  /** The live week grant, or null. Expiry is a comparison, never a timer. */
  weekOverrideNow(): PlanOverride | null {
    return this.o.overrides?.active('seven_day', this.now().toISOString()) ?? null
  }

  /**
   * Releases the week's two bounds for ONE NIGHT (SPEC section 8.6a).
   *
   * The week is the bound every other grant survives, which is what made a released afternoon
   * a bounded decision. Lifting it removes that backstop, so the bound moves rather than
   * disappearing: `expiresAt` is the end of the night window this is granted for, and never
   * the week's own reset, which can be seven days out. The decision at the banner is "let
   * tonight run", and the grant lasts exactly as long as that sentence is true.
   *
   * Refuses without an end instant for the same reason the five-hour grant does: an
   * open-ended release is the one thing this must never become.
   */
  grantWeek(nightEndsAt: string | null): { readonly ok: true; readonly override: PlanOverride } | { readonly ok: false; readonly reason: string } {
    if (!this.o.overrides) return { ok: false, reason: 'no override store is wired' }
    const now = this.now()
    const live = this.o.overrides.active('seven_day', now.toISOString())
    if (live) return { ok: false, reason: `the week is already released until ${live.expiresAt}` }
    if (nightEndsAt === null) return { ok: false, reason: 'the night window has no end to release until' }
    const ends = Date.parse(nightEndsAt)
    if (Number.isNaN(ends) || ends <= now.getTime()) return { ok: false, reason: 'that night has already ended; nothing to release' }
    const override = this.o.overrides.grant({ window: 'seven_day', pct: OVERRIDE_PCT, grantedAt: now.toISOString(), expiresAt: nightEndsAt })
    this.log('warn', `usage: the WEEK is released to ${OVERRIDE_PCT}% until ${nightEndsAt} - the reserve that survives every other grant`)
    return { ok: true, override }
  }

  /** Ends a live week grant early. */
  revokeWeek(): PlanOverride | null {
    const ended = this.o.overrides?.revoke('seven_day', this.now().toISOString()) ?? null
    if (ended) this.log('info', 'usage: the week release was withdrawn')
    return ended
  }

  /** Everything the dashboard shows (D7). */
  status(standardStep: { estCostUsd: number; model: AgentModel }): PlanStatus {
    const s = this.o.settings()
    const latest = this.latest()
    /*
     * The same lifted bound the gate reads. Without it the panel said "8 of 15 points" while
     * the gate was letting work through up to 90 - the number that decides whether tonight is
     * affordable, disagreeing with the one that actually decides it.
     */
    const lifted = this.overrideNow()
    const liftedWeek = this.weekOverrideNow()
    const calibration = this.calibration()
    const consumption = this.consumption()
    const est = this.estimatePct(standardStep.estCostUsd, standardStep.model)
    const points = consumption.weekPct !== null && est.sevenDay !== null
    const shareWeekPct = liftedWeek?.pct ?? s.researchShareWeekPct
    const weekShare = points ? shareWeekPct : (shareWeekPct / 100) * s.planWeekUsd
    const share5h = lifted?.pct ?? s.researchShare5hPct
    const fiveShare = points ? share5h : (share5h / 100) * s.plan5hUsd
    const weekUsed = points ? consumption.weekPct! : consumption.weekUsd
    const perStep = points ? est.sevenDay! : standardStep.estCostUsd
    return {
      available: latest.available,
      source: latest.source,
      reason: latest.available ? null : (this.lastReason ?? (this.o.fetchEndpoint ? 'no sample yet' : 'no plan windows on an API key; USD accounting')),
      /*
       * Why the numbers are not refreshing, even while they are still shown. `reason` above
       * only speaks when NOTHING is available, and a sample counts as available for a day -
       * so an endpoint that stopped answering left the screen showing hours-old percentages
       * with nothing to say about it.
       */
      liveReason: this.o.fetchEndpoint
        ? this.endpointReason
        : 'no plan windows on an API key; the numbers come from runs only',
      sinceSample: this.sinceSample(),
      override: ((): PlanStatus['override'] => {
        const live = this.overrideNow()
        return {
          enabled: s.fiveHourOverrideEnabled,
          active: live !== null,
          pct: live?.pct ?? OVERRIDE_PCT,
          expiresAt: live?.expiresAt ?? null,
        }
      })(),
      weekOverride: {
        enabled: s.weekOverrideEnabled,
        active: liftedWeek !== null,
        pct: liftedWeek?.pct ?? OVERRIDE_PCT,
        expiresAt: liftedWeek?.expiresAt ?? null,
      },
      subscription: s.planName !== '' ? s.planName : this.subscription,
      sampledAt: latest.sampledAt,
      windows: latest.windows,
      resets: Object.fromEntries(['five_hour', 'seven_day'].flatMap((w) => (this.resetOf(w) ? [[w, this.resetOf(w)!]] : []))),
      calibration,
      consumption,
      settings: s,
      shares: {
        unit: points ? 'points' : 'usd',
        week: Math.round(weekShare * 100) / 100,
        fiveHour: Math.round(fiveShare * 100) / 100,
        weekUsed: Math.round(weekUsed * 100) / 100,
        fiveHourUsed: Math.round((points ? consumption.fiveHourPct! : consumption.fiveHourUsd) * 100) / 100,
        stepsLeftWeek: perStep > 0 ? Math.max(0, Math.floor((weekShare - weekUsed) / perStep)) : null,
      },
      gate: this.gate({ estCostUsd: standardStep.estCostUsd, model: standardStep.model, kind: 'research-step' }),
    }
  }

  samples(limit = 200): UsageSample[] {
    return this.o.store.list(limit)
  }
}
