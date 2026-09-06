/**
 * Daily recaps (docs/agents/SPEC.md section 9, docs/tasks/TASKS-A2.md): one row per cycle
 * date holding the rendered model, the vault page path (null on a quiet day), what was
 * delivered where, and when the user answered. Schema v17. The vault page is rendering
 * only; this row is what the dashboard, Telegram and the answer path read.
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

export interface RecapDelivery {
  readonly dashboard?: string
  /** Chat ids the Telegram text reached, with the time. */
  readonly telegram?: { readonly chatIds: readonly number[]; readonly at: string }
}

export interface RecapRow<M = unknown> {
  readonly cycleDate: string
  readonly generatedAt: string
  /** Vault-relative page path, null on a quiet day. */
  readonly path: string | null
  readonly quiet: boolean
  readonly model: M
  readonly delivered: RecapDelivery
  readonly answeredAt: string | null
}

export interface RecapStore<M = unknown> {
  get(cycleDate: string): RecapRow<M> | undefined
  /** Newest first, capped. */
  list(limit?: number): RecapRow<M>[]
  put(row: RecapRow<M>): void
  update(cycleDate: string, patch: Partial<Pick<RecapRow<M>, 'delivered' | 'answeredAt' | 'model'>>): RecapRow<M> | undefined
}

export class MemoryRecapStore<M = unknown> implements RecapStore<M> {
  private readonly rows = new Map<string, RecapRow<M>>()
  get(cycleDate: string): RecapRow<M> | undefined {
    return this.rows.get(cycleDate)
  }
  list(limit = 30): RecapRow<M>[] {
    return [...this.rows.values()].sort((a, b) => b.cycleDate.localeCompare(a.cycleDate)).slice(0, limit)
  }
  put(row: RecapRow<M>): void {
    this.rows.set(row.cycleDate, row)
  }
  update(cycleDate: string, patch: Partial<Pick<RecapRow<M>, 'delivered' | 'answeredAt' | 'model'>>): RecapRow<M> | undefined {
    const prev = this.rows.get(cycleDate)
    if (!prev) return undefined
    const next = { ...prev, ...patch }
    this.rows.set(cycleDate, next)
    return next
  }
}

interface Row {
  cycle_date: string
  generated_at: string
  path: string | null
  quiet: number
  model: string
  delivered: string
  answered_at: string | null
}

function parse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function toRow<M>(row: Row): RecapRow<M> {
  return {
    cycleDate: row.cycle_date,
    generatedAt: row.generated_at,
    path: row.path,
    quiet: row.quiet === 1,
    model: parse<M>(row.model, {} as M),
    delivered: parse<RecapDelivery>(row.delivered, {}),
    answeredAt: row.answered_at,
  }
}

const COLUMNS = 'cycle_date, generated_at, path, quiet, model, delivered, answered_at'

export class SqliteRecapStore<M = unknown> implements RecapStore<M> {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  get(cycleDate: string): RecapRow<M> | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM recaps WHERE cycle_date = ? AND user_id = ?`).get(cycleDate, this.userId) as
      | Row
      | undefined
    return row ? toRow<M>(row) : undefined
  }

  list(limit = 30): RecapRow<M>[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM recaps WHERE user_id = ? ORDER BY cycle_date DESC LIMIT ?`)
      .all(this.userId, limit) as Row[]
    return rows.map((r) => toRow<M>(r))
  }

  put(r: RecapRow<M>): void {
    this.db
      .prepare(
        `INSERT INTO recaps (cycle_date, user_id, generated_at, path, quiet, model, delivered, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, cycle_date) DO UPDATE SET
           generated_at = excluded.generated_at, path = excluded.path, quiet = excluded.quiet,
           model = excluded.model, delivered = excluded.delivered, answered_at = excluded.answered_at`,
      )
      .run(r.cycleDate, this.userId, r.generatedAt, r.path, r.quiet ? 1 : 0, JSON.stringify(r.model), JSON.stringify(r.delivered), r.answeredAt)
  }

  update(cycleDate: string, patch: Partial<Pick<RecapRow<M>, 'delivered' | 'answeredAt' | 'model'>>): RecapRow<M> | undefined {
    const prev = this.get(cycleDate)
    if (!prev) return undefined
    const next: RecapRow<M> = { ...prev, ...patch }
    this.put(next)
    return next
  }
}
