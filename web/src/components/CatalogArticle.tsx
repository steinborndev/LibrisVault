/**
 * One page, read inside the Catalog tab (second sweep, chunk 2): the route
 * `/catalog/page/<path>`. The graph's page view is where a page is edited and placed among
 * its links; this is where it is read next to the list it came from. A wikilink stays in the
 * tab, Escape and the arrow return to the list, and the graph is one button away.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { GraphNode } from '../api/types.ts'
import { Icon } from './Icon.tsx'
import { Markdown } from './Markdown.tsx'
import { PageLink } from './PageLink.tsx'
import { queryState } from './QueryState.tsx'
import { catalogPageRoute, navigate } from '../lib/router.ts'
import { obsidianUri } from '../lib/obsidian.ts'

export function CatalogArticle({
  path,
  vaultName,
  nodes,
  onBack,
}: {
  path: string
  vaultName: string
  /** The page index, for the title and for resolving wikilinks the way the graph's viewer does. */
  nodes: readonly GraphNode[]
  onBack: () => void
}): React.ReactElement {
  const page = useQuery({ queryKey: ['page-full', path], queryFn: () => api.pageFull(path) })
  const state = queryState(page, 'the page')
  const body = page.data ? page.data.markdown.replace(/^---[\s\S]*?\n---\n/, '') : ''
  const node = nodes.find((n) => n.path === path)
  const title = page.data?.title ?? node?.title ?? path.split('/').pop()?.replace(/\.md$/, '') ?? path
  // Title to path, first wins, case-insensitive: the same rule as the graph's viewer and the
  // server, so no viewer can send a wikilink somewhere another would not.
  const byTitle = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of nodes) {
      const key = n.title.toLowerCase()
      if (!m.has(key)) m.set(key, n.path)
    }
    return m
  }, [nodes])
  const linkTo = (target: string, label: string, key: string): React.ReactNode => {
    const resolved = byTitle.get(target.toLowerCase())
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

  return (
    <div className="ca">
      <div className="ca-head">
        <button className="btn ghost" onClick={onBack} title="Back to the catalog (same as Esc)">
          <Icon name="back" />
        </button>
        <h2 className="ca-title" title={title}>
          {title}
        </h2>
        {node && <span className="bucket">{node.type}</span>}
        <span className="spacer" />
        <button className="btn" onClick={() => navigate(`/graph?focus=${encodeURIComponent(path)}`)} title="Focus this page in the graph">
          <Icon name="graph" /> In graph
        </button>
        <a className="btn" href={obsidianUri(vaultName, path)} title="Open in Obsidian">
          <Icon name="link" /> Obsidian
        </a>
      </div>
      <div className="shelf-page">
        {state ?? (
          <article className="page-body">
            <Markdown source={body} renderWikilink={linkTo} />
            <p className="recap-foot">
              Vault page: <PageLink vaultName={vaultName} path={path} />
            </p>
          </article>
        )}
      </div>
    </div>
  )
}
