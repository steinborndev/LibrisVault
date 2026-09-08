/**
 * The duplicate judge's prompt, schema and answer handling (server/src/pipeline/dedupe-judge.ts).
 *
 * The run itself is mocked, as every agent run is in tests. What is pinned is the part that
 * decides whether the judgement can be trusted: the schema that binds the answer to the pairs
 * actually asked about, and that a pair the judge skipped comes back as NaN rather than as a
 * confident zero.
 */

import { describe, it, expect, vi } from 'vitest'
import { renderJudgePrompt, judgeSchema, judgePairs } from '../src/pipeline/dedupe-judge.js'
import * as runner from '../src/pipeline/agent-runner.js'
import type { AgentRunResult } from '../src/pipeline/agent-runner.js'

const PAIRS = [
  { id: 'p1', a: 'newly approved biologics and what they treat', b: 'which new medicines cleared regulators lately' },
  { id: 'p2', a: 'has application X moved since March', b: 'has application Y moved since March' },
]

const ok = (structuredOutput: unknown): AgentRunResult => ({
  ok: true,
  result: '',
  usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.01 },
  durationMs: 1,
  numTurns: 1,
  sessionId: 's',
  timedOut: false,
  structuredOutput,
})

const opts = { vaultRoot: '/tmp/vault', auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN' as const, credential: 'x' } }

describe('the duplicate judge', () => {
  it('asks whether ONE run would serve both, not whether the topics are alike', () => {
    const prompt = renderJudgePrompt(PAIRS)
    // Similarity is precisely what the metrics that failed were measuring.
    expect(prompt).toContain('ONE research run would serve both')
    expect(prompt).toContain('not whether they are similar')
    /*
     * The two shapes every surface measure got wrong on this vault's own history, spelled out
     * because they are the expensive mistake: merging them away kills a run that should run.
     */
    expect(prompt).toContain('narrow follow-up')
    expect(prompt).toContain('different subjects')
    // Hedging is allowed on purpose: a forced verdict destroys the margin a threshold needs.
    expect(prompt).toContain('middle of the range when you are genuinely unsure')
    expect(prompt).toContain('p1\n  A: newly approved biologics')
  })

  it('binds the answer to exactly the pairs it was asked about', () => {
    const schema = judgeSchema(['p1', 'p2']) as {
      properties: { judgements: { minItems: number; maxItems: number; items: { properties: { id: { enum: string[] }; confidence: { minimum: number; maximum: number } } } } }
    }
    const j = schema.properties.judgements
    // One judgement per pair, no more and no fewer: a short answer would silently drop a pair.
    expect(j.minItems).toBe(2)
    expect(j.maxItems).toBe(2)
    expect(j.items.properties.id.enum).toEqual(['p1', 'p2'])
    expect(j.items.properties.confidence).toMatchObject({ minimum: 0, maximum: 100 })
  })

  it('scores into [0, 1] in the order it was asked', async () => {
    vi.spyOn(runner, 'runAgent').mockResolvedValue(
      ok({ judgements: [{ id: 'p2', confidence: 4, reason: 'two subjects' }, { id: 'p1', confidence: 95, reason: 'same question' }] }),
    )
    // Answered out of order, returned in the caller's order.
    expect(await judgePairs(PAIRS, opts)).toEqual([0.95, 0.04])
    vi.restoreAllMocks()
  })

  it('returns NaN for a pair the judge did not answer, never a zero', async () => {
    vi.spyOn(runner, 'runAgent').mockResolvedValue(ok({ judgements: [{ id: 'p1', confidence: 90, reason: 'same' }, { id: 'p2', confidence: 0, reason: 'x' }] }))
    const [first] = await judgePairs(PAIRS, opts)
    expect(first).toBe(0.9)
    vi.restoreAllMocks()

    // A short answer cannot pass the schema in production; if one ever does, the missing pair
    // must not read as "confidently not a duplicate".
    vi.spyOn(runner, 'runAgent').mockResolvedValue(ok({ judgements: [{ id: 'p1', confidence: 90, reason: 'same' }] }))
    const scores = await judgePairs(PAIRS, opts)
    expect(scores[0]).toBe(0.9)
    expect(Number.isNaN(scores[1]!)).toBe(true)
    vi.restoreAllMocks()
  })

  it('refuses an answer outside its schema and a failed run, rather than scoring them', async () => {
    vi.spyOn(runner, 'runAgent').mockResolvedValue(ok({ judgements: [{ id: 'p1', confidence: 'very sure', reason: 'x' }] }))
    await expect(judgePairs(PAIRS, opts)).rejects.toThrow(/outside its schema/)
    vi.restoreAllMocks()

    vi.spyOn(runner, 'runAgent').mockResolvedValue({ ...ok({}), ok: false, error: 'the model refused' })
    await expect(judgePairs(PAIRS, opts)).rejects.toThrow(/the model refused/)
    vi.restoreAllMocks()
  })

  it('asks nothing when there is nothing to ask', async () => {
    const spy = vi.spyOn(runner, 'runAgent')
    expect(await judgePairs([], opts)).toEqual([])
    expect(spy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
