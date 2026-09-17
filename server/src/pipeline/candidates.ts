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
 *
 * Because all five sources read the vault, a Fellow whose task is to WATCH for what is new
 * had nothing on its menu that meant "go and look again". After its first run the only
 * candidates it could ever be offered were the open questions that run had written itself,
 * and a research run's open questions are mostly about verifying and reaching what it just
 * found. Measured on this vault (2026-09-08): a Fellow asked to find quick recipes spent six
 * of eight runs auditing time claims on its own first three sources, and every one of its
 * proposals named an open question from its own notebook as its origin. Two things below
 * answer that - the standing sweep (source 6) and the loop brake - and neither of them
 * fetches anything or widens what the planner may read.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AgentRecord, AgentTask } from '../db/agents.js'
import type { AgentRunRecord } from '../db/agent-runs.js'
import type { JobRow } from '../db/jobs.js'
import type { VaultGraph } from './graph.js'
import { parseNotebook } from './notebook.js'

export type CandidateKind = 'open-question' | 'gap' | 'stub' | 'ingest' | 'handoff' | 'note' | 'reading' | 'sweep'

/** How a recap's free-text answer is filed under the notebook's Notes (docs/tasks/TASKS-A2.md D6). */
export const RECAP_NOTE_PREFIX = 'Recap note'

/**
 * Bullets under `## Notes` that a recap answer left (`- Recap note <date>: text`). The user's
 * own notes stay theirs: only lines with the prefix become candidates.
 */
export function parseRecapNotes(markdown: string): string[] {
  const notes = parseNotebook(markdown).sections.get('Notes')
  if (!notes) return []
  const out: string[] = []
  const re = new RegExp(`^\\s*[-*]\\s+${RECAP_NOTE_PREFIX}\\s+\\d{4}-\\d{2}-\\d{2}:\\s*(.+)$`)
  for (const line of notes.split('\n')) {
    const m = re.exec(line)
    if (m && m[1]!.trim() !== '') out.push(m[1]!.trim())
  }
  return out
}

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
  /** For kind `handoff`: the handoff row, so a proposal built from it can mark it (A3). */
  readonly handoffId?: string
}

/** What a pending handoff to the Fellow looks like to the candidate computation (A3). */
export interface HandoffCandidate {
  readonly id: string
  readonly question: string
  readonly sourcePage: string | null
  readonly fromName: string
}

/** A page under this many bytes is a stub (kept in step with `STUB_BYTES` in web/src/lib/domains.ts). */
export const STUB_BYTES = 1024
/** How many candidates reach the planner at most. */
export const MAX_CANDIDATES = 20
const MAX_QUESTIONS = 10
const MAX_NOTES = 3
const MAX_HANDOFFS = 5
const MAX_GAPS = 8
const MAX_STUBS = 5
const MAX_INGESTS = 5

/**
 * The standing sweep's weight: above the Fellow's own open questions, below a recap note (the
 * user's direct steer) and below a publication that has arrived. Looking for new material is
 * the default of standing work, not an emergency - the planner still chooses.
 */
export const SWEEP_WEIGHT = 3.2

/**
 * How many runs in a row may come from the Fellow's own open questions before the brake
 * bites. Three is one full cycle of the largest task list, so a Fellow that alternates
 * between following up and looking outward never trips it.
 */
export const SELF_LOOP_LIMIT = 3

/**
 * What a self-authored open question is worth once the brake is on: below every other kind,
 * so a sweep, a gap, a stub or an ingest ranks above it. Not zero and not dropped - a
 * question can still be the best thing to do, and the planner is the one that judges. This
 * only stops ten of them from filling the top of the list for a fourth night.
 */
export const LOOPED_QUESTION_WEIGHT = 0.5

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
  /** Pending handoffs routed to this Fellow (section 6.6). */
  readonly handoffs?: readonly HandoffCandidate[]
  /**
   * Tonight's task, when one is up. A `watch` task gets the standing sweep below; the others
   * do not, because they already have a candidate source that fits them (an explore task has
   * its open questions, a deepen task its ranked pages).
   */
  readonly task?: AgentTask
  /**
   * How many of the Fellow's most recent runs in a row came from an open question it wrote
   * itself (see {@link ownQuestionStreak}). At or above {@link SELF_LOOP_LIMIT} the brake
   * comes on.
   */
  readonly selfLoop?: number
  /**
   * Publications this Fellow put on the reading list that have since arrived in the vault
   * (section 10.6). They are the strongest candidate there is: the Fellow asked for the
   * document, said why, and now it is here - which is a step to take, not a search to repeat.
   */
  readonly readingFiled?: ReadonlyArray<{ readonly title: string; readonly page: string; readonly why: string | null; readonly filedAt: string | null }>
}

/**
 * How many of the newest runs in a row came from an open question the Fellow wrote itself.
 *
 * EVERY open-question candidate is self-authored: `computeCandidates` reads them from the
 * Fellow's own notebook and its own synthesis pages, and from nowhere else. The first draft
 * of this counted only the notebook, on the theory that a question on a synthesis page is a
 * finding rather than the Fellow talking to itself - the live pool disproved it on sight
 * (2026-09-08): the same audit questions sat on both, written by the same runs on the same
 * night. Any other kind breaks the streak, because that work came from outside the Fellow's
 * own last run.
 */
export function ownQuestionStreak(executed: readonly { readonly candidate: string }[]): number {
  let n = 0
  for (const p of executed) {
    if (p.candidate !== 'open-question') break
    n++
  }
  return n
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
  // The user's recap notes come first: they are the most direct steer the planner gets.
  const notebook = readPage(vaultRoot, agent.notebookPath)
  for (const note of notebook === undefined ? [] : parseRecapNotes(notebook).slice(-MAX_NOTES)) {
    raw.push({ kind: 'note', text: note, sourcePages: [agent.notebookPath], weight: 3.5 })
  }
  /*
   * 6. The standing sweep: the watch task itself, always on the menu.
   *
   * Every other candidate is something the vault already wrote down, so without this a watch
   * Fellow can only follow up its own findings - the failure mode in this file's header. The
   * text is the task, and its source page is the notebook, where the task is recorded under
   * `## Intent`; nothing here is fetched.
   */
  if (input.task?.kind === 'watch') {
    raw.push({ kind: 'sweep', text: input.task.text, sourcePages: [agent.notebookPath], weight: SWEEP_WEIGHT })
  }

  /*
   * The loop brake. The questions keep their place in the list but lose their precedence once
   * the Fellow has followed nothing else for SELF_LOOP_LIMIT runs, so whatever else it has -
   * a sweep, a gap, a stub, an ingest - is read first. All of them, notebook and synthesis
   * page alike: both are this Fellow's own writing, see `ownQuestionStreak`.
   */
  const looping = (input.selfLoop ?? 0) >= SELF_LOOP_LIMIT
  raw.push(...(looping ? questions.map((q) => ({ ...q, weight: LOOPED_QUESTION_WEIGHT })) : questions))

  // 5. Handoffs from other Fellows (section 6.6): another Fellow's question in this domain.
  for (const h of (input.handoffs ?? []).slice(0, MAX_HANDOFFS)) {
    raw.push({ kind: 'handoff', text: `${h.question} (handed off by ${h.fromName})`, sourcePages: h.sourcePage ? [h.sourcePage] : [], weight: 2.5, handoffId: h.id })
  }

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

  // 4. Publications the Fellow asked for that are now in the vault (section 10.6).
  for (const r of input.readingFiled ?? []) {
    if (input.since !== null && r.filedAt !== null && r.filedAt < input.since.slice(0, 10)) continue
    raw.push({
      kind: 'reading',
      text: `"${r.title}" is in the vault now, as ${r.page}${r.why ? ` - you asked for it: ${r.why}` : ''}`,
      sourcePages: [r.page],
      // Above every other candidate: the question was already written down, the document is
      // here, and reading it is cheaper and more certain than another search round.
      weight: 4.5,
    })
  }

  // 5. Ingests into the Fellow's domains since its last run.
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
