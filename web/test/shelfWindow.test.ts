/**
 * The shelf window's subgraph (docs/agents/SPEC.md section 10.5): one department's pages
 * and only the links that run between them, re-indexed onto the smaller node list. The
 * legend narrows that subgraph again to a single page type, and both views take the narrowed
 * one, so a click on "sources" leaves sources on the canvas and in the catalog.
 */

import { describe, expect, it } from 'vitest'
import { narrow, subgraph } from '../src/components/library/ShelfWindow.tsx'
import type { GraphNode } from '../src/api/types.ts'

const node = (title: string, domain: string | null, type = 'concepts'): GraphNode => ({
  path: `wiki/${type}/${title}.md`,
  title,
  type,
  tags: [],
  domain,
  kind: 'knowledge',
  out: 0,
  in: 0,
  size: 1000,
})

describe('a department subgraph', () => {
  const nodes = [node('A', 'computing'), node('B', 'cooking'), node('C', 'computing'), node('D', 'computing')]
  const edges: Array<[number, number]> = [
    [0, 2], // inside computing
    [0, 1], // leaves the department
    [1, 3], // enters it
    [2, 3], // inside
    [3, 3], // a self link
  ]

  it('keeps the department, re-indexes its links and drops the ones that leave', () => {
    const sub = subgraph(nodes, edges, 'computing')
    expect(sub.nodes.map((n) => n.title)).toEqual(['A', 'C', 'D'])
    expect(sub.edges).toEqual([
      [0, 1],
      [1, 2],
    ])
  })

  it('an empty department yields nothing, and a domain nobody carries too', () => {
    expect(subgraph(nodes, edges, 'astronomy')).toEqual({ nodes: [], edges: [] })
    expect(subgraph([], [], 'computing')).toEqual({ nodes: [], edges: [] })
  })
})

describe('the legend filter', () => {
  const nodes = [node('A', 'computing'), node('S', 'computing', 'sources'), node('C', 'computing'), node('T', 'computing', 'sources')]
  const edges: Array<[number, number]> = [
    [0, 1], // concept to source
    [1, 3], // source to source
    [0, 2], // concept to concept
    [3, 3], // a self link
  ]

  it('keeps one page type and the links that stay inside it', () => {
    const only = narrow({ nodes, edges }, 'sources')
    expect(only.nodes.map((n) => n.title)).toEqual(['S', 'T'])
    expect(only.edges).toEqual([[0, 1]])
  })

  it('no type picked leaves the department whole', () => {
    expect(narrow({ nodes, edges }, null)).toEqual({ nodes, edges })
  })

  it('a type nobody carries yields nothing', () => {
    expect(narrow({ nodes, edges }, 'questions')).toEqual({ nodes: [], edges: [] })
  })
})
