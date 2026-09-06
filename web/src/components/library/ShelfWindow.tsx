/**
 * A shelf's window (docs/agents/SPEC.md section 10.5): clicking a department in the Library
 * used to leave for the Graph screen with a domain filter applied. It opens here instead,
 * over the room, in the same frame - the two views that answer for a department, both
 * already filtered and stripped of everything that belongs to the full screens.
 *
 *   Graph     the department's own pages and the links inside it, on the shared canvas
 *   Catalog   the same pages as rows, with the source column that opens the ingested document
 *
 * A page opens as a third level inside the same window - from a node on the canvas, a row
 * in the table, or a line in the column. Escape steps back one level at a time: the page
 * closes to the view it came from, the view to the room.
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import type { GraphNode } from '../../api/types.ts'
import { CatalogTable } from '../../tabs/Catalog.tsx'
import { Markdown } from '../Markdown.tsx'
import { PageLink } from '../PageLink.tsx'
import { GraphCanvas, domainColor, TYPE_VARS } from '../GraphCanvas.tsx'
import { queryState } from '../QueryState.tsx'
import { signText } from '../../lib/library/room.ts'

type Pane = 'graph' | 'catalog'

/** The pages of one domain, and the links between them, as indices into that subset. */
export function subgraph(nodes: readonly GraphNode[], edges: ReadonlyArray<readonly [number, number]>, domain: string): { nodes: GraphNode[]; edges: Array<[number, number]> } {
  const keep = new Map<number, number>()
  const out: GraphNode[] = []
  nodes.forEach((n, i) => {
    if (n.domain !== domain) return
    keep.set(i, out.length)
    out.push(n)
  })
  const inner: Array<[number, number]> = []
  for (const [a, b] of edges) {
    const x = keep.get(a)
    const y = keep.get(b)
    if (x !== undefined && y !== undefined && x !== y) inner.push([x, y])
  }
  return { nodes: out, edges: inner }
}

export function ShelfWindow({
  domain,
  vaultName,
  pane: initial = 'graph',
  page,
  onPage,
  onClose,
}: {
  domain: string
  vaultName: string
  pane?: Pane
  /** The page being read inside the window, or null for the view itself. */
  page?: string | null
  onPage: (path: string | null) => void
  onClose: () => void
}): React.ReactElement {
  const [pane, setPane] = useState<Pane>(initial)
  const [query, setQuery] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [srcOnly, setSrcOnly] = useState(false)
  /** A node picked on the canvas: the window names it under the graph. */
  const [selected, setSelected] = useState<string | null>(null)
  /**
   * The canvas keeps its pan and zoom across mounts (it is module state shared with the
   * Graph screen). A department opened again should start fitted, not where the last look
   * left it, so every mount gets a fit key of its own.
   */
  const [openedAt] = useState(() => Date.now())
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources })

  const sub = useMemo(
    () => (graph.data ? subgraph(graph.data.nodes, graph.data.edges, domain) : { nodes: [], edges: [] }),
    [graph.data, domain],
  )
  const refs = sources.data?.pages
  const kinds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of sub.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [sub.nodes])
  const withSource = useMemo(() => (refs === undefined ? 0 : sub.nodes.filter((n) => refs[n.path] !== undefined).length), [sub.nodes, refs])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sub.nodes
      .filter((n) => (type === null || n.type === type) && (!srcOnly || (refs !== undefined && refs[n.path] !== undefined)) && (q === '' || n.title.toLowerCase().includes(q)))
      .sort((a, b) => b.in + b.out - (a.in + a.out))
  }, [sub.nodes, query, type, srcOnly, refs])

  const state = queryState(graph, 'the graph')

  return (
    <div className="lib-window shelf-window" role="dialog" aria-label={`${signText(domain)} department`}>
      <div className="box-head">
        <span className="chip-dot" style={{ background: domainColor(domain) }} aria-hidden />
        <h2 className="box-title">{signText(domain)}</h2>
        {page == null ? (
          <span className="box-sub">
            {sub.nodes.length} page(s) · {sub.edges.length} link(s) inside the department
          </span>
        ) : (
          <span className="box-sub">reading a page</span>
        )}
        <span className="spacer" />
        {page == null ? (
          <div className="seg sm" role="tablist" aria-label="View">
            <button role="tab" aria-selected={pane === 'graph'} onClick={() => setPane('graph')}>
              Graph
            </button>
            <button role="tab" aria-selected={pane === 'catalog'} onClick={() => setPane('catalog')}>
              Catalog
            </button>
          </div>
        ) : (
          <button className="btn ghost sm" onClick={() => onPage(null)}>
            Back to the {pane} · Esc
          </button>
        )}
        <button className="btn ghost sm" onClick={onClose}>
          {page == null ? 'Back to the room · Esc' : 'Back to the room'}
        </button>
      </div>

      {page != null && <PagePane path={page} vaultName={vaultName} onOpenPage={onPage} />}

      {page != null ? null : pane === 'graph' ? (
        <div className="shelf-graph">
          {state ?? (
            <GraphCanvas
              nodes={sub.nodes}
              edges={sub.edges}
              focusIndex={null}
              matches={new Set()}
              lens="type"
              fitKey={`shelf-${domain}-${sub.nodes.length}-${openedAt}`}
              onSelect={(node) => setSelected(node.path)}
              onOpen={(node) => onPage(node.path)}
            />
          )}
          {selected !== null && (
            <div className="shelf-picked">
              <button className="linkish" onClick={() => onPage(selected)}>
                {sub.nodes.find((n) => n.path === selected)?.title ?? selected}
              </button>
              <span className="box-sub">click again on the canvas to open it</span>
            </div>
          )}
          <div className="shelf-legend">
            {kinds.slice(0, 5).map(([kind, n]) => (
              <span key={kind}>
                <i style={{ background: `var(${TYPE_VARS[kind] ?? '--type-meta'})` }} />
                {kind} {n}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="shelf-filter">
            <input className="input sm" type="search" value={query} placeholder="Filter this department…" aria-label="Filter pages" onChange={(e) => setQuery(e.target.value)} />
            {kinds.map(([kind, n]) => (
              <button key={kind} className="chip" aria-pressed={type === kind} onClick={() => setType(type === kind ? null : kind)}>
                {kind} {n}
              </button>
            ))}
            <button className="chip" aria-pressed={srcOnly} onClick={() => setSrcOnly(!srcOnly)} title="Only pages written from an ingested document">
              has a source {withSource}
            </button>
            <span className="spacer" />
            <span className="box-sub">
              {rows.length} of {sub.nodes.length} page(s)
            </span>
          </div>
          <div className="shelf-table">
            {state ?? (rows.length === 0 ? <div className="empty">Nothing matches these filters.</div> : <CatalogTable nodes={rows} refs={refs} vaultName={vaultName} hideDomain onOpenPage={onPage} />)}
          </div>
        </>
      )}
    </div>
  )
}

/** One page, read inside the window: the vault's markdown, its wikilinks still live. */
function PagePane({ path, vaultName, onOpenPage }: { path: string; vaultName: string; onOpenPage: (path: string | null) => void }): React.ReactElement {
  const page = useQuery({ queryKey: ['page-full', path], queryFn: () => api.pageFull(path) })
  const state = queryState(page, 'the page')
  const body = page.data ? page.data.markdown.replace(/^---[\s\S]*?\n---\n/, '') : ''
  return (
    <div className="shelf-page">
      {state ?? (
        <article className="page-body">
          <Markdown source={body} />
          <p className="recap-foot">
            Vault page: <PageLink vaultName={vaultName} path={path} /> ·{' '}
            <button className="linkish" onClick={() => onOpenPage(null)}>
              back to the department
            </button>
          </p>
        </article>
      )}
    </div>
  )
}
