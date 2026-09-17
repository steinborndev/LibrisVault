/**
 * The ask activity box's lines (lib/askTrail.ts): one line per observed transition, in the
 * order they happened, and a new question starts the trail over.
 */
import { describe, expect, it } from 'vitest'
import { advanceTrail, TRAIL_START, type TrailInput } from '../src/lib/askTrail.ts'

const at = (n: number): string => `2026-09-08T10:00:0${n}.000Z`
const step = (partial: Partial<TrailInput>): TrailInput => ({ ...TRAIL_START, ...partial })

describe('advanceTrail', () => {
  it('starts a trail when the question goes out, and only then', () => {
    expect(advanceTrail([], TRAIL_START, TRAIL_START, at(0))).toEqual([])
    expect(advanceTrail([], TRAIL_START, step({ pending: true }), at(1))).toEqual([{ ts: at(1), text: 'Searching the vault' }])
  })

  it('walks the four moments of an answer in order, one line each', () => {
    const asked = step({ pending: true })
    let trail = advanceTrail([], TRAIL_START, asked, at(1))
    const retrieved = step({ pending: true, retrieval: { count: 5, strategy: 'bm25-only' } })
    trail = advanceTrail(trail, asked, retrieved, at(2))
    const writing = step({ pending: true, retrieval: retrieved.retrieval, writing: true })
    trail = advanceTrail(trail, retrieved, writing, at(3))
    // Nothing changed: nothing appended, however often the answer text grows.
    expect(advanceTrail(trail, writing, writing, at(4))).toEqual(trail)
    const landed = step({ retrieval: retrieved.retrieval, writing: true, landed: 3 })
    trail = advanceTrail(trail, writing, landed, at(5))
    expect(trail.map((l) => l.text)).toEqual([
      'Searching the vault',
      'Retrieved 5 pages',
      'Writing the answer',
      'Answered with 3 sources',
    ])
    expect(trail.map((l) => l.ts)).toEqual([at(1), at(2), at(3), at(5)])
  })

  it('says one page and one source in the singular', () => {
    const one = step({ pending: true, retrieval: { count: 1, strategy: null } })
    expect(advanceTrail([], step({ pending: true }), one, at(1)).at(-1)?.text).toBe('Retrieved 1 page')
    const landed = step({ landed: 1 })
    expect(advanceTrail([], step({ pending: true }), landed, at(2)).at(-1)?.text).toBe('Answered with 1 source')
    expect(advanceTrail([], step({ pending: true }), step({ landed: 0 }), at(3)).at(-1)?.text).toBe('Answered')
  })

  it('ends a failed ask with the failure, and keeps what happened before it', () => {
    const asked = step({ pending: true })
    const failed = step({ error: 'query failed' })
    const trail = advanceTrail([{ ts: at(1), text: 'Searching the vault' }], asked, failed, at(2))
    expect(trail.map((l) => l.text)).toEqual(['Searching the vault', 'Failed: query failed'])
  })

  it('starts over on the next question rather than growing forever', () => {
    const old = [{ ts: at(1), text: 'Searching the vault' }, { ts: at(2), text: 'Answered' }]
    const trail = advanceTrail(old, step({ landed: 0 }), step({ pending: true }), at(3))
    expect(trail).toEqual([{ ts: at(3), text: 'Searching the vault' }])
  })
})
