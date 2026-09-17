/**
 * Moving a wing in the room strip (docs/agents/SPEC.md section 10.8).
 *
 * The strip is the room navigation, and it is also where the order lives: the wings are shown
 * in the order they are in, so dragging one along the strip is the obvious way to change it.
 * The main room is not a wing and never moves; it stays at the head of the list.
 *
 * Pure, so the arithmetic of "dropped left of it" versus "dropped right of it" is under test
 * rather than being discovered by dragging.
 */

/**
 * The wing ids in their new order after `dragged` is dropped on `target`.
 *
 * Dropping a wing on one that sits BEFORE it puts it in front of that wing; dropping it on one
 * that sits after puts it behind. That is what the eye expects from a strip: the pill you drop
 * onto makes room on the side you came from.
 */
export function reorderWings(ids: readonly string[], dragged: string, target: string): string[] {
  const from = ids.indexOf(dragged)
  const to = ids.indexOf(target)
  if (from < 0 || to < 0 || from === to) return [...ids]
  const out = [...ids]
  out.splice(from, 1)
  out.splice(to, 0, dragged)
  return out
}

/** True when a drop would change anything; the caller skips the request otherwise. */
export function orderChanged(before: readonly string[], after: readonly string[]): boolean {
  return before.length !== after.length || before.some((id, i) => id !== after[i])
}
