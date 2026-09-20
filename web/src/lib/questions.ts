/**
 * The pinboard's cuts (prototype 2026-09-17), on the reading list's model: which list you are
 * looking at - open or archived - and then which domain. Plus, since 2026-09-20, which rows are
 * the same question written more than once. Pure, so the tests pin it.
 */
import type { QuestionItem } from '../api/types.ts'

export type QuestionTab = 'current' | 'archived'

/**
 * One row of the board as the screen around it sees it: the question, and the page it stands
 * on. The page rides along because handing a question to a research run carries its origin
 * page with it (docs/tasks/TASKS-QUESTIONS.md, phase 1), and the keyboard path has to be able
 * to do exactly what the row's own button does.
 */
export interface QuestionRow {
  readonly text: string
  readonly page: string
}

/**
 * Words that carry no topical signal, so two questions sharing them are not thereby similar.
 *
 * MIRRORS the server: `STOPWORDS` in `server/src/pipeline/related-pages.ts` plus `QUESTION_WORDS`
 * in `server/src/pipeline/planner.ts`, which `scopeScore` subtracts. Kept in step by hand, the
 * same arrangement `STUB_BYTES` has in `web/src/lib/domains.ts` - the audit CLI and this file
 * have to group a vault's questions the same way or the board and the measurement disagree
 * about how many distinct questions there are. `server/test/question-audit.test.ts` and
 * `web/test/questionClusters.test.ts` run the SAME cases for exactly that reason.
 */
const STOPWORDS = new Set([
  // related-pages.ts
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'on', 'to', 'with', 'from', 'into', 'its',
  'is', 'are', 'be', 'as', 'at', 'by', 'this', 'that', 'these', 'those', 'it', 'their',
  'research', 'recent', 'insights', 'insight', 'overview', 'introduction', 'update', 'updates',
  'using', 'use', 'based', 'new', 'state', 'guide', 'notes', 'note', 'about',
  // planner.ts QUESTION_WORDS
  'how', 'well', 'where', 'when', 'what', 'which', 'why', 'who', 'whether', 'does', 'doe', 'did', 'can',
  'could', 'would', 'should', 'come', 'there', 'than', 'then', 'only', 'also', 'more', 'most', 'much',
  'many', 'far', 'still', 'really', 'actually', 'between', 'against', 'within', 'without', 'across',
])

/** Significant tokens: lower-cased, punctuation stripped, stopwords and short words dropped,
 * one trailing plural `s` removed so "turbines" matches "turbine". Mirrors `tokenize`. */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue
    tokens.add(raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw)
  }
  return tokens
}

/** Overlap coefficient of the significant tokens. Mirrors `scopeScore`. */
export function questionOverlap(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return Math.round((shared / Math.min(ta.size, tb.size)) * 100) / 100
}

/**
 * Overlap at or above which two bullets are read as the same question.
 *
 * MIRRORS `CLUSTER_THRESHOLD` in `server/src/cli/questionaudit.ts`. 0.7 over the coefficient
 * above: low enough to catch the shape this vault actually produces - one run writing the same
 * open item onto its notebook, its synthesis page and the concept page it touched, in three
 * wordings, 43 times over - and high enough that a narrower follow-up on a subject stays its
 * own question, which is the expensive error to make.
 */
export const CLUSTER_THRESHOLD = 0.7

/** A question, and every place it was written. One row of the board. */
export interface QuestionCluster {
  /** The row's own identity, stable across renders: the lead's id. */
  readonly id: string
  /** What the row shows: the member carrying the most context. */
  readonly lead: QuestionItem
  /** Every member, lead included. Archiving the row archives all of them. */
  readonly members: readonly QuestionItem[]
  /** True when a Fellow planned ANY member for tonight: the question is claimed. */
  readonly planned: QuestionItem['planned']
  /** Likewise for a run in flight on any member. */
  readonly researching: QuestionItem['researching']
  /** Every domain a member stands in, so a clustered row is missing from none of them. */
  readonly domains: readonly (string | null)[]
}

/**
 * Groups the questions of one tab that read as the same question.
 *
 * Clustering happens per TAB, so a cluster never mixes an archived member with an open one:
 * archiving one wording of a question and leaving another is a state the user can produce, and
 * a row that is half struck through has nothing useful to say.
 *
 * The lead is the LONGEST member, tie broken by page path. Longest because these wordings
 * differ by how much context they carry, and the one that says the most is the one worth
 * reading and worth handing to a run; by path because a stable choice keeps the row from
 * reshuffling under the pointer between two polls.
 */
export function questionClusters(entries: readonly QuestionItem[], tab: QuestionTab = 'current'): QuestionCluster[] {
  const inTab = entries.filter((e) => (tab === 'archived' ? e.archived : !e.archived))
  const parent = inTab.map((_, i) => i)
  const find = (x: number): number => {
    let root = x
    while (parent[root] !== root) root = parent[root]!
    let cur = x
    while (parent[cur] !== root) {
      const next = parent[cur]!
      parent[cur] = root
      cur = next
    }
    return root
  }
  for (let i = 0; i < inTab.length; i++) {
    for (let j = i + 1; j < inTab.length; j++) {
      if (find(i) === find(j)) continue
      if (questionOverlap(inTab[i]!.text, inTab[j]!.text) >= CLUSTER_THRESHOLD) parent[find(i)] = find(j)
    }
  }
  const groups = new Map<number, QuestionItem[]>()
  for (let i = 0; i < inTab.length; i++) {
    const root = find(i)
    const g = groups.get(root)
    if (g) g.push(inTab[i]!)
    else groups.set(root, [inTab[i]!])
  }
  const out: QuestionCluster[] = []
  for (const members of groups.values()) {
    const lead = [...members].sort((a, b) => b.text.length - a.text.length || a.page.localeCompare(b.page))[0]!
    out.push({
      id: lead.id,
      lead,
      members,
      planned: members.find((m) => m.planned !== null)?.planned ?? null,
      researching: members.find((m) => m.researching !== null)?.researching ?? null,
      domains: [...new Set(members.map((m) => m.domain))],
    })
  }
  // The order the entries arrived in, by where the lead sat: page order, which is what the
  // board showed before clustering and what the keys walk.
  return out.sort((a, b) => inTab.indexOf(a.lead) - inTab.indexOf(b.lead))
}

export interface QuestionView {
  readonly shown: QuestionCluster[]
  /** How many distinct questions stand in the domain you are looking at. */
  readonly total: number
  /** Of the shown: planned for tonight by a Fellow, and being researched right now. */
  readonly planned: number
  readonly researching: number
}

/**
 * The domains that have something on the list, alphabetical: a ring whose order followed the
 * counts would reshuffle itself as questions close. Questions without a domain stand under
 * "all domains" alone.
 */
export function questionDomains(clusters: readonly QuestionCluster[]): string[] {
  const out = new Set<string>()
  for (const c of clusters) for (const d of c.domains) if (d !== null) out.add(d)
  return [...out].sort((a, b) => a.localeCompare(b))
}

/**
 * One domain's worth of the board. Counted over CLUSTERS, so the lede and the rows agree about
 * how many questions there are; a clustered row appears in every domain one of its members
 * stands in, so grouping never hides a question from the shelf it belongs to.
 */
export function questionView(clusters: readonly QuestionCluster[], domain: string | null = null): QuestionView {
  const shown = domain === null ? [...clusters] : clusters.filter((c) => c.domains.includes(domain))
  return {
    shown,
    total: shown.length,
    planned: shown.filter((c) => c.planned !== null).length,
    researching: shown.filter((c) => c.researching !== null).length,
  }
}

/**
 * Whether a reformulation that has just come back may replace what is in the composer
 * (docs/tasks/TASKS-QUESTIONS.md, phase 2, decision D3).
 *
 * The suggestion is asked for the moment a question lands in the box, and it takes a few
 * seconds to arrive. In that window the user may already be typing, and their edit wins: the
 * answer is only accepted when the box still holds exactly the text it was asked about. It is
 * a suggestion, so losing it costs nothing; overwriting somebody mid-sentence would.
 */
export function acceptsSuggestion(current: string, askedAbout: string): boolean {
  return current.trim() === askedAbout.trim()
}

/**
 * Archives (or restores) every wording of one question, one call at a time, in order.
 *
 * Each member is its own page, its own vault commit and its own file lock, so these would
 * queue on the commit mutex however they were issued; doing it in order means a failure has a
 * place in a sequence and can be reported as one. What comes back on a failure says how far it
 * got, because "3 of 5 pages done" is a different thing to do next than "nothing happened".
 *
 * The caller invalidates the list either way, so the board shows what is actually on disk
 * rather than what was asked for.
 */
export async function archiveCluster(
  members: readonly QuestionItem[],
  archived: boolean,
  call: (page: string, text: string, archived: boolean) => Promise<unknown>,
): Promise<number> {
  let done = 0
  for (const m of members) {
    try {
      await call(m.page, m.text, archived)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      if (members.length === 1) throw new Error(why, { cause: err })
      throw new Error(`${done} of ${members.length} page(s) done, then ${m.page} failed: ${why}`, { cause: err })
    }
    done++
  }
  return done
}
