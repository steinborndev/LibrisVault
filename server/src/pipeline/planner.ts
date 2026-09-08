/**
 * The planner (docs/agents/SPEC.md sections 6.2 to 6.4): pure functions around a Fellow's
 * planning run. The prompt and the output schema go in; the schema-bound answer comes back
 * and is validated, scored against the intent and turned into proposal rows here.
 *
 * Nothing in this module talks to the SDK or the database, so the prompt, the validation
 * rules and the drift threshold are unit-testable with fixtures.
 */

import { z } from 'zod'
import type { AgentRecord, AgentStep, AgentModel, AgentTask, TaskKind } from '../db/agents.js'
import { MODEL_FACTOR } from '../db/agents.js'
import type { ProposalKind, ProposalRecord, Provenance } from '../db/proposals.js'
import { RESEARCH_PROFILES } from './research-profiles.js'
import { tokenize } from './related-pages.js'
import { SELF_LOOP_LIMIT, type Candidate } from './candidates.js'
import { EXPAND_MAX_PAGES } from './expand.js'

/** The kinds the planner may propose, smallest first (A3 added `research-expand`). */
export const PLANNER_KINDS: readonly ProposalKind[] = ['research-step', 'research-expand', 'research']

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

/**
 * How long each field of the answer may be. One place, because all three layers have to
 * agree: the JSON schema binds the model, the prompt says it in words, and the parser
 * trims to it. They did not agree once - the schema said nothing about length while the
 * parser rejected a topic over 500 characters - and a single long topic threw away a whole
 * night's plan, proposals, handoffs and all.
 */
export const FIELD_CAPS = {
  topic: 500,
  rationale: 2000,
  reason: 2000,
  handoffReason: 1000,
  domain: 64,
  pages: 20,
  /** Publications the planner may name for the reading list, and how long a link may be. */
  reading: 10,
  url: 500,
} as const

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

/** What each art of task means, for the prompt. */
const TASK_HELP: Record<TaskKind, string> = {
  watch: 'a standing lookout for what is NEW in the field - it is never finished',
  explore: 'an open question to pursue until the library can take it no further',
  deepen: 'a theme whose existing pages should be built out - it is never finished',
}

/**
 * The run kinds an art of task allows.
 *
 * The task decides the work and the step size only sizes an explore run (decision 2026-09-07):
 * a `small` Fellow used to be forbidden everything but `research-step`, which would have made
 * a deepen task unrunnable on it. The step was never meant as a prohibition.
 */
export function kindsForTask(kind: TaskKind, step: AgentStep): ProposalKind[] {
  if (kind === 'deepen') return ['research-expand']
  if (kind === 'watch') return ['research-step', 'research']
  return step === 'small' ? ['research-step'] : ['research-step', 'research']
}

/** The largest kind a step size allows: `small` is steps only; `standard` and `deep` may expand and sweep. */
export function kindsForStep(step: AgentStep, allowed: readonly ProposalKind[] = PLANNER_KINDS): ProposalKind[] {
  return allowed.filter((k) => step !== 'small' || k === 'research-step')
}

/** Clamps a proposed kind to what the Fellow's step allows. */
export function clampKind(kind: ProposalKind, step: AgentStep): ProposalKind {
  return step === 'small' ? 'research-step' : kind
}

export interface DomainHint {
  readonly key: string
  readonly description: string
}

export interface PlannerInput {
  readonly agent: AgentRecord
  readonly candidates: readonly Candidate[]
  /** Newest last. */
  readonly recentLog: readonly string[]
  /** Topics the user vetoed recently; the planner must not propose them again. */
  readonly vetoed: readonly string[]
  /**
   * What the OTHER Fellows are already on: their undecided and approved topics, and what has
   * already run tonight (docs/agents/ideas.md, decision 2026-09-08).
   *
   * The service's own dedupe compares topic strings, which only catches a duplicate that is
   * also a near-quotation: two Fellows can ask the same question in different words and score
   * zero against each other. Measured on this vault, retrieval over the BM25 index does not
   * close that gap either - it ranks by shared terms and finds topical NEIGHBOURS, which in a
   * library concentrated on one subject is everything. The planner is the one judge in the
   * loop that reads for meaning, and it is already running; this is what it costs to ask it.
   *
   * An instruction, not a boundary - the lexical dedupe stays underneath as the mechanical
   * floor. Empty when there is only one Fellow.
   */
  readonly elsewhere?: readonly { readonly fellow: string; readonly topic: string; readonly ran: boolean }[]
  readonly runsLeftToday: number
  readonly kinds: readonly ProposalKind[]
  /** Tonight's task: the one thing the answer is judged against (decision 2026-09-07). */
  readonly task: AgentTask
  /** Which of the Fellow's tasks it is, for the line that says so. */
  readonly taskIndex?: number
  /** For a deepen task: the pages the service ranked for tonight, the set the run may name. */
  readonly deepenPages?: readonly string[]
  /** The domain registry, for routing (A3); empty when the vault has none. */
  readonly domains?: readonly DomainHint[]
  /** Set on the second attempt of a cycle: what went wrong with the first answer. */
  readonly retryNote?: string
  /**
   * How many runs in a row followed up an open question the Fellow wrote itself
   * (candidates.ts `ownQuestionStreak`). At or above `SELF_LOOP_LIMIT` the prompt says so:
   * the candidate list has already been re-ranked, and this is the reason for it.
   */
  readonly selfLoop?: number
}

const KIND_HELP: Readonly<Record<ProposalKind, string>> = {
  'research-step': 'one question: 1 search round, at most 5 sources and 5 new pages, about 2 USD',
  research: 'a full sweep of a broader topic: 3 rounds, up to 15 pages, about 6 USD',
  'research-expand': 'deepen up to 4 EXISTING pages you name in `pages` with dated append-only update sections, about 3 USD',
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
    'Decide what the Fellow should do TONIGHT, judged only against the one task below.\n\n' +
    /*
     * One task, not the whole list. The Fellow works its tasks in turn, and a planner shown
     * all of them judges against the union - which is the broad subject this replaced.
     */
    `Tonight's task${input.taskIndex !== undefined ? ` (${input.taskIndex + 1} of ${agent.tasks.length})` : ''}: ${input.task.text}\n` +
    `The task is ${input.task.kind === 'explore' ? 'an' : 'a'} ${input.task.kind} task: ${TASK_HELP[input.task.kind]}\n` +
    (agent.tasks.length > 1
      ? `The Fellow's other standing tasks, NOT for tonight - do not propose against them: ${agent.tasks
          .filter((t) => t.id !== input.task.id)
          .map((t) => `"${t.text}" (${t.kind})`)
          .join('; ')}\n`
      : '') +
    (agent.scope ? `Scope notes from the user, they qualify every task: ${agent.scope}\n` : '') +
    `Home domain: ${agent.homeDomain}${agent.extraDomains.length > 0 ? ` (also ${agent.extraDomains.join(', ')})` : ''}\n` +
    `Notebook: ${agent.notebookPath}\n\n` +
    `Candidates (every proposal must name one of these ids as its origin):\n${candidates}\n\n` +
    /*
     * The sweep needs a sentence: every other candidate names something the vault already
     * holds, so a planner shown one without explanation reads it as another follow-up.
     */
    (input.candidates.some((c) => c.kind === 'sweep')
      ? 'The `sweep` candidate is the standing task itself. It means going out to look for material the library does ' +
        'not have yet, rather than following up something it has already written down, and it never runs out - a ' +
        'watch task always has it. Propose it when the best thing tonight is more material rather than a closer look ' +
        'at what is here, and make the topic sentence say what to look for and what to file about each thing found.\n\n'
      : '') +
    (input.selfLoop !== undefined && input.selfLoop >= SELF_LOOP_LIMIT
      ? `The last ${input.selfLoop} runs all followed up a question this Fellow wrote itself. That is how standing ` +
        'work turns into an audit of its own first sources: each run leaves questions about what it could not verify ' +
        'or reach, and those questions are then the only thing on the menu. The candidates above are ordered with ' +
        'that in mind. Prefer one that is not the Fellow\'s own open question tonight, unless one of them is ' +
        'genuinely worth more than looking outward.\n\n'
      : '') +
    (input.recentLog.length > 0 ? `Recent runs, newest last:\n${input.recentLog.map((l) => `- ${l}`).join('\n')}\n\n` : '') +
    (input.vetoed.length > 0 ? `The user vetoed these topics recently; do not propose them again:\n${input.vetoed.map((t) => `- ${t}`).join('\n')}\n\n` : '') +
    (input.elsewhere !== undefined && input.elsewhere.length > 0
      ? 'Work already claimed elsewhere in the library. A topic that asks the SAME question as one of these is a ' +
        'duplicate however differently it is worded, and duplicates are the one thing this library cannot afford: ' +
        'two Fellows spending a run each on one question. Do not propose one. Judge by what the question ASKS, not ' +
        'by the words it uses - and be precise about it, because a narrower follow-up on a subject someone else ' +
        'touched is NOT a duplicate and is often the most valuable thing you can propose. If your candidate is the ' +
        'same question, drop it; if it genuinely goes further, propose it and say in the rationale what it adds:\n' +
        input.elsewhere
          .map((e) => `- ${e.ran ? 'ALREADY RAN tonight' : 'proposed'} by ${e.fellow}: "${e.topic}"`)
          .join('\n') +
        '\n\n'
      : '') +
    (input.deepenPages !== undefined && input.deepenPages.length > 0
      ? `\nThe pages to deepen tonight, chosen for this theme because the library points at them more than they ` +
        `pay off - name these in \`pages\`, all of them or the ones that fit:\n${input.deepenPages.map((p) => `- ${p}`).join('\n')}\n`
      : '') +
    `\nRun kinds you may propose, smallest first: ${input.kinds.map((k) => `${k} (${KIND_HELP[k]})`).join('; ')}. ` +
    'Choose the SMALLEST kind that fits each candidate: a single question is a research-step; only a genuinely broad, ' +
    'multi-question theme deserves a full research sweep. ' +
    `Lenses: ${lenses}; "${agent.lens}" is the Fellow's default.\n` +
    `The Fellow has ${input.runsLeftToday} run(s) left today.\n` +
    (input.domains !== undefined && input.domains.length > 0
      ? `\nThe library's domains (registry keys): ${input.domains.map((d) => `${d.key} (${d.description})`).join('; ')}.\n`
      : '') +
    '\nRead the candidates\' source pages with your read tools when you need to judge them; you have no web access and ' +
    'must not write anything. Then answer in the required structured format: at most ' +
    `${MAX_PROPOSALS} proposals, best first, each with the candidate id, the kind, a precise topic sentence a ` +
    `research run can act on (at most ${FIELD_CAPS.topic} characters - one sentence, not a paragraph), one paragraph of ` +
    `rationale against the intent (at most ${FIELD_CAPS.rationale} characters), and for research-expand the vault-relative ` +
    `paths of at most ${FIELD_CAPS.pages} existing pages to deepen in \`pages\` (leave \`pages\` empty for the other kinds). ` +
    'Merge candidates that ' +
    'are the same question. Skip candidates the wiki already answers or that fall outside the intent. ' +
    (input.domains !== undefined && input.domains.length > 0
      ? 'A candidate that is a real question but belongs to ANOTHER domain of the library is a handoff, not a proposal: ' +
        'list it under `handoffs` with its candidate id, the registry key of that domain and a short reason, so the ' +
        `Fellow of that domain gets it (or the user is offered to spawn one). Keep the reason under ${FIELD_CAPS.handoffReason} ` +
        "characters. Do not hand off the Fellow's own questions. "
      : '') +
    'Reading list: while judging the candidates you will see publications named in the source pages and in the ' +
    'notebook - papers a run read, and papers a run wanted and could NOT get (a paywall, an HTTP error, a PDF that ' +
    'would not extract). List those that are worth having in the original under `reading`, with the access you can ' +
    'infer: `open` when the full text is freely available, `paywalled` behind a subscription, `unreachable` when a ' +
    'run failed to fetch it, and `blocked` for the reason in a few words. The service adds them to the reading list; ' +
    'you must not write to any page. Leave out anything already on the list or without a usable link.\n\n' +
    'If nothing is worth a run, return no proposals, set nothing_worth_a_run and say why; set intent_covered only when ' +
    `TONIGHT'S TASK is answered as far as the library can take it - and never for a watch or a deepen task, which are standing work and are never finished. Keep \`reason\` under ${FIELD_CAPS.reason} characters.` +
    (input.retryNote !== undefined ? `\n\nNOTE: ${input.retryNote}` : '')
  )
}

/** JSON schema for the planning answer, built from the kinds, candidate ids and domains of this run. */
export function plannerSchema(input: { readonly kinds: readonly ProposalKind[]; readonly candidateIds: readonly string[]; readonly domainKeys?: readonly string[] }): Record<string, unknown> {
  const domainKeys = input.domainKeys ?? []
  return {
    type: 'object',
    properties: {
      proposals: {
        type: 'array',
        maxItems: MAX_PROPOSALS,
        items: {
          type: 'object',
          properties: {
            candidate: { type: 'string', enum: [...input.candidateIds] },
            kind: { type: 'string', enum: [...input.kinds] },
            topic: { type: 'string', minLength: 3, maxLength: FIELD_CAPS.topic },
            rationale: { type: 'string', maxLength: FIELD_CAPS.rationale },
            lens: { type: 'string', enum: RESEARCH_PROFILES.map((p) => p.key) },
            pages: { type: 'array', items: { type: 'string' }, maxItems: FIELD_CAPS.pages },
          },
          required: ['candidate', 'kind', 'topic', 'rationale', 'lens', 'pages'],
          additionalProperties: false,
        },
      },
      handoffs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidate: { type: 'string', enum: [...input.candidateIds] },
            domain: domainKeys.length > 0 ? { type: 'string', enum: [...domainKeys] } : { type: 'string', maxLength: FIELD_CAPS.domain },
            reason: { type: 'string', maxLength: FIELD_CAPS.handoffReason },
          },
          required: ['candidate', 'domain', 'reason'],
          additionalProperties: false,
        },
      },
      reading: {
        type: 'array',
        maxItems: FIELD_CAPS.reading,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: FIELD_CAPS.topic },
            url: { type: 'string', maxLength: FIELD_CAPS.url },
            ref: { type: 'string', maxLength: FIELD_CAPS.domain },
            domain: domainKeys.length > 0 ? { type: 'string', enum: [...domainKeys] } : { type: 'string', maxLength: FIELD_CAPS.domain },
            why: { type: 'string', maxLength: FIELD_CAPS.handoffReason },
            access: { type: 'string', enum: ['open', 'paywalled', 'unreachable'] },
            blocked: { type: 'string', maxLength: FIELD_CAPS.domain },
          },
          required: ['title', 'url', 'ref', 'domain', 'why', 'access', 'blocked'],
          additionalProperties: false,
        },
      },
      nothing_worth_a_run: { type: 'boolean' },
      intent_covered: { type: 'boolean' },
      reason: { type: 'string', maxLength: FIELD_CAPS.reason },
    },
    required: ['proposals', 'handoffs', 'reading', 'nothing_worth_a_run', 'intent_covered', 'reason'],
    additionalProperties: false,
  }
}

/** A text field: trimmed and cut to its cap rather than refused for being one character long. */
const text = (cap: number, fallback = ''): z.ZodType<string, string | undefined> =>
  z
    .string()
    .optional()
    .transform((v) => (v ?? fallback).trim().slice(0, cap))

const proposalSchema = z.object({
  candidate: z.string(),
  kind: z.enum(['research', 'research-step', 'research-expand']),
  // Length is trimmed, not refused; a topic of two characters is still no topic.
  topic: text(FIELD_CAPS.topic).refine((t) => t.length >= 3, 'topic too short'),
  rationale: text(FIELD_CAPS.rationale),
  lens: z.string().optional(),
  pages: z
    .array(z.string().trim().min(1))
    .default([])
    .transform((p) => p.slice(0, FIELD_CAPS.pages)),
})

const handoffSchema = z.object({
  candidate: z.string(),
  domain: text(FIELD_CAPS.domain).refine((d) => d.length >= 1, 'no domain'),
  reason: text(FIELD_CAPS.handoffReason),
})

const readingSchema = z.object({
  title: text(FIELD_CAPS.topic).refine((t) => t.length >= 3, 'title too short'),
  url: text(FIELD_CAPS.url).refine((u) => /^https?:\/\//i.test(u), 'not a url'),
  ref: text(FIELD_CAPS.domain),
  domain: text(FIELD_CAPS.domain),
  why: text(FIELD_CAPS.handoffReason),
  access: z.enum(['open', 'paywalled', 'unreachable']).optional(),
  blocked: text(FIELD_CAPS.domain),
})

/**
 * Strict where it matters: an answer without a proposal list is not an answer at all. The
 * entries themselves are parsed one by one below, so one malformed proposal costs that
 * proposal and not the plan around it.
 */
const answerSchema = z.object({
  proposals: z.array(z.unknown()),
  handoffs: z.array(z.unknown()).default([]),
  reading: z.array(z.unknown()).default([]),
  nothing_worth_a_run: z.boolean(),
  intent_covered: z.boolean().default(false),
  reason: text(FIELD_CAPS.reason),
})

export interface PlannerAnswer {
  readonly proposals: ReadonlyArray<{
    readonly candidate: string
    readonly kind: ProposalKind
    readonly topic: string
    readonly rationale: string
    readonly lens?: string
    readonly pages: readonly string[]
  }>
  /** Candidates the planner routed to another domain (A3). */
  readonly handoffs: ReadonlyArray<{ readonly candidate: string; readonly domain: string; readonly reason: string }>
  /** Publications worth the original, for the reading list (section 10.6); the service writes them. */
  readonly reading: ReadonlyArray<{
    readonly title: string
    readonly url: string
    readonly ref: string | null
    readonly domain: string | null
    readonly why: string | null
    readonly access: 'open' | 'paywalled' | 'unreachable' | null
    readonly blocked: string | null
  }>
  readonly nothingWorthARun: boolean
  readonly intentCovered: boolean
  readonly reason: string
  /** Entries thrown away on the way in, one line each, for the run log. */
  readonly dropped: readonly string[]
}

const why = (error: z.ZodError): string => error.issues.map((i) => `${i.path.join('.') || 'entry'}: ${i.message}`).join('; ')

/**
 * Parses the structured answer; undefined only when the answer is not an answer - no object,
 * no proposal list, no verdict. Everything smaller is survivable: a field over its cap is
 * cut, and a proposal or handoff that still does not parse is dropped on its own so the rest
 * of the plan stands.
 */
export function parsePlannerAnswer(raw: unknown): PlannerAnswer | undefined {
  const parsed = answerSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const dropped: string[] = []
  const proposals: Array<PlannerAnswer['proposals'][number]> = []
  parsed.data.proposals.forEach((entry, i) => {
    const p = proposalSchema.safeParse(entry)
    if (!p.success) {
      dropped.push(`proposal ${i + 1} dropped, ${why(p.error)}`)
      return
    }
    proposals.push({
      candidate: p.data.candidate,
      kind: p.data.kind,
      topic: p.data.topic,
      rationale: p.data.rationale,
      pages: p.data.pages,
      ...(p.data.lens !== undefined ? { lens: p.data.lens } : {}),
    })
  })
  const handoffs: Array<PlannerAnswer['handoffs'][number]> = []
  parsed.data.handoffs.forEach((entry, i) => {
    const h = handoffSchema.safeParse(entry)
    if (!h.success) {
      dropped.push(`handoff ${i + 1} dropped, ${why(h.error)}`)
      return
    }
    handoffs.push({ candidate: h.data.candidate.trim().toUpperCase(), domain: h.data.domain.toLowerCase(), reason: h.data.reason })
  })
  const reading: Array<PlannerAnswer['reading'][number]> = []
  parsed.data.reading.forEach((entry, i) => {
    const r = readingSchema.safeParse(entry)
    if (!r.success) {
      dropped.push(`reading ${i + 1} dropped, ${why(r.error)}`)
      return
    }
    reading.push({
      title: r.data.title,
      url: r.data.url,
      ref: r.data.ref || null,
      domain: r.data.domain ? r.data.domain.toLowerCase() : null,
      why: r.data.why || null,
      access: r.data.access ?? null,
      blocked: r.data.blocked || null,
    })
  })
  return {
    proposals,
    handoffs,
    reading,
    nothingWorthARun: parsed.data.nothing_worth_a_run,
    intentCovered: parsed.data.intent_covered,
    reason: parsed.data.reason,
    dropped,
  }
}

export interface BuildProposalsInput {
  readonly agent: AgentRecord
  readonly answer: PlannerAnswer
  readonly candidates: readonly Candidate[]
  readonly kinds: readonly ProposalKind[]
  /** The task the answer was asked for; the scope score measures against it. */
  readonly task?: AgentTask
  readonly cycleDate: string
  readonly now: string
  readonly newId: () => string
  /** Whether a vault-relative page exists (an expand page set keeps only existing pages, D1). */
  readonly pageExists?: (page: string) => boolean
  /** The Fellow's own pages an expand run may always touch: its synthesis pages and its notebook. */
  readonly ownPages?: readonly string[]
  /** Points of the week a run of that cost takes on that model, once calibrated (A5); null otherwise. */
  readonly estimatePct?: (costUsd: number, model: AgentModel) => number | null
}

export interface BuiltProposals {
  readonly proposals: ProposalRecord[]
  /** Why an answer's proposal was dropped, for the log. */
  readonly rejected: string[]
  /** Expand proposals clamped to a step because no listed page existed. */
  readonly clamped: string[]
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
  const clamped: string[] = []
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
    let kind = clampKind(allowed, agent.step)
    let pageSet: string[] = []
    if (kind === 'research-expand') {
      // D1: the listed pages that exist, capped, plus the Fellow's own pages; none listed = a step.
      const exists = input.pageExists ?? ((): boolean => true)
      const listed = [...new Set([...p.pages, ...candidate.sourcePages])].filter((pg) => pg.startsWith('wiki/') && exists(pg)).slice(0, EXPAND_MAX_PAGES)
      if (listed.length === 0) {
        kind = 'research-step'
        clamped.push(p.topic)
      } else {
        pageSet = [...new Set([...listed, ...(input.ownPages ?? []).filter(exists)])]
      }
    }
    const provenance: Provenance = {
      candidate: candidate.kind,
      text: candidate.text,
      sourcePages: candidate.sourcePages,
      // Which standing task asked for this, so the recap can say so while you decide.
      ...(input.task !== undefined ? { task: input.task.text } : {}),
    }
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
      pageSet,
      estCostUsd: estimateCostUsd(kind, agent.model),
      estPlanPct: input.estimatePct ? input.estimatePct(estimateCostUsd(kind, agent.model), agent.model) : null,
      // Against TONIGHT'S task, which is what makes the number mean something: measured
      // against a broad intent plus free-text notes it read 0.00 for a Fellow that was in
      // fact on topic (the end-to-end tests).
      scopeScore: scopeScore(`${p.topic} ${p.rationale} ${candidate.text}`, `${input.task?.text ?? agent.intent} ${agent.scope ?? ''}`),
      rank: proposals.length + 1,
      status: 'proposed',
      decidedAt: null,
      decidedVia: null,
      userNote: null,
      runId: null,
    })
  }
  return { proposals, rejected, clamped }
}

/** The notebook's Plan section, rendered from the pending proposals (section 5.4). */
export function renderPlanSection(input: {
  readonly pending: readonly ProposalRecord[]
  readonly autonomy: AgentRecord['autonomy']
  readonly window: { readonly start: string; readonly end: string }
  /** When nothing is pending: why (the sleep reason), or null for the default line. */
  readonly idleReason?: string | null
  /** "Skip tonight": the cycle date the next shift skips for this Fellow. */
  readonly skipUntil?: string
}): string {
  const skip = input.skipUntil !== undefined ? `Skipped tonight (${input.skipUntil}) at your request; the planner still runs.\n\n` : ''
  if (input.pending.length === 0) {
    return skip + (input.idleReason ? `Nothing planned: ${input.idleReason}` : 'Nothing planned. The planner runs in the next night shift.')
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
    const from = `${p.provenance.task !== undefined ? `task "${p.provenance.task}" · ` : ''}${p.provenance.candidate}: ${p.provenance.text}${p.provenance.sourcePages.length > 0 ? ` (${p.provenance.sourcePages.join(', ')})` : ''}`
    return `${i + 1}. ${p.kind} · ${p.topic} · ${status}${cost}\n   Why: ${p.rationale || '-'}\n   From: ${from}`
  })
  return `${skip}${head}\n\n${lines.join('\n')}`
}
