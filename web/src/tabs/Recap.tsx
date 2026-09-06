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
import { answerCode, nightLine, undecidedCount } from '../lib/recap.ts'
import { timeAgo, usd } from '../lib/format.ts'

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
        <button className="btn ghost sm" disabled={build.isPending || status?.building === true} onClick={() => build.mutate(current !== undefined && current.cycleDate === new Date().toISOString().slice(0, 10))} title="Build today's recap now (rebuilds it when today's exists)">
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
          <RecapBody row={current} vaultName={vaultName} onAnswer={send} onFollow={followed} busy={answer.isPending} />
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
}: {
  row: RecapRow
  vaultName: string
  onAnswer: (a: RecapAnswer) => void
  onFollow: (page: string, agentId: string) => void
  busy: boolean
  /** The five lead figures. Home's feed shows them once, in the box, for the day in view. */
  facts?: boolean
  /** Only this Fellow's section, by name. Home's feed uses it for the Fellow filter. */
  only?: string
}): React.ReactElement {
  // A recap stored before a field existed (A2 rows have no `dedupe`) still renders.
  const stored = row.model
  const m = { ...stored, unclaimed: stored.unclaimed ?? [], dedupe: stored.dedupe ?? { merged: [], overlaps: [] }, sleeping: stored.sleeping ?? [], fellows: stored.fellows ?? [] }
  return (
    <div className="recap">
      {facts && <RecapFacts row={row} />}
      {m.quiet && (
        <div className="empty">
          <p className="qs-line">Nothing ran tonight.</p>
          {m.sleeping.length > 0 && <p className="qs-detail">{m.sleeping.map((s) => `${s.name}: ${s.reason}`).join(' · ')}</p>}
        </div>
      )}
      {m.summaryNote && <div className="toast warn">{m.summaryNote}</div>}
      {m.shift && m.shift.skipped.length > 0 && (
        <p className="recap-line">Skipped: {m.shift.skipped.map((s) => `${s.agentName} (${s.reason})`).join(' · ')}</p>
      )}
      {(m.dedupe.merged.length > 0 || m.dedupe.overlaps.length > 0) && (
        <p className="recap-line">
          {m.dedupe.merged.map((d, i) => (
            <span key={`m${i}`}>
              Merged {d.droppedAgentName}'s "{d.droppedTopic}" into {d.keptAgentName}'s "{d.keptTopic}".{' '}
            </span>
          ))}
          {m.dedupe.overlaps.map((o, i) => (
            <span key={`o${i}`}>
              {o.agentName}'s "{o.topic}" overlaps the existing page "{o.page}".{' '}
            </span>
          ))}
        </p>
      )}
      {!m.quiet &&
        m.fellows
          .filter((f) => only === undefined || f.name === only)
          .map((f) => <FellowSection key={f.agentId} f={f} vaultName={vaultName} onAnswer={onAnswer} onFollow={onFollow} busy={busy} />)}
      {only === undefined &&
        m.unclaimed.map((u) => <UnclaimedSection key={u.handoffId} u={u} vaultName={vaultName} onAnswer={onAnswer} busy={busy} />)}
      {row.path && (
        <p className="recap-line">
          Vault page: <PageLink vaultName={vaultName} path={row.path} />
          {row.delivered.telegram ? ` · sent to Telegram ${timeAgo(row.delivered.telegram.at)}` : ' · Telegram: no bot connected'}
        </p>
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
}: {
  f: RecapFellow
  vaultName: string
  onAnswer: (a: RecapAnswer) => void
  onFollow: (page: string, agentId: string) => void
  busy: boolean
}): React.ReactElement {
  const [note, setNote] = useState('')
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
      <div className="recap-fhead">
        <h3 className="recap-fname">
          {f.index}. {f.name}
        </h3>
        <span className="recap-fmeta">
          {f.homeDomain} · {f.model} · {stateLine}
          {f.skipUntil ? ` · skipped tonight (${f.skipUntil})` : ''}
        </span>
        <span className="spacer" />
        <button className="btn ghost sm" disabled={busy} title={answerCode({ action: 'skip', fellow: f.index })} onClick={() => onAnswer({ action: 'skip', fellow: f.index })}>
          Skip tonight
        </button>
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
          {STEPS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* The decision first: the proposals are what the recap wants an answer to. */}
      <span className="recap-label">
        Proposals for tonight <span className="recap-label-sub">{autonomyLine}</span>
      </span>
      {f.proposals.length === 0 ? (
        <p className="recap-none">None pending. A note steers the next plan.</p>
      ) : (
        f.proposals.map((p) => <ProposalRow key={p.proposalId} fellow={f.index} p={p} onAnswer={onAnswer} busy={busy} />)
      )}

      <span className="recap-label">What it did last night</span>
      {f.runs.length === 0 ? (
        <p className="recap-none">Nothing since the last recap.</p>
      ) : (
        f.runs.map((r) => (
          <div key={r.runId} className="recap-ran">
            <div className="recap-ran-line">
              <b>{r.kind}</b> · {r.topic}
            </div>
            <div className="recap-ran-meta">
              {r.ok
                ? `${r.pagesCreated.length} page(s) created, ${r.pagesUpdated.length} updated · ${usd(r.costUsd)}${r.commit ? ` · commit ${r.commit.slice(0, 8)}` : ''}`
                : `failed: ${r.error ?? 'unknown'}`}
            </div>
            {r.pagesCreated.length > 0 && (
              <div className="recap-pages">
                <span className="k">Created</span>
                {r.pagesCreated.map(link)}
              </div>
            )}
            {r.pagesUpdated.length > 0 && (
              <div className="recap-pages">
                <span className="k">Updated</span>
                {r.pagesUpdated.map(link)}
              </div>
            )}
          </div>
        ))
      )}

      {f.found.length > 0 && (
        <>
          <span className="recap-label">Found</span>
          <ul className="recap-list">
            {f.found.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </>
      )}
      {f.openQuestions.length > 0 && (
        <>
          <span className="recap-label">Open questions</span>
          <ul className="recap-list">
            {f.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}

      <form
        className="recap-note"
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
      <p className="recap-foot">
        Notebook: <PageLink vaultName={vaultName} path={f.notebookPath} /> · opened {f.value.pageOpens} time(s) this month
      </p>
    </section>
  )
}

/** The five lead figures of one recap. Rendered by the screen and by Home's feed alike. */
export function RecapFacts({ row }: { row: RecapRow }): React.ReactElement {
  const m = row.model
  return (
    <Facts size="lead">
      <Fact k="Night" v={nightLine(m)} sub={m.shift ? `${m.shift.trigger} shift, ${m.shift.executed} run(s), ${m.shift.planned} plan(s)` : 'no shift ran'} size="lead" />
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

export function UnclaimedSection({ u, vaultName, onAnswer, busy }: { u: RecapUnclaimed; vaultName: string; onAnswer: (a: RecapAnswer) => void; busy: boolean }): React.ReactElement {
  const [name, setName] = useState(defaultFellowName(u.domain))
  const request = Number(u.code.slice(1))
  return (
    <section className="recap-fellow" aria-label={`Unclaimed request ${u.code}`}>
      <div className="recap-fhead">
        <h3 className="recap-fname">{u.code}. Unclaimed request</h3>
        <span className="recap-fmeta">
          {u.domain} · from {u.fromName} · no Fellow covers this domain
        </span>
      </div>
      <div className="prop-topic">{u.question}</div>
      {u.reason && <p className="prop-why">{u.reason}</p>}
      {u.sourcePage && (
        <p className="recap-foot">
          From: <PageLink vaultName={vaultName} path={u.sourcePage} />
        </p>
      )}
      <form
        className="recap-note"
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
    </section>
  )
}

function ProposalRow({ fellow, p, onAnswer, busy }: { fellow: number; p: RecapProposal; onAnswer: (a: RecapAnswer) => void; busy: boolean }): React.ReactElement {
  const pick: RecapAnswer = { action: 'pick', fellow, letter: p.code.slice(-1) }
  const veto: RecapAnswer = { action: 'veto', fellow, letter: p.code.slice(-1) }
  return (
    <div className={`prop${p.status === 'approved' ? ' approved' : p.status === 'vetoed' ? ' vetoed' : ''}`}>
      <div className="prop-main">
        <div className="prop-topic">
          <span className="prop-code">{p.code}</span> {p.kind} · {p.topic} · about {usd(p.estCostUsd)}
          {p.status === 'approved' && <span className="chip ok">runs tonight</span>}
          {p.status === 'vetoed' && <span className="chip">vetoed</span>}
          {p.drift && (
            <span className="chip" title="Low overlap with the intent; runs only if you approve it">
              drift
            </span>
          )}
        </div>
        {p.rationale && <p className="prop-why">{p.rationale}</p>}
        <p className="prop-from">
          From {p.provenance.candidate}: {p.provenance.text}
        </p>
      </div>
      <div className="prop-acts">
        {p.status !== 'approved' && (
          <button className="btn primary sm" disabled={busy} title={answerCode(pick)} onClick={() => onAnswer(pick)}>
            Run tonight
          </button>
        )}
        {p.status !== 'vetoed' && (
          <button className="btn ghost sm" disabled={busy} title={answerCode(veto)} onClick={() => onAnswer(veto)}>
            Veto
          </button>
        )}
      </div>
    </div>
  )
}
