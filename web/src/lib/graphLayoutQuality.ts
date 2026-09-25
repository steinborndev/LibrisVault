/**
 * How clean a finished graph layout is, in numbers (2026-09-24): what the layout probe
 * (`scripts/graph-layout-probe.mjs`) reports, so a change to the forces is judged by a
 * measurement rather than by a screenshot. Pure: positions, groups and edges in, figures out.
 *
 * The figures, each chosen for one thing a reader sees:
 *
 *   - spread: per domain, the 90th-percentile distance of its pages from their centroid over
 *     the radius its slot was given. About 1 is a domain filling its territory; well above 1
 *     is a domain frayed across the map;
 *   - misplaced: the share of pages that stand, relative to slot size, nearer another
 *     domain's centroid than their own - pages drawn inside a neighbour;
 *   - overlaps: pairs of domains whose p90 discs intersect - blobs drawn into each other;
 *   - bridge ratio: the median length of a cross-domain edge over that of an internal one -
 *     how long the fibres between domains are;
 *   - fragments: per domain, the share of its pages outside its largest spatial island, two
 *     pages being in one island when they stand within `ISLAND_GAP` of each other - a domain
 *     drawn as one blob scores 0, one frayed into scattered clumps scores high;
 *   - drift: how far each domain's centre moved between two layouts, for comparing the map
 *     before and after a change such as a split.
 */

/** Two pages of one domain within this distance stand in one island (1.5 link lengths). */
export const ISLAND_GAP = 90

export interface DomainQuality {
  readonly group: number
  readonly count: number
  /** Share of its pages outside its largest island (see ISLAND_GAP). */
  readonly fragments: number
  /** p90 distance from the centroid over the slot radius. */
  readonly spread: number
  readonly cx: number
  readonly cy: number
  readonly p90: number
}

export interface LayoutQuality {
  readonly nodes: number
  readonly domains: number
  readonly spreadMedian: number
  readonly spreadMax: number
  /** The group with the largest spread, or -1. */
  readonly spreadWorst: number
  readonly misplacedShare: number
  readonly overlapPairs: number
  readonly bridgeRatio: number | null
  /** Page-weighted share of pages outside their domain's largest island. */
  readonly fragmentShare: number
  /** The largest per-domain fragment share, and its group. */
  readonly fragmentMax: number
  readonly fragmentWorst: number
  readonly perDomain: readonly DomainQuality[]
}

/** Share of `list`'s pages outside the largest group of pages chained within `gap`. */
function fragmentsOf(positions: Float32Array, list: readonly number[], gap: number): number {
  if (list.length < 2) return 0
  const cell = new Map<string, number[]>()
  const key = (x: number, y: number): string => `${Math.floor(x / gap)}:${Math.floor(y / gap)}`
  list.forEach((i, j) => {
    const k = key(positions[i * 2]!, positions[i * 2 + 1]!)
    const c = cell.get(k)
    if (c === undefined) cell.set(k, [j])
    else c.push(j)
  })
  const seen = new Uint8Array(list.length)
  let largest = 0
  for (let s = 0; s < list.length; s++) {
    if (seen[s]) continue
    seen[s] = 1
    const stack = [s]
    let size = 0
    while (stack.length > 0) {
      const j = stack.pop()!
      size++
      const x = positions[list[j]! * 2]!
      const y = positions[list[j]! * 2 + 1]!
      const cx = Math.floor(x / gap)
      const cy = Math.floor(y / gap)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const o of cell.get(`${cx + dx}:${cy + dy}`) ?? []) {
            if (seen[o]) continue
            if (Math.hypot(positions[list[o]! * 2]! - x, positions[list[o]! * 2 + 1]! - y) <= gap) {
              seen[o] = 1
              stack.push(o)
            }
          }
        }
      }
    }
    largest = Math.max(largest, size)
  }
  return 1 - largest / list.length
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!
}

/**
 * `radius[g]` is the slot radius the layout gave group g (`groupRadius` of its size); groups
 * are `domainGroups`' ids, -1 for pages without a domain, which count toward nothing here.
 */
export function layoutQuality(
  positions: Float32Array,
  groups: Int32Array,
  radius: readonly number[],
  edges: ReadonlyArray<readonly [number, number]>,
): LayoutQuality {
  const n = groups.length
  const members = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const g = groups[i]!
    if (g < 0) continue
    const list = members.get(g)
    if (list === undefined) members.set(g, [i])
    else list.push(i)
  }
  const perDomain: DomainQuality[] = []
  for (const [g, list] of [...members].sort((a, b) => a[0] - b[0])) {
    let cx = 0
    let cy = 0
    for (const i of list) {
      cx += positions[i * 2]!
      cy += positions[i * 2 + 1]!
    }
    cx /= list.length
    cy /= list.length
    const d = list.map((i) => Math.hypot(positions[i * 2]! - cx, positions[i * 2 + 1]! - cy))
    const p90 = quantile(d, 0.9)
    perDomain.push({
      group: g,
      count: list.length,
      fragments: fragmentsOf(positions, list, ISLAND_GAP),
      spread: p90 / Math.max(1, radius[g] ?? 1),
      cx,
      cy,
      p90,
    })
  }

  // Misplaced: nearer, in units of slot radius, to another domain's centroid than to its own.
  let grouped = 0
  let misplaced = 0
  const byGroup = new Map(perDomain.map((q) => [q.group, q]))
  for (let i = 0; i < n; i++) {
    const g = groups[i]!
    if (g < 0) continue
    grouped++
    const x = positions[i * 2]!
    const y = positions[i * 2 + 1]!
    const own = byGroup.get(g)!
    const ownD = Math.hypot(x - own.cx, y - own.cy) / Math.max(1, radius[g] ?? 1)
    for (const q of perDomain) {
      if (q.group === g) continue
      if (Math.hypot(x - q.cx, y - q.cy) / Math.max(1, radius[q.group] ?? 1) < ownD) {
        misplaced++
        break
      }
    }
  }

  let overlapPairs = 0
  for (let a = 0; a < perDomain.length; a++) {
    for (let b = a + 1; b < perDomain.length; b++) {
      const p = perDomain[a]!
      const q = perDomain[b]!
      if (Math.hypot(p.cx - q.cx, p.cy - q.cy) < p.p90 + q.p90) overlapPairs++
    }
  }

  const inner: number[] = []
  const cross: number[] = []
  for (const [a, b] of edges) {
    const ga = groups[a] ?? -1
    const gb = groups[b] ?? -1
    if (ga < 0 || gb < 0) continue
    const len = Math.hypot(positions[a * 2]! - positions[b * 2]!, positions[a * 2 + 1]! - positions[b * 2 + 1]!)
    ;(ga === gb ? inner : cross).push(len)
  }

  const spreads = perDomain.map((q) => q.spread)
  const outside = perDomain.reduce((a, q) => a + q.fragments * q.count, 0)
  const total = perDomain.reduce((a, q) => a + q.count, 0)
  const frayed = perDomain.reduce<DomainQuality | null>((w, q) => (w === null || q.fragments > w.fragments ? q : w), null)
  const worst = perDomain.reduce<DomainQuality | null>((w, q) => (w === null || q.spread > w.spread ? q : w), null)
  return {
    nodes: n,
    domains: perDomain.length,
    spreadMedian: median(spreads),
    spreadMax: worst?.spread ?? 0,
    spreadWorst: worst?.group ?? -1,
    misplacedShare: grouped > 0 ? misplaced / grouped : 0,
    overlapPairs,
    bridgeRatio: inner.length > 0 && cross.length > 0 ? median(cross) / Math.max(1e-9, median(inner)) : null,
    fragmentShare: total > 0 ? outside / total : 0,
    fragmentMax: frayed?.fragments ?? 0,
    fragmentWorst: frayed?.group ?? -1,
    perDomain,
  }
}

/** How far each domain's centroid moved between two layouts, by domain key. */
export function centroidDrift(
  before: ReadonlyMap<string, { x: number; y: number }>,
  after: ReadonlyMap<string, { x: number; y: number }>,
): { median: number; max: number; maxKey: string | null; compared: number } {
  const moves: Array<[string, number]> = []
  for (const [key, a] of after) {
    const b = before.get(key)
    if (b !== undefined) moves.push([key, Math.hypot(a.x - b.x, a.y - b.y)])
  }
  const top = moves.reduce<[string, number] | null>((m, x) => (m === null || x[1] > m[1] ? x : m), null)
  return { median: median(moves.map((m) => m[1])), max: top?.[1] ?? 0, maxKey: top?.[0] ?? null, compared: moves.length }
}
