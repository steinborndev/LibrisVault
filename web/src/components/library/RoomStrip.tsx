/**
 * The room strip in the headline (docs/agents/SPEC.md section 10.8): pills with the room
 * names, shelf counts and an activity dot. It takes a dragged shelf, and its last button
 * opens a new wing. The arrows are gone: the pills are the navigation, and the wheel pages
 * through the rooms.
 */

import type { SceneRoom } from '../../api/types.ts'
import { Icon } from '../Icon.tsx'

export function RoomStrip({
  rooms,
  current,
  activity,
  night,
  dropTarget,
  onPick,
  onHover,
  onNewWing,
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
}): React.ReactElement {
  return (
    <div className={`lib-strip${night ? ' dark' : ''}`} role="tablist" aria-label="Rooms">
      {rooms.map((r) => (
        <button
          key={r.id}
          role="tab"
          aria-selected={r.id === current}
          className={`rp${r.id === current ? ' on' : ''}${dropTarget === r.id ? ' target' : ''}`}
          data-room={r.id}
          onClick={() => onPick(r.id)}
          onPointerEnter={() => onHover?.(r.id)}
          onPointerLeave={() => onHover?.(null)}
        >
          {r.name}
          {r.kind === 'wing' && <span className="cnt">{r.shelves.length}</span>}
          {activity.has(r.id) && r.id !== current && <span className="adot" aria-label="activity" />}
        </button>
      ))}
      <button className="arr" aria-label="New wing" title="Open another wing" disabled={onNewWing === undefined} onClick={() => onNewWing?.()}>
        <Icon name="plus" />
      </button>
    </div>
  )
}
