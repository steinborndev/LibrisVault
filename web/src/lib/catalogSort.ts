/**
 * How the catalog table is ordered (2026-09-14).
 *
 * The order used to live in the Catalog tab, chosen by the sidebar's pills. Now the table's own
 * headings choose it too, and the Library's shelf window renders the same table without any
 * sidebar - so the rule belongs here, in one pure function that every caller shares. A column
 * heading and a pill are then two ways of saying the same thing, and neither can drift.
 *
 * Every column has a NATURAL direction, the one a first click gives: the newest page, the most
 * linked page, the alphabet. A second click reverses it, whatever it was.
 */

import type { GraphNode, SourceRef } from '../api/types.ts'
import { sourceKind } from './sources.ts'

export type CatalogSortKey = 'changed' | 'title' | 'type' | 'domain' | 'backlinks' | 'source'
export type SortDir = 'asc' | 'desc'

export interface CatalogSortSpec {
  readonly key: CatalogSortKey
  /** The pill's label, and what the heading says. */
  readonly label: string
  /** What the sidebar's hint line reads under the pills. */
  readonly desc: string
  /** The direction a first click gives. */
  readonly natural: SortDir
}

/** The sorts, in the order the sidebar lists them. */
export const CATALOG_SORTS: readonly CatalogSortSpec[] = [
  { key: 'changed', label: 'Changed', desc: 'most recently edited first', natural: 'desc' },
  { key: 'title', label: 'Title', desc: 'alphabetical, A to Z', natural: 'asc' },
  { key: 'type', label: 'Type', desc: 'grouped by bucket: concepts, entities, sources, questions…', natural: 'asc' },
  { key: 'domain', label: 'Domain', desc: 'grouped by domain, unfiled pages last', natural: 'asc' },
  { key: 'backlinks', label: 'Backlinks', desc: 'most linked pages first', natural: 'desc' },
  { key: 'source', label: 'Source type', desc: 'grouped by what was ingested, pages without a source last', natural: 'asc' },
]

export const naturalDir = (key: CatalogSortKey): SortDir => CATALOG_SORTS.find((s) => s.key === key)?.natural ?? 'desc'

/**
 * The buckets in the order the vault thinks in, rather than the alphabet: what a page IS, from
 * the ideas through the things and the documents to the vault's own machinery. Anything unknown
 * sorts after them, by name.
 */
const BUCKET_ORDER = ['concepts', 'entities', 'sources', 'questions', 'comparisons', 'references', 'folds', 'meta', 'root']

/**
 * Source kinds from the stored document to the most fleeting trace of one: a PDF, an office
 * file and a text drop are copies the vault holds; a web ingest keeps only the address; an image
 * or a recording is a document that was not read as text. A page with no source at all is last,
 * the way an unfiled page is last under `domain` - the sort exists to group what HAS one.
 */
const SOURCE_ORDER = ['pdf', 'office', 'text', 'web', 'image', 'av', 'other']

const rank = (order: readonly string[], value: string | null): number => {
  if (value === null) return order.length + 1
  const at = order.indexOf(value)
  return at === -1 ? order.length : at
}

/** The comparator for one key, always in its natural direction; `reverse` flips the result. */
function compare(a: GraphNode, b: GraphNode, key: CatalogSortKey, refs: Record<string, SourceRef> | undefined): number {
  const byTitle = a.title.localeCompare(b.title)
  switch (key) {
    case 'title':
      return byTitle
    case 'backlinks':
      return b.in - a.in || byTitle
    case 'type':
      return rank(BUCKET_ORDER, a.type) - rank(BUCKET_ORDER, b.type) || a.type.localeCompare(b.type) || byTitle
    case 'domain':
      // Unfiled pages last rather than first: an empty string would sort to the top and bury
      // the domains the sort exists to group.
      return rank([], a.domain === null || a.domain === '' ? null : 'x') - rank([], b.domain === null || b.domain === '' ? null : 'x') ||
        (a.domain ?? '').localeCompare(b.domain ?? '') ||
        byTitle
    case 'source':
      return rank(SOURCE_ORDER, sourceKind(a, refs)) - rank(SOURCE_ORDER, sourceKind(b, refs)) || byTitle
    default:
      return (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || byTitle
  }
}

/**
 * The pages in the order the table shows them. A copy: the caller's array is left alone, because
 * it is memoised upstream and a sort in place would reorder what other views read.
 */
export function sortCatalog(
  nodes: readonly GraphNode[],
  sort: CatalogSortKey,
  dir: SortDir,
  refs?: Record<string, SourceRef>,
): GraphNode[] {
  const flip = dir === naturalDir(sort) ? 1 : -1
  return [...nodes].sort((a, b) => flip * compare(a, b, sort, refs))
}
