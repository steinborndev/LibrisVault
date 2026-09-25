/**
 * Parity of the web's Louvain with the server copy (docs/tasks/TASKS-DOMAIN-SPLIT.md 1.1).
 *
 * The generator, its seed and the expected labels are duplicated in
 * `server/test/communities.test.ts` on purpose: each suite asserts the same hard-coded array,
 * so a change to either copy fails its own suite rather than only the other one's.
 */
import { describe, it, expect } from 'vitest'
import { louvainCommunities } from '../src/lib/communities.ts'

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

const PARITY_LABELS = [0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 3, 2, 2, 3]

describe('louvainCommunities parity with the server copy', () => {
  it('produces the labels the server copy produces', () => {
    const g = planted([12, 10, 8, 6], 0.5, 0.04, 7)
    expect(g.edges.length).toBe(85)
    expect(louvainCommunities(g.n, g.edges)).toEqual(PARITY_LABELS)
  })
})
