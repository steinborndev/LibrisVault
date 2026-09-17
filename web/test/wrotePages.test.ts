/**
 * Grouping the pages a run wrote (lib/wrotePages.ts).
 *
 * Small, and pinned because two of its rules are the kind that erode: the ORDER groups come
 * in, which is what lets two runs put the same kinds in the same places, and the count in the
 * label, which the band no longer states anywhere else.
 */
import { describe, expect, it } from 'vitest'
import { countLine, groupPages, pageKind } from '../src/lib/wrotePages.ts'

describe('the pages a run wrote', () => {
  it('reads the kind off the folder, and calls everything else a page', () => {
    expect(pageKind('wiki/concepts/A.md')).toBe('concept')
    expect(pageKind('wiki/entities/B.md')).toBe('entity')
    expect(pageKind('wiki/sources/C.md')).toBe('source')
    expect(pageKind('wiki/questions/Research: D.md')).toBe('question')
    // Bookkeeping a run touches is real and counts, but it is not a finding.
    expect(pageKind('wiki/index.md')).toBe('other')
    expect(pageKind('wiki/hot.md')).toBe('other')
  })

  it('groups in a fixed order whatever order the run reported, and states the count once', () => {
    const groups = groupPages(['wiki/sources/S.md', 'wiki/concepts/A.md', 'wiki/questions/Q.md', 'wiki/concepts/B.md'])
    expect(groups.map((g) => g.kind)).toEqual(['concept', 'source', 'question'])
    expect(groups.map((g) => g.label)).toEqual(['Concepts 2', 'Source 1', 'Question 1'])
    // The band in the opened run states the category alone; the list already counted.
    expect(groups.map((g) => g.name)).toEqual(['Concepts', 'Sources', 'Questions'])
    expect(groups[0]!.paths).toEqual(['wiki/concepts/A.md', 'wiki/concepts/B.md'])
  })

  it('drops empty kinds rather than listing a zero', () => {
    expect(groupPages([]).length).toBe(0)
    expect(groupPages(['wiki/index.md']).map((g) => g.label)).toEqual(['Page 1'])
  })

  it('summarises a row in one line, singular where it is one', () => {
    expect(countLine(['wiki/concepts/A.md', 'wiki/concepts/B.md', 'wiki/questions/Q.md'])).toBe('2 concepts · 1 question')
    // "1 questions" was both wrong and a character wider than the column has to be.
    expect(countLine(['wiki/entities/E.md'])).toBe('1 entity')
    expect(countLine([])).toBe('')
  })
})
