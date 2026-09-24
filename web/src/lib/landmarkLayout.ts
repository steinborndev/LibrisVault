/**
 * The landmarks overview's own drawing aids (2026-09-24, chosen among three rendered variants):
 * titles wrapped instead of cut, a caption that looks for a free spot around its dot, and a
 * display-only spread that evens out where forty landmarks of a 500-page layout happen to sit. Pure: the canvas feeds
 * sizes and positions in and reads boxes and positions out.
 */

export type Box = [number, number, number, number]

/**
 * A title in at most `maxLines` lines of at most `maxW` (the measure's unit), broken at spaces
 * and hyphens; a word longer than a line is cut, and a title that still does not fit ends in an
 * ellipsis on its last line.
 */
export function wrapTitle(title: string, maxW: number, maxLines: number, measure: (s: string) => number): string[] {
  const words = title.split(/(?<=[\s-])/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const next = line + w
    if (measure(next.trimEnd()) <= maxW || line === '') line = next
    else {
      lines.push(line.trimEnd())
      line = w
    }
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && line !== '') lines.push(line.trimEnd())
  const used = lines.join(' ').replace(/\s+/g, ' ')
  const whole = title.replace(/\s+/g, ' ')
  if (used.length < whole.length || measure(lines[lines.length - 1] ?? '') > maxW) {
    let last = lines[lines.length - 1] ?? ''
    while (last.length > 1 && measure(`${last}…`) > maxW) last = last.slice(0, -1)
    lines[lines.length - 1] = `${last.trimEnd()}…`
  }
  return lines
}

const overlap = (a: Box, b: Box): number => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
  return w > 0 && h > 0 ? w * h : 0
}

const discOverlap = (b: Box, d: { x: number; y: number; r: number }): number => {
  const nx = Math.max(b[0], Math.min(d.x, b[2]))
  const ny = Math.max(b[1], Math.min(d.y, b[3]))
  return (nx - d.x) ** 2 + (ny - d.y) ** 2 < d.r * d.r ? d.r * d.r : 0
}

/**
 * Where a caption of size w x h goes around a dot: below first (the resting labels' place),
 * then above, right, left and the four diagonals. The first spot that touches no placed caption
 * and no other dot wins; when none is free, the one covering least - a landmark's caption is
 * never dropped.
 */
export function placeAround(
  x: number,
  y: number,
  r: number,
  w: number,
  h: number,
  gap: number,
  placed: readonly Box[],
  discs: ReadonlyArray<{ x: number; y: number; r: number }>,
  /** The visible world rectangle: a caption that would leave it is the last resort. */
  view: Box | null = null,
): Box {
  const g = r + gap
  const spots: Box[] = [
    [x - w / 2, y + g, x + w / 2, y + g + h],
    [x - w / 2, y - g - h, x + w / 2, y - g],
    [x + g, y - h / 2, x + g + w, y + h / 2],
    [x - g - w, y - h / 2, x - g, y + h / 2],
    [x + g * 0.7, y + g * 0.7, x + g * 0.7 + w, y + g * 0.7 + h],
    [x - g * 0.7 - w, y + g * 0.7, x - g * 0.7, y + g * 0.7 + h],
    [x + g * 0.7, y - g * 0.7 - h, x + g * 0.7 + w, y - g * 0.7],
    [x - g * 0.7 - w, y - g * 0.7 - h, x - g * 0.7, y - g * 0.7],
  ]
  let best = spots[0]!
  let bestCost = Infinity
  for (const s of spots) {
    let cost = 0
    for (const p of placed) cost += overlap(s, p) * 4
    for (const d of discs) if (!(d.x === x && d.y === y)) cost += discOverlap(s, d)
    if (view !== null && (s[0] < view[0] || s[1] < view[1] || s[2] > view[2] || s[3] > view[3])) cost += 1e12
    if (cost === 0) return s
    if (cost < bestCost) {
      bestCost = cost
      best = s
    }
  }
  return best
}

/**
 * A display-only spread of the overview's points. Worked out in SCREEN pixels, because the
 * captions are screen-sized: each axis is blended toward its RANK (clumps open up, left stays
 * left and top stays top), stretched over the whole drawing area, and a relaxation then pushes
 * apart any two dots whose rectangles - dot plus its caption below - overlap, clamped inside the
 * area so the height gets used as well as the width. The result is handed back in world units
 * at one zoom `k0`, so the fit that frames it lands on about that zoom and every caption has the
 * room it was given. The layout itself is never touched.
 */
export function spreadPoints(
  pts: ReadonlyArray<{ i: number; x: number; y: number; r: number }>,
  caption: (i: number) => { w: number; h: number },
  vp: { w: number; h: number },
  margins: { x: number; top: number; bottom: number },
  blend = 0.8,
): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>()
  const n = pts.length
  if (n < 3) {
    for (const p of pts) out.set(p.i, [p.x, p.y])
    return out
  }
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  const rankOf = (vals: number[]): number[] => {
    const order = vals.map((v, j) => [v, j] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const r = new Array<number>(vals.length)
    order.forEach(([, j], k) => (r[j] = k / (vals.length - 1)))
    return r
  }
  const rx = rankOf(xs)
  const ry = rankOf(ys)
  const W = vp.w - 2 * margins.x
  const H = vp.h - margins.top - margins.bottom
  // The zoom the points are handed back at: the original extent fitted into the area.
  const k0 = Math.min(W / Math.max(1, x1 - x0), H / Math.max(1, y1 - y0))
  const at = pts.map((p, j) => {
    const c = caption(p.i)
    const rs = p.r * k0
    return {
      i: p.i,
      rs,
      half: Math.max(rs, c.w / 2) + 6,
      below: rs + 3 + c.h + 6,
      x: 0,
      y: 0,
      u: (1 - blend) * ((p.x - x0) / Math.max(1e-9, x1 - x0)) + blend * rx[j]!,
      v: (1 - blend) * ((p.y - y0) / Math.max(1e-9, y1 - y0)) + blend * ry[j]!,
    }
  })
  const clamp = (a: (typeof at)[number]): void => {
    a.x = Math.min(Math.max(a.x, a.half), W - a.half)
    a.y = Math.min(Math.max(a.y, a.rs + 4), H - a.below)
  }
  for (const a of at) {
    a.x = a.half + a.u * Math.max(0, W - 2 * a.half)
    a.y = a.rs + 4 + a.v * Math.max(0, H - a.rs - 4 - a.below)
  }
  const rect = (a: (typeof at)[number]): Box => [a.x - a.half, a.y - a.rs - 4, a.x + a.half, a.y + a.below]
  for (let it = 0; it < 400; it++) {
    let moved = false
    for (let a = 0; a < at.length; a++) {
      for (let b = a + 1; b < at.length; b++) {
        const A = at[a]!
        const B = at[b]!
        const ra = rect(A)
        const rb = rect(B)
        const ox = Math.min(ra[2], rb[2]) - Math.max(ra[0], rb[0])
        const oy = Math.min(ra[3], rb[3]) - Math.max(ra[1], rb[1])
        if (ox <= 0 || oy <= 0) continue
        moved = true
        // Along whichever axis costs less of the room there is: captions are wide, and always
        // pushing sideways spends the width and leaves the height empty.
        if (ox / W < oy / H) {
          const d = (ox / 2 + 0.5) * (A.x <= B.x ? -1 : 1)
          A.x += d
          B.x -= d
        } else {
          const d = (oy / 2 + 0.5) * (A.y <= B.y ? -1 : 1)
          A.y += d
          B.y -= d
        }
        clamp(A)
        clamp(B)
      }
    }
    if (!moved) break
  }
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  for (const a of at) out.set(a.i, [cx + (a.x - W / 2) / k0, cy + (a.y - H / 2) / k0])
  return out
}
