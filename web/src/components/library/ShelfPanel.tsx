/**
 * The control column while a department's window is open (docs/agents/SPEC.md section 10.5).
 *
 * The Library's own column - Fellows, Rooms, Departments - answers for the room, and none
 * of it applies once a window covers it. Rather than dim a dead column, it becomes the
 * department's own, in the order a reader asks: what is IN this department, who works here,
 * and only then the other departments to switch to, under their wing names.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import type { GraphNode, SceneDepartment, SceneRoom, VaultGraph } from '../../api/types.ts'
import { domainColor } from '../GraphCanvas.tsx'
import { signText } from '../../lib/library/room.ts'
import { sourceLink } from '../../lib/sources.ts'
import { hasSource } from '../../lib/catalogSourceFilter.ts'
import { STUB_BYTES } from '../../lib/domains.ts'
import { timeAgo } from '../../lib/format.ts'

/** Gaps a department owns: page names its own pages link to but nobody has written. */
function gapsOf(graph: VaultGraph | undefined, paths: ReadonlySet<string>): number {
  if (graph === undefined) return 0
  return graph.gaps.filter((g) => g.refBy.some((i) => paths.has(graph.nodes[i]?.path ?? ''))).length
}

export function ShelfPanel({
  domain,
  rooms,
  departments,
  onPick,
  onOpenPage,
  onOpenFellow,
}: {
  domain: string
  rooms: readonly SceneRoom[]
  departments: readonly SceneDepartment[]
  onPick: (domain: string) => void
  /** A page named here opens in the window, the same way a row or a node does. */
  onOpenPage: (path: string) => void
  /** A Fellow named here opens its card. */
  onOpenFellow?: (agentId: string) => void
}): React.ReactElement {
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  const scene = useQuery({ queryKey: ['library-scene'], queryFn: api.libraryScene, staleTime: 5_000 })
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources })

  const pages = useMemo<GraphNode[]>(() => (graph.data?.nodes ?? []).filter((n) => n.domain === domain), [graph.data, domain])
  const paths = useMemo(() => new Set(pages.map((n) => n.path)), [pages])
  const stubs = pages.filter((n) => (n.size ?? 0) < STUB_BYTES).length
  const gaps = useMemo(() => gapsOf(graph.data, paths), [graph.data, paths])
  /** Five, and a section of their own: what changed here is a question, not a footnote. */
  const recent = useMemo(
    () => [...pages].filter((n) => n.mtimeMs !== undefined).sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)).slice(0, 5),
    [pages],
  )
  const fellows = (scene.data?.fellows ?? []).filter((f) => f.homeDomain === domain && f.state !== 'retired')

  /**
   * What stands behind this department: how many of its pages name a source, and how many
   * distinct documents that is.
   *
   * The page count is the SAME rule the Source column draws by (`hasSource`) - an ingested
   * document, or the address the page states for itself - so this figure, the window's "has a
   * source" pill and the Catalog cannot say three different things about one vault. It used to
   * be the sum over the five most-cited documents, a leftover from the list that stood in this
   * column: for one department it read 63 where the pill beside it read 370.
   *
   * Null while the index is in flight: 0 would be a claim, and there is none to make yet.
   */
  const provenance = useMemo(() => {
    const refs = sources.data?.pages
    if (refs === undefined) return null
    const docs = new Set<string>()
    let sourced = 0
    for (const n of pages) {
      if (hasSource(n, refs)) sourced += 1
      const link = sourceLink(refs[n.path])
      if (link !== null) docs.add(link.href)
    }
    return { sourced, documents: docs.size }
  }, [sources.data, pages])


  const byRoom = (id: string): SceneDepartment[] => departments.filter((d) => d.room === id).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  const unplaced = departments.filter((d) => d.room === null)

  return (
    <>
      <div className="gp-sec">
        <div className="gp-head">
          <span className="gp-eyebrow">In this department</span>
        </div>
        <div className="shelf-facts">
          <div>
            <b>{pages.length}</b> pages
          </div>
          <div>
            <b>{stubs}</b> stubs
          </div>
          <div>
            <b>{gaps}</b> gaps
          </div>
          <div title={provenance === null ? undefined : `${provenance.sourced} of ${pages.length} pages name a source, from ${provenance.documents} distinct documents`}>
            <b>{provenance === null ? '-' : provenance.sourced}</b> sourced
          </div>
        </div>
      </div>

      {recent.length > 0 && (
        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Last edits</span>
          </div>
          <ul className="shelf-list">
            {recent.map((n) => (
              <li key={n.path}>
                <button className="nm linkish" onClick={() => onOpenPage(n.path)} title={`Read ${n.title}`}>
                  {n.title}
                </button>
                <span className="when">{timeAgo(new Date(n.mtimeMs!).toISOString())}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="gp-sec">
        <div className="gp-head">
          <span className="gp-eyebrow">Fellows here</span>
        </div>
        {fellows.length === 0 ? (
          <p className="mono-meta">No Fellow covers this domain. A request from another one would show up in the recap.</p>
        ) : (
          fellows.map((f) => (
            // A Fellow named here is a Fellow you may want to look at: the row opens its card.
            <button key={f.agentId} className="shelf-fellow" onClick={() => onOpenFellow?.(f.agentId)} title={`Open ${f.name}`}>
              <span className="av" aria-hidden>
                {f.name.slice(0, 1)}
              </span>
              <span className="nm">{f.name}</span>
              <span className="st">{f.run ? (f.run.kind === 'plan' ? 'planning' : (f.run.label ?? f.run.kind)) : (f.sleepReason ?? f.state)}</span>
            </button>
          ))
        )}
      </div>

      {/* The other departments, under their wing names. No eyebrow of its own: the section
          at the top already says which department this is, and the wing names are the
          headings this list needs. It takes the leftover height and scrolls, because it is
          the one part of this column that grows with the vault. */}
      <div className="gp-sec grow">
        <div className="lib-deps">
          {rooms.map((r) => (
            <div key={r.id}>
              <div className="lib-grp">{r.name}</div>
              {byRoom(r.id).map((d) => (
                <button key={d.domain} className={`lib-drow pick${d.domain === domain ? ' on' : ''}`} onClick={() => onPick(d.domain)}>
                  <span className="dot" style={{ background: domainColor(d.domain) }} aria-hidden />
                  <span className="nm">{signText(d.domain)}</span>
                  <span className="n">{d.books + d.volumes}</span>
                </button>
              ))}
            </div>
          ))}
          {unplaced.length > 0 && (
            <div>
              <div className="lib-grp">Not on a shelf</div>
              {unplaced.map((d) => (
                <button key={d.domain} className={`lib-drow pick${d.domain === domain ? ' on' : ''}`} onClick={() => onPick(d.domain)}>
                  <span className="dot" style={{ background: domainColor(d.domain) }} aria-hidden />
                  <span className="nm">{signText(d.domain)}</span>
                  <span className="n">{d.books + d.volumes}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
