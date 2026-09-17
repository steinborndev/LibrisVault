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

import type { ShiftSummary, ShiftRecord, ShiftStore, ShiftTrigger, ShiftExecution, ShiftPlanning, ShiftSkip, ShiftMerge, ShiftOverlap } from '../db/shifts.js'
import { tokenize } from './related-pages.js'
import type { AgentRecord } from '../db/agents.js'
import type { FellowService } from './fellows.js'
import { localDate, windowAt, type NightWindow } from './clock.js'

export { windowAt, cycleAt, type NightWindow, type WindowAt, type WindowSpan } from './clock.js'

export interface ShiftStatus {
  readonly window: NightWindow
  readonly inWindow: boolean
  readonly cycleDate: string | null
  readonly nextStartsAt: string
  readonly running: boolean
  readonly last: ShiftRecord | null
  readonly recent: readonly ShiftRecord[]
}

/**
 * The ingest queue's side of phase 0 (docs/tasks/TASKS-SWEEP-2026-09.md, chunk 6): the jobs
 * the user held for tonight are released and run to the end before any Fellow works.
 */
export interface NightIngests {
  /** Lets every job held for the night run; returns their ids. */
  readonly release: () => readonly string[]
  /** Resolves once the queue has nothing left to run. */
  readonly onIdle: () => Promise<void>
  /** A job's status once the queue is done with it. */
  readonly statusOf: (id: string) => string | undefined
}

export interface NightShiftOptions {
  readonly fellows: FellowService
  readonly shifts: ShiftStore
  readonly window: () => NightWindow
  /** The held ingests; absent when the queue is not wired (a test, a read-only service). */
  readonly ingests?: NightIngests
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
  /**
   * The nightly reading-list sweep (docs/sources/SPEC.md section 6.1): entries a Fellow could
   * not read are checked for an open copy and marked. Injected as a closure, so the shift does
   * not have to know a resolver exists; absent = no sweep.
   */
  readonly openCopies?: (today: string) => Promise<{ readonly checked: number; readonly found: number }>
  /**
   * Judges whether pairs of topics ask the same question, in one read-only run (section 6.6).
   * Injected so the tests never spawn one, and absent when the setting is off - in which case
   * the lexical passes carry on alone, which is what they did before this existed.
   *
   * Returns one score in [0, 1] per pair, in order; NaN for a pair it did not answer for.
   */
  readonly judge?: (pairs: readonly JudgePair[]) => Promise<readonly JudgeVerdict[]>
}

/** One question for the judge: are these two topics the same question? */
export interface JudgePair {
  readonly id: string
  readonly a: string
  readonly b: string
}

export interface JudgeVerdict {
  readonly score: number
  readonly reason?: string
}

/** How long the shift waits for a 5-hour reset at most (docs/tasks/TASKS-A5.md D5). */
export const MAX_RESET_WAIT_MS = 4 * 3600_000

/** Two pending topics this alike are one topic (overlap coefficient of the significant tokens). */
export const DEDUPE_THRESHOLD = 0.6
/** A pending topic this close to an existing synthesis page is noted (never dropped). */
export const OVERLAP_NOTE_THRESHOLD = 0.7

/**
 * The judge's two bars (measured 2026-09-08, see docs/agents/ideas.md).
 *
 * Over three runs of the labelled set the worst true duplicate scored 0.200 and the best pair
 * that must NOT be merged 0.120, so anything at or above `JUDGE_NOTE` is worth saying out
 * loud. `JUDGE_MERGE` sits far higher on purpose: everything the judge scored above 0.5 was a
 * paraphrase it was sure about, while the one duplicate it hedged on - a task that is a SUBSET
 * of another rather than a restatement - landed at 0.20 to 0.28. A hedge should cost a line in
 * the recap, never a run.
 *
 * The asymmetry is the whole design. A missed duplicate costs one run; a wrong merge costs a
 * run that should have happened, and this vault's own history is full of narrow follow-ups
 * that every surface measure wanted to merge away.
 */
export const JUDGE_MERGE = 0.5
export const JUDGE_NOTE = 0.16

/** Unordered, normalized: "a vs b" and "b vs a" are one question. */
const pairKey = (a: string, b: string): string => [a.trim().toLowerCase(), b.trim().toLowerCase()].sort().join(' \u0000 ')

/**
 * How many pairs one judging call carries. Two Fellows with three proposals each make nine;
 * the cap only bites at a size this library has never reached, and it keeps one runaway night
 * from turning a cheap read-only run into a long one.
 */
export const JUDGE_PAIR_CAP = 120

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
  private readonly judge: ((pairs: readonly JudgePair[]) => Promise<readonly JudgeVerdict[]>) | undefined
  private readonly ingests: NightIngests | undefined
  /** The nightly open-copy sweep over the reading list; absent = the service has none wired. */
  private readonly openCopies: ((today: string) => Promise<{ checked: number; found: number }>) | undefined
  /**
   * Verdicts already obtained this shift, by unordered topic pair. The pass before the shift
   * judges every standing pair; the check before each run mostly asks about the same pairs
   * again, and a second call would buy the same answer twice.
   */
  private verdicts = new Map<string, JudgeVerdict>()
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
    this.judge = opts.judge
    this.ingests = opts.ingests
    this.openCopies = opts.openCopies
  }

  /**
   * Dedupe before the shift (section 6.6, D6): pairwise over the undecided proposals of all
   * Fellows in shift order, the later Fellow's near-duplicate is superseded (approved ones
   * never lose); a topic close to an existing synthesis page is noted, not dropped.
   */
  async dedupe(): Promise<{ merged: ShiftMerge[]; overlaps: ShiftOverlap[] }> {
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
    /*
     * What the words could not settle now goes to the judge - every cross-Fellow pair still
     * standing, not a band of them. A band gated on lexical similarity was the obvious way to
     * hold the cost down and it is exactly wrong: a real paraphrase scores 0.13 against its own
     * twin, so the filter would discard the cases the judge exists for.
     *
     * One call for all of them, which is what a night's handful costs.
     */
    await this.judgeKept(kept, merged)

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

  /**
   * The second opinion on the pairs the token overlap left standing, and the graded action.
   *
   * Above `JUDGE_MERGE` the later Fellow's proposal is superseded, as the lexical pass would;
   * between `JUDGE_NOTE` and that it is only NOTED and still runs. The bars are far apart on
   * purpose: measured, every score above 0.5 was a paraphrase the judge was sure of, and the
   * one duplicate it hedged over - a task contained in another rather than restating it - sat
   * near 0.2. A hedge should cost a line in the recap, never a run.
   *
   * Approved proposals are exempt from the merge exactly as they are from the lexical pass:
   * the user decided that topic, and a model's opinion does not overturn a decision. They can
   * still be noted.
   *
   * Any failure is a warning and nothing else. The judge is a second opinion on top of a pass
   * that already ran; a shift must never depend on it.
   */
  private async judgeKept(
    kept: ReadonlyArray<{ agentId: string; agentName: string; id: string; topic: string; status: string }>,
    merged: ShiftMerge[],
  ): Promise<void> {
    if (this.judge === undefined || kept.length < 2) return
    // Pairs already answered this shift cost nothing to skip and a call to ask again.
    const asked = (a: string, b: string): boolean => this.verdicts.has(pairKey(a, b))
    const pairs: Array<{ id: string; a: string; b: string; left: (typeof kept)[number]; right: (typeof kept)[number] }> = []
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        const left = kept[i]!
        const right = kept[j]!
        // Cross-Fellow only, like the pass before it: a Fellow's own list is its own beat.
        if (left.agentId === right.agentId) continue
        if (asked(left.topic, right.topic)) continue
        if (pairs.length >= JUDGE_PAIR_CAP) break
        pairs.push({ id: `p${pairs.length + 1}`, a: left.topic, b: right.topic, left, right })
      }
    }
    if (pairs.length === 0) return
    let verdicts: readonly JudgeVerdict[]
    try {
      verdicts = await this.judge(pairs.map((p) => ({ id: p.id, a: p.a, b: p.b })))
    } catch (err) {
      this.log('warn', `shift: the duplicate judge failed, the lexical pass stands: ${(err as Error).message}`)
      return
    }
    let superseded = 0
    let noted = 0
    for (const [i, p] of pairs.entries()) {
      const verdict = verdicts[i]
      if (verdict !== undefined && Number.isFinite(verdict.score)) this.verdicts.set(pairKey(p.a, p.b), verdict)
      if (verdict === undefined || !Number.isFinite(verdict.score) || verdict.score < JUDGE_NOTE) continue
      // The later Fellow in shift order loses, the same rule the lexical pass follows.
      const later = p.right
      const kept2 = p.left
      const score = Math.round(verdict.score * 100) / 100
      const record: ShiftMerge = {
        keptAgentName: kept2.agentName,
        keptTopic: kept2.topic,
        droppedAgentName: later.agentName,
        droppedTopic: later.topic,
        score,
        by: 'judge',
        ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      }
      if (verdict.score >= JUDGE_MERGE && later.status !== 'approved') {
        this.fellows.supersedeProposal(later.id, `judged the same question as ${kept2.agentName}'s "${kept2.topic}" (${score})`)
        merged.push(record)
        superseded++
      } else {
        merged.push({ ...record, noted: true })
        noted++
      }
    }
    if (superseded > 0 || noted > 0) {
      this.log('info', `shift: the judge read ${pairs.length} pair(s), superseded ${superseded}, noted ${noted}`)
    }
  }

  /**
   * Every undecided or approved topic standing right now, in shift order - the list the judging
   * pass works over.
   *
   * It is read twice a night, and that is the point. The pass before the shift sees what earlier
   * nights left standing; phase 2's planning runs then CREATE tonight's proposals, and reading
   * again afterwards is what puts those in front of the judge before phase 3 executes one and
   * before the recap asks the user about them. The memo means the second read only pays for the
   * pairs the first one did not have.
   */
  private standing(): Array<{ agentId: string; agentName: string; id: string; topic: string; status: string }> {
    const out: Array<{ agentId: string; agentName: string; id: string; topic: string; status: string }> = []
    for (const agent of this.fellows.list().map((s) => s.agent).filter((a) => a.state !== 'retired')) {
      for (const p of this.fellows.pendingProposals(agent.id)) {
        out.push({ agentId: agent.id, agentName: agent.name, id: p.id, topic: p.topic, status: p.status })
      }
    }
    return out
  }

  /**
   * The judge's opinion on a topic about to run, against what has already run tonight. The
   * counterpart of {@link coveredTonight}, for the duplicate the words cannot see.
   *
   * Most of these pairs were judged before the shift and come out of the memo. The ones that
   * were not are the reason this exists: a planning run in phase 2 makes proposals that phase 3
   * executes, and they never met the pass at the start of the night.
   *
   * Returns the strongest verdict, or null when there is no judge, no answer, or nothing that
   * clears the note bar.
   */
  private async judgeCovered(
    topic: string,
    agentId: string,
    executed: readonly CoveringRun[],
  ): Promise<{ run: CoveringRun; verdict: JudgeVerdict } | null> {
    if (this.judge === undefined) return null
    const others = executed.filter((e) => e.ok && e.agentId !== agentId)
    if (others.length === 0) return null
    const missing = others.filter((e) => !this.verdicts.has(pairKey(e.topic, topic)))
    if (missing.length > 0) {
      try {
        const answers = await this.judge(missing.slice(0, JUDGE_PAIR_CAP).map((e, i) => ({ id: `c${i + 1}`, a: e.topic, b: topic })))
        missing.forEach((e, i) => {
          const v = answers[i]
          if (v !== undefined && Number.isFinite(v.score)) this.verdicts.set(pairKey(e.topic, topic), v)
        })
      } catch (err) {
        this.log('warn', `shift: the duplicate judge failed, the lexical check stands: ${(err as Error).message}`)
      }
    }
    let best: { run: CoveringRun; verdict: JudgeVerdict } | null = null
    for (const run of others) {
      const verdict = this.verdicts.get(pairKey(run.topic, topic))
      if (verdict === undefined || verdict.score < JUDGE_NOTE) continue
      if (best === null || verdict.score > best.verdict.score) best = { run, verdict }
    }
    return best
  }

  /** Starts the timer. Idempotent. */
  start(): void {
    if (this.timer) return
    this.reconcileInterrupted()
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    this.timer.unref?.()
  }

  /**
   * Closes what a dead process left open, before the first tick can look at it.
   *
   * A round writes its row when it starts and rewrites it when it settles. A machine that goes
   * down in between leaves a row with no `finishedAt`, which reads forever as a round still in
   * progress - and the Fellows it had already started read forever as running. Both are
   * memory facts persisted halfway; neither can be true after a restart, because the round
   * that owned them is gone.
   */
  reconcileInterrupted(): void {
    this.fellows.reconcileInterrupted()
    const open = this.shifts.list(7).filter((r) => r.finishedAt === null)
    for (const record of open) {
      this.shifts.put({
        ...record,
        finishedAt: this.now().toISOString(),
        // Marked in the row itself: the alternative is a round that reads as having run and
        // found nothing, which is a very different claim than one that was cut off.
        summary: { ...record.summary, interrupted: true },
      })
      this.log('warn', `shift: closed the round of ${record.cycleDate}, which a restart interrupted`)
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  get isRunning(): boolean {
    return this.running !== null
  }

  /**
   * When the night a release would be granted for ends: the window `now` is inside, or the
   * next one. The shift owns the window, so it answers this rather than the usage route
   * reading the same two settings a second time.
   */
  nightEndsAt(): string {
    const at = windowAt(this.now(), this.window())
    return (at.current ?? at.next).end.toISOString()
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
    let ingests: ShiftSummary['ingests']
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
      ...(ingests !== undefined ? { ingests } : {}),
    })
    const record = (finishedAt: string | null): ShiftRecord => ({ cycleDate, trigger, startedAt: startedAt.toISOString(), finishedAt, summary: summary() })
    // A verdict is about tonight's topics; next night's are different ones.
    this.verdicts = new Map()
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

    /*
     * And the other side of that loop (docs/sources/SPEC.md section 6.1): entries nobody could
     * read are checked for a legal open copy and marked, so the board can offer the ingest in
     * the morning. A mark, never an ingest of its own - the user decides.
     */
    if (this.openCopies !== undefined) {
      try {
        const { checked, found } = await this.openCopies(cycleDate)
        if (checked > 0) this.log('info', `shift: ${checked} reading list entr${checked === 1 ? 'y' : 'ies'} checked for an open copy, ${found} found`)
      } catch (err) {
        this.log('warn', `shift: the reading list was not checked for open copies: ${(err as Error).message}`)
      }
    }

    /*
     * Phase 0: the ingests the user queued for tonight, before any Fellow works. All of them,
     * whatever the hour - the Fellows get what is left of the window, and a run with no room
     * is skipped below with its reason, as ever. A job held after this point waits for the
     * next night (chunk 6 of docs/tasks/TASKS-SWEEP-2026-09.md).
     */
    if (this.ingests !== undefined) {
      const released = this.ingests.release()
      if (released.length > 0) {
        this.log('info', `shift: ${released.length} ingest${released.length === 1 ? '' : 's'} held for tonight released to the queue`)
        await this.ingests.onIdle()
        const done = released.filter((id) => this.ingests!.statusOf(id) === 'done').length
        ingests = { released: released.length, done }
        this.log('info', `shift: the ingest queue is drained, ${done} of ${released.length} done`)
      }
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
          merged: [...dedupe.merged, { keptAgentName: done.agentName, keptTopic: done.topic, droppedAgentName: agent.name, droppedTopic: proposal.topic, score, by: 'lexical' }],
        }
        this.log('info', `shift: ${agent.name}'s "${proposal.topic}" is covered by ${done.agentName}'s run tonight (overlap ${score})`)
        this.shifts.put(record(null))
        return false
      }
      /*
       * And the same question put to the judge, for the duplicate the words cannot see. Graded
       * exactly as the pass before the shift: merge only well above the bar and only an
       * undecided proposal, otherwise note it and let the run happen.
       */
      const judged = await this.judgeCovered(proposal.topic, agent.id, executed)
      if (judged !== null) {
        const score = Math.round(judged.verdict.score * 100) / 100
        const sure = judged.verdict.score >= JUDGE_MERGE
        const merge = sure && proposal.status !== 'approved'
        dedupe = {
          ...dedupe,
          merged: [
            ...dedupe.merged,
            {
              keptAgentName: judged.run.agentName,
              keptTopic: judged.run.topic,
              droppedAgentName: agent.name,
              droppedTopic: proposal.topic,
              score,
              by: 'judge',
              ...(merge ? {} : { noted: true }),
              ...(judged.verdict.reason !== undefined ? { reason: judged.verdict.reason } : {}),
            },
          ],
        }
        this.shifts.put(record(null))
        if (merge) {
          this.fellows.supersedeProposal(proposal.id, `judged the same question as ${judged.run.agentName}'s run "${judged.run.topic}" tonight (${score})`)
          this.log('info', `shift: ${agent.name}'s "${proposal.topic}" was judged the same question as ${judged.run.agentName}'s run (${score})`)
          return false
        }
        if (sure) {
          // Approved: the user decided this topic, and a model's opinion does not overturn a
          // decision. Held for another night, exactly as the lexical pass holds one.
          skip(agent, `judged the same question as ${judged.run.agentName}'s run tonight (${score}); the approved topic keeps its place`)
          return false
        }
        this.log('info', `shift: ${agent.name}'s "${proposal.topic}" may overlap ${judged.run.agentName}'s run (${score}); running it and noting it`)
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
      dedupe = await this.dedupe()
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
      /*
       * One planning run per standing task for a `sweep` Fellow, the one whose turn it is for
       * a `rotate` one. `planNight` awaits each run before starting the next, so the loop here
       * gets a settled outcome per task and reports each as its own line.
       */
      const outcomes = await this.fellows.planNight(agent.id, cycleDate)
      for (const outcome of outcomes) {
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
    }

    /*
     * Phase 2 just created tonight's proposals, and they never met the pass at the start of the
     * night. Judge them now, before phase 3 spends a run on one and before the recap asks the
     * user about them. The memo makes this cost only the pairs that are actually new.
     */
    try {
      const before = dedupe.merged.length
      const merged = [...dedupe.merged]
      await this.judgeKept(this.standing(), merged)
      if (merged.length !== before) dedupe = { ...dedupe, merged }
    } catch (err) {
      this.log('warn', `shift: the second judging pass failed, the lexical passes stand: ${(err as Error).message}`)
    }

    /*
     * Phase 3: auto Fellows run what phase 2 just planned for them (section 6.5), in rounds.
     *
     * It used to be one `executeOne` per Fellow, which was right while a Fellow planned ONE
     * task a night: its top proposal WAS its night. Since `nightly: sweep` a Fellow plans
     * every standing task, and phase 1 - the loop that runs more than one - skips auto
     * Fellows on purpose, because their proposals do not exist yet when it runs. So an auto
     * Fellow swept three tasks and ran one of them, whatever its runs-per-day allowed.
     *
     * The same round shape as phase 1, and the same thing stops it: the quota, the gate, or
     * nothing left that is runnable.
     */
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let progressed = false
      for (const agent of active()) {
        if (agent.autonomy !== 'auto') continue
        if (await executeOne(agent)) progressed = true
      }
      if (!progressed) break
    }

    const done = record(this.now().toISOString())
    this.shifts.put(done)
    this.log('info', `shift: cycle ${cycleDate} finished: ${executed.length} run(s), ${planned.length} plan(s), ${skipped.length} skip(s), ${done.summary.costUsd} USD`)
    return done
  }
}
