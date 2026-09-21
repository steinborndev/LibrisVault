/**
 * The one-off backfill of quote evidence (TASKS-DEFECT-PATHS 1.3).
 *
 *   npm run backfill-quote-evidence              # report what it would fill, write nothing
 *   npm run backfill-quote-evidence -- --apply   # fill it
 *
 * WHY A BACKFILL IS NEEDED AT ALL. Migration 34 gives a finding an `evidence` column and
 * `checkQuotes` fills it from the source text it holds in memory. A row is only rewritten when
 * a run REPORTS it again, and a `quote` finding is only re-reported by an ingest of the same
 * job against the same artifact - which in practice never happens a second time. So every
 * quote finding standing on the day the column shipped would keep `evidence = NULL` forever,
 * and the fall-back "read the page again" cannot produce the longest match at all: that needs
 * the document, not the page.
 *
 * WHAT IT DOES. For each standing `quote` finding: take the job that last reported it, read
 * that job's commit, and re-run exactly the check the ingest ran - same artifact, same
 * before-state - then match the result back by finding identity and write the evidence down.
 *
 * WHAT IT NEVER DOES. It does not go through `record()`, so no count moves, no `last_seen`
 * moves and no resolved row comes back. It writes only into rows whose evidence is still NULL.
 * It writes NOTHING to the vault: `checkQuotes` is read-only and so is `git show`.
 */

import { pathToFileURL } from 'node:url'
import { loadConfig, ConfigError } from '../config.js'
import { openDb, defaultDbPath } from '../db/index.js'
import { JobStore } from '../db/jobs.js'
import { ValidationStore, findingIdentity } from '../db/validation.js'
import { checkQuotes, gitPageBefore } from '../pipeline/quotes.js'
import { readAtRevision } from '../pipeline/git.js'

async function main(): Promise<number> {
  const apply = process.argv.slice(2).includes('--apply')
  const config = loadConfig()
  const db = openDb(defaultDbPath())
  const jobs = new JobStore(db)
  const validation = new ValidationStore(db)

  // The whole standing list, then the quote rows of it: `list()` has no rule-less filter that
  // would let the query do this, and 200 rows is the cap the re-check pass already uses.
  const standing = validation.list({ limit: 200 }).filter((f) => f.rule === 'quote' && f.evidence === null)
  console.log(`${standing.length} standing quote finding(s) with no evidence${apply ? '' : '  (dry run)'}`)

  let filled = 0
  let noJob = 0
  let noMatch = 0
  for (const finding of standing) {
    const jobId = finding.lastJobId
    if (jobId === null) {
      noJob++
      continue
    }
    const job = jobs.get(jobId)
    const hash = job?.commit_hash ?? null
    if (job === undefined || hash === null) {
      noJob++
      continue
    }
    let produced
    try {
      produced = await checkQuotes({
        vaultRoot: config.vaultRoot,
        jobIds: [jobId],
        pages: [finding.path],
        before: gitPageBefore((rev, rel) => readAtRevision(config.vaultRoot, rev, rel), hash),
      })
    } catch (err) {
      console.log(`  ${finding.id}: the check threw (${(err as Error).message})`)
      noMatch++
      continue
    }
    // Matched by IDENTITY, never by position: the page may carry several quote findings and a
    // re-check may produce them in a different order or produce one the page no longer has.
    const match = produced.findings.find((f) => findingIdentity(f) === finding.id)
    if (match === undefined || match.evidence === undefined) {
      noMatch++
      continue
    }
    if (apply) {
      if (validation.setEvidence(finding.id, match.evidence)) filled++
    } else filled++
  }

  console.log(`  ${filled} filled, ${noJob} with no usable job, ${noMatch} the re-check no longer produces`)
  if (!apply) console.log('\nnothing was written. Add --apply to run it for real.')
  db.close()
  return 0
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main()
    .then((c) => process.exit(c))
    .catch((err: unknown) => {
      console.error(err instanceof ConfigError ? err.message : err)
      process.exit(1)
    })
}
