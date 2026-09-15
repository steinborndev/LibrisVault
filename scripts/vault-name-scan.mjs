/**
 * Look for private vault content in files, which the commit-msg hook structurally cannot.
 *
 * The hook (`scripts/git-hooks/commit-msg`) reads the commit MESSAGE. Every leak the
 * 2026-09-15 audit actually found was in file CONTENT: examples in comments, UI placeholders,
 * test fixtures, run output quoted into a design record. And `gh pr create` text is not a
 * commit message either, which makes the PR body the likeliest leak of all.
 *
 * So this is the half the hook cannot do, as a thing you run rather than a thing you remember:
 *
 *   node scripts/vault-name-scan.mjs                      # every tracked file
 *   node scripts/vault-name-scan.mjs --diff <base>        # only what a merge would add
 *   node scripts/vault-name-scan.mjs --file pr-body.txt   # the PR text before it is posted
 *
 * WHAT IT CANNOT SEE, because trusting it further than it goes is how the first audit missed
 * two fixtures. The term list is built from vault page TITLES, as they are RIGHT NOW.
 *
 *   1. A subject that lives only in the database - a Fellow's standing task, a planner's
 *      answer quoted into a document - names things no title carries. Read quoted run output
 *      with your own eyes.
 *   2. A page the vault has since removed leaves no title to build a term from, so a fixture
 *      naming it passes clean while still saying what the vault once held. One of the 2026-09-15
 *      fixtures was exactly that: a real concept page, reverted later, invisible to this scan
 *      and a leak all the same. `git -C $VAULT_ROOT log -S "<term>"` is the check for a term
 *      you suspect; there is no way to enumerate them.
 *   3. It reads text. A PNG cannot be scanned and has to be looked at.
 *
 * Exit code is 0 when nothing matched, 1 when something did. Nothing is judged for you: a hit
 * is a line to look at, not a verdict. Product vocabulary that happens to also be a page title
 * ("hot cache", an entity named after an ordinary word) lands here every time.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const argOf = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const VAULT = process.env.VAULT_ROOT ?? join(homedir(), 'vault')
if (!existsSync(join(VAULT, 'wiki'))) {
  console.log(`no vault at ${VAULT} - nothing to compare against, passing`)
  process.exit(0)
}

/*
 * Ordinary words that are also page titles, and this product's own vocabulary. Kept identical
 * in spirit to the hook's list: a term here is one whose appearance says nothing about what
 * the vault holds, so matching it only trains the reader to ignore output.
 */
const STOP = new Set([
  'data', 'code', 'test', 'page', 'user', 'index', 'log', 'hot', 'meta', 'core', 'self',
  'state of the art', 'patent landscape', 'startup landscape', 'hot cache', 'system prompt',
])

const deny = new Map()
const add = (t) => {
  const term = t.replace(/^[\s\-:,]+|[\s\-:,]+$/g, '')
  if (term.length < 4 || STOP.has(term.toLowerCase())) return
  if (!deny.has(term.toLowerCase())) deny.set(term.toLowerCase(), term)
}
/** A title's parts, the way a fixture writer quotes a piece of one. Two words minimum. */
const addFragments = (stem) => {
  for (const part of stem.replace(/[()]/g, ' ').split(/\s+[-–—]\s+|[:,]/)) {
    const piece = part.replace(/^[\s\-:,]+|[\s\-:,]+$/g, '')
    if (piece.split(/\s+/).length >= 2 && piece.length >= 8) add(piece)
  }
}

// Every bucket that says what the vault is ABOUT. `concepts` is in, unlike in the hook: a
// false positive costs a glance here and a blocked commit there, so the trade runs the other
// way - and a concept title HAS leaked into a fixture before.
for (const bucket of ['entities', 'sources', 'questions', 'comparisons', 'folds', 'concepts']) {
  const dir = join(VAULT, 'wiki', bucket)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue
    const stem = name.slice(0, -3)
    add(stem)
    addFragments(stem)
    for (const h of readFileSync(join(dir, name), 'utf8').match(/@[A-Za-z0-9_]{2,}|0x_[A-Za-z0-9]+/g) ?? []) add(h)
  }
}

// One alternation, longest first, so a hit reports the longest term that matched rather than
// a short fragment of it.
const pattern = new RegExp(
  '(?<!\\w)(' + [...deny.keys()].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?!\\w)',
  'g',
)

const git = (a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 })
let units
const base = argOf('--diff')
const single = argOf('--file')
if (single) {
  units = [{ label: single, text: readFileSync(single, 'utf8') }]
} else if (base) {
  // Added lines only: what a merge would introduce, not what is already public.
  const added = git(['diff', '--text', `${base}...HEAD`]).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  units = [{ label: `added lines since ${base}`, text: added.join('\n') }]
} else {
  units = git(['ls-files'])
    .split('\n')
    .filter((f) => f && !f.startsWith('docs/local/') && !f.startsWith('docs/studio/'))
    .map((f) => {
      try {
        return { label: f, text: readFileSync(f, 'utf8') }
      } catch {
        return null // binary or unreadable; a PNG cannot be scanned and must be looked at
      }
    })
    .filter(Boolean)
}

console.log(`${deny.size} terms from ${VAULT}, over ${units.length} unit(s)\n`)
let hits = 0
for (const unit of units) {
  const found = [...new Set([...unit.text.toLowerCase().matchAll(pattern)].map((m) => deny.get(m[1])))]
  if (found.length === 0) continue
  hits += found.length
  console.log(`  ${unit.label}`)
  for (const f of found) console.log(`      ${f}`)
}

if (hits === 0) {
  console.log('nothing matched.')
  process.exit(0)
}
console.log(`\n${hits} match(es). Each is a line to LOOK AT, not a verdict - product vocabulary`)
console.log('that is also a page title lands here every time. And remember what this cannot see:')
console.log('a subject that lives in the database, quoted into a document, carries no page title.')
process.exit(1)
