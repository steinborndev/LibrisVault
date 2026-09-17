/**
 * The graph explorer's navigation trail. Two rules that interact, which is why they are
 * tested rather than read: a rolling window, and a rewind on revisiting.
 *
 * Tested here and not through the screen because a click-through cannot tell the two apart -
 * walking a graph lands on pages you have already seen, which rewinds, and a trail that stays
 * short then looks like the window doing its job when it is the rewind doing it.
 */

import { describe, expect, it } from 'vitest'
import { stepTrail } from '../src/lib/trail.ts'

describe('the navigation trail', () => {
  it('appends until it is full, then rolls off the oldest', () => {
    let t: string[] = []
    for (const p of ['a', 'b', 'c']) t = stepTrail(t, p, 3)
    expect(t).toEqual(['a', 'b', 'c'])
    // The fourth page replaces the first: the trail is the recent past, not the whole walk.
    expect(stepTrail(t, 'd', 3)).toEqual(['b', 'c', 'd'])
    expect(stepTrail(stepTrail(t, 'd', 3), 'e', 3)).toEqual(['c', 'd', 'e'])
  })

  it('rewinds to a page already on it instead of appending it again', () => {
    // Walking back out of a detour undoes the detour rather than recording it twice - and a
    // trail can therefore never hold the same page in two places.
    expect(stepTrail(['a', 'b', 'c'], 'b', 3)).toEqual(['a', 'b'])
    expect(stepTrail(['a', 'b', 'c'], 'a', 3)).toEqual(['a'])
    expect(stepTrail(['a', 'b', 'c'], 'c', 3)).toEqual(['a', 'b', 'c'])
  })

  it('rewinds even to a page the window is about to drop', () => {
    // The interaction worth pinning: the rewind is checked BEFORE the window, so revisiting
    // the oldest hop shortens the trail rather than rolling it and appending a duplicate.
    expect(stepTrail(['a', 'b', 'c'], 'a', 3)).toEqual(['a'])
  })

  it('holds one page when that is all there is', () => {
    expect(stepTrail([], 'a', 3)).toEqual(['a'])
    expect(stepTrail(['a'], 'a', 3)).toEqual(['a'])
  })
})
