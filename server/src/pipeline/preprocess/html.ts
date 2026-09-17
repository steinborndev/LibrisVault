/**
 * HTML the service did not fetch itself: reading a saved page's own address, turning markup
 * into text without a converter, and the gate that tells an article from a login wall.
 *
 * Its own module because BOTH lanes need it and they must not import each other: the URL lane
 * (`web.ts`) fetches the page, and the text plugin reads one saved from a browser. `web.ts`
 * re-exports everything here, so a call site that has always imported it from there still can.
 */

import type { ToolAvailability } from './types.js'
import { runConverter } from './sandbox.js'

/** What an extraction produced, and what it had to say about how. */
export interface ExtractedArticle {
  readonly markdown: string
  readonly notes: readonly string[]
}

/**
 * The article out of a page: `defuddle` in its jail when installed, the built-in fallback
 * otherwise (a missing optional tool must not fail a job).
 *
 * ONE implementation for the three callers that need it - a page the service fetched, a page the
 * user saved from a browser, and an open-access landing page (docs/sources/SPEC.md 5.2). They
 * had two copies of it and were about to have three; the notes keep their own prefix so a
 * reader of the manifest can still tell which lane produced them.
 */
export async function extractArticle(args: {
  /** The HTML on disk: defuddle reads a file, and it is the file the jail binds. */
  readonly filePath: string
  /** The same bytes in memory, for the fallback. */
  readonly html: string
  readonly tools: ToolAvailability
  readonly notePrefix?: string
}): Promise<ExtractedArticle> {
  const prefix = args.notePrefix ?? ''
  if (args.tools.defuddle) {
    try {
      const { stdout } = await runConverter('defuddle', ['parse', args.filePath, '--md'], {
        reads: [args.filePath],
        timeoutMs: 30_000,
      })
      return { markdown: stdout.trim(), notes: [`${prefix}extracted via defuddle`] }
    } catch {
      return { markdown: htmlToText(args.html), notes: [`${prefix}defuddle failed, used the built-in HTML-to-text fallback`] }
    }
  }
  return { markdown: htmlToText(args.html), notes: [`${prefix}defuddle not installed, used the built-in HTML-to-text fallback`] }
}

/**
 * The address a saved page names for itself - its canonical link, else its Open Graph
 * URL - so a page dropped as a file still says where it came from (the manifest's `url`,
 * the source page's, the reading list's). Attribute order is not fixed in HTML, so both
 * orders are read; anything but an http(s) address is ignored.
 */
export function canonicalUrlOf(html: string): string | undefined {
  const head = html.slice(0, 200_000)
  const attr = (tag: RegExp, key: string): string | undefined => {
    const m = head.match(tag)
    if (m === null) return undefined
    const v = m[0].match(new RegExp(`\\b${key}\\s*=\\s*["']([^"']+)["']`, 'i'))
    return v?.[1]
  }
  const candidates = [
    attr(/<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i, 'href'),
    attr(/<meta\b[^>]*\bproperty\s*=\s*["']og:url["'][^>]*>/i, 'content'),
  ]
  for (const c of candidates) {
    if (c === undefined) continue
    try {
      const u = new URL(c.trim())
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href
    } catch {
      /* not an address */
    }
  }
  return undefined
}

/**
 * The PDF a page says it HAS: `citation_pdf_url`, the tag publishers set for Google Scholar
 * (docs/sources/SPEC.md 3.2, added 2026-09-15).
 *
 * `pdfUrlFor` reads the address, and an address only says "PDF" in three shapes: an arXiv
 * abstract, a path ending in `.pdf`, and a `/pdf/` segment. A journal that routes its document
 * to a sibling of the article path - the HighWire and Silverchair families, which is most of
 * the literature - matches none of them, so an open-access paper was filed as the web page in
 * front of it. The page itself knows the answer and has been publishing it for years; this
 * reads it rather than guessing a URL per publisher.
 *
 * The answer is still only a candidate: the caller validates it like any other address, fetches
 * it under the same cap, and the magic bytes decide whether what came back is a document.
 */
export function citationPdfUrl(html: string): string | undefined {
  const head = html.slice(0, 200_000)
  const tag = /<meta\b[^>]*\b(?:name|property)\s*=\s*["']citation_pdf_url["'][^>]*>/i.exec(head)?.[0]
  if (tag === undefined) return undefined
  const raw = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.trim()
  // `&amp;` is the one entity an address routinely carries, and a query string that keeps it
  // literally is a different address from the one the page meant.
  return raw === undefined || raw === '' ? undefined : raw.replace(/&amp;/gi, '&')
}

/**
 * The title a page gives itself: `<title>`, else Open Graph, else the citation meta tag.
 *
 * Needed because the artifact does not hold it - a fetched page's first line is its ADDRESS and
 * defuddle drops the `<h1>` - and a run that quotes the document's title, which is an ordinary
 * thing to do, was then reported as having invented it (docs/sources/SPEC.md 7.6, second
 * calibration round). It goes into the manifest and from there into the quote corpus.
 */
export function htmlTitle(html: string): string | undefined {
  const head = html.slice(0, 200_000)
  const attr = (tag: RegExp, key: string): string | undefined => {
    const m = head.match(tag)
    if (m === null) return undefined
    return new RegExp(`\\b${key}\\s*=\\s*["']([^"']+)["']`, 'i').exec(m[0])?.[1]
  }
  const raw =
    /<title[^>]*>([\s\S]{1,400}?)<\/title>/i.exec(head)?.[1] ??
    attr(/<meta\b[^>]*\bproperty\s*=\s*["']og:title["'][^>]*>/i, 'content') ??
    attr(/<meta\b[^>]*\bname\s*=\s*["']citation_title["'][^>]*>/i, 'content')
  if (raw === undefined) return undefined
  const text = raw
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#3?9;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? undefined : text
}

/** Bare-minimum HTML to text when defuddle is unavailable: strips tags, collapses space. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Minimum characters the generic extraction must yield before a job proceeds to ingest. */
export const MIN_WEB_CONTENT_CHARS = 300
/**
 * Only short extractions are pattern-checked: a real article that merely QUOTES a login
 * prompt is long, so the length bound keeps the patterns from false-positive matching.
 */
const GATE_PATTERN_MAX_CHARS = 5000

const BLOCKED_PAGE_PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly reason: string }> = [
  { re: /javascript is not available/i, reason: 'the site serves a JavaScript-only shell (X/Twitter login wall)' },
  { re: /please (enable|turn on) javascript|(enable|activate) javascript and cookies/i, reason: 'the page requires JavaScript rendering' },
  { re: /(log|sign) ?in to (continue|view|read)|sign ?up to (continue|view|read)/i, reason: 'login required' },
  { re: /you (must|need to) be logged in|create an account to (continue|read|view)/i, reason: 'login required' },
  { re: /subscribe (now )?to (continue|read|keep reading)|subscription required/i, reason: 'paywall' },
  { re: /checking your browser|verify(ing)? (that )?you are (a )?human|just a moment\.\.\.|attention required.{0,5}cloudflare/i, reason: 'anti-bot interstitial (e.g. Cloudflare)' },
  { re: /melde dich an|melden sie sich an|jetzt anmelden|jetzt registrieren/i, reason: 'login required (German)' },
  { re: /abonnieren, um weiter ?zu ?lesen|jetzt abonnieren und weiterlesen/i, reason: 'paywall (German)' },
]

/**
 * Sanity gate for the generic fetch+extract path (SPEC.md §5): returns a human-readable
 * reason when the extraction is junk (app shell, login wall, anti-bot page), else null.
 * Failing here turns the job `failed` with that reason BEFORE an agent run burns tokens
 * on it and writes a garbage page into the vault.
 */
export function assessExtractedContent(markdown: string): string | null {
  const text = markdown.trim()
  if (text.length < MIN_WEB_CONTENT_CHARS) {
    return `only ${text.length} characters of extractable content: the page is likely a JavaScript app shell, empty, or blocked`
  }
  if (text.length <= GATE_PATTERN_MAX_CHARS) {
    for (const p of BLOCKED_PAGE_PATTERNS) {
      if (p.re.test(text)) return `page looks like a login/anti-bot/paywall shell: ${p.reason}`
    }
  }
  return null
}
