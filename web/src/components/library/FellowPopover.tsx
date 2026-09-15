/**
 * The card a click on a figure in the room opens (docs/agents/SPEC.md section 10.6).
 *
 * It used to answer with two lines and a door to a Fellow sidebar. Every one of that sidebar's
 * sections now lives in the command centre - the recap, the activity log, the pages, the
 * notebook, the settings - so the door led to a second, older copy of screens the user already
 * had. The card is the shortest way INTO those screens instead: what the Fellow is, what the
 * night comes to, and the three places its own work is kept.
 *
 * It reads the same `FellowSummary` the command centre reads, which the Library screen already
 * holds; the scene's own record carries the room and the live run and nothing else is asked of
 * the server. Centred over the room rather than pinned to the figure, because a card this size
 * anchored to a figure near an edge spends its life half outside the drawing.
 */

import { useEffect } from 'react'
import type { FellowSummary, SceneFellow } from '../../api/types.ts'
import { usd } from '../../lib/format.ts'
import { domainColor } from '../../lib/domains.ts'
import { fellowMinutes, runProgress, runsTonight, shapeName, standingTasks } from '../../lib/command/model.ts'
import { runUsd, type Prices } from '../../lib/plan.ts'

const NIGHTLY: Record<string, string> = { sweep: 'every task', rotate: 'one task a night' }
const AUTONOMY: Record<string, string> = {
  manual: 'asks every time',
  veto: 'runs unless you stop it',
  auto: 'runs the same night',
}

export function FellowPopover({
  scene,
  fellow,
  roomName,
  durations,
  costs,
  onDossier,
  onSettings,
  onTonight,
  onDecisions,
  onPause,
  onClose,
}: {
  scene: SceneFellow
  /** The roster's own record, once the agents query has it; the card degrades without it. */
  fellow: FellowSummary | undefined
  roomName: string
  durations: Readonly<Record<string, number | null>>
  costs: Prices | undefined
  onDossier: () => void
  onSettings: () => void
  onTonight: () => void
  onDecisions: () => void
  onPause: () => void
  onClose: () => void
}): React.ReactElement {
  // Escape closes it, the way it closes the shelf window and the command centre. Captured
  // here and stopped, so the room behind does not also step a wing back on the same press.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const agent = fellow?.agent
  const running = scene.run
  const state = running ? (running.kind === 'plan' ? 'planning' : 'at work') : scene.state
  const tone = running ? 'rec' : scene.state === 'paused' ? 'mut' : scene.state === 'waiting' ? 'ok' : 'mut'
  const standing = agent ? standingTasks(agent) : []
  const runs = fellow ? runsTonight(fellow) : 0
  const quota = agent?.quotaRunsPerDay ?? 0
  const minutes = fellow ? fellowMinutes(fellow, durations) : 0
  const spent = fellow !== undefined && runs >= quota && quota > 0 && fellow.runsTonight >= quota
  /*
   * What the night asks, in the same order the shift takes it: every proposal that stands
   * carries the planner's own estimate, and only the runs beyond them - the slots tonight's
   * planning will fill - are priced from the Fellow's shape. Multiplying one estimate by the
   * quota priced two cheap steps as two deep ones.
   */
  const queue = fellow?.queue ?? []
  const night = agent
    ? queue.slice(0, runs).reduce((a, p) => a + (p.estCostUsd ?? 0), 0) +
      Math.max(0, runs - queue.length) * runUsd(agent.step, agent.model, costs)
    : 0
  const progress = running ? runProgress(running.startedAt, running.typicalMs, Date.now()) : null
  const undecided = fellow?.undecidedProposals ?? 0

  /*
   * The night as the slots it is made of, always at least three of them (2026-09-15). A night
   * read as one line said what would run FIRST and nothing about the rest, so a Fellow with
   * three runs standing looked like a Fellow with one. An empty slot says why it is empty,
   * which is the other half of the answer: the quota can stop short of it, tonight's own
   * planning can still be about to fill it, or nothing is coming for it at all.
   */
  const slots = Array.from({ length: Math.max(3, runs) }, (_, i) => {
    const proposal = queue[i] ?? null
    if (proposal !== null) return { proposal, why: '' }
    if (quota > 0 && i >= quota) return { proposal, why: `past the quota of ${quota} a night` }
    if (i < runs) return { proposal, why: "tonight's own planning fills this one" }
    return { proposal, why: 'nothing stands for it' }
  })

  const fact = (value: string, label: string, off = false): React.ReactElement => (
    <span key={label} className={off ? 'off' : undefined}>
      <b>{value}</b>
      <i>{label}</i>
    </span>
  )

  return (
    <div className="lib-pop" style={{ ['--dot' as string]: domainColor(scene.homeDomain) }} role="dialog" aria-label={scene.name}>
      <button className="gx-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="gx-kicker">
        <i className="lib-pop-dot" />
        {scene.homeDomain} · {roomName}
      </div>
      <div className="lib-pop-head">
        <div className="lib-pop-title">
          {scene.name}
          {agent && <span className="shape">({shapeName(agent.art)})</span>}
        </div>
        <span className={`sev ${tone}`}>{state}</span>
      </div>
      {agent && (
        <div className="lib-pop-sub">
          {NIGHTLY[agent.nightly] ?? agent.nightly} · {AUTONOMY[agent.autonomy] ?? agent.autonomy} · {agent.step} depth
        </div>
      )}
      {agent && (
        <div className="lib-pop-facts">
          {fact(String(standing.length), `standing task${standing.length === 1 ? '' : 's'}`)}
          {fact(`${runs} of ${quota}`, 'runs tonight', spent)}
          {fact(String(minutes), 'minutes', minutes === 0)}
          {fact(agent.model, 'model')}
          {fact(usd(night), 'tonight', night === 0)}
        </div>
      )}
      <div className="lib-pop-line">
        <span className="k">Now</span>
        <span className="v">
          {running ? running.label ?? running.kind : (scene.sleepReason ?? scene.state)}
          {running && <small>{running.kind}</small>}
          {progress !== null && (
            <span className="lib-pop-prog">
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
          )}
        </span>
      </div>
      <div className="lib-pop-line">
        <span className="k">Tonight</span>
        <span className="v lib-pop-runs">
          {slots.map((slot, i) => (
            <span key={i} className={`lib-pop-run${slot.proposal === null ? ' none' : ''}`}>
              <span className="t" title={slot.proposal?.topic}>
                <b>Run {i + 1}:</b> {slot.proposal !== null ? slot.proposal.topic : slot.why}
              </span>
              {slot.proposal !== null && (
                <small>
                  {slot.proposal.status === 'approved' ? 'approved' : 'undecided'}
                  {slot.proposal.estCostUsd !== null ? ` · about ${usd(slot.proposal.estCostUsd)}` : ''}
                </small>
              )}
            </span>
          ))}
        </span>
      </div>
      {standing.length > 0 && (
        <div className="lib-pop-line">
          <span className="k">Standing</span>
          <span className="v">
            {standing.map((t) => (
              <span key={t.id} className="lib-pop-task">
                <span className={`cc-art a-${t.kind}`}>{t.kind}</span>
                <span className="t" title={t.text}>
                  {t.text}
                </span>
              </span>
            ))}
          </span>
        </div>
      )}
      <div className="lib-pop-acts">
        <button className="btn sm primary" onClick={onDossier} title="Its recap, activity, pages, notebook and settings">
          Dossier
        </button>
        <button className="btn sm" onClick={onSettings} title="Its standing work, how much of the night it takes, and who decides">
          Settings
        </button>
        <button className="btn sm" onClick={onTonight} title="The night this shelf works, and who else is on it">
          Tonight
        </button>
        {undecided > 0 && (
          <button className="btn sm due" onClick={onDecisions} title={`${undecided} proposal(s) up for review`}>
            Decisions<span className="n">{undecided}</span>
          </button>
        )}
        <span className="grow" />
        <button className="btn ghost sm" onClick={onPause}>
          {scene.state === 'paused' ? 'Resume' : 'Pause'}
        </button>
      </div>
    </div>
  )
}
