/**
 * The planner (docs/agents/SPEC.md sections 6.2 to 6.4): pure functions around a Fellow's
 * planning run. The prompt and the output schema go in; the schema-bound answer comes back
 * and is validated, scored against the intent and turned into proposal rows here.
 *
 * Nothing in this module talks to the SDK or the database, so the prompt, the validation
 * rules and the drift threshold are unit-testable with fixtures.
 */

import { z } from 'zod'
import type { AgentRecord, AgentStep, AgentModel } from '../db/agents.js'
import { MODEL_FACTOR } from '../db/agents.js'
import type { ProposalKind, ProposalRecord, Provenance } from '../db/proposals.js'
import { RESEARCH_PROFILES } from './research-profiles.js'
import { tokenize } from './related-pages.js'
import type { Candidate } from './candidates.js'

/** The kinds the planner may propose in this milestone (docs/tasks/TASKS-A1.md D1). */
export const PLANNER_KINDS: readonly ProposalKind[] = ['research-step', 'research']

/** Rough list-price cost per kind on Sonnet 5 (spec section 16), scaled by the model factor. */
export const KIND_COST_USD: Readonly<Record<ProposalKind | 'plan', number>> = {
  'research-step': 2,
  research: 6,
  'research-expand': 3,
  plan: 0.4,
}

/** Below this overlap with the intent a proposal is flagged as drift (section 6.4, D9). */
export const DRIFT_THRESHOLD = 0.2

/** How many proposals a planning run may leave. */
export const MAX_PROPOSALS = 3

export function estimateCostUsd(kind: ProposalKind | 'plan', model: AgentModel): number {
  return Math.round(KIND_COST_USD[kind] * MODEL_FACTOR[model] * 100) / 100
}

/**
 * Words an intent is phrased with that carry no topical signal. The overlap tokenizer keeps
 * them (they never matched a page title anyway); here they would inflate the intent's token
 * set and pull an on-topic proposal under the threshold (seen on the first real plan: a
 * proposal sharing "ground" and "transit" with the intent scored 0.18 because "how", "well",
 * "where" and "come" counted as intent tokens).
 */
const QUESTION_WORDS = new Set([
  'how', 'well', 'where', 'when', 'what', 'which', 'why', 'who', 'whether', 'does', 'doe', 'did', 'can',
  'could', 'would', 'should', 'come', 'there', 'than', 'then', 'only', 'also', 'more', 'most', 'much',
  'many', 'far', 'still', 'really', 'actually', 'between', 'against', 'within', 'without', 'across',
])

function scopeTokens(text: string): Set<string> {
  const tokens = tokenize(text)
  for (const w of QUESTION_WORDS) tokens.delete(w)
  return tokens
}

/**
 * Overlap coefficient of the significant tokens: |A and B| / min(|A|, |B|). The intent is
 * short and the rationale long, so plain Jaccard would punish every well-argued proposal.
 */
export function scopeScore(topicAndRationale: string, intentAndScope: string): number {
  const a = scopeTokens(topicAndRationale)
  const b = scopeTokens(intentAndScope)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return Math.round((shared / Math.min(a.size, b.size)) * 100) / 100
}

export const isDrift = (score: number): boolean => score < DRIFT_THRESHOLD

/** The largest kind a step size allows. */
export function kindsForStep(step: AgentStep, allowed: readonly ProposalKind[] = PLANNER_KINDS): ProposalKind[] {
  return allowed.filter((k) => step !== 'small' || k === 'research-step')
}

/** Clamps a proposed kind to what the Fellow's step allows. */
export function clampKind(kind: ProposalKind, step: AgentStep): ProposalKind {
  return step === 'small' ? 'research-step' : kind
}

export interface PlannerInput {
  readonly agent: AgentRecord
  readonly candidates: readonly Candidate[]
  /** Newest last. */
  readonly recentLog: readonly string[]
  /** Topics the user vetoed recently; the planner must not propose them again. */
  readonly vetoed: readonly string[]
  readonly runsLeftToday: number
  readonly kinds: readonly ProposalKind[]
}

const KIND_HELP: Readonly<Record<ProposalKind, string>> = {
  'research-step': 'one question: 1 search round, at most 5 sources and 5 new pages, about 2 USD',
  research: 'a full sweep of a broader topic: 3 rounds, up to 15 pages, about 6 USD',
  'research-expand': 'deepen listed pages append-only, about 3 USD',
}

/** The planning prompt. Everything the planner may draw on is vault-internal (section 13). */
export function renderPlannerPrompt(input: PlannerInput): string {
  const { agent } = input
  const candidates = input.candidates
    .map((c) => `${c.id} [${c.kind}; from ${c.sourcePages.join(', ') || 'no page'}] ${c.text}`)
    .join('\n')
  const lenses = RESEARCH_PROFILES.map((p) => `${p.key} (${p.blurb})`).join('; ')
  return (
    `You are the planner of "${agent.name}", a resident research Fellow of this library. ` +
    'Decide what the Fellow should research next, judged only against its standing intent.\n\n' +
    `Intent: ${agent.intent}\n` +
    (agent.scope ? `Scope notes from the user: ${agent.scope}\n` : '') +
    `Home domain: ${agent.homeDomain}${agent.extraDomains.length > 0 ? ` (also ${agent.extraDomains.join(', ')})` : ''}\n` +
    `Notebook: ${agent.notebookPath}\n\n` +
    `Candidates (every proposal must name one of these ids as its origin):\n${candidates}\n\n` +
    (input.recentLog.length > 0 ? `Recent runs, newest last:\n${input.recentLog.map((l) => `- ${l}`).join('\n')}\n\n` : '') +
    (input.vetoed.length > 0 ? `The user vetoed these topics recently; do not propose them again:\n${input.vetoed.map((t) => `- ${t}`).join('\n')}\n\n` : '') +
    `Run kinds you may propose, smallest first: ${input.kinds.map((k) => `${k} (${KIND_HELP[k]})`).join('; ')}. ` +
    'Choose the SMALLEST kind that fits each candidate: a single question is a research-step; only a genuinely broad, ' +
    'multi-question theme deserves a full research sweep. ' +
    `Lenses: ${lenses}; "${agent.lens}" is the Fellow's default.\n` +
    `The Fellow has ${input.runsLeftToday} run(s) left today.\n\n` +
    'Read the candidates\' source pages with your read tools when you need to judge them; you have no web access and ' +
    'must not write anything. Then answer in the required structured format: at most ' +
    `${MAX_PROPOSALS} proposals, best first, each with the candidate id, the kind, a precise topic sentence a ` +
    'research run can act on, and one paragraph of rationale against the intent. Merge candidates that are the same ' +
    'question. Skip candidates the wiki already answers or that fall outside the intent. If nothing is worth a run, ' +
    'return no proposals, set nothing_worth_a_run and say why; set intent_covered only when the intent itself is ' +
    'answered as far as the library can take it.'
  )
}

/** JSON schema for the planning answer, built from the kinds and candidate ids of this run. */
export function plannerSchema(input: { readonly kinds: readonly ProposalKind[]; readonly candidateIds: readonly string[] }): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidate: { type: 'string', enum: [...input.candidateIds] },
            kind: { type: 'string', enum: [...input.kinds] },
            topic: { type: 'string' },
            rationale: { type: 'string' },
            lens: { type: 'string', enum: RESEARCH_PROFILES.map((p) => p.key) },
          },
          required: ['candidate', 'kind', 'topic', 'rationale', 'lens'],
          additionalProperties: false,
        },
      },
      nothing_worth_a_run: { type: 'boolean' },
      intent_covered: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['proposals', 'nothing_worth_a_run', 'intent_covered', 'reason'],
    additionalProperties: false,
  }
}

/** Strict where it matters: an answer without a proposal list is not an answer at all. */
const answerSchema = z.object({
  proposals: z.array(
    z.object({
      candidate: z.string(),
      kind: z.enum(['research', 'research-step', 'research-expand']),
      topic: z.string().trim().min(3).max(500),
      rationale: z.string().trim().max(2000).default(''),
      lens: z.string().optional(),
    }),
  ),
  nothing_worth_a_run: z.boolean(),
  intent_covered: z.boolean().default(false),
  reason: z.string().trim().max(2000).default(''),
})

export interface PlannerAnswer {
  readonly proposals: ReadonlyArray<{
    readonly candidate: string
    readonly kind: ProposalKind
    readonly topic: string
    readonly rationale: string
    readonly lens?: string
  }>
  readonly nothingWorthARun: boolean
  readonly intentCovered: boolean
  readonly reason: string
}

/** Parses the structured answer; undefined when it is not the shape the schema asked for. */
export function parsePlannerAnswer(raw: unknown): PlannerAnswer | undefined {
  const parsed = answerSchema.safeParse(raw)
  if (!parsed.success) return undefined
  return {
    proposals: parsed.data.proposals.map((p) => ({
      candidate: p.candidate,
      kind: p.kind,
      topic: p.topic,
      rationale: p.rationale,
      ...(p.lens !== undefined ? { lens: p.lens } : {}),
    })),
    nothingWorthARun: parsed.data.nothing_worth_a_run,
    intentCovered: parsed.data.intent_covered,
    reason: parsed.data.reason,
  }
}

export interface BuildProposalsInput {
  readonly agent: AgentRecord
  readonly answer: PlannerAnswer
  readonly candidates: readonly Candidate[]
  readonly kinds: readonly ProposalKind[]
  readonly cycleDate: string
  readonly now: string
  readonly newId: () => string
}

export interface BuiltProposals {
  readonly proposals: ProposalRecord[]
  /** Why an answer's proposal was dropped, for the log. */
  readonly rejected: string[]
}

/**
 * Turns a validated answer into proposal rows: provenance from the named candidate (a
 * proposal without one is rejected, section 6.4), the kind clamped to the Fellow's step and
 * to the allowed kinds, the scope score against intent and scope, at most three, ranked in
 * the planner's order.
 */
export function buildProposals(input: BuildProposalsInput): BuiltProposals {
  const { agent } = input
  const byId = new Map(input.candidates.map((c) => [c.id, c]))
  const lensKeys = new Set<string>(RESEARCH_PROFILES.map((p) => p.key))
  const proposals: ProposalRecord[] = []
  const rejected: string[] = []
  const seenTopics = new Set<string>()
  for (const p of input.answer.proposals) {
    if (proposals.length >= MAX_PROPOSALS) {
      rejected.push(`"${p.topic}": beyond the ${MAX_PROPOSALS}-proposal cap`)
      continue
    }
    const candidate = byId.get(p.candidate.trim().toUpperCase())
    if (!candidate) {
      rejected.push(`"${p.topic}": names no known candidate (${p.candidate})`)
      continue
    }
    const topicKey = p.topic.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seenTopics.has(topicKey)) {
      rejected.push(`"${p.topic}": duplicate topic`)
      continue
    }
    seenTopics.add(topicKey)
    const allowed: ProposalKind = input.kinds.includes(p.kind) ? p.kind : 'research-step'
    const kind = clampKind(allowed, agent.step)
    const provenance: Provenance = { candidate: candidate.kind, text: candidate.text, sourcePages: candidate.sourcePages }
    proposals.push({
      id: input.newId(),
      agentId: agent.id,
      createdAt: input.now,
      cycleDate: input.cycleDate,
      kind,
      topic: p.topic,
      lens: p.lens !== undefined && lensKeys.has(p.lens) ? p.lens : agent.lens,
      rationale: p.rationale,
      provenance,
      pageSet: [],
      estCostUsd: estimateCostUsd(kind, agent.model),
      estPlanPct: null,
      scopeScore: scopeScore(`${p.topic} ${p.rationale} ${candidate.text}`, `${agent.intent} ${agent.scope ?? ''}`),
      rank: proposals.length + 1,
      status: 'proposed',
      decidedAt: null,
      decidedVia: null,
      userNote: null,
      runId: null,
    })
  }
  return { proposals, rejected }
}

/** The notebook's Plan section, rendered from the pending proposals (section 5.4). */
export function renderPlanSection(input: {
  readonly pending: readonly ProposalRecord[]
  readonly autonomy: AgentRecord['autonomy']
  readonly window: { readonly start: string; readonly end: string }
  /** When nothing is pending: why (the sleep reason), or null for the default line. */
  readonly idleReason?: string | null
}): string {
  if (input.pending.length === 0) {
    return input.idleReason ? `Nothing planned: ${input.idleReason}` : 'Nothing planned. The planner runs in the next night shift.'
  }
  const head =
    input.autonomy === 'manual'
      ? 'Manual mode: a proposal runs only after you approve it.'
      : input.autonomy === 'auto'
        ? 'Auto mode: the top proposal runs in the same night it is planned.'
        : `Veto window: the top undecided proposal runs at the next night shift (${input.window.start} to ${input.window.end}) unless vetoed.`
  const lines = input.pending.map((p, i) => {
    const status =
      p.status === 'approved'
        ? `approved${p.decidedVia ? ` (${p.decidedVia})` : ''}`
        : isDrift(p.scopeScore)
          ? 'undecided, flagged as drift (will not run unapproved)'
          : 'undecided'
    const cost = p.estCostUsd !== null ? ` · about ${p.estCostUsd.toFixed(2)} USD` : ''
    const from = `${p.provenance.candidate}: ${p.provenance.text}${p.provenance.sourcePages.length > 0 ? ` (${p.provenance.sourcePages.join(', ')})` : ''}`
    return `${i + 1}. ${p.kind} · ${p.topic} · ${status}${cost}\n   Why: ${p.rationale || '-'}\n   From: ${from}`
  })
  return `${head}\n\n${lines.join('\n')}`
}
