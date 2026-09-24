import { describe, expect, it } from 'vitest'
import {
  HULL_PAD,
  SPOT_FADE_MS,
  SPOT_HIDE_DELAY_MS,
  SPOT_IDLE,
  SPOT_SHOW_DELAY_MS,
  buildSpotGeoms,
  paddedPart,
  splitParts,
  placeSpotLabel,
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

  it('tests the smoothed outline that is drawn, not the polygon behind it', () => {
    // The outline is the drawn curve sampled back into a polygon, and never reaches past the
    // padded polygon it rounds off.
    expect(smoothOutline(g0.padded).length).toBe(g0.padded.length * 6)
    const [px0, , px1] = [Math.min(...g0.padded.map((p) => p[0])), 0, Math.max(...g0.padded.map((p) => p[0]))]
    for (const [x] of g0.hull) {
      expect(x).toBeGreaterThanOrEqual(px0 - 1e-9)
      expect(x).toBeLessThanOrEqual(px1 + 1e-9)
    }
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

describe('where the spotlight label goes', () => {
  const hull: Array<[number, number]> = [[0, 100], [100, 100], [100, 200], [0, 200]]
  const view = [-500, -500, 500, 500] as const

  it('sits a gap above the highest of the outline and the member nodes', () => {
    const box = placeSpotLabel(hull, [{ x: 50, y: 90, r: 20 }], 80, 20, 8, view)!
    // The node reaches up to y = 70, above the outline's top at 100.
    expect(box[3]).toBe(70 - 8)
    expect((box[0] + box[2]) / 2).toBe(50)
  })

  it('goes below when above would leave the frame', () => {
    const box = placeSpotLabel(hull, [], 80, 20, 8, [-500, 90, 500, 500])!
    expect(box[1]).toBe(200 + 8)
  })
})

describe('an area holds every one of its members', () => {
  it('draws a community the layout keeps in two places as two parts, each member inside one', () => {
    // A body of eight pages and a group of four far above it: the old outlier trim dropped
    // the four from the area altogether.
    const body: Array<[number, number]> = Array.from({ length: 8 }, (_, i) => [(i % 4) * 40, Math.floor(i / 4) * 40])
    const far: Array<[number, number]> = [[40, -900], [80, -900], [40, -860], [80, -860]]
    const pts = [...body, ...far]
    const [g] = buildSpotGeoms(pts.map(() => 0), flat(pts), pts.length, () => true)
    expect(g!.parts).toHaveLength(2)
    for (const [x, y] of pts) expect(g!.parts.some((p) => pointInPolygon(x, y, p.outline))).toBe(true)
    // The empty stretch between the two is not tinted.
    expect(g!.parts.some((p) => pointInPolygon(60, -450, p.outline))).toBe(false)
  })

  it('keeps one compact community as one part', () => {
    const pts: Array<[number, number]> = Array.from({ length: 9 }, (_, i) => [(i % 3) * 50, Math.floor(i / 3) * 50])
    expect(splitParts(pts)).toHaveLength(1)
  })

  it('pads a lone member far from the rest with a disc of its own', () => {
    const pts: Array<[number, number]> = [[0, 0], [30, 0], [0, 30], [30, 30], [1000, 0]]
    const parts = splitParts(pts)
    expect(parts.map((p) => p.length)).toEqual([4, 1])
    const disc = paddedPart(parts[1]!)
    expect(pointInPolygon(1000 + HULL_PAD * 0.9, 0, disc)).toBe(true)
    expect(pointInPolygon(1000 + HULL_PAD * 1.1, 0, disc)).toBe(false)
  })
})
