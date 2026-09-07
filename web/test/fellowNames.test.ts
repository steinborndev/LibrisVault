/**
 * Suggesting a Fellow's name (web/src/lib/fellowNames.ts). The rule is a reading aid - the
 * name shares its initial with the domain - and the awkward cases are the ones worth pinning:
 * several Fellows in one domain, several domains on one letter, and a letter with no list.
 */

import { describe, it, expect } from 'vitest'
import { suggestFellowName } from '../src/lib/fellowNames.ts'

describe('suggesting a name', () => {
  it('shares the first letter with the domain', () => {
    expect(suggestFellowName('astronomy')).toBe('Ada')
    expect(suggestFellowName('biomedicine')).toBe('Beatrice')
    expect(suggestFellowName('materials-science')).toBe('Mira')
  })

  it('keeps the letter when a domain already has a Fellow, so a second one still reads right', () => {
    expect(suggestFellowName('astronomy', ['Ada'])).toBe('Alan')
    expect(suggestFellowName('astronomy', ['Ada', 'Alan'])).toBe('Amara')
  })

  it('counts Fellows of the OTHER domains on the same letter, because a name is unique service-wide', () => {
    // Four of this vault's domains start with "c"; the spawn endpoint refuses a duplicate slug.
    expect(suggestFellowName('cooking', ['Clara'])).toBe('Casper')
    expect(suggestFellowName('cryptography', ['Clara', 'Casper'])).toBe('Cecilia')
  })

  it('ignores case and stray whitespace in what is taken', () => {
    expect(suggestFellowName('astronomy', ['  ada  '])).toBe('Alan')
  })

  it('numbers the letter rather than leaving it once every name on it is out', () => {
    const all = ['Ada', 'Alan', 'Amara', 'Arthur', 'Alice', 'Adrian', 'Astrid', 'August']
    expect(suggestFellowName('astronomy', all)).toBe('Ada 2')
    expect(suggestFellowName('astronomy', [...all, 'Ada 2'])).toBe('Ada 3')
  })

  it('still answers for a domain whose letter has no list of its own', () => {
    const out = suggestFellowName('3d-printing')
    expect(out).not.toBe('')
    expect(suggestFellowName('3d-printing', [out])).not.toBe(out)
  })

  it('answers with nothing when no domain is chosen, so the field stays empty', () => {
    expect(suggestFellowName('')).toBe('')
    expect(suggestFellowName('   ')).toBe('')
  })
})
