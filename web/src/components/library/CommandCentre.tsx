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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import type {
  AgentPatchBody,
  FellowCard,
  FellowRecord,
  FellowSummary,
  ProposalRecord,
  RecapFellow,
  PlanStatus,
  SceneDepartment,
  SceneRoom,
  SpawnBody,
  TaskKind,
} from '../../api/types.ts'
import {
  runsTonight,
  fellowMinutes,
  isSystemPage,
  minutesFor,
  nightBlock,
  nightRoom,
  scheduleFrom,
  runCount,
  plannedOnly,
  taskBands,
  type TaskBand,
  nightRows,
  type NightRow,
  CANDIDATE_TEXT,
  shelfOrder,
  shelvesFrom,
  tasksTonight,
  ticksIn,
  windowMinutes,
  type Block,
  type Bound,
  type Shelf,
  ingestSchedule,
  type IngestBlock,
  type IngestPhase,
} from '../../lib/command/model.ts'
import { domainColor } from '../../lib/domains.ts'
import { navigate, pageRoute } from '../../lib/router.ts'
import { SpawnForm } from './SpawnForm.tsx'
import { WeekRelease } from './WeekRelease.tsx'
import { queryState } from '../QueryState.tsx'
import { Markdown } from '../Markdown.tsx'
import { timeAgo, usd } from '../../lib/format.ts'
import { MODEL_FACTOR, pointsPerUsd, rosterShare, runUsd, shareDetail, weekShare } from '../../lib/plan.ts'

export type CcView = 'shelves' | 'tonight' | 'dossier' | 'decisions' | 'spawn'
type Pane = 'notebook' | 'recap' | 'ledger' | 'pages' | 'settings'

/**
 * Two scales, because the two bars answer different questions.
 *
 * The setter spans a whole night, 18:00 to 06:00, so there is somewhere to drag the window
 * TO. The queue on a shelf spans the active hours themselves: the work is minutes long and a
 * twelve-hour scale draws it as a hairline, which is the wrong picture of a night that is
 * mostly empty in a different way than "too small to see".
 */
interface Scale {
  readonly from: number
  readonly to: number
}
const NIGHT: Scale = { from: 18 * 60, to: 30 * 60 }
const pctIn = (s: Scale, m: number): number => ((m - s.from) / (s.to - s.from)) * 100
/**
 * How finely each bar is marked. The setter spans a whole night and is dragged in quarter
 * hours, so hours are enough to aim by. The queue holds work six to eleven minutes long, and
 * half hours are what make the difference between "starts around one" and "starts at 01:30".
 */
const HOUR = 60
const HALF_HOUR = 30
const marks = (s: Scale, step: number): number[] => ticksIn(s.from, s.to, step)
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
 *
 * Each carries the settings it is a shape FOR, not only its art: a researcher reads sources
 * and writes a synthesis, which is what pays for opus and a deep step, and it asks first
 * because that is the expensive one. The form shows every one of them and every one can be
 * changed, so these are a starting point and never a hidden decision.
 */
const SHAPES: ReadonlyArray<{
  readonly art: FellowRecord['art']
  readonly name: string
  /** What the user wants, in their words. It is what they pick by. */
  readonly want: string
  readonly what: string
  readonly holds: string
  readonly defaults: Partial<SpawnBody> & { model: string; step: string; autonomy: string }
}> = [
  {
    art: 'watch',
    name: 'The observer',
    want: 'Keep me current.',
    what: 'Searches the web for what is new in a subject and writes it into the vault. A watch task never finishes: it comes round for as long as there is something to find.',
    holds: 'up to 3 tasks, all of them watch',
    defaults: { model: 'sonnet-5', step: 'standard', autonomy: 'veto' },
  },
  {
    art: 'explore',
    name: 'The researcher',
    want: 'Answer my questions.',
    what: 'Searches the web to answer one question, reads the sources it finds and writes the synthesis into the vault. The question rests once the planner judges the vault has it covered; when the last one rests, the Fellow goes quiet and waits for a new question from you.',
    holds: 'up to 3 tasks, all of them explore',
    defaults: { model: 'opus-5', step: 'deep', autonomy: 'manual' },
  },
  {
    art: 'deepen',
    name: 'The librarian',
    want: 'Expand what we already have.',
    what: 'Ranks the concept and entity pages of this shelf against a theme, backlinks per kilobyte, and extends the four thinnest with what it finds on the web. It writes no new pages.',
    holds: 'up to 3 tasks, all of them deepen',
    defaults: { model: 'sonnet-5', step: 'standard', autonomy: 'veto' },
  },
  {
    art: 'custom',
    name: 'Custom',
    want: 'Something of my own.',
    what: 'Any mix of the three arts, up to three tasks, and every setting yours from the start. The shape with no opinion about what a Fellow should be.',
    holds: 'up to 3 tasks, any of the three arts',
    defaults: { model: 'sonnet-5', step: 'standard', autonomy: 'veto' },
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

/** What a bound is called: the two the gate checks, in the words the gate uses. */
const boundName = (b: Bound): string => (b.window === 'week' ? 'the week' : 'the 5-hour window')
/** A reset instant, short enough to sit in a one-line banner. */
const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })

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
  /**
   * The roster in the order the dossier's arrows walk it. The headline draws one dot per stop
   * of whatever ring you are on, and in the dossier the stops are these Fellows rather than
   * the shelves - which is what the arrows do there, and the only reading under which the
   * count is right.
   */
  readonly onRoster: (list: readonly RosterEntry[]) => void
  /** Which Fellow's dossier is open. Held by the screen, because the headline needs it too. */
  readonly fellowId: string | null
  readonly setFellowId: (id: string | null) => void
}

export interface RosterEntry {
  readonly id: string
  readonly name: string
  readonly domain: string
}

export function CommandCentre({
  stop,
  setStop,
  view,
  setView,
  onClose,
  onShelves,
  onRoster,
  fellowId,
  setFellowId,
}: CommandCentreProps): React.ReactElement {
  const [pane, setPane] = useState<Pane>('recap')
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
  /** The held ingest a click on its block marked; its row shows it. */
  const [picked, setPicked] = useState<string | null>(null)

  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, refetchInterval: 20_000 })
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph, staleTime: 60_000 })
  const registry = useQuery({ queryKey: ['domains'], queryFn: api.domains, staleTime: 300_000 })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 60_000 })
  const recaps = useQuery({ queryKey: ['recaps'], queryFn: api.recaps, staleTime: 60_000 })
  // Only for the wing an unstaffed shelf stands in; the room strip behind the window has it too.
  const scene = useQuery({ queryKey: ['library-scene'], queryFn: api.libraryScene, staleTime: 60_000 })
  // Only to price a shape in the plan's own unit; the spawn form shows the same figure.
  const usage = useQuery({ queryKey: ['usage-plan'], queryFn: api.usagePlan, staleTime: 300_000 })
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
  /*
   * Grouped here rather than in `Shelves`: the keyboard walks these rows by index, and two
   * different orders for one list is how Enter opens a different shelf than the one lit up.
   * `empty` is the same list read flat, which is what makes the two agree by construction.
   */
  const wings = useMemo(
    () =>
      byWing(
        // `meta` holds the Fellows' own notebooks and the domain registry, not a subject
        // anyone researches. Offering to staff it would be offering to research the shelving.
        shelves.filter((s) => s.fellows.length === 0 && s.key !== 'meta'),
        scene.data?.rooms ?? [],
        scene.data?.departments ?? [],
      ),
    [shelves, scene.data],
  )
  const empty = useMemo(() => wings.flatMap((w) => w.shelves), [wings])
  const roster = useMemo(() => staffed.flatMap((s) => s.fellows.map((f) => ({ shelf: s, fellow: f }))), [staffed])
  /**
   * The shelf a just-spawned Fellow belongs to, while the roster still knows nothing about it.
   * Cleared the moment the shelf turns up, by the effect below.
   */
  const [pending, setPending] = useState<string | null>(null)
  const shelf = staffed[Math.min(stop, Math.max(0, staffed.length - 1))]

  /*
   * The ring follows the dossier once the data catches up. Two things can be late after a
   * spawn: the Fellow (so `openFellow` could not find its shelf) and the shelf itself (a
   * domain nobody worked before is not a stop until it has someone). Either way the refetch
   * arrives a moment later, and this is where the stop is put right.
   */
  useEffect(() => {
    if (view !== 'dossier') return
    const byFellow = fellowId === null ? -1 : roster.findIndex((r) => r.fellow.agent.id === fellowId)
    const want =
      byFellow >= 0 ? staffed.indexOf(roster[byFellow]!.shelf) : pending === null ? -1 : staffed.findIndex((sh) => sh.key === pending)
    if (want < 0) return
    if (want !== stop) setStop(want)
    if (pending !== null) setPending(null)
  }, [view, fellowId, roster, staffed, pending, stop, setStop])

  // The headline needs the names; it does not need to know how they were derived.
  useEffect(() => onShelves(staffed.map((s) => s.key)), [staffed, onShelves])
  /*
   * The roster as the headline needs it: who, and on which shelf. Only this window knows the
   * order the arrows walk, so it reports it rather than letting the screen guess.
   */
  const entries = useMemo<readonly RosterEntry[]>(
    () => roster.map((r) => ({ id: r.fellow.agent.id, name: r.fellow.agent.name, domain: r.shelf.key })),
    [roster],
  )
  useEffect(() => onRoster(entries), [entries, onRoster])
  /*
   * A Fellow opened from `?cc=<id>` was named before the roster had loaded, so the shelf it
   * stands on follows here rather than at the click. Once per id: `stop` is the user's after
   * that, and re-setting it would drag them back every time the roster refetched.
   */
  const placed = useRef<string | null>(null)
  useEffect(() => {
    if (fellowId === null || placed.current === fellowId) return
    const at = roster.findIndex((r) => r.fellow.agent.id === fellowId)
    if (at < 0) return
    placed.current = fellowId
    setStop(staffed.indexOf(roster[at]!.shelf))
  }, [fellowId, roster, staffed, setStop])

  const set = settings.data?.effective
  const win = useMemo(
    () => windowMinutes(set?.nightWindowStart ?? '01:00', set?.nightWindowEnd ?? '06:00'),
    [set?.nightWindowStart, set?.nightWindowEnd],
  )
  const live = drag ?? win
  const span = live.to - live.from
  // A fresh `{}` every render would re-lay the schedule on every render with it.
  /*
   * What the standing arrangement claims of the week's research budget: every Fellow that is
   * not retired, at its own model, depth and quota. Not tonight's plan - a Fellow that is
   * paused or waiting on approval still occupies its share of the arrangement, and the number
   * that answers "can I afford another one" is the one that counts them all.
   */
  const budget = useMemo(
    () =>
      rosterShare(
        usage.data,
        (agents.data?.fellows ?? [])
          .filter((f) => f.agent.state !== 'retired')
          .map((f) => ({ model: f.agent.model, step: f.agent.step, quotaRunsPerDay: f.agent.quotaRunsPerDay })),
      ),
    [usage.data, agents.data],
  )
  const durations = useMemo(() => agents.data?.durations ?? {}, [agents.data])
  // Phase 0: the ingests held for tonight, from the window's start; the Fellows' queue
  // starts where they end (chunk 7 of docs/tasks/TASKS-SWEEP-2026-09.md).
  const ingests = useMemo(() => ingestSchedule(scene.data?.jobs ?? [], live.from), [scene.data, live.from])
  const ingestEnd = ingests.length > 0 ? ingests[ingests.length - 1]!.to : live.from
  const blocks = useMemo(() => scheduleFrom(staffed, ingestEnd, durations), [staffed, ingestEnd, durations])
  // Removing is cancelling: the job stays in the history as cancelled, like any other.
  const removeHeld = useMutation({
    mutationFn: (id: string) => api.cancel(id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['library-scene'] })
      void qc.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
  const overflow = blocks.filter((b) => b.to > live.to)
  const mine = useMemo(() => (shelf ? blocks.filter((b) => b.shelf === shelf.key) : []), [blocks, shelf])
  /*
   * This shelf's deferred tasks, not the night's. The note sits on a shelf's own page and is
   * about its Fellows, so counting every shelf's put a number there that nothing on the page
   * accounted for. The overflow note below it stays global on purpose and says why: the queue
   * is one line for everyone, so what pushes your work past the window may not be yours.
   */
  const planOnly = plannedOnly(mine)
  // The night as a list, for the shelf you are on: the same blocks the bar draws, in the
  // shift's own order, each carrying the proposal it will work from.
  const rows = useMemo(() => {
    if (shelf === undefined) return []
    // One currency for the list: a slot with no proposal yet is priced in USD, and the
    // calibration turns that into the points the rest of the night is counted in.
    const points = (amount: number, model: string): number | null => {
      const rate = pointsPerUsd(usage.data, model)
      return rate === null ? null : Math.round(amount * rate.ppu * 100) / 100
    }
    return nightRows(shelf, mine, { points })
  }, [shelf, mine, usage.data])
  // The queue draws every shelf, so the "no run of its own" set has to cover every shelf too;
  // `planOnly` above is this shelf's share of it, which is what the note under the bar counts.
  const unrun = useMemo(() => new Set(plannedOnly(blocks)), [blocks])
  /*
   * Whether the plan's own reserves will refuse the night. The schedule above knows tasks and
   * durations; this is the gate every run meets first, and without it the window draws work
   * the service has already decided not to do.
   */
  const blocked = nightBlock(usage.data)
  const room = nightRoom(usage.data)
  /*
   * The one control that hands out budget from this window. It sits at the end of the banner
   * because that is where the reader already is when the answer matters: the sentence before
   * it has just said what is holding the night, and the button is the answer to that sentence.
   */
  const weekRelease = (
    <WeekRelease
      release={{
        enabled: usage.data?.weekOverride.enabled === true,
        active: usage.data?.weekOverride.active === true,
        pct: usage.data?.weekOverride.pct ?? 90,
        until: usage.data?.weekOverride.expiresAt ?? null,
      }}
      weekPct={usage.data?.windows.find((w) => w.window === 'seven_day')?.utilization ?? null}
      onDone={() => void qc.invalidateQueries({ queryKey: ['usage-plan'] })}
    />
  )

  const deciders = useMemo(
    // Undecided, not standing: approving one is what takes it off this list.
    () => roster.filter((r) => r.fellow.undecidedProposals > 0),
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
      // The recap board shows the same decisions elsewhere; it should not keep showing one
      // that has been made here.
      void qc.invalidateQueries({ queryKey: ['recaps'] })
    },
  })
  const act = useMutation({
    mutationFn: async (v: { id: string; what: 'step' | 'plan' | 'pause' | 'resume' | 'retire' }): Promise<void> => {
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

  /**
   * Opens a Fellow's dossier and takes the ring with it.
   *
   * A Fellow spawned a moment ago is not in the roster yet - the list is refetched after the
   * spawn, and until it answers the new one does not exist as far as this component knows. The
   * stop was therefore left where it stood, and the promise in the old comment ("the shelf
   * follows when it is") was never kept by anything: spawning into a shelf that had nobody
   * opened the new Fellow's dossier with the ring still pointing at whoever was there before.
   *
   * Two halves, because the gap is real: the domain is known from the spawn's own answer, so
   * the stop moves at once when that shelf already exists, and `pending` holds it for the case
   * it does not - a shelf with nobody on it is not in `staffed` at all until the refetch.
   */
  const openFellow = (id: string, domain?: string): void => {
    const at = roster.findIndex((r) => r.fellow.agent.id === id)
    if (at >= 0) setStop(staffed.indexOf(roster[at]!.shelf))
    else if (domain !== undefined) {
      const known = staffed.findIndex((sh) => sh.key === domain)
      if (known >= 0) setStop(known)
      else setPending(domain)
    }
    setFellowId(id)
    setPane('recap')
    setView('dossier')
  }
  const stepFellow = (delta: number): void => {
    if (roster.length === 0) return
    const at = roster.findIndex((r) => r.fellow.agent.id === fellowId)
    const next = roster[((at < 0 ? 0 : at) + delta + roster.length) % roster.length]!
    setFellowId(next.fellow.agent.id)
    setStop(staffed.indexOf(next.shelf))
  }
  /**
   * Opens a vault page from inside a dossier and leaves a return ticket behind it.
   *
   * `originPath()` in the router is the last NON-page route, and Escape on a page goes there.
   * Replacing the Library's own entry with one that names this Fellow is therefore all it
   * takes: the same key that leaves a page now lands back on the Fellow you left from, rather
   * than in the room with the window closed.
   */
  const openPage = (page: string): void => {
    if (fellowId !== null) navigate(`/library?cc=${encodeURIComponent(fellowId)}`, { replace: true })
    navigate(pageRoute(page))
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
        const order: Pane[] = ['recap', 'ledger', 'pages', 'notebook', 'settings']
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
      /*
       * A ring of one has nowhere to go. With every Fellow retired there are no staffed
       * shelves, so the only stop is the overview - and stepping off it landed on `tonight`
       * with no shelf to draw, which renders nothing at all. The dots agree: they draw one
       * stop, and the arrows must not offer a second.
       */
      if (staffed.length === 0) {
        if (view !== 'shelves') setView('shelves')
        return
      }
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
      const span = NIGHT.to - NIGHT.from
      const m = NIGHT.from + Math.round((((ev.clientX - rect.left) / rect.width) * span) / 15) * 15
      next =
        edge === 'from'
          ? { from: Math.max(NIGHT.from, Math.min(m, next.to - 60)), to: next.to }
          : { from: next.from, to: Math.min(NIGHT.to, Math.max(m, next.from + 60)) }
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
    <div className="lib-window cc" role="dialog" aria-label="Night shift">
      {view === 'shelves' && (
        <>
          <NightLine
            facts={[
              /* The hours first: they are the setting the rest of the line is read against. */
              { key: 'hours', node: `${hhmm(win.from)} to ${hhmm(win.to)}` },
              { key: 'ingests', node: `Ingest queue: ${ingests.length}` },
              { key: 'tasks', node: `${runCount(blocks)} across ${new Set(blocks.map((b) => b.shelf)).size} shel${new Set(blocks.map((b) => b.shelf)).size === 1 ? 'f' : 'ves'}` },
              /* The night's length counts the held ingests with the Fellows' tasks; the
                 reserve holds only the Fellows, and the line says so when ingests still run. */
              {
                key: 'length',
                node:
                  blocked !== null
                    ? ingests.length > 0
                      ? 'ingests run, Fellows held by the plan reserve'
                      : 'held by the plan reserve'
                    : blocks.length === 0 && ingests.length === 0
                      ? 'nothing to run'
                      : `${dur(blocks.reduce((n, b) => n + b.minutes, 0) + ingests.reduce((n, b) => n + b.minutes, 0))} estimated`,
              },
              { key: 'fellows', node: `${roster.length} Fellow${roster.length === 1 ? '' : 's'}` },
              /*
               * What the arrangement claims of the week, and the way to change what it is
               * claimed from: the limit is a setting, and a number you cannot act on is only
               * half a fact. Over the budget it wears the warning tone.
               */
              ...(budget === null
                ? []
                : [
                    {
                      key: 'budget',
                      node: (
                        <button
                          className={`cc-budget${budget.pct > 100 ? ' over' : ''}`}
                          title={`Research budget: ${shareDetail(budget)}. Click to set the share in System.`}
                          onClick={() => navigate('/system?section=service&setting=researchShareWeekPct')}
                        >
                          Research budget: {budget.pct.toFixed(0)}%
                        </button>
                      ),
                    },
                  ]),
            ]}
          />
          <div className="cc-fixed cc-shelves">
            {/*
              * The hours are one setting for every Fellow, so they belong to the overview and
              * not to a shelf. Kept out of the two panes below and above their scroll, because
              * the number the panes are read against must not scroll away from them.
              */}
            <section className="cc-bars">
              <h3 className="cc-sec">
                Active hours
                <span className="grow" />
                {saveWindow.isPending && <span className="c">saving…</span>}
              </h3>
              <Axis scale={NIGHT} step={HOUR} />
              <div className="cc-track set">
                {marks(NIGHT, HOUR).map((m) => <span key={m} className="cc-grid" style={{ left: `${pctIn(NIGHT, m)}%` }} />)}
                <div
                  className="cc-window"
                  style={{ left: `${pctIn(NIGHT, live.from)}%`, width: `${(span / (NIGHT.to - NIGHT.from)) * 100}%` }}
                >
                  <span className="h l" onMouseDown={dragEdge('from')} />
                  <span className="h r" onMouseDown={dragEdge('to')} />
                </div>
                {/* Phase 0 at the window's start: one grey block per held ingest, as wide as
                    its kind usually takes. A click marks its row below. */}
                {ingests.map((b) => (
                  <span
                    key={b.id}
                    className={`cc-ingest${picked === b.id ? ' here' : ''}`}
                    style={{ left: `${pctIn(NIGHT, b.from)}%`, width: `${(b.minutes / (NIGHT.to - NIGHT.from)) * 100}%` }}
                    title={`${b.name} · ${b.type} · about ${b.minutes} min · held for tonight`}
                    onClick={() => setPicked(b.id)}
                  />
                ))}
                {/*
                  * And the Fellows' own work after it, one block per shelf in the shelf's
                  * colour (2026-09-14). The ingests were drawn here and the work that follows
                  * them was not, so the setter showed a night with nothing in it whenever the
                  * queue was empty - which is most nights. Twelve hours of scale make a
                  * nine-minute run a hairline, so the blocks carry a minimum width in CSS and
                  * a shelf's tasks are one block rather than one each; the queue below draws
                  * them task by task on the window's own scale.
                  */}
                {taskBands(blocks).map((t) => (
                  <span
                    key={`${t.fellowId}-${t.text}-${t.from}`}
                    className="cc-work"
                    style={{ left: `${pctIn(NIGHT, t.from)}%`, width: `${((t.to - t.from) / (NIGHT.to - NIGHT.from)) * 100}%`, ['--dc' as string]: domainColor(t.shelf) }}
                    title={taskTitle(t)}
                  />
                ))}
              </div>
              {/* One line each. The rule behind them is in the note under the queue; here the
                  reader wants the number and, when it is shut, when it opens again. */}
              {blocked !== null ? (
                <p className="cc-note warn one">
                  <b>Nothing runs tonight: {blocked.reason}.</b>{' '}
                  {blocked.liftable
                    ? `Release the window under System${blocked.resetsAt === null ? '' : `, or wait until ${when(blocked.resetsAt)}`}.`
                    : blocked.resetsAt === null
                      ? 'The week clears on its own.'
                      : `The week clears on its own at ${when(blocked.resetsAt)}.`}
                  <span className="grow" />
                  {weekRelease}
                </p>
              ) : room !== null ? (
                <p className="cc-note ok one">
                  <b>Tonight runs.</b> {room.tight.reserve - room.tight.pct} points of room on {boundName(room.tight)}{' '}
                  ({room.tight.pct}% of {room.tight.reserve}%), {room.other.reserve - room.other.pct} on{' '}
                  {boundName(room.other)} ({room.other.pct}% of {room.other.reserve}%).
                  <span className="grow" />
                  {/* Only while a grant is live: a released night says so where it was released. */}
                  {usage.data?.weekOverride.active === true ? weekRelease : null}
                </p>
              ) : null}
            </section>
            <Shelves
              staffed={staffed}
              empty={empty}
              wings={wings}
              row={row}
              blocks={blocks}
              ingests={ingests}
              picked={picked}
              onPick={setPicked}
              onRemove={(id) => removeHeld.mutate(id)}
              removing={removeHeld.isPending}
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
          </div>
        </>
      )}

      {view === 'tonight' && !shelf && (
        <div className="lib-window-body cc-body">
          <p className="empty">
            No shelf has a Fellow. Every stop on this ring is a staffed shelf, so there is only
            the overview until one is.
          </p>
        </div>
      )}

      {view === 'tonight' && shelf && (
        <>
          <NightLine
            facts={[
              { key: 'ingests', node: `Ingest queue: ${ingests.length}` },
              { key: 'tasks', node: runCount(mine) },
              { key: 'when', node: mine.length === 0 ? 'nothing scheduled' : `${hhmm(mine[0]!.from)} to ${hhmm(mine[mine.length - 1]!.to)} (estimated)` },
              { key: 'fellows', node: `${shelf.fellows.length} Fellow${shelf.fellows.length === 1 ? '' : 's'}` },
            ]}
          />
          <div className="lib-window-body cc-body">
            <section className="cc-bars">
              <h3 className="cc-sec">The queue</h3>
              <Axis scale={live} step={HALF_HOUR} />
              <div className="cc-track">
                {marks(live, HALF_HOUR).map((m) => <span key={m} className="cc-grid" style={{ left: `${pctIn(live, m)}%` }} />)}
                {/* Phase 0 first, grey whichever shelf you are on: the held ingests run
                    through the queue before any Fellow works. */}
                {ingests.map((b) => (
                  <div
                    key={b.id}
                    className={`cc-band ingest${picked === b.id ? ' here' : ''}`}
                    style={{ left: `${pctIn(live, b.from)}%`, width: `${(b.minutes / (live.to - live.from)) * 100}%` }}
                    title={`${b.name} · ${b.type} · about ${b.minutes} min · held for tonight, ahead of every Fellow`}
                    onClick={() => setPicked(b.id)}
                  />
                ))}
                {bandsOf(blocks).map((g) => (
                  <div
                    key={`${g.shelf}-${g.from}`}
                    className={`cc-band ${g.shelf === shelf.key ? 'here' : ''}`}
                    style={{ left: `${pctIn(live, g.from)}%`, width: `${((g.to - g.from) / (live.to - live.from)) * 100}%`, ['--dc' as string]: domainColor(g.shelf) }}
                    title={`${g.shelf}: ${runCount(g.parts)}, ${dur(g.to - g.from)}`}
                  >
                    <span className="cc-parts">
                      {g.parts.map((b, i) => (
                        <span
                          key={`${b.fellowId}-${b.text}-${b.phase}-${b.from}`}
                          className={`cc-part ${b.phase === 'run' ? '' : 'plan'}`}
                          style={{ width: `${(b.minutes / (g.to - g.from)) * 100}%`, borderLeft: i > 0 ? '1px solid rgba(255,255,255,.55)' : undefined }}
                          title={blockTitle(b, unrun.has(b))}
                        >
                          {/* The mark is the record of what happened, not part of the forecast:
                              it appears only once the night has made something of the task. */}
                          {b.outcome === 'ran' ? <i className="cc-mark ok" aria-hidden>✓</i> : null}
                          {b.outcome === 'vetoed' ? <i className="cc-mark no" aria-hidden>✕</i> : null}
                        </span>
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
            </section>

            <section className="cc-block">
              <h3 className="cc-sec">Fellows of this shelf <span className="c">{shelf.fellows.length}</span></h3>
              <div className="cc-rows">
                {shelf.fellows.map((f, i) => {
                  const tonight = tasksTonight(f.agent)
                  const minutes = fellowMinutes(f, durations)
                  const runs = runsTonight(f)
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
                        {f.undecidedProposals > 0 && (
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
                            {f.undecidedProposals} decision{f.undecidedProposals === 1 ? '' : 's'}
                          </button>
                        )}
                        {tonight.length === 0 ? (
                          <button className="cc-link quiet" onClick={(e) => { e.stopPropagation(); setFellowId(f.agent.id); setPane('settings'); setView('dossier') }}>
                            Assign a new task ›
                          </button>
                        ) : (
                          <>
                            {/* Runs against the quota, not tasks against tasks: one standing
                                task can carry a whole night, because its planning run puts up
                                three proposals and the shift works through them in rounds. */}
                            <span
                              className={`sev ${runs === 0 ? 'due' : 'ok'}`}
                              title={
                                `${tonight.length} task${tonight.length === 1 ? '' : 's'} planned tonight, ${runs} research run${runs === 1 ? '' : 's'} carried out. ` +
                                `The quota is ${f.agent.quotaRunsPerDay} run(s) a night` +
                                (runs === 0 ? ', and nothing stands to run: tonight is a planning night.' : '.')
                              }
                            >
                              {runs} of {f.agent.quotaRunsPerDay}
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

            {/*
              * What the bar can only shade: the night as a list, in the shift's own order,
              * with the sentence each run will work from. The room under the Fellows is where
              * it belongs - you read who is on the shelf, then what they will do.
              */}
            <section className="cc-block">
              <h3 className="cc-sec">
                Tonight, in order
                <span className="c">{rows.filter((r) => r.kind === 'run' || r.kind === 'open').length}</span>
                <span className="grow" />
                <span className="mono-meta">{nightBill(rows)}</span>
              </h3>
              {rows.length === 0 ? (
                <p className="cc-note dim">Nothing is scheduled for this shelf tonight.</p>
              ) : (
                PHASES.filter(([phase]) => rows.some((r) => r.phase === phase)).map(([phase, lead], at, shown) => {
                  const here = rows.filter((r) => r.phase === phase)
                  return (
                    <div key={phase} className="cc-phase">
                      <h6>{phaseLead(lead, at, shown.length)}</h6>
                      {here.map((r, i) => (
                        <PlanRow
                          key={`${r.fellowId}-${r.kind}-${r.proposal?.id ?? r.task ?? ''}-${i}`}
                          row={r}
                          onPage={openPage}
                          busy={decide.isPending}
                          onOpen={() => openFellow(r.fellowId)}
                          {...(r.proposal === null ? {} : { onVeto: (): void => decide.mutate({ id: r.proposal!.id, status: 'vetoed' }) })}
                        />
                      ))}
                    </div>
                  )
                })
              )}
            </section>

            {/*
              * Below the list, not above it. These notes appear and disappear with the night's
              * state, and every line of them used to push the Fellows down the page: walking
              * from shelf to shelf moved the one thing you walked there to read.
              */}
            <section className="cc-block">
              <p className="cc-note dim">
                The order the shift walks the shelves in, and the arrows change it. Inside a shelf its Fellows keep their
                own order: priority first, then age. Moving a shelf does not move you off it.
              </p>
              {planOnly.length > 0 && (
                <p className="cc-note">
                  <b>
                    {planOnly.length} task{planOnly.length === 1 ? ' is' : 's are'} planned tonight but not carried out
                    {' '}({[...new Set(planOnly.map((b) => b.fellowName))].join(', ')}).
                  </b>{' '}
                  Planning is free of the quota and the run it produces is not, so a Fellow that works more tasks a
                  night than its <i>runs a night</i> allows plans them all and runs the top ones. What is left over stands as
                  a proposal for two nights: approve it to move it ahead of the others, or raise the quota in the Fellow
                  {planOnly.length === 1 ? "'s" : 's’'} settings so every planned task also runs.
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
          </div>
        </>
      )}

      {view === 'dossier' && !fellow && (
        <div className="lib-window-body cc-body">
          {/* Two reasons a dossier has no Fellow, and they are not the same: one is a moment
              after a spawn, the other is a Fellow that has been retired out of the roster. */}
          {agents.data?.fellows.some((f) => f.agent.id === fellowId) === true ? (
            <p className="empty">
              This Fellow is retired. Its notebook and the pages it wrote stay in the vault; it
              is off every shelf.
            </p>
          ) : (
            <p className="empty">Opening the Fellow…</p>
          )}
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
          onAct={(what) => act.mutate({ id: fellow.agent.id, what })}
          onPatch={(body) => patch.mutate({ id: fellow.agent.id, body })}
          onOpenPage={openPage}
          held={blocked === null ? null : blocked.reason}
          nextShift={agents.data?.shift?.nextStartsAt ?? null}
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

      {view === 'spawn' && (
        <Spawn
          shelf={spawnShelf ?? shelf?.key ?? ''}
          durations={durations}
          plan={usage.data}
          onBack={back}
          onDone={openFellow}
        />
      )}
    </div>
  )
}

/** Contiguous runs of one shelf: the unit you read, divided by hairlines into its topics. */
/**
 * The three phases of a night, in the order the shift takes them (`pipeline/shift.ts`).
 *
 * Not the order the bar draws: the bar groups a Fellow's work together because the shelf order
 * is what the arrows set and a task scattered over the night cannot be pointed at. The list is
 * where the true order belongs, and these headings are how it says so without inventing clock
 * times the bar would then contradict.
 */
const PHASES: ReadonlyArray<readonly [1 | 2 | 3, string]> = [
  [1, 'what already stands'],
  [2, 'the planning runs'],
  [3, 'what the night decides for itself'],
]

/** The heading, with the connector the reader needs: "then" only when something came before. */
const phaseLead = (lead: string, at: number, of: number): string =>
  of === 1 ? lead[0]!.toUpperCase() + lead.slice(1) : `${at === 0 ? 'First' : 'Then'}, ${lead}`

/**
 * The night's own arithmetic for one shelf: what it spends and how long it takes.
 *
 * Points where every line has them, USD otherwise. Never a sum of both - the two are the same
 * estimate in different currencies, and adding one to the other would be a number for nothing.
 */
function nightBill(rows: readonly NightRow[]): string {
  const work = rows.filter((r) => r.kind === 'run' || r.kind === 'open')
  const minutes = rows.reduce((n, r) => n + r.minutes, 0)
  if (work.length === 0) return `${dur(minutes)} · planning only`
  const priced = work.every((r) => r.estPct !== null)
  const total = priced
    ? `${work.reduce((n, r) => n + (r.estPct ?? 0), 0).toFixed(2)} points`
    : usd(work.reduce((n, r) => n + (r.estUsd ?? 0), 0))
  return `${dur(minutes)} · about ${total}`
}

/**
 * One line of the night. Four kinds, and the difference between them is what the reader is
 * being told: a run names its subject, a plan names the task it will think about, an open slot
 * names the room it has, and a held line names what will not happen and why.
 */
function PlanRow({
  row: r,
  busy,
  onOpen,
  onVeto,
  onPage,
}: {
  row: NightRow
  busy: boolean
  onOpen: () => void
  onVeto?: () => void
  onPage: (page: string) => void
}): React.ReactElement {
  const p = r.proposal
  const source = p?.provenance.sourcePages[0]
  return (
    <div className={`cc-pl ${r.kind}`} onClick={onOpen}>
      <span className="cc-pl-mark" aria-hidden>
        {r.kind === 'run' ? '▶' : r.kind === 'plan' ? '◇' : r.kind === 'open' ? '◌' : '✕'}
      </span>
      <div className="cc-pl-main">
        <div className="cc-pl-head">
          <b>{r.fellowName}</b>
          {p !== null ? (
            <>
              <span className="sev mut">{p.kind}</span>
              <span className="sev mut">{p.pageSet.length > 0 ? `extends ${p.pageSet.length} pages` : p.lens}</span>
              {p.status === 'approved' ? <span className="sev ok">approved</span> : <span className="sev due">undecided</span>}
            </>
          ) : r.art !== null ? (
            <span className={`cc-art a-${r.art}`}>{r.art}</span>
          ) : null}
          <span className="grow" />
          {r.minutes > 0 && (
            <span className="mono-meta">
              {dur(r.minutes)}
              {r.estPct !== null ? ` · ${r.estPct} points` : r.estUsd !== null ? ` · ${usd(r.estUsd)}` : ''}
            </span>
          )}
          {p !== null && (
            <span className="cc-scope" title="token overlap with what you asked this Fellow to follow">
              <span className="mono-meta">· fit</span>
              <span className="cc-bar"><i style={{ width: `${Math.round(p.scopeScore * 100)}%` }} /></span>
              <span className="mono-meta">{Math.round(p.scopeScore * 100)}%</span>
            </span>
          )}
        </div>
        {/* The subject, in the planner's own sentence where there is one - that is the whole
            point of the list, and shortening it would leave the reader guessing again. */}
        <p className="cc-pl-t">{p !== null ? p.topic : (r.task ?? r.fellowName)}</p>
        <p className="cc-pl-why">
          {r.why}
          {p !== null && (
            <>
              {' · from '}
              {CANDIDATE_TEXT[p.provenance.candidate] ?? p.provenance.candidate}
              {source !== undefined && (
                <>
                  {', '}
                  <button
                    className="cc-pl-src"
                    onClick={(e) => { e.stopPropagation(); onPage(source) }}
                    title={source}
                  >
                    {source.replace(/^wiki\//, '').replace(/\.md$/, '')}
                  </button>
                </>
              )}
            </>
          )}
        </p>
      </div>
      {onVeto !== undefined && (
        /* The one decision worth having here. Approving is a ranking choice and belongs in
           Decisions with the alternatives beside it; stopping something does not. */
        <button
          className="btn ghost sm danger cc-pl-veto"
          disabled={busy}
          title={`Veto "${p?.topic ?? ''}". It will not run, tonight or later.`}
          onClick={(e) => { e.stopPropagation(); onVeto() }}
        >
          Veto
        </button>
      )}
    </div>
  )
}

/**
 * What one block of the queue says about itself: whose it is, which task, and what the night
 * does with it. Every section carries its own, because a Fellow with three tasks is three
 * different answers and one tooltip for the band would name none of them.
 */
function blockTitle(b: Block, unrun: boolean): string {
  const who = `${b.fellowName} · ${b.kind}: ${b.text}`
  if (b.outcome === 'ran') return `${who} · done, a run carried it out tonight`
  if (b.outcome === 'vetoed') return `${who} · nothing runs: you vetoed every option it proposed`
  if (b.phase === 'run') return `${who} · a research run, about ${dur(b.minutes)}`
  return unrun
    ? `${who} · the planning run (${dur(b.minutes)}). Its own run does not fit tonight: the quota is spent on the tasks ahead of it, so what it proposes stands for a later night.`
    : `${who} · the planning run (${dur(b.minutes)}): what to do about this task tonight. It never counts against the quota.`
}

/** The same for one whole task, which is what the overview above draws. */
function taskTitle(t: TaskBand): string {
  const who = `${t.fellowName} · ${t.kind}: ${t.text}`
  const work =
    t.runs === 0
      ? 'planned tonight, no run of its own'
      : `${t.plans} plan and ${t.runs} run${t.runs === 1 ? '' : 's'}, ${dur(t.to - t.from)}`
  if (t.outcome === 'ran') return `${who} · ${work} · done, a run carried it out tonight`
  if (t.outcome === 'vetoed') return `${who} · nothing runs: you vetoed every option it proposed`
  return `${who} · ${work}`
}

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

/** The shared axis: one label at every mark, and every mark set the same. */
function Axis({ scale, step }: { scale: Scale; step: number }): React.ReactElement {
  return (
    <div className="cc-axis">
      {marks(scale, step).map((m) => (
        <span key={m} className="cc-hour" style={{ left: `${pctIn(scale, m)}%` }}>{hhmm(m)}</span>
      ))}
    </div>
  )
}

/**
 * The night in four facts, centred and in fixed slots. They change every night and with every
 * setting, and a line that re-centres itself as they do is a line you have to find again each
 * time - so each fact keeps its width whatever it says.
 */
function NightLine({ facts }: { facts: readonly { key: string; node: React.ReactNode }[] }): React.ReactElement {
  return (
    <div className="cc-line2">
      <span className="cc-side" />
      <span className="cc-facts">
        <b>Tonight</b>
        {facts.map((f) => <span key={f.key} className="s">{f.node}</span>)}
      </span>
      <span className="cc-side end" />
    </div>
  )
}

/** Where an ingest of tonight's queue stands, as its row says it. */
const PHASE_TEXT: Record<IngestPhase, string> = {
  held: 'held for tonight',
  waiting: 'released, waiting its turn',
  running: 'running now',
  committing: 'run finished, committing',
}

/**
 * The two panes of the overview: the shelves that have a Fellow, and the shelves that do not.
 *
 * Each scrolls on its own so the active hours above them stay put, and a row is one line: at
 * twenty-one domains the second line was most of the scrolling.
 */
function Shelves({
  staffed,
  empty,
  wings,
  row,
  blocks,
  ingests,
  picked,
  onPick,
  onRemove,
  removing,
  onOpen,
  onSpawn,
  onDecisions,
}: {
  staffed: readonly Shelf[]
  empty: readonly Shelf[]
  wings: ReadonlyArray<{ name: string; shelves: Shelf[] }>
  row: number
  blocks: readonly Block[]
  /** Phase 0: the ingests held for tonight, in the order they run. */
  ingests: readonly IngestBlock[]
  picked: string | null
  onPick: (id: string | null) => void
  onRemove: (id: string) => void
  removing: boolean
  onOpen: (index: number) => void
  onSpawn: (key: string) => void
  onDecisions: (key: string) => void
}): React.ReactElement {
  return (
    <>
      {/*
       * Tonight's ingests, one row each, in the order they run: the block in the bar above
       * and the row here are the same job (a click on the block marks the row). A row stays
       * from "Add to night shift" until the job's commit is made (2026-09-12): released and
       * waiting, running, committing - the queue empties one job at a time as the night goes,
       * not all at once when it begins. Removing is cancelling, so only a job still waiting
       * can be removed; a running one is left to finish. The rows are tab stops, and Delete
       * removes the focused one.
       */}
      <section className="cc-pane">
        <h3 className="cc-sec">
          Ingest queue <span className="c">{ingests.length}</span>
        </h3>
        {ingests.length === 0 ? (
          <p className="empty">Nothing is held for tonight. "Add to night shift" on Home holds an ingest until the shift begins, and it runs ahead of every Fellow.</p>
        ) : (
          <div className="cc-rows">
            {ingests.map((b) => {
              const removable = b.phase === 'held' || b.phase === 'waiting'
              return (
                <div
                  key={b.id}
                  className={`cc-row one ingest ${b.phase} ${picked === b.id ? 'sel' : ''}`}
                  tabIndex={0}
                  aria-label={`${b.name}, ${PHASE_TEXT[b.phase]}`}
                  onClick={() => onPick(b.id)}
                  onFocus={() => onPick(b.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Delete' || e.key === 'Backspace') {
                      e.preventDefault()
                      e.stopPropagation()
                      if (removable) onRemove(b.id)
                    } else if (e.key === 'Enter') e.stopPropagation()
                  }}
                >
                  <span className="chip-dot ingest" aria-hidden />
                  <b className="cc-key">{b.name}</b>
                  <span className="cc-t">
                    {b.type} · about {b.minutes} min · added {timeAgo(b.createdAt)}
                    {b.phase !== 'held' && ` · ${PHASE_TEXT[b.phase]}`}
                  </span>
                  <span className="grow" />
                  <span className="mono-meta">{hhmm(b.from)}</span>
                  {removable ? (
                    <button
                      className="btn sm"
                      disabled={removing}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemove(b.id)
                      }}
                      title="Take it off tonight's queue: the job is cancelled and stays in the history"
                    >
                      Remove
                    </button>
                  ) : (
                    <span className="cc-t cc-left" title="A running ingest is left to finish; the row goes once its commit is made">
                      left to finish
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="cc-pane">
        <h3 className="cc-sec">
          Staffed domains <span className="c">{staffed.length}</span>
        </h3>
        {staffed.length === 0 ? (
          <p className="empty">No Fellow anywhere yet. Any shelf below can have the first one.</p>
        ) : (
          <div className="cc-rows">
            {staffed.map((d, i) => {
              const nightly = blocks.filter((b) => b.shelf === d.key).reduce((n, b) => n + b.minutes, 0)
              const open = d.fellows.reduce((n, f) => n + f.undecidedProposals, 0)
              return (
                <div key={d.key} className={`cc-row one ${i === row ? 'sel' : ''}`} onClick={() => onOpen(i)}>
                  <span className="chip-dot" style={{ background: domainColor(d.key) }} aria-hidden />
                  <b className="cc-key">{d.key}</b>
                  <span className="cc-t">
                    {d.fellows.map((f) => f.agent.name).join(', ')} · {d.pages} pages · {d.questions} open question{d.questions === 1 ? '' : 's'}
                  </span>
                  <span className="grow" />
                  {open > 0 && (
                    <button className="sev due cc-pill" onClick={(e) => { e.stopPropagation(); onDecisions(d.key) }}>
                      {open} decision{open === 1 ? '' : 's'}
                    </button>
                  )}
                  <span className="mono-meta">{nightly > 0 ? `${nightly} min tonight` : 'nothing tonight'}</span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="cc-pane">
        <h3 className="cc-sec">
          Unstaffed domains <span className="c">{empty.length}</span>
        </h3>
        <div className="cc-rows">
          {wings.map((w) => (
            <div key={w.name} className="cc-wing">
              <h4 className="cc-wing-h">{w.name}</h4>
              {w.shelves.map((d) => (
                <div
                  key={d.key}
                  className={`cc-row one ${row === staffed.length + empty.indexOf(d) ? 'sel' : ''}`}
                  onClick={() => onSpawn(d.key)}
                >
                  <span className="chip-dot" style={{ background: domainColor(d.key), opacity: 0.45 }} aria-hidden />
                  <b className="cc-key">{d.key}</b>
                  <span className="cc-t">
                    {d.pages} pages · {d.questions} open question{d.questions === 1 ? '' : 's'} · {d.gaps} linked but never written
                  </span>
                  <span className="grow" />
                  <span className="cc-bar" title="how much is waiting here"><i style={{ width: `${Math.min(100, (d.questions + d.gaps * 2) * 6)}%` }} /></span>
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); onSpawn(d.key) }}>Spawn fellow ›</button>
                </div>
              ))}
            </div>
          ))}
        </div>
        <p className="cc-note dim">
          A shelf without a Fellow is not idle: ingests still file pages there. It only means nobody plans work for it at
          night.
        </p>
      </section>
    </>
  )
}

/**
 * The unstaffed shelves grouped by the wing they stand in, wings in the order the room strip
 * shows them, and inside a wing the shelf with the most open questions first.
 *
 * The wing is where a shelf physically is, so it is the grouping a reader already has a map
 * for. A domain nobody has placed goes last under its own heading rather than into the first
 * wing, which would be a claim about where it stands.
 */
function byWing(
  empty: readonly Shelf[],
  rooms: readonly SceneRoom[],
  departments: readonly SceneDepartment[],
): Array<{ name: string; shelves: Shelf[] }> {
  const roomOf = new Map(departments.map((d) => [d.domain, d.room]))
  const order = [...rooms].sort((a, b) => a.position - b.position)
  const name = new Map(order.map((r) => [r.id, r.name]))
  const groups = new Map<string, Shelf[]>()
  for (const r of order) groups.set(r.id, [])
  const UNPLACED = '\u0000unplaced'
  for (const shelf of empty) {
    const id = roomOf.get(shelf.key) ?? null
    const key = id !== null && groups.has(id) ? id : UNPLACED
    groups.set(key, [...(groups.get(key) ?? []), shelf])
  }
  const out: Array<{ name: string; shelves: Shelf[] }> = []
  for (const [id, shelves] of groups) {
    if (shelves.length === 0) continue
    out.push({
      name: id === UNPLACED ? 'Not shelved in a wing yet' : (name.get(id) ?? id),
      shelves: [...shelves].sort((a, b) => b.questions - a.questions || b.gaps - a.gaps || a.key.localeCompare(b.key)),
    })
  }
  return out
}

function Dossier({
  fellow,
  card,
  recap,
  pane,
  durations,
  setPane,
  onBack,
  onAct,
  onPatch,
  onOpenPage,
  held,
  nextShift,
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
  onAct: (what: 'step' | 'plan' | 'pause' | 'resume' | 'retire') => void
  onPatch: (body: AgentPatchBody) => void
  onOpenPage: (page: string) => void
  /** Why nothing will run tonight, if anything: the state line says so where it applies. */
  held: string | null
  /** When the next shift starts, so a waiting Fellow can name what it waits for. */
  nextShift: string | null
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
  /*
   * What the night produced first, what it did second, and the settings behind it last. The
   * notebook is the Fellow's own page and belongs near the settings that write to it.
   */
  /** The retire button's second step: ending a Fellow is not a single click. */
  const [asking, setAsking] = useState(false)
  const [showPlanning, setShowPlanning] = useState(false)
  const shown = showPlanning ? runs : runs.filter((r) => r.kind !== 'plan')
  /*
   * The indexes a run has to touch are not what it made. Hidden by default, because a list of
   * "created pages" that opens with `hot.md` and `_index.md` answers a question nobody asked.
   */
  const [hideSystem, setHideSystem] = useState(true)
  const shownPages = hideSystem ? pages.filter((p) => !isSystemPage(p)) : pages

  // The counts are of what the tab SHOWS: a label saying 31 over a list of 25 invites the
  // question the footer already answers.
  const panes: Array<[Pane, string]> = [
    ['recap', 'Recap'],
    ['ledger', `Activity log ${shown.length}`],
    ['pages', `Created pages ${shownPages.length}`],
    ['notebook', 'Notebook'],
    ['settings', 'Settings'],
  ]
  const nightly = fellowMinutes(fellow, durations)
  const tonight = tasksTonight(a)
  const carried = runsTonight(fellow)

  return (
    <>
      <div className="cc-line2">
        <button className="cc-back" onClick={onBack} title="Back to tonight · Esc">‹</button>
        {/*
          * The night as a chain rather than as a heap of labels: where the Fellow stands now,
          * then every step the shift will take for it, planning included. A task the quota
          * cannot carry out ends at its planning run, and the chain says so by stopping there.
          * The name is in the headline above; repeating it here said nothing twice.
          */}
        <span className="cc-lead cc-flow">
          <span
            className={`sev ${fellow.currentRun ? 'rec' : a.state === 'paused' ? 'mut' : held !== null ? 'due' : 'ok'}`}
            title={stateReason(a, fellow, held, nextShift)}
          >
            {fellow.currentRun ? 'working' : a.state}
          </span>
          {tonight.length === 0 ? (
            <>
              <i className="cc-arrow-in" aria-hidden>→</i>
              <span className="cc-step-none">nothing standing</span>
            </>
          ) : (
            tonight.map((t, i) => (
              <span key={t.id} className="cc-flow-step">
                <i className="cc-arrow-in" aria-hidden>→</i>
                <span className="cc-art a-plan" title="A planning run: what to do about this task. It never counts against the night's quota.">
                  plan
                </span>
                <i className="cc-arrow-in" aria-hidden>→</i>
                <span
                  className={`cc-art a-${t.kind} ${i < carried ? '' : 'held'}`}
                  title={i < carried ? `${ART_TEXT[t.kind]} Task: ${t.text}` : `Planned tonight, carried out on a later night: the quota is ${a.quotaRunsPerDay} run(s) a night. Task: ${t.text}`}
                >
                  {t.kind}
                </span>
              </span>
            ))
          )}
          {/* A state nobody can act on has to say what it is waiting for. */}
          <span className="cc-sub">{stateReason(a, fellow, held, nextShift)}</span>
        </span>
        <span className="grow" />
        {/*
          * Retiring is the one action here that ends something, so it asks first and wears no
          * colour: it stops the Fellow for good, keeps its record and its pages, and takes it
          * off every shelf. Pausing is the reversible neighbour and stays a plain button.
          */}
        {a.state === 'retired' ? (
          <span className="cc-sub">retired; its pages and notebook stay in the vault</span>
        ) : asking ? (
          <span className="cc-ask">
            <button className="cc-rel go" disabled={busy} onClick={() => { setAsking(false); onAct('retire') }}>
              yes, retire {a.name}
            </button>
            <button className="cc-rel" onClick={() => setAsking(false)}>no</button>
          </span>
        ) : (
          <>
            <button
              className="btn ghost sm"
              disabled={busy}
              title={`Stop ${a.name} for good. Its notebook and the pages it wrote stay; nothing plans or runs for it again.`}
              onClick={() => setAsking(true)}
            >
              Retire
            </button>
            <button className="btn sm" disabled={busy} onClick={() => onAct(a.state === 'paused' ? 'resume' : 'pause')}>
              {a.state === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button className="btn sm" disabled={busy} onClick={() => onAct('plan')}>Plan now</button>
            <button className="btn primary sm" disabled={busy || a.state === 'paused'} onClick={() => onAct('step')}>
              Run a task now
            </button>
          </>
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
              <span className="mono-meta">{nightly} min tonight · {card ? `${card.quota.used} of ${card.quota.runsPerDay} runs used` : ''}</span>
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
                  : pane === 'pages' ? 'a row opens the page' 
                    : pane === 'settings' ? 'changes apply to the next night' : ''}
          </span>
        </div>

        <div className="cc-area">
          <div className="cc-scroll">
          {pane === 'notebook' && <Notebook path={a.notebookPath} />}

          {pane === 'recap' &&
            (recap === undefined ? (
              <p className="empty">No recap covers this Fellow yet.</p>
            ) : (
              /* The same shape as the notebook beside it: one section per question the recap
                 answers, so the two panes read as two views of one Fellow. */
              <div className="cc-doc">
                <section className="cc-doc-sec">
                  <h5>The night</h5>
                  {recap.runs.length === 0 ? (
                    <p className="cc-note warn">Did not run: {recap.sleepReason ?? 'nothing worth a run'}</p>
                  ) : (
                    <ul className="cc-list runs">
                      {recap.runs.map((r) => (
                        <li key={r.runId}>
                          <span className={`sev ${r.ok ? 'ok' : 'err'}`}>{r.kind.replace('research-', '').replace('research', 'sweep')}</span>
                          <span className="t">{r.topic}</span>
                          <span className="mono-meta">
                            {r.pagesCreated.length + r.pagesUpdated.length} page
                            {r.pagesCreated.length + r.pagesUpdated.length === 1 ? '' : 's'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="cc-doc-sec">
                  <h5>What it found</h5>
                  {recap.found.length === 0 ? (
                    <p className="empty">Nothing was written up.</p>
                  ) : (
                    <div className="cc-prose">{recap.found.map((x) => <p key={x}>{x}</p>)}</div>
                  )}
                </section>
                {recap.openQuestions.length > 0 && (
                  <section className="cc-doc-sec">
                    <h5>Questions it raised</h5>
                    <ul className="cc-list">{recap.openQuestions.map((q) => <li key={q}>{q}</li>)}</ul>
                  </section>
                )}
                <section className="cc-doc-sec">
                  <h5>Did you use it</h5>
                  <p className="mono-meta">{recap.value.pageOpens} page open(s) · {recap.value.recapLinks} link(s) followed</p>
                  <p className="cc-note dim">
                    {a.name}’s slice of the last recap. The wall board in the Library keeps the whole night.
                  </p>
                </section>
              </div>
            ))}

          {pane === 'ledger' &&
            (shown.length === 0 ? (
              <p className="empty">{runs.length === 0 ? 'No runs yet.' : 'Only planning runs so far; show them to see the night.'}</p>
            ) : (
              <table className="cc-ledger">
                <thead><tr><th>When</th><th>Task</th><th>Out</th><th>Cost</th></tr></thead>
                <tbody>
                  {shown.map((r) => {
                    const page = r.pages.find((p) => p.startsWith('wiki/questions/')) ?? r.pages[0]
                    return (
                      <tr
                        key={r.id}
                        className={page === undefined ? '' : 'open'}
                        title={page === undefined ? 'This run filed no page' : `Open ${page.split('/').pop()?.replace(/\.md$/, '')}`}
                        onClick={() => { if (page !== undefined) onOpenPage(page) }}
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
            (shownPages.length === 0 ? (
              <p className="empty">
                {pages.length === 0 ? 'No pages yet.' : 'Only the vault’s own indexes so far; include them to see them.'}
              </p>
            ) : (
              <ul className="cc-pages">
                {shownPages.map((p) => (
                  <li key={p} onClick={() => onOpenPage(p)}>
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
                    <span className="k">Runs a night</span>
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
                    <span className="mono-meta">{nightly} min tonight{card ? ` · ${card.quota.used} of ${card.quota.runsPerDay} used` : ''}</span>
                  </div>
                  {/*
                    * Against TONIGHT'S tasks, not against everything standing. A rotating
                    * Fellow plans one task a night whatever its list holds, so comparing the
                    * quota with the whole list told a Fellow doing exactly what it was asked
                    * that it was falling behind.
                    */}
                  {carried < tonight.length && (
                    <p className="cc-note warn">
                      {tonight.length} task{tonight.length === 1 ? '' : 's'} planned tonight, {carried} run
                      {carried === 1 ? '' : 's'} carried out. Planning is free of the quota and the run it produces is not, so{' '}
                      {tonight.length} run{tonight.length === 1 ? '' : 's'} a night is what it takes for every task planned to also run.{' '}
                      <button className="cc-link" disabled={patching} onClick={() => onPatch({ quotaRunsPerDay: tonight.length })}>
                        Raise it to {tonight.length} ›
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
                    {a.model} · {a.effort} effort · {a.step} depth · {a.lens} lens · {a.art === 'custom' ? 'custom' : `${a.art} only`}
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

          {/*
            * The corner of the box, not the end of the table: a switch that changes what the
            * rows above it are should be where it can be reached without scrolling to find it.
            */}
          {(pane === 'ledger' || pane === 'pages') && (
            <div className="cc-foot">
              {pane === 'ledger' ? (
                <label className="cc-toggle">
                  <input type="checkbox" checked={showPlanning} onChange={(e) => setShowPlanning(e.target.checked)} />
                  Show planning
                  <span className="mono-meta">{runs.length - shown.length} hidden</span>
                </label>
              ) : (
                <label className="cc-toggle">
                  <input type="checkbox" checked={hideSystem} onChange={(e) => setHideSystem(e.target.checked)} />
                  Exclude system pages
                  <span className="mono-meta">{pages.length - shownPages.length} hidden</span>
                </label>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * What a Fellow's state is waiting for, in one clause.
 *
 * `waiting` is the state with nothing to read: it means a proposal stands and a run has not
 * taken it, which is true of a Fellow that will run in an hour and of one the plan reserve
 * has stopped for a day. The sleeping states carry their own reason already; this fills the
 * gap the others leave.
 */
function stateReason(a: FellowRecord, fellow: FellowSummary, held: string | null, nextShift: string | null): string {
  if (fellow.currentRun) return 'a run is in flight'
  if (a.state === 'paused') return 'paused by you; resume to let the shift take it again'
  if (a.state === 'blocked') return 'a run failed; resume it to try again'
  if (a.sleepReason !== null && a.sleepReason !== '') return a.sleepReason
  if (held !== null) return `held tonight: ${held}`
  const when =
    nextShift === null
      ? 'the next night shift'
      : `the shift at ${new Date(nextShift).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  if (a.state === 'waiting') return `${fellow.next === null ? 'nothing to run' : 'a proposal stands'}, waiting for ${when}`
  return `waiting for ${when}`
}

/**
 * The notebook is a vault page; the window shows what the page says, not a copy of it.
 *
 * Read-only and non-destructive: the markdown is split on its own `## ` headings and each
 * section is rendered as it stands. Nothing is rewritten, and a page that does not follow the
 * shape (a section renamed by hand, a preamble above the first heading) still shows in full,
 * because what is not under a heading is kept as the first block rather than dropped.
 */
function Notebook({ path }: { path: string }): React.ReactElement {
  // `api.page` is a PREVIEW and truncates: the notebook lost its last section to it, silently.
  const page = useQuery({ queryKey: ['page-full', path], queryFn: () => api.pageFull(path), staleTime: 30_000 })
  const state = queryState(page, 'the notebook')
  if (state) return <>{state}</>
  const sections = splitSections(page.data?.markdown ?? '')
  if (sections.length === 0) return <p className="empty">The notebook page is empty.</p>
  return (
    <div className="cc-doc">
      {sections.map((sec) => (
        <section key={sec.name ?? '_'} className="cc-doc-sec">
          {sec.name !== null && <h5>{sec.name}</h5>}
          {sec.body.trim() === '' ? (
            <p className="empty">Nothing here yet.</p>
          ) : (
            <div className="cc-prose"><Markdown source={sec.body} /></div>
          )}
        </section>
      ))}
    </div>
  )
}

/**
 * A markdown document as its `## ` sections, in the order it wrote them. Frontmatter and the
 * `# Title` line go, because the pane is already inside a window that names the Fellow; a
 * `name: null` section is whatever stood before the first heading.
 */
function splitSections(markdown: string): Array<{ name: string | null; body: string }> {
  // The blank line between the frontmatter and the title is why the title strip needs `\s*`.
  const text = markdown.replace(/^---[\s\S]*?\n---\n/, '').replace(/^\s*#\s+.*\n/, '')
  const out: Array<{ name: string | null; body: string }> = []
  let name: string | null = null
  let body: string[] = []
  const flush = (): void => {
    if (name !== null || body.join('\n').trim() !== '') out.push({ name, body: body.join('\n') })
  }
  for (const line of text.split('\n')) {
    const head = /^##\s+(.+?)\s*$/.exec(line)
    if (head) {
      flush()
      name = head[1]!
      body = []
    } else body.push(line)
  }
  flush()
  return out
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
              <span className="cnt">{fellow.undecidedProposals}</span>
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
function Spawn({
  shelf,
  durations,
  plan,
  onBack,
  onDone,
}: {
  shelf: string
  durations: Readonly<Record<string, number | null>>
  plan: PlanStatus | undefined
  onBack: () => void
  onDone: (id: string, homeDomain: string) => void
}): React.ReactElement {
  const [shape, setShape] = useState<FellowRecord['art'] | null>(null)
  const picked = shape === null ? null : shapeOf(shape)

  if (picked === null) {
    return (
      <>
        <div className="cc-line2">
          <button className="cc-back" onClick={onBack} title="Back · Esc">‹</button>
          <span className="cc-lead"><b>A new Fellow{shelf ? ` for ${shelf}` : ''}</b></span>
          <span className="grow" />
          <span className="cc-sub">what should it be?</span>
        </div>
        <div className="lib-window-body cc-body">
          <div className="cc-shapes">
            {SHAPES.map((sh) => {
              /*
               * Its own numbers, not the same three copied four times: the shapes differ in
               * model and depth, which is most of what a Fellow costs. Three standing tasks
               * is what the shape is sized for, and what a spawn defaults its quota to.
               */
              const kind: TaskKind = sh.art === 'custom' ? 'explore' : sh.art
              const perRun = runUsd(sh.defaults.step, sh.defaults.model)
              const week = weekShare(plan, { stepUsd: perRun, stepsPerDay: 3, model: sh.defaults.model })
              return (
                <button key={sh.art} className="cc-shape" onClick={() => setShape(sh.art)}>
                  <b>
                    {sh.name}
                    <span className={`cc-art a-${sh.art}`}>{sh.art === 'custom' ? 'mixed' : sh.art}</span>
                  </b>
                  <p className="want">“{sh.want}”</p>
                  <p className="what">{sh.what}</p>
                  <span className="specs">
                    <span className="holds">{sh.holds}</span>
                    <span>{minutesFor(kind, durations)} min a task · {usd(perRun)} a run</span>
                    <span>
                      {sh.defaults.model.replace(/-\d.*$/, '')}
                      {(MODEL_FACTOR[sh.defaults.model] ?? 1) > 1 ? ` (×${MODEL_FACTOR[sh.defaults.model]!} the plan)` : ''} ·{' '}
                      {sh.defaults.step} depth
                      {week === null ? '' : ` · ${week.pct.toFixed(0)}% of the research budget at 3 tasks`}
                    </span>
                    <span>{autonomyOf(sh.defaults.autonomy).short}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <p className="cc-note dim">
            A shape is kept: the service refuses a task of another art afterwards. Every other setting here is a starting
            point you change on the next screen. Only <b>custom</b> takes any mix, and takes no warning with it either.
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
          <span className={`cc-art a-${picked.art}`}>{picked.art === 'custom' ? 'mixed' : picked.art}</span>
          {/* The headline above names the stop you came from, which is not where this one is
              going when an empty shelf is being staffed. So the shelf is named here too. */}
          {shelf !== '' && <span className="cc-sub">for {shelf}</span>}
        </span>
        <span className="grow" />
        <span className="cc-sub">“{picked.want}”</span>
      </div>
      <div className="lib-window-body cc-body">
        <SpawnForm
          prefill={
            {
              homeDomain: shelf,
              art: picked.art,
              nightly: 'sweep',
              tasks: [{ text: '', kind }],
              ...picked.defaults,
            } satisfies Partial<SpawnBody>
          }
          plan={plan}
          onDone={onDone}
          onCancel={() => setShape(null)}
        />
      </div>
    </>
  )
}
