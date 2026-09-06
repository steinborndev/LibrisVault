/**
 * Candidate sources for a Fellow's planning run (docs/agents/SPEC.md section 6.1):
 * deterministic, computed by the service, all vault-internal.
 *
 *   1. Open questions from the Fellow's own synthesis pages and its notebook.
 *   2. Graph gaps (unresolved wikilinks) whose referrers are the Fellow's pages or pages in
 *      its domains, in the order the "Worth a run" backlog ranks them.
 *   3. Stubs in the Fellow's domains.
 *   4. Sources ingested into the Fellow's domains since its last run.
 *   5. Handoffs from other Fellows (A3; not computed here yet).
 *
 * Fetched web content never becomes a candidate directly: everything here is read from
 * pages the vault already holds, which is the injection boundary the spec relies on
 * (section 13). The list is capped so the planning prompt stays bounded.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AgentRecord } from '../db/agents.js'
import type { AgentRunRecord } from '../db/agent-runs.js'
import type { JobRow } from '../db/jobs.js'
import type { VaultGraph } from './graph.js'
import { parseNotebook } from './notebook.js'

export type CandidateKind = 'open-question' | 'gap' | 'stub' | 'ingest' | 'handoff'

export interface Candidate {
  /** Stable id inside one planning run, `C1` and up, the handle the planner names. */
  readonly id: string
  readonly kind: CandidateKind
  /** The question, gap title, stub title or source name, as shown to the planner. */
  readonly text: string
  /** Vault-relative pages the candidate came from. */
  readonly sourcePages: readonly string[]
  /** Ordering weight; higher first. */
  readonly weight: number
}

/** A page under this many bytes is a stub (kept in step with `STUB_BYTES` in web/src/lib/domains.ts). */
export const STUB_BYTES = 1024
/** How many candidates reach the planner at most. */
export const MAX_CANDIDATES = 20
const MAX_QUESTIONS = 10
const MAX_GAPS = 8
const MAX_STUBS = 5
const MAX_INGESTS = 5

export interface CandidateInput {
  readonly agent: AgentRecord
  /** The Fellow's settled runs, newest first (their pages name its synthesis pages). */
  readonly runs: readonly AgentRunRecord[]
  readonly vaultRoot: string
  /** The live graph, or null when unavailable (gaps and stubs are then skipped). */
  readonly graph: VaultGraph | null
  /** Finished ingest jobs, newest first. */
  readonly jobs: readonly JobRow[]
  /** Only ingests finished after this instant count; null = every ingest. */
  readonly since: string | null
}

/** The domains a Fellow reads as its own: home plus extras. */
export function fellowDomains(agent: AgentRecord): ReadonlySet<string> {
  return new Set([agent.homeDomain, ...agent.extraDomains])
}

/** Normalises a question for de-duplication: case, whitespace and trailing punctuation. */
const questionKey = (q: string): string => q.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.?!]+$/g, '').trim()

/**
 * Bullet items under an `## Open questions` (any case) section. A bullet may wrap onto
 * indented continuation lines, as the autoresearch skill writes them. Lines the Fellow marked
 * as answered (`(answered …)`) are skipped.
 */
export function parseOpenQuestions(markdown: string): string[] {
  const { sections } = parseNotebook(markdown)
  let body: string | undefined
  for (const [name, text] of sections) if (name.toLowerCase() === 'open questions') body = text
  if (!body) return []
  const out: string[] = []
  let current: string | null = null
  const flush = (): void => {
    if (current !== null) {
      const q = current.replace(/\s+/g, ' ').trim()
      // Skipped: placeholders, questions marked answered, and struck-through ones (~~…~~),
      // both conventions the runs use to close a question without deleting the line.
      if (q !== '' && !/^\(none/i.test(q) && !/\(answered\b/i.test(q) && !q.startsWith('~~')) out.push(q)
    }
    current = null
  }
  for (const line of body.split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      flush()
      current = bullet[1] ?? ''
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += ' ' + line.trim()
    } else flush()
  }
  flush()
  return out
}

const readPage = (vaultRoot: string, rel: string): string | undefined => {
  try {
    return fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
  } catch {
    return undefined
  }
}

/** The synthesis pages the Fellow's runs committed, newest run first, deduplicated. */
export function fellowSynthesisPages(runs: readonly AgentRunRecord[]): string[] {
  const out: string[] = []
  for (const r of runs) for (const p of r.pages) if (p.startsWith('wiki/questions/') && !out.includes(p)) out.push(p)
  return out
}

/**
 * Pages a run committed that count as knowledge: not the bookkeeping pages (index, hot
 * cache, journal), not `wiki/meta/`, not the synthesis page under `wiki/questions/`. The
 * stall rule (docs/tasks/TASKS-A1.md D8) and the gap attribution below both read it.
 */
export function knowledgePages(pages: readonly string[]): string[] {
  return pages.filter(
    (p) =>
      p.startsWith('wiki/') &&
      !p.startsWith('wiki/meta/') &&
      !p.startsWith('wiki/questions/') &&
      !['wiki/index.md', 'wiki/hot.md', 'wiki/log.md', 'wiki/overview.md'].includes(p) &&
      !p.endsWith('/_index.md'),
  )
}

/**
 * The knowledge pages the Fellow's runs committed, for gap attribution. Bookkeeping pages
 * stay out on purpose: every run touches `wiki/log.md` and `wiki/index.md`, and the
 * journal names every page that ever existed, so counting them would hand the Fellow
 * every gap in the vault (seen on the first real planning run, 2026-09-06).
 */
function fellowPages(runs: readonly AgentRunRecord[]): Set<string> {
  const out = new Set<string>()
  for (const r of runs) for (const p of knowledgePages(r.pages)) out.add(p)
  return out
}

function parseCreatedPages(job: JobRow): string[] {
  if (!job.created_pages) return []
  try {
    const parsed: unknown = JSON.parse(job.created_pages)
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

/** Computes the candidate list for one planning run. Never throws; an unreadable source is skipped. */
export function computeCandidates(input: CandidateInput): Candidate[] {
  const { agent, runs, vaultRoot, graph } = input
  const domains = fellowDomains(agent)
  const raw: Array<Omit<Candidate, 'id'>> = []

  // 1. Open questions: the notebook first (the Fellow's running list), then its syntheses.
  const seen = new Set<string>()
  const addQuestions = (page: string, weight: number): void => {
    const md = readPage(vaultRoot, page)
    if (md === undefined) return
    for (const q of parseOpenQuestions(md)) {
      const key = questionKey(q)
      if (seen.has(key)) continue
      seen.add(key)
      raw.push({ kind: 'open-question', text: q, sourcePages: [page], weight })
    }
  }
  addQuestions(agent.notebookPath, 3)
  for (const page of fellowSynthesisPages(runs)) addQuestions(page, 2)
  const questions = raw.filter((c) => c.kind === 'open-question').slice(0, MAX_QUESTIONS)
  raw.length = 0
  raw.push(...questions)

  if (graph !== null) {
    const own = fellowPages(runs)
    const isMine = (i: number): boolean => {
      const node = graph.nodes[i]
      if (!node) return false
      return own.has(node.path) || (node.domain !== null && domains.has(node.domain))
    }
    // 2. Gaps, in the backlog's order (the graph already ranks them).
    let gaps = 0
    for (const gap of graph.gaps) {
      if (gaps >= MAX_GAPS) break
      const referrers = gap.refBy.filter(isMine)
      if (referrers.length === 0) continue
      gaps++
      raw.push({
        kind: 'gap',
        text: gap.title,
        sourcePages: referrers.slice(0, 4).map((i) => graph.nodes[i]!.path),
        weight: 1 + Math.min(referrers.length, 4) * 0.1,
      })
    }
    // 3. Stubs in the Fellow's domains, smallest first. A synthesis page is a question, not a
    // thin concept to deepen, so `wiki/questions/` stays out.
    const stubs = graph.nodes
      .filter((n) => n.kind === 'knowledge' && !n.path.startsWith('wiki/questions/') && n.domain !== null && domains.has(n.domain) && (n.size ?? Infinity) < STUB_BYTES)
      .sort((a, b) => (a.size ?? 0) - (b.size ?? 0))
      .slice(0, MAX_STUBS)
    for (const n of stubs) raw.push({ kind: 'stub', text: n.title, sourcePages: [n.path], weight: 1 })
  }

  // 4. Ingests into the Fellow's domains since its last run.
  const byPath = new Map<string, { domain: string | null; title: string }>()
  if (graph !== null) for (const n of graph.nodes) byPath.set(n.path, { domain: n.domain, title: n.title })
  let ingests = 0
  for (const job of input.jobs) {
    if (ingests >= MAX_INGESTS) break
    if (job.status !== 'done' || !job.finished_at) continue
    if (input.since !== null && job.finished_at < input.since) continue
    const pages = parseCreatedPages(job).filter((p) => {
      const node = byPath.get(p)
      return node !== undefined && node.domain !== null && domains.has(node.domain)
    })
    if (pages.length === 0) continue
    ingests++
    const first = byPath.get(pages[0]!)
    raw.push({
      kind: 'ingest',
      text: job.original_name ?? job.url ?? first?.title ?? pages[0]!,
      sourcePages: pages.slice(0, 4),
      weight: 2,
    })
  }

  return raw
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_CANDIDATES)
    .map((c, i) => ({ ...c, id: `C${i + 1}` }))
}
