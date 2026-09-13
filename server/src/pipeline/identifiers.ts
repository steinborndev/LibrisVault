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
