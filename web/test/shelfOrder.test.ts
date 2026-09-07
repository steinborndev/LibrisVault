/**
 * Walking from shelf to shelf with the up and down arrows (web/src/lib/library/shelfOrder.ts).
 * The order has to be the one on screen, and the ends have to wrap - both are easy to get
 * subtly wrong and tedious to check by holding a key down.
 */

import { describe, it, expect } from 'vitest'
import { orderedDomains, stepDomain } from '../src/lib/library/shelfOrder.ts'

const rooms = [{ id: 'main' }, { id: 'w1' }, { id: 'w2' }]
const dep = (domain: string, room: string | null, slot: number | null) => ({ domain, room, slot })

describe('the order the shelves stand in', () => {
  it('walks the rooms in their order and the slots inside each', () => {
    const departments = [dep('cooking', 'w1', 1), dep('astronomy', 'main', 0), dep('biology', 'w1', 0), dep('finance', 'main', 1), dep('music', 'w2', 0)]
    expect(orderedDomains(rooms, departments)).toEqual(['astronomy', 'finance', 'biology', 'cooking', 'music'])
  })

  it('still lists a department whose room is gone, after the placed ones, so it can be left', () => {
    const departments = [dep('astronomy', 'main', 0), dep('orphan', 'deleted-wing', 2), dep('unfiled', null, 1)]
    expect(orderedDomains(rooms, departments)).toEqual(['astronomy', 'unfiled', 'orphan'])
  })

  it('answers with nothing for an empty library', () => {
    expect(orderedDomains(rooms, [])).toEqual([])
  })
})

describe('stepping to the next one', () => {
  const order = ['a', 'b', 'c']

  it('moves one along in either direction', () => {
    expect(stepDomain(order, 'a', 1)).toBe('b')
    expect(stepDomain(order, 'b', -1)).toBe('a')
  })

  it('wraps at both ends, because a ring of shelves has no dead end', () => {
    expect(stepDomain(order, 'c', 1)).toBe('a')
    expect(stepDomain(order, 'a', -1)).toBe('c')
  })

  it('starts somewhere sensible when the current shelf is not in the list', () => {
    expect(stepDomain(order, null, 1)).toBe('a')
    expect(stepDomain(order, null, -1)).toBe('c')
    expect(stepDomain(order, 'deleted', 1)).toBe('a')
  })

  it('goes nowhere when there is nowhere to go', () => {
    expect(stepDomain([], 'a', 1)).toBeNull()
    expect(stepDomain(['a'], 'a', 1)).toBeNull()
    expect(stepDomain(['a'], 'a', -1)).toBeNull()
  })
})
