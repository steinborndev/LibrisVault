/**
 * The rows of Home's activity table. One table shows four kinds of event, so the row types
 * live together: they have to agree on the six columns (event, channel, pages, took, cost,
 * when) or the table stops reading as one stream.
 *
 * In-flight rows are tinted and ride at the top; a job moves down into the settled rows when
 * it commits, rather than teleporting between two screens as it did before the Inbox folded
 * into Home.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { AuthMode, Job, JobStatus, MaintenanceRun } from '../api/types.ts'
import { Cost } from './Cost.tsx'
import { Icon } from './Icon.tsx'
import { PageLink } from './PageLink.tsx'
import { useRunProgressLine } from '../hooks/useRunProgressLine.ts'
import { useState } from 'react'
import { duration, parsePages, timeAgo } from '../lib/format.ts'
import { jobNote, type ActivityEvent, contentPages } from '../lib/activity.ts'
import { RUN_RUNNING_TITLES, runTitle } from '../lib/runLabels.ts'
import { navigate, pageRoute } from '../lib/router.ts'
import { openableRow } from '../lib/tableRow.ts'

/** Stable per-channel colour, so a row's origin reads without parsing the word. */
export function channelColor(source: string): string {
  const map: Record<string, string> = {
    drop: 'var(--accent)',
    watch: 'var(--type-source)',
    telegram: 'var(--type-entity)',
    api: 'var(--type-meta)',
    url: 'var(--type-question)',
    research: 'var(--research)',
    manual: 'var(--type-meta)',
    git: 'var(--muted)',
  }
  return map[source] ?? 'var(--ok)'
}

/** Channel labels: the stored source values are terse, the panel is not. */
export function channelLabel(source: string): string {
  const map: Record<string, string> = {
    drop: 'Drop / upload',
    watch: 'Watch folder',
    url: 'Link',
    telegram: 'Telegram',
    manual: 'Manual edits',
    research: 'Research',
    git: 'Vault commit',
  }
  return map[source] ?? source
}

/**
 * Up to three page chips under a row's title; the rest is a count.
 *
 * The band used to swallow every click that landed on it - it is a full-width flex row and
 * on a three-chip ingest it is most of the row's height, so "click the row to open it" in
 * practice meant "hit the title line". Only the chips themselves stop the click now (they
 * are links of their own, in PageLink); the air around them opens the record like any
 * other part of the row.
 */
function PageChips({ vaultName, paths }: { vaultName: string; paths: readonly string[] }): React.ReactElement | null {
  if (paths.length === 0) return null
  return (
    <span className="rowpages">
      {paths.slice(0, 3).map((p) => (
        <PageLink key={p} vaultName={vaultName} path={p} tabbable={false} />
      ))}
      {paths.length > 3 && <span className="chip-n">+{paths.length - 3} more</span>}
    </span>
  )
}

/**
 * The per-row "take this out of the history" control (2026-09-05). Two clicks, the second
 * within four seconds, because the row is gone for good afterwards - the same arming the
 * "Clear history" button uses, scaled down. The vault is never touched by it.
 *
 * Lives in the seventh column, visible on hover and keyboard focus (`.rowacts`), and stops
 * the click so the row does not open underneath it.
 */
/** What the trash does to this row, in the words its tooltip uses. */
const VERBS = {
  remove: { idle: (label: string) => `Remove from history: ${label}`, armed: 'Click again to remove this entry from the history' },
  cancel: { idle: (label: string) => `Cancel this job: ${label}`, armed: 'Click again to cancel the job; it stays in the history as cancelled' },
  dismiss: { idle: (label: string) => `Take this commit off the stream: ${label}`, armed: 'Click again to take it off the stream; the vault keeps the commit' },
} as const

/**
 * The trash at the right edge of every row (second sweep, chunk 1): always there, in the same
 * place on every row, so a stream of settled things has one way to be thinned. First click
 * arms it, the second acts, four seconds and it stands down. A row nothing can be done to yet
 * (a run or an ingest in flight, a record the service keeps for itself) shows it disabled
 * and says why on hover.
 */
export function RowDelete({
  label,
  remove,
  onRemoved,
  verb = 'remove',
  disabledReason,
}: {
  label: string
  remove?: () => Promise<unknown>
  onRemoved?: () => void
  verb?: keyof typeof VERBS
  /** When set, the trash is disabled and this is its tooltip. */
  disabledReason?: string
}): React.ReactElement {
  const qc = useQueryClient()
  const [armed, setArmed] = useState(false)
  const del = useMutation({
    mutationFn: async () => remove?.(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
      void qc.invalidateQueries({ queryKey: ['maintenance-history'] })
      void qc.invalidateQueries({ queryKey: ['library-scene'] })
      onRemoved?.()
    },
    onSettled: () => setArmed(false),
  })
  const words = VERBS[verb]
  const off = disabledReason !== undefined || remove === undefined
  return (
    <span className="rowacts always">
      <button
        className={`btn ghost sm trash${armed ? ' danger' : ''}`}
        tabIndex={-1}
        disabled={off || del.isPending}
        title={off ? disabledReason : armed ? words.armed : words.idle(label)}
        aria-label={off ? (disabledReason ?? 'Nothing to remove') : armed ? 'Confirm' : words.idle(label)}
        onClick={(e) => {
          e.stopPropagation()
          if (off) return
          if (armed) del.mutate()
          else {
            setArmed(true)
            window.setTimeout(() => setArmed(false), 4000)
          }
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {del.isPending ? '…' : armed ? 'Sure?' : <Icon name="trash" />}
      </button>
    </span>
  )
}

const IN_FLIGHT_RUN = 'A run in flight is left to finish; it can be removed once it has settled.'
const IN_FLIGHT_JOB = 'An ingest in flight is left to finish; it can be removed once it has settled.'
const KEPT_SETTLE = "The kind's last settle, kept by the service for its own status; it has no history entry to remove."


/** The pipeline as three ticks - enough to see movement, not enough to need a legend. */
const PHASES: JobStatus[] = ['queued', 'preprocessing', 'ingesting']

/** A running agent run (research, lint, hot cache): in the same table as the ingests. */
export function RunRow({ run }: { run: MaintenanceRun }): React.ReactElement {
  const profiles = useQuery({ queryKey: ['research-profiles'], queryFn: api.researchProfiles })
  const profile = profiles.data?.profiles.find((p) => p.key === run.profileKey)
  const { text, ratio } = useRunProgressLine(run.channel, profile)
  const isResearch = run.kind === 'research'
  const open = (): void => navigate(isResearch ? '/research' : '/system')
  return (
    <tr className={`live${isResearch ? ' research' : ''}`} {...openableRow(open, `Open the ${run.kind} run`)}>
      <td>
        <span className="hrow-name">
          <span className="hrow-dot running" aria-hidden />
          <span className="nm">{run.label ?? RUN_RUNNING_TITLES[run.kind] ?? run.kind}</span>
          {profile !== undefined && run.profileKey !== 'broad' && <span className="lens-tag">{profile.label}</span>}
        </span>
        <span className="live-phase">{text}</span>
      </td>
      <td className="dimc">{channelLabel(run.kind)}</td>
      <td colSpan={2}>
        <span className={`minibar${isResearch ? ' research' : ''}`}>
          <i style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
      </td>
      <td className="num">-</td>
      <td className="faintc">{timeAgo(run.startedAt)}</td>
      <td className="acts">
        <RowDelete label={run.label ?? run.kind} disabledReason={IN_FLIGHT_RUN} />
      </td>
    </tr>
  )
}

/** A running or queued ingest, cancellable while it still waits. */
export function LiveJobRow({ job, onOpen }: { job: Job; onOpen: () => void }): React.ReactElement {
  const qc = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => api.cancel(job.id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      void qc.invalidateQueries({ queryKey: ['library-scene'] })
    },
  })
  const phase = PHASES.indexOf(job.status)
  const name = job.original_name ?? job.url ?? job.id
  return (
    <tr className="live" {...openableRow(onOpen, `Open job detail: ${name}`)}>
      <td>
        <span className="hrow-name">
          {/* A job held for the night wears a crescent where the others wear the status
              dot (2026-09-11): the amber dot said "waiting", and a night job is waiting for
              something the row should name. It keeps the dot's slot, so the names align. */}
          {job.hold === 'night' ? (
            <span className="hrow-moon" aria-hidden>
              <Icon name="moon" />
            </span>
          ) : (
            <span className={`hrow-dot ${job.status === 'queued' ? 'queued' : 'running'}`} aria-hidden />
          )}
          <span className="nm" title={name}>
            {name}
          </span>
          <span className="badge type">{job.type}</span>
          {/* Held for the night shift: queued, but not before the shift begins. */}
          {job.hold === 'night' && (
            <span className="hrow-state tonight" title="Held for the night shift, which runs it ahead of the Fellows">
              tonight
            </span>
          )}
        </span>
        <span className="live-phase">{job.status}</span>
      </td>
      <td className="dimc">{channelLabel(job.source)}</td>
      <td colSpan={2}>
        <span className="fsteps" aria-hidden>
          {PHASES.map((p, i) => (
            <span key={p} className={`st${i < phase ? ' on' : i === phase ? ' now' : ''}`} />
          ))}
        </span>
      </td>
      <td className="num">
        {/* A waiting job says so with a Cancel of its own, at the trash's height so the row
            keeps the column's rhythm; the trash at the edge cancels it too. */}
        {job.status === 'queued' ? (
          <button
            className="btn ghost danger sm cancel"
            disabled={cancel.isPending}
            title={job.hold === 'night' ? 'Take it off tonight: the job is cancelled and stays in the history' : 'Cancel this job; it stays in the history as cancelled'}
            onClick={(e) => {
              e.stopPropagation()
              cancel.mutate()
            }}
          >
            Cancel
          </button>
        ) : (
          '-'
        )}
      </td>
      <td className="faintc">{timeAgo(job.started_at ?? job.created_at)}</td>
      <td className="acts">
        {/* The trash cancels while the job still waits; once it runs, it is left to finish. */}
        {job.status === 'queued' ? (
          <RowDelete label={name} verb="cancel" remove={() => api.cancel(job.id)} />
        ) : (
          <RowDelete label={name} disabledReason={IN_FLIGHT_JOB} />
        )}
      </td>
    </tr>
  )
}

/** The handle for one multi-file drop: how many, how long ago, and cancel them together. */
export function BatchHead({ jobs }: { jobs: Job[] }): React.ReactElement {
  const qc = useQueryClient()
  const cancelAll = useMutation({
    // No batch endpoint - cancel each member; the queue treats them independently anyway.
    mutationFn: () => Promise.all(jobs.map((j) => api.cancel(j.id))),
    // One failed member must not abort silently - refresh either way and let the rows say so.
    onSettled: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  })
  const oldest = jobs[jobs.length - 1]!
  return (
    <tr className="batchhead">
      <td colSpan={7}>
        <strong>Batch</strong> · {jobs.length} files · {timeAgo(oldest.created_at)}
        <span className="spacer" />
        <button className="btn ghost danger sm" disabled={cancelAll.isPending} onClick={() => cancelAll.mutate()}>
          <Icon name="x" /> Cancel batch
        </button>
      </td>
    </tr>
  )
}

/** One finished ingest as a scannable row; every detail lives in the drawer. */
export function HistoryJobRow({
  job,
  vaultName,
  authMode,
  onOpen,
}: {
  job: Job
  vaultName: string
  authMode: AuthMode
  onOpen: () => void
}): React.ReactElement {
  const name = job.original_name ?? job.url ?? job.id
  // The same pages the record lists: the index hubs every ingest rewrites are not what it
  // produced, and a row that counted them said +7 where the record said +4.
  const pages = contentPages(parsePages(job.created_pages))
  const showState = job.status !== 'done'
  const noChanges = job.status === 'done' && job.outcome === 'no-changes'
  const note = jobNote(job)
  return (
    <tr {...openableRow(onOpen, `Open job detail: ${name}`)}>
      <td>
        <span className="hrow-name">
          <span className={`hrow-dot ${job.status}`} aria-hidden />
          <span className="nm" title={name}>
            {name}
          </span>
          <span className="badge type">{job.type}</span>
          {showState && <span className={`hrow-state ${job.status}`}>{job.status}</span>}
          {noChanges && <span className="hrow-state nochanges">no changes</span>}
          {job.reverted_at != null && <span className="hrow-state reverted">reverted</span>}
        </span>
        {/* A failure's line is red; a duplicate's or a no-change run's is an explanation, not an alarm. */}
        {note !== undefined && <span className={job.status === 'failed' ? 'rowerr' : 'rownote'}>{note}</span>}
        <PageChips vaultName={vaultName} paths={pages} />
      </td>
      <td className="dimc">{channelLabel(job.source)}</td>
      <td className="num">{pages.length > 0 ? `+${pages.length}` : '-'}</td>
      <td className="num">
        {job.started_at !== null && job.finished_at !== null ? duration(job.started_at, job.finished_at) : '-'}
      </td>
      <td className="num">{job.cost_usd !== null ? <Cost value={job.cost_usd} authMode={authMode} /> : '-'}</td>
      <td className="faintc">{timeAgo(job.finished_at ?? job.started_at ?? job.created_at)}</td>
      <td className="acts">
        <RowDelete label={name} remove={() => api.deleteJob(job.id)} />
      </td>
    </tr>
  )
}

/**
 * A settled agent run (research or maintenance): outcome, pages, time, cost.
 *
 * It opens its own record in the stream's slot, the same as an ingest row. It used to
 * navigate - research to the run list, everything else to System - which answered a
 * question the row had not been asked: clicking a finished run in a list of finished runs
 * means "show me this one", not "take me somewhere that lists it again".
 */
export function SettleRow({
  event,
  vaultName,
  authMode,
  onOpen,
  remove,
}: {
  event: ActivityEvent
  vaultName: string
  authMode: AuthMode
  onOpen: () => void
  /** Removes the run from the history; absent for records with no row to remove. */
  remove?: () => Promise<unknown>
}): React.ReactElement {
  // The kind names the run ("Lint report written"); a research topic is appended to it,
  // because "Research run" alone was all the per-kind settle record could ever say.
  const base = runTitle(event.runKind ?? event.kind, event.state !== 'failed')
  const name = event.title === '' ? base : `${base}: ${event.title}`
  return (
    <tr {...openableRow(onOpen, `Open the record: ${name}`)}>
      <td>
        <span className="hrow-name">
          <span className={`hrow-dot ${event.state === 'failed' ? 'failed' : 'done'}`} aria-hidden />
          <span className="nm" title={name}>
            {name}
          </span>
        </span>
        {event.note !== undefined && <span className="rowerr">{event.note}</span>}
        <PageChips vaultName={vaultName} paths={event.pages} />
      </td>
      <td className="dimc">{channelLabel(event.channel)}</td>
      <td className="num">{event.pages.length > 0 ? `+${event.pages.length}` : '-'}</td>
      <td className="num">{duration(event.startedIso ?? null, event.whenIso)}</td>
      <td className="num">{event.costUsd !== null ? <Cost value={event.costUsd} authMode={authMode} /> : '-'}</td>
      <td className="faintc">{timeAgo(event.whenIso)}</td>
      <td className="acts">
        {remove !== undefined ? <RowDelete label={name} remove={remove} /> : <RowDelete label={name} disabledReason={KEPT_SETTLE} />}
      </td>
    </tr>
  )
}

/**
 * A commit no job or run claims: a page saved or deleted by hand, or an ingest whose own
 * commit the service never recorded. Its title is the commit subject verbatim - the row
 * that puts a run's name in front of it is `SettleRow`, and a commit has no run.
 */
export function CommitRow({
  event,
  vaultName,
  onOpen,
}: {
  event: ActivityEvent
  vaultName: string
  /** Opens the commit's record when it is not a single page: the pages it touched, its hash. */
  onOpen?: () => void
}): React.ReactElement {
  const single = event.pages.length === 1 ? event.pages[0]! : null
  const open = single !== null ? () => navigate(pageRoute(single)) : onOpen
  return (
    <tr {...openableRow(open, single !== null ? `Open ${single}` : `Open the record: ${event.title}`)}>
      <td>
        <span className="hrow-name">
          <span className="hrow-dot edit" aria-hidden />
          <span className="nm" title={event.title}>
            {event.title}
          </span>
          {event.commit !== null && <span className="mono-meta">{event.commit.slice(0, 7)}</span>}
        </span>
        <PageChips vaultName={vaultName} paths={event.pages} />
      </td>
      <td className="dimc">{channelLabel(event.channel)}</td>
      <td className="num">{event.pages.length > 0 ? `+${event.pages.length}` : '-'}</td>
      <td className="num">-</td>
      <td className="num">-</td>
      <td className="faintc">{timeAgo(event.whenIso)}</td>
      <td className="acts">
        {/* Off the stream, not out of the vault: the service remembers the hash and the
            history it reads from git leaves it out from then on. */}
        {event.commit !== null ? (
          <RowDelete label={event.title} verb="dismiss" remove={() => api.dismissCommit(event.commit!)} />
        ) : (
          <RowDelete label={event.title} disabledReason="This record carries no commit hash to take off the stream." />
        )}
      </td>
    </tr>
  )
}

export type LiveRowItem = { kind: 'batch'; batchId: string; jobs: Job[] } | { kind: 'job'; job: Job }

/**
 * Live job rows in display order, with a batch header inserted before the first member of
 * each multi-file drop. Members keep their own rows underneath - the header is a handle for
 * the group, not a replacement for seeing what is in it.
 */
export function groupRows(jobs: readonly Job[], batches: ReadonlyMap<string, Job[]>): LiveRowItem[] {
  const emitted = new Set<string>()
  const out: LiveRowItem[] = []
  for (const job of jobs) {
    const id = job.batch_id
    if (id !== null && batches.has(id) && !emitted.has(id)) {
      emitted.add(id)
      out.push({ kind: 'batch', batchId: id, jobs: batches.get(id)! })
    }
    out.push({ kind: 'job', job })
  }
  return out
}

/**
 * The queue's state, next to the queue. Finding out WHY nothing is moving used to mean a
 * trip to another screen; the reason belongs where the work is listed.
 *
 * Read-only on purpose: the queue pauses itself on a spent budget or an exhausted usage
 * limit and resumes on its own, and there is no manual pause in the API. A button here
 * would either do nothing or promise a feature that does not exist.
 */
export function QueueState({
  paused,
  reason,
  concurrency,
  active,
  queued,
}: {
  paused: boolean
  reason: string | null
  concurrency: number | undefined
  active: number
  queued: number
}): React.ReactElement {
  // The old badge read "running" whenever the queue was merely WILLING to run, which is
  // what it says for an idle service too - so the panel claimed work that was not
  // happening. Three states now, and they describe the queue's actual occupation.
  const state = paused ? 'paused' : active > 0 ? 'working' : 'idle'
  return (
    <>
      <div className="queue-row">
        <span className={`badge ${state === 'paused' ? 'deferred' : state === 'working' ? 'ingesting' : ''}`}>
          {state === 'paused' ? 'paused' : state === 'working' ? `${active} running` : 'idle'}
        </span>
        {queued > 0 && <span className="badge queued">{queued} waiting</span>}
        {concurrency !== undefined && state !== 'paused' && (
          <span className="faintc">up to {concurrency} at a time</span>
        )}
      </div>
      <div className="pillhint wrap">
        {paused
          ? reason === 'budget'
            ? 'Daily budget reached - queued jobs resume at midnight.'
            : reason === 'rate-limit'
              ? 'The Anthropic usage limit is exhausted - queued jobs resume when the window resets.'
              : 'Queued jobs wait; nothing is lost.'
          : state === 'working'
            ? 'Working through the queue - rows appear at the top of the stream.'
            : 'Nothing to do. A drop, a watched file or a message starts a job within seconds.'}
      </div>
    </>
  )
}
