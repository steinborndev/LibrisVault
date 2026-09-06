/**
 * The Fellow notebook page (docs/agents/SPEC.md section 5.4): `wiki/meta/agents/<slug>.md`,
 * `type: meta` so the vault's lint tiling and address rules leave it alone.
 *
 * Source-of-truth discipline: the service READS BACK only `Intent` and `Scope` (the user may
 * edit them in Obsidian); `Plan` and `Log` are rendered from SQLite on every write; `Open
 * Questions` and `Notes` are kept verbatim, because runs append to the former and the user
 * owns the latter. The page can therefore never become a second source of truth for state.
 *
 * Writing is one commit behind the shared commit mutex, the same discipline as a user edit
 * through `PUT /api/v1/pages` (hard rule 1).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AgentRecord } from '../db/agents.js'
import type { AgentRunRecord } from '../db/agent-runs.js'
import { commitPaths, type CommitResult } from './git.js'
import type { Mutex } from '../util/mutex.js'

export const NOTEBOOK_DIR = 'wiki/meta/agents'
export const notebookPath = (slug: string): string => `${NOTEBOOK_DIR}/${slug}.md`

const SECTION_ORDER = ['Intent', 'Scope', 'Plan', 'Log', 'Open Questions', 'Notes'] as const
type SectionName = (typeof SECTION_ORDER)[number]

export interface ParsedNotebook {
  readonly sections: ReadonlyMap<string, string>
}

/** Splits a notebook into its `## ` sections (frontmatter and the title are dropped). */
export function parseNotebook(markdown: string): ParsedNotebook {
  let body = markdown
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end >= 0) body = body.slice(end + 4)
  }
  const sections = new Map<string, string>()
  let current: string | null = null
  let buf: string[] = []
  const flush = (): void => {
    if (current !== null) sections.set(current, buf.join('\n').trim())
  }
  for (const line of body.split('\n')) {
    const m = /^## (.+?)\s*$/.exec(line)
    if (m) {
      flush()
      current = m[1]!.trim()
      buf = []
    } else if (current !== null) buf.push(line)
  }
  flush()
  return { sections }
}

/** What the user may have edited on the page: intent and scope, trimmed; empty = unchanged. */
export function readBackNotebook(markdown: string): { intent?: string; scope?: string } {
  const { sections } = parseNotebook(markdown)
  const intent = sections.get('Intent')?.trim()
  const scope = sections.get('Scope')?.trim()
  return {
    ...(intent ? { intent } : {}),
    ...(scope !== undefined && scope !== '' && scope !== '(none)' ? { scope } : {}),
  }
}

const day = (iso: string): string => iso.slice(0, 10)
const usd = (n: number | null): string => (n === null ? '-' : `${n.toFixed(2)} USD`)

/** One log line per run, oldest first; what the run was, what it cost, what it left. */
export function renderLogLines(runs: readonly AgentRunRecord[]): string[] {
  return [...runs]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((r) => {
      const outcome = r.ok ? (r.pages.length > 0 ? `${r.pages.length} page(s)` : 'no pages') : `failed: ${r.error ?? 'unknown'}`
      const topic = r.label ?? r.kind
      return `${day(r.startedAt)} · ${r.kind} · ${topic} · ${outcome} · ${usd(r.costUsd)}`
    })
}

export interface RenderNotebookInput {
  readonly agent: AgentRecord
  readonly runs: readonly AgentRunRecord[]
  /** The page as it is on disk, if it exists; its Intent, Scope, Open Questions and Notes survive. */
  readonly existing?: string
  /** What the next run will be, rendered under Plan; null = nothing planned. */
  readonly plan?: string | null
  readonly now?: string
}

export function renderNotebook(input: RenderNotebookInput): string {
  const { agent } = input
  const now = input.now ?? new Date().toISOString()
  const kept = input.existing ? parseNotebook(input.existing).sections : new Map<string, string>()
  const section = (name: SectionName, fallback: string): string => {
    const v = kept.get(name)
    if (v === undefined || v.trim() === '') return fallback
    // A placeholder line the service wrote earlier must not outlive the first real entry.
    const lines = v.trim().split('\n')
    const real = lines.filter((l) => l.trim() !== fallback.trim())
    return real.length > 0 ? real.join('\n').trim() : fallback
  }
  const log = renderLogLines(input.runs)
  const sections: Record<SectionName, string> = {
    Intent: section('Intent', agent.intent),
    Scope: section('Scope', agent.scope ?? '(none)'),
    Plan: input.plan ?? 'Nothing planned yet. The planner arrives with milestone A1; until then a step is started by hand from the card.',
    Log: log.length > 0 ? log.map((l) => `- ${l}`).join('\n') : '- (no runs yet)',
    'Open Questions': section('Open Questions', '- (none yet)'),
    Notes: section('Notes', '(yours)'),
  }
  const fm = [
    '---',
    'type: meta',
    `title: "Fellow: ${agent.name.replace(/"/g, "'")}"`,
    `status: ${agent.state === 'retired' ? 'retired' : 'active'}`,
    `created: ${day(agent.createdAt)}`,
    `updated: ${day(now)}`,
    'tags:',
    '  - meta',
    '  - agent',
    `agent_id: ${agent.id}`,
    `home_domain: ${agent.homeDomain}`,
    `model: ${agent.model}`,
    '---',
  ].join('\n')
  const body = SECTION_ORDER.map((name) => `## ${name}\n\n${sections[name]}\n`).join('\n')
  return `${fm}\n\n# Fellow: ${agent.name}\n\nA resident research Fellow of this library (docs/agents/SPEC.md). The Plan and Log sections are rendered by the service; Intent, Scope, Open Questions and Notes are yours and the Fellow's.\n\n${body}`
}

export interface NotebookWriterOptions {
  readonly vaultRoot: string
  /** The commit mutex shared with the queue, the runner and the pages route. */
  readonly commitMutex: Mutex
  /** Live gitAutoCommit setting; false leaves the page written but uncommitted. */
  readonly autoCommit?: () => boolean
  readonly commit?: (vaultRoot: string, message: string, paths: readonly string[]) => Promise<CommitResult>
}

export interface NotebookWriteResult {
  readonly path: string
  readonly commit: string | null
  /** Intent and scope read back from the page before it was rewritten (user edits). */
  readonly readBack: { intent?: string; scope?: string }
}

/** Renders and commits a Fellow's notebook. One commit per write, behind the commit mutex. */
export class NotebookWriter {
  private readonly vaultRoot: string
  private readonly commitMutex: Mutex
  private readonly autoCommit: () => boolean
  private readonly commit: (vaultRoot: string, message: string, paths: readonly string[]) => Promise<CommitResult>

  constructor(opts: NotebookWriterOptions) {
    this.vaultRoot = opts.vaultRoot
    this.commitMutex = opts.commitMutex
    this.autoCommit = opts.autoCommit ?? ((): boolean => true)
    this.commit = opts.commit ?? commitPaths
  }

  /** The page as it is on disk, or undefined when it does not exist yet. */
  read(agent: AgentRecord): string | undefined {
    try {
      return fs.readFileSync(path.join(this.vaultRoot, agent.notebookPath), 'utf8')
    } catch {
      return undefined
    }
  }

  async write(agent: AgentRecord, runs: readonly AgentRunRecord[], plan: string | null = null): Promise<NotebookWriteResult> {
    return this.commitMutex.runExclusive(async () => {
      const abs = path.join(this.vaultRoot, agent.notebookPath)
      const existing = this.read(agent)
      const readBack = existing ? readBackNotebook(existing) : {}
      const markdown = renderNotebook({ agent, runs, plan, ...(existing !== undefined ? { existing } : {}) })
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, markdown, 'utf8')
      const commit = this.autoCommit()
        ? await this.commit(this.vaultRoot, `fellow: notebook of ${agent.name}`, [agent.notebookPath])
        : undefined
      return { path: agent.notebookPath, commit: commit?.committed ? (commit.hash ?? null) : null, readBack }
    })
  }
}
