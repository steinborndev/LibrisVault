/**
 * Rename the pages whose FILE NAME carries a character a file name cannot hold (2026-09-21).
 *
 *   npm run rename-unsafe -- ~/vault            # report
 *   npm run rename-unsafe -- ~/vault --apply    # rename, rewrite the links, commit once
 *
 * WHY. This vault is read from Windows over a share, where a name containing `:` `?` `*` `"`
 * `<` `>` `|` `/` `\` cannot be opened at all, and the vault's own lint counts such names as
 * filename-forbidden. 39 pages were in that state when this was written, 34 of them research
 * target pages filed as `Research: <topic>.md`. The service stopped producing them earlier
 * that day - `researchTargetTitle` writes `Research - <topic>` now - so this is the one-off for
 * the pages already there, the same shape as `fix-meta-page-titles.mjs` was for the notebooks.
 *
 * WHAT IT TOUCHES, and nothing else:
 *
 *   - the file name, through `git mv`, so the rename is in the index and git records it as one;
 *   - that page's `title:` and `aliases:` where they carry the same prefix, and its first `# `
 *     heading;
 *   - every `[[wikilink]]` naming the old file name, anywhere under `wiki/`, in all its forms
 *     (plain, `|alias`, `#heading`).
 *
 * The `.raw/.manifest.json` address map is NOT touched here: `manifest-sync.ts` follows the
 * rename into it from the commit itself, which is the one place where the rename is a fact
 * rather than a guess. That is also why the commit goes through `commitVault`.
 *
 * WHAT IT REFUSES. Only the unambiguous shape is renamed: a `Research: ` prefix becomes
 * `Research - `. A `*` that is part of an astronomical name, a `?` that ends a source article's
 * own title, a quoted phrase - each of those changes what the page is CALLED, not just how it
 * is filed, and a script should not decide that. They are listed and left alone.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { commitVault } from '../pipeline/git.js'

const UNSAFE = /[/\\:?*"<>|]/
const UNSAFE_G = /[/\\:?*"<>|]/g
const PREFIX = 'Research: '
const REPLACEMENT = 'Research - '

/**
 * The name a page should be filed under.
 *
 * The `Research: ` prefix becomes `Research - `, which is what the service writes today, so the
 * old pages end up looking like the new ones. Every other forbidden character is DROPPED rather
 * than substituted (`--strip`), because there is no substitution that reads well in all of
 * them: a question mark ending an article's own title, an asterisk inside an astronomical
 * designation, a quoted phrase. Dropping leaves the words; the run space collapse keeps the
 * result from carrying the gap where the character was.
 */
export function safeName(oldName: string, strip: boolean): string | null {
  let name = oldName.startsWith(PREFIX) ? REPLACEMENT + oldName.slice(PREFIX.length) : oldName
  if (UNSAFE.test(name)) {
    if (!strip) return null
    name = name.replace(UNSAFE_G, '').replace(/ {2,}/g, ' ').replace(/ +([,.;)])/g, '$1').trim()
  }
  return name === '' || name === oldName ? null : name
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
/** Also drop the characters that have no good substitute, rather than leaving those pages. */
const strip = args.includes('--strip')
/** Repair the TITLE line instead, on pages whose file name is already clean. */
const titles = args.includes('--titles')
const cwd = process.env['INIT_CWD'] ?? process.cwd()
const vault = path.resolve(cwd, args.find((a) => !a.startsWith('--')) ?? path.join(process.env['HOME'] ?? '', 'vault'))

interface Rename {
  readonly from: string
  readonly to: string
  readonly oldName: string
  readonly newName: string
}

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

/**
 * Rewrites every `[[old]]`, `[[old|alias]]` and `[[old#heading]]` in `text`. Matching is on the
 * whole target, so a page whose name merely STARTS with another's is not caught by it.
 */
export function rewriteLinks(text: string, byOldName: ReadonlyMap<string, string>): { text: string; hits: number } {
  let hits = 0
  const out = text.replace(/\[\[([^\]]*?)\]\]/g, (whole, inner: string) => {
    const cut = inner.search(/[|#]/)
    const target = (cut === -1 ? inner : inner.slice(0, cut)).trim()
    const rest = cut === -1 ? '' : inner.slice(cut)
    const renamed = byOldName.get(target)
    if (renamed === undefined) return whole
    hits++
    return `[[${renamed}${rest}]]`
  })
  return { text: out, hits }
}

/**
 * The page's own naming lines: the `title:`, the `aliases:` entries that repeat it, and the
 * first `# ` heading. Deliberately NOT a replace over the whole file - a page may name the
 * prefix in prose about something else, and a rename is not a licence to edit the body.
 */
export function retitle(text: string): string {
  const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1
  const front = end === -1 ? '' : text.slice(0, end)
  const body = end === -1 ? text : text.slice(end)
  const fixed = front
    .split('\n')
    .map((line) => {
      const named = /^(title:[ \t]*|[ \t]*-[ \t]*)(["']?)(.*)$/.exec(line)
      if (named === null || !named[3]!.startsWith(PREFIX)) return line
      return `${named[1]}${named[2]}${REPLACEMENT}${named[3]!.slice(PREFIX.length)}`
    })
    .join('\n')
  // The first heading only, and only when it is the name rather than a sentence about it.
  const withHeading = body.replace(new RegExp(`^# ${PREFIX}`, 'm'), `# ${REPLACEMENT}`)
  return fixed + withHeading
}

/**
 * The title a page should carry, or null when it is already fine.
 *
 * Two routes, and the first one is the better evidence. Where the file name is the SAME WORDS
 * as the title with the character already dealt with, the file name shows what was meant when
 * the page was created, and it is taken as the title. Otherwise the characters are dealt with
 * here, and not all of them the same way: a slash or a backslash separates two terms and
 * becomes a hyphen (dropping it welds them into one word), while a question mark, an asterisk,
 * a quotation mark and an angle bracket leave nothing behind when removed.
 */
export function titleFor(fileName: string, title: string): string | null {
  if (title === '' || !UNSAFE.test(title)) return null
  /*
   * A YAML escape means the raw line is not the value: `\"` is one quotation mark, and the
   * backslash in front of it is syntax. Running a character rule over the raw text turns that
   * backslash into a hyphen. Two titles in the vault are in this state; they are left for a
   * person rather than guessed at.
   */
  if (/\\["\\]/.test(title)) return null
  const key = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (key(title) === key(fileName)) return fileName === title ? null : fileName
  const cleaned = title
    .replace(/[/\\]/g, '-')
    .replace(/:[ \t]+/g, ' - ')
    .replace(/[:?*"<>|]/g, '')
    .replace(/ {2,}/g, ' ')
    .replace(/ +([,.;)\]])/g, '$1')
    .trim()
  return cleaned === '' || cleaned === title ? null : cleaned
}

/**
 * The other half of the same defect: the FILE name is clean, and the title still carries the
 * character. No page is renamed and no link is touched - only the `title:` line moves, so this
 * is the cheap half and it runs on its own.
 */
async function repairTitles(): Promise<number> {
  const changes: { rel: string; from: string; to: string }[] = []
  for (const rel of wikiPages(vault)) {
    const abs = path.join(vault, rel)
    const text = fs.readFileSync(abs, 'utf8')
    const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1
    if (end === -1) continue
    const m = /^title:[ \t]*("?)(.*?)\1[ \t]*$/m.exec(text.slice(0, end))
    if (m === null) continue
    const next = titleFor(path.basename(rel, '.md'), m[2]!)
    if (next === null) continue
    changes.push({ rel, from: m[2]!, to: next })
  }
  console.log(`${changes.length} title(s) to clean`)
  for (const c of changes.slice(0, 200)) console.log(`  ${c.from.slice(0, 88)}\n  -> ${c.to.slice(0, 88)}`)
  if (changes.length === 0 || !apply) {
    if (changes.length > 0) console.log('\ndry run - pass --apply to write and commit')
    return 0
  }

  const git = (...a: string[]): string => execFileSync('git', ['-C', vault, ...a], { encoding: 'utf8' }).trim()
  if (git('status', '--short') !== '') {
    console.error('vault has uncommitted changes; commit or stash them first')
    return 3
  }
  for (const c of changes) {
    const abs = path.join(vault, c.rel)
    const text = fs.readFileSync(abs, 'utf8')
    const end = text.indexOf('\n---', 3)
    // Only inside the frontmatter block, and only that one line.
    const front = text.slice(0, end).replace(/^title:[ \t]*("?)(.*?)\1[ \t]*$/m, (_w, q: string) => `title: ${q}${c.to}${q}`)
    fs.writeFileSync(abs, front + text.slice(end))
  }
  const res = await commitVault(vault, 'fix: title the pages as names a file name can hold', { pathspec: changes.map((c) => c.rel) })
  console.log(`\n${res.committed ? `committed ${git('log', '-1', '--format=%h %s')}` : `nothing committed: ${res.note ?? ''}`}`)
  return res.committed ? 0 : 4
}

async function main(): Promise<number> {
  if (!fs.existsSync(path.join(vault, 'wiki'))) {
    console.error(`not a vault: ${vault}`)
    return 2
  }

  const renames: Rename[] = []
  const skipped: string[] = []
  for (const rel of wikiPages(vault)) {
    const oldName = path.basename(rel, '.md')
    if (!UNSAFE.test(oldName)) continue
    const newName = safeName(oldName, strip)
    if (newName === null) {
      skipped.push(rel)
      continue
    }
    const to = `${path.dirname(rel)}/${newName}.md`
    if (fs.existsSync(path.join(vault, to))) {
      // The cleaned name is already taken by another page; merging two pages is not a rename.
      skipped.push(rel)
      continue
    }
    renames.push({ from: rel, to, oldName, newName })
  }

  if (titles) return await repairTitles()

  const byOldName = new Map(renames.map((r) => [r.oldName, r.newName]))
  console.log(`${renames.length} page(s) to rename, ${skipped.length} left for a person`)
  for (const r of renames) console.log(`  ${r.oldName.slice(0, 92)}\n  -> ${r.newName.slice(0, 92)}`)
  if (skipped.length > 0) {
    console.log(`\nleft alone${strip ? '' : ' - pass --strip to drop the characters that have no good substitute'}:`)
    for (const rel of skipped) console.log(`  ${rel.slice(0, 100)}`)
  }
  if (renames.length === 0) return 0

  // Count the link rewrites before deciding anything, so the dry run says what it would do.
  const touched: { rel: string; text: string; hits: number }[] = []
  for (const rel of wikiPages(vault)) {
    const text = fs.readFileSync(path.join(vault, rel), 'utf8')
    const { text: next, hits } = rewriteLinks(text, byOldName)
    if (hits > 0) touched.push({ rel, text: next, hits })
  }
  const links = touched.reduce((n, t) => n + t.hits, 0)
  console.log(`\n${links} wikilink(s) on ${touched.length} page(s) name one of them`)
  if (!apply) {
    console.log('dry run - pass --apply to rename, rewrite and commit')
    return 0
  }

  const git = (...a: string[]): string => execFileSync('git', ['-C', vault, ...a], { encoding: 'utf8' }).trim()
  const dirty = git('status', '--short')
  if (dirty !== '') {
    console.error(`vault has uncommitted changes; commit or stash them first:\n${dirty}`)
    return 3
  }

  /*
   * Link rewrites first, while the old names still resolve on disk, then the moves. The moved
   * pages get their own rewrite from this same pass, because they link each other.
   */
  for (const t of touched) fs.writeFileSync(path.join(vault, t.rel), t.text)
  for (const r of renames) {
    const abs = path.join(vault, r.from)
    fs.writeFileSync(abs, retitle(fs.readFileSync(abs, 'utf8')))
    git('mv', '--', r.from, r.to)
  }

  /*
   * Through `commitVault`, not a bare `git commit`: it is what follows the rename into
   * `.raw/.manifest.json`, from the index, where the rename is a fact rather than a guess.
   */
  const pathspec = [...new Set([...touched.map((t) => t.rel), ...renames.map((r) => r.to)])]
  const res = await commitVault(vault, 'fix: file the research pages under names every system can open', { pathspec })
  console.log(`\n${res.committed ? `committed ${git('log', '-1', '--format=%h %s')}` : `nothing committed: ${res.note ?? ''}`}`)
  return res.committed ? 0 : 4
}

// Only when run as a command; the pure helpers above are imported by other code. No top-level
// await: it makes the module unimportable from a CommonJS loader, and the tests import it.
const invoked = process.argv[1] ?? ''
if (invoked.endsWith('rename-unsafe-names.ts') || invoked.endsWith('rename-unsafe-names.js')) {
  void main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err)
      process.exit(1)
    },
  )
}
