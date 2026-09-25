/**
 * The split proposal (docs/tasks/TASKS-DOMAIN-SPLIT.md, phase 1): which shelves an oversized
 * domain falls into, with the evidence a person needs to judge each one. SPEC.md §12.4 knows how
 * a domain is BORN from pages that fit nothing; this is the other direction.
 *
 * Pure functions over a graph the caller already built. No route, no disk access, no clock: the
 * same graph gives the same proposal, which is what lets the route memoise it per graph object
 * and lets a later write (milestone B) approve exactly the pages a person saw.
 *
 * **The engine is a CONSENSUS, not one Louvain run** (D2). One run over the same pages in
 * another order moves a median 4.8 % of them to another shelf, worst 24 %, so a single run's
 * shelves would flicker between two page loads. Forty runs over seeded permutations, a link is
 * STABLE when its two ends share a cluster in 90 % of them, and the shelves are the connected
 * groups of stable links with `SHELF_MIN_PAGES` or more. Everything else stays with the parent,
 * which is a principled home rather than a leftover: those pages are the borderline ones.
 *
 * **Its input is fixed by the proposal** (D3): the domain's KNOWLEDGE pages and the links among
 * them, sorted by path before the first permutation. What the Graph screen happens to show, and
 * the order the graph builder lists pages in, change nothing.
 *
 * Measured on the live vault (2026-09-23, analysis R3): 8 shelves over 537 pages, another seed
 * moves 0.2 % of them, the vault three days earlier 0.2 %.
 */

import type { GraphNode, VaultGraph } from './graph.js'
import { louvainCommunities } from './communities.js'
import { STRUCTURAL_TAGS } from './domain-candidates.js'
import { isDepartmentDomain } from './library.js'
import { UPSTREAM_DEMO } from './hubs.js'

/* ------------------------------------------------------------------------------ constants */

/** Below this a group is read whole: the same number as the web's `LANDMARK_MIN_PAGES`. */
export const SHELF_MIN_PAGES = 25
/** Two shelves' worth. A smaller domain is closer to a tag, by the registry's own conventions. */
export const SPLIT_MIN_PAGES = 50
/** A "shelf" of this share of the domain is a rename, not a split. */
export const HOLDS_TOGETHER_SHARE = 0.9
/** Seeded Louvain runs per proposal: 96 ms for all of them over 537 pages and 3473 links. */
export const CONSENSUS_RUNS = 40
/** The resolution at which the domain-local partition equals the whole-vault partition. */
export const CONSENSUS_GAMMA = 0.4
/** A link is stable when its ends share a cluster in this share of the runs or more. */
export const CONSENSUS_AGREE = 0.9
/** Reproducibility only: another seed moves 0.2 % of pages. */
export const CONSENSUS_SEED = 20260923
/** The status item appears when one department domain holds this share of the knowledge pages. */
export const OVERSIZE_SHARE = 0.25
/** Landmarks shown per shelf, and the ones a shelf is recognised by. */
export const SHELF_LANDMARKS = 5
export const FINGERPRINT_LANDMARKS = 3
/** Proposed tag hints per shelf. */
export const SHELF_TAGS = 4
/** Under this tag precision a shelf carries the misfiling warning. */
export const MISFILE_PRECISION = 0.6
/** A class receiving or giving this share of a shelf's pages, from tags alone, is a confusion. */
const CONFUSION_SHARE = 0.1
/** An outside page with this many links into a shelf is its neighbour. */
const OUTSIDE_MIN_LINKS = 3
/** Outside neighbours listed per shelf; the count covers all of them. */
const OUTSIDE_LISTED = 10
/** `topDistinct`'s floor: a tag scoring at or below it is not distinctive (web communities.ts). */
const DISTINCT_FLOOR = 0.05

/* ---------------------------------------------------------------------------------- types */

/** A page of the proposal: its path, and its `address:` when it has one (phase 5 keys on it). */
export interface SplitMember {
  readonly path: string
  readonly address: string | null
}

export interface SplitPageRef {
  readonly path: string
  readonly title: string
  readonly address: string | null
}

export interface ShelfLandmark extends SplitPageRef {
  /** Backlinks from inside the shelf, inside the domain, and over the whole vault. */
  readonly inShelf: number
  readonly inDomain: number
  readonly inVault: number
}

export interface OutsideNeighbour extends SplitPageRef {
  readonly domain: string | null
  /** Links between this page and the shelf, both directions. */
  readonly links: number
}

/** A class the tags confuse this shelf with: another shelf's id, or `rest` for the parent. */
export interface ShelfConfusion {
  readonly with: number | 'rest'
  /** Share of this shelf's tagged pages the tags put into `with`. */
  readonly gives: number
  /** Share of `with`'s tagged pages the tags put into this shelf. */
  readonly receives: number
}

export interface KeyCollision {
  readonly key: string
  /** Pages inside the shelf carrying `key` as a tag: each would book a `tag-mirroring` finding. */
  readonly inside: number
  /** Pages anywhere else in the vault carrying it. */
  readonly elsewhere: number
}

export interface SplitShelf {
  /** Position in rank order, 0 first. The id means something only inside one proposal. */
  readonly id: number
  readonly rank: number
  readonly size: number
  /** Pages per top-level bucket (`concepts`, `entities`, …). */
  readonly types: Readonly<Record<string, number>>
  readonly entities: number
  /** The share of the shelf's link ends inside the domain that leave the shelf. */
  readonly conductance: number
  /** The mean run agreement over the shelf's internal links. */
  readonly stability: number
  /** Tags-alone leave-one-out, the rest as a class of its own; null when nothing to measure. */
  readonly precision: number | null
  readonly recall: number | null
  /** `precision × (1 − conductance)`, the rank order (D5). */
  readonly separability: number
  readonly misfile: boolean
  readonly confusedWith: readonly ShelfConfusion[]
  readonly landmarks: readonly ShelfLandmark[]
  /** The most distinctive tags, structural ones excluded. Hints, never a key (D7). */
  readonly tags: readonly string[]
  /** The collision cost of the top tag, were it used as the key. Null without a tag. */
  readonly topTagCollision: KeyCollision | null
  readonly outsideNeighbours: { readonly count: number; readonly pages: readonly OutsideNeighbour[] }
  /** The first landmark addresses, sorted, plus the size band (D15). */
  readonly fingerprint: string
  readonly pages: readonly SplitMember[]
}

export interface DomainShare {
  /** A domain key, or `shelf:<id>` for a promoted shelf. */
  readonly domain: string
  readonly pages: number
  readonly share: number
}

export interface SplitProposal {
  readonly domain: string
  /** The domain's knowledge pages: the whole population of the proposal. */
  readonly pages: number
  readonly eligible: boolean
  /** Why there are no shelves: too small, or holds together. Null when there are shelves. */
  readonly reason: string | null
  readonly shelves: readonly SplitShelf[]
  /** What stays with the parent. */
  readonly rest: {
    readonly size: number
    readonly types: Readonly<Record<string, number>>
    readonly entities: number
    readonly pages: readonly SplitMember[]
  }
  /**
   * Directed links inside the domain, from group to group: rows and columns are the shelves in
   * id order, then the rest. Sums to `totals.internalLinks`. The client computes from it what
   * any selection or merge would turn cross-domain.
   */
  readonly links: readonly (readonly number[])[]
  readonly totals: {
    readonly inShelves: number
    readonly withParent: number
    readonly internalLinks: number
    /** Pages the tags could not place at all, excluded from precision and recall. */
    readonly untagged: number
    readonly knowledgePages: number
    readonly largestNow: DomainShare
    readonly largestAfter: DomainShare
    /**
     * The largest department domain OTHER than this one, so the client can compute the share
     * after any selection of shelves without the sizes of every domain.
     */
    readonly largestOther: DomainShare
  }
  /** Pages of the domain without an `address:`. They can be shown, never approved. */
  readonly unaddressed: readonly string[]
  readonly params: {
    readonly runs: number
    readonly gamma: number
    readonly agree: number
    readonly seed: number
    readonly shelfMinPages: number
  }
}

/* --------------------------------------------------------------------------- the consensus */

/** mulberry32: small, fast, and the same numbers on every platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ConsensusOptions {
  readonly runs?: number
  readonly gamma?: number
  readonly agree?: number
  readonly seed?: number
  readonly minPages?: number
  readonly holdsTogether?: number
}

export interface Consensus {
  /** The pages, sorted by path: every index below points into this. */
  readonly paths: readonly string[]
  /** Per page, its shelf (index into `shelves`) or -1 for the rest. */
  readonly group: readonly number[]
  /** The shelves as sorted page indices, largest first, ties by first path. */
  readonly shelves: readonly (readonly number[])[]
  /** Every distinct undirected link, with the share of runs that put its ends together. */
  readonly pairs: ReadonlyArray<{ readonly a: number; readonly b: number; readonly agree: number }>
  /** Set when the largest stable group holds `holdsTogether` of the pages or more. */
  readonly holdsTogether: boolean
  readonly largestShare: number
}

/**
 * The consensus partition of `pages` under `links` (both by path). Self-links and links to a
 * page not in `pages` are ignored. The pages are sorted by path before the first permutation,
 * so the caller's order never matters.
 */
export function consensusShelves(
  pages: readonly string[],
  links: ReadonlyArray<readonly [string, string]>,
  opts: ConsensusOptions = {},
): Consensus {
  const runs = opts.runs ?? CONSENSUS_RUNS
  const gamma = opts.gamma ?? CONSENSUS_GAMMA
  const agree = opts.agree ?? CONSENSUS_AGREE
  const minPages = opts.minPages ?? SHELF_MIN_PAGES
  const holdsShare = opts.holdsTogether ?? HOLDS_TOGETHER_SHARE

  const paths = [...new Set(pages)].sort()
  const n = paths.length
  const at = new Map(paths.map((p, i) => [p, i]))
  // Directed links, as the graph builder records them and the web's hull lens feeds Louvain.
  // Sorted, so the input order of the links is as irrelevant as that of the pages.
  const edges: Array<[number, number]> = []
  const seen = new Set<number>()
  for (const [pa, pb] of links) {
    const a = at.get(pa)
    const b = at.get(pb)
    if (a === undefined || b === undefined || a === b) continue
    const key = a * n + b
    if (seen.has(key)) continue
    seen.add(key)
    edges.push([a, b])
  }
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1])

  // The distinct undirected pairs, which is what "the two ends agree" is measured on.
  const pairIndex = new Map<number, number>()
  const pairEnds: Array<[number, number]> = []
  for (const [a, b] of edges) {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const key = lo * n + hi
    if (pairIndex.has(key)) continue
    pairIndex.set(key, pairEnds.length)
    pairEnds.push([lo, hi])
  }
  const together = new Array<number>(pairEnds.length).fill(0)

  const random = rng(opts.seed ?? CONSENSUS_SEED)
  const perm = Array.from({ length: n }, (_, i) => i)
  const inv = new Array<number>(n)
  for (let r = 0; r < runs; r++) {
    // Fisher-Yates: perm[newIndex] = page. Louvain sees the pages in this order.
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      const t = perm[i]!
      perm[i] = perm[j]!
      perm[j] = t
    }
    for (let i = 0; i < n; i++) inv[perm[i]!] = i
    const mapped = edges.map(([a, b]) => [inv[a]!, inv[b]!] as [number, number])
    const label = louvainCommunities(n, mapped, () => 1, gamma)
    pairEnds.forEach(([a, b], k) => {
      if (label[inv[a]!] === label[inv[b]!]) together[k]!++
    })
  }

  // Union-find over the stable links; the components are the candidate groups.
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!
      x = parent[x]!
    }
    return x
  }
  const pairs = pairEnds.map(([a, b], k) => ({ a, b, agree: runs > 0 ? together[k]! / runs : 0 }))
  for (const p of pairs) {
    if (p.agree + 1e-12 < agree) continue
    const ra = find(p.a)
    const rb = find(p.b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const comps = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const list = comps.get(r)
    if (list === undefined) comps.set(r, [i])
    else list.push(i)
  }
  const all = [...comps.values()].sort((x, y) => y.length - x.length || x[0]! - y[0]!)
  const largestShare = n > 0 ? (all[0]?.length ?? 0) / n : 0
  const holdsTogether = n > 0 && largestShare >= holdsShare
  const shelves = holdsTogether ? [] : all.filter((c) => c.length >= minPages)
  const group = new Array<number>(n).fill(-1)
  shelves.forEach((c, s) => {
    for (const i of c) group[i] = s
  })
  return { paths, group, shelves, pairs, holdsTogether, largestShare }
}

/* --------------------------------------------------------------------------- the evidence */

/** A knowledge page of this vault: not structure, not the plugin's demo material. */
export const isKnowledge = (n: GraphNode): boolean => n.kind === 'knowledge' && n.origin !== UPSTREAM_DEMO

const tagsOf = (n: GraphNode): string[] => [...new Set(n.tags.map((t) => t.toLowerCase()))]

const countTypes = (nodes: readonly GraphNode[]): { types: Record<string, number>; entities: number } => {
  const m = new Map<string, number>()
  for (const n of nodes) m.set(n.type, (m.get(n.type) ?? 0) + 1)
  const types: Record<string, number> = {}
  for (const k of [...m.keys()].sort()) types[k] = m.get(k)!
  return { types, entities: types.entities ?? 0 }
}

/**
 * The pages inside a shelf, and the pages anywhere else in the vault, that carry `key` as a
 * tag (D7, finding 3). Naming a shelf after a tag its own pages carry books one `tag-mirroring`
 * finding per page; a key frequent elsewhere is not distinctive of the shelf at all.
 */
export function keyCollision(graph: VaultGraph, shelfPaths: ReadonlySet<string> | readonly string[], key: string): KeyCollision {
  const inShelf = shelfPaths instanceof Set ? shelfPaths : new Set(shelfPaths as readonly string[])
  const k = key.toLowerCase()
  let inside = 0
  let elsewhere = 0
  for (const n of graph.nodes) {
    if (!n.tags.some((t) => t.toLowerCase() === k)) continue
    if (inShelf.has(n.path)) inside++
    else elsewhere++
  }
  return { key: k, inside, elsewhere }
}

export interface ProposeOptions extends ConsensusOptions {}

/**
 * The proposal for one domain. `addresses` maps page path to `address:` (the caller reads them,
 * `readAddresses` in hubs.ts); the engine never touches a file.
 */
export function proposeSplit(
  graph: VaultGraph,
  domain: string,
  addresses: ReadonlyMap<string, string>,
  opts: ProposeOptions = {},
): SplitProposal {
  const params = {
    runs: opts.runs ?? CONSENSUS_RUNS,
    gamma: opts.gamma ?? CONSENSUS_GAMMA,
    agree: opts.agree ?? CONSENSUS_AGREE,
    seed: opts.seed ?? CONSENSUS_SEED,
    shelfMinPages: opts.minPages ?? SHELF_MIN_PAGES,
  }
  const knowledge = graph.nodes.filter(isKnowledge)
  const nodeOf = new Map<string, GraphNode>(graph.nodes.map((n) => [n.path, n]))
  const addressOf = (p: string): string | null => addresses.get(p) ?? null
  const ref = (p: string): SplitPageRef => ({ path: p, title: nodeOf.get(p)?.title ?? p, address: addressOf(p) })

  const domainPaths = knowledge.filter((n) => n.domain === domain).map((n) => n.path).sort()
  const inDomain = new Set(domainPaths)
  const N = domainPaths.length

  // Directed links inside the domain, by path, self-links out.
  const domainLinks: Array<[string, string]> = []
  for (const [a, b] of graph.edges) {
    if (a === b) continue
    const pa = graph.nodes[a]!.path
    const pb = graph.nodes[b]!.path
    if (inDomain.has(pa) && inDomain.has(pb)) domainLinks.push([pa, pb])
  }

  // Department domain sizes for the share now; the share after is completed below.
  const deptSize = new Map<string, number>()
  for (const n of knowledge) if (isDepartmentDomain(n.domain)) deptSize.set(n.domain, (deptSize.get(n.domain) ?? 0) + 1)
  const K = knowledge.length
  const largestOf = (sizes: ReadonlyMap<string, number>): DomainShare => {
    let best: DomainShare = { domain: '', pages: 0, share: 0 }
    for (const [d, c] of [...sizes.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      if (c > best.pages) best = { domain: d, pages: c, share: K > 0 ? c / K : 0 }
    }
    return best
  }
  const largestNow = largestOf(deptSize)
  const largestOther = largestOf(new Map([...deptSize].filter(([d]) => d !== domain)))
  const members = (paths: readonly string[]): SplitMember[] => paths.map((p) => ({ path: p, address: addressOf(p) }))
  const unaddressed = domainPaths.filter((p) => !addresses.has(p))

  const noShelves = (reason: string, eligible: boolean): SplitProposal => ({
    domain,
    pages: N,
    eligible,
    reason,
    shelves: [],
    rest: { size: N, ...countTypes(domainPaths.map((p) => nodeOf.get(p)!)), pages: members(domainPaths) },
    links: [[domainLinks.length]],
    totals: {
      inShelves: 0,
      withParent: N,
      internalLinks: domainLinks.length,
      untagged: 0,
      knowledgePages: K,
      largestNow,
      largestAfter: largestNow,
      largestOther,
    },
    unaddressed,
    params,
  })

  if (N < SPLIT_MIN_PAGES) {
    return noShelves(`Only ${N} knowledge pages: a domain under ${SPLIT_MIN_PAGES} is read whole, not split.`, false)
  }

  const consensus = consensusShelves(domainPaths, domainLinks, opts)
  if (consensus.shelves.length === 0) {
    return noShelves(
      consensus.holdsTogether
        ? `Holds together: its largest stable group is ${Math.round(consensus.largestShare * 100)} % of the domain, so a shelf would be a rename, not a split.`
        : `No stable group of ${params.shelfMinPages} pages or more: the links do not divide this domain into shelves.`,
      true,
    )
  }

  // From here on, everything is computed in the consensus's index space (sorted paths, groups by
  // size) and reordered into rank order at the end.
  const { paths, group, shelves: groups, pairs } = consensus
  const idx = new Map(paths.map((p, i) => [p, i]))
  const S = groups.length
  const REST = S
  const cls = (i: number): number => (group[i]! >= 0 ? group[i]! : REST)
  const classSize = new Array<number>(S + 1).fill(0)
  for (let i = 0; i < N; i++) classSize[cls(i)]!++

  // Link ends per group: internal and cut, for the conductance; in-degrees for the landmarks.
  const inGroupDeg = new Array<number>(N).fill(0)
  const inDomainDeg = new Array<number>(N).fill(0)
  const internalEnds = new Array<number>(S).fill(0)
  const cutEnds = new Array<number>(S).fill(0)
  const matrix = Array.from({ length: S + 1 }, () => new Array<number>(S + 1).fill(0))
  for (const [pa, pb] of domainLinks) {
    const a = idx.get(pa)!
    const b = idx.get(pb)!
    inDomainDeg[b]!++
    const ca = cls(a)
    const cb = cls(b)
    matrix[ca]![cb]!++
    if (ca === cb) {
      inGroupDeg[b]!++
      if (ca !== REST) internalEnds[ca]! += 2
    } else {
      if (ca !== REST) cutEnds[ca]!++
      if (cb !== REST) cutEnds[cb]!++
    }
  }

  // Stability: the mean agreement over each shelf's internal links.
  const agreeSum = new Array<number>(S).fill(0)
  const agreeCount = new Array<number>(S).fill(0)
  for (const p of pairs) {
    const g = group[p.a]!
    if (g >= 0 && g === group[p.b]) {
      agreeSum[g]! += p.agree
      agreeCount[g]!++
    }
  }

  // Tags: document frequency inside the domain and per class.
  const pageTags = paths.map((p) => tagsOf(nodeOf.get(p)!).filter((t) => !STRUCTURAL_TAGS.has(t)))
  const df = new Map<string, number>()
  const classTag: Array<Map<string, number>> = Array.from({ length: S + 1 }, () => new Map())
  pageTags.forEach((tags, i) => {
    for (const t of tags) {
      df.set(t, (df.get(t) ?? 0) + 1)
      const m = classTag[cls(i)]!
      m.set(t, (m.get(t) ?? 0) + 1)
    }
  })

  /**
   * Leave-one-out prediction of a page's class from its tags alone. The score of a class: the
   * sum over the page's tags of (the tag's count in the class minus the page itself) over (the
   * class size minus the page itself), times `ln(N / df)`. A page no class scores above zero
   * for has no usable tag and is counted as such, not guessed.
   */
  const predicted = new Array<number>(N).fill(-1)
  let untagged = 0
  for (let i = 0; i < N; i++) {
    const own = cls(i)
    let best = -1
    let bestScore = 0
    for (let c = 0; c <= S; c++) {
      const self = c === own ? 1 : 0
      const denom = classSize[c]! - self
      if (denom <= 0) continue
      let score = 0
      for (const t of pageTags[i]!) {
        const inClass = (classTag[c]!.get(t) ?? 0) - self
        if (inClass <= 0) continue
        score += (inClass / denom) * Math.log(N / df.get(t)!)
      }
      if (score > bestScore + 1e-12) {
        best = c
        bestScore = score
      }
    }
    if (best < 0) untagged++
    predicted[i] = best
  }
  // confusion[true][predicted], over the pages the tags could place.
  const confusion = Array.from({ length: S + 1 }, () => new Array<number>(S + 1).fill(0))
  const tagged = new Array<number>(S + 1).fill(0)
  for (let i = 0; i < N; i++) {
    if (predicted[i]! < 0) continue
    confusion[cls(i)]![predicted[i]!]!++
    tagged[cls(i)]!++
  }

  const evidence = groups.map((members, g) => {
    const nodes = members.map((i) => nodeOf.get(paths[i]!)!)
    const vol = internalEnds[g]! + cutEnds[g]!
    const conductance = vol > 0 ? cutEnds[g]! / vol : 0
    let predictedInto = 0
    for (let c = 0; c <= S; c++) predictedInto += confusion[c]![g]!
    const precision = predictedInto > 0 ? confusion[g]![g]! / predictedInto : tagged[g]! > 0 ? 0 : null
    const recall = tagged[g]! > 0 ? confusion[g]![g]! / tagged[g]! : null

    // Landmarks: backlinks inside the shelf, then inside the domain, then over the vault, then path.
    const landmarks = [...members]
      .sort(
        (x, y) =>
          inGroupDeg[y]! - inGroupDeg[x]! ||
          inDomainDeg[y]! - inDomainDeg[x]! ||
          nodeOf.get(paths[y]!)!.in - nodeOf.get(paths[x]!)!.in ||
          paths[x]!.localeCompare(paths[y]!),
      )
      .slice(0, SHELF_LANDMARKS)
      .map((i) => ({ ...ref(paths[i]!), inShelf: inGroupDeg[i]!, inDomain: inDomainDeg[i]!, inVault: nodeOf.get(paths[i]!)!.in }))

    // Tags: `topDistinct`'s score over the domain as the population, structural tags out.
    const size = members.length
    const outN = Math.max(1, N - size)
    const scored = [...classTag[g]!.entries()].map(([t, c]) => ({ t, c, score: c / size - (df.get(t)! - c) / outN }))
    scored.sort((a, b) => b.score - a.score || b.c - a.c || a.t.localeCompare(b.t))
    const distinct = scored.filter((s) => s.score > DISTINCT_FLOOR).slice(0, SHELF_TAGS).map((s) => s.t)
    const tags = distinct.length > 0 ? distinct : scored.slice(0, SHELF_TAGS).map((s) => s.t)

    return { g, members, nodes, conductance, precision, recall, landmarks, tags }
  })

  // Rank (D5): separability, then size, then the first path. A shelf the tags cannot measure
  // ranks as if its precision were zero.
  const separabilityOf = (e: (typeof evidence)[number]): number => (e.precision ?? 0) * (1 - e.conductance)
  const order = [...evidence].sort(
    (x, y) => separabilityOf(y) - separabilityOf(x) || y.members.length - x.members.length || x.members[0]! - y.members[0]!,
  )
  const newId = new Array<number>(S + 1)
  order.forEach((e, rank) => (newId[e.g] = rank))
  newId[REST] = S
  const idOut = (c: number): number | 'rest' => (c === REST ? 'rest' : newId[c]!)

  const shelves: SplitShelf[] = order.map((e, rank) => {
    const g = e.g
    const shelfPaths = new Set(e.members.map((i) => paths[i]!))
    const confusedWith: ShelfConfusion[] = []
    for (let c = 0; c <= S; c++) {
      if (c === g || classSize[c] === 0) continue
      const gives = tagged[g]! > 0 ? confusion[g]![c]! / tagged[g]! : 0
      const receives = tagged[c]! > 0 ? confusion[c]![g]! / tagged[c]! : 0
      if (gives >= CONFUSION_SHARE || receives >= CONFUSION_SHARE) confusedWith.push({ with: idOut(c), gives, receives })
    }
    confusedWith.sort((a, b) => (a.with === 'rest' ? S : a.with) - (b.with === 'rest' ? S : b.with))

    // Outside neighbours: knowledge pages of other domains with three or more links into the shelf.
    const outside = new Map<string, number>()
    for (const [a, b] of graph.edges) {
      if (a === b) continue
      const pa = graph.nodes[a]!.path
      const pb = graph.nodes[b]!.path
      const other = shelfPaths.has(pa) && !shelfPaths.has(pb) ? pb : shelfPaths.has(pb) && !shelfPaths.has(pa) ? pa : null
      if (other === null || inDomain.has(other)) continue
      const n = nodeOf.get(other)!
      if (!isKnowledge(n)) continue
      outside.set(other, (outside.get(other) ?? 0) + 1)
    }
    const neighbours = [...outside.entries()]
      .filter(([, c]) => c >= OUTSIDE_MIN_LINKS)
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))

    const size = e.members.length
    const fingerprint = `${e.landmarks
      .slice(0, FINGERPRINT_LANDMARKS)
      .map((l) => l.address ?? l.path)
      .sort()
      .join('|')}#${Math.floor(Math.log2(size))}`

    return {
      id: rank,
      rank: rank + 1,
      size,
      ...countTypes(e.nodes),
      conductance: e.conductance,
      stability: agreeCount[g]! > 0 ? agreeSum[g]! / agreeCount[g]! : 1,
      precision: e.precision,
      recall: e.recall,
      separability: separabilityOf(e),
      misfile: e.precision !== null && e.precision < MISFILE_PRECISION,
      confusedWith,
      landmarks: e.landmarks,
      tags: e.tags,
      topTagCollision: e.tags.length > 0 ? keyCollision(graph, shelfPaths, e.tags[0]!) : null,
      outsideNeighbours: {
        count: neighbours.length,
        pages: neighbours.slice(0, OUTSIDE_LISTED).map(([p, links]) => ({ ...ref(p), domain: nodeOf.get(p)!.domain, links })),
      },
      fingerprint,
      pages: members(e.members.map((i) => paths[i]!)),
    }
  })

  // The link matrix in the new order: rows and columns are shelf ids, then the rest.
  const back = [...order.map((e) => e.g), REST]
  const links = back.map((r) => back.map((c) => matrix[r]![c]!))

  const restPaths = paths.filter((_, i) => group[i]! < 0)
  const after = new Map(deptSize)
  after.set(domain, restPaths.length)
  for (const s of shelves) after.set(`shelf:${s.id}`, s.size)
  const inShelves = N - restPaths.length

  return {
    domain,
    pages: N,
    eligible: true,
    reason: null,
    shelves,
    rest: { size: restPaths.length, ...countTypes(restPaths.map((p) => nodeOf.get(p)!)), pages: members(restPaths) },
    links,
    totals: {
      inShelves,
      withParent: restPaths.length,
      internalLinks: domainLinks.length,
      untagged,
      knowledgePages: K,
      largestNow,
      largestAfter: largestOf(after),
      largestOther,
    },
    unaddressed,
    params,
  }
}

/* --------------------------------------------------------------------------- the comparison */

/**
 * How far proposal `b` moved from proposal `a`: over the pages both hold, the share that land
 * on another shelf. Each of `b`'s shelves is matched to the group of `a` (a shelf, or the rest)
 * it overlaps most, and the rest to the rest; a page moved when its group in `b`, so matched,
 * is not its group in `a`. Used by `splitprobe --stability` and by the stability test.
 */
export function shelfDrift(a: SplitProposal, b: SplitProposal): { common: number; moved: number; share: number } {
  const groupOf = (p: SplitProposal): Map<string, number> => {
    const m = new Map<string, number>()
    for (const s of p.shelves) for (const pg of s.pages) m.set(pg.path, s.id)
    for (const pg of p.rest.pages) m.set(pg.path, -1)
    return m
  }
  const ga = groupOf(a)
  const gb = groupOf(b)
  const overlap = new Map<number, Map<number, number>>()
  for (const [path, g] of gb) {
    const inA = ga.get(path)
    if (inA === undefined) continue
    const m = overlap.get(g) ?? overlap.set(g, new Map()).get(g)!
    m.set(inA, (m.get(inA) ?? 0) + 1)
  }
  const match = new Map<number, number>([[-1, -1]])
  for (const [g, m] of overlap) {
    if (g === -1) continue
    const best = [...m.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]
    match.set(g, best?.[0] ?? -1)
  }
  let common = 0
  let moved = 0
  for (const [path, g] of gb) {
    const inA = ga.get(path)
    if (inA === undefined) continue
    common++
    if ((match.get(g) ?? -1) !== inA) moved++
  }
  return { common, moved, share: common > 0 ? moved / common : 0 }
}

/** A graph restricted to the nodes `keep` accepts, edges remapped. For the probe's "N days ago". */
export function restrictGraph(graph: VaultGraph, keep: (n: GraphNode) => boolean): VaultGraph {
  const map = new Map<number, number>()
  const nodes: GraphNode[] = []
  graph.nodes.forEach((n, i) => {
    if (!keep(n)) return
    map.set(i, nodes.length)
    nodes.push(n)
  })
  const edges: Array<[number, number]> = []
  for (const [a, b] of graph.edges) {
    const na = map.get(a)
    const nb = map.get(b)
    if (na !== undefined && nb !== undefined) edges.push([na, nb])
  }
  return { ...graph, nodes, edges }
}
