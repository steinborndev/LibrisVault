/**
 * Which domain a run filed its pages under, for the record's fact strip (Home, 2026-09-24).
 *
 * Read off the pages themselves, as the graph knows them now: the domain of the run's main
 * article (for an ingest, the page of the source it read), else the domain most of its
 * knowledge pages carry, and every domain with its count for the tooltip. "Pages written"
 * counts the existing pages a run added to as well, which is why the article decides: an
 * ingest filed as `unassigned` that also touched one page elsewhere is still unassigned. A run whose pages fell into `unassigned` says so, which is the one
 * case worth noticing - it means no domain of the registry took the subject.
 *
 * Pure, like the rest of `lib/`: the component hands in the graph's nodes.
 */

export interface IngestDomain {
  /** The main article's domain, else the one most of its pages carry; null when none is in the graph. */
  readonly domain: string | null
  /** Every domain its pages carry, most pages first. */
  readonly counts: ReadonlyArray<readonly [string, number]>
}

export function ingestDomain(
  pages: readonly string[],
  nodes: ReadonlyArray<{ readonly path: string; readonly domain: string | null; readonly kind?: string }>,
  article: string | null,
): IngestDomain {
  const byPath = new Map(nodes.map((n) => [n.path, n]))
  const counts = new Map<string, number>()
  for (const p of pages) {
    const n = byPath.get(p)
    if (n === undefined || (n.kind !== undefined && n.kind !== 'knowledge')) continue
    const d = n.domain ?? 'unassigned'
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  const articleNode = article === null ? undefined : byPath.get(article)
  const articleDomain = articleNode === undefined ? null : (articleNode.domain ?? 'unassigned')
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return { domain: articleDomain ?? sorted[0]?.[0] ?? null, counts: sorted }
}
