/**
 * Write down the pages that carry an address the manifest never recorded (2026-09-21).
 *
 *   npm run manifest-backfill -- ~/vault            # report
 *   npm run manifest-backfill -- ~/vault --apply    # write and commit once
 *
 * WHY. `.raw/.manifest.json`'s `address_map` is the vault's path-to-address record, and it is
 * what a re-ingest consults before allocating: a page already in it keeps the address it has.
 * The ingest skill writes an entry for every page it creates. No other skill mentions
 * addressing at all, so a research run gives its pages an address from the vault's general rule
 * and records nothing, and the map falls behind by exactly the pages that run wrote. Measured
 * the day this was written: 73 of 1274 addressed pages were missing, every single one of them
 * created by a research run, not one by an ingest.
 *
 * `manifest-sync.ts` keeps NEW pages out of that hole, inside each run's own commit. This is
 * the one-off for the pages already written, and it uses the same code: the address is READ off
 * the page, never allocated, an entry that exists is never overwritten, and a page with no
 * address of its own is left alone, because a missing address is a different defect and
 * inventing a number would be the worst possible answer to it.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { addressOf, syncManifest, MANIFEST_PATH } from '../pipeline/manifest-sync.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const cwd = process.env['INIT_CWD'] ?? process.cwd()
const given = args.find((a) => !a.startsWith('--'))
const vault = path.resolve(cwd, given ?? path.join(process.env['HOME'] ?? '', 'vault'))

/** Every markdown page under `wiki/`, in a stable order so two runs report the same thing. */
function wikiPages(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) walk(child)
      else if (e.name.endsWith('.md')) out.push(child)
    }
  }
  walk('wiki')
  return out
}

function main(): number {
  if (!fs.existsSync(path.join(vault, 'wiki'))) {
    console.error(`not a vault: ${vault}`)
    return 2
  }
  let map: Record<string, unknown>
  try {
    map = (JSON.parse(fs.readFileSync(path.join(vault, MANIFEST_PATH), 'utf8')) as { address_map?: Record<string, unknown> }).address_map ?? {}
  } catch {
    console.error(`no readable ${MANIFEST_PATH} in ${vault}`)
    return 2
  }

  const missing = wikiPages(vault)
    .filter((rel) => !Object.prototype.hasOwnProperty.call(map, rel))
    .map((rel) => ({ rel, address: addressOf(vault, rel) }))
    .filter((e): e is { rel: string; address: string } => e.address !== null)

  console.log(`${Object.keys(map).length} entries in the map, ${missing.length} addressed page(s) it does not know`)
  for (const { rel, address } of missing) console.log(`  ${address}  ${rel}`)
  if (missing.length === 0) return 0
  if (!apply) {
    console.log('\ndry run - pass --apply to write and commit')
    return 0
  }

  const git = (...a: string[]): string => execFileSync('git', ['-C', vault, ...a], { encoding: 'utf8' }).trim()
  const dirty = git('status', '--short')
  if (dirty !== '') {
    console.error(`vault has uncommitted changes; commit or stash them first:\n${dirty}`)
    return 3
  }
  if (!syncManifest(vault, { renames: [], added: missing.map((m) => m.rel) })) {
    console.error('nothing was written - the manifest is not in a shape this can update')
    return 4
  }
  git('add', '--', MANIFEST_PATH)
  git('commit', '--no-verify', '-m', 'fix: record the addresses the manifest never learned about')
  console.log(`\ncommitted ${git('log', '-1', '--format=%h %s')}`)
  return 0
}

process.exit(main())
