import { describe, it, expect } from 'vitest'
import { stampDates, bodyChanged, bodyOf, fieldOf, freshnessDate, CONTENT_UPDATED } from '../src/pipeline/page-dates.js'

/**
 * `updated:` and `content_updated:` (B7, 7.3) - the prerequisite for phase 8.
 *
 * `updated:` was the only freshness signal a page had, and every mass pass bumped it: a tag
 * normalisation, a link repair, a counter refresh. 1231 of 1247 pages claim an update within
 * thirty days, which is another way of saying the field answers nothing.
 *
 * The repair passes of phase 8 are more such passes. Without a second field they would destroy
 * the signal a second time, which is why this lands first.
 */
const page = (front: string, body = '# Title\n\nSome prose.\n'): string => `---\n${front}\n---\n\n${body}`

describe('stampDates', () => {
  it('sets updated: without content_updated: for a mechanical change', () => {
    const out = stampDates(page('type: concept\nupdated: 2026-01-01'), { content: false, day: '2026-09-19' })
    expect(fieldOf(out, 'updated')).toBe('2026-09-19')
    expect(fieldOf(out, CONTENT_UPDATED)).toBeNull()
  })

  it('sets both when the page says something new', () => {
    const out = stampDates(page('type: concept\nupdated: 2026-01-01'), { content: true, day: '2026-09-19' })
    expect(fieldOf(out, 'updated')).toBe('2026-09-19')
    expect(fieldOf(out, CONTENT_UPDATED)).toBe('2026-09-19')
  })

  it('puts the new field directly after updated:, keeping the writer\'s order', () => {
    const out = stampDates(page('type: concept\ntitle: "X"\nupdated: 2026-01-01\ntags:\n  - concept'), {
      content: true,
      day: '2026-09-19',
    })
    const front = out.split('---')[1] ?? ''
    expect(front.indexOf('updated:')).toBeLessThan(front.indexOf(CONTENT_UPDATED))
    expect(front.indexOf(CONTENT_UPDATED)).toBeLessThan(front.indexOf('tags:'))
    expect(front).toContain('title: "X"')
  })

  it('replaces an existing content_updated: rather than adding a second', () => {
    const once = stampDates(page('type: concept\nupdated: 2026-01-01'), { content: true, day: '2026-05-05' })
    const twice = stampDates(once, { content: true, day: '2026-09-19' })
    expect(twice.match(new RegExp(`^${CONTENT_UPDATED}:`, 'gm'))).toHaveLength(1)
    expect(fieldOf(twice, CONTENT_UPDATED)).toBe('2026-09-19')
  })

  it('leaves an older content_updated: alone on a mechanical pass', () => {
    // The whole point: a repair pass may touch every page in the vault and must not claim any
    // of them said something new.
    const written = stampDates(page('type: concept\nupdated: 2026-01-01'), { content: true, day: '2026-05-05' })
    const repaired = stampDates(written, { content: false, day: '2026-09-19' })
    expect(fieldOf(repaired, 'updated')).toBe('2026-09-19')
    expect(fieldOf(repaired, CONTENT_UPDATED)).toBe('2026-05-05')
  })

  it('adds updated: to a page that never had one', () => {
    const out = stampDates(page('type: concept'), { content: false, day: '2026-09-19' })
    expect(fieldOf(out, 'updated')).toBe('2026-09-19')
  })

  it('leaves a page with no frontmatter exactly as it is', () => {
    // Inventing a frontmatter block is a bigger decision than a date field.
    const plain = '# Just a page\n\nNo frontmatter at all.\n'
    expect(stampDates(plain, { content: true })).toBe(plain)
  })

  it('never touches the body', () => {
    const before = page('type: concept\nupdated: 2026-01-01', '# Title\n\nA paragraph with --- in it.\n')
    expect(bodyOf(stampDates(before, { content: true, day: '2026-09-19' }))).toBe(bodyOf(before))
  })
})

describe('bodyChanged', () => {
  it('is false for a frontmatter-only edit', () => {
    const before = page('type: concept\nstatus: seed')
    const after = page('type: concept\nstatus: mature')
    expect(bodyChanged(before, after)).toBe(false)
  })

  it('is true when the prose changes', () => {
    expect(bodyChanged(page('type: concept'), page('type: concept', '# Title\n\nDifferent prose.\n'))).toBe(true)
  })

  it('ignores trailing whitespace, which an editor adds and a person does not', () => {
    expect(bodyChanged(page('type: concept'), `${page('type: concept')}\n\n`)).toBe(false)
  })
})

describe('freshnessDate', () => {
  it('prefers the content date', () => {
    expect(freshnessDate(page(`type: concept\ncreated: 2026-01-01\nupdated: 2026-09-19\n${CONTENT_UPDATED}: 2026-05-05`))).toBe('2026-05-05')
  })

  it('falls back to created: for the pages that predate the field', () => {
    // Deliberately NOT to `updated:`: on those 1247 pages that is the date of the last mass
    // pass, and sorting by it is what made every page look equally fresh.
    expect(freshnessDate(page('type: concept\ncreated: 2026-01-01\nupdated: 2026-09-19'))).toBe('2026-01-01')
  })

  it('is null when a page states no date at all', () => {
    expect(freshnessDate(page('type: concept'))).toBeNull()
  })
})
