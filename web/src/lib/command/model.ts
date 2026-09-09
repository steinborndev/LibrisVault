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

import type { AgentTask, FellowRecord, FellowSummary, GraphNode, TaskKind } from '../../api/types.ts'

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
   * False when only the planning run fits tonight: the Fellow's runs-per-day quota is spent
   * on earlier tasks, so this one is planned tonight and carried out on a later night.
   */
  readonly runs: boolean
}

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

/**
 * How many of tonight's tasks a Fellow also carries out, as opposed to only planning: its
 * runs-per-day quota, or fewer if it has fewer tasks standing.
 */
export function carriedTonight(agent: FellowRecord): number {
  return Math.min(tasksTonight(agent).length, Math.max(0, agent.quotaRunsPerDay))
}

/** What one Fellow costs the night: a planning run each, plus the runs the quota lets through. */
export function fellowMinutes(agent: FellowRecord, durations: Readonly<Record<string, number | null>>): number {
  const tasks = tasksTonight(agent)
  const carried = carriedTonight(agent)
  return tasks.reduce((n, t, i) => n + (i < carried ? minutesFor(t.kind, durations) : planMinutes(durations)), 0)
}

/**
 * Tonight's queue: every Fellow of every visited shelf, laid end to end from the window's
 * start. The runs are serialized on the run mutex, so this is one line and not one per shelf
 * (A7 D9) - which is the whole reason the schedule is drawn at all.
 *
 * A Fellow's `quotaRunsPerDay` caps how many of its tasks are also CARRIED OUT tonight; the
 * rest still cost their planning run. `minutesFor` a task past the cap would book time the
 * shift will not spend.
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
      const carried = carriedTonight(f.agent)
      for (const [i, t] of tasksTonight(f.agent).entries()) {
        const runs = i < carried
        const minutes = runs ? minutesFor(t.kind, durations) : planMinutes(durations)
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
          runs,
        })
        cur += minutes
      }
    }
  }
  return out
}

/**
 * How many tasks a set of blocks actually gets through, in words.
 *
 * The count has to lead with what RUNS. Every task on the list gets a planning run, so a plain
 * "3 tasks" against a quota of two says the night does three when it does two and defers one,
 * and the number a schedule shows is the one a reader takes at face value.
 */
export function taskCount(blocks: readonly Block[]): string {
  const runs = blocks.filter((b) => b.runs).length
  const word = (n: number): string => `${n} task${n === 1 ? '' : 's'}`
  return runs === blocks.length ? word(runs) : `${runs} of ${word(blocks.length)} run`
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
