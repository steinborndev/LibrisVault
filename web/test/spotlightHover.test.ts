import { describe, expect, it } from 'vitest'
import {
  HULL_PAD,
  SPOT_FADE_MS,
  SPOT_HIDE_DELAY_MS,
  SPOT_IDLE,
  SPOT_SHOW_DELAY_MS,
  buildSpotGeoms,
  pointInPolygon,
  resolveAreaCid,
  smoothOutline,
  spotAlpha,
  tickSpot,
  wantSpot,
} from '../src/lib/spotlightHover.ts'

/** Positions as the canvas holds them: x0, y0, x1, y1, ... */
const flat = (pts: Array<[number, number]>): Float32Array => new Float32Array(pts.flat())

describe('one geometry for drawing and pointing', () => {
  // Two squares of four pages, the second inside the first's padding on one side.
  const pts: Array<[number, number]> = [
    [0, 0], [100, 0], [100, 100], [0, 100],
    [400, 0], [500, 0], [500, 100], [400, 100],
  ]
  const clusters = [0, 0, 0, 0, 1, 1, 1, 1]
  const geoms = buildSpotGeoms(clusters, flat(pts), pts.length, () => true)
  const g0 = geoms.find((g) => g.id === 0)!

  it('pads by the world distance, at any zoom', () => {
    // A point just inside the drawn padding answers; one past it does not.
    expect(pointInPolygon(-HULL_PAD * 0.5, 50, g0.hull)).toBe(true)
    expect(pointInPolygon(-HULL_PAD * 1.2, 50, g0.hull)).toBe(false)
  })

  it('tests the smoothed outline, not the corners it rounds off', () => {
    const corner = g0.padded.reduce((a, p) => (p[0] + p[1] < a[0] + a[1] ? p : a))
    // The padded polygon's own corner lies outside the curve that is drawn through it.
    expect(pointInPolygon(corner[0] + 1, corner[1] + 1, g0.hull)).toBe(false)
    expect(smoothOutline(g0.padded).length).toBe(g0.padded.length * 6)
  })

  it('wraps only what is painted', () => {
    const only = buildSpotGeoms(clusters, flat(pts), pts.length, (i) => i !== 2)
    expect(only.find((g) => g.id === 0)!.members).toHaveLength(3)
  })
})

describe('which community the pointer is in', () => {
  // A big community and a small one inside it.
  const pts: Array<[number, number]> = [
    [0, 0], [300, 0], [300, 300], [0, 300],
    [120, 120], [180, 120], [180, 180], [120, 180],
  ]
  const clusters = [0, 0, 0, 0, 1, 1, 1, 1]
  const geoms = buildSpotGeoms(clusters, flat(pts), pts.length, () => true)
  const any = (): boolean => true

  it('picks the smallest containing hull when entering an overlap', () => {
    expect(resolveAreaCid(150, 150, geoms, any, null)).toBe(1)
    expect(resolveAreaCid(40, 40, geoms, any, null)).toBe(0)
  })

  it('keeps the community already on show while the pointer is still inside it', () => {
    expect(resolveAreaCid(150, 150, geoms, any, 0)).toBe(0)
  })

  it('never offers what cannot be isolated', () => {
    expect(resolveAreaCid(150, 150, geoms, (cid) => cid !== 1, null)).toBe(0)
    expect(resolveAreaCid(1000, 1000, geoms, any, null)).toBe(-1)
  })
})

describe('when the spotlight shows', () => {
  it('shows a node hover at once and an area hover after a beat', () => {
    const node = wantSpot(SPOT_IDLE, 3, true, 0)
    expect(spotAlpha(node, SPOT_FADE_MS)).toBe(1)
    const area = wantSpot(SPOT_IDLE, 3, false, 0)
    expect(area.pending?.at).toBe(SPOT_SHOW_DELAY_MS)
    expect(spotAlpha(area, 10)).toBe(0)
    const shown = tickSpot(area, SPOT_SHOW_DELAY_MS)
    expect(spotAlpha(shown, SPOT_SHOW_DELAY_MS + SPOT_FADE_MS)).toBe(1)
  })

  it('lingers when the pointer leaves, and a return cancels the exit', () => {
    const on = wantSpot(SPOT_IDLE, 3, true, 0)
    const leaving = wantSpot(on, -1, false, 500)
    expect(leaving.pending?.at).toBe(500 + SPOT_HIDE_DELAY_MS)
    const back = wantSpot(leaving, 3, false, 550)
    expect(back.pending).toBeNull()
    expect(spotAlpha(tickSpot(back, 2000), 2000)).toBe(1)
    const gone = tickSpot(leaving, 500 + SPOT_HIDE_DELAY_MS)
    expect(spotAlpha(gone, 500 + SPOT_HIDE_DELAY_MS + SPOT_FADE_MS)).toBe(0)
  })

  it('switches straight from one community to the next', () => {
    const on = wantSpot(SPOT_IDLE, 3, true, 0)
    const next = wantSpot(on, 4, false, 400)
    expect(next.cid).toBe(4)
    expect(spotAlpha(next, 400)).toBe(1)
  })
})
