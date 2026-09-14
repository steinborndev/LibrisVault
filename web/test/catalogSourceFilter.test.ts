/**
 * The Catalog's source filter (2026-09-14): the pills OR together, and `Publication` cuts
 * across the document kinds rather than standing beside them.
 */

import { describe, expect, it } from 'vitest'
import {
  PUBLICATION,
  SOURCE_FILTERS,
  hasSource,
  isPublication,
  matchesSources,
  sourceCounts,
  sourceSummary,
} from '../src/lib/catalogSourceFilter.ts'
import type { GraphNode, SourceRef } from '../src/api/types.ts'

const node = (over: Partial<GraphNode> & { path: string }): GraphNode => ({
  title: over.path,
  type: 'sources',
  tags: [],
  domain: null,
  in: 0,
  out: 0,
  url: null,
  ...over,
})

const refs: Record<string, SourceRef> = {
  'paper.md': { type: 'pdf', url: null, dir: '.raw/1', file: 'paper.pdf' },
  'site.md': { type: 'web', url: 'https://publisher.example/news/1', dir: '.raw/2', file: null },
  'preprint.md': { type: 'web', url: 'https://doi.org/10.1234/example.2026.001', dir: '.raw/3', file: null },
  'photo.md': { type: 'image', url: null, dir: '.raw/4', file: 'shot.png' },
}
const pages = [
  node({ path: 'paper.md', url: 'https://publisher.example/articles/10.1234/example.2026.002' }),
  node({ path: 'site.md' }),
  node({ path: 'preprint.md' }),
  node({ path: 'photo.md' }),
  node({ path: 'written.md' }),
  node({ path: 'read.md', url: 'https://publisher.example/blog/why' }),
]
const shown = (selected: string[]): string[] =>
  pages.filter((n) => matchesSources(n, refs, new Set(selected))).map((n) => n.path)

describe('a publication is an address, not a kind of document', () => {
  it('reads a DOI off the page\'s own address or off the ingest\'s', () => {
    // A publisher's own URL that carries the DOI in its path, and the resolver's host.
    expect(isPublication({ path: 'paper.md', url: 'https://publisher.example/articles/10.1234/example.2026.002' }, refs)).toBe(true)
    expect(isPublication({ path: 'preprint.md' }, refs)).toBe(true)
    expect(isPublication({ path: 'read.md', url: 'https://publisher.example/blog/why' }, refs)).toBe(false)
    expect(isPublication({ path: 'written.md' }, refs)).toBe(false)
  })

  it('does not mistake a short number in a path for a DOI', () => {
    expect(isPublication({ path: 'x.md', url: 'https://publisher.example/10.5/notes' }, refs)).toBe(false)
  })
})

describe('the pills OR together', () => {
  it('nothing selected is not a filter', () => {
    expect(shown([])).toHaveLength(pages.length)
  })

  it('two kinds show either, the page that only states an address included', () => {
    // `read.md` has no ingest behind it; the address it states is what makes it Web.
    expect(shown(['pdf', 'web'])).toEqual(['paper.md', 'site.md', 'preprint.md', 'read.md'])
  })

  it('a page with nothing behind it is in no kind', () => {
    expect(shown(['pdf', 'web', 'image', 'text', 'office', 'av', 'other'])).not.toContain('written.md')
  })

  it('publication crosses the kinds: the PDF with a DOI comes along without the PDF pill', () => {
    expect(shown([PUBLICATION])).toEqual(['paper.md', 'preprint.md'])
    expect(shown([PUBLICATION, 'image'])).toEqual(['paper.md', 'preprint.md', 'photo.md'])
  })

  it('narrows nothing while the index is still in flight', () => {
    // Otherwise the table would empty out and read as "nothing matches" mid-load.
    expect(pages.filter((n) => matchesSources(n, undefined, new Set(['pdf'])))).toHaveLength(pages.length)
  })
})

describe('with a source at all', () => {
  it('is what the column draws a link for, the bare address included', () => {
    expect(pages.filter((n) => hasSource(n, refs)).map((n) => n.path)).toEqual([
      'paper.md',
      'site.md',
      'preprint.md',
      'photo.md',
      'read.md',
    ])
    // The one page the vault wrote out of other pages: no document, no address.
    expect(hasSource(node({ path: 'written.md' }), refs)).toBe(false)
  })

  it('narrows nothing while the index is still in flight', () => {
    expect(hasSource(node({ path: 'written.md' }), undefined)).toBe(true)
  })
})

describe('the counts on the pills', () => {
  const counts = sourceCounts(pages, refs)

  it('counts what each pill alone would show, overlaps included', () => {
    expect(counts.get('pdf')).toBe(1)
    expect(counts.get('web')).toBe(3)
    expect(counts.get('image')).toBe(1)
    // The PDF with a DOI is counted under both, because both pills would show it.
    expect(counts.get(PUBLICATION)).toBe(2)
    expect(counts.get('office')).toBeUndefined()
  })
})

describe('the hint line under the pills', () => {
  it('says the selection, and counts the rest past three', () => {
    expect(sourceSummary(new Set())).toBe('every page, whatever it came from')
    expect(sourceSummary(new Set(['pdf']))).toBe('PDF only')
    expect(sourceSummary(new Set(['pdf', 'web']))).toBe('PDF or Web only')
    expect(sourceSummary(new Set(['pdf', 'web', PUBLICATION]))).toBe('PDF, Web or Publication only')
    expect(sourceSummary(new Set(['pdf', 'web', 'image', PUBLICATION]))).toBe('PDF, Web and 2 more')
  })

  it('keeps every line inside the one the panel has room for', () => {
    // Measured against the live sidebar: 222px of an 11px face, about 41 characters. Longer
    // lines are cut off mid-word, which is the bug this bound exists to hold.
    for (const f of SOURCE_FILTERS) expect(f.desc.length).toBeLessThanOrEqual(41)
    const every = new Set(SOURCE_FILTERS.map((f) => f.key))
    expect(sourceSummary(every).length).toBeLessThanOrEqual(41)
  })
})
