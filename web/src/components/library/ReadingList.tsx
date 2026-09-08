/**
 * The reading list board (docs/agents/SPEC.md section 10.6): the publications the Fellows
 * read on the web and thought worth having in the original.
 *
 * A research step writes the entry, never the document: letting an agent download would
 * step around the SSRF guard, the size cap and the magic-byte check that every ingest goes
 * through, and a run reads pages written by strangers. So each row offers the ingest as one
 * click, and the service fetches it the ordinary way.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import { queryState } from '../QueryState.tsx'
import { Icon } from '../Icon.tsx'
import { domainColor } from '../GraphCanvas.tsx'
import { signText } from '../../lib/library/room.ts'
import { isReachable, reachLabel, readingView, type ReadingTab } from '../../lib/readingList.ts'
import { PageLink } from '../PageLink.tsx'

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function ReadingList({ vaultName, tab = 'current' }: { vaultName: string; tab?: ReadingTab }): React.ReactElement {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['reading-list'], queryFn: api.readingList, refetchInterval: 20_000 })
  const ingest = useMutation({
    mutationFn: (url: string) => api.ingestReading(url),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reading-list'] })
      void qc.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
  const archive = useMutation({
    mutationFn: ({ url, archived }: { url: string; archived: boolean }) => api.archiveReading(url, archived),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reading-list'] }),
  })
  // Off by default: a paywalled row's Ingest would fail the same way the run did.
  const [showPaywalled, setShowPaywalled] = useState(false)
  const state = queryState(list, 'the reading list')
  const entries = list.data?.entries ?? []
  const view = readingView(entries, showPaywalled, tab)

  return (
    <div className="lib-window-body reading">
      {state ??
        (view.shown.length === 0 && view.hidden === 0 ? (
          <div className="empty">
            <h2>{tab === 'archived' ? 'Nothing archived' : 'Nothing on the list yet'}</h2>
            <p className="qs-line">
              {tab === 'archived'
                ? 'Entries you archive land here. They keep what they asked for and why, and can be put back.'
                : 'A research step writes down every publication it read and thought worth the original. The page is wiki/meta/reading-list.md.'}
            </p>
          </div>
        ) : (
          <>
            <div className="reading-head">
              <p className="reading-lede">
                {tab === 'archived' ? (
                  <>
                    {view.shown.length} archived publication(s). They are out of the current list, not off the page:
                    each still carries what a Fellow asked for and why.
                  </>
                ) : (
                  <>
                    {view.shown.length} publication(s) the Fellows found, {view.waiting} of them not ingested. Reading
                    one in full is your call: the service fetches it, checks it and files it like any other source.
                  </>
                )}
              </p>
              <button
                className="chip"
                aria-pressed={showPaywalled}
                onClick={() => setShowPaywalled(!showPaywalled)}
                title="Publications behind a subscription, or ones a run could not fetch. The service cannot get them either; the link and your own access can."
              >
                Show paywalled
                {view.hidden > 0 && !showPaywalled ? ` · ${view.hidden}` : ''}
              </button>
            </div>
            <ul className="reading-rows">
              {view.shown.map((e) => (
                <li key={e.url}>
                  <div className="rl-main">
                    <div className="rl-title">
                      {e.domain !== null && <span className="chip-dot" style={{ background: domainColor(e.domain) }} aria-hidden />}
                      <a href={e.url} target="_blank" rel="noreferrer noopener" title={e.url}>
                        {e.title}
                      </a>
                      {e.ref !== null && <span className="rl-ref">{e.ref}</span>}
                    </div>
                    {e.why !== null && <p className="rl-why">{e.why}</p>}
                    <p className="rl-meta">
                      {host(e.url)}
                      {e.domain !== null ? ` · ${signText(e.domain)}` : ''}
                      {e.by !== null ? ` · found by ${e.by}${e.at !== null ? `, ${e.at}` : ''}` : e.found !== null ? ` · found by ${e.found}` : ''}
                      {reachLabel(e) !== null ? ` · ${reachLabel(e)}` : ''}
                    </p>
                    {e.page !== null && (
                      <p className="rl-filed">
                        In the vault as <PageLink vaultName={vaultName} path={e.page} />
                        {e.job === null ? (e.via === 'ref' ? ' · matched by its identifier' : e.via === 'url' ? ' · matched by its source url' : e.via === 'file' ? ' · matched by the file name it was downloaded as' : '') : ''}
                      </p>
                    )}
                  </div>
                  <div className="rl-act">
                    {e.page !== null && e.job === null ? (
                      // Recognized by its DOI or arXiv id: the document is in the vault even
                      // though no ingest ever ran for this url - the user fetched it by hand.
                      <span className="chip ok" title={`in the vault as ${e.page}`}>
                        in the vault
                      </span>
                    ) : e.job === null && !isReachable(e) ? (
                      <a
                        className="btn sm"
                        href={e.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        title="The service cannot fetch this one. Open it with your own access and drop the file into the vault; it goes through the ordinary ingest from there."
                      >
                        <Icon name="link" />
                        Open
                      </a>
                    ) : e.job === null ? (
                      <button
                        className="btn sm"
                        disabled={ingest.isPending}
                        title="The service downloads it, checks it, and files it as a source"
                        onClick={() => ingest.mutate(e.url)}
                      >
                        <Icon name="upload" />
                        Ingest
                      </button>
                    ) : e.job?.status === 'done' ? (
                      <span className="chip ok" title={`${e.job.pages} page(s) written`}>
                        ingested · {e.job.pages} page(s)
                      </span>
                    ) : e.job?.status === 'failed' ? (
                      <button className="btn ghost sm" disabled={ingest.isPending} onClick={() => ingest.mutate(e.url)}>
                        retry
                      </button>
                    ) : (
                      <span className="chip">{e.job.status}</span>
                    )}
                    {/*
                     * A mark, not a removal: the entry keeps the request and the reason a
                     * Fellow wrote down, and the archived list is where it goes. Reversible,
                     * because a one-way button beside an Ingest button is a trap.
                     */}
                    <button
                      className="btn ghost sm rl-arch"
                      disabled={archive.isPending}
                      aria-label={tab === 'archived' ? `Restore ${e.title}` : `Archive ${e.title}`}
                      title={
                        tab === 'archived'
                          ? 'Put it back on the current list'
                          : 'Out of the current list and into Archived. The entry is kept, with what it asked for and why.'
                      }
                      onClick={() => archive.mutate({ url: e.url, archived: tab !== 'archived' })}
                    >
                      <Icon name={tab === 'archived' ? 'retry' : 'archive'} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ))}
      {ingest.error != null && <div className="toast err">{(ingest.error as Error).message}</div>}
      {archive.error != null && <div className="toast err">{(archive.error as Error).message}</div>}
    </div>
  )
}
