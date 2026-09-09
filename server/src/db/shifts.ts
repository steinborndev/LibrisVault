/**
 * Night shifts (docs/agents/SPEC.md section 4.2, docs/tasks/TASKS-A1.md D4): one row per
 * cycle date, written when a shift starts and completed when it ends. The scheduler reads
 * it to never run a second shift in the same night after a restart; the recap (A2) reads
 * the summary. Schema v16. Operational state only.
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

export type ShiftTrigger = 'timer' | 'manual'

export interface ShiftExecution {
  readonly agentId: string
  readonly agentName: string
  readonly proposalId: string | null
  readonly runId: string
  readonly kind: string
  readonly topic: string
  readonly ok: boolean
  readonly pages: number
  readonly costUsd: number | null
  readonly error: string | null
}

export interface ShiftPlanning {
  readonly agentId: string
  readonly agentName: string
  readonly runId: string | null
  readonly ok: boolean
  readonly proposals: number
  readonly costUsd: number | null
  readonly note: string | null
}

export interface ShiftSkip {
  readonly agentId: string
  readonly agentName: string
  readonly reason: string
}

/** A near-duplicate the shift merged before running (section 6.6, A3). */
export interface ShiftMerge {
  readonly keptAgentName: string
  readonly keptTopic: string
  readonly droppedAgentName: string
  readonly droppedTopic: string
  readonly score: number
  /**
   * Which measure decided. `lexical` is the token-overlap pass; `judge` is the read-only run
   * that reads what a question asks. Recorded because they fail differently and the recap
   * should not present a model's judgement as a mechanical fact.
   */
  readonly by?: 'lexical' | 'judge'
  /**
   * Set when the judge saw a likely duplicate but not surely enough to merge it: the run
   * happened, and this is the note. A hedge costs a line, never a run.
   */
  readonly noted?: boolean
  /** The judge's own words, a dozen at most. Absent for the lexical pass, which has no reason. */
  readonly reason?: string
}

/** A pending topic that overlaps an existing synthesis page (noted, not dropped). */
export interface ShiftOverlap {
  readonly agentName: string
  readonly topic: string
  readonly page: string
  readonly score: number
}

export interface ShiftSummary {
  readonly executed: readonly ShiftExecution[]
  readonly planned: readonly ShiftPlanning[]
  readonly skipped: readonly ShiftSkip[]
  readonly costUsd: number
  readonly merged?: readonly ShiftMerge[]
  readonly overlaps?: readonly ShiftOverlap[]
  /**
   * Set when a restart closed this round rather than the round closing itself. Without it an
   * interrupted round is indistinguishable from one that ran and found nothing to do, which
   * is a very different claim about the night.
   */
  readonly interrupted?: true
}

export interface ShiftRecord {
  readonly cycleDate: string
  readonly trigger: ShiftTrigger
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly summary: ShiftSummary
}

export const EMPTY_SUMMARY: ShiftSummary = { executed: [], planned: [], skipped: [], costUsd: 0 }

export interface ShiftStore {
  /** The row for a cycle date, or undefined when no shift ran that night. */
  get(cycleDate: string): ShiftRecord | undefined
  /** Newest first, capped. */
  list(limit?: number): ShiftRecord[]
  /** Inserts or replaces the row for the record's cycle date. */
  put(record: ShiftRecord): void
}

export class MemoryShiftStore implements ShiftStore {
  private readonly rows = new Map<string, ShiftRecord>()
  get(cycleDate: string): ShiftRecord | undefined {
    return this.rows.get(cycleDate)
  }
  list(limit = 30): ShiftRecord[] {
    return [...this.rows.values()].sort((a, b) => b.cycleDate.localeCompare(a.cycleDate)).slice(0, limit)
  }
  put(record: ShiftRecord): void {
    this.rows.set(record.cycleDate, record)
  }
}

interface Row {
  cycle_date: string
  trigger: string
  started_at: string
  finished_at: string | null
  summary: string
}

function toRecord(row: Row): ShiftRecord {
  let summary: ShiftSummary = EMPTY_SUMMARY
  try {
    const parsed = JSON.parse(row.summary) as Partial<ShiftSummary>
    summary = {
      executed: Array.isArray(parsed.executed) ? parsed.executed : [],
      planned: Array.isArray(parsed.planned) ? parsed.planned : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
      costUsd: typeof parsed.costUsd === 'number' ? parsed.costUsd : 0,
      ...(Array.isArray(parsed.merged) ? { merged: parsed.merged } : {}),
      ...(Array.isArray(parsed.overlaps) ? { overlaps: parsed.overlaps } : {}),
      ...(parsed.interrupted === true ? { interrupted: true as const } : {}),
    }
  } catch {
    /* a corrupt summary must not hide the shift */
  }
  return { cycleDate: row.cycle_date, trigger: row.trigger as ShiftTrigger, startedAt: row.started_at, finishedAt: row.finished_at, summary }
}

export class SqliteShiftStore implements ShiftStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  get(cycleDate: string): ShiftRecord | undefined {
    const row = this.db
      .prepare('SELECT cycle_date, trigger, started_at, finished_at, summary FROM agent_shifts WHERE cycle_date = ? AND user_id = ?')
      .get(cycleDate, this.userId) as Row | undefined
    return row ? toRecord(row) : undefined
  }

  list(limit = 30): ShiftRecord[] {
    const rows = this.db
      .prepare('SELECT cycle_date, trigger, started_at, finished_at, summary FROM agent_shifts WHERE user_id = ? ORDER BY cycle_date DESC LIMIT ?')
      .all(this.userId, limit) as Row[]
    return rows.map(toRecord)
  }

  put(r: ShiftRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_shifts (cycle_date, user_id, trigger, started_at, finished_at, summary)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, cycle_date) DO UPDATE SET
           trigger = excluded.trigger, started_at = excluded.started_at, finished_at = excluded.finished_at, summary = excluded.summary`,
      )
      .run(r.cycleDate, this.userId, r.trigger, r.startedAt, r.finishedAt, JSON.stringify(r.summary))
  }
}
