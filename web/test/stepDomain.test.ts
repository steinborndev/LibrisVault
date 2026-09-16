/**
 * Walking the flat domain list with the arrow keys. Tested here rather than through the panel
 * because the three rules that make it more than an index walk are all edge cases - both ends
 * and a multi-selection - and a click-through can only show one of them at a time.
 */

import { describe, expect, it } from 'vitest'
import { stepDomain } from '../src/lib/wings.ts'

const ROWS = ['ai', 'bio', 'cooking', 'finance']
const sel = (...d: string[]): ReadonlySet<string> => new Set(d)

describe('stepping through the flat domain list', () => {
  it('walks one domain at a time', () => {
    expect(stepDomain(ROWS, sel('bio'), 1)).toEqual({ pick: 'cooking' })
    expect(stepDomain(ROWS, sel('bio'), -1)).toEqual({ pick: 'ai' })
  })

  it('enters the list from the left end, with nothing selected', () => {
    // Right picks the first domain; left is already at "all domains" and stays there.
    expect(stepDomain(ROWS, sel(), 1)).toEqual({ pick: 'ai' })
    expect(stepDomain(ROWS, sel(), -1)).toBeNull()
  })

  it('leaves the list at the left end and holds at the right', () => {
    expect(stepDomain(ROWS, sel('ai'), -1)).toBe('clear')
    expect(stepDomain(ROWS, sel('finance'), 1)).toBeNull()
  })

  it('takes the LAST selected row as the anchor', () => {
    // A set built by clicking collapses to one domain, continuing past its far end.
    expect(stepDomain(ROWS, sel('ai', 'cooking'), 1)).toEqual({ pick: 'finance' })
    expect(stepDomain(ROWS, sel('ai', 'cooking'), -1)).toEqual({ pick: 'bio' })
  })

  it('ignores a selection the list does not hold', () => {
    // A domain filtered out from under the selection leaves no anchor: the walk starts over.
    expect(stepDomain(ROWS, sel('gone'), 1)).toEqual({ pick: 'ai' })
    expect(stepDomain(ROWS, sel('gone'), -1)).toBeNull()
  })

  it('does nothing with an empty list', () => {
    expect(stepDomain([], sel(), 1)).toBeNull()
    expect(stepDomain([], sel('ai'), -1)).toBeNull()
  })
})
