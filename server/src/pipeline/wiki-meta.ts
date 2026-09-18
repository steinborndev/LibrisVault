/**
 * The vault's meta pages: the pages every ingest touches no matter what it ingested (index,
 * log, hot cache, overview, folder indexes), as opposed to the content pages a run creates or
 * extends (sources, concepts, entities, questions).
 *
 * One definition, two consumers. The queue's "no changes" outcome (SPEC.md §12.9 stage 3):
 * a run that only appended its own entry to `wiki/log.md` must not pass as an ingest that
 * wrote a page, which is exactly what happened on 2026-09-18 when a re-shared post went
 * through a full run and ended `done` with "1 page" (the log). And the Telegram completion
 * message, where these paths are noise among the titles.
 *
 * The list mirrors the ingest skill's own address-exemption list (wiki-ingest SKILL.md,
 * "Exclusions"), matched by PATH so a genuine content page titled "Log" still counts.
 * `wiki/meta/` is deliberately NOT included: the domain registry and the reading list live
 * there, and a run that changes them changed the vault.
 */

import path from 'node:path'

const META_PAGES: ReadonlySet<string> = new Set([
  'wiki/index.md',
  'wiki/hot.md',
  'wiki/log.md',
  'wiki/overview.md',
  'wiki/dashboard.md',
  'wiki/Wiki Map.md',
  'wiki/getting-started.md',
])

/** Whether a vault-relative POSIX path names a meta page (or any folder's `_index.md`). */
export function isMetaPage(rel: string): boolean {
  return META_PAGES.has(rel) || path.posix.basename(rel) === '_index.md'
}

/** The content pages among `paths`: what a run actually added to the wiki. */
export function contentPages(paths: readonly string[]): string[] {
  return paths.filter((p) => !isMetaPage(p))
}
