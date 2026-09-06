/**
 * The Fellow service (docs/agents/SPEC.md sections 5 to 8, milestone A0): spawn, step,
 * pause, resume, retire, and the card. A Fellow's run is an ordinary sandboxed research run
 * started through the maintenance runner, pinned to the Fellow's model and budget and
 * attributed to it; this service owns the record, the quota gate and the notebook.
 *
 * What A0 deliberately leaves to A1: proposals, the planner and the night shift. A step here
 * is started by hand and takes its topic from the request, defaulting to the intent.
 */

import { randomUUID } from 'node:crypto'
import {
  MODEL_FACTOR,
  MODEL_IDS,
  slugify,
  type AgentAutonomy,
  type AgentEffort,
  type AgentModel,
  type AgentRecord,
  type AgentStep,
  type AgentStore,
} from '../db/agents.js'
import type { AgentRunRecord, AgentRunStore } from '../db/agent-runs.js'
import type { MaintenanceRunner, MaintenanceRun } from './maintenance.js'
import { notebookPath, renderLogLines, type NotebookWriter } from './notebook.js'
import type { FellowRunContext } from './fellow-prompts.js'
import { startOfToday } from './budget.js'

/** Per-kind USD cap on Sonnet 5 (docs/agents/SPEC.md section 7), scaled by the model factor. */
export const BUDGET_USD: Readonly<Record<StepKind, number>> = { research: 12, 'research-step': 4 }

export type StepKind = 'research' | 'research-step'

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
  /** Start the first full research run on the intent right away (default true, section 5.1). */
  readonly runFirstStep?: boolean
}

export interface Refusal {
  readonly status: 404 | 409
  readonly error: string
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

export interface FellowSummary {
  readonly agent: AgentRecord
  readonly currentRun: MaintenanceRun | null
  readonly lastRun: AgentRunRecord | null
  readonly runsToday: number
}

export interface FellowCard extends FellowSummary {
  /** Newest first, capped. */
  readonly runs: readonly AgentRunRecord[]
  /** Every page the Fellow's runs committed, newest first, deduplicated. */
  readonly pages: readonly string[]
  readonly lastActive: string | null
  readonly quota: { readonly runsPerDay: number; readonly usedToday: number }
}

export interface FellowServiceOptions {
  readonly agents: AgentStore
  readonly runs: AgentRunStore
  readonly maintenance: MaintenanceRunner
  readonly notebook: NotebookWriter
  readonly now?: () => Date
}

export class FellowService {
  private readonly agents: AgentStore
  private readonly runs: AgentRunStore
  private readonly maintenance: MaintenanceRunner
  private readonly notebook: NotebookWriter
  private readonly now: () => Date
  /** One run in flight per Fellow: agent id to tracked run id. */
  private readonly inFlight = new Map<string, string>()
  /** Notebook rewrites still in progress (after a settle); `flush()` awaits them. */
  private pending: Promise<unknown>[] = []

  constructor(opts: FellowServiceOptions) {
    this.agents = opts.agents
    this.runs = opts.runs
    this.maintenance = opts.maintenance
    this.notebook = opts.notebook
    this.now = opts.now ?? ((): Date => new Date())
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id)
  }

  list(): FellowSummary[] {
    return this.agents.list().map((agent) => this.summary(agent))
  }

  private summary(agent: AgentRecord): FellowSummary {
    const runId = this.inFlight.get(agent.id)
    const currentRun = runId ? (this.maintenance.getRun(runId) ?? null) : null
    const [lastRun] = this.runs.list({ agentId: agent.id, limit: 1 })
    return { agent, currentRun, lastRun: lastRun ?? null, runsToday: this.runsToday(agent.id) }
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
    }
  }

  private runsToday(agentId: string): number {
    return this.runs.list({ agentId, since: startOfToday(this.now()).toISOString() }).length
  }

  /** Creates the record and its notebook page, then (by default) runs the intent as a full research run. */
  async spawn(input: SpawnInput): Promise<SpawnOutcome> {
    const slug = slugify(input.name)
    if (this.agents.bySlug(slug) !== undefined) {
      return { refusal: { status: 409, error: `a Fellow named "${input.name}" (slug ${slug}) already exists` } }
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
      model: input.model ?? 'sonnet-5',
      effort: input.effort ?? 'high',
      step: input.step ?? 'standard',
      quotaRunsPerDay: input.quotaRunsPerDay ?? 1,
      quotaWeekPct: null,
      autonomy: input.autonomy ?? 'veto',
      priority: 0,
      state: 'proposed',
      sleepReason: null,
      notebookPath: notebookPath(slug),
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
    }
    this.agents.create(agent)
    await this.notebook.write(agent, [])
    if (input.runFirstStep === false) return { agent }
    const outcome = this.step(agent.id, { kind: 'research', topic: agent.intent })
    return { agent: this.agents.get(agent.id) ?? agent, ...(outcome.run ? { run: outcome.run } : {}), ...(outcome.refusal ? { refusal: outcome.refusal } : {}) }
  }

  /**
   * Starts one step now, subject to the gate: a known, unpaused, unretired Fellow with no run
   * in flight and runs left for today. Returns the tracked run (202) or a refusal (404/409).
   */
  step(id: string, opts: { readonly topic?: string; readonly kind?: StepKind } = {}): StepOutcome {
    const agent = this.agents.get(id)
    if (!agent) return { refusal: { status: 404, error: 'no such Fellow' } }
    if (agent.state === 'retired') return { refusal: { status: 409, error: `${agent.name} is retired` } }
    if (agent.state === 'paused') return { refusal: { status: 409, error: `${agent.name} is paused; resume first` } }
    const inFlight = this.inFlight.get(id)
    if (inFlight !== undefined && this.maintenance.getRun(inFlight)?.status === 'running') {
      return { refusal: { status: 409, error: `${agent.name} already has a run in flight` } }
    }
    const used = this.runsToday(id)
    if (used >= agent.quotaRunsPerDay) {
      return { refusal: { status: 409, error: `${agent.name} used today's quota (${used} of ${agent.quotaRunsPerDay} runs)` } }
    }
    const kind: StepKind = opts.kind ?? 'research-step'
    const topic = opts.topic?.trim() ? opts.topic.trim() : agent.intent
    const ctx = this.context(agent, kind)
    const run =
      kind === 'research'
        ? this.maintenance.startResearch(topic, agent.lens, ctx)
        : this.maintenance.startResearchStep(topic, agent.lens, ctx)
    this.inFlight.set(id, run.id)
    this.agents.update(id, { state: 'active', sleepReason: null }, this.now().toISOString())
    this.maintenance.onRunSettled(run.id, (settled) => {
      const p = this.onSettled(id, settled)
      this.pending.push(p)
      void p.finally(() => {
        this.pending = this.pending.filter((x) => x !== p)
      })
    })
    return { run }
  }

  /** Waits for notebook rewrites triggered by settled runs (tests, shutdown). */
  async flush(): Promise<void> {
    while (this.pending.length > 0) await Promise.allSettled(this.pending)
  }

  private context(agent: AgentRecord, kind: StepKind): FellowRunContext {
    const recent = renderLogLines(this.runs.list({ agentId: agent.id, limit: 5 }))
    return {
      agentId: agent.id,
      name: agent.name,
      slug: agent.slug,
      notebookPath: agent.notebookPath,
      intent: agent.intent,
      scope: agent.scope,
      model: MODEL_IDS[agent.model],
      effort: agent.effort,
      maxBudgetUsd: Math.round(BUDGET_USD[kind] * MODEL_FACTOR[agent.model] * 100) / 100,
      recentLog: recent.slice(-5),
    }
  }

  private async onSettled(agentId: string, settled: MaintenanceRun): Promise<void> {
    this.inFlight.delete(agentId)
    const now = this.now().toISOString()
    const ok = settled.status === 'done'
    const agent = this.agents.get(agentId)
    if (!agent) return
    let next = this.agents.update(
      agentId,
      ok
        ? { state: 'sleeping', sleepReason: 'nothing planned; start the next step from the card (the planner arrives with A1)' }
        : { state: 'blocked', sleepReason: settled.error ?? 'the last run failed' },
      now,
    )
    if (!next) return
    try {
      const written = await this.notebook.write(next, this.runs.list({ agentId, limit: 200 }))
      // The user may have edited intent or scope on the page (section 5.4): the page wins.
      const patch: { intent?: string; scope?: string } = {}
      if (written.readBack.intent && written.readBack.intent !== next.intent) patch.intent = written.readBack.intent
      if (written.readBack.scope && written.readBack.scope !== next.scope) patch.scope = written.readBack.scope
      if (patch.intent !== undefined || patch.scope !== undefined) next = this.agents.update(agentId, patch, now) ?? next
    } catch {
      /* the notebook is bookkeeping; a failed rewrite must not corrupt the settle */
    }
  }

  async pause(id: string): Promise<AgentRecord | undefined> {
    return this.setState(id, { state: 'paused', sleepReason: 'paused by you' })
  }

  async resume(id: string): Promise<AgentRecord | undefined> {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    if (agent.state !== 'paused') return agent
    return this.setState(id, { state: 'sleeping', sleepReason: 'resumed; start the next step from the card' })
  }

  async retire(id: string): Promise<AgentRecord | undefined> {
    const next = await this.setState(id, { state: 'retired', sleepReason: null, retiredAt: this.now().toISOString() })
    return next
  }

  /** Removes a retired Fellow's record; the notebook and its pages stay in the vault. */
  remove(id: string): { ok: true } | Refusal {
    const agent = this.agents.get(id)
    if (!agent) return { status: 404, error: 'no such Fellow' }
    if (agent.state !== 'retired') return { status: 409, error: 'retire the Fellow before removing its record' }
    this.agents.remove(id)
    return { ok: true }
  }

  private async setState(
    id: string,
    patch: { state: AgentRecord['state']; sleepReason: string | null; retiredAt?: string },
  ): Promise<AgentRecord | undefined> {
    const next = this.agents.update(id, patch, this.now().toISOString())
    if (!next) return undefined
    try {
      await this.notebook.write(next, this.runs.list({ agentId: id, limit: 200 }))
    } catch {
      /* bookkeeping only */
    }
    return next
  }

  update(id: string, patch: Parameters<AgentStore['update']>[1]): AgentRecord | undefined {
    return this.agents.update(id, patch, this.now().toISOString())
  }
}
