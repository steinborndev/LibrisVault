/**
 * The reading list board's access toggle (docs/agents/SPEC.md section 10.6): a publication
 * the service cannot fetch is worth listing - the user's own access can often get it - but its
 * Ingest button would fail the same way the run did, so the board shows one side of the
 * paywall at a time, or both.
 */

import { describe, expect, it } from 'vitest'
import { copyVersionWords, hasUsableCopy, inReach, isReachable, reachLabel, readingView } from '../src/lib/readingList.ts'
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
  archivedAt: null,
  oa: null,
  oaExhausted: false,
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

  it('shows one side of the paywall at a time: what the service can fetch, what only the user can, or both', () => {
    // An unknown host is worth one attempt, so it stands with the open ones; what a run could
    // not reach stands with the paywalled ones, because the service would fail the same way.
    const open = readingView(entries, 'open')
    expect(open.shown.map((e) => e.title)).toEqual(['open', 'unknown host'])
    expect(open.hidden).toBe(2)
    expect(open.total).toBe(4)

    const paywalled = readingView(entries, 'paywalled')
    expect(paywalled.shown.map((e) => e.title)).toEqual(['paywalled', 'unreachable'])
    expect(paywalled.hidden).toBe(2)

    const both = readingView(entries, 'both')
    expect(both.shown).toHaveLength(4)
    expect(both.hidden).toBe(0)
    expect(inReach(item({ reach: 'unknown' }), 'open')).toBe(true)
    expect(inReach(item({ reach: 'unreachable' }), 'paywalled')).toBe(true)
    expect(inReach(item({ reach: 'unreachable' }), 'open')).toBe(false)
  })

  it('counts what still waits on the side it shows', () => {
    const ingested = [...entries, item({ title: 'paywalled but filed', reach: 'paywalled', job: { id: 'j1', status: 'done', pages: 2 } })]
    expect(readingView(ingested, 'open').waiting).toBe(2)
    // A paywalled paper that was ingested anyway stands with the paywalled ones, done.
    const paywalled = readingView(ingested, 'paywalled')
    expect(paywalled.shown.map((e) => e.title)).toEqual(['paywalled', 'unreachable', 'paywalled but filed'])
    expect(paywalled.waiting).toBe(2)
    // A row matched by its identifier counts as done too, though no ingest ran for its url.
    expect(readingView([item({ page: 'wiki/sources/X.md' })], 'open').waiting).toBe(0)
  })

  it('an entry the user fetched by hand stands with the paywalled ones, and says where it landed', () => {
    // The case the whole identity match exists for: the user got the paywalled paper by hand
    // and dropped the PDF in, so no ingest ran for its url but its page carries its DOI. Its
    // access did not change, so its side of the toggle does not either.
    const byHand = item({ title: 'fetched by hand', reach: 'paywalled', page: 'wiki/sources/X.md', via: 'ref' })
    const rows = [byHand, item({ title: 'still out of reach', reach: 'paywalled' })]
    expect(readingView(rows, 'open').shown).toEqual([])
    expect(readingView(rows, 'paywalled').shown.map((e) => e.title)).toEqual(['fetched by hand', 'still out of reach'])
    expect(readingView(rows, 'paywalled').waiting).toBe(1)
    // It is not reachable BY THE SERVICE, which is what the toggle is about; the row shows
    // where it landed regardless.
    expect(isReachable(byHand)).toBe(false)
    expect(byHand.page).toBe('wiki/sources/X.md')
  })

  /*
   * The archive is the outer cut: it decides WHICH list you are looking at, and the paywall
   * toggle then filters inside it. So an archived entry is never counted as held back by that
   * toggle - it is not hidden, it is somewhere else.
   */
  it('splits the list in two, and the access toggle works inside each half', () => {
    const withArchive: ReadingItem[] = [
      ...entries,
      item({ title: 'archived open', reach: 'open', archivedAt: '2026-09-08' }),
      item({ title: 'archived paywalled', reach: 'paywalled', access: 'paywalled', archivedAt: '2026-09-08' }),
    ]
    const current = readingView(withArchive, 'open', 'current')
    expect(current.shown.map((e) => e.title)).toEqual(['open', 'unknown host'])
    expect(current.hidden).toBe(2)
    // The count of what sits in the other list is the same from either side.
    expect(current.archived).toBe(2)

    const archived = readingView(withArchive, 'open', 'archived')
    expect(archived.shown.map((e) => e.title)).toEqual(['archived open'])
    expect(archived.hidden).toBe(1)
    expect(readingView(withArchive, 'both', 'archived').shown.map((e) => e.title)).toEqual(['archived open', 'archived paywalled'])
    // `total` is the list you are on, not the page.
    expect(archived.total).toBe(2)
  })

  it('treats a missing archive mark as current, because the field is newer than the page', () => {
    // An entry written before the field existed carries nothing there. A view that read that as
    // "archived" would empty the current list on the one input it is most likely to meet.
    const legacy = [{ ...item({ title: 'old' }), archivedAt: undefined } as unknown as ReadingItem]
    expect(readingView(legacy, 'open', 'current').shown.map((e) => e.title)).toEqual(['old'])
    expect(readingView(legacy, 'open', 'archived').shown).toEqual([])
  })

  it('an unknown host is still worth one attempt; a named blocker is spelled out', () => {
    expect(isReachable(item({ reach: 'unknown' }))).toBe(true)
    expect(isReachable(item({ reach: 'paywalled' }))).toBe(false)
    expect(reachLabel(item({ reach: 'open' }))).toBeNull()
    expect(reachLabel(item({ reach: 'paywalled', blocked: 'HTTP 403' }))).toBe('paywalled · HTTP 403')
    expect(reachLabel(item({ reach: 'unreachable' }))).toBe('unreachable')
  })
})

describe('an entry with an open copy (docs/sources/SPEC.md 6.3)', () => {
  it('says so beside the reach, in words rather than in OpenAlex\'s', () => {
    const copy = { url: 'https://repository.example/paper.pdf', version: 'acceptedVersion', at: '2026-09-13' }
    expect(reachLabel(item({ reach: 'paywalled', blocked: 'HTTP 403', oa: copy }))).toBe(
      'paywalled · HTTP 403 · open copy · accepted manuscript',
    )
    expect(reachLabel(item({ reach: 'unreachable', oa: { ...copy, version: null } }))).toBe('unreachable · open copy · version not stated')
    // Without a copy the label is exactly what it was.
    expect(reachLabel(item({ reach: 'paywalled', blocked: 'subscription' }))).toBe('paywalled · subscription')
    expect(reachLabel(item({ reach: 'open' }))).toBeNull()
  })

  it('names the version the way a reader would', () => {
    expect(copyVersionWords('publishedVersion')).toBe('published version')
    expect(copyVersionWords('acceptedVersion')).toBe('accepted manuscript')
    expect(copyVersionWords('submittedVersion')).toBe('preprint')
    expect(copyVersionWords(null)).toBe('version not stated')
  })

  it('says a copy was tried and found wanting, and offers no click for it', () => {
    const copy = { url: 'https://repository.example/record.pdf', version: 'publishedVersion', at: '2026-09-13' }
    const tried = item({ reach: 'paywalled', blocked: 'HTTP 403', oa: copy, oaExhausted: true })
    // The address is real, so the mark stays; it is just not the paper.
    expect(reachLabel(tried)).toBe('paywalled · HTTP 403 · copy named, not readable')
    expect(hasUsableCopy(tried)).toBe(false)
    expect(hasUsableCopy(item({ reach: 'paywalled', oa: copy }))).toBe(true)
    expect(hasUsableCopy(item({ reach: 'paywalled' }))).toBe(false)
  })

  it('stays on the paywalled side of the toggle: the copy does not make the entry open', () => {
    // The entry is still one the user could not read; what changed is that the service can
    // rescue the ingest. Moving it to the open side would hide it from the list it belongs on.
    const e = item({ reach: 'paywalled', oa: { url: 'https://repository.example/x.pdf', version: 'publishedVersion', at: '2026-09-13' } })
    expect(isReachable(e)).toBe(false)
    expect(inReach(e, 'paywalled')).toBe(true)
    expect(inReach(e, 'open')).toBe(false)
  })
})
