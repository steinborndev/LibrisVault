/**
 * What the open-access resolvers answered about a DOI (schema v27, docs/sources/SPEC.md 5.5).
 *
 * Three APIs are asked per DOI at most, and the same DOI comes up again: the nightly reading-list
 * sweep asks about twenty entries, and the ingest the user starts from a find asks about the same
 * one minutes later. So the answer is kept: a find is reused at once (which is what lets that
 * ingest rescue itself without a second round of lookups), and a blank stands for a week.
 *
 * Operational state only (hard rule 1): losing this table costs a lookup, never a document.
 */

import type { Db } from './index.js'
import { nowIso } from './index.js'

/** The stored row. `result` is the resolver round as JSON; the pipeline owns its shape. */
export interface OaLookupRow {
  readonly doi: string
  readonly checkedAt: string
  readonly found: boolean
  readonly result: unknown
}

export class OaLookupStore {
  constructor(private readonly db: Db) {}

  get(doi: string): OaLookupRow | undefined {
    const row = this.db.prepare('SELECT doi, checked_at, found, result FROM oa_lookups WHERE doi = ?').get(doi.toLowerCase()) as
      | { doi: string; checked_at: string; found: number; result: string }
      | undefined
    if (row === undefined) return undefined
    let result: unknown
    try {
      result = JSON.parse(row.result)
    } catch {
      // A row written by an older build, or hand-edited: treat it as no answer at all.
      return undefined
    }
    return { doi: row.doi, checkedAt: row.checked_at, found: row.found === 1, result }
  }

  /** Last answer wins: a fresh round is always better than the one it replaces. */
  put(doi: string, found: boolean, result: unknown, checkedAt: string = nowIso()): void {
    this.db
      .prepare(
        `INSERT INTO oa_lookups (doi, checked_at, found, result) VALUES (?, ?, ?, ?)
         ON CONFLICT(doi) DO UPDATE SET checked_at = excluded.checked_at, found = excluded.found, result = excluded.result`,
      )
      .run(doi.toLowerCase(), checkedAt, found ? 1 : 0, JSON.stringify(result))
  }

  /** How many DOIs have been asked about, and how many had a copy: the System tab's line. */
  counts(): { readonly asked: number; readonly found: number } {
    const row = this.db.prepare('SELECT COUNT(*) asked, COALESCE(SUM(found), 0) found FROM oa_lookups').get() as {
      asked: number
      found: number
    }
    return { asked: row.asked, found: row.found }
  }
}
