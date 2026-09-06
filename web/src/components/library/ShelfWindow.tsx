/**
 * A shelf's window (docs/agents/SPEC.md section 10.5): clicking a department in the Library
 * used to leave for the Graph screen with a domain filter applied. It opens here instead,
 * over the room, in the same frame - the two views that answer for a department, both
 * already filtered and stripped of everything that belongs to the full screens.
 *
 *   Graph     the department's own pages and the links inside it, on the shared canvas
 *   Catalog   the same pages as rows, with the source column that opens the ingested document
 *
 * Escape, handled by the Library, puts the room back.
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import type { GraphNode } from '../../api/types.ts'
import { CatalogTable } from '../../tabs/Catalog.tsx'
import { GraphCanvas, domainColor, TYPE_VARS } from '../GraphCanvas.tsx'
import { queryState } from '../QueryState.tsx'
import { signText } from '../../lib/library/room.ts'
import { navigate, pageRoute } from '../../lib/router.ts'

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

export function ShelfWindow({ domain, vaultName, pane: initial = 'graph', onClose }: { domain: string; vaultName: string; pane?: Pane; onClose: () => void }): React.ReactElement {
  const [pane, setPane] = useState<Pane>(initial)
  const [query, setQuery] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [srcOnly, setSrcOnly] = useState(false)
  /** A node picked on the canvas: the window names it under the graph. */
  const [selected, setSelected] = useState<string | null>(null)
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
        <span className="box-sub">
          {sub.nodes.length} page(s) · {sub.edges.length} link(s) inside the department
        </span>
        <span className="spacer" />
        <div className="seg sm" role="tablist" aria-label="View">
          <button role="tab" aria-selected={pane === 'graph'} onClick={() => setPane('graph')}>
            Graph
          </button>
          <button role="tab" aria-selected={pane === 'catalog'} onClick={() => setPane('catalog')}>
            Catalog
          </button>
        </div>
        <button className="btn ghost sm" onClick={onClose}>
          Back to the room · Esc
        </button>
      </div>

      {pane === 'graph' ? (
        <div className="shelf-graph">
          {state ?? (
            <GraphCanvas
              nodes={sub.nodes}
              edges={sub.edges}
              focusIndex={null}
              matches={new Set()}
              lens="type"
              fitKey={`shelf-${domain}-${sub.nodes.length}`}
              onSelect={(node) => setSelected(node.path)}
              onOpen={(node) => navigate(pageRoute(node.path))}
            />
          )}
          {selected !== null && (
            <div className="shelf-picked">
              <button className="linkish" onClick={() => navigate(pageRoute(selected))}>
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
            {state ?? (rows.length === 0 ? <div className="empty">Nothing matches these filters.</div> : <CatalogTable nodes={rows} refs={refs} vaultName={vaultName} hideDomain />)}
          </div>
        </>
      )}
    </div>
  )
}
