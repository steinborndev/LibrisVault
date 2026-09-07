/**
 * Which pages of a domain are worth deepening (docs/agents/ideas.md, decision 2026-09-07).
 *
 * A `research-expand` run appends to pages that already exist, and the question the user
 * should NOT have to answer is which ones. The vault answers it: a page many others link to
 * and that carries little text is a promise the vault keeps making and does not pay off.
 * That is demand against substance, and both halves are already on every graph node - `in`
 * from the link index, `size` from the file - so the ranking is a pure function here rather
 * than a new endpoint.
 *
 * Recency (`mtimeMs`) and isolation (`out`) are other real kinds of gap, deliberately not
 * this one: an old page can be finished, and an isolated page can be thorough.
 */

import type { FellowSummary, GraphNode } from '../api/types.ts'

/** A page the vault points at more than it pays off, with the numbers that said so. */
export interface DeepenCandidate {
  readonly path: string
  readonly title: string
  /** Pages linking here - the demand. */
  readonly backlinks: number
  /** File size in bytes - the substance. */
  readonly bytes: number
  /** Demand per kilobyte; only meaningful against the other candidates of the same domain. */
  readonly score: number
}

/**
 * The wiki buckets a deepening run may append to. A source page is the record of a document
 * someone else wrote and does not grow with our thinking; index hubs and reports are not
 * knowledge at all (`kind`), and the Fellow's own notebook and synthesis pages join the set
 * on the server anyway.
 */
const DEEPENABLE = new Set(['concepts', 'entities'])

/** Bytes of a page that is barely there; the divisor's floor, so an empty page still sorts first. */
const FLOOR_BYTES = 200

/**
 * The pages of `domain` in the order they deserve deepening, best first.
 *
 * Ties break on the smaller page and then on the path, so the same vault always proposes the
 * same set: a dialog that reshuffles between two openings is a dialog nobody trusts.
 */
export function deepenCandidates(nodes: readonly GraphNode[], domain: string): DeepenCandidate[] {
  return nodes
    .filter((n) => n.domain === domain && DEEPENABLE.has(n.type) && (n.kind ?? 'knowledge') === 'knowledge')
    .map((n) => {
      const bytes = n.size ?? 0
      return { path: n.path, title: n.title, backlinks: n.in, bytes, score: (n.in + 1) / (Math.max(bytes, FLOOR_BYTES) / 1024) }
    })
    .sort((a, b) => b.score - a.score || a.bytes - b.bytes || a.path.localeCompare(b.path))
}

/** How many pages a hand-started deepening may name; the planner keeps its own, smaller cap. */
export const DEEPEN_MAX_PAGES = 8
/** How many the dialog proposes before you add or remove any - the planner's cap, so both agree. */
export const DEEPEN_DEFAULT_PAGES = 4

/**
 * What a deepening of `pages` pages costs and how long it may take, mirroring the server's
 * own arithmetic (`expandBudgetUsd`, `expandTimeoutMs`) so the dialog can say it before the
 * run starts. A run orients itself in the vault once, so the eighth page is cheaper than the
 * first: the base covers four, each further page adds a fixed amount rather than a share.
 */
export const DEEPEN_BASE_USD = 6
export const DEEPEN_PER_PAGE_USD = 1

export function deepenCostUsd(pages: number, modelFactor = 1): number {
  const base = DEEPEN_BASE_USD + Math.max(0, pages - DEEPEN_DEFAULT_PAGES) * DEEPEN_PER_PAGE_USD
  return Math.round(base * modelFactor * 100) / 100
}

/**
 * The Fellows that may deepen `domain`, home domain first.
 *
 * A Fellow works its own ground: its home domain and the extra ones it was given, and nothing
 * else (decision 2026-09-07). Borrowing a Fellow for a foreign domain would let one grow past
 * its subject without anyone deciding that, which is the drift the scope score exists to catch
 * - so an empty answer is not a dead end but the case where a domain wants its own Fellow.
 *
 * Retired and paused Fellows are left out: they are not going to run.
 */
export function fellowsForDomain(fellows: readonly FellowSummary[], domain: string): FellowSummary[] {
  const eligible = fellows.filter((f) => f.agent.state !== 'retired' && f.agent.state !== 'paused')
  const home = eligible.filter((f) => f.agent.homeDomain === domain)
  const extra = eligible.filter((f) => f.agent.homeDomain !== domain && f.agent.extraDomains.includes(domain))
  return [...home, ...extra]
}
