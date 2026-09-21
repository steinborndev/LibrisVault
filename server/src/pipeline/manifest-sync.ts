/**
 * Keeping `.raw/.manifest.json` in step with what a run's commit does to the pages it names
 * (2026-09-21).
 *
 * WHAT THE MANIFEST IS FOR. `skills/wiki-ingest/SKILL.md` makes `address_map` the vault's
 * path-to-address record, and says what it is for: on a re-ingest the map is consulted FIRST,
 * and a page already in it keeps its address instead of being given a second one. It also says
 * a rename must move the key while preserving the value.
 *
 * TWO WAYS IT FELL BEHIND, both measured on the live vault the day this was written.
 *
 *  - A rename. The lint-fix run shortened an over-long source title, which shortened the file
 *    name, and rewrote every wikilink to it. It left `.raw/` alone and said so in its report,
 *    treating it as service-owned, which is right. Nothing else followed the rename, so the map
 *    went on naming a file that no longer existed, and so did the `pages_created` list of the
 *    job that produced the page.
 *  - A new page. `skills/autoresearch/SKILL.md` never mentions addressing at all, so a research
 *    run gives its pages an address from the vault's general rule and records nothing. 73 of
 *    1274 addressed pages were missing from the map, and every single one of them was created
 *    by a research run; no ingest ever left a gap.
 *
 * WHY IN THE COMMIT. Both facts are only unambiguous in the index: git has just matched a
 * deletion to an addition by content, and the added paths are exactly this run's. So the
 * manifest is brought into step between staging and committing and rides along in the run's own
 * commit rather than in one of its own, which is what keeps "one run, one commit" true - the
 * same shape as the hub writer (CLAUDE.md hard rule 1).
 *
 * SCOPE. Only paths under `wiki/`, only the path strings and the address a page already carries
 * in its own frontmatter. No address is invented, allocated, changed or removed, an entry that
 * already exists is never overwritten, and a manifest that is missing, unreadable or shaped
 * differently is left untouched: it belongs to the vault, and a repair that cannot be made
 * safely is not made.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Where the vault keeps it. Same constant the address rules use. */
export const MANIFEST_PATH = '.raw/.manifest.json'

/** `c-000042`. Anything else in an `address:` field is somebody else's problem, not a key. */
const ADDRESS = /^[cl]-\d{6}$/

export interface Rename {
  readonly from: string
  readonly to: string
}

export interface StagedChanges {
  /** Renames git matched by content, old path to new. */
  readonly renames: Rename[]
  /** Paths this commit ADDS, which is where a new page's address comes from. */
  readonly added: string[]
}

/**
 * What the INDEX says this commit is about to record.
 *
 * `-M` is git's own similarity detection; a rename it cannot see (a page rewritten beyond
 * recognition in the same commit) reads as a delete plus an add, and the manifest then keeps
 * the stale entry, which is where we were before this existed and what the address-map rule
 * reports.
 */
export function parseStagedChanges(nameStatusZ: string): StagedChanges {
  /*
   * `--name-status -z` writes a rename as three NUL-separated fields ("R096", old, new) and
   * every other status as two. Walking the fields with that rule is the only correct way to
   * read it: a line-based parse breaks on the file names this vault has, which carry spaces,
   * commas and parentheses.
   */
  const parts = nameStatusZ.split('\0')
  const renames: Rename[] = []
  const added: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]
    if (status === undefined || status === '') continue
    if (status.startsWith('R')) {
      const from = parts[i + 1]
      const to = parts[i + 2]
      i += 2
      if (from === undefined || to === undefined || from === '' || to === '') continue
      if (!from.startsWith('wiki/') || !to.startsWith('wiki/')) continue
      renames.push({ from, to })
      continue
    }
    const target = parts[i + 1]
    i += 1
    if (target === undefined || target === '') continue
    if (status.startsWith('A') && target.startsWith('wiki/')) added.push(target)
  }
  return { renames, added }
}

/**
 * Brings the manifest into step with `changes`. Returns true when the file changed, so the
 * caller can stage it into the same commit.
 */
export function syncManifest(vaultRoot: string, changes: StagedChanges): boolean {
  if (changes.renames.length === 0 && changes.added.length === 0) return false
  const abs = path.join(vaultRoot, MANIFEST_PATH)
  let manifest: unknown
  try {
    manifest = JSON.parse(fs.readFileSync(abs, 'utf8'))
  } catch {
    return false
  }
  if (!isRecord(manifest)) return false

  const renamed = followRenames(manifest, changes.renames)
  const recorded = recordAddresses(vaultRoot, manifest, changes.added)
  if (!renamed && !recorded) return false

  // Two spaces and a trailing newline: what the vault's own tooling writes, so the update does
  // not show up as a whole-file reformat in the diff.
  fs.writeFileSync(abs, `${JSON.stringify(manifest, null, 2)}\n`)
  return true
}

/** Moves a renamed page's path in `address_map` and in the `pages_created` list that names it. */
function followRenames(root: Record<string, unknown>, renames: readonly Rename[]): boolean {
  let changed = false
  for (const { from, to } of renames) {
    if (from === to) continue

    // `address_map`: one entry per page, keyed by path. Insertion order is preserved so the
    // file stays readable as a history rather than being resorted by an unrelated repair.
    const map = root['address_map']
    if (isRecord(map) && has(map, from) && !has(map, to)) {
      const rebuilt: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(map)) rebuilt[k === from ? to : k] = v
      root['address_map'] = rebuilt
      changed = true
    }

    // `sources`: one entry per ingest job, each listing the pages it created.
    const sources = root['sources']
    if (!isRecord(sources)) continue
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
  return changed
}

/**
 * Adds an entry for each new page that carries an address of its own.
 *
 * The address is READ, never allocated: the page already has it, and this only writes down
 * which page holds it. A page without one is left alone - that is a different defect, the one
 * the vault's own lint reports as "missing address", and inventing a number here would be the
 * worst possible answer to it. An entry that already exists is never overwritten, because the
 * map is what decides which address a re-ingest reuses.
 */
function recordAddresses(vaultRoot: string, root: Record<string, unknown>, added: readonly string[]): boolean {
  if (added.length === 0) return false
  const map = root['address_map']
  if (!isRecord(map)) return false
  let changed = false
  for (const rel of added) {
    if (has(map, rel)) continue
    const address = addressOf(vaultRoot, rel)
    if (address === null) continue
    map[rel] = address
    changed = true
  }
  return changed
}

/** The `address:` a page states in its own frontmatter, or null. */
export function addressOf(vaultRoot: string, rel: string): string | null {
  let head: string
  try {
    // The frontmatter is at the top; a whole research page is not worth reading for one field.
    const fd = fs.openSync(path.join(vaultRoot, rel), 'r')
    try {
      const buf = Buffer.alloc(2048)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      head = buf.subarray(0, n).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  if (!head.startsWith('---')) return null
  const end = head.indexOf('\n---', 3)
  const front = end === -1 ? head : head.slice(0, end)
  const m = /^address:[ \t]*(\S+)[ \t]*$/m.exec(front)
  const value = m?.[1]?.replace(/^["']|["']$/g, '')
  return value !== undefined && ADDRESS.test(value) ? value : null
}

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
