/**
 * The graph explorer's navigation trail: where you came from, on the way to here.
 *
 * Two rules, and the second is the one that surprises people. Revisiting a page you already
 * walked through REWINDS to it rather than appending, so a trail never repeats a page and
 * walking back out of a detour undoes the detour. Everything else appends, and the trail is a
 * rolling window: past `max` hops the oldest drops off.
 *
 * `max` is three since 2026-09-16 (it was eight). The trail runs along the bottom of the
 * drawing under page titles that are often a line long, and eight of those is a second bar
 * rather than a breadcrumb.
 */

export function stepTrail(prev: readonly string[], path: string, max: number): string[] {
  const at = prev.indexOf(path)
  if (at >= 0) return prev.slice(0, at + 1)
  const next = [...prev, path]
  return next.length > max ? next.slice(next.length - max) : next
}
