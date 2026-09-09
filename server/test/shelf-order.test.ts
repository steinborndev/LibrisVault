/**
 * The night's order and a Fellow's art (docs/tasks/TASKS-A7.md 3.5 and D7).
 *
 * Both are constraints that only matter when they are wrong: an order that quietly falls back
 * to something else, or an art that accepts a task it promised not to. So the cases here are
 * mostly the ones where the answer is "no" or "not that".
 */

import { describe, it, expect } from 'vitest'
import { MemoryShelfOrderStore, byShelfThenPriority } from '../src/db/shelf-order.js'
import { artRefusal } from '../src/pipeline/fellows.js'
import type { AgentTask } from '../src/db/agents.js'

const task = (kind: AgentTask['kind'], text: string): AgentTask => ({ id: text, text, kind, state: 'active' })
const agent = (homeDomain: string, priority: number, createdAt: string): { homeDomain: string; priority: number; createdAt: string } => ({
  homeDomain,
  priority,
  createdAt,
})

describe('byShelfThenPriority', () => {
  it('walks the shelves in the order that was set, and the Fellows inside one by priority', () => {
    const order = ['finance', 'biomedicine']
    const sorted = byShelfThenPriority(
      [agent('biomedicine', 0, '2026-01-02'), agent('finance', 0, '2026-01-03'), agent('biomedicine', 5, '2026-01-04')],
      order,
    )
    // finance first because the order says so; inside biomedicine, priority 5 before 0.
    expect(sorted.map((a) => `${a.homeDomain}:${a.priority}`)).toEqual(['finance:0', 'biomedicine:5', 'biomedicine:0'])
  })

  it('keeps a shelf together, which the old per-Fellow order could not', () => {
    /*
     * Two Fellows of one domain either side of a third domain's is exactly what a schedule
     * cannot draw: the shelf appears twice and the band is a lie about where the work is.
     */
    const sorted = byShelfThenPriority(
      [agent('bio', 9, '2026-01-01'), agent('ml', 5, '2026-01-01'), agent('bio', 1, '2026-01-01')],
      ['bio', 'ml'],
    )
    expect(sorted.map((a) => a.homeDomain)).toEqual(['bio', 'bio', 'ml'])
  })

  it('puts an unplaced shelf after every placed one, without disturbing them', () => {
    // No row for a domain is not a statement that it comes last; it is nothing said at all.
    const sorted = byShelfThenPriority([agent('new', 99, '2026-01-01'), agent('a', 0, '2026-01-02'), agent('b', 0, '2026-01-03')], ['a', 'b'])
    expect(sorted.map((a) => a.homeDomain)).toEqual(['a', 'b', 'new'])
  })

  it('falls back to priority and age when nobody has set an order', () => {
    const sorted = byShelfThenPriority([agent('a', 0, '2026-01-02'), agent('b', 3, '2026-01-03'), agent('c', 0, '2026-01-01')], [])
    expect(sorted.map((a) => a.homeDomain)).toEqual(['b', 'c', 'a'])
  })
})

describe('MemoryShelfOrderStore', () => {
  it('replaces the whole order, and an empty list clears it', () => {
    const store = new MemoryShelfOrderStore()
    store.put(['a', 'b'])
    expect(store.list()).toEqual(['a', 'b'])
    store.put(['b'])
    expect(store.list()).toEqual(['b'])
    store.put([])
    expect(store.list()).toEqual([])
  })
})

describe('artRefusal', () => {
  it('lets a Fellow hold the art it is', () => {
    expect(artRefusal('watch', [task('watch', 'a'), task('watch', 'b')])).toBeNull()
  })

  it('refuses a task of another art, and says which', () => {
    /*
     * A Fellow's art is a promise about what it will do. An observer that quietly accepted a
     * deepen task would be an observer in name only, and the name is what it was chosen by.
     */
    const refusal = artRefusal('watch', [task('watch', 'a'), task('deepen', 'lipid nanoparticles')])
    expect(refusal?.status).toBe(409)
    expect(refusal?.error).toContain('watch tasks only')
    expect(refusal?.error).toContain('"lipid nanoparticles" is deepen')
  })

  it('lets custom hold anything, which is what custom means', () => {
    expect(artRefusal('custom', [task('watch', 'a'), task('explore', 'b'), task('deepen', 'c')])).toBeNull()
  })

  it('accepts an empty list rather than inventing a complaint about it', () => {
    // "A Fellow needs at least one task" is a different rule, checked in its own place.
    expect(artRefusal('deepen', [])).toBeNull()
  })
})
