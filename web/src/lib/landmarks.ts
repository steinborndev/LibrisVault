/**
 * Landmarks (docs/tasks/TASKS-LANDMARKS.md), the Graph screen's fourth overlay: the pages one
 * domain is built around, in a reading order, plus the few pages that hold that order's
 * chapters together.
 *
 * Everything here is computed over the DOMAIN, not over the drawing. A type chip, a tag, the
 * system-page switch and the gaps overlay change what is on screen and change neither the set
 * nor its order - the list is a reading ORDER, and an order that rearranged itself because
 * somebody pressed a type chip would not be one. So the caller hands in the whole graph and a
 * domain key, never the filtered subgraph.
 *
 * One population throughout: the domain's own KNOWLEDGE pages. Landmarks, connectors,
 * neighbours and the backlink counts all live in it, so a page of another domain, an index hub
 * or a lint report can neither be a landmark nor lend one a backlink.
 *
 * Pure graph algorithmics, no React and no view state, unit-tested on its own like
 * `communities.ts` and `graphReveal.ts` - and deterministic, which the tie-break below is what
 * secures: two builds over the same vault produce the same list.
 */

import type { GraphNode } from '../api/types.ts'
import { isKnowledgeNode } from './knowledge.ts'

/**
 * The screen's key for "page without a `domain:`" (`NO_DOMAIN` in Vault.tsx, which reads it
 * from here). The absence of a domain is never one: its pages share no subject, and "what is
 * this built around" has no answer there to rank.
 */
export const NO_DOMAIN = ''

/**
 * Below this many knowledge pages the mode is not offered: a domain that small is read whole.
 * Ten of this vault's twenty-two domains clear the bar, which is the accepted cost of a switch
 * that lives where its three siblings live.
 */
export const LANDMARK_MIN_PAGES = 25

/** Share of a domain's knowledge pages that become landmarks, between the two bounds below. */
const LANDMARK_SHARE = 0.12
const LANDMARK_FLOOR = 8
const LANDMARK_CEIL = 40

/**
 * How many landmarks a domain of `pages` knowledge pages gets: 40 for the largest domain this
 * vault has, 18 for the two next, 10, 9, and 8 for everything smaller.
 */
export function landmarkCount(pages: number): number {
  return Math.min(LANDMARK_CEIL, Math.max(LANDMARK_FLOOR, Math.round(pages * LANDMARK_SHARE)))
}

/** Whether the mode can be switched on, and when it cannot, the reason the switch states. */
export type LandmarkState =
  | { available: true; domain: string; pages: number }
  | { available: false; reason: string }

/**
 * The one domain on show, or null for none and for several. Exactly `inDomainScope`'s two ways
 * of saying the same thing: one domain picked in the chips, or a room holding one domain. Both
 * are equally true on screen, and a switch that told a reader to filter to one domain while one
 * domain is what they are looking at would not be followable.
 */
export function soleDomain(selectedDomains: ReadonlySet<string>, wingScope: ReadonlySet<string> | null): string | null {
  if (selectedDomains.size > 0) return selectedDomains.size === 1 ? [...selectedDomains][0]! : null
  if (wingScope === null || wingScope.size !== 1) return null
  return [...wingScope][0]!
}

/**
 * The switch's four states, in the words it says them: available, nothing or several domains on
 * show, the unfiled pile on show, and a domain under the bar (with its own count, because "too
 * small" without the number is an assertion the reader cannot check).
 */
export function landmarkState(
  nodes: readonly GraphNode[],
  selectedDomains: ReadonlySet<string>,
  wingScope: ReadonlySet<string> | null,
): LandmarkState {
  const domain = soleDomain(selectedDomains, wingScope)
  if (domain === null) return { available: false, reason: 'Filter to one domain to see where it begins.' }
  if (domain === NO_DOMAIN) return { available: false, reason: 'Pages without a domain are not one.' }
  const pages = domainPages(nodes, domain).length
  if (pages < LANDMARK_MIN_PAGES)
    return { available: false, reason: `Only ${pages} pages here, small enough to read whole.` }
  return { available: true, domain, pages }
}

/** The domain's own knowledge pages, as indices into `nodes` - the mode's whole population. */
function domainPages(nodes: readonly GraphNode[], domain: string): number[] {
  const idx: number[] = []
  nodes.forEach((n, i) => {
    if (n.domain === domain && isKnowledgeNode(n)) idx.push(i)
  })
  return idx
}

export interface LandmarkSet {
  /** The domain the set was computed for. */
  domain: string
  /** The landmark paths, in reading order. */
  order: string[]
  /** Start offsets into `order`, one per chapter. Always begins at 0. */
  chapters: number[]
  /** The non-landmark pages that join two chapters, in the order the rule picked them. */
  connectors: string[]
  /** Backlinks from inside the domain, for every knowledge page of it. */
  inDomain: ReadonlyMap<string, number>
  /**
   * Each landmark's neighbours inside the domain, in the list's own order. All of them: what a
   * bloom paints out of this and where it caps is the screen's business, and the number the
   * list states ("12 of 22") is a fact about the page's neighbourhood rather than about paint.
   */
  neighbours: ReadonlyMap<string, string[]>
}

/**
 * The set, the order, the chapters and the connectors for one domain.
 *
 * **The set.** The top `landmarkCount` pages by backlinks from inside the same domain. Counting
 * inside rather than over the whole vault is what keeps authority a statement about the domain:
 * over the vault, an index hub lends every page it lists the same few links, and a small domain
 * gains pages whose links all point somewhere else.
 *
 * **Ties**, everywhere the rank is read: domain-internal backlinks, then backlinks over the
 * whole vault, then the path. The middle term is a real signal and costs nothing; the path makes
 * the order total, which is what makes two builds over one vault identical.
 *
 * **The order.** Strongest page first, then always the strongest page not yet listed that links
 * to or from something already listed; where nothing links any more, a new chapter begins. The
 * chapters are therefore exactly the components of the set, which is the honest name for what
 * they are. The walk does not travel through connectors although they are on screen: routing
 * through them would hide the very split the chapters report.
 *
 * **The connectors.** Repeatedly the non-landmark knowledge page of the domain that touches the
 * most chapters still separate from one another, ties by domain-internal backlinks and then by
 * path, merging what it touches, until no page touches two. No cap is needed: every step merges
 * at least two chapters, so the loop cannot run longer than one step short of the chapter count.
 * Where nothing joins anything, nothing is added and the chapters stand apart - which is then
 * true of the domain rather than of the drawing.
 */
export function landmarkSet(
  nodes: readonly GraphNode[],
  edges: ReadonlyArray<readonly [number, number]>,
  domain: string,
): LandmarkSet {
  const idx = domainPages(nodes, domain)
  const inside = new Set(idx)
  const inDeg = new Map<number, number>(idx.map((i) => [i, 0]))
  const adj = new Map<number, Set<number>>(idx.map((i) => [i, new Set<number>()]))
  for (const [a, b] of edges) {
    // Inside the domain, both ends. A self-link is a page citing itself and no backlink.
    if (a === b || !inside.has(a) || !inside.has(b)) continue
    inDeg.set(b, inDeg.get(b)! + 1)
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }
  /** The rank, total: inside, then over the vault, then the path. */
  const rank = (x: number, y: number): number =>
    inDeg.get(y)! - inDeg.get(x)! || nodes[y]!.in - nodes[x]!.in || nodes[x]!.path.localeCompare(nodes[y]!.path)

  const byRank = [...idx].sort(rank)
  const marks = byRank.slice(0, landmarkCount(idx.length))
  const markSet = new Set(marks)

  // The walk. `listed` holds landmarks only, so "links to something already listed" is a link
  // between two landmarks and the walk never steps through a connector.
  const order: number[] = []
  const chapters: number[] = []
  const listed = new Set<number>()
  while (order.length < marks.length) {
    chapters.push(order.length)
    const seed = marks.find((i) => !listed.has(i))!
    order.push(seed)
    listed.add(seed)
    for (;;) {
      // `marks` is in rank order, so the first candidate that touches the walk is the strongest.
      const next = marks.find((cand) => {
        if (listed.has(cand)) return false
        for (const nb of adj.get(cand)!) if (listed.has(nb)) return true
        return false
      })
      if (next === undefined) break
      order.push(next)
      listed.add(next)
    }
  }

  // The connectors, over the chapters as a union-find: a page is worth drawing for the chapters
  // it still joins, not for the ones something else already joined.
  const chapterOf = new Map<number, number>()
  chapters.forEach((start, c) => {
    const end = chapters[c + 1] ?? order.length
    for (let p = start; p < end; p++) chapterOf.set(order[p]!, c)
  })
  const parent = chapters.map((_, c) => c)
  const find = (c: number): number => {
    let r = c
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]!]!
      r = parent[r]!
    }
    return r
  }
  const candidates = [...idx]
    .filter((i) => !markSet.has(i))
    .sort((x, y) => inDeg.get(y)! - inDeg.get(x)! || nodes[x]!.path.localeCompare(nodes[y]!.path))
  const connectors: number[] = []
  for (;;) {
    let best: number | null = null
    let joins: Set<number> | null = null
    for (const cand of candidates) {
      const groups = new Set<number>()
      for (const nb of adj.get(cand)!) {
        const c = chapterOf.get(nb)
        if (c !== undefined) groups.add(find(c))
      }
      // Strictly greater, over a list already in tie-break order: most chapters joined wins,
      // and among equals the strongest page does.
      if (groups.size >= 2 && (joins === null || groups.size > joins.size)) {
        best = cand
        joins = groups
      }
    }
    if (best === null || joins === null) break
    connectors.push(best)
    const root = find([...joins][0]!)
    for (const g of joins) parent[find(g)] = root
  }

  const inDomain = new Map<string, number>()
  for (const i of idx) inDomain.set(nodes[i]!.path, inDeg.get(i)!)
  const neighbours = new Map<string, string[]>()
  for (const i of marks) neighbours.set(nodes[i]!.path, [...adj.get(i)!].sort(rank).map((j) => nodes[j]!.path))

  return {
    domain,
    order: order.map((i) => nodes[i]!.path),
    chapters,
    connectors: connectors.map((i) => nodes[i]!.path),
    inDomain,
    neighbours,
  }
}

/** How many landmarks the chapter starting at offset `chapters[c]` holds. */
export function chapterSize(set: Pick<LandmarkSet, 'order' | 'chapters'>, c: number): number {
  return (set.chapters[c + 1] ?? set.order.length) - (set.chapters[c] ?? 0)
}
