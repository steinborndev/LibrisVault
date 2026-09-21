/**
 * The pinboard of open questions (prototype 2026-09-17), on the reading list's model: the
 * headline draws a ring of stops - all domains first, then one per domain that has a question
 * - the arrows step it, up and down walk the rows, Escape steps back out. What this component
 * owns is which questions exist, so it reports the ring and the rows upward.
 *
 * Two actions on a row. "Start research" hands the question to the Research tab with the
 * topic filled in, where the lens is chosen and the run started - the question is not assigned
 * to a Fellow, it is researched now. Archive strikes the question through on its own page,
 * which is the convention the Fellows already honour, and vetoes the proposal a Fellow had
 * planned from it; the row says so before the click.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import { queryState } from '../QueryState.tsx'
import { Icon } from '../Icon.tsx'
import { domainColor } from '../GraphCanvas.tsx'
import { signText } from '../../lib/library/room.ts'
import { navigate } from '../../lib/router.ts'
import { archiveCluster, questionClusters, questionDomains, questionView, type QuestionCluster, type QuestionRow, type QuestionTab } from '../../lib/questions.ts'
import type { QuestionItem } from '../../api/types.ts'
import { PageLink } from '../PageLink.tsx'
import { Markdown, type WikilinkRenderer } from '../Markdown.tsx'
import { wikilinkResolver } from '../../lib/wikilink.tsx'

/**
 * Where "Start research" goes: the Research tab with the question as the topic, and the page it
 * stands on beside it. The run reads that page first, which is what resolves a question written
 * to be read in place ("in this pass", "either source") once it travels alone.
 */
export const researchRoute = (text: string, page?: string): string =>
  `/research?prefill=${encodeURIComponent(text)}${page !== undefined && page !== '' ? `&from=${encodeURIComponent(page)}` : ''}`

export function QuestionBoard({
  vaultName,
  tab = 'current',
  domain = null,
  row = 0,
  onDomains,
  onRows,
  onPick,
}: {
  vaultName: string
  tab?: QuestionTab
  /** One stop of the domain ring; null is "all domains", the stop the board opens on. */
  domain?: string | null
  /** The row the keys are on. */
  row?: number
  /** The ring, reported up: the headline draws it and the arrows walk it. */
  onDomains?: (domains: readonly string[]) => void
  /** The rows on show, so Enter can hand the selected one to Research exactly as its button does. */
  onRows?: (rows: readonly QuestionRow[]) => void
  onPick?: (row: number) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['questions'], queryFn: api.questions, refetchInterval: 20_000 })
  /*
   * Archiving a ROW archives every wording of it. Each member is its own page, its own vault
   * commit and its own lock, so the calls go one at a time and in order: they would queue on
   * the commit mutex anyway, and a failure halfway is easier to report than to untangle. What
   * is reported is what actually happened - the list is invalidated either way, so the board
   * shows the real state rather than an optimistic one.
   */
  const archive = useMutation({
    mutationFn: ({ members, archived }: { members: readonly QuestionItem[]; archived: boolean }) =>
      archiveCluster(members, archived, api.archiveQuestion),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['questions'] })
      // A veto changes what tonight holds, and the agents query is where tonight is read.
      void qc.invalidateQueries({ queryKey: ['agents'] })
    },
  })
  const state = queryState(list, 'the pinboard')
  /* `?? []` would be a fresh array on every render, which would make the memo below useless. */
  const entries = useMemo(() => list.data?.entries ?? [], [list.data])
  /* A question names pages the way the vault does, in [[brackets]]; the graph resolves them to
     links into the Catalog, and a title the vault does not have stays as text. */
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph, staleTime: 60_000 })
  const renderWikilink = useMemo(() => wikilinkResolver(graph.data?.nodes ?? []), [graph.data])
  /*
   * Clustering is quadratic in the number of questions, so it happens once per tab and the
   * domain cut is a filter over the result. Doing it per domain would also regroup the same
   * questions differently depending on which shelf you were standing at.
   */
  const clusters = useMemo(() => questionClusters(entries, tab), [entries, tab])
  const view = questionView(clusters, domain)
  const domains = questionDomains(clusters)

  const report = useRef<{ onDomains?: (d: readonly string[]) => void; onRows?: (r: readonly QuestionRow[]) => void }>({})
  report.current = { ...(onDomains ? { onDomains } : {}), ...(onRows ? { onRows } : {}) }
  const ringKey = domains.join('\n')
  /*
   * A row is an object now (question plus page), so it cannot be its own effect dependency the
   * way the joined text was: a fresh array every render would report on every render. The key
   * stays the string, and the rows themselves are read off a ref when it changes.
   */
  const rows: QuestionRow[] = view.shown.map((c) => ({ text: c.lead.text, page: c.lead.page }))
  const rowsKey = rows.map((r) => `${r.page}\t${r.text}`).join('\n')
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  useEffect(() => {
    report.current.onDomains?.(ringKey === '' ? [] : ringKey.split('\n'))
  }, [ringKey])
  useEffect(() => {
    report.current.onRows?.(rowsRef.current)
  }, [rowsKey])

  const selected = useRef<HTMLLIElement>(null)
  useEffect(() => {
    selected.current?.scrollIntoView({ block: 'nearest' })
  }, [row])

  return (
    <div className="lib-window-body reading">
      {state ??
        (view.shown.length === 0 ? (
          <div className="empty">
            <h2>{tab === 'archived' ? 'Nothing archived' : domain !== null ? `Nothing open in ${signText(domain)}` : 'Nothing open'}</h2>
            <p className="qs-line">
              {tab === 'archived'
                ? 'Questions you archive land here, struck through on their own page, and can be put back.'
                : domain !== null
                  ? 'Esc steps back to every domain.'
                  : 'A page leaves what it could not answer under "Open questions". None does right now.'}
            </p>
          </div>
        ) : (
          <>
            <div className="reading-head">
              <p className="reading-lede">
                {tab === 'archived' ? (
                  <>{view.total} archived question(s). Struck through on their pages: the Fellows plan nothing from them, and a restore puts one back.</>
                ) : (
                  <>
                    {view.total} open question(s){domain !== null ? ` in ${signText(domain)}` : ' across the vault'}
                    {view.planned > 0 ? `, ${view.planned} planned for tonight` : ''}
                    {view.researching > 0 ? `, ${view.researching} being researched` : ''}. Start research hands one to the Research tab; archiving closes it for the Fellows too.
                  </>
                )}
              </p>
              <span className="box-sub reading-what">what the pages left open</span>
            </div>
            <ul className="reading-rows questions">
              {view.shown.map((c, i) => (
                <li
                  key={c.id}
                  ref={i === row ? selected : null}
                  className={i === row ? 'on' : ''}
                  aria-current={i === row ? 'true' : undefined}
                  onClick={(ev) => {
                    if ((ev.target as HTMLElement).closest('a, button')) return
                    onPick?.(i)
                  }}
                >
                  <Row c={c} vaultName={vaultName} renderWikilink={renderWikilink} />
                  <div className="rl-act">
                    {tab === 'current' && (
                      <button
                        className="btn sm"
                        disabled={c.researching !== null}
                        title={c.researching !== null ? 'A research run on this question is in flight' : 'Open the Research tab with this question as the topic; pick a lens there and start the run'}
                        onClick={() => navigate(researchRoute(c.lead.text, c.lead.page))}
                      >
                        <Icon name="flask" />
                        {c.researching !== null ? 'Researching…' : 'Start research'}
                      </button>
                    )}
                    <button
                      className="btn ghost sm rl-arch"
                      disabled={archive.isPending}
                      aria-label={tab === 'archived' ? `Restore: ${c.lead.text}` : `Archive: ${c.lead.text}`}
                      title={
                        tab === 'archived'
                          ? restoreTitle(c)
                          : c.planned !== null
                            ? `${strikeTitle(c)}, and veto ${c.planned.fellow}'s proposal for tonight: a closed question is not researched`
                            : `${strikeTitle(c)}. The Fellows plan nothing from a struck question; a restore puts it back`
                      }
                      onClick={() => archive.mutate({ members: c.members, archived: tab !== 'archived' })}
                    >
                      <Icon name={tab === 'archived' ? 'retry' : 'archive'} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ))}
      {archive.error != null && <div className="toast err">{(archive.error as Error).message}</div>}
    </div>
  )
}

/** What the archive button promises, in the singular or for every wording at once. */
const strikeTitle = (c: QuestionCluster): string =>
  c.members.length === 1
    ? 'Strike it through on its page'
    : `Strike it through on all ${c.members.length} pages it was written on`
const restoreTitle = (c: QuestionCluster): string =>
  c.members.length === 1
    ? 'Take the strike off on its page: the question is open again, for the Fellows too'
    : `Take the strike off on all ${c.members.length} pages: the question is open again, for the Fellows too`

function Row({ c, vaultName, renderWikilink }: { c: QuestionCluster; vaultName: string; renderWikilink: WikilinkRenderer }): React.ReactElement {
  const e = c.lead
  /* Where else the same question was written. One run tends to leave it on its notebook, its
     synthesis page and the concept page it touched, so the board used to show it three times. */
  const others = c.members.filter((m) => m !== e)
  return (
    <div className="rl-main">
      <div className="rl-title">
        <span className="chip-dot" style={{ background: e.domain !== null ? domainColor(e.domain) : 'var(--border-strong)' }} aria-hidden />
        <span className="q-text" title={e.text}>
          <Markdown source={e.text} renderWikilink={renderWikilink} />
        </span>
      </div>
      <p className="rl-meta">
        <PageLink vaultName={vaultName} path={e.page} />
        {e.domain !== null ? ` · ${signText(e.domain)}` : ''}
        {others.length > 0 && (
          <>
            {' · '}
            <span title={`The same question, in other words, on: ${others.map((m) => m.page).join(', ')}`}>
              also on{' '}
              {others.map((m, i) => (
                <span key={m.id}>
                  {i > 0 ? ', ' : ''}
                  <PageLink vaultName={vaultName} path={m.page} />
                </span>
              ))}
            </span>
          </>
        )}
        {c.planned !== null && (
          <>
            {' · '}
            <span className="chip" title={`${c.planned.fellow} planned a run on this for tonight (${c.planned.status}); archiving vetoes it`}>
              planned tonight by {c.planned.fellow}
            </span>
          </>
        )}
        {c.researching !== null && (
          <>
            {' · '}
            <span className="chip ok">researching now</span>
          </>
        )}
      </p>
    </div>
  )
}
