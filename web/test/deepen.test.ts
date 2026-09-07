/**
 * Ranking the pages of a domain by how much they deserve deepening (web/src/lib/deepen.ts).
 * The dialog puts four of these in front of the user and spends real money on them, so the
 * order is worth pinning down rather than eyeballing.
 */

import { describe, it, expect } from 'vitest'
import { deepenCandidates, deepenCostUsd, fellowsForDomain, DEEPEN_DEFAULT_PAGES } from '../src/lib/deepen.ts'
import type { FellowSummary, GraphNode } from '../src/api/types.ts'

const node = (over: Partial<GraphNode> & { path: string }): GraphNode => ({
  title: (over.path.split('/').pop() ?? over.path).replace(/\.md$/, ''),
  type: 'concepts',
  tags: [],
  domain: 'astronomy',
  kind: 'knowledge',
  out: 2,
  in: 0,
  size: 4000,
  ...over,
})

describe('which pages deserve deepening', () => {
  it('puts demand over substance: many backlinks, little text', () => {
    const nodes = [
      node({ path: 'wiki/concepts/Thorough.md', in: 20, size: 40_000 }),
      node({ path: 'wiki/concepts/Wanted But Thin.md', in: 18, size: 900 }),
      node({ path: 'wiki/concepts/Thin And Ignored.md', in: 0, size: 800 }),
    ]
    expect(deepenCandidates(nodes, 'astronomy').map((c) => c.title)).toEqual(['Wanted But Thin', 'Thin And Ignored', 'Thorough'])
  })

  it('leaves every other domain alone', () => {
    const nodes = [node({ path: 'wiki/concepts/A.md', in: 9, size: 500 }), node({ path: 'wiki/concepts/B.md', domain: 'cooking', in: 99, size: 100 })]
    expect(deepenCandidates(nodes, 'astronomy').map((c) => c.title)).toEqual(['A'])
  })

  it('offers concepts and entities, never sources, index hubs or reports', () => {
    const nodes = [
      node({ path: 'wiki/concepts/Concept.md', in: 5, size: 500 }),
      node({ path: 'wiki/entities/Entity.md', type: 'entities', in: 5, size: 500 }),
      node({ path: 'wiki/sources/Paper.md', type: 'sources', in: 50, size: 300 }),
      node({ path: 'wiki/concepts/_index.md', kind: 'structural', in: 90, size: 300 }),
      node({ path: 'wiki/meta/lint-report.md', type: 'meta', kind: 'artifact', in: 40, size: 300 }),
    ]
    expect(deepenCandidates(nodes, 'astronomy').map((c) => c.title).sort()).toEqual(['Concept', 'Entity'])
  })

  it('sorts an empty page first without dividing by zero, and orders ties the same way twice', () => {
    const nodes = [
      node({ path: 'wiki/concepts/Empty.md', in: 3, size: 0 }),
      node({ path: 'wiki/concepts/B Tie.md', in: 3, size: 1000 }),
      node({ path: 'wiki/concepts/A Tie.md', in: 3, size: 1000 }),
    ]
    const order = deepenCandidates(nodes, 'astronomy').map((c) => c.title)
    expect(order[0]).toBe('Empty')
    expect(order.slice(1)).toEqual(['A Tie', 'B Tie'])
    expect(deepenCandidates(nodes, 'astronomy').map((c) => c.title)).toEqual(order)
  })

  it('treats a node with no size as empty rather than dropping it', () => {
    const nodes = [node({ path: 'wiki/concepts/Unknown Size.md', in: 4, size: undefined })]
    expect(deepenCandidates(nodes, 'astronomy')).toHaveLength(1)
  })
})

describe('what it costs', () => {
  it('charges the base for the proposed set and a flat amount for each page beyond it', () => {
    expect(deepenCostUsd(DEEPEN_DEFAULT_PAGES)).toBe(6)
    expect(deepenCostUsd(1)).toBe(6)
    expect(deepenCostUsd(8)).toBe(10)
  })

  it('scales with the model, the way every other budget does', () => {
    expect(deepenCostUsd(8, 2.5)).toBe(25)
  })
})

describe('who may deepen a domain', () => {
  const fellow = (name: string, homeDomain: string, extraDomains: string[] = [], state = 'waiting'): FellowSummary =>
    ({ agent: { name, homeDomain, extraDomains, state }, currentRun: null, lastRun: null, runsToday: 0, pendingProposals: 0, next: null }) as unknown as FellowSummary

  it('offers the Fellow of the domain before one that only has it as an extra', () => {
    const all = [fellow('Extra', 'computing', ['astronomy']), fellow('Home', 'astronomy')]
    expect(fellowsForDomain(all, 'astronomy').map((f) => f.agent.name)).toEqual(['Home', 'Extra'])
  })

  it('offers nobody for a domain nobody works, which is what sends you to the spawn form', () => {
    expect(fellowsForDomain([fellow('Ada', 'astronomy')], 'cooking')).toEqual([])
  })

  it('leaves out the Fellows that are not going to run', () => {
    const all = [fellow('Gone', 'astronomy', [], 'retired'), fellow('Held', 'astronomy', [], 'paused'), fellow('Ready', 'astronomy')]
    expect(fellowsForDomain(all, 'astronomy').map((f) => f.agent.name)).toEqual(['Ready'])
  })
})
