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

/*
 * There is no cap on a bloom (2026-09-22, user decision). It was 12, on the ground that one
 * click must not undo the mode by putting a page's whole neighbourhood back on screen - but the
 * click now re-frames the picture onto that neighbourhood, so what it puts up is a view of one
 * page rather than a domain with a crowd in the middle of it. A cap would only hide part of the
 * answer to a question the reader has just asked in full.
 */

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

/**
 * Whether the mode can be switched on, and when it cannot, why - twice over. `reason` is the
 * switch's own line and stays on ONE of them, beside three siblings whose lines are four words;
 * `why` is the sentence behind it, which the row carries in its tooltip. A row that wrapped to
 * three lines to explain itself would be the loudest thing in a block of switches that are all
 * off.
 */
export type LandmarkState =
  | { available: true; domain: string; pages: number }
  | { available: false; reason: string; why: string }

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
  if (domain === null)
    return { available: false, reason: 'Select a domain first', why: 'Filter to one domain to see where it begins.' }
  if (domain === NO_DOMAIN)
    return {
      available: false,
      reason: 'Not a domain',
      why: 'Pages without a domain are not one: they share no subject, so "what is this built around" has no answer here.',
    }
  const pages = domainPages(nodes, domain).length
  if (pages < LANDMARK_MIN_PAGES)
    return {
      available: false,
      // The count is the domain's own, so the sentence can be checked against the panel.
      reason: `Only ${pages} pages here`,
      why: `Only ${pages} pages here, small enough to read whole.`,
    }
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
/**
 * The domain's own subgraph: its knowledge pages, the backlinks they lend each other, who
 * neighbours whom, and the total rank both entry points below read.
 */
function domainGraph(
  nodes: readonly GraphNode[],
  edges: ReadonlyArray<readonly [number, number]>,
  domain: string,
): {
  idx: number[]
  inDeg: Map<number, number>
  adj: Map<number, Set<number>>
  rank: (x: number, y: number) => number
} {
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
  return { idx, inDeg, adj, rank }
}

/** The counts and the neighbourhoods both entry points return, over one domain subgraph. */
function readings(
  nodes: readonly GraphNode[],
  g: ReturnType<typeof domainGraph>,
  marks: readonly number[],
): Pick<LandmarkSet, 'inDomain' | 'neighbours'> {
  const inDomain = new Map<string, number>()
  for (const i of g.idx) inDomain.set(nodes[i]!.path, g.inDeg.get(i)!)
  const neighbours = new Map<string, string[]>()
  for (const i of marks) neighbours.set(nodes[i]!.path, [...g.adj.get(i)!].sort(g.rank).map((j) => nodes[j]!.path))
  return { inDomain, neighbours }
}

export function landmarkSet(
  nodes: readonly GraphNode[],
  edges: ReadonlyArray<readonly [number, number]>,
  domain: string,
): LandmarkSet {
  const g = domainGraph(nodes, edges, domain)
  const { idx, inDeg, adj, rank } = g

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

  return {
    domain,
    order: order.map((i) => nodes[i]!.path),
    chapters,
    connectors: connectors.map((i) => nodes[i]!.path),
    ...readings(nodes, g, marks),
  }
}

/** What the lock records of this mode: the computed order, its breaks, and the glue. */
export type HeldLandmarks = Pick<LandmarkSet, 'domain'> & {
  order: readonly string[]
  chapters: readonly number[]
  connectors: readonly string[]
}

/**
 * A held set, read back against the graph as it stands.
 *
 * The ORDER comes from the record and is not re-derived: the set is what decides which nodes are
 * drawn in this mode, the set is recomputed on every graph change, and a ranking that moved
 * under a held picture would be the one thing the lock exists to prevent. What IS read off the
 * graph is everything that is not the order - the counts the lens colours by and the
 * neighbourhoods a bloom paints - because those say what the vault holds now.
 *
 * A held page that has since gone simply drops out, the way a `clusterStack` path already
 * behaves, and a chapter that loses all of its pages drops with them rather than leaving a rule
 * with nothing under it.
 */
export function heldLandmarkSet(
  nodes: readonly GraphNode[],
  edges: ReadonlyArray<readonly [number, number]>,
  held: HeldLandmarks,
): LandmarkSet {
  const g = domainGraph(nodes, edges, held.domain)
  const byPath = new Map<string, number>()
  for (const i of g.idx) byPath.set(nodes[i]!.path, i)

  const groups = held.chapters
    .map((start, c) => held.order.slice(start, held.chapters[c + 1] ?? held.order.length).filter((p) => byPath.has(p)))
    .filter((grp) => grp.length > 0)
  const order: string[] = []
  const chapters: number[] = []
  for (const grp of groups) {
    chapters.push(order.length)
    order.push(...grp)
  }
  return {
    domain: held.domain,
    order,
    chapters,
    connectors: held.connectors.filter((p) => byPath.has(p)),
    ...readings(nodes, g, order.map((p) => byPath.get(p)!)),
  }
}

/** How many landmarks the chapter starting at offset `chapters[c]` holds. */
export function chapterSize(set: Pick<LandmarkSet, 'order' | 'chapters'>, c: number): number {
  return (set.chapters[c + 1] ?? set.order.length) - (set.chapters[c] ?? 0)
}
