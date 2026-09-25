import { describe, expect, it } from 'vitest'
import { placeAround, spreadPoints, wrapTitle, type Box } from '../src/lib/landmarkLayout.ts'

/** Monospace stand-in for measureText: 6 units per character. */
const measure = (s: string): number => s.length * 6

describe('wrapTitle', () => {
  it('keeps a title that fits on one line', () => {
    expect(wrapTitle('Short Title', 100, 4, measure)).toEqual(['Short Title'])
  })

  it('wraps at spaces and hyphens and keeps every word', () => {
    const lines = wrapTitle('Well-Known Topic and Its Close Relative', 100, 4, measure)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((l) => measure(l) <= 100)).toBe(true)
    expect(lines.join(' ').replace(/- /g, '-')).toBe('Well-Known Topic and Its Close Relative')
  })

  it('ends a title that does not fit in the lines it has with an ellipsis', () => {
    const lines = wrapTitle('one two three four five six seven eight nine ten', 30, 2, measure)
    expect(lines).toHaveLength(2)
    expect(lines[1]!.endsWith('…')).toBe(true)
    expect(measure(lines[1]!)).toBeLessThanOrEqual(30)
  })
})

describe('placeAround', () => {
  it('puts the caption below the dot when that is free', () => {
    const box = placeAround(0, 0, 5, 40, 10, 3, [], [])
    expect(box[1]).toBe(8)
  })

  it('moves to another side when below is taken, and never leaves the view when it can help it', () => {
    const taken: Box[] = [[-30, 5, 30, 25]]
    const box = placeAround(0, 0, 5, 40, 10, 3, taken, [])
    expect(box[3]).toBeLessThanOrEqual(0)
    const inView = placeAround(0, 0, 5, 40, 10, 3, [], [], [-100, -100, 100, 5])
    expect(inView[3]).toBeLessThanOrEqual(5)
  })
})

describe('spreadPoints', () => {
  it('pulls a clump apart until no two captions overlap, and keeps the rows in order', () => {
    // Twelve dots in a 4 x 3 clump, six world units wide and four high.
    const pts = Array.from({ length: 12 }, (_, i) => ({ i, x: (i % 4) * 2, y: Math.floor(i / 4) * 2, r: 0.05 }))
    const vp = { w: 1000, h: 800 }
    const m = { x: 16, top: 18, bottom: 24 }
    const out = spreadPoints(pts, () => ({ w: 120, h: 26 }), vp, m)
    // Back to the pixels the spread was laid out in: the zoom is the clump's extent fitted in.
    const W = vp.w - 2 * m.x
    const H = vp.h - m.top - m.bottom
    const k0 = Math.min(W / 6, H / 4)
    const px = pts.map((p) => {
      const [x, y] = out.get(p.i)!
      return [(x - 3) * k0 + W / 2, (y - 2) * k0 + H / 2] as const
    })
    const box = ([x, y]: readonly [number, number]): Box => [x - 60, y - 8, x + 60, y + 8 + 3 + 26]
    let overlaps = 0
    for (let a = 0; a < px.length; a++)
      for (let b = a + 1; b < px.length; b++) {
        const A = box(px[a]!)
        const B = box(px[b]!)
        if (Math.min(A[2], B[2]) - Math.max(A[0], B[0]) > 1 && Math.min(A[3], B[3]) - Math.max(A[1], B[1]) > 1) overlaps++
      }
    expect(overlaps).toBe(0)
    // Everything inside the drawing area.
    for (const [x, y] of px) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(W)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(H)
    }
    // The top row stays above the bottom row, on average.
    const rowY = (r: number): number => px.slice(r * 4, r * 4 + 4).reduce((s, p) => s + p[1], 0) / 4
    expect(rowY(0)).toBeLessThan(rowY(2))
  })
})

describe('spreadPoints with a pinned point', () => {
  it('holds the pinned point in the middle and spreads the rest around it', () => {
    // An open neighbourhood: its landmark (0) at one side of a clump, twelve neighbours.
    const pts = [{ i: 0, x: -5, y: 0, r: 0.05 }, ...Array.from({ length: 12 }, (_, k) => ({ i: k + 1, x: (k % 4) * 2, y: Math.floor(k / 4) * 2, r: 0.05 }))]
    const vp = { w: 1000, h: 800 }
    const m = { x: 16, top: 18, bottom: 24 }
    const out = spreadPoints(pts, () => ({ w: 120, h: 26 }), vp, m, 0)
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2
    // The pin lands on the centre of the area the spread was laid out in.
    expect(out.get(0)![0]).toBeCloseTo(cx, 6)
    expect(out.get(0)![1]).toBeCloseTo(cy, 6)
    // And nothing else sits on it.
    for (const p of pts.slice(1)) {
      const [x, y] = out.get(p.i)!
      expect(Math.hypot(x - cx, y - cy)).toBeGreaterThan(0.01)
    }
  })
})

describe('spreadPoints with a box to keep out of', () => {
  it('leaves the corner box empty and still keeps the captions apart', () => {
    const pts = Array.from({ length: 16 }, (_, i) => ({ i, x: (i % 4) * 2, y: Math.floor(i / 4) * 2, r: 0.05 }))
    const vp = { w: 1000, h: 800 }
    const m = { x: 16, top: 18, bottom: 24 }
    const W = vp.w - 2 * m.x
    const H = vp.h - m.top - m.bottom
    // A legend in the bottom right corner of the area, 200 x 160.
    const corner: Box = [W - 200, H - 160, W + 4, H + 4]
    const out = spreadPoints(pts, () => ({ w: 120, h: 26 }), vp, m, null, Infinity, 0.8, [corner])
    const k0 = Math.min(W / 6, H / 6)
    for (const p of pts) {
      const [x, y] = out.get(p.i)!
      const sx = (x - 3) * k0 + W / 2
      const sy = (y - 3) * k0 + H / 2
      const r: Box = [sx - 66, sy - 9, sx + 66, sy + 3 + 26 + 6]
      const inside = Math.min(r[2], corner[2]) - Math.max(r[0], corner[0]) > 1 && Math.min(r[3], corner[3]) - Math.max(r[1], corner[1]) > 1
      expect(inside).toBe(false)
    }
  })
})
