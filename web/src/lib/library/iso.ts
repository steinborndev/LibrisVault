/**
 * The isometric projection and the small drawing helpers the Library shares with the design
 * generator (docs/agents/design/library-screen/gen.mjs): one grid, tiles twice as wide as
 * high, depth by i + j for the painter's order. Pure, so the tests pin the numbers.
 */

export type Pt = readonly [number, number]

export interface Proj {
  (i: number, j: number, z?: number): Pt
  readonly TW: number
  readonly TH: number
}

/** A projection with the tile width `TW` and the origin `(ox, oy)` of grid point (0, 0). */
export function makeProj(ox: number, oy: number, TW: number): Proj {
  const TH = TW / 2
  const P = ((i: number, j: number, z = 0): Pt => [ox + ((i - j) * TW) / 2, oy + ((i + j) * TH) / 2 - z]) as Proj & { TW: number; TH: number }
  P.TW = TW
  P.TH = TH
  return P
}

export const pts = (arr: readonly Pt[]): string => arr.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')

/** Where an object stands in the painter's order: further back paints first. */
export const depthOf = (i: number, j: number): number => i + j

export interface BoxColors {
  readonly top: string
  readonly left: string
  readonly right: string
}

/** The three visible faces of a box standing on (i0, j0) with footprint a by b and height h, from z0 up. */
export function boxFaces(P: Proj, i0: number, j0: number, a: number, b: number, h: number, z0 = 0): { top: Pt[]; left: Pt[]; right: Pt[] } {
  const Q = (i: number, j: number, z = 0): Pt => P(i, j, z + z0)
  return {
    top: [Q(i0, j0, h), Q(i0 + a, j0, h), Q(i0 + a, j0 + b, h), Q(i0, j0 + b, h)],
    left: [Q(i0, j0 + b, 0), Q(i0 + a, j0 + b, 0), Q(i0 + a, j0 + b, h), Q(i0, j0 + b, h)],
    right: [Q(i0 + a, j0, 0), Q(i0 + a, j0 + b, 0), Q(i0 + a, j0 + b, h), Q(i0 + a, j0, h)],
  }
}

/** The tile width and origin that fit one room of NI by NJ tiles plus its wall height into W by H. */
export function fitRoom(NI: number, NJ: number, W: number, H: number, wallH: number, pad = 20, max = 64, min = 12): { TW: number; ox: number; oy: number } {
  const bbox = (TW: number): { minX: number; maxX: number; minY: number; maxY: number } => {
    const TH = TW / 2
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    const corners: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [NI, 0],
      [NI, NJ],
      [0, NJ],
    ]
    for (const [i, j] of corners) {
      const x = ((i - j) * TW) / 2
      const y = ((i + j) * TH) / 2
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y - wallH)
      maxY = Math.max(maxY, y)
    }
    return { minX, maxX, minY, maxY }
  }
  for (let TW = max; TW >= min; TW -= 2) {
    const b = bbox(TW)
    if (b.maxX - b.minX <= W - 2 * pad && b.maxY - b.minY <= H - 2 * pad) {
      return { TW, ox: Math.round((W - (b.maxX - b.minX)) / 2 - b.minX), oy: Math.round((H - (b.maxY - b.minY)) / 2 - b.minY) }
    }
  }
  const b = bbox(min)
  return { TW: min, ox: Math.round((W - (b.maxX - b.minX)) / 2 - b.minX), oy: Math.round((H - (b.maxY - b.minY)) / 2 - b.minY) }
}

export const hsl = (h: number, s: number, l: number): string => `hsl(${Math.round(h)} ${s}% ${l}%)`

/** Mixes two `#rrggbb` colors; `t` = 1 is all `b`. */
export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const ch = (shift: number): number => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t)
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`
}

/** A small deterministic generator, so a shelf's books look the same on every render. */
export function seeded(seed: number): () => number {
  let s = (seed >>> 0) || 7
  return (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}
