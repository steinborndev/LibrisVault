/**
 * What the record and the stream say about a job's quotes (docs/sources/SPEC.md 7.5).
 */

import { describe, expect, it } from 'vitest'
import { parseQuoteSummary, quotesChip, quotesFact, quotesTitle } from '../src/lib/quotes.ts'

const json = (quotes: unknown): string => JSON.stringify({ quotes })

describe('parseQuoteSummary', () => {
  it('reads the column and treats anything unexpected as nothing to say', () => {
    expect(parseQuoteSummary(json({ checked: 12, unverified: 1 }))).toEqual({ checked: 12, unverified: 1 })
    expect(parseQuoteSummary(json({ checked: 0, unverified: 0, note: 'no commit to compare the pages against' }))).toEqual({
      checked: 0,
      unverified: 0,
      note: 'no commit to compare the pages against',
    })
    // An older job, a column written by another build, a truncated value.
    expect(parseQuoteSummary(null)).toBeNull()
    expect(parseQuoteSummary(undefined)).toBeNull()
    expect(parseQuoteSummary('')).toBeNull()
    expect(parseQuoteSummary('{"quotes":')).toBeNull()
    expect(parseQuoteSummary(json({ checked: 'many' }))).toBeNull()
    expect(parseQuoteSummary(JSON.stringify({ somethingElse: true }))).toBeNull()
  })
})

describe('what the reader sees', () => {
  it('states the two numbers, or a dash when nothing was checked', () => {
    expect(quotesFact({ checked: 12, unverified: 1 })).toBe('12 checked · 1 unverified')
    expect(quotesFact({ checked: 12, unverified: 0 })).toBe('12 checked')
    expect(quotesFact({ checked: 0, unverified: 0 })).toBe('-')
    expect(quotesFact(null)).toBe('-')
  })

  it('says why nothing was checked in the tooltip', () => {
    expect(quotesTitle({ checked: 0, unverified: 0, note: 'no readable artifact for this job' })).toMatch(
      /Nothing was checked: no readable artifact/,
    )
    expect(quotesTitle({ checked: 0, unverified: 0 })).toMatch(/no quotation of five words/)
    expect(quotesTitle({ checked: 12, unverified: 1 })).toMatch(/11 of 12 quotation\(s\).*Advisory/)
  })

  it('flags a row only when a quotation did not hold', () => {
    expect(quotesChip({ checked: 12, unverified: 1 })).toBe('1 quote')
    expect(quotesChip({ checked: 12, unverified: 3 })).toBe('3 quotes')
    expect(quotesChip({ checked: 12, unverified: 0 })).toBeNull()
    expect(quotesChip(null)).toBeNull()
  })
})
