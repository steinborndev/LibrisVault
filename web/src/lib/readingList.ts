/**
 * What the reading list board shows (docs/agents/SPEC.md section 10.6).
 *
 * Most entries are open access and one click from being a source. The ones a run could not
 * get - behind a subscription, or an HTTP error, or a PDF with no extractable text - are the
 * ones the user's own access is worth using on, but they would fail the same way if the
 * service tried to fetch them, so the board shows one kind at a time: what the service can
 * fetch (open, and hosts it knows nothing about), what only the user can (paywalled, and
 * what a run could not reach), or both.
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

/** Which side of the paywall the board shows: what the service can fetch, what only the user can, or both. */
export type ReadingReach = 'open' | 'paywalled' | 'both'

/** Whether an entry belongs to the side the board shows. */
export const inReach = (e: ReadingItem, reach: ReadingReach): boolean => reach === 'both' || (reach === 'open') === isReachable(e)

/*
 * Absent counts as current. The field is newer than the page format, so an entry written before
 * it existed carries nothing there - and a view that hid every such entry would empty the list
 * on the one input it is most likely to meet.
 */
export const isArchived = (e: ReadingItem): boolean => (e.archivedAt ?? null) !== null

/**
 * The domains the board's ring stops at, after "all domains" (2026-09-16).
 *
 * Read off the entries the board is SHOWING - the tab and the access toggle have already cut -
 * so the ring never offers a stop with nothing behind it. An entry without a domain is on no
 * stop of its own and is reachable through "all domains", which is where it belongs: the ring
 * is a way through the subjects, and "no subject" is not one.
 *
 * Alphabetical, deliberately, and not by size: a ring whose order followed the counts would
 * reshuffle itself the moment an entry is ingested, and an order you cannot predict is worse
 * than one you would not have chosen.
 */
export function readingDomains(shown: readonly ReadingItem[]): string[] {
  return [...new Set(shown.map((e) => e.domain).filter((d): d is string => d !== null))].sort((a, b) => a.localeCompare(b))
}

export function readingView(
  entries: readonly ReadingItem[],
  reach: ReadingReach,
  tab: ReadingTab = 'current',
  /** One stop of the domain ring; null is "all domains", the stop the board opens on. */
  domain: string | null = null,
): ReadingView {
  // The archive is the outer cut: it decides which list you are looking at, and the access
  // toggle then filters within it. An archived entry is never counted as held back by that
  // toggle - it is not hidden, it is somewhere else.
  const inTab = entries.filter((e) => (tab === 'archived' ? isArchived(e) : !isArchived(e)))
  // The ring sits between the two: which list, then which subject, then which side of the
  // paywall. So `hidden` stays what it always was - what the TOGGLE is holding back - and
  // counts what it holds back inside the domain you are looking at.
  const inDomain = domain === null ? inTab : inTab.filter((e) => e.domain === domain)
  // One side of the paywall at a time, by the entry's access alone: a paywalled paper the
  // user fetched by hand stands with the paywalled ones, where it says it is in the vault.
  const shown = inDomain.filter((e) => inReach(e, reach))
  return {
    shown,
    hidden: inDomain.length - shown.length,
    // Not ingested means the DOCUMENT is not here. An entry matched by its identifier is done
    // even though no ingest ever ran for its url; an entry that only has a page written ABOUT
    // it is not, however completely that page reads - the lede offers to fetch the original.
    waiting: shown.filter((e) => !e.held).length,
    total: inDomain.length,
    /** How many sit in the other tab, for the toggle's own count. */
    archived: entries.filter(isArchived).length,
  }
}

/**
 * The version of a copy, in words a reader knows (docs/sources/SPEC.md 6.3). The machine words
 * are OpenAlex's; "submitted" is what everyone else calls a preprint, and "accepted" is the
 * manuscript whose wording may differ from the published one, which is why it is named.
 */
export function copyVersionWords(version: string | null): string {
  if (version === 'publishedVersion') return 'published version'
  if (version === 'acceptedVersion') return 'accepted manuscript'
  if (version === 'submittedVersion') return 'preprint'
  return 'version not stated'
}

/** Whether the board may offer the one click: a copy is named and nobody has ruled it out yet. */
export const hasUsableCopy = (e: ReadingItem): boolean => e.oa !== null && !e.oaExhausted

/**
 * Whether the copy was opened and measured, rather than merely named by a resolver.
 *
 * The two ways a copy reaches an entry differ in exactly this: the nightly sweep ASKS (three
 * lines, no size), and "Find open-access" on the board FETCHES, extracts and measures it (a
 * fourth line with the character count). The checkmark on the button marks the second.
 */
export const copyVerified = (e: ReadingItem): boolean => (e.oa?.chars ?? null) !== null

/**
 * What a search that found nothing says in the row: short, dated, and the same whether the answer
 * came from the resolvers just now or from the week-old row that already asked them. The full
 * sentence - which resolver said what, how many copies were tried - rides in the tooltip.
 */
export function searchMiss(reason: string): string {
  const asked = /last asked \((\d{4})-(\d{2})-(\d{2})/.exec(reason)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  if (asked !== null) return `no open copy · asked ${Number(asked[3])} ${months[Number(asked[2]) - 1]}`
  const tried = /tried (\d+)/.exec(reason)
  return tried !== null && Number(tried[1]) > 0 ? `no open copy · ${tried[1]} tried` : 'no open copy'
}

/** The size a verification measured, in the short form a label can carry. */
export const copySize = (e: ReadingItem): string | null =>
  e.oa?.chars == null ? null : `${e.oa.chars.toLocaleString('en-US')} chars`

/** What the row says about reaching the document, or null when there is nothing to say. */
export function reachLabel(e: ReadingItem): string | null {
  /*
   * An open copy is the one thing that changes what a paywalled row means: the service CAN read
   * this one after all, through the copy, so the label says so beside the reach. Once an ingest
   * has fetched that copy and found a record page rather than the paper, the label says THAT
   * instead - the address is still real, it is just not the document (docs/sources/SPEC.md 6.3).
   */
  const copy =
    e.oa === null
      ? ''
      : e.oaExhausted
        ? ' · copy named, not readable'
        : ` · open copy · ${copyVersionWords(e.oa.version)}${copySize(e) === null ? '' : ` · ${copySize(e)!}`}`
  if (e.reach === 'paywalled') return `${e.blocked !== null ? `paywalled · ${e.blocked}` : 'paywalled'}${copy}`
  if (e.reach === 'unreachable') return `${e.blocked !== null ? `unreachable · ${e.blocked}` : 'unreachable'}${copy}`
  return copy === '' ? null : copy.replace(/^ · /, '')
}
