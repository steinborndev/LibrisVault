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
/**
 * What a Fellow may hold. One art, or `custom` for any mix (docs/tasks/TASKS-A7.md D7): the
 * art belongs to a TASK, and this is the constraint on which arts its tasks may be.
 */
export const AGENT_ARTS = ['watch', 'explore', 'deepen', 'custom'] as const
export type AgentArt = (typeof AGENT_ARTS)[number]
/**
 * How much of a night a Fellow works. `sweep` takes every standing task, so every night
 * delivers a result for each of them; `rotate` takes one in turn, which means each comes round
 * every N nights (A7 D8).
 */
export const AGENT_NIGHTLY = ['sweep', 'rotate'] as const
export type AgentNightly = (typeof AGENT_NIGHTLY)[number]
export type AgentAutonomy = (typeof AGENT_AUTONOMIES)[number]
export const AGENT_STATES = ['proposed', 'active', 'waiting', 'sleeping', 'paused', 'blocked', 'retired'] as const
export type AgentState = (typeof AGENT_STATES)[number]
/**
 * Why a Fellow sleeps (docs/tasks/TASKS-A1.md D6). The night shift reads it to decide
 * whether to plan the Fellow again: `idle`, `quota`, `budget`, `no-candidates` and
 * `plan-failed` are planned every night; `covered` and `stalled` only on a wake trigger.
 * `plan` means the plan window refused the run, `plan-failed` that the planner answered
 * twice in a shape the service could not use - a fault, not a quiet night, so the screen
 * marks it.
 */
export const AGENT_SLEEP_CODES = ['idle', 'quota', 'budget', 'plan', 'plan-failed', 'no-candidates', 'covered', 'stalled'] as const
export type AgentSleepCode = (typeof AGENT_SLEEP_CODES)[number]

/** What a Fellow keeps doing, and how (docs/agents/ideas.md, decision 2026-09-07). */
export const TASK_KINDS = ['watch', 'explore', 'deepen'] as const
export type TaskKind = (typeof TASK_KINDS)[number]
/** More than three starves the tail: at one run a day the fourth comes up twice a fortnight. */
export const MAX_TASKS = 3

export interface AgentTask {
  readonly id: string
  /** One sentence: the question, the thing to watch, or the theme to build out. */
  readonly text: string
  readonly kind: TaskKind
  /**
   * `resting` = the planner reported this task answered as far as the library can take it.
   * Only an `explore` task can reach it: a watch or a deepen is standing work, and standing
   * work that declares itself finished is a bug.
   */
  readonly state: 'active' | 'resting'
}

/** A task as it comes in from the API, before it gets its id. */
export interface TaskInput {
  readonly text: string
  readonly kind: TaskKind
}

export interface AgentRecord {
  readonly id: string
  readonly name: string
  /** URL- and filename-safe form of the name; names the notebook page. Unique per user. */
  readonly slug: string
  /**
   * The first task's sentence, kept in step with `tasks[0]`. Every notebook page, recap and
   * prompt written before 2026-09-07 refers to it, so it stays the Fellow's one-line summary.
   */
  readonly intent: string
  readonly scope: string | null
  /** The standing work, one to three. Never empty: a Fellow without a task has nothing to do. */
  readonly tasks: readonly AgentTask[]
  /** Which task is up next; the planner takes them in turn and advances it. */
  readonly taskCursor: number
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
  /** The arts its tasks may be; `custom` allows any mix. */
  readonly art: AgentArt
  /** Every standing task each night, or one in turn. */
  readonly nightly: AgentNightly
  readonly priority: number
  readonly state: AgentState
  readonly sleepReason: string | null
  /** Machine-readable sleep reason (v16); null unless the state is `sleeping`. */
  readonly sleepCode: AgentSleepCode | null
  /** "Skip tonight" (v17): the shift of this cycle date runs nothing for the Fellow. */
  readonly skipUntil: string | null
  readonly notebookPath: string
  /**
   * The desk the Fellow keeps in the Library's main room, 0 to 9 (v31, 2026-09-17): given at
   * spawn as the lowest free one, freed at retirement, null once retired. The room has ten,
   * which is why a spawn is refused when all ten are taken (`FellowService.spawn`).
   */
  readonly desk: number | null
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
    | 'tasks'
    | 'taskCursor'
    | 'homeDomain'
    | 'extraDomains'
    | 'lens'
    | 'model'
    | 'effort'
    | 'step'
    | 'quotaRunsPerDay'
    | 'quotaWeekPct'
    | 'autonomy'
    | 'art'
    | 'nightly'
    | 'priority'
    | 'state'
    | 'sleepReason'
    | 'sleepCode'
    | 'skipUntil'
    | 'desk'
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
  art: string | null
  nightly: string | null
  priority: number
  state: string
  sleep_reason: string | null
  sleep_code: string | null
  skip_until: string | null
  notebook_path: string
  created_at: string
  updated_at: string
  retired_at: string | null
  tasks: string | null
  task_cursor: number | null
  desk: number | null
}

const COLUMNS =
  'id, name, slug, intent, scope, home_domain, extra_domains, lens, model, effort, step, quota_runs_per_day, ' +
  'quota_week_pct, autonomy, priority, state, sleep_reason, sleep_code, skip_until, notebook_path, created_at, updated_at, retired_at, ' +
  'tasks, task_cursor, art, nightly, desk'

/** The stored list, or the intent as one explore task when it is missing or corrupt. */
export function parseTasks(raw: string | null | undefined, intent: string): AgentTask[] {
  const fallback = (): AgentTask[] => [{ id: 't1', text: intent, kind: 'explore', state: 'active' }]
  if (raw === null || raw === undefined || raw === '') return fallback()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback()
  }
  if (!Array.isArray(parsed)) return fallback()
  const out: AgentTask[] = []
  for (const t of parsed) {
    if (t === null || typeof t !== 'object') continue
    const r = t as Record<string, unknown>
    const text = typeof r['text'] === 'string' ? r['text'].trim() : ''
    if (text === '') continue
    const kind = TASK_KINDS.includes(r['kind'] as TaskKind) ? (r['kind'] as TaskKind) : 'explore'
    out.push({
      id: typeof r['id'] === 'string' && r['id'] !== '' ? r['id'] : `t${out.length + 1}`,
      text,
      kind,
      // Only an explore task may rest; anything else read back as resting is a stored mistake.
      state: r['state'] === 'resting' && kind === 'explore' ? 'resting' : 'active',
    })
    if (out.length >= MAX_TASKS) break
  }
  return out.length > 0 ? out : fallback()
}

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
    // A Fellow whose task list is missing or unreadable still has its intent, and a Fellow with
    // nothing to do is worse than one working from a single sentence.
    tasks: parseTasks(row.tasks, row.intent),
    taskCursor: row.task_cursor ?? 0,
    homeDomain: row.home_domain,
    extraDomains: extra,
    lens: row.lens,
    model: row.model as AgentModel,
    effort: row.effort as AgentEffort,
    step: row.step as AgentStep,
    quotaRunsPerDay: row.quota_runs_per_day,
    quotaWeekPct: row.quota_week_pct,
    autonomy: row.autonomy as AgentAutonomy,
    // A value the column does not know falls back rather than propagating: `custom` allows
    // whatever the task list already is, and `sweep` is the decided default (A7 D8).
    art: AGENT_ARTS.includes(row.art as AgentArt) ? (row.art as AgentArt) : 'custom',
    nightly: AGENT_NIGHTLY.includes(row.nightly as AgentNightly) ? (row.nightly as AgentNightly) : 'sweep',
    priority: row.priority,
    state: row.state as AgentState,
    sleepReason: row.sleep_reason,
    sleepCode: row.sleep_code as AgentSleepCode | null,
    skipUntil: row.skip_until,
    notebookPath: row.notebook_path,
    desk: row.desk,
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        r.sleepCode,
        r.skipUntil,
        r.notebookPath,
        r.createdAt,
        r.updatedAt,
        r.retiredAt,
        JSON.stringify(r.tasks),
        r.taskCursor,
        r.art,
        r.nightly,
        r.desk,
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

  /** Active first, then by creation - and by insertion within one millisecond, which a tie on
   *  `created_at` left to SQLite's choice (seen as a flaky desk test, 2026-09-25). */
  list(): AgentRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM agents WHERE user_id = ? ORDER BY (state = 'retired'), created_at, rowid`)
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
           sleep_reason = ?, sleep_code = ?, skip_until = ?, updated_at = ?, retired_at = ?,
           tasks = ?, task_cursor = ?, art = ?, nightly = ?, desk = ?
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
        next.sleepCode,
        next.skipUntil,
        next.updatedAt,
        next.retiredAt,
        JSON.stringify(next.tasks),
        next.taskCursor,
        next.art,
        next.nightly,
        next.desk,
        id,
        this.userId,
      )
    return next
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').run(id, this.userId).changes > 0
  }
}
