/**
 * Home, redesign (2026-09-11): the Library's conventions (docs/agents/SPEC.md 10.7) applied
 * to this screen - one headline with three zones, a control column that answers for what is
 * visible, and arrow keys where buttons used to repeat them.
 *
 *   BAND      the stock, as a glance. The number is the header, every countable thing is a
 *             door beside it, the picture is the door to the graph, the domains are a list.
 *             No panel heads, no switcher, no button: nothing in the band asks for a click.
 *   HEADLINE  left the view (Daily recaps | Activity), middle where
 *             you are (the day on show, the stream's kinds, the open record's path),
 *             right the one thing this state offers (Build now; the record's Article | Log).
 *   COLUMN    intake first, always, now and for the night; then the plan; then what the view
 *             in front needs and nothing else: the Fellows while the recaps show, the kind
 *             and state narrowing while the stream shows, the record list while a record
 *             is open.
 *
 * The time axis is one day, shown in the headline, for both views: the recaps to that night,
 * the stream to that day. It opens on today and moves only by key. Left and right step to
 * the nearest day that has something in the view in front (the future is no stop), PageUp
 * and PageDown seven days at a time, up and down walk the records while one is open, Enter
 * opens a focused row, Escape steps back (a record, the search, a filter). The view is
 * switched by its toggle, not by a key. The week list that used to stand in the column went
 * with the day rail (2026-09-11): one axis, one place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { Job, JobStatus } from '../api/types.ts'
import { Dropzone } from '../components/Dropzone.tsx'
import { PlanCard } from '../components/PlanCard.tsx'
import { planCorner } from '../lib/library/planCorner.ts'
import { VaultConstellation } from '../components/VaultConstellation.tsx'
import { JobDetail } from '../components/JobDetail.tsx'
import { DomainRanks } from '../components/HomePanel.tsx'
import { newPagesIn } from '../lib/homePanels.ts'
import { mainArticle } from '../lib/homeArticle.ts'
import { Icon } from '../components/Icon.tsx'
import { queryState, merge } from '../components/QueryState.tsx'
import { Cost } from '../components/Cost.tsx'
import { Fact, Facts } from '../components/Fact.tsx'
import {
  BatchHead,
  CommitRow,
  HistoryJobRow,
  LiveJobRow,
  RunRow,
  SettleRow,
  groupRows,
} from '../components/ActivityRows.tsx'
import { useActiveRuns } from '../hooks/useActiveRuns.ts'
import { useMaintenanceStatus } from '../hooks/useMaintenanceStatus.ts'
import {
  buildActivity,
  filterActivity,
  type ActivityEvent,
  type ActivityFilter,
  type ActivityKind,
  type ActivityState,
} from '../lib/activity.ts'
import { navigate } from '../lib/router.ts'
import { undecidedCount } from '../lib/recap.ts'
import { RecapFeed, titleDomain } from '../components/RecapFeed.tsx'
import { knowledgeSubgraph, vaultShape } from '../lib/vaultShape.ts'
import { TYPE_VARS, domainColor } from '../lib/domains.ts'
import { timeAgo } from '../lib/format.ts'
import { addDays, fmtDay, localDate, runsInWeek, weekStartOf } from '../lib/recapFeed.ts'

/** The event kinds as one choice - the same four the model distinguishes, plus "all". */
const KINDS: Array<{ id: ActivityKind | 'all'; label: string; hint: string }> = [
  { id: 'all', label: 'Everything', hint: 'Every change to the vault, whoever made it.' },
  { id: 'ingest', label: 'Ingests', hint: 'Files, links and messages that became pages.' },
  { id: 'research', label: 'Research', hint: 'Web-enabled runs you started on purpose.' },
  { id: 'maintenance', label: 'Maintenance', hint: 'What the vault does to itself: lint, cache, domains.' },
  { id: 'edit', label: 'Edits', hint: 'Pages you edited or deleted by hand.' },
]

/** The state filter, in pipeline order: what is happening, then how it ended. */
const STATES: Array<{ id: ActivityState; label: string }> = [
  { id: 'running', label: 'Running' },
  { id: 'queued', label: 'Queued' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
  { id: 'deferred', label: 'Deferred' },
  { id: 'duplicate', label: 'Duplicates' },
  { id: 'cancelled', label: 'Cancelled' },
]

/** Statuses a job rests in - what "clear history" is allowed to delete. */
const AT_REST: JobStatus[] = ['done', 'failed', 'deferred', 'duplicate', 'cancelled']

/** The server caps GET /jobs at 500; start smaller, one "Load older" step to the cap. */
const WINDOW_STEP = 300
const WINDOW_MAX = 500

/* The time axis is the week list in the column, not this filter's `days` - it stays null. */
const DEFAULT_FILTER: ActivityFilter = { kind: 'all', state: null, channel: null, days: null, query: '' }

/** The local calendar day an event settled on - the same shape a recap's cycleDate has. */
const eventDay = (e: ActivityEvent): string => localDate(new Date(e.whenIso))
/** The feed reports the day at its top as it scrolls; with one day on show there is nothing to hear. */
const noop = (): void => undefined

/**
 * The persisted run behind a settled-run event, if it has one. Only rows of the run log
 * (`logrun:<id>`) can be removed; a per-kind settle record or a reconstructed commit has no
 * row of its own to delete.
 */
const runIdOf = (e: ActivityEvent): string | null => (e.id.startsWith('logrun:') ? e.id.slice('logrun:'.length) : null)

/** True while the caret is somewhere the arrow keys already mean something. */
function inField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

type FlowView = 'recaps' | 'activity'

export function Home({ statusFilter = '', active = true }: { statusFilter?: string; active?: boolean }): React.ReactElement {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<ActivityFilter>(DEFAULT_FILTER)
  const [limit, setLimit] = useState(WINDOW_STEP)
  /** The activity row being read, by event id. Null = the stream itself. */
  const [detailId, setDetailId] = useState<string | null>(null)
  /** Which of the record's two views shows; the headline switches it. */
  const [detailTab, setDetailTab] = useState<'article' | 'log'>('article')
  /** Which of the box's two views is on show. Recaps by default, activity on click or arrow. */
  const [flow, setFlow] = useState<FlowView>('recaps')
  /**
   * The time axis, shared by both views: one day, and the Fellow the recaps are narrowed to.
   * It opens on TODAY: the morning's recap and the day's stream are what the screen is opened
   * for, and the day stays where it is until the reader moves it (2026-09-11).
   */
  const [day, setDay] = useState<string>(() => localDate(new Date()))
  const [fellow, setFellow] = useState<string | null>(null)
  /** The search box, one for both views: the stream matches titles and pages, the feed its sections. */
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  /** A `?filter=<state>` still looking for the day its newest match is on. */
  const jumpTo = useRef<ActivityState | null>(null)

  // `?filter=` from elsewhere (a failure count, a notification) pre-applies a state - the
  // screen stays mounted, so this must react to navigation, not just the first mount.
  useEffect(() => {
    if (statusFilter === '') return
    const state = STATES.find((s) => s.id === statusFilter)
    if (state !== undefined) {
      setFilter((f) => ({ ...f, state: state.id }))
      setFlow('activity')
      jumpTo.current = state.id
    }
  }, [statusFilter])

  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  const fellowsOn = health.data?.fellows === true
  const recaps = useQuery({ queryKey: ['recaps'], queryFn: api.recaps, enabled: fellowsOn, staleTime: 30_000, refetchInterval: 60_000 })
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, enabled: fellowsOn, staleTime: 30_000 })
  // The plan, the same card and the same cached reading the Library and the Research tab use.
  const planQ = useQuery({ queryKey: ['usage-plan'], queryFn: api.usagePlan, enabled: fellowsOn, refetchInterval: 60_000, retry: false })
  const planCard = fellowsOn ? planCorner(planQ.data, Date.now()) : null
  const rows = useMemo(() => recaps.data?.recaps ?? [], [recaps.data])
  const waiting = (() => {
    const latest = rows[0]
    return latest !== undefined && !latest.quiet ? undecidedCount(latest.model) : 0
  })()
  const view: FlowView = fellowsOn ? flow : 'activity'
  const demoMode = health.data?.demoMode === true
  const jobsQ = useQuery({ queryKey: ['jobs', limit], queryFn: () => api.jobs({ limit }) })
  const historyQ = useQuery({
    queryKey: ['maintenance-history', 'all'],
    queryFn: () => api.maintenanceHistory({ limit: 200 }),
  })
  const graphQ = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  const runs = useActiveRuns()
  const maint = useMaintenanceStatus()

  const vaultName = stats.data?.vaultName ?? 'vault'
  const authMode = stats.data?.authMode ?? 'oauth'
  const totals = stats.data?.jobs ?? {}
  const jobs = useMemo(() => jobsQ.data?.jobs ?? [], [jobsQ.data])

  const events = useMemo(
    () =>
      buildActivity({
        jobs,
        activeRuns: runs.running,
        runHistory: historyQ.data?.runs ?? [],
        lastRuns: [...(maint.data?.lastRuns.values() ?? [])],
        commits: stats.data?.commits ?? [],
      }),
    [jobs, runs.running, historyQ.data, maint.data, stats.data],
  )

  // ---- The day on show. ----
  const today = localDate(new Date())

  /*
   * The stream, windowed to the day on show. Live rows are always in - something running now
   * is never "not today".
   */
  const windowed = useMemo(() => events.filter((e) => e.live || eventDay(e) === day), [events, day])
  const now = new Date()
  /** The column's narrowing plus the search box. */
  const liveFilter = { ...filter, query }
  const shown = filterActivity(windowed, liveFilter, now)
  const live = shown.filter((e) => e.live)
  const settled = shown.filter((e) => !e.live)
  /*
   * The days the arrows can land on, newest first: the nights that have a recap, or the days
   * the stream has something on under the current narrowing - and today whatever it holds,
   * because that is where the screen opens. Never the future.
   */
  const stops = ((): string[] => {
    const set = new Set<string>([today])
    if (view === 'recaps') for (const r of rows) set.add(r.cycleDate)
    else for (const e of filterActivity(events.filter((x) => !x.live), liveFilter, now)) set.add(eventDay(e))
    return [...set].filter((d) => d <= today).sort((a, b) => b.localeCompare(a))
  })()
  const liveJobs = live.filter((e) => e.job !== undefined).map((e) => e.job!)
  const liveRuns = live.filter((e) => e.run !== undefined).map((e) => e.run!)

  const detailEvent =
    detailId === null ? null : (events.find((e) => e.id === detailId || e.job?.id === detailId) ?? null)
  const detailArticle = detailEvent !== null && mainArticle(detailEvent.pages) !== null

  const batches = useMemo(() => {
    const m = new Map<string, Job[]>()
    for (const j of jobs) {
      if (j.status !== 'queued' || j.batch_id === null) continue
      m.set(j.batch_id, [...(m.get(j.batch_id) ?? []), j])
    }
    return new Map([...m].filter(([, group]) => group.length > 1))
  }, [jobs])

  /** What one pill would show - every OTHER axis of the filter, and the window, still applied. */
  const facet = (patch: Partial<ActivityFilter>): number => filterActivity(windowed, { ...liveFilter, ...patch }, now).length

  const stateCount = (id: ActivityState): number => {
    if (id === 'running' || id === 'queued') return events.filter((e) => e.live && e.state === id).length
    return totals[id] ?? events.filter((e) => e.state === id).length
  }
  /* The states that hold anything. A closed set of seven with six zeros in it said nothing;
     with everything done there is one line to say instead of one chip to click. */
  const heldStates = STATES.filter((s) => stateCount(s.id) > 0 || filter.state === s.id)
  const stateChips = heldStates.some((s) => s.id !== 'done') ? heldStates : []

  const filtered = filter.kind !== 'all' || filter.state !== null || filter.channel !== null || filter.query !== ''
  const reset = (): void => setFilter(DEFAULT_FILTER)

  /*
   * A pre-applied state is meant to SHOW something. Once the events are in, the day jumps to
   * the newest match - a failure from three weeks ago must not land the reader on an empty
   * table.
   */
  useEffect(() => {
    const want = jumpTo.current
    if (want === null || events.length === 0) return
    const newest = [...events].filter((e) => !e.live && e.state === want).sort((a, b) => b.whenIso.localeCompare(a.whenIso))[0]
    jumpTo.current = null
    if (newest !== undefined) setDay(eventDay(newest))
  }, [events])

  const clearable = filter.state !== null && AT_REST.includes(filter.state as JobStatus) ? (filter.state as JobStatus) : null
  const clearCount =
    clearable === null ? AT_REST.reduce((sum, st) => sum + (totals[st] ?? 0), 0) : (totals[clearable] ?? 0)

  const clear = useMutation({
    mutationFn: () => api.clearHistory(clearable ?? undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
  /* Retry stood in the record's own bar; the bar folded into the headline, so it stands there. */
  const retry = useMutation({
    mutationFn: (id: string) => api.retry(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  // Two-step confirm on the button itself. First click arms it for 4 s, second click clears.
  const [armedLeft, setArmedLeft] = useState<number | null>(null)
  const armTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const disarm = (): void => {
    if (armTimer.current) clearInterval(armTimer.current)
    armTimer.current = null
    setArmedLeft(null)
  }
  useEffect(
    () => () => {
      if (armTimer.current) clearInterval(armTimer.current)
    },
    [],
  )
  const onClear = (): void => {
    if (armedLeft === null) {
      setArmedLeft(4)
      armTimer.current = setInterval(() => {
        setArmedLeft((s) => {
          if (s === null || s <= 1) {
            disarm()
            return null
          }
          return s - 1
        })
      }, 1000)
      return
    }
    disarm()
    clear.mutate()
  }

  const streamState = queryState(merge(jobsQ, stats), 'the activity stream')
  const statPlaceholder = stats.isError ? '-' : '…'

  const shape = vaultShape(graphQ.data)
  const constellation = useMemo(
    () => (graphQ.data === undefined ? null : knowledgeSubgraph(graphQ.data)),
    [graphQ.data],
  )
  const growth = stats.data?.growth ?? []
  const grew7 = newPagesIn(growth, 7, now.getTime())
  const grew30 = newPagesIn(growth, 30, now.getTime())
  const kinds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of constellation?.nodes ?? []) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [constellation])
  const legend = kinds.slice(0, 4)
  const legendRest = kinds.slice(4).reduce((sum, [, n]) => sum + n, 0)
  const historyCount = jobs.filter((j) => AT_REST.includes(j.status)).length
  const allTime = AT_REST.reduce((sum, st) => sum + (totals[st] ?? 0), 0)

  // ---- Walking the days. ----
  const fellows = useMemo(() => (agents.data?.fellows ?? []).filter((f) => f.agent.state !== 'retired'), [agents.data])
  /** Moving the day closes an open record: it belongs to another day's list. */
  const go = (date: string): void => {
    setDay(date)
    setDetailId(null)
  }
  /** Left is back in time, right is forward: the nearest stop on that side of the day on show. */
  const stepDay = (toward: 'older' | 'newer'): void => {
    const next = toward === 'older' ? stops.find((d) => d < day) : [...stops].reverse().find((d) => d > day)
    if (next !== undefined) go(next)
  }
  /** Seven days at a time, landing on a stop: the nearest one at least a week away, else the far end. */
  const stepWeek = (toward: 'older' | 'newer'): void => {
    const target = addDays(day, toward === 'older' ? -7 : 7)
    const next = toward === 'older' ? (stops.find((d) => d <= target) ?? stops[stops.length - 1]) : ([...stops].reverse().find((d) => d >= target) ?? stops[0])
    if (next === undefined) return
    if (toward === 'older' ? next < day : next > day) go(next)
  }

  const openView = useCallback((v: FlowView): void => {
    setDetailId(null)
    setFlow(v)
  }, [])
  const openDetail = (id: string): void => {
    setDetailTab('article')
    setDetailId(id)
  }
  const stepRecord = (delta: number): void => {
    if (detailEvent === null || settled.length === 0) return
    const at = settled.findIndex((e) => e.id === detailEvent.id)
    const next = settled[(at + delta + settled.length) % settled.length]!
    openDetail(next.id)
  }

  /*
   * The keys, only while Home is the screen in front and the caret is not in a field. Left
   * and right step the day, PageUp and PageDown step a week, in both views and over an open
   * record (which they close: it belongs to another day's list); up and down walk the records
   * while one is open; Escape steps back one level. Enter belongs to a focused row (the rows
   * are tab stops of their own).
   */
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (inField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        stepDay(e.key === 'ArrowLeft' ? 'older' : 'newer')
        return
      }
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault()
        stepWeek(e.key === 'PageUp' ? 'older' : 'newer')
        return
      }
      if (detailEvent !== null && view === 'activity') {
        // Escape belongs to the record itself (JobDetail closes on it).
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          stepRecord(e.key === 'ArrowDown' ? 1 : -1)
        }
        return
      }
      if (e.key === 'Tab' && view === 'activity') {
        /*
         * Tab walks the stream's rows and nothing else: from anywhere on the screen the first
         * press lands on a row, the next ones step through them and wrap at the end. The header
         * tabs and the column took a dozen presses before the first row came up. Shift+Tab on
         * the first row is left to the browser, so the table can still be left upwards.
         */
        const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>('.home-main .dtable tbody tr[tabindex]'))
        if (rows.length === 0) return
        const at = rows.indexOf(document.activeElement as HTMLTableRowElement)
        if (e.shiftKey && at === 0) return
        const next = at === -1 ? (e.shiftKey ? rows.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + rows.length) % rows.length
        e.preventDefault()
        rows[next]!.focus()
        rows[next]!.scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Escape') {
        if (query !== '') setQuery('')
        else if (view === 'recaps' && fellow !== null) setFellow(null)
        else if (view === 'activity' && filtered) reset()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="workspace">
      <aside className="gpanel" aria-label="Home controls">
        {/* Intake first: it is the reason to open the app at all. The two other ways in are
            the header's own chips, one row up, so they are not restated here. */}
        {!demoMode && (
          <div className="gp-sec">
            <div className="gp-head">
              <span className="gp-eyebrow" title="Files, links and notes go into the queue right away; the next free worker files them, and the Activity stream shows each one settle.">
                Add now
              </span>
            </div>
            <Dropzone legend={false} />
          </div>
        )}
        {/* The same box for the night: what it takes is held until the shift begins and runs
            ahead of every Fellow, so the Fellows plan on a vault that already holds it. */}
        {!demoMode && fellowsOn && (
          <div className="gp-sec">
            <div className="gp-head">
              <span className="gp-eyebrow" title="The same box, but everything it takes is held until the night shift begins. The shift runs these first, ahead of every Fellow, so the Fellows plan on a vault that already holds them. The Night shift window lists what is waiting and lets you take it off again.">
                Add to night shift
              </span>
            </div>
            <Dropzone legend={false} when="night" />
          </div>
        )}
        {/* The plan, between the two boxes and the view's own sections: what tonight can cost
            against what is left of the windows. The same card as the Library's corner and the
            Research tab's rail. */}
        {planCard !== null && (
          <div className="gp-sec">
            <div className="gp-head">
              <span className="gp-eyebrow">Plan usage</span>
            </div>
            <PlanCard corner={planCard} />
          </div>
        )}

        {view === 'recaps' ? (
          /* The Fellows, as the Library's own rows: a click narrows the feed to one of them,
             the same row again widens it. One row to spawn, not five empty slots. */
          <div className="gp-sec grow">
            <div className="gp-head">
              <span className="gp-eyebrow">Fellows</span>
              <span className="spacer" />
              {fellow !== null ? (
                <button className="btn ghost" onClick={() => setFellow(null)} title="Every Fellow again · Esc">
                  <Icon name="x" /> Clear
                </button>
              ) : (
                <span className="gp-count">{fellows.length}</span>
              )}
            </div>
            <div className="lib-deps">
              {fellows.map((f) => {
                const n = runsInWeek(rows, weekStartOf(day), f.agent.name)
                const on = fellow === f.agent.name
                return (
                  <button
                    key={f.agent.id}
                    className="lib-frow"
                    aria-pressed={on}
                    title={on ? 'Every Fellow again' : `Only ${f.agent.name}'s nights`}
                    onClick={() => setFellow(on ? null : f.agent.name)}
                  >
                    <span className="d" style={{ background: domainColor(f.agent.homeDomain) }} aria-hidden />
                    <span className="who">
                      <b>{f.agent.name}</b>
                      <span className="st">
                        {titleDomain(f.agent.homeDomain)} · {n === 0 ? 'no run this week' : `${n} run${n === 1 ? '' : 's'} this week`}
                      </span>
                    </span>
                  </button>
                )
              })}
              {/* The night shift in the Library: its overview lists every shelf with the button
                  that spawns one there, which is the choice a new Fellow starts with. */}
              <button className="lib-frow spawn" onClick={() => navigate('/library?cc=1')} title="Opens the night shift in the Library">
                <span className="d" aria-hidden />
                <span className="who">
                  <b>Spawn a Fellow</b>
                  <span className="st">{fellows.length === 0 ? 'nobody works the nights yet' : 'one more desk in the Library'}</span>
                </span>
              </button>
            </div>
          </div>
        ) : detailEvent !== null ? (
          /* A record is open: the column becomes the stream's own list, the way the
             department list stands beside an open shelf. Up and down walk it. */
          <div className="gp-sec grow">
            <div className="gp-head">
              <span className="gp-eyebrow">Records</span>
              <span className="spacer" />
              <span className="gp-count">{settled.length}</span>
            </div>
            <div className="lib-deps home-recs">
              {settled.map((e) => (
                <button
                  key={e.id}
                  className={`lib-drow pick${e.id === detailEvent.id ? ' on' : ''}`}
                  title={e.title}
                  onClick={() => openDetail(e.id)}
                >
                  <span className={`hrow-dot ${e.state}`} aria-hidden />
                  <span className="nm">{e.title !== '' ? e.title : (e.runKind ?? e.kind)}</span>
                  <span className="when">{timeAgo(e.whenIso)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* The type, one row each with the count it would leave on the table. The reset
                lives in the head of the first filtering section. */}
            <div className="gp-sec">
              <div className="gp-head">
                <span className="gp-eyebrow">Type</span>
                <span className="spacer" />
                {filtered && (
                  <button className="btn ghost" onClick={reset} title="Every kind and state again · Esc">
                    Reset
                  </button>
                )}
              </div>
              <div className="pillrow stacked" role="radiogroup" aria-label="Event type">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    className="viewpill"
                    role="radio"
                    aria-checked={filter.kind === k.id}
                    title={k.hint}
                    onClick={() => setFilter({ ...filter, kind: k.id })}
                  >
                    <span className="pl">{k.label}</span>
                    <span className="pn">{facet({ kind: k.id })}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="gp-sec">
              <div className="gp-head">
                <span className="gp-eyebrow">State</span>
                <span className="spacer" />
                <span className="gp-state">{filter.state ?? 'all'}</span>
              </div>
              {stateChips.length === 0 ? (
                <div className="gp-none">Everything settled · {stateCount('done')} done</div>
              ) : (
                <div className="statechips" role="radiogroup" aria-label="State">
                  {stateChips.map((s) => {
                    const on = filter.state === s.id
                    return (
                      <button
                        key={s.id}
                        className="viewpill"
                        role="radio"
                        aria-checked={on}
                        onClick={() => setFilter({ ...filter, state: on ? null : s.id })}
                      >
                        <span className={`hrow-dot ${s.id}`} aria-hidden />
                        {s.label}
                        <span className="pn">{stateCount(s.id)}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )}

      </aside>

      <div className="home-main">
        {/* THE BAND - the stock, as a glance. No heads: the number is the header, the picture
            says what it is, the list says what it lists. Every figure is a door. */}
        <section className="vaultzone">
          <div className="vz-hero">
            <div className="vz-n">{stats.data?.pages.total ?? statPlaceholder}</div>
            <div className="vz-k">pages in the wiki</div>
            <div className="vz-facts">
              <button className="vzf" onClick={() => navigate('/graph')}>
                <b>{shape !== null ? shape.links.toLocaleString('en-US') : statPlaceholder}</b>
                <span>links between pages</span>
              </button>
              <button className="vzf" onClick={() => navigate('/graph')}>
                <b>{shape !== null ? shape.medianDegree : statPlaceholder}</b>
                <span>median links per page</span>
              </button>
              <button className="vzf" onClick={() => navigate('/catalog')}>
                <b>{shape !== null ? shape.domains : statPlaceholder}</b>
                <span>
                  domains
                  {shape !== null && shape.undomained > 0 ? `, ${shape.undomained} pages unfiled` : ''}
                </span>
              </button>
              {/* The gaps view of the graph lists them, and carries the unlink picker now. */}
              <button
                className="vzf"
                onClick={() => navigate('/graph?gaps=1')}
                title={
                  shape === null
                    ? undefined
                    : `${shape.gaps} page names other pages link to but that nobody has written. The graph counts ${shape.unresolved} dangling wikilinks in all - the rest point at staging files, or are quoted by lint reports, session logs and the plugin's own doc pages, and are nobody's backlog.`
                }
              >
                <b>{shape !== null ? shape.gaps : statPlaceholder}</b>
                <span>pages linked but not written</span>
              </button>
              {/* Growth as two doors: the week opens the stream on this week, the month opens
                  the chart it was read off. */}
              <button
                className="vzf"
                onClick={() => {
                  setFilter(DEFAULT_FILTER)
                  go(today)
                  openView('activity')
                }}
                title="New wiki pages over the last 7 days, from the vault's own git history. Opens the stream on today."
              >
                <b>{grew7 === null ? statPlaceholder : `+${grew7}`}</b>
                <span>new pages in 7 days</span>
              </button>
              <button
                className="vzf"
                onClick={() => navigate('/system?section=vault')}
                title="New wiki pages over the last 30 days - as far back as the growth series reaches. Opens the growth chart."
              >
                <b>{grew30 === null ? statPlaceholder : `+${grew30}`}</b>
                <span>new pages in 30 days</span>
              </button>
            </div>
          </div>

          <div className="vz-panel bare">
            <div className="vz-body first frame">
              {constellation !== null ? (
                <VaultConstellation
                  nodes={constellation.nodes}
                  edges={constellation.edges}
                  onOpen={() => navigate('/graph')}
                />
              ) : (
                (queryState(graphQ, 'the vault graph') ?? <div className="empty">No pages yet.</div>)
              )}
            </div>
            <div className="vz-foot">
              {legend.map(([dir, n]) => (
                <span key={dir} className="vzl">
                  <span className="dot" style={{ background: `var(${TYPE_VARS[dir] ?? '--type-meta'})` }} aria-hidden />
                  {dir} <b>{n}</b>
                </span>
              ))}
              {legendRest > 0 && (
                <span className="vzl">
                  <span className="dot" style={{ background: 'var(--type-meta)' }} aria-hidden />
                  other <b>{legendRest}</b>
                </span>
              )}
            </div>
          </div>
          <div className="vz-panel bare">
            <div className="vz-body first inset tall">
              {/* A domain is a shelf: the click opens that shelf's window in the Library, the way
                  a click on the shelf in the room does. Without Fellows there is no Library tab,
                  and the catalog filtered to the domain is the next best door. */}
              <DomainRanks
                nodes={graphQ.data?.nodes ?? []}
                onOpenDomain={(domain) => navigate(fellowsOn ? `/library?shelf=${encodeURIComponent(domain)}` : `/catalog?domain=${encodeURIComponent(domain)}`)}
              />
            </div>
          </div>
        </section>

        {/* THE BOX - one headline, three zones, one control height. */}
        <div className="box">
          <div className="graph-controls lib-headline home-headline">
            <div className="lib-head-left">
              {fellowsOn ? (
                <div className="seg sm" role="tablist" aria-label="View">
                  <button role="tab" aria-selected={view === 'recaps'} onClick={() => openView('recaps')} title={`Daily recaps${waiting > 0 ? ` · ${waiting} undecided` : ''}`}>
                    Daily recaps
                  </button>
                  <button role="tab" aria-selected={view === 'activity'} onClick={() => openView('activity')} title="Activity">
                    Activity
                  </button>
                </div>
              ) : (
                <h2 className="box-title">Activity</h2>
              )}
            </div>
            <div className="lib-head-mid">
              {detailEvent !== null && view === 'activity' ? (
                <span className="lib-open">
                  <button className="lib-crumb" onClick={() => setDetailId(null)} title="Back to the stream · Esc">
                    Activity
                  </button>
                  <span className="lib-sep" aria-hidden>
                    /
                  </span>
                  <span className="home-crumb-t" title={detailEvent.title}>
                    {detailEvent.title}
                  </span>
                </span>
              ) : (
                /* Where you are: the one day, in a slot of fixed width, so walking the days
                   moves the letters and nothing else. The two arrows beside it are the same
                   step the keys make, and the sign that the date is a place to move from. */
                <span className="lib-open home-where">
                  <button
                    className="wh-step prev"
                    aria-label="Previous day"
                    title="The day before this one that has something · ←"
                    disabled={!stops.some((d) => d < day)}
                    onClick={() => stepDay('older')}
                  >
                    <Icon name="chevron" />
                  </button>
                  <b>{fmtDay(day)}</b>
                  <button
                    className="wh-step next"
                    aria-label="Next day"
                    title="The next day that has something · →"
                    disabled={!stops.some((d) => d > day)}
                    onClick={() => stepDay('newer')}
                  >
                    <Icon name="chevron" />
                  </button>
                </span>
              )}
            </div>
            <div className="lib-head-right">
              {/* One search box for both views. The stream matches titles and the pages a row
                  wrote, the feed keeps the days and Fellow sections that say the word. Escape
                  in the box clears it and hands the keys back to the screen. */}
              {(view === 'recaps' || detailEvent === null) && (
                <input
                  ref={searchRef}
                  className="input sm home-search"
                  type="search"
                  placeholder={view === 'recaps' ? 'Search the recaps…' : 'Search the stream…'}
                  aria-label={view === 'recaps' ? 'Search the recaps' : 'Search the stream'}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setQuery('')
                      e.currentTarget.blur()
                    }
                  }}
                />
              )}
              {view === 'activity' && detailEvent?.job !== undefined && (detailEvent.job.status === 'failed' || detailEvent.job.status === 'deferred') && (
                <button className="btn sm" disabled={retry.isPending} onClick={() => retry.mutate(detailEvent.job!.id)}>
                  {retry.isPending ? 'Retrying…' : 'Retry'}
                </button>
              )}
              {view === 'activity' && detailEvent !== null && detailArticle && (
                <div className="seg sm" role="radiogroup" aria-label="What to show">
                  <button role="radio" aria-checked={detailTab === 'article'} onClick={() => setDetailTab('article')}>
                    Article
                  </button>
                  <button role="radio" aria-checked={detailTab === 'log'} onClick={() => setDetailTab('log')}>
                    Log
                  </button>
                </div>
              )}
            </div>
          </div>

          {view === 'recaps' ? (
            <div className="flow-view" id="flow-recaps" role="tabpanel">
              <RecapFeed vaultName={vaultName} compact control={{ week: weekStartOf(day), day, fellow, query, onVisible: noop }} />
            </div>
          ) : (
            <>
              {/* The stream's five figures describe the stream. While a record is open the
                  box is the record's, and its own facts stand where these did. */}
              {detailEvent === null && (
              <Facts size="lead">
                <Fact
                  k="Events"
                  v={shown.length}
                  sub={day !== null ? 'on this day' : query !== '' || filtered ? 'matching, this week' : 'this week'}
                  size="lead"
                />
                <Fact
                  k="In flight"
                  v={events.filter((e) => e.live).length}
                  sub={`${events.filter((e) => e.live && e.state === 'running').length} running, ${events.filter((e) => e.state === 'queued').length} queued`}
                  size="lead"
                  onOpen={() => setFilter({ ...DEFAULT_FILTER, state: 'running' })}
                />
                <Fact
                  k="Failures · 7d"
                  v={stats.data?.kpis7d.failures ?? statPlaceholder}
                  tone={(stats.data?.kpis7d.failures ?? 0) > 0 ? 'err' : undefined}
                  sub={(stats.data?.kpis7d.failures ?? 0) > 0 ? 'retry from the row' : 'nothing failed this week'}
                  size="lead"
                  onOpen={() => {
                    setFilter({ ...DEFAULT_FILTER, state: 'failed' })
                    jumpTo.current = 'failed'
                  }}
                />
                <Fact
                  k="Ingests · 7d"
                  v={stats.data?.kpis7d.ingests ?? statPlaceholder}
                  sub={`${stats.data?.usage.today.ingests ?? 0} today`}
                  size="lead"
                  onOpen={() => {
                    setFilter({ ...DEFAULT_FILTER, kind: 'ingest' })
                    go(today)
                  }}
                />
                <Fact
                  k="Spend today"
                  v={
                    stats.data !== undefined ? (
                      <Cost value={stats.data.usage.today.costUsd} authMode={authMode} />
                    ) : (
                      statPlaceholder
                    )
                  }
                  sub={
                    stats.data?.budget.limit != null
                      ? `${Math.min(100, Math.round((stats.data.budget.spent / stats.data.budget.limit) * 100))}% of the daily budget`
                      : 'no daily budget set'
                  }
                  size="lead"
                  onOpen={() => navigate('/system?section=usage')}
                />
                <Fact
                  k="Checks due"
                  v={maint.data?.status.due ?? statPlaceholder}
                  tone={(maint.data?.status.due ?? 0) > 0 ? 'warn' : undefined}
                  sub={
                    maint.data === null
                      ? 'checking…'
                      : (maint.data?.status.recommended ?? 0) > 0
                        ? `${maint.data?.status.recommended} recommended soon`
                        : 'nothing else pending'
                  }
                  size="lead"
                  onOpen={() => navigate('/system')}
                />
              </Facts>
              )}

              {detailEvent === null ? (
                <>
                  {clear.error != null && <div className="toast err">Clearing failed: {(clear.error as Error).message}</div>}

                  <div className="box-body">
                    <table className="dtable inbox-table">
                      <thead>
                        <tr>
                          <th>Event</th>
                          <th>Channel</th>
                          <th className="num">Pages</th>
                          <th className="num">Took</th>
                          <th className="num">Cost</th>
                          <th>When</th>
                          <th className="acts" aria-label="Row actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {live.length > 0 && (
                          <tr className="livehead">
                            <td colSpan={7}>In flight - {live.length}</td>
                          </tr>
                        )}
                        {liveRuns.map((r) => (
                          <RunRow key={r.id} run={r} />
                        ))}
                        {groupRows(liveJobs, batches).map((row) =>
                          row.kind === 'batch' ? (
                            <BatchHead key={`batch:${row.batchId}`} jobs={row.jobs} />
                          ) : (
                            <LiveJobRow key={row.job.id} job={row.job} onOpen={() => openDetail(row.job.id)} />
                          ),
                        )}
                        {settled.map((e) =>
                          e.job !== undefined ? (
                            <HistoryJobRow
                              key={e.id}
                              job={e.job}
                              vaultName={vaultName}
                              authMode={authMode}
                              onOpen={() => openDetail(e.id)}
                            />
                          ) : e.runKind === undefined ? (
                            /* A commit no job or run claims. It used to be "any event with a hash",
                               which was right until the run log started keeping hashes (schema v13):
                               from then on every research step and research run rendered as a bare
                               commit, openable only when it wrote exactly one page, and then as that
                               page. A run has a record; only the reconstructed commits have none. */
                            <CommitRow key={e.id} event={e} vaultName={vaultName} onOpen={() => openDetail(e.id)} />
                          ) : (
                            <SettleRow
                              key={e.id}
                              event={e}
                              vaultName={vaultName}
                              authMode={authMode}
                              onOpen={() => openDetail(e.id)}
                              {...(runIdOf(e) !== null ? { remove: () => api.deleteRun(runIdOf(e)!) } : {})}
                            />
                          ),
                        )}
                        {shown.length === 0 && (
                          <tr className="staterow">
                            <td colSpan={7}>
                              {streamState ?? (
                                <div className="empty">
                                  {filtered || query !== ''
                                    ? 'Nothing matches these filters.'
                                    : 'Nothing happened on this day. Left and right step to the days that have something, or drop a file on the left.'}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="box-foot">
                    <span>
                      {shown.length} shown · {fmtDay(day)} · {historyCount} stored
                      {allTime > historyCount ? ` · ${allTime} all-time` : ''}
                    </span>
                    <span className="spacer" />
                    {historyCount >= limit && limit < WINDOW_MAX && (
                      <button className="btn sm" onClick={() => setLimit(WINDOW_MAX)}>
                        Load older
                      </button>
                    )}
                    <span className="dim">← → step the day · PgUp PgDn a week · Tab to a row, Enter opens it · Esc steps back</span>
                    {/* History management lives with the history count, not in the headline:
                        it is rare, and it is the one destructive thing on the screen. */}
                    {clearCount > 0 && (
                      <button
                        className={`btn sm ${armedLeft !== null ? 'armed' : 'ghost danger'}`}
                        disabled={clear.isPending}
                        onClick={onClear}
                        title={
                          clearable === null
                            ? 'Deletes every stored history entry (all statuses, including ones not shown), and with it the token and cost history those entries carry. The vault and created pages stay untouched.'
                            : `Deletes every stored "${clearable}" entry, including ones the filters hide, and with it the token and cost history those entries carry. The vault and created pages stay untouched.`
                        }
                      >
                        {armedLeft !== null
                          ? `Really delete ${clearCount} ${clearable === null ? 'entries' : `${clearable} entries`}? (${armedLeft})`
                          : clearable === null
                            ? 'Clear history'
                            : `Clear ${clearable}`}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <JobDetail
                  event={detailEvent}
                  vaultName={vaultName}
                  authMode={authMode}
                  onBack={() => setDetailId(null)}
                  bar={false}
                  tab={detailTab}
                  onTab={setDetailTab}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
