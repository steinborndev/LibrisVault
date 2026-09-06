/**
 * The run log: one persistent row per settled agent run (research, lint, hot cache, tag-fix,
 * domain backfill, …). Schema v12, plus the commit each run produced (v13).
 *
 * Why this exists alongside `maintenance_state` (v10): that table answers "when did the last
 * run of each KIND settle, and did it work" - one row per kind, upserted. It is the right
 * shape for the "what's due" head and the wrong shape for a history. A research run's topic,
 * lens, cost and duration used to live only in the runner's in-memory map, which is bounded
 * and dies with the process, so the Research screen had to reconstruct its own past from the
 * synthesis pages in the vault. Those carry topic and date, but no cost, no duration, and no
 * trace at all of a run that failed before writing anything.
 *
 * Operational state only (hard rule 1): losing this table costs history, never vault content.
 * The pages a run wrote are in git either way.
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

/** How many rows to keep per user. Pruned on write - a run a year old answers no question. */
export const RUN_HISTORY_LIMIT = 1000

export interface AgentRunRecord {
  readonly id: string
  readonly kind: string
  /** What the run was about when the kind alone does not say it (a research topic). */
  readonly label: string | null
  /** Research runs: the lens the run was started under. */
  readonly profileKey: string | null
  readonly ok: boolean
  readonly pages: readonly string[]
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly costUsd: number | null
  readonly error: string | null
  /**
   * The commit this run produced, or null when it committed nothing (a read-only kind, a
   * failure before any write, or a row written before schema v13).
   */
  readonly commitHash: string | null
  readonly startedAt: string
  readonly finishedAt: string
  /** The Fellow this run belonged to (schema v15), null for a run the user started by hand. */
  readonly agentId?: string | null
  /** The SDK model id the run was pinned to (schema v15), null when the runner's default ran. */
  readonly model?: string | null
  /** The proposal this run executed (schema v16), null for a manual step or a non-Fellow run. */
  readonly proposalId?: string | null
  /** The agent's final text, capped (schema v17); the recap's "what it found" reads it. */
  readonly answer?: string | null
}

/** How much of a run's answer the row keeps. */
export const ANSWER_CAP = 6000

export interface AgentRunQuery {
  /** Only runs of this kind (e.g. `research`). Omitted = every kind. */
  readonly kind?: string
  /** Newest first, capped by the caller. */
  readonly limit?: number
  /** Only runs of this Fellow. */
  readonly agentId?: string
  /** Only runs started at or after this ISO timestamp (the quota gate's day window). */
  readonly since?: string
}

/**
 * What the runner and the route depend on. An interface so the runner stays constructible
 * without a database (tests, and the memory fallback below).
 */
export interface AgentRunStore {
  record(run: AgentRunRecord): void
  list(query?: AgentRunQuery): AgentRunRecord[]
  /** Drops one settled run from the history; false when no such run is recorded. */
  remove(id: string): boolean
}

/** Non-persistent fallback: history lasts as long as the process. */
export class MemoryAgentRunStore implements AgentRunStore {
  private readonly runs = new Map<string, AgentRunRecord>()

  record(run: AgentRunRecord): void {
    this.runs.set(run.id, run)
  }

  list(query: AgentRunQuery = {}): AgentRunRecord[] {
    const rows = [...this.runs.values()]
      .filter((r) => query.kind === undefined || r.kind === query.kind)
      .filter((r) => query.agentId === undefined || r.agentId === query.agentId)
      .filter((r) => query.since === undefined || r.startedAt >= query.since)
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    return query.limit === undefined ? rows : rows.slice(0, query.limit)
  }

  remove(id: string): boolean {
    return this.runs.delete(id)
  }
}

interface Row {
  id: string
  kind: string
  label: string | null
  profile_key: string | null
  ok: number
  pages: string
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  error: string | null
  commit_hash: string | null
  started_at: string
  finished_at: string
  agent_id: string | null
  model: string | null
  proposal_id: string | null
  answer: string | null
}

function toRecord(row: Row): AgentRunRecord {
  let pages: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.pages)
    if (Array.isArray(parsed)) pages = parsed as string[]
  } catch {
    /* a corrupt page list must not hide the run it belongs to */
  }
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    profileKey: row.profile_key,
    ok: row.ok === 1,
    pages,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    error: row.error,
    commitHash: row.commit_hash,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    agentId: row.agent_id,
    model: row.model,
    proposalId: row.proposal_id,
    answer: row.answer,
  }
}

export class SqliteAgentRunStore implements AgentRunStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
    private readonly keep: number = RUN_HISTORY_LIMIT,
  ) {}

  /** Upsert by run id: a settle writes once, and a re-settle of the same id corrects it. */
  record(run: AgentRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs
           (id, user_id, kind, label, profile_key, ok, pages, tokens_in, tokens_out, cost_usd, error, commit_hash, started_at, finished_at, agent_id, model, proposal_id, answer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           label = excluded.label,
           profile_key = excluded.profile_key,
           ok = excluded.ok,
           pages = excluded.pages,
           tokens_in = excluded.tokens_in,
           tokens_out = excluded.tokens_out,
           cost_usd = excluded.cost_usd,
           error = excluded.error,
           commit_hash = excluded.commit_hash,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           agent_id = excluded.agent_id,
           model = excluded.model,
           proposal_id = excluded.proposal_id,
           answer = excluded.answer`,
      )
      .run(
        run.id,
        this.userId,
        run.kind,
        run.label,
        run.profileKey,
        run.ok ? 1 : 0,
        JSON.stringify(run.pages),
        run.tokensIn,
        run.tokensOut,
        run.costUsd,
        run.error,
        run.commitHash,
        run.startedAt,
        run.finishedAt,
        run.agentId ?? null,
        run.model ?? null,
        run.proposalId ?? null,
        run.answer === undefined || run.answer === null ? null : run.answer.slice(0, ANSWER_CAP),
      )
    this.prune()
  }

  list(query: AgentRunQuery = {}): AgentRunRecord[] {
    let where = query.kind === undefined ? '' : ' AND kind = ?'
    const params: Array<string | number> = [this.userId]
    if (query.kind !== undefined) params.push(query.kind)
    if (query.agentId !== undefined) {
      where += ' AND agent_id = ?'
      params.push(query.agentId)
    }
    if (query.since !== undefined) {
      where += ' AND started_at >= ?'
      params.push(query.since)
    }
    const limit = query.limit ?? RUN_HISTORY_LIMIT
    params.push(limit)
    const rows = this.db
      .prepare(
        `SELECT id, kind, label, profile_key, ok, pages, tokens_in, tokens_out, cost_usd, error, commit_hash, started_at, finished_at, agent_id, model, proposal_id, answer
           FROM agent_runs
          WHERE user_id = ?${where}
          ORDER BY finished_at DESC
          LIMIT ?`,
      )
      .all(...params) as Row[]
    return rows.map(toRecord)
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM agent_runs WHERE id = ? AND user_id = ?').run(id, this.userId).changes > 0
  }

  /** Keeps the newest `keep` rows for this user; older history is not worth a query plan. */
  private prune(): void {
    this.db
      .prepare(
        `DELETE FROM agent_runs
          WHERE user_id = ?
            AND id NOT IN (
              SELECT id FROM agent_runs WHERE user_id = ? ORDER BY finished_at DESC LIMIT ?
            )`,
      )
      .run(this.userId, this.userId, this.keep)
  }
}
