/**
 * Grouping the pages a run wrote, by the kind their folder says they are.
 *
 * The band that shows them used to be a flat row of chips, each carrying its own kind label,
 * inside a container fixed at two rows' height with the rest behind a scrollbar. A run that
 * wrote nine pages therefore showed four and hid five, and printed the word "concepts" on
 * every one of them.
 *
 * Grouped, the kind is a column label said once and the names get the whole width. What a
 * long group does about its length is the caller's business - this only decides what belongs
 * together and in which order.
 */

/** The kinds a vault page can be, in the order the band lists them. */
export const PAGE_KINDS = ['concept', 'entity', 'source', 'question', 'other'] as const
export type PageKind = (typeof PAGE_KINDS)[number]

const LABEL: Record<PageKind, { one: string; many: string }> = {
  concept: { one: 'Concept', many: 'Concepts' },
  entity: { one: 'Entity', many: 'Entities' },
  source: { one: 'Source', many: 'Sources' },
  question: { one: 'Question', many: 'Questions' },
  // `wiki/index.md`, `wiki/hot.md`, `wiki/log.md`: real pages a run touches, and none of them
  // is a finding. Named for what they are rather than dropped, because a page count that does
  // not add up is worse than a row nobody reads.
  other: { one: 'Page', many: 'Pages' },
}

/**
 * The kind of one vault-relative path. The folder decides, which is the vault's own rule -
 * `type:` in the frontmatter would be authoritative but is not in a path the run reports.
 */
export function pageKind(path: string): PageKind {
  const p = path.toLowerCase()
  if (p.startsWith('wiki/concepts/')) return 'concept'
  if (p.startsWith('wiki/entities/')) return 'entity'
  if (p.startsWith('wiki/sources/')) return 'source'
  if (p.startsWith('wiki/questions/')) return 'question'
  return 'other'
}

export interface PageGroup {
  readonly kind: PageKind
  /** `Concepts 5`, or `Concept 1` - the count is part of the label, not a chip of its own. */
  readonly label: string
  readonly paths: readonly string[]
}

/**
 * The groups a page list falls into, empty ones dropped and in `PAGE_KINDS` order - so two
 * runs that wrote the same kinds put them in the same places, whatever order the run reported
 * them in.
 */
export function groupPages(paths: readonly string[]): PageGroup[] {
  const by = new Map<PageKind, string[]>()
  for (const p of paths) {
    const k = pageKind(p)
    const list = by.get(k)
    if (list) list.push(p)
    else by.set(k, [p])
  }
  const out: PageGroup[] = []
  for (const kind of PAGE_KINDS) {
    const list = by.get(kind)
    if (list === undefined || list.length === 0) continue
    const l = LABEL[kind]
    out.push({ kind, label: `${list.length === 1 ? l.one : l.many} ${list.length}`, paths: list })
  }
  return out
}

/**
 * The one-line summary for a list row: `5 concepts · 3 entities`. Singular where it is one,
 * because "1 questions" is both wrong and a character wider than the column has to be.
 */
export function countLine(paths: readonly string[]): string {
  return groupPages(paths)
    .map((g) => `${g.paths.length} ${(g.paths.length === 1 ? LABEL[g.kind].one : LABEL[g.kind].many).toLowerCase()}`)
    .join(' · ')
}
