/**
 * The split proposal on screen (docs/tasks/TASKS-DOMAIN-SPLIT.md 3.1): the chip mask, the
 * selection arithmetic, and the rule that says when a domain is offered its shelves. Every expected number is
 * a hand count over the fixture below.
 */
import { describe, it, expect } from 'vitest'
import {
  largestDepartment,
  shelfChips,
  shelfPaths,
  shelfState,
  splitOutcome,
  SPLIT_MIN_PAGES,
} from '../src/lib/splitShelves.ts'
import { NO_DOMAIN } from '../src/lib/landmarks.ts'
import type { GraphNode, SplitProposal, SplitShelf } from '../src/api/types.ts'

const member = (p: string): { path: string; address: string } => ({ path: p, address: `c-${p}` })

const shelf = (id: number, pages: string[], tags: string[] = []): SplitShelf => ({
  id,
  rank: id + 1,
  size: pages.length,
  types: { concepts: pages.length },
  entities: 0,
  conductance: 0.1,
  stability: 1,
  precision: 1,
  recall: 1,
  separability: 0.9,
  misfile: false,
  confusedWith: [],
  landmarks: [],
  tags,
  topTagCollision: null,
  outsideNeighbours: { count: 0, pages: [] },
  fingerprint: `f${id}`,
  pages: pages.map(member),
})

/**
 * Three shelves of 30, 20 and 10 pages and a rest of 5, in a domain of 65 in a vault of 200
 * knowledge pages whose next largest domain holds 25. Links, directed, rows from and columns to
 * in id order then the rest:
 *
 *        s0  s1  s2  rest
 *   s0   40   3   1    2
 *   s1    2  30   4    0
 *   s2    0   1  10    1
 *   rest  1   0   0    2      sum 97
 */
const range = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `wiki/${prefix}${i}.md`)
const proposal: SplitProposal = {
  domain: 'alpha',
  pages: 65,
  eligible: true,
  reason: null,
  shelves: [shelf(0, range('a', 30), ['t-a', 't-b', 't-c']), shelf(1, range('b', 20), ['t-d']), shelf(2, range('c', 10))],
  rest: { size: 5, types: { concepts: 5 }, entities: 0, pages: range('r', 5).map(member) },
  links: [
    [40, 3, 1, 2],
    [2, 30, 4, 0],
    [0, 1, 10, 1],
    [1, 0, 0, 2],
  ],
  totals: {
    inShelves: 60,
    withParent: 5,
    internalLinks: 97,
    untagged: 0,
    knowledgePages: 200,
    largestNow: { domain: 'alpha', pages: 65, share: 65 / 200 },
    largestAfter: { domain: 'shelf:0', pages: 30, share: 30 / 200 },
    largestOther: { domain: 'beta', pages: 25, share: 25 / 200 },
  },
  unaddressed: [],
  params: { runs: 40, gamma: 0.4, agree: 0.9, seed: 1, shelfMinPages: 25 },
  decisions: [],
}

const node = (path: string, domain: string | null, over: Partial<GraphNode> = {}): GraphNode => ({
  path,
  title: path,
  type: 'concepts',
  tags: [],
  domain,
  kind: 'knowledge',
  out: 0,
  in: 0,
  ...over,
})

describe('shelfPaths and shelfChips', () => {
  it('narrows to exactly one shelf, the rest, or nothing for an unknown id', () => {
    expect(shelfPaths(proposal, 1)).toEqual(new Set(range('b', 20)))
    expect(shelfPaths(proposal, 'rest')).toEqual(new Set(range('r', 5)))
    expect(shelfPaths(proposal, 9).size).toBe(0)
  })

  it('lists one chip per shelf in rank order and one for the rest, with the route\'s counts', () => {
    expect(shelfChips(proposal).map((c) => [c.key, c.size])).toEqual([
      [0, 30],
      [1, 20],
      [2, 10],
      ['rest', 5],
    ])
  })
})

describe('splitOutcome', () => {
  it('promotes nothing: nothing moves and no link turns cross-domain', () => {
    expect(splitOutcome(proposal, [])).toEqual({
      moved: 0,
      parentKeeps: 65,
      largestAfter: { domain: 'alpha', pages: 65, share: 65 / 200 },
      crossLinks: 0,
    })
  })

  it('promotes every shelf on its own', () => {
    // Off-diagonal: 3+1+2 + 2+4+0 + 0+1+1 + 1+0+0 = 15.
    expect(splitOutcome(proposal, [[0], [1], [2]])).toEqual({
      moved: 60,
      parentKeeps: 5,
      largestAfter: { domain: 'shelf:0', pages: 30, share: 30 / 200 },
      crossLinks: 15,
    })
  })

  it('promotes one shelf: the parent keeps the others', () => {
    // s1 against everything else: row s1 off-diagonal 2+4+0, column s1 off-diagonal 3+1+0.
    expect(splitOutcome(proposal, [[1]])).toEqual({
      moved: 20,
      parentKeeps: 45,
      largestAfter: { domain: 'alpha', pages: 45, share: 45 / 200 },
      crossLinks: 10,
    })
  })

  it('merges two shelves into one domain: the links between them stay inside it', () => {
    // {s0, s1} against {s2, rest}: 1+2 + 4+0 from the group, 0+1 + 1+0 into it.
    expect(splitOutcome(proposal, [[0, 1]])).toEqual({
      moved: 50,
      parentKeeps: 15,
      largestAfter: { domain: 'shelf:0+1', pages: 50, share: 50 / 200 },
      crossLinks: 9,
    })
  })

  it('lets another domain be the largest afterwards, and ignores unknown and repeated ids', () => {
    const out = splitOutcome(proposal, [[2, 7], [2], [9]])
    expect(out.moved).toBe(10)
    expect(splitOutcome(proposal, [[0], [1], [2]]).largestAfter.domain).toBe('shelf:0')
    const small = { ...proposal, totals: { ...proposal.totals, largestOther: { domain: 'beta', pages: 40, share: 0.2 } } }
    expect(splitOutcome(small, [[0], [1], [2]]).largestAfter).toEqual({ domain: 'beta', pages: 40, share: 0.2 })
  })
})

describe('shelfState, the overlay\'s enabling rule', () => {
  const nodes = [
    ...Array.from({ length: SPLIT_MIN_PAGES }, (_, i) => node(`wiki/a${i}.md`, 'alpha')),
    ...Array.from({ length: 49 }, (_, i) => node(`wiki/b${i}.md`, 'beta')),
    ...Array.from({ length: 10 }, (_, i) => node(`wiki/s${i}.md`, 'beta', { kind: 'structural' })),
    ...Array.from({ length: 60 }, (_, i) => node(`wiki/u${i}.md`, 'unassigned')),
  ]

  it('has the same cases as the Landmarks switch, with the split\'s own bar', () => {
    expect(shelfState(nodes, new Set(['alpha']), null)).toEqual({ available: true, domain: 'alpha', pages: 50 })
    expect(shelfState(nodes, new Set(), null)).toMatchObject({ available: false, reason: 'Select a domain first' })
    expect(shelfState(nodes, new Set(['alpha', 'beta']), null)).toMatchObject({ reason: 'Select a domain first' })
    expect(shelfState(nodes, new Set([NO_DOMAIN]), null)).toMatchObject({ reason: 'Not a domain' })
    expect(shelfState(nodes, new Set(['unassigned']), null)).toMatchObject({ reason: 'Not a domain' })
    // The count is the domain's own knowledge pages: system pages do not lift it over the bar.
    expect(shelfState(nodes, new Set(['beta']), null)).toMatchObject({ reason: 'Only 49 pages here' })
  })

  it('reads a room holding one domain as one domain on show', () => {
    expect(shelfState(nodes, new Set(), new Set(['alpha']))).toMatchObject({ available: true, domain: 'alpha' })
    expect(shelfState(nodes, new Set(), new Set(['alpha', 'beta']))).toMatchObject({ available: false })
  })

  it('keeps the line to one line, and the sentence behind it', () => {
    for (const picked of [new Set<string>(), new Set([NO_DOMAIN]), new Set(['beta'])]) {
      const state = shelfState(nodes, picked, null)
      if (state.available) throw new Error('expected an unavailable state')
      expect(state.reason.length).toBeLessThanOrEqual(24)
      expect(state.why.length).toBeGreaterThan(state.reason.length)
    }
  })
})

describe('largestDepartment', () => {
  it('names the largest department domain and its share of every knowledge page', () => {
    const nodes = [
      ...Array.from({ length: 3 }, (_, i) => node(`wiki/a${i}.md`, 'alpha')),
      ...Array.from({ length: 5 }, (_, i) => node(`wiki/u${i}.md`, 'unassigned')),
      node('wiki/m.md', 'meta'),
      node('wiki/s.md', 'alpha', { kind: 'artifact' }),
      node('wiki/n.md', null),
    ]
    expect(largestDepartment(nodes)).toEqual({ domain: 'alpha', pages: 3, share: 3 / 10 })
    expect(largestDepartment([])).toBeNull()
  })
})
