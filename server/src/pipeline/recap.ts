/**
 * The daily recap (docs/agents/SPEC.md section 9, docs/tasks/TASKS-A2.md): once a morning,
 * one text for three channels. The skeleton is deterministic from SQLite and the run log;
 * the three "what it found" lines per Fellow come from one schema-bound run on the default
 * model; the page is written by the service (one commit), never by an agent; Telegram gets
 * the same text in plain form; the dashboard reads the stored model.
 *
 * Proposals are coded (`1a`, `1b`, `2a`) against the recap's own Fellow order and the
 * mapping is stored with the model, so an answer resolves against what the user read.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AgentRecord, AgentModel, AgentStep } from '../db/agents.js'
import { AGENT_MODELS, AGENT_STEPS } from '../db/agents.js'
import type { AgentRunRecord, AgentRunStore } from '../db/agent-runs.js'
import type { RecapRow, RecapStore } from '../db/recaps.js'
import type { ShiftRecord, ShiftStore } from '../db/shifts.js'
import type { JobStore } from '../db/jobs.js'
import type { MaintenanceRun, MaintenanceRunner } from './maintenance.js'
import type { FellowService } from './fellows.js'
import type { DecisionChannel, ProposalRecord } from '../db/proposals.js'
import { commitPaths, commitFileStatus, type CommitResult } from './git.js'
import type { Mutex } from '../util/mutex.js'
import { parseOpenQuestions, knowledgePages } from './candidates.js'
import { isDrift } from './planner.js'
import { startOfToday } from './budget.js'
import { addDays, atLocalTime, localDate, windowAt, type NightWindow } from './clock.js'

export const RECAP_DIR = 'wiki/meta/recaps'
/**
 * `Recap <date>.md`, not `<date>.md`: the vault's own `.gitignore` ignores every file named
 * like a bare date (`????-??-??.md`, its daily-note rule), and hard rule 5 leaves that file
 * alone. Found on the first real recap (docs/tasks/TASKS-A2.md F1).
 */
export const recapPath = (cycleDate: string): string => `${RECAP_DIR}/Recap ${cycleDate}.md`

/* ------------------------------------ the model ------------------------------------ */

export interface RecapRun {
  readonly runId: string
  readonly kind: string
  readonly topic: string
  readonly ok: boolean
  readonly error: string | null
  readonly pagesCreated: readonly string[]
  readonly pagesUpdated: readonly string[]
  readonly commit: string | null
  readonly costUsd: number | null
  readonly startedAt: string
  readonly proposalId: string | null
}

export interface RecapProposal {
  /** `1a`, `1b`, ... */
  readonly code: string
  readonly proposalId: string
  readonly kind: string
  readonly topic: string
  readonly rationale: string
  readonly provenance: { readonly candidate: string; readonly text: string; readonly sourcePages: readonly string[] }
  readonly estCostUsd: number | null
  readonly scopeScore: number
  readonly drift: boolean
  readonly status: string
  readonly rank: number
}

export interface RecapFellow {
  /** 1-based position in the recap; the number in every code. */
  readonly index: number
  readonly agentId: string
  readonly name: string
  readonly homeDomain: string
  readonly model: string
  readonly autonomy: string
  readonly state: string
  readonly sleepCode: string | null
  readonly sleepReason: string | null
  readonly skipUntil: string | null
  readonly notebookPath: string
  readonly runs: readonly RecapRun[]
  /** Three lines from the recap run; empty when it did not run or failed. */
  readonly found: readonly string[]
  readonly openQuestions: readonly string[]
  readonly proposals: readonly RecapProposal[]
  readonly value: { readonly pageOpens: number; readonly recapLinks: number }
}

export interface RecapModel {
  readonly cycleDate: string
  readonly generatedAt: string
  readonly quiet: boolean
  readonly since: string
  readonly window: NightWindow
  readonly shift: {
    readonly trigger: string
    readonly startedAt: string
    readonly finishedAt: string | null
    readonly executed: number
    readonly planned: number
    readonly skipped: readonly { readonly agentName: string; readonly reason: string }[]
    readonly costUsd: number
  } | null
  readonly totals: { readonly runs: number; readonly failed: number; readonly costUsd: number; readonly pages: number }
  /** Service-wide consumption, manual runs and ingests included (section 8.2). */
  readonly usage: { readonly today: { readonly costUsd: number; readonly runs: number }; readonly week: { readonly costUsd: number; readonly runs: number } }
  readonly value: { readonly pageOpens: number; readonly recapLinks: number }
  readonly fellows: readonly RecapFellow[]
  /** Fellows without a run tonight, with their reasons (the quiet-day line reads it). */
  readonly sleeping: readonly { readonly name: string; readonly reason: string }[]
  /** Why the "what it found" lines are missing, when they are. */
  readonly summaryNote: string | null
  readonly summaryCostUsd: number | null
}

const LETTERS = 'abcdefghij'
export const codeFor = (index: number, rank: number): string => `${index}${LETTERS[rank - 1] ?? `x${rank}`}`

const isResearchKind = (kind: string): boolean => kind === 'research' || kind === 'research-step'

export interface BuildModelInput {
  readonly cycleDate: string
  readonly now: Date
  readonly since: string
  readonly window: NightWindow
  readonly fellows: readonly AgentRecord[]
  readonly runsOf: (agentId: string) => readonly AgentRunRecord[]
  readonly pendingOf: (agentId: string) => readonly ProposalRecord[]
  readonly shift: ShiftRecord | null
  readonly usage: (sinceIso: string) => { readonly costUsd: number; readonly runs: number }
  readonly valueOf: (agentId?: string) => { readonly pageOpens: number; readonly recapLinks: number }
  readonly readPage: (rel: string) => string | undefined
  /** Created versus updated pages of a commit; undefined = unknown (every page counts as updated). */
  readonly commitStatus: (hash: string) => ReadonlyMap<string, 'A' | 'M' | 'D'> | undefined
}

/** The deterministic skeleton (section 9.2). Pure: the tests build it from fixtures. */
export function buildRecapModel(input: BuildModelInput): RecapModel {
  const fellows: RecapFellow[] = []
  const sleeping: { name: string; reason: string }[] = []
  let index = 0
  for (const agent of input.fellows) {
    if (agent.state === 'retired') continue
    index++
    const runs = input.runsOf(agent.id)
      .filter((r) => isResearchKind(r.kind) && r.startedAt >= input.since)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((r): RecapRun => {
        const status = r.commitHash ? input.commitStatus(r.commitHash) : undefined
        const knowledge = knowledgePages(r.pages)
        const synth = r.pages.filter((p) => p.startsWith('wiki/questions/'))
        const shown = [...synth, ...knowledge]
        const created = status ? shown.filter((p) => status.get(p) === 'A') : []
        const updated = status ? shown.filter((p) => status.get(p) !== 'A' && status.get(p) !== 'D') : shown
        return {
          runId: r.id,
          kind: r.kind,
          topic: r.label ?? r.kind,
          ok: r.ok,
          error: r.error,
          pagesCreated: created,
          pagesUpdated: updated,
          commit: r.commitHash,
          costUsd: r.costUsd,
          startedAt: r.startedAt,
          proposalId: r.proposalId ?? null,
        }
      })
    const notebook = input.readPage(agent.notebookPath)
    const openQuestions = notebook ? parseOpenQuestions(notebook).slice(0, 5) : []
    const proposals = input
      .pendingOf(agent.id)
      .slice()
      .sort((a, b) => (a.status === 'approved' ? 0 : 1) - (b.status === 'approved' ? 0 : 1) || a.rank - b.rank)
      .map((p, i): RecapProposal => ({
        code: codeFor(index, i + 1),
        proposalId: p.id,
        kind: p.kind,
        topic: p.topic,
        rationale: p.rationale,
        provenance: p.provenance,
        estCostUsd: p.estCostUsd,
        scopeScore: p.scopeScore,
        drift: isDrift(p.scopeScore),
        status: p.status,
        rank: p.rank,
      }))
    if (runs.length === 0 && agent.state !== 'active') {
      sleeping.push({ name: agent.name, reason: agent.state === 'sleeping' ? (agent.sleepReason ?? agent.sleepCode ?? 'sleeping') : agent.state })
    }
    fellows.push({
      index,
      agentId: agent.id,
      name: agent.name,
      homeDomain: agent.homeDomain,
      model: agent.model,
      autonomy: agent.autonomy,
      state: agent.state,
      sleepCode: agent.sleepCode,
      sleepReason: agent.sleepReason,
      skipUntil: agent.skipUntil,
      notebookPath: agent.notebookPath,
      runs,
      found: [],
      openQuestions,
      proposals,
      value: input.valueOf(agent.id),
    })
  }
  const allRuns = fellows.flatMap((f) => f.runs)
  const newProposals = fellows.some((f) => f.proposals.some((p) => p.status === 'proposed' && input.pendingOf(f.agentId).some((q) => q.id === p.proposalId && q.createdAt >= input.since)))
  const quiet = allRuns.length === 0 && !newProposals
  const shift = input.shift
  const dayStart = startOfToday(input.now).toISOString()
  const weekStart = new Date(input.now.getTime() - 7 * 24 * 3600_000).toISOString()
  return {
    cycleDate: input.cycleDate,
    generatedAt: input.now.toISOString(),
    quiet,
    since: input.since,
    window: input.window,
    shift: shift
      ? {
          trigger: shift.trigger,
          startedAt: shift.startedAt,
          finishedAt: shift.finishedAt,
          executed: shift.summary.executed.length,
          planned: shift.summary.planned.length,
          skipped: shift.summary.skipped.map((s) => ({ agentName: s.agentName, reason: s.reason })),
          costUsd: shift.summary.costUsd,
        }
      : null,
    totals: {
      runs: allRuns.length,
      failed: allRuns.filter((r) => !r.ok).length,
      costUsd: Math.round(allRuns.reduce((a, r) => a + (r.costUsd ?? 0), 0) * 100) / 100,
      pages: allRuns.reduce((a, r) => a + r.pagesCreated.length + r.pagesUpdated.length, 0),
    },
    usage: { today: input.usage(dayStart), week: input.usage(weekStart) },
    value: input.valueOf(),
    fellows,
    sleeping,
    summaryNote: null,
    summaryCostUsd: null,
  }
}

/* --------------------------------- the summary run --------------------------------- */

const summarySchema = z.object({
  fellows: z.array(z.object({ agentId: z.string(), lines: z.array(z.string()) })),
})

export function summarySchemaJson(agentIds: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      fellows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            agentId: { type: 'string', enum: [...agentIds] },
            lines: { type: 'array', items: { type: 'string' } },
          },
          required: ['agentId', 'lines'],
          additionalProperties: false,
        },
      },
    },
    required: ['fellows'],
    additionalProperties: false,
  }
}

/** The Fellows whose night produced something to summarise: at least one successful run with text. */
export function summaryInput(model: RecapModel, runsOf: (agentId: string) => readonly AgentRunRecord[]): Array<{ agentId: string; name: string; intent: string; runs: Array<{ topic: string; answer: string }> }> {
  const out: Array<{ agentId: string; name: string; intent: string; runs: Array<{ topic: string; answer: string }> }> = []
  for (const f of model.fellows) {
    const okRuns = f.runs.filter((r) => r.ok)
    if (okRuns.length === 0) continue
    const byId = new Map(runsOf(f.agentId).map((r) => [r.id, r]))
    const runs = okRuns
      .map((r) => ({ topic: r.topic, answer: (byId.get(r.runId)?.answer ?? '').trim() }))
      .filter((r) => r.answer !== '')
    if (runs.length === 0) continue
    out.push({ agentId: f.agentId, name: f.name, intent: '', runs })
  }
  return out
}

export function renderSummaryPrompt(input: ReadonlyArray<{ agentId: string; name: string; runs: ReadonlyArray<{ topic: string; answer: string }> }>): string {
  const blocks = input
    .map(
      (f) =>
        `Fellow ${f.name} (agentId ${f.agentId}):\n` +
        f.runs.map((r, i) => `Run ${i + 1}, topic: ${r.topic}\nResult text:\n${r.answer.slice(0, 5000)}`).join('\n\n'),
    )
    .join('\n\n---\n\n')
  return (
    'You are writing the "what it found" part of a morning recap for the user of this library. ' +
    'Below are the research runs the resident Fellows finished tonight, with the text each run ended with. ' +
    'For every Fellow write exactly three short lines (one sentence each, plain English, no markdown, no wikilinks) ' +
    'that tell the user what the runs found: the most useful finding first, then what it means for the ' +
    "Fellow's question, then what stays open. Use only the result texts below; do not read or search anything else, " +
    'and do not invent findings the text does not carry. Answer in the required structured format with the agentId ' +
    'exactly as given.\n\n' +
    blocks
  )
}

export function parseSummary(raw: unknown): Map<string, string[]> | undefined {
  const parsed = summarySchema.safeParse(raw)
  if (!parsed.success) return undefined
  const out = new Map<string, string[]>()
  for (const f of parsed.data.fellows) {
    const lines = f.lines.map((l) => l.trim()).filter((l) => l !== '').slice(0, 3)
    if (lines.length > 0) out.set(f.agentId, lines)
  }
  return out
}

/* ----------------------------------- rendering ----------------------------------- */

const usd = (n: number | null | undefined): string => (n === null || n === undefined ? '-' : `${n.toFixed(2)} USD`)
const title = (p: string): string => path.posix.basename(p).replace(/\.md$/i, '')
const wikilink = (p: string): string => `[[${title(p)}]]`

/** The vault page (section 9.3): `type: meta`, rendering only. */
export function renderRecapPage(model: RecapModel): string {
  const fm = [
    '---',
    'type: meta',
    `title: "Recap: ${model.cycleDate}"`,
    `created: ${model.cycleDate}`,
    `updated: ${localDate(new Date(model.generatedAt))}`,
    'tags:',
    '  - meta',
    '  - recap',
    `cycle: ${model.cycleDate}`,
    '---',
  ].join('\n')
  const lines: string[] = [fm, '', `# Recap: ${model.cycleDate}`, '', renderHeader(model, 'page'), '']
  for (const f of model.fellows) lines.push(renderFellow(model, f, 'page'), '')
  lines.push(
    'Answer in the dashboard (Home, Recap), or on Telegram with the codes: `1b` runs that proposal tonight, ' +
      '`veto 1b` drops it, `skip 1` skips tonight, `pause 1` pauses the Fellow, `note 1: ...` leaves it a note. ' +
      'This page is rendered by the service; edits here are not read back.',
  )
  return lines.join('\n') + '\n'
}

/** The Telegram messages (section 9.3): plain text, one for the header, one per Fellow. */
export function renderRecapMessages(model: RecapModel): string[] {
  if (model.quiet) return [renderQuietLine(model)]
  const out = [renderHeader(model, 'text')]
  for (const f of model.fellows) out.push(renderFellow(model, f, 'text'))
  out.push('Answer with codes: 1b runs it tonight, veto 1b drops it, skip 1 skips tonight, pause 1, resume 1, note 1: your text, model 1 opus-5, step 1 small.')
  return out.map((m) => (m.length > 4000 ? `${m.slice(0, 3998)}\n…` : m))
}

/** The one-liner of a quiet day (NEW-2). */
export function renderQuietLine(model: RecapModel): string {
  const n = model.fellows.length
  const reasons = model.sleeping.map((s) => `${s.name}: ${s.reason}`).join('; ')
  return `Recap ${model.cycleDate}: nothing ran tonight. ${n} Fellow${n === 1 ? '' : 's'}${reasons ? ` sleeping (${reasons})` : ''}.`
}

function renderHeader(model: RecapModel, mode: 'page' | 'text'): string {
  const b = (s: string): string => (mode === 'page' ? `**${s}**` : s)
  const lines: string[] = []
  lines.push(
    `${b('Night')} ${model.window.start} to ${model.window.end}` +
      (model.shift ? ` (${model.shift.trigger} shift, ${model.shift.executed} run(s), ${model.shift.planned} plan(s), ${usd(model.shift.costUsd)})` : ' (no shift ran)') +
      '.',
  )
  lines.push(
    `${b('Fellow runs since the last recap')}: ${model.totals.runs}` +
      (model.totals.failed > 0 ? `, ${model.totals.failed} failed` : '') +
      `, ${model.totals.pages} page(s), ${usd(model.totals.costUsd)}.`,
  )
  lines.push(
    `${b('Consumption')} (everything, manual runs and ingests included): today ${usd(model.usage.today.costUsd)} in ${model.usage.today.runs} run(s), this week ${usd(model.usage.week.costUsd)} in ${model.usage.week.runs} run(s).`,
  )
  if (model.shift && model.shift.skipped.length > 0) {
    lines.push(`${b('Skipped')}: ${model.shift.skipped.map((s) => `${s.agentName} (${s.reason})`).join('; ')}.`)
  }
  if (model.sleeping.length > 0 && model.totals.runs > 0) {
    lines.push(`${b('Sleeping')}: ${model.sleeping.map((s) => `${s.name}: ${s.reason}`).join('; ')}.`)
  }
  lines.push(`${b('Value this month')}: ${model.value.pageOpens} page open(s), ${model.value.recapLinks} recap link(s) followed.`)
  if (model.summaryNote) lines.push(`${b('Note')}: ${model.summaryNote}`)
  return lines.join('\n')
}

function renderFellow(model: RecapModel, f: RecapFellow, mode: 'page' | 'text'): string {
  const b = (s: string): string => (mode === 'page' ? `**${s}**` : s)
  const link = (p: string): string => (mode === 'page' ? wikilink(p) : title(p))
  const lines: string[] = []
  const stateLine = f.state === 'sleeping' ? `sleeping: ${f.sleepReason ?? f.sleepCode ?? ''}` : f.state
  lines.push(mode === 'page' ? `## ${f.index}. ${f.name} (${f.homeDomain}, ${f.model}, ${stateLine})` : `${f.index}. ${f.name} (${f.homeDomain}, ${f.model}, ${stateLine})`)
  lines.push('')
  if (f.runs.length === 0) lines.push(`${b('Ran')}: nothing since the last recap.`)
  for (const r of f.runs) {
    const outcome = r.ok ? `${r.pagesCreated.length + r.pagesUpdated.length} page(s), ${usd(r.costUsd)}${r.commit ? `, commit ${r.commit.slice(0, 8)}` : ''}` : `failed: ${r.error ?? 'unknown'}`
    lines.push(`${b('Ran')}: ${r.kind} "${r.topic}" · ${outcome}`)
    if (r.pagesCreated.length > 0) lines.push(`  Created: ${r.pagesCreated.map(link).join(', ')}`)
    if (r.pagesUpdated.length > 0) lines.push(`  Updated: ${r.pagesUpdated.map(link).join(', ')}`)
  }
  if (f.found.length > 0) {
    lines.push(`${b('Found')}:`)
    for (const l of f.found) lines.push(`- ${l}`)
  }
  if (f.openQuestions.length > 0) {
    lines.push(`${b('Open questions')}:`)
    for (const q of f.openQuestions) lines.push(`- ${q}`)
  }
  if (f.proposals.length > 0) {
    const mode_ = f.autonomy === 'manual' ? 'manual: runs only what you approve' : f.autonomy === 'auto' ? 'auto: the top one runs in the same night it is planned' : 'veto: the top undecided one runs tonight unless vetoed'
    lines.push(`${b('Proposals for tonight')} (${mode_}${f.skipUntil ? `; skipped tonight ${f.skipUntil}` : ''}):`)
    for (const p of f.proposals) {
      const flags = [p.status === 'approved' ? 'approved' : null, p.drift ? 'drift, runs only if approved' : null].filter(Boolean).join(', ')
      lines.push(`- ${b(p.code)} ${p.kind} · ${p.topic} · about ${usd(p.estCostUsd)}${flags ? ` · ${flags}` : ''}`)
      if (p.rationale) lines.push(`  Why: ${p.rationale}`)
      lines.push(`  From: ${p.provenance.candidate}: ${p.provenance.text}`)
    }
    lines.push(`- \`skip ${f.index}\` skip tonight · \`pause ${f.index}\` pause · \`note ${f.index}: ...\` a note for the planner`.replace(/`/g, mode === 'page' ? '`' : ''))
  } else {
    lines.push(`${b('Proposals')}: none pending. \`note ${f.index}: ...\` steers the next plan.`.replace(/`/g, mode === 'page' ? '`' : ''))
  }
  if (mode === 'page') lines.push(`Notebook: ${wikilink(f.notebookPath)}`)
  return lines.join('\n')
}

/* --------------------------------- answers (9.4) --------------------------------- */

export type RecapAnswer =
  | { readonly action: 'pick'; readonly fellow: number; readonly letter: string }
  | { readonly action: 'veto'; readonly fellow: number; readonly letter?: string }
  | { readonly action: 'skip' | 'pause' | 'resume'; readonly fellow: number }
  | { readonly action: 'note'; readonly fellow: number; readonly text: string }
  | { readonly action: 'model'; readonly fellow: number; readonly value: string }
  | { readonly action: 'step'; readonly fellow: number; readonly value: string }
  | { readonly action: 'topic'; readonly fellow: number; readonly letter: string; readonly text: string }

const CODE = /^(\d{1,2})([a-j])$/i
const NUM = /^\d{1,2}$/

/**
 * The answer grammar (D4). Returns null when the text is not an answer at all, so the
 * Telegram bot can fall through to its note-ingest path; an answer with a bad token
 * returns the good ones plus an `errors` list.
 */
export function parseRecapAnswers(text: string): { answers: RecapAnswer[]; errors: string[] } | null {
  const answers: RecapAnswer[] = []
  const errors: string[] = []
  let sawAnswerShape = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    // `note N: rest` and `topic Na: rest` take the rest of their line, wherever they start.
    const free = /(^|[\s,;])(note\s+\d{1,2}\s*:|topic\s+\d{1,2}[a-j]\s*:)/i.exec(line)
    const head = free ? line.slice(0, free.index) : line
    const tail = free ? line.slice(free.index + free[1]!.length) : ''
    const noteM = /^note\s+(\d{1,2})\s*:\s*(.*)$/i.exec(tail)
    const topicM = /^topic\s+(\d{1,2})([a-j])\s*:\s*(.*)$/i.exec(tail)
    const tokens = head.split(/[\s,;]+/).filter((t) => t !== '')
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!.toLowerCase()
      const next = tokens[i + 1]?.toLowerCase()
      if (CODE.test(t)) {
        sawAnswerShape = true
        const m = CODE.exec(t)!
        answers.push({ action: 'pick', fellow: Number(m[1]), letter: m[2]!.toLowerCase() })
        continue
      }
      if (t === 'veto' && next !== undefined) {
        sawAnswerShape = true
        i++
        if (CODE.test(next)) {
          const m = CODE.exec(next)!
          answers.push({ action: 'veto', fellow: Number(m[1]), letter: m[2]!.toLowerCase() })
        } else if (NUM.test(next)) answers.push({ action: 'veto', fellow: Number(next) })
        else errors.push(`veto needs a code or a Fellow number, not "${next}"`)
        continue
      }
      if ((t === 'skip' || t === 'pause' || t === 'resume') && next !== undefined) {
        sawAnswerShape = true
        i++
        if (NUM.test(next)) answers.push({ action: t, fellow: Number(next) })
        else errors.push(`${t} needs a Fellow number, not "${next}"`)
        continue
      }
      if ((t === 'model' || t === 'step') && next !== undefined) {
        sawAnswerShape = true
        const value = tokens[i + 2]?.toLowerCase()
        i += 2
        if (NUM.test(next) && value !== undefined) answers.push({ action: t, fellow: Number(next), value })
        else errors.push(`${t} needs a Fellow number and a value`)
        continue
      }
      if (sawAnswerShape) errors.push(`unknown token "${tokens[i]}"`)
      else return null
    }
    if (noteM) {
      sawAnswerShape = true
      const body = noteM[2]!.trim()
      if (body === '') errors.push(`note ${noteM[1]} has no text`)
      else answers.push({ action: 'note', fellow: Number(noteM[1]), text: body })
    } else if (topicM) {
      sawAnswerShape = true
      const body = topicM[3]!.trim()
      if (body === '') errors.push(`topic ${topicM[1]}${topicM[2]} has no text`)
      else answers.push({ action: 'topic', fellow: Number(topicM[1]), letter: topicM[2]!.toLowerCase(), text: body })
    }
  }
  if (!sawAnswerShape) return null
  return { answers, errors }
}

export interface AnswerResult {
  readonly answer: RecapAnswer
  readonly ok: boolean
  readonly message: string
}

/* ------------------------------------ the service ------------------------------------ */

export interface RecapServiceOptions {
  readonly vaultRoot: string
  readonly fellows: FellowService
  readonly runs: AgentRunStore
  readonly recaps: RecapStore<RecapModel>
  readonly shifts: ShiftStore
  readonly maintenance: MaintenanceRunner
  readonly jobs: Pick<JobStore, 'usageSince'>
  readonly commitMutex: Mutex
  readonly settings: () => { readonly window: NightWindow; readonly recapTime: string }
  readonly autoCommit?: () => boolean
  readonly commit?: (vaultRoot: string, message: string, paths: readonly string[]) => Promise<CommitResult>
  readonly commitStatus?: (hash: string) => Promise<ReadonlyMap<string, 'A' | 'M' | 'D'>>
  readonly now?: () => Date
  /** Delivers the plain-text messages to Telegram; returns the chat ids reached. Late-bound. */
  readonly telegram?: () => ((messages: readonly string[]) => Promise<number[]>) | undefined
  /** Skips the summary run (tests); the page then carries no "found" lines. */
  readonly summarize?: boolean
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface BuildOutcome {
  readonly row: RecapRow<RecapModel>
  readonly summaryRun: MaintenanceRun | null
}

export class RecapService {
  private readonly o: RecapServiceOptions
  private readonly now: () => Date
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void
  private building: Promise<BuildOutcome> | null = null
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: RecapServiceOptions) {
    this.o = opts
    this.now = opts.now ?? ((): Date => new Date())
    this.log = opts.log ?? ((): void => {})
  }

  list(limit = 30): RecapRow<RecapModel>[] {
    return this.o.recaps.list(limit)
  }

  get(cycleDate: string): RecapRow<RecapModel> | undefined {
    return this.o.recaps.get(cycleDate)
  }

  latest(): RecapRow<RecapModel> | undefined {
    return this.o.recaps.list(1)[0]
  }

  get isBuilding(): boolean {
    return this.building !== null
  }

  /** Starts the daily timer (one-minute tick). Idempotent. */
  start(tickMs = 60_000): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), tickMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** The timer's check (D7): past the recap time today and no recap for today: build one. */
  async tick(): Promise<BuildOutcome | null> {
    if (this.building) return null
    const now = this.now()
    const due = atLocalTime(now, this.o.settings().recapTime)
    if (now.getTime() < due.getTime()) return null
    const cycleDate = localDate(now)
    if (this.o.recaps.get(cycleDate) !== undefined) return null
    return this.build({ trigger: 'timer' })
  }

  /** The recap status for the dashboard and the routes. */
  status(): { readonly recapTime: string; readonly nextAt: string; readonly building: boolean; readonly latest: RecapRow<RecapModel> | null } {
    const now = this.now()
    const time = this.o.settings().recapTime
    let next = atLocalTime(now, time)
    if (next.getTime() <= now.getTime() || this.o.recaps.get(localDate(now)) !== undefined) next = atLocalTime(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), time)
    return { recapTime: time, nextAt: next.toISOString(), building: this.building !== null, latest: this.latest() ?? null }
  }

  /** Builds (or with `force` rebuilds) the recap of a cycle date; one build at a time. */
  build(opts: { readonly cycleDate?: string; readonly trigger: 'timer' | 'manual'; readonly force?: boolean } = { trigger: 'manual' }): Promise<BuildOutcome> {
    if (this.building) return this.building
    const p = this.execute(opts).finally(() => {
      this.building = null
    })
    this.building = p
    return p
  }

  private async execute(opts: { readonly cycleDate?: string; readonly trigger: 'timer' | 'manual'; readonly force?: boolean }): Promise<BuildOutcome> {
    const now = this.now()
    const cycleDate = opts.cycleDate ?? localDate(now)
    const existing = this.o.recaps.get(cycleDate)
    if (existing && !opts.force) return { row: existing, summaryRun: null }
    const settings = this.o.settings()
    // D1: since the previous recap, or a day back when there is none (a rebuild keeps its window).
    const previous = this.o.recaps.list(50).find((r) => r.cycleDate < cycleDate)
    const since = existing?.model.since ?? previous?.generatedAt ?? new Date(now.getTime() - 24 * 3600_000).toISOString()
    const fellows = this.o.fellows.list().map((s) => s.agent)
    const statusCache = new Map<string, ReadonlyMap<string, 'A' | 'M' | 'D'>>()
    const commitStatusFn = this.o.commitStatus ?? ((hash: string) => commitFileStatus(this.o.vaultRoot, hash))
    for (const agent of fellows) {
      for (const r of this.o.runs.list({ agentId: agent.id, limit: 50 })) {
        if (r.commitHash && r.startedAt >= since && !statusCache.has(r.commitHash)) {
          try {
            statusCache.set(r.commitHash, await commitStatusFn(r.commitHash))
          } catch {
            /* unknown commit: every page counts as updated */
          }
        }
      }
    }
    let model = buildRecapModel({
      cycleDate,
      now,
      since,
      window: settings.window,
      fellows,
      runsOf: (id) => this.o.runs.list({ agentId: id, limit: 50 }),
      pendingOf: (id) => this.o.fellows.pendingProposals(id),
      shift: this.o.shifts.get(cycleDate) ?? null,
      usage: (sinceIso) => {
        const u = this.o.jobs.usageSince(sinceIso)
        return { costUsd: Math.round(u.costUsd * 100) / 100, runs: u.ingests }
      },
      valueOf: (id) => this.o.fellows.valueCounts(id),
      readPage: (rel) => {
        try {
          return fs.readFileSync(path.join(this.o.vaultRoot, rel), 'utf8')
        } catch {
          return undefined
        }
      },
      commitStatus: (hash) => statusCache.get(hash),
    })

    let summaryRun: MaintenanceRun | null = null
    if (!model.quiet && this.o.summarize !== false) {
      const input = summaryInput(model, (id) => this.o.runs.list({ agentId: id, limit: 50 }))
      if (input.length > 0) {
        try {
          const run = this.o.maintenance.startRecap(renderSummaryPrompt(input), summarySchemaJson(input.map((f) => f.agentId)))
          summaryRun = await new Promise<MaintenanceRun>((resolve) => this.o.maintenance.onRunSettled(run.id, resolve))
          const lines = summaryRun.status === 'done' ? parseSummary(summaryRun.result?.structuredOutput) : undefined
          if (lines) {
            model = {
              ...model,
              summaryCostUsd: summaryRun.result?.usage.costUsd ?? null,
              fellows: model.fellows.map((f) => ({ ...f, found: lines.get(f.agentId) ?? [] })),
            }
          } else {
            model = { ...model, summaryNote: `the summary lines are unavailable (${summaryRun.error ?? 'the answer did not match the schema'})`, summaryCostUsd: summaryRun.result?.usage.costUsd ?? null }
          }
        } catch (err) {
          model = { ...model, summaryNote: `the summary lines are unavailable (${(err as Error).message})` }
        }
      }
    }

    // The page (quiet days get none, NEW-2), written like a user edit: one commit behind the mutex.
    let pagePath: string | null = null
    if (!model.quiet) {
      pagePath = recapPath(cycleDate)
      try {
        await this.o.commitMutex.runExclusive(async () => {
          const abs = path.join(this.o.vaultRoot, pagePath!)
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          fs.writeFileSync(abs, renderRecapPage(model), 'utf8')
          if (this.o.autoCommit?.() ?? true) await (this.o.commit ?? commitPaths)(this.o.vaultRoot, `recap: ${cycleDate}`, [pagePath!])
        })
      } catch (err) {
        this.log('warn', `recap: page not written: ${(err as Error).message}`)
      }
    }

    const row: RecapRow<RecapModel> = {
      cycleDate,
      generatedAt: model.generatedAt,
      path: pagePath,
      quiet: model.quiet,
      model,
      delivered: { dashboard: model.generatedAt },
      answeredAt: null,
    }
    this.o.recaps.put(row)
    this.log('info', `recap: ${cycleDate} built (${opts.trigger}${model.quiet ? ', quiet day' : `, ${model.fellows.length} Fellow(s), ${model.totals.runs} run(s)`})`)

    // Telegram, when a bot is up: the same text, plain.
    const send = this.o.telegram?.()
    if (send) {
      try {
        const chatIds = await send(renderRecapMessages(model))
        if (chatIds.length > 0) this.o.recaps.update(cycleDate, { delivered: { ...row.delivered, telegram: { chatIds, at: this.now().toISOString() } } })
      } catch (err) {
        this.log('warn', `recap: telegram delivery failed: ${(err as Error).message}`)
      }
    }
    return { row: this.o.recaps.get(cycleDate) ?? row, summaryRun }
  }

  /**
   * Applies answers to the recap of `cycleDate` (section 9.4). Codes resolve against the
   * recap's stored mapping; a Fellow number resolves against its order.
   */
  async answer(cycleDate: string, answers: readonly RecapAnswer[], via: DecisionChannel): Promise<{ results: AnswerResult[]; recap: RecapRow<RecapModel> } | undefined> {
    const recap = this.o.recaps.get(cycleDate)
    if (!recap) return undefined
    const results: AnswerResult[] = []
    for (const a of answers) {
      const fellow = recap.model.fellows.find((f) => f.index === a.fellow)
      if (!fellow) {
        results.push({ answer: a, ok: false, message: `no Fellow ${a.fellow} in the recap of ${cycleDate}` })
        continue
      }
      const proposal = 'letter' in a && a.letter !== undefined ? fellow.proposals.find((p) => p.code === `${a.fellow}${a.letter}`) : undefined
      try {
        results.push({ answer: a, ...(await this.applyOne(a, fellow, proposal, via)) })
      } catch (err) {
        results.push({ answer: a, ok: false, message: (err as Error).message })
      }
    }
    const updated = this.o.recaps.update(cycleDate, { answeredAt: this.now().toISOString() }) ?? recap
    return { results, recap: updated }
  }

  private async applyOne(a: RecapAnswer, fellow: RecapFellow, proposal: RecapProposal | undefined, via: DecisionChannel): Promise<{ ok: boolean; message: string }> {
    const f = this.o.fellows
    const needProposal = (): RecapProposal => {
      if (!proposal) throw new Error(`no proposal ${a.fellow}${'letter' in a ? a.letter : ''} in the recap`)
      return proposal
    }
    switch (a.action) {
      case 'pick': {
        const p = needProposal()
        const d = await f.decide(p.proposalId, { status: 'approved', via })
        if (d.refusal) return { ok: false, message: d.refusal.error }
        return { ok: true, message: `${p.code} approved for ${fellow.name}: "${p.topic}" runs at the next shift` }
      }
      case 'veto': {
        if (a.letter !== undefined) {
          const p = needProposal()
          const d = await f.decide(p.proposalId, { status: 'vetoed', via })
          if (d.refusal) return { ok: false, message: d.refusal.error }
          return { ok: true, message: `${p.code} vetoed` }
        }
        let n = 0
        for (const p of fellow.proposals) {
          const d = await f.decide(p.proposalId, { status: 'vetoed', via })
          if (!d.refusal) n++
        }
        return { ok: true, message: `${n} proposal(s) of ${fellow.name} vetoed` }
      }
      case 'skip': {
        const r = await f.skipTonight(fellow.agentId)
        return r ? { ok: true, message: `${fellow.name} skips the shift of ${r.cycleDate}` } : { ok: false, message: 'no such Fellow' }
      }
      case 'pause': {
        const r = await f.pause(fellow.agentId)
        return r ? { ok: true, message: `${fellow.name} paused` } : { ok: false, message: 'no such Fellow' }
      }
      case 'resume': {
        const r = await f.resume(fellow.agentId)
        return r ? { ok: true, message: `${fellow.name} resumed (${r.state})` } : { ok: false, message: 'no such Fellow' }
      }
      case 'note': {
        const r = await f.addNote(fellow.agentId, a.text)
        return r ? { ok: true, message: `note filed in ${fellow.name}'s notebook for the next plan` } : { ok: false, message: 'no such Fellow' }
      }
      case 'model': {
        if (!(AGENT_MODELS as readonly string[]).includes(a.value)) return { ok: false, message: `unknown model "${a.value}" (${AGENT_MODELS.join(', ')})` }
        const r = await f.update(fellow.agentId, { model: a.value as AgentModel })
        return r ? { ok: true, message: `${fellow.name} now runs on ${a.value}` } : { ok: false, message: 'no such Fellow' }
      }
      case 'step': {
        if (!(AGENT_STEPS as readonly string[]).includes(a.value)) return { ok: false, message: `unknown step "${a.value}" (${AGENT_STEPS.join(', ')})` }
        const r = await f.update(fellow.agentId, { step: a.value as AgentStep })
        return r ? { ok: true, message: `${fellow.name}'s largest step is now ${a.value}` } : { ok: false, message: 'no such Fellow' }
      }
      case 'topic': {
        const p = needProposal()
        const d = await f.decide(p.proposalId, { topic: a.text, via })
        if (d.refusal) return { ok: false, message: d.refusal.error }
        return { ok: true, message: `${p.code} now reads "${a.text}"` }
      }
    }
  }

  /** The Telegram bot's hook: parses a message as answers to the latest recap; null = not an answer. */
  async answerText(text: string, via: DecisionChannel = 'telegram'): Promise<string | null> {
    const parsed = parseRecapAnswers(text)
    if (!parsed) return null
    const latest = this.latest()
    if (!latest) return 'There is no recap to answer yet.'
    const outcome = await this.answer(latest.cycleDate, parsed.answers, via)
    const lines = [...(outcome?.results ?? []).map((r) => `${r.ok ? '✅' : '❌'} ${r.message}`), ...parsed.errors.map((e) => `❌ ${e}`)]
    return lines.length > 0 ? `Recap ${latest.cycleDate}:\n${lines.join('\n')}` : `Recap ${latest.cycleDate}: nothing to apply.`
  }
}

/** A stable id for a recap link click (kept for parity with the other stores). */
export const newRecapId = (): string => randomUUID()

export { addDays, windowAt }
