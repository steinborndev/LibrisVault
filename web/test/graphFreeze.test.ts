import { describe, it, expect } from 'vitest'
import { parseGraphFreeze, serializeGraphFreeze, type GraphFreeze } from '../src/lib/graphFreeze.ts'

/**
 * The lock's record is read back field by field. A payload of another version, or one with a
 * field that is not what it says, is dropped whole: a lock half-applied would hold a picture
 * nobody locked.
 */

const held: GraphFreeze = {
  v: 2,
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
  landmarks: null,
}

/**
 * The same picture with the Landmarks overlay on. It carries none of the four things the mode
 * excludes, because the interface cannot produce a record that does - which is what the
 * invariant below tests.
 */
const marked: GraphFreeze = {
  ...held,
  localDepth: 0,
  query: '',
  clusterStack: [],
  spotlight: false,
  landmarks: {
    domain: 'alpha',
    order: ['wiki/concepts/a.md', 'wiki/concepts/b.md', 'wiki/concepts/c.md'],
    chapters: [0, 2],
    connectors: ['wiki/concepts/glue.md'],
    bloom: 'wiki/concepts/a.md',
  },
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
    // A v1 picture knows nothing of the mode's exclusions, so it cannot be half-read into v2.
    expect(parseGraphFreeze(JSON.stringify({ ...held, v: 1 }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, v: 3 }))).toBeNull()
  })

  it('drops a payload a field of which is not what it says', () => {
    expect(parseGraphFreeze(JSON.stringify({ ...held, selectedTypes: 'concepts' }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, lens: 'heat' }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, localDepth: 3 }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, wingMode: 'room' }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, tagFilter: { tag: 4 } }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...held, clusterStack: [{ paths: 'a' }] }))).toBeNull()
  })

  it('round-trips the overlay, its order and its open bloom', () => {
    // The computed ORDER, not merely the switch: re-deriving a ranking on the way back would
    // put the reader somewhere else the first time an ingest reordered it.
    expect(parseGraphFreeze(serializeGraphFreeze(marked))).toEqual(marked)
  })

  it('drops a record pairing the overlay with what the mode turns off', () => {
    expect(parseGraphFreeze(JSON.stringify({ ...marked, spotlight: true }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...marked, localDepth: 1 }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...marked, query: 'lattice' }))).toBeNull()
    expect(parseGraphFreeze(JSON.stringify({ ...marked, clusterStack: held.clusterStack }))).toBeNull()
    // …and each of those is fine on its own, with the overlay off.
    expect(parseGraphFreeze(JSON.stringify({ ...marked, landmarks: null, spotlight: true }))).not.toBeNull()
  })

  it('reads the nested field as strictly as the flat ones', () => {
    const bad = (l: unknown): string => JSON.stringify({ ...marked, landmarks: l })
    expect(parseGraphFreeze(bad({ ...marked.landmarks, domain: 4 }))).toBeNull()
    expect(parseGraphFreeze(bad({ ...marked.landmarks, order: 'a' }))).toBeNull()
    expect(parseGraphFreeze(bad({ ...marked.landmarks, chapters: [0, 'two'] }))).toBeNull()
    expect(parseGraphFreeze(bad({ ...marked.landmarks, chapters: [0, -1] }))).toBeNull()
    expect(parseGraphFreeze(bad({ ...marked.landmarks, bloom: 7 }))).toBeNull()
    expect(parseGraphFreeze(bad('alpha'))).toBeNull()
    // A bloom is allowed to be closed; the field missing altogether is a foreign record.
    expect(parseGraphFreeze(bad({ ...marked.landmarks, bloom: null }))).not.toBeNull()
    const without: Record<string, unknown> = { ...marked }
    delete without.landmarks
    expect(parseGraphFreeze(JSON.stringify(without))).toBeNull()
  })

  it('survives text that is not JSON, and a JSON that is not a record', () => {
    expect(parseGraphFreeze('{')).toBeNull()
    expect(parseGraphFreeze('null')).toBeNull()
    expect(parseGraphFreeze('"held"')).toBeNull()
  })
})
