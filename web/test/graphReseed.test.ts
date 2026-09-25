import { describe, it, expect } from 'vitest'
import { reseedPlan, REGROUP_FULL_SHARE } from '../src/lib/graphForces.ts'

const paths = Array.from({ length: 100 }, (_, i) => `wiki/p${i}.md`)
const before = new Map(paths.map((p, i) => [p, i < 60 ? 'alpha' : 'beta']))

describe('reseedPlan (2026-09-24)', () => {
  it('keeps every position when no page changed domain, a filter toggle included', () => {
    expect(reseedPlan(paths, paths.map((p) => before.get(p)!), before)).toEqual({ mode: 'keep' })
    // Half the pages hidden by a filter: still nothing regrouped.
    const shown = paths.slice(0, 50)
    expect(reseedPlan(shown, shown.map((p) => before.get(p)!), before)).toEqual({ mode: 'keep' })
  })

  it('re-seeds exactly the few pages a re-file moved between existing domains', () => {
    const domains = paths.map((p, i) => (i === 3 || i === 4 ? 'beta' : before.get(p)!))
    expect(reseedPlan(paths, domains, before)).toEqual({ mode: 'partial', drop: [3, 4] })
  })

  it('deals afresh when a domain appeared, however few pages moved (a split)', () => {
    const domains = paths.map((p, i) => (i === 7 ? 'gamma' : before.get(p)!))
    expect(reseedPlan(paths, domains, before)).toEqual({ mode: 'full' })
  })

  it('deals afresh when a large share moved between existing domains', () => {
    const moved = Math.ceil(paths.length * REGROUP_FULL_SHARE)
    const domains = paths.map((p, i) => (i < moved ? 'beta' : before.get(p)!))
    expect(reseedPlan(paths, domains, before).mode).toBe('full')
  })

  it('does not count a page it has never laid out as moved', () => {
    const more = [...paths, 'wiki/new.md']
    expect(reseedPlan(more, more.map((p) => before.get(p) ?? 'gamma'), before)).toEqual({ mode: 'keep' })
  })
})
