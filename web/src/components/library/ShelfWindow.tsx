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

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import type { GraphNode } from '../../api/types.ts'
import { CatalogTable } from '../../tabs/Catalog.tsx'
import { DeepenDialog } from './DeepenDialog.tsx'
import { Markdown } from '../Markdown.tsx'
import { PageLink } from '../PageLink.tsx'
import { GraphCanvas, TYPE_VARS } from '../GraphCanvas.tsx'
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

/** One department narrowed to a single page type, with the links inside it re-indexed. */
export function narrow(sub: { nodes: readonly GraphNode[]; edges: ReadonlyArray<readonly [number, number]> }, type: string | null): { nodes: GraphNode[]; edges: Array<[number, number]> } {
  if (type === null) return { nodes: [...sub.nodes], edges: sub.edges.map(([a, b]) => [a, b] as [number, number]) }
  const keep = new Map<number, number>()
  const nodes: GraphNode[] = []
  sub.nodes.forEach((n, i) => {
    if (n.type !== type) return
    keep.set(i, nodes.length)
    nodes.push(n)
  })
  const edges: Array<[number, number]> = []
  for (const [a, b] of sub.edges) {
    const x = keep.get(a)
    const y = keep.get(b)
    if (x !== undefined && y !== undefined && x !== y) edges.push([x, y])
  }
  return { nodes, edges }
}

export function ShelfWindow({
  domain,
  vaultName,
  pane,
  page,
  layoutKey = '',
  onPage,
  onCounts,
}: {
  domain: string
  vaultName: string
  /** Which of the two views is showing; the screen's headline switches it. */
  pane: Pane
  /** Changes when the space around the canvas does, so the graph refits instead of sitting off centre. */
  layoutKey?: string
  /** The page being read inside the window, or null for the view itself. */
  page?: string | null
  onPage: (path: string | null) => void
  /** Reports the department's size, for the line in the headline. */
  onCounts?: (counts: { pages: number; links: number }) => void
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [srcOnly, setSrcOnly] = useState(false)
  /**
   * The canvas keeps its pan and zoom across mounts (it is module state shared with the
   * Graph screen). A department opened again should start fitted, not where the last look
   * left it, so every mount gets a fit key of its own.
   */
  const [openedAt] = useState(() => Date.now())
  /** Bumped by the Fit button in the band; the canvas fits whenever its key changes. */
  const [fitNonce, setFitNonce] = useState(0)
  /** Deepening this department: the shelf you opened already picked the domain. */
  const [deepening, setDeepening] = useState(false)
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

  /** The subgraph the graph draws: the department, narrowed to one page type when the legend picks one. */
  const drawn = useMemo(() => (type === null ? sub : narrow(sub, type)), [sub, type])

  useEffect(() => {
    onCounts?.({ pages: sub.nodes.length, links: sub.edges.length })
  }, [sub.nodes.length, sub.edges.length, onCounts])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sub.nodes
      .filter((n) => (type === null || n.type === type) && (!srcOnly || (refs !== undefined && refs[n.path] !== undefined)) && (q === '' || n.title.toLowerCase().includes(q)))
      .sort((a, b) => b.in + b.out - (a.in + a.out))
  }, [sub.nodes, query, type, srcOnly, refs])

  const state = queryState(graph, 'the graph')

  return (
    <div className="lib-window shelf-window" role="dialog" aria-label={`${signText(domain)} department`}>
      {page != null && <PagePane path={page} vaultName={vaultName} onOpenPage={onPage} />}

      {/*
       * One filter band, directly under the headline, the same in both views. It used to be a
       * legend floating in the graph's bottom left and a row on top of the catalog, so the
       * control for one job moved when the view changed. The colour that was the legend's
       * point rides on the chips.
       */}
      {page != null ? null : (
        /*
         * Three parts, not one wrapping row: the filters take what they need and wrap among
         * themselves, the count keeps the middle, and the actions stay on the right. As one
         * flex row the Deepen button fell to a second line and landed on the LEFT, under the
         * chips, which is the one place it does not belong.
         */
        <div className="shelf-filter">
          <div className="sf-filters">
            <input className="input sm" type="search" value={query} placeholder="Filter this department…" aria-label="Filter pages" onChange={(e) => setQuery(e.target.value)} />
            {kinds.map(([kind, n]) => (
              <button key={kind} className="chip" aria-pressed={type === kind} title={`Show only ${kind}`} onClick={() => setType(type === kind ? null : kind)}>
                <i className="chip-dot" style={{ background: `var(${TYPE_VARS[kind] ?? '--type-meta'})` }} aria-hidden />
                {kind} {n}
              </button>
            ))}
            <button className="chip" aria-pressed={srcOnly} onClick={() => setSrcOnly(!srcOnly)} title="Only pages written from an ingested document">
              has a source {withSource}
            </button>
          </div>
          <span className="box-sub sf-count">
            {rows.length} of {sub.nodes.length} page(s)
          </span>
          <div className="sf-actions">
            {pane === 'graph' && (
              <button className="btn ghost sm" onClick={() => setFitNonce((n) => n + 1)} title="Fit the view to the department (f)">
                Fit
              </button>
            )}
            {/* Opening a shelf already chose the domain, so the dialog needs no domain step. */}
            <button className="btn sm" onClick={() => setDeepening(true)} title={`Have the Fellow of ${domain} append to its thinnest, most linked pages`}>
              Deepen this domain
            </button>
          </div>
        </div>
      )}
      {deepening && <DeepenDialog domain={domain} onClose={() => setDeepening(false)} />}

      {page != null ? null : pane === 'graph' ? (
        <div className="shelf-graph">
          {state ?? (
            <GraphCanvas
              nodes={drawn.nodes}
              edges={drawn.edges}
              focusIndex={null}
              matches={new Set()}
              lens="type"
              fitKey={`shelf-${domain}-${drawn.nodes.length}-${type ?? 'all'}-${openedAt}-${layoutKey}-${fitNonce}`}
              openOnClick
              fitOnMount
              onSelect={(node) => onPage(node.path)}
              onOpen={(node) => onPage(node.path)}
            />
          )}
        </div>
      ) : (
        <div className="shelf-table">
          {state ?? (rows.length === 0 ? <div className="empty">Nothing matches these filters.</div> : <CatalogTable nodes={rows} refs={refs} vaultName={vaultName} hideDomain onOpenPage={onPage} />)}
        </div>
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
