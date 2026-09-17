/**
 * One resolver for `[[wikilinks]]`, used by every view that reads a vault page.
 *
 * The Catalog's article and the record's article show the SAME page; a link that works in one
 * and is plain text in the other is the kind of difference nobody can explain later. So the
 * rule lives once: title to path, first wins, case-insensitive - the same rule the graph's
 * viewer and the server use, so no reader can send a wikilink somewhere another would not.
 */

import type { GraphNode } from '../api/types.ts'
import type { WikilinkRenderer } from '../components/Markdown.tsx'
import { catalogPageRoute, navigate } from './router.ts'

/** Title to path, the way the server indexes pages. */
export function titleIndex(nodes: readonly GraphNode[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const n of nodes) {
    const key = n.title.toLowerCase()
    if (!index.has(key)) index.set(key, n.path)
  }
  return index
}

/**
 * A wikilink renderer over that index: a link into the Catalog when the page exists, and text
 * that says why when it does not. A page the vault does not have is not a broken link in the
 * app's sense - it is a gap the graph already reports.
 */
export function wikilinkResolver(nodes: readonly GraphNode[]): WikilinkRenderer {
  const index = titleIndex(nodes)
  return (target, label, key) => {
    const resolved = index.get(target.toLowerCase())
    return resolved !== undefined ? (
      <a
        key={key}
        className="wikilink"
        href={catalogPageRoute(resolved)}
        onClick={(e) => {
          e.preventDefault()
          navigate(catalogPageRoute(resolved))
        }}
      >
        {label}
      </a>
    ) : (
      <span key={key} className="wikilink unresolved" title="This page doesn't exist (yet)">
        {label}
      </span>
    )
  }
}
