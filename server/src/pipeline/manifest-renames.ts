/**
 * Keeping `.raw/.manifest.json` pointed at a page that a run renamed (2026-09-21).
 *
 * WHAT WENT WRONG. The lint-fix run of 2026-09-21 did exactly what the title-length rule asks:
 * a source page whose title was 145 characters got a shorter title and, necessarily, a shorter
 * file name. It rewrote the wikilinks on the six pages that referenced it, and it deliberately
 * left the manifest alone, saying so in its own report: it treats `.raw/` as service-owned
 * infrastructure, which is right. Nobody else followed the rename either, so the manifest kept
 * naming a file that no longer existed, in two places: the `address_map` entry that carries the
 * page's DragonScale address, and the `pages_created` list of the job that produced it.
 *
 * WHY HERE. The rename is only unambiguous in the index, at the moment of the commit: git has
 * just matched the deletion to the addition by content. Reconstructing it afterwards means
 * guessing. So the manifest is repaired between staging and committing, and rides along in the
 * run's own commit rather than in one of its own - the same shape as the hub writer
 * (CLAUDE.md hard rule 1), and it keeps "one run, one commit" true.
 *
 * SCOPE. Only paths under `wiki/`, only entries the manifest already holds, and only the path
 * strings: no address is invented, changed or removed, and a rename to a path the manifest
 * already knows is left alone rather than merged. A manifest that is missing, unreadable or
 * shaped differently is left untouched - it belongs to the vault, and a repair that cannot be
 * made safely is not made.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Where the vault keeps it. Same constant the address rules use. */
export const MANIFEST_PATH = '.raw/.manifest.json'

export interface Rename {
  readonly from: string
  readonly to: string
}

/**
 * The renames git matched in the INDEX, i.e. what this commit is about to record.
 *
 * `-M` is git's own similarity detection; a rename it cannot see (a page rewritten beyond
 * recognition in the same commit) leaves the manifest as it was, which is where we were
 * before this existed.
 */
export function parseStagedRenames(nameStatusZ: string): Rename[] {
  /*
   * `--name-status -z` writes a rename as three NUL-separated fields: "R096", old, new. Every
   * other status is two. Splitting on NUL and walking with that rule is the only correct way
   * to read it; a line-based parse breaks on the file names this vault has, which contain
   * spaces, commas and parentheses.
   */
  const parts = nameStatusZ.split('\0')
  const out: Rename[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]
    if (status === undefined || status === '') continue
    if (!status.startsWith('R')) continue
    const from = parts[i + 1]
    const to = parts[i + 2]
    i += 2
    if (from === undefined || to === undefined || from === '' || to === '') continue
    if (!from.startsWith('wiki/') || !to.startsWith('wiki/')) continue
    out.push({ from, to })
  }
  return out
}

/**
 * Rewrites the manifest's path references for `renames`. Returns true when the file changed,
 * so the caller can stage it into the same commit.
 */
export function followRenames(vaultRoot: string, renames: readonly Rename[]): boolean {
  if (renames.length === 0) return false
  const abs = path.join(vaultRoot, MANIFEST_PATH)
  let raw: string
  try {
    raw = fs.readFileSync(abs, 'utf8')
  } catch {
    return false
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(raw)
  } catch {
    return false
  }
  if (typeof manifest !== 'object' || manifest === null) return false
  const root = manifest as Record<string, unknown>

  let changed = false
  for (const { from, to } of renames) {
    if (from === to) continue

    // `address_map`: one entry per page, keyed by path. Insertion order is preserved so the
    // file stays readable as a history rather than being resorted by an unrelated repair.
    const map = root['address_map']
    if (isRecord(map) && Object.prototype.hasOwnProperty.call(map, from) && !Object.prototype.hasOwnProperty.call(map, to)) {
      const rebuilt: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(map)) rebuilt[k === from ? to : k] = v
      root['address_map'] = rebuilt
      changed = true
    }

    // `sources`: one entry per ingest job, each listing the pages it created.
    const sources = root['sources']
    if (isRecord(sources)) {
      for (const entry of Object.values(sources)) {
        if (!isRecord(entry)) continue
        const pages = entry['pages_created']
        if (!Array.isArray(pages)) continue
        let hit = false
        const next = pages.map((p) => {
          if (p !== from) return p
          hit = true
          return to
        })
        if (hit) {
          entry['pages_created'] = next
          changed = true
        }
      }
    }
  }
  if (!changed) return false

  // Two spaces and a trailing newline: what the vault's own tooling writes, so the repair does
  // not show up as a whole-file reformat in the diff.
  fs.writeFileSync(abs, `${JSON.stringify(manifest, null, 2)}\n`)
  return true
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
