/**
 * Take the arrival mark off reading-list entries that never held a document (2026-09-14).
 *
 * An entry is marked `filed:` when the publication it asked for arrives in the vault. The
 * resolver behind that mark finds a source page by the identity the entry names - its DOI, or
 * failing that its url - and for a long while a match alone was taken as arrival.
 *
 * It is not. A research step writes a source page from what it read on the web, and such a page
 * carries the publication's DOI and url, so an entry could match the write-up its own request
 * had produced. The entry was then marked as arrived, the board said "in the vault", and the
 * Fellow that asked was told to go read a document the vault does not have.
 *
 * `locate()` knows the difference now (`held`), so no new mark can be wrong. This sweep is for
 * the ones already on the page: it asks the same question of every entry that carries a mark
 * and removes the two lines where the answer is no. Nothing else in the block is touched - what
 * the Fellow asked for and why, the access, the open-copy lines all stay, and the entry simply
 * goes back to being one the board offers the ingest for.
 *
 * Dry run by default. `--apply` writes through `PUT /api/v1/pages`, the one sanctioned path for
 * a non-agent vault mutation (CLAUDE.md hard rule 1): the service holds the commit mutex across
 * check-and-write, so the edit is one revertable commit that cannot interleave with an agent's.
 *
 *   npx tsx src/cli/readingsweep.ts
 *   npx tsx src/cli/readingsweep.ts --apply
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDb, defaultDbPath } from '../db/index.js'
import { JobStore } from '../db/jobs.js'
import { ReadingListService, READING_LIST_PAGE } from '../pipeline/reading-list.js'
import { SourceIndexBuilder } from '../pipeline/sources.js'

interface Args {
  readonly vault: string
  readonly api: string
  readonly apply: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
  }
  const port = process.env['PORT'] ?? '8421'
  return {
    vault: path.resolve(get('vault', process.env['VAULT_ROOT'] ?? '~/vault').replace(/^~/, os.homedir())),
    api: get('api', `http://127.0.0.1:${port}`),
    apply: argv.includes('--apply'),
  }
}

/** The `- title:` line that opens an entry's block, as the page writes it. */
const TITLE_LINE = /^[ \t]*[-*][ \t]+title:[ \t]*(.*?)[ \t]*$/
/** The two lines a wrong mark consists of; every other field in the block survives. */
const MARK_LINE = /^[ \t]*(filed|filedAt):/

/**
 * The page with the mark removed from the named entries.
 *
 * Line-wise on purpose: the block belongs to whoever wrote it, and an edit that reformats
 * fields it did not come for would put the service's idea of the format into a page the
 * Fellows write by hand.
 */
export function stripMarks(markdown: string, titles: ReadonlySet<string>): string {
  const out: string[] = []
  let inside = false
  for (const line of markdown.split('\n')) {
    const title = TITLE_LINE.exec(line)
    if (title !== null) inside = titles.has(title[1] ?? '')
    else if (inside && MARK_LINE.test(line)) continue
    out.push(line)
  }
  return out.join('\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const db = openDb(defaultDbPath())
  const sources = new SourceIndexBuilder(args.vault)
  // The same question the board asks, through the same resolver: `held` is the whole verdict.
  const reading = new ReadingListService(args.vault, new JobStore(db), {
    held: (page) => sources.build().pages[page] !== undefined,
  })
  const entries = reading.entries()
  const marked = entries.filter((e) => e.filed !== null)
  const wrong = marked.filter((e) => !e.held)

  process.stdout.write(`reading list: ${entries.length} entries, ${marked.length} marked as arrived\n`)
  process.stdout.write(`${marked.length - wrong.length} of those hold a document, ${wrong.length} do not\n\n`)
  for (const e of wrong) {
    process.stdout.write(`  ${e.title}\n    marked as: ${e.filed}\n    but no ingested document stands behind that page\n`)
  }
  if (wrong.length === 0) {
    process.stdout.write('nothing to sweep.\n')
    db.close()
    return
  }

  const file = path.join(args.vault, READING_LIST_PAGE)
  const markdown = fs.readFileSync(file, 'utf8')
  const next = stripMarks(markdown, new Set(wrong.map((e) => e.title)))
  const removed = markdown.split('\n').length - next.split('\n').length
  process.stdout.write(`\n${removed} line(s) would be removed (2 per entry: filed, filedAt)\n`)
  if (removed !== wrong.length * 2) {
    process.stdout.write('REFUSED: that is not two lines per entry - the page does not look as expected.\n')
    db.close()
    process.exitCode = 1
    return
  }
  if (!args.apply) {
    process.stdout.write('\ndry run - nothing written. Re-run with --apply.\n')
    db.close()
    return
  }

  const baseMtime = fs.statSync(file).mtime.toISOString()
  const res = await fetch(`${args.api}/api/v1/pages`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: READING_LIST_PAGE, markdown: next, baseMtime }),
  })
  const body = (await res.json().catch(() => ({}))) as { commit?: string; error?: string }
  process.stdout.write(res.ok ? `\nwritten, commit ${body.commit ?? '(none)'}\n` : `\nFAILED ${res.status} ${body.error ?? ''}\n`)
  if (!res.ok) process.exitCode = 1
  db.close()
}

// Only when run as a command: the edit itself is unit-tested, and importing a module must
// never open the database or write to the vault as a side effect.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
