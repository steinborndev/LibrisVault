/**
 * Turning an open question into a topic a run can act on
 * (docs/tasks/TASKS-QUESTIONS.md, phase 2).
 *
 * Everything here is the prompt, the schema and the failure behaviour; the SDK call is mocked
 * throughout. The property the callers lean on hardest is the last describe block: this returns
 * null for every way it can go wrong and never throws, because it improves an action that has
 * to keep working without it (decision D3).
 *
 * Every question in this file is invented (hard rule 7).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanTitle,
  EXCERPT_MAX_CHARS,
  readPageExcerpt,
  reformulate,
  renderTopicPrompt,
  TITLE_BUDGET,
  topicSchema,
  TOPIC_MAX_CHARS,
} from '../src/pipeline/question-topic.js'
import { RESEARCH_PREFIX, RESEARCH_PROFILES, TITLE_MAX_CHARS, researchTargetTitle } from '../src/pipeline/research-profiles.js'
import type { AgentRunResult, RunAgentOptions } from '../src/pipeline/agent-runner.js'
import { sentenceCount } from '../src/cli/questiontopic-eval.js'

const NOTE = 'No source in this pass gives an installed-cost figure per megawatt for a rack-mounted array.'
const PAGE = 'wiki/concepts/Tidal Turbine.md'
const auth = { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' } as const

const answer = (structuredOutput: unknown): AgentRunResult =>
  ({
    ok: true,
    result: JSON.stringify(structuredOutput),
    structuredOutput,
    usage: { tokensIn: 900, tokensOut: 60, costUsd: 0.004 },
    durationMs: 1,
    numTurns: 1,
    sessionId: 's',
    timedOut: false,
  }) as AgentRunResult

describe('the prompt', () => {
  it('carries the note, the page and the rules each defect earned', () => {
    const prompt = renderTopicPrompt({ text: NOTE, page: PAGE })
    expect(prompt).toContain(NOTE)
    expect(prompt).toContain(PAGE)
    // The deixis list comes from the shared vocabulary, not from a second list written here.
    expect(prompt).toContain('"this pass"')
    expect(prompt).toContain('"either source"')
    // Ask something; keep the reason in brackets; two caps; no prefix on the title.
    expect(prompt).toMatch(/END THE SENTENCE WITH A QUESTION MARK/)
    // The reason the note stayed open is kept, but BEFORE the question mark: the two rules
    // fought each other in the first measured run, and 7 of 10 answers that read as proper
    // questions were scored as not asking because the bracket came last.
    expect(prompt).toMatch(/in brackets just BEFORE the question mark/)
    expect(prompt).toContain(String(TOPIC_MAX_CHARS))
    expect(prompt).toContain(String(TITLE_BUDGET))
    expect(prompt).toContain(RESEARCH_PREFIX.trim())
  })

  it('leaves out what it does not have', () => {
    const prompt = renderTopicPrompt({ text: NOTE })
    expect(prompt).toContain(NOTE)
    expect(prompt).not.toContain('It stands on this page')
  })

  it('states the caps the schema binds, so prompt and schema cannot disagree', () => {
    const schema = topicSchema() as {
      properties: { topic: { maxLength: number }; title: { maxLength: number } }
      required: string[]
    }
    expect(schema.properties.topic.maxLength).toBe(TOPIC_MAX_CHARS)
    expect(schema.properties.title.maxLength).toBe(TITLE_BUDGET)
    expect(schema.required).toEqual(['topic', 'title'])
  })

  it('computes the title budget from what a page name has left over', () => {
    // Prefix plus the longest lens suffix; not a number somebody picked.
    const longest = Math.max(...RESEARCH_PROFILES.map((p) => p.titleSuffix.length))
    expect(TITLE_BUDGET).toBe(TITLE_MAX_CHARS - RESEARCH_PREFIX.length - longest)
    // And a title that fits it survives every lens without being cut.
    const title = 'T'.repeat(TITLE_BUDGET)
    for (const p of RESEARCH_PROFILES) {
      expect(researchTargetTitle(p, 'ignored', title).length).toBeLessThanOrEqual(TITLE_MAX_CHARS)
    }
  })
})

describe('the page excerpt', () => {
  let vaultRoot: string
  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki/concepts'), { recursive: true })
    fs.writeFileSync(
      path.join(vaultRoot, PAGE),
      '---\ntitle: Tidal Turbine\n---\n\n# Tidal Turbine\n\nA rotor driven by tidal flow.\n\n## Open questions\n\n- ' +
        NOTE +
        '\n',
    )
  })
  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('names the page and carries its opening and its questions', () => {
    const excerpt = readPageExcerpt(vaultRoot, PAGE)
    expect(excerpt).toBeDefined()
    expect(excerpt).toContain('Tidal Turbine')
    expect(excerpt).toContain('A rotor driven by tidal flow')
    expect(excerpt).toContain('installed-cost figure')
    expect(excerpt).not.toContain('---')
  })

  it('is bounded, whatever the page weighs', () => {
    const huge = 'wiki/concepts/Huge.md'
    fs.writeFileSync(path.join(vaultRoot, huge), '# Huge\n\n' + 'x'.repeat(400_000))
    const excerpt = readPageExcerpt(vaultRoot, huge)
    expect(excerpt!.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS * 2)
  })

  it('reports none for a path it must not read', () => {
    expect(readPageExcerpt(vaultRoot, '../../etc/passwd')).toBeUndefined()
    expect(readPageExcerpt(vaultRoot, 'skills/x.md')).toBeUndefined()
    expect(readPageExcerpt(vaultRoot, 'wiki/concepts/Absent.md')).toBeUndefined()
  })
})

describe('the title the answer gives back', () => {
  it('strips a prefix the model added for us', () => {
    expect(cleanTitle('Research - Tidal Turbine Costs')).toBe('Tidal Turbine Costs')
    expect(cleanTitle('Research: Tidal Turbine Costs')).toBe('Tidal Turbine Costs')
    expect(cleanTitle('Tidal Turbine Costs')).toBe('Tidal Turbine Costs')
  })

  it('makes it safe to be a file name', () => {
    expect(cleanTitle('Cost/MW of tidal arrays')).toBe('Cost-MW of tidal arrays')
    expect(cleanTitle('Tidal: the cost question?')).toBe('Tidal - the cost question')
  })
})

describe('the eval harness sentence heuristic', () => {
  /*
   * It cost a false failure on the first measured 30-question sample: one topic was scored as
   * two sentences because a name carried a middle initial, and a stop after a single capital
   * is an initial or an abbreviation, not a sentence end. Names here are invented (hard rule 7).
   */
  it('does not read an initial or an abbreviation as a sentence end', () => {
    expect(sentenceCount('Does A. B. Halvorsen\'s group use the term in its published work?')).toBe(1)
    expect(sentenceCount('What is the U.S. market share of rack-mounted tidal arrays?')).toBe(1)
  })

  it('still counts real sentences', () => {
    expect(sentenceCount('What is the capacity factor?')).toBe(1)
    expect(sentenceCount('What is the capacity factor? And what does it cost?')).toBe(2)
    expect(sentenceCount('First point. Second point. Third point.')).toBe(3)
    expect(sentenceCount('   ')).toBe(0)
  })
})

describe('reformulating', () => {
  const vaultRoot = '/tmp/does-not-need-to-exist'
  const good = { topic: 'What is the installed cost per megawatt of rack-mounted tidal arrays?', title: 'Tidal Array Installed Cost' }

  it('returns the suggestion, read-only and with no web', async () => {
    let seen: RunAgentOptions | undefined
    const out = await reformulate(
      { text: NOTE },
      {
        vaultRoot,
        auth,
        run: async (opts) => {
          seen = opts
          return answer(good)
        },
      },
    )
    expect(out).toEqual(good)
    expect(seen?.profile).toBe('query')
    expect(seen?.outputFormat).toEqual({ type: 'json_schema', schema: topicSchema() })
    expect(seen?.timeoutMs).toBeGreaterThan(0)
  })

  it('names the page only when it could be read', async () => {
    // A path that resolves to nothing is a claim the run cannot check, and it arrives from a
    // request body. The excerpt and the name travel together or not at all.
    let prompt = ''
    const run = async (opts: RunAgentOptions): Promise<AgentRunResult> => {
      prompt = opts.prompt
      return answer(good)
    }
    await reformulate({ text: NOTE, page: 'wiki/concepts/Absent.md' }, { vaultRoot, auth, run })
    expect(prompt).not.toContain('It stands on this page')
    expect(prompt).not.toContain('Absent.md')
    await reformulate({ text: NOTE, page: PAGE, pageExcerpt: 'Page "Tidal Turbine": a rotor.' }, { vaultRoot, auth, run })
    expect(prompt).toContain('It stands on this page')
    expect(prompt).toContain('a rotor')
  })

  it('never calls out for an empty note', async () => {
    let called = false
    const out = await reformulate(
      { text: '   ' },
      {
        vaultRoot,
        auth,
        run: async () => {
          called = true
          return answer(good)
        },
      },
    )
    expect(out).toBeNull()
    expect(called).toBe(false)
  })

  it('returns null for every way the answer can be wrong', async () => {
    const bad: unknown[] = [
      { topic: 'x'.repeat(TOPIC_MAX_CHARS + 1), title: 'Fine' },
      { topic: 'What is the cost?' },
      { title: 'Only a title' },
      { topic: 'What is the cost?', title: 'T'.repeat(TITLE_BUDGET + 1) },
      { topic: '', title: 'Fine' },
      { topic: 'What is the cost?', title: '   ' },
      'not an object',
      null,
      undefined,
    ]
    for (const out of bad) {
      expect(await reformulate({ text: NOTE }, { vaultRoot, auth, run: async () => answer(out) })).toBeNull()
    }
  })

  it('returns null when the title survives cleaning as nothing usable', async () => {
    expect(
      await reformulate({ text: NOTE }, { vaultRoot, auth, run: async () => answer({ topic: 'What is the cost?', title: '...' }) }),
    ).toBeNull()
  })

  it('returns null when the run fails, times out, or throws', async () => {
    const failed = { ...answer(good), ok: false, error: 'the run exploded' } as AgentRunResult
    expect(await reformulate({ text: NOTE }, { vaultRoot, auth, run: async () => failed })).toBeNull()
    expect(
      await reformulate({ text: NOTE }, { vaultRoot, auth, run: async () => ({ ...answer(good), timedOut: true, ok: false }) as AgentRunResult }),
    ).toBeNull()
    expect(
      await reformulate({
        text: NOTE,
      }, {
        vaultRoot,
        auth,
        run: async () => {
          throw new Error('the SDK went away')
        },
      }),
    ).toBeNull()
  })
})
