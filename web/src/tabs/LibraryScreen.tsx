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
import { ShelfPanel } from '../components/library/ShelfPanel.tsx'
import { ReadingList } from '../components/library/ReadingList.tsx'
import { NewDepartment } from '../components/library/NewDepartment.tsx'
import type { BoardId } from '../components/library/RoomSvg.tsx'
import { queryState } from '../components/QueryState.tsx'
import { logStore } from '../lib/logStore.ts'
import { domainColor } from '../lib/domains.ts'
import { orderedDomains, stepInOrder } from '../lib/library/shelfOrder.ts'
import { navigate } from '../lib/router.ts'
import { buildActors, floorLine, roleOfRun, ROLE_NAME, EXIT_MS, type Actor, type Exit } from '../lib/library/scene.ts'
import { shareLine } from '../lib/plan.ts'
import { planCorner } from '../lib/library/planCorner.ts'
import { signText } from '../lib/library/room.ts'
import { undecidedCount } from '../lib/recap.ts'
import { roomToFollow } from '../lib/library/follow.ts'

const CANVAS_W = 1128
const CANVAS_H = 700

type Mode = 'full' | 'focus'

const BOARD_TITLES: Record<BoardId, string> = { hot: 'Hot cache', recap: 'Daily recap', reading: 'Reading list' }
const BOARD_SUBS: Record<BoardId, string> = {
  hot: "the vault's digest, refreshed after every run",
  recap: 'the same view Home opens on',
  reading: 'what the Fellows read on the web; ingesting one is your call',
}

export function LibraryScreen({
  vaultName,
  agentParam,
  roomParam,
  active = true,
  spawnParam = '',
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
  const recaps = useQuery({ queryKey: ['recaps'], queryFn: api.recaps, staleTime: 30_000 })
  const openDecisions = useMemo(() => {
    const latest = recaps.data?.recaps[0]
    return latest === undefined || latest.quiet ? 0 : undecidedCount(latest.model)
  }, [recaps.data])
  // Focus is the resting state; a department and a Fellow card both live in the column, so a
  // deep link into either opens in full, the same as a click on the shelf or the figure does.
  const [mode, setMode] = useState<Mode>(shelfParam !== '' || agentParam !== '' ? 'full' : 'focus')
  const [room, setRoom] = useState<string>(roomParam !== '' ? roomParam : 'main')
  const [spawnOpen, setSpawnOpen] = useState(spawnParam !== '')
  const [popover, setPopover] = useState<{ fellow: SceneFellow; x: number; y: number } | null>(null)
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
      const run = runsQ.data?.runs.find((r) => r.id === id)
      const ok = run ? run.status === 'done' : true
      gone.push({ id, kind: who.role === 'clerk' ? 'job' : 'run', ok, name: who.name, role: who.role, at: Date.now(), ...(who.agentId ? { agentId: who.agentId } : {}) })
    }
    seen.current = live
    if (gone.length > 0) {
      setExits((xs) => [...xs, ...gone])
      // A run that just settled is the one event that certainly moved the plan windows; the
      // poll would otherwise show the old figure for up to a minute (section 8.3).
      void qc.invalidateQueries({ queryKey: ['usage-plan'] })
    }
  }, [scene.data, runsQ.data])

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

  const rooms: readonly SceneRoom[] = scene.data?.rooms ?? []
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
  const windowOpen = shelf !== null || board !== null
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
  const onKey = (e: React.KeyboardEvent): void => {
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
    }
  }

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

  const state = queryState(scene, 'the library')
  const clock = new Date()
  const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`
  const byRoom = (id: string): typeof departments => departments.filter((d) => d.room === id).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  const s: LibraryScene | undefined = scene.data

  return (
    <div className={`workspace lib-workspace${mode === 'focus' ? ' focus' : ''}`}>
      {mode === 'full' && shelf !== null && (
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
      {mode === 'full' && shelf === null && (
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
        <div className="graph-controls lib-headline">
          <div className="lib-head-left">
            <div className="seg sm" role="radiogroup" aria-label="Mode">
              <button role="radio" aria-checked={mode === 'focus'} onClick={() => setMode('focus')}>
                Focus
              </button>
              <button role="radio" aria-checked={mode === 'full'} onClick={() => setMode('full')}>
                Full
              </button>
            </div>
          </div>
          <div className="lib-head-mid">
            {shelf === null && board === null && rooms.length > 0 && current && (
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
            {shelf === null && board !== null && (
              <span className="lib-open">
                <b>{BOARD_TITLES[board]}</b>
                <span className="box-sub">{BOARD_SUBS[board]}</span>
              </span>
            )}
            {shelf !== null && (
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
            {shelf !== null && shelfPage === null && (
              /* Same width and same right edge as "Deepen this domain" in the band below:
                 the two controls of a department stand in one column. */
              <div className="seg sm shelf-view" role="tablist" aria-label="View">
                <button role="tab" aria-selected={shelfPane === 'graph'} onClick={() => setShelfPane('graph')}>
                  Graph
                </button>
                <button role="tab" aria-selected={shelfPane === 'catalog'} onClick={() => setShelfPane('catalog')}>
                  Catalog
                </button>
              </div>
            )}
            {/* Spawning belongs to the room, where the Fellows are. */}
            {shelf === null && board === null && (
              <>
                <button
                  className="btn primary sm"
                  onClick={() => {
                    setMode('full')
                    setSpawnOpen(true)
                  }}
                >
                  Spawn a Fellow
                </button>
                {/* What the Fellows are waiting on you for, counted across all of them. */}
                <button
                  className={`btn sm lib-decisions${openDecisions > 0 ? ' due' : ''}`}
                  onClick={() => setBoard('recap')}
                  title={openDecisions > 0 ? `${openDecisions} proposal(s) waiting for a decision` : 'Nothing is waiting for a decision'}
                >
                  Decisions
                  <span className="n">{openDecisions}</span>
                </button>
              </>
            )}
          </div>
        </div>
        <div className={`lib-area${night ? ' night' : ''}`} ref={areaRef} tabIndex={0} onKeyDown={onKey}>
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
              onActorClick={onActorClick}
              onBoardClick={current.kind === 'main' ? setBoard : undefined}
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

          {/* A department's window: its graph and its catalog, over the room (section 10.5). */}
          {shelf !== null && (
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
              {board === 'hot' ? <HotCache vaultName={vaultName} /> : board === 'recap' ? <RecapFeed vaultName={vaultName} /> : <ReadingList vaultName={vaultName} />}
            </div>
          )}
          {(() => {
            const corner = planCorner(plan.data, Date.now())
            if (corner === null) return null
            return (
              <div className="lib-corner br">
                <div className={`lib-plan${night ? ' dark' : ''}`}>
                  {/* "left" once, in the head: with a per-model window or three it would be
                      four repetitions of the same word in a card this size. */}
                  {/* The unit sits over the column it describes, right-aligned with the
                      figures, and a rule separates the head from the readings. */}
                  <div className="lp-name">
                    <span>{corner.plan ?? 'plan'}</span>
                    <span className="lp-unit">{corner.unit}</span>
                  </div>
                  {corner.lines.map((l) => (
                    <div key={l.window} className={`lp-row${l.usedPct >= 90 ? ' spent' : l.usedPct >= 75 ? ' low' : ''}`}>
                      <span className="lp-w">{l.label}</span>
                      <span className="lp-n">{l.usedPct}%</span>
                    </div>
                  ))}
                  {corner.stale && (
                    <div className="lp-stale" title={corner.reason ?? 'the plan endpoint has not answered since'}>
                      {corner.ageMin}m old
                    </div>
                  )}
                </div>
              </div>
            )
          })()}
          <div className="lib-corner bl">
            <span className={`chip${night ? ' dark' : ''}`}>
              <Icon name={night ? 'moon' : 'sun'} /> {hhmm} · {night ? 'night' : 'day'} · {floorLine(actors)}
              {plan.data && ` · ${shareLine(plan.data)}`}
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
