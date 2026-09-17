/**
 * The catalog's order (2026-09-14): one rule for the sidebar's pills and the table's headings,
 * because they are the same choice made in two places.
 */

import { describe, expect, it } from 'vitest'
import { CATALOG_SORTS, naturalDir, sortCatalog, type CatalogSortKey } from '../src/lib/catalogSort.ts'
import { sourceKind } from '../src/lib/sources.ts'
import type { GraphNode, SourceRef } from '../src/api/types.ts'

const node = (over: Partial<GraphNode> & { title: string }): GraphNode => ({
  path: `wiki/concepts/${over.title}.md`,
  type: 'concepts',
  tags: [],
  domain: null,
  in: 0,
  out: 0,
  url: null,
  ...over,
})

const titles = (nodes: readonly GraphNode[]): string[] => nodes.map((n) => n.title)
const order = (nodes: readonly GraphNode[], key: CatalogSortKey, dir = naturalDir(key), refs?: Record<string, SourceRef>): string[] =>
  titles(sortCatalog(nodes, key, dir, refs))

describe('one click: every column in the direction that makes sense', () => {
  const pages = [
    node({ title: 'Beta', type: 'sources', domain: 'astronomy', in: 3, mtimeMs: 200 }),
    node({ title: 'Alpha', type: 'concepts', domain: null, in: 7, mtimeMs: 100 }),
    node({ title: 'Gamma', type: 'entities', domain: 'cooking', in: 1, mtimeMs: 300 }),
  ]

  it('changed: the newest first', () => {
    expect(order(pages, 'changed')).toEqual(['Gamma', 'Beta', 'Alpha'])
  })

  it('title: A to Z', () => {
    expect(order(pages, 'title')).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('backlinks: the most linked first', () => {
    expect(order(pages, 'backlinks')).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('type: the buckets in the order the vault thinks in, not the alphabet', () => {
    // Concepts, entities, sources - ideas, things, documents - and never c-e-s by accident.
    expect(order(pages, 'type')).toEqual(['Alpha', 'Gamma', 'Beta'])
  })

  it('domain: grouped, and the unfiled page last', () => {
    expect(order(pages, 'domain')).toEqual(['Beta', 'Gamma', 'Alpha'])
  })
})

describe('a second click reverses whatever the first one did', () => {
  const pages = [
    node({ title: 'Beta', mtimeMs: 200, in: 3 }),
    node({ title: 'Alpha', mtimeMs: 100, in: 7 }),
    node({ title: 'Gamma', mtimeMs: 300, in: 1 }),
  ]

  it('turns newest-first into oldest-first, and most-linked into fewest-linked', () => {
    expect(order(pages, 'changed', 'asc')).toEqual(['Alpha', 'Beta', 'Gamma'])
    // Fewest backlinks first is how orphans surface.
    expect(order(pages, 'backlinks', 'asc')).toEqual(['Gamma', 'Beta', 'Alpha'])
    expect(order(pages, 'title', 'desc')).toEqual(['Gamma', 'Beta', 'Alpha'])
  })

  it('knows each column\'s natural direction, so the first click never surprises', () => {
    expect(naturalDir('changed')).toBe('desc')
    expect(naturalDir('backlinks')).toBe('desc')
    expect(naturalDir('title')).toBe('asc')
    expect(naturalDir('type')).toBe('asc')
    expect(naturalDir('domain')).toBe('asc')
    expect(naturalDir('source')).toBe('asc')
  })
})

describe('source type: what was ingested', () => {
  const pages = [
    node({ title: 'A web ingest', path: 'w.md' }),
    node({ title: 'A dropped PDF', path: 'p.md' }),
    node({ title: 'Nothing behind it', path: 'n.md' }),
    node({ title: 'Its own address only', path: 'u.md', url: 'https://publisher.example/x' }),
    node({ title: 'An image', path: 'i.md' }),
  ]
  const refs: Record<string, SourceRef> = {
    'w.md': { type: 'web', url: 'https://publisher.example/a', dir: '.raw/1', file: null },
    'p.md': { type: 'pdf', url: null, dir: '.raw/2', file: 'paper.pdf' },
    'i.md': { type: 'image', url: null, dir: '.raw/3', file: 'shot.png' },
  }

  it('reads the kind the column shows, address fallback included', () => {
    expect(sourceKind({ path: 'p.md' }, refs)).toBe('pdf')
    expect(sourceKind({ path: 'w.md' }, refs)).toBe('web')
    expect(sourceKind({ path: 'u.md', url: 'https://publisher.example/x' }, refs)).toBe('web')
    expect(sourceKind({ path: 'n.md' }, refs)).toBeNull()
    // An index that has not arrived yet says nothing rather than "no source".
    expect(sourceKind({ path: 'p.md' }, undefined)).toBeNull()
  })

  it('groups from the stored document to the bare address, and pages without one last', () => {
    expect(order(pages, 'source', 'asc', refs)).toEqual([
      'A dropped PDF',
      'A web ingest',
      'Its own address only',
      'An image',
      'Nothing behind it',
    ])
  })

  it('reversed, the pages with no source lead', () => {
    expect(order(pages, 'source', 'desc', refs)[0]).toBe('Nothing behind it')
  })
})

describe('the sorts as the sidebar lists them', () => {
  it('carries a pill for every sortable column, Type and Source type included', () => {
    expect(CATALOG_SORTS.map((s) => s.key)).toEqual(['changed', 'title', 'type', 'domain', 'backlinks', 'source'])
    expect(CATALOG_SORTS.every((s) => s.label !== '' && s.desc !== '')).toBe(true)
  })

  it('says each one in a line the panel can show whole', () => {
    // The hint slot is one line that clips rather than wraps; measured against the live
    // sidebar, 222px of an 11px face takes about 41 characters. Two of these were cut off
    // mid-word until 2026-09-14.
    for (const s of CATALOG_SORTS) expect(s.desc.length).toBeLessThanOrEqual(41)
  })

  it('leaves the caller\'s array alone', () => {
    const pages = [node({ title: 'B' }), node({ title: 'A' })]
    const before = titles(pages)
    sortCatalog(pages, 'title', 'asc')
    expect(titles(pages)).toEqual(before)
  })
})
