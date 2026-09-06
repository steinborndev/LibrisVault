/**
 * The room strip on the canvas (docs/agents/SPEC.md section 10.8): pills with the room
 * names, shelf counts and an activity dot; pages between rooms, and takes a dragged shelf.
 */

import type { SceneRoom } from '../../api/types.ts'

export function RoomStrip({ rooms, current, activity, night, dropTarget, onPick, onHover }: { rooms: readonly SceneRoom[]; current: string; activity: ReadonlySet<string>; night: boolean; dropTarget: string | null; onPick: (id: string) => void; onHover?: (id: string | null) => void }): React.ReactElement {
  const idx = rooms.findIndex((r) => r.id === current)
  return (
    <div className={`lib-strip${night ? ' dark' : ''}`} role="tablist" aria-label="Rooms">
      <button className="arr" aria-label="Previous room" disabled={idx <= 0} onClick={() => idx > 0 && onPick(rooms[idx - 1]!.id)}>
        ↑
      </button>
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
      <button className="arr" aria-label="Next room" disabled={idx < 0 || idx >= rooms.length - 1} onClick={() => idx < rooms.length - 1 && onPick(rooms[idx + 1]!.id)}>
        ↓
      </button>
    </div>
  )
}
