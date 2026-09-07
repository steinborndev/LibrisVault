/**
 * The control column while a department's window is open (docs/agents/SPEC.md section 10.5).
 *
 * The Library's own column - Fellows, Rooms, Departments - answers for the room, and none
 * of it applies once a window covers it. Rather than dim a dead column, it becomes the
 * department's own: the list on top switches which department the window shows, and under
 * it stands what one would want to know before opening a shelf - its size and shape, who
 * works here, what ran last, and which documents it was written from.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import type { GraphNode, SceneDepartment, SceneRoom, VaultGraph } from '../../api/types.ts'
import { domainColor } from '../GraphCanvas.tsx'
import { signText } from '../../lib/library/room.ts'
import { sourceLink } from '../../lib/sources.ts'
import { STUB_BYTES } from '../../lib/domains.ts'
import { timeAgo } from '../../lib/format.ts'
import { Icon } from '../Icon.tsx'

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
  const recent = useMemo(
    () => [...pages].filter((n) => n.mtimeMs !== undefined).sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)).slice(0, 3),
    [pages],
  )
  const fellows = (scene.data?.fellows ?? []).filter((f) => f.homeDomain === domain && f.state !== 'retired')

  /** The documents this department was written from, most-cited first. */
  const documents = useMemo(() => {
    const refs = sources.data?.pages
    if (refs === undefined) return []
    const counts = new Map<string, { ref: NonNullable<ReturnType<typeof sourceLink>>; n: number }>()
    for (const p of paths) {
      const link = sourceLink(refs[p])
      if (link === null) continue
      const key = link.href
      const seen = counts.get(key)
      if (seen) seen.n += 1
      else counts.set(key, { ref: link, n: 1 })
    }
    return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 5)
  }, [sources.data, paths])


  const byRoom = (id: string): SceneDepartment[] => departments.filter((d) => d.room === id).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  const unplaced = departments.filter((d) => d.room === null)

  return (
    <>
      <div className="gp-sec">
        <div className="gp-head">
          <span className="gp-eyebrow">Departments</span>
        </div>
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
          <div>
            <b>{documents.reduce((n, d) => n + d.n, 0)}</b> sourced
          </div>
        </div>
        {recent.length > 0 && (
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
        )}
      </div>

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

      <div className="gp-sec grow">
        {documents.length > 0 && (
          <>
            <div className="gp-head">
              <span className="gp-eyebrow">Documents</span>
            </div>
            <ul className="shelf-docs">
              {documents.map((d) => (
                <li key={d.ref.href}>
                  <a href={d.ref.href} title={d.ref.title} target="_blank" rel={d.ref.external ? 'noreferrer noopener' : undefined}>
                    <Icon name={d.ref.icon} />
                    <span className="nm">{d.ref.title.replace(/^Open the (ingested document|source at): ?/, '')}</span>
                  </a>
                  <span className="n">{d.n}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  )
}
