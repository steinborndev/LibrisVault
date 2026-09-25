/**
 * The wings as the domain sections walk them (docs/tasks/TASKS-SWEEP-2026-09.md, chunk 4).
 *
 * A wing is a Library room: the main room first, then the wings in the user's order, each
 * holding the domains shelved in it, in shelf order. The scene is the source - the same
 * placement the Library draws - so the sidebar and the room never disagree about where a
 * domain stands. What the scene has not shelved (a domain with no shelf yet, the no-domain
 * bucket) forms one last group, so every domain the screen knows is reachable by walking.
 *
 * Pure, so the order and the walking are under test.
 */

import type { SceneRoom } from '../api/types.ts'

export interface WingGroup {
  readonly id: string
  readonly name: string
  /** The domains of this wing that the screen knows, in shelf order. */
  readonly domains: readonly string[]
}

/** The id of the last group: what no room holds. */
export const UNSHELVED = 'unshelved'

/**
 * The groups, in walking order, from the rooms and the domains the screen knows (in the
 * order it lists them). A room with none of them is left out - a page with nothing on it is
 * a stop nobody wants - and without a scene there are no groups and no wing mode.
 */
export function wingGroups(scene: { readonly rooms: readonly SceneRoom[] } | undefined, known: readonly string[]): WingGroup[] {
  if (scene === undefined) return []
  const knownSet = new Set(known)
  const placed = new Set<string>()
  const groups: WingGroup[] = []
  for (const room of [...scene.rooms].sort((a, b) => a.position - b.position)) {
    const domains = [...room.shelves].sort((a, b) => a.slot - b.slot).map((s) => s.domain).filter((d) => knownSet.has(d) && !placed.has(d))
    for (const d of domains) placed.add(d)
    if (domains.length > 0) groups.push({ id: room.id, name: room.name, domains })
  }
  const rest = known.filter((d) => !placed.has(d))
  if (rest.length > 0) groups.push({ id: UNSHELVED, name: 'Not shelved', domains: rest })
  return groups
}

/**
 * The group before or after this one; null at either end, so the walk stops there. `can`, when
 * given, is which groups the walk may stop at - the rest are stepped over (see `stepDomain`).
 */
export function stepWing(groups: readonly WingGroup[], current: string, delta: -1 | 1, can?: (id: string) => boolean): string | null {
  const at = groups.findIndex((g) => g.id === current)
  if (at === -1) return null
  for (let i = at + delta; i >= 0 && i < groups.length; i += delta) if (can === undefined || can(groups[i]!.id)) return groups[i]!.id
  return null
}

/** The group a domain stands in, or undefined when the screen does not know it. */
export function wingOf(groups: readonly WingGroup[], domain: string): string | undefined {
  return groups.find((g) => g.domains.includes(domain))?.id
}

export type WingListMode = 'wing' | 'all'

/**
 * The wing on show for a mode and a remembered id: none in the flat list, the remembered
 * room while it still exists, else the first room. Null with no rooms at all, which is also
 * what "no wing mode" looks like to the section.
 */
export function resolveWing(mode: WingListMode, id: string | null, groups: readonly WingGroup[]): string | null {
  if (mode !== 'wing' || groups.length === 0) return null
  return groups.some((g) => g.id === id) ? id : (groups[0]?.id ?? null)
}

/**
 * One step through the FLAT domain list, the counterpart of `stepWing` for "show all": the
 * arrows walk the domains there since 2026-09-16, so the same two keys mean the same thing in
 * both modes - move to the next thing this section filters by.
 *
 * Three rules worth naming, because none of them is what a plain index walk would do:
 *   - the anchor is the LAST selected row, so stepping out of a set built by clicking carries
 *     on from its far end rather than from wherever the set happens to start;
 *   - the right end HOLDS (null), the way the wing arrows stop at the last room;
 *   - the left end steps OFF the list and clears, because "all domains" is a real position
 *     here - it is where the list starts - and no other key gets you back to it.
 *
 * `can`, when given, is which rows the walk may stop at, and the rest are stepped over
 * (2026-09-25: with Landmarks on, a domain too small for it is skipped, because the switch
 * could not have been turned on there either). A walk with `can` holds at BOTH ends: "all
 * domains" is not a place such a walk may stop at either.
 */
export function stepDomain(
  rows: readonly string[],
  selected: ReadonlySet<string>,
  delta: -1 | 1,
  can?: (key: string) => boolean,
): { pick: string } | 'clear' | null {
  let at = -1
  for (let i = 0; i < rows.length; i++) if (selected.has(rows[i]!)) at = i
  if (can !== undefined) {
    if (at < 0 && delta === -1) return null
    for (let i = at + delta; i >= 0 && i < rows.length; i += delta) if (can(rows[i]!)) return { pick: rows[i]! }
    return null
  }
  if (delta === 1) return at >= rows.length - 1 ? null : { pick: rows[at + 1]! }
  if (at < 0) return null
  return at === 0 ? 'clear' : { pick: rows[at - 1]! }
}
