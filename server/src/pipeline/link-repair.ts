/**
 * Wikilinks broken by a line wrap, and the deterministic repair for them.
 *
 * An agent formatting prose to a width takes the brackets with it, and `[[Ocean Carbon\nSink]]`
 * stops resolving: Obsidian will not follow it, the graph loses the edge, and every check that
 * reads the page calls it a dead link. One lint run over a 936-page vault found 36 of its 87
 * dead links were working pages broken exactly this way, and the lint-FIX run that followed
 * wrote 19 more while creating stub pages.
 *
 * The prompts now forbid it (system-prompt.ts), which stops new ones. This module is the other
 * half: finding the existing ones and joining them back, with no model in the loop. The rule is
 * mechanical - a link whose brackets span a newline, whose collapsed title names a page that
 * exists - so it belongs in code, where it is exact, free and testable, rather than in a run
 * that costs dollars and may introduce the very defect it is fixing.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Mutex } from '../util/mutex.js'
import { withWikiLocks } from './wiki-lock.js'
import { commitPaths, type CommitResult } from './git.js'
import { indexWikiPages } from './citations.js'

/** A link split across lines: the text as written, and the title it means. */
export interface WrappedLink {
  /** The full `[[...]]` as it stands in the file, newline included. */
  readonly raw: string
  /** The target with its inner whitespace collapsed to single spaces. */
  readonly target: string
}

/**
 * Wikilinks in `markdown` whose brackets span a line break. Nothing else is touched: a link on
 * one line is fine however long, and an unclosed `[[` is not a link at all.
 */
export function findWrappedLinks(markdown: string): WrappedLink[] {
  const out: WrappedLink[] = []
  // A [[...]] that contains at least one newline and no other bracket pair inside it.
  for (const m of markdown.matchAll(/\[\[([^[\]]*\n[^[\]]*)\]\]/g)) {
    const inner = m[1]!
    // Continuation lines carry the block's own prefix - a blockquote's ">" or a list bullet -
    // and that prefix is not part of the title. Half the broken links in this vault sit inside
    // callouts, where the second line begins "> ".
    const target = inner
      .split('\n')
      .map((line, i) => (i === 0 ? line : line.replace(/^\s*(?:>\s*)*(?:[-*+]\s+)?/, '')))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (target === '') continue
    out.push({ raw: m[0]!, target })
  }
  return out
}

/**
 * Joins every wrapped link whose collapsed target names a page that exists back onto one line.
 *
 * A link that would still not resolve is LEFT as it stands: it is a genuine dead link, and
 * joining it would only hide a finding behind a cosmetic change. `exists` answers for a title
 * the way the vault's own index does (basename, case-insensitive), including a `Title#heading`
 * or `Title|alias` form.
 */
export function rejoinWrappedLinks(markdown: string, exists: (target: string) => boolean): { readonly text: string; readonly fixed: readonly string[]; readonly left: readonly string[] } {
  const fixed: string[] = []
  const left: string[] = []
  let text = markdown
  for (const link of findWrappedLinks(markdown)) {
    if (!exists(link.target)) {
      left.push(link.target)
      continue
    }
    text = text.replace(link.raw, `[[${link.target}]]`)
    fixed.push(link.target)
  }
  return { text, fixed, left }
}

/** The page a target names, ignoring a `#heading` or `|alias` tail. */
const pageOf = (target: string): string => target.split(/[#|]/)[0]!.trim()

/**
 * Joins every wrapped link in the vault's wiki that names an existing page, and commits the
 * pages it changed as one commit behind the shared mutex - the path the recap page and the
 * reading list take. No agent, no cost, and nothing else in the file is touched: the only edit
 * is removing a newline from inside a pair of brackets.
 */
export async function repairWrappedLinks(
  vaultRoot: string,
  opts: {
    readonly commitMutex?: Mutex
    readonly commit?: (root: string, message: string, paths: readonly string[]) => Promise<CommitResult>
    readonly autoCommit?: () => boolean
    /** Report what would change without writing anything. */
    readonly dryRun?: boolean
  } = {},
): Promise<{ readonly pages: readonly string[]; readonly fixed: number; readonly left: number; readonly busy: readonly string[]; readonly commit: string | null }> {
  const index = indexWikiPages(vaultRoot)
  const exists = (target: string): boolean => {
    const page = pageOf(target)
    if (page === '') return false
    if (index.has(page.toLowerCase())) return true
    // Path-qualified links (`concepts/_index`) name their file by its last segment.
    const base = page.split('/').filter(Boolean).pop() ?? ''
    return base !== '' && index.has(base.toLowerCase())
  }

  const wikiRoot = path.join(vaultRoot, 'wiki')
  const files: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile() && e.name.endsWith('.md')) files.push(abs)
    }
  }
  walk(wikiRoot)

  const changed: Array<{ rel: string; text: string }> = []
  let fixed = 0
  let left = 0
  for (const abs of files.sort()) {
    let markdown: string
    try {
      markdown = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    if (!markdown.includes('[[')) continue
    const out = rejoinWrappedLinks(markdown, exists)
    left += out.left.length
    if (out.fixed.length === 0) continue
    fixed += out.fixed.length
    changed.push({ rel: path.relative(vaultRoot, abs).split(path.sep).join('/'), text: out.text })
  }

  const pages = changed.map((c) => c.rel)
  if (changed.length === 0 || opts.dryRun === true || opts.commitMutex === undefined) {
    return { pages, fixed, left, busy: [], commit: null }
  }
  const commit = opts.commit ?? commitPaths
  let hash: string | null = null
  /*
   * The vault's per-file locks first and our commit mutex inside them, never the other way
   * round (`wiki-lock.ts`). A page another writer holds is LEFT ALONE rather than repaired
   * over the top of it: that is the vault's own guidance for a held lock, and a page an agent
   * is writing this second is a page whose links are about to change anyway.
   */
  const mutex = opts.commitMutex
  const result = await withWikiLocks(vaultRoot, pages, async (held, busyPages) => {
    const holding = new Set(held)
    const mine = changed.filter((c) => holding.has(c.rel))
    if (mine.length === 0) return { written: [] as string[], busy: busyPages }
    await mutex.runExclusive(async () => {
      for (const c of mine) fs.writeFileSync(path.join(vaultRoot, c.rel), c.text, 'utf8')
      if (opts.autoCommit?.() ?? true) {
        const res = await commit(vaultRoot, `repair: join ${fixed} wikilink(s) broken across a line`, mine.map((c) => c.rel))
        hash = res.committed ? (res.hash ?? null) : null
      }
    })
    return { written: mine.map((c) => c.rel), busy: busyPages }
  })
  // `busy` is reported rather than logged away: a caller that asked for a repair deserves to
  // know which pages it did NOT get, and a count nobody can act on is not a result.
  return { pages: result.written, fixed, left, busy: result.busy, commit: hash }
}
