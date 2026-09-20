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
import { questionDomains, questionView, type QuestionRow, type QuestionTab } from '../../lib/questions.ts'
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
  const archive = useMutation({
    mutationFn: ({ page, text, archived }: { page: string; text: string; archived: boolean }) => api.archiveQuestion(page, text, archived),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['questions'] })
      // A veto changes what tonight holds, and the agents query is where tonight is read.
      void qc.invalidateQueries({ queryKey: ['agents'] })
    },
  })
  const state = queryState(list, 'the pinboard')
  const entries = list.data?.entries ?? []
  /* A question names pages the way the vault does, in [[brackets]]; the graph resolves them to
     links into the Catalog, and a title the vault does not have stays as text. */
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph, staleTime: 60_000 })
  const renderWikilink = useMemo(() => wikilinkResolver(graph.data?.nodes ?? []), [graph.data])
  const view = questionView(entries, tab, domain)
  const domains = questionDomains(questionView(entries, tab, null).shown)

  const report = useRef<{ onDomains?: (d: readonly string[]) => void; onRows?: (r: readonly QuestionRow[]) => void }>({})
  report.current = { ...(onDomains ? { onDomains } : {}), ...(onRows ? { onRows } : {}) }
  const ringKey = domains.join('\n')
  /*
   * A row is an object now (question plus page), so it cannot be its own effect dependency the
   * way the joined text was: a fresh array every render would report on every render. The key
   * stays the string, and the rows themselves are read off a ref when it changes.
   */
  const rows: QuestionRow[] = view.shown.map((e) => ({ text: e.text, page: e.page }))
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
              {view.shown.map((e, i) => (
                <li
                  key={e.id}
                  ref={i === row ? selected : null}
                  className={i === row ? 'on' : ''}
                  aria-current={i === row ? 'true' : undefined}
                  onClick={(ev) => {
                    if ((ev.target as HTMLElement).closest('a, button')) return
                    onPick?.(i)
                  }}
                >
                  <Row e={e} vaultName={vaultName} renderWikilink={renderWikilink} />
                  <div className="rl-act">
                    {tab === 'current' && (
                      <button
                        className="btn sm"
                        disabled={e.researching !== null}
                        title={e.researching !== null ? 'A research run on this question is in flight' : 'Open the Research tab with this question as the topic; pick a lens there and start the run'}
                        onClick={() => navigate(researchRoute(e.text, e.page))}
                      >
                        <Icon name="flask" />
                        {e.researching !== null ? 'Researching…' : 'Start research'}
                      </button>
                    )}
                    <button
                      className="btn ghost sm rl-arch"
                      disabled={archive.isPending}
                      aria-label={tab === 'archived' ? `Restore: ${e.text}` : `Archive: ${e.text}`}
                      title={
                        tab === 'archived'
                          ? 'Take the strike off on its page: the question is open again, for the Fellows too'
                          : e.planned !== null
                            ? `Strike it through on its page and veto ${e.planned.fellow}'s proposal for tonight: a closed question is not researched`
                            : 'Strike it through on its page. The Fellows plan nothing from a struck question; a restore puts it back'
                      }
                      onClick={() => archive.mutate({ page: e.page, text: e.text, archived: tab !== 'archived' })}
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

function Row({ e, vaultName, renderWikilink }: { e: QuestionItem; vaultName: string; renderWikilink: WikilinkRenderer }): React.ReactElement {
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
        {e.planned !== null && (
          <>
            {' · '}
            <span className="chip" title={`${e.planned.fellow} planned a run on this for tonight (${e.planned.status}); archiving vetoes it`}>
              planned tonight by {e.planned.fellow}
            </span>
          </>
        )}
        {e.researching !== null && (
          <>
            {' · '}
            <span className="chip ok">researching now</span>
          </>
        )}
      </p>
    </div>
  )
}
