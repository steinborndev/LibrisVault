import { describe, it, expect } from 'vitest'
import { isMetaPage, contentPages } from '../src/pipeline/wiki-meta.js'

describe('wiki meta pages', () => {
  it('names the pages every ingest touches, by path', () => {
    for (const p of [
      'wiki/index.md',
      'wiki/hot.md',
      'wiki/log.md',
      'wiki/overview.md',
      'wiki/dashboard.md',
      'wiki/Wiki Map.md',
      'wiki/getting-started.md',
      'wiki/concepts/_index.md',
      'wiki/sources/nested/_index.md',
    ]) {
      expect(isMetaPage(p), p).toBe(true)
    }
  })

  it('keeps content pages, including one titled like a meta page and the registry pages under wiki/meta/', () => {
    for (const p of ['wiki/concepts/Log.md', 'wiki/sources/Index Funds.md', 'wiki/meta/reading-list.md', 'wiki/meta/domains.md']) {
      expect(isMetaPage(p), p).toBe(false)
    }
  })

  it('contentPages filters a committed list down to what the run added', () => {
    expect(contentPages(['wiki/log.md', 'wiki/index.md', 'wiki/concepts/Foo.md'])).toEqual(['wiki/concepts/Foo.md'])
    expect(contentPages(['wiki/log.md'])).toEqual([])
    expect(contentPages([])).toEqual([])
  })
})
