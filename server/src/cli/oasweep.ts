/**
 * The reading list's open-copy sweep, as a dry run (docs/sources/SPEC.md section 6.4).
 *
 * Prints which entries the nightly sweep would ask about and what the resolvers answer, and
 * writes NOTHING: no mark on the page, no commit, no job. That is the whole point of having it
 * as a CLI - the sweep itself runs inside the night shift, where nobody watches it pick.
 *
 * Run: VAULT_ROOT=~/vault npx tsx server/src/cli/oasweep.ts [--write] [--limit N]
 *
 * `--write` marks the finds the way the shift does (one commit behind the mutex); without it
 * nothing on disk changes. The lookups are cached in `oa_lookups` either way, which is what
 * makes a later ingest of a find rescue itself without asking the APIs again.
 */

import { loadConfig } from '../config.js'
import { openDb, defaultDbPath } from '../db/index.js'
import { JobStore } from '../db/jobs.js'
import { OaLookupStore } from '../db/oa.js'
import { Mutex } from '../util/mutex.js'
import { ReadingListService, SWEEP_MAX_LOOKUPS, openCopyCandidates, parseReadingList, READING_LIST_PAGE } from '../pipeline/reading-list.js'
import { lookupOpenAccess, lookupSaysNothing, oaCacheOver } from '../pipeline/preprocess/oa.js'
import { detectTools } from '../pipeline/preprocess/index.js'
import fs from 'node:fs'
import path from 'node:path'

const config = loadConfig()
const args = process.argv.slice(2)
const write = args.includes('--write')
const limitAt = args.indexOf('--limit')
const limit = limitAt === -1 ? SWEEP_MAX_LOOKUPS : Math.max(1, Number(args[limitAt + 1] ?? SWEEP_MAX_LOOKUPS))
const today = new Date().toISOString().slice(0, 10)

const main = async (): Promise<void> => {
  const db = openDb(defaultDbPath())
  const store = new OaLookupStore(db)
  const cache = oaCacheOver(store)
  const reading = new ReadingListService(config.vaultRoot, new JobStore(db), {
    commitMutex: new Mutex(),
    autoCommit: () => write,
  })
  /*
   * A dry run must not change what tonight's sweep does. Only a round that named NO copy skips a
   * DOI; a round that named one is read back from the row, so running this first costs the APIs
   * nothing tonight and hides nothing from the board.
   */
  const answeredRecently = (doi: string): boolean => {
    const row = cache.get(doi)
    return row !== undefined && lookupSaysNothing(row, new Date())
  }

  const page = ((): string => {
    try {
      return fs.readFileSync(path.join(config.vaultRoot, READING_LIST_PAGE), 'utf8')
    } catch {
      return ''
    }
  })()
  const entries = parseReadingList(page)
  const candidates = openCopyCandidates(entries, { answeredRecently, limit })
  console.log(`reading list: ${entries.length} entries, ${candidates.length} to ask about (limit ${limit})`)
  console.log(`mode: ${write ? 'WRITE - finds are marked and committed' : 'dry run - nothing is written'}\n`)
  for (const c of candidates) {
    console.log(`- ${c.entry.title.slice(0, 70)}`)
    console.log(`  ${c.arxivId !== undefined ? `arXiv:${c.arxivId}` : c.doi} | ${c.entry.blocked ?? 'no reason given'} | by ${c.entry.by ?? 'unknown'}`)
  }

  const tools = await detectTools()
  const { checked, found } = await reading.markOpenCopies({
    today,
    answeredRecently,
    limit,
    dryRun: !write,
    lookup: async (doi) => {
      const round = await lookupOpenAccess(doi, { jobDir: config.vaultRoot, tools, cache })
      const best = round.accepted ?? round.candidates[0]
      if (best === undefined) {
        console.log(`  ${doi}: no open copy (${round.rateLimited ? 'rate limited, not recorded as absent' : 'nothing found'})`)
        return undefined
      }
      console.log(`  ${doi}: ${best.source} ${best.version ?? 'version not stated'} at ${best.host} -> ${best.url}`)
      return { url: best.url, version: best.version, at: today }
    },
  })
  console.log(`\n${checked} asked, ${found.length} with an open copy${write ? ' (marked)' : ' (nothing written)'}`)
  for (const f of found) console.log(`  ${f.entry.title.slice(0, 60)} -> ${f.copy.url}`)
  db.close()
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
