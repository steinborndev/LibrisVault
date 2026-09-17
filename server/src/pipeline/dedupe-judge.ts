/**
 * The language-model judge for duplicate topics (docs/agents/ideas.md, 2026-09-08).
 *
 * Everything measured before this reads a topic's SURFACE - which words it shares with another,
 * or where its sentence lands in an embedding space - and on this vault both fail the same way:
 * they score topical adjacency, and in a library concentrated on one subject everything is
 * adjacent. A broad sweep and a narrow follow-up on it are neighbours by every surface measure
 * and must both run.
 *
 * This asks the only judge that reads what a question ASKS. One call over all the pairs a
 * night produces, which is also how it would run in the shift: the pairs are few, the prompt is
 * short, and a second opinion is worth one cheap read-only run at most.
 *
 * It is measured before it is wired to anything (`npm run dedupe-eval -- --judge`). A judge
 * that cannot be given a safe threshold is no better than the metrics it was meant to replace,
 * and this vault's own history holds the pairs that would catch it out.
 */

import { z } from 'zod'
import { runAgent } from './agent-runner.js'
import type { AgentAuth } from './agent-runner.js'

/** One question put to the judge. */
export interface JudgePair {
  readonly id: string
  readonly a: string
  readonly b: string
}

const answerSchema = z.object({
  judgements: z.array(
    z.object({
      id: z.string(),
      /** 0 = plainly different questions, 100 = one run answers both. */
      confidence: z.number().min(0).max(100),
      reason: z.string(),
    }),
  ),
})

export type JudgeAnswer = z.infer<typeof answerSchema>

/** The JSON schema that binds the answer, in the shape the SDK's structured output takes. */
export function judgeSchema(ids: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['judgements'],
    properties: {
      judgements: {
        type: 'array',
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'confidence', 'reason'],
          properties: {
            id: { type: 'string', enum: [...ids] },
            confidence: { type: 'integer', minimum: 0, maximum: 100 },
            reason: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
  }
}

/**
 * The prompt. Two things are load-bearing and both come from measurement rather than taste.
 *
 * The question is "would ONE run serve both", not "are these similar" - similarity is exactly
 * what the failed metrics measured. And the follow-up case is spelled out with the shape this
 * vault actually produces, because that is the mistake every surface measure made: a narrower
 * question about a subject someone else covered is the most valuable thing a Fellow proposes,
 * and merging it away is the expensive error.
 */
export function renderJudgePrompt(pairs: readonly JudgePair[]): string {
  return (
    'You are judging whether pairs of research topics are the same question.\n\n' +
    'Each pair below is two topic sentences from a research library. For each, decide whether ' +
    'ONE research run would serve both - not whether they are similar, and not whether they ' +
    'are about the same subject. Two questions about one subject are usually NOT the same ' +
    'question.\n\n' +
    'What is NOT a duplicate, and this is the case that matters most:\n' +
    '- A narrow follow-up on a subject a broader run already covered. "What was approved this ' +
    'year" and "has this particular application moved since March" are different questions; ' +
    'the second is worth its own run.\n' +
    '- The same shape of question asked about different subjects. Two filing-status questions ' +
    'about two different products share almost every word and share no answer.\n' +
    '- Two halves of one project that need different work: fetching pages that remain, versus ' +
    'finding a route past a block.\n\n' +
    'What IS a duplicate:\n' +
    '- The same question in different words, however little vocabulary they share.\n' +
    '- One question wholly contained in the other, so that answering the broader one answers ' +
    'the narrower too.\n\n' +
    'Answer with a confidence from 0 to 100 for each pair: 0 means plainly different questions, ' +
    '100 means one run answers both. Use the middle of the range when you are genuinely unsure ' +
    'rather than rounding to a verdict. Give a reason of at most a dozen words.\n\n' +
    'Pairs:\n' +
    pairs.map((p) => `${p.id}\n  A: ${p.a}\n  B: ${p.b}`).join('\n\n')
  )
}

export interface JudgeOptions {
  readonly vaultRoot: string
  readonly auth: AgentAuth
  readonly model?: string
  readonly timeoutMs?: number
}

/** One verdict: the score in [0, 1] and the judge's own short reason for it. */
export interface JudgeVerdict {
  readonly score: number
  readonly reason?: string
}

/**
 * Scores every pair in [0, 1]. A pair the judge did not answer for comes back as NaN rather
 * than 0: a zero is a score, and a score gets compared to a threshold.
 *
 * The reason rides along because a merge decided by a model should be able to say why - the
 * recap presents it as a judgement, not as a mechanical fact like the token overlap.
 */
export async function judgePairs(pairs: readonly JudgePair[], opts: JudgeOptions): Promise<JudgeVerdict[]> {
  if (pairs.length === 0) return []
  const result = await runAgent({
    vaultRoot: opts.vaultRoot,
    prompt: renderJudgePrompt(pairs),
    auth: opts.auth,
    // Read-only, no web: the judge needs the two sentences and nothing else.
    profile: 'query',
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
    outputFormat: { type: 'json_schema', schema: judgeSchema(pairs.map((p) => p.id)) },
  })
  if (!result.ok) throw new Error(result.error ?? 'the judge run failed')
  const parsed = answerSchema.safeParse(result.structuredOutput)
  if (!parsed.success) throw new Error(`the judge answered outside its schema: ${parsed.error.message.slice(0, 200)}`)
  const byId = new Map(parsed.data.judgements.map((j) => [j.id, { score: j.confidence / 100, reason: j.reason }]))
  return pairs.map((p) => byId.get(p.id) ?? { score: Number.NaN })
}
