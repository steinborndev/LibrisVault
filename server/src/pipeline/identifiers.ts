/**
 * Publication identifiers, in one place (docs/sources/SPEC.md section 2.2).
 *
 * A DOI and an arXiv id are read by four call sites that used to know nothing of each other:
 * the dedupe index (is this document already here?), the URL path (is this address a PDF?),
 * the open-access resolver (what is the paper this address names?) and the reading list (has
 * the entry arrived?). Same strings, same normalization, and a disagreement between any two
 * of them shows up as a document ingested twice or an entry that never closes.
 *
 * Nothing here reaches the network or the disk: these are pure string functions over an
 * address or a page's markup.
 */

/**
 * An arXiv identifier as it stands in an address: the current scheme (`2506.20907`, with an
 * optional `v2`) and the old one (`astro-ph/0601001`), which carries a slash and is therefore
 * two path segments rather than one.
 */
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/

/** The hosts that serve arXiv's abstract and PDF pages. */
const ARXIV_HOSTS = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'])

/**
 * The arXiv id an address names, or undefined when it names none.
 *
 * The VERSION SUFFIX IS KEPT when the address carries one: `/abs/2506.20907v1` names that
 * revision, and fetching the latest instead would hand the ingest a different document than
 * the one the user asked for.
 */
export function arxivIdFromUrl(url: URL | string): string | undefined {
  let u: URL
  try {
    u = typeof url === 'string' ? new URL(url) : url
  } catch {
    return undefined
  }
  if (!ARXIV_HOSTS.has(u.hostname.toLowerCase())) return undefined
  const m = /^\/(?:abs|pdf)\/(.+)$/.exec(u.pathname)
  if (m === null) return undefined
  // `/pdf/2506.20907.pdf` and `/pdf/2506.20907v2` are the same document as `/abs/2506.20907`.
  const id = m[1]!.replace(/\.pdf$/i, '').replace(/\/+$/, '')
  return ARXIV_ID.test(id) ? id : undefined
}

/**
 * A DOI as it appears in running text or an address. The prefix is fixed by the standard
 * (`10.` + a 4 to 9 digit registrant); the suffix runs to whitespace or a delimiter that cannot
 * be part of one in practice. Moved here from `dedupe.ts`, which still re-exports what it used
 * to own so its own call sites read the same as before.
 */
export const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>()[\]{}]+/g

/** Lowercases (DOIs are case-insensitive) and drops the punctuation a sentence appends. */
export function normalizeDoi(raw: string): string {
  return raw.replace(/[.,;:]+$/, '').toLowerCase()
}

/** Every DOI in `text`, normalized, in order of appearance. */
export function doisIn(text: string): string[] {
  return (text.match(DOI_RE) ?? []).map(normalizeDoi)
}

/**
 * The DOI an address names: a `doi.org` link, or a DOI standing in the path or the query of a
 * publisher's own address (`/doi/10.1234/x`, `?doi=10.1234%2Fx`). Undefined when it names none.
 *
 * The whole address is searched rather than just the path, because a link to a document often
 * carries the DOI as a parameter - and nothing else in an address looks like a DOI.
 */
export function doiFromUrl(url: URL | string): string | undefined {
  let href: string
  try {
    href = typeof url === 'string' ? new URL(url).href : url.href
  } catch {
    return undefined
  }
  // A percent-encoded slash is common in a `?doi=` parameter and is the same DOI.
  const decoded = ((): string => {
    try {
      return decodeURIComponent(href)
    } catch {
      return href
    }
  })()
  return doisIn(decoded)[0]
}

/**
 * The DOI a PAGE declares about itself: the citation meta tags publishers emit, or a canonical
 * link that is a DOI link.
 *
 * NEVER a DOI found only in the running text (docs/sources/SPEC.md section 2.2): a reference
 * list is full of other papers' DOIs, and resolving one of those would fetch a cited work in
 * place of the page the user asked for - which is worse than not resolving anything.
 */
export function doiFromHtml(html: string): string | undefined {
  const head = html.slice(0, 200_000)
  const metaKeys = ['citation_doi', 'dc.identifier', 'dc.identifier.doi', 'prism.doi', 'citation_id']
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.trim().toLowerCase()
    if (name === undefined || !metaKeys.includes(name)) continue
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    const doi = content === undefined ? undefined : doisIn(content)[0]
    if (doi !== undefined) return doi
  }
  const canonical = /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i.exec(head)?.[0]
  const href = canonical === undefined ? undefined : /\bhref\s*=\s*["']([^"']+)["']/i.exec(canonical)?.[1]
  if (href !== undefined && /(?:^|\/\/)(?:dx\.)?doi\.org\//i.test(href)) return doiFromUrl(href)
  return undefined
}
