/**
 * The reading list board's paywalled toggle (docs/agents/SPEC.md section 10.6): a publication
 * the service cannot fetch is worth listing - the user's own access can often get it - but its
 * Ingest button would fail the same way the run did, so it sits behind a toggle.
 */

import { describe, expect, it } from 'vitest'
import { isReachable, reachLabel, readingView } from '../src/lib/readingList.ts'
import type { ReadingItem } from '../src/api/types.ts'

const item = (over: Partial<ReadingItem>): ReadingItem => ({
  title: 't',
  url: 'https://example.invalid/x',
  ref: null,
  domain: null,
  why: null,
  found: null,
  by: null,
  at: null,
  access: null,
  blocked: null,
  reach: 'unknown',
  page: null,
  via: null,
  filed: null,
  filedAt: null,
  job: null,
  ...over,
})

describe('the reading list view', () => {
  const entries: ReadingItem[] = [
    item({ title: 'open', reach: 'open' }),
    item({ title: 'unknown host', reach: 'unknown' }),
    item({ title: 'paywalled', reach: 'paywalled', access: 'paywalled', blocked: 'HTTP 403' }),
    item({ title: 'unreachable', reach: 'unreachable', access: 'unreachable' }),
  ]

  it('hides what the service cannot fetch until the toggle is set', () => {
    const off = readingView(entries, false)
    expect(off.shown.map((e) => e.title)).toEqual(['open', 'unknown host'])
    expect(off.hidden).toBe(2)
    expect(off.total).toBe(4)

    const on = readingView(entries, true)
    expect(on.shown).toHaveLength(4)
    expect(on.hidden).toBe(0)
  })

  it('keeps a paywalled entry that was ingested anyway, and counts what still waits', () => {
    const ingested = [...entries, item({ title: 'paywalled but filed', reach: 'paywalled', job: { id: 'j1', status: 'done', pages: 2 } })]
    const off = readingView(ingested, false)
    expect(off.shown.map((e) => e.title)).toEqual(['open', 'unknown host', 'paywalled but filed'])
    expect(off.waiting).toBe(2)
    // A row matched by its identifier counts as done too, though no ingest ran for its url.
    expect(readingView([item({ page: 'wiki/sources/X.md' })], false).waiting).toBe(0)
  })

  it('an entry recognized in the vault stays visible even when nobody could fetch it', () => {
    // The case the whole identity match exists for: the user got the paywalled paper by hand
    // and dropped the PDF in, so no ingest ran for its url but its page carries its DOI.
    const byHand = item({ title: 'fetched by hand', reach: 'paywalled', page: 'wiki/sources/X.md', via: 'ref' })
    const off = readingView([byHand, item({ title: 'still out of reach', reach: 'paywalled' })], false)
    expect(off.shown.map((e) => e.title)).toEqual(['fetched by hand'])
    expect(off.hidden).toBe(1)
    // It is not reachable BY THE SERVICE, which is what the toggle is about; the row shows
    // where it landed regardless.
    expect(isReachable(byHand)).toBe(false)
    expect(byHand.page).toBe('wiki/sources/X.md')
  })

  it('an unknown host is still worth one attempt; a named blocker is spelled out', () => {
    expect(isReachable(item({ reach: 'unknown' }))).toBe(true)
    expect(isReachable(item({ reach: 'paywalled' }))).toBe(false)
    expect(reachLabel(item({ reach: 'open' }))).toBeNull()
    expect(reachLabel(item({ reach: 'paywalled', blocked: 'HTTP 403' }))).toBe('paywalled · HTTP 403')
    expect(reachLabel(item({ reach: 'unreachable' }))).toBe('unreachable')
  })
})
