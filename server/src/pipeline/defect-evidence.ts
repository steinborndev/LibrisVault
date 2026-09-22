/**
 * What a standing finding is based on, for the reader (TASKS-DEFECT-PATHS 1.2).
 *
 * A row says what is wrong and, until this module, never showed it. Judging a finding meant
 * opening the page and hunting for the lines the message counted, which is why six of the nine
 * standing rules - the ones classified as needing judgement - were a list nobody worked down.
 *
 * TWO SOURCES, in this order. The stored `evidence` column, for a rule whose evidence the page
 * no longer holds (`quote`, and only `quote` today: the quotation is compared against the
 * artifact the job read, and nothing afterwards holds that artifact). Otherwise a fresh read of
 * the page, because the page IS the evidence for every other rule and a stale snapshot would
 * show a defect that has since been repaired.
 *
 * READ-ONLY, and it reads exactly one page per call. The excerpt comes from the SERVER so the
 * browser never reads the vault: the dashboard is usable from a Windows browser that cannot
 * reach the WSL filesystem at all (SPEC.md §12.4), and a fetch of raw page text into the
 * client would be a second page-read path beside the one that exists.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseQuestionBullets } from './questions.js'
import { asksAQuestion, hasPassDeixis } from './question-form.js'
import { parseFrontmatterMeta } from './graph.js'
import { REQUIRED_HEADINGS_BY_TYPE, type ValidationRule } from './validator.js'

/** How much of one excerpt is shown. Beyond this the block says it was cut. */
export const EVIDENCE_CHARS = 600

export interface EvidenceBlock {
  /** What this block is, in two or three words: "the quotation", "headings this page has". */
  readonly label: string
  readonly text: string
  /** True when the text was cut at {@link EVIDENCE_CHARS}. */
  readonly truncated?: boolean
}

export interface DefectEvidence {
  readonly blocks: EvidenceBlock[]
  /** Where it came from: the column the producer wrote, a fresh read, or nothing. */
  readonly source: 'stored' | 'page' | 'none'
  /** Why there is nothing to show, when that is the case. */
  readonly note?: string
}

const cut = (label: string, text: string): EvidenceBlock =>
  text.length > EVIDENCE_CHARS
    ? { label, text: `${text.slice(0, EVIDENCE_CHARS)}…`, truncated: true }
    : { label, text }

/** The page's body, frontmatter taken off: every line-based rule below reads this. */
function bodyOf(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown
  const end = markdown.indexOf('\n---', 3)
  return end === -1 ? markdown : markdown.slice(end + 4)
}

/** The stored quote evidence, as `checkQuotes` writes it. */
interface StoredQuote {
  readonly quote?: string
  readonly matched?: string
  readonly words?: number
  readonly matchedWords?: number
}

/**
 * The quote row, from the column.
 *
 * It deliberately says "matched" and not "the source says": the corpus the match was found in
 * is a normalised lowercase word stream, so the source's own rendering is not recoverable and
 * the span shown is made of the QUOTE's words (`longestMatch`, `quotes.ts`).
 */
function quoteEvidence(stored: string): DefectEvidence {
  let parsed: StoredQuote
  try {
    parsed = JSON.parse(stored) as StoredQuote
  } catch {
    return { blocks: [cut('what the check recorded', stored)], source: 'stored' }
  }
  const blocks: EvidenceBlock[] = []
  if (typeof parsed.quote === 'string' && parsed.quote !== '') blocks.push(cut('the quotation as the page has it', parsed.quote))
  if (typeof parsed.matched === 'string' && parsed.matched !== '') {
    blocks.push(
      cut(
        `matched: ${parsed.matchedWords ?? '?'} of ${parsed.words ?? '?'} words of the quotation do stand in the source`,
        parsed.matched,
      ),
    )
  } else if (parsed.matchedWords === 0) {
    blocks.push({ label: 'matched', text: 'no run of this quotation’s words stands in the source at all.' })
  }
  return blocks.length === 0 ? { blocks: [], source: 'none', note: 'the check recorded nothing readable' } : { blocks, source: 'stored' }
}

/**
 * The second page a near-duplicate finding names, straight out of the message.
 *
 * SPACES ARE PART OF A PAGE PATH. The vault names its files after their titles, so
 * `wiki/concepts/Some Long Title.md` is the normal shape and a pattern that stops at the first
 * space finds nothing - measured against the live list, where all six near-duplicate rows
 * looked as if they named no page at all. So the match runs from `wiki/` to the first `.md`,
 * non-greedy, which is exactly one path whatever the message says around it.
 */
function namedPage(message: string): string | undefined {
  const link = /\[\[([^\]|]+)/.exec(message)
  if (link !== null) return link[1]!.trim()
  const rel = /(wiki\/[^\n]+?\.md)/.exec(message)
  return rel === null ? undefined : rel[1]
}

/** Lines of the body that mention any of `needles`, at most `max` of them. */
function linesMentioning(body: string, needles: readonly string[], max = 6): string[] {
  if (needles.length === 0) return []
  const lower = needles.map((n) => n.toLowerCase())
  const out: string[] = []
  for (const line of body.split('\n')) {
    const l = line.toLowerCase()
    if (lower.some((n) => l.includes(n))) out.push(line.trim())
    if (out.length >= max) break
  }
  return out
}

/** Every `"…"` and `'…'` term the message quotes: what the rule is complaining about. */
function quotedTerms(message: string): string[] {
  return [...message.matchAll(/"([^"]{1,80})"/g)].map((m) => m[1]!).filter((t) => t.trim() !== '')
}

/**
 * The evidence for one finding.
 *
 * `read` is injected so a test hands in fixtures and the route hands in the vault; it returns
 * undefined for a path that is gone, which is itself worth saying rather than rendering empty.
 */
export function evidenceFor(
  finding: { readonly rule: string; readonly path: string; readonly message: string; readonly evidence?: string | null },
  read: (rel: string) => string | undefined,
): DefectEvidence {
  const rule = finding.rule as ValidationRule
  // The column first, wherever the producer filled it: it holds what the page no longer does.
  if (typeof finding.evidence === 'string' && finding.evidence !== '') {
    if (rule === 'quote') return quoteEvidence(finding.evidence)
    return { blocks: [cut('what the check recorded', finding.evidence)], source: 'stored' }
  }
  if (rule === 'quote') {
    return {
      blocks: [],
      source: 'none',
      note:
        'This finding predates the evidence column. The quotation is compared against the document the ' +
        'job read, which only the ingest holds, so re-reading the page cannot recover it.',
    }
  }
  if (rule === 'near-duplicate') {
    const other = namedPage(finding.message)
    return other === undefined
      ? { blocks: [], source: 'none', note: 'the finding names no second page' }
      : { blocks: [{ label: 'the other page', text: other }], source: 'stored' }
  }
  if (!finding.path.startsWith('wiki/') || !finding.path.endsWith('.md')) {
    return {
      blocks: [],
      source: 'none',
      note: 'This finding is about a directory rather than a page, so there is no page text to show.',
    }
  }

  const markdown = read(finding.path)
  if (markdown === undefined) {
    return { blocks: [], source: 'none', note: 'the page is no longer on disk; the next run that checks it will clear this row' }
  }
  const body = bodyOf(markdown)

  if (rule === 'page-schema') {
    const meta = parseFrontmatterMeta(markdown)
    const type = (meta.fmType ?? '').toLowerCase()
    const headings = [...markdown.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1]!.trim())
    const required = REQUIRED_HEADINGS_BY_TYPE.get(type) ?? []
    return {
      blocks: [
        cut('headings this page has', headings.length === 0 ? '(none)' : headings.map((h) => `## ${h}`).join('\n')),
        cut(`what a ${type === '' ? 'page of this type' : type} page needs`, required.map((h) => `## ${h}`).join('\n') || '(nothing)'),
      ],
      source: 'page',
    }
  }

  if (rule === 'open-question-form') {
    const bullets = parseQuestionBullets(markdown).filter((b) => !b.archived)
    const offending = bullets.filter((b) => !asksAQuestion(b.text) || hasPassDeixis(b.text))
    if (offending.length === 0) {
      return { blocks: [], source: 'page', note: 'the page’s bullets read cleanly now; the next run to check it clears this row' }
    }
    return {
      blocks: [
        cut(
          `${offending.length} of ${bullets.length} open question(s)`,
          offending
            .map((b) => {
              const why = [!asksAQuestion(b.text) ? 'asks nothing' : '', hasPassDeixis(b.text) ? 'refers to the run' : '']
                .filter(Boolean)
                .join(', ')
              return `- ${b.text}\n  (${why})`
            })
            .join('\n'),
        ),
      ],
      source: 'page',
    }
  }

  if (rule === 'tag-singleton' || rule === 'tag-mirroring') {
    const tags = quotedTerms(finding.message)
    return {
      blocks: [
        { label: 'the tag', text: tags.length === 0 ? '(the message names none)' : tags.join(', ') },
        {
          label: 'what dropping it does',
          text:
            rule === 'tag-singleton'
              ? 'Nothing else in the vault carries this tag, so it groups one page with itself. Dropping it loses no grouping; the page keeps its type, its domain and its links.'
              : 'The page’s own type: or domain: field already carries this, and every reader of the tag reads the field. Dropping it loses nothing.',
        },
      ],
      source: 'page',
    }
  }

  // Everything else: the lines of the page the message is about, found by what it quotes.
  const terms = quotedTerms(finding.message)
  const lines = linesMentioning(body, terms)
  if (lines.length > 0) return { blocks: [cut('the lines this is about', lines.join('\n'))], source: 'page' }
  const headings = [...markdown.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((m) => `## ${m[1]!.trim()}`)
  // The frontmatter block, which is what the remaining rules (frontmatter, dates, address,
  // status-vocabulary, source-url) are almost always about.
  const fm = markdown.startsWith('---') ? markdown.slice(0, markdown.indexOf('\n---', 3) + 4) : ''
  if (fm !== '') return { blocks: [cut('this page’s frontmatter', fm.trim())], source: 'page' }
  return headings.length > 0
    ? { blocks: [cut('what this page is made of', headings.join('\n'))], source: 'page' }
    : { blocks: [], source: 'none', note: 'nothing on the page matches what the message names' }
}

/** A reader over a vault root, for the route. Returns undefined for anything unreadable. */
export function vaultReader(vaultRoot: string): (rel: string) => string | undefined {
  return (rel) => {
    // Never outside the vault, whatever a stored path says.
    const abs = path.resolve(vaultRoot, rel)
    const inside = path.relative(vaultRoot, abs)
    if (inside.startsWith('..') || path.isAbsolute(inside)) return undefined
    try {
      return fs.readFileSync(abs, 'utf8')
    } catch {
      return undefined
    }
  }
}
