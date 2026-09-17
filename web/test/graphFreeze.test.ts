import { describe, it, expect } from 'vitest'
import { parseGraphFreeze, serializeGraphFreeze, type GraphFreeze } from '../src/lib/graphFreeze.ts'

/**
 * The lock's record is read back field by field. A payload of another version, or one with a
 * field that is not what it says, is dropped whole: a lock half-applied would hold a picture
 * nobody locked.
 */

const held: GraphFreeze = {
  v: 1,
  selectedTypes: ['concepts'],
  selectedDomains: ['alpha'],
  wingMode: 'wing',
  wing: 'w1',
  localDepth: 2,
  focusPath: 'wiki/concepts/a.md',
  showGaps: false,
  showSystem: true,
  query: 'lattice',
  tagFilter: { tag: 'crystal', around: null },
  clusterStack: [{ paths: ['wiki/concepts/a.md', 'wiki/concepts/b.md'], label: 'lattice', domain: 'alpha', anchor: 'wiki/concepts/a.md' }],
  lens: 'authority',
  showClusters: true,
  showNetwork: false,
  spotlight: false,
}

describe("the graph lock's record", () => {
  it('round-trips what it wrote', () => {
    expect(parseGraphFreeze(serializeGraphFreeze(held))).toEqual(held)
  })

  it('reads the empty case as nothing held', () => {
    expect(parseGraphFreeze(null)).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, tagFilter: null, clusterStack: [], focusPath: null, wing: null, wingMode: 'all' }))).toMatchObject({ tagFilter: null, clusterStack: [], focusPath: null })
  })

  it('drops a payload of another version whole', () => {
    expect(parseGraphFreeze(JSON.stringify({ ...held, v: 2 }))).toBeNull()
  })

  it('drops a payload a field of which is not what it says', () => {
    expect(parseGraphFreeze(JSON.stringify({ ...held, selectedTypes: 'concepts' }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, lens: 'heat' }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, localDepth: 3 }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, wingMode: 'room' }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, tagFilter: { tag: 4 } }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, clusterStack: [{ paths: 'a' }] }))).toBeNull()
  })

  it('survives text that is not JSON, and a JSON that is not a record', () => {
    expect(parseGraphFreeze('{')).toBeNull()
    expect(parseGraphFreeze('null')).toBeNull()
    expect(parseGraphFreeze('"held"')).toBeNull()
  })
})
