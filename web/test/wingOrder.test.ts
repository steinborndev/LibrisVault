/**
 * Reordering wings by dragging their pill in the room strip (docs/agents/SPEC.md 10.8). The
 * strip shows the wings in their order, so the drop has to land where the eye expects it.
 */

import { describe, expect, it } from 'vitest'
import { orderChanged, reorderWings } from '../src/lib/library/wingOrder.ts'

describe('reordering wings', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('dropping on a wing in front puts it in front of that one', () => {
    expect(reorderWings(ids, 'c', 'a')).toEqual(['c', 'a', 'b', 'd'])
    expect(reorderWings(ids, 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('dropping on a wing behind puts it behind that one', () => {
    expect(reorderWings(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(reorderWings(ids, 'b', 'd')).toEqual(['a', 'c', 'd', 'b'])
  })

  it('a drop on itself, or on something that is not in the list, changes nothing', () => {
    expect(reorderWings(ids, 'b', 'b')).toEqual(ids)
    expect(reorderWings(ids, 'b', 'zz')).toEqual(ids)
    expect(reorderWings(ids, 'zz', 'b')).toEqual(ids)
  })

  it('says whether a request is worth making', () => {
    expect(orderChanged(ids, ['a', 'b', 'c', 'd'])).toBe(false)
    expect(orderChanged(ids, ['b', 'a', 'c', 'd'])).toBe(true)
    expect(orderChanged(ids, ['a', 'b', 'c'])).toBe(true)
  })
})
