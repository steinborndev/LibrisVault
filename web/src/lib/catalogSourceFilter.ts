/**
 * The Catalog's "Source types" filter (2026-09-14).
 *
 * A filter category over the source model, not a second source model. The kinds are the ones
 * `sourceKind` already reads off the page index, so a pill, the Source column and the source
 * sort can never disagree about what a page came from - and nothing here changes any of them.
 *
 * The one pill that is not a kind of document is PUBLICATION. A paper arrives as a PDF or as a
 * web page, so it has no type of its own; what marks it is its ADDRESS carrying a DOI. It sits
 * in the same row because it answers the question a reader actually asks of this section ("what
 * kind of thing is this page about"), and it ORs with the kinds like every other pill: PDF and
 * Publication selected together means "a PDF, or anything with a DOI".
 */

import type { GraphNode, SourceRef } from '../api/types.ts'
import { LABELS as KIND_LABELS, sourceKind } from './sources.ts'

/** The cross-cutting pill: not a document type, a property of the address. */
export const PUBLICATION = 'publication'

export interface SourceFilterSpec {
  readonly key: string
  /** The label the Source column uses for this kind, so one thing has one name. */
  readonly label: string
  /** What the sidebar's hint line reads while the pointer is on the pill. */
  readonly desc: string
}

/**
 * The pills, in the order the sidebar lists them: the stored documents first (the same order
 * the source sort groups by), then the address property, which is the odd one out.
 */
export const SOURCE_FILTERS: readonly SourceFilterSpec[] = [
  { key: 'pdf', label: KIND_LABELS['pdf']!, desc: 'papers and reports dropped in as PDF' },
  { key: 'office', label: KIND_LABELS['office']!, desc: 'word processor and spreadsheet files' },
  { key: 'text', label: KIND_LABELS['text']!, desc: 'plain text and markdown dropped in' },
  { key: 'web', label: KIND_LABELS['web']!, desc: 'pages ingested from an address' },
  { key: 'image', label: KIND_LABELS['image']!, desc: 'pictures read for what they show' },
  { key: 'av', label: KIND_LABELS['av']!, desc: 'audio and video that was ingested' },
  { key: 'other', label: KIND_LABELS['other']!, desc: 'files of a kind of their own' },
  { key: PUBLICATION, label: 'Publication', desc: 'pages whose address carries a DOI' },
]

/**
 * A DOI in the address: the resolver's own host, or the `10.<registrant>/<suffix>` shape inside
 * some publisher's URL. Read off the address the page states or its ingest recorded, because
 * that is where the vault keeps it - the page index carries no DOI field of its own, and adding
 * one would be a change to the source model rather than a filter over it.
 */
const DOI = /(?:\/\/(?:dx\.)?doi\.org\/|\b10\.\d{4,9}\/)/i

export function isPublication(
  node: { readonly path: string; readonly url?: string | null },
  refs: Record<string, SourceRef> | undefined,
): boolean {
  return DOI.test(node.url ?? '') || DOI.test(refs?.[node.path]?.url ?? '')
}

/**
 * Whether the Source column would show anything for this page: an ingested document, or the
 * address the page states for itself. A page with neither is one the vault wrote out of other
 * pages, and the column draws a dash for it.
 *
 * While the page index is still in flight nothing is narrowed, for the reason `matchesSources`
 * gives below.
 */
export function hasSource(
  node: { readonly path: string; readonly url?: string | null },
  refs: Record<string, SourceRef> | undefined,
): boolean {
  return refs === undefined || sourceKind(node, refs) !== null
}

/** Whether a page passes the selection. Nothing selected is not a filter: everything passes. */
export function matchesSources(
  node: GraphNode,
  refs: Record<string, SourceRef> | undefined,
  selected: ReadonlySet<string>,
): boolean {
  if (selected.size === 0) return true
  /*
   * An index that has not arrived cannot narrow anything. Filtering against it would empty the
   * table for as long as the query is in flight, and an empty table is a statement ("nothing
   * matches") where the truth is only "not known yet" - the same reason the Source column draws
   * nothing rather than a dash before the index is here.
   */
  if (refs === undefined) return true
  if (selected.has(PUBLICATION) && isPublication(node, refs)) return true
  const kind = sourceKind(node, refs)
  return kind !== null && selected.has(kind)
}

/**
 * How many pages each pill would show. A publication is counted twice on purpose, once under
 * its document's kind and once as a publication: the pills OR together, so each count says what
 * that pill alone brings, not a share of a partition.
 */
export function sourceCounts(
  nodes: readonly GraphNode[],
  refs: Record<string, SourceRef> | undefined,
): Map<string, number> {
  const counts = new Map<string, number>()
  const bump = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const n of nodes) {
    const kind = sourceKind(n, refs)
    if (kind !== null) bump(kind)
    if (isPublication(n, refs)) bump(PUBLICATION)
  }
  return counts
}

/**
 * The selection as one line, for the hint under the pills. Past three labels the list stops
 * being readable in the 222px the panel has, so it counts the rest instead.
 */
export function sourceSummary(selected: ReadonlySet<string>): string {
  const labels = SOURCE_FILTERS.filter((f) => selected.has(f.key)).map((f) => f.label)
  if (labels.length === 0) return 'every page, whatever it came from'
  if (labels.length === 1) return `${labels[0]} only`
  if (labels.length <= 3) return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]} only`
  return `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`
}
