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
  slugify,
  type AgentAutonomy,
  type AgentEffort,
  type AgentModel,
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
import { notebookPath, renderLogLines, type NotebookWriter } from './notebook.js'
import type { FellowRunContext } from './fellow-prompts.js'
import { startOfToday } from './budget.js'
import { computeCandidates, knowledgePages, type Candidate } from './candidates.js'
import { localDate, addDays, windowAt } from './clock.js'
import type { VaultGraph } from './graph.js'
import {
  buildProposals,
  isDrift,
  kindsForStep,
  parsePlannerAnswer,
  plannerSchema,
  renderPlanSection,
  renderPlannerPrompt,
  type DomainHint,
} from './planner.js'
import { DEFAULT_NIGHT_WINDOW, DEFAULT_RESEARCH_MODEL } from '../db/settings.js'

/** Per-kind USD cap on Sonnet 5 (docs/agents/SPEC.md sections 6.2 and 7), scaled by the model factor. */
export const BUDGET_USD: Readonly<Record<RunKind, number>> = { research: 12, 'research-step': 4, 'research-expand': 6, plan: 1 }
/** A `deep` step is a full run with a longer leash (section 7). */
export const DEEP_TIMEOUT_MS = 45 * 60_000
const STEP_TIMEOUT_MS = 15 * 60_000

export type StepKind = 'research' | 'research-step' | 'research-expand'
export type RunKind = StepKind | 'plan'

export interface SpawnInput {
  readonly name: string
  readonly intent: string
  readonly scope?: string
  readonly homeDomain: string
  readonly extraDomains?: readonly string[]
  readonly lens?: string
  readonly model?: AgentModel
  readonly effort?: AgentEffort
  readonly step?: AgentStep
  readonly quotaRunsPerDay?: number
  readonly autonomy?: AgentAutonomy
  readonly priority?: number
  /** Start the first full research run on the intent right away (default true, section 5.1). */
  readonly runFirstStep?: boolean
}

export type RefusalCode = 'unknown' | 'state' | 'in-flight' | 'quota' | 'budget' | 'kind'

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

export interface PlanOutcome {
  readonly run?: MaintenanceRun
  readonly refusal?: Refusal
  /** The planner was not started because there was nothing to plan from; the reason. */
  readonly skipped?: string
}

export interface FellowSummary {
  readonly agent: AgentRecord
  readonly currentRun: MaintenanceRun | null
  readonly lastRun: AgentRunRecord | null
  readonly runsToday: number
  /** Proposals still to decide or to run. */
  readonly pendingProposals: number
  /** The proposal the next shift would run, if any. */
  readonly next: ProposalRecord | null
}

export interface FellowSpend {
  readonly todayUsd: number
  readonly weekUsd: number
  readonly runsToday: number
  readonly runsWeek: number
}

export interface FellowCard extends FellowSummary {
  /** Newest first, capped. */
  readonly runs: readonly AgentRunRecord[]
  /** Every page the Fellow's runs committed, newest first, deduplicated. */
  readonly pages: readonly string[]
  readonly lastActive: string | null
  readonly quota: { readonly runsPerDay: number; readonly usedToday: number }
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
  readonly code: 'budget'
  readonly reason: string
}

export interface FellowServiceOptions {
  readonly agents: AgentStore
  readonly runs: AgentRunStore
  readonly proposals: ProposalStore
  readonly maintenance: MaintenanceRunner
  readonly notebook: NotebookWriter
  readonly now?: () => Date
  /** Candidate computation; the default reads the vault, the graph and the job store. */
  readonly candidates?: (agent: AgentRecord, runs: readonly AgentRunRecord[], since: string | null) => Candidate[]
  readonly candidateSources?: CandidateSources
  /** Service-wide block on starting runs (daily budget, rate-limit pause); null = clear. */
  readonly gate?: () => GateBlock | null
  readonly settings?: () => FellowSettings
  /** The value signal (section 9.6); absent = the card shows no opens. */
  readonly values?: ValueEventStore
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
  private readonly now: () => Date
  private readonly candidatesFn: (agent: AgentRecord, runs: readonly AgentRunRecord[], since: string | null) => Candidate[]
  private readonly gate: () => GateBlock | null
  private readonly settings: () => FellowSettings
  private readonly values: ValueEventStore | undefined
  private readonly handoffs: HandoffStore | undefined
  private readonly registry: () => readonly DomainHint[]
  private readonly vaultRoot: string | undefined
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void
  /** One run in flight per Fellow: agent id to tracked run id. */
  private readonly inFlight = new Map<string, string>()
  /** Resolves once a run settled AND this service finished its settle handling. */
  private readonly settling = new Map<string, Promise<MaintenanceRun>>()
  /** Notebook rewrites still in progress; `flush()` awaits them. */
  private pending: Promise<unknown>[] = []

  constructor(opts: FellowServiceOptions) {
    this.agents = opts.agents
    this.runs = opts.runs
    this.proposals = opts.proposals
    this.maintenance = opts.maintenance
    this.notebook = opts.notebook
    this.now = opts.now ?? ((): Date => new Date())
    this.gate = opts.gate ?? ((): GateBlock | null => null)
    this.settings = opts.settings ?? ((): FellowSettings => ({ window: DEFAULT_NIGHT_WINDOW, defaultModel: DEFAULT_RESEARCH_MODEL }))
    this.values = opts.values
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
    const sources = opts.candidateSources
    this.candidatesFn =
      opts.candidates ??
      ((agent, runs, since): Candidate[] => {
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
        return computeCandidates({ agent, runs, vaultRoot: sources.vaultRoot, graph, jobs, since, handoffs: this.handoffCandidates(agent.id) })
      })
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id)
  }

  /** Every Fellow, in the night shift's order: priority first (higher earlier), then age; retired last. */
  list(): FellowSummary[] {
    return this.agents
      .list()
      .sort((a, b) => (a.state === 'retired' ? 1 : 0) - (b.state === 'retired' ? 1 : 0) || b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
      .map((agent) => this.summary(agent))
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
      runsToday: this.runsToday(agent.id),
      pendingProposals: this.pendingProposals(agent.id).length,
      next: this.runnable(agent.id) ?? null,
    }
  }

  card(id: string): FellowCard | undefined {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    const runs = this.runs.list({ agentId: id, limit: 50 })
    const pages: string[] = []
    for (const r of runs) for (const p of r.pages) if (!pages.includes(p)) pages.push(p)
    const usedToday = this.runsToday(id)
    return {
      ...this.summary(agent),
      runs,
      pages,
      lastActive: runs[0]?.finishedAt ?? null,
      quota: { runsPerDay: agent.quotaRunsPerDay, usedToday },
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
    await this.writeNotebook(agent, { appendNotes: [`Recap note ${date}: ${clean}`] })
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

  /** Steps this Fellow ran since local midnight; a planning run does not count. */
  private runsToday(agentId: string): number {
    return this.runs
      .list({ agentId, since: startOfToday(this.now()).toISOString() })
      .filter((r) => isResearchKind(r.kind)).length
  }

  /** USD totals for the card (list-price estimates in subscription mode). */
  spend(agentId: string): FellowSpend {
    const now = this.now()
    const week = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString()
    const weekRuns = this.runs.list({ agentId, since: week })
    const todayIso = startOfToday(now).toISOString()
    const todayRuns = weekRuns.filter((r) => r.startedAt >= todayIso)
    const sum = (rs: readonly AgentRunRecord[]): number => Math.round(rs.reduce((acc, r) => acc + (r.costUsd ?? 0), 0) * 100) / 100
    return { todayUsd: sum(todayRuns), weekUsd: sum(weekRuns), runsToday: todayRuns.length, runsWeek: weekRuns.length }
  }

  /** Creates the record and its notebook page, then (by default) runs the intent as a full research run. */
  async spawn(input: SpawnInput): Promise<SpawnOutcome> {
    const slug = slugify(input.name)
    if (this.agents.bySlug(slug) !== undefined) {
      return { refusal: { status: 409, code: 'state', error: `a Fellow named "${input.name}" (slug ${slug}) already exists` } }
    }
    const now = this.now().toISOString()
    const agent: AgentRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      slug,
      intent: input.intent.trim(),
      scope: input.scope?.trim() ? input.scope.trim() : null,
      homeDomain: input.homeDomain,
      extraDomains: input.extraDomains ?? [],
      lens: input.lens ?? 'broad',
      model: input.model ?? this.settings().defaultModel,
      effort: input.effort ?? 'high',
      step: input.step ?? 'standard',
      quotaRunsPerDay: input.quotaRunsPerDay ?? 1,
      quotaWeekPct: null,
      autonomy: input.autonomy ?? 'veto',
      priority: input.priority ?? 0,
      state: 'proposed',
      sleepReason: null,
      sleepCode: null,
      skipUntil: null,
      notebookPath: notebookPath(slug),
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
    }
    this.agents.create(agent)
    await this.writeNotebook(agent)
    if (input.runFirstStep === false) return { agent }
    const outcome = this.step(agent.id, { kind: 'research', topic: agent.intent })
    return { agent: this.agents.get(agent.id) ?? agent, ...(outcome.run ? { run: outcome.run } : {}), ...(outcome.refusal ? { refusal: outcome.refusal } : {}) }
  }

  /**
   * Why a run may not start for this Fellow right now, or null. The gate of section 8.4 as far
   * as A1 measures it: state, one run in flight per Fellow, runs per day, the daily budget and
   * the rate-limit pause. A planning run skips the quota (it is not a step).
   */
  gateFor(agent: AgentRecord, kind: RunKind): Refusal | null {
    if (agent.state === 'retired') return { status: 409, code: 'state', error: `${agent.name} is retired` }
    if (agent.state === 'paused') return { status: 409, code: 'state', error: `${agent.name} is paused; resume first` }
    // In flight until the run settled AND its settle handling (state, proposals, notebook) is done.
    if (this.inFlight.has(agent.id)) {
      return { status: 409, code: 'in-flight', error: `${agent.name} already has a run in flight` }
    }
    if (kind !== 'plan') {
      const used = this.runsToday(agent.id)
      if (used >= agent.quotaRunsPerDay) {
        return { status: 409, code: 'quota', error: `${agent.name} used today's quota (${used} of ${agent.quotaRunsPerDay} runs)` }
      }
    }
    const block = this.gate()
    if (block) return { status: 409, code: block.code, error: block.reason }
    return null
  }

  /** The timeout a run of this kind gets for this Fellow (the shift checks the window against it). */
  timeoutFor(agent: AgentRecord, kind: RunKind): number {
    if (kind === 'plan') return PLAN_TIMEOUT_MS
    if (kind === 'research-step') return STEP_TIMEOUT_MS
    if (kind === 'research-expand') return EXPAND_TIMEOUT_MS
    return agent.step === 'deep' ? DEEP_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  }

  /**
   * Starts one step now, subject to the gate. Returns the tracked run (202) or a refusal
   * (404/409). With a `proposalId` the run executes that proposal and marks it so.
   */
  step(
    id: string,
    opts: { readonly topic?: string; readonly kind?: StepKind; readonly lens?: string; readonly proposalId?: string; readonly pageSet?: readonly string[] } = {},
  ): StepOutcome {
    const agent = this.agents.get(id)
    if (!agent) return { refusal: { status: 404, code: 'unknown', error: 'no such Fellow' } }
    const refusal = this.gateFor(agent, opts.kind ?? 'research-step')
    if (refusal) return { refusal }
    const kind: StepKind = opts.kind ?? 'research-step'
    if (kind === 'research-expand' && (opts.pageSet === undefined || opts.pageSet.length === 0)) {
      return { refusal: { status: 409, code: 'kind', error: 'an expand run needs a page set' } }
    }
    const topic = opts.topic?.trim() ? opts.topic.trim() : agent.intent
    const ctx = this.context(agent, kind, opts.proposalId)
    const lens = opts.lens ?? agent.lens
    // The Fellow's own pages are always in an expand's set (D1): the run appends open
    // questions to its notebook, and its synthesis pages carry the update's summary.
    const pageSet = kind === 'research-expand' ? [...new Set([...(opts.pageSet ?? []), ...fellowSynthesisPages(this.runs.list({ agentId: agent.id, limit: 50 })), agent.notebookPath])] : []
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

  /** Executes a pending proposal now (the shift's path, and the card's "run this one"). */
  execute(proposalId: string): StepOutcome {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) return { refusal: { status: 404, code: 'unknown', error: 'no such proposal' } }
    if (!PENDING_STATUSES.includes(proposal.status)) {
      return { refusal: { status: 409, code: 'state', error: `the proposal is ${proposal.status}` } }
    }
    return this.step(proposal.agentId, { topic: proposal.topic, kind: proposal.kind, lens: proposal.lens, proposalId, pageSet: proposal.pageSet })
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
    const approved = pending.filter((p) => p.status === 'approved').sort((a, b) => a.rank - b.rank)
    if (approved[0]) return approved[0]
    if (agent.autonomy === 'manual') return undefined
    if (agent.state === 'sleeping' && (agent.sleepCode === 'covered' || agent.sleepCode === 'stalled')) return undefined
    return pending
      .filter((p) => p.status === 'proposed' && !isDrift(p.scopeScore))
      .sort((a, b) => a.rank - b.rank)[0]
  }

  /**
   * Starts a planning run (section 6.2) unless there is nothing to plan from, in which case
   * the Fellow sleeps with `no-candidates` and no planner cost is spent.
   */
  plan(id: string, opts: { readonly cycleDate?: string } = {}): PlanOutcome {
    const agent = this.agents.get(id)
    if (!agent) return { refusal: { status: 404, code: 'unknown', error: 'no such Fellow' } }
    const refusal = this.gateFor(agent, 'plan')
    if (refusal) return { refusal }
    const now = this.now()
    const cycleDate = opts.cycleDate ?? localDate(now)
    // Pending proposals from three cycles ago had their two nights (section 6.5).
    const expired = this.proposals.expire(agent.id, addDays(cycleDate, -2))
    if (expired > 0) this.log('info', `fellows: ${expired} proposal(s) of ${agent.name} expired`)
    const runs = this.runs.list({ agentId: agent.id, limit: 200 })
    const { candidates } = this.candidates(agent.id) ?? { candidates: [] }
    if (candidates.length === 0) {
      const reason = `no open questions and no candidates in ${[agent.homeDomain, ...agent.extraDomains].join(', ')}`
      this.sleep(agent.id, 'no-candidates', reason)
      return { skipped: reason }
    }
    const kinds = kindsForStep(agent.step)
    const vetoed = this.proposals
      .list({ agentId: agent.id, status: ['vetoed'], limit: 10 })
      .map((p) => p.topic)
    const domains = this.handoffs ? this.registry() : []
    const prompt = renderPlannerPrompt({
      agent,
      candidates,
      recentLog: renderLogLines(runs.slice(0, 8)).slice(-8),
      vetoed,
      runsLeftToday: Math.max(0, agent.quotaRunsPerDay - this.runsToday(agent.id)),
      kinds,
      domains,
    })
    const schema = plannerSchema({ kinds, candidateIds: candidates.map((c) => c.id), domainKeys: domains.map((d) => d.key) })
    const run = this.maintenance.startPlan(prompt, this.context(agent, 'plan'), schema)
    this.track(agent.id, run, (settled) => this.onPlanSettled(agent.id, settled, candidates, kinds, cycleDate))
    this.agents.update(agent.id, { state: 'active', sleepReason: null, sleepCode: null }, now.toISOString())
    this.log('info', `fellows: planning run for ${agent.name} started with ${candidates.length} candidate(s)`)
    return { run }
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

  /** What the planner would be shown right now (the dashboard's "why this plan" view). */
  candidates(agentId: string): { candidates: Candidate[]; since: string | null } | undefined {
    const agent = this.agents.get(agentId)
    if (!agent) return undefined
    const runs = this.runs.list({ agentId, limit: 200 })
    const since = runs.find((r) => isResearchKind(r.kind))?.startedAt ?? agent.createdAt
    return { candidates: this.candidatesFn(agent, runs, since), since }
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

  private enqueue(p: Promise<unknown>): void {
    this.pending.push(p)
    void p.finally(() => {
      this.pending = this.pending.filter((x) => x !== p)
    })
  }

  private track(agentId: string, run: MaintenanceRun, handler: (settled: MaintenanceRun) => Promise<void>): void {
    this.inFlight.set(agentId, run.id)
    const done = new Promise<MaintenanceRun>((resolve) => {
      this.maintenance.onRunSettled(run.id, (settled) => {
        const p = handler(settled)
          .catch((err: unknown) => this.log('warn', `fellows: settle handling failed: ${(err as Error).message}`))
          .then(() => {
            this.inFlight.delete(agentId)
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

  private context(agent: AgentRecord, kind: RunKind, proposalId?: string): FellowRunContext {
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
      maxBudgetUsd: Math.round(BUDGET_USD[kind] * MODEL_FACTOR[agent.model] * 100) / 100,
      recentLog: recent.slice(-5),
      ...(deep ? { timeoutMs: DEEP_TIMEOUT_MS } : {}),
      ...(proposalId !== undefined ? { proposalId } : {}),
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
  ): Promise<void> {
    const now = this.now().toISOString()
    const agent = this.agents.get(agentId)
    if (!agent) return
    const answer = settled.status === 'done' ? parsePlannerAnswer(settled.result?.structuredOutput) : undefined
    if (!answer) {
      const why = settled.status === 'done' ? 'its answer did not match the schema' : (settled.error ?? 'it failed')
      this.log('warn', `fellows: planning run for ${agent.name} failed: ${why}`)
      this.agents.update(agentId, { state: 'sleeping', sleepReason: `the planning run failed (${why}); the planner tries again in the next night shift`, sleepCode: 'idle' }, now)
      const fresh = this.agents.get(agentId)
      if (fresh) await this.writeNotebook(fresh)
      return
    }
    const root = this.vaultRoot
    const built = buildProposals({
      agent,
      answer,
      candidates,
      kinds,
      cycleDate,
      now,
      newId: () => randomUUID(),
      pageExists: (page) => (root === undefined ? true : fs.existsSync(path.join(root, page))),
      ownPages: [...fellowSynthesisPages(this.runs.list({ agentId, limit: 50 })), agent.notebookPath],
    })
    for (const r of built.rejected) this.log('warn', `fellows: ${agent.name}: proposal dropped, ${r}`)
    for (const t of built.clamped) this.log('info', `fellows: ${agent.name}: "${t}" clamped to a step, no listed page exists`)
    this.routeHandoffs(agent, answer, candidates, cycleDate, now)
    // A new plan replaces what was still undecided; approved proposals survive (section 6.5).
    this.proposals.supersede(agentId)
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
      const reason = answer.reason.trim() || (answer.intentCovered ? 'the planner reports the intent as covered' : 'the planner found nothing worth a run')
      this.agents.update(agentId, { state: 'sleeping', sleepReason: reason, sleepCode: 'covered' }, now)
      this.log('info', `fellows: ${agent.name} sleeps: ${reason}`)
    }
    const fresh = this.agents.get(agentId)
    if (fresh) await this.writeNotebook(fresh)
  }

  /** Renders and commits the notebook with the current Plan section; never throws. */
  private async writeNotebook(
    agent: AgentRecord,
    opts: { readonly forceIntentScope?: boolean; readonly appendNotes?: readonly string[] } = {},
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

  async pause(id: string): Promise<AgentRecord | undefined> {
    return this.setState(id, { state: 'paused', sleepReason: 'paused by you', sleepCode: null })
  }

  /** Resumes a paused Fellow; also clears `blocked` (the user has seen the failure). */
  async resume(id: string): Promise<AgentRecord | undefined> {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    if (agent.state !== 'paused' && agent.state !== 'blocked') return agent
    const pending = this.pendingProposals(id).length > 0
    return this.setState(
      id,
      pending
        ? { state: 'waiting', sleepReason: null, sleepCode: null }
        : { state: 'sleeping', sleepReason: 'resumed; the planner runs in the next night shift', sleepCode: 'idle' },
    )
  }

  /** Retires a Fellow: pending proposals expire, the notebook says so, its pages stay (section 5.2). */
  async retire(id: string): Promise<AgentRecord | undefined> {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    for (const p of this.pendingProposals(id)) this.proposals.update(p.id, { status: 'expired' })
    // Pending handoffs to a retired Fellow become unclaimed requests (section 5.2).
    const unclaimed = this.handoffs?.unclaimTarget(id, this.now().toISOString()) ?? 0
    if (unclaimed > 0) this.log('info', `fellows: ${unclaimed} handoff(s) to ${agent.name} are unclaimed now`)
    return this.setState(id, { state: 'retired', sleepReason: null, sleepCode: null, retiredAt: this.now().toISOString() })
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
   */
  async update(id: string, patch: AgentPatch): Promise<AgentRecord | undefined> {
    const prev = this.agents.get(id)
    if (!prev) return undefined
    const intentEdit = (patch.intent !== undefined && patch.intent !== prev.intent) || (patch.scope !== undefined && patch.scope !== prev.scope)
    const wake: AgentPatch =
      intentEdit && prev.state === 'sleeping'
        ? { state: 'sleeping', sleepReason: 'intent edited; the planner reconsiders in the next night shift', sleepCode: 'idle' }
        : {}
    const next = this.agents.update(id, { ...patch, ...wake }, this.now().toISOString())
    if (!next) return undefined
    if (intentEdit) await this.writeNotebook(next, { forceIntentScope: true })
    return next
  }
}
