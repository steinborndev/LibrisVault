/**
 * The room strip in the headline (docs/agents/SPEC.md section 10.8): pills with the room
 * names, shelf counts and an activity dot. It takes a dragged shelf, and its last button
 * opens a new wing. The arrows are gone: the pills are the navigation, and the wheel pages
 * through the rooms.
 *
 * The strip also carries what the room list in the column used to (2026-09-07): the wings are
 * shown in their order, so dragging a pill along the strip is what changes that order, and the
 * pill of the room you are in offers to delete it while it is an empty wing. Both live here
 * because this is where a wing is a thing you can point at.
 */

import { useRef, useState } from 'react'
import type { SceneRoom } from '../../api/types.ts'
import { Icon } from '../Icon.tsx'
import { orderChanged, reorderWings } from '../../lib/library/wingOrder.ts'

/** How far a pointer travels before a click on a pill turns into a drag of it. */
const DRAG_THRESHOLD = 5

export function RoomStrip({
  rooms,
  current,
  activity,
  night,
  dropTarget,
  onPick,
  onHover,
  onNewWing,
  onReorder,
  onDelete,
}: {
  rooms: readonly SceneRoom[]
  current: string
  activity: ReadonlySet<string>
  night: boolean
  dropTarget: string | null
  onPick: (id: string) => void
  onHover?: (id: string | null) => void
  /** Opens another wing; absent while one is being created. */
  onNewWing?: () => void
  /** The wing ids in their new order, after a pill was dragged onto another. */
  onReorder?: (ids: string[]) => void
  /** Deletes an empty wing; the pill only offers it for the room you are in. */
  onDelete?: (id: string) => void
}): React.ReactElement {
  const wings = rooms.filter((r) => r.kind === 'wing')
  /** The wing being dragged, and the pill it is currently over. */
  const [drag, setDrag] = useState<{ id: string; over: string | null; moved: boolean } | null>(null)
  const start = useRef<{ x: number; id: string } | null>(null)

  const onPointerDown = (e: React.PointerEvent, room: SceneRoom): void => {
    if (room.kind !== 'wing' || onReorder === undefined || e.button !== 0) return
    start.current = { x: e.clientX, id: room.id }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const from = start.current
    if (from === null) return
    if (drag === null) {
      if (Math.abs(e.clientX - from.x) < DRAG_THRESHOLD) return
      setDrag({ id: from.id, over: null, moved: true })
      return
    }
    // Which pill is under the pointer: the strip is a row, so the x axis decides.
    const over = (e.target as HTMLElement | null)?.closest?.('[data-room]')?.getAttribute('data-room') ?? null
    const room = rooms.find((r) => r.id === over)
    setDrag({ ...drag, over: room?.kind === 'wing' ? room.id : null })
  }
  const onPointerUp = (): void => {
    const held = drag
    start.current = null
    setDrag(null)
    if (held === null || held.over === null || held.over === held.id) return
    const ids = wings.map((w) => w.id)
    const next = reorderWings(ids, held.id, held.over)
    if (orderChanged(ids, next)) onReorder?.(next)
  }

  return (
    <div
      className={`lib-strip${night ? ' dark' : ''}${drag !== null ? ' dragging' : ''}`}
      role="tablist"
      aria-label="Rooms"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      {rooms.map((r) => {
        const deletable = onDelete !== undefined && r.kind === 'wing' && r.id === current && r.shelves.length === 0
        return (
          <span key={r.id} className={`rpw${drag?.id === r.id ? ' held' : ''}${drag !== null && drag.over === r.id && drag.id !== r.id ? ' over' : ''}`}>
            <button
              role="tab"
              aria-selected={r.id === current}
              className={`rp${r.id === current ? ' on' : ''}${dropTarget === r.id ? ' target' : ''}`}
              data-room={r.id}
              title={r.kind === 'wing' && onReorder !== undefined ? `${r.name} - drag to reorder` : r.name}
              onPointerDown={(e) => onPointerDown(e, r)}
              onClick={() => {
                // A drag that moved is not a click; the pointer-up above already handled it.
                if (drag === null) onPick(r.id)
              }}
              onPointerEnter={() => onHover?.(r.id)}
              onPointerLeave={() => onHover?.(null)}
            >
              {r.name}
              {r.kind === 'wing' && <span className="cnt">{r.shelves.length}</span>}
              {activity.has(r.id) && r.id !== current && <span className="adot" aria-label="activity" />}
            </button>
            {deletable && (
              <button
                className="rdel"
                aria-label={`Delete ${r.name}`}
                title="Delete this empty wing"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete?.(r.id)
                }}
              >
                ×
              </button>
            )}
          </span>
        )
      })}
      <button className="arr" aria-label="New wing" title="Open another wing" disabled={onNewWing === undefined} onClick={() => onNewWing?.()}>
        <Icon name="plus" />
      </button>
    </div>
  )
}
