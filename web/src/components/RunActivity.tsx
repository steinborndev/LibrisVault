/**
 * The agent's own section while it works (2026-09-08).
 *
 * What the agent is doing is a live account and belongs in a box of its own above the list;
 * what a run IS belongs in the list. Folding one into the other was tried and made a row that
 * grew and shrank under the cursor. The two share nothing but the dot.
 *
 * Three things, top to bottom, and no headline between them: what it is working on, the
 * last few lines of how, and the stages with the current one lit. There used to be a line
 * naming the stage and the elapsed time as well - it said what the strip already marks and
 * what the list's Took column already counts, so it went.
 *
 * One box, two kinds of work. A research run streams its log, so its lines are the log's
 * (lib/researchProgress.ts). A question streams only its answer, so its lines are the four
 * moments the client can observe (lib/askTrail.ts). Nothing here is estimated, and nothing
 * here can stop the work: there is no cancel for either, so there is no button pretending
 * to be one.
 */

import { useJobLog } from '../hooks/useJobLog.ts'
import { RESEARCH_STEPS, deriveResearchProgress, EMPTY_PROGRESS } from '../lib/researchProgress.ts'
import { ASK_STEPS, deriveAskProgress, type AskProgressInput } from '../lib/askProgress.ts'
import type { TrailLine } from '../lib/askTrail.ts'
import type { JobLogLine } from '../api/types.ts'

/** How many lines the box keeps. Four: the fifth was always answered by the line above it. */
export const ACTIVITY_LINES = 4

/** The strip's labels: short, because they sit under a segment rather than beside a mark. */
const SHORT: Record<string, string> = {
  plan: 'Plan',
  search: 'Search',
  read: 'Read sources',
  file: 'Write pages',
  commit: 'Commit',
}

/**
 * Tool RESULTS are the half of the log that says nothing: `← tool ok` after every call. The
 * box shows the other half - what the agent did and what the runner reported.
 */
const isEvent = (l: JobLogLine): boolean => !/←\s*tool/.test(l.message)

/** `-8s`, `-1m20s`: how far behind the newest line this one is. */
function age(ts: string, newest: string): string {
  const d = Math.max(0, Math.round((Date.parse(newest) - Date.parse(ts)) / 1000))
  if (d === 0) return 'now'
  if (d < 60) return `-${d}s`
  return `-${Math.floor(d / 60)}m${String(d % 60).padStart(2, '0')}s`
}

/** The `[assistant] ` / `[user] ` role tag the formatter prefixes; the box has no columns for it. */
const untag = (message: string): string => message.replace(/^\[[a-z]+\]\s*/, '')

interface StageView {
  readonly id: string
  readonly label: string
  readonly title: string
}

/**
 * The box itself. Always on the screen in its mode, idle or not, and the same height in every
 * state, so work starting lights it up instead of pushing the list down - the screen does not
 * rearrange itself at the one moment the reader is watching it.
 *
 * "Every state" includes the one the two modes disagree on (2026-09-16). The log keeps the
 * last four lines of the run it belongs to, and each mode has its own: after a vault question
 * and before any web run, one box carried four lines and the other carried the empty line, so
 * switching between them resized the box and moved everything under it. The list now always
 * stands four rows tall and pads with blanks, which is also what makes a run's second line
 * appear under its first instead of pushing it up.
 */
function ActivityBox({
  live,
  title,
  topic,
  idle,
  lines,
  empty,
  stages,
  step,
  label,
}: {
  live: boolean
  /** The head's word for the live state; "Idle" otherwise. */
  title: string
  /** What it is working on, shown while live. */
  topic: string
  /** The head's line while nothing is in flight. */
  idle: string
  /** Oldest first; the box keeps the newest few and turns them round. */
  lines: readonly TrailLine[]
  /** What the box says before any line exists. */
  empty: string
  stages: readonly StageView[]
  /** Index into `stages` of the one in progress; the ones before it are done. */
  step: number
  label: string
}): React.ReactElement {
  const recent = lines.slice(-ACTIVITY_LINES).reverse()
  const newest = recent[0]?.ts ?? ''

  return (
    <section className="box activity" aria-label={label}>
      <div className="sub-head">
        <span className={live ? 'dot live' : 'dot idle'} title={live ? 'in flight' : 'nothing in flight'} />
        <h3 className="sub-title">{live ? title : 'Idle'}</h3>
        <span className="box-sub act-topic" title={topic}>
          {live ? topic : idle}
        </span>
      </div>
      <ul className="actlog">
        {recent.length === 0 ? (
          <li className={live ? 'head' : 'faint'}>
            <span className="t">{live ? 'now' : ''}</span>
            <span>{live ? 'Starting…' : empty}</span>
          </li>
        ) : (
          recent.map((l, i) => (
            <li key={`${l.ts}-${i}`} className={i === 0 ? 'head' : ''}>
              <span className="t">{age(l.ts, newest)}</span>
              <span title={l.text}>{l.text}</span>
            </li>
          ))
        )}
        {/* The rows the log does not have yet, held open. A blank rather than a fixed height
            on the list, because a row is as tall as the font says and this file should not be
            the second place that number is written down. */}
        {Array.from({ length: Math.max(0, ACTIVITY_LINES - Math.max(1, recent.length)) }, (_, i) => (
          <li className="spare" key={`spare-${i}`} aria-hidden>
            <span className="t" />
            <span>&nbsp;</span>
          </li>
        ))}
      </ul>
      {/* Centred under its own segment, and unnumbered: the strip reads left to right, so an
          ordinal restated the reading order. The current stage is the only lit one. */}
      <div className="stages" role="list" aria-label="Stages">
        {stages.map((s, i) => {
          // Idle: nothing is done and nothing is current; the strip only shows the shape.
          const state = !live ? 'todo' : i < step ? 'done' : i === step ? 'now' : 'todo'
          return (
            <div key={s.id} className={`stage ${state}`} role="listitem" title={s.title} aria-current={state === 'now' ? 'step' : undefined}>
              <span className="stage-bar" aria-hidden />
              <span className="stage-lbl">{s.label}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

const RESEARCH_STAGES: readonly StageView[] = RESEARCH_STEPS.map((s) => ({ id: s.id, label: SHORT[s.id] ?? s.title, title: s.title }))
const ASK_STAGES: readonly StageView[] = ASK_STEPS.map((s) => ({ id: s.id, label: s.short, title: s.title }))

/** A research run: the lines are the run's own log, the stages counted from it. */
export function RunActivity({ live, topic }: { live: boolean; topic: string }): React.ReactElement {
  const lines = useJobLog('maintenance:research', { seed: false })
  const p = live && lines.length > 0 ? deriveResearchProgress(lines) : EMPTY_PROGRESS
  const events = lines.filter(isEvent).map((l) => ({ ts: l.ts, text: untag(l.message) }))
  return (
    <ActivityBox
      live={live}
      title={live ? 'Running' : 'Idle'}
      topic={topic}
      idle="No run in flight"
      lines={events}
      empty="The last four lines of a run's log appear here."
      stages={RESEARCH_STAGES}
      step={p.step}
      label="The run in flight"
    />
  )
}

/** A question to the vault: the lines are the moments the client observed (hooks/useAskTrail.ts). */
export function AskActivity({
  question,
  lines,
  ...input
}: { question: string; lines: readonly TrailLine[] } & AskProgressInput): React.ReactElement {
  const p = deriveAskProgress(input)
  return (
    <ActivityBox
      live={input.pending}
      title="Answering"
      topic={question}
      idle="No question in flight"
      lines={lines}
      empty="The steps of an answer appear here as they happen."
      stages={ASK_STAGES}
      step={p.step}
      label="The question in flight"
    />
  )
}
