/**
 * The page a question came from, travelling with it into a research run
 * (docs/tasks/TASKS-QUESTIONS.md, phase 1).
 *
 * The board hands a bullet to a run as its topic, and a bullet is written to be read next to
 * the page it stands on: 152 of the 355 on the measured vault refer to the run that wrote them
 * ("in this pass", "either source"), which stops meaning anything the moment it travels alone.
 * Naming the page resolves that, whatever the wording. This pins three things: the block says
 * what it should, a bad path is dropped rather than refused, and a prompt WITHOUT an origin is
 * unchanged character for character - the assertion that proves this change is additive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { renderQuestionOrigin } from '../src/pipeline/related-pages.js'
import { isWikiPagePath, resolveWikiPage } from '../src/pipeline/vault-paths.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import { MemoryAgentRunStore } from '../src/db/agent-runs.js'
import type { AgentRunResult } from '../src/pipeline/agent-runner.js'

const PAGE = 'wiki/concepts/Tidal Turbine.md'

describe('the vault page guard', () => {
  it('accepts a wiki page and nothing that could point elsewhere', () => {
    expect(isWikiPagePath(PAGE)).toBe(true)
    expect(isWikiPagePath('wiki/meta/agents/fixture.md')).toBe(true)
    expect(isWikiPagePath('wiki/../../etc/passwd')).toBe(false)
    expect(isWikiPagePath('../wiki/x.md')).toBe(false)
    expect(isWikiPagePath('/etc/passwd')).toBe(false)
    expect(isWikiPagePath('/home/user/vault/wiki/x.md')).toBe(false)
    expect(isWikiPagePath('skills/autoresearch/SKILL.md')).toBe(false)
    expect(isWikiPagePath('wiki/concepts/x.txt')).toBe(false)
    expect(isWikiPagePath('wiki\\concepts\\x.md')).toBe(false)
    expect(isWikiPagePath('')).toBe(false)
  })
})

describe('the origin block', () => {
  it('names the page and says what it is for', () => {
    const block = renderQuestionOrigin(PAGE)
    expect(block).toContain(PAGE)
    expect(block).toContain('<question_origin>')
    expect(block).toContain('</question_origin>')
    // The reason it exists: a question written to be read in place.
    expect(block).toMatch(/in this pass/i)
    // And what it is NOT: a source to summarise, or the page to extend.
    expect(block).toMatch(/not a source to summarise/i)
  })

  it('is empty without a page, so a prompt that has none is untouched', () => {
    expect(renderQuestionOrigin(undefined)).toBe('')
    expect(renderQuestionOrigin('')).toBe('')
  })
})

describe('the research prompt', () => {
  let vaultRoot: string
  let prompts: string[]

  const makeRunner = (): MaintenanceRunner => {
    prompts = []
    return new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex: new Mutex(),
      runAgent: async (opts: { prompt: string }) => {
        prompts.push(opts.prompt)
        return {
          ok: true,
          result: 'done',
          usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
          durationMs: 1,
          numTurns: 1,
          sessionId: 's',
          timedOut: false,
        } as AgentRunResult
      },
      commit: async () => ({ committed: false, committedPages: [] }),
      runStore: new MemoryAgentRunStore(),
    })
  }

  const settled = async (runner: MaintenanceRunner, id: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      const run = runner.getRun(id)
      if (run !== undefined && run.status !== 'running') return
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('run never settled')
  }

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki/concepts'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, PAGE), '# Tidal Turbine\n\n## Open questions\n\n- Not measured in this pass.\n')
  })
  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('finds the page on disk, or reports none', () => {
    expect(resolveWikiPage(vaultRoot, PAGE)).toBe(path.join(vaultRoot, PAGE))
    expect(resolveWikiPage(vaultRoot, 'wiki/concepts/Absent.md')).toBeNull()
    expect(resolveWikiPage(vaultRoot, 'wiki/concepts')).toBeNull()
    expect(resolveWikiPage(vaultRoot, '../../etc/passwd')).toBeNull()
  })

  it('carries the origin block when the topic came from a page', async () => {
    const runner = makeRunner()
    const run = runner.startResearch('blade fatigue under sediment loading', 'broad', undefined, { from: PAGE })
    await settled(runner, run.id)
    expect(prompts[0]).toContain('<question_origin>')
    expect(prompts[0]).toContain(PAGE)
  })

  it('is byte-identical to a prompt with no origin when the path is unusable', async () => {
    const runner = makeRunner()
    const topic = 'blade fatigue under sediment loading'
    const plain = runner.startResearch(topic, 'broad')
    await settled(runner, plain.id)
    const baseline = prompts[0]!
    expect(baseline).not.toContain('<question_origin>')

    // Every way a path can fail: outside the wiki, escaping it, absolute, and simply absent.
    for (const bad of ['skills/x.md', 'wiki/../../etc/passwd', '/etc/passwd', 'wiki/concepts/Absent.md', '']) {
      const r2 = makeRunner()
      const run = r2.startResearch(topic, 'broad', undefined, { from: bad })
      await settled(r2, run.id)
      expect(prompts[0], `path ${JSON.stringify(bad)} must leave the prompt untouched`).toBe(baseline)
    }
  })

  it('puts the origin before the overlap rules and keeps the synthesis mandate last', async () => {
    // The overlap block only renders when the vault has a page whose title shares the topic's
    // tokens, which the fixture page does.
    const runner = makeRunner()
    const run = runner.startResearch('tidal turbine blades', 'broad', undefined, { from: PAGE })
    await settled(runner, run.id)
    const prompt = prompts[0]!
    const origin = prompt.indexOf('<question_origin>')
    const overlap = prompt.indexOf('The vault ALREADY holds pages')
    const mandate = prompt.indexOf('<synthesis_page>')
    expect(origin).toBeGreaterThan(-1)
    expect(overlap).toBeGreaterThan(-1)
    expect(origin).toBeLessThan(overlap)
    expect(mandate).toBeGreaterThan(overlap)
  })
})
