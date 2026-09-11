/**
 * The wings the domain sections walk (web/src/lib/wings.ts): the Library's rooms in the
 * user's order, the domains in shelf order, and the walking and the searching over them.
 */

import { describe, expect, it } from 'vitest'
import { stepWing, UNSHELVED, wingGroups, wingOf, wingWithMatch } from '../src/lib/wings.ts'
import type { SceneRoom } from '../src/api/types.ts'

const shelf = (slot: number, domain: string): SceneRoom['shelves'][number] => ({ slot, domain, books: 1, volumes: 1, stubs: 0, placedBy: 'auto' })
const rooms: SceneRoom[] = [
  { id: 'w-b', name: 'Wing B', kind: 'wing', position: 1, capacity: 12, shelves: [shelf(1, 'chemistry'), shelf(0, 'physics')] },
  { id: 'main', name: 'Main room', kind: 'main', position: -1, capacity: 4, shelves: [shelf(0, 'astronomy'), shelf(1, 'biology')] },
  { id: 'w-a', name: 'Wing A', kind: 'wing', position: 0, capacity: 12, shelves: [shelf(0, 'ai-tooling')] },
  { id: 'w-empty', name: 'Wing C', kind: 'wing', position: 2, capacity: 12, shelves: [shelf(0, 'nowhere')] },
]
const known = ['ai-tooling', 'astronomy', 'biology', 'chemistry', 'physics', 'stray', '']

describe('the wings a domain section walks', () => {
  it('walks the main room first, then the wings in order, then what is not shelved, in shelf order', () => {
    const groups = wingGroups({ rooms }, known)
    expect(groups.map((g) => g.id)).toEqual(['main', 'w-a', 'w-b', UNSHELVED])
    expect(groups.map((g) => g.name)).toEqual(['Main room', 'Wing A', 'Wing B', 'Not shelved'])
    // Shelf order, not the order the scene happened to list them in.
    expect(groups[2]!.domains).toEqual(['physics', 'chemistry'])
    // The no-domain bucket and a domain without a shelf are reachable at the end.
    expect(groups[3]!.domains).toEqual(['stray', ''])
  })

  it('leaves out a room with none of the screen\'s domains, and everything without a scene', () => {
    expect(wingGroups({ rooms }, known).some((g) => g.id === 'w-empty')).toBe(false)
    expect(wingGroups(undefined, known)).toEqual([])
    // Every domain shelved: no last group.
    expect(wingGroups({ rooms }, ['astronomy']).map((g) => g.id)).toEqual(['main'])
  })

  it('steps one group at a time and stops at the ends', () => {
    const groups = wingGroups({ rooms }, known)
    expect(stepWing(groups, 'main', 1)).toBe('w-a')
    expect(stepWing(groups, 'w-a', -1)).toBe('main')
    expect(stepWing(groups, 'main', -1)).toBeNull()
    expect(stepWing(groups, UNSHELVED, 1)).toBeNull()
    expect(stepWing(groups, 'gone', 1)).toBeNull()
  })

  it('knows where a domain stands, and where a search lands', () => {
    const groups = wingGroups({ rooms }, known)
    expect(wingOf(groups, 'physics')).toBe('w-b')
    expect(wingOf(groups, 'unknown')).toBeUndefined()
    const has = (needle: string) => (d: string) => d.includes(needle)
    // The page on show keeps a hit of its own; otherwise the first page with one.
    expect(wingWithMatch(groups, 'w-b', has('phys'))).toBe('w-b')
    expect(wingWithMatch(groups, 'main', has('phys'))).toBe('w-b')
    expect(wingWithMatch(groups, 'w-b', has('chem'))).toBe('w-b')
    expect(wingWithMatch(groups, 'main', has('zzz'))).toBeNull()
  })
})
