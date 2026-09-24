/**
 * The spotlight's community geometry and hover resolution (2026-09-24).
 *
 * Before this module the tinted hull was built twice: once to draw it (padded by a WORLD
 * distance, painted members only, as a smoothed curve) and once to hit-test it (padded by a
 * SCREEN distance, every member, as the raw polygon). At the fit zoom the hit area reached
 * about 20px past the drawn edge; zoomed in, most of the drawn hull did not react at all. Here
 * both come from one function, so the shape you see is the shape that answers the pointer, the
 * cursor and the click.
 *
 * Pure: no canvas, no React - the canvas feeds positions in and reads polygons out.
 */

import type { ClusterGeom, Pt } from './graphZoom.ts'

/** Padding around a community's body, in WORLD units - drawn and hit-tested alike. */
export const HULL_PAD = 26

/** A member farther than this multiple of the median member distance is a spatial outlier. */
const HULL_OUTLIER_FACTOR = 2.5

/** Samples per curve segment when the smoothed outline is turned back into a polygon. */
const SMOOTH_STEPS = 6

/** Andrew's monotone-chain convex hull. Returns the hull points counter-clockwise. */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/**
 * The subset of member points the hull should enclose: the cluster BODY, spatial outliers
 * trimmed (measured from the component-wise median point, past HULL_OUTLIER_FACTOR x the
 * median distance). Fewer than 5 members keep all; never trims below 3.
 */
export function hullBody(points: readonly Pt[]): Pt[] {
  if (points.length < 5) return [...points]
  const xs = points.map((p) => p[0]).sort((a, b) => a - b)
  const ys = points.map((p) => p[1]).sort((a, b) => a - b)
  const mid = points.length >> 1
  const mx = xs[mid]!
  const my = ys[mid]!
  const dists = points.map(([x, y]) => Math.hypot(x - mx, y - my))
  const medDist = [...dists].sort((a, b) => a - b)[mid]!
  if (medDist <= 1e-6) return [...points]
  const threshold = medDist * HULL_OUTLIER_FACTOR
  const body = points.filter((_, i) => dists[i]! <= threshold)
  return body.length >= 3 ? body : [...points]
}

/** Pushes each hull point outward from the centroid by `pad` world units. */
export function expandHull(hull: readonly Pt[], cx: number, cy: number, pad: number): Pt[] {
  return hull.map(([x, y]) => {
    const dx = x - cx
    const dy = y - cy
    const d = Math.hypot(dx, dy) || 1
    return [x + (dx / d) * pad, y + (dy / d) * pad] as Pt
  })
}

/**
 * The outline the canvas draws for a padded hull - quadratic curves through the edge
 * midpoints with the vertices as controls - sampled back into a polygon, so a point test
 * sees the curve and not the corners it rounds off.
 */
export function smoothOutline(poly: readonly Pt[], steps = SMOOTH_STEPS): Pt[] {
  if (poly.length < 3) return [...poly]
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const prev = poly[(i - 1 + poly.length) % poly.length]!
    const cur = poly[i]!
    const next = poly[(i + 1) % poly.length]!
    const p0 = mid(prev, cur)
    const p2 = mid(cur, next)
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const u = 1 - t
      out.push([u * u * p0[0] + 2 * u * t * cur[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * cur[1] + t * t * p2[1]])
    }
  }
  return out
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(x: number, y: number, poly: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!
    const [xj, yj] = poly[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Absolute area of a polygon (shoelace). */
export function polygonArea(poly: readonly Pt[]): number {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j]![0] + poly[i]![0]) * (poly[j]![1] - poly[i]![1])
  return Math.abs(a) / 2
}

/**
 * One community's geometry: the canvas draws `padded` (through the same smoothing), and the
 * pointer, the cursor, the click and the zoom magnet all read `hull` - the smoothed outline
 * of exactly that shape.
 */
export interface SpotGeom extends ClusterGeom {
  /** The padded convex hull the drawing traces; empty when fewer than 3 members. */
  padded: Pt[]
  /** Area of `hull`, world units squared - the tie-break between overlapping communities. */
  area: number
}

/**
 * Every community's geometry from the current positions. `paints` is the same filter the
 * drawing applies (a node the landmark mask hides is neither drawn nor wrapped), and `only`
 * narrows the work to one community when that is all the frame needs.
 */
export function buildSpotGeoms(
  clusters: ArrayLike<number>,
  pos: ArrayLike<number>,
  count: number,
  paints: (i: number) => boolean,
  only: number | null = null,
): SpotGeom[] {
  const members = new Map<number, Pt[]>()
  for (let i = 0; i < count; i++) {
    const cid = clusters[i] ?? -1
    if (cid < 0 || (only !== null && cid !== only)) continue
    if (!paints(i)) continue
    const x = pos[i * 2]!
    if (Number.isNaN(x)) continue
    ;(members.get(cid) ?? members.set(cid, []).get(cid)!).push([x, pos[i * 2 + 1]!])
  }
  const geoms: SpotGeom[] = []
  for (const [cid, pts] of members) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [px, py] of pts) {
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
    }
    const body = pts.length >= 3 ? hullBody(pts) : pts
    const cx = body.reduce((s, p) => s + p[0], 0) / body.length
    const cy = body.reduce((s, p) => s + p[1], 0) / body.length
    const padded = pts.length >= 3 ? expandHull(convexHull(body), cx, cy, HULL_PAD) : []
    const hull = padded.length >= 3 ? smoothOutline(padded) : []
    geoms.push({ id: cid, members: pts, hull, padded, area: polygonArea(hull), cx, cy, extent: Math.max(x1 - x0, y1 - y0) })
  }
  return geoms
}

/**
 * Which community the pointer is in, world coords. Two rules make it calm:
 *
 *  - Sticky: while the pointer is still inside the community it is already on (`current`),
 *    that community stays, however many others overlap it there. Before, an overlap was split
 *    by nearest member, so the choice flipped along lines nobody could see.
 *  - Most specific: entering an overlap fresh picks the SMALLEST containing hull - the tighter
 *    group is the one you are pointing at.
 *
 * `isolatable` filters what may be chosen at all (a community spanning every visible page
 * has nothing to isolate).
 */
export function resolveAreaCid(
  x: number,
  y: number,
  geoms: readonly SpotGeom[],
  isolatable: (cid: number) => boolean,
  current: number | null,
): number {
  let best = -1
  let bestArea = Infinity
  for (const g of geoms) {
    if (g.hull.length < 3 || !isolatable(g.id)) continue
    if (!pointInPolygon(x, y, g.hull)) continue
    if (g.id === current) return g.id
    if (g.area < bestArea) {
      bestArea = g.area
      best = g.id
    }
  }
  return best
}

/** Delay before an AREA hover shows its hull - a pointer crossing on its way elsewhere shows nothing. */
export const SPOT_SHOW_DELAY_MS = 80
/** Grace before a shown hull goes when the pointer leaves it - a gap between two nodes is not an exit. */
export const SPOT_HIDE_DELAY_MS = 150
/** The fade in and out of the hull and the dimming. */
export const SPOT_FADE_MS = 120

/**
 * The shown spotlight as a small state machine, so the timing is testable without a canvas:
 * `want` is fed what the pointer resolved (a community, and whether it came from a node or
 * from the area), `alpha` says how visible the shown one is at a given time.
 */
export interface SpotState {
  /** The community being shown (or fading out), -1 for none. */
  cid: number
  /** When the current fade started, and in which direction. */
  fadeFrom: number
  fadeIn: boolean
  /** A pending change: what, and when it takes effect. */
  pending: { cid: number; at: number } | null
}

export const SPOT_IDLE: SpotState = { cid: -1, fadeFrom: 0, fadeIn: false, pending: null }

/**
 * The next state for what the pointer resolved to now. A node hover shows at once (the
 * pointer is ON something); an area hover waits SPOT_SHOW_DELAY_MS; losing the target waits
 * SPOT_HIDE_DELAY_MS; switching straight from one community to another is immediate.
 */
export function wantSpot(s: SpotState, cid: number, fromNode: boolean, now: number): SpotState {
  const shown = s.cid >= 0 && s.fadeIn ? s.cid : -1
  if (cid === shown) return s.pending === null ? s : { ...s, pending: null }
  if (cid >= 0) {
    if (shown >= 0 || fromNode) return { cid, fadeFrom: shown >= 0 ? now - SPOT_FADE_MS : now, fadeIn: true, pending: null }
    if (s.pending !== null && s.pending.cid === cid) return s
    return { ...s, pending: { cid, at: now + SPOT_SHOW_DELAY_MS } }
  }
  if (s.pending !== null && s.pending.cid === -1) return s
  return { ...s, pending: { cid: -1, at: now + SPOT_HIDE_DELAY_MS } }
}

/** Applies a pending change whose time has come. */
export function tickSpot(s: SpotState, now: number): SpotState {
  if (s.pending === null || now < s.pending.at) return s
  if (s.pending.cid >= 0) return { cid: s.pending.cid, fadeFrom: now, fadeIn: true, pending: null }
  if (s.cid < 0 || !s.fadeIn) return { ...s, pending: null }
  return { cid: s.cid, fadeFrom: now, fadeIn: false, pending: null }
}

/** How visible the shown community is, 0..1. */
export function spotAlpha(s: SpotState, now: number): number {
  if (s.cid < 0) return 0
  const t = Math.min(1, Math.max(0, (now - s.fadeFrom) / SPOT_FADE_MS))
  return s.fadeIn ? t : 1 - t
}

/** True while something is still moving (a fade, or a pending change) - keep drawing. */
export function spotBusy(s: SpotState, now: number): boolean {
  return s.pending !== null || (s.cid >= 0 && now - s.fadeFrom < SPOT_FADE_MS)
}

/** A disc in world units: a member node the spotlight label must not sit under. */
export interface Disc {
  x: number
  y: number
  r: number
}

/**
 * Where the spotlight's label goes, world units: centred over the community, its bottom a
 * `gap` above whichever is higher - the drawn outline or the top of a member node. The general
 * region-label placer anchors against the outline alone, and a node sitting ON the outline
 * (the topmost member usually does) was drawn over its own community's name. Below the
 * community instead when above would leave the visible frame.
 */
export function placeSpotLabel(
  hull: readonly Pt[],
  discs: readonly Disc[],
  boxW: number,
  boxH: number,
  gap: number,
  view: readonly [number, number, number, number],
): [number, number, number, number] | null {
  if (hull.length < 3) return null
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const [x, y] of hull) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  let top = y0
  let bottom = y1
  for (const d of discs) {
    top = Math.min(top, d.y - d.r)
    bottom = Math.max(bottom, d.y + d.r)
  }
  const cx = Math.min(Math.max((x0 + x1) / 2, view[0] + boxW / 2), view[2] - boxW / 2)
  let by = top - gap - boxH
  if (by < view[1]) by = bottom + gap
  return [cx - boxW / 2, by, cx + boxW / 2, by + boxH]
}
