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
