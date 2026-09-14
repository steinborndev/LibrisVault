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
import {
  copySize,
  copyVerified,
  searchMiss,
  copyVersionWords,
  hasUsableCopy,
  isReachable,
  reachLabel,
  readingView,
  type ReadingReach,
  type ReadingTab,
} from '../../lib/readingList.ts'
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
  /*
   * "Find open-access": the service asks the resolvers AND opens the best copy, so this takes a
   * few seconds and the row says so while it runs. A find is written into the entry, which is
   * why the answer only has to invalidate the list.
   */
  const findOa = useMutation({
    mutationFn: (url: string) => api.findOpenAccess(url),
    onSuccess: (res, url) => {
      setSearched((prev) => ({ ...prev, [url]: res.found ? '' : (res.reason ?? 'no open copy found') }))
      void qc.invalidateQueries({ queryKey: ['reading-list'] })
    },
    onError: (err: Error, url) => setSearched((prev) => ({ ...prev, [url]: err.message })),
  })
  // Opens on what the service can fetch: a paywalled row's Ingest would fail the same way
  // the run did, so those wait behind their own third of the toggle.
  const [reach, setReach] = useState<ReadingReach>('open')
  /** What the last search said, per entry url, so a miss is visible until the next look. */
  const [searched, setSearched] = useState<Record<string, string>>({})
  const state = queryState(list, 'the reading list')
  const entries = list.data?.entries ?? []
  const view = readingView(entries, reach, tab)

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
              <div className="seg sm ink reading-reach" role="radiogroup" aria-label="Access">
                <button role="radio" aria-checked={reach === 'open'} onClick={() => setReach('open')} title="Open access, and hosts the service knows nothing about: what Ingest can fetch">
                  Open source
                </button>
                <button
                  role="radio"
                  aria-checked={reach === 'paywalled'}
                  onClick={() => setReach('paywalled')}
                  title="Behind a subscription, or a run could not fetch it. The service cannot get these either; the link and your own access can."
                >
                  Paywalled
                </button>
                <button role="radio" aria-checked={reach === 'both'} onClick={() => setReach('both')} title="Every entry, whatever its access">
                  Both
                </button>
              </div>
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
                      {/* What the last search said, until the next one: a miss is worth seeing. */}
                      {searched[e.url] ? (
                        /* In the warning tone: the click DID something, and a row that looks
                           unchanged after a search reads as a button that did nothing. */
                        <span className="rl-miss" title={searched[e.url]!}>
                          {' · '}
                          {searchMiss(searched[e.url]!)}
                        </span>
                      ) : (
                        ''
                      )}
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
                      /*
                       * The paywalled row carries two actions side by side: what the service can
                       * do about the copy, and the address for your own access. They stay on one
                       * line - `.rl-act` never wraps and every `.btn` is nowrap.
                       */
                      <>
                        {hasUsableCopy(e) ? (
                          /*
                           * A copy is on record (docs/sources/SPEC.md 6.3). The click is the
                           * ORDINARY ingest of the entry's own url: the job meets the same wall
                           * the Fellow did and is rescued from the copy already cached, with the
                           * full disclosure on the page. No second door, and nothing here has to
                           * know the copy's address. The checkmark says the copy was OPENED and
                           * measured, which only this button's own search does.
                           */
                          <button
                            className="btn sm"
                            disabled={ingest.isPending}
                            title={
                              `The requested address stays the source's own; the text comes from the open copy ` +
                              `(${copyVersionWords(e.oa?.version ?? null)}) at ${host(e.oa?.url ?? '')}, and the page says so.` +
                              (copyVerified(e)
                                ? ` Verified: ${copySize(e) ?? ''} of text.`
                                : ' Found by the night shift, which asks the resolvers rather than opening the copy.')
                            }
                            onClick={() => ingest.mutate(e.url)}
                          >
                            <Icon name={copyVerified(e) ? 'check' : 'upload'} />
                            Fetch open access
                          </button>
                        ) : e.oaEligible ? (
                          <button
                            className="btn sm"
                            disabled={findOa.isPending}
                            title="Ask OpenAlex, Europe PMC and CORE whether a legal open copy of this publication exists, fetch it and measure it. Nothing is ingested yet."
                            onClick={() => findOa.mutate(e.url)}
                          >
                            <Icon name="search" />
                            {findOa.isPending && findOa.variables === e.url ? 'Searching…' : 'Find open-access'}
                          </button>
                        ) : null}
                        <a
                          className="btn sm"
                          href={e.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          title="The service cannot fetch this one. Open it with your own access and drop the file into the vault; it goes through the ordinary ingest from there."
                        >
                          <Icon name="link" />
                          Open URL
                        </a>
                      </>
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
