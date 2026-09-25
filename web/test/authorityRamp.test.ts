/**
 * The authority lens's colour ramp.
 *
 * Worth its own test because the whole point of the ramp is a property, not an appearance:
 * more backlinks must never be harder to see than fewer, and the difference has to live in
 * the channel a six-pixel dot is actually read by. The version this replaced spanned a
 * quarter of the lightness axis and mixed in raw sRGB, which is why a dense domain came out
 * as one colour with a few bright dots.
 */

import { describe, expect, it } from 'vitest'
import {
  authorityDomain,
  authorityGradient,
  authorityPosition,
  authorityRamp,
  authorityValue,
  inkOnColor,
  isDarkSurface,
  recencyDomain,
  recencyPosition,
  type LandmarkMask,
} from '../src/components/GraphCanvas.tsx'
import type { GraphNode } from '../src/api/types.ts'

const rgb = (css: string): [number, number, number] => {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(css)
  if (m === null) throw new Error(`not an rgb() colour: ${css}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}
/** Relative luminance, which is what "lighter or darker" means to an eye. */
const lum = ([r, g, b]: [number, number, number]): number => {
  const lin = (u: number): number => (u / 255 <= 0.04045 ? u / 255 / 12.92 : ((u / 255 + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const BLUE = '#3059c8'
const steps = (base: string, dark: boolean): number[] =>
  [0, 0.25, 0.5, 0.75, 1].map((t) => lum(rgb(authorityRamp(base, t, dark))))

describe('the authority ramp', () => {
  it('moves monotonically through lightness, in both themes', () => {
    // Light theme: more backlinks, darker page. Dark theme: the other way round. Either way
    // the order is strict - two pages that differ in backlinks differ on the axis.
    const light = steps(BLUE, false)
    expect(light).toEqual([...light].sort((a, b) => b - a))
    expect(new Set(light).size).toBe(light.length)
    const dark = steps(BLUE, true)
    expect(dark).toEqual([...dark].sort((a, b) => a - b))
    expect(new Set(dark).size).toBe(dark.length)
  })

  it('uses most of the lightness axis, not a corner of it', () => {
    // The number that decides whether the lens works. The old ramp managed ~0.15 of relative
    // luminance end to end in the light theme; anything under about half that is a repeat of
    // the bug this replaced.
    for (const dark of [false, true]) {
      const s = steps(BLUE, dark)
      expect(Math.abs(s[s.length - 1]! - s[0]!)).toBeGreaterThan(0.35)
    }
  })

  it('keeps each domain on its own hue', () => {
    // The palette hands out `hsl(...)`, which is the format the ramp has to be able to read -
    // a base it cannot parse would fall back to one colour and collapse every domain into it.
    const a = rgb(authorityRamp('hsl(20 62% 52%)', 0.8, false))
    const b = rgb(authorityRamp('hsl(200 62% 52%)', 0.8, false))
    expect(a).not.toEqual(b)
    // Warm base stays warm (more red than blue), cool base stays cool.
    expect(a[0]).toBeGreaterThan(a[2])
    expect(b[2]).toBeGreaterThan(b[0])
    // ...and both still sit at the same point on the lightness axis, so the hue says WHERE
    // and the lightness says HOW MUCH, without the two reading each other's message.
    expect(Math.abs(lum(a) - lum(b))).toBeLessThan(0.08)
  })

  it('falls back rather than throwing on a colour it cannot read', () => {
    expect(authorityRamp('not a colour', 0.5, false)).toMatch(/^rgb\(/)
  })

  it('renders as a gradient with a stop at each quarter', () => {
    const g = authorityGradient(BLUE, false)
    expect(g.startsWith('linear-gradient(90deg, ')).toBe(true)
    expect(g.match(/rgb\(/g)).toHaveLength(5)
    expect(g).toContain('0%')
    expect(g).toContain('100%')
  })
})

describe('isDarkSurface', () => {
  it('reads the surface colour rather than the media query', () => {
    // Asked of the token in force, so the ramp follows the theme however the theme is chosen.
    expect(isDarkSurface('#131928')).toBe(true)
    expect(isDarkSurface('#ffffff')).toBe(false)
    expect(isDarkSurface('rgb(236, 239, 246)')).toBe(false)
    // Unreadable input assumes dark, which is this app's base theme.
    expect(isDarkSurface('')).toBe(true)
  })
})

describe('what the authority lens counts', () => {
  const nodes = [
    { path: 'a', title: 'a', type: 'concepts', tags: [], domain: 'alpha', in: 40, out: 0 },
    { path: 'b', title: 'b', type: 'concepts', tags: [], domain: 'alpha', in: 13, out: 0 },
  ] satisfies GraphNode[]
  const mask = (inDomain: number[]): LandmarkMask => ({
    landmarks: new Set([0]),
    connectors: new Set<number>(),
    bloom: new Set<number>(),
    bloomAnchor: null,
    inDomain,
  })

  it('reads the vault-wide count with no mask on', () => {
    expect(authorityValue(null, nodes, 0)).toBe(40)
    expect(authorityValue(null, nodes, 1)).toBe(13)
  })

  it('reads the domain-internal count the mask hands in', () => {
    // The machine-learning finding as a case: a page with backlinks over the vault and none
    // inside its own domain is not an authority OF that domain, and the lens has to say so.
    expect(authorityValue(mask([7, 0]), nodes, 0)).toBe(7)
    expect(authorityValue(mask([7, 0]), nodes, 1)).toBe(0)
  })

  it('falls back on a missing entry, never on a zero', () => {
    // The trap this guards: `||` would read "no backlinks inside the domain" as "nobody said"
    // and silently colour the page by its vault count instead.
    expect(authorityValue(mask([5]), nodes, 1)).toBe(13)
    expect(authorityValue(mask([0, 0]), nodes, 0)).toBe(0)
  })

  it('answers for a node nothing knows about', () => {
    expect(authorityValue(null, nodes, 9)).toBe(0)
  })

  it('spans the ramp over what the mask paints, not over the whole domain', () => {
    // The landmarks are the domain's most-linked pages: over the domain they all sat at the top
    // of the ramp in one colour (2026-09-25). Only the painted page counts here.
    expect(authorityDomain(mask([7, 3]), nodes, 2)).toEqual([7])
    expect(authorityDomain(null, nodes, 2)).toEqual([13, 40])
    expect(authorityDomain(null, nodes, 2, new Set([0]))).toEqual([13])
  })
})

describe('recency over what the Landmarks mode paints', () => {
  const day = 86_400_000
  const now = Date.UTC(2026, 8, 25)
  const nodes = [
    { path: 'a', title: 'a', type: 'concepts', tags: [], domain: 'alpha', in: 1, out: 0, freshMs: now - 400 * day },
    { path: 'b', title: 'b', type: 'concepts', tags: [], domain: 'alpha', in: 1, out: 0, freshMs: now - 200 * day },
    { path: 'c', title: 'c', type: 'concepts', tags: [], domain: 'alpha', in: 1, out: 0, freshMs: now - 100 * day },
  ] satisfies GraphNode[]
  const all: LandmarkMask = {
    landmarks: new Set([0, 1, 2]),
    connectors: new Set<number>(),
    bloom: new Set<number>(),
    bloomAnchor: null,
    inDomain: [1, 1, 1],
  }

  it('keeps the fixed window without the mode: all three are older than it', () => {
    expect(recencyDomain(null, nodes, 3)).toBeNull()
    for (const n of nodes) expect(recencyPosition(n.freshMs, now, null)).toBe(0)
  })

  it('spreads the pages on show over the whole ramp in the mode, oldest to newest', () => {
    const sorted = recencyDomain(all, nodes, 3)!
    expect(sorted).toEqual([now - 400 * day, now - 200 * day, now - 100 * day])
    const t = nodes.map((n) => recencyPosition(n.freshMs, now, sorted))
    expect(t[0]).toBe(0)
    expect(t[2]).toBe(1)
    expect(t[1]).toBeGreaterThan(t[0]!)
    expect(t[1]).toBeLessThan(t[2]!)
  })
})

describe('the shared palette helpers', () => {
  it('places a count on the authority ramp without a domain at 0', () => {
    expect(authorityPosition(null, 12)).toBe(0)
    expect(authorityPosition([9, 12, 31], 31)).toBe(1)
    expect(authorityPosition([9, 12, 31], 9)).toBe(0)
  })

  it('inks a fill white, with the ground or with the text colour, whichever reads', () => {
    expect(inkOnColor('#1a3a8a', ['#ffffff', '#1a2333'])).toBe('#ffffff')
    expect(inkOnColor('#e8eef8', ['#0f1420', '#e6e9f0'])).toBe('#0f1420')
    // A pale disc on the light theme: white and the ground are both pale, the text colour reads.
    expect(inkOnColor('#dce8f0', ['#f7f8fb', '#1a2333'])).toBe('#1a2333')
    expect(inkOnColor('var(--x)', ['#ffffff'])).toBeNull()
  })
})
