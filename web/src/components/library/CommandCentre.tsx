/**
 * The Fellow command centre (docs/tasks/TASKS-A7.md).
 *
 * Opens over the room in the frame a department gets, and takes the same two-line headline:
 * the shelf's name in the middle of the row above, what is there in the row below. The
 * rotation therefore lives in `LibraryScreen` and arrives as props - the headline belongs to
 * the screen, the body to the window - and while the window is open the room's own controls
 * stand down: no mode toggle, no room strip, and the arrows reach the window rather than
 * paging the room behind it.
 *
 * Every number here is real: the shelves come from the domain registry and the graph, the
 * Fellows and their proposals from the agents API, the night's hours from the settings, and
 * the length of a task from what the service measured its own runs to take. The arithmetic
 * that turns those into a night lives in `lib/command/model.ts`, under test.
 *
 * Everything the window draws is now also something it can change: the shelves reorder into
 * the order the night walks them, a Fellow's art and how much of the night it takes are fields
 * on its record, and a new Fellow is spawned from one of four shapes that the service holds it
 * to. Until A7 stage B those three said "not built" where they stood; the fields landed with
 * migration V23.
 */

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import type { AgentPatchBody, FellowCard, FellowRecord, FellowSummary, ProposalRecord, RecapFellow, SpawnBody, TaskKind } from '../../api/types.ts'
import {
  carriedTonight,
  fellowMinutes,
  scheduleFrom,
  shelfOrder,
  shelvesFrom,
  tasksTonight,
  windowMinutes,
  type Block,
  type Shelf,
} from '../../lib/command/model.ts'
import { domainColor } from '../../lib/domains.ts'
import { navigate, pageRoute } from '../../lib/router.ts'
import { SpawnForm } from './SpawnForm.tsx'
import { queryState } from '../QueryState.tsx'
import { usd } from '../../lib/format.ts'

export type CcView = 'shelves' | 'tonight' | 'dossier' | 'decisions' | 'spawn'
type Pane = 'notebook' | 'recap' | 'ledger' | 'pages' | 'settings'

/** The night, drawn 18:00 to 06:00: one scale for the hours and for the work inside them. */
const SCALE_FROM = 18 * 60
const SCALE_TO = 30 * 60
const SCALE_SPAN = SCALE_TO - SCALE_FROM
const pctAt = (m: number): number => ((m - SCALE_FROM) / SCALE_SPAN) * 100
const SCALE_HOURS = Array.from({ length: SCALE_SPAN / 60 + 1 }, (_, i) => SCALE_FROM + i * 60)
const pad2 = (n: number): string => String(n).padStart(2, '0')
const hhmm = (m: number): string => `${pad2(Math.floor((m % 1440) / 60))}:${pad2(Math.round(m) % 60)}`
const dur = (m: number): string => (m >= 60 ? `${Math.floor(m / 60)} h ${pad2(Math.round(m % 60))}` : `${Math.round(m)} min`)
const clock = (m: number): string => `${pad2(Math.floor((m % 1440) / 60))}:${pad2(Math.round(m) % 60)}`

/** What each art is, in the words the app already uses (lib/library/tasks.ts, planner.ts). */
const ART_TEXT: Record<TaskKind, string> = {
  watch: 'Searches the web for what is new in a subject. Never finished.',
  explore: 'Searches the web to answer one question. The only art that can be put to rest.',
  deepen: 'Extends the pages the vault already has on a theme, at most four a night.',
}

/**
 * The four shapes a Fellow is spawned as. A shape is a starting point AND a promise: the
 * service holds a Fellow to its `art`, so an observer cannot later be given a deepen task
 * (`artRefusal`). `custom` is the one that promises nothing, which is why it exists.
 */
const SHAPES: ReadonlyArray<{
  readonly art: FellowRecord['art']
  readonly name: string
  readonly line: string
  readonly body: string
}> = [
  {
    art: 'watch',
    name: 'Observer',
    line: 'up to three subjects, watched',
    body: 'Sweeps the web for what is new in each subject and files what it finds. Never finished, so it never falls quiet.',
  },
  {
    art: 'explore',
    name: 'Researcher',
    line: 'up to three questions, answered',
    body: 'Pursues one question at a time until the vault can answer it, then puts that question to rest and takes the next.',
  },
  {
    art: 'deepen',
    name: 'Librarian',
    line: 'up to three themes, built out',
    body: 'Reads no further than the shelf: it extends the pages the vault already has on a theme, at most four a night.',
  },
  {
    art: 'custom',
    name: 'Custom',
    line: 'any mix of the three',
    body: 'One Fellow that watches, asks and extends. Nothing holds it to a single art, so nothing warns you when it drifts across them.',
  },
]

const shapeOf = (art: FellowRecord['art']): (typeof SHAPES)[number] => SHAPES.find((x) => x.art === art) ?? SHAPES[3]!

/** What each autonomy mode means, from `fellows.ts` `runnable()`. */
const AUTONOMY: Record<string, { label: string; short: string; long: string }> = {
  manual: {
    label: 'Ask me every time',
    short: 'asks first',
    long: 'Nothing runs unless you approve it. A night with no approval is a night with no result.',
  },
  veto: {
    label: 'Run unless I stop it',
    short: 'runs unless stopped',
    long:
      'Tonight it plans; tomorrow night the top proposal runs, unless you veto it during the day. A proposal that ' +
      'drifts too far from the intent still waits for you.',
  },
  auto: {
    label: 'Run the same night',
    short: 'runs the same night',
    long: 'Plans and carries out its top proposal in one night. Drifting proposals are dropped rather than shown to you.',
  },
}
const autonomyOf = (k: string): { label: string; short: string; long: string } => AUTONOMY[k] ?? AUTONOMY['veto']!

/** One shared empty list: a fresh `[]` each render would re-sort the shelves on every render. */
const NO_ORDER: readonly string[] = []

/** Below this overlap the service calls a proposal drift and will not run it unasked. */
const DRIFT_THRESHOLD = 0.2

export interface CommandCentreProps {
  readonly stop: number
  readonly setStop: (n: number) => void
  readonly view: CcView
  readonly setView: (v: CcView) => void
  readonly onClose: () => void
  /** Reported upward so the headline can name the shelf you are on. */
  readonly onShelves: (keys: readonly string[]) => void
}

export function CommandCentre({ stop, setStop, view, setView, onClose, onShelves }: CommandCentreProps): React.ReactElement {
  const [fellowId, setFellowId] = useState<string | null>(null)
  const [pane, setPane] = useState<Pane>('notebook')
  const [decIndex, setDecIndex] = useState(0)
  const [optIndex, setOptIndex] = useState(0)
  const [row, setRow] = useState(0)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  /** The order while its write is in flight: the list must not jump back under the click. */
  const [orderDraft, setOrderDraft] = useState<readonly string[] | null>(null)
  /**
   * The shelf a spawn was started for. It is NOT `stop`: staffing an empty shelf is started
   * from a row that has no stop of its own, and reading the current stop there handed the
   * form the staffed shelf you happened to be standing on.
   */
  const [spawnShelf, setSpawnShelf] = useState<string | null>(null)

  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, refetchInterval: 20_000 })
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph, staleTime: 60_000 })
  const registry = useQuery({ queryKey: ['domains'], queryFn: api.domains, staleTime: 300_000 })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 60_000 })
  const recaps = useQuery({ queryKey: ['recaps'], queryFn: api.recaps, staleTime: 60_000 })
  const card = useQuery({
    queryKey: ['agent-card', fellowId],
    queryFn: () => api.agentCard(fellowId!),
    enabled: fellowId !== null,
    refetchInterval: 15_000,
  })

  const shelves = useMemo(
    () =>
      shelvesFrom({
        domains: (registry.data?.domains ?? []).map((d) => d.key),
        nodes: graph.data?.nodes ?? [],
        gaps: graph.data?.gaps ?? [],
        fellows: agents.data?.fellows ?? [],
      }),
    [registry.data, graph.data, agents.data],
  )
  const order = orderDraft ?? agents.data?.shelfOrder ?? NO_ORDER
  const staffed = useMemo(() => shelfOrder(shelves, order), [shelves, order])
  // Sorted here rather than in `Shelves`: the keyboard walks these rows by index, and two
  // different orders for one list is how Enter opens a different shelf than the one lit up.
  const empty = useMemo(
    () =>
      shelves
        .filter((s) => s.fellows.length === 0)
        .sort((a, b) => b.questions + b.gaps * 2 - (a.questions + a.gaps * 2)),
    [shelves],
  )
  const roster = useMemo(() => staffed.flatMap((s) => s.fellows.map((f) => ({ shelf: s, fellow: f }))), [staffed])
  const shelf = staffed[Math.min(stop, Math.max(0, staffed.length - 1))]

  // The headline needs the names; it does not need to know how they were derived.
  useEffect(() => onShelves(staffed.map((s) => s.key)), [staffed, onShelves])

  const set = settings.data?.effective
  const win = useMemo(
    () => windowMinutes(set?.nightWindowStart ?? '01:00', set?.nightWindowEnd ?? '06:00'),
    [set?.nightWindowStart, set?.nightWindowEnd],
  )
  const live = drag ?? win
  const span = live.to - live.from
  // A fresh `{}` every render would re-lay the schedule on every render with it.
  const durations = useMemo(() => agents.data?.durations ?? {}, [agents.data])
  const blocks = useMemo(() => scheduleFrom(staffed, live.from, durations), [staffed, live.from, durations])
  const overflow = blocks.filter((b) => b.to > live.to)
  const planOnly = blocks.filter((b) => !b.runs)
  const mine = shelf ? blocks.filter((b) => b.shelf === shelf.key) : []

  const deciders = useMemo(
    () => roster.filter((r) => r.fellow.pendingProposals > 0),
    [roster],
  )

  const qc = useQueryClient()
  const saveWindow = useMutation({
    mutationFn: (w: { from: number; to: number }) =>
      api.saveSettings({ nightWindowStart: clock(w.from), nightWindowEnd: clock(w.to) }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  })
  const decide = useMutation({
    mutationFn: (v: { id: string; status: 'approved' | 'vetoed' }) => api.decideProposal(v.id, { status: v.status }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] })
      void qc.invalidateQueries({ queryKey: ['agent-card'] })
    },
  })
  const act = useMutation({
    mutationFn: async (v: { id: string; what: 'step' | 'plan' | 'pause' | 'resume' }): Promise<void> => {
      if (v.what === 'step') await api.stepAgent(v.id)
      else if (v.what === 'plan') await api.planAgent(v.id)
      else await api.agentAction(v.id, v.what)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['agents'] }),
  })
  const patch = useMutation({
    mutationFn: (v: { id: string; body: AgentPatchBody }) => api.patchAgent(v.id, v.body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] })
      void qc.invalidateQueries({ queryKey: ['agent-card'] })
    },
  })
  const reorder = useMutation({
    mutationFn: (domains: readonly string[]) => api.saveShelfOrder(domains),
    onSettled: () => {
      setOrderDraft(null)
      void qc.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  /**
   * Moves one shelf a place in the night's order. The whole list goes to the service, not the
   * one that moved: an order stated in full cannot be read two ways, and every shelf the user
   * has seen ranked is one they have implicitly placed.
   */
  const moveShelf = (key: string, delta: number): void => {
    const keys = staffed.map((s) => s.key)
    const at = keys.indexOf(key)
    const to = at + delta
    if (at < 0 || to < 0 || to >= keys.length) return
    const next = [...keys]
    next.splice(to, 0, next.splice(at, 1)[0]!)
    setOrderDraft(next)
    reorder.mutate(next)
    // `stop` is a slot in the list, not a shelf. Hold the shelf you were looking at.
    const here = shelf?.key
    if (here !== undefined) setStop(Math.max(0, next.indexOf(here)))
  }

  const openFellow = (id: string): void => {
    // A Fellow spawned a moment ago is not in the roster yet; the shelf follows when it is.
    const at = roster.findIndex((r) => r.fellow.agent.id === id)
    if (at >= 0) setStop(staffed.indexOf(roster[at]!.shelf))
    setFellowId(id)
    setPane('notebook')
    setView('dossier')
  }
  const stepFellow = (delta: number): void => {
    if (roster.length === 0) return
    const at = roster.findIndex((r) => r.fellow.agent.id === fellowId)
    const next = roster[((at < 0 ? 0 : at) + delta + roster.length) % roster.length]!
    setFellowId(next.fellow.agent.id)
    setStop(staffed.indexOf(next.shelf))
  }
  /** Opens the spawn view for one shelf. `null` means "wherever I am", never "no shelf". */
  const openSpawn = (key: string | null): void => {
    setSpawnShelf(key ?? shelf?.key ?? null)
    setView('spawn')
  }
  const back = (): void => {
    if (view === 'shelves') onClose()
    else if (view === 'tonight') setView('shelves')
    else setView('tonight')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        back()
        return
      }
      if (view === 'dossier') {
        const order: Pane[] = ['notebook', 'recap', 'ledger', 'pages', 'settings']
        const n = Number(e.key)
        if (n >= 1 && n <= 5) setPane(order[n - 1]!)
        else if (e.key === 'ArrowRight') {
          e.preventDefault()
          stepFellow(1)
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          stepFellow(-1)
        }
        return
      }
      if (view === 'decisions') {
        if (deciders.length === 0) return
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          setDecIndex((i) => (i + 1) % deciders.length)
          setOptIndex(0)
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          setDecIndex((i) => (i - 1 + deciders.length) % deciders.length)
          setOptIndex(0)
        }
        return
      }
      if (view === 'spawn') return
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (view === 'shelves') {
          setStop(0)
          setRow(0)
          setView('tonight')
        } else if (stop >= staffed.length - 1) {
          setRow(0)
          setView('shelves')
        } else {
          setStop(stop + 1)
          setRow(0)
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (view === 'shelves') {
          setStop(Math.max(0, staffed.length - 1))
          setRow(0)
          setView('tonight')
        } else if (stop <= 0) {
          setRow(0)
          setView('shelves')
        } else {
          setStop(stop - 1)
          setRow(0)
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setRow((r) => Math.min((view === 'shelves' ? staffed.length + empty.length : (shelf?.fellows.length ?? 0) + 1) - 1, r + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setRow((r) => Math.max(0, r - 1))
      } else if (e.key === 'Enter') {
        if (view === 'shelves') {
          if (row < staffed.length) {
            setStop(row)
            setRow(0)
            setView('tonight')
          } else openSpawn(empty[row - staffed.length]?.key ?? null)
        } else if (row >= (shelf?.fellows.length ?? 0)) openSpawn(null)
        else {
          const f = shelf?.fellows[row]
          if (f) openFellow(f.agent.id)
        }
      } else if (e.key === 'n') openSpawn(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const dragEdge = (edge: 'from' | 'to') => (e: React.MouseEvent): void => {
    e.preventDefault()
    const track = (e.currentTarget as HTMLElement).closest('.cc-track')
    let next = { ...live }
    const move = (ev: MouseEvent): void => {
      const rect = track?.getBoundingClientRect()
      if (!rect) return
      const m = SCALE_FROM + Math.round((((ev.clientX - rect.left) / rect.width) * SCALE_SPAN) / 15) * 15
      next =
        edge === 'from'
          ? { from: Math.max(SCALE_FROM, Math.min(m, next.to - 60)), to: next.to }
          : { from: next.from, to: Math.min(SCALE_TO, Math.max(m, next.from + 60)) }
      setDrag(next)
    }
    const up = (): void => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      setDrag(null)
      saveWindow.mutate(next)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const state =
    queryState(agents, 'the Fellows') ??
    queryState(graph, 'the vault graph') ??
    queryState(registry, 'the domain registry') ??
    queryState(settings, 'the settings')
  if (state) return <div className="lib-window cc"><div className="lib-window-body cc-body">{state}</div></div>

  const fellow = roster.find((r) => r.fellow.agent.id === fellowId)?.fellow
  const recapOf = (id: string): RecapFellow | undefined =>
    recaps.data?.recaps[0]?.model.fellows.find((x) => x.agentId === id)

  return (
    <div className="lib-window cc" role="dialog" aria-label="Fellow command centre">
      {view === 'shelves' && (
        <>
          <NightLine
            facts={[
              `${blocks.length} task${blocks.length === 1 ? '' : 's'} across ${new Set(blocks.map((b) => b.shelf)).size} shel${new Set(blocks.map((b) => b.shelf)).size === 1 ? 'f' : 'ves'}`,
              `${hhmm(win.from)} to ${hhmm(win.to)} (active hours)`,
              `${roster.length} Fellow${roster.length === 1 ? '' : 's'}`,
            ]}
          />
          <Shelves
            staffed={staffed}
            empty={empty}
            row={row}
            blocks={blocks}
            onOpen={(i) => { setStop(i); setRow(0); setView('tonight') }}
            onSpawn={openSpawn}
            onDecisions={(key) => {
              const first = deciders.findIndex((x) => x.shelf.key === key)
              if (first < 0) return
              setDecIndex(first)
              setOptIndex(0)
              setView('decisions')
            }}
          />
        </>
      )}

      {view === 'tonight' && shelf && (
        <>
          <NightLine
            facts={[
              `${mine.length} task${mine.length === 1 ? '' : 's'}`,
              mine.length === 0 ? 'nothing scheduled' : `${hhmm(mine[0]!.from)} to ${hhmm(mine[mine.length - 1]!.to)} (estimated)`,
              `${shelf.fellows.length} Fellow${shelf.fellows.length === 1 ? '' : 's'}`,
            ]}
          />
          <div className="lib-window-body cc-body">
            <section className="cc-block">
              <h3 className="cc-sec">Active Hours</h3>
              <p className="cc-note">
                The stretch of the night the shift may work in. Every Fellow shares it, and the runs go through it one at
                a time, so this is not a budget per Fellow but the length of one queue. Drag either end.
              </p>
              <Axis />
              <div className="cc-track set">
                {SCALE_HOURS.slice(1, -1).map((m) => <span key={m} className="cc-grid" style={{ left: `${pctAt(m)}%` }} />)}
                <div className="cc-window" style={{ left: `${pctAt(live.from)}%`, width: `${(span / SCALE_SPAN) * 100}%` }}>
                  <span className="h l" onMouseDown={dragEdge('from')} />
                  <span className="h r" onMouseDown={dragEdge('to')} />
                </div>
              </div>
              <div className="cc-under">
                <b>{hhmm(live.from)} to {hhmm(live.to)}</b>
                <span>{dur(span)}</span>
                {saveWindow.isPending && <span className="mono-meta">saving…</span>}
              </div>
            </section>

            <section className="cc-block">
              <h3 className="cc-sec">
                The queue
                <span className="grow" />
                <span className="c">one run at a time, planning included</span>
              </h3>
              <Axis />
              <div className="cc-track">
                {SCALE_HOURS.slice(1, -1).map((m) => <span key={m} className="cc-grid" style={{ left: `${pctAt(m)}%` }} />)}
                <div className="cc-active" style={{ left: `${pctAt(live.from)}%`, width: `${(span / SCALE_SPAN) * 100}%` }} />
                {bandsOf(blocks).map((g) => (
                  <div
                    key={`${g.shelf}-${g.from}`}
                    className={`cc-band ${g.shelf === shelf.key ? 'here' : ''}`}
                    style={{ left: `${pctAt(g.from)}%`, width: `${Math.max(0.4, ((g.to - g.from) / SCALE_SPAN) * 100)}%`, ['--dc' as string]: domainColor(g.shelf) }}
                    title={`${g.shelf}: ${g.parts.length} task(s), ${dur(g.to - g.from)}`}
                  >
                    <span className="cc-parts">
                      {g.parts.map((b, i) => (
                        <span
                          key={`${b.fellowId}-${b.text}`}
                          className={`cc-part ${b.runs ? '' : 'plan'}`}
                          style={{ width: `${(b.minutes / (g.to - g.from)) * 100}%`, borderLeft: i > 0 ? '1px solid rgba(255,255,255,.55)' : undefined }}
                          title={
                            b.runs
                              ? `${b.fellowName} · ${b.kind}: ${b.text} · ${dur(b.minutes)}, planning included`
                              : `${b.fellowName} · ${b.kind}: ${b.text} · planned only tonight (${dur(b.minutes)}); the daily quota is spent, so it is carried out on a later night`
                          }
                        />
                      ))}
                    </span>
                  </div>
                ))}
              </div>
              <div className="cc-order">
                {staffed.map((d, i) => (
                  <span key={d.key} className={`cc-chip ${d.key === shelf.key ? 'here' : ''}`}>
                    <i style={{ background: domainColor(d.key) }} aria-hidden />
                    {d.key}
                    <button
                      disabled={i === 0 || reorder.isPending}
                      onClick={() => moveShelf(d.key, -1)}
                      title={`Move ${d.key} earlier in the night`}
                      aria-label={`Move ${d.key} earlier`}
                    >
                      ‹
                    </button>
                    <button
                      disabled={i === staffed.length - 1 || reorder.isPending}
                      onClick={() => moveShelf(d.key, 1)}
                      title={`Move ${d.key} later in the night`}
                      aria-label={`Move ${d.key} later`}
                    >
                      ›
                    </button>
                  </span>
                ))}
              </div>
              <p className="cc-note dim">
                The order the shift walks the shelves in, and the arrows change it. Inside a shelf its Fellows keep their
                own order: priority first, then age. Moving a shelf does not move you off it.
              </p>
              {planOnly.length > 0 && (
                <p className="cc-note">
                  <b>{planOnly.length} task{planOnly.length === 1 ? ' is' : 's are'} planned tonight but not carried out.</b>{' '}
                  Planning is free of the daily quota and the run it produces is not, so a Fellow that works more tasks a
                  night than its <i>runs a day</i> allows leaves the rest standing as proposals. Raise the quota in the
                  Fellow{planOnly.length === 1 ? "'s" : 's’'} settings, or let them come round over several nights.
                </p>
              )}
              {overflow.length > 0 ? (
                <p className="cc-note warn">
                  <b>{overflow.length} task{overflow.length === 1 ? ' does' : 's do'} not fit tonight.</b> The night is one
                  queue for every Fellow, not one per shelf: {dur(blocks.reduce((n, b) => n + b.minutes, 0))} of work against
                  a {dur(span)} window. Widen the hours, or leave it: what does not fit stands for tomorrow.
                </p>
              ) : blocks.some((b) => b.waits) ? (
                <p className="cc-note">
                  {blocks.filter((b) => b.waits).length} of tonight’s {blocks.length} tasks belong to a Fellow set to{' '}
                  <b>ask me every time</b>, and those wait for you. The rest run unless you veto them during the day.
                </p>
              ) : (
                <p className="cc-note">
                  Everything here runs on its own. What a Fellow proposes tonight runs tomorrow night unless you veto it.
                </p>
              )}
            </section>

            <section className="cc-block">
              <h3 className="cc-sec">Fellows of this shelf <span className="c">{shelf.fellows.length}</span></h3>
              <div className="cc-rows">
                {shelf.fellows.map((f, i) => {
                  const tonight = tasksTonight(f.agent)
                  const minutes = fellowMinutes(f.agent, durations)
                  const carried = carriedTonight(f.agent)
                  const rested = f.agent.tasks.length > 0 && f.agent.tasks.every((t) => t.state !== 'active')
                  return (
                    <div key={f.agent.id} className={`cc-row ${i === row ? 'sel' : ''}`} onClick={() => { setRow(i); openFellow(f.agent.id) }}>
                      <span className="cc-id">
                        <span className="cc-idline">
                          <b>{f.agent.name}</b>
                          <span className={`sev ${f.currentRun ? 'rec' : f.agent.state === 'paused' ? 'mut' : 'ok'}`}>
                            {f.currentRun ? 'working' : rested ? 'quiet' : f.agent.state}
                          </span>
                        </span>
                        <span className="cc-t">{rested ? `all ${f.agent.tasks.length} questions answered, nothing standing` : f.agent.intent}</span>
                      </span>
                      <span className="cc-right">
                        {f.pendingProposals > 0 && (
                          <button
                            className="sev due cc-pill"
                            onClick={(e) => {
                              e.stopPropagation()
                              const at = deciders.findIndex((x) => x.fellow.agent.id === f.agent.id)
                              if (at < 0) return
                              setDecIndex(at)
                              setOptIndex(0)
                              setView('decisions')
                            }}
                          >
                            {f.pendingProposals} decision{f.pendingProposals === 1 ? '' : 's'}
                          </button>
                        )}
                        {tonight.length === 0 ? (
                          <button className="cc-link quiet" onClick={(e) => { e.stopPropagation(); setFellowId(f.agent.id); setPane('settings'); setView('dossier') }}>
                            Assign a new task ›
                          </button>
                        ) : (
                          <>
                            <span
                              className="sev ok"
                              title={
                                carried < tonight.length
                                  ? `${tonight.length} planned, ${carried} carried out: the quota is ${f.agent.quotaRunsPerDay} run(s) a day`
                                  : f.agent.nightly === 'sweep'
                                    ? 'every standing task, each in its own run'
                                    : `one task a night: each of ${f.agent.tasks.length} comes round every ${f.agent.tasks.length} nights`
                              }
                            >
                              {tonight.length} of {f.agent.tasks.length}
                            </span>
                            <span className="mono-meta">{minutes} min</span>
                          </>
                        )}
                      </span>
                    </div>
                  )
                })}
                <div className={`cc-row new ${row === shelf.fellows.length ? 'sel' : ''}`} onClick={() => openSpawn(shelf.key)}>
                  <span className="cc-id">
                    <span className="cc-idline"><b>New Fellow</b></span>
                    <span className="cc-t">take one of four examples and change anything about it</span>
                  </span>
                  <span className="cc-right"><span className="mono-meta">n</span></span>
                </div>
              </div>
            </section>
          </div>
        </>
      )}

      {view === 'dossier' && !fellow && (
        <div className="lib-window-body cc-body">
          <p className="empty">Opening the Fellow…</p>
        </div>
      )}

      {view === 'dossier' && fellow && (
        <Dossier
          fellow={fellow}
          card={card.data}
          recap={recapOf(fellow.agent.id)}
          pane={pane}
          durations={durations}
          setPane={setPane}
          onBack={back}
          onStep={stepFellow}
          onAct={(what) => act.mutate({ id: fellow.agent.id, what })}
          onPatch={(body) => patch.mutate({ id: fellow.agent.id, body })}
          patching={patch.isPending}
          refused={patch.error === null ? null : (patch.error as Error).message}
          busy={act.isPending}
        />
      )}

      {view === 'decisions' && (
        <Decisions
          list={deciders}
          at={Math.min(decIndex, Math.max(0, deciders.length - 1))}
          opt={optIndex}
          span={span}
          onPick={(i) => { setDecIndex(i); setOptIndex(0) }}
          onOpt={setOptIndex}
          onDecide={(id, status) => decide.mutate({ id, status })}
          busy={decide.isPending}
          onBack={back}
        />
      )}

      {view === 'spawn' && <Spawn shelf={spawnShelf ?? shelf?.key ?? ''} onBack={back} onDone={openFellow} />}
    </div>
  )
}

/** Contiguous runs of one shelf: the unit you read, divided by hairlines into its topics. */
function bandsOf(blocks: readonly Block[]): Array<{ shelf: string; from: number; to: number; parts: Block[] }> {
  const out: Array<{ shelf: string; from: number; to: number; parts: Block[] }> = []
  for (const b of blocks) {
    const last = out[out.length - 1]
    if (last && last.shelf === b.shelf) {
      last.to = b.to
      last.parts.push(b)
    } else out.push({ shelf: b.shelf, from: b.from, to: b.to, parts: [b] })
  }
  return out
}

/** The shared axis: one label at every full hour, the same shape above both bars. */
function Axis(): React.ReactElement {
  return (
    <div className="cc-axis">
      {/* The ends are the frame itself; a label there hangs off the edge and reads as loose. */}
      {SCALE_HOURS.slice(1, -1).map((m) => (
        <span key={m} className="cc-hour" style={{ left: `${pctAt(m)}%` }}>{hhmm(m)}</span>
      ))}
    </div>
  )
}

/**
 * The night in four facts, centred and in fixed slots. They change every night and with every
 * setting, and a line that re-centres itself as they do is a line you have to find again each
 * time - so each fact keeps its width whatever it says.
 */
function NightLine({ facts }: { facts: readonly string[] }): React.ReactElement {
  return (
    <div className="cc-line2">
      <span className="cc-side" />
      <span className="cc-facts">
        <b>Tonight</b>
        {facts.map((f) => <span key={f} className="s">{f}</span>)}
      </span>
      <span className="cc-side end" />
    </div>
  )
}

function Shelves({
  staffed,
  empty,
  row,
  blocks,
  onOpen,
  onSpawn,
  onDecisions,
}: {
  staffed: readonly Shelf[]
  empty: readonly Shelf[]
  row: number
  blocks: readonly Block[]
  onOpen: (index: number) => void
  onSpawn: (key: string) => void
  onDecisions: (key: string) => void
}): React.ReactElement {
  // Already sorted by what is waiting there; see the parent's `empty`.
  const top = empty[0]
  return (
    <div className="lib-window-body cc-body">
      <section className="cc-block">
        <h3 className="cc-sec">
          Staffed <span className="c">{staffed.length}</span>
          <span className="grow" />
          <span className="c">the order the night works them in</span>
        </h3>
        {staffed.length === 0 ? (
          <p className="empty">No Fellow anywhere yet. Any shelf below can have the first one.</p>
        ) : (
          <div className="cc-rows">
            {staffed.map((d, i) => {
              const nightly = blocks.filter((b) => b.shelf === d.key).reduce((n, b) => n + b.minutes, 0)
              const open = d.fellows.reduce((n, f) => n + f.pendingProposals, 0)
              return (
                <div key={d.key} className={`cc-row ${i === row ? 'sel' : ''}`} onClick={() => onOpen(i)}>
                  <span className="cc-id">
                    <span className="cc-idline">
                      <span className="chip-dot" style={{ background: domainColor(d.key) }} aria-hidden />
                      <b>{d.key}</b>
                    </span>
                    <span className="cc-t">
                      {d.fellows.map((f) => f.agent.name).join(', ')} · {d.pages} pages · {d.questions} open question{d.questions === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="cc-right">
                    {open > 0 && (
                      <button className="sev due cc-pill" onClick={(e) => { e.stopPropagation(); onDecisions(d.key) }}>
                        {open} decision{open === 1 ? '' : 's'}
                      </button>
                    )}
                    <span className="mono-meta">{nightly > 0 ? `${nightly} min tonight` : 'nothing tonight'}</span>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="cc-block">
        <h3 className="cc-sec">
          Nobody on them <span className="c">{empty.length}</span>
          <span className="grow" />
          <span className="c">sorted by what is waiting there, not by size</span>
        </h3>
        <p className="cc-note">
          A shelf earns a Fellow when it holds questions nobody is answering.
          {top && top.questions + top.gaps > 0 && (
            <> <b>{top.key}</b> has the most: {top.questions} open question{top.questions === 1 ? '' : 's'} and {top.gaps} page{top.gaps === 1 ? '' : 's'} linked but never written.</>
          )}
        </p>
        <div className="cc-rows">
          {empty.map((d, i) => (
            <div key={d.key} className={`cc-row ${row === staffed.length + i ? 'sel' : ''}`} onClick={() => onSpawn(d.key)}>
              <span className="cc-id">
                <span className="cc-idline">
                  <span className="chip-dot" style={{ background: domainColor(d.key), opacity: 0.45 }} aria-hidden />
                  <b>{d.key}</b>
                </span>
                <span className="cc-t">
                  {d.pages} pages · {d.questions} open question{d.questions === 1 ? '' : 's'} · {d.gaps} linked but never written
                </span>
              </span>
              <span className="cc-right">
                <span className="cc-bar" title="how much is waiting here"><i style={{ width: `${Math.min(100, (d.questions + d.gaps * 2) * 6)}%` }} /></span>
                <button className="btn sm" onClick={(e) => { e.stopPropagation(); onSpawn(d.key) }}>Staff it ›</button>
              </span>
            </div>
          ))}
        </div>
        <p className="cc-note dim">
          A shelf without a Fellow is not idle: ingests still file pages there. It only means nobody plans work for it at
          night.
        </p>
      </section>
    </div>
  )
}

function Dossier({
  fellow,
  card,
  recap,
  pane,
  durations,
  setPane,
  onBack,
  onStep,
  onAct,
  onPatch,
  patching,
  refused,
  busy,
}: {
  fellow: FellowSummary
  card: FellowCard | undefined
  recap: RecapFellow | undefined
  pane: Pane
  durations: Readonly<Record<string, number | null>>
  setPane: (p: Pane) => void
  onBack: () => void
  onStep: (delta: number) => void
  onAct: (what: 'step' | 'plan' | 'pause' | 'resume') => void
  onPatch: (body: AgentPatchBody) => void
  patching: boolean
  refused: string | null
  busy: boolean
}): React.ReactElement {
  const a: FellowRecord = fellow.agent
  const active = a.tasks.filter((t) => t.state === 'active')
  const resting = a.tasks.filter((t) => t.state !== 'active')
  const upNext = tasksTonight(a)[0]
  const art = a.art
  const runs = card?.runs ?? []
  const pages = card?.pages ?? []
  const panes: Array<[Pane, string]> = [
    ['notebook', 'Notebook'],
    ['recap', 'Recap'],
    ['ledger', `Ledger ${runs.length}`],
    ['pages', `Pages ${pages.length}`],
    ['settings', 'Settings'],
  ]
  const nightly = fellowMinutes(a, durations)
  const carried = carriedTonight(a)

  return (
    <>
      <div className="cc-line2">
        <button className="cc-back" onClick={onBack} title="Back to tonight · Esc">‹</button>
        <span className="cc-lead">
          <b>{a.name}</b>
          {(['watch', 'explore', 'deepen'] as TaskKind[]).map((k) => {
            const n = a.tasks.filter((t) => t.kind === k).length
            return n === 0 ? null : <span key={k} className={`cc-art a-${k}`} title={ART_TEXT[k]}>{k}{n > 1 ? ` ×${n}` : ''}</span>
          })}
          <span className={`sev ${fellow.currentRun ? 'rec' : a.state === 'paused' ? 'mut' : 'ok'}`}>
            {fellow.currentRun ? 'working' : a.state}
          </span>
          <span className="cc-sub">{autonomyOf(a.autonomy).short}</span>
        </span>
        <span className="grow" />
        <span className="cc-step">
          <button onClick={() => onStep(-1)} title="Previous Fellow · ←">‹</button>
          <span>Fellow</span>
          <button onClick={() => onStep(1)} title="Next Fellow · →">›</button>
        </span>
        <button className="btn sm" disabled={busy} onClick={() => onAct('plan')}>Plan now</button>
        {a.state === 'paused' ? (
          <button className="btn primary sm" disabled={busy} onClick={() => onAct('resume')}>Resume</button>
        ) : (
          <button className="btn primary sm" disabled={busy} onClick={() => onAct('step')}>Run a task now</button>
        )}
      </div>

      <div className="cc-fixed">
        <div className="cc-upnext">
          {upNext ? (
            <>
              <span className="k">up next</span>
              <span className={`cc-art a-${upNext.kind}`}>{upNext.kind}</span>
              <span className="cc-upnext-t">{upNext.text}</span>
              <span className="grow" />
              <span className="mono-meta">{nightly} min tonight · {card ? `${card.quota.usedToday} of ${card.quota.runsPerDay} runs used` : ''}</span>
            </>
          ) : (
            <>
              <span className="k">nothing standing</span>
              <span className="cc-upnext-t">every task is answered; give it a new one in Settings</span>
            </>
          )}
        </div>

        <div className="cc-bar-row">
          <span className="seg">
            {panes.map(([k, label]) => (
              <button key={k} className={pane === k ? 'active' : ''} onClick={() => setPane(k)}>{label}</button>
            ))}
          </span>
          <span className="grow" />
          <span className="mono-meta">
            {pane === 'notebook' ? a.notebookPath
              : pane === 'recap' ? 'one Fellow’s slice · the wall board keeps the whole'
                : pane === 'ledger' ? 'a row opens the page it filed'
                  : pane === 'settings' ? 'changes apply to the next night' : ''}
          </span>
        </div>

        <div className="cc-area">
          {pane === 'notebook' && <Notebook path={a.notebookPath} />}

          {pane === 'recap' && (
            <div className="cc-prose">
              {recap === undefined ? (
                <p className="empty">No recap covers this Fellow yet.</p>
              ) : (
                <>
                  {recap.runs.length > 0 ? (
                    <p className="mono-meta">{recap.runs.length} run(s) in the last recap</p>
                  ) : (
                    <p className="cc-note warn">Did not run: {recap.sleepReason ?? 'nothing worth a run'}</p>
                  )}
                  {recap.found.length > 0 && (
                    <>
                      <h5>What it found</h5>
                      {recap.found.map((x) => <p key={x}>{x}</p>)}
                    </>
                  )}
                  {recap.openQuestions.length > 0 && (
                    <>
                      <h5>Questions it raised</h5>
                      <ul className="cc-list">{recap.openQuestions.map((q) => <li key={q}>{q}</li>)}</ul>
                    </>
                  )}
                  <h5>Did you use it</h5>
                  <p className="mono-meta">{recap.value.pageOpens} page open(s) · {recap.value.recapLinks} link(s) followed</p>
                  <p className="cc-note dim">
                    {a.name}’s slice of the last recap. The wall board in the Library keeps the whole night.
                  </p>
                </>
              )}
            </div>
          )}

          {pane === 'ledger' &&
            (runs.length === 0 ? (
              <p className="empty">No runs yet.</p>
            ) : (
              <table className="cc-ledger">
                <thead><tr><th>When</th><th>Task</th><th>Out</th><th>Cost</th></tr></thead>
                <tbody>
                  {runs.map((r) => {
                    const page = r.pages.find((p) => p.startsWith('wiki/questions/')) ?? r.pages[0]
                    return (
                      <tr
                        key={r.id}
                        className={page === undefined ? '' : 'open'}
                        title={page === undefined ? 'This run filed no page' : `Open ${page.split('/').pop()?.replace(/\.md$/, '')}`}
                        onClick={() => { if (page !== undefined) navigate(pageRoute(page)) }}
                      >
                        <td className="n">{r.finishedAt.slice(5, 16).replace('T', ' ')}</td>
                        <td className="t">{r.label ?? r.kind} <span className="sev mut">{r.kind}</span></td>
                        <td className="n">{r.pages.length} page{r.pages.length === 1 ? '' : 's'}</td>
                        <td className="n">{usd(r.costUsd ?? 0)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ))}

          {pane === 'pages' &&
            (pages.length === 0 ? (
              <p className="empty">No pages yet.</p>
            ) : (
              <ul className="cc-pages">
                {pages.map((p) => (
                  <li key={p} onClick={() => navigate(pageRoute(p))}>
                    <span className="p">{p.split('/').pop()?.replace(/\.md$/, '')}</span>
                  </li>
                ))}
              </ul>
            ))}

          {pane === 'settings' && (
            <div className="cc-settings">
              <section className="wide">
                <h5>Standing work <span className="lead">- {art === 'custom' ? 'any mix of arts' : `${art} tasks only`}, up to 3</span></h5>
                <div className="cc-card">
                  <ul className="cc-tasks">
                    {active.map((t, i) => (
                      <li key={t.id} className={i === 0 ? 'on' : ''}>
                        <span className={`cc-art a-${t.kind}`}>{t.kind}</span>
                        <span className="t">{t.text}</span>
                        <span className="mono-meta">{i === 0 ? 'up next' : 'waiting'}</span>
                      </li>
                    ))}
                    {resting.map((t) => (
                      <li key={t.id} className="rest">
                        <span className={`cc-art a-${t.kind}`}>{t.kind}</span>
                        <span className="t">{t.text}</span>
                        <span className="mono-meta">at rest</span>
                      </li>
                    ))}
                  </ul>
                  <p className="cc-note dim">
                    {art === 'custom' ? (
                      <><b>watch</b> {ART_TEXT.watch} <b>explore</b> {ART_TEXT.explore} <b>deepen</b> {ART_TEXT.deepen}</>
                    ) : (
                      <><b>{art}</b> {ART_TEXT[art]}</>
                    )}{' '}
                    Editing the list is not built into this window yet (TASKS-A7 4.2).
                  </p>
                </div>
              </section>
              <section>
                <h5>How much of the night</h5>
                <div className="cc-card">
                  <span className="seg">
                    <button
                      className={a.nightly === 'sweep' ? 'active' : ''}
                      disabled={patching}
                      onClick={() => onPatch({ nightly: 'sweep' })}
                    >
                      Every task
                    </button>
                    <button
                      className={a.nightly === 'rotate' ? 'active' : ''}
                      disabled={patching}
                      onClick={() => onPatch({ nightly: 'rotate' })}
                    >
                      One a night
                    </button>
                  </span>
                  <p className="cc-note">
                    {a.nightly === 'sweep' ? (
                      <>
                        All {active.length} standing task{active.length === 1 ? '' : 's'} {active.length === 1 ? 'runs' : 'run'} each
                        night, each planned and carried out on its own. Nothing waits {active.length} nights for its turn.
                      </>
                    ) : (
                      <>
                        <b>One task a night</b>, taken in turn: each of {active.length} comes round every {active.length} night
                        {active.length === 1 ? '' : 's'}. The cheaper pace, and the slower one.
                      </>
                    )}
                  </p>
                  <div className="cc-quota">
                    <span className="k">Runs a day</span>
                    <span className="cc-step">
                      <button
                        disabled={patching || a.quotaRunsPerDay <= 0}
                        onClick={() => onPatch({ quotaRunsPerDay: a.quotaRunsPerDay - 1 })}
                        title="One fewer run a night"
                      >
                        -
                      </button>
                      <b>{a.quotaRunsPerDay}</b>
                      <button
                        disabled={patching || a.quotaRunsPerDay >= 24}
                        onClick={() => onPatch({ quotaRunsPerDay: a.quotaRunsPerDay + 1 })}
                        title="One more run a night"
                      >
                        +
                      </button>
                    </span>
                    <span className="mono-meta">{nightly} min tonight{card ? ` · ${card.quota.usedToday} used today` : ''}</span>
                  </div>
                  {carried < active.length && (
                    <p className="cc-note warn">
                      {active.length} task{active.length === 1 ? '' : 's'} planned, {carried} carried out. Planning is free
                      of the daily quota and the run it produces is not, so {active.length} runs a day is what it takes for
                      every task to also run the night it is planned.{' '}
                      <button className="cc-link" disabled={patching} onClick={() => onPatch({ quotaRunsPerDay: active.length })}>
                        Raise it to {active.length} ›
                      </button>
                    </p>
                  )}
                </div>
              </section>
              <section>
                <h5>Who decides</h5>
                <div className="cc-card">
                  <span className="seg">
                    {(['manual', 'veto', 'auto'] as const).map((k) => (
                      <button
                        key={k}
                        className={a.autonomy === k ? 'active' : ''}
                        disabled={patching}
                        onClick={() => onPatch({ autonomy: k })}
                      >
                        {autonomyOf(k).label}
                      </button>
                    ))}
                  </span>
                  <p className="cc-note">{autonomyOf(a.autonomy).long}</p>
                  <p className="cc-note dim">
                    A proposal stands for two nights and then expires, approved ones too. Approving moves one ahead of the
                    others; it is not what permits it to run.
                  </p>
                </div>
              </section>
              <section className="wide">
                <h5>Model, effort, share</h5>
                <div className="cc-card">
                  <span className="mono-meta">
                    {a.model} · {a.effort} effort · {a.step} depth · {a.lens} lens · {shapeOf(a.art).name.toLowerCase()}
                    {a.quotaWeekPct !== null ? ` · ${a.quotaWeekPct}% of the week` : ''}
                    {card ? ` · this week ${card.spend.runsWeek} run(s), ${usd(card.spend.weekUsd)}` : ''}
                  </span>
                </div>
              </section>
              {refused !== null && (
                <section className="wide">
                  <p className="cc-note warn">{refused}</p>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/** The notebook is a vault page; the window shows what the page says, not a copy of it. */
function Notebook({ path }: { path: string }): React.ReactElement {
  const page = useQuery({ queryKey: ['page', path], queryFn: () => api.page(path), staleTime: 30_000 })
  const state = queryState(page, 'the notebook')
  if (state) return <>{state}</>
  return <pre className="cc-notebook">{page.data?.markdown ?? ''}</pre>
}

function Decisions({
  list,
  at,
  opt,
  span,
  onPick,
  onOpt,
  onDecide,
  busy,
  onBack,
}: {
  list: ReadonlyArray<{ shelf: Shelf; fellow: FellowSummary }>
  at: number
  opt: number
  span: number
  onPick: (i: number) => void
  onOpt: (i: number) => void
  onDecide: (id: string, status: 'approved' | 'vetoed') => void
  busy: boolean
  onBack: () => void
}): React.ReactElement {
  const here = list[at]
  const card = useQuery({
    queryKey: ['agent-card', here?.fellow.agent.id],
    queryFn: () => api.agentCard(here!.fellow.agent.id),
    enabled: here !== undefined,
  })
  if (!here) {
    return (
      <>
        <div className="cc-line2">
          <button className="cc-back" onClick={onBack} title="Back · Esc">‹</button>
          <span className="cc-lead"><b>Decisions</b></span>
        </div>
        <div className="lib-window-body cc-body"><p className="empty">Nothing is waiting for a decision.</p></div>
      </>
    )
  }
  const a = here.fellow.agent
  const open = (card.data?.proposals ?? []).filter((p) => p.status === 'proposed' || p.status === 'approved')
  const artFor = (p: ProposalRecord): TaskKind =>
    a.tasks.find((t) => t.text === p.provenance.task)?.kind ?? 'explore'
  const groups = (['watch', 'explore', 'deepen'] as TaskKind[])
    .map((art) => ({ art, items: open.map((p, i) => ({ p, i })).filter((x) => artFor(x.p) === art) }))
    .filter((g) => g.items.length > 0)

  return (
    <>
      <div className="cc-line2">
        <button className="cc-back" onClick={onBack} title="Back · Esc">‹</button>
        <span className="cc-lead">
          <b>{a.name}</b>
          <span className="cc-sub">{here.shelf.key} · {autonomyOf(a.autonomy).label.toLowerCase()} · {open.length} undecided</span>
        </span>
        <span className="grow" />
      </div>
      <div className="cc-dec-wrap">
        <div className="cc-rail">
          <h6>Up for review</h6>
          {list.map(({ shelf, fellow }, i) => (
            <div key={fellow.agent.id} className={`cc-rail-i ${i === at ? 'on' : ''}`} onClick={() => onPick(i)}>
              <span className="nm">{fellow.agent.name}<i>{shelf.key}</i></span>
              <span className="cnt">{fellow.pendingProposals}</span>
            </div>
          ))}
        </div>
        <div className="cc-dec-main">
          <div className="cc-fits">
            {a.autonomy === 'manual' ? (
              <><b>Nothing here runs until you approve it.</b> {a.name} asks every time.</>
            ) : (
              <><b>The top option runs tomorrow night on its own.</b> Veto is how you stop it; approving only moves one ahead of the others.</>
            )}
            <span className="grow" />
            <span className="mono-meta">a proposal stands for two nights, then it expires</span>
          </div>
          {queryState(card, 'the proposals') ??
            groups.map((g) => (
              <div key={g.art} className="cc-group">
                <h4>
                  <span className={`cc-art a-${g.art}`}>{g.art}</span>
                  <span className="c">{g.items.length} option{g.items.length > 1 ? 's' : ''} for the same task</span>
                  <span className="grow" />
                  <span className="mono-meta">{ART_TEXT[g.art]}</span>
                </h4>
                {g.items.map(({ p, i }) => (
                  <Option
                    key={p.id}
                    proposal={p}
                    rank={i + 1}
                    current={i === opt}
                    first={i === 0}
                    autonomy={a.autonomy}
                    span={span}
                    busy={busy}
                    onSelect={() => onOpt(i)}
                    onDecide={(status) => onDecide(p.id, status)}
                  />
                ))}
              </div>
            ))}
        </div>
      </div>
    </>
  )
}

function Option({
  proposal: p,
  rank,
  current,
  first,
  autonomy,
  span,
  busy,
  onSelect,
  onDecide,
}: {
  proposal: ProposalRecord
  rank: number
  current: boolean
  first: boolean
  autonomy: string
  span: number
  busy: boolean
  onSelect: () => void
  onDecide: (status: 'approved' | 'vetoed') => void
}): React.ReactElement {
  const drift = p.scopeScore < DRIFT_THRESHOLD
  const approved = p.status === 'approved'
  const runsByDefault = first && autonomy !== 'manual' && !drift && !approved
  const minutes = Math.round((p.estCostUsd ?? 2.5) * 3)
  return (
    <div className={`cc-opt ${current ? 'cur' : ''} ${approved ? 'ok' : ''}`} onClick={onSelect}>
      <div className="cc-opt-head">
        <span className="cc-rank">{rank}</span>
        <div>
          <div className="cc-opt-t">{p.topic}</div>
          <div className="cc-opt-meta">
            <span className="sev mut">{p.kind}</span>
            <span className="sev mut">{p.pageSet.length > 0 ? `extends ${p.pageSet.length} pages` : p.lens}</span>
            <span className="mono-meta">
              about {usd(p.estCostUsd ?? 0)}
              {p.estPlanPct !== null ? ` · ${p.estPlanPct} points` : ''}
              {span > 0 ? ` · ${Math.round((minutes / span) * 100)}% of tonight` : ''}
            </span>
            <span className="cc-scope" title="token overlap with what you asked this Fellow to follow">
              <span className="mono-meta">fit</span>
              <span className="cc-bar"><i style={{ width: `${Math.round(p.scopeScore * 100)}%` }} /></span>
              <span className="mono-meta">{Math.round(p.scopeScore * 100)}%</span>
            </span>
          </div>
        </div>
        <span>
          {approved ? <span className="sev ok">approved, runs first</span>
            : drift ? <span className="sev due" title="scope below the drift threshold of 0.2">drift · will not run</span>
              : runsByDefault ? <span className="sev ok">runs unless vetoed</span>
                : <span className="sev mut">alternative</span>}
        </span>
      </div>
      <div className="cc-why"><p>{p.rationale}</p></div>
      {p.pageSet.length > 0 && (
        <div className="cc-prov">
          <span className="lbl">will extend</span>
          {p.pageSet.map((x) => <a key={x} onClick={(e) => { e.stopPropagation(); navigate(pageRoute(x)) }}>{x.split('/').pop()?.replace(/\.md$/, '')}</a>)}
          <span className="lbl">no new pages</span>
        </div>
      )}
      <div className="cc-prov">
        <span className="lbl">came from</span>
        <span className="sev mut">{p.provenance.candidate}</span>
        <span>{p.provenance.text}</span>
        {p.provenance.sourcePages[0] !== undefined && (
          <>
            <span className="lbl">read on</span>
            <a onClick={(e) => { e.stopPropagation(); navigate(pageRoute(p.provenance.sourcePages[0]!)) }}>
              {p.provenance.sourcePages[0].split('/').pop()?.replace(/\.md$/, '')}
            </a>
          </>
        )}
      </div>
      <div className="cc-opt-foot">
        <span className="grow" />
        {runsByDefault ? (
          <>
            <button className="btn sm" disabled={busy} onClick={(e) => { e.stopPropagation(); onDecide('approved') }}>Approve anyway</button>
            <button className="btn primary sm" disabled={busy} onClick={(e) => { e.stopPropagation(); onDecide('vetoed') }}>Veto</button>
          </>
        ) : (
          <>
            <button className="btn sm" disabled={busy} onClick={(e) => { e.stopPropagation(); onDecide('vetoed') }}>Veto</button>
            {!approved && (
              <button className="btn primary sm" disabled={busy} onClick={(e) => { e.stopPropagation(); onDecide('approved') }}>
                Approve{drift ? ', it drifts' : ' this one'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Spawning: pick a shape, then fill in the same form the Library has always used.
 *
 * The shape is not a template that dissolves on submit. It sets `art`, and the service holds
 * the Fellow to it from then on: an observer that is later handed a deepen task is refused
 * (`artRefusal`). So the choice here is the one thing on this screen that cannot be undone by
 * editing a field, which is why it is a screen of its own rather than a select in the form.
 */
function Spawn({ shelf, onBack, onDone }: { shelf: string; onBack: () => void; onDone: (id: string) => void }): React.ReactElement {
  const [shape, setShape] = useState<FellowRecord['art'] | null>(null)
  const picked = shape === null ? null : shapeOf(shape)

  if (picked === null) {
    return (
      <>
        <div className="cc-line2">
          <button className="cc-back" onClick={onBack} title="Back · Esc">‹</button>
          <span className="cc-lead"><b>A new Fellow{shelf ? ` for ${shelf}` : ''}</b></span>
          <span className="grow" />
          <span className="cc-sub">what shape should it have?</span>
        </div>
        <div className="lib-window-body cc-body">
          <div className="cc-shapes">
            {SHAPES.map((sh) => (
              <button key={sh.art} className="cc-shape" onClick={() => setShape(sh.art)}>
                <b>
                  {sh.name}
                  <span className={`cc-art a-${sh.art}`}>{sh.art}</span>
                </b>
                <p className="want">{sh.line}</p>
                <p className="what">{sh.body}</p>
                <span className="specs">
                  <span>art: {sh.art === 'custom' ? 'any' : `${sh.art} only`}</span>
                  <span>a night: every standing task</span>
                </span>
              </button>
            ))}
          </div>
          <p className="cc-note dim">
            A shape is kept: the service refuses a task of another art afterwards. Only <b>custom</b> takes any mix, and
            takes no warning with it either.
          </p>
        </div>
      </>
    )
  }

  const kind: TaskKind = picked.art === 'custom' ? 'explore' : picked.art
  return (
    <>
      <div className="cc-line2">
        <button className="cc-back" onClick={() => setShape(null)} title="Back to the shapes">‹</button>
        <span className="cc-lead">
          <b>{picked.name}</b>
          <span className={`cc-art a-${picked.art}`}>{picked.art}</span>
          {/* The headline above names the stop you came from, which is not where this one is
              going when an empty shelf is being staffed. So the shelf is named here too. */}
          {shelf !== '' && <span className="cc-sub">for {shelf}</span>}
        </span>
        <span className="grow" />
        <span className="cc-sub">{picked.line}</span>
      </div>
      <div className="lib-window-body cc-body">
        <SpawnForm
          prefill={{ homeDomain: shelf, art: picked.art, nightly: 'sweep', tasks: [{ text: '', kind }] } satisfies Partial<SpawnBody>}
          onDone={onDone}
          onCancel={() => setShape(null)}
        />
      </div>
    </>
  )
}
