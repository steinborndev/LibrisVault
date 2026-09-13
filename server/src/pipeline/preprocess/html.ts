/**
 * HTML the service did not fetch itself: reading a saved page's own address, turning markup
 * into text without a converter, and the gate that tells an article from a login wall.
 *
 * Its own module because BOTH lanes need it and they must not import each other: the URL lane
 * (`web.ts`) fetches the page, and the text plugin reads one saved from a browser. `web.ts`
 * re-exports everything here, so a call site that has always imported it from there still can.
 */

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

/** Bare-minimum HTML→text when defuddle is unavailable — strips tags, collapses space. */
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
    return `only ${text.length} characters of extractable content — the page is likely a JavaScript app shell, empty, or blocked`
  }
  if (text.length <= GATE_PATTERN_MAX_CHARS) {
    for (const p of BLOCKED_PAGE_PATTERNS) {
      if (p.re.test(text)) return `page looks like a login/anti-bot/paywall shell: ${p.reason}`
    }
  }
  return null
}
