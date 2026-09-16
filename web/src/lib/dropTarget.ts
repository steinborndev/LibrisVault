/**
 * Whether a dropped file landed on something that handles drops itself.
 *
 * The Inbox dropzone handles drops on itself and marks itself with `data-drop-target`; the
 * window-level `DropGuard` swallows everything else, so that a drop which misses does not
 * navigate the tab away from the dashboard. Both hear a drop on the dropzone, because the
 * event bubbles to `window`, and the mark is how the window one knows to keep its hands off.
 *
 * Until 2026-09-16 the window listener was an uploader rather than a guard, and the same mark
 * stopped a file dropped on the zone from being sent twice (the second arrived as a
 * "duplicate" of the first, 30 ms apart). The uploader is gone - a drop is not an ingest, the
 * button is - and the rule it needed outlived it.
 *
 * Kept as a pure function over the event target so the rule is testable without a DOM.
 */

/** The subset of `Element` the rule needs; a test can pass a plain object. */
export interface DropTargetLike {
  closest(selector: string): unknown
}

export const DROP_TARGET_SELECTOR = '[data-drop-target]'

/** True when the drop landed inside an element that handles drops itself. */
export function ownsDrop(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false
  const el = target as Partial<DropTargetLike>
  if (typeof el.closest !== 'function') return false
  return el.closest(DROP_TARGET_SELECTOR) != null
}
