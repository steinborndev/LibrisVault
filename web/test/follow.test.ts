/**
 * Focus mode's room follow (docs/agents/SPEC.md 10.7). It follows the Fellow at work, but as
 * an event: navigating away from the room it followed into must stand, or a run in a wing
 * traps the reader there until the step ends - which is exactly what it did.
 */

import { describe, expect, it } from 'vitest'
import { roomToFollow } from '../src/lib/library/follow.ts'

describe('following the Fellow at work', () => {
  it('moves to the room the Fellow is working in', () => {
    expect(roomToFollow('wing-a', 'main', { followed: null })).toBe('wing-a')
  })

  it('lets a step back to the main room stand while the Fellow stays put', () => {
    // The follow already happened, the user walked out, and the Fellow has not moved since.
    expect(roomToFollow('wing-a', 'main', { followed: 'wing-a' })).toBeNull()
  })

  it('follows again when the Fellow moves on', () => {
    // From the wing to the desks in the main room: a new place, so a new follow.
    expect(roomToFollow('main', 'wing-a', { followed: 'wing-a' })).toBe('main')
    // And back to the shelf later, which is a move again.
    expect(roomToFollow('wing-a', 'main', { followed: 'main' })).toBe('wing-a')
  })

  it('does nothing when nobody is working, or when the room is already right', () => {
    expect(roomToFollow(null, 'main', { followed: null })).toBeNull()
    expect(roomToFollow(null, 'wing-a', { followed: 'wing-a' })).toBeNull()
    expect(roomToFollow('wing-a', 'wing-a', { followed: null })).toBeNull()
  })
})
