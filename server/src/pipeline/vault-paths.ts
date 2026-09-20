/**
 * What counts as a wiki page path handed in from outside (a request body, a query parameter).
 *
 * The rule was written twice before it was written down: `questions.ts` guards the page a
 * strike-through edits, and the research endpoint now guards the page a question came from
 * (docs/tasks/TASKS-QUESTIONS.md, phase 1). Two copies of a containment check are two chances
 * to relax one of them, so there is one.
 *
 * Containment is the whole job: a path from outside must name a page inside `wiki/` and must
 * not be able to point anywhere else. Everything here is pure string work plus, for
 * {@link resolveWikiPage}, one existence check.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * True for a vault-relative path that names a wiki page and cannot escape the wiki.
 *
 * Rejected: anything with `..` in it, anything outside `wiki/`, anything that is not `.md`,
 * an absolute path, and a backslash (a Windows-shaped path would be one segment to POSIX
 * `path.posix` and another to the filesystem).
 */
export function isWikiPagePath(rel: string): boolean {
  if (rel === '' || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) return false
  return rel.startsWith('wiki/') && rel.endsWith('.md')
}

/**
 * The absolute path of an existing wiki page, or null when the path is not one or the page is
 * not there. Never throws: every caller treats a bad path as "no page", not as an error.
 */
export function resolveWikiPage(vaultRoot: string, rel: string): string | null {
  if (!isWikiPagePath(rel)) return null
  const abs = path.join(vaultRoot, rel)
  try {
    return fs.statSync(abs).isFile() ? abs : null
  } catch {
    return null
  }
}
