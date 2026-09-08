/**
 * What the reading list board shows (docs/agents/SPEC.md section 10.6).
 *
 * Most entries are open access and one click from being a source. The ones a run could not
 * get - behind a subscription, or an HTTP error, or a PDF with no extractable text - are the
 * ones the user's own access is worth using on, but they would fail the same way if the
 * service tried to fetch them, so they sit behind a toggle instead of cluttering the list
 * with rows whose button does not work.
 *
 * A second axis crosses that one: an entry the user has archived is out of the current view
 * entirely, whatever its access. Archiving is the answer to "I have dealt with this", which is
 * a different statement from "this is in the vault" and can be true without it - a publication
 * one decides not to fetch is exactly what the list had no answer for.
 *
 * Pure, so the rule and the counting are under test.
 */

import type { ReadingItem } from '../api/types.ts'

/** An entry the service can fetch: open access, or unknown and therefore worth one attempt. */
export const isReachable = (e: ReadingItem): boolean => e.reach === 'open' || e.reach === 'unknown'

export interface ReadingView {
  readonly shown: readonly ReadingItem[]
  /** How many entries the toggle is holding back right now. */
  readonly hidden: number
  readonly waiting: number
  readonly total: number
  /** Entries carrying an archive mark, across both tabs; what the toggle counts. */
  readonly archived: number
}

export type ReadingTab = 'current' | 'archived'

/*
 * Absent counts as current. The field is newer than the page format, so an entry written before
 * it existed carries nothing there - and a view that hid every such entry would empty the list
 * on the one input it is most likely to meet.
 */
export const isArchived = (e: ReadingItem): boolean => (e.archivedAt ?? null) !== null

export function readingView(entries: readonly ReadingItem[], showPaywalled: boolean, tab: ReadingTab = 'current'): ReadingView {
  // The archive is the outer cut: it decides which list you are looking at, and the paywall
  // toggle then filters within it. An archived entry is never counted as held back by that
  // toggle - it is not hidden, it is somewhere else.
  const inTab = entries.filter((e) => (tab === 'archived' ? isArchived(e) : !isArchived(e)))
  // Hidden means "neither reachable nor done". A publication already in the vault stays on the
  // list whatever its access was: it is the answer to "did that paper ever arrive".
  const shown = showPaywalled ? inTab : inTab.filter((e) => isReachable(e) || e.job !== null || e.page !== null)
  return {
    shown,
    hidden: inTab.length - shown.length,
    // Not ingested means not in the vault at all - an entry matched by its identifier is done,
    // even though no ingest ever ran for its url.
    waiting: shown.filter((e) => e.job === null && e.page === null).length,
    total: inTab.length,
    /** How many sit in the other tab, for the toggle's own count. */
    archived: entries.filter(isArchived).length,
  }
}

/** What the row says about reaching the document, or null when there is nothing to say. */
export function reachLabel(e: ReadingItem): string | null {
  if (e.reach === 'paywalled') return e.blocked !== null ? `paywalled · ${e.blocked}` : 'paywalled'
  if (e.reach === 'unreachable') return e.blocked !== null ? `unreachable · ${e.blocked}` : 'unreachable'
  return null
}
