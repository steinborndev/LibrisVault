/**
 * Parses the `wiki-lint` skill's report (`wiki/meta/lint-report-YYYY-MM-DD.md`) into
 * structured JSON for the Wartung tab (SPEC.md §6.4, TASKS-M4 §2). The skill writes a fixed
 * markdown shape — a `## Summary` block of counts followed by one `## <Category>` section
 * per check (Orphan Pages, Dead Links, Missing Pages, Frontmatter Gaps, Stale Claims,
 * Cross-Reference Gaps), each a bullet list. We turn that into groups of findings, each with
 * its primary `[[Page]]` resolved to a vault path so the UI can link it.
 *
 * The parse is lenient: unknown sections are kept as-is, and a report that drifts from the
 * template still yields whatever sections it does have rather than failing.
 */

import { parseWikilinks, type Citation } from './citations.js'

export interface LintFinding {
  /** The raw bullet text (minus the leading `- `). */
  readonly text: string
  /** The first wikilink in the finding, resolved to a page path (or null). */
  readonly page: Citation | null
}

export interface LintSection {
  readonly title: string
  readonly findings: LintFinding[]
  /**
   * How many defects this section is ABOUT, which is not the same as how many lines it has.
   *
   * The skill used to write one bullet per defect; it now writes prose that groups them into
   * patterns. On the 2026-09-20 report the Dead Links section had four bullets describing four
   * CLASSES and said "101 unresolved wikilink targets" in its opening line, so counting bullets
   * reported 4 where the vault had 101. Read from the summary line that names this section,
   * else from the number the section opens with, else the bullet count - in that order, because
   * each is a weaker statement of the same thing.
   */
  readonly count: number
}

export interface LintReport {
  /** `YYYY-MM-DD` from the report heading, or null if absent. */
  readonly date: string | null
  /** Summary counts, e.g. { "Pages scanned": 94, "Issues found": 3 }. */
  readonly summary: Record<string, number>
  readonly sections: LintSection[]
  /**
   * Defect counts the summary states that no section covers - the skill names a check in its
   * summary and then folds it into a neighbouring section, or writes no section for it at all.
   * Kept apart from `sections` because there are no findings to show, and counted in
   * `totalFindings` because the defects are real.
   */
  readonly extras: Record<string, number>
  /** Total findings across all non-summary sections, plus the extras above. */
  readonly totalFindings: number
}

/**
 * @param markdown the report file contents
 * @param resolve  maps a page label to a Citation (label→path); typically closed over the
 *                 wiki page index so the parser stays pure/testable.
 */
export function parseLintReport(markdown: string, resolve: (label: string) => Citation): LintReport {
  const lines = markdown.split('\n')
  const dateMatch = markdown.match(/^#\s+Lint Report:?\s*(\d{4}-\d{2}-\d{2})/m)
  const date = dateMatch ? dateMatch[1]! : null

  const summary: Record<string, number> = {}
  const sections: Array<{ title: string; findings: LintFinding[] }> = []
  /** Per section title, the number its first prose line states, when it states one. */
  const openingCounts = new Map<string, number>()
  let current: { title: string; findings: LintFinding[] } | null = null
  let inSummary = false
  /** True until the first non-blank line of the section we are in has been read. */
  let atSectionStart = false

  const flush = (): void => {
    if (current) sections.push(current)
    current = null
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const h2 = /^##\s+(.*)$/.exec(line)
    if (h2) {
      flush()
      const title = h2[1]!.trim()
      if (/^summary$/i.test(title)) {
        inSummary = true
      } else {
        inSummary = false
        current = { title, findings: [] }
        atSectionStart = true
      }
      continue
    }

    /*
     * "101 unresolved `[[wikilink]]` targets …" - the section stating its own total, and only
     * on the line it opens with. A bare number deeper down belongs to a sub-list rather than to
     * the section: on the 2026-09-20 report a backfill tally 40 lines in became the address
     * section's count, and read 15 where the report said 12.
     */
    if (current !== null && atSectionStart && line.trim() !== '') {
      atSectionStart = false
      const opening = /^(\d+)\s+\S/.exec(line.trim())
      if (opening) openingCounts.set(current.title, Number(opening[1]))
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (!bullet) continue
    const text = bullet[1]!.trim()

    if (inSummary) {
      /*
       * "- Pages scanned: 94" and, since the skill started qualifying its totals, also
       * "- Dead links: 101 (78 distinct targets)" and "- … callouts: 28 pages".
       *
       * The old form anchored the number to the end of the line, so a total with anything
       * after it was dropped: on the 2026-09-20 report that lost 9 of 11 lines, and every one
       * it lost was a real count. What stayed were the two that happened to end in a digit,
       * which is why the maintenance view read 1332 pages scanned and no defects worth naming.
       */
      const kv = /^(.+?):\s*(\d+)\b/.exec(text)
      if (kv) summary[kv[1]!.trim()] = Number(kv[2])
      continue
    }

    if (current) {
      const firstLink = parseWikilinks(text)[0]
      current.findings.push({ text, page: firstLink ? resolve(firstLink) : null })
    }
  }
  flush()

  /*
   * A section's own count. `summary` is the report's own arithmetic over the whole vault and
   * wins; the section's opening number ("101 unresolved …") is the same statement made locally;
   * the bullets are the last resort and are right only while the skill writes one per defect.
   */
  const claimed = new Set<string>()
  const counted = sections.map((sec) => {
    const hit = matchSummary(sec.title, summary)
    if (hit) claimed.add(hit.key)
    return { ...sec, count: hit?.value ?? openingCounts.get(sec.title) ?? sec.findings.length }
  })

  /*
   * A summary count no section covers. "Domain-field gaps: 9" was stated and then written up
   * inside the frontmatter section, so nothing reported those nine. A key is an extra only when
   * it names defects (a scan total is not a defect) and when it matches no section at all -
   * not merely when some other key outranked it for one, which would double-count.
   */
  const extras: Record<string, number> = {}
  for (const [key, value] of Object.entries(summary)) {
    if (value === 0 || claimed.has(key) || !DEFECT_KEY.test(key) || AGGREGATE_KEY.test(key)) continue
    const words = titleWords(key)
    if (counted.some((sec) => subjectOverlap(words, titleWords(sec.title)) !== null)) continue
    extras[key] = value
  }

  /*
   * A lint-fix appends "## Auto-fix run" to the report it worked from, listing what it
   * repaired. Those are closed, not open: counting them would report a repair as a defect.
   */
  const open = counted.filter((s) => !/^auto-fix\b/i.test(s.title)).reduce((n, s) => n + s.count, 0)
  const totalFindings = Object.values(extras).reduce((n, v) => n + v, open)
  return { date, summary, sections: counted, extras, totalFindings }
}

/**
 * Whether a summary key counts DEFECTS rather than work done. "Pages scanned: 1337" and
 * "Auto-fixed: 0" describe the run, "Domain-field gaps: 9" describes the vault, and only the
 * second kind may be added to a total. Prefix matching, so every plural comes along.
 *
 * Deliberately a positive list: a defect word we have not seen yet is left out of the total,
 * which under-counts. Guessing the other way around would report 1337 scanned pages as defects.
 */
const DEFECT_KEY =
  /\b(gap|error|issue|violation|missing|stale|dead|orphan|empty|duplicate|broken|mismatch|collision|conflict|unresolved|contradiction|drift)/i

/**
 * ... and which of those keys is the report's own SUM of the others. "Issues found: 200" counts
 * defects by any wording test, and adding it to the sections that make it up double-counts the
 * whole report - measured against the two reports this vault still holds from before the skill
 * wrote per-category totals.
 */
const AGGREGATE_KEY = /\btotal\b|\boverall\b|\bissues?\s+found\b|\bfindings?\b/i

/**
 * The significant words of a title, for matching a summary key to a section: lower-cased,
 * punctuation gone, plural `s` off, and the words that carry no distinction dropped.
 *
 * A SET rather than a string, because the two are written by hand and drift in order as well
 * as in wording: "Em/en-dash house-style violations" heads a section called "House Style:
 * Em/En-Dash Violations", and a substring test cannot see that those are the same thing.
 *
 * The stop list holds grammar only. It once held "missing", "page" and "pages" as well, which
 * left the section titled "Missing Pages" with no significant words at all and no way to find
 * its own summary line - `subjectOverlap` already refuses a single shared word, which is the
 * work those three were doing.
 */
const titleWords = (title: string): Set<string> => {
  const stop = new Set(['the', 'a', 'an', 'of', 'in', 'for', 'and', 'or', 'with', 'required'])
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
      .filter((w) => w !== '' && !stop.has(w)),
  )
}

/**
 * How many significant words two titles share, or null when they are not the same subject.
 *
 * Two thirds of the shorter title has to be shared, and more than one word. The sides are
 * written by hand and rarely agree word for word - "DragonScale address errors" heads a section
 * called "DragonScale Address Validation" - so demanding that one side contain the other
 * entirely left that section reading a stray number instead of its own total. A single shared
 * word ("gaps", "pages") stays a coincidence rather than the same subject.
 */
const subjectOverlap = (a: Set<string>, b: Set<string>): number | null => {
  if (a.size === 0 || b.size === 0) return null
  let shared = 0
  for (const w of b) if (a.has(w)) shared++
  if (shared < 2 || shared * 3 < Math.min(a.size, b.size) * 2) return null
  return shared
}

/**
 * The summary line that names a section, if one does: the strongest overlap, and among equals
 * the shorter key, so a line that says the same thing plus an aside does not outrank the plain
 * one.
 */
function matchSummary(title: string, summary: Record<string, number>): { key: string; value: number } | undefined {
  const wanted = titleWords(title)
  let best: { key: string; value: number; shared: number; size: number } | undefined
  for (const [key, value] of Object.entries(summary)) {
    const words = titleWords(key)
    const shared = subjectOverlap(wanted, words)
    if (shared === null) continue
    if (best === undefined || shared > best.shared || (shared === best.shared && words.size < best.size)) {
      best = { key, value, shared, size: words.size }
    }
  }
  return best === undefined ? undefined : { key: best.key, value: best.value }
}
