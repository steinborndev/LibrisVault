/**
 * The one-off sweep that takes a wrong arrival mark off a reading-list entry
 * (`cli/readingsweep.ts`, 2026-09-14).
 *
 * The mark used to be written whenever the resolver found a source page carrying the entry's
 * identity - including the page a research step had just written FROM reading the publication
 * on the web. `locate()` knows the difference now; this removes the marks that predate it.
 *
 * What is under test is the edit itself: exactly two lines out of the named blocks, and nothing
 * else on a page the Fellows write by hand.
 */

import { describe, expect, it } from 'vitest'
import { stripMarks } from '../src/cli/readingsweep.js'
import { parseReadingList } from '../src/pipeline/reading-list.js'

const PAGE = `---
type: meta
title: "Reading list"
---
# Reading list

## Entries

- title: Only a write-up exists
  filed: wiki/sources/Write Up.md
  filedAt: 2026-09-14
  url: https://journal.example/a
  ref: 10.9999/example.a
  domain: biomedicine
  why: a run read it on the web; no copy was ever fetched
  by: Ada
  at: 2026-09-14
- title: The document really is here
  filed: wiki/sources/Held.md
  filedAt: 2026-09-10
  url: https://journal.example/b
  by: Ada
- title: Nothing claimed at all
  url: https://journal.example/c
  by: Beatrice
`

describe('the reading list sweep', () => {
  it('removes the two mark lines from the named entry and leaves every other field alone', () => {
    const next = stripMarks(PAGE, new Set(['Only a write-up exists']))
    const entries = parseReadingList(next)

    expect(entries[0]).toMatchObject({ title: 'Only a write-up exists', filed: null, filedAt: null })
    // Everything the Fellow wrote about it survives: the request is still a request.
    expect(entries[0]).toMatchObject({
      url: 'https://journal.example/a',
      ref: '10.9999/example.a',
      domain: 'biomedicine',
      why: 'a run read it on the web; no copy was ever fetched',
      by: 'Ada',
    })
    // The entry whose document IS here keeps its mark, and the unmarked one is untouched.
    expect(entries[1]).toMatchObject({ title: 'The document really is here', filed: 'wiki/sources/Held.md', filedAt: '2026-09-10' })
    expect(entries[2]).toMatchObject({ title: 'Nothing claimed at all', filed: null })
    expect(PAGE.split('\n').length - next.split('\n').length).toBe(2)
  })

  it('names nothing, changes nothing', () => {
    expect(stripMarks(PAGE, new Set())).toBe(PAGE)
  })

  it('a title nobody wrote cannot take another entry\'s mark with it', () => {
    expect(stripMarks(PAGE, new Set(['A title nobody wrote']))).toBe(PAGE)
  })
})
