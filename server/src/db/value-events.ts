/**
 * The value signal (docs/agents/SPEC.md section 9.6, review decision OPEN-18): two locally
 * counted events, a Fellow's page opened in the dashboard and a recap link followed, each
 * attributed to the Fellow whose page it is. Nothing leaves the machine. Schema v17.
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

export const VALUE_EVENT_KINDS = ['page_open', 'recap_link'] as const
export type ValueEventKind = (typeof VALUE_EVENT_KINDS)[number]

export interface ValueEvent {
  readonly ts: string
  readonly kind: ValueEventKind
  readonly agentId: string | null
  readonly page: string | null
}

export interface ValueCounts {
  readonly pageOpens: number
  readonly recapLinks: number
}

export interface ValueEventStore {
  record(event: ValueEvent): void
  /** Counts since `sinceIso`, for one Fellow or (undefined) for every event. */
  counts(sinceIso: string, agentId?: string): ValueCounts
}

const count = (events: readonly ValueEvent[]): ValueCounts => ({
  pageOpens: events.filter((e) => e.kind === 'page_open').length,
  recapLinks: events.filter((e) => e.kind === 'recap_link').length,
})

export class MemoryValueEventStore implements ValueEventStore {
  private readonly events: ValueEvent[] = []
  record(event: ValueEvent): void {
    this.events.push(event)
  }
  counts(sinceIso: string, agentId?: string): ValueCounts {
    return count(this.events.filter((e) => e.ts >= sinceIso && (agentId === undefined || e.agentId === agentId)))
  }
}

export class SqliteValueEventStore implements ValueEventStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  record(e: ValueEvent): void {
    this.db
      .prepare('INSERT INTO value_events (user_id, ts, kind, agent_id, page) VALUES (?, ?, ?, ?, ?)')
      .run(this.userId, e.ts, e.kind, e.agentId, e.page)
  }

  counts(sinceIso: string, agentId?: string): ValueCounts {
    const where = agentId === undefined ? '' : ' AND agent_id = ?'
    const params: string[] = [this.userId, sinceIso]
    if (agentId !== undefined) params.push(agentId)
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(kind = 'page_open'), 0) AS opens,
           COALESCE(SUM(kind = 'recap_link'), 0) AS links
         FROM value_events WHERE user_id = ? AND ts >= ?${where}`,
      )
      .get(...params) as { opens: number; links: number }
    return { pageOpens: row.opens, recapLinks: row.links }
  }
}
