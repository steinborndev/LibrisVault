/**
 * The night shift (docs/agents/SPEC.md sections 4.2 and 8.5, docs/tasks/TASKS-A1.md D4, D5,
 * D13): once per night, inside the configured window, the scheduler executes the Fellows'
 * plans in priority rounds, then lets every eligible Fellow plan the next night, then runs
 * the fresh plans of `auto` Fellows. One row per cycle date in `agent_shifts` guards against
 * a second shift after a restart; a manual trigger ignores the window and may repeat.
 *
 * Runs are awaited one after another. The maintenance runner's mutex would serialize them
 * anyway; awaiting each lets the shift read the outcome before it decides the next one.
 */

import type { ShiftRecord, ShiftStore, ShiftTrigger, ShiftExecution, ShiftPlanning, ShiftSkip, ShiftMerge, ShiftOverlap } from '../db/shifts.js'
import { tokenize } from './related-pages.js'
import type { AgentRecord } from '../db/agents.js'
import type { FellowService } from './fellows.js'
import { localDate, windowAt, type NightWindow } from './clock.js'

export { windowAt, type NightWindow, type WindowAt, type WindowSpan } from './clock.js'

export interface ShiftStatus {
  readonly window: NightWindow
  readonly inWindow: boolean
  readonly cycleDate: string | null
  readonly nextStartsAt: string
  readonly running: boolean
  readonly last: ShiftRecord | null
  readonly recent: readonly ShiftRecord[]
}

export interface NightShiftOptions {
  readonly fellows: FellowService
  readonly shifts: ShiftStore
  readonly window: () => NightWindow
  readonly now?: () => Date
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** How often the timer checks the window; a minute by default. */
  readonly tickMs?: number
  /** Titles of the existing synthesis pages, for the dedupe notes (section 6.6, A3). */
  readonly synthesisTitles?: () => readonly string[]
  /** Refreshes the plan usage before a round (the endpoint sample, cached); optional. */
  readonly beforeRound?: () => Promise<void>
  /** Waits; injectable so the tests run dry. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** How long the shift waits for a 5-hour reset at most (docs/tasks/TASKS-A5.md D5). */
export const MAX_RESET_WAIT_MS = 4 * 3600_000

/** Two pending topics this alike are one topic (overlap coefficient of the significant tokens). */
export const DEDUPE_THRESHOLD = 0.6
/** A pending topic this close to an existing synthesis page is noted (never dropped). */
export const OVERLAP_NOTE_THRESHOLD = 0.7

export function topicOverlap(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return Math.round((shared / Math.min(ta.size, tb.size)) * 100) / 100
}

/** A run that already happened tonight, as {@link coveredTonight} needs to see it. */
export interface CoveringRun {
  readonly agentId: string
  readonly agentName: string
  readonly topic: string
  readonly ok: boolean
}

/**
 * Whether a topic about to run has already been covered by another Fellow's run TONIGHT.
 *
 * The pass before the shift (section 6.6) reads the proposals as they stand when it starts and
 * nothing after: a proposal approved during the night, one a planning run adds in phase 2 for
 * phase 3 to execute, a step started by hand from the card. None of them meet it, so a Fellow
 * could spend a full run on a subject another Fellow finished an hour earlier with the pages
 * already in the vault.
 *
 * Cross-Fellow only, like the pass before it: a Fellow's own list is its own beat, and that
 * rule is already settled. `hold` is what is new here - the twin has not merely been PROPOSED,
 * it has RUN, and an approved proposal is the user's own decision. So an approved topic is held
 * for another night rather than superseded: the run is not spent, the decision still stands.
 */
export function coveredTonight(
  proposal: { readonly topic: string; readonly status: string },
  agentId: string,
  executed: readonly CoveringRun[],
): { readonly run: CoveringRun; readonly score: number; readonly hold: boolean } | null {
  const run = executed.find((e) => e.ok && e.agentId !== agentId && topicOverlap(e.topic, proposal.topic) >= DEDUPE_THRESHOLD)
  if (run === undefined) return null
  return { run, score: topicOverlap(run.topic, proposal.topic), hold: proposal.status === 'approved' }
}

/** Safety bound on execution rounds per shift (round-robin, section 8.5). */
const MAX_ROUNDS = 12

export class NightShift {
  private readonly fellows: FellowService
  private readonly shifts: ShiftStore
  private readonly window: () => NightWindow
  private readonly now: () => Date
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void
  private readonly tickMs: number
  private readonly synthesisTitles: () => readonly string[]
  private readonly beforeRound: () => Promise<void>
  private readonly sleep: (ms: number) => Promise<void>
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<ShiftRecord> | null = null

  constructor(opts: NightShiftOptions) {
    this.fellows = opts.fellows
    this.shifts = opts.shifts
    this.window = opts.window
    this.now = opts.now ?? ((): Date => new Date())
    this.log = opts.log ?? ((): void => {})
    this.tickMs = opts.tickMs ?? 60_000
    this.synthesisTitles = opts.synthesisTitles ?? ((): readonly string[] => [])
    this.beforeRound = opts.beforeRound ?? (async (): Promise<void> => {})
    this.sleep = opts.sleep ?? ((ms): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Dedupe before the shift (section 6.6, D6): pairwise over the undecided proposals of all
   * Fellows in shift order, the later Fellow's near-duplicate is superseded (approved ones
   * never lose); a topic close to an existing synthesis page is noted, not dropped.
   */
  dedupe(): { merged: ShiftMerge[]; overlaps: ShiftOverlap[] } {
    const merged: ShiftMerge[] = []
    const overlaps: ShiftOverlap[] = []
    const fellows = this.fellows.list().map((s) => s.agent).filter((a) => a.state !== 'retired')
    const kept: Array<{ agentId: string; agentName: string; id: string; topic: string; status: string }> = []
    for (const agent of fellows) {
      for (const p of this.fellows.pendingProposals(agent.id)) {
        const twin = p.status === 'approved' ? undefined : kept.find((k) => k.agentId !== agent.id && topicOverlap(k.topic, p.topic) >= DEDUPE_THRESHOLD)
        if (twin) {
          const score = topicOverlap(twin.topic, p.topic)
          this.fellows.supersedeProposal(p.id, `merged into ${twin.agentName}'s "${twin.topic}" (overlap ${score})`)
          merged.push({ keptAgentName: twin.agentName, keptTopic: twin.topic, droppedAgentName: agent.name, droppedTopic: p.topic, score })
          continue
        }
        kept.push({ agentId: agent.id, agentName: agent.name, id: p.id, topic: p.topic, status: p.status })
      }
    }
    const titles = this.synthesisTitles()
    for (const k of kept) {
      for (const title of titles) {
        const score = topicOverlap(k.topic, title)
        if (score >= OVERLAP_NOTE_THRESHOLD) {
          overlaps.push({ agentName: k.agentName, topic: k.topic, page: title, score })
          break
        }
      }
    }
    if (merged.length > 0 || overlaps.length > 0) this.log('info', `shift: dedupe merged ${merged.length}, noted ${overlaps.length} overlap(s) with existing pages`)
    return { merged, overlaps }
  }

  /** Starts the timer. Idempotent. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  get isRunning(): boolean {
    return this.running !== null
  }

  status(): ShiftStatus {
    const now = this.now()
    const window = this.window()
    const at = windowAt(now, window)
    const recent = this.shifts.list(7)
    return {
      window,
      inWindow: at.current !== null,
      cycleDate: at.current?.cycleDate ?? null,
      nextStartsAt: at.next.start.toISOString(),
      running: this.running !== null,
      last: recent[0] ?? null,
      recent,
    }
  }

  /**
   * The timer's check: inside the window, and no shift recorded for this cycle yet, run one.
   * Returns the record when a shift ran, null otherwise.
   */
  async tick(): Promise<ShiftRecord | null> {
    if (this.running) return null
    const at = windowAt(this.now(), this.window())
    if (at.current === null) return null
    if (this.shifts.get(at.current.cycleDate) !== undefined) return null
    return this.run('timer')
  }

  /** Runs a shift now. A second call while one runs returns the running shift's promise. */
  run(trigger: ShiftTrigger): Promise<ShiftRecord> {
    if (this.running) return this.running
    const p = this.execute(trigger).finally(() => {
      this.running = null
    })
    this.running = p
    return p
  }

  private async execute(trigger: ShiftTrigger): Promise<ShiftRecord> {
    const startedAt = this.now()
    const at = windowAt(startedAt, this.window())
    const cycleDate = at.current?.cycleDate ?? localDate(startedAt)
    // Only a timer shift respects the window's end; a manual one runs whatever is due.
    const deadline = trigger === 'timer' && at.current ? at.current.end.getTime() : null
    const executed: ShiftExecution[] = []
    const planned: ShiftPlanning[] = []
    const skipped: ShiftSkip[] = []
    let dedupe: { merged: ShiftMerge[]; overlaps: ShiftOverlap[] } = { merged: [], overlaps: [] }
    const skippedOnce = new Set<string>()
    const skip = (agent: AgentRecord, reason: string): void => {
      const key = `${agent.id}:${reason}`
      if (skippedOnce.has(key)) return
      skippedOnce.add(key)
      skipped.push({ agentId: agent.id, agentName: agent.name, reason })
    }
    const summary = (): ShiftRecord['summary'] => ({
      executed,
      planned,
      skipped,
      costUsd: Math.round((executed.reduce((a, e) => a + (e.costUsd ?? 0), 0) + planned.reduce((a, p) => a + (p.costUsd ?? 0), 0)) * 100) / 100,
      merged: dedupe.merged,
      overlaps: dedupe.overlaps,
    })
    const record = (finishedAt: string | null): ShiftRecord => ({ cycleDate, trigger, startedAt: startedAt.toISOString(), finishedAt, summary: summary() })
    this.shifts.put(record(null))
    this.log('info', `shift: ${trigger} shift for cycle ${cycleDate} started`)

    // Before anything is planned: publications the Fellows asked for that have arrived in the
    // vault since the last shift, however they got there. Each becomes a note in the notebook
    // of the Fellow that asked, and a candidate its planner can act on (section 10.6).
    try {
      const filed = await this.fellows.noteFiledReading(cycleDate)
      if (filed > 0) this.log('info', `shift: ${filed} reading list entr${filed === 1 ? 'y is' : 'ies are'} in the vault`)
    } catch (err) {
      this.log('warn', `shift: reading list not reconciled: ${(err as Error).message}`)
    }

    const roomFor = (agent: AgentRecord, kind: 'research' | 'research-step' | 'research-expand' | 'plan'): boolean =>
      deadline === null || this.now().getTime() + this.fellows.timeoutFor(agent, kind) <= deadline

    const active = (): AgentRecord[] => this.fellows.list().map((s) => s.agent).filter((a) => a.state !== 'retired' && a.state !== 'paused')

    /** One execution attempt for a Fellow; true when a run happened. */
    const executeOne = async (agent: AgentRecord): Promise<boolean> => {
      if (agent.state === 'blocked') {
        skip(agent, 'blocked after a failed run; resume it from the card')
        return false
      }
      if (agent.state === 'active') {
        skip(agent, 'a run is already in flight')
        return false
      }
      if (agent.skipUntil !== null && agent.skipUntil >= cycleDate) {
        skip(agent, 'skipped tonight at your request')
        return false
      }
      const proposal = this.fellows.runnable(agent.id)
      if (!proposal) {
        skip(agent, agent.autonomy === 'manual' ? 'manual mode and nothing approved' : 'nothing runnable')
        return false
      }
      if (!roomFor(agent, proposal.kind)) {
        skip(agent, `the window has no room left for a ${proposal.kind}`)
        return false
      }
      // Dedupe again, against what has already RUN tonight (see `coveredTonight`).
      const covered = coveredTonight(proposal, agent.id, executed)
      if (covered !== null) {
        const { run: done, score, hold } = covered
        if (hold) {
          skip(agent, `"${done.topic}" ran tonight and covers this (overlap ${score}); the approved topic keeps its place`)
          return false
        }
        this.fellows.supersedeProposal(proposal.id, `covered by ${done.agentName}'s run "${done.topic}" tonight (overlap ${score})`)
        dedupe = {
          ...dedupe,
          merged: [...dedupe.merged, { keptAgentName: done.agentName, keptTopic: done.topic, droppedAgentName: agent.name, droppedTopic: proposal.topic, score }],
        }
        this.log('info', `shift: ${agent.name}'s "${proposal.topic}" is covered by ${done.agentName}'s run tonight (overlap ${score})`)
        this.shifts.put(record(null))
        return false
      }
      const outcome = this.fellows.execute(proposal.id)
      if (outcome.refusal || !outcome.run) {
        const refusal = outcome.refusal
        if (refusal?.code === 'quota') this.fellows.sleep(agent.id, 'quota', `${refusal.error}; wakes at the next night shift`)
        else if (refusal?.code === 'budget') this.fellows.sleep(agent.id, 'budget', `${refusal.error}; wakes when it clears`)
        else if (refusal?.code === 'reserve' || refusal?.code === 'share') {
          this.fellows.sleep(agent.id, 'plan', `${refusal.error}; wakes when the window resets`)
          const reset = this.fellows.lastPlanReset()
          if (reset !== null) pendingReset = pendingReset === null ? reset : Math.min(pendingReset, reset)
        }
        skip(agent, refusal?.error ?? 'could not start')
        return false
      }
      this.log('info', `shift: ${agent.name} runs "${proposal.topic}" (${proposal.kind})`)
      const settled = await this.fellows.settled(outcome.run.id)
      executed.push({
        agentId: agent.id,
        agentName: agent.name,
        proposalId: proposal.id,
        runId: settled.id,
        kind: settled.kind,
        topic: proposal.topic,
        ok: settled.status === 'done',
        pages: settled.result?.pages.length ?? 0,
        costUsd: settled.result?.usage.costUsd ?? null,
        error: settled.error ?? null,
      })
      this.shifts.put(record(null))
      return true
    }

    // Dedupe first (section 6.6): near-duplicate topics across Fellows run once.
    try {
      dedupe = this.dedupe()
    } catch (err) {
      this.log('warn', `shift: dedupe failed: ${(err as Error).message}`)
    }

    // Phase 1: the plans of veto and manual Fellows, in rounds (section 8.5). A 5-hour
    // reset inside the window is worth waiting for (D5): the refused Fellows get another round.
    let pendingReset: number | null = null
    let waited = false
    for (let round = 0; round < MAX_ROUNDS; round++) {
      pendingReset = null
      await this.beforeRound()
      let progressed = false
      for (const agent of active()) {
        if (agent.autonomy === 'auto') continue
        if (await executeOne(agent)) progressed = true
      }
      if (progressed) continue
      const now = this.now().getTime()
      if (!waited && pendingReset !== null && pendingReset > now && (deadline === null || pendingReset < deadline) && pendingReset - now <= MAX_RESET_WAIT_MS) {
        waited = true
        const ms = pendingReset - now + 30_000
        this.log('info', `shift: waiting ${Math.round(ms / 60_000)} min for the 5-hour window to reset`)
        await this.sleep(ms)
        for (const s of this.fellows.list().map((x) => x.agent)) if (s.state === 'sleeping' && s.sleepCode === 'plan') this.fellows.sleep(s.id, 'idle', 'the window reset; trying again')
        continue
      }
      break
    }

    // Phase 2: one planning run per eligible Fellow against the fresh vault state.
    for (const agent of active()) {
      if (agent.state === 'blocked' || agent.state === 'active') continue
      if (agent.state === 'sleeping' && (agent.sleepCode === 'covered' || agent.sleepCode === 'stalled')) {
        const triggers = this.fellows.wakeTriggers(agent.id)
        if (triggers.length === 0) {
          skip(agent, `sleeps (${agent.sleepCode}) and nothing new arrived in its domains`)
          continue
        }
        this.log('info', `shift: ${agent.name} wakes: ${triggers.join('; ')}`)
      }
      if (!roomFor(agent, 'plan')) {
        skip(agent, 'the window has no room left for a planning run')
        continue
      }
      const outcome = this.fellows.plan(agent.id, { cycleDate })
      if (outcome.skipped !== undefined) {
        planned.push({ agentId: agent.id, agentName: agent.name, runId: null, ok: true, proposals: 0, costUsd: null, note: outcome.skipped })
        continue
      }
      if (outcome.refusal || !outcome.run) {
        skip(agent, outcome.refusal?.error ?? 'planning could not start')
        continue
      }
      const settled = await this.fellows.settled(outcome.run.id)
      const fresh = this.fellows.get(agent.id)
      planned.push({
        agentId: agent.id,
        agentName: agent.name,
        runId: settled.id,
        ok: settled.status === 'done',
        proposals: this.fellows.pendingProposals(agent.id).filter((p) => p.cycleDate === cycleDate).length,
        costUsd: settled.result?.usage.costUsd ?? null,
        note: settled.status === 'done' ? (fresh?.state === 'sleeping' ? (fresh.sleepReason ?? null) : null) : (settled.error ?? 'failed'),
      })
      this.shifts.put(record(null))
    }

    // Phase 3: auto Fellows run their fresh top proposal in the same night (section 6.5).
    for (const agent of active()) {
      if (agent.autonomy !== 'auto') continue
      await executeOne(agent)
    }

    const done = record(this.now().toISOString())
    this.shifts.put(done)
    this.log('info', `shift: cycle ${cycleDate} finished: ${executed.length} run(s), ${planned.length} plan(s), ${skipped.length} skip(s), ${done.summary.costUsd} USD`)
    return done
  }
}
