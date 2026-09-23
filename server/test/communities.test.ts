/**
 * The server's Louvain (docs/tasks/TASKS-DOMAIN-SPLIT.md 1.1): parity with the web copy, and
 * the resolution parameter the port adds.
 *
 * PARITY is asserted against a hard-coded label array rather than by importing the web copy:
 * the generator and its seed are duplicated in `web/test/communities-parity.test.ts`, which
 * asserts the SAME array, so either copy drifting fails its own suite.
 */
import { describe, it, expect } from 'vitest'
import { louvainCommunities } from '../src/pipeline/communities.js'

/** mulberry32, duplicated in the web parity test on purpose. */
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

/** Planted partition: blocks of the given sizes, one link probability inside, one between. */
function planted(sizes: number[], pIn: number, pOut: number, seed: number): { n: number; edges: Array<[number, number]> } {
  const r = rng(seed)
  const block: number[] = []
  sizes.forEach((s, b) => {
    for (let i = 0; i < s; i++) block.push(b)
  })
  const edges: Array<[number, number]> = []
  for (let i = 0; i < block.length; i++)
    for (let j = i + 1; j < block.length; j++) if (r() < (block[i] === block[j] ? pIn : pOut)) edges.push([i, j])
  return { n: block.length, edges }
}

/** The labels both copies must produce for `planted([12, 10, 8, 6], 0.5, 0.04, 7)` at γ = 1. */
const PARITY_LABELS = [0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 3, 2, 2, 3]

const clusterCount = (labels: number[]): number => new Set(labels).size

describe('louvainCommunities (server copy)', () => {
  const g = planted([12, 10, 8, 6], 0.5, 0.04, 7)

  it('produces the parity labels the web copy produces', () => {
    expect(g.edges.length).toBe(85)
    expect(louvainCommunities(g.n, g.edges)).toEqual(PARITY_LABELS)
  })

  it('treats gamma = 1 as the web behaviour', () => {
    expect(louvainCommunities(g.n, g.edges, () => 1, 1)).toEqual(louvainCommunities(g.n, g.edges))
  })

  it('never yields more clusters at a lower gamma on the fixture', () => {
    const big = planted([30, 25, 20, 15, 10], 0.3, 0.02, 11)
    let prev = Infinity
    for (const gamma of [1.5, 1, 0.8, 0.6, 0.4, 0.2]) {
      const k = clusterCount(louvainCommunities(big.n, big.edges, () => 1, gamma))
      expect(k).toBeLessThanOrEqual(prev)
      prev = k
    }
  })

  it('returns every node alone on a graph without links', () => {
    expect(louvainCommunities(3, [], () => 1, 0.4)).toEqual([0, 1, 2])
  })
})
