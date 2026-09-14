/**
 * The Recap screen (docs/agents/SPEC.md section 9.3): the morning recap with its
 * proposals as buttons. `/recap` shows the latest, `/recap/<date>` one day. Every button
 * sends the same answer the Telegram grammar would (`1b`, `veto 1b`, `skip 1`, ...), so
 * the two channels can never disagree about what an answer does.
 *
 * Mounted only on an instance that has Fellows (`health.fellows`); Home's inbox entry and
 * the route are the two ways in.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { RecapAnswer, RecapAnswerResult, RecapFellow, RecapProposal, RecapRow, RecapUnclaimed } from '../api/types.ts'
import { Fact, Facts } from '../components/Fact.tsx'
import { PageLink } from '../components/PageLink.tsx'
import { queryState } from '../components/QueryState.tsx'
import { navigate } from '../lib/router.ts'
import { answerCode, undecidedCount } from '../lib/recap.ts'
import { fellowText } from '../lib/recapFeed.ts'
import { timeAgo, usd } from '../lib/format.ts'
import { domainColor } from '../lib/domains.ts'

const MODELS = ['sonnet-5', 'opus-5', 'fable-5-1']
const STEPS = ['small', 'standard', 'deep']

export function Recap({ date }: { date: string }): React.ReactElement {
  const qc = useQueryClient()
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'
  const recaps = useQuery({ queryKey: ['recaps'], queryFn: api.recaps, refetchInterval: 30_000 })
  const [toasts, setToasts] = useState<RecapAnswerResult[]>([])

  const rows = recaps.data?.recaps ?? []
  const current: RecapRow | undefined = date !== '' ? rows.find((r) => r.cycleDate === date) : rows[0]

  const answer = useMutation({
    mutationFn: (input: { date: string; answers: RecapAnswer[] }) => api.answerRecap(input.date, { answers: input.answers }),
    onSuccess: (res) => {
      setToasts(res.results)
      void qc.invalidateQueries({ queryKey: ['recaps'] })
      void qc.invalidateQueries({ queryKey: ['agents'] })
    },
  })
  const build = useMutation({
    mutationFn: (force: boolean) => api.buildRecap({ force }),
    onSuccess: () => {
      // The build runs in the background; the 30 s refetch picks the row up, this one sooner.
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['recaps'] }), 4_000)
    },
  })

  const send = (a: RecapAnswer): void => {
    if (!current) return
    answer.mutate({ date: current.cycleDate, answers: [a] })
  }
  const followed = (page: string, agentId: string): void => api.valueEvent({ kind: 'recap_link', page, agentId })

  const state = queryState(recaps, 'the recaps')
  const status = recaps.data?.status

  return (
    <div className="box">
      <div className="box-head">
        <h2 className="box-title">Recap{current ? ` · ${current.cycleDate}` : ''}</h2>
        <span className="box-sub">
          {status
            ? status.building
              ? 'building now…'
              : `next at ${status.recapTime} (${timeAgo(status.nextAt).replace('ago', 'from now')})`
            : ''}
        </span>
        <span className="spacer" />
        {rows.length > 0 && (
          <span className="pillrow" role="tablist" aria-label="Recap days">
            {rows.slice(0, 7).map((r) => (
              <button
                key={r.cycleDate}
                className={`chip${current?.cycleDate === r.cycleDate ? ' active' : ''}`}
                onClick={() => navigate(`/recap/${r.cycleDate}`)}
                title={r.quiet ? 'quiet day' : `${undecidedCount(r.model)} undecided`}
              >
                {r.cycleDate.slice(5)}
                {!r.quiet && undecidedCount(r.model) > 0 && <span className="chip-n">{undecidedCount(r.model)}</span>}
              </button>
            ))}
          </span>
        )}
        <button
          className="btn ghost sm"
          disabled={build.isPending || status?.building === true}
          onClick={() => build.mutate(current !== undefined && current.cycleDate === new Date().toISOString().slice(0, 10))}
          title="Build today's recap now, rebuilding it when today's exists. Costs a short agent run for the summary lines and rewrites the recap page in the vault; the proposals and Fellow states are current without it."
        >
          Build now
        </button>
        <button className="btn ghost sm" onClick={() => navigate('/')}>
          Back to Home
        </button>
      </div>

      {toasts.length > 0 && (
        <div className={`toast ${toasts.every((t) => t.ok) ? 'ok' : 'warn'}`} role="status">
          {toasts.map((t, i) => (
            <div key={i}>
              {t.ok ? '✓' : '✗'} {t.message}
            </div>
          ))}
        </div>
      )}
      {answer.error != null && <div className="toast err">Answer failed: {(answer.error as Error).message}</div>}

      <div className="box-body">
        {state ?? (current === undefined ? (
          <div className="empty">
            <h2>No recap yet</h2>
            <p className="qs-line">The first one is built at {status?.recapTime ?? '07:00'} and covers the night's Fellow runs and their proposals. Build one now to see today's.</p>
          </div>
        ) : (
          <RecapBody
            row={current}
            vaultName={vaultName}
            onAnswer={send}
            onFollow={followed}
            busy={answer.isPending}
            decidable={current.cycleDate === rows[0]?.cycleDate}
            results={toasts}
          />
        ))}
      </div>
    </div>
  )
}

export function RecapBody({
  row,
  vaultName,
  onAnswer,
  onFollow,
  busy,
  facts = true,
  only,
  settings = true,
  query = '',
  decidable = true,
  results = [],
  agentIdOf,
}: {
  row: RecapRow
  vaultName: string
  onAnswer: (a: RecapAnswer) => void
  onFollow: (page: string, agentId: string) => void
  busy: boolean
  /** The five lead figures. Home's feed shows them once, in the box, for the day in view. */
  facts?: boolean
  /**
   * Only these Fellows' sections, by name. Empty or absent is all of them. The feeds use it for
   * their Fellow filter, which takes more than one.
   */
  only?: readonly string[]
  /** The pause, model and step controls. Home's feed leaves them to the dossier (mockup 2026-09-11). */
  settings?: boolean
  /** The search box's text: only the Fellow sections and requests that say it. */
  query?: string
  /** False for a recap older than the newest: the record of its day, with no answers to give. */
  decidable?: boolean
  /** What the last answers came back with; each Fellow shows the lines that concern it. */
  results?: readonly RecapAnswerResult[]
  /** A Fellow's id by name, for the names that stand outside their own section (the skipped). */
  agentIdOf?: (name: string) => string | undefined
}): React.ReactElement {
  const q = query.trim().toLowerCase()
  // A recap stored before a field existed (A2 rows have no `dedupe`) still renders.
  const stored = row.model
  const m = { ...stored, unclaimed: stored.unclaimed ?? [], dedupe: stored.dedupe ?? { merged: [], overlaps: [] }, sleeping: stored.sleeping ?? [], fellows: stored.fellows ?? [] }
  /* The night's own reading-list entries, not everything that arrived since the last recap;
     on a quiet night nobody asked for anything, so the row stays away. */
  const reading = m.quiet ? [] : (stored.readingAdded ?? [])
  const since = m.sinceBuilt ?? null
  return (
    <div className="recap">
      {facts && <RecapFacts row={row} />}
      {/*
       * The proposals and Fellow states below are re-read on every request, so they are current
       * whatever happened since this recap was built. What a rebuild would ADD is the night's
       * story: runs it does not know about, and the summary lines an agent writes for them.
       */}
      {since !== null && since.runs > 0 && (
        <p className="recap-line recap-since">
          {since.runs} run{since.runs === 1 ? '' : 's'} finished after this recap was built
          {since.proposals > 0 ? `, and ${since.proposals} of the proposals below are newer than it` : ''}. The
          decisions above are current; rebuilding adds those runs and their summary lines, which costs a short agent
          run and rewrites the recap page.
        </p>
      )}
      {m.quiet && (
        <div className="empty">
          <p className="qs-line">Nothing ran tonight.</p>
          {m.sleeping.length > 0 && <p className="qs-detail">{m.sleeping.map((s) => `${s.name}: ${s.reason}`).join(' · ')}</p>}
        </div>
      )}
      {/* The day's own rows, on the same rail the Fellows use: a label on the left, one line
          per item on the right - a reading list entry, a skipped Fellow, a merged topic. */}
      {(reading.length > 0 || (m.shift !== null && m.shift !== undefined && m.shift.skipped.length > 0) || m.dedupe.merged.length > 0 || m.dedupe.overlaps.length > 0) && (
        <div className="rf-grid day">
          {reading.length > 0 && (
            <>
              <span className="rf-k" title="What the Fellows put on the reading list this night">
                Reading list
              </span>
              <div className="rf-v list">
                {reading.map((r) => (
                  <span key={r.url} className="filed">
                    {r.page !== null ? (
                      <PageLink vaultName={vaultName} path={r.page} />
                    ) : (
                      <a className="filed-link" href={r.url} target="_blank" rel="noreferrer noopener" title={r.url}>
                        {r.title}
                      </a>
                    )}
                    <span className="by">
                      {r.by !== null ? `${r.by} asked for it` : 'asked for'}
                      {r.page !== null ? ' · in the vault' : ''}
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}
          {m.shift && m.shift.skipped.length > 0 && (
            <>
              <span className="rf-k">Skipped</span>
              <div className="rf-v list">
                {m.shift.skipped.map((sk) => {
                  const id = agentIdOf?.(sk.agentName)
                  return (
                    <span key={sk.agentName} className="filed">
                      {id !== undefined ? (
                        <button className="recap-fname-link" title={`Open ${sk.agentName}'s dossier in the Library`} onClick={() => navigate(`/library?cc=${encodeURIComponent(id)}`)}>
                          <b>{sk.agentName}</b>
                        </button>
                      ) : (
                        <b>{sk.agentName}</b>
                      )}
                      <span className="by">{sk.reason}</span>
                    </span>
                  )
                })}
              </div>
            </>
          )}
          {(m.dedupe.merged.length > 0 || m.dedupe.overlaps.length > 0) && (
            <>
              <span className="rf-k">Merged</span>
              <p className="rf-v">
                {/* A merge and a hedge are different events: one topic did not run, the other did.
                    And a judgement says it is one - a model's opinion is not a token count. */}
                {m.dedupe.merged.map((d, i) =>
                  d.noted === true ? (
                    <span key={`m${i}`}>
                      {d.droppedAgentName}'s "{d.droppedTopic}" may be the same question as {d.keptAgentName}'s "{d.keptTopic}"; it ran anyway
                      {d.reason ? ` (${d.reason})` : ''}.{' '}
                    </span>
                  ) : (
                    <span key={`m${i}`}>
                      Merged {d.droppedAgentName}'s "{d.droppedTopic}" into {d.keptAgentName}'s "{d.keptTopic}"
                      {d.by === 'judge' ? ', judged the same question' : ''}
                      {d.by === 'judge' && d.reason ? ` (${d.reason})` : ''}.{' '}
                    </span>
                  ),
                )}
                {m.dedupe.overlaps.map((o, i) => (
                  <span key={`o${i}`}>
                    {o.agentName}'s "{o.topic}" overlaps the existing page "{o.page}".{' '}
                  </span>
                ))}
              </p>
            </>
          )}
        </div>
      )}
      {!m.quiet &&
        m.fellows
          .filter((f) => (only === undefined || only.length === 0 || only.includes(f.name)) && (q === '' || fellowText(f).includes(q)))
          .map((f) => (
            <FellowSection
              key={f.agentId}
              f={f}
              vaultName={vaultName}
              onAnswer={onAnswer}
              onFollow={onFollow}
              busy={busy}
              settings={settings}
              decidable={decidable}
              results={results.filter((r) => r.answer.action !== 'spawn' && r.answer.fellow === f.index)}
            />
          ))}
      {(only === undefined || only.length === 0) &&
        m.unclaimed.filter((u) => q === '' || `${u.question} ${u.domain} ${u.fromName}`.toLowerCase().includes(q)).map((u) => <UnclaimedSection key={u.handoffId} u={u} vaultName={vaultName} onAnswer={onAnswer} busy={busy} decidable={decidable} />)}
      {row.path && (
        <div className="rf-grid day foot">
          <span className="rf-k">Vault page</span>
          <p className="rf-v">
            <PageLink vaultName={vaultName} path={row.path} />
            {row.delivered.telegram ? ` · sent to Telegram ${timeAgo(row.delivered.telegram.at)}` : ' · Telegram: no bot connected'}
          </p>
        </div>
      )}
    </div>
  )
}

export function FellowSection({
  f,
  vaultName,
  onAnswer,
  onFollow,
  busy,
  settings = true,
  decidable = true,
  results = [],
}: {
  f: RecapFellow
  vaultName: string
  onAnswer: (a: RecapAnswer) => void
  onFollow: (page: string, agentId: string) => void
  busy: boolean
  settings?: boolean
  decidable?: boolean
  results?: readonly RecapAnswerResult[]
}): React.ReactElement {
  const [note, setNote] = useState('')
  /* Answers are for tonight and for a Fellow that still has nights: an older recap is the
     record of its day, and a retired Fellow has no shift to skip and no plan to note for. */
  const canAct = decidable && f.state !== 'retired'
  const stateLine = f.state === 'sleeping' ? `sleeping: ${f.sleepReason ?? f.sleepCode ?? ''}` : f.state
  const autonomyLine =
    f.autonomy === 'manual'
      ? 'manual: runs only what you approve'
      : f.autonomy === 'auto'
        ? 'auto: the top one runs the night it is planned'
        : 'veto: the top undecided one runs tonight unless vetoed'
  const link = (page: string): React.ReactElement => (
    <span key={page} onClickCapture={() => onFollow(page, f.agentId)}>
      <PageLink vaultName={vaultName} path={page} />
    </span>
  )
  return (
    <section className="recap-fellow" aria-label={`${f.index}. ${f.name}`}>
      {/* The head names the Fellow the way the column does - its domain's colour, its index,
          its name - and carries the one decision that is the night's own: skip it. */}
      <header className="rf-head">
        <span className="rf-dot" style={{ background: domainColor(f.homeDomain) }} aria-hidden />
        <span className="rf-idx">{f.index}</span>
        <h3 className="rf-name">
          {settings ? (
            f.name
          ) : (
            <button
              className="recap-fname-link"
              title={`Open ${f.name}'s dossier in the Library`}
              onClick={() => navigate(`/library?cc=${encodeURIComponent(f.agentId)}`)}
            >
              {f.name}
            </button>
          )}
        </h3>
        <span className="rf-meta">
          {f.homeDomain} · {f.model} · {stateLine}
          {f.skipUntil && f.state !== 'retired' ? ` · skipped tonight (${f.skipUntil})` : ''}
        </span>
        <span className="spacer" />
        {canAct && (
          <button className="btn ghost sm" disabled={busy} title={answerCode({ action: 'skip', fellow: f.index })} onClick={() => onAnswer({ action: 'skip', fellow: f.index })}>
            Skip tonight
          </button>
        )}
        {canAct && settings && (
          <>
            {f.state === 'paused' ? (
              <button className="btn ghost sm" disabled={busy} title={answerCode({ action: 'resume', fellow: f.index })} onClick={() => onAnswer({ action: 'resume', fellow: f.index })}>
                Resume
              </button>
            ) : (
              <button className="btn ghost sm" disabled={busy} title={answerCode({ action: 'pause', fellow: f.index })} onClick={() => onAnswer({ action: 'pause', fellow: f.index })}>
                Pause
              </button>
            )}
            <select className="select sm" aria-label={`Model of ${f.name}`} value={f.model} disabled={busy} onChange={(e) => onAnswer({ action: 'model', fellow: f.index, value: e.target.value })}>
              {MODELS.map((mo) => (
                <option key={mo} value={mo}>
                  {mo}
                </option>
              ))}
            </select>
            <select className="select sm" aria-label={`Largest step of ${f.name}`} defaultValue="" disabled={busy} onChange={(e) => e.target.value !== '' && onAnswer({ action: 'step', fellow: f.index, value: e.target.value })}>
              <option value="">step…</option>
              {STEPS.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </>
        )}
      </header>

      {results.length > 0 && (
        <div className={`toast ${results.every((r) => r.ok) ? 'ok' : 'warn'} rf-toast`} role="status">
          {results.map((r, i) => (
            <div key={i}>
              {r.ok ? '✓' : '✗'} {r.message}
            </div>
          ))}
        </div>
      )}
      {/* One rail of labels, one column of content. The eye finds the band it wants on the
          rail and reads across, rather than down a wall; every list is one item per line. */}
      <div className="rf-grid">
        {/* The decision first: the proposals are what the recap wants an answer to. */}
        <span className="rf-k">Tonight</span>
        <div className="rf-v">
          <p className="rf-hint">{autonomyLine}</p>
          {f.proposals.length === 0 ? (
            <p className="recap-none">None pending. A note steers the next plan.</p>
          ) : (
            f.proposals.map((p) => <ProposalRow key={p.proposalId} fellow={f.index} p={p} onAnswer={onAnswer} busy={busy} canAct={canAct} />)
          )}
        </div>

        <span className="rf-k">Last night</span>
        <div className="rf-v">
          {f.runs.length === 0 ? (
            <p className="recap-none">Nothing since the last recap.</p>
          ) : (
            f.runs.map((r) => (
              <div key={r.runId} className="recap-ran">
                <div className="recap-ran-line">
                  <b>{r.kind}</b> · {r.topic}
                  {/* Its facts are here, its prose is not: the "what it found" lines are written
                      during a build, and this run landed after one. */}
                  {r.addedAfterBuild === true && (
                    <span className="recap-later" title="This ran after the recap was built. Rebuilding adds its summary line.">
                      after the build
                    </span>
                  )}
                </div>
                <div className="recap-ran-meta">
                  {r.ok
                    ? `${r.addedAfterBuild === true ? `${r.pagesUpdated.length} page(s)` : `${r.pagesCreated.length} page(s) created, ${r.pagesUpdated.length} updated`} · ${usd(r.costUsd)}${r.commit ? ` · commit ${r.commit.slice(0, 8)}` : ''}`
                    : `failed: ${r.error ?? 'unknown'}`}
                </div>
                {r.pagesCreated.length > 0 && (
                  <div className="recap-pages">
                    <span className="k">Created</span>
                    <span className="chips">{r.pagesCreated.map(link)}</span>
                  </div>
                )}
                {r.pagesUpdated.length > 0 && (
                  <div className="recap-pages">
                    <span className="k">Updated</span>
                    <span className="chips">{r.pagesUpdated.map(link)}</span>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {f.found.length > 0 && (
          <>
            <span className="rf-k">Found</span>
            <ul className="rf-v recap-list">
              {f.found.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </>
        )}
        {f.openQuestions.length > 0 && (
          <>
            <span className="rf-k">Open questions</span>
            <ul className="rf-v recap-list">
              {f.openQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </>
        )}

        {canAct && (
          <>
        <span className="rf-k">Note</span>
        <form
          className="rf-v recap-note"
          onSubmit={(e) => {
            e.preventDefault()
            if (note.trim() === '') return
            onAnswer({ action: 'note', fellow: f.index, text: note.trim() })
            setNote('')
          }}
        >
          <input className="input" placeholder={`A note for ${f.name}'s next plan (becomes a candidate)`} value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn sm" type="submit" disabled={busy || note.trim() === ''} title={answerCode({ action: 'note', fellow: f.index, text: '…' })}>
            Send note
          </button>
        </form>
          </>
        )}

        <span className="rf-k">Notebook</span>
        <p className="rf-v recap-foot">
          <PageLink vaultName={vaultName} path={f.notebookPath} /> · opened {f.value.pageOpens} time(s) this month
        </p>
      </div>
    </section>
  )
}

/** The five lead figures of one recap. Rendered by the screen and by Home's feed alike. */
export function RecapFacts({ row }: { row: RecapRow }): React.ReactElement {
  const m = row.model
  return (
    <Facts size="lead">
      {/* One line whatever the night did - the cost and the shift go under it - so the strip
          keeps one height from day to day; "12 runs · 43 pages · 29.82 USD" wrapped. */}
      <Fact
        k="Night"
        v={m.quiet ? 'Quiet' : `${m.totals.runs} run${m.totals.runs === 1 ? '' : 's'} · ${m.totals.pages} page${m.totals.pages === 1 ? '' : 's'}`}
        sub={`${m.quiet ? 'nothing ran' : usd(m.totals.costUsd)}${m.totals.failed > 0 ? ` · ${m.totals.failed} failed` : ''} · ${m.shift ? `${m.shift.trigger} shift, ${m.shift.executed} run(s), ${m.shift.planned} plan(s)` : 'no shift ran'}`}
        size="lead"
      />
      <Fact k="Consumption today" v={usd(m.usage.today.costUsd)} sub={`${m.usage.today.runs} run(s), manual ones included`} size="lead" />
      <Fact k="This week" v={usd(m.usage.week.costUsd)} sub={`${m.usage.week.runs} run(s)`} size="lead" />
      <Fact k="Undecided" v={undecidedCount(m)} sub={row.answeredAt ? `last answered ${timeAgo(row.answeredAt)}` : 'nothing answered yet'} size="lead" tone={undecidedCount(m) > 0 ? 'warn' : undefined} />
      <Fact k="Value this month" v={m.value.pageOpens} sub={`page opens · ${m.value.recapLinks} recap links followed`} size="lead" />
    </Facts>
  )
}

/** An unclaimed request (A3): no Fellow covers the domain; a prefilled spawn is one click away. */
/** `climate-science` reads as "Climate Science Fellow", the same default the server uses. */
function defaultFellowName(domain: string): string {
  const words = domain.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  return words.concat(['Fellow']).join(' ')
}

export function UnclaimedSection({ u, vaultName, onAnswer, busy, decidable = true }: { u: RecapUnclaimed; vaultName: string; onAnswer: (a: RecapAnswer) => void; busy: boolean; decidable?: boolean }): React.ReactElement {
  const [name, setName] = useState(defaultFellowName(u.domain))
  const request = Number(u.code.slice(1))
  return (
    <section className="recap-fellow" aria-label={`Unclaimed request ${u.code}`}>
      <header className="rf-head">
        <span className="rf-dot" style={{ background: domainColor(u.domain) }} aria-hidden />
        <span className="rf-idx">{u.code}</span>
        <h3 className="rf-name">Unclaimed request</h3>
        <span className="rf-meta">
          {u.domain} · from {u.fromName} · no Fellow covers this domain
        </span>
      </header>
      <div className="rf-grid">
        <span className="rf-k">Question</span>
        <div className="rf-v">
          <div className="prop-topic">{u.question}</div>
          {u.reason && <p className="prop-why">{u.reason}</p>}
          {u.sourcePage && (
            <p className="recap-foot">
              From: <PageLink vaultName={vaultName} path={u.sourcePage} />
            </p>
          )}
        </div>
        {decidable && (
          <>
            <span className="rf-k">Spawn</span>
            <form
              className="rf-v recap-note"
              onSubmit={(e) => {
                e.preventDefault()
                onAnswer({ action: 'spawn', request, ...(name.trim() !== '' ? { name: name.trim() } : {}) })
              }}
            >
              <input className="input" aria-label="Name of the new Fellow" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn primary sm" type="submit" disabled={busy} title={answerCode({ action: 'spawn', request, name })}>
                Spawn a Fellow for this
              </button>
            </form>
          </>
        )}
      </div>
    </section>
  )
}

/** What a proposal's status says once it is not a question any more. */
const SETTLED_CHIPS: Record<string, string> = { vetoed: 'vetoed', executed: 'ran', expired: 'expired', superseded: 'superseded' }

function ProposalRow({ fellow, p, onAnswer, busy, canAct = true }: { fellow: number; p: RecapProposal; onAnswer: (a: RecapAnswer) => void; busy: boolean; canAct?: boolean }): React.ReactElement {
  const pick: RecapAnswer = { action: 'pick', fellow, letter: p.code.slice(-1) }
  const veto: RecapAnswer = { action: 'veto', fellow, letter: p.code.slice(-1) }
  // The two answers exist while the question is open and the reader may answer it; anything
  // else is a chip that says what became of the proposal. Both stand in the column on the
  // right, so the text on the left reads as text and the state is always in one place.
  const open = canAct && (p.status === 'proposed' || p.status === 'approved')
  return (
    <div className={`prop${p.status === 'approved' ? ' approved' : p.status === 'vetoed' || p.status === 'expired' || p.status === 'superseded' ? ' vetoed' : ''}`}>
      <div className="prop-main">
        <div className="prop-topic">
          <span className="prop-code">{p.code}</span> {p.kind} · {p.topic} · about {usd(p.estCostUsd)}
        </div>
        {p.rationale && <p className="prop-why">{p.rationale}</p>}
        <p className="prop-from">
          {p.provenance.task !== undefined && <>For &ldquo;{p.provenance.task}&rdquo; · </>}
          From {p.provenance.candidate}: {p.provenance.text}
        </p>
      </div>
      <div className="prop-acts">
        {open && p.status !== 'approved' && (
          <button className="btn primary sm" disabled={busy} title={answerCode(pick)} onClick={() => onAnswer(pick)}>
            Run tonight
          </button>
        )}
        {open && (
          <button className="btn ghost sm" disabled={busy} title={answerCode(veto)} onClick={() => onAnswer(veto)}>
            Veto
          </button>
        )}
        {p.status === 'approved' && <span className="chip ok">runs tonight</span>}
        {SETTLED_CHIPS[p.status] !== undefined && <span className="chip">{SETTLED_CHIPS[p.status]}</span>}
        {/* Still undecided in the store, but this recap is not where it is decided any more. */}
        {p.status === 'proposed' && !canAct && (
          <span className="chip" title="Still undecided; it is decided on the newest recap">
            open
          </span>
        )}
        {p.drift && (
          <span className="chip" title="Low overlap with the intent; runs only if you approve it">
            drift
          </span>
        )}
      </div>
    </div>
  )
}
