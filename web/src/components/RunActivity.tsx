/**
 * The agent's own section while a research run is in flight (2026-09-08).
 *
 * What the agent is doing is a live account and belongs in a box of its own above the list;
 * what a run IS belongs in the list. Folding one into the other was tried and made a row that
 * grew and shrank under the cursor. The two share nothing but the dot.
 *
 * Three things, top to bottom, and no headline between them: the run's topic, the last few
 * lines of its log, and the five stages with the current one lit. There used to be a line
 * naming the stage and the elapsed time as well - it said what the strip already marks and
 * what the list's Took column already counts, so it went.
 *
 * Everything shown is read off the log the run already streams (lib/researchProgress.ts).
 * Nothing here is estimated, and nothing here can stop the run: there is no cancel for a
 * maintenance run, so there is no button pretending to be one.
 */

import { useJobLog } from '../hooks/useJobLog.ts'
import { RESEARCH_STEPS, deriveResearchProgress, EMPTY_PROGRESS } from '../lib/researchProgress.ts'
import type { JobLogLine } from '../api/types.ts'

/** How many log lines the box keeps. Four: the fifth was always answered by the line above it. */
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

/**
 * Always on the screen in research mode, idle or not. It is the same height in both states,
 * so a run starting lights it up instead of pushing the list down - the screen does not
 * rearrange itself at the one moment the reader is watching it.
 */
export function RunActivity({ live, topic }: { live: boolean; topic: string }): React.ReactElement {
  const lines = useJobLog('maintenance:research', { seed: false })
  const p = live && lines.length > 0 ? deriveResearchProgress(lines) : EMPTY_PROGRESS
  const events = lines.filter(isEvent)
  const recent = events.slice(-ACTIVITY_LINES).reverse()
  const newest = recent[0]?.ts ?? ''

  return (
    <section className="box activity" aria-label="The run in flight">
      <div className="sub-head">
        <span className={live ? 'dot live' : 'dot idle'} title={live ? 'a run is in flight' : 'no run in flight'} />
        <h3 className="sub-title">{live ? 'Running' : 'Idle'}</h3>
        <span className="box-sub act-topic" title={topic}>
          {live ? topic : 'No run in flight'}
        </span>
      </div>
      <ul className="actlog">
        {recent.length === 0 ? (
          <li className={live ? 'head' : 'faint'}>
            <span className="t">{live ? 'now' : ''}</span>
            <span>{live ? 'Starting…' : 'The last four lines of a run\'s log appear here.'}</span>
          </li>
        ) : (
          recent.map((l, i) => (
            <li key={`${l.ts}-${i}`} className={i === 0 ? 'head' : ''}>
              <span className="t">{age(l.ts, newest)}</span>
              <span title={untag(l.message)}>{untag(l.message)}</span>
            </li>
          ))
        )}
      </ul>
      {/* Centred under its own segment, and unnumbered: the strip reads left to right, so an
          ordinal restated the reading order. The current stage is the only lit one. */}
      <div className="stages" role="list" aria-label="Stages">
        {RESEARCH_STEPS.map((step, i) => {
          // Idle: nothing is done and nothing is current; the strip only shows the shape.
          const state = !live ? 'todo' : i < p.step ? 'done' : i === p.step ? 'now' : 'todo'
          return (
            <div key={step.id} className={`stage ${state}`} role="listitem" title={step.title} aria-current={state === 'now' ? 'step' : undefined}>
              <span className="stage-bar" aria-hidden />
              <span className="stage-lbl">{SHORT[step.id] ?? step.title}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
