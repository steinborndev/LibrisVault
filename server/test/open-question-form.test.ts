/**
 * The form rule, and the three kinds of run that have to carry it
 * (docs/tasks/TASKS-QUESTIONS.md, phase 3).
 *
 * Phases 1 and 2 repair a question on its way OUT of the vault, one at a time and for a metered
 * call each. This is the other side: what a run writes in the first place. The rule reaches a
 * run through `systemPromptExtra` only, because the vault's own template belongs to the vault
 * (hard rule 5), and it is NOT gated on `AGENTS_ENABLED` - an ingest writes an open-questions
 * section too, and the flag off must change nothing in either direction (hard rule 8).
 *
 * The block's content is asserted against the numbers that earned each rule, so a later edit
 * that drops one has to argue with a measurement rather than with a preference.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OPEN_QUESTION_FORM } from '../src/pipeline/system-prompt.js'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue, type IngestRunner } from '../src/pipeline/queue.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import type { AgentRunResult } from '../src/pipeline/agent-runner.js'
import { asksAQuestion, hasPassDeixis, classifyQuestion, PASS_DEIXIS } from '../src/pipeline/question-form.js'

/** The two examples the block carries, pulled back out of it. */
const examples = (): { before: string; after: string } => {
  const [, before = '', after = ''] = /So instead of:\n\s*- ([\s\S]*?)\nwrite:\n\s*- ([\s\S]*?)\n<\/open_questions>/.exec(OPEN_QUESTION_FORM) ?? []
  return { before: before.replace(/\s+/g, ' ').trim(), after: after.replace(/\s+/g, ' ').trim() }
}

describe('the open-question form block', () => {
  it('states every rule its own measurement earned', () => {
    // 29 of 355 asked anything (phase 0).
    expect(OPEN_QUESTION_FORM).toMatch(/end the sentence with a question mark/i)
    // 152 of 355 pointed back at the run that wrote them.
    expect(OPEN_QUESTION_FORM).toContain('"in this pass"')
    expect(OPEN_QUESTION_FORM).toContain('"either source"')
    // 32 near-duplicate clusters, every one of them spanning more than one page.
    expect(OPEN_QUESTION_FORM).toMatch(/do not copy the same question onto\s+several pages/i)
    // The bracket goes BEFORE the question mark: the phase 2 lesson, where the opposite rule
    // cost 7 of 10 otherwise perfect questions their question mark.
    expect(OPEN_QUESTION_FORM).toMatch(/in brackets just BEFORE the question\s+mark/)
  })

  it('states no character limit, because length is not the defect', () => {
    // Phase 2 measured the reformulated questions LONGER than the notes they replaced (median
    // 351 against 247): spelling a name out and keeping the reason costs characters.
    expect(OPEN_QUESTION_FORM).not.toMatch(/\b\d{2,}\s*characters\b/i)
  })

  it('carries a worked example that obeys its own rules', () => {
    const { before, after } = examples()
    expect(before).not.toBe('')
    expect(after).not.toBe('')
    // The "before" is the defect: a limitation note that points at this run.
    expect(classifyQuestion(before)).toBe('limitation')
    expect(hasPassDeixis(before)).toBe(true)
    // The "after" is what the rule asks for, judged by the same functions the audit and the
    // validator use. A block whose own example fails the check is worse than no block.
    expect(asksAQuestion(after)).toBe(true)
    expect(hasPassDeixis(after)).toBe(false)
    expect(classifyQuestion(after)).toBe('question')
  })

  it('quotes the deixis it forbids, and forbids what the shared list knows', () => {
    // The block has to NAME these to rule them out, so it cannot be deixis-free itself. What it
    // must not do is drift from the list the audit counts with and the validator will flag with.
    // By phrase, not by exact quoting: the block writes "in this pass" where the list calls it
    // "this pass", and reading naturally is worth more here than matching a constant's spelling.
    const named = PASS_DEIXIS.filter((d) => OPEN_QUESTION_FORM.includes(d.name))
    expect(named.map((d) => d.name)).toEqual(expect.arrayContaining(['this pass', 'this step', 'either source', 'above']))
  })
})

/**
 * The rule has to reach every run that can write the section, which is three prompt-building
 * sites in two files. A rule that only an ingest carries would leave every research run writing
 * the old shape, and the pinboard fills mostly from research runs.
 *
 * Nothing here is gated on `AGENTS_ENABLED`: these are base-product runs, they are built with
 * no Fellow anywhere in the picture, and they carry the block all the same.
 */
describe('the runs that carry it', () => {
  let db: Db
  let vaultRoot: string

  const ok = (): AgentRunResult =>
    ({
      ok: true,
      result: 'done',
      usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
      messages: [],
      durationMs: 1,
      numTurns: 1,
      sessionId: 's',
      timedOut: false,
    }) as AgentRunResult

  beforeEach(() => {
    db = openDb(MEMORY_DB)
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oqf-'))
    for (const dir of ['wiki/concepts', 'wiki/questions', '.raw']) fs.mkdirSync(path.join(vaultRoot, dir), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki/index.md'), '# Wiki Index\n')
  })
  afterEach(() => {
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  /** Runs files through the queue and returns the systemPromptExtra the runner saw. */
  async function ingest(names: readonly string[]): Promise<string | undefined> {
    let seen: string | undefined
    const runIngest: IngestRunner = async (opts) => {
      seen = opts.systemPromptExtra
      return ok()
    }
    const queue = new IngestQueue({
      store: new JobStore(db),
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 1,
      detectToolsFn: async () => ({}) as never,
      commit: async () => ({ committed: true, hash: 'abc', committedPages: [] }),
      refreshHotCache: async () => '',
      runIngest,
    })
    queue.start()
    for (const [i, name] of names.entries()) {
      const src = path.join(vaultRoot, name)
      fs.writeFileSync(src, `hello ${i}`)
      await queue.enqueueFile({ sourcePath: src, source: 'drop' })
    }
    await queue.onIdle()
    queue.stop()
    return seen
  }

  it('an ingest run carries it', async () => {
    expect(await ingest(['one.md'])).toContain('<open_questions>')
  })

  it('a batch ingest carries it', async () => {
    // Two files dropped together are one run with one lead job, built by the other site.
    expect(await ingest(['one.md', 'two.md'])).toContain('<open_questions>')
  })

  it('a research run carries it, with no Fellow in sight', async () => {
    let seen: string | undefined
    const runner = new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex: new Mutex(),
      runAgent: async (opts) => {
        seen = opts.systemPromptExtra
        return ok()
      },
      commit: async () => ({ committed: false, committedPages: [] }),
    })
    const run = runner.startResearch('tidal turbines', 'broad')
    for (let i = 0; i < 400 && runner.getRun(run.id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 5))
    expect(seen).toContain('<open_questions>')
    // Beside the blocks it has always carried, not instead of one of them.
    expect(seen).toContain('<page_hygiene>')
    expect(seen).toContain('<entity_notability>')
  })
})
