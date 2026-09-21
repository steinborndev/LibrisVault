/**
 * `research-expand` (docs/agents/SPEC.md section 7, docs/tasks/TASKS-A3.md D1 to D3): a run
 * that deepens a listed page set additively - it may insert anywhere on those pages and may
 * never rewrite or delete a line. This module holds the rules block the prompt carries, the
 * validator that checks a commit against those rules, and the finding types.
 * The validator reads both sides of every page from git through a small reader interface,
 * so the tests feed it fixtures and the runner feeds it `git show`.
 */

import { commitFileStatus, readAtRevision } from './git.js'

/** How many existing pages an expand proposal may list (its own pages come on top). */
export const EXPAND_MAX_PAGES = 4
/**
 * How many a HAND-started deepening may list (docs/agents/ideas.md, decision 2026-09-07).
 * The planner keeps the smaller cap because it spends the night's budget unattended; a user
 * who is looking at the dialog and its price may ask for more.
 */
export const EXPAND_MANUAL_MAX_PAGES = 8
/** How many new pages an expand run may file. */
export const EXPAND_MAX_NEW = 3

/**
 * What a deepening of this many pages may cost, in USD before the model factor.
 *
 * Not linear: a run orients itself in the vault once - reads the registry, the neighbours,
 * its own notebook - and only the per-page work grows. So the base covers the planner's four
 * and each further page adds a flat amount, which makes the eighth page cheaper than the
 * first. `web/src/lib/deepen.ts` mirrors this so the dialog can say the price beforehand.
 */
export function expandBudgetUsd(base: number, pages: number): number {
  return base + Math.max(0, pages - EXPAND_MAX_PAGES) * 1
}

/** The same shape for time: each page beyond the base set adds a quarter of the base leash. */
export function expandTimeoutMs(base: number, pages: number): number {
  return Math.round(base * (1 + 0.25 * Math.max(0, pages - EXPAND_MAX_PAGES)))
}

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

/**
 * The prompt block that states the rules for one run (section 7).
 *
 * ADDITIVE, NOT APPENDED (2026-09-10). The rule used to demand one dated `## Update <date>`
 * section at the END of every page, and that is not how the vault's own skill maintains a
 * page: `wiki-ingest` says "create or update", edits in place with PATCH, keeps pages to a
 * few hundred lines, and flags a conflicting claim with a `[!contradiction]` callout next to
 * the claim rather than overwriting it. A dated tail is what claude-obsidian reserves for its
 * journals (`wiki/log.md`, the folds), and it showed: a real run wrote "extends the <named>
 * section above", which is a fact that belongs IN that section and that a reader of that
 * section will never see, and another had to narrate a correction it was not allowed to make.
 *
 * What holds the run is unchanged, and is the part worth having: the validator below checks
 * that every old body line survives, in order, and a run that rewrites or deletes one is
 * reverted. `isSubsequence` allows an insertion ANYWHERE, so placing the addition where it
 * belongs was always within the guarantee - only this wording stood in the way.
 */
export function renderExpandRules(pageSet: readonly string[], date: string): string {
  return (
    '\n\n<research_expand>\n' +
    'This run is a research EXPAND, not a sweep: deepen the pages listed below with what the web adds, ' +
    'and touch nothing else. The service checks the commit against these rules and reverts a run that breaks them.\n' +
    'Rules:\n' +
    `- You may EDIT only these existing pages (plus wiki/index.md, wiki/hot.md and wiki/log.md as usual):\n${pageSet.map((p) => `  - ${p}`).join('\n')}\n` +
    '- Every edit is ADDITIVE: you may insert new text anywhere, and you may never rewrite, reorder or delete ' +
    'a line of existing body text. In the frontmatter you may change only `updated`, `related` and `tags`; ' +
    'the `related:` footer line at the end of a page may gain links and move below what you add.\n' +
    '- PUT IT WHERE IT BELONGS. Add to the section the fact belongs to, in that section\'s voice and tense - ' +
    'the page states what is known, it is not a changelog. Only what fits no existing section gets one of its own, ' +
    `named for its subject; if the addition is genuinely a dated development, "## Update ${date}" is a fine name for that section. ` +
    'Carry the date and the source in the sentence itself, the way the page already cites its claims.\n' +
    '- CORRECT BY FLAGGING, NEVER BY DELETING. When what you found contradicts a claim on the page, or supersedes ' +
    'a figure it states, leave the old line where it is and put a callout directly under it:\n' +
    '  > [!contradiction] <what conflicts>\n' +
    '  > This page says X. <source> says Y. <which is better founded, and why>\n' +
    '  Use `> [!stale]` instead when the old claim is not wrong but has been overtaken by a newer or more primary ' +
    'source. Both are the vault\'s own callouts. Do not narrate the correction in a section at the end of the page: ' +
    'a reader of the old claim must meet the flag at the claim.\n' +
    `- You may CREATE at most ${EXPAND_MAX_NEW} new pages (sources you cite, a concept the update needs), under the normal hygiene rules.\n` +
    '- Do not modify, rename or delete any other existing page. If a finding belongs elsewhere, leave a bullet in your notebook\'s Open Questions instead.\n' +
    '- The synthesis page in the list is where the run\'s summary goes; it counts as an edit, not as a new page.\n' +
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

/**
 * The commit to validate. `from` names the revision the run STARTED at, for a run whose work
 * landed in several commits (the agent committing its own work, then the service committing
 * the rest): the net effect of `from..hash` is what the run did, and that is what the rules
 * are about.
 */
export function gitCommitReader(vaultRoot: string, hash: string, from?: string): CommitReader {
  return {
    status: () => commitFileStatus(vaultRoot, hash, from),
    before: (p) => readAtRevision(vaultRoot, from ?? `${hash}^`, p),
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

/**
 * The commit check for a `defect-fix` run (TASKS-DEFECT-PATHS 4.4).
 *
 * THREE OF `validateExpandCommit`'s FOUR RULES, and the fourth deliberately dropped.
 *
 * Kept: a modified page outside the set, a deleted page, and a cap on new pages - which for a
 * defect fix is ZERO, because the repair is always to the page the finding stands on and a new
 * page is never it.
 *
 * DROPPED: additivity (`isSubsequence`), which requires every existing body line to survive. A
 * defect fix REPLACES lines by definition - that is what rewriting a question, correcting a
 * quotation and filling a missing heading each are - so reusing the expand check here would
 * revert exactly the run it was reused for, every time, on every page.
 *
 * This is the backstop, not the boundary. The `PreToolUse` hook refuses a write outside the set
 * before it happens; this catches what the hook structurally cannot see, which is a page
 * written through Bash, and the caller reverts on any finding.
 */
export async function validateDefectFixCommit(
  reader: CommitReader,
  pageSet: readonly string[],
  maxNew = 0,
): Promise<ExpandFinding[]> {
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
      findings.push({ path: p, rule: 'outside-set', detail: 'modified a page the finding did not name' })
    }
  }
  if (added > maxNew) {
    findings.push({
      path: '(new pages)',
      rule: 'too-many-new',
      detail:
        maxNew === 0
          ? `${added} new page(s); a defect fix repairs the page its finding stands on and creates none`
          : `${added} new pages, at most ${maxNew} allowed`,
    })
  }
  return findings
}

export function describeFindings(findings: readonly ExpandFinding[]): string {
  return findings.map((f) => `${f.path}: ${f.detail}`).join('; ')
}
