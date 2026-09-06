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

import type { ShiftRecord, ShiftStore, ShiftTrigger, ShiftExecution, ShiftPlanning, ShiftSkip } from '../db/shifts.js'
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
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<ShiftRecord> | null = null

  constructor(opts: NightShiftOptions) {
    this.fellows = opts.fellows
    this.shifts = opts.shifts
    this.window = opts.window
    this.now = opts.now ?? ((): Date => new Date())
    this.log = opts.log ?? ((): void => {})
    this.tickMs = opts.tickMs ?? 60_000
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
    })
    const record = (finishedAt: string | null): ShiftRecord => ({ cycleDate, trigger, startedAt: startedAt.toISOString(), finishedAt, summary: summary() })
    this.shifts.put(record(null))
    this.log('info', `shift: ${trigger} shift for cycle ${cycleDate} started`)

    const roomFor = (agent: AgentRecord, kind: 'research' | 'research-step' | 'plan'): boolean =>
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
      if (proposal.kind === 'research-expand') {
        skip(agent, 'research-expand proposals cannot run before A3')
        return false
      }
      if (!roomFor(agent, proposal.kind)) {
        skip(agent, `the window has no room left for a ${proposal.kind}`)
        return false
      }
      const outcome = this.fellows.execute(proposal.id)
      if (outcome.refusal || !outcome.run) {
        const refusal = outcome.refusal
        if (refusal?.code === 'quota') this.fellows.sleep(agent.id, 'quota', `${refusal.error}; wakes at the next night shift`)
        else if (refusal?.code === 'budget') this.fellows.sleep(agent.id, 'budget', `${refusal.error}; wakes when it clears`)
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

    // Phase 1: the plans of veto and manual Fellows, in rounds (section 8.5).
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let progressed = false
      for (const agent of active()) {
        if (agent.autonomy === 'auto') continue
        if (await executeOne(agent)) progressed = true
      }
      if (!progressed) break
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
