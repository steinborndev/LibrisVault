import { describe, it, expect } from 'vitest'
import {
  landmarkCount,
  landmarkSet,
  heldLandmarkSet,
  landmarkState,
  soleDomain,
  chapterSize,
  NO_DOMAIN,
  LANDMARK_MIN_PAGES,
} from '../src/lib/landmarks.ts'
import type { GraphNode } from '../src/api/types.ts'

/**
 * The fixtures are built by NAME rather than by index, so the shape a test asserts is the shape
 * it reads. `in` is the whole vault's backlink count (the rank's second term) and defaults to
 * what the links below add up to; the domain-internal count is never given, it is always what
 * the links produce.
 */
interface Spec {
  name: string
  domain: string | null
  kind?: GraphNode['kind']
  /** Backlinks over the whole vault, where a test needs to set the rank's second term. */
  vaultIn?: number
}

const pathOf = (name: string): string => `wiki/${name}.md`

function fixture(pages: Spec[], links: Array<[string, string]>): { nodes: GraphNode[]; edges: Array<[number, number]> } {
  const at = new Map(pages.map((p, i) => [p.name, i]))
  const edges = links.map(([a, b]): [number, number] => [at.get(a)!, at.get(b)!])
  const inCount = new Map<string, number>()
  const outCount = new Map<string, number>()
  for (const [a, b] of links) {
    inCount.set(b, (inCount.get(b) ?? 0) + 1)
    outCount.set(a, (outCount.get(a) ?? 0) + 1)
  }
  const nodes = pages.map(
    (p): GraphNode => ({
      path: pathOf(p.name),
      title: p.name,
      type: 'concepts',
      tags: [],
      domain: p.domain,
      kind: p.kind ?? 'knowledge',
      in: p.vaultIn ?? inCount.get(p.name) ?? 0,
      out: outCount.get(p.name) ?? 0,
    }),
  )
  return { nodes, edges }
}

const names = (paths: readonly string[]): string[] => paths.map((p) => p.replace(/^wiki\/|\.md$/g, ''))

/**
 * ALPHA. Eight landmarks in three chapters, and the rank order is deliberately not the reading
 * order: `b1` is the second-strongest page in the domain and the sixth entry in the list,
 * because nothing links it to what stands above it.
 *
 *   chapter 1  a1 → a2 → a3 → a4 → a5 → a1   (a ring, so each carries one internal backlink)
 *   chapter 2  b1 ⇄ b2
 *   chapter 3  c1, linked to no landmark at all
 *
 * The fillers: `v` votes for chapter 1, `w` for chapter 2, `u1`/`u2` for c1 - each inside ONE
 * chapter, so none of them is a connector. `p2` touches two chapters and `p3` all three, and
 * `q` gives `p2` the one internal backlink that puts it AHEAD of `p3` in the tie-break - so a
 * run that picked the strongest candidate rather than the one joining the most chapters would
 * pick `p2` and leave the third chapter adrift.
 *
 * `x` is the machine-learning finding as a fixture: a page with 500 backlinks over the vault and
 * none inside the domain. Authority is counted inside, so it is not a landmark.
 *
 * Domain-internal backlinks, as the links below produce them:
 *   a1 4 · b1 4 · c1 3 · a2 2 · a3 2 · a4 2 · a5 2 · b2 2 · p2 1 · everything else 0
 */
/** The ALPHA fixture's inputs, named once: the determinism test re-reads them in reverse. */
const alphaPages: Spec[] = [
  { name: 'a1', domain: 'alpha', vaultIn: 90 },
  { name: 'a2', domain: 'alpha', vaultIn: 80 },
  { name: 'a3', domain: 'alpha', vaultIn: 70 },
  { name: 'a4', domain: 'alpha', vaultIn: 60 },
  { name: 'a5', domain: 'alpha', vaultIn: 50 },
  { name: 'b1', domain: 'alpha', vaultIn: 40 },
  { name: 'b2', domain: 'alpha', vaultIn: 30 },
  { name: 'c1', domain: 'alpha', vaultIn: 20 },
  { name: 'v', domain: 'alpha' },
  { name: 'w', domain: 'alpha' },
  { name: 'u1', domain: 'alpha' },
  { name: 'u2', domain: 'alpha' },
  { name: 'p2', domain: 'alpha' },
  { name: 'p3', domain: 'alpha' },
  { name: 'q', domain: 'alpha' },
  { name: 'x', domain: 'alpha', vaultIn: 500 },
  { name: 'beta1', domain: 'beta' },
  { name: 'hub', domain: 'alpha', kind: 'structural' },
]
const alphaLinks: Array<[string, string]> = [
  ['a1', 'a2'], ['a2', 'a3'], ['a3', 'a4'], ['a4', 'a5'], ['a5', 'a1'],
  ['b1', 'b2'], ['b2', 'b1'],
  ['v', 'a1'], ['v', 'a2'], ['v', 'a3'], ['v', 'a4'], ['v', 'a5'],
  ['w', 'b1'], ['w', 'b2'],
  ['u1', 'c1'], ['u2', 'c1'],
  ['p2', 'a1'], ['p2', 'b1'],
  ['p3', 'a1'], ['p3', 'b1'], ['p3', 'c1'],
  ['q', 'p2'],
  ['beta1', 'a5'], ['beta1', 'b2'], ['hub', 'a5'], ['hub', 'b2'], ['hub', 'c1'],
]

const alpha = fixture(alphaPages, alphaLinks)

describe('how many landmarks a domain gets', () => {
  it('is 12 % of its knowledge pages, between 8 and 40', () => {
    expect(landmarkCount(535)).toBe(40) // the largest domain, at the ceiling
    expect(landmarkCount(152)).toBe(18)
    expect(landmarkCount(150)).toBe(18)
    expect(landmarkCount(82)).toBe(10)
    expect(landmarkCount(78)).toBe(9)
    expect(landmarkCount(68)).toBe(8) // 8.16 rounds to 8 on its own
    expect(landmarkCount(40)).toBe(8) // 4.8 would be, so the floor holds it
    expect(landmarkCount(LANDMARK_MIN_PAGES)).toBe(8)
  })
})

describe('whether the mode is available', () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ name: `big${i}`, domain: 'alpha' }))
  const small = Array.from({ length: 19 }, (_, i) => ({ name: `small${i}`, domain: 'beta' }))
  const { nodes } = fixture([...big, ...small, { name: 'nodom', domain: null }], [])

  it('takes one picked domain and a room holding one, and nothing else', () => {
    expect(soleDomain(new Set(['alpha']), null)).toBe('alpha')
    expect(soleDomain(new Set(['alpha', 'beta']), null)).toBeNull()
    expect(soleDomain(new Set(), new Set(['alpha']))).toBe('alpha')
    expect(soleDomain(new Set(), new Set(['alpha', 'beta']))).toBeNull()
    expect(soleDomain(new Set(), null)).toBeNull()
    // A pick inside a room is still one domain on show - the pick is the narrower of the two.
    expect(soleDomain(new Set(['alpha']), new Set(['alpha', 'beta']))).toBe('alpha')
  })

  it('says why it is not available, in the words the switch shows', () => {
    expect(landmarkState(nodes, new Set(['alpha']), null)).toEqual({ available: true, domain: 'alpha', pages: 30 })
    expect(landmarkState(nodes, new Set(), null)).toMatchObject({ available: false, reason: 'Select a domain first' })
    expect(landmarkState(nodes, new Set(['alpha', 'beta']), null)).toMatchObject({ reason: 'Select a domain first' })
    expect(landmarkState(nodes, new Set([NO_DOMAIN]), null)).toMatchObject({ reason: 'Not a domain' })
    // The count is the domain's own, so the line can be checked against the panel.
    expect(landmarkState(nodes, new Set(['beta']), null)).toMatchObject({ reason: 'Only 19 pages here' })
  })

  it('keeps the switch’s line to one line, and the sentence behind it', () => {
    // The row sits beside three siblings whose lines are four words; a row that wrapped to three
    // to explain itself would be the loudest thing in a block of switches that are all off.
    for (const picked of [new Set<string>(), new Set([NO_DOMAIN]), new Set(['beta'])]) {
      const state = landmarkState(nodes, picked, null)
      if (state.available) throw new Error('expected an unavailable state')
      expect(state.reason.length).toBeLessThanOrEqual(24)
      expect(state.why.length).toBeGreaterThan(state.reason.length)
    }
  })

  it('counts the domain rather than the drawing: system pages do not lift it over the bar', () => {
    const { nodes: n2 } = fixture(
      [
        ...Array.from({ length: 20 }, (_, i) => ({ name: `k${i}`, domain: 'alpha' })),
        ...Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, domain: 'alpha', kind: 'structural' as const })),
      ],
      [],
    )
    expect(landmarkState(n2, new Set(['alpha']), null)).toMatchObject({
      available: false,
      reason: 'Only 20 pages here',
    })
  })
})

describe('the set, the order and the chapters', () => {
  const set = landmarkSet(alpha.nodes, alpha.edges, 'alpha')

  it('ranks by backlinks from inside the domain, not over the vault', () => {
    // `x` carries 500 vault backlinks and none inside; `p2` is the strongest non-landmark.
    expect(names(set.order)).not.toContain('x')
    expect(names(set.order)).not.toContain('p2')
    expect(set.inDomain.get(pathOf('x'))).toBe(0)
    expect(set.inDomain.get(pathOf('a1'))).toBe(4)
    expect(set.inDomain.get(pathOf('b1'))).toBe(4)
  })

  it('leaves out what is not a knowledge page of this domain', () => {
    expect(set.inDomain.has(pathOf('hub'))).toBe(false)
    expect(set.inDomain.has(pathOf('beta1'))).toBe(false)
    // Three links from the hub and two from the foreign page land on a5, b2 and c1 and are
    // counted for none of them.
    expect(set.inDomain.get(pathOf('a5'))).toBe(2)
    expect(set.inDomain.get(pathOf('b2'))).toBe(2)
    expect(set.inDomain.get(pathOf('c1'))).toBe(3)
  })

  it('follows the walk rather than the rank', () => {
    // The rank alone would read a1, b1, c1, a2, … - b1 is the second-strongest page here.
    expect(names(set.order)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'c1'])
  })

  it('breaks a chapter where nothing links any more, and the chapters are the components', () => {
    expect(set.chapters).toEqual([0, 5, 7])
    expect(chapterSize(set, 0)).toBe(5)
    expect(chapterSize(set, 1)).toBe(2)
    expect(chapterSize(set, 2)).toBe(1)
  })

  it('numbers the list unbroken across the chapter rules', () => {
    // The offsets index one list; nothing is skipped or repeated at a break.
    expect(set.order.length).toBe(8)
    expect(new Set(set.order).size).toBe(8)
    expect(set.chapters[0]).toBe(0)
  })

  it('is the same list whatever order the graph arrives in', () => {
    const shuffled = fixture(
      [...alphaPages].reverse(),
      [...alphaLinks].reverse(),
    )
    const other = landmarkSet(shuffled.nodes, shuffled.edges, 'alpha')
    expect(names(other.order)).toEqual(names(set.order))
    expect(other.chapters).toEqual(set.chapters)
    expect(names(other.connectors)).toEqual(names(set.connectors))
  })
})

describe('the connectors', () => {
  const set = landmarkSet(alpha.nodes, alpha.edges, 'alpha')

  it('takes the page that joins the most chapters, not the strongest one', () => {
    // p2 outranks p3 (one internal backlink against none) and joins two chapters; p3 joins all
    // three, and closing the set in one page is what the rule is for.
    expect(names(set.connectors)).toEqual(['p3'])
  })

  it('is never a landmark, and never a system or foreign page', () => {
    for (const c of set.connectors) expect(set.order).not.toContain(c)
    expect(names(set.connectors)).not.toContain('hub')
    expect(names(set.connectors)).not.toContain('beta1')
  })

  it('joins pairwise when nothing joins everything, strongest candidate first', () => {
    /*
     * DELTA. Three chapters, no page touching more than two of them. `m1` and `m2` each join a
     * pair and both are needed; `m3` joins the same pair as `m1` and is redundant the moment m1
     * is in - a page is worth drawing for the chapters it STILL joins.
     */
    const { nodes, edges } = fixture(
      [
        { name: 'd1', domain: 'delta', vaultIn: 90 },
        { name: 'd2', domain: 'delta', vaultIn: 80 },
        { name: 'd3', domain: 'delta', vaultIn: 70 },
        { name: 'd4', domain: 'delta', vaultIn: 60 },
        { name: 'd5', domain: 'delta', vaultIn: 50 },
        { name: 'd6', domain: 'delta', vaultIn: 40 },
        { name: 'd7', domain: 'delta', vaultIn: 30 },
        { name: 'd8', domain: 'delta', vaultIn: 20 },
        { name: 'm1', domain: 'delta' },
        { name: 'm2', domain: 'delta' },
        { name: 'm3', domain: 'delta' },
        { name: 'z', domain: 'delta' },
      ],
      [
        ['d1', 'd2'], ['d2', 'd3'], ['d3', 'd1'],
        ['d4', 'd5'], ['d5', 'd6'], ['d6', 'd4'],
        ['d7', 'd8'], ['d8', 'd7'],
        ['m1', 'd1'], ['m1', 'd4'],
        ['m2', 'd5'], ['m2', 'd7'],
        ['m3', 'd2'], ['m3', 'd6'],
        ['z', 'm1'], // m1 ahead of m2 and m3 in the tie-break
      ],
    )
    const d = landmarkSet(nodes, edges, 'delta')
    expect(names(d.order)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'])
    expect(d.chapters).toEqual([0, 3, 6])
    expect(names(d.connectors)).toEqual(['m1', 'm2'])
  })

  it('adds nothing where nothing joins anything, and the chapters stand apart', () => {
    /*
     * The finance case. Two chapters and no page of the domain touching both, however long the
     * loop runs - which is true of the domain rather than of the drawing.
     */
    const { nodes, edges } = fixture(
      [
        { name: 'g1', domain: 'gamma', vaultIn: 90 },
        { name: 'g2', domain: 'gamma', vaultIn: 80 },
        { name: 'g3', domain: 'gamma', vaultIn: 70 },
        { name: 'g4', domain: 'gamma', vaultIn: 60 },
        { name: 'g5', domain: 'gamma', vaultIn: 50 },
        { name: 'g6', domain: 'gamma', vaultIn: 40 },
        { name: 'g7', domain: 'gamma', vaultIn: 30 },
        { name: 'g8', domain: 'gamma', vaultIn: 20 },
        { name: 'h1', domain: 'gamma' },
        { name: 'h2', domain: 'gamma' },
      ],
      [
        ['g1', 'g2'], ['g2', 'g3'], ['g3', 'g4'], ['g4', 'g5'], ['g5', 'g1'],
        ['g6', 'g7'], ['g7', 'g8'], ['g8', 'g6'],
        ['h1', 'g1'],
        ['h2', 'g6'],
      ],
    )
    const g = landmarkSet(nodes, edges, 'gamma')
    expect(names(g.order)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'])
    expect(g.chapters).toEqual([0, 5])
    expect(g.connectors).toEqual([])
  })
})

describe("a landmark's neighbours", () => {
  const set = landmarkSet(alpha.nodes, alpha.edges, 'alpha')

  it('are the ones inside the domain, in the list’s own order', () => {
    // a1 is linked to a2 and a5 (the ring) and to v, p2 and p3; ordered inside, then over the
    // vault, then by path - which is where p3 comes before v.
    expect(names(set.neighbours.get(pathOf('a1'))!)).toEqual(['a2', 'a5', 'p2', 'p3', 'v'])
    // Neither the structural hub nor the foreign page is a neighbour of anything.
    expect(names(set.neighbours.get(pathOf('c1'))!)).toEqual(['p3', 'u1', 'u2'])
  })

  it('are computed for every landmark and for nothing else', () => {
    expect([...set.neighbours.keys()].sort()).toEqual([...set.order].sort())
  })
})

describe('a held set, read back', () => {
  const live = landmarkSet(alpha.nodes, alpha.edges, 'alpha')
  const held = { domain: 'alpha', order: live.order, chapters: live.chapters, connectors: live.connectors }

  it('is the record’s order, not a fresh ranking', () => {
    // The graph has moved under the held picture: `c1` now carries more internal backlinks than
    // anything else, so a fresh run would list it first. The held one must not.
    const louder = fixture(alphaPages, [...alphaLinks, ['v', 'c1'], ['w', 'c1'], ['u1', 'a1'], ['q', 'c1'], ['x', 'c1']])
    expect(names(landmarkSet(louder.nodes, louder.edges, 'alpha').order)[0]).toBe('c1')
    const back = heldLandmarkSet(louder.nodes, louder.edges, held)
    expect(names(back.order)).toEqual(names(live.order))
    expect(back.chapters).toEqual(live.chapters)
    expect(names(back.connectors)).toEqual(names(live.connectors))
  })

  it('reads the counts and the neighbourhoods off the graph as it stands', () => {
    const louder = fixture(alphaPages, [...alphaLinks, ['x', 'c1']])
    const back = heldLandmarkSet(louder.nodes, louder.edges, held)
    expect(back.inDomain.get(pathOf('c1'))).toBe(4) // 3 in the held picture
    expect(names(back.neighbours.get(pathOf('c1'))!)).toContain('x')
  })

  it('drops a page that has gone, and a chapter that loses all of its pages', () => {
    // b1 and b2 are the whole second chapter; c1 is the whole third.
    const gone = new Set([pathOf('b1'), pathOf('b2'), pathOf('a3')])
    const left = fixture(
      alphaPages.filter((pg) => !gone.has(pathOf(pg.name))),
      alphaLinks.filter(([a, b]) => !gone.has(pathOf(a)) && !gone.has(pathOf(b))),
    )
    const back = heldLandmarkSet(left.nodes, left.edges, held)
    expect(names(back.order)).toEqual(['a1', 'a2', 'a4', 'a5', 'c1'])
    // Two chapters left, and the offsets moved with the pages rather than pointing past them.
    expect(back.chapters).toEqual([0, 4])
    expect(back.order.slice(back.chapters[1]!)).toEqual([pathOf('c1')])
  })

  it('is idempotent, so locking a held picture records the same thing again', () => {
    const back = heldLandmarkSet(alpha.nodes, alpha.edges, held)
    expect(back.order).toEqual(live.order)
    expect(back.chapters).toEqual(live.chapters)
    expect(back.connectors).toEqual(live.connectors)
  })
})
