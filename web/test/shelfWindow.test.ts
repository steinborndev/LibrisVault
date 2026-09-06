/**
 * The shelf window's subgraph (docs/agents/SPEC.md section 10.5): one department's pages
 * and only the links that run between them, re-indexed onto the smaller node list.
 */

import { describe, expect, it } from 'vitest'
import { subgraph } from '../src/components/library/ShelfWindow.tsx'
import type { GraphNode } from '../src/api/types.ts'

const node = (title: string, domain: string | null): GraphNode => ({
  path: `wiki/concepts/${title}.md`,
  title,
  type: 'concepts',
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
