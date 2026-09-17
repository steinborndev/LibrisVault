/**
 * Which room focus mode should show while a Fellow is working (docs/agents/SPEC.md 10.7).
 *
 * Focus follows the Fellow at work, which is the whole point of the mode: the room where
 * something happens is the room you want to see. Followed on every render, though, it also
 * follows you BACK: navigate to the main room while a Fellow stands at a shelf in a wing and
 * the next render drags you into the wing again, over and over, until its run ends.
 *
 * So the follow is an event, not a pull. The screen remembers which room it last followed the
 * Fellow into; while that has not changed, your own navigation stands. When the Fellow moves
 * to a different room - or a different Fellow takes over - the follow fires once more.
 */

export interface FollowState {
  /** The room the screen last moved to on its own, or null when it never has. */
  readonly followed: string | null
}

/**
 * The room to switch to, or null to leave the view where the user put it.
 *
 * @param activeRoom the room of the Fellow currently at work, or null when none is
 * @param state what the screen last followed
 */
export function roomToFollow(activeRoom: string | null, current: string, state: FollowState): string | null {
  if (activeRoom === null) return null
  // Already there: nothing to do, and remember it so a step away is not undone.
  if (activeRoom === current) return null
  // The user navigated away from a room we already followed into: leave them alone.
  if (state.followed === activeRoom) return null
  return activeRoom
}
