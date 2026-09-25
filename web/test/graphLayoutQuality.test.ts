import { describe, it, expect } from 'vitest'
import { centroidDrift, layoutQuality } from '../src/lib/graphLayoutQuality.ts'

/** Two groups of four pages on small squares, at a given distance apart. */
function twoSquares(offset: number): Float32Array {
  const pts = [
    [0, 0], [10, 0], [0, 10], [10, 10],
    [offset, 0], [offset + 10, 0], [offset, 10], [offset + 10, 10],
  ]
  return new Float32Array(pts.flat())
}
const groups = new Int32Array([0, 0, 0, 0, 1, 1, 1, 1])
const edges: Array<[number, number]> = [[0, 1], [4, 5], [3, 4]]

describe('layoutQuality', () => {
  it('sees two domains apart: nothing misplaced, no overlap, long bridges', () => {
    const q = layoutQuality(twoSquares(200), groups, [10, 10], edges)
    expect(q.domains).toBe(2)
    expect(q.misplacedShare).toBe(0)
    expect(q.overlapPairs).toBe(0)
    expect(q.bridgeRatio).toBeGreaterThan(10)
    expect(q.spreadMedian).toBeCloseTo(Math.hypot(5, 5) / 10, 5)
  })

  it('sees two domains drawn into each other: pages misplaced, one overlap', () => {
    // The second square sits on the first, shifted half a cell: its pages stand amid group 0.
    const q = layoutQuality(twoSquares(5), groups, [10, 10], edges)
    expect(q.overlapPairs).toBe(1)
    expect(q.misplacedShare).toBeGreaterThan(0)
  })

  it('ignores pages without a domain', () => {
    const q = layoutQuality(twoSquares(200), new Int32Array([0, 0, 0, 0, -1, -1, -1, -1]), [10], edges)
    expect(q.domains).toBe(1)
    expect(q.bridgeRatio).toBeNull()
  })
})

describe('fragments', () => {
  it('scores a compact domain 0 and one split into two far clumps by the smaller clump', () => {
    // Group 0: four pages together. Group 1: two pages here, two 500 px away.
    const pos = new Float32Array([0, 0, 10, 0, 0, 10, 10, 10, 200, 0, 210, 0, 700, 0, 710, 0])
    const q = layoutQuality(pos, groups, [10, 10], edges)
    expect(q.perDomain.map((d) => d.fragments)).toEqual([0, 0.5])
    expect(q.fragmentShare).toBeCloseTo(0.25, 5)
    expect(q.fragmentWorst).toBe(1)
  })
})

describe('centroidDrift', () => {
  it('measures how far each shared domain moved, and names the farthest', () => {
    const before = new Map([['a', { x: 0, y: 0 }], ['b', { x: 0, y: 0 }], ['gone', { x: 9, y: 9 }]])
    const after = new Map([['a', { x: 3, y: 4 }], ['b', { x: 0, y: 1 }], ['new', { x: 1, y: 1 }]])
    expect(centroidDrift(before, after)).toEqual({ median: 3, max: 5, maxKey: 'a', compared: 2 })
  })
})
