import { describe, expect, it } from 'vitest'
import { scopeHeading } from '../src/lib/scopeHeading.ts'

describe('scopeHeading', () => {
  it('names the one selected domain and colours the dot with it', () => {
    expect(scopeHeading(new Set(['materials']), 'Main room')).toEqual({ text: 'materials', domain: 'materials' })
  })

  it('says "no domain" for the empty key and keeps that key for the dot', () => {
    expect(scopeHeading(new Set(['']), null)).toEqual({ text: 'no domain', domain: '' })
  })

  it('counts several selected domains, with no one colour', () => {
    expect(scopeHeading(new Set(['a', 'b']), 'Main room')).toEqual({ text: '2 domains', domain: null })
  })

  it('names the wing in front when nothing is picked and the list is by wing', () => {
    expect(scopeHeading(new Set(), 'Wing A')).toEqual({ text: 'Wing A', domain: null })
  })

  it('says "all domains" when nothing is picked and no wing narrows the view', () => {
    expect(scopeHeading(new Set(), null)).toEqual({ text: 'all domains', domain: null })
  })

  it('names an open neighbourhood after the heading, whatever the heading is', () => {
    // It REFINES rather than replaces: the reader has narrowed the drawing around one page and
    // wants to know which, without looking away from it.
    expect(scopeHeading(new Set(['alpha']), null, null, 'Page Alpha')).toEqual({
      text: 'alpha',
      domain: 'alpha',
      bloom: 'Page Alpha',
    })
    expect(scopeHeading(new Set(), 'Wing A', null, 'Page Alpha')).toMatchObject({ text: 'Wing A', bloom: 'Page Alpha' })
  })

  it('leaves the field out entirely when nothing is expanded', () => {
    // Absent rather than undefined: the component asks whether the key is there.
    expect('bloom' in scopeHeading(new Set(['alpha']), null)).toBe(false)
  })

  it('still lets a tag outrank both', () => {
    const h = scopeHeading(new Set(['alpha']), null, { name: 'crystal', around: null }, 'Page Alpha')
    expect(h.text).toBe('#crystal')
    expect(h.bloom).toBeUndefined()
  })
})
