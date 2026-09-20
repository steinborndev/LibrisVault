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
  /** Total findings across all non-summary sections. */
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
      }
      continue
    }

    // "101 unresolved `[[wikilink]]` targets …" - the section stating its own total.
    if (current !== null && !openingCounts.has(current.title)) {
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
  const counted = sections.map((sec) => ({ ...sec, count: countFor(sec, summary, openingCounts.get(sec.title)) }))
  /*
   * A lint-fix appends "## Auto-fix run" to the report it worked from, listing what it
   * repaired. Those are closed, not open: counting them would report a repair as a defect.
   */
  const totalFindings = counted.filter((s) => !/^auto-fix\b/i.test(s.title)).reduce((n, s) => n + s.count, 0)
  return { date, summary, sections: counted, totalFindings }
}

/**
 * The significant words of a title, for matching a summary key to a section: lower-cased,
 * punctuation gone, plural `s` off, and the words that carry no distinction dropped.
 *
 * A SET rather than a string, because the two are written by hand and drift in order as well
 * as in wording: "Em/en-dash house-style violations" heads a section called "House Style:
 * Em/En-Dash Violations", and a substring test cannot see that those are the same thing.
 */
const titleWords = (title: string): Set<string> => {
  const stop = new Set(['the', 'a', 'an', 'of', 'in', 'for', 'and', 'or', 'with', 'required', 'missing', 'page', 'pages'])
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
 * The count for one section: the summary line that names it, else the number it opens with,
 * else how many bullets it has.
 *
 * The summary match is on significant words rather than the whole string, because the two are
 * written by hand and never agree exactly: "Dead links: 101" heads a section called "Dead
 * Links", and "Em/en-dash house-style violations: 155 pages" one called "House Style: Em/En-Dash
 * Violations".
 */
function countFor(section: { title: string; findings: LintFinding[] }, summary: Record<string, number>, opening: number | undefined): number {
  const wanted = titleWords(section.title)
  if (wanted.size > 0) {
    let best: { shared: number; value: number } | undefined
    for (const [key, value] of Object.entries(summary)) {
      const words = titleWords(key)
      if (words.size === 0) continue
      let shared = 0
      for (const w of words) if (wanted.has(w)) shared++
      // Every significant word of one side present in the other, and more than one of them:
      // a single shared word ("gaps", "pages") is a coincidence, not the same subject.
      const covers = shared === words.size || shared === wanted.size
      if (covers && shared > 1 && (best === undefined || shared > best.shared)) best = { shared, value }
    }
    if (best !== undefined) return best.value
  }
  return opening ?? section.findings.length
}
