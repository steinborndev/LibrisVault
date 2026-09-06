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
