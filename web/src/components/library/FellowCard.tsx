/**
 * The docked Fellow card (docs/agents/SPEC.md section 10.5, docs/tasks/TASKS-A4.md D7):
 * who the Fellow is, what runs now (phase bar and log tail over the live channel), what it
 * wrote, what it plans, what it spends, and the actions of the A0 to A3 endpoints.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../api/client.ts'
import type { FellowCard as CardData, ProposalRecord } from '../../api/types.ts'
import { queryState } from '../QueryState.tsx'
import { PageLink } from '../PageLink.tsx'
import { Icon } from '../Icon.tsx'
import { useJobLog } from '../../hooks/useJobLog.ts'
import { timeAgo, usd } from '../../lib/format.ts'
import { navigate, pageRoute } from '../../lib/router.ts'
import { obsidianUri } from '../../lib/obsidian.ts'
import { stepButton } from '../../lib/stepAction.ts'
import { toolFamily } from '../../lib/library/scene.ts'
import { DeepenDialog } from './DeepenDialog.tsx'

const STATE_TEXT: Record<string, string> = {
  proposed: 'new, first run pending',
  active: 'a run is in flight',
  waiting: 'waiting for the night shift',
  sleeping: 'asleep',
  paused: 'paused',
  blocked: 'blocked after a failed run',
  retired: 'retired',
}

function LiveRun({ channel, label, kind }: { channel: string; label: string | null; kind: string }): React.ReactElement {
  const lines = useJobLog(channel, { seed: false })
  const tail = lines.slice(-6)
  const last = tail.length > 0 ? tail[tail.length - 1]!.message : null
  const family = toolFamily(last)
  const phase = family === 'read' ? 'reading sources' : family === 'write' ? 'writing pages' : family === 'commit' ? 'shelving' : 'thinking'
  const steps = ['reading sources', 'writing pages', 'shelving']
  return (
    <div className="lc-live">
      <div className="lc-live-head">
        <span className="pulse" aria-hidden />
        <b>{kind}</b> {label ?? ''}
      </div>
      <ol className="lc-phases">
        {steps.map((s) => (
          <li key={s} className={s === phase ? 'on' : ''}>
            {s}
          </li>
        ))}
      </ol>
      <pre className="lc-tail">{tail.map((l) => l.message).join('\n') || 'waiting for the first tool call…'}</pre>
    </div>
  )
}

export function FellowCard({ agentId, vaultName, onClose }: { agentId: string; vaultName: string; onClose: () => void }): React.ReactElement {
  const qc = useQueryClient()
  const card = useQuery({ queryKey: ['agent-card', agentId], queryFn: () => api.agentCard(agentId), refetchInterval: 10_000 })
  const [toast, setToast] = useState<string | null>(null)
  /** The daily quota is used up and the card is asking whether to run anyway (section 8.4). */
  const [confirmStep, setConfirmStep] = useState(false)
  /** The deepening dialog, opened on the Fellow's own home domain. */
  const [deepening, setDeepening] = useState(false)
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['agent-card', agentId] })
    void qc.invalidateQueries({ queryKey: ['agents'] })
    void qc.invalidateQueries({ queryKey: ['library-scene'] })
    void qc.invalidateQueries({ queryKey: ['maintenance-runs'] })
  }
  const act = useMutation({
    mutationFn: async (
      what: { kind: 'step'; override?: boolean } | { kind: 'plan' } | { kind: 'pause' | 'resume' | 'retire' } | { kind: 'veto'; proposalId: string },
    ) => {
      if (what.kind === 'step') return api.stepAgent(agentId, what.override === true ? { override: true } : {}).then(() => 'a step is running')
      if (what.kind === 'plan') return api.planAgent(agentId).then((r) => (r.run ? 'a planning run is going' : `nothing to plan: ${r.skipped ?? 'no candidates'}`))
      if (what.kind === 'veto') return api.decideProposal(what.proposalId, { status: 'vetoed' }).then(() => 'the next proposal is vetoed')
      return api.agentAction(agentId, what.kind).then((r) => `${r.agent.name} is ${r.agent.state}`)
    },
    onSuccess: (msg) => {
      setToast(msg)
      setConfirmStep(false)
      refresh()
    },
    onError: (err) => {
      // The quota ran out between the render and the click: ask instead of just refusing.
      if (err instanceof ApiError && err.code === 'quota') setConfirmStep(true)
      setToast((err as Error).message)
    },
  })
  const state = queryState(card, 'the Fellow')
  const c: CardData | undefined = card.data
  const pending = (c?.proposals ?? []).filter((p) => p.status === 'proposed' || p.status === 'approved')
  const nextUndecided: ProposalRecord | undefined = c?.next ?? undefined
  return (
    <aside className="lib-card" aria-label="Fellow card">
      <button className="gx-close" onClick={onClose} aria-label="Close the card">
        <Icon name="x" />
      </button>
      {state ?? (c === undefined ? null : (
        <>
          <div className="gx-head">
            <div className="gx-kicker">Fellow · {c.agent.homeDomain}</div>
            <div className="gx-title">{c.agent.name}</div>
            <div className="gx-tags">
              <span className="gx-tag">{c.agent.model} · {c.agent.effort}</span>
              <span className="gx-tag">{c.agent.step} steps</span>
              <span className="gx-tag">{c.agent.autonomy} mode</span>
              <span className="gx-tag">{c.quota.usedToday} of {c.quota.runsPerDay} today</span>
            </div>
          </div>
          {toast && (
            <div className="toast ok" role="status">
              {toast}
            </div>
          )}
          <div className="gx-body">
            <section className="gx-sec">
              <h3>Intent</h3>
              <p>{c.agent.intent}</p>
              {c.agent.scope && <p className="mono-meta">Scope: {c.agent.scope}</p>}
              <p className="mono-meta">
                {STATE_TEXT[c.agent.state] ?? c.agent.state}
                {c.agent.sleepReason ? `: ${c.agent.sleepReason}` : ''}
                {c.agent.skipUntil ? ` · skips tonight (${c.agent.skipUntil})` : ''}
                {c.lastActive ? ` · last active ${timeAgo(c.lastActive)}` : ''}
              </p>
            </section>
            {c.currentRun && c.currentRun.status === 'running' && (
              <section className="gx-sec">
                <h3>Now</h3>
                <LiveRun channel={c.currentRun.channel} label={c.currentRun.label ?? null} kind={c.currentRun.kind} />
              </section>
            )}
            <section className="gx-sec">
              <h3>
                Plan <span className="c">{pending.length}</span>
              </h3>
              {pending.length === 0 ? (
                <p className="mono-meta">Nothing pending; the planner runs in the next night shift.</p>
              ) : (
                <ul>
                  {pending.map((p) => (
                    <li key={p.id}>
                      <b>{p.status === 'approved' ? 'approved' : `rank ${p.rank}`}</b> · {p.kind} · {p.topic}
                      {p.estCostUsd !== null ? ` · about ${usd(p.estCostUsd)}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="gx-sec">
              <h3>
                Pages <span className="c">{c.pages.length}</span>
              </h3>
              {c.pages.length === 0 ? (
                <p className="mono-meta">No pages yet.</p>
              ) : (
                <ul>
                  {c.pages.slice(0, 12).map((p) => (
                    <li key={p}>
                      <PageLink vaultName={vaultName} path={p} />
                    </li>
                  ))}
                  {c.pages.length > 12 && <li className="mono-meta">and {c.pages.length - 12} more</li>}
                </ul>
              )}
            </section>
            <section className="gx-sec">
              <h3>This week</h3>
              <p className="mono-meta">
                {c.spend.runsWeek} run(s), {usd(c.spend.weekUsd)}
                {c.spend.weekPct !== null && ` (${c.spend.weekPct.toFixed(1)} points of the week)`} · today {c.spend.runsToday} run(s), {usd(c.spend.todayUsd)} · opened {c.value.pageOpens} time(s) this month
              </p>
            </section>
            <div className="gx-actions">
              {(() => {
                const step = stepButton(c.quota, confirmStep)
                const busy = act.isPending || c.agent.state === 'active' || c.agent.state === 'paused' || c.agent.state === 'retired'
                return (
                  <>
                    <button className="btn primary sm" disabled={busy} onClick={() => (step.asks ? setConfirmStep(true) : act.mutate({ kind: 'step', override: step.override }))}>
                      {step.label}
                    </button>
                    {confirmStep && (
                      <button className="btn sm" disabled={act.isPending} onClick={() => setConfirmStep(false)}>
                        Cancel
                      </button>
                    )}
                    {step.note !== null && <p className="mono-meta">{step.note}</p>}
                  </>
                )
              })()}
              <button className="btn sm" disabled={act.isPending || c.agent.state === 'active' || c.agent.state === 'paused' || c.agent.state === 'retired'} onClick={() => act.mutate({ kind: 'plan' })}>
                Plan again now
              </button>
              {/* The one run kind that touches pages the vault already has; until now it could
                  only happen if the planner chose it (docs/agents/ideas.md, 2026-09-07). */}
              <button
                className="btn sm"
                disabled={act.isPending || c.agent.state === 'active' || c.agent.state === 'paused' || c.agent.state === 'retired'}
                title={`Append to thin pages in ${c.agent.homeDomain} that the vault often points at`}
                onClick={() => setDeepening(true)}
              >
                Deepen pages…
              </button>
              {c.agent.state === 'paused' || c.agent.state === 'blocked' ? (
                <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ kind: 'resume' })}>
                  Resume
                </button>
              ) : (
                <button className="btn sm" disabled={act.isPending || c.agent.state === 'retired'} onClick={() => act.mutate({ kind: 'pause' })}>
                  Pause
                </button>
              )}
              {nextUndecided && nextUndecided.status === 'proposed' && (
                <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ kind: 'veto', proposalId: nextUndecided.id })}>
                  Veto the next plan
                </button>
              )}
              <button className="btn sm" onClick={() => navigate(pageRoute(c.agent.notebookPath))}>
                Open notebook
              </button>
              <a className="btn sm" href={obsidianUri(vaultName, c.agent.notebookPath)}>
                Open in Obsidian
              </a>
              <button className="btn sm" onClick={() => navigate(`/research?fellow=${encodeURIComponent(c.agent.id)}`)}>
                Research ledger
              </button>
              <button className="btn ghost sm danger" disabled={act.isPending || c.agent.state === 'retired'} onClick={() => act.mutate({ kind: 'retire' })}>
                Retire
              </button>
            </div>
          </div>
          {deepening && <DeepenDialog domain={c.agent.homeDomain} agentId={c.agent.id} onClose={() => setDeepening(false)} />}
        </>
      ))}
    </aside>
  )
}
