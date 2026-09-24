import { describe, it, expect } from 'vitest'
import { ingestDomain } from '../src/lib/ingestDomain.ts'

const nodes = [
  { path: 'wiki/sources/S.md', domain: 'alpha', kind: 'knowledge' },
  { path: 'wiki/concepts/A.md', domain: 'alpha', kind: 'knowledge' },
  { path: 'wiki/concepts/B.md', domain: 'beta', kind: 'knowledge' },
  { path: 'wiki/concepts/C.md', domain: 'beta', kind: 'knowledge' },
  { path: 'wiki/concepts/U.md', domain: null, kind: 'knowledge' },
  { path: 'wiki/index.md', domain: 'meta', kind: 'structural' },
]

describe('ingestDomain', () => {
  it("names the main article's domain, and every domain with its count", () => {
    const r = ingestDomain(['wiki/concepts/B.md', 'wiki/concepts/C.md', 'wiki/concepts/A.md', 'wiki/index.md'], nodes, 'wiki/concepts/A.md')
    expect(r.domain).toBe('alpha')
    expect(r.counts).toEqual([
      ['beta', 2],
      ['alpha', 1],
    ])
  })

  it('falls back to the domain most pages carry without an article in the graph', () => {
    expect(ingestDomain(['wiki/concepts/B.md', 'wiki/concepts/C.md', 'wiki/sources/S.md'], nodes, null).domain).toBe('beta')
    expect(ingestDomain(['wiki/concepts/B.md', 'wiki/concepts/C.md', 'wiki/sources/S.md'], nodes, 'wiki/gone.md').domain).toBe('beta')
    // An unassigned article is the run's answer, even when it touched a page elsewhere.
    expect(ingestDomain(['wiki/concepts/U.md', 'wiki/concepts/B.md'], nodes, 'wiki/concepts/U.md').domain).toBe('unassigned')
  })

  it('counts a page without a domain as unassigned, and is null for pages the graph does not hold', () => {
    expect(ingestDomain(['wiki/concepts/U.md'], nodes, null).domain).toBe('unassigned')
    expect(ingestDomain(['wiki/concepts/Gone.md'], nodes, null)).toEqual({ domain: null, counts: [] })
  })
})
