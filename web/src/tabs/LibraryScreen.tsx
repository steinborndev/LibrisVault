/**
 * The Library screen (docs/agents/SPEC.md section 10, docs/tasks/TASKS-A4.md): the vault as
 * a library, one room per view, the service's activity as people working in it. A renderer
 * over data the service already has: the scene snapshot, the live log lines, the run
 * registry. The control column holds the Fellows, the Rooms and the Departments; the
 * canvas box holds the room, the strip, the now chip and the legend; the card docks beside.
 *
 * Deep links: `/library?agent=<id>` opens the card, `/library?room=<id>` shows a room,
 * `/library?spawn=1` opens the spawn form (Home's empty Fellow slots point here),
 * `/library?shelf=<domain>` opens that department's window straight away, on its graph
 * unless `&pane=catalog` asks for the other view, and `&page=<vault path>` opens a page
 * inside it, and `?board=hot|recap|reading` opens one of the boards.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { fmtDay } from '../lib/recapFeed.ts'
import type { LibraryScene, SceneFellow, SceneRoom } from '../api/types.ts'
import { RoomSvg } from '../components/library/RoomSvg.tsx'
import { RoomStrip } from '../components/library/RoomStrip.tsx'
import { FellowCard } from '../components/library/FellowCard.tsx'
import { FellowPopover } from '../components/library/FellowPopover.tsx'
import { SpawnForm } from '../components/library/SpawnForm.tsx'
import { Icon } from '../components/Icon.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { PageLink } from '../components/PageLink.tsx'
import { RecapFeed } from '../components/RecapFeed.tsx'
import { ShelfWindow } from '../components/library/ShelfWindow.tsx'
import { CommandCentre, type CcView, type RosterEntry } from '../components/library/CommandCentre.tsx'
import { ShelfPanel } from '../components/library/ShelfPanel.tsx'
import { ReadingList } from '../components/library/ReadingList.tsx'
import { NewDepartment } from '../components/library/NewDepartment.tsx'
import type { BoardId } from '../components/library/RoomSvg.tsx'
import type { ReadingTab } from '../lib/readingList.ts'
import { queryState } from '../components/QueryState.tsx'
import { logStore } from '../lib/logStore.ts'
import { domainColor } from '../lib/domains.ts'
import { orderedDomains, stepInOrder } from '../lib/library/shelfOrder.ts'
import { navigate } from '../lib/router.ts'
import { buildActors, exitOk, floorLine, roleOfRun, ROLE_NAME, EXIT_MS, type Actor, type Exit } from '../lib/library/scene.ts'
import { planCorner } from '../lib/library/planCorner.ts'
import { FiveHourRelease } from '../components/library/FiveHourRelease.tsx'
import { PlanCard } from '../components/PlanCard.tsx'
import { signText } from '../lib/library/room.ts'
import { roomToFollow } from '../lib/library/follow.ts'

const CANVAS_W = 1128
const CANVAS_H = 700

type Mode = 'full' | 'focus'

/*
 * The board on the wall is "Last night": the headline's own button already says "Night shift",
 * and that one means TONIGHT - which Fellows run, in what order, at what cost. This is the
 * other direction in time, the report of what the shift did. Home has no such neighbour, so
 * the same feed is "Night shift" there.
 */
const BOARD_TITLES: Record<BoardId, string> = { hot: 'Hot cache', recap: 'Last night', reading: 'Reading list' }
/* Empty is a value here: the night shift board carries a date stepper in this slot, and a
   line about where else the feed appears described a screen you are not looking at. */
const BOARD_SUBS: Record<BoardId, string> = {
  hot: "the vault's digest, refreshed after every run",
  recap: '',
  reading: 'what the Fellows read on the web; ingesting one is your call',
}

export function LibraryScreen({
  vaultName,
  agentParam,
  roomParam,
  active = true,
  spawnParam = '',
  ccParam = '',
  shelfParam = '',
  paneParam = '',
  pageParam = '',
  boardParam = '',
}: {
  vaultName: string
  agentParam: string
  roomParam: string
  /** Whether the Library tab is the one showing; the screen stays mounted either way. */
  active?: boolean
  spawnParam?: string
  shelfParam?: string
  ccParam?: string
  paneParam?: string
  pageParam?: string
  boardParam?: string
}): React.ReactElement {
  const qc = useQueryClient()
  const scene = useQuery({ queryKey: ['library-scene'], queryFn: api.libraryScene, refetchInterval: 5_000 })
  const runsQ = useQuery({ queryKey: ['maintenance-runs'], queryFn: api.maintenanceRuns, staleTime: 5_000 })
  // The plan's research share for the now chip and the spawn projection (A5); the endpoint is cached server-side.
  /*
   * The plan numbers (section 8.3). Polled only while this tab is in front - the screen stays
   * mounted behind the others, and a minute timer on a hidden screen buys nothing. The
   * endpoint caches for three minutes anyway, so a faster poll would re-serve the same figure.
   */
  const plan = useQuery({ queryKey: ['usage-plan'], queryFn: api.usagePlan, refetchInterval: active ? 60_000 : false, refetchOnWindowFocus: true, retry: false })
  /**
   * The decisions the newest recap is still waiting for, across every Fellow in it. The recap
   * is the surface where they are made, so the button counts them and opens that board.
   */
  /*
   * Counted from the LIVE Fellows, not from the recap.
   *
   * The recap is a snapshot built once a night; the decisions are made in the command centre,
   * which invalidates `agents` and had no reason to invalidate `recaps`. So the count sat at
   * its old value until some unrelated mount happened to refetch the recap - "many seconds",
   * with no fixed length, and disagreeing all the while with the per-shelf pill beside it,
   * which reads the live number. One number, one source.
   */
  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: api.agents, refetchInterval: 20_000 })
  const openDecisions = useMemo(
    () => (agentsQ.data?.fellows ?? []).reduce((n, f) => n + f.undecidedProposals, 0),
    [agentsQ.data],
  )
  // Focus is the resting state; a department and a Fellow card both live in the column, so a
  // deep link into either opens in full, the same as a click on the shelf or the figure does.
  const [mode, setMode] = useState<Mode>(shelfParam !== '' || agentParam !== '' ? 'full' : 'focus')
  const [room, setRoom] = useState<string>(roomParam !== '' ? roomParam : 'main')
  const [spawnOpen, setSpawnOpen] = useState(spawnParam !== '')
  /*
   * The Fellow command centre (TASKS-A7), opened by "Night shift" or `?cc=1`. Its shelf
   * rotation lives here rather than in the window, because the name it rotates through stands
   * in the HEADLINE - the same two-line shape a department gets, where the middle zone says
   * where you are and the window below it says what is there.
   */
  /*
   * Walking the nights, from the headline (2026-09-14). The board used to carry a week of days
   * in its own rail; a report is read one night at a time, so the stepper moved up beside the
   * title, where Home already keeps it. Null is the newest night, which is what "Last night"
   * means - not a date that goes stale the moment a new recap is built.
   */
  const [recapDay, setRecapDay] = useState<string | null>(null)
  const [ccOpen, setCcOpen] = useState(ccParam !== '')
  const [ccStop, setCcStop] = useState(0)
  /*
   * `?cc=<id>` names a Fellow and opens on its dossier. That is the return ticket a page
   * opened from a dossier leaves behind: Escape on the page goes to the last non-page route,
   * and this is what that route was replaced with.
   */
  const ccFellowIdParam = /^[0-9a-f-]{36}$/.test(ccParam) ? ccParam : ''
  const [ccView, setCcView] = useState<CcView>(ccFellowIdParam === '' ? 'shelves' : 'dossier')
  /* Reported up by the window: the headline names the shelf, the window knows which they are. */
  const [ccShelves, setCcShelves] = useState<readonly string[]>([])
  /** The roster, in the order the dossier's arrows walk it. Reported up for the same reason. */
  const [ccRoster, setCcRoster] = useState<readonly RosterEntry[]>([])
  const [ccFellowId, setCcFellowId] = useState<string | null>(ccFellowIdParam === '' ? null : ccFellowIdParam)
  /*
   * Only the dossier is a Fellow. `ccFellowId` outlives it - Escape steps back to the shelf
   * and leaves it set, so that the arrows and a later reopen land where you were - and reading
   * it in the shelf view would put a Fellow's name over a shelf's page.
   */
  const ccFellow = ccView === 'dossier' ? (ccRoster.find((r) => r.id === ccFellowId) ?? null) : null
  const ccShelf = ccView === 'shelves' ? null : (ccFellow?.domain ?? ccShelves[ccStop] ?? null)
  const [popover, setPopover] = useState<{ fellow: SceneFellow; x: number; y: number } | null>(null)
  /**
   * Which of the reading list's two lists is open. It lives here rather than in the board,
   * because its toggle stands in the headline where the mode toggle otherwise does - one slot,
   * whatever is relevant to what you have open.
   */
  const [readingTab, setReadingTab] = useState<ReadingTab>('current')
  /** Every visit opens on the newest night, whatever night the last visit ended on. */
  const openBoard = (id: BoardId): void => {
    setRecapDay(null)
    setBoard(id)
  }
  /** A board on the main room's wall, opened as a window over the room. Escape closes it. */
  const [board, setBoard] = useState<BoardId | null>(boardParam === 'hot' || boardParam === 'recap' || boardParam === 'reading' ? boardParam : null)
  /** A department opened over the room: its graph and its catalog, filtered (section 10.5). */
  const [shelf, setShelf] = useState<string | null>(shelfParam !== '' ? shelfParam : null)
  /** A free slot clicked in the room: the form for the department that would stand there. */
  const [newSlot, setNewSlot] = useState<number | null>(null)
  /** A page read inside the shelf window: the third level, closed by the first Escape. */
  const [shelfPage, setShelfPage] = useState<string | null>(pageParam !== '' ? pageParam : null)
  /** Which of the department's two views shows; the headline switches it. */
  const [shelfPane, setShelfPane] = useState<'graph' | 'catalog'>(paneParam === 'catalog' ? 'catalog' : 'graph')
  /** What the open department holds, for the line between the two controls. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [tick, setTick] = useState(0)
  const [exits, setExits] = useState<Exit[]>([])
  const seen = useRef<Map<string, { name: string; role: Actor['role']; agentId?: string }>>(new Map())
  const [drag, setDrag] = useState<{ domain: string; x: number; y: number; target: string | null; slot: number | null } | null>(null)
  const areaRef = useRef<HTMLDivElement>(null)

  /**
   * Leaving the tab closes the room's windows. The screen stays mounted while another tab
   * shows (it polls the scene), so a board or a department window left open was still there
   * on the way back - the Library reopened on whatever had been in front of the room rather
   * than on the room. Coming back is the main room in focus, the resting state of 10.7.
   */
  useEffect(() => {
    if (active) return
    setBoard(null)
    setShelf(null)
    setShelfPage(null)
    setNewSlot(null)
    setRenaming(null)
    setSpawnOpen(false)
    setPopover(null)
    setRoom('main')
    setMode('focus')
  }, [active])

  // Deep links: the room, the card and the spawn form follow the URL.
  useEffect(() => {
    if (roomParam !== '') setRoom(roomParam)
  }, [roomParam])
  useEffect(() => {
    if (spawnParam !== '') setSpawnOpen(true)
  }, [spawnParam])
  /*
   * The centre follows the URL too. It has to be an effect and not just initial state: the
   * screen stays mounted while you are on a page, so coming back from one never remounts it.
   */
  useEffect(() => {
    if (ccParam === '') return
    setCcOpen(true)
    /*
     * And close whatever window stands in front of it. A board opened from the wall is state,
     * not a URL, so `?cc=1` used to leave it up: the headline changed to the centre's and the
     * board went on covering it, which read as a dead link ("Spawn a Fellow" from the night
     * shift board did exactly this).
     */
    setBoard(null)
    if (ccFellowIdParam !== '') {
      setCcFellowId(ccFellowIdParam)
      setCcView('dossier')
    } else {
      /*
       * `?cc=1` names the overview. The view is state that outlives a visit - Escape steps
       * back and leaves the last dossier in place, so the arrows land where you were - and
       * without this reset a link to the overview reopened the centre on that dossier: from
       * Home's "Spawn a Fellow", on a retired Fellow's notice instead of the shelves.
       */
      setCcView('shelves')
    }
  }, [ccParam, ccFellowIdParam])
  useEffect(() => {
    if (shelfParam !== '') setShelf(shelfParam)
  }, [shelfParam])
  useEffect(() => {
    if (agentParam !== '') setMode('full')
  }, [agentParam])

  // Live log lines change poses without a new snapshot: re-render on a line of any channel in play.
  const channels = useMemo(() => {
    const s = scene.data
    if (!s) return ''
    const set = new Set<string>()
    for (const f of s.fellows) if (f.run) set.add(f.run.channel)
    for (const r of s.runs) set.add(r.channel)
    for (const j of s.jobs) set.add(j.id)
    return [...set].sort().join('\n')
  }, [scene.data])
  useEffect(() => {
    if (channels === '') return
    const unsubscribes = channels.split('\n').map((ch) => logStore.subscribe(ch, () => setTick((t) => t + 1)))
    return () => {
      for (const u of unsubscribes) u()
    }
  }, [channels])
  // Exits fade on their own clock.
  useEffect(() => {
    if (exits.length === 0) return
    const timer = setTimeout(() => setExits((xs) => xs.filter((x) => Date.now() - x.at < EXIT_MS)), EXIT_MS + 100)
    return () => clearTimeout(timer)
  }, [exits])

  // A run or job that vanished from the snapshot settled: remember it for its exit pose.
  useEffect(() => {
    const s = scene.data
    if (!s) return
    const live = new Map<string, { name: string; role: Actor['role']; agentId?: string }>()
    for (const f of s.fellows) if (f.run) live.set(f.run.id, { name: f.name, role: 'fellow', agentId: f.agentId })
    /*
     * The role the run actually draws, and that role's noun as the name. Every maintenance run
     * used to be remembered as a RESEARCHER called after its own kind, so a finished backfill
     * left behind a half-faded researcher whose bubble read "domain-backfill" - a figure that
     * was never in the room, wearing an identifier no reader has seen before.
     */
    for (const r of s.runs) {
      const role = roleOfRun(r.kind) ?? 'researcher'
      live.set(r.id, { name: ROLE_NAME[role], role })
    }
    for (const j of s.jobs) if (j.status !== 'queued') live.set(j.id, { name: j.name, role: 'clerk' })
    const gone: Exit[] = []
    for (const [id, who] of seen.current) {
      if (live.has(id)) continue
      const ok = exitOk(runsQ.data?.runs.find((r) => r.id === id))
      gone.push({ id, kind: who.role === 'clerk' ? 'job' : 'run', ok, name: who.name, role: who.role, at: Date.now(), ...(who.agentId ? { agentId: who.agentId } : {}) })
    }
    seen.current = live
    if (gone.length > 0) {
      setExits((xs) => [...xs, ...gone])
      // A run that just settled is the one event that certainly moved the plan windows; the
      // poll would otherwise show the old figure for up to a minute (section 8.3). The run
      // list is refetched for the same reason: it is the record every other screen reads the
      // outcome from, and it is the one this handler just found to be out of date.
      void qc.invalidateQueries({ queryKey: ['usage-plan'] })
      void qc.invalidateQueries({ queryKey: ['maintenance-runs'] })
    }
  }, [scene.data, runsQ.data, qc])

  const actors = useMemo(() => {
    void tick
    if (!scene.data) return []
    return buildActors({
      scene: scene.data,
      lines: (channel) => logStore.snapshot(channel),
      exits,
      now: Date.now(),
    })
  }, [scene.data, exits, tick])

  /*
   * Memoised on the scene, like `shelfOrder` below and for the same reason: the `?? []`
   * fallback is a fresh array on every render while the scene is still loading, and the
   * room-paging callback depends on this list.
   */
  const rooms: readonly SceneRoom[] = useMemo(() => scene.data?.rooms ?? [], [scene.data])
  const departments = scene.data?.departments ?? []
  /**
   * The shelves in the order they stand in - what up and down walk along. Keyed on the scene
   * itself: `rooms` and `departments` are fresh arrays on every render, so memoising on them
   * would resubscribe the key listener each time.
   */
  const shelfOrder = useMemo(() => orderedDomains(scene.data?.rooms ?? [], scene.data?.departments ?? []), [scene.data])
  const current = rooms.find((r) => r.id === room) ?? rooms[0]
  const activityRooms = useMemo(() => new Set(actors.filter((a) => !a.exiting && a.pose !== 'sleep' && a.pose !== 'sit').map((a) => a.room)), [actors])
  const night = scene.data?.night ?? false

  // Focus mode follows the Fellow at work - once per move, not on every render. Followed on
  // every render it also followed you back: a step to the main room while a Fellow stood at a
  // shelf in a wing was undone immediately, and you were stuck there until its run ended.
  const followed = useRef<string | null>(null)
  useEffect(() => {
    if (mode !== 'focus') return
    const active = actors.find((a) => a.role === 'fellow' && (a.pose === 'shelf' || a.pose === 'desk' || a.pose === 'shelve'))
    const next = roomToFollow(active?.room ?? null, room, { followed: followed.current })
    if (active) followed.current = active.room
    if (next !== null) setRoom(next)
  }, [mode, actors, room])

  const pickRoom = useCallback(
    (id: string): void => {
      setRoom(id)
      const q = new URLSearchParams(window.location.search)
      q.set('room', id)
      navigate(`/library?${q.toString()}`, { replace: true })
    },
    [],
  )
  const openCard = useCallback((agentId: string): void => {
    const q = new URLSearchParams(window.location.search)
    q.set('agent', agentId)
    navigate(`/library?${q.toString()}`)
    setPopover(null)
    setMode('full')
  }, [])
  const closeCard = (): void => {
    const q = new URLSearchParams(window.location.search)
    q.delete('agent')
    const rest = q.toString()
    navigate(rest === '' ? '/library' : `/library?${rest}`, { replace: true })
  }

  /*
   * Paging: wheel and arrow keys inside the canvas. It wraps - scrolling past the last room
   * arrives back at the main one - because the rooms are a ring, which is how the passage in
   * the back wall already walks them and what the sign over it promises. Clamping instead made
   * the last room a wall you could scroll against with nothing happening.
   */
  const page = useCallback(
    (delta: number): void => {
      if (!current) return
      const next = stepInOrder(rooms.map((r) => r.id), current.id, delta)
      if (next !== null && next !== current.id) pickRoom(next)
    },
    [rooms, current, pickRoom],
  )
  const recapsQ = useQuery({ queryKey: ['recaps'], queryFn: api.recaps, enabled: board === 'recap', staleTime: 30_000 })
  /** Newest first: the order the arrows walk. */
  const nights = useMemo(
    () => [...(recapsQ.data?.recaps ?? [])].map((r) => r.cycleDate).sort((a, b) => b.localeCompare(a)),
    [recapsQ.data],
  )
  const shownNight = recapDay ?? nights[0] ?? null
  const olderNight = shownNight === null ? undefined : nights.find((d) => d < shownNight)
  const newerNight = shownNight === null ? undefined : [...nights].reverse().find((d) => d > shownNight)
  /** Left is back in time, right is forward, and forward is dead until you have gone back. */
  const stepNight = useCallback(
    (toward: 'older' | 'newer'): void => {
      const next = toward === 'older' ? nights.find((d) => d < (recapDay ?? nights[0] ?? '')) : [...nights].reverse().find((d) => d > (recapDay ?? nights[0] ?? ''))
      if (next !== undefined) setRecapDay(next)
    },
    [nights, recapDay],
  )

  const windowOpen = shelf !== null || board !== null || ccOpen
  /*
   * The centre is somewhere you went, not a setting. Leaving the Library for another screen
   * and coming back should put you in the room, the way closing it does.
   */
  useEffect(() => {
    if (!active) setCcOpen(false)
  }, [active])
  useEffect(() => {
    const el = areaRef.current
    if (!el || windowOpen) return
    let last = 0
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) < 20) return
      const now = Date.now()
      if (now - last < 450) return
      last = now
      e.preventDefault()
      page(e.deltaY > 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [page, windowOpen])
  const onKey = (e: KeyboardEvent): void => {
    /*
     * The night shift board is the one window that wants the arrows: left walks back through
     * the nights, right forward, the same keys and the same direction as Home's date. Checked
     * before the guard below, which otherwise hands every key but Escape to the room.
     */
    if (board === 'recap' && !ccOpen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      stepNight(e.key === 'ArrowLeft' ? 'older' : 'newer')
      return
    }
    // Inside a window the arrows belong to it too; only Escape still reaches the room.
    if (windowOpen && e.key !== 'Escape') return
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault()
      page(1)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault()
      page(-1)
    } else if (e.key === 'Escape') {
      setPopover(null)
      if (renaming !== null) setRenaming(null)
      else if (newSlot !== null) setNewSlot(null)
      else if (shelfPage !== null) setShelfPage(null)
      else if (shelf !== null) closeShelf()
      else if (board !== null) setBoard(null)
      // The last step out: a wing is somewhere you walked to, so Escape walks back. Without
      // it the key stopped working the moment the department window closed, leaving you in
      // a side room with the one key that means "out of here" doing nothing.
      else if (current !== undefined && current.kind !== 'main') {
        const main = rooms.find((r) => r.kind === 'main')
        if (main) pickRoom(main.id)
      }
    }
  }
  /*
   * The keys, for the screen in front, wherever the focus is. They hung on the room's own
   * element, which nothing focused: arriving from Home with a shelf already open, Escape did
   * nothing until the room was clicked. Fields keep their keys, except that Escape still
   * reaches a rename in progress; the command centre owns every key while it is open.
   */
  useEffect(() => {
    if (!active || ccOpen) return
    const handler = (e: KeyboardEvent): void => {
      const t = e.target
      const inField = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)
      if (inField && !(e.key === 'Escape' && renaming !== null)) return
      onKey(e)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  /**
   * Left and right switch a department's two views. They are two sides of one thing - the same
   * pages as a map and as a list - and reaching for the toggle to compare them costs more than
   * the comparison. They work while a page is being read too, and switching then closes it:
   * the other view is a view of the department, not of the page, so arriving there with the
   * article still over it would be the wrong place. Never while the caret sits in a field,
   * where the arrows move the text.
   */
  useEffect(() => {
    if (!active || shelf === null) return
    const onArrow = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const el = e.target
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return
      e.preventDefault()
      setShelfPage(null)
      setShelfPane((p) => (p === 'graph' ? 'catalog' : 'graph'))
    }
    window.addEventListener('keydown', onArrow)
    return () => window.removeEventListener('keydown', onArrow)
  }, [active, shelf])

  /**
   * Up and down walk to the next department, in the order the shelves stand in - the same
   * order the column lists and the back wall shows, so the arrow moves to the shelf beside
   * this one rather than to an alphabetical neighbour nobody can see. It wraps at both ends,
   * and it closes an open page: you are leaving the department the page belongs to.
   */
  useEffect(() => {
    if (!active || shelf === null) return
    const onArrow = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const el = e.target
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return
      const next = stepInOrder(shelfOrder, shelf, e.key === 'ArrowDown' ? 1 : -1)
      if (next === null) return
      e.preventDefault()
      setShelfPage(null)
      setShelf(next)
    }
    window.addEventListener('keydown', onArrow)
    return () => window.removeEventListener('keydown', onArrow)
  }, [active, shelf, shelfOrder])

  // Wings and moves.
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['library-scene'] })
    void qc.invalidateQueries({ queryKey: ['wings'] })
  }
  const move = useMutation({ mutationFn: (body: { domain: string; room: string; slot?: number }) => api.moveShelf(body), onSuccess: invalidate })
  const createWing = useMutation({ mutationFn: () => api.createWing(), onSuccess: (r) => {
    invalidate()
    pickRoom(r.wing.id)
  } })
  const renameWing = useMutation({ mutationFn: (b: { id: string; name: string }) => api.renameWing(b.id, b.name), onSuccess: invalidate })
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.reorderWings(ids), onSuccess: invalidate })
  const moveAisle = useMutation({
    mutationFn: (b: { id: string; row: 'wall' | 'mid'; at: number }) => api.moveAisle(b.id, b.row, b.at),
    onSuccess: invalidate,
  })
  const deleteWing = useMutation({ mutationFn: (id: string) => api.deleteWing(id), onSuccess: () => {
    invalidate()
    pickRoom('main')
  } })
  const pauseFellow = useMutation({ mutationFn: (f: SceneFellow) => api.agentAction(f.agentId, f.state === 'paused' ? 'resume' : 'pause'), onSuccess: () => {
    void qc.invalidateQueries({ queryKey: ['library-scene'] })
    void qc.invalidateQueries({ queryKey: ['agents'] })
    setPopover(null)
  } })

  // Drag a shelf with the pointer: onto a room pill or list row, or onto another slot to swap.
  const onShelfPointerDown = (domain: string, e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    let started = false
    const onMove = (ev: PointerEvent): void => {
      if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return
      started = true
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const roomEl = el?.closest<HTMLElement>('[data-room]')
      const slotEl = el?.closest<SVGElement>('.lib-slot')
      const raw = slotEl?.getAttribute('data-slot')
      const slot = raw !== null && raw !== undefined && raw !== '' ? Number(raw) : NaN
      setDrag({ domain, x: ev.clientX, y: ev.clientY, target: roomEl?.dataset['room'] ?? null, slot: Number.isFinite(slot) ? slot : null })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDrag((d) => {
        if (d && started) {
          if (d.target !== null) move.mutate({ domain: d.domain, room: d.target })
          else if (d.slot !== null && current) move.mutate({ domain: d.domain, room: current.id, slot: d.slot })
        }
        return null
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /**
   * Dragging a gap along its row (2026-09-14). The same gesture the shelves have, with one
   * difference: a gap has no owner to move, so what travels is a position. The drop is read
   * from the element under the pointer, which is why the room draws a target over every other
   * position of the row while one is in hand.
   */
  const [aisleDrag, setAisleDrag] = useState<{ row: 'wall' | 'mid'; at: number } | null>(null)
  const onAislePointerDown = (row: 'wall' | 'mid', at: number, e: React.PointerEvent): void => {
    if (e.button !== 0 || current === undefined || current.kind !== 'wing') return
    e.stopPropagation()
    const wing = current.id
    const startX = e.clientX
    const startY = e.clientY
    let started = false
    let target: number | null = null
    const onMove = (ev: PointerEvent): void => {
      if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return
      if (!started) setAisleDrag({ row, at })
      started = true
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const raw = el?.closest<SVGElement>('[data-aisle-target]')?.getAttribute('data-aisle-target')
      target = raw !== null && raw !== undefined && raw !== '' ? Number(raw) : null
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setAisleDrag(null)
      if (started && target !== null && target !== at) moveAisle.mutate({ id: wing, row, at: target })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** A department opens with the column beside it; leaving one returns to the room, in focus. */
  const openShelf = (domain: string): void => {
    setShelf(domain)
    setMode('full')
  }
  const closeShelf = (): void => {
    setShelfPage(null)
    setShelf(null)
    setMode('focus')
  }

  /** The passage in the back wall: on to the next room, wrapping back to the main one. */
  const nextRoom = (): void => {
    if (rooms.length < 2 || !current) return
    const at = rooms.findIndex((r) => r.id === current.id)
    const next = rooms[(at + 1) % rooms.length]
    if (next) pickRoom(next.id)
  }

  const onActorClick = (a: Actor, e: React.MouseEvent): void => {
    if (!a.agentId || !scene.data) return
    const fellow = scene.data.fellows.find((f) => f.agentId === a.agentId)
    if (!fellow) return
    if (mode === 'focus') {
      const rect = areaRef.current?.getBoundingClientRect()
      setPopover({ fellow, x: e.clientX - (rect?.left ?? 0) + 16, y: e.clientY - (rect?.top ?? 0) - 40 })
    } else openCard(a.agentId)
  }

  /*
   * A board is read, not worked in: it opens over the room and fills the frame, and the control
   * column beside it belongs to a room you cannot see. So the three boards are always a focus
   * view whatever the toggle says - and the toggle goes with them, because a control that does
   * nothing is worse than no control. The user's own choice is remembered and comes back when
   * the board closes.
   */
  const boardOpen = board !== null && shelf === null
  const view: Mode = boardOpen ? 'focus' : mode

  const state = queryState(scene, 'the library')
  const clock = new Date()
  const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`
  const byRoom = (id: string): typeof departments => departments.filter((d) => d.room === id).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  const s: LibraryScene | undefined = scene.data

  return (
    <div className={`workspace lib-workspace${view === 'focus' ? ' focus' : ''}`}>
      {view === 'full' && shelf !== null && (
        <aside className="gpanel" aria-label={`${signText(shelf)} department`}>
          <ShelfPanel
            domain={shelf}
            rooms={rooms}
            departments={departments}
            onPick={(d) => {
              setShelfPage(null)
              setShelf(d)
            }}
            onOpenPage={setShelfPage}
            onOpenFellow={openCard}
          />
        </aside>
      )}
      {view === 'full' && shelf === null && (
        <aside className="gpanel" aria-label="Library controls">
          {/*
           * The room list used to stand here as well, repeating the strip in the headline; the
           * strip is the navigation now, and a wing is renamed on its own banner. What is left
           * is what the room cannot show at a glance: which department stands where, and who
           * works on what.
           */}
          <div className="gp-sec grow">
            <div className="gp-head">
              <span className="gp-eyebrow">Departments</span>
              <span className="spacer" />
              <span className="mono-meta">drag onto a room</span>
            </div>
            <div className="lib-deps">
              {rooms.map((r) => (
                <div key={r.id}>
                  <div className="lib-grp">{r.name}</div>
                  {byRoom(r.id).map((d) => (
                    <button
                      key={d.domain}
                      className="lib-drow"
                      data-domain={d.domain}
                      title={`${signText(d.domain)} stands in ${r.name}`}
                      onPointerDown={(e) => onShelfPointerDown(d.domain, e)}
                      onClick={() => {
                        if (!drag) pickRoom(r.id)
                      }}
                    >
                      <span className="dot" style={{ background: domainColor(d.domain) }} aria-hidden />
                      <span className="nm">{signText(d.domain)}</span>
                      <span className="n">{d.books + d.volumes}</span>
                    </button>
                  ))}
                </div>
              ))}
              {s && s.unfiled > 0 && <p className="mono-meta">{s.unfiled} unfiled page(s) on the intake cart.</p>}
            </div>
          </div>
          <div className="gp-sec">
            <div className="gp-head">
              <span className="gp-eyebrow">Fellows</span>
              <span className="spacer" />
              <span className="mono-meta">{s ? `${s.fellows.filter((f) => f.run).length} at work` : ''}</span>
            </div>
            {s && s.fellows.filter((f) => f.state !== 'retired').length === 0 && <p className="mono-meta">No Fellows yet. The existing runs still show up on the floor.</p>}
            {(s?.fellows ?? [])
              .filter((f) => f.state !== 'retired')
              .map((f) => (
                <button key={f.agentId} className={`lib-frow${agentParam === f.agentId ? ' sel' : ''}`} onClick={() => openCard(f.agentId)}>
                  <span className="d" style={{ background: domainColor(f.homeDomain) }} aria-hidden />
                  <span className="who">
                    <b>{f.name}</b>
                    <span className="st">{f.run ? (f.run.kind === 'plan' ? 'planning' : f.run.label ?? f.run.kind) : f.sleepReason ?? f.state}</span>
                  </span>
                  <span className="mono-meta">{f.homeDomain.split('-')[0]}</span>
                </button>
              ))}
            {/* Spawning is one button in the headline; the form opens here under the Fellows. */}
            {spawnOpen && (
              <SpawnForm
                plan={plan.data}
                onDone={(id) => {
                  setSpawnOpen(false)
                  openCard(id)
                }}
                onCancel={() => setSpawnOpen(false)}
              />
            )}
          </div>
        </aside>
      )}

      <div className="box lib-box">
        {/*
         * One headline for every state, three zones that never trade places: the mode toggle
         * on the left, where you are in the middle, the one thing you can do here on the
         * right. Escape and the arrow keys do the rest, so no button repeats a key.
         */}
        <div className={`graph-controls lib-headline${ccOpen ? ' cc' : ''}`}>
          <div className="lib-head-left">
            {/*
             * One slot, whatever stands in it. The room's toggle when a room is what you are
             * looking at; the reading list's own two lists when that board is open, because
             * they are the choice that matters there; nothing for the other two boards.
             */}
            {/* The command centre always opens in focus: the room behind it is not what you
                are looking at, so there is no mode to choose while it is open. */}
            {ccOpen ? null : board === 'reading' && shelf === null ? (
              <div className="seg sm ink" role="radiogroup" aria-label="Reading list">
                <button role="radio" aria-checked={readingTab === 'current'} onClick={() => setReadingTab('current')}>
                  Current
                </button>
                <button role="radio" aria-checked={readingTab === 'archived'} onClick={() => setReadingTab('archived')}>
                  Archived
                </button>
              </div>
            ) : boardOpen ? null : (
              <div className="seg sm ink" role="radiogroup" aria-label="Mode">
                <button role="radio" aria-checked={mode === 'focus'} onClick={() => setMode('focus')}>
                  Focus
                </button>
                <button role="radio" aria-checked={mode === 'full'} onClick={() => setMode('full')}>
                  Full
                </button>
              </div>
            )}
          </div>
          <div className="lib-head-mid">
            {ccOpen && (
              /* Just where you are. Escape steps back, the dots jump, and the shelves view is
                 the map - so the name needs no arrows around it. */
              <span className="lib-open cc-rot">
                {/* Dot, name, dots: the same three slots at every stop, and the name's slot is
                    wide enough for the longest domain, so walking the ring moves nothing but
                    the letters. The overview takes the accent for its dot because it is not a
                    domain and has no colour of its own. */}
                <span
                  className="chip-dot"
                  style={{ background: ccShelf === null ? 'var(--accent)' : domainColor(ccShelf) }}
                  aria-hidden
                />
                <b className={`cc-name${ccShelf === null ? ' dim' : ''}`}>
                  {ccShelf === null ? 'Night shift' : ccFellow === null ? signText(ccShelf) : ccFellow.name}
                  {ccShelf !== null && ccFellow !== null && <span className="cc-of">({signText(ccShelf)})</span>}
                </b>
                {/*
                  * One dot per stop of the ring you are ON, and the dossier is a different
                  * ring: there the arrows walk the Fellows, so three dots for two Fellows was
                  * the shelves' ring drawn over a view that never visits it.
                  */}
                {/*
                  * A ring of one gets no dots. With every Fellow retired the only stop is the
                  * overview, and a lone dot reads as an invitation to walk somewhere.
                  */}
                <span className="cc-dots" hidden={ccView === 'dossier' ? ccRoster.length < 2 : ccShelves.length === 0}>
                  {ccView === 'dossier' ? (
                    ccRoster.map((r) => (
                      <i
                        key={r.id}
                        className={r.id === ccFellowId ? 'on' : ''}
                        title={`${r.name} (${signText(r.domain)})`}
                        onClick={() => setCcFellowId(r.id)}
                      />
                    ))
                  ) : (
                    <>
                      {/* The overview is a stop like any shelf, so it gets the same dot: a
                          different shape there read as a control rather than as a place. */}
                      <i
                        className={ccView === 'shelves' ? 'on' : ''}
                        title="Overview: every shelf"
                        onClick={() => setCcView('shelves')}
                      />
                      {ccShelves.map((key, i) => (
                        <i
                          key={key}
                          className={ccView !== 'shelves' && i === ccStop ? 'on' : ''}
                          title={key}
                          onClick={() => { setCcStop(i); setCcView('tonight') }}
                        />
                      ))}
                    </>
                  )}
                </span>
              </span>
            )}
            {!ccOpen && shelf === null && board === null && rooms.length > 0 && current && (
              <RoomStrip
                rooms={rooms}
                current={current.id}
                activity={activityRooms}
                night={false}
                dropTarget={drag?.target ?? null}
                onPick={pickRoom}
                onReorder={(ids) => reorder.mutate(ids)}
                onDelete={(id) => deleteWing.mutate(id)}
                {...(createWing.isPending ? {} : { onNewWing: () => createWing.mutate() })}
              />
            )}
            {!ccOpen && shelf === null && board !== null && (
              <span className={`lib-open${board === 'recap' ? ' home-where' : ''}`}>
                {board === 'recap' ? (
                  <>
                    {/* The same two arrows Home puts beside its date, and the same keys. The
                        title stays "Last night" while you are on the newest one, because that
                        is what it is; step back and it names the night you are reading. */}
                    <button
                      className="wh-step prev"
                      aria-label="The night before"
                      title="The night before this one · ←"
                      disabled={olderNight === undefined}
                      onClick={() => stepNight('older')}
                    >
                      <Icon name="chevron" />
                    </button>
                    <b>{shownNight === null || shownNight === nights[0] ? 'Last night' : fmtDay(shownNight)}</b>
                    <button
                      className="wh-step next"
                      aria-label="The night after"
                      title="The night after this one · →"
                      disabled={newerNight === undefined}
                      onClick={() => stepNight('newer')}
                    >
                      <Icon name="chevron" />
                    </button>
                  </>
                ) : (
                  <>
                    <b>{BOARD_TITLES[board]}</b>
                    {BOARD_SUBS[board] !== '' && <span className="box-sub">{BOARD_SUBS[board]}</span>}
                  </>
                )}
              </span>
            )}
            {!ccOpen && shelf !== null && (
              <span className="lib-open">
                <span className="chip-dot" style={{ background: domainColor(shelf) }} aria-hidden />
                {shelfPage === null ? (
                  /* The name alone: pages and links sit one row down, beside the filters that
                     change them, where a number that moves belongs. */
                  <b>{signText(shelf)}</b>
                ) : (
                  <>
                    {/* The path walks back, so a page needs no button of its own to leave by. */}
                    <button className="lib-crumb" onClick={() => setShelfPage(null)} title={`Back to the ${shelfPane} · Esc`}>
                      {signText(shelf)}
                    </button>
                    <span className="lib-sep" aria-hidden>
                      /
                    </span>
                    <span className="box-sub">{shelfPage.split('/').pop()?.replace(/\.md$/, '')}</span>
                  </>
                )}
              </span>
            )}
          </div>
          <div className="lib-head-right">
            {!ccOpen && shelf !== null && shelfPage === null && (
              /* Same width and same right edge as "Deepen this domain" in the band below:
                 the two controls of a department stand in one column. */
              <div className="seg sm ink shelf-view" role="tablist" aria-label="View">
                <button role="tab" aria-selected={shelfPane === 'graph'} onClick={() => setShelfPane('graph')}>
                  Graph
                </button>
                <button role="tab" aria-selected={shelfPane === 'catalog'} onClick={() => setShelfPane('catalog')}>
                  Catalog
                </button>
              </div>
            )}
            {/* One slot, two states. Outside the centre the door is "Night shift" and the
                count rides beside it; inside it, the door is gone and the count becomes the
                way to the decisions - there is no sense offering to open what is open. The
                door explains itself on hover: the word alone does not say that the Fellows,
                their decisions and their notebooks are behind it. */}
            {shelf === null && board === null && (
              ccOpen ? (
                <button
                  className={`btn sm lib-decisions${openDecisions > 0 ? ' due' : ''}`}
                  onClick={() => setCcView('decisions')}
                  title={openDecisions > 0 ? `${openDecisions} proposal(s) up for review` : 'Nothing is up for review'}
                >
                  Decisions
                  <span className="n">{openDecisions}</span>
                </button>
              ) : (
                <button
                  className={`btn primary sm lib-manage${openDecisions > 0 ? ' due' : ''}`}
                  onClick={() => { setCcView('shelves'); setCcOpen(true) }}
                  title={`Tonight's plan: which Fellows work, in what order and at what cost, with the ingest queue ahead of them. Their decisions, notebooks and settings live here too.${openDecisions > 0 ? ` ${openDecisions} proposal(s) up for review.` : ''}`}
                >
                  Night shift
                  {openDecisions > 0 && <span className="n">{openDecisions}</span>}
                </button>
              )
            )}
          </div>
        </div>
        <div className={`lib-area${night ? ' night' : ''}`} ref={areaRef} tabIndex={0}>
          {state ?? (current === undefined ? null : (
            <RoomSvg
              room={current}
              night={night}
              actors={actors}
              width={CANVAS_W}
              height={CANVAS_H}
              selectedAgentId={agentParam || null}
              draggingDomain={drag?.domain ?? null}
              dropSlot={drag && drag.target === null ? drag.slot : null}
              onShelfClick={(domain) => {
                if (!drag) openShelf(domain)
              }}
              onEmptySlotClick={(slot) => setNewSlot(slot)}
              {...(current.kind === 'wing' ? { onBannerClick: () => setRenaming({ id: current.id, name: current.name }) } : {})}
              onShelfPointerDown={onShelfPointerDown}
              onAislePointerDown={onAislePointerDown}
              draggingAisle={aisleDrag}
              onActorClick={onActorClick}
              onBoardClick={current.kind === 'main' ? openBoard : undefined}
              onPassageClick={rooms.length > 1 ? nextRoom : undefined}
              {...(rooms.length > 1 ? { nextRoomName: rooms[(rooms.findIndex((r) => r.id === current.id) + 1) % rooms.length]?.name } : {})}
              passageTitle={
                rooms.length > 1
                  ? `to ${rooms[(rooms.findIndex((r) => r.id === current.id) + 1) % rooms.length]?.name ?? 'the next room'}`
                  : 'the next room'
              }
              idp={`lib-${current.id.slice(0, 8)}`}
            />
          ))}

          {/* The Fellow command centre, over the room like a shelf window (TASKS-A7). Behind
              `?cc=1` while it runs on fixture data. */}
          {ccOpen && (
            <CommandCentre
              stop={ccStop}
              setStop={setCcStop}
              view={ccView}
              setView={setCcView}
              onClose={() => setCcOpen(false)}
              onShelves={setCcShelves}
              onRoster={setCcRoster}
              fellowId={ccFellowId}
              setFellowId={setCcFellowId}
            />
          )}

          {/* A department's window: its graph and its catalog, over the room (section 10.5). */}
          {shelf !== null && !ccOpen && (
            <ShelfWindow
              domain={shelf}
              vaultName={vaultName}
              pane={shelfPane}
              layoutKey={mode}
              page={shelfPage}
              onPage={setShelfPage}
            />
          )}

          {shelf === null && newSlot !== null && (
            <NewDepartment slot={newSlot} roomName={current?.name ?? 'the room'} onClose={() => setNewSlot(null)} />
          )}

          {/* The banner's rename, over the room: focus mode has no column to put it in. */}
          {renaming !== null && current?.id === renaming.id && (
            <form
              className="lib-rename"
              onSubmit={(e) => {
                e.preventDefault()
                const name = renaming.name.trim()
                if (name !== '') renameWing.mutate({ id: renaming.id, name })
                setRenaming(null)
              }}
            >
              <input
                className="input"
                aria-label="Wing name"
                value={renaming.name}
                maxLength={40}
                autoFocus
                onChange={(e) => setRenaming({ id: renaming.id, name: e.target.value })}
              />
              <button className="btn primary sm" type="submit">
                Rename
              </button>
              <button className="btn ghost sm" type="button" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </form>
          )}

          {/* A board's window: the same frame, the same size, so the screen does not move. */}
          {shelf === null && board !== null && (
            <div className="lib-window" role="dialog" aria-label={BOARD_TITLES[board]}>
              {board === 'hot' ? <HotCache vaultName={vaultName} /> : board === 'recap' ? <RecapFeed vaultName={vaultName} day={shownNight} /> : <ReadingList vaultName={vaultName} tab={readingTab} />}
            </div>
          )}
          {(() => {
            const corner = planCorner(plan.data, Date.now())
            if (corner === null) return null
            return (
              <div className="lib-corner br">
                {/* The release button stands beside the age; the card is the shared one. */}
                <PlanCard
                  corner={corner}
                  dark={night}
                  foot={
                    corner.release.enabled && (
                      <FiveHourRelease
                        release={corner.release}
                        fiveHourUsed={corner.lines.find((l) => l.window === 'five_hour')?.usedPct ?? null}
                        onDone={() => void qc.invalidateQueries({ queryKey: ['usage-plan'] })}
                      />
                    )
                  }
                />
              </div>
            )
          })()}
          {/* The clock and the floor. The week's research share used to trail it; the night
              shift's own line carries that number now, as a percent of the budget and with the
              setting behind it one click away. */}
          <div className="lib-corner bl">
            <span className={`chip${night ? ' dark' : ''}`}>
              <Icon name={night ? 'moon' : 'sun'} /> {hhmm} · {night ? 'night' : 'day'} · {floorLine(actors)}
            </span>
          </div>
          {popover && (
            <FellowPopover
              fellow={popover.fellow}
              x={popover.x}
              y={popover.y}
              roomName={current?.name ?? ''}
              onOpenCard={() => openCard(popover.fellow.agentId)}
              onPause={() => pauseFellow.mutate(popover.fellow)}
              onClose={() => setPopover(null)}
            />
          )}
          {drag && (
            <div className="lib-hint" style={{ left: drag.x - (areaRef.current?.getBoundingClientRect().left ?? 0) + 14, top: drag.y - (areaRef.current?.getBoundingClientRect().top ?? 0) + 14 }}>
              move {signText(drag.domain)} {drag.target !== null ? `to ${rooms.find((r) => r.id === drag.target)?.name ?? 'the room'}` : drag.slot !== null ? `to slot ${drag.slot + 1}` : '…'}
            </div>
          )}
          {move.error != null && <div className="toast err lib-toast">{(move.error as Error).message}</div>}
        </div>
      </div>

      {mode === 'full' && agentParam !== '' && <FellowCard agentId={agentParam} vaultName={vaultName} onClose={closeCard} />}
    </div>
  )
}

/** The vault's digest page, read straight from the vault (SPEC.md section 12.4). */
function HotCache({ vaultName }: { vaultName: string }): React.ReactElement {
  const page = useQuery({ queryKey: ['page', 'wiki/hot.md'], queryFn: () => api.pageFull('wiki/hot.md'), staleTime: 30_000 })
  const state = queryState(page, 'the hot cache')
  const body = page.data ? page.data.markdown.replace(/^---[\s\S]*?\n---\n/, '') : ''
  return (
    <div className="lib-window-body">
      {state ??
        (body.trim() === '' ? (
          <div className="empty">
            <h2>No hot cache yet</h2>
            <p className="qs-line">It is written after the first ingest and refreshed after every run.</p>
          </div>
        ) : (
          <article className="page-body">
            <Markdown source={body} />
            <p className="recap-foot">
              Vault page: <PageLink vaultName={vaultName} path="wiki/hot.md" />
            </p>
          </article>
        ))}
    </div>
  )
}
