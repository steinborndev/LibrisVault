/**
 * Keeping the hot cache a cache (docs/agents/SPEC.md section 6.4, validator.ts).
 *
 * `wiki/hot.md` is read at the start of every run, and the wiki skill sizes it at ~500 words,
 * overwritten each time. Two things pushed it back over that: the autoresearch skill's filing
 * step says only "update wiki/hot.md with the research summary", and in one vault the refresh
 * run - the only one that says "rewrite from scratch" - had never run at all, so the cache grew
 * from 401 to 826 words over eight research runs. So the research prompt now states the rule
 * itself, and a run whose validation finds an oversized cache queues the refresh behind it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import { hotCacheWords } from '../src/pipeline/vault-stats.js'
import { HOT_CACHE_WORD_BUDGET, type ValidationFinding } from '../src/pipeline/validator.js'
import type { AgentRunResult, RunAgentOptions } from '../src/pipeline/agent-runner.js'

const okResult = (): AgentRunResult => ({
  ok: true,
  result: 'done',
  usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
  durationMs: 1,
  numTurns: 1,
  sessionId: 's',
  timedOut: false,
})

const OVERSIZED: ValidationFinding[] = [{ rule: 'hot-cache-size', path: 'wiki/hot.md', message: 'hot cache is 826 words' }]

describe('the hot cache', () => {
  let vaultRoot: string
  let calls: RunAgentOptions[]

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki'), { recursive: true })
    calls = []
  })
  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const makeRunner = (validate: () => ValidationFinding[]): MaintenanceRunner =>
    new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex: new Mutex(),
      runAgent: async (opts) => {
        calls.push(opts)
        return okResult()
      },
      // A commit gives the run touched pages, which is what the post-run validation needs.
      commit: async () => ({ committed: true, hash: 'abc12345', committedPages: ['wiki/hot.md'] }),
      validate,
    })

  const settle = async (runner: MaintenanceRunner, id: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (runner.getRun(id)?.status !== 'running') return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('run never settled')
  }

  /** Waits for the queued refresh, which starts behind the run that found the cache oversized. */
  const waitForCalls = async (n: number): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      if (calls.length >= n) return
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('tells every research run to rewrite the cache, with the budget in words', async () => {
    const runner = makeRunner(() => [])
    const run = runner.startResearch('Sodium-ion cathodes', 'broad')
    await settle(runner, run.id)

    const prompt = calls[0]!.prompt
    expect(prompt).toContain('REWRITE wiki/hot.md from scratch')
    expect(prompt).toContain(`under ${HOT_CACHE_WORD_BUDGET} words`)
    expect(prompt).toContain('never append')
    // The skill's own step would leave the hot cache at "update". The index and the log are
    // no longer the run's at all: the service writes both afterwards (SPEC.md §12.12), so the
    // prompt says so rather than asking for work the next render overwrites.
    expect(prompt).toContain('Do not edit wiki/index.md or wiki/log.md')
    expect(prompt).toContain('from your final answer')
  })

  it('queues one refresh when a run leaves the cache oversized, and not a second that day', async () => {
    const runner = makeRunner(() => OVERSIZED)
    const first = runner.startResearch('Grid storage', 'broad')
    await settle(runner, first.id)
    await waitForCalls(2)

    expect(calls).toHaveLength(2)
    expect(calls[1]!.prompt).toContain('Rewrite wiki/hot.md from scratch')

    // The same finding on the next run does not queue another one: one oversized cache is one
    // refresh, not one per run of the night.
    const second = runner.startResearch('Iron-air chemistry', 'broad')
    await settle(runner, second.id)
    await new Promise((r) => setTimeout(r, 60))
    expect(calls).toHaveLength(3)
    expect(calls[2]!.prompt).toContain('Iron-air chemistry')
  })

  it('never queues a refresh from a refresh, however long the cache still is', async () => {
    const runner = makeRunner(() => OVERSIZED)
    const run = runner.startHotCache()
    await settle(runner, run.id)
    await new Promise((r) => setTimeout(r, 60))
    expect(calls).toHaveLength(1)
  })

  it('counts the cache in words for the card, and says nothing when there is none', () => {
    expect(hotCacheWords(vaultRoot)).toBeNull()
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'hot.md'), '# Hot Cache\n\none two three\n')
    expect(hotCacheWords(vaultRoot)).toBe(6)
  })
})
