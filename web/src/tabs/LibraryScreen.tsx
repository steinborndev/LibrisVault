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
 * inside it.
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
import { queryState } from '../components/QueryState.tsx'
import { logStore } from '../lib/logStore.ts'
import { domainColor } from '../lib/domains.ts'
import { navigate } from '../lib/router.ts'
import { buildActors, floorLine, EXIT_MS, type Actor, type Exit } from '../lib/library/scene.ts'
import { shareLine } from '../lib/plan.ts'
import { signText, WING_CAPACITY, FAVORITE_SLOTS } from '../lib/library/room.ts'

const CANVAS_W = 1128
const CANVAS_H = 700

type Mode = 'full' | 'focus'

export function LibraryScreen({ vaultName, agentParam, roomParam, spawnParam = '', shelfParam = '', paneParam = '', pageParam = '' }: { vaultName: string; agentParam: string; roomParam: string; spawnParam?: string; shelfParam?: string; paneParam?: string; pageParam?: string }): React.ReactElement {
  const qc = useQueryClient()
  const scene = useQuery({ queryKey: ['library-scene'], queryFn: api.libraryScene, refetchInterval: 5_000 })
  const runsQ = useQuery({ queryKey: ['maintenance-runs'], queryFn: api.maintenanceRuns, staleTime: 5_000 })
  // The plan's research share for the now chip and the spawn projection (A5); the endpoint is cached server-side.
  const plan = useQuery({ queryKey: ['usage-plan'], queryFn: api.usagePlan, refetchInterval: 60_000, retry: false })
  const [mode, setMode] = useState<Mode>('full')
  const [room, setRoom] = useState<string>(roomParam !== '' ? roomParam : 'main')
  const [spawnOpen, setSpawnOpen] = useState(spawnParam !== '')
  const [popover, setPopover] = useState<{ fellow: SceneFellow; x: number; y: number } | null>(null)
  /** A board on the main room's wall, opened as a window over the room. Escape closes it. */
  const [board, setBoard] = useState<'hot' | 'recap' | null>(null)
  /** A department opened over the room: its graph and its catalog, filtered (section 10.5). */
  const [shelf, setShelf] = useState<string | null>(shelfParam !== '' ? shelfParam : null)
  /** A page read inside the shelf window: the third level, closed by the first Escape. */
  const [shelfPage, setShelfPage] = useState<string | null>(pageParam !== '' ? pageParam : null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [tick, setTick] = useState(0)
  const [exits, setExits] = useState<Exit[]>([])
  const seen = useRef<Map<string, { name: string; role: Actor['role']; agentId?: string }>>(new Map())
  const [drag, setDrag] = useState<{ domain: string; x: number; y: number; target: string | null; slot: number | null } | null>(null)
  const areaRef = useRef<HTMLDivElement>(null)

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
    for (const r of s.runs) live.set(r.id, { name: r.kind === 'research' ? 'researcher' : r.kind, role: 'researcher' })
    for (const j of s.jobs) if (j.status !== 'queued') live.set(j.id, { name: j.name, role: 'clerk' })
    const gone: Exit[] = []
    for (const [id, who] of seen.current) {
      if (live.has(id)) continue
      const run = runsQ.data?.runs.find((r) => r.id === id)
      const ok = run ? run.status === 'done' : true
      gone.push({ id, kind: who.role === 'clerk' ? 'job' : 'run', ok, name: who.name, role: who.role, at: Date.now(), ...(who.agentId ? { agentId: who.agentId } : {}) })
    }
    seen.current = live
    if (gone.length > 0) setExits((xs) => [...xs, ...gone])
  }, [scene.data, runsQ.data])

  const actors = useMemo(() => {
    void tick
    if (!scene.data) return []
    return buildActors({
      scene: scene.data,
      lastLine: (channel) => {
        const lines = logStore.snapshot(channel)
        return lines.length > 0 ? lines[lines.length - 1]!.message : null
      },
      exits,
      now: Date.now(),
    })
  }, [scene.data, exits, tick])

  const rooms: readonly SceneRoom[] = scene.data?.rooms ?? []
  const current = rooms.find((r) => r.id === room) ?? rooms[0]
  const activityRooms = useMemo(() => new Set(actors.filter((a) => !a.exiting && a.pose !== 'sleep' && a.pose !== 'sit').map((a) => a.room)), [actors])
  const night = scene.data?.night ?? false

  // Focus mode follows the active Fellow's room.
  useEffect(() => {
    if (mode !== 'focus') return
    const active = actors.find((a) => a.role === 'fellow' && (a.pose === 'shelf' || a.pose === 'desk' || a.pose === 'shelve'))
    if (active && active.room !== room) setRoom(active.room)
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

  // Paging: wheel and arrow keys inside the canvas.
  const page = useCallback(
    (delta: number): void => {
      if (!current) return
      const idx = rooms.findIndex((r) => r.id === current.id)
      const next = rooms[Math.max(0, Math.min(rooms.length - 1, idx + delta))]
      if (next && next.id !== current.id) pickRoom(next.id)
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
      if (shelfPage !== null) setShelfPage(null)
      else if (shelf !== null) setShelf(null)
      else if (board !== null) setBoard(null)
      else if (mode === 'focus') setMode('full')
    }
  }

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
  const deleteWing = useMutation({ mutationFn: (id: string) => api.deleteWing(id), onSuccess: () => {
    invalidate()
    pickRoom('main')
  } })
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.reorderWings(ids), onSuccess: invalidate })
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
  const departments = scene.data?.departments ?? []
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
          />
        </aside>
      )}
      {mode === 'full' && shelf === null && (
        <aside className="gpanel" aria-label="Library controls">
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
            {spawnOpen ? (
              <SpawnForm
                plan={plan.data}
                onDone={(id) => {
                  setSpawnOpen(false)
                  openCard(id)
                }}
                onCancel={() => setSpawnOpen(false)}
              />
            ) : (
              <button className="btn primary sm" style={{ marginTop: 8 }} onClick={() => setSpawnOpen(true)}>
                Spawn a Fellow
              </button>
            )}
          </div>
          <div className="gp-sec">
            <div className="gp-head">
              <span className="gp-eyebrow">Rooms</span>
              <span className="spacer" />
              <span className="mono-meta">scroll or click</span>
            </div>
            {rooms.map((r, idx) => (
              <div key={r.id} className={`lib-wrow${r.id === current?.id ? ' on' : ''}${drag?.target === r.id ? ' target' : ''}`} data-room={r.id}>
                {renaming?.id === r.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      renameWing.mutate({ id: r.id, name: renaming.name })
                      setRenaming(null)
                    }}
                  >
                    <input className="input sm" autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: r.id, name: e.target.value })} onBlur={() => setRenaming(null)} maxLength={40} />
                  </form>
                ) : (
                  <button className="wn" onClick={() => pickRoom(r.id)}>
                    {r.name}
                  </button>
                )}
                <span className="ws">
                  {r.kind === 'main' ? `favorites ${r.shelves.length} of ${FAVORITE_SLOTS}` : `${r.shelves.length} of ${WING_CAPACITY}${r.shelves.length >= WING_CAPACITY ? ', full' : ''}`}
                </span>
                {r.kind === 'wing' && (
                  <span className="wacts">
                    <button className="wact" title="Rename" onClick={() => setRenaming({ id: r.id, name: r.name })}>
                      ✎
                    </button>
                    <button className="wact" title="Move up" disabled={idx <= 1} onClick={() => reorder.mutate(moveInOrder(rooms, r.id, -1))}>
                      ↑
                    </button>
                    <button className="wact" title="Move down" disabled={idx >= rooms.length - 1} onClick={() => reorder.mutate(moveInOrder(rooms, r.id, 1))}>
                      ↓
                    </button>
                    {r.shelves.length === 0 && (
                      <button className="wact" title="Delete the empty wing" onClick={() => deleteWing.mutate(r.id)}>
                        ×
                      </button>
                    )}
                  </span>
                )}
              </div>
            ))}
            <button className="lib-wrow add" onClick={() => createWing.mutate()} disabled={createWing.isPending}>
              + New wing
            </button>
          </div>
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
                    <div key={d.domain} className="lib-drow" data-domain={d.domain} onPointerDown={(e) => onShelfPointerDown(d.domain, e)} style={{ cursor: 'grab' }}>
                      <span className="dot" style={{ background: domainColor(d.domain) }} aria-hidden />
                      <span className="nm">{signText(d.domain)}</span>
                      <span className="n">{d.books + d.volumes}</span>
                      <select
                        className="select sm"
                        aria-label={`Move ${d.domain}`}
                        value=""
                        onChange={(e) => {
                          if (e.target.value !== '') move.mutate({ domain: d.domain, room: e.target.value })
                        }}
                      >
                        <option value="">move…</option>
                        {rooms.filter((x) => x.id !== r.id).map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              ))}
              {s && s.unfiled > 0 && <p className="mono-meta">{s.unfiled} unfiled page(s) on the intake cart.</p>}
            </div>
          </div>
        </aside>
      )}

      <div className="box lib-box">
        <div className="graph-controls lib-headline">
          {rooms.length > 0 && current && (
            <RoomStrip rooms={rooms} current={current.id} activity={activityRooms} night={false} dropTarget={drag?.target ?? null} onPick={pickRoom} />
          )}
          <span className="spacer" />
          <div className="seg sm" role="radiogroup" aria-label="Mode">
            <button role="radio" aria-checked={mode === 'full'} onClick={() => setMode('full')}>
              Full
            </button>
            <button role="radio" aria-checked={mode === 'focus'} onClick={() => setMode('focus')}>
              Focus
            </button>
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
                if (!drag) setShelf(domain)
              }}
              onShelfPointerDown={onShelfPointerDown}
              onActorClick={onActorClick}
              onBoardClick={current.kind === 'main' ? setBoard : undefined}
              onPassageClick={rooms.length > 1 ? nextRoom : undefined}
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
              pane={paneParam === 'catalog' ? 'catalog' : 'graph'}
              page={shelfPage}
              onPage={setShelfPage}
              onClose={() => {
                setShelfPage(null)
                setShelf(null)
              }}
            />
          )}

          {/* A board's window: the same frame, the same size, so the screen does not move. */}
          {shelf === null && board !== null && (
            <div className="lib-window" role="dialog" aria-label={board === 'hot' ? 'Hot cache' : 'Daily recap'}>
              <div className="box-head">
                <h2 className="box-title">{board === 'hot' ? 'Hot cache' : 'Daily recap'}</h2>
                <span className="box-sub">{board === 'hot' ? "the vault's digest, refreshed after every run" : 'the same view Home opens on'}</span>
                <span className="spacer" />
                <button className="btn ghost sm" onClick={() => setBoard(null)}>
                  Back to the room · Esc
                </button>
              </div>
              {board === 'hot' ? <HotCache vaultName={vaultName} /> : <RecapFeed vaultName={vaultName} />}
            </div>
          )}
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

/** The wing ids in their new order after moving one by `delta` (the main room stays first). */
function moveInOrder(rooms: readonly SceneRoom[], id: string, delta: number): string[] {
  const ids = rooms.filter((r) => r.kind === 'wing').map((r) => r.id)
  const idx = ids.indexOf(id)
  const to = idx + delta
  if (idx < 0 || to < 0 || to >= ids.length) return ids
  ids.splice(idx, 1)
  ids.splice(to, 0, id)
  return ids
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
