/**
 * Plan utilization samples (docs/agents/SPEC.md section 8.3, milestone A5): one row per
 * window per sample, taken before and after Fellow runs through the SDK, from rate-limit
 * events, or from the usage endpoint on a tick. Schema v20. Operational state only.
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

export type SamplePhase = 'before' | 'after' | 'tick' | 'event'
export type SampleSource = 'sdk' | 'event' | 'endpoint'

export interface UsageSample {
  readonly ts: string
  /** `five_hour`, `seven_day`, `seven_day_sonnet`, `seven_day_opus`, `model:<name>`, ... */
  readonly window: string
  /** 0 to 100. */
  readonly utilization: number
  readonly resetsAt: string | null
  readonly runId: string | null
  readonly phase: SamplePhase
  readonly source: SampleSource
}

export interface UsageSampleStore {
  record(sample: UsageSample): void
  /** Newest first, capped. */
  list(limit?: number): UsageSample[]
  /** The newest sample per window. */
  latest(): UsageSample[]
  /** Samples of one run, oldest first. */
  ofRun(runId: string): UsageSample[]
}

export class MemoryUsageSampleStore implements UsageSampleStore {
  private readonly rows: UsageSample[] = []
  record(sample: UsageSample): void {
    this.rows.push(sample)
    if (this.rows.length > 5000) this.rows.splice(0, this.rows.length - 5000)
  }
  list(limit = 200): UsageSample[] {
    return [...this.rows].reverse().slice(0, limit)
  }
  latest(): UsageSample[] {
    const by = new Map<string, UsageSample>()
    for (const s of this.rows) {
      const prev = by.get(s.window)
      if (!prev || s.ts >= prev.ts) by.set(s.window, s)
    }
    return [...by.values()]
  }
  ofRun(runId: string): UsageSample[] {
    return this.rows.filter((s) => s.runId === runId)
  }
}

interface Row {
  ts: string
  window: string
  utilization: number
  resets_at: string | null
  run_id: string | null
  phase: string
  source: string
}

const toSample = (r: Row): UsageSample => ({ ts: r.ts, window: r.window, utilization: r.utilization, resetsAt: r.resets_at, runId: r.run_id, phase: r.phase as SamplePhase, source: r.source as SampleSource })

export class SqliteUsageSampleStore implements UsageSampleStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  record(s: UsageSample): void {
    this.db
      .prepare('INSERT INTO usage_samples (user_id, ts, window, utilization, resets_at, run_id, phase, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.userId, s.ts, s.window, s.utilization, s.resetsAt, s.runId, s.phase, s.source)
    // Bounded: a sample a minute for a year is noise nobody reads.
    this.db.prepare('DELETE FROM usage_samples WHERE user_id = ? AND id NOT IN (SELECT id FROM usage_samples WHERE user_id = ? ORDER BY id DESC LIMIT 5000)').run(this.userId, this.userId)
  }

  list(limit = 200): UsageSample[] {
    const rows = this.db.prepare('SELECT ts, window, utilization, resets_at, run_id, phase, source FROM usage_samples WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT ?').all(this.userId, limit) as Row[]
    return rows.map(toSample)
  }

  latest(): UsageSample[] {
    const rows = this.db
      .prepare(
        `SELECT ts, window, utilization, resets_at, run_id, phase, source FROM usage_samples
          WHERE user_id = ? AND id IN (SELECT MAX(id) FROM usage_samples WHERE user_id = ? GROUP BY window)`,
      )
      .all(this.userId, this.userId) as Row[]
    return rows.map(toSample)
  }

  ofRun(runId: string): UsageSample[] {
    const rows = this.db.prepare('SELECT ts, window, utilization, resets_at, run_id, phase, source FROM usage_samples WHERE user_id = ? AND run_id = ? ORDER BY id').all(this.userId, runId) as Row[]
    return rows.map(toSample)
  }
}

/**
 * A grant that lifts a plan window's bounds for the rest of that window (SPEC section 8.6).
 *
 * The row IS the record: granting writes one, the gate reads the newest live one, and the
 * history of what was released and until when is the table itself. Nothing renews a grant -
 * it expires with the window it was written for, which is the one bound that cannot be
 * argued with, because the plan draws it.
 */
export interface PlanOverride {
  readonly id: number
  readonly window: string
  /** The percent both five-hour bounds are lifted to while this is live. */
  readonly pct: number
  readonly grantedAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
}

interface OverrideRow {
  id: number
  window: string
  pct: number
  granted_at: string
  expires_at: string
  revoked_at: string | null
}

const toOverride = (r: OverrideRow): PlanOverride => ({
  id: r.id,
  window: r.window,
  pct: r.pct,
  grantedAt: r.granted_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
})

export interface PlanOverrideStore {
  /** The live grant for a window at `now`, or undefined. */
  active(window: string, now: string): PlanOverride | undefined
  grant(input: { window: string; pct: number; grantedAt: string; expiresAt: string }): PlanOverride
  /** Ends a live grant early; returns what it ended. */
  revoke(window: string, now: string): PlanOverride | undefined
  list(limit?: number): PlanOverride[]
}

export class SqlitePlanOverrideStore implements PlanOverrideStore {
  constructor(
    private readonly db: Db,
    private readonly userId = 'local',
  ) {}

  active(window: string, now: string): PlanOverride | undefined {
    const row = this.db
      .prepare(
        `SELECT id, window, pct, granted_at, expires_at, revoked_at FROM plan_overrides
         WHERE user_id = ? AND window = ? AND expires_at > ? AND revoked_at IS NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(this.userId, window, now) as OverrideRow | undefined
    return row ? toOverride(row) : undefined
  }

  grant(input: { window: string; pct: number; grantedAt: string; expiresAt: string }): PlanOverride {
    const info = this.db
      .prepare('INSERT INTO plan_overrides (user_id, window, pct, granted_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(this.userId, input.window, input.pct, input.grantedAt, input.expiresAt)
    return { id: Number(info.lastInsertRowid), window: input.window, pct: input.pct, grantedAt: input.grantedAt, expiresAt: input.expiresAt, revokedAt: null }
  }

  revoke(window: string, now: string): PlanOverride | undefined {
    const live = this.active(window, now)
    if (!live) return undefined
    this.db.prepare('UPDATE plan_overrides SET revoked_at = ? WHERE id = ? AND user_id = ?').run(now, live.id, this.userId)
    return { ...live, revokedAt: now }
  }

  list(limit = 20): PlanOverride[] {
    const rows = this.db
      .prepare('SELECT id, window, pct, granted_at, expires_at, revoked_at FROM plan_overrides WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(this.userId, limit) as OverrideRow[]
    return rows.map(toOverride)
  }
}
