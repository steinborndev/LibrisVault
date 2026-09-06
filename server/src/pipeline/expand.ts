/**
 * `research-expand` (docs/agents/SPEC.md section 7, docs/tasks/TASKS-A3.md D1 to D3): a run
 * that deepens a listed page set append-only. This module holds the rules block the prompt
 * carries, the validator that checks a commit against those rules, and the finding types.
 * The validator reads both sides of every page from git through a small reader interface,
 * so the tests feed it fixtures and the runner feeds it `git show`.
 */

import { commitFileStatus, readAtRevision } from './git.js'

/** How many existing pages an expand proposal may list (its own pages come on top). */
export const EXPAND_MAX_PAGES = 4
/** How many new pages an expand run may file. */
export const EXPAND_MAX_NEW = 3

export interface ExpandFinding {
  readonly path: string
  readonly rule: 'outside-set' | 'deleted-page' | 'rewritten' | 'too-many-new'
  readonly detail: string
}

/** Paths every run touches and no rule minds: the vault's bookkeeping and the service state. */
export function isExemptPath(p: string): boolean {
  return (
    p === 'wiki/index.md' ||
    p === 'wiki/hot.md' ||
    p === 'wiki/log.md' ||
    p === 'wiki/overview.md' ||
    p.endsWith('/_index.md') ||
    p.startsWith('.vault-meta/') ||
    p.startsWith('.raw/') ||
    !p.startsWith('wiki/')
  )
}

/** The prompt block that states the rules for one run (section 7, verbatim in spirit). */
export function renderExpandRules(pageSet: readonly string[], date: string): string {
  return (
    '\n\n<research_expand>\n' +
    'This run is a research EXPAND, not a sweep: deepen the pages listed below with what the web adds, ' +
    'and touch nothing else. The service checks the commit against these rules and reverts a run that breaks them.\n' +
    'Rules:\n' +
    `- You may EDIT only these existing pages (plus wiki/index.md, wiki/hot.md and wiki/log.md as usual):\n${pageSet.map((p) => `  - ${p}`).join('\n')}\n` +
    `- Every edit is APPEND-ONLY: add a dated section "## Update ${date}" (or bullets under an existing one) at the end of the page. ` +
    'Never rewrite, reorder or delete a line of existing body text. In the frontmatter you may change only `updated`, `related` and `tags`; ' +
    'the `related:` footer line at the end of a page may gain links and move below your update.\n' +
    `- You may CREATE at most ${EXPAND_MAX_NEW} new pages (sources you cite, a concept the update needs), under the normal hygiene rules.\n` +
    '- Do not modify, rename or delete any other existing page. If a finding belongs elsewhere, leave a bullet in your notebook\'s Open Questions instead.\n' +
    '- The synthesis page in the list is where the update\'s summary goes; it counts as an edit, not as a new page.\n' +
    '</research_expand>'
  )
}

/** How the validator sees one commit. */
export interface CommitReader {
  status(): Promise<ReadonlyMap<string, 'A' | 'M' | 'D'>>
  /** The page before the commit; null when it did not exist. */
  before(path: string): Promise<string | null>
  /** The page after the commit; null when the commit deleted it. */
  after(path: string): Promise<string | null>
}

export function gitCommitReader(vaultRoot: string, hash: string): CommitReader {
  return {
    status: () => commitFileStatus(vaultRoot, hash),
    before: (p) => readAtRevision(vaultRoot, `${hash}^`, p),
    after: (p) => readAtRevision(vaultRoot, hash, p),
  }
}

/**
 * Body lines of a page: after the frontmatter, trimmed, blank lines dropped, and without the
 * vault's `related:` footer line (the skill keeps it at the end of the page and rewrites it as
 * links are added, so it is frontmatter in all but position; seen on the first real expand run,
 * docs/tasks/TASKS-A3.md F2).
 */
export function bodyLines(markdown: string): string[] {
  let body = markdown
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end >= 0) body = body.slice(end + 4)
  }
  return body
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '' && !/^related:\s/i.test(l))
}

/** True when every line of `old` appears in `next` in the same order (insertions allowed). */
export function isSubsequence(old: readonly string[], next: readonly string[]): { ok: true } | { ok: false; missing: string } {
  let j = 0
  for (const line of old) {
    while (j < next.length && next[j] !== line) j++
    if (j >= next.length) return { ok: false, missing: line }
    j++
  }
  return { ok: true }
}

/**
 * Checks one commit against the expand rules (D2): modified pages outside the set, deleted
 * pages, rewritten or removed body lines inside the set, too many new pages. Bookkeeping is
 * exempt. Returns every finding, so the run's failure names them all.
 */
export async function validateExpandCommit(reader: CommitReader, pageSet: readonly string[], maxNew = EXPAND_MAX_NEW): Promise<ExpandFinding[]> {
  const findings: ExpandFinding[] = []
  const allowed = new Set(pageSet)
  const status = await reader.status()
  let added = 0
  for (const [p, s] of status) {
    if (isExemptPath(p)) continue
    if (s === 'A') {
      added++
      continue
    }
    if (s === 'D') {
      findings.push({ path: p, rule: 'deleted-page', detail: 'the run deleted an existing page' })
      continue
    }
    if (!allowed.has(p)) {
      findings.push({ path: p, rule: 'outside-set', detail: 'modified a page the proposal did not list' })
      continue
    }
    const [before, after] = await Promise.all([reader.before(p), reader.after(p)])
    if (before === null || after === null) continue
    const check = isSubsequence(bodyLines(before), bodyLines(after))
    if (!check.ok) findings.push({ path: p, rule: 'rewritten', detail: `a body line was rewritten or removed: "${check.missing.slice(0, 120)}"` })
  }
  if (added > maxNew) findings.push({ path: '(new pages)', rule: 'too-many-new', detail: `${added} new pages, at most ${maxNew} allowed` })
  return findings
}

export function describeFindings(findings: readonly ExpandFinding[]): string {
  return findings.map((f) => `${f.path}: ${f.detail}`).join('; ')
}
