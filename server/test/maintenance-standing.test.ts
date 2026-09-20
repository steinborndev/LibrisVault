/**
 * Maintenance runs keep the standing defect list (found 2026-09-20).
 *
 * Until this, only `queue.ts` did. A lint, a lint-fix, a repair or a research run validated
 * the pages it wrote and logged the findings, but recorded none of them and cleared none: the
 * list moved only when an ingest happened to touch the same page. Measured the day it was
 * found, 20 of the 44 standing findings had already been repaired on disk - two of them by a
 * lint-fix an hour earlier that had no way to say so. A list that reports repaired defects is
 * the same failure A9 set out to end, running the other way.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { ValidationStore } from '../src/db/validation.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import type { AgentRunResult } from '../src/pipeline/agent-runner.js'
import type { ValidationFinding } from '../src/pipeline/validator.js'

let vaultRoot: string
let db: Db
let validation: ValidationStore

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

const PAGE = 'wiki/concepts/Subject.md'

/** A runner whose validator answers whatever the test sets, over the pages the run committed. */
const makeRunner = (findingsFor: () => ValidationFinding[]): MaintenanceRunner =>
  new MaintenanceRunner({
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    events: new EventBus(),
    commitMutex: new Mutex(),
    runAgent: async () => ok(),
    commit: async () => ({ committed: true, hash: 'abc1234', committedPages: [PAGE] }),
    validate: findingsFor,
    validation,
  })

const settle = async (runner: MaintenanceRunner, id: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (runner.getRun(id)?.status !== 'running') return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('run never settled')
}

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-standing-'))
  fs.mkdirSync(path.join(vaultRoot, 'wiki/concepts'), { recursive: true })
  fs.writeFileSync(path.join(vaultRoot, PAGE), '# Subject\n')
  db = openDb(MEMORY_DB)
  validation = new ValidationStore(db)
})
afterEach(() => {
  db.close()
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

describe('a maintenance run and the standing list', () => {
  const defect: ValidationFinding = { rule: 'em-dash', path: PAGE, message: '3 em-dashes in prose' }

  it('records what it finds, so a defect a maintenance run introduces is on the list', async () => {
    const runner = makeRunner(() => [defect])
    const run = runner.startHotCache()
    await settle(runner, run.id)
    expect(validation.list().map((f) => [f.rule, f.path])).toEqual([['em-dash', PAGE]])
  })

  it('clears what it no longer finds, so a repair becomes visible', async () => {
    // First run leaves the defect standing.
    const dirty = makeRunner(() => [defect])
    await settle(dirty, dirty.startHotCache().id)
    expect(validation.list()).toHaveLength(1)

    // A second run over the same page reports nothing: the defect is repaired.
    const clean = makeRunner(() => [])
    await settle(clean, clean.startHotCache().id)
    expect(validation.list()).toEqual([])
  })

  it('counts a repeat rather than stacking it up', async () => {
    const runner = makeRunner(() => [defect])
    await settle(runner, runner.startHotCache().id)
    await settle(runner, runner.startHotCache().id)
    const standing = validation.list()
    expect(standing).toHaveLength(1)
    expect(standing[0]!.count).toBe(2)
  })

  it('leaves a defect on a page this run never touched', async () => {
    const elsewhere: ValidationFinding = { rule: 'em-dash', path: 'wiki/concepts/Other.md', message: 'x' }
    validation.record([elsewhere], null)
    const runner = makeRunner(() => [])
    await settle(runner, runner.startHotCache().id)
    // The run committed one page; a finding on another page is not its to clear.
    expect(validation.list().map((f) => f.path)).toEqual(['wiki/concepts/Other.md'])
  })
})
