/**
 * What the command centre draws, derived from what the API returns (docs/tasks/TASKS-A7.md).
 *
 * The window asks questions the endpoints do not answer directly - how many shelves have a
 * Fellow, what is unanswered on the ones that do not, how long tonight's queue is - and the
 * arithmetic behind them is where a plausible-looking wrong number would hide. So it lives
 * here, pure and under test, and the component only lays it out.
 *
 * Three things the service does not have yet are DERIVED here rather than invented (A7 3.3):
 * a Fellow's art comes from the arts of its tasks, the night works one task per Fellow because
 * that is what the shift does today, and the order of the shelves is the order the shift walks
 * its Fellows in. When the fields land, these three functions are what changes.
 */

import type { AgentTask, FellowRecord, FellowSummary, GraphNode, TaskKind } from '../../api/types.ts'

/** A Fellow holds one art when all its tasks share one, and is custom when they do not. */
export type FellowArt = TaskKind | 'custom'

export function artOf(tasks: readonly AgentTask[]): FellowArt {
  const kinds = new Set(tasks.map((t) => t.kind))
  const only = [...kinds][0]
  return kinds.size === 1 && only !== undefined ? only : 'custom'
}

/** The tasks a Fellow works tonight. One per night today: `taskForTonight` takes exactly one. */
export function tasksTonight(agent: FellowRecord): readonly AgentTask[] {
  if (agent.state === 'paused' || agent.state === 'retired') return []
  const active = (agent.tasks ?? []).filter((t) => t.state === 'active')
  if (active.length === 0) return []
  const at = ((agent.taskCursor % active.length) + active.length) % active.length
  return [active[at]!]
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
 * The shelves the night actually visits, in the order it visits them.
 *
 * The shift walks its Fellows by priority and then by age (`fellows.ts` `all()`), so the order
 * of the shelves is the order their first Fellow comes up. A stored order per shelf does not
 * exist yet (A7 3.3.3); until it does, this reports what will happen rather than a wish.
 */
export function shelfOrder(shelves: readonly Shelf[]): readonly Shelf[] {
  const rank = (s: Shelf): number => {
    const best = s.fellows.reduce((n, f) => Math.max(n, f.agent.priority), Number.NEGATIVE_INFINITY)
    return best
  }
  return [...shelves]
    .filter((s) => s.fellows.length > 0)
    .sort((a, b) => rank(b) - rank(a) || (a.fellows[0]?.agent.createdAt ?? '').localeCompare(b.fellows[0]?.agent.createdAt ?? ''))
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
}

/** What a run of this kind costs in minutes, from the service's own measurements. */
export function minutesFor(kind: TaskKind, durations: Readonly<Record<string, number | null>>): number {
  const run = kind === 'deepen' ? durations['research-expand'] : durations['research-step']
  const plan = durations['plan']
  return Math.round(((run ?? 320_000) + (plan ?? 90_000)) / 60_000)
}

/**
 * Tonight's queue: every Fellow of every visited shelf, laid end to end from the window's
 * start. The runs are serialized on the run mutex, so this is one line and not one per shelf
 * (A7 D9) - which is the whole reason the schedule is drawn at all.
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
      for (const t of tasksTonight(f.agent)) {
        const minutes = minutesFor(t.kind, durations)
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
        })
        cur += minutes
      }
    }
  }
  return out
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
