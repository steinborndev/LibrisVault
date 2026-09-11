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

/** The group before or after this one; null at either end, so the walk stops there. */
export function stepWing(groups: readonly WingGroup[], current: string, delta: -1 | 1): string | null {
  const at = groups.findIndex((g) => g.id === current)
  if (at === -1) return null
  return groups[at + delta]?.id ?? null
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
