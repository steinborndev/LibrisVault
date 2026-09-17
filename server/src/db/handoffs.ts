/**
 * Handoffs (docs/agents/SPEC.md section 6.6, docs/tasks/TASKS-A3.md D4 and D5): an open
 * question a planner judged to belong to another domain. Routed to the Fellow of that domain
 * it is a candidate for that Fellow's next planning run; without one it is an unclaimed
 * request the recap offers as a spawn. Schema v18. Service-side records only: a Fellow never
 * writes another Fellow's notebook.
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

export const HANDOFF_STATUSES = ['pending', 'proposed', 'unclaimed', 'expired'] as const
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number]

export interface HandoffRecord {
  readonly id: string
  readonly fromAgentId: string
  /** The Fellow the question was routed to; null while unclaimed. */
  readonly toAgentId: string | null
  readonly question: string
  readonly sourcePage: string | null
  /** The registry domain the planner named. */
  readonly domain: string
  readonly reason: string
  readonly createdAt: string
  readonly cycleDate: string
  readonly status: HandoffStatus
  /** The proposal built from it, once the target's planner picked it up. */
  readonly proposalId: string | null
  readonly updatedAt: string
}

export type HandoffPatch = Partial<Pick<HandoffRecord, 'toAgentId' | 'status' | 'proposalId' | 'updatedAt'>>

export interface HandoffQuery {
  readonly status?: readonly HandoffStatus[]
  readonly toAgentId?: string
  readonly limit?: number
}

export interface HandoffStore {
  create(record: HandoffRecord): void
  get(id: string): HandoffRecord | undefined
  /** Newest first, capped. */
  list(query?: HandoffQuery): HandoffRecord[]
  update(id: string, patch: HandoffPatch): HandoffRecord | undefined
  /** Pending handoffs to a retired Fellow become unclaimed (section 5.2); returns how many. */
  unclaimTarget(agentId: string, now: string): number
  /** Pending and unclaimed handoffs older than `beforeCycle` expire; returns how many. */
  expire(beforeCycle: string, now: string): number
}

const sortRows = (rows: HandoffRecord[]): HandoffRecord[] => rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

export class MemoryHandoffStore implements HandoffStore {
  private readonly rows = new Map<string, HandoffRecord>()
  create(record: HandoffRecord): void {
    this.rows.set(record.id, record)
  }
  get(id: string): HandoffRecord | undefined {
    return this.rows.get(id)
  }
  list(query: HandoffQuery = {}): HandoffRecord[] {
    const rows = sortRows(
      [...this.rows.values()]
        .filter((r) => query.status === undefined || query.status.includes(r.status))
        .filter((r) => query.toAgentId === undefined || r.toAgentId === query.toAgentId),
    )
    return query.limit === undefined ? rows : rows.slice(0, query.limit)
  }
  update(id: string, patch: HandoffPatch): HandoffRecord | undefined {
    const prev = this.rows.get(id)
    if (!prev) return undefined
    const next = { ...prev, ...patch }
    this.rows.set(id, next)
    return next
  }
  unclaimTarget(agentId: string, now: string): number {
    let n = 0
    for (const r of this.rows.values()) {
      if (r.toAgentId === agentId && r.status === 'pending') {
        this.rows.set(r.id, { ...r, toAgentId: null, status: 'unclaimed', updatedAt: now })
        n++
      }
    }
    return n
  }
  expire(beforeCycle: string, now: string): number {
    let n = 0
    for (const r of this.rows.values()) {
      if ((r.status === 'pending' || r.status === 'unclaimed') && r.cycleDate < beforeCycle) {
        this.rows.set(r.id, { ...r, status: 'expired', updatedAt: now })
        n++
      }
    }
    return n
  }
}

interface Row {
  id: string
  from_agent_id: string
  to_agent_id: string | null
  question: string
  source_page: string | null
  domain: string
  reason: string
  created_at: string
  cycle_date: string
  status: string
  proposal_id: string | null
  updated_at: string
}

const COLUMNS = 'id, from_agent_id, to_agent_id, question, source_page, domain, reason, created_at, cycle_date, status, proposal_id, updated_at'

const toRecord = (r: Row): HandoffRecord => ({
  id: r.id,
  fromAgentId: r.from_agent_id,
  toAgentId: r.to_agent_id,
  question: r.question,
  sourcePage: r.source_page,
  domain: r.domain,
  reason: r.reason,
  createdAt: r.created_at,
  cycleDate: r.cycle_date,
  status: r.status as HandoffStatus,
  proposalId: r.proposal_id,
  updatedAt: r.updated_at,
})

export class SqliteHandoffStore implements HandoffStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  create(r: HandoffRecord): void {
    this.db
      .prepare(`INSERT INTO handoffs (${COLUMNS}, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.fromAgentId, r.toAgentId, r.question, r.sourcePage, r.domain, r.reason, r.createdAt, r.cycleDate, r.status, r.proposalId, r.updatedAt, this.userId)
  }

  get(id: string): HandoffRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM handoffs WHERE id = ? AND user_id = ?`).get(id, this.userId) as Row | undefined
    return row ? toRecord(row) : undefined
  }

  list(query: HandoffQuery = {}): HandoffRecord[] {
    const clauses = ['user_id = ?']
    const params: Array<string | number> = [this.userId]
    if (query.status !== undefined && query.status.length > 0) {
      clauses.push(`status IN (${query.status.map(() => '?').join(', ')})`)
      params.push(...query.status)
    }
    if (query.toAgentId !== undefined) {
      clauses.push('to_agent_id = ?')
      params.push(query.toAgentId)
    }
    params.push(query.limit ?? 200)
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM handoffs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as Row[]
    return rows.map(toRecord)
  }

  update(id: string, patch: HandoffPatch): HandoffRecord | undefined {
    const prev = this.get(id)
    if (!prev) return undefined
    const next: HandoffRecord = { ...prev, ...patch }
    this.db
      .prepare('UPDATE handoffs SET to_agent_id = ?, status = ?, proposal_id = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(next.toAgentId, next.status, next.proposalId, next.updatedAt, id, this.userId)
    return next
  }

  unclaimTarget(agentId: string, now: string): number {
    return this.db
      .prepare(`UPDATE handoffs SET to_agent_id = NULL, status = 'unclaimed', updated_at = ? WHERE to_agent_id = ? AND status = 'pending' AND user_id = ?`)
      .run(now, agentId, this.userId).changes
  }

  expire(beforeCycle: string, now: string): number {
    return this.db
      .prepare(`UPDATE handoffs SET status = 'expired', updated_at = ? WHERE status IN ('pending', 'unclaimed') AND cycle_date < ? AND user_id = ?`)
      .run(now, beforeCycle, this.userId).changes
  }
}
