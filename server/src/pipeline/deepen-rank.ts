/**
 * Which pages a deepen task should build out tonight (docs/agents/ideas.md, decision
 * 2026-09-07).
 *
 * A deepen task names a THEME, not a page set: a fixed list runs dry after two nights, while a
 * theme re-ranked each run lets what has already been built out fall to the back on its own.
 *
 * Two steps. First the theme picks its pages - token overlap between the task's sentence and a
 * page's title and tags, the same tokeniser the scope score uses, so "endosomal escape and LNP
 * formulation" finds the pages about those things. Then the same demand-against-substance
 * ranking the Deepen dialog uses puts the thin, much-linked ones first.
 *
 * TWIN: `web/src/lib/library/../deepen.ts` ranks identically for the dialog. The formula lives
 * in two places because the two workspaces share no code; if one changes, change both, and the
 * test below pins the numbers so a drift shows up as a failure rather than as two different
 * answers to the same question.
 */

import type { VaultGraph, GraphNode } from './graph.js'
import { tokenize } from './related-pages.js'

/** The wiki buckets a deepening run may append to; a source page records someone else's document. */
const DEEPENABLE = new Set(['concepts', 'entities'])
/** Bytes of a page that is barely there; the divisor's floor, so an empty page still sorts first. */
const FLOOR_BYTES = 200
/** Below this overlap a page is not about the theme at all. */
const THEME_MIN = 0.12

export interface RankedPage {
  readonly path: string
  readonly title: string
  readonly backlinks: number
  readonly bytes: number
  /** Demand per kilobyte - only meaningful against the other candidates of the same theme. */
  readonly score: number
}

/** Overlap of the theme's words with a page's own, 0 to 1. */
function themeMatch(theme: ReadonlySet<string>, node: GraphNode): number {
  if (theme.size === 0) return 0
  const words = tokenize(`${node.title} ${(node.names ?? []).join(' ')} ${node.tags.join(' ')}`)
  if (words.size === 0) return 0
  let shared = 0
  for (const t of theme) if (words.has(t)) shared++
  return shared / theme.size
}

/**
 * The pages of `domains` that the theme is about, worth deepening first.
 *
 * Bounded to the Fellow's own domains, the same rule the hand-started deepening follows: a
 * Fellow works its own ground, and a task cannot widen that.
 */
export function rankForDeepening(graph: VaultGraph | null, domains: ReadonlySet<string>, theme: string, limit: number): RankedPage[] {
  if (graph === null) return []
  const words = tokenize(theme)
  const out: Array<RankedPage & { match: number }> = []
  for (const n of graph.nodes) {
    if (!DEEPENABLE.has(n.type) || (n.kind ?? 'knowledge') !== 'knowledge') continue
    if (n.domain === null || !domains.has(n.domain)) continue
    const match = themeMatch(words, n)
    if (match < THEME_MIN) continue
    const bytes = n.size ?? 0
    out.push({ path: n.path, title: n.title, backlinks: n.in, bytes, score: (n.in + 1) / (Math.max(bytes, FLOOR_BYTES) / 1024), match })
  }
  // The theme decides WHETHER a page belongs; the score decides in which order. Ties break on
  // the smaller page and then the path, so the same vault proposes the same set twice running.
  out.sort((a, b) => b.score - a.score || a.bytes - b.bytes || a.path.localeCompare(b.path))
  return out.slice(0, limit).map(({ match: _match, ...rest }) => rest)
}
