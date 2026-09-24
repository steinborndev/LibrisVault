import { describe, it, expect } from 'vitest'
import {
  fitTransform,
  ZOOM_MAX,
  FIT_LABEL_GAP_PX,
  FIT_LABEL_LINE_PX,
  MAGNET_REACH_PX,
  WHEEL_MAX_DELTA_PX,
  centerOn,
  fullyInView,
  leash,
  localAnchor,
  magnetAnchor,
  nearestMass,
  normalizeWheel,
  toScreen,
  toWorld,
  visibleNodes,
  wheelFactor,
  worldBounds,
  zoomAt,
  type ClusterGeom,
  type Transform,
} from '../src/lib/graphZoom.ts'

const vp = { w: 800, h: 500 }
const fresh = (): Transform => ({ x: 0, y: 0, k: 1 })

/** A square community of side `size` around (cx, cy), with a matching hull. */
function cluster(id: number, cx: number, cy: number, size: number): ClusterGeom {
  const h = size / 2
  const members: Array<[number, number]> = [
    [cx - h, cy - h],
    [cx + h, cy - h],
    [cx + h, cy + h],
    [cx - h, cy + h],
    [cx, cy],
  ]
  return { id, members, hull: members.slice(0, 4), cx, cy, extent: size }
}

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const t = fresh()
    const before = toWorld(t, vp, 600, 100)
    zoomAt(t, vp, 600, 100, 2.5)
    const after = toWorld(t, vp, 600, 100)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(t.k).toBe(2.5)
  })
})

describe('the tamed wheel', () => {
  it('normalizes line and page modes to pixels and caps a flick', () => {
    expect(normalizeWheel(3, 1, 500)).toBe(48)
    expect(normalizeWheel(1, 2, 500)).toBe(WHEEL_MAX_DELTA_PX)
    expect(normalizeWheel(-900, 0, 500)).toBe(-WHEEL_MAX_DELTA_PX)
    expect(normalizeWheel(100, 0, 500)).toBe(100)
  })
  it('zooms in on wheel-up by about 10 % per notch', () => {
    expect(wheelFactor(-100)).toBeCloseTo(1.105, 3)
    expect(wheelFactor(100)).toBeCloseTo(0.905, 3)
  })
})

describe('the leash', () => {
  const bounds = { x0: -300, y0: -200, x1: 300, y1: 200 }

  it('leaves a centered, fitting graph alone', () => {
    const t = fresh()
    leash(t, vp, bounds)
    expect(t).toEqual({ x: 0, y: 0, k: 1 })
  })

  it('pulls a graph that drifted off the left edge back to 60 % overlap', () => {
    const t = { x: -900, y: 0, k: 1 } // the whole box is left of the picture
    leash(t, vp, bounds)
    const a = toScreen(t, vp, bounds.x0, 0)
    const b = toScreen(t, vp, bounds.x1, 0)
    const boxW = b.x - a.x + 80 // padded
    const overlap = Math.min(b.x + 40, vp.w) - Math.max(a.x - 40, 0)
    expect(overlap).toBeCloseTo(0.6 * Math.min(boxW, vp.w), 5)
    expect(t.y).toBe(0)
  })

  it('keeps the picture inside a graph that is larger than it', () => {
    const t = { x: 0, y: 0, k: 4 } // the box is 2400 x 1600 on screen, the picture inside it
    leash(t, vp, bounds)
    expect(t).toEqual({ x: 0, y: 0, k: 4 })
    // Pan until the picture would leave the box entirely - the leash holds it at 60 %.
    const far = { x: 4000, y: 0, k: 4 }
    leash(far, vp, bounds)
    const b = toScreen(far, vp, bounds.x1, 0)
    expect(b.x + 160).toBeGreaterThanOrEqual(0.6 * vp.w - 1e-6)
  })

  it('does nothing without placed nodes', () => {
    const t = { x: 5, y: 6, k: 1 }
    leash(t, vp, null)
    expect(t).toEqual({ x: 5, y: 6, k: 1 })
  })
})

describe('the magnet', () => {
  const clusters = [cluster(1, -200, 0, 80), cluster(2, 250, 100, 60)]

  it('aims at the cluster center when the cursor is inside its hull', () => {
    const t = fresh()
    const a = magnetAnchor(t, vp, vp.w / 2 - 190, vp.h / 2 + 10, clusters)
    expect(a.clusterId).toBe(1)
    expect(a.weight).toBe(1)
    expect(a.x).toBeCloseTo(vp.w / 2 - 200)
    expect(a.y).toBeCloseTo(vp.h / 2)
  })

  it('pulls partially within reach and not at all beyond it', () => {
    const t = fresh()
    // 80 px right of cluster 2's top-right member, level with it: half way into the reach.
    const sx = vp.w / 2 + 250 + 30 + MAGNET_REACH_PX / 2
    const sy = vp.h / 2 + 70
    const a = magnetAnchor(t, vp, sx, sy, clusters)
    expect(a.clusterId).toBe(2)
    expect(a.weight).toBeCloseTo(0.5)
    expect(a.x).toBeCloseTo(sx + (vp.w / 2 + 250 - sx) * 0.5)
    const far = magnetAnchor(t, vp, vp.w / 2 + 250 + 30 + MAGNET_REACH_PX + 5, sy, clusters)
    expect(far.clusterId).toBeNull()
    expect(far.x).toBe(vp.w / 2 + 250 + 30 + MAGNET_REACH_PX + 5)
  })

  it('hands the anchor back to the cursor once the cluster fills the picture', () => {
    // At k = 8 cluster 1 spans 640 px on a 500 px tall picture: fine work, cursor rules.
    const t = { x: 200 * 8, y: 0, k: 8 } // cluster 1 centered
    const a = magnetAnchor(t, vp, vp.w / 2 + 30, vp.h / 2 - 20, clusters)
    expect(a.weight).toBe(0)
    expect(a.x).toBe(vp.w / 2 + 30)
    expect(a.clusterId).toBeNull()
  })

  it('falls back to the nodes within reach when there are no communities', () => {
    const t = fresh()
    const positions = new Float32Array([100, 0, 120, 0, 110, 10, Number.NaN, Number.NaN])
    const near = localAnchor(t, vp, vp.w / 2 + 60, vp.h / 2, positions)
    expect(near.weight).toBe(1)
    expect(near.x).toBeGreaterThan(vp.w / 2 + 60)
    expect(near.x).toBeLessThan(vp.w / 2 + 120)
    const alone = localAnchor(t, vp, 10, 10, positions)
    expect(alone.weight).toBe(0)
    expect(alone.x).toBe(10)
  })
})

describe('the way back', () => {
  const positions = new Float32Array([-300, -200, 300, 200, 0, 0, Number.NaN, Number.NaN])

  it('counts placed and visible nodes and knows when the whole graph fits', () => {
    const t = fresh()
    expect(visibleNodes(t, vp, positions)).toEqual({ placed: 3, inView: 3 })
    expect(fullyInView(t, vp, worldBounds(positions))).toBe(true)
    const off = { x: 3000, y: 0, k: 1 }
    expect(visibleNodes(off, vp, positions).inView).toBe(0)
    expect(fullyInView(off, vp, worldBounds(positions))).toBe(false)
  })

  it('heads for the nearest cluster center, or the nearest node without communities', () => {
    const t = { x: -250, y: -100, k: 1 } // the picture's center sits at world (250, 100)
    const clusters = [cluster(1, -200, 0, 80), cluster(2, 250, 100, 60)]
    expect(nearestMass(t, vp, clusters, positions)).toEqual({ x: 250, y: 100 })
    expect(nearestMass(t, vp, [], positions)).toEqual({ x: 300, y: 200 })
    const to = centerOn(t, 250, 100)
    const centered = { ...t, ...to }
    const s = toScreen(centered, vp, 250, 100)
    expect(s.x).toBeCloseTo(vp.w / 2)
    expect(s.y).toBeCloseTo(vp.h / 2)
  })
})

describe('the fit', () => {
  const margins = { x: 16, top: 18, bottom: 24 }
  const view = { w: 800, h: 600 }
  /** The screen box of every circle and title under `t`. */
  const screenBox = (t: { x: number; y: number; k: number }, items: Parameters<typeof fitTransform>[0]): [number, number, number, number] => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const it of items) {
      const c = toScreen(t, view, it.x, it.y)
      const side = Math.max(it.r * t.k, it.labelHalf)
      x0 = Math.min(x0, c.x - side)
      x1 = Math.max(x1, c.x + side)
      y0 = Math.min(y0, c.y - it.r * t.k)
      y1 = Math.max(y1, c.y + it.r * t.k + (it.labelHalf > 0 ? FIT_LABEL_GAP_PX + FIT_LABEL_LINE_PX : 0))
    }
    return [x0, y0, x1, y1]
  }

  it('keeps a long title at the edge inside the picture, and centres the box it makes', () => {
    // A long title on the left, a short one on the right: the flat pad cut the first and
    // left the picture off-centre.
    const items = [
      { x: -300, y: 0, r: 12, labelHalf: 85 },
      { x: 300, y: 0, r: 12, labelHalf: 20 },
      { x: 0, y: -200, r: 12, labelHalf: 40 },
      { x: 0, y: 200, r: 12, labelHalf: 40 },
    ]
    const t = fitTransform(items, view, margins)!
    const [x0, y0, x1, y1] = screenBox(t, items)
    expect(x0).toBeGreaterThanOrEqual(margins.x - 1e-3)
    expect(x1).toBeLessThanOrEqual(view.w - margins.x + 1e-3)
    expect(y0).toBeGreaterThanOrEqual(margins.top - 1e-3)
    expect(y1).toBeLessThanOrEqual(view.h - margins.bottom + 1e-3)
    // It uses the room: one side is tight, and the free room left and right is equal.
    expect(Math.min(x0 - margins.x, y0 - margins.top)).toBeLessThan(0.5)
    expect(x0 - margins.x).toBeCloseTo(view.w - margins.x - x1, 3)
  })

  it('puts a centre in the middle of the picture and still fits everything', () => {
    const items = [
      { x: 0, y: 0, r: 5, labelHalf: 30 },
      { x: 400, y: 0, r: 5, labelHalf: 30 },
      { x: 400, y: 100, r: 5, labelHalf: 0 },
    ]
    const t = fitTransform(items, view, margins, [0, 0])!
    const c = toScreen(t, view, 0, 0)
    expect(c.x).toBeCloseTo(view.w / 2)
    expect(c.y).toBeCloseTo(margins.top + (view.h - margins.top - margins.bottom) / 2)
    const [x0, , x1] = screenBox(t, items)
    expect(x0).toBeGreaterThanOrEqual(margins.x - 1e-3)
    expect(x1).toBeLessThanOrEqual(view.w - margins.x + 1e-3)
  })

  it('caps the zoom on a single node and frames nothing when given nothing', () => {
    expect(fitTransform([{ x: 5, y: 5, r: 3, labelHalf: 20 }], view, margins)!.k).toBe(ZOOM_MAX)
    expect(fitTransform([], view, margins)).toBeNull()
  })
})
