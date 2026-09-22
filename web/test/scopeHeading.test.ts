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
    expect(scopeHeading(new Set(['materials']), null, null, 'Carbon Fibre')).toEqual({
      text: 'materials',
      domain: 'materials',
      bloom: 'Carbon Fibre',
    })
    expect(scopeHeading(new Set(), 'Wing A', null, 'Carbon Fibre')).toMatchObject({ text: 'Wing A', bloom: 'Carbon Fibre' })
  })

  it('leaves the field out entirely when nothing is expanded', () => {
    // Absent rather than undefined: the component asks whether the key is there.
    expect('bloom' in scopeHeading(new Set(['materials']), null)).toBe(false)
  })

  it('still lets a tag outrank both', () => {
    const h = scopeHeading(new Set(['materials']), null, { name: 'crystal', around: null }, 'Carbon Fibre')
    expect(h.text).toBe('#crystal')
    expect(h.bloom).toBeUndefined()
  })
})
