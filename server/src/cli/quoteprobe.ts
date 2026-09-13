/**
 * Calibration for the quote check (docs/sources/SPEC.md section 7.6).
 *
 * The check compares a page's quotations against the text the job read, and both sides come out
 * of an extraction: hyphenation at a line end, ligatures, citation markers, a column padded with
 * spaces. So before it ships, it runs over the last twenty finished ingests that still have
 * their artifacts and prints every quote it could NOT find - and the normalization is tuned
 * until what is left is inventions rather than extraction noise. The task file records the rate.
 *
 * Read-only: it reads pages and artifacts, and writes nothing anywhere.
 *
 * Run: VAULT_ROOT=~/vault DB_PATH=... npx tsx server/src/cli/quoteprobe.ts [--jobs N] [--all]
 */

import { loadConfig } from '../config.js'
import { openDb, defaultDbPath } from '../db/index.js'
import { JobStore } from '../db/jobs.js'
import { checkQuotes, extractQuotes, gitPageBefore, jobCorpus } from '../pipeline/quotes.js'
import { readAtRevision } from '../pipeline/git.js'
import fs from 'node:fs'
import path from 'node:path'

const config = loadConfig()
const args = process.argv.slice(2)
const at = args.indexOf('--jobs')
const wanted = at === -1 ? 20 : Math.max(1, Number(args[at + 1] ?? 20))
/** Print every quote, not just the unverified ones: what a false-alarm hunt needs. */
const all = args.includes('--all')

const db = openDb(defaultDbPath())
const store = new JobStore(db)

const main = async (): Promise<void> => {
let jobs = 0
let checked = 0
let unverified = 0
/*
 * Every failure with the longest run of its OWN words that does stand in the document. The first
 * calibration round classified these by the leading PREFIX, which is not the same question and
 * understated how much of a quote was there - the review of 2026-09-14 caught it. A quote can
 * differ in its first word and be verbatim after it.
 */
const offenders: Array<{ job: string; path: string; run: number; words: number; text: string }> = []

for (const job of store.list({ limit: 400 })) {
  if (jobs >= wanted) break
  if (job.status !== 'done') continue
  let pages: string[]
  try {
    pages = (JSON.parse(job.created_pages ?? '[]') as string[]).filter((p) => p.endsWith('.md'))
  } catch {
    continue
  }
  if (pages.length === 0) continue
  // Batch members share one commit; each member's own artifact is part of the corpus (7.2).
  const members = job.batch_id === null ? [job.id] : store.list({ limit: 400 }).filter((j) => j.batch_id === job.batch_id).map((j) => j.id)
  const corpus = await jobCorpus(config.vaultRoot, members)
  if (corpus.artifacts === 0) continue
  // Without the run's own commit there is no "before", and every earlier run's quotes on a
  // shared page would be read as this job's (7.6).
  if (job.commit_hash === null) continue
  jobs++
  const before = gitPageBefore((rev, rel) => readAtRevision(config.vaultRoot, rev, rel), job.commit_hash)
  const result = await checkQuotes({ vaultRoot: config.vaultRoot, jobIds: members, pages, before })
  checked += result.summary.checked
  unverified += result.summary.unverified
  console.log(
    `${job.id} ${(job.type ?? '?').padEnd(6)} ${String(result.summary.checked).padStart(3)} checked ${String(result.summary.unverified).padStart(3)} unverified  ${pages.length} page(s), corpus ${corpus.index.length} chars`,
  )
  for (const f of result.findings) {
    console.log(`    ${f.path}`)
    console.log(`      ${f.message}`)
    const m = /longest match (\d+) of (\d+) words/.exec(f.message)
    offenders.push({
      job: job.id,
      path: f.path,
      run: m === null ? 0 : Number(m[1]),
      words: m === null ? 0 : Number(m[2]),
      text: f.message,
    })
  }
  if (all) {
    for (const rel of pages) {
      let markdown: string
      try {
        markdown = fs.readFileSync(path.join(config.vaultRoot, rel), 'utf8')
      } catch {
        continue
      }
      for (const q of extractQuotes(rel, markdown)) console.log(`    + ${q.text.slice(0, 100)}`)
    }
  }
}

const rate = checked === 0 ? 0 : Math.round((unverified / checked) * 1000) / 10
console.log(`\n${jobs} job(s) with artifacts, ${checked} quote(s) checked, ${unverified} unverified (${rate} %)`)
/*
 * The distribution is the point of the exercise: a quote with almost all of its words in the
 * document in a row is a MISQUOTE and a bug's worth of normalization away, one with none of them
 * is an invention. Printed here so the record in the task file can be reproduced with one command.
 */
const share = (n: number): string => (offenders.length === 0 ? '-' : `${Math.round((n / offenders.length) * 1000) / 10} %`)
const bucket = (lo: number, hi: number): number =>
  offenders.filter((o) => o.words > 0 && o.run / o.words >= lo && o.run / o.words < hi).length
const whole = offenders.filter((o) => o.words > 0 && o.run === o.words).length
console.log('\nhow much of each failing quote IS in the document, as one run of words:')
console.log(`  all of it (a match the check still refused):   ${whole} (${share(whole)})`)
console.log(`  60 % up to all:                                ${bucket(0.6, 1)} (${share(bucket(0.6, 1))})`)
console.log(`  30 % up to 60 %:                               ${bucket(0.3, 0.6)} (${share(bucket(0.3, 0.6))})`)
console.log(`  under 30 %:                                    ${bucket(0, 0.3)} (${share(bucket(0, 0.3))})`)
// The same set counted the way the first record (wrongly) claimed to count it, for comparison.
const fewer = offenders.filter((o) => o.run < 3).length
console.log(`  and of all of them, fewer than three words in a row: ${fewer} (${share(fewer)})`)
if (offenders.length > 0) console.log('\nRead the lines above: a long run is a misquote, a short one is an invention.')
db.close()
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
