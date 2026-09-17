/**
 * The pinboard of open questions (docs/agents/SPEC.md 10.13, prototype 2026-09-17): every
 * bullet under a `## Open questions` heading on every wiki page, grouped by the page's
 * domain, with what the Fellows make of each - planned for tonight, being researched now.
 *
 * The archive is the vault's own convention: a struck-through bullet (`~~…~~`), which the
 * planner's candidate parser already skips and the runs use themselves to close a question
 * without deleting the line. Archiving therefore edits the page the question stands in - a
 * user-initiated page edit, one commit behind the shared mutex under the vault's per-file
 * lock (hard rule 1) - and vetoes the proposal a Fellow had planned from it, because a closed
 * question is not to be researched. Restoring takes the strike off again.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { VaultGraph } from './graph.js'
import type { Mutex } from '../util/mutex.js'
import { withWikiLock } from './wiki-lock.js'
import { commitPaths, type CommitResult } from './git.js'
import { parseNotebook } from './notebook.js'
import type { ProposalRecord } from '../db/proposals.js'

export interface QuestionEntry {
  /** The page and the question's key: what the board addresses a row by. */
  readonly id: string
  readonly text: string
  readonly page: string
  readonly domain: string | null
  readonly archived: boolean
  /** A pending proposal that names this question: whose, and how far it got. */
  readonly planned: { readonly proposalId: string; readonly agentId: string; readonly fellow: string; readonly status: string } | null
  /** A research run in flight whose topic is this question. */
  readonly researching: { readonly runId: string } | null
}

/** One bullet as it stands in the page: the text without its strike, and whether it has one. */
export interface QuestionBullet {
  readonly text: string
  readonly archived: boolean
}

/** Normalises a question for matching: case, whitespace and trailing punctuation (as the planner does). */
export const questionKey = (q: string): string => q.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.?!]+$/g, '').trim()

const STRUCK = /^~~([\s\S]*?)~~$/

/**
 * Every bullet under the page's `## Open questions` section, struck ones included and marked.
 * The same reading the planner's `parseOpenQuestions` does - wrapped bullets, placeholders and
 * answered ones skipped - except that a struck bullet is kept here, as an archived question.
 */
export function parseQuestionBullets(markdown: string): QuestionBullet[] {
  const { sections } = parseNotebook(markdown)
  let body: string | undefined
  for (const [name, text] of sections) if (name.toLowerCase() === 'open questions') body = text
  if (!body) return []
  const out: QuestionBullet[] = []
  let current: string | null = null
  const flush = (): void => {
    if (current !== null) {
      const q = current.replace(/\s+/g, ' ').trim()
      if (q !== '' && !/^\(none/i.test(q) && !/\(answered\b/i.test(q)) {
        const m = STRUCK.exec(q)
        out.push(m ? { text: m[1]!.trim(), archived: true } : { text: q, archived: false })
      }
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

/**
 * The page with one question struck through, or its strike taken off; null when the question
 * is not on the page or already stands that way. Only the bullet's own lines change: the
 * strike opens on the bullet's first line and closes on its last, so a wrapped question is
 * still one struck question to the parser above and to the planner's.
 */
export function strikeQuestion(markdown: string, text: string, archived: boolean): string | null {
  const lines = markdown.split('\n')
  const wanted = questionKey(text)
  let inSection = false
  let start = -1
  let end = -1
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading) {
      if (inSection && start >= 0) break
      inSection = heading[1]!.trim().toLowerCase() === 'open questions'
      continue
    }
    if (!inSection) continue
    const bullet = /^\s*[-*]\s+/.test(line)
    const continuation = start >= 0 && !bullet && /^\s+\S/.test(line)
    if (start >= 0 && !continuation) {
      // The bullet under the cursor ended a line ago; test it.
      const joined = lines
        .slice(start, end + 1)
        .map((l, i) => (i === 0 ? l.replace(/^\s*[-*]\s+/, '') : l.trim()))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      const m = STRUCK.exec(joined)
      const key = questionKey(m ? m[1]! : joined)
      if (key === wanted) break
      start = -1
      end = -1
    }
    if (bullet) {
      start = k
      end = k
    } else if (continuation) end = k
  }
  if (start >= 0 && end >= start) {
    const joined = lines
      .slice(start, end + 1)
      .map((l, i) => (i === 0 ? l.replace(/^\s*[-*]\s+/, '') : l.trim()))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    const m = STRUCK.exec(joined)
    if (questionKey(m ? m[1]! : joined) !== wanted) return null
    const struck = m !== null
    if (struck === archived) return null
    const first = lines[start]!
    const last = lines[end]!
    const lead = /^(\s*[-*]\s+)([\s\S]*)$/.exec(first)!
    if (archived) {
      lines[start] = `${lead[1]}~~${lead[2]}`
      lines[end] = start === end ? `${lines[start]}~~` : `${last.replace(/\s+$/, '')}~~`
    } else {
      lines[start] = `${lead[1]}${lead[2]!.replace(/^~~/, '')}`
      lines[end] = (start === end ? lines[start]! : last).replace(/~~\s*$/, '')
    }
    return lines.join('\n')
  }
  return null
}

export interface QuestionsOptions {
  readonly vaultRoot: string
  readonly graph: () => VaultGraph | null
  /** The Fellows' notebooks, which the graph does not file under a domain: each with its Fellow's home domain. */
  readonly notebooks?: () => ReadonlyArray<{ readonly path: string; readonly domain: string }>
  /** The proposals still pending, whose provenance names the question they came from. */
  readonly proposals?: () => readonly ProposalRecord[]
  readonly fellowName?: (agentId: string) => string
  /** The runs in flight: a research run's label is its topic. */
  readonly runs?: () => ReadonlyArray<{ readonly id: string; readonly kind: string; readonly status: string; readonly label?: string | null }>
  readonly commitMutex?: Mutex
  readonly commit?: (root: string, message: string, paths: readonly string[]) => Promise<CommitResult>
  readonly autoCommit?: () => boolean
  /** Vetoes one pending proposal; wired to the Fellow service's decision path. */
  readonly veto?: (proposalId: string) => Promise<void>
}

export class QuestionsService {
  constructor(private readonly o: QuestionsOptions) {}

  /** Every question on every page, with what the Fellows make of it. Read fresh each time; the pages are the truth. */
  list(): QuestionEntry[] {
    const graph = this.o.graph()
    const pages: Array<{ path: string; domain: string | null }> = []
    const seen = new Set<string>()
    for (const n of graph?.nodes ?? []) {
      if (n.kind !== 'knowledge' || seen.has(n.path)) continue
      seen.add(n.path)
      pages.push({ path: n.path, domain: n.domain })
    }
    for (const nb of this.o.notebooks?.() ?? []) {
      if (seen.has(nb.path)) continue
      seen.add(nb.path)
      pages.push({ path: nb.path, domain: nb.domain })
    }
    const planned = new Map<string, QuestionEntry['planned']>()
    for (const p of this.o.proposals?.() ?? []) {
      const key = questionKey(p.provenance.text)
      if (key === '' || planned.has(key)) continue
      planned.set(key, { proposalId: p.id, agentId: p.agentId, fellow: this.o.fellowName?.(p.agentId) ?? 'a Fellow', status: p.status })
    }
    const researching = new Map<string, { runId: string }>()
    for (const r of this.o.runs?.() ?? []) {
      if (r.status !== 'running' || r.kind !== 'research' || !r.label) continue
      researching.set(questionKey(r.label), { runId: r.id })
    }
    const out: QuestionEntry[] = []
    for (const page of pages) {
      let markdown: string
      try {
        markdown = fs.readFileSync(path.join(this.o.vaultRoot, page.path), 'utf8')
      } catch {
        continue
      }
      for (const b of parseQuestionBullets(markdown)) {
        const key = questionKey(b.text)
        out.push({
          id: `${page.path}#${key}`,
          text: b.text,
          page: page.path,
          domain: page.domain,
          archived: b.archived,
          planned: planned.get(key) ?? null,
          researching: researching.get(key) ?? null,
        })
      }
    }
    return out
  }

  /**
   * Strikes one question through on its page, or takes the strike off again, and vetoes the
   * proposal a Fellow had planned from it. Returns what happened; `changed` is false when the
   * question is not on the page or already stands that way.
   */
  async setArchived(page: string, text: string, archived: boolean): Promise<{ changed: boolean; vetoed: string[] }> {
    if (page.includes('..') || !page.startsWith('wiki/') || !page.endsWith('.md')) return { changed: false, vetoed: [] }
    const file = path.join(this.o.vaultRoot, page)
    let markdown: string
    try {
      markdown = fs.readFileSync(file, 'utf8')
    } catch {
      return { changed: false, vetoed: [] }
    }
    const next = strikeQuestion(markdown, text, archived)
    if (next === null) return { changed: false, vetoed: [] }
    const write = async (): Promise<void> => {
      fs.writeFileSync(file, next, 'utf8')
      if (this.o.commitMutex !== undefined && (this.o.autoCommit?.() ?? true)) {
        const commit = this.o.commit ?? commitPaths
        await commit(this.o.vaultRoot, `questions: ${archived ? 'archived' : 'restored'} one on ${path.basename(page, '.md')}`, [page])
      }
    }
    if (this.o.commitMutex === undefined) await write()
    else await withWikiLock(this.o.vaultRoot, page, async () => this.o.commitMutex!.runExclusive(write))
    const vetoed: string[] = []
    if (archived && this.o.veto) {
      const key = questionKey(text)
      for (const p of this.o.proposals?.() ?? []) {
        if (questionKey(p.provenance.text) !== key) continue
        await this.o.veto(p.id)
        vetoed.push(p.id)
      }
    }
    return { changed: true, vetoed }
  }
}
