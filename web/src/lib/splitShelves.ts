/**
 * The split proposal on screen (docs/tasks/TASKS-DOMAIN-SPLIT.md 3.1): what the Graph, the
 * Catalog and the System panel do with `GET /api/v1/domains/:key/split`.
 *
 * Pure, like `landmarks.ts` and `communities.ts`: no React, no fetching, unit-tested on its own.
 * The shelves come from the SERVER and are never recomputed here - the proposal's partition is
 * fixed by the proposal (D3), and the hull lens's own Louvain over the drawing is exactly what
 * it must not be confused with (analysis, finding 1). What lives here is the translation into
 * the canvas's vocabulary (`clusters`, `clusterLabels`), the mask a chip narrows to, and the
 * arithmetic of a selection - which shelves would be promoted, merged or not - that the
 * decision surface of milestone B reuses unchanged.
 */

import type { GraphNode, SplitProposal, SplitShelf } from '../api/types.ts'
import { isKnowledgeNode } from './knowledge.ts'
import { NO_DOMAIN, soleDomain } from './landmarks.ts'

/** Mirrors the server's `SPLIT_MIN_PAGES`: a domain under it is not offered a split. */
export const SPLIT_MIN_PAGES = 50
/** Mirrors the server's `OVERSIZE_SHARE`: the status item appears from this share on. */
export const OVERSIZE_SHARE = 0.25

/** A chip: one shelf by id, or the pages that stay with the parent. */
export type ShelfKey = number | 'rest'

/** The meta pages and the unfiled pile are no domain a split can be proposed for. */
const isDepartment = (d: string): boolean => d !== NO_DOMAIN && d !== 'meta' && d !== 'unassigned'

/**
 * Whether the Shelves overlay can be switched on, and why not - under exactly the condition
 * Landmarks uses (one domain on show, `soleDomain`), with the split's own bar. The same two
 * texts: `reason` on one line beside its siblings, `why` for the tooltip.
 */
export type ShelfState =
  | { available: true; domain: string; pages: number }
  | { available: false; reason: string; why: string }

export function shelfState(
  nodes: readonly GraphNode[],
  selectedDomains: ReadonlySet<string>,
  wingScope: ReadonlySet<string> | null,
): ShelfState {
  const domain = soleDomain(selectedDomains, wingScope)
  if (domain === null)
    return { available: false, reason: 'Select a domain first', why: 'Filter to one domain to see the shelves it falls into.' }
  if (!isDepartment(domain))
    return {
      available: false,
      reason: 'Not a domain',
      why: 'Pages without a domain, the unfiled pile and the meta pages are not a subject a split can divide.',
    }
  let pages = 0
  for (const n of nodes) if (n.domain === domain && isKnowledgeNode(n)) pages++
  if (pages < SPLIT_MIN_PAGES)
    return {
      available: false,
      reason: `Only ${pages} pages here`,
      why: `Only ${pages} pages here: a domain under ${SPLIT_MIN_PAGES} is read whole, not split.`,
    }
  return { available: true, domain, pages }
}

/** A shelf's name until it has one: its rank and its two most distinctive tags. */
export function shelfLabel(shelf: Pick<SplitShelf, 'rank' | 'tags'>): string {
  const tags = shelf.tags.slice(0, 2).map((t) => `#${t}`)
  return tags.length > 0 ? `${shelf.rank} · ${tags.join(' ')}` : `Shelf ${shelf.rank}`
}

/**
 * The proposal in the canvas's terms, for the node array on screen: each node's shelf id by
 * path, -1 for a page that stays with the parent and for every page the proposal does not hold
 * (another domain, a system page, a ghost). The rest gets no hull: it is not a shelf.
 */
export function shelfClusters(
  proposal: Pick<SplitProposal, 'shelves'>,
  nodes: ReadonlyArray<Pick<GraphNode, 'path'>>,
): { clusterIds: number[]; clusterLabels: Map<number, string> } {
  const of = new Map<string, number>()
  for (const s of proposal.shelves) for (const p of s.pages) of.set(p.path, s.id)
  return {
    clusterIds: nodes.map((n) => of.get(n.path) ?? -1),
    clusterLabels: new Map(proposal.shelves.map((s) => [s.id, shelfLabel(s)])),
  }
}

/** The paths one chip narrows to. An unknown id is an empty set, never the whole domain. */
export function shelfPaths(proposal: Pick<SplitProposal, 'shelves' | 'rest'>, key: ShelfKey): Set<string> {
  const pages = key === 'rest' ? proposal.rest.pages : (proposal.shelves.find((s) => s.id === key)?.pages ?? [])
  return new Set(pages.map((p) => p.path))
}

/** The chips, in rank order and then the rest, each with the route's own count. */
export function shelfChips(proposal: Pick<SplitProposal, 'shelves' | 'rest'>): Array<{ key: ShelfKey; label: string; size: number }> {
  return [
    ...proposal.shelves.map((s) => ({ key: s.id as ShelfKey, label: shelfLabel(s), size: s.size })),
    ...(proposal.rest.size > 0 ? [{ key: 'rest' as ShelfKey, label: 'Rest', size: proposal.rest.size }] : []),
  ]
}

export interface SplitOutcome {
  /** Pages that would leave the parent. */
  moved: number
  /** Pages the parent keeps: the rest plus every shelf not promoted. */
  parentKeeps: number
  /** The largest department domain afterwards: the parent, another domain, or a new one. */
  largestAfter: { domain: string; pages: number; share: number }
  /** Links inside the domain today whose two ends would stand in different domains. */
  crossLinks: number
}

/**
 * What promoting `groups` would do. Each group is one new domain: a single shelf, or several
 * MERGED into one (D6 - merging is how "coarser" is said). A shelf in no group stays with the
 * parent; an id the proposal does not hold is ignored, and a shelf listed twice counts once, in
 * its first group.
 *
 * Everything comes from the proposal: the sizes from the shelves, the link cost from its
 * matrix, and the largest domain elsewhere from `totals.largestOther`, so no second request and
 * no graph are needed. A new domain is named `shelf:<ids>` until it has a key.
 */
export function splitOutcome(
  proposal: Pick<SplitProposal, 'domain' | 'shelves' | 'rest' | 'links' | 'totals'>,
  groups: ReadonlyArray<readonly number[]>,
): SplitOutcome {
  const S = proposal.shelves.length
  const ids = new Set(proposal.shelves.map((s) => s.id))
  /** The final domain of each matrix row: a group index, or -1 for the parent. */
  const fate = new Array<number>(S + 1).fill(-1)
  const taken = new Set<number>()
  const clean: number[][] = []
  for (const g of groups) {
    const members = g.filter((id) => ids.has(id) && !taken.has(id))
    if (members.length === 0) continue
    for (const id of members) {
      taken.add(id)
      fate[id] = clean.length
    }
    clean.push(members)
  }
  const sizeOf = (id: number): number => proposal.shelves.find((s) => s.id === id)?.size ?? 0
  const groupSizes = clean.map((g) => g.reduce((a, id) => a + sizeOf(id), 0))
  const moved = groupSizes.reduce((a, b) => a + b, 0)
  const parentKeeps = proposal.rest.size + proposal.shelves.reduce((a, s) => a + (taken.has(s.id) ? 0 : s.size), 0)

  let crossLinks = 0
  proposal.links.forEach((row, r) => row.forEach((n, c) => {
    if (fate[r] !== fate[c]) crossLinks += n
  }))

  const K = proposal.totals.knowledgePages
  const candidates: Array<{ domain: string; pages: number }> = [
    { domain: proposal.domain, pages: parentKeeps },
    { domain: proposal.totals.largestOther.domain, pages: proposal.totals.largestOther.pages },
    ...clean.map((g, i) => ({ domain: `shelf:${g.join('+')}`, pages: groupSizes[i]! })),
  ]
  const best = candidates.reduce((a, b) => (b.pages > a.pages ? b : a))
  return {
    moved,
    parentKeeps,
    largestAfter: { domain: best.domain, pages: best.pages, share: K > 0 ? best.pages / K : 0 },
    crossLinks,
  }
}

/**
 * The largest department domain in a graph, for the status model: which one, how many knowledge
 * pages, and its share of all of them. Null for a graph without one.
 */
export function largestDepartment(nodes: readonly GraphNode[]): { domain: string; pages: number; share: number } | null {
  const counts = new Map<string, number>()
  let knowledge = 0
  for (const n of nodes) {
    if (!isKnowledgeNode(n)) continue
    knowledge++
    const d = n.domain ?? NO_DOMAIN
    if (isDepartment(d)) counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  let best: { domain: string; pages: number } | null = null
  for (const [domain, pages] of [...counts].sort((a, b) => a[0].localeCompare(b[0])))
    if (best === null || pages > best.pages) best = { domain, pages }
  return best === null ? null : { ...best, share: knowledge > 0 ? best.pages / knowledge : 0 }
}

/**
 * The collision cost of a key being typed (TASKS-DOMAIN-SPLIT 6.1, D7): the pages inside the new
 * domain and the pages elsewhere in the vault that carry `key` as a tag. Each page inside would
 * book a `tag-mirroring` finding the moment the key is its `domain:`. Case-insensitive and over
 * every page of any kind, like the server's `keyCollision`, which this mirrors so the counts
 * move as the user types rather than after a round trip.
 */
export function keyCollisionOf(
  nodes: ReadonlyArray<Pick<GraphNode, 'path' | 'tags'>>,
  paths: ReadonlySet<string>,
  key: string,
): { inside: number; elsewhere: number } {
  const k = key.trim().toLowerCase()
  if (k === '') return { inside: 0, elsewhere: 0 }
  let inside = 0
  let elsewhere = 0
  for (const n of nodes) {
    if (!n.tags.some((t) => t.toLowerCase() === k)) continue
    if (paths.has(n.path)) inside++
    else elsewhere++
  }
  return { inside, elsewhere }
}
