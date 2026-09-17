/**
 * Pure helpers for Home's recap feed (docs/agents/SPEC.md section 9.3): the calendar week
 * the rail shows, the day format it prints, and which recaps the feed renders under the
 * current filters. Kept out of the component so the week arithmetic - the part that is easy
 * to get wrong around month ends - is testable.
 */

import type { RecapFellow, RecapModel, RecapRow } from '../api/types.ts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 24 * 3600_000

/** A local calendar date as `YYYY-MM-DD` - the same shape a recap's `cycleDate` has. */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parse(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

/** `06 Sep 2026` - unambiguous about the month, and the year in full. */
export function fmtDay(date: string): string {
  const d = parse(date)
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** `31 Aug - 06 Sep 2026` for a week given by its Monday. */
export function fmtWeek(monday: string): string {
  const start = parse(monday)
  return `${String(start.getDate()).padStart(2, '0')} ${MONTHS[start.getMonth()]} - ${fmtDay(addDays(monday, 6))}`
}

export function addDays(date: string, days: number): string {
  return localDate(new Date(parse(date).getTime() + days * DAY_MS))
}

/** The Monday of the week that holds this date. */
export function weekStartOf(date: string): string {
  const d = parse(date)
  return addDays(date, -((d.getDay() + 6) % 7))
}

/** The seven days of a week, Monday first. The rail reverses this: newest on top. */
export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}

/** A Fellow worked that night when its section carries at least one run. */
export function workedOn(row: RecapRow, name: string): boolean {
  return row.model.fellows.some((f) => f.name === name && f.runs.length > 0)
}

/**
 * Why a Fellow did not work that night, in the recap's own words: the shift's skip reason
 * first, then the sleeping note, then its section's state, and a plain sentence when the
 * recap does not mention it at all (it was retired, or not spawned yet).
 */
export function absenceOf(row: RecapRow, name: string): string {
  const skipped = row.model.shift?.skipped.find((s) => s.agentName === name)
  if (skipped) return skipped.reason
  const sleeping = row.model.sleeping.find((s) => s.name === name)
  if (sleeping) return sleeping.reason
  const section = row.model.fellows.find((f) => f.name === name)
  if (section) {
    const state = section.state === 'sleeping' ? `sleeping: ${section.sleepReason ?? section.sleepCode ?? 'idle'}` : section.state
    return `${state}. It is in this recap, but no run of its own settled in the window.`
  }
  return 'not in this recap - it was not running on this day.'
}

export interface FeedFilter {
  /** Monday of the week the rail shows. */
  readonly week: string
  /** A single day, or null for the whole week. */
  readonly day: string | null
  /**
   * The Fellows on show, by name. Empty is every Fellow rather than none: the filter exists to
   * narrow, and "nothing picked" is the state you start in.
   */
  readonly fellows: readonly string[]
}

/**
 * The recaps the feed renders, newest first. A picked day always shows, even when the
 * picked Fellow did nothing that night - the reason is what you opened it for. Without one,
 * the week shows the nights that Fellow worked.
 */
export function feedRows(rows: readonly RecapRow[], filter: FeedFilter): RecapRow[] {
  const sorted = [...rows].sort((a, b) => b.cycleDate.localeCompare(a.cycleDate))
  if (filter.day !== null) return sorted.filter((r) => r.cycleDate === filter.day)
  const days = new Set(weekDays(filter.week))
  return sorted
    .filter((r) => days.has(r.cycleDate))
    .filter((r) => filter.fellows.length === 0 || filter.fellows.some((name) => workedOn(r, name)))
}

/**
 * What the picked Fellows did with one night, from their own sections of that night's recap.
 *
 * Every figure here is the SAME arithmetic the server does for the whole night, over a subset
 * of the same runs (`recap.ts`: runs, failures, cost, and pages as created + updated). That is
 * what makes a filtered strip comparable with an unfiltered one rather than merely similar:
 * pick every Fellow and you get the night's totals back, to the cent.
 *
 * What is deliberately NOT here is the part of a recap that no single Fellow owns. Plan
 * consumption counts manual runs and ingests too (`usage`, section 8.2), and the shift's own
 * counts are the night's. Those do not decompose, and inventing a per-Fellow share of them
 * would be a number nobody could check.
 */
export interface NightShare {
  readonly runs: number
  readonly pages: number
  readonly failed: number
  readonly costUsd: number
  readonly undecided: number
  readonly pageOpens: number
  readonly recapLinks: number
  /** The recap has a section for at least one of them; false = retired, or not yet spawned. */
  readonly present: boolean
}

/** The picked Fellows' sections of one recap; empty `names` is every Fellow. */
function sectionsOf(m: RecapModel, names: readonly string[]): RecapFellow[] {
  return m.fellows.filter((f) => names.length === 0 || names.includes(f.name))
}

export function nightOf(row: RecapRow, names: readonly string[]): NightShare {
  const sections = sectionsOf(row.model, names)
  const runs = sections.flatMap((f) => f.runs)
  return {
    runs: runs.length,
    pages: runs.reduce((n, r) => n + r.pagesCreated.length + r.pagesUpdated.length, 0),
    failed: runs.filter((r) => !r.ok).length,
    // Rounded the way the server rounds its own total, so summing the parts cannot drift
    // a cent away from the whole.
    costUsd: Math.round(runs.reduce((n, r) => n + (r.costUsd ?? 0), 0) * 100) / 100,
    undecided: sections.reduce((n, f) => n + f.proposals.filter((p) => p.status === 'proposed').length, 0),
    pageOpens: sections.reduce((n, f) => n + f.value.pageOpens, 0),
    recapLinks: sections.reduce((n, f) => n + f.value.recapLinks, 0),
    present: sections.length > 0,
  }
}

/** The same, over the days of one shown week: what the picked Fellows ran and what it cost. */
export function weekOf(rows: readonly RecapRow[], monday: string, names: readonly string[]): { runs: number; costUsd: number } {
  const days = new Set(weekDays(monday))
  const nights = rows.filter((r) => days.has(r.cycleDate)).map((r) => nightOf(r, names))
  return {
    runs: nights.reduce((n, x) => n + x.runs, 0),
    costUsd: Math.round(nights.reduce((n, x) => n + x.costUsd, 0) * 100) / 100,
  }
}

/** Runs a Fellow settled in the shown week - what its pill counts. */
export function runsInWeek(rows: readonly RecapRow[], monday: string, name: string): number {
  return weekOf(rows, monday, [name]).runs
}

/**
 * The day's own rows - the reading list, the skipped and the merged - narrowed to the picked
 * Fellows. Empty `names` is every Fellow, which is the state you start in.
 *
 * Each of these carries its own attribution and they are not the same shape: a reading-list
 * entry names who asked for it (or `ingest`, or nobody), a skip names the Fellow that was
 * skipped, and a merge names TWO - the topic that was dropped and the one it was folded into.
 * A merge shows for either of them, because it is the answer to "why did mine not run" as much
 * as to "why did mine cover that".
 */
export function dayRail(
  m: RecapModel,
  names: readonly string[],
): {
  reading: NonNullable<RecapModel['readingAdded']>
  skipped: NonNullable<RecapModel['shift']>['skipped']
  merged: RecapModel['dedupe']['merged']
  overlaps: RecapModel['dedupe']['overlaps']
  sleeping: RecapModel['sleeping']
} {
  const all = names.length === 0
  const dedupe = m.dedupe ?? { merged: [], overlaps: [] }
  return {
    // A quiet night files nothing, so its rail carries nothing either.
    reading: m.quiet ? [] : (m.readingAdded ?? []).filter((r) => all || (r.by !== null && names.includes(r.by))),
    skipped: (m.shift?.skipped ?? []).filter((s) => all || names.includes(s.agentName)),
    merged: dedupe.merged.filter((d) => all || names.includes(d.droppedAgentName) || names.includes(d.keptAgentName)),
    overlaps: dedupe.overlaps.filter((o) => all || names.includes(o.agentName)),
    sleeping: (m.sleeping ?? []).filter((s) => all || names.includes(s.name)),
  }
}

/**
 * The week the rail opens on: the one holding today, unless it has no recap yet (a Monday
 * before the first build), in which case the newest recap's week.
 */
export function openingWeek(rows: readonly RecapRow[], today: string): string {
  const current = weekStartOf(today)
  const days = new Set(weekDays(current))
  if (rows.some((r) => days.has(r.cycleDate))) return current
  const newest = [...rows].sort((a, b) => b.cycleDate.localeCompare(a.cycleDate))[0]
  return newest ? weekStartOf(newest.cycleDate) : current
}

/** The oldest week the arrows may reach. */
export function earliestWeek(rows: readonly RecapRow[], today: string): string {
  const oldest = [...rows].sort((a, b) => a.cycleDate.localeCompare(b.cycleDate))[0]
  return weekStartOf(oldest?.cycleDate ?? today)
}

/** Everything a Fellow's section says, lower-cased, for the search box over the feed. */
export function fellowText(f: RecapFellow): string {
  return [
    f.name,
    f.homeDomain,
    ...f.proposals.flatMap((p) => [p.topic, p.rationale, p.provenance.text]),
    ...f.runs.flatMap((r) => [r.topic, ...r.pagesCreated, ...r.pagesUpdated]),
    ...f.found,
    ...f.openQuestions,
  ]
    .join('\n')
    .toLowerCase()
}

/** True when the query is empty or something in the recap says it - a Fellow, a document, a request. */
export function recapMatches(row: RecapRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const m = row.model
  if (m.fellows.some((f) => fellowText(f).includes(q))) return true
  if ((m.readingAdded ?? []).some((r) => `${r.title} ${r.url} ${r.page ?? ''} ${r.by ?? ''}`.toLowerCase().includes(q))) return true
  return (m.unclaimed ?? []).some((u) => `${u.question} ${u.domain} ${u.fromName}`.toLowerCase().includes(q))
}
