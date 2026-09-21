/**
 * Re-reading the pages the standing list still names (2026-09-21).
 *
 * WHY. A finding is cleared when a run looks at its page again and no longer reports it. That
 * works for pages runs touch, and not at all for the rest: a Fellow notebook or a dated recap
 * is written once and then left alone for months. Measured the morning this was written, 11 of
 * 66 standing findings described a defect that had been repaired hours earlier - the notebook
 * and recap titles - and nothing was ever going to clear them. A list that reports repairs is
 * worth as little as one that reports nothing, which is the failure the standing list was built
 * to end.
 *
 * WHY IT IS ITS OWN PASS, rather than a few more paths handed to the run's own check. The run's
 * check covers rules the run can raise, and the ingest path can raise two that nothing else can
 * (`quote`, `near-duplicate`) - but only for the pages of ITS job, where it has the artifact and
 * the commit before. Folding standing pages into that same call would let those two rules clear
 * findings on pages the job never fetched anything for. So this pass stands alone and claims
 * only `VALIDATOR_RULES`, which is exactly what reading a page can answer.
 *
 * It reads files and writes no vault content.
 */

import { VALIDATOR_RULES, type Validator } from './validator.js'

export interface StandingStore {
  list(opts?: { rule?: string; limit?: number; offset?: number }): ReadonlyArray<{ rule: string; path: string }>
  resolveMissing(
    paths: readonly string[],
    stillSeen: readonly { rule: string; path: string; message: string }[],
    opts: { readonly checked: ReadonlySet<string>; readonly fullyChecked?: ReadonlySet<string>; readonly now?: string },
  ): number
}

/** At most this many pages per pass: a bounded read, not a vault sweep. */
const RECHECK_LIMIT = 200

/**
 * Clears what the standing list still names but a fresh read no longer finds. Returns how many
 * went, and never throws: this is bookkeeping running after a run, and a run that worked must
 * not be reported as failed because a page could not be read.
 */
export function recheckStanding(store: StandingStore, validate: Validator, opts: { exclude?: readonly string[] } = {}): number {
  try {
    const skip = new Set(opts.exclude ?? [])
    const paths = [
      ...new Set(
        store
          .list({ limit: RECHECK_LIMIT })
          .map((f) => f.path)
          // `.raw/` job directories and the like are named by whole-vault rules, which this
          // pass does not claim: it reads pages.
          .filter((p) => p.startsWith('wiki/') && p.endsWith('.md') && !skip.has(p)),
      ),
    ]
    if (paths.length === 0) return 0
    return store.resolveMissing(paths, validate(paths), { checked: VALIDATOR_RULES })
  } catch {
    return 0
  }
}
