/**
 * The two pure halves of the one-off rename (2026-09-21): rewriting the wikilinks that name a
 * page, and rewriting the page's own naming lines.
 *
 * Worth testing for one reason: on the live vault this touched 526 links across 181 pages, and
 * a link this gets wrong is a link that resolves to nothing afterwards.
 *
 * Page names are invented (hard rule 7).
 */

import { describe, it, expect } from 'vitest'
import { rewriteLinks, retitle, safeName } from '../src/cli/rename-unsafe-names.js'

const map = new Map([
  ['Research: One Thing', 'Research - One Thing'],
  ['Research: Another', 'Research - Another'],
])

describe('rewriting the links that name a renamed page', () => {
  it('rewrites the plain form', () => {
    expect(rewriteLinks('See [[Research: One Thing]] today.', map)).toEqual({ text: 'See [[Research - One Thing]] today.', hits: 1 })
  })

  it('keeps an alias and a heading exactly as they were', () => {
    const r = rewriteLinks('[[Research: One Thing|that one]] and [[Research: Another#Findings]]', map)
    expect(r.text).toBe('[[Research - One Thing|that one]] and [[Research - Another#Findings]]')
    expect(r.hits).toBe(2)
  })

  it('leaves every other link alone', () => {
    const text = '[[Some Concept]] and [[Research: Not Listed]] and [[Research - One Thing]]'
    expect(rewriteLinks(text, map)).toEqual({ text, hits: 0 })
  })

  it('does not match a page whose name merely starts with another', () => {
    // `[[Research: One Thing Extended]]` is a DIFFERENT page, and renaming its prefix would
    // point it at one that does not exist.
    const text = 'see [[Research: One Thing Extended]]'
    expect(rewriteLinks(text, map)).toEqual({ text, hits: 0 })
  })

  it('tolerates the spacing people leave inside the brackets', () => {
    expect(rewriteLinks('[[ Research: One Thing ]]', map).hits).toBe(1)
  })

  it('counts every occurrence, not every page', () => {
    expect(rewriteLinks('[[Research: One Thing]] [[Research: One Thing]]', map).hits).toBe(2)
  })
})

describe("rewriting the page's own naming lines", () => {
  const page = (front: string, body: string): string => `---\n${front}---\n\n${body}`

  it('rewrites the title and the aliases that repeat it', () => {
    const out = retitle(page('type: question\ntitle: "Research: One Thing"\naliases:\n  - "Research: One Thing"\n', '# Research: One Thing\n\nBody.\n'))
    expect(out).toContain('title: "Research - One Thing"')
    expect(out).toContain('  - "Research - One Thing"')
    expect(out).toContain('# Research - One Thing')
  })

  it('leaves the body alone where the prefix is prose about something else', () => {
    const out = retitle(page('type: question\ntitle: "Research: One Thing"\n', '# Research: One Thing\n\nResearch: a summary follows, and [[Research: Another]] is linked.\n'))
    // The heading is the page's name; the sentence below it is not.
    expect(out).toContain('# Research - One Thing')
    expect(out).toContain('Research: a summary follows')
    expect(out).toContain('[[Research: Another]]')
  })

  it('leaves a frontmatter value that does not carry the prefix', () => {
    const out = retitle(page('type: question\ntitle: "Something Else"\nquestion: "Research: is this it?"\n', '# Something Else\n'))
    expect(out).toContain('title: "Something Else"')
    expect(out).toContain('question: "Research: is this it?"')
  })

  it('handles a page with no frontmatter at all', () => {
    expect(retitle('# Research: One Thing\n\nBody.\n')).toContain('# Research - One Thing')
  })
})

describe('the name a page should be filed under', () => {
  it('turns the research prefix into the one the service writes today', () => {
    expect(safeName('Research: One Thing', false)).toBe('Research - One Thing')
  })

  it('leaves a second forbidden character to a decision, until --strip says otherwise', () => {
    expect(safeName('Research: Is it so?', false)).toBeNull()
    expect(safeName('Research: Is it so?', true)).toBe('Research - Is it so')
  })

  it('drops the character and closes the gap it leaves', () => {
    // "Zeichen weg": no substitution reads well across an article title ending in a question,
    // an asterisk inside a designation, and a quoted phrase - so the words stay and the
    // character goes.
    expect(safeName('A Question? And Then Some', true)).toBe('A Question And Then Some')
    expect(safeName('Collapsed Companion (ABC-4*)', true)).toBe('Collapsed Companion (ABC-4)')
    expect(safeName('Impacting the Sector? (Research, 2024)', true)).toBe('Impacting the Sector (Research, 2024)')
    expect(safeName('He said "this" loudly', true)).toBe('He said this loudly')
  })

  it('says no when there would be nothing left, or nothing to change', () => {
    expect(safeName('???', true)).toBeNull()
    expect(safeName('A Clean Name', true)).toBeNull()
  })
})
