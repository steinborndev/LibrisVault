/**
 * The split proposal's engine (docs/tasks/TASKS-DOMAIN-SPLIT.md 1.2 to 1.6), on synthetic graphs
 * only (hard rule 7): planted partitions from one seeded generator, and two hand-built shapes
 * where a count has to be checkable by hand.
 */
import { describe, it, expect } from 'vitest'
import {
  consensusShelves,
  keyCollision,
  proposeSplit,
  restrictGraph,
  shelfDrift,
  SPLIT_MIN_PAGES,
  type SplitProposal,
  type SplitShelf,
} from '../src/pipeline/domain-split.js'
import { STRUCTURAL_TAGS } from '../src/pipeline/domain-candidates.js'
import type { GraphNode, VaultGraph } from '../src/pipeline/graph.js'

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

const DOMAIN = 'alpha'

const page = (block: number, i: number, over: Partial<GraphNode> = {}): GraphNode => ({
  path: `wiki/concepts/Page B${block}-${String(i).padStart(3, '0')}.md`,
  title: `Page B${block}-${String(i).padStart(3, '0')}`,
  type: 'concepts',
  tags: ['concept', `topic-${block}`],
  domain: DOMAIN,
  kind: 'knowledge',
  out: 0,
  in: 0,
  ...over,
})

/** Planted partition over one domain: blocks of the given sizes, `pIn` inside, `pOut` between. */
function planted(sizes: number[], pIn: number, pOut: number, seed: number): VaultGraph {
  const r = rng(seed)
  const block: number[] = []
  sizes.forEach((s, b) => {
    for (let i = 0; i < s; i++) block.push(b)
  })
  const nodes = block.map((b, i) => page(b, i))
  const edges: Array<[number, number]> = []
  for (let i = 0; i < block.length; i++)
    for (let j = i + 1; j < block.length; j++)
      if (r() < (block[i] === block[j] ? pIn : pOut)) edges.push(r() < 0.5 ? [i, j] : [j, i])
  return { nodes, edges, unresolved: 0, gaps: [], builtAt: '2026-09-23T00:00:00.000Z' }
}

const addressesOf = (g: VaultGraph): Map<string, string> =>
  new Map(g.nodes.map((n) => [n.path, `c-${n.path.replace(/\D/g, '').padStart(6, '0')}`]))

const blockOf = (path: string): number => Number(/Page B(\d+)-/.exec(path)![1])
const blocksIn = (s: SplitShelf): number[] => [...new Set(s.pages.map((p) => blockOf(p.path)))].sort()
const shelfOfBlock = (p: SplitProposal, b: number): SplitShelf =>
  p.shelves.find((s) => blocksIn(s).length === 1 && blocksIn(s)[0] === b)!

/**
 * Two ring lattices of 30 (each page links to its next three, 90 links per ring) and three
 * links from the first ring to the second: every count below can be done by hand.
 */
function rings(extra: (nodes: GraphNode[], edges: Array<[number, number]>) => void = () => {}): VaultGraph {
  const nodes: GraphNode[] = []
  const edges: Array<[number, number]> = []
  for (let b = 0; b < 2; b++) for (let i = 0; i < 30; i++) nodes.push(page(b, i))
  for (let b = 0; b < 2; b++)
    for (let i = 0; i < 30; i++) for (let k = 1; k <= 3; k++) edges.push([b * 30 + i, b * 30 + ((i + k) % 30)])
  edges.push([0, 30], [10, 40], [20, 50])
  extra(nodes, edges)
  return { nodes, edges, unresolved: 0, gaps: [], builtAt: '2026-09-23T00:00:00.000Z' }
}

describe('consensusShelves and proposeSplit', () => {
  const g = planted([40, 40, 40, 40, 12], 0.25, 0.01, 2)
  const proposal = proposeSplit(g, DOMAIN, addressesOf(g))

  it('recovers four blocks of 40 as four shelves and leaves the 12 with the parent', () => {
    expect(proposal.eligible).toBe(true)
    expect(proposal.shelves).toHaveLength(4)
    expect(proposal.shelves.map(blocksIn).sort()).toEqual([[0], [1], [2], [3]])
    expect(proposal.shelves.every((s) => s.size === 40)).toBe(true)
    expect(proposal.rest.size).toBe(12)
    expect(new Set(proposal.rest.pages.map((p) => blockOf(p.path)))).toEqual(new Set([4]))
  })

  it('gives a deep-equal proposal for the same pages and links in shuffled input order', () => {
    const r = rng(5)
    const order = g.nodes.map((_, i) => i).sort(() => r() - 0.5)
    const at = new Map(order.map((old, i) => [old, i]))
    const edges = g.edges.map(([a, b]) => [at.get(a)!, at.get(b)!] as [number, number]).sort(() => r() - 0.5)
    const shuffled: VaultGraph = { ...g, nodes: order.map((i) => g.nodes[i]!), edges }
    expect(proposeSplit(shuffled, DOMAIN, addressesOf(g))).toEqual(proposal)
  })

  it('keeps at least 98 % of the rest on their shelf when 5 % of the pages are removed', () => {
    const r = rng(99)
    const drop = new Set(g.nodes.filter(() => r() < 0.05).map((n) => n.path))
    expect(drop.size).toBeGreaterThan(0)
    const after = proposeSplit(restrictGraph(g, (n) => !drop.has(n.path)), DOMAIN, addressesOf(g))
    const drift = shelfDrift(proposal, after)
    expect(drift.common).toBe(g.nodes.length - drop.size)
    expect(drift.share).toBeLessThanOrEqual(0.02)
  })

  it('returns deep-equal results for two calls on one graph object', () => {
    expect(proposeSplit(g, DOMAIN, addressesOf(g))).toEqual(proposal)
  })

  it('sorts its pages by path, so the order the caller lists them in never matters', () => {
    const paths = g.nodes.map((n) => n.path)
    const links = g.edges.map(([a, b]) => [paths[a]!, paths[b]!] as [string, string])
    const a = consensusShelves(paths, links)
    const b = consensusShelves([...paths].reverse(), [...links].reverse())
    expect(b).toEqual(a)
    expect(a.paths).toEqual([...paths].sort())
  })

  it('ignores self-links', () => {
    const paths = g.nodes.map((n) => n.path)
    const links = g.edges.map(([a, b]) => [paths[a]!, paths[b]!] as [string, string])
    const selfish = [...links, ...paths.map((p) => [p, p] as [string, string])]
    expect(consensusShelves(paths, selfish)).toEqual(consensusShelves(paths, links))
  })
})

describe('the boundaries', () => {
  it('finds that one dense block of 60 holds together, and says so', () => {
    const g = planted([60], 0.3, 0, 5)
    const p = proposeSplit(g, DOMAIN, addressesOf(g))
    expect(p.eligible).toBe(true)
    expect(p.shelves).toEqual([])
    expect(p.reason).toMatch(/^Holds together/)
    expect(p.rest.size).toBe(60)
  })

  it('does not offer a split under 50 pages and does at 50', () => {
    const small = planted([SPLIT_MIN_PAGES - 1], 0.3, 0, 6)
    const p49 = proposeSplit(small, DOMAIN, addressesOf(small))
    expect(p49.eligible).toBe(false)
    expect(p49.reason).toContain('49')
    const enough = planted([SPLIT_MIN_PAGES], 0.3, 0, 6)
    expect(proposeSplit(enough, DOMAIN, addressesOf(enough)).eligible).toBe(true)
  })

  it('counts only the domain\'s knowledge pages', () => {
    const g = planted([40, 40], 0.25, 0.01, 2)
    const nodes = g.nodes.map((n, i) =>
      i < 5 ? { ...n, kind: 'artifact' as const } : i < 8 ? { ...n, origin: 'upstream-demo' } : i < 10 ? { ...n, domain: 'beta' } : n,
    )
    expect(proposeSplit({ ...g, nodes }, DOMAIN, addressesOf(g)).pages).toBe(70)
  })
})

describe('the evidence', () => {
  it('computes conductance equal to the hand count on two rings', () => {
    const g = rings()
    const p = proposeSplit(g, DOMAIN, addressesOf(g))
    expect(p.shelves).toHaveLength(2)
    // 90 links inside each ring (180 link ends), three leaving it.
    for (const s of p.shelves) expect(s.conductance).toBeCloseTo(3 / 183, 10)
    expect(p.totals.internalLinks).toBe(183)
  })

  it('sums the link matrix to the domain\'s internal links', () => {
    const g = planted([40, 40, 40, 40, 12], 0.25, 0.01, 2)
    const p = proposeSplit(g, DOMAIN, addressesOf(g))
    const sum = p.links.flat().reduce((a, b) => a + b, 0)
    expect(sum).toBe(g.edges.length)
    expect(p.totals.internalLinks).toBe(g.edges.length)
    expect(p.links).toHaveLength(p.shelves.length + 1)
  })

  it('ranks landmarks by backlinks in the shelf, then in the domain, then over the vault, then path', () => {
    const g = rings((nodes, edges) => {
      // A clique of ten beside the rings: a group of its own, which stays with the parent,
      // lending one ring page a backlink inside the domain but not inside its shelf.
      const base = nodes.length
      for (let i = 0; i < 10; i++) nodes.push(page(9, i))
      for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) edges.push([base + i, base + j])
      edges.push([base, 5])
      // Two more ring pages differ only by their backlinks over the whole vault.
      nodes[12] = { ...nodes[12]!, in: 50 }
      nodes[7] = { ...nodes[7]!, in: 20 }
    })
    const p = proposeSplit(g, DOMAIN, addressesOf(g))
    expect(p.rest.size).toBe(10)
    const ring = shelfOfBlock(p, 0)
    expect(ring.landmarks.map((l) => l.title)).toEqual([
      'Page B0-005',
      'Page B0-012',
      'Page B0-007',
      'Page B0-000',
      'Page B0-001',
    ])
    expect(ring.landmarks[0]).toMatchObject({ inShelf: 3, inDomain: 4 })
  })

  it('never proposes a structural tag', () => {
    const g = planted([40, 40, 12], 0.25, 0.01, 4)
    const nodes = g.nodes.map((n) => (blockOf(n.path) === 0 ? { ...n, tags: [...n.tags, 'person', 'entity'] } : n))
    const p = proposeSplit({ ...g, nodes }, DOMAIN, addressesOf(g))
    for (const s of p.shelves) for (const t of s.tags) expect(STRUCTURAL_TAGS.has(t)).toBe(false)
    expect(shelfOfBlock(p, 0).tags).toContain('topic-0')
  })

  it('gives the shelf whose tags are a subset of another\'s the lower precision and a confusion', () => {
    const g = planted([40, 40, 12], 0.25, 0.01, 4)
    const r = rng(3)
    const nodes = g.nodes.map((n) => {
      const b = blockOf(n.path)
      if (b === 0) return { ...n, tags: ['concept', 'topic-a'] }
      if (b === 1) return { ...n, tags: ['concept', ...(r() < 0.8 ? ['topic-a'] : []), ...(r() < 0.5 ? ['topic-b'] : [])] }
      return { ...n, tags: ['concept', 'topic-c'] }
    })
    const p = proposeSplit({ ...g, nodes }, DOMAIN, addressesOf(g))
    const sub = shelfOfBlock(p, 0)
    const sup = shelfOfBlock(p, 1)
    expect(sub.precision!).toBeLessThan(sup.precision!)
    const conf = sub.confusedWith.find((c) => c.with === sup.id)
    expect(conf).toBeDefined()
    expect(conf!.receives).toBeGreaterThanOrEqual(0.1)
    // Ranked by separability, so the subset shelf ranks below the one it resembles.
    expect(sub.rank).toBeGreaterThan(sup.rank)
  })

  it('keeps a shelf\'s fingerprint when a page is added at its periphery', () => {
    const g = planted([40, 40, 40, 12], 0.25, 0.01, 2)
    const before = shelfOfBlock(proposeSplit(g, DOMAIN, addressesOf(g)), 0)
    const leaf = page(0, 999)
    const from = g.nodes.findIndex((n) => blockOf(n.path) === 0)
    const grown: VaultGraph = { ...g, nodes: [...g.nodes, leaf], edges: [...g.edges, [from, g.nodes.length]] }
    const after = proposeSplit(grown, DOMAIN, addressesOf(grown))
    const shelf = after.shelves.find((s) => s.pages.some((pg) => pg.path === before.pages[0]!.path))!
    expect(shelf.size).toBe(41)
    expect(shelf.fingerprint).toBe(before.fingerprint)
  })

  it('lists outside neighbours with three or more links into a shelf, and only those', () => {
    const g = planted([40, 40, 12], 0.25, 0.01, 4)
    const target = g.nodes.findIndex((n) => blockOf(n.path) === 0)
    const n = g.nodes.length
    const nodes = [...g.nodes, page(7, 1, { domain: 'beta' }), page(7, 2, { domain: 'beta' })]
    const edges: Array<[number, number]> = [...g.edges, [n, target], [n, target + 1], [target + 2, n], [n + 1, target], [n + 1, target + 1]]
    const p = proposeSplit({ ...g, nodes, edges }, DOMAIN, addressesOf(g))
    const s = shelfOfBlock(p, 0)
    expect(s.outsideNeighbours.count).toBe(1)
    expect(s.outsideNeighbours.pages[0]).toMatchObject({ title: 'Page B7-001', domain: 'beta', links: 3 })
  })

  it('reports the largest department domain now and after promoting every shelf', () => {
    const g = planted([40, 40, 12], 0.25, 0.01, 4)
    const others = Array.from({ length: 30 }, (_, i) => page(8, i, { domain: 'beta' }))
    const p = proposeSplit({ ...g, nodes: [...g.nodes, ...others] }, DOMAIN, addressesOf(g))
    expect(p.totals.knowledgePages).toBe(122)
    expect(p.totals.largestNow).toEqual({ domain: DOMAIN, pages: 92, share: 92 / 122 })
    expect(p.totals.largestAfter.pages).toBe(40)
  })

  it('lists the unaddressed pages', () => {
    const g = planted([40, 40, 12], 0.25, 0.01, 4)
    const addresses = addressesOf(g)
    addresses.delete(g.nodes[3]!.path)
    const p = proposeSplit(g, DOMAIN, addresses)
    expect(p.unaddressed).toEqual([g.nodes[3]!.path])
    const member = [...p.shelves.flatMap((s) => s.pages), ...p.rest.pages].find((m) => m.path === g.nodes[3]!.path)
    expect(member?.address).toBeNull()
  })
})

describe('keyCollision', () => {
  it('counts the pages inside the shelf and elsewhere that carry the key as a tag', () => {
    const g = planted([10], 0.3, 0, 1)
    const nodes = g.nodes.map((n, i) => (i < 4 ? { ...n, tags: [...n.tags, 'Key-X'] } : n))
    const shelf = nodes.slice(0, 3).map((n) => n.path)
    expect(keyCollision({ ...g, nodes }, shelf, 'key-x')).toEqual({ key: 'key-x', inside: 3, elsewhere: 1 })
  })
})
