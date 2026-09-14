/**
 * What the command centre draws, derived from what the API returns (docs/tasks/TASKS-A7.md).
 *
 * The window asks questions the endpoints do not answer directly - how many shelves have a
 * Fellow, what is unanswered on the ones that do not, how long tonight's queue is - and the
 * arithmetic behind them is where a plausible-looking wrong number would hide. So it lives
 * here, pure and under test, and the component only lays it out.
 *
 * Two of these are cheaper to get wrong than to get right, so they are spelled out here:
 *
 * - A task's cost is a PLANNING run plus its own run, because the shift starts both.
 * - The planning run is not gated by `quotaRunsPerDay`, and the run it produces is. So a
 *   Fellow that sweeps three tasks on a quota of one plans three and carries out one. Drawing
 *   three full runs would be the plausible-looking wrong number: the night would read as full
 *   when most of it is not booked, and two of the three tasks would look done.
 */

import { kindUsd, pointsPerUsd, runUsd, type Calibrated, type Prices } from '../plan.ts'
import type { AgentTask, FellowRecord, FellowSummary, GraphNode, ProposalRecord, TaskKind, SceneJob } from '../../api/types.ts'

/** A Fellow holds one art when all its tasks share one, and is custom when they do not. */
export type FellowArt = TaskKind | 'custom'

/**
 * The art a task list amounts to. The record carries `art` since A7 stage B and that is what
 * the service enforces; this stays for a list being edited, before it has a record to read.
 */
export function artOf(tasks: readonly AgentTask[]): FellowArt {
  const kinds = new Set(tasks.map((t) => t.kind))
  const only = [...kinds][0]
  return kinds.size === 1 && only !== undefined ? only : 'custom'
}

/**
 * The tasks a Fellow works tonight: every standing one when it sweeps, the one whose turn it
 * is when it rotates (docs/tasks/TASKS-A7.md D8). A paused Fellow works none.
 */
export function tasksTonight(agent: FellowRecord): readonly AgentTask[] {
  if (agent.state === 'paused' || agent.state === 'retired') return []
  const tasks = agent.tasks ?? []
  const active = tasks.filter((t) => t.state === 'active')
  if (active.length === 0) return []
  if (agent.nightly !== 'rotate') return active
  /*
   * The cursor indexes the WHOLE list, not the active part of it: the service steps over a
   * resting task rather than removing it (`taskForTonight`). Reading it against the filtered
   * list put a different task up here than the one the shift would run, and only when
   * something was resting - which is exactly when nobody would think to check.
   */
  const start = ((agent.taskCursor % tasks.length) + tasks.length) % tasks.length
  for (let step = 0; step < tasks.length; step++) {
    const t = tasks[(start + step) % tasks.length]!
    if (t.state === 'active') return [t]
  }
  return []
}

export interface Shelf {
  readonly key: string
  /** Knowledge pages filed under this domain. */
  readonly pages: number
  /** Question pages: what the vault has written down as unanswered. */
  readonly questions: number
  /** Link targets nobody has written, attributed to the domain most of their referrers are in. */
  readonly gaps: number
  readonly fellows: readonly FellowSummary[]
}

/**
 * Every domain of the registry with the facts a staffing decision needs, and its Fellows.
 *
 * A Fellow appears at its `homeDomain` only (A7 D10): `extraDomains` widens where it may work,
 * not where it lives, and counting it twice would double the night's arithmetic.
 */
export function shelvesFrom(input: {
  readonly domains: readonly string[]
  readonly nodes: readonly GraphNode[]
  readonly gaps: ReadonlyArray<{ readonly title: string; readonly refBy: readonly number[] }>
  readonly fellows: readonly FellowSummary[]
}): readonly Shelf[] {
  const pages = new Map<string, number>()
  const questions = new Map<string, number>()
  for (const n of input.nodes) {
    if (n.domain === null || (n.kind ?? 'knowledge') !== 'knowledge') continue
    pages.set(n.domain, (pages.get(n.domain) ?? 0) + 1)
    if (n.type === 'questions') questions.set(n.domain, (questions.get(n.domain) ?? 0) + 1)
  }
  // A gap belongs where it is missed: the domain most of the pages that link to it sit in.
  const gaps = new Map<string, number>()
  for (const g of input.gaps) {
    const tally = new Map<string, number>()
    for (const i of g.refBy) {
      const d = input.nodes[i]?.domain
      if (d != null) tally.set(d, (tally.get(d) ?? 0) + 1)
    }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    if (top) gaps.set(top[0], (gaps.get(top[0]) ?? 0) + 1)
  }
  return input.domains.map((key) => ({
    key,
    pages: pages.get(key) ?? 0,
    questions: questions.get(key) ?? 0,
    gaps: gaps.get(key) ?? 0,
    fellows: input.fellows.filter((f) => f.agent.homeDomain === key && f.agent.state !== 'retired'),
  }))
}

/**
 * The shelves the night visits, in the order it visits them: the stored order first, then the
 * ones nobody placed, ranked as the shift ranks their Fellows (priority, then age).
 *
 * An unplaced shelf sorting last is not a statement that it comes last - it is what "nothing
 * was said about it" looks like, and the same rule the service sorts by (`byShelfThenPriority`).
 */
export function shelfOrder(shelves: readonly Shelf[], order: readonly string[] = []): readonly Shelf[] {
  const rank = new Map(order.map((d, i) => [d, i]))
  const placed = (s: Shelf): number => rank.get(s.key) ?? Number.POSITIVE_INFINITY
  const best = (s: Shelf): number => s.fellows.reduce((n, f) => Math.max(n, f.agent.priority), Number.NEGATIVE_INFINITY)
  return [...shelves]
    .filter((s) => s.fellows.length > 0)
    .sort(
      (a, b) =>
        placed(a) - placed(b) ||
        best(b) - best(a) ||
        (a.fellows[0]?.agent.createdAt ?? '').localeCompare(b.fellows[0]?.agent.createdAt ?? ''),
    )
}

export interface Block {
  readonly shelf: string
  readonly fellowId: string
  readonly fellowName: string
  readonly kind: TaskKind
  readonly text: string
  readonly minutes: number
  /** Minutes from midnight; may run past 24 h, the night crosses it. */
  readonly from: number
  readonly to: number
  /** A Fellow in `manual` mode starts nothing on its own. */
  readonly waits: boolean
  /**
   * Which of the night's two run kinds this block is (2026-09-14). The shift plans every
   * standing task and then carries out as many proposals as the quota allows, and those are
   * different lengths and different numbers - a Fellow with one task and a quota of two does
   * one plan and two runs. Drawing one block per TASK could show neither.
   */
  readonly phase: 'plan' | 'run'
  /**
   * The proposal this run will carry out, where one already stands. Null for a planning run,
   * and for a run tonight's own planning has yet to fill - the slot is real, its subject is not
   * decided. A block that knows its proposal is priced by the proposal's own kind, which is the
   * difference between a five-minute step and a ten-minute sweep.
   */
  readonly proposal: ProposalRecord | null
  /**
   * What the night made of this block, as the service recorded it: `ran` when a run carried a
   * proposal out, `vetoed` when every proposal the task got was vetoed, `open` otherwise. The
   * bar marks a section from this rather than from the schedule, because the schedule is a
   * forecast and this is the record.
   */
  readonly outcome: TaskOutcome
}

export type TaskOutcome = 'ran' | 'vetoed' | 'open'

/*
 * Milliseconds first, minutes at the end: rounding each part and adding the results loses
 * most of a minute on every task, and the schedule is laid out in these numbers.
 */
const planMs = (d: Readonly<Record<string, number | null>>): number => d['plan'] ?? 90_000
const runMs = (kind: TaskKind, d: Readonly<Record<string, number | null>>): number =>
  (kind === 'deepen' ? d['research-expand'] : d['research-step']) ?? 320_000

/** The planning run every task gets, whether or not the quota leaves room to carry it out. */
export function planMinutes(durations: Readonly<Record<string, number | null>>): number {
  return Math.round(planMs(durations) / 60_000)
}

/** What a task costs the night in full: its planning run and its own run. */
export function minutesFor(kind: TaskKind, durations: Readonly<Record<string, number | null>>): number {
  return Math.round((planMs(durations) + runMs(kind, durations)) / 60_000)
}

/** What one research run of this art takes, without the planning run in front of it. */
export function runMinutes(kind: TaskKind, durations: Readonly<Record<string, number | null>>): number {
  return Math.round(runMs(kind, durations) / 60_000)
}

/**
 * The same for a run whose PROPOSAL is known, priced by what the proposal asks for rather than
 * by the art of the task it came from: a sweep of the whole field and a single-question step
 * are both proposals of a watch task and take twice as long one as the other.
 */
export function kindMinutes(kind: string, durations: Readonly<Record<string, number | null>>): number {
  return Math.round((durations[kind] ?? durations['research-step'] ?? 320_000) / 60_000)
}

/** Proposals one planning run puts up for its task; the planner is capped at three. */
const PROPOSALS_PER_PLAN = 3

/**
 * How many RESEARCH runs the night carries out for this Fellow, the ones already done included.
 *
 * It used to be `min(tasks, quota)`, which read the quota as a supply of tasks rather than as
 * the cap it is: a Fellow with one standing task and a quota of two was drawn as one run, while
 * the shift ran two - phase 3 walks its auto Fellows in ROUNDS and stops on the quota, not on
 * the task list. One task can carry a whole night, because one planning run puts up three
 * proposals for it.
 *
 * What the night can actually reach:
 *   - the quota, less what this night already spent;
 *   - what stands: the Fellow's `queue`, which the service builds from the same rule the shift
 *     runs by - approved first in any mode, then the undecided ones a Fellow that decides for
 *     itself would take;
 *   - what tonight's own plans add, and only an auto Fellow runs what it just planned - in veto
 *     mode tonight's proposals are tomorrow's runs, which is the whole point of the mode.
 */
export function runsTonight(f: FellowSummary): number {
  const done = Math.max(0, f.runsTonight)
  // "Skip tonight" stops the runs and not the planning, so the night still costs its plans.
  if (f.skipsTonight === true) return done
  const left = Math.max(0, f.agent.quotaRunsPerDay - done)
  // What stands is no longer guessed from two counts: the service reports the very list the
  // shift would take, in its order and already capped by the quota.
  const standing = (f.queue ?? []).length
  const fresh = f.agent.autonomy === 'auto' ? tasksTonight(f.agent).length * PROPOSALS_PER_PLAN : 0
  return done + Math.min(left, standing + fresh)
}

/**
 * How the night's runs fall across a Fellow's tasks: round robin over the ones that can still
 * run, so with fewer runs than tasks the ones at the front of the list get them and with more
 * the list comes round again.
 *
 * A task every proposal of which was vetoed is out of the round: the shift will not run one, so
 * booking time for it would forecast work that cannot happen - and the bar would say "nothing
 * runs" and draw a run in the same breath. Before a night has planned anything there are no
 * proposals and so no vetoes, which is why this only bites once a night is under way.
 */
export function runsByTask(f: FellowSummary): Map<string, number> {
  const vetoed = new Set((f.tonight ?? []).filter((o) => o.outcome === 'vetoed').map((o) => o.id))
  const open = tasksTonight(f.agent).filter((t) => !vetoed.has(t.id))
  const out = new Map<string, number>()
  if (open.length === 0) return out
  const runs = runsTonight(f)
  for (let i = 0; i < runs; i++) {
    const t = open[i % open.length]!
    out.set(t.id, (out.get(t.id) ?? 0) + 1)
  }
  return out
}

/** What one Fellow costs the night: one planning run per standing task, plus its research runs. */
export function fellowMinutes(f: FellowSummary, durations: Readonly<Record<string, number | null>>): number {
  const tasks = tasksTonight(f.agent)
  const runs = runsByTask(f)
  const plans = tasks.length * planMinutes(durations)
  /*
   * Priced the same way the blocks are, or the Fellow's own line would disagree with the bar
   * beside it: by the standing proposal where there is one, because a sweep of the whole field
   * and a single-question step are both proposals of a watch task and one takes twice as long;
   * by the task's art where the night has yet to decide.
   */
  const waiting = new Map<string, ProposalRecord[]>()
  for (const p of f.queue ?? []) {
    const key = p.provenance.task ?? ''
    waiting.set(key, [...(waiting.get(key) ?? []), p])
  }
  let n = 0
  for (const t of tasks) {
    for (let i = 0; i < (runs.get(t.id) ?? 0); i++) {
      const p = waiting.get(t.text)?.shift()
      n += p === undefined ? runMinutes(t.kind, durations) : kindMinutes(p.kind, durations)
    }
  }
  return plans + n
}

/**
 * Where an ingest of tonight's queue stands (2026-09-12): held until the shift begins;
 * released and waiting its turn; running; or run and committing - `done` is written before
 * the commit, and the job leaves the queue only once the commit is made.
 */
export type IngestPhase = 'held' | 'waiting' | 'running' | 'committing'

export function ingestPhase(j: Pick<SceneJob, 'hold' | 'status'>): IngestPhase {
  if (j.hold === 'night') return 'held'
  if (j.status === 'preprocessing' || j.status === 'ingesting') return 'running'
  if (j.status === 'done') return 'committing'
  return 'waiting'
}

/** An ingest of tonight's queue as the night draws it: one grey block, as wide as its kind usually takes. */
export interface IngestBlock {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly minutes: number
  readonly from: number
  readonly to: number
  readonly createdAt: string
  readonly phase: IngestPhase
}

/** Five minutes for a type the scene has no figure for (nothing measured, nothing listed). */
export const INGEST_FALLBACK_MS = 300_000

/**
 * Phase 0 of the night, laid end to end from the window's start: the ingests of tonight's
 * queue run before any Fellow works, oldest first (chunk 6 of
 * docs/tasks/TASKS-SWEEP-2026-09.md), so the Fellows' queue starts where this ends. Held or
 * released alike: a released job stays in the queue until its commit is made (the scene's
 * `night` flag), so the queue empties one job at a time as the night goes, not all at once
 * when it begins.
 */
export function ingestSchedule(
  jobs: ReadonlyArray<Pick<SceneJob, 'id' | 'name' | 'type' | 'hold' | 'night' | 'status' | 'typicalMs' | 'createdAt'>>,
  startMinute: number,
): readonly IngestBlock[] {
  const out: IngestBlock[] = []
  let cur = startMinute
  for (const j of [...jobs].filter((j) => j.night).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const minutes = Math.max(1, Math.round((j.typicalMs ?? INGEST_FALLBACK_MS) / 60_000))
    out.push({ id: j.id, name: j.name, type: j.type, minutes, from: cur, to: cur + minutes, createdAt: j.createdAt, phase: ingestPhase(j) })
    cur += minutes
  }
  return out
}

/**
 * Tonight's queue: every Fellow of every visited shelf, laid end to end from the window's
 * start. The runs are serialized on the run mutex, so this is one line and not one per shelf
 * (A7 D9) - which is the whole reason the schedule is drawn at all.
 *
 * One block is one RUN, not one task (2026-09-14). The shift plans every standing task and
 * then carries out as many proposals as the quota allows, so the two are different counts and
 * different lengths, and a Fellow with one task and a quota of two fills a night with three
 * runs. Grouped per Fellow rather than in the shift's true phase order (all plans, then all
 * runs): the shelf order is what the arrows set, and it has to stay legible in the bar.
 */
export function scheduleFrom(
  shelves: readonly Shelf[],
  startMinute: number,
  durations: Readonly<Record<string, number | null>>,
): readonly Block[] {
  const out: Block[] = []
  let cur = startMinute
  for (const s of shelves) {
    for (const f of s.fellows) {
      const outcomes = new Map((f.tonight ?? []).map((o) => [o.id, o.outcome]))
      const tasks = tasksTonight(f.agent)
      const push = (t: AgentTask, phase: 'plan' | 'run', minutes: number, outcome: TaskOutcome, proposal: ProposalRecord | null = null): void => {
        out.push({
          shelf: s.key,
          fellowId: f.agent.id,
          fellowName: f.agent.name,
          kind: t.kind,
          text: t.text,
          minutes,
          from: cur,
          to: cur + minutes,
          waits: f.agent.autonomy === 'manual',
          phase,
          proposal,
          outcome,
        })
        cur += minutes
      }
      /*
       * The standing proposals fill the run slots in the shift's own order, task by task as the
       * layout below walks them. A slot past the end of the queue is one tonight's planning
       * will fill, and it is priced by its task's art because nothing more is known about it.
       */
      const waiting = new Map<string, ProposalRecord[]>()
      for (const p of f.queue ?? []) {
        const key = p.provenance.task ?? ''
        waiting.set(key, [...(waiting.get(key) ?? []), p])
      }
      const take = (t: AgentTask): ProposalRecord | null => waiting.get(t.text)?.shift() ?? null
      // The runs this night has already carried out come first and wear the mark; the rest are
      // the forecast.
      const runsFor = runsByTask(f)
      const done = Math.max(0, f.runsTonight)
      /*
       * Laid out task by task, each with its planning run in front of its own runs. The shift
       * really does all the plans before any of the runs, and across every Fellow rather than
       * within one - but the bar is read task by task, and a task whose blocks are scattered
       * over the night cannot be pointed at, hovered, or grouped in the overview above.
       */
      let ran = 0
      for (const t of tasks) {
        // A vetoed task is marked on its plan: that is the run that produced the proposals
        // nothing survived.
        push(t, 'plan', planMinutes(durations), outcomes.get(t.id) === 'vetoed' ? 'vetoed' : 'open')
        for (let i = 0; i < (runsFor.get(t.id) ?? 0); i++) {
          const p = take(t)
          push(t, 'run', p === null ? runMinutes(t.kind, durations) : kindMinutes(p.kind, durations), ran++ < done ? 'ran' : 'open', p)
        }
      }
    }
  }
  return out
}

/**
 * One task's share of the night: its planning run and the runs that came of it, as one span.
 *
 * What the overview bar draws, where twelve hours of scale leave a single run about ten pixels
 * wide and the block a reader points at has to be the whole task. The shelf's own queue draws
 * the blocks themselves, on the window's scale, where they are wide enough to tell apart.
 */
export interface TaskBand {
  readonly shelf: string
  readonly fellowId: string
  readonly fellowName: string
  readonly kind: TaskKind
  readonly text: string
  readonly from: number
  readonly to: number
  readonly plans: number
  readonly runs: number
  readonly outcome: TaskOutcome
}

/** The blocks grouped into one band per task, in the order the night takes them. */
export function taskBands(blocks: readonly Block[]): TaskBand[] {
  const out: TaskBand[] = []
  for (const b of blocks) {
    const last = out[out.length - 1]
    if (last !== undefined && last.fellowId === b.fellowId && last.text === b.text) {
      out[out.length - 1] = {
        ...last,
        to: b.to,
        plans: last.plans + (b.phase === 'plan' ? 1 : 0),
        runs: last.runs + (b.phase === 'run' ? 1 : 0),
        // A run that happened outranks the plan's verdict: the pages exist.
        outcome: b.outcome === 'ran' ? 'ran' : last.outcome,
      }
      continue
    }
    out.push({
      shelf: b.shelf,
      fellowId: b.fellowId,
      fellowName: b.fellowName,
      kind: b.kind,
      text: b.text,
      from: b.from,
      to: b.to,
      plans: b.phase === 'plan' ? 1 : 0,
      runs: b.phase === 'run' ? 1 : 0,
      outcome: b.outcome,
    })
  }
  return out
}

/**
 * The tasks a night plans but never gets a run to: their plan block has no run block beside it.
 * What the quota holds back, named per task rather than counted, so the note can say whose.
 */
export function plannedOnly(blocks: readonly Block[]): Block[] {
  const ran = new Set(blocks.filter((b) => b.phase === 'run').map((b) => `${b.fellowId}\u0000${b.text}`))
  return blocks.filter((b) => b.phase === 'plan' && !ran.has(`${b.fellowId}\u0000${b.text}`))
}

/**
 * What a set of blocks gets through, in words.
 *
 * The count leads with the RESEARCH runs: they are the work, a planning run is what decides
 * what the work will be. Both are named, because a night of four plans and one run is a
 * different night from one plan and four runs, and "5" would say neither.
 */
export function runCount(blocks: readonly Block[]): string {
  const runs = blocks.filter((b) => b.phase === 'run').length
  const plans = blocks.length - runs
  const word = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  if (blocks.length === 0) return 'nothing to run'
  if (runs === 0) return `${word(plans, 'plan')}, no run`
  return plans === 0 ? word(runs, 'run') : `${word(runs, 'run')}, ${word(plans, 'plan')}`
}

/**
 * Why tonight will not run at all, or null when nothing stands in its way.
 *
 * The schedule is drawn from tasks and measured durations, and knows nothing about the plan.
 * But every Fellow run meets the same gate first (`usage-monitor.ts`, SPEC section 8.4):
 * planning runs included, which is what makes a night stop after its first task rather than
 * degrade. A window drawing 29 minutes of work while the gate refuses all of it is the most
 * expensive kind of wrong number, because a reader has no way to see it from here.
 *
 * Read off the service's OWN answer (`PlanStatus.gate`) rather than re-derived from the
 * percentages: two implementations of one rule is how a window ends up disagreeing with the
 * shift about the same night. All this adds is which window it was, because only the
 * five-hour one can be lifted by hand (SPEC section 8.6) and the week has to be waited out.
 */
export interface NightBlock {
  readonly reason: string
  readonly resetsAt: string | null
  /** True for the five-hour window, which a release lifts; the week is never liftable. */
  readonly liftable: boolean
}

export function nightBlock(
  plan: { gate?: { readonly window: string; readonly reason: string; readonly resetsAt: string | null } | null } | undefined,
): NightBlock | null {
  const gate = plan?.gate
  if (gate === undefined || gate === null) return null
  return { reason: gate.reason, resetsAt: gate.resetsAt, liftable: gate.window === 'five_hour' }
}

/**
 * How much room the night has left before the gate shuts, or null.
 *
 * The mirror of `nightBlock`, and worth drawing for the same reason: "nothing runs tonight"
 * is only readable against a state where something does. What a reader cannot see from the
 * schedule is how close the night is to the bound, and which of the two bounds it will meet
 * first - so the tighter one leads, by margin rather than by percentage: 18 % of a 60 %
 * reserve has less room left than 62 % of an 80 % one.
 *
 * Null when the gate is shut (that is `nightBlock`'s to say) and null when there is nothing
 * measured: promising a night that runs, without a measurement behind it, is a guess.
 */
export interface Bound {
  readonly window: 'five-hour' | 'week'
  readonly pct: number
  readonly reserve: number
  readonly resetsAt: string | null
}

export interface NightRoom {
  /** The bound with the least room left: the one a night would meet first. */
  readonly tight: Bound
  readonly other: Bound
}

export function nightRoom(
  plan:
    | {
        readonly available: boolean
        readonly gate?: { readonly window: string } | null
        readonly windows: ReadonlyArray<{ readonly window: string; readonly utilization: number; readonly resetsAt: string | null }>
        readonly override?: { readonly active: boolean; readonly pct: number } | null
        readonly settings?: { readonly reserve5hPct: number; readonly reserveWeekPct: number }
      }
    | undefined,
): NightRoom | null {
  if (plan === undefined || !plan.available || plan.settings === undefined) return null
  if (plan.gate !== undefined && plan.gate !== null) return null
  const five = plan.windows.find((w) => w.window === 'five_hour')
  const week = plan.windows.find((w) => w.window === 'seven_day')
  if (five === undefined || week === undefined) return null
  // A live release lifts the five-hour reserve to its own percentage, and only that one.
  const lift = plan.override?.active === true ? plan.override.pct : null
  const bounds: Bound[] = [
    { window: 'five-hour', pct: five.utilization, reserve: lift ?? plan.settings.reserve5hPct, resetsAt: five.resetsAt },
    { window: 'week', pct: week.utilization, reserve: plan.settings.reserveWeekPct, resetsAt: week.resetsAt },
  ]
  const [tight, other] = [...bounds].sort((a, b) => a.reserve - a.pct - (b.reserve - b.pct)) as [Bound, Bound]
  return { tight, other }
}

/**
 * The marks on a time scale, every `step` minutes, ends excluded.
 *
 * The ends are the frame the bar is drawn in; a mark there sits on the border and a label
 * there hangs off it. One kind of mark, whatever the step: a ruler whose marks differ from
 * each other is read as two rulers.
 */
export function ticksIn(from: number, to: number, step: number): number[] {
  const out: number[] = []
  if (step <= 0) return out
  for (let m = Math.ceil(from / step) * step; m < to; m += step) if (m > from) out.push(m)
  return out
}

/**
 * Whether a page is the vault's own machinery rather than something a Fellow set out to make.
 *
 * A run touches the indexes it has to touch: `hot.md` and `log.md` are rewritten by every
 * ingest and every research run, `_index.md` is the folder listing the vault maintains, and a
 * Fellow's notebook is its own record of the run. None of them are the run's result, and on a
 * list of what a Fellow created they crowd out what it actually wrote.
 *
 * The reading list is NOT one of these: a Fellow adds entries to it on purpose, and they are
 * as much a result as a page is.
 */
const VAULT_INDEXES = new Set(['wiki/hot.md', 'wiki/index.md', 'wiki/log.md', 'wiki/overview.md', 'wiki/getting-started.md'])

export function isSystemPage(path: string): boolean {
  if (VAULT_INDEXES.has(path)) return true
  // The Fellows' own notebooks, but not the rest of `wiki/meta/` - the reading list lives there.
  if (path.startsWith('wiki/meta/agents/')) return true
  return (path.split('/').pop() ?? '').startsWith('_')
}

/** `HH:MM` from a time the shift settings state as `HH:MM`, in minutes from midnight. */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return (Number(h) || 0) * 60 + (Number(m) || 0)
}

/**
 * The night's window as a stretch of minutes, unwrapped across midnight so a schedule can be
 * laid on it: 01:00 to 06:00 comes back as 1500 to 1800, a whole night after 18:00.
 */
export function windowMinutes(start: string, end: string): { readonly from: number; readonly to: number } {
  const NIGHT_FROM = 18 * 60
  let from = toMinutes(start)
  if (from < NIGHT_FROM) from += 1440
  let to = toMinutes(end)
  if (to <= from % 1440 || to < NIGHT_FROM) to += 1440
  if (to <= from) to = from + 60
  return { from, to }
}

/**
 * Tonight's SETTLED work as a list, in the order the shift will take it (2026-09-14).
 *
 * The bar answers how long and whose; this answers WHAT, which is the question the queue over
 * it cannot draw. Only work that is decided, in three kinds of line:
 *
 *   `run`   a proposal you approved. Its subject is known, down to the sentence the planner
 *           wrote and the vault page the idea came from.
 *   `plan`  a planning run: the Fellow works out what to do about one standing task. What it
 *           decides runs tonight for a Fellow that decides for itself, tomorrow for one that
 *           waits a night.
 *   `open`  a run the quota leaves room for whose subject is not settled - either nothing is
 *           planned for it yet, or what stands there is still up for a decision.
 *
 * Nothing here is up for review, and that is the point: a proposal is weighed against its
 * alternatives under Decisions, which has the rationale, the fit and the two buttons. A list
 * that ALSO asked for decisions would be a second, smaller version of that screen - and a
 * reader who wants to know what the night does would have to read past it every time.
 *
 * Ordered by the shift's own phases (`pipeline/shift.ts`), which is not the order the bar
 * draws: the bar groups by shelf because the shelf order is what the arrows set, while the
 * night really runs the standing proposals of the Fellows that wait a night, then every
 * planning run, then what the Fellows that decide for themselves have.
 */
export interface NightRow {
  readonly kind: 'run' | 'plan' | 'open'
  /** 1: standing proposals of the Fellows that wait. 2: the plans. 3: the auto Fellows' runs. */
  readonly phase: 1 | 2 | 3
  readonly shelf: string
  readonly fellowId: string
  readonly fellowName: string
  /** The standing task this line belongs to, where it belongs to one. */
  readonly task: string | null
  readonly art: TaskKind | null
  readonly proposal: ProposalRecord | null
  readonly minutes: number
  /** What the line is, in one clause and in the words the shift would use. */
  readonly why: string
  /** What the run is expected to cost: the proposal's own estimate, else the Fellow's price. */
  readonly estUsd: number | null
  /** The same in plan points, where the service is calibrated enough to have one. */
  readonly estPct: number | null
}

/**
 * Where a proposal came from, in words a reader knows (`pipeline/candidates.ts`). The planner
 * is told the candidate's kind, and it is the difference between "it swept its own subject
 * again" and "it is answering a question your vault wrote down".
 */
export const CANDIDATE_TEXT: Record<string, string> = {
  sweep: 'the standing sweep of its own task',
  'open-question': 'an open question in the vault',
  note: 'a note in its own notebook',
  gap: 'a page linked but never written',
  stub: 'a page too thin to stand',
  reading: 'a publication you put on its reading list',
  ingest: 'something you added to the vault',
  handoff: 'a question another Fellow handed over',
}

/** Where a Fellow's own runs sit in the night: a Fellow that waits runs before the plans. */
const phaseOf = (f: FellowSummary): 1 | 3 => (f.agent.autonomy === 'auto' ? 3 : 1)

/**
 * The list for one shelf, with the rest of the night as the order it sits in.
 *
 * Built from the same blocks the bar draws, so the two can never disagree about how many runs
 * there are or how long they take - the list simply names what the bar can only shade.
 */
export function nightRows(
  shelf: Shelf,
  blocks: readonly Block[],
  opts: {
    /**
     * Plan points for a price in USD, where the service is calibrated enough to give them.
     * Passed in rather than read here so the whole list speaks ONE currency: a proposal
     * carries points of its own, a slot nothing has been decided for does not, and a list
     * that mixed the two would add a number to a different number.
     */
    readonly points?: (usd: number, model: string) => number | null
    /** The measured price of each run kind, where the service has reported one. */
    readonly costs?: Prices
  } = {},
): NightRow[] {
  const out: NightRow[] = []
  for (const f of shelf.fellows) {
    const mine = blocks.filter((b) => b.fellowId === f.agent.id)
    for (const b of mine) {
      const common = {
        shelf: shelf.key,
        fellowId: f.agent.id,
        fellowName: f.agent.name,
        task: b.text,
        art: b.kind,
        minutes: b.minutes,
        // The proposal's own estimate where there is one; the Fellow's price for a slot that
        // has no proposal yet. A planning run is not priced here: it is not what the quota or
        // the research share is spent on, and naming a price for it would read as a choice.
        estUsd: b.phase === 'plan' ? null : (b.proposal?.estCostUsd ?? runUsd(f.agent.step, f.agent.model, opts.costs, b.kind)),
        estPct:
          b.phase === 'plan'
            ? null
            : (b.proposal?.estPlanPct ?? opts.points?.(runUsd(f.agent.step, f.agent.model, opts.costs, b.kind), f.agent.model) ?? null),
      }
      if (b.phase === 'plan') {
        out.push({
          ...common,
          kind: 'plan',
          phase: 2,
          proposal: null,
          why:
            f.agent.autonomy === 'auto'
              ? 'works out what to do about this task, and carries out its own top pick tonight'
              : 'works out what to do about this task; what it picks runs tomorrow night unless you veto it',
        })
        continue
      }
      /*
       * Approved is what makes a run's subject settled enough to print. A proposal that is
       * still undecided WILL run for a Fellow that decides for itself, but naming it here
       * would put a decision in front of a reader who came to see what the night does - so
       * the slot says it is waiting, and Decisions is where it is answered.
       */
      if (b.proposal?.status === 'approved') {
        out.push({ ...common, kind: 'run', phase: phaseOf(f), proposal: b.proposal, why: 'you approved it, so it runs ahead of the others' })
        continue
      }
      out.push({
        ...common,
        kind: 'open',
        phase: 3,
        proposal: null,
        why:
          b.proposal === null
            ? 'a run the quota leaves room for, on whatever tonight’s planning puts up first'
            : 'a run the quota leaves room for; what stands here is waiting on your decision',
      })
    }
  }
  // Stable inside a phase: the blocks are already in the order the bar lays them out.
  return out.map((r, i) => ({ r, i })).sort((a, b) => a.r.phase - b.r.phase || a.i - b.i).map((x) => x.r)
}

/**
 * What tonight asks of the Fellows' share of the week, against what is left of it.
 *
 * The one number the night shift never had (2026-09-14). Everything else answers a neighbouring
 * question and none of them this one: a Fellow's pill is its own run count against its own
 * quota, the plan banner is the plan's headroom against the reserves, and "Research budget" is
 * the roster at full quota projected over seven days. So four Fellows could each sit inside
 * their quota, every pill green, and the night still stop half way through with the Fellows
 * asleep on `share` - which is a thing you want to know at eleven, not at four.
 *
 * The WEEK, and only the week. The five-hour window resets inside a night that runs from 23:30
 * to 04:00, so a night measured against one five-hour share would be measured against a bound
 * that refills under it; the week is the one that survives the night, and it is the one the
 * user sets a percentage for.
 *
 * Planning runs count. The gate prices every Fellow run and holds the plans as well - they
 * spend plan points like anything else - so a total that left them out would be short by one
 * per standing task, which on a shelf of quiet Fellows is most of the night.
 */
export interface NightAsk {
  /** What the night's runs are expected to spend, in the unit the share is counted in. */
  readonly needs: number
  /** What is left of the share after what the Fellows have already spent this week. */
  readonly left: number
  /** The share itself: what the user set aside for the Fellows. */
  readonly share: number
  readonly unit: 'points' | 'usd'
  /** True when the night asks for more than is left, and the shift will stop part-way. */
  readonly over: boolean
  /** How many of the night's runs fit before the share runs out, and how many there are. */
  readonly fits: number
  readonly total: number
}

/** The plan fields this reads, so a test can hand it four numbers instead of a payload. */
export interface AskPlan {
  readonly shares: { readonly unit: 'points' | 'usd'; readonly week: number; readonly weekUsed: number }
  readonly calibration?: Calibrated['calibration']
}

export function nightAsk(blocks: readonly Block[], shelves: readonly Shelf[], plan: AskPlan | undefined, costs?: Prices): NightAsk | null {
  if (plan === undefined || plan.shares.week <= 0) return null
  const byFellow = new Map<string, FellowSummary>()
  for (const s of shelves) for (const f of s.fellows) byFellow.set(f.agent.id, f)
  const share = plan.shares.week
  const left = Math.max(0, Math.round((share - plan.shares.weekUsed) * 100) / 100)
  let needs = 0
  let fits = 0
  let spent = 0
  for (const b of blocks) {
    const f = byFellow.get(b.fellowId)
    if (f === undefined) continue
    const model = f.agent.model
    /*
     * Priced the way the gate will price it: by the run's own kind where one is decided, by
     * the Fellow's depth where the night has yet to decide. In points where the service has
     * measured enough to have a rate for this model - which is the unit the share itself is
     * counted in - and in USD until then, which is what the share falls back to as well.
     */
    const usd =
      b.phase === 'plan'
        ? kindUsd('plan', model, costs)
        : (b.proposal?.estCostUsd ?? runUsd(f.agent.step, model, costs, b.kind))
    const rate = plan.shares.unit === 'points' && plan.calibration !== undefined ? (pointsPerUsd({ calibration: plan.calibration }, model)?.ppu ?? null) : null
    const cost = rate === null ? usd : Math.round(usd * rate * 1000) / 1000
    needs += cost
    spent += cost
    // A planning run is not one of the runs the count is about: it is what decides what they
    // will be, and "the share runs out after the 3rd of 5" has to mean the work.
    if (b.phase === 'run' && spent <= left) fits++
  }
  const total = blocks.filter((b) => b.phase === 'run').length
  return {
    needs: Math.round(needs * 100) / 100,
    left,
    share,
    unit: plan.shares.unit,
    over: needs > left,
    fits: Math.min(fits, total),
    total,
  }
}

/**
 * Why a Fellow will carry out fewer runs tonight than it has standing tasks, or null when it
 * will not (2026-09-14).
 *
 * The board used to read a shortfall as a quota that was set too low, and said so in the
 * warning tone with a button to raise it. That was true while the runs were `min(tasks,
 * quota)`; since they come from what stands and what tonight's own planning puts up, the
 * quota is only one of the reasons and no longer the usual one. A Fellow that waits a night
 * runs nothing on the night it plans - that is the mode working, not a number to fix - and
 * telling it to raise a quota that is not binding changes nothing at all.
 *
 * The quota is the cause exactly when it BINDS and tasks are still left over. Everything else
 * is a supply that has not arrived yet, and the answer to it is a sentence, not a button.
 */
export type ShortfallCode = 'parked' | 'skipped' | 'quota' | 'asks' | 'waits'

export interface Shortfall {
  readonly code: ShortfallCode
  /** The standing tasks tonight, and the research runs the night will carry out for them. */
  readonly tasks: number
  readonly runs: number
  /** What the quota would have to be for every task to also run; only for `quota`. */
  readonly raiseTo: number | null
}

export function shortfall(f: FellowSummary): Shortfall | null {
  const tasks = tasksTonight(f.agent).length
  const runs = runsTonight(f)
  if (tasks === 0 || runs >= tasks) return null
  const quota = f.agent.quotaRunsPerDay
  const at = (code: ShortfallCode): Shortfall => ({ code, tasks, runs, raiseTo: code === 'quota' ? tasks : null })
  // A quota of zero parks a Fellow without pausing it, and reads as its own thing rather than
  // as a quota that is merely too small.
  if (quota <= 0) return at('parked')
  if (f.skipsTonight === true) return at('skipped')
  // The quota binds: every run it allows is taken and there are tasks past them.
  if (runs >= quota) return at('quota')
  if (f.agent.autonomy === 'manual' && f.undecidedProposals > 0) return at('asks')
  return at('waits')
}
