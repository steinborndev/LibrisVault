/**
 * The Fellow record (docs/agents/SPEC.md section 5): a resident research agent's identity,
 * intent, home domain, model, step size, quota and state. Schema v15.
 *
 * Operational state only (hard rule 1). The user-facing text lives on the notebook page in
 * the vault (`wiki/meta/agents/<slug>.md`); this row is what the scheduler, the quota gate
 * and the card read. Losing the table loses settings, never vault content.
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

/** The closed model set a Fellow may run on, and the SDK model id each maps to. */
export const AGENT_MODELS = ['sonnet-5', 'opus-5', 'fable-5-1'] as const
export type AgentModel = (typeof AGENT_MODELS)[number]
export const MODEL_IDS: Readonly<Record<AgentModel, string>> = {
  'sonnet-5': 'claude-sonnet-5',
  'opus-5': 'claude-opus-5',
  'fable-5-1': 'claude-fable-5-1',
}
/**
 * Rough plan-usage factor per model against Sonnet 5, used to scale per-run budget caps
 * and to show the cost factor at spawn (docs/agents/SPEC.md section 7).
 */
export const MODEL_FACTOR: Readonly<Record<AgentModel, number>> = { 'sonnet-5': 1, 'opus-5': 2.5, 'fable-5-1': 5 }

export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgentEffort = (typeof AGENT_EFFORTS)[number]
export const AGENT_STEPS = ['small', 'standard', 'deep'] as const
export type AgentStep = (typeof AGENT_STEPS)[number]
export const AGENT_AUTONOMIES = ['manual', 'veto', 'auto'] as const
export type AgentAutonomy = (typeof AGENT_AUTONOMIES)[number]
export const AGENT_STATES = ['proposed', 'active', 'waiting', 'sleeping', 'paused', 'blocked', 'retired'] as const
export type AgentState = (typeof AGENT_STATES)[number]

export interface AgentRecord {
  readonly id: string
  readonly name: string
  /** URL- and filename-safe form of the name; names the notebook page. Unique per user. */
  readonly slug: string
  readonly intent: string
  readonly scope: string | null
  readonly homeDomain: string
  readonly extraDomains: readonly string[]
  readonly lens: string
  readonly model: AgentModel
  readonly effort: AgentEffort
  /** The largest step the planner may propose (section 7). */
  readonly step: AgentStep
  readonly quotaRunsPerDay: number
  readonly quotaWeekPct: number | null
  readonly autonomy: AgentAutonomy
  readonly priority: number
  readonly state: AgentState
  readonly sleepReason: string | null
  readonly notebookPath: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly retiredAt: string | null
}

export type AgentPatch = Partial<
  Pick<
    AgentRecord,
    | 'name'
    | 'intent'
    | 'scope'
    | 'homeDomain'
    | 'extraDomains'
    | 'lens'
    | 'model'
    | 'effort'
    | 'step'
    | 'quotaRunsPerDay'
    | 'quotaWeekPct'
    | 'autonomy'
    | 'priority'
    | 'state'
    | 'sleepReason'
    | 'retiredAt'
  >
>

export interface AgentStore {
  create(record: AgentRecord): void
  get(id: string): AgentRecord | undefined
  bySlug(slug: string): AgentRecord | undefined
  /** Every Fellow, retired ones last, then by creation. */
  list(): AgentRecord[]
  /** Applies the patch and bumps `updatedAt`; undefined when there is no such Fellow. */
  update(id: string, patch: AgentPatch, now?: string): AgentRecord | undefined
  remove(id: string): boolean
}

/** A filename-safe slug: lowercase, hyphens, no leading/trailing hyphen, at most 48 chars. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug === '' ? 'fellow' : slug
}

const stateRank = (s: AgentState): number => (s === 'retired' ? 1 : 0)

export class MemoryAgentStore implements AgentStore {
  private readonly rows = new Map<string, AgentRecord>()

  create(record: AgentRecord): void {
    if (this.bySlug(record.slug) !== undefined) throw new Error(`slug already taken: ${record.slug}`)
    this.rows.set(record.id, record)
  }
  get(id: string): AgentRecord | undefined {
    return this.rows.get(id)
  }
  bySlug(slug: string): AgentRecord | undefined {
    return [...this.rows.values()].find((r) => r.slug === slug)
  }
  list(): AgentRecord[] {
    return [...this.rows.values()].sort(
      (a, b) => stateRank(a.state) - stateRank(b.state) || a.createdAt.localeCompare(b.createdAt),
    )
  }
  update(id: string, patch: AgentPatch, now: string = new Date().toISOString()): AgentRecord | undefined {
    const prev = this.rows.get(id)
    if (!prev) return undefined
    const next: AgentRecord = { ...prev, ...patch, updatedAt: now }
    this.rows.set(id, next)
    return next
  }
  remove(id: string): boolean {
    return this.rows.delete(id)
  }
}

interface Row {
  id: string
  name: string
  slug: string
  intent: string
  scope: string | null
  home_domain: string
  extra_domains: string
  lens: string
  model: string
  effort: string
  step: string
  quota_runs_per_day: number
  quota_week_pct: number | null
  autonomy: string
  priority: number
  state: string
  sleep_reason: string | null
  notebook_path: string
  created_at: string
  updated_at: string
  retired_at: string | null
}

const COLUMNS =
  'id, name, slug, intent, scope, home_domain, extra_domains, lens, model, effort, step, quota_runs_per_day, ' +
  'quota_week_pct, autonomy, priority, state, sleep_reason, notebook_path, created_at, updated_at, retired_at'

function toRecord(row: Row): AgentRecord {
  let extra: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.extra_domains)
    if (Array.isArray(parsed)) extra = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    /* a corrupt list must not hide the Fellow */
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    intent: row.intent,
    scope: row.scope,
    homeDomain: row.home_domain,
    extraDomains: extra,
    lens: row.lens,
    model: row.model as AgentModel,
    effort: row.effort as AgentEffort,
    step: row.step as AgentStep,
    quotaRunsPerDay: row.quota_runs_per_day,
    quotaWeekPct: row.quota_week_pct,
    autonomy: row.autonomy as AgentAutonomy,
    priority: row.priority,
    state: row.state as AgentState,
    sleepReason: row.sleep_reason,
    notebookPath: row.notebook_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
  }
}

export class SqliteAgentStore implements AgentStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  create(r: AgentRecord): void {
    this.db
      .prepare(
        `INSERT INTO agents (${COLUMNS}, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.name,
        r.slug,
        r.intent,
        r.scope,
        r.homeDomain,
        JSON.stringify(r.extraDomains),
        r.lens,
        r.model,
        r.effort,
        r.step,
        r.quotaRunsPerDay,
        r.quotaWeekPct,
        r.autonomy,
        r.priority,
        r.state,
        r.sleepReason,
        r.notebookPath,
        r.createdAt,
        r.updatedAt,
        r.retiredAt,
        this.userId,
      )
  }

  get(id: string): AgentRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM agents WHERE id = ? AND user_id = ?`).get(id, this.userId) as
      | Row
      | undefined
    return row ? toRecord(row) : undefined
  }

  bySlug(slug: string): AgentRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM agents WHERE slug = ? AND user_id = ?`).get(slug, this.userId) as
      | Row
      | undefined
    return row ? toRecord(row) : undefined
  }

  list(): AgentRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM agents WHERE user_id = ? ORDER BY (state = 'retired'), created_at`)
      .all(this.userId) as Row[]
    return rows.map(toRecord)
  }

  update(id: string, patch: AgentPatch, now: string = new Date().toISOString()): AgentRecord | undefined {
    const prev = this.get(id)
    if (!prev) return undefined
    const next: AgentRecord = { ...prev, ...patch, updatedAt: now }
    this.db
      .prepare(
        `UPDATE agents SET name = ?, intent = ?, scope = ?, home_domain = ?, extra_domains = ?, lens = ?, model = ?,
           effort = ?, step = ?, quota_runs_per_day = ?, quota_week_pct = ?, autonomy = ?, priority = ?, state = ?,
           sleep_reason = ?, updated_at = ?, retired_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        next.name,
        next.intent,
        next.scope,
        next.homeDomain,
        JSON.stringify(next.extraDomains),
        next.lens,
        next.model,
        next.effort,
        next.step,
        next.quotaRunsPerDay,
        next.quotaWeekPct,
        next.autonomy,
        next.priority,
        next.state,
        next.sleepReason,
        next.updatedAt,
        next.retiredAt,
        id,
        this.userId,
      )
    return next
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').run(id, this.userId).changes > 0
  }
}
