/**
 * Local calendar arithmetic shared by the night shift, the recap and the Fellow service
 * (docs/tasks/TASKS-A1.md D5). Everything here is pure and takes the instant as an
 * argument, so the tests pin the clock.
 */

/** Local calendar date `YYYY-MM-DD`. */
export function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** `days` after a local calendar date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return localDate(new Date(y, m - 1, d + days))
}

export interface NightWindow {
  /** Local `HH:MM`. */
  readonly start: string
  readonly end: string
}

export interface WindowSpan {
  readonly start: Date
  readonly end: Date
  /** The local date of the window's end: the morning after the night (D5). */
  readonly cycleDate: string
}

export interface WindowAt {
  /** The window `now` falls into, or null outside every window. */
  readonly current: WindowSpan | null
  /** The next window that starts after `now`. */
  readonly next: WindowSpan
}

export function parseHm(hm: string): { h: number; m: number } {
  const [h, m] = hm.split(':').map(Number)
  return { h: Number.isFinite(h) ? h! : 1, m: Number.isFinite(m) ? m! : 0 }
}

/** The window that starts on the local calendar day of `dayRef` (it may end the next day). */
function spanStartingOn(dayRef: Date, window: NightWindow): WindowSpan {
  const s = parseHm(window.start)
  const e = parseHm(window.end)
  const start = new Date(dayRef.getFullYear(), dayRef.getMonth(), dayRef.getDate(), s.h, s.m)
  let end = new Date(dayRef.getFullYear(), dayRef.getMonth(), dayRef.getDate(), e.h, e.m)
  if (end.getTime() <= start.getTime()) end = new Date(dayRef.getFullYear(), dayRef.getMonth(), dayRef.getDate() + 1, e.h, e.m)
  return { start, end, cycleDate: localDate(end) }
}

/**
 * The cycle an instant BELONGS to: the window it falls inside, else the one that started most
 * recently (2026-09-14).
 *
 * The difference from {@link windowAt} is which way it looks when `now` is between two nights.
 * A forecast looks FORWARD - "tonight" at six in the evening is the window that has not opened
 * yet. A count that GATES has to cover the present moment instead, or there would be hours of
 * the day in which nothing is counted at all: the daylight hours belong to the night that
 * opened them, so a run started by hand at noon is counted against that one.
 *
 * Both anchor on the window START rather than on local midnight, which is the point of having
 * them: a night from 23:30 to 04:00 is one cycle and not two.
 */
export function cycleAt(now: Date, window: NightWindow): WindowSpan {
  const t = now.getTime()
  const days = [-2, -1, 0].map((d) => spanStartingOn(new Date(now.getFullYear(), now.getMonth(), now.getDate() + d), window))
  return [...days].reverse().find((s) => s.start.getTime() <= t) ?? days[0]!
}

/** Where `now` stands relative to the night window. */
export function windowAt(now: Date, window: NightWindow): WindowAt {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const spans = [spanStartingOn(yesterday, window), spanStartingOn(now, window), spanStartingOn(tomorrow, window)]
  const t = now.getTime()
  const current = spans.find((s) => s.start.getTime() <= t && t < s.end.getTime()) ?? null
  const next = spans.find((s) => s.start.getTime() > t) ?? spans[2]!
  return { current, next }
}

/** The instant of a local `HH:MM` on the calendar day of `dayRef`. */
export function atLocalTime(dayRef: Date, hm: string): Date {
  const { h, m } = parseHm(hm)
  return new Date(dayRef.getFullYear(), dayRef.getMonth(), dayRef.getDate(), h, m)
}
