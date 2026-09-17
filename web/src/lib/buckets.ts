/**
 * What a reader calls the wiki's buckets: one map for the graph's type chips, the Catalog's
 * type rows and Home's legend (2026-09-17). Each screen used to carry a copy of its own, and
 * Home's legend had none, so it said "questions" where the two others said "Research". The key
 * is the vault's folder name and never moves with the label: the frontmatter, every route and
 * every filter keep it. `questions` reads as Research since 2026-09-16.
 */

export const BUCKET_LABELS: Record<string, string> = {
  concepts: 'Concepts',
  entities: 'Entities',
  sources: 'Sources',
  meta: 'Meta',
  root: 'Root',
  questions: 'Research',
  references: 'References',
  comparisons: 'Comparisons',
  folds: 'Folds',
}

/** The bucket's label, or the folder name itself where the vault has a bucket this map does not know. */
export const bucketLabel = (type: string): string => BUCKET_LABELS[type] ?? type
