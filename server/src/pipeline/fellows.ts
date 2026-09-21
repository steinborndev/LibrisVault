/**
 * The Fellow service (docs/agents/SPEC.md sections 5 to 8): spawn, step, plan, proposals and
 * decisions, pause, resume, retire, and the card. A Fellow's run is an ordinary sandboxed run
 * started through the maintenance runner, pinned to the Fellow's model and budget and
 * attributed to it; this service owns the record, the quota gate, the proposals and the
 * notebook. The night shift (`shift.ts`) drives it; the routes expose it.
 *
 * Milestone A1 added the planning run, the proposals with their veto-window decisions, the
 * sleep codes (docs/tasks/TASKS-A1.md D6) and the settle state machine (D8).
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  AGENT_EFFORTS,
  MODEL_FACTOR,
  MODEL_IDS,
  MAX_TASKS,
  TASK_KINDS,
  slugify,
  type AgentTask,
  type TaskInput,
  type AgentAutonomy,
  type AgentEffort,
  type AgentArt,
  type AgentModel,
  type AgentNightly,
  type AgentPatch,
  type AgentRecord,
  type AgentSleepCode,
  type AgentStep,
  type AgentStore,
} from '../db/agents.js'
import type { AgentRunRecord, AgentRunStore } from '../db/agent-runs.js'
import type { JobRow } from '../db/jobs.js'
import type { ValueCounts, ValueEventStore } from '../db/value-events.js'
import type { HandoffRecord, HandoffStore } from '../db/handoffs.js'
import { readDomainRegistry } from './domains.js'
import { fellowSynthesisPages } from './candidates.js'
import {
  PENDING_STATUSES,
  type DecisionChannel,
  type ProposalKind,
  type ProposalPatch,
  type ProposalRecord,
  type ProposalStore,
} from '../db/proposals.js'
import type { MaintenanceRunner, MaintenanceRun } from './maintenance.js'
import { PLAN_TIMEOUT_MS, EXPAND_TIMEOUT_MS } from './maintenance.js'
import { DEFAULT_TIMEOUT_MS } from './agent-runner.js'
import { notebookPath, renderLogLines, type NotebookNote, type NotebookWriter } from './notebook.js'
import { READING_LIST_PAGE, type ReadingEntry as ReadingEntryInput } from './reading-list.js'
import type { FellowRunContext } from './fellow-prompts.js'
import { startOfToday } from './budget.js'
import { SAMPLE_LIMIT } from './run-duration.js'
import type { CostSample } from './run-cost.js'
import { EXPAND_MANUAL_MAX_PAGES, expandBudgetUsd, expandTimeoutMs } from './expand.js'
import { parseFrontmatterMeta } from './graph.js'
import { computeCandidates, fellowDomains, knowledgePages, ownQuestionStreak, SELF_LOOP_LIMIT, type Candidate } from './candidates.js'
import { rankForDeepening } from './deepen-rank.js'
import { EXPAND_MAX_PAGES } from './expand.js'
import { localDate, addDays, windowAt, cycleAt, type WindowSpan } from './clock.js'
import type { VaultGraph } from './graph.js'
import {
  buildProposals,
  estimateCostUsd,
  isDrift,
  kindsForTask,
  parsePlannerAnswer,
  plannerSchema,
  renderPlanSection,
  renderPlannerPrompt,
  type DomainHint,
} from './planner.js'
import { byShelfThenPriority, type ShelfOrderStore } from '../db/shelf-order.js'
import type { GateContext } from './usage-monitor.js'
import { DEFAULT_NIGHT_WINDOW, DEFAULT_RESEARCH_MODEL } from '../db/settings.js'

/**
 * Whether a task list is one this Fellow may hold (docs/tasks/TASKS-A7.md D7).
 *
 * `custom` allows any mix; every other art allows only its own. The check exists because a
 * Fellow's art is a promise about what it will do - an observer that quietly accepted a
 * deepen task would be an observer in name only, and the name is what the user chose it by.
 */
export function artRefusal(art: AgentArt, tasks: readonly AgentTask[]): Refusal | null {
  if (art === 'custom') return null
  const wrong = tasks.filter((t) => t.kind !== art)
  if (wrong.length === 0) return null
  return {
    status: 409,
    code: 'kind',
    error: `this Fellow holds ${art} tasks only; ${wrong.map((t) => `"${t.text}" is ${t.kind}`).join(', ')}`,
  }
}

/**
 * The task list as it goes into the record: trimmed, empty ones dropped, capped at MAX_TASKS,
 * each with a stable id. Ids are positional (`t1`..`t3`) because the list is short and edited
 * whole; nothing outside a Fellow's own record refers to them.
 */
export function normalizeTasks(input: readonly TaskInput[]): AgentTask[] {
  const out: AgentTask[] = []
  for (const t of input) {
    const text = t.text.trim()
    if (text === '') continue
    out.push({ id: `t${out.length + 1}`, text, kind: TASK_KINDS.includes(t.kind) ? t.kind : 'explore', state: 'active' })
    if (out.length >= MAX_TASKS) break
  }
  return out
}

/**
 * The task the planner works tonight, and where the cursor lands next.
 *
 * Round robin over the ACTIVE tasks: a resting one is stepped over rather than removed, so it
 * stays visible on the card and can be replaced. Null when every task rests - that is what puts
 * the Fellow to sleep, rather than the first answered question doing it (docs/agents/ideas.md,
 * decision 2026-09-07).
 */
export function taskForTonight(tasks: readonly AgentTask[], cursor: number): { task: AgentTask; index: number; nextCursor: number } | null {
  if (tasks.length === 0) return null
  const start = ((cursor % tasks.length) + tasks.length) % tasks.length
  for (let step = 0; step < tasks.length; step++) {
    const i = (start + step) % tasks.length
    const task = tasks[i]!
    if (task.state === 'active') return { task, index: i, nextCursor: (i + 1) % tasks.length }
  }
  return null
}

/** The task list with one task put to rest; only an explore task may reach that state. */
export function restTask(tasks: readonly AgentTask[], id: string): AgentTask[] {
  return tasks.map((t) => (t.id === id && t.kind === 'explore' ? { ...t, state: 'resting' as const } : t))
}

/** Per-kind USD cap on Sonnet 5 (docs/agents/SPEC.md sections 6.2 and 7), scaled by the model factor. */
export const BUDGET_USD: Readonly<Record<RunKind, number>> = { research: 12, 'research-step': 4, 'research-expand': 6, plan: 1 }
/** A `deep` step is a full run with a longer leash (section 7). */
export const DEEP_TIMEOUT_MS = 45 * 60_000
const STEP_TIMEOUT_MS = 15 * 60_000
/** Planning attempts per cycle: one retry when the answer comes back unusable, then the night is over. */
export const PLAN_ATTEMPTS = 2

/**
 * How many of the other Fellows' topics ride in the planner prompt. Enough to cover a night's
 * work across a handful of Fellows, small enough that the block stays an aside.
 */
export const ELSEWHERE_CAP = 12

export type StepKind = 'research' | 'research-step' | 'research-expand'
export type RunKind = StepKind | 'plan'

export interface SpawnInput {
  readonly name: string
  /** The first task's sentence; kept for callers that spawn with one line. */
  readonly intent: string
  /** The standing work, one to three. Absent = the intent as a single explore task. */
  readonly tasks?: readonly TaskInput[]
  readonly scope?: string
  readonly homeDomain: string
  readonly extraDomains?: readonly string[]
  readonly lens?: string
  readonly model?: AgentModel
  readonly effort?: AgentEffort
  readonly step?: AgentStep
  readonly quotaRunsPerDay?: number
  readonly autonomy?: AgentAutonomy
  /** The arts its tasks may be; inferred from the first task list when absent. */
  readonly art?: AgentArt
  /** Every standing task each night (the default), or one in turn. */
  readonly nightly?: AgentNightly
  readonly priority?: number
  /** Start the first full research run on the intent right away (default true, section 5.1). */
  readonly runFirstStep?: boolean
}

export type RefusalCode = 'unknown' | 'state' | 'in-flight' | 'quota' | 'budget' | 'kind' | 'scope' | 'reserve' | 'share' | 'full'

/**
 * How many Fellows the Library seats: one desk each in the main room (docs/agents/SPEC.md
 * 10.13). The web's room model draws exactly this many (`web/src/lib/library/room.ts`).
 */
export const DESK_COUNT = 10

export interface Refusal {
  readonly status: 404 | 409
  readonly error: string
  readonly code: RefusalCode
}

export interface StepOutcome {
  readonly run?: MaintenanceRun
  readonly refusal?: Refusal
}

export interface SpawnOutcome {
  readonly agent?: AgentRecord
  readonly run?: MaintenanceRun
  readonly refusal?: Refusal
}

export interface UpdateOutcome {
  readonly agent?: AgentRecord
  readonly refusal?: Refusal
}

export interface PlanOutcome {
  readonly run?: MaintenanceRun
  readonly refusal?: Refusal
  /** The planner was not started because there was nothing to plan from; the reason. */
  readonly skipped?: string
}

export interface TaskOutcome {
  /** The task's own id (`t1`..`t3`); its text is the key the proposals carry. */
  readonly id: string
  readonly outcome: 'ran' | 'vetoed' | 'open'
}

export interface FellowSummary {
  readonly agent: AgentRecord
  readonly currentRun: MaintenanceRun | null
  readonly lastRun: AgentRunRecord | null
  /**
   * Research runs spent in the cycle the quota is counted in - the night, not the calendar day
   * (2026-09-14). A window that crosses midnight is one night and one count.
   */
  readonly runsTonight: number
  /** Proposals still to decide or to run: approved ones stand here until they have run. */
  readonly pendingProposals: number
  /**
   * Proposals still UNDECIDED. Not the same number: an approved proposal keeps standing
   * until a run takes it, so `pendingProposals` counts it and nothing is up for review. A
   * count labelled "decisions" has to be this one, or it promises work that is already done.
   */
  readonly undecidedProposals: number
  /**
   * What became of each standing task tonight, in the order the tasks stand.
   *
   * Derived here because the proposals live here: a task "ran" when a run today carried out
   * one of its proposals, and is "vetoed" when every proposal it got this cycle was vetoed
   * and none ran. Anything else is still open. The queue bar marks its sections from this,
   * so the drawing of a night and the record of it cannot disagree.
   */
  readonly tonight: readonly TaskOutcome[]
  /**
   * What the next shift would run for this Fellow, in order and capped by the quota. `next` is
   * its first entry; this is the whole night, which a Fellow with room for two runs needs.
   */
  readonly queue: readonly ProposalRecord[]
  /**
   * Whether "skip tonight" covers the night ahead: the shift still PLANS for such a Fellow and
   * runs nothing of it. Resolved here rather than shipped as a date, because deciding it means
   * knowing which night is ahead, and that is this service's question and not the board's.
   */
  readonly skipsTonight: boolean
  /** The proposal the next shift would run, if any. */
  readonly next: ProposalRecord | null
}

export interface FellowSpend {
  readonly todayUsd: number
  readonly weekUsd: number
  readonly runsToday: number
  readonly runsWeek: number
  /** Plan points of the week's runs where measured (section 8.3), null when none was. */
  readonly weekPct: number | null
}

export interface FellowCard extends FellowSummary {
  /** Newest first, capped. */
  readonly runs: readonly AgentRunRecord[]
  /** Every page the Fellow's runs committed, newest first, deduplicated. */
  readonly pages: readonly string[]
  readonly lastActive: string | null
  /**
   * The quota and what is spent of it in the cycle now in force - the night that is running,
   * else the one that opened this day (2026-09-14). Not the calendar day, so a night that
   * crosses midnight is one allowance, and not the night AHEAD, because a count that gates a
   * hand-started run may not read zero through the whole afternoon.
   */
  readonly quota: { readonly runsPerDay: number; readonly used: number }
  /** Pending first (by rank), then the recent history. */
  readonly proposals: readonly ProposalRecord[]
  readonly spend: FellowSpend
  /** Page opens and recap link clicks attributed to the Fellow this month (section 9.6). */
  readonly value: ValueCounts
}

export interface DecisionInput {
  /** `proposed` returns an approved or vetoed proposal to undecided. */
  readonly status?: 'approved' | 'vetoed' | 'proposed'
  readonly note?: string
  /** Edited topic text (section 6.5). */
  readonly topic?: string
  /** Move to this rank among the Fellow's pending proposals (1 = first). */
  readonly rank?: number
  readonly via?: DecisionChannel
}

export interface DecisionOutcome {
  readonly proposal?: ProposalRecord
  readonly refusal?: Refusal
}

/** What the candidate computation needs from the rest of the service; all injectable. */
export interface CandidateSources {
  readonly vaultRoot: string
  readonly graph?: () => VaultGraph | null
  readonly jobs?: () => JobRow[]
}

export interface FellowSettings {
  readonly window: { readonly start: string; readonly end: string }
  readonly defaultModel: AgentModel
}

export interface GateBlock {
  readonly code: 'budget' | 'reserve' | 'share'
  readonly reason: string
  /** When the block lifts, if known (a plan window's reset). */
  readonly resetsAt?: string | null
}

export interface FellowServiceOptions {
  readonly agents: AgentStore
  readonly runs: AgentRunStore
  readonly proposals: ProposalStore
  readonly maintenance: MaintenanceRunner
  readonly notebook: NotebookWriter
  /** The reading list, when the vault has one: the planner's finds are written by the service. */
  readonly reading?: {
    add(entries: readonly ReadingEntryInput[]): Promise<{ readonly added: number }>
    /** Marks entries whose publication arrived in the vault and reports them (section 10.6). */
    reconcile(today: string): Promise<ReadonlyArray<{ readonly entry: ReadingEntryInput; readonly page: string }>>
    entries(): ReadonlyArray<ReadingEntryInput & { readonly page: string | null; readonly held: boolean }>
  }
  readonly now?: () => Date
  /** Candidate computation; the default reads the vault, the graph and the job store. */
  readonly candidates?: (agent: AgentRecord, runs: readonly AgentRunRecord[], since: string | null, task?: AgentTask) => Candidate[]
  readonly candidateSources?: CandidateSources
  /** Service-wide block on starting a run of this cost and model (daily budget, rate-limit pause, plan gate); null = clear. */
  readonly gate?: (ctx: GateContext) => GateBlock | null
  /** Prices a run in plan points once calibrated (section 6.3); null while uncalibrated. */
  readonly estimatePct?: (costUsd: number, model: AgentModel) => { fiveHour: number | null; sevenDay: number | null }
  readonly settings?: () => FellowSettings
  /**
   * Whether the runs-per-day quota is suspended right now - a live five-hour release (SPEC
   * section 8.6). The quota limits the autopilot, not the user, and a release is exactly the
   * user saying they want the autopilot to use what is there.
   */
  readonly quotaSuspended?: () => boolean
  /** The value signal (section 9.6); absent = the card shows no opens. */
  readonly values?: ValueEventStore
  /** The order the night walks the shelves; absent means nobody has set one (A7 3.5). */
  readonly shelfOrder?: ShelfOrderStore
  /** Handoffs between Fellows (section 6.6, A3); absent = no routing. */
  readonly handoffs?: HandoffStore
  /** The domain registry for the planner's routing; defaults to the vault's page. */
  readonly registry?: () => readonly DomainHint[]
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export { localDate, addDays }

export { knowledgePages }

const isResearchKind = (kind: string): boolean => kind === 'research' || kind === 'research-step'

/** A decision may still change while the proposal has not run, expired or been superseded. */
const DECIDABLE: readonly ProposalRecord['status'][] = ['proposed', 'approved', 'vetoed']

export class FellowService {
  private readonly agents: AgentStore
  private readonly runs: AgentRunStore
  private readonly proposals: ProposalStore
  private readonly maintenance: MaintenanceRunner
  private readonly notebook: NotebookWriter
  private readonly reading: FellowServiceOptions['reading']
  private readonly now: () => Date
  private readonly candidatesFn: (agent: AgentRecord, runs: readonly AgentRunRecord[], since: string | null, task?: AgentTask) => Candidate[]
  private readonly gate: (ctx: GateContext) => GateBlock | null
  private readonly estimatePct: ((costUsd: number, model: AgentModel) => { fiveHour: number | null; sevenDay: number | null }) | undefined
  private readonly settings: () => FellowSettings
  private readonly values: ValueEventStore | undefined
  private readonly shelfOrder: ShelfOrderStore | undefined
  private readonly handoffs: HandoffStore | undefined
  private readonly registry: () => readonly DomainHint[]
  private readonly vaultRoot: string | undefined
  /** Where the candidate machinery reads from; the deepen ranking needs the graph too. */
  private readonly sources: CandidateSources | undefined
  /** True while a five-hour release is live; the runs-per-day quota then does not apply. */
  private readonly quotaSuspended: () => boolean
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void
  /** One run in flight per Fellow: agent id to tracked run id. */
  private readonly inFlight = new Map<string, string>()
  /** Resolves once a run settled AND this service finished its settle handling. */
  private readonly settling = new Map<string, Promise<MaintenanceRun>>()
  /** The reset instant of the window behind the last plan refusal, for the shift (A5). */
  private planReset: number | null = null
  /** Notebook rewrites still in progress; `flush()` awaits them. */
  private pending: Promise<unknown>[] = []

  constructor(opts: FellowServiceOptions) {
    this.agents = opts.agents
    this.runs = opts.runs
    this.proposals = opts.proposals
    this.maintenance = opts.maintenance
    this.notebook = opts.notebook
    this.reading = opts.reading
    this.now = opts.now ?? ((): Date => new Date())
    this.gate = opts.gate ?? ((): GateBlock | null => null)
    this.estimatePct = opts.estimatePct
    this.settings = opts.settings ?? ((): FellowSettings => ({ window: DEFAULT_NIGHT_WINDOW, defaultModel: DEFAULT_RESEARCH_MODEL }))
    this.values = opts.values
    this.shelfOrder = opts.shelfOrder
    this.handoffs = opts.handoffs
    this.vaultRoot = opts.candidateSources?.vaultRoot
    this.registry =
      opts.registry ??
      ((): readonly DomainHint[] => {
        const root = opts.candidateSources?.vaultRoot
        if (!root) return []
        const reg = readDomainRegistry(root)
        return reg ? reg.domains.filter((d) => d.key !== 'meta').map((d) => ({ key: d.key, description: d.description })) : []
      })
    this.log = opts.log ?? ((): void => {})
    this.quotaSuspended = opts.quotaSuspended ?? ((): boolean => false)
    const sources = opts.candidateSources
    this.sources = sources
    this.candidatesFn =
      opts.candidates ??
      ((agent, runs, since, task): Candidate[] => {
        if (!sources) return []
        const safely = <T>(read: (() => T) | undefined, fallback: T): T => {
          try {
            return read?.() ?? fallback
          } catch {
            return fallback
          }
        }
        const graph = safely<VaultGraph | null>(sources.graph, null)
        const jobs = safely<JobRow[]>(sources.jobs, [])
        return computeCandidates({
          agent,
          runs,
          vaultRoot: sources.vaultRoot,
          graph,
          jobs,
          since,
          handoffs: this.handoffCandidates(agent.id),
          readingFiled: this.filedReadingOf(agent),
          ...(task !== undefined ? { task } : {}),
          selfLoop: this.selfLoopOf(agent),
        })
      })
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id)
  }

  /**
   * Every Fellow, in the night shift's order: its shelf's rank first, then priority inside the
   * shelf, then age; retired last (docs/tasks/TASKS-A7.md 3.5). Priority kept its meaning and
   * gained a scope - the shelf order is the level above it, so the two cannot disagree.
   */
  list(): FellowSummary[] {
    const order = this.shelfOrder?.list() ?? []
    const live = this.agents.list().filter((a) => a.state !== 'retired')
    const gone = this.agents.list().filter((a) => a.state === 'retired')
    return [...byShelfThenPriority(live, order), ...byShelfThenPriority(gone, order)].map((agent) => this.summary(agent))
  }

  /** The order the night walks the shelves, as stored; empty when nobody has set one. */
  shelves(): string[] {
    return this.shelfOrder?.list() ?? []
  }

  /** Sets it. An empty list clears it and the registry's own order takes over again. */
  setShelves(domains: readonly string[]): void {
    this.shelfOrder?.put(domains)
  }

  /**
   * Whether any Fellow has a run going. Read by the five-hour release, which refuses while one
   * does: a Fellow that could raise the bound mid-flight would be granting itself budget for
   * the run it is already in (SPEC section 8.6, the security review of 2026-09-07).
   */
  anyRunInFlight(): boolean {
    for (const runId of this.inFlight.values()) {
      if (this.maintenance.getRun(runId)?.status === 'running') return true
    }
    return false
  }

  private summary(agent: AgentRecord): FellowSummary {
    const runId = this.inFlight.get(agent.id)
    const tracked = runId ? this.maintenance.getRun(runId) : undefined
    const currentRun = tracked?.status === 'running' ? tracked : null
    const [lastRun] = this.runs.list({ agentId: agent.id, limit: 1 })
    return {
      agent,
      currentRun,
      lastRun: lastRun ?? null,
      runsTonight: this.runsTonight(agent.id),
      pendingProposals: this.pendingProposals(agent.id).length,
      undecidedProposals: this.pendingProposals(agent.id).filter((p) => p.status === 'proposed').length,
      tonight: this.taskOutcomes(agent),
      next: this.runnable(agent.id) ?? null,
      queue: this.queue(agent.id),
      skipsTonight: this.skipsTonight(agent),
    }
  }

  card(id: string): FellowCard | undefined {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    const runs = this.runs.list({ agentId: id, limit: 50 })
    const pages: string[] = []
    for (const r of runs) for (const p of r.pages) if (!pages.includes(p)) pages.push(p)
    const used = this.runsThisCycle(id)
    return {
      ...this.summary(agent),
      runs,
      pages,
      lastActive: runs[0]?.finishedAt ?? null,
      quota: { runsPerDay: agent.quotaRunsPerDay, used },
      proposals: this.proposals.list({ agentId: id, limit: 20 }),
      spend: this.spend(id),
      value: this.valueCounts(id),
    }
  }

  /** Opens and recap links attributed to the Fellow since the first of the month. */
  valueCounts(agentId?: string): ValueCounts {
    if (!this.values) return { pageOpens: 0, recapLinks: 0 }
    const now = this.now()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    return this.values.counts(monthStart, agentId)
  }

  /** The Fellow whose run committed `page`, for value attribution (section 9.6); undefined when none did. */
  ownerOfPage(page: string): AgentRecord | undefined {
    const run = this.runs.list({ limit: 1000 }).find((r) => r.agentId && r.pages.includes(page))
    return run?.agentId ? this.agents.get(run.agentId) : undefined
  }

  /** Records a value event, attributing the page to its Fellow when the caller named none. */
  recordValue(kind: 'page_open' | 'recap_link', page: string | null, agentId?: string): { agentId: string | null } {
    const owner = agentId ?? (page !== null ? this.ownerOfPage(page)?.id : undefined) ?? null
    this.values?.record({ ts: this.now().toISOString(), kind, agentId: owner, page })
    return { agentId: owner }
  }

  /**
   * "Skip tonight" (docs/tasks/TASKS-A2.md D5): the next shift runs nothing for the Fellow
   * but still plans for it. Returns the cycle date that is skipped.
   */
  async skipTonight(id: string): Promise<{ agent: AgentRecord; cycleDate: string } | undefined> {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    const at = windowAt(this.now(), this.settings().window)
    const cycleDate = at.current?.cycleDate ?? at.next.cycleDate
    // A retired Fellow has no shift to skip; the request is answered, not applied.
    if (agent.state === 'retired') return { agent, cycleDate }
    const next = this.agents.update(id, { skipUntil: cycleDate }, this.now().toISOString())
    if (!next) return undefined
    await this.writeNotebook(next)
    return { agent: next, cycleDate }
  }

  /** Clears "skip tonight". */
  async unskip(id: string): Promise<AgentRecord | undefined> {
    const next = this.agents.update(id, { skipUntil: null }, this.now().toISOString())
    if (next) await this.writeNotebook(next)
    return next
  }

  /**
   * Files a free-text answer as a note under the notebook's Notes section (D6); the next
   * planning run reads it as a candidate.
   */
  async addNote(id: string, text: string, date: string = localDate(this.now())): Promise<AgentRecord | undefined> {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean === '') return agent
    // A retired Fellow plans no more; a note for its next plan has nowhere to go.
    if (agent.state === 'retired') return agent
    await this.writeNotebook(agent, { appendNotes: [{ text: `Recap note ${date}: ${clean}` }] })
    if (agent.state === 'sleeping' && (agent.sleepCode === 'covered' || agent.sleepCode === 'stalled')) {
      return this.agents.update(id, { sleepReason: 'a recap note arrived; the planner reconsiders in the next night shift', sleepCode: 'idle' }, this.now().toISOString())
    }
    return agent
  }

  /** The Fellow's pending proposals, approved first, then by rank. */
  pendingProposals(agentId: string): ProposalRecord[] {
    return this.proposals.list({ agentId, status: PENDING_STATUSES })
  }

  listProposals(agentId: string, limit = 50): ProposalRecord[] {
    return this.proposals.list({ agentId, limit })
  }

  getProposal(id: string): ProposalRecord | undefined {
    return this.proposals.get(id)
  }

  /**
   * What the other Fellows are already on, for the planner's duplicate check (section 6.6).
   *
   * Two sources, both cross-Fellow: the topics they have standing (undecided or approved) and
   * the ones that have already RUN tonight. The service's lexical dedupe catches a duplicate
   * only when it is also a near-quotation; this is the same question put to the one judge in
   * the loop that reads for meaning, in a prompt that runs anyway.
   *
   * Capped, newest work first: the block is an aside in a long prompt, not the prompt.
   */
  private elsewhereFor(agentId: string): Array<{ fellow: string; topic: string; ran: boolean }> {
    const out: Array<{ fellow: string; topic: string; ran: boolean }> = []
    const seen = new Set<string>()
    const add = (fellow: string, topic: string, ran: boolean): void => {
      const key = topic.trim().toLowerCase()
      if (key === '' || seen.has(key)) return
      seen.add(key)
      out.push({ fellow, topic, ran })
    }
    const others = this.agents.list().filter((a) => a.id !== agentId && a.state !== 'retired')
    // What ran tonight comes first: it is the strongest claim, the pages already exist. The
    // night, not the calendar day - a run at 23:40 and one at 00:10 are the same night's.
    for (const other of others) {
      for (const run of this.runs.list({ agentId: other.id, since: this.cycleNow().start.toISOString(), limit: 20 })) {
        if (!isResearchKind(run.kind) || !run.ok || run.label === null) continue
        add(other.name, run.label, true)
      }
    }
    for (const other of others) for (const p of this.pendingProposals(other.id)) add(other.name, p.topic, false)
    return out.slice(0, ELSEWHERE_CAP)
  }

  /**
   * The settled runs a price is taken from (`pipeline/run-cost.ts`): the most recent ones of
   * every Fellow, not only this one's, because what a kind costs is a property of the kind and
   * the model rather than of who asked for it - and one Fellow alone rarely has three runs of
   * a kind to have a median from.
   */
  private costHistory(): readonly CostSample[] {
    return this.runs.list({ limit: SAMPLE_LIMIT })
  }

  /** Steps this Fellow ran in the cycle the quota gates; a planning run does not count. */
  private runsThisCycle(agentId: string): number {
    return this.researchRunsSince(agentId, this.cycleNow().start)
  }

  /** The same count for the night AHEAD: what the bar draws as already carried out. */
  private runsTonight(agentId: string): number {
    return this.researchRunsSince(agentId, this.nightAhead().start)
  }

  private researchRunsSince(agentId: string, since: Date): number {
    return this.runs.list({ agentId, since: since.toISOString() }).filter((r) => isResearchKind(r.kind)).length
  }

  /** USD totals for the card (list-price estimates in subscription mode). */
  spend(agentId: string): FellowSpend {
    const now = this.now()
    const week = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString()
    const weekRuns = this.runs.list({ agentId, since: week })
    const todayIso = startOfToday(now).toISOString()
    const todayRuns = weekRuns.filter((r) => r.startedAt >= todayIso)
    const sum = (rs: readonly AgentRunRecord[]): number => Math.round(rs.reduce((acc, r) => acc + (r.costUsd ?? 0), 0) * 100) / 100
    const measured = weekRuns.filter((r) => r.planPctDelta?.['seven_day'] !== undefined)
    const weekPct = measured.length > 0 ? Math.round(measured.reduce((acc, r) => acc + (r.planPctDelta!['seven_day'] ?? 0), 0) * 100) / 100 : null
    return { todayUsd: sum(todayRuns), weekUsd: sum(weekRuns), runsToday: todayRuns.length, runsWeek: weekRuns.length, weekPct }
  }

  /** Creates the record and its notebook page, then (by default) runs the intent as a full research run. */
  async spawn(input: SpawnInput): Promise<SpawnOutcome> {
    const slug = slugify(input.name)
    if (this.agents.bySlug(slug) !== undefined) {
      return { refusal: { status: 409, code: 'state', error: `a Fellow named "${input.name}" (slug ${slug}) already exists` } }
    }
    /*
     * A desk before anything else (2026-09-17): the room seats ten, and a Fellow with nowhere
     * to stand is not spawned. The lowest free number, so a retirement's desk is the next one
     * taken - the room fills from the first desk and never leaves a gap standing.
     */
    const desk = this.freeDesk()
    if (desk === null) {
      return { refusal: { status: 409, code: 'full', error: `the room seats ${DESK_COUNT} Fellows and every desk is taken; retire one first` } }
    }
    const now = this.now().toISOString()
    /*
     * The standing work. `tasks` when the caller sends them, otherwise the single intent as one
     * explore task - the shape every Fellow spawned before 2026-09-07 has, and the shape the
     * API keeps accepting so a one-line spawn stays a one-line spawn.
     */
    const tasks = normalizeTasks(input.tasks ?? [{ text: input.intent, kind: 'explore' }])
    if (tasks.length === 0) {
      return { refusal: { status: 409, code: 'kind', error: 'a Fellow needs at least one task' } }
    }
    const art: AgentArt = input.art ?? (new Set(tasks.map((t) => t.kind)).size === 1 ? tasks[0]!.kind : 'custom')
    const artBad = artRefusal(art, tasks)
    if (artBad) return { refusal: artBad }
    const agent: AgentRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      slug,
      intent: tasks[0]!.text,
      scope: input.scope?.trim() ? input.scope.trim() : null,
      tasks,
      taskCursor: 0,
      homeDomain: input.homeDomain,
      extraDomains: input.extraDomains ?? [],
      lens: input.lens ?? 'broad',
      model: input.model ?? this.settings().defaultModel,
      effort: input.effort ?? 'high',
      step: input.step ?? 'standard',
      /*
       * One run a day per standing task, because `nightly` defaults to `sweep` and a planning
       * run is not gated by this while the run it produces is (see `gateFor`). A default of 1
       * against three tasks would plan three every night and carry out one, which reads as a
       * Fellow that keeps changing its mind rather than as a quota doing its job.
       */
      quotaRunsPerDay: input.quotaRunsPerDay ?? tasks.length,
      quotaWeekPct: null,
      autonomy: input.autonomy ?? 'veto',
      /*
       * A spawn with a single kind of task is that kind of Fellow; a mix is custom. Stated
       * rather than derived from here on: the field is what the tasks may become, and a
       * Fellow that starts with one watch task should not silently accept a deepen later.
       */
      art,
      nightly: input.nightly ?? 'sweep',
      priority: input.priority ?? 0,
      state: 'proposed',
      sleepReason: null,
      sleepCode: null,
      skipUntil: null,
      notebookPath: notebookPath(slug),
      desk,
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
    }
    this.agents.create(agent)
    await this.writeNotebook(agent)
    if (input.runFirstStep === false) return { agent }
    const outcome = this.step(agent.id, { kind: 'research', topic: agent.intent })
    /*
     * The first run IS the first task's turn, so the turn moves on. It is not a planning run,
     * and the rotation otherwise advances only when the planner starts - which left the first
     * task planned again on the first night, after it had already had its run.
     */
    if (outcome.run) {
      const next = taskForTonight(agent.tasks, 0)
      if (next) this.agents.update(agent.id, { taskCursor: next.nextCursor }, this.now().toISOString())
      this.enqueue(this.planAfterFirst(agent.id, outcome.run.id))
    }
    return { agent: this.agents.get(agent.id) ?? agent, ...(outcome.run ? { run: outcome.run } : {}), ...(outcome.refusal ? { refusal: outcome.refusal } : {}) }
  }

  /**
   * The planning run that follows a spawn's first run (2026-09-14).
   *
   * Run first, then plan - in that order, because the plan is only worth having once the run
   * has been: a Fellow spawned at eight in the evening wrote eighteen pages and ten open
   * questions in its first run, and those ten questions are what its planner then had to work
   * from. Planned the other way round it would have had its own task's name and the vault as
   * it already stood.
   *
   * What it buys is a night. Without it the first night is a bare planning run, the decisions
   * arrive the next morning and the first steered work the night after; with it the proposals
   * stand before the shift opens, there is an evening to decide in, and tonight already runs
   * what you chose.
   *
   * A refusal is swallowed on purpose. The chained plan is a courtesy and not a promise: a
   * gate that is shut would otherwise put a Fellow to sleep in the minute it was created, and
   * tonight's shift plans for it anyway.
   */
  private async planAfterFirst(agentId: string, runId: string): Promise<void> {
    const settled = await this.settled(runId)
    if (settled.status !== 'done') return
    const agent = this.agents.get(agentId)
    if (!agent || agent.state === 'retired' || agent.state === 'paused') return
    const outcome = this.plan(agentId)
    if (outcome.refusal) {
      this.log('info', `fellows: no plan for ${agent.name} yet - ${outcome.refusal.error}; the night shift plans for it`)
      return
    }
    if (outcome.run) await this.settled(outcome.run.id)
  }

  /**
   * Why a run may not start for this Fellow right now, or null. The gate of section 8.4 as far
   * as A1 measures it: state, one run in flight per Fellow, runs per day, the daily budget and
   * the rate-limit pause. A planning run skips the quota (it is not a step).
   *
   * `manual` marks a run the user asked for by hand. It skips ONLY the runs-per-day quota,
   * which is a self-imposed limit on the autopilot and has no meaning against a deliberate
   * click. Everything else holds: the shares, the reserves, the daily budget and the
   * rate-limit pause protect the user's own capacity, and overriding those would quietly
   * spend it.
   */
  /**
   * Whether this Fellow has a run in flight right now (TASKS-DEFECT-PATHS 4.5).
   *
   * The narrow question a defect fix on a notebook page has to ask, exposed rather than the
   * map itself. Why this and not `pause()`: pausing blocks starting new runs and the night
   * shift's filter, and stops NO run in flight - there is no abort path anywhere in this module
   * - so it would not close the one window that matters. And `resume()` does not restore the
   * previous state, so a crashed fix run could leave a Fellow paused indefinitely.
   *
   * In-memory and per process, which is honest: a run in flight belongs to this process, and
   * the startup reconciliation is what keeps the answer true across a restart.
   */
  hasRunInFlight(agentId: string): boolean {
    return this.inFlight.has(agentId)
  }

  gateFor(agent: AgentRecord, kind: RunKind, opts: { readonly manual?: boolean } = {}): Refusal | null {
    if (agent.state === 'retired') return { status: 409, code: 'state', error: `${agent.name} is retired` }
    if (agent.state === 'paused') return { status: 409, code: 'state', error: `${agent.name} is paused; resume first` }
    // In flight until the run settled AND its settle handling (state, proposals, notebook) is done.
    if (this.inFlight.has(agent.id)) {
      return { status: 409, code: 'in-flight', error: `${agent.name} already has a run in flight` }
    }
    /*
     * A live release suspends the quota for as long as it lasts. It is re-read on every start,
     * so the moment the release ends or is withdrawn the next run is refused again - which is
     * also what stops a shift round that is still walking its Fellows.
     */
    if (kind !== 'plan' && opts.manual !== true && !this.quotaSuspended()) {
      const used = this.runsThisCycle(agent.id)
      if (used >= agent.quotaRunsPerDay) {
        return { status: 409, code: 'quota', error: `${agent.name} used tonight's quota (${used} of ${agent.quotaRunsPerDay} runs)` }
      }
    }
    // The service-wide gate: the daily budget and the rate-limit pause, and the plan shares
    // and reserves (section 8.4) for every Fellow run, planning included: a planning run
    // spends plan points too, and the reserves protect the user's own use of the plan.
    const block = this.gate({ estCostUsd: estimateCostUsd(kind, agent.model, this.costHistory()), model: agent.model, kind })
    if (block) {
      this.planReset = block.resetsAt ? Date.parse(block.resetsAt) : null
      return { status: 409, code: block.code, error: block.reason }
    }
    return null
  }

  /** The reset instant behind the most recent gate refusal (epoch ms), for the shift's wait (A5 D5). */
  lastPlanReset(): number | null {
    return this.planReset !== null && Number.isFinite(this.planReset) ? this.planReset : null
  }

  /**
   * The timeout a run of this kind gets for this Fellow (the shift checks the window against
   * it). A deepening's leash grows with the set it was given: the planner's four fit the base,
   * a hand-started eight need twice as long.
   */
  timeoutFor(agent: AgentRecord, kind: RunKind, pages?: number): number {
    if (kind === 'plan') return PLAN_TIMEOUT_MS
    if (kind === 'research-step') return STEP_TIMEOUT_MS
    if (kind === 'research-expand') return expandTimeoutMs(EXPAND_TIMEOUT_MS, pages ?? 0)
    return agent.step === 'deep' ? DEEP_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  }

  /**
   * Why this Fellow may not deepen these pages, or null.
   *
   * Two bounds, both absent until now: a hand-started deepening was capped by nothing, and
   * nothing stopped a Fellow appending to a domain that is not his. The second is the drift
   * the scope score exists to catch, made deliberate instead of accidental - the decision of
   * 2026-09-07 is that a Fellow works its own ground, and a domain with no Fellow leads to a
   * spawn rather than to a borrowed one. A page carrying NO domain is unfiled, not foreign,
   * and stays allowed: it is often exactly the thin page worth deepening.
   */
  private boundsRefusal(agent: AgentRecord, pageSet: readonly string[]): Refusal | null {
    if (pageSet.length > EXPAND_MANUAL_MAX_PAGES) {
      return { status: 409, code: 'kind', error: `a deepening may name at most ${EXPAND_MANUAL_MAX_PAGES} pages (${pageSet.length} given)` }
    }
    const root = this.vaultRoot
    if (root === undefined) return null
    const own = new Set([agent.homeDomain, ...agent.extraDomains].filter((d): d is string => typeof d === 'string' && d !== ''))
    for (const page of pageSet) {
      let markdown: string
      try {
        markdown = fs.readFileSync(path.join(root, page), 'utf8')
      } catch {
        return { status: 409, code: 'kind', error: `no such page: ${page}` }
      }
      const domain = parseFrontmatterMeta(markdown).domain
      if (domain !== null && domain !== '' && !own.has(domain)) {
        return { status: 409, code: 'scope', error: `${agent.name} does not work ${domain} (${page})` }
      }
    }
    return null
  }

  /**
   * Starts one step now, subject to the gate. Returns the tracked run (202) or a refusal
   * (404/409). With a `proposalId` the run executes that proposal and marks it so.
   */
  step(
    id: string,
    opts: {
      readonly topic?: string
      readonly kind?: StepKind
      readonly lens?: string
      readonly proposalId?: string
      readonly pageSet?: readonly string[]
      /** Set by a deliberate manual start: run even though today's quota is used up. */
      readonly override?: boolean
    } = {},
  ): StepOutcome {
    const agent = this.agents.get(id)
    if (!agent) return { refusal: { status: 404, code: 'unknown', error: 'no such Fellow' } }
    const refusal = this.gateFor(agent, opts.kind ?? 'research-step', { manual: opts.override === true })
    if (refusal) return { refusal }
    const kind: StepKind = opts.kind ?? 'research-step'
    if (kind === 'research-expand' && (opts.pageSet === undefined || opts.pageSet.length === 0)) {
      return { refusal: { status: 409, code: 'kind', error: 'an expand run needs a page set' } }
    }
    // The planner's own sets come pre-bounded (EXPAND_MAX_PAGES, pages of the Fellow's own
    // candidates); a hand-started one arrives from the request body and is bounded here.
    if (kind === 'research-expand' && opts.proposalId === undefined) {
      const refused = this.boundsRefusal(agent, opts.pageSet ?? [])
      if (refused) return { refusal: refused }
    }
    const topic = opts.topic?.trim() ? opts.topic.trim() : agent.intent
    const ctx = this.context(agent, kind, opts.proposalId, opts.pageSet?.length ?? 0)
    const lens = opts.lens ?? agent.lens
    /*
     * The Fellow's own pages are always in an expand's set (D1): the run appends open
     * questions to its notebook, and its synthesis pages carry the update's summary. The
     * reading list belongs with them since every writing run carries that rule (10.6) - left
     * out, an expand that noted one publication was reverted whole, which is exactly what
     * happened on the first real one. Being IN the set rather than exempt from the check is
     * the point: the subsequence rule then holds it to appending, which is what the page is.
     */
    const pageSet =
      kind === 'research-expand'
        ? [...new Set([...(opts.pageSet ?? []), ...fellowSynthesisPages(this.runs.list({ agentId: agent.id, limit: 50 })), agent.notebookPath, READING_LIST_PAGE])]
        : []
    const run =
      kind === 'research'
        ? this.maintenance.startResearch(topic, lens, ctx)
        : kind === 'research-expand'
          ? this.maintenance.startResearchExpand(topic, lens, ctx, pageSet)
          : this.maintenance.startResearchStep(topic, lens, ctx)
    this.track(agent.id, run, (settled) => this.onStepSettled(agent.id, settled))
    this.agents.update(id, { state: 'active', sleepReason: null, sleepCode: null }, this.now().toISOString())
    if (opts.proposalId !== undefined) this.proposals.update(opts.proposalId, { status: 'executed', runId: run.id })
    return { run }
  }

  /**
   * Executes a pending proposal now (the shift's path, and the card's "run this one"). The
   * shift never passes `override`; only a click does.
   */
  execute(proposalId: string, opts: { readonly override?: boolean } = {}): StepOutcome {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) return { refusal: { status: 404, code: 'unknown', error: 'no such proposal' } }
    if (!PENDING_STATUSES.includes(proposal.status)) {
      return { refusal: { status: 409, code: 'state', error: `the proposal is ${proposal.status}` } }
    }
    return this.step(proposal.agentId, {
      topic: proposal.topic,
      kind: proposal.kind,
      lens: proposal.lens,
      proposalId,
      pageSet: proposal.pageSet,
      ...(opts.override === true ? { override: true } : {}),
    })
  }

  /**
   * The proposal the next shift would run for this Fellow (section 6.5): an approved one
   * first (any mode), else in veto and auto mode the top undecided one that is not flagged
   * as drift, and none while the Fellow sleeps because its intent is covered or it stalled.
   */
  runnable(agentId: string): ProposalRecord | undefined {
    const agent = this.agents.get(agentId)
    if (!agent) return undefined
    const pending = this.pendingProposals(agentId)
    /*
     * A task that has already run today goes to the back (docs/tasks/TASKS-A7.md D8).
     *
     * The planner ranks each task's proposals 1..3 independently, so a sweeping Fellow holds
     * three rank-1 proposals and `rank` alone cannot tell them apart. Ordered by rank only,
     * three runs could all be options of ONE task while the other two stood planned and
     * untouched - which is the opposite of what "every standing task each night" promises.
     * Rank still decides inside a task; it just no longer decides between them.
     */
    // Fairness runs inside ONE night: what has already run in the night being planned goes to
    // the back. Inside the window that is the running shift; outside it, nothing has run yet.
    const done = this.tasksRunSince(agentId, this.nightAhead().start)
    const byTask = (a: ProposalRecord, b: ProposalRecord): number => {
      const ad = done.has(a.provenance.task ?? '') ? 1 : 0
      const bd = done.has(b.provenance.task ?? '') ? 1 : 0
      return ad - bd || a.rank - b.rank
    }
    const approved = pending.filter((p) => p.status === 'approved').sort(byTask)
    if (approved[0]) return approved[0]
    if (agent.autonomy === 'manual') return undefined
    if (agent.state === 'sleeping' && (agent.sleepCode === 'covered' || agent.sleepCode === 'stalled')) return undefined
    return pending.filter((p) => p.status === 'proposed' && !isDrift(p.scopeScore)).sort(byTask)[0]
  }

  /**
   * Every proposal the next shift would run for this Fellow, in the order it would take them
   * and no further than the quota reaches (2026-09-14).
   *
   * {@link runnable} answers the shift's question, which is "what next" - it is asked again
   * after every run. This answers the dashboard's, which is "what tonight", and it has to be
   * the same order or the board would promise work the night does differently. So the two read
   * one list: approved first, whatever the mode, then the undecided ones a Fellow that decides
   * for itself would take. What is NOT here is what tonight's own planning will add, because
   * it does not exist yet; the board draws those as the open slots they are.
   */
  queue(agentId: string): ProposalRecord[] {
    const agent = this.agents.get(agentId)
    if (!agent) return []
    if (this.skipsTonight(agent)) return []
    const room = Math.max(0, agent.quotaRunsPerDay - this.runsTonight(agentId))
    if (room === 0) return []
    const pending = this.pendingProposals(agentId)
    const done = this.tasksRunSince(agentId, this.nightAhead().start)
    const byTask = (a: ProposalRecord, b: ProposalRecord): number => {
      const ad = done.has(a.provenance.task ?? '') ? 1 : 0
      const bd = done.has(b.provenance.task ?? '') ? 1 : 0
      return ad - bd || a.rank - b.rank
    }
    const approved = pending.filter((p) => p.status === 'approved').sort(byTask)
    const asks = agent.autonomy === 'manual'
    const resting = agent.state === 'sleeping' && (agent.sleepCode === 'covered' || agent.sleepCode === 'stalled')
    const undecided = asks || resting ? [] : pending.filter((p) => p.status === 'proposed' && !isDrift(p.scopeScore)).sort(byTask)
    return [...approved, ...undecided].slice(0, room)
  }

  /**
   * The night the Fellows are read against: the one running now, else the one that has not
   * opened yet (2026-09-14).
   *
   * The calendar day was the wrong unit on both counts. A window of 23:30 to 04:00 carries the
   * cycle date of the morning after, so the afternoon's finished work was drawn under the
   * heading "Tonight" - and the count that gates the night reset at midnight, in the middle of
   * the shift that was still running.
   *
   * This is the FORECAST anchor: what the night ahead has made of each task, and how much of
   * it is still to come. The gate counts in {@link cycleNow} instead, which covers the present
   * moment - a count that gates may not have hours of the day in which it counts nothing.
   * Inside the window the two are the same span, which is where the gate does its work.
   */
  private nightAhead(): WindowSpan {
    const at = windowAt(this.now(), this.settings().window)
    return at.current ?? at.next
  }

  /** Whether the Fellow's skip mark covers the night ahead. It still plans; nothing of it runs. */
  private skipsTonight(agent: AgentRecord): boolean {
    return agent.skipUntil !== null && agent.skipUntil >= this.nightAhead().cycleDate
  }

  /** The cycle in force at this instant, which the quota is counted in. See {@link cycleAt}. */
  private cycleNow(): WindowSpan {
    return cycleAt(this.now(), this.settings().window)
  }

  /**
   * What each standing task came to in the night ahead: a run carried one of its proposals
   * out, every proposal it got was vetoed, or it is still open.
   *
   * Read against the NIGHT, not the calendar day (2026-09-14). A window of 23:30 to 04:00
   * carries the cycle date of the morning after, so reading the outcomes against today put
   * the afternoon's finished work under the heading "Tonight" - and would have cleared it at
   * midnight, in the middle of the shift that was still running.
   */
  private taskOutcomes(agent: AgentRecord): TaskOutcome[] {
    const night = this.nightAhead()
    const ran = this.tasksRunSince(agent.id, night.start)
    const cycle = night.cycleDate
    const mine = this.proposals.list({ agentId: agent.id, limit: 60 }).filter((p) => p.cycleDate === cycle)
    return agent.tasks.map((t) => {
      if (ran.has(t.text)) return { id: t.id, outcome: 'ran' as const }
      const forTask = mine.filter((p) => p.provenance.task === t.text)
      // Vetoed only when there was something to veto and nothing survived it.
      const vetoed = forTask.length > 0 && forTask.every((p) => p.status === 'vetoed')
      return { id: t.id, outcome: vetoed ? ('vetoed' as const) : ('open' as const) }
    })
  }

  /** The standing tasks this Fellow has run since an instant, by their text (what proposals store). */
  private tasksRunSince(agentId: string, since: Date): Set<string> {
    const out = new Set<string>()
    for (const r of this.runs.list({ agentId, since: since.toISOString() })) {
      if (!isResearchKind(r.kind) || !r.proposalId) continue
      const task = this.proposals.get(r.proposalId)?.provenance.task
      if (task !== undefined && task !== '') out.add(task)
    }
    return out
  }

  /**
   * Starts a planning run (section 6.2) unless there is nothing to plan from, in which case
   * the Fellow sleeps with `no-candidates` and no planner cost is spent.
   */
  plan(
    id: string,
    opts: {
      readonly cycleDate?: string
      readonly attempt?: number
      readonly retryNote?: string
      /**
       * Plan for THIS task rather than the one whose turn it is. The sweep walks the standing
       * work itself, so it says which task each run is for; without it the rotation decides,
       * which is what a hand-started plan and a `rotate` Fellow both want.
       */
      readonly task?: AgentTask
    } = {},
  ): PlanOutcome {
    const agent = this.agents.get(id)
    if (!agent) return { refusal: { status: 404, code: 'unknown', error: 'no such Fellow' } }
    const refusal = this.gateFor(agent, 'plan')
    if (refusal) return { refusal }
    const now = this.now()
    /*
     * The night it is FOR, not the calendar day it is started on (2026-09-14). The shift always
     * says which cycle it is planning; everything else - the card's "plan now", the run that
     * follows a spawn - is a plan for the night ahead, and a window of 23:30 to 04:00 carries
     * the cycle date of the morning after. Read against the calendar day, proposals made in
     * the evening belonged to a cycle the coming night is not, so the board would not count
     * them and they would expire a night early.
     */
    const cycleDate = opts.cycleDate ?? this.nightAhead().cycleDate
    // Pending proposals from three cycles ago had their two nights (section 6.5).
    const expired = this.proposals.expire(agent.id, addDays(cycleDate, -2))
    if (expired > 0) this.log('info', `fellows: ${expired} proposal(s) of ${agent.name} expired`)
    const runs = this.runs.list({ agentId: agent.id, limit: 200 })
    /*
     * Tonight's task, taken in turn. Every task resting is what puts the Fellow to sleep now -
     * one answered question used to do it for the whole Fellow (decision 2026-09-07).
     *
     * Decided BEFORE the candidates, because the list depends on it: the standing sweep
     * candidate IS this task's text, and it is the only candidate a task can stand on by
     * itself. Built from the rotation instead, every run of a sweeping Fellow was handed the
     * FIRST task's sweep - the cursor does not move for a sweep - so tasks two and three were
     * offered the first task's material and told not to propose against it. The planner said
     * so in its own words and proposed nothing, night after night.
     */
    const chosen = opts.task
    const tonight =
      chosen === undefined
        ? taskForTonight(agent.tasks, agent.taskCursor)
        : { task: chosen, index: agent.tasks.findIndex((t) => t.id === chosen.id), nextCursor: agent.taskCursor }
    if (tonight === null) {
      const reason = 'every standing task is answered as far as the library can take it'
      this.sleep(agent.id, 'covered', reason)
      return { skipped: reason }
    }
    const { candidates } = this.candidates(agent.id, tonight.task) ?? { candidates: [] }
    if (candidates.length === 0) {
      const reason = `no open questions and no candidates in ${[agent.homeDomain, ...agent.extraDomains].join(', ')}`
      this.sleep(agent.id, 'no-candidates', reason)
      return { skipped: reason }
    }
    const kinds = kindsForTask(tonight.task.kind, agent.step)
    /*
     * A deepen task names a theme, so the pages are ranked afresh here rather than stored:
     * what has already been built out falls to the back on its own (decision 2026-09-07). The
     * planner is handed them as the set it may name; without any, there is nothing to deepen.
     */
    const deepenPages =
      tonight.task.kind === 'deepen'
        ? rankForDeepening(this.graphOf(), fellowDomains(agent), tonight.task.text, EXPAND_MAX_PAGES).map((r) => r.path)
        : []
    if (tonight.task.kind === 'deepen' && deepenPages.length === 0) {
      const reason = `nothing to deepen for "${tonight.task.text}" in ${[agent.homeDomain, ...agent.extraDomains].join(', ')}`
      this.agents.update(agent.id, { taskCursor: tonight.nextCursor }, now.toISOString())
      this.log('info', `fellows: ${agent.name} skips tonight - ${reason}`)
      return { skipped: reason }
    }
    const vetoed = this.proposals
      .list({ agentId: agent.id, status: ['vetoed'], limit: 10 })
      .map((p) => p.topic)
    const domains = this.handoffs ? this.registry() : []
    const attempt = opts.attempt ?? 1
    const prompt = renderPlannerPrompt({
      agent,
      candidates,
      recentLog: renderLogLines(runs.slice(0, 8)).slice(-8),
      vetoed,
      elsewhere: this.elsewhereFor(agent.id),
      runsLeftTonight: Math.max(0, agent.quotaRunsPerDay - this.runsThisCycle(agent.id)),
      kinds,
      task: tonight.task,
      taskIndex: tonight.index,
      selfLoop: this.selfLoopOf(agent),
      ...(deepenPages.length > 0 ? { deepenPages } : {}),
      domains,
      ...(opts.retryNote !== undefined ? { retryNote: opts.retryNote } : {}),
    })
    const schema = plannerSchema({ kinds, candidateIds: candidates.map((c) => c.id), domainKeys: domains.map((d) => d.key) })
    const run = this.maintenance.startPlan(prompt, this.context(agent, 'plan'), schema)
    this.track(agent.id, run, (settled) => this.onPlanSettled(agent.id, settled, candidates, kinds, cycleDate, attempt, tonight.task))
    /*
     * The cursor moves when the run STARTS, so a failed or retried planning run does not put
     * the same task up two nights running. A sweep names its own task and leaves the cursor
     * alone: it is walking the whole list, so there is no turn to keep.
     */
    this.agents.update(
      agent.id,
      { state: 'active', sleepReason: null, sleepCode: null, ...(chosen === undefined ? { taskCursor: tonight.nextCursor } : {}) },
      now.toISOString(),
    )
    this.log('info', `fellows: planning run for ${agent.name} started on task ${tonight.index + 1} (${tonight.task.kind}) with ${candidates.length} candidate(s)`)
    return { run }
  }

  /**
   * The Fellow's whole night of planning (docs/tasks/TASKS-A7.md D8).
   *
   * A `sweep` Fellow plans EVERY standing task, one run each, awaited in turn - the runs
   * serialize on the run mutex anyway, and `track` holds one in-flight slot per Fellow, so
   * starting a second before the first settles would collide with itself. One plan per task
   * rather than one merged plan is deliberate: `plannerSchema` constrains `kind`, `candidate`
   * and the deepen page set PER TASK, and a merged run has to widen `kind` to the union
   * (A7 section 1, "rejected on the way here").
   *
   * A `rotate` Fellow plans the one task whose turn it is, which is what the shift did before
   * any of this - so the two paths differ only in how many times the same call is made.
   */
  async planNight(id: string, cycleDate: string): Promise<PlanOutcome[]> {
    const agent = this.agents.get(id)
    if (!agent) return [{ refusal: { status: 404, code: 'unknown', error: 'no such Fellow' } }]
    if (agent.nightly !== 'sweep') return [this.plan(id, { cycleDate })]
    const active = agent.tasks.filter((t) => t.state === 'active')
    if (active.length === 0) return [this.plan(id, { cycleDate })]
    const out: PlanOutcome[] = []
    for (const task of active) {
      const outcome = this.plan(id, { cycleDate, task })
      out.push(outcome)
      if (outcome.run) await this.settled(outcome.run.id)
      // A refusal is the gate closing - the budget, the plan share, a rate limit. The tasks
      // after this one would meet the same wall, so the night stops here rather than
      // collecting the same refusal three times.
      if (outcome.refusal) break
    }
    return out
  }

  /** A user decision on a proposal (section 6.5): approve, veto, undo, edit the topic, reorder. */
  async decide(proposalId: string, input: DecisionInput): Promise<DecisionOutcome> {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) return { refusal: { status: 404, code: 'unknown', error: 'no such proposal' } }
    if (!DECIDABLE.includes(proposal.status)) {
      return { refusal: { status: 409, code: 'state', error: `the proposal is ${proposal.status} and can no longer be decided` } }
    }
    const now = this.now().toISOString()
    const patch: { -readonly [K in keyof ProposalPatch]: ProposalPatch[K] } = {}
    if (input.status !== undefined && input.status !== proposal.status) {
      patch.status = input.status
      patch.decidedAt = input.status === 'proposed' ? null : now
      patch.decidedVia = input.status === 'proposed' ? null : (input.via ?? 'dashboard')
    }
    if (input.note !== undefined) patch.userNote = input.note.trim() === '' ? null : input.note.trim()
    if (input.topic !== undefined && input.topic.trim() !== '') patch.topic = input.topic.trim()
    let next = this.proposals.update(proposalId, patch) ?? proposal
    if (input.rank !== undefined) next = this.reorder(next, input.rank)
    const agent = this.agents.get(proposal.agentId)
    if (agent && agent.state !== 'active' && agent.state !== 'paused' && agent.state !== 'retired' && agent.state !== 'blocked') {
      if (this.pendingProposals(agent.id).length > 0) {
        this.agents.update(agent.id, { state: 'waiting', sleepReason: null, sleepCode: null }, now)
      } else if (agent.state === 'waiting') {
        this.agents.update(agent.id, { state: 'sleeping', sleepReason: 'every proposal was decided; the planner runs in the next night shift', sleepCode: 'idle' }, now)
      }
      const fresh = this.agents.get(agent.id)
      if (fresh) await this.writeNotebook(fresh)
    }
    return { proposal: this.proposals.get(proposalId) ?? next }
  }

  /** Moves a pending proposal to `rank` among the Fellow's pending ones and renumbers the rest. */
  private reorder(proposal: ProposalRecord, rank: number): ProposalRecord {
    const pending = this.pendingProposals(proposal.agentId)
      .filter((p) => p.id !== proposal.id)
      .sort((a, b) => a.rank - b.rank)
    const at = Math.max(0, Math.min(pending.length, Math.round(rank) - 1))
    pending.splice(at, 0, proposal)
    let updated = proposal
    pending.forEach((p, i) => {
      if (p.rank !== i + 1) {
        const u = this.proposals.update(p.id, { rank: i + 1 })
        if (p.id === proposal.id && u) updated = u
      }
    })
    return updated
  }

  /** Puts a Fellow to sleep with a code and a reason; the notebook shows it under Plan. */
  sleep(id: string, code: AgentSleepCode, reason: string): AgentRecord | undefined {
    const next = this.agents.update(id, { state: 'sleeping', sleepReason: reason, sleepCode: code }, this.now().toISOString())
    if (next) this.enqueue(this.writeNotebook(next))
    return next
  }

  /** The shift's dedupe (section 6.6): an undecided proposal loses to a near-duplicate elsewhere. */
  supersedeProposal(proposalId: string, note: string): void {
    const p = this.proposals.get(proposalId)
    if (!p || p.status !== 'proposed') return
    this.proposals.update(proposalId, { status: 'superseded', userNote: note })
    const agent = this.agents.get(p.agentId)
    if (agent && agent.state === 'waiting' && this.pendingProposals(agent.id).length === 0) {
      this.agents.update(agent.id, { state: 'sleeping', sleepReason: 'its proposals were merged into another Fellow\'s plan', sleepCode: 'idle' }, this.now().toISOString())
    }
  }

  /** Pending handoffs routed to a Fellow, as the candidate computation wants them. */
  private handoffCandidates(agentId: string): Array<{ id: string; question: string; sourcePage: string | null; fromName: string }> {
    if (!this.handoffs) return []
    return this.handoffs.list({ status: ['pending'], toAgentId: agentId, limit: 20 }).map((h) => ({
      id: h.id,
      question: h.question,
      sourcePage: h.sourcePage,
      fromName: this.agents.get(h.fromAgentId)?.name ?? 'another Fellow',
    }))
  }

  /** Every handoff still open: pending ones with their target, unclaimed ones for the recap. */
  listHandoffs(): HandoffRecord[] {
    return this.handoffs?.list({ status: ['pending', 'proposed', 'unclaimed'], limit: 100 }) ?? []
  }

  getHandoff(id: string): HandoffRecord | undefined {
    return this.handoffs?.get(id)
  }

  /** The Fellow a question of `domain` is routed to (D4): unretired, unpaused, highest priority, never `except`. */
  private targetFor(domain: string, except: string): AgentRecord | undefined {
    return this.agents
      .list()
      .filter((a) => a.id !== except && a.state !== 'retired' && a.state !== 'paused' && (a.homeDomain === domain || a.extraDomains.includes(domain)))
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0]
  }

  /** Turns the planner's routed candidates into handoff rows (D4): to a Fellow, or unclaimed. */
  private routeHandoffs(agent: AgentRecord, answer: { readonly handoffs: ReadonlyArray<{ candidate: string; domain: string; reason: string }> }, candidates: readonly Candidate[], cycleDate: string, now: string): void {
    if (!this.handoffs) return
    const known = new Set(this.registry().map((d) => d.key))
    const open = this.handoffs.list({ status: ['pending', 'unclaimed', 'proposed'], limit: 500 })
    const norm = (q: string): string => q.toLowerCase().replace(/\s+/g, ' ').trim()
    for (const h of answer.handoffs) {
      const candidate = candidates.find((c) => c.id === h.candidate)
      if (!candidate || candidate.kind === 'handoff') continue
      if (known.size > 0 && !known.has(h.domain)) {
        this.log('warn', `fellows: ${agent.name} routed "${candidate.text.slice(0, 60)}" to an unknown domain ${h.domain}; ignored`)
        continue
      }
      if (h.domain === agent.homeDomain || agent.extraDomains.includes(h.domain)) continue
      if (open.some((o) => norm(o.question) === norm(candidate.text))) continue
      const target = this.targetFor(h.domain, agent.id)
      this.handoffs.create({
        id: randomUUID(),
        fromAgentId: agent.id,
        toAgentId: target?.id ?? null,
        question: candidate.text,
        sourcePage: candidate.sourcePages[0] ?? null,
        domain: h.domain,
        reason: h.reason,
        createdAt: now,
        cycleDate,
        status: target ? 'pending' : 'unclaimed',
        proposalId: null,
        updatedAt: now,
      })
      this.log('info', `fellows: ${agent.name} handed "${candidate.text.slice(0, 60)}" to ${target ? target.name : `nobody (unclaimed, ${h.domain})`}`)
    }
  }

  /**
   * Spawns a Fellow from an unclaimed request (section 6.6, D5): intent, home domain and
   * provenance come from the request, the rest from the input; the request is then routed
   * to the new Fellow as a pending handoff.
   */
  async spawnFromHandoff(handoffId: string, input: Partial<SpawnInput> = {}): Promise<SpawnOutcome & { readonly handoff?: HandoffRecord }> {
    const h = this.handoffs?.get(handoffId)
    if (!h) return { refusal: { status: 404, code: 'unknown', error: 'no such request' } }
    if (h.status !== 'unclaimed') return { refusal: { status: 409, code: 'state', error: `the request is ${h.status}` } }
    const from = this.agents.get(h.fromAgentId)
    const name = input.name?.trim() || `${h.domain.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} Fellow`
    const outcome = await this.spawn({
      ...input,
      name,
      intent: input.intent?.trim() || h.question,
      homeDomain: input.homeDomain ?? h.domain,
      scope: input.scope ?? `Handed off by ${from?.name ?? 'another Fellow'}${h.sourcePage ? ` from ${h.sourcePage}` : ''}${h.reason ? `: ${h.reason}` : ''}`,
    })
    if (!outcome.agent) return outcome
    const now = this.now().toISOString()
    const claimed = this.handoffs!.update(handoffId, { toAgentId: outcome.agent.id, status: 'pending', updatedAt: now })
    return { ...outcome, ...(claimed ? { handoff: claimed } : {}) }
  }

  /**
   * What the planner would be shown for one task (the dashboard's "why this plan" view).
   *
   * `task` is which one to build the list for; without it, the one the rotation has up. It has
   * to be asked for, because the list is not the same for every task: the standing sweep
   * candidate IS the task, and it is the only candidate a task can stand on by itself.
   */
  candidates(agentId: string, task?: AgentTask): { candidates: Candidate[]; since: string | null } | undefined {
    const agent = this.agents.get(agentId)
    if (!agent) return undefined
    const runs = this.runs.list({ agentId, limit: 200 })
    const since = runs.find((r) => isResearchKind(r.kind))?.startedAt ?? agent.createdAt
    const chosen = task ?? taskForTonight(agent.tasks, agent.taskCursor)?.task
    return { candidates: this.candidatesFn(agent, runs, since, chosen), since }
  }

  /**
   * How many runs in a row followed up a question this Fellow wrote itself: the executed
   * proposals, newest first, read through `ownQuestionStreak`. Only executed ones count - a
   * proposal the user vetoed or let expire never became a run, so it never narrowed anything.
   */
  private selfLoopOf(agent: AgentRecord): number {
    const executed = this.proposals
      .list({ agentId: agent.id, status: ['executed'], limit: SELF_LOOP_LIMIT + 2 })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((p) => ({ candidate: p.provenance.candidate }))
    return ownQuestionStreak(executed)
  }

  /** What this Fellow asked for on the reading list and has since arrived in the vault. */
  private filedReadingOf(agent: AgentRecord): Array<{ title: string; page: string; why: string | null; filedAt: string | null }> {
    if (!this.reading) return []
    try {
      return this.reading
        .entries()
        // `held` as well as the mark: a page about the publication is not the publication, and
        // a candidate that says "go read it" has to be about something the vault actually has.
        .filter((e) => e.filed !== null && e.held && (e.by === null || e.by.toLowerCase() === agent.name.toLowerCase()))
        .map((e) => ({ title: e.title, page: e.filed!, why: e.why, filedAt: e.filedAt }))
    } catch {
      return []
    }
  }

  /**
   * The loop the reading list closes (section 10.6): a publication a Fellow asked for has
   * arrived in the vault - by the ingest button, or as a PDF the user fetched and dropped in,
   * which no url could have matched. The entry is marked, and the Fellow that asked gets one
   * line in its notebook, so the next planning run works from it instead of searching again.
   */
  async noteFiledReading(cycleDate: string): Promise<number> {
    if (!this.reading) return 0
    let filed: ReadonlyArray<{ entry: ReadingEntryInput; page: string }>
    try {
      filed = await this.reading.reconcile(cycleDate)
    } catch (err) {
      this.log('warn', `fellows: reading list not reconciled: ${(err as Error).message}`)
      return 0
    }
    if (filed.length === 0) return 0
    const byAgent = new Map<string, NotebookNote[]>()
    for (const f of filed) {
      const agent = this.agents.list().find((a) => a.name.toLowerCase() === (f.entry.by ?? '').toLowerCase())
      this.log('info', `fellows: "${f.entry.title}" from the reading list is in the vault as ${f.page}`)
      if (!agent) continue
      // A retired Fellow plans no more, so a line for its next plan has nowhere to go; the
      // entry's own `filed` mark is the record that the publication arrived.
      if (agent.state === 'retired') continue
      const line = `The publication you asked for is in the vault: "${f.entry.title}" as ${f.page}${f.entry.why ? ` - you wanted it because: ${f.entry.why}` : ''}`
      /*
       * Keyed on the page, so the note is written once per publication however often the
       * entry is marked. The mark itself is the only thing that normally prevents a repeat,
       * and it lives in a vault page a human can edit: one stale save took four marks with
       * it on 2026-09-14 and a Fellow was told the same thing twice two nights later.
       */
      byAgent.set(agent.id, [...(byAgent.get(agent.id) ?? []), { text: line, once: f.page }])
    }
    for (const [agentId, notes] of byAgent) {
      const agent = this.agents.get(agentId)
      if (!agent) continue
      const res = await this.writeNotebook(agent, { appendNotes: notes })
      /*
       * Said out loud rather than swallowed. A suppressed note means a mark was lost and
       * written again, and that is the only trace of it - dedupe without this line would
       * make the next such loss invisible, which is how this one nearly stayed invisible.
       */
      for (const key of res?.skippedNotes ?? []) {
        this.log('warn', `fellows: ${agent.name} was already told about ${key}; the reading list entry was marked again, so its mark was lost in between`)
      }
    }
    return filed.length
  }

  /**
   * Whether a Fellow that sleeps on `covered` or `stalled` has a wake trigger (section 5.3):
   * in A1, an ingest into its domains newer than the sleep. Returns the triggers' texts.
   */
  wakeTriggers(agentId: string): string[] {
    const agent = this.agents.get(agentId)
    if (!agent) return []
    const runs = this.runs.list({ agentId, limit: 50 })
    return this.candidatesFn(agent, runs, agent.updatedAt)
      .filter((c) => c.kind === 'ingest')
      .map((c) => c.text)
  }

  /** Resolves when the run settled and this service finished handling it (the shift awaits it). */
  settled(runId: string): Promise<MaintenanceRun> {
    const known = this.settling.get(runId)
    if (known) return known
    const run = this.maintenance.getRun(runId)
    if (run && run.status !== 'running') return Promise.resolve(run)
    return new Promise((resolve) => this.maintenance.onRunSettled(runId, resolve))
  }

  /** Waits for notebook rewrites triggered by settled runs (tests, shutdown). */
  async flush(): Promise<void> {
    while (this.pending.length > 0) await Promise.allSettled(this.pending)
  }

  /**
   * Holds a detached piece of background work so `flush` can wait for it, and swallows its
   * failure into a log line.
   *
   * The catch is the point. Everything enqueued here is work the caller already returned
   * without: the notebook rewrite after a settle, the planning run chained onto a spawn's
   * first run ("a courtesy and not a promise"). None of it may fail the call that started it,
   * and an unhandled rejection in Node takes the process down, so a database error during a
   * shutdown would end the service over work whose result nobody was waiting for.
   * `track` already catches inside its own handler for the same reason; this is that rule in
   * the one place every caller passes through.
   */
  private enqueue(p: Promise<unknown>): void {
    const guarded = p.catch((err: unknown) => {
      this.log('warn', `fellows: background work failed: ${(err as Error).message}`)
    })
    this.pending.push(guarded)
    void guarded.finally(() => {
      this.pending = this.pending.filter((x) => x !== guarded)
    })
  }

  private track(agentId: string, run: MaintenanceRun, handler: (settled: MaintenanceRun) => Promise<void>): void {
    this.inFlight.set(agentId, run.id)
    const done = new Promise<MaintenanceRun>((resolve) => {
      this.maintenance.onRunSettled(run.id, (settled) => {
        const p = handler(settled)
          .catch((err: unknown) => this.log('warn', `fellows: settle handling failed: ${(err as Error).message}`))
          .then(() => {
            // Only clear our own slot: a retry started from inside the handler already put
            // its run there, and deleting that would let a third run start beside it.
            if (this.inFlight.get(agentId) === run.id) this.inFlight.delete(agentId)
            resolve(settled)
          })
        this.enqueue(p)
      })
    })
    this.settling.set(run.id, done)
    void done.finally(() => {
      // Keep the map bounded: the promise is only needed while someone may still await it.
      setTimeout(() => this.settling.delete(run.id), 60_000).unref?.()
    })
  }

  /** A deepening's budget grows with its page count; every other kind has a flat one. */
  private budgetFor(kind: RunKind, pages: number): number {
    return kind === 'research-expand' ? expandBudgetUsd(BUDGET_USD[kind], pages) : BUDGET_USD[kind]
  }

  private context(agent: AgentRecord, kind: RunKind, proposalId?: string, pages = 0): FellowRunContext {
    const recent = renderLogLines(this.runs.list({ agentId: agent.id, limit: 5 }))
    const deep = kind === 'research' && agent.step === 'deep'
    const effortIndex = AGENT_EFFORTS.indexOf(agent.effort)
    const effort = deep ? (AGENT_EFFORTS[Math.min(effortIndex + 1, AGENT_EFFORTS.length - 1)] ?? agent.effort) : agent.effort
    return {
      agentId: agent.id,
      name: agent.name,
      slug: agent.slug,
      notebookPath: agent.notebookPath,
      intent: agent.intent,
      scope: agent.scope,
      model: MODEL_IDS[agent.model],
      effort,
      maxBudgetUsd: Math.round(this.budgetFor(kind, pages) * MODEL_FACTOR[agent.model] * 100) / 100,
      recentLog: recent.slice(-5),
      today: localDate(this.now()),
      ...(deep ? { timeoutMs: DEEP_TIMEOUT_MS } : {}),
      ...(kind === 'research-expand' && pages > 0 ? { timeoutMs: this.timeoutFor(agent, kind, pages) } : {}),
      ...(proposalId !== undefined ? { proposalId } : {}),
    }
  }

  /** The vault graph when the service was given one; null in tests and read-only wirings. */
  private graphOf(): VaultGraph | null {
    try {
      return this.sources?.graph?.() ?? null
    } catch {
      return null
    }
  }

  /** The settle state machine for a research kind (docs/tasks/TASKS-A1.md D8). */
  private async onStepSettled(agentId: string, settled: MaintenanceRun): Promise<void> {
    const now = this.now().toISOString()
    const agent = this.agents.get(agentId)
    if (!agent) return
    let patch: AgentPatch
    if (settled.status !== 'done' && settled.kind === 'research-expand' && (settled.error ?? '').startsWith('expand run reverted')) {
      // D3: the fault is in one run's output, not in the Fellow; the planner carries on.
      patch = { state: 'sleeping', sleepReason: settled.error ?? 'the expand run was reverted', sleepCode: 'idle' }
    } else if (settled.status !== 'done') {
      patch = { state: 'blocked', sleepReason: settled.error ?? 'the last run failed', sleepCode: null }
    } else {
      const history = this.runs.list({ agentId, limit: 10 }).filter((r) => isResearchKind(r.kind))
      const [last, previous] = history
      const changedNothing = (r: AgentRunRecord | undefined): boolean => r !== undefined && r.ok && knowledgePages(r.pages).length === 0
      if (changedNothing(last) && changedNothing(previous)) {
        patch = { state: 'sleeping', sleepReason: 'two runs in a row changed no knowledge page; edit the intent or start a step by hand to wake it', sleepCode: 'stalled' }
      } else if (this.pendingProposals(agentId).length > 0) {
        patch = { state: 'waiting', sleepReason: null, sleepCode: null }
      } else {
        patch = { state: 'sleeping', sleepReason: 'nothing planned; the planner runs in the next night shift', sleepCode: 'idle' }
      }
    }
    const next = this.agents.update(agentId, patch, now)
    if (!next) return
    const written = await this.writeNotebook(next)
    // The user may have edited intent or scope on the page (section 5.4): the page wins.
    const edit: { intent?: string; scope?: string } = {}
    if (written?.readBack.intent && written.readBack.intent !== next.intent) edit.intent = written.readBack.intent
    if (written?.readBack.scope && written.readBack.scope !== next.scope) edit.scope = written.readBack.scope
    if (edit.intent !== undefined || edit.scope !== undefined) this.agents.update(agentId, edit, now)
  }

  /** Turns a settled planning run into proposals (sections 6.2 to 6.4). */
  private async onPlanSettled(
    agentId: string,
    settled: MaintenanceRun,
    candidates: readonly Candidate[],
    kinds: readonly ProposalKind[],
    cycleDate: string,
    attempt = 1,
    /** The standing task this plan was for: what its proposals replace, and nothing else. */
    task: AgentTask,
  ): Promise<void> {
    const now = this.now().toISOString()
    const agent = this.agents.get(agentId)
    if (!agent) return
    const answer = settled.status === 'done' ? parsePlannerAnswer(settled.result?.structuredOutput) : undefined
    if (!answer) {
      const why = settled.status === 'done' ? 'its answer did not match the schema' : (settled.error ?? 'it failed')
      this.log('warn', `fellows: planning run for ${agent.name} failed: ${why}`)
      // One immediate retry, with the reason in the prompt. Waiting a whole night for the
      // next shift costs the Fellow a day over something a second attempt usually fixes.
      if (attempt < PLAN_ATTEMPTS) {
        // This Fellow counts as in flight until the handler returns, and the retry takes that
        // same slot, so hand it over rather than letting the gate refuse our own retry.
        this.inFlight.delete(agentId)
        const retry = this.plan(agentId, {
          cycleDate,
          attempt: attempt + 1,
          retryNote:
            'Your previous answer in this cycle could not be used: ' +
            `${why}. Answer again in exactly the required structure, keeping every field inside its stated limit.`,
        })
        if (retry.run) {
          this.log('info', `fellows: planning run for ${agent.name} retried once`)
          // Awaited, so the shift sees the outcome of the retry and not an empty first attempt.
          await this.settled(retry.run.id)
          return
        }
        this.log('warn', `fellows: planning retry for ${agent.name} did not start: ${retry.refusal?.error ?? retry.skipped ?? 'unknown'}`)
      }
      this.agents.update(
        agentId,
        { state: 'sleeping', sleepReason: `the planning run failed (${why}); the planner tries again in the next night shift`, sleepCode: 'plan-failed' },
        now,
      )
      const fresh = this.agents.get(agentId)
      if (fresh) await this.writeNotebook(fresh)
      return
    }
    for (const d of answer.dropped) this.log('warn', `fellows: ${agent.name}: ${d}`)
    // The planner reads the vault and no web: a publication it names can only reach the list
    // as data, written by the service (section 10.6). It names the ones a run could NOT get
    // too, which are the entries the user's own access is worth using on.
    if (this.reading && answer.reading.length > 0) {
      try {
        const { added } = await this.reading.add(
          answer.reading.map((r) => ({
            title: r.title,
            url: r.url,
            ref: r.ref,
            domain: r.domain ?? agent.homeDomain,
            why: r.why,
            found: null,
            by: agent.name,
            at: cycleDate,
            access: r.access,
            blocked: r.blocked,
            filed: null,
            filedAt: null,
            archivedAt: null,
            oa: null,
          })),
        )
        if (added > 0) this.log('info', `fellows: ${agent.name} added ${added} entr${added === 1 ? 'y' : 'ies'} to the reading list`)
      } catch (err) {
        this.log('warn', `fellows: reading list not written: ${(err as Error).message}`)
      }
    }
    const root = this.vaultRoot
    const built = buildProposals({
      agent,
      answer,
      candidates,
      kinds,
      ...(task !== undefined ? { task } : {}),
      cycleDate,
      now,
      newId: () => randomUUID(),
      pageExists: (page) => (root === undefined ? true : fs.existsSync(path.join(root, page))),
      ownPages: [...fellowSynthesisPages(this.runs.list({ agentId, limit: 50 })), agent.notebookPath],
      ...(this.estimatePct ? { estimatePct: (cost, model) => this.estimatePct!(cost, model).sevenDay } : {}),
      costHistory: this.costHistory(),
    })
    for (const r of built.rejected) this.log('warn', `fellows: ${agent.name}: proposal dropped, ${r}`)
    for (const t of built.clamped) this.log('info', `fellows: ${agent.name}: "${t}" clamped to a step, no listed page exists`)
    this.routeHandoffs(agent, answer, candidates, cycleDate, now)
    /*
     * A new plan replaces what was still undecided FOR THIS TASK; approved proposals survive
     * (section 6.5). Scoped to the task because a Fellow can plan several in one night: a
     * whole-Fellow supersede let each run of a sweep wipe the one before it, so a night of
     * three planning runs ended with one task's worth of work. It also stops a rotation from
     * discarding a task's standing proposal because a different task came up.
     */
    this.proposals.supersede(agentId, task.text)
    let kept = 0
    for (const p of built.proposals) {
      if (agent.autonomy === 'auto' && isDrift(p.scopeScore)) {
        this.log('warn', `fellows: ${agent.name}: "${p.topic}" dropped as drift (score ${p.scopeScore}) in auto mode`)
        continue
      }
      this.proposals.create(p)
      kept++
      // A proposal built from a handoff settles that handoff (D5).
      const source = candidates.find((c) => c.text === p.provenance.text && c.kind === 'handoff')
      if (source?.handoffId !== undefined) this.handoffs?.update(source.handoffId, { status: 'proposed', proposalId: p.id, updatedAt: now })
    }
    const pending = this.pendingProposals(agentId)
    if (pending.length > 0) {
      this.agents.update(agentId, { state: 'waiting', sleepReason: null, sleepCode: null }, now)
      this.log('info', `fellows: ${agent.name} has ${kept} new proposal(s), ${pending.length} pending`)
    } else {
      /*
       * `intent_covered` is per task now, and only an explore task can reach it: watch and
       * deepen are standing work, and standing work that declares itself finished is a bug.
       * The Fellow sleeps only once every task rests - one answered question used to send the
       * whole Fellow to bed.
       */
      const covered = answer.intentCovered && task !== undefined && task.kind === 'explore'
      const tasks = covered ? restTask(agent.tasks, task.id) : agent.tasks
      if (covered) this.log('info', `fellows: ${agent.name} rests task "${task.text}" - answered as far as the library can take it`)
      /*
       * Sleep only when there is nothing ELSE to try. A task that was answered rests and the
       * others carry on; a night that simply had nothing in it does not stop a Fellow whose
       * next task is a different subject. With one task both come out as before - it sleeps -
       * which is right: planning into the same emptiness every night costs a run each time.
       */
      const elsewhere = tasks.some((t) => t.state === 'active' && t.id !== task?.id)
      const reason = answer.reason.trim() || (covered ? 'the planner reports this task as covered' : 'the planner found nothing worth a run')
      if (elsewhere) {
        this.agents.update(agentId, { state: 'waiting', sleepReason: null, sleepCode: null, ...(covered ? { tasks } : {}) }, now)
        this.log('info', `fellows: ${agent.name} has nothing for tonight (${reason}); ${tasks.filter((t) => t.state === 'active').length} task(s) still standing`)
      } else {
        this.agents.update(agentId, { state: 'sleeping', sleepReason: reason, sleepCode: 'covered', ...(covered ? { tasks } : {}) }, now)
        this.log('info', `fellows: ${agent.name} sleeps: ${reason}`)
      }
    }
    const fresh = this.agents.get(agentId)
    if (fresh) await this.writeNotebook(fresh)
  }

  /** Renders and commits the notebook with the current Plan section; never throws. */
  private async writeNotebook(
    agent: AgentRecord,
    opts: { readonly forceIntentScope?: boolean; readonly appendNotes?: readonly NotebookNote[] } = {},
  ): Promise<Awaited<ReturnType<NotebookWriter['write']>> | undefined> {
    try {
      const plan = renderPlanSection({
        pending: this.pendingProposals(agent.id),
        autonomy: agent.autonomy,
        window: this.settings().window,
        idleReason: agent.state === 'sleeping' ? agent.sleepReason : null,
        ...(agent.skipUntil !== null ? { skipUntil: agent.skipUntil } : {}),
      })
      return await this.notebook.write(agent, this.runs.list({ agentId: agent.id, limit: 200 }), plan, opts)
    } catch (err) {
      this.log('warn', `fellows: notebook of ${agent.name} not written: ${(err as Error).message}`)
      return undefined
    }
  }

  /**
   * Frees Fellows left `active` by a process that died mid-run (called once at startup).
   *
   * `active` means "a run is in flight right now", and that fact lives in two places: the row
   * in SQLite, and the settle subscription in {@link track}, which is memory. A process that
   * goes away between the two - a crash, a machine shutting down at one in the morning - keeps
   * the row and loses the subscription, so nothing ever writes the state back.
   *
   * The cost of leaving it is not a runaway but the opposite: the shift skips an `active`
   * Fellow in BOTH phases ("a run is already in flight", and again when planning), so a flag
   * nobody can see quietly takes it out of service for good. This is the same gap the queue
   * closes for interrupted jobs; the Fellows had no equivalent.
   *
   * Safe to call at any time: a run that really is in flight is in `inFlight`, and is skipped.
   */
  reconcileInterrupted(): string[] {
    const now = this.now().toISOString()
    const freed: string[] = []
    for (const agent of this.agents.list()) {
      if (agent.state !== 'active' || this.inFlight.has(agent.id)) continue
      this.agents.update(
        agent.id,
        {
          state: 'sleeping',
          sleepReason: 'a run was interrupted by a restart; the planner runs in the next night shift',
          sleepCode: 'idle',
        },
        now,
      )
      freed.push(agent.name)
    }
    if (freed.length > 0) {
      this.log('info', `fellows: freed after a restart interrupted a run: ${freed.join(', ')}`)
    }
    return freed
  }

  async pause(id: string): Promise<AgentRecord | undefined> {
    // Retired is final: pausing it would make it look resumable.
    const agent = this.agents.get(id)
    if (agent?.state === 'retired') return agent
    return this.setState(id, { state: 'paused', sleepReason: 'paused by you', sleepCode: null })
  }

  /**
   * Resumes a paused Fellow; also clears `blocked` (the user has seen the failure) and
   * `active` (a run that no longer exists, if reconciliation somehow did not catch it - the
   * user should not have to go through `pause` to get out of a state the service left behind).
   */
  async resume(id: string): Promise<AgentRecord | undefined> {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    const stuck = agent.state === 'active' && !this.inFlight.has(agent.id)
    if (agent.state === 'retired') return agent
    if (agent.state !== 'paused' && agent.state !== 'blocked' && !stuck) return agent
    const pending = this.pendingProposals(id).length > 0
    return this.setState(
      id,
      pending
        ? { state: 'waiting', sleepReason: null, sleepCode: null }
        : { state: 'sleeping', sleepReason: 'resumed; the planner runs in the next night shift', sleepCode: 'idle' },
    )
  }

  /** Retires a Fellow: pending proposals expire, the notebook says so, its pages stay (section 5.2). */
  /** The lowest desk no living Fellow keeps, or null when all ten are taken. */
  private freeDesk(): number | null {
    const taken = new Set(this.agents.list().filter((a) => a.state !== 'retired').map((a) => a.desk))
    for (let n = 0; n < DESK_COUNT; n++) if (!taken.has(n)) return n
    return null
  }

  async retire(id: string): Promise<AgentRecord | undefined> {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    for (const p of this.pendingProposals(id)) this.proposals.update(p.id, { status: 'expired' })
    // Pending handoffs to a retired Fellow become unclaimed requests (section 5.2).
    const unclaimed = this.handoffs?.unclaimTarget(id, this.now().toISOString()) ?? 0
    if (unclaimed > 0) this.log('info', `fellows: ${unclaimed} handoff(s) to ${agent.name} are unclaimed now`)
    // A skip is a statement about a night to come; a retired Fellow has none - and its desk
    // goes back to the room, for the next spawn to take.
    return this.setState(id, { state: 'retired', sleepReason: null, sleepCode: null, skipUntil: null, desk: null, retiredAt: this.now().toISOString() })
  }

  /** Removes a retired Fellow's record; the notebook and its pages stay in the vault. */
  remove(id: string): { ok: true } | Refusal {
    const agent = this.agents.get(id)
    if (!agent) return { status: 404, code: 'unknown', error: 'no such Fellow' }
    if (agent.state !== 'retired') return { status: 409, code: 'state', error: 'retire the Fellow before removing its record' }
    this.agents.remove(id)
    return { ok: true }
  }

  private async setState(id: string, patch: AgentPatch): Promise<AgentRecord | undefined> {
    const next = this.agents.update(id, patch, this.now().toISOString())
    if (!next) return undefined
    await this.writeNotebook(next)
    return next
  }

  /**
   * Edits the record. An intent or scope edit is written through to the notebook (the page
   * would otherwise win it back at the next settle) and wakes a sleeping Fellow (section 5.3).
   *
   * A task list arrives from the API as sentences and arts; the ids, the `intent` summary and
   * the cursor are this method's business, so no caller can leave a Fellow with a cursor
   * pointing past its own list or an intent that no longer matches its first task.
   *
   * An edit that cannot stand comes back as a refusal rather than as the unchanged record: a
   * silent no-op reports success for a change that did not happen, and the two are
   * indistinguishable to a caller that only reads the record back.
   */
  async update(id: string, patch: AgentPatch & { readonly taskInput?: readonly TaskInput[] }): Promise<UpdateOutcome> {
    const prev = this.agents.get(id)
    if (!prev) return { refusal: { status: 404, code: 'unknown', error: 'no such Fellow' } }
    const { taskInput, ...rest } = patch
    let edit: AgentPatch = rest
    const nextArt = (rest.art ?? prev.art) as AgentArt
    // Narrowing the art without touching the list has to hold the list it lands on.
    if (taskInput === undefined && rest.art !== undefined) {
      const artBad = artRefusal(nextArt, prev.tasks)
      if (artBad) return { refusal: artBad }
    }
    if (taskInput !== undefined) {
      const tasks = normalizeTasks(taskInput)
      if (tasks.length === 0) return { refusal: { status: 409, code: 'kind', error: 'a Fellow needs at least one task' } }
      // A task the user kept keeps its state: replacing the list should not wake a task the
      // planner has already answered, and editing its wording should.
      const withState = tasks.map((t) => {
        const before = prev.tasks.find((p) => p.text === t.text && p.kind === t.kind)
        return before ? { ...t, state: before.state } : t
      })
      // The art the edit lands on: the patch's if it sets one, otherwise the Fellow's own.
      const artBad = artRefusal(nextArt, withState)
      if (artBad) return { refusal: artBad }
      edit = { ...edit, tasks: withState, intent: withState[0]!.text, taskCursor: Math.min(prev.taskCursor, withState.length - 1) }
    }
    const patchedIntent = edit.intent
    const intentEdit = (patchedIntent !== undefined && patchedIntent !== prev.intent) || (edit.scope !== undefined && edit.scope !== prev.scope)
    const wake: AgentPatch =
      intentEdit && prev.state === 'sleeping'
        ? { state: 'sleeping', sleepReason: 'intent edited; the planner reconsiders in the next night shift', sleepCode: 'idle' }
        : {}
    const next = this.agents.update(id, { ...edit, ...wake }, this.now().toISOString())
    if (!next) return { refusal: { status: 404, code: 'unknown', error: 'no such Fellow' } }
    if (intentEdit) await this.writeNotebook(next, { forceIntentScope: true })
    return { agent: next }
  }
}
