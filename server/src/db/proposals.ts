/**
 * Proposals (docs/agents/SPEC.md sections 6.3 to 6.5): what a Fellow's planning run
 * suggests for its next step, what the user decides on in the veto window, and what the
 * night shift executes. Schema v16.
 *
 * Status model: `proposed` (undecided) - `approved` - `vetoed` - `executed` (a run started
 * for it; `run_id` names it) - `expired` (never executed within two cycles) - `superseded`
 * (a newer plan replaced it while it was still undecided). The notebook's Plan section is
 * rendered from these rows and never read back (section 5.4).
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

export const PROPOSAL_KINDS = ['research', 'research-step', 'research-expand'] as const
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]
export const PROPOSAL_STATUSES = ['proposed', 'approved', 'vetoed', 'executed', 'expired', 'superseded'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]
export const DECISION_CHANNELS = ['dashboard', 'telegram', 'auto'] as const
export type DecisionChannel = (typeof DECISION_CHANNELS)[number]

/** Where a proposal came from: the candidate the planner named and its source pages (6.3). */
export interface Provenance {
  /** The candidate's kind: `open-question`, `gap`, `stub`, `ingest`, `handoff`. */
  readonly candidate: string
  /** The candidate's text as it was shown to the planner. */
  readonly text: string
  /** Vault-relative pages the candidate was read from. */
  readonly sourcePages: readonly string[]
  /**
   * The Fellow's task this proposal was planned for (decision 2026-09-07). Stored here rather
   * than in a column because provenance is already the record of where a proposal came from,
   * and a task's wording can change under it without invalidating the row.
   */
  readonly task?: string
}

export interface ProposalRecord {
  readonly id: string
  readonly agentId: string
  readonly createdAt: string
  /** The cycle the proposal belongs to (docs/tasks/TASKS-A1.md D5). */
  readonly cycleDate: string
  readonly kind: ProposalKind
  readonly topic: string
  readonly lens: string
  readonly rationale: string
  readonly provenance: Provenance
  /** For `research-expand`: the pages the run may touch. Empty otherwise. */
  readonly pageSet: readonly string[]
  readonly estCostUsd: number | null
  /** Plan percent, once the usage monitor is calibrated (A5). */
  readonly estPlanPct: number | null
  /** Token overlap with the intent, 0 to 1 (section 6.4). */
  readonly scopeScore: number
  /** 1 = the planner's top pick. */
  readonly rank: number
  readonly status: ProposalStatus
  readonly decidedAt: string | null
  readonly decidedVia: DecisionChannel | null
  readonly userNote: string | null
  readonly runId: string | null
}

export type ProposalPatch = Partial<
  Pick<ProposalRecord, 'topic' | 'rank' | 'status' | 'decidedAt' | 'decidedVia' | 'userNote' | 'runId' | 'lens'>
>

export interface ProposalQuery {
  readonly agentId?: string
  readonly status?: readonly ProposalStatus[]
  /** Newest cycle first, then rank; capped. */
  readonly limit?: number
}

/** The statuses a proposal can still run from. */
export const PENDING_STATUSES: readonly ProposalStatus[] = ['proposed', 'approved']

export interface ProposalStore {
  create(record: ProposalRecord): void
  get(id: string): ProposalRecord | undefined
  list(query?: ProposalQuery): ProposalRecord[]
  update(id: string, patch: ProposalPatch): ProposalRecord | undefined
  /**
   * Moves still-undecided proposals of the Fellow to `superseded`; returns how many.
   *
   * `task` narrows it to the proposals that task asked for. A plan replaces the plan for the
   * SAME standing work, which is per task now that a Fellow can plan several in one night: a
   * whole-Fellow sweep let each run of a night's sweep wipe the one before it, and a night of
   * three planning runs ended with one task's worth of work.
   */
  supersede(agentId: string, task?: string): number
  /** Expires every pending proposal of the Fellow whose cycle date is before `beforeCycle`. */
  expire(agentId: string, beforeCycle: string): number
}

const statusOrder = (s: ProposalStatus): number => (s === 'approved' ? 0 : s === 'proposed' ? 1 : 2)

function sortRows(rows: ProposalRecord[]): ProposalRecord[] {
  return rows.sort(
    (a, b) =>
      statusOrder(a.status) - statusOrder(b.status) ||
      b.cycleDate.localeCompare(a.cycleDate) ||
      a.rank - b.rank ||
      a.createdAt.localeCompare(b.createdAt),
  )
}

export class MemoryProposalStore implements ProposalStore {
  private readonly rows = new Map<string, ProposalRecord>()

  create(record: ProposalRecord): void {
    this.rows.set(record.id, record)
  }
  get(id: string): ProposalRecord | undefined {
    return this.rows.get(id)
  }
  list(query: ProposalQuery = {}): ProposalRecord[] {
    const rows = sortRows(
      [...this.rows.values()]
        .filter((r) => query.agentId === undefined || r.agentId === query.agentId)
        .filter((r) => query.status === undefined || query.status.includes(r.status)),
    )
    return query.limit === undefined ? rows : rows.slice(0, query.limit)
  }
  update(id: string, patch: ProposalPatch): ProposalRecord | undefined {
    const prev = this.rows.get(id)
    if (!prev) return undefined
    const next = { ...prev, ...patch }
    this.rows.set(id, next)
    return next
  }
  supersede(agentId: string, task?: string): number {
    let n = 0
    for (const r of this.rows.values()) {
      if (r.agentId === agentId && r.status === 'proposed' && (task === undefined || r.provenance.task === task)) {
        this.rows.set(r.id, { ...r, status: 'superseded' })
        n++
      }
    }
    return n
  }
  expire(agentId: string, beforeCycle: string): number {
    let n = 0
    for (const r of this.rows.values()) {
      if (r.agentId === agentId && PENDING_STATUSES.includes(r.status) && r.cycleDate < beforeCycle) {
        this.rows.set(r.id, { ...r, status: 'expired' })
        n++
      }
    }
    return n
  }
}

interface Row {
  id: string
  agent_id: string
  created_at: string
  cycle_date: string
  kind: string
  topic: string
  lens: string
  rationale: string
  provenance: string
  page_set: string
  est_cost_usd: number | null
  est_plan_pct: number | null
  scope_score: number
  rank: number
  status: string
  decided_at: string | null
  decided_via: string | null
  user_note: string | null
  run_id: string | null
}

const COLUMNS =
  'id, agent_id, created_at, cycle_date, kind, topic, lens, rationale, provenance, page_set, est_cost_usd, ' +
  'est_plan_pct, scope_score, rank, status, decided_at, decided_via, user_note, run_id'

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function toRecord(row: Row): ProposalRecord {
  const prov = parseJson<Partial<Provenance>>(row.provenance, {})
  return {
    id: row.id,
    agentId: row.agent_id,
    createdAt: row.created_at,
    cycleDate: row.cycle_date,
    kind: row.kind as ProposalKind,
    topic: row.topic,
    lens: row.lens,
    rationale: row.rationale,
    provenance: {
      candidate: typeof prov.candidate === 'string' ? prov.candidate : 'unknown',
      text: typeof prov.text === 'string' ? prov.text : '',
      sourcePages: Array.isArray(prov.sourcePages) ? prov.sourcePages.filter((p): p is string => typeof p === 'string') : [],
      ...(typeof prov.task === 'string' && prov.task !== '' ? { task: prov.task } : {}),
    },
    pageSet: parseJson<unknown>(row.page_set, []) as string[],
    estCostUsd: row.est_cost_usd,
    estPlanPct: row.est_plan_pct,
    scopeScore: row.scope_score,
    rank: row.rank,
    status: row.status as ProposalStatus,
    decidedAt: row.decided_at,
    decidedVia: row.decided_via as DecisionChannel | null,
    userNote: row.user_note,
    runId: row.run_id,
  }
}

export class SqliteProposalStore implements ProposalStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  create(r: ProposalRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_proposals (${COLUMNS}, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.agentId,
        r.createdAt,
        r.cycleDate,
        r.kind,
        r.topic,
        r.lens,
        r.rationale,
        JSON.stringify(r.provenance),
        JSON.stringify(r.pageSet),
        r.estCostUsd,
        r.estPlanPct,
        r.scopeScore,
        r.rank,
        r.status,
        r.decidedAt,
        r.decidedVia,
        r.userNote,
        r.runId,
        this.userId,
      )
  }

  get(id: string): ProposalRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM agent_proposals WHERE id = ? AND user_id = ?`).get(id, this.userId) as
      | Row
      | undefined
    return row ? toRecord(row) : undefined
  }

  list(query: ProposalQuery = {}): ProposalRecord[] {
    const clauses = ['user_id = ?']
    const params: Array<string | number> = [this.userId]
    if (query.agentId !== undefined) {
      clauses.push('agent_id = ?')
      params.push(query.agentId)
    }
    if (query.status !== undefined && query.status.length > 0) {
      clauses.push(`status IN (${query.status.map(() => '?').join(', ')})`)
      params.push(...query.status)
    }
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM agent_proposals WHERE ${clauses.join(' AND ')}`)
      .all(...params) as Row[]
    const sorted = sortRows(rows.map(toRecord))
    return query.limit === undefined ? sorted : sorted.slice(0, query.limit)
  }

  update(id: string, patch: ProposalPatch): ProposalRecord | undefined {
    const prev = this.get(id)
    if (!prev) return undefined
    const next: ProposalRecord = { ...prev, ...patch }
    this.db
      .prepare(
        `UPDATE agent_proposals SET topic = ?, lens = ?, rank = ?, status = ?, decided_at = ?, decided_via = ?, user_note = ?, run_id = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(next.topic, next.lens, next.rank, next.status, next.decidedAt, next.decidedVia, next.userNote, next.runId, id, this.userId)
    return next
  }

  supersede(agentId: string, task?: string): number {
    // The task lives inside the provenance JSON; `json_extract` keeps it there rather than
    // adding a column that would have to be kept in step with it.
    const sql = `UPDATE agent_proposals SET status = 'superseded' WHERE agent_id = ? AND user_id = ? AND status = 'proposed'${
      task === undefined ? '' : ` AND json_extract(provenance, '$.task') = ?`
    }`
    const args: unknown[] = [agentId, this.userId]
    if (task !== undefined) args.push(task)
    return this.db.prepare(sql).run(...args).changes
  }

  expire(agentId: string, beforeCycle: string): number {
    return this.db
      .prepare(
        `UPDATE agent_proposals SET status = 'expired'
          WHERE agent_id = ? AND user_id = ? AND status IN ('proposed', 'approved') AND cycle_date < ?`,
      )
      .run(agentId, this.userId, beforeCycle).changes
  }
}
