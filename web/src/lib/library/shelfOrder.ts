/**
 * Stepping from one department to the next (docs/agents/SPEC.md section 10.9).
 *
 * Left and right switch a department's two views; up and down switch the department itself.
 * The order is the one the eye already has: the rooms in their order, and inside each room
 * the shelves in their slots - the same walk the column's list and the room's back wall show,
 * so an arrow moves to the shelf that stands next to this one rather than to an alphabetical
 * neighbour nobody can see.
 *
 * Pure, so the wrap-around and the "not in the list any more" case are under test rather than
 * discovered by holding a key down.
 */

/** Just enough of a room and a department to place its shelf; the scene types are supersets. */
interface RoomLike {
  readonly id: string
}
interface DepartmentLike {
  readonly domain: string
  readonly room: string | null
  readonly slot: number | null
}

/**
 * Every department in the order it stands in: room by room, and by slot within a room.
 *
 * A department whose room is unknown (a wing deleted while the scene was in flight) still
 * appears, at the end, because a shelf you can open is a shelf you must be able to leave.
 */
export function orderedDomains(rooms: readonly RoomLike[], departments: readonly DepartmentLike[]): string[] {
  const bySlot = (a: DepartmentLike, b: DepartmentLike): number => (a.slot ?? 0) - (b.slot ?? 0)
  const placed = new Set<string>()
  const out: string[] = []
  for (const room of rooms) {
    for (const d of departments.filter((x) => x.room === room.id).sort(bySlot)) {
      placed.add(d.domain)
      out.push(d.domain)
    }
  }
  for (const d of [...departments].sort(bySlot)) {
    if (!placed.has(d.domain)) out.push(d.domain)
  }
  return out
}

/**
 * The department `step` places along from `current`, wrapping at both ends.
 *
 * Wrapping rather than stopping: the list is a ring of shelves in a room, and holding the key
 * down to walk past the last one and stop dead reads as a broken key. Returns null when there
 * is nowhere to go - no departments at all, or only the one you are in.
 */
export function stepDomain(order: readonly string[], current: string | null, step: number): string | null {
  if (order.length === 0) return null
  const at = current === null ? -1 : order.indexOf(current)
  // Opening a department that has since left the list (renamed, moved, deleted) still steps:
  // from nowhere, forward is the first shelf and backward is the last.
  if (at < 0) return step >= 0 ? order[0]! : order[order.length - 1]!
  if (order.length === 1) return null
  const next = (at + (step % order.length) + order.length) % order.length
  return order[next]!
}
