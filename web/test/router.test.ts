/**
 * The page routes (web/src/lib/router.ts): the graph's viewer and the Catalog's reading pane
 * each have one, and neither may read the other's.
 */

import { describe, expect, it } from 'vitest'
import { catalogPageFromPath, catalogPageRoute, pageFromPath, pageRoute } from '../src/lib/router.ts'

describe('page routes', () => {
  it('round-trips a page path with spaces and slashes, in both viewers', () => {
    const p = 'wiki/sources/A Paper (2026).md'
    expect(pageFromPath(pageRoute(p))).toBe(p)
    expect(catalogPageFromPath(catalogPageRoute(p))).toBe(p)
    expect(catalogPageRoute(p)).toBe('/catalog/page/wiki/sources/A%20Paper%20(2026).md')
  })

  it('keeps the two apart: a catalog page is not a graph page, and the catalog list is no page', () => {
    expect(pageFromPath('/catalog/page/wiki/x.md')).toBeNull()
    expect(catalogPageFromPath('/page/wiki/x.md')).toBeNull()
    expect(catalogPageFromPath('/catalog')).toBeNull()
    expect(catalogPageFromPath('/catalog?domain=x')).toBeNull()
  })
})
