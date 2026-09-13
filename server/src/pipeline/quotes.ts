/**
 * Quote integrity (docs/sources/SPEC.md section 7).
 *
 * An ingest writes quotations into the vault, and a quotation is the one kind of claim a page
 * makes that can be checked mechanically: the words are either in the document the job read or
 * they are not. Everything else on a page is a summary, and summarising is what the run is for.
 *
 * So after a run's commit, every quote on the pages it touched is looked up in the job's OWN
 * text - the artifact in `.raw/<job-id>/`, which is the only source this job had. A quote that
 * is not there is a finding in the job log and a number on the record; nothing is corrected and
 * nothing is written to the vault (hard rule 1, and the validator's stance: advisory).
 *
 * WHAT IT CANNOT SEE: whether a quote is fair, whether it is attributed to the right speaker,
 * or whether a paraphrase is accurate. And it is deliberately generous where extraction is
 * lossy - a PDF's hyphenation, its ligatures, its citation markers and its line breaks are
 * normalized away on both sides, because a false alarm about a quote that IS in the document
 * costs more attention than a missed invention.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isExemptPath } from './expand.js'
import { runConverter } from './preprocess/sandbox.js'
import { documentTextOf } from './preprocess/fence.js'
import { htmlToText } from './preprocess/html.js'
import type { ValidationFinding } from './validator.js'

/**
 * Pages whose quotation marks are not a claim about any one document, and are therefore out of
 * scope (measured, see section 7.6 and the task file): the vault's journal, its indexes, the hot
 * cache and everything under `wiki/meta/`. A run NARRATES on those pages - "the next step is to
 * fold into an overlapping page", the user's own question, a source's title - and those quotation
 * marks are the run's own. 292 of 476 quotes in the calibration stood on such a page, 288 of them
 * unverified, all of it about text no document ever contained.
 *
 * The same set the link checks and the expand rules already exempt, plus `wiki/meta/`.
 */
export function isBookkeepingPage(rel: string): boolean {
  return isExemptPath(rel) || rel.startsWith('wiki/meta/')
}

/** A quote shorter than this many words is not checked: too common to be a quotation (D10). */
const MIN_QUOTE_WORDS = 5
/** Inside an ellipsis-split quote, a fragment this short says nothing (7.3). */
const MIN_SEGMENT_WORDS = 3
/**
 * How far a quotation mark may reach for its partner. A stray `"` in prose would otherwise
 * swallow a page; a real quotation is a sentence or a paragraph.
 */
const MAX_QUOTE_CHARS = 1500
/** How much of a quote the finding shows. */
const FINDING_CHARS = 80

/** One quotation found on a page. */
export interface PageQuote {
  /** Vault-relative POSIX path of the page it stands on. */
  readonly path: string
  /** The quoted text as the page has it, unnormalized. */
  readonly text: string
}

/** What the job's record says about its quotes (`jobs.validation`, section 7.4). */
export interface QuoteSummary {
  readonly checked: number
  readonly unverified: number
  /** Why nothing was checked, when that is the case. */
  readonly note?: string
}

// --- normalization (7.3) -----------------------------------------------------

/**
 * Both sides of a comparison, reduced to what is actually the same text.
 *
 * Every step here is an extraction artifact seen in this vault's own PDFs: soft hyphens and
 * hyphenation at a line end (`transpor-\ntation`), typographic quotes and apostrophes, en and
 * em dashes where the page has a hyphen, ligatures (NFKC folds them), bracketed citation
 * numbers inside a sentence (`... as shown [12] in the trial ...`), and the whitespace
 * `pdftotext -layout` pads a column with.
 */
export function normalizeQuoteText(text: string): string {
  return text
    .normalize('NFKC')
    // Soft hyphens carry no meaning at all.
    .replace(/­/g, '')
    // Every dash is a hyphen, so a page's "-" matches a document's "–".
    .replace(/[‐-―⁃−﹘﹣－]/g, '-')
    // A word broken across a line comes back together; this must run before whitespace collapses.
    .replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu, '$1$2')
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    // A citation marker sits inside the sentence a page quotes without it.
    .replace(/\[\s*\d+(?:\s*[,-]\s*\d+)*\s*\]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The WORDS of a text: runs of letters and digits, and nothing else.
 *
 * Comparing characters was the mistake the second calibration round found (see the record in
 * docs/tasks/TASKS-SOURCES.md). A quotation differs from its source in punctuation constantly and
 * in words almost never: the source puts one word of the sentence in typographic quotes and the
 * page quotes the sentence without them, the page writes a comma where the source has a dash, a
 * bracket closes somewhere. None of that changes what was said. So both sides are reduced to
 * their words, and the comparison is about those.
 */
export function wordsOf(text: string): string[] {
  return normalizeQuoteText(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * The corpus as one searchable line of space-delimited words, with a space at each end so a
 * needle can be bounded on both sides and no match ever starts inside a word.
 */
export function wordIndex(text: string): string {
  return ` ${wordsOf(text).join(' ')} `
}

/** One segment as a needle for {@link wordIndex}. */
const needleOf = (words: readonly string[]): string => ` ${words.join(' ')} `

/** The ellipsis shapes a quote uses to skip a passage (7.3). */
const ELLIPSIS = /\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\(\s*(?:\.\.\.|…)\s*\)|\.\.\.|…)\s*/

/**
 * Whether a quote stands in the corpus: every segment of three words or more, in order, at
 * increasing positions. `corpusIndex` comes from {@link wordIndex}.
 *
 * The ORDER is what makes an ellipsis quote checkable: "A ... B" holds when A comes before B in
 * the document, and a quote that stitches two unrelated passages backwards does not.
 */
export function quoteHolds(quote: string, corpusIndex: string): boolean {
  let from = 0
  for (const segment of quote.split(ELLIPSIS)) {
    const words = wordsOf(segment)
    if (words.length < MIN_SEGMENT_WORDS) continue
    const needle = needleOf(words)
    const at = corpusIndex.indexOf(needle, from)
    if (at === -1) return false
    /*
     * Minus one: two adjacent matches share the space between them, and advancing past it would
     * make the next needle's leading space unfindable.
     */
    from = at + needle.length - 1
  }
  return true
}

/**
 * The longest run of a quote's own words that DOES stand in the corpus.
 *
 * What tells a misquote from an invention, and the reason the finding says it: "19 of 20 words in
 * a row" is a wrong pronoun or a dropped word, and "3 of 20" is a sentence nobody wrote. The
 * second calibration round found a quarter of the failures were the first kind, which
 * "not found in the source" describes badly.
 */
export function longestRun(quote: string, corpusIndex: string): number {
  const words = wordsOf(quote)
  let best = 0
  for (let i = 0; i < words.length; i++) {
    // Each start extends only while it is still found, so this stays linear per start.
    let n = best
    while (i + n < words.length && corpusIndex.includes(needleOf(words.slice(i, i + n + 1)))) n++
    if (n > best) best = n
  }
  return best
}

// --- what counts as a quote on a page (7.1) ----------------------------------

/**
 * The body of a page, with what must not be scanned taken out: the frontmatter, fenced code,
 * inline code (a path or a JSON snippet is full of quotation marks and is not a quotation), and
 * the header line of every callout, which carries the callout's type and its title.
 */
export function quotableBody(markdown: string): string {
  let body = markdown
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end >= 0) body = body.slice(end + 4)
  }
  return body
    .replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^[ \t]*>[ \t]*\[![a-z-]+\].*$/gim, '')
}

/** The four typographies a quotation may wear (7.1). Single quotes are not considered. */
const PAIRS: ReadonlyArray<{ readonly open: string; readonly close: string }> = [
  { open: '"', close: '"' },
  // German before English: `„…“` closes with the character `“…”` opens with, and the scan below
  // must read a `„` as the start of a German quotation rather than wait for an English one.
  { open: '„', close: '“' },
  { open: '“', close: '”' },
  { open: '«', close: '»' },
]

/**
 * Quotations inside quotation marks, never across a paragraph break: a quotation mark whose
 * partner is two paragraphs away is prose, not a quotation (an apostrophe in `the 90"s`, a stray
 * mark from an extraction).
 *
 * ONE left-to-right scan over all four typographies, not one pass per typography. The German
 * closing mark IS the English opening mark, so a per-typography pass let a German quotation's
 * closer pair with an English quotation's closer somewhere further down the page - a span over
 * everything between them, which then hid the real quotation behind it. Scanning once takes the
 * German quotation first, because its opener comes first, and the marks it used are gone.
 */
function quotedSpans(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const pair = PAIRS.find((p) => text.startsWith(p.open, i))
    if (pair === undefined) {
      i++
      continue
    }
    const end = text.indexOf(pair.close, i + pair.open.length)
    if (end === -1) {
      i++
      continue
    }
    const inner = text.slice(i + pair.open.length, end)
    if (inner.length > MAX_QUOTE_CHARS || /\n[ \t]*\r?\n/.test(inner)) {
      // Not a quotation: step over the mark, so a real opener further on is still found.
      i += pair.open.length
      continue
    }
    out.push(inner)
    i = end + pair.close.length
  }
  return out
}

/** The text of a `> [!quote]` callout: its continuation lines, without the header (7.1). */
function calloutQuotes(markdown: string): string[] {
  const lines = markdown.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t]*>[ \t]*\[!quote\]/i.test(lines[i]!)) continue
    const block: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!
      if (!/^[ \t]*>/.test(line)) break
      // A nested callout header inside the block is a header, not quoted text.
      if (/^[ \t]*>[ \t]*\[![a-z-]+\]/i.test(line)) break
      block.push(line.replace(/^[ \t]*>[ \t]?/, ''))
      i = j
    }
    const text = block.join(' ').trim()
    if (text !== '') out.push(text)
  }
  return out
}

/** Every quotation on one page, deduplicated, at or above the five-word floor. */
export function extractQuotes(rel: string, markdown: string): PageQuote[] {
  const body = quotableBody(markdown)
  const seen = new Set<string>()
  const out: PageQuote[] = []
  for (const raw of [...calloutQuotes(markdown), ...quotedSpans(body)]) {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (text.split(' ').filter(Boolean).length < MIN_QUOTE_WORDS) continue
    const key = normalizeQuoteText(text)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push({ path: rel, text })
  }
  return out
}

// --- the job's own text (7.2) ------------------------------------------------

/** The manifest fields the corpus needs; everything else about it is irrelevant here. */
interface CorpusManifest {
  readonly type?: string
  readonly normalized?: string
  readonly original?: string
  readonly passImageToAgent?: boolean
  /** The document's own title, which the extraction usually drops (see below). */
  readonly title?: string
}

/**
 * A second extraction of a PDF, in READING ORDER.
 *
 * The plugin extracts with `-layout`, which keeps a table readable and interleaves the lines of a
 * two-column paper: a sentence that runs across the column break comes out with the neighbouring
 * column's words in the middle of it, so a quotation that is verbatim in the paper is unfindable
 * in the artifact. `pdftotext` without `-layout` follows the text's own order, which is what a
 * quotation follows. Measured in the second calibration round; it costs one extraction per ingest
 * with a PDF, after the commit, and it is the corpus only - the agent's artifact is untouched.
 *
 * Contained like every other conversion, into a scratch directory outside the vault.
 */
async function readingOrderText(dir: string, original: string): Promise<string | undefined> {
  if (!/\.pdf$/i.test(original)) return undefined
  const src = path.join(dir, original)
  if (!fs.existsSync(src)) return undefined
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-corpus-'))
  try {
    const txt = path.join(out, 'reading-order.txt')
    await runConverter('pdftotext', ['-enc', 'UTF-8', src, txt], { reads: [src], writes: out, timeoutMs: 120_000 })
    return fs.readFileSync(txt, 'utf8')
  } catch {
    // A missing tool or an unreadable PDF: the layout extraction stays the whole corpus.
    return undefined
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
}

/**
 * The text one job actually read: its normalized artifact, or the passthrough original for a
 * text drop, with the untrusted fence and the banner taken off (the service's own words are not
 * the document's). A job whose artifact is an image or an unreadable file has no corpus.
 */
export async function jobCorpusText(vaultRoot: string, jobId: string): Promise<string | undefined> {
  const dir = path.join(vaultRoot, '.raw', jobId)
  let manifest: CorpusManifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as CorpusManifest
  } catch {
    return undefined
  }
  const name =
    manifest.normalized ??
    // A passthrough original is the document; anything else without a normalized artifact
    // (an image, a deferred file) is not text at all.
    (manifest.passImageToAgent !== true && (manifest.type === 'text' || manifest.type === 'other') ? manifest.original : undefined)
  if (name === undefined) return undefined
  let text: string
  try {
    const raw = documentTextOf(fs.readFileSync(path.join(dir, name), 'utf8'))
    /*
     * A page saved from a browser and passed through unconverted is markup, and a quotation is
     * in its text rather than between its tags. Jobs from before the saved-page extraction
     * (2026-09-12) are all of this shape, and the calibration reads them.
     */
    text = /\.html?$/i.test(name) || /^\s*<(?:!doctype|html)/i.test(raw.slice(0, 200)) ? htmlToText(raw) : raw
  } catch {
    return undefined
  }
  /*
   * And two things the artifact does not hold. The TITLE: a page's own heading is the address for
   * a fetched document and defuddle drops the `<h1>`, so a run that quotes the document's title -
   * which is a perfectly ordinary thing to do - was reported as inventing it. The READING ORDER:
   * see above. Both were found in the second calibration round.
   */
  const extra = [manifest.title, manifest.original === undefined ? undefined : await readingOrderText(dir, manifest.original)]
  return [text, ...extra.filter((t): t is string => t !== undefined && t.trim() !== '')].join('\n\n')
}

/** The corpus for a job or a whole batch: the union of its members' own texts (7.2). */
export async function jobCorpus(
  vaultRoot: string,
  jobIds: readonly string[],
): Promise<{ readonly index: string; readonly artifacts: number }> {
  const parts: string[] = []
  for (const id of jobIds) {
    const text = await jobCorpusText(vaultRoot, id)
    if (text !== undefined && text.trim() !== '') parts.push(text)
  }
  // Reduced to its words once, here: every quote is then compared against the same line.
  return { index: wordIndex(parts.join('\n\n')), artifacts: parts.length }
}

// --- the check ---------------------------------------------------------------

/**
 * How a page stood BEFORE this run touched it: the run's commit read against its parent, or null
 * for a page the run created. Injected, so the queue hands in git and a test hands in fixtures.
 */
export type PageBefore = (rel: string) => Promise<string | null>

/**
 * The quotes THIS run put on a page: what stands there now, minus what stood there before.
 *
 * Measured before it shipped, and the reason this function exists (docs/sources/SPEC.md 7.6): a
 * page is written by many runs. The vault's journal, its indexes and a Fellow's synthesis page
 * carry every earlier run's quotations, and checking a whole page against one job's document
 * reported 98.3 % of 2,971 quotes as unverified - noise, and all of it about text the job never
 * wrote. A run is answerable for the quotes it ADDS, which is exactly what the commit says.
 */
export async function newQuotesOf(vaultRoot: string, rel: string, before: PageBefore): Promise<PageQuote[]> {
  let after: string
  try {
    after = fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
  } catch {
    return []
  }
  const now = extractQuotes(rel, after)
  const previous = await before(rel)
  if (previous === null) return now
  const had = new Set(extractQuotes(rel, previous).map((q) => normalizeQuoteText(q.text)))
  return now.filter((q) => !had.has(normalizeQuoteText(q.text)))
}

/**
 * Checks the quotes a run added to `pages` against the text `jobIds` read (sections 7.1 to 7.4).
 *
 * Read-only over the vault, like the rest of the validator. Returns one finding per unverified
 * quote and the summary the job record carries. Two cases check nothing and say so: a job whose
 * artifact is gone (an old job whose `.raw/` was cleaned, an image), and a run with no commit to
 * compare against - without a before there is no way to tell this run's quotes from those of the
 * twelve runs before it, and guessing would report their text as this job's invention.
 */
export async function checkQuotes(args: {
  readonly vaultRoot: string
  readonly jobIds: readonly string[]
  readonly pages: readonly string[]
  /** Absent = nothing to compare against; the check is skipped with a note. */
  readonly before?: PageBefore
}): Promise<{ readonly findings: ValidationFinding[]; readonly summary: QuoteSummary }> {
  const pages = [...new Set(args.pages)].filter((p) => p.startsWith('wiki/') && p.endsWith('.md') && !isBookkeepingPage(p))
  if (args.before === undefined) {
    return { findings: [], summary: { checked: 0, unverified: 0, note: 'no commit to compare the pages against' } }
  }
  const quotes: PageQuote[] = []
  for (const rel of pages) quotes.push(...(await newQuotesOf(args.vaultRoot, rel, args.before)))
  if (quotes.length === 0) return { findings: [], summary: { checked: 0, unverified: 0 } }

  const corpus = await jobCorpus(args.vaultRoot, args.jobIds)
  if (corpus.artifacts === 0 || corpus.index.trim() === '') {
    return { findings: [], summary: { checked: 0, unverified: 0, note: 'no readable artifact for this job' } }
  }

  const findings: ValidationFinding[] = []
  for (const quote of quotes) {
    if (quoteHolds(quote.text, corpus.index)) continue
    // How much of it IS there, so a misquote reads as one and an invention as one (7.4).
    const words = wordsOf(quote.text).length
    findings.push({
      rule: 'quote',
      path: quote.path,
      message:
        `quote not found in the source: ${JSON.stringify(quote.text.slice(0, FINDING_CHARS))} ` +
        `(longest match ${longestRun(quote.text, corpus.index)} of ${words} words)`,
    })
  }
  return { findings, summary: { checked: quotes.length, unverified: findings.length } }
}

/** The before-reader over a run's own commit: the page as its parent commit had it. */
export function gitPageBefore(readAtRevision: (rev: string, rel: string) => Promise<string | null>, hash: string): PageBefore {
  return (rel) => readAtRevision(`${hash}^`, rel)
}
