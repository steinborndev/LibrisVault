/**
 * Pure helpers for Home's recap feed (docs/agents/SPEC.md section 9.3): the calendar week
 * the rail shows, the day format it prints, and which recaps the feed renders under the
 * current filters. Kept out of the component so the week arithmetic - the part that is easy
 * to get wrong around month ends - is testable.
 */

import type { RecapRow } from '../api/types.ts'

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

/** `06 Sep 26` - short enough for the rail, unambiguous about the month. */
export function fmtDay(date: string): string {
  const d = parse(date)
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`
}

/** `31 Aug - 06 Sep 26` for a week given by its Monday. */
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
  /** A Fellow's name, or null for all of them. */
  readonly fellow: string | null
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
    .filter((r) => filter.fellow === null || workedOn(r, filter.fellow))
}

/** Runs a Fellow settled in the shown week - what its pill counts. */
export function runsInWeek(rows: readonly RecapRow[], monday: string, name: string): number {
  const days = new Set(weekDays(monday))
  return rows
    .filter((r) => days.has(r.cycleDate))
    .reduce((n, r) => n + r.model.fellows.filter((f) => f.name === name).reduce((m, f) => m + f.runs.length, 0), 0)
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
