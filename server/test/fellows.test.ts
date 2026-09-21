/**
 * Milestone A0 (docs/tasks/TASKS-A0.md): the Fellow record and store, the notebook page,
 * the service's spawn / step gate / settle handling against a real git vault with a fake
 * agent, and the routes. Acceptance: spawn a Fellow, the first run and one manual step show
 * up in the notebook and in the run log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { MemoryAgentStore, SqliteAgentStore, slugify, type AgentRecord } from '../src/db/agents.js'
import { MemoryAgentRunStore, SqliteAgentRunStore, type AgentRunRecord } from '../src/db/agent-runs.js'
import { MemoryProposalStore, SqliteProposalStore } from '../src/db/proposals.js'
import { renderNotebook, parseNotebook, readBackNotebook, notebookPath, NotebookWriter } from '../src/pipeline/notebook.js'
import { UNSAFE_TITLE_CHARS } from '../src/pipeline/validator.js'
import { STATUS_VOCABULARY } from '../src/pipeline/page-dates.js'
import { FellowService, localDate, DESK_COUNT } from '../src/pipeline/fellows.js'
import { windowAt } from '../src/pipeline/clock.js'
import { DEFAULT_NIGHT_WINDOW } from '../src/db/settings.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { buildServer } from '../src/api/server.js'
import type { Config } from '../src/config.js'
import type { AgentRunResult, RunAgentOptions } from '../src/pipeline/agent-runner.js'

const okResult = (text: string): AgentRunResult => ({
  ok: true,
  result: text,
  usage: { tokensIn: 12, tokensOut: 3, costUsd: 0.5 },
  durationMs: 1,
  numTurns: 1,
  sessionId: 's',
  timedOut: false,
})

const agentRecord = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: 'a1',
  name: 'Ada',
  slug: 'ada',
  intent: 'How far can ground-based transit photometry constrain atmospheric retrievals?',
  scope: null,
  tasks: [{ id: 't1', text: 'How far can ground-based transit photometry constrain atmospheric retrievals?', kind: 'explore', state: 'active' }],
  taskCursor: 0,
  homeDomain: 'astronomy',
  extraDomains: [],
  lens: 'broad',
  model: 'sonnet-5',
  effort: 'high',
  step: 'standard',
  quotaRunsPerDay: 1,
  quotaWeekPct: null,
  autonomy: 'veto',
  art: 'custom',
  nightly: 'sweep',
  priority: 0,
  state: 'proposed',
  sleepReason: null,
  sleepCode: null,
  skipUntil: null,
  notebookPath: notebookPath('ada'),
  createdAt: '2026-09-06T08:00:00.000Z',
  updatedAt: '2026-09-06T08:00:00.000Z',
  desk: null,
  retiredAt: null,
  ...over,
})

/** The cycle date of the night a plan started now belongs to: the window's own morning after. */
const nightAheadDate = (): string => {
  const at = windowAt(new Date(), DEFAULT_NIGHT_WINDOW)
  return (at.current ?? at.next).cycleDate
}

const runRecord = (over: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
  id: 'r1',
  kind: 'research-step',
  label: 'Limb darkening',
  profileKey: 'broad',
  ok: true,
  pages: ['wiki/questions/Research: Limb darkening.md'],
  tokensIn: 100,
  tokensOut: 10,
  costUsd: 2.1,
  error: null,
  commitHash: 'abc',
  startedAt: '2026-09-06T09:00:00.000Z',
  finishedAt: '2026-09-06T09:12:00.000Z',
  agentId: 'a1',
  model: 'claude-sonnet-5',
  ...over,
})

describe('slugify', () => {
  it('makes a filename-safe, unique-enough slug', () => {
    expect(slugify('Ada Lovelace')).toBe('ada-lovelace')
    expect(slugify('  Müller & Söhne  ')).toBe('muller-sohne')
    expect(slugify('***')).toBe('fellow')
    expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(48)
  })
})

describe('SqliteAgentStore', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(MEMORY_DB)
  })
  afterEach(() => {
    db.close()
  })

  it('creates, reads by id and slug, lists retired last, updates and removes', () => {
    const store = new SqliteAgentStore(db)
    store.create(agentRecord())
    store.create(agentRecord({ id: 'a2', name: 'Noor', slug: 'noor', state: 'retired', createdAt: '2026-09-05T08:00:00.000Z' }))
    expect(store.get('a1')?.name).toBe('Ada')
    expect(store.bySlug('noor')?.id).toBe('a2')
    expect(store.list().map((a) => a.id)).toEqual(['a1', 'a2'])
    const updated = store.update('a1', { state: 'sleeping', sleepReason: 'nothing planned', model: 'opus-5' }, '2026-09-06T10:00:00.000Z')
    expect(updated).toMatchObject({ state: 'sleeping', model: 'opus-5', updatedAt: '2026-09-06T10:00:00.000Z' })
    expect(store.get('a1')?.extraDomains).toEqual([])
    expect(store.remove('a2')).toBe(true)
    expect(store.list()).toHaveLength(1)
  })

  it('refuses a second Fellow with the same slug', () => {
    const store = new SqliteAgentStore(db)
    store.create(agentRecord())
    expect(() => store.create(agentRecord({ id: 'dup' }))).toThrow()
  })

  it('the run log filters by Fellow and by start time', () => {
    const runs = new SqliteAgentRunStore(db)
    runs.record(runRecord())
    runs.record(runRecord({ id: 'r2', agentId: 'other', startedAt: '2026-09-06T11:00:00.000Z', finishedAt: '2026-09-06T11:05:00.000Z' }))
    runs.record(runRecord({ id: 'r0', startedAt: '2026-09-05T09:00:00.000Z', finishedAt: '2026-09-05T09:10:00.000Z' }))
    expect(runs.list({ agentId: 'a1' }).map((r) => r.id)).toEqual(['r1', 'r0'])
    expect(runs.list({ agentId: 'a1', since: '2026-09-06T00:00:00.000Z' }).map((r) => r.id)).toEqual(['r1'])
    expect(runs.list({ agentId: 'a1' })[0]).toMatchObject({ model: 'claude-sonnet-5', agentId: 'a1' })
  })
})

describe('notebook page', () => {
  it('renders frontmatter, title and the six sections', () => {
    const md = renderNotebook({ agent: agentRecord(), runs: [runRecord()], now: '2026-09-06T12:00:00.000Z' })
    expect(md.startsWith('---\ntype: meta\n')).toBe(true)
    expect(md).toContain('title: "Ada"')
    expect(md).toContain('updated: 2026-09-06')
    expect(md).toContain('agent_id: a1')
    for (const s of ['## Intent', '## Scope', '## Plan', '## Log', '## Open Questions', '## Notes']) expect(md).toContain(s)
    expect(md).toContain('2026-09-06 · research-step · Limb darkening · 1 page(s) · 2.10 USD')
  })

  /*
   * The page this writer produces has to pass the rules the service itself applies to a vault
   * page. It did not: `title: "Fellow: Ada"` beside a file called `ada.md` is the title-name
   * defect, and `status: active` is outside the vault's vocabulary. Both were written on every
   * notebook for weeks and surfaced only when a maintenance run happened to touch the pages.
   */
  it('writes a title a file name can carry, and a status the vault knows', () => {
    const md = renderNotebook({ agent: agentRecord(), runs: [], now: '2026-09-06T12:00:00.000Z' })
    const title = /^title: "(.*)"$/m.exec(md)?.[1] ?? ''
    expect(title).not.toBe('')
    expect(UNSAFE_TITLE_CHARS.test(title)).toBe(false)
    const status = /^status: (.*)$/m.exec(md)?.[1] ?? ''
    expect(STATUS_VOCABULARY.has(status)).toBe(true)
    expect(parseNotebook(md).sections.get('Intent')).toBe(agentRecord().intent)
  })

  it('keeps what the page owns and re-renders what the service owns', () => {
    const first = renderNotebook({ agent: agentRecord(), runs: [] })
    const edited = first
      .replace(agentRecord().intent, 'A narrower question the user typed in Obsidian')
      .replace('- (none yet)', '- Which surveys publish raw light curves?')
      .replace('(yours)', 'my own remark')
    const second = renderNotebook({ agent: agentRecord(), runs: [runRecord()], existing: edited })
    const sections = parseNotebook(second).sections
    expect(sections.get('Intent')).toBe('A narrower question the user typed in Obsidian')
    expect(sections.get('Open Questions')).toBe('- Which surveys publish raw light curves?')
    // A run appends below the placeholder; the placeholder must not survive the next render.
    const appended = second.replace('- Which surveys publish raw light curves?', '- (none yet)\n- Which surveys publish raw light curves?')
    expect(parseNotebook(renderNotebook({ agent: agentRecord(), runs: [], existing: appended })).sections.get('Open Questions')).toBe('- Which surveys publish raw light curves?')
    expect(sections.get('Notes')).toBe('my own remark')
    expect(sections.get('Log')).toContain('research-step · Limb darkening')
    expect(readBackNotebook(edited)).toEqual({ intent: 'A narrower question the user typed in Obsidian' })
  })
})

describe('FellowService against a git vault', () => {
  let vaultRoot: string
  let db: Db
  let calls: RunAgentOptions[]
  let agentOk: boolean
  let runner: MaintenanceRunner
  let service: FellowService
  const git = (...args: string[]): string => execFileSync('git', ['-C', vaultRoot, ...args], { encoding: 'utf8' })

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fellows-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'index.md'), '# index\n')
    git('init', '-q')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed')
    db = openDb(MEMORY_DB)
    calls = []
    agentOk = true
    const commitMutex = new Mutex()
    const runs = new SqliteAgentRunStore(db)
    runner = new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex,
      runAgent: async (opts) => {
        calls.push(opts)
        return agentOk ? okResult('filed 3 pages') : ({ ...okResult(''), ok: false, error: 'agent exploded' } as AgentRunResult)
      },
      commit: async () => ({ committed: true, hash: 'abc12345', committedPages: ['wiki/questions/Research: Q.md'] }),
      runStore: runs,
    })
    service = new FellowService({
      agents: new SqliteAgentStore(db),
      runs,
      proposals: new SqliteProposalStore(db),
      maintenance: runner,
      notebook: new NotebookWriter({ vaultRoot, commitMutex }),
    })
  })
  afterEach(() => {
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const waitSettled = async (id: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      const run = runner.getRun(id)
      if (run !== undefined && run.status !== 'running') {
        await service.flush()
        return
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('run never settled')
  }

  it('spawns: record, committed notebook, and the intent as a first full run pinned to the model', async () => {
    const { agent, run, refusal } = await service.spawn({ name: 'Ada', intent: agentRecord().intent, homeDomain: 'astronomy', model: 'opus-5', quotaRunsPerDay: 2 })
    expect(refusal).toBeUndefined()
    expect(agent).toMatchObject({ slug: 'ada', state: 'active', model: 'opus-5', notebookPath: 'wiki/meta/agents/ada.md' })
    expect(run).toMatchObject({ kind: 'research', label: agentRecord().intent, agentId: agent!.id, model: 'claude-opus-5' })
    expect(fs.existsSync(path.join(vaultRoot, 'wiki/meta/agents/ada.md'))).toBe(true)
    expect(git('log', '--format=%s')).toContain('fellow: notebook of Ada')

    await waitSettled(run!.id)
    const [call] = calls
    expect(call).toMatchObject({ profile: 'research', model: 'claude-opus-5', effort: 'high', maxBudgetUsd: 30 })
    expect(call!.prompt).toContain('<fellow>')
    expect(call!.prompt).toContain('wiki/meta/agents/ada.md')
    expect(call!.prompt).not.toContain('<research_step>')

    const card = service.card(agent!.id)!
    expect(card.agent.state).toBe('sleeping')
    expect(card.runs).toHaveLength(1)
    expect(card.runs[0]).toMatchObject({ kind: 'research', agentId: agent!.id, model: 'claude-opus-5', ok: true })
    expect(card.pages).toEqual(['wiki/questions/Research: Q.md'])
    expect(card.quota).toEqual({ runsPerDay: 2, used: 1 })
    const notebook = fs.readFileSync(path.join(vaultRoot, 'wiki/meta/agents/ada.md'), 'utf8')
    expect(notebook).toContain('research · ' + agentRecord().intent)
    expect(notebook).toContain('1 page(s) · 0.50 USD')
  })

  it('seats every Fellow at its own desk: the lowest free one, freed by retirement and taken again', async () => {
    const spawn = (name: string): ReturnType<FellowService['spawn']> => service.spawn({ name, intent: 'Standing work', homeDomain: 'astronomy', runFirstStep: false })
    const a = (await spawn('Ada')).agent!
    const b = (await spawn('Bo')).agent!
    expect([a.desk, b.desk]).toEqual([0, 1])
    // The record and the scene say the same desk.
    expect(service.list().map((f) => [f.agent.name, f.agent.desk])).toEqual([['Ada', 0], ['Bo', 1]])
    const retired = await service.retire(a.id)
    expect(retired?.desk).toBeNull()
    // The desk a retirement freed is the next one taken - the room never keeps a gap standing.
    const c = (await spawn('Cy')).agent!
    expect(c.desk).toBe(0)
    expect(service.list().filter((f) => f.agent.state !== 'retired').map((f) => f.agent.desk)).toEqual([1, 0])
  })

  it('refuses the eleventh Fellow while every desk is taken, and seats it after a retirement', async () => {
    const spawn = (name: string): ReturnType<FellowService['spawn']> => service.spawn({ name, intent: 'Standing work', homeDomain: 'astronomy', runFirstStep: false })
    const seated: AgentRecord[] = []
    for (let n = 0; n < DESK_COUNT; n++) seated.push((await spawn(`Fellow ${n}`)).agent!)
    expect(seated.map((f) => f.desk)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const full = await spawn('One too many')
    expect(full.agent).toBeUndefined()
    expect(full.refusal).toMatchObject({ status: 409, code: 'full' })
    expect(full.refusal!.error).toContain('every desk is taken')
    // Nothing was created for the refused one: no record, no notebook.
    expect(service.list()).toHaveLength(DESK_COUNT)
    expect(fs.existsSync(path.join(vaultRoot, 'wiki/meta/agents/one-too-many.md'))).toBe(false)
    await service.retire(seated[4]!.id)
    const next = await spawn('Not too many')
    expect(next.refusal).toBeUndefined()
    expect(next.agent?.desk).toBe(4)
  })

  /*
   * Run first, then plan (2026-09-14). The plan is only worth having once the run has been -
   * its candidates are what the run just wrote down - and having it before the night opens is
   * what buys the Fellow a night: the proposals stand while there is still an evening to
   * decide in, and the shift runs what was chosen instead of only planning.
   */
  it('plans straight after the first run, so the decisions stand before the night opens', async () => {
    // Its own service over the same stores: the shared one has no candidate sources, and a
    // planning run with nothing to plan from is skipped before it starts.
    const planner = new FellowService({
      agents: new SqliteAgentStore(db),
      runs: new SqliteAgentRunStore(db),
      proposals: new SqliteProposalStore(db),
      maintenance: runner,
      notebook: new NotebookWriter({ vaultRoot, commitMutex: new Mutex() }),
      candidates: () => [{ id: 'C1', kind: 'sweep', text: 'Creep resistance testing', sourcePages: [], weight: 3 }],
    })
    const { agent, run } = await planner.spawn({
      name: 'Ida',
      intent: 'Creep resistance testing',
      homeDomain: 'ai-tooling',
      tasks: [{ text: 'Creep resistance testing', kind: 'watch' }],
    })
    expect(run).toMatchObject({ kind: 'research', label: 'Creep resistance testing' })

    await waitSettled(run!.id)
    await planner.flush()
    const kinds = planner.card(agent!.id)!.runs.map((r) => r.kind)
    expect(kinds).toContain('research')
    expect(kinds).toContain('plan')
    // And the plan is for the night AHEAD, not for the calendar day it was started on: read
    // against the day, proposals made in the evening belong to a cycle the night is not.
    for (const p of planner.card(agent!.id)!.proposals) expect(p.cycleDate).toBe(nightAheadDate())
  })

  it('leaves the plan to the night shift when the first run is not taken', async () => {
    const { agent } = await service.spawn({ name: 'Ines', intent: 'Nothing yet', homeDomain: 'ai-tooling', runFirstStep: false })
    await service.flush()
    expect(calls).toHaveLength(0)
    expect(service.card(agent!.id)!.runs).toEqual([])
  })

  it('a manual step is a research-step with tightened caps, and the daily quota gates the next one', async () => {
    const { agent } = await service.spawn({ name: 'Noor', intent: 'Heat transport in ice shelves', homeDomain: 'climate-science', runFirstStep: false })
    expect(agent!.state).toBe('proposed')
    expect(calls).toHaveLength(0)

    const first = service.step(agent!.id, { topic: 'Basal melt rates under warm cavities' })
    expect(first.run).toMatchObject({ kind: 'research-step', label: 'Basal melt rates under warm cavities', model: 'claude-sonnet-5' })
    expect(service.step(agent!.id).refusal).toMatchObject({ status: 409 })
    await waitSettled(first.run!.id)
    expect(calls[0]!.prompt).toContain('<research_step>')
    expect(calls[0]).toMatchObject({ maxBudgetUsd: 4 })

    const second = service.step(agent!.id)
    expect(second.refusal).toMatchObject({ status: 409, code: 'quota' })
    expect(second.refusal?.error).toContain("used tonight's quota (1 of 1 runs)")
    expect(service.card(agent!.id)!.agent.state).toBe('sleeping')

    // A deliberate manual start passes the quota: it limits the autopilot, not the user.
    const anyway = service.step(agent!.id, { override: true })
    expect(anyway.run).toMatchObject({ kind: 'research-step' })
    await waitSettled(anyway.run!.id)

  })

  it('a failed run blocks the Fellow with the reason; pause refuses steps; retire then remove', async () => {
    agentOk = false
    const { agent, run } = await service.spawn({ name: 'Tomas', intent: 'Cache coherence in NUMA systems', homeDomain: 'computing' })
    await waitSettled(run!.id)
    expect(service.get(agent!.id)).toMatchObject({ state: 'blocked', sleepReason: expect.stringContaining('agent exploded') })

    await service.pause(agent!.id)
    expect(service.step(agent!.id).refusal?.error).toContain('paused')
    await service.resume(agent!.id)
    expect(service.get(agent!.id)?.state).toBe('sleeping')
    expect(service.remove(agent!.id)).toMatchObject({ status: 409 })
    await service.retire(agent!.id)
    expect(fs.readFileSync(path.join(vaultRoot, agent!.notebookPath), 'utf8')).toContain('status: retired')
    expect(service.remove(agent!.id)).toEqual({ ok: true })
    expect(service.get(agent!.id)).toBeUndefined()
  })

  it('reads intent edits back from the page after a run', async () => {
    const { agent, run } = await service.spawn({ name: 'Mira', intent: 'Original intent', homeDomain: 'neuroscience' })
    const abs = path.join(vaultRoot, agent!.notebookPath)
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('Original intent', 'Edited in Obsidian'))
    await waitSettled(run!.id)
    expect(service.get(agent!.id)?.intent).toBe('Edited in Obsidian')
  })
})

describe('agents routes', () => {
  let vaultRoot: string
  let app: FastifyInstance
  let runner: MaintenanceRunner
  let service: FellowService
  const git = (...args: string[]): string => execFileSync('git', ['-C', vaultRoot, ...args], { encoding: 'utf8' })

  beforeEach(async () => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fellows-api-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'index.md'), '# index\n')
    git('init', '-q')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed')
    const db = openDb(MEMORY_DB)
    const events = new EventBus()
    const store = new JobStore(db, events)
    const config: Config = {
      vaultRoot,
      obsidianVaultName: 'vault',
      demoMode: false,
      agentsEnabled: true,
      auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
      telegram: null,
      server: { host: '127.0.0.1', port: 0, watchFolder: path.join(vaultRoot, 'inbox'), maxUploadBytes: 1024 * 1024, authMode: 'local-single-user' },
    }
    const commitMutex = new Mutex()
    const runs = new SqliteAgentRunStore(db)
    runner = new MaintenanceRunner({
      vaultRoot,
      auth: config.auth,
      events,
      commitMutex,
      runAgent: async () => okResult('done'),
      commit: async () => ({ committed: true, hash: 'abc12345', committedPages: [] }),
      runStore: runs,
    })
    service = new FellowService({ agents: new SqliteAgentStore(db), runs, proposals: new SqliteProposalStore(db), maintenance: runner, notebook: new NotebookWriter({ vaultRoot, commitMutex }) })
    const queue = new IngestQueue({ store, vaultRoot, auth: config.auth, runIngest: async () => { throw new Error('no agent') } })
    app = await buildServer({ config, store, chat: new ChatStore(db), queue, events, maintenance: runner, logger: false, commitMutex, agentRuns: runs, fellows: service })
  })
  afterEach(async () => {
    await app.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const settle = async (id: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      const run = runner.getRun(id)
      if (run !== undefined && run.status !== 'running') {
        await service.flush()
        return
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('run never settled')
  }

  it('spawns, lists, shows the card, steps, refuses over quota, pauses, retires, removes', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { name: 'Ada', intent: 'Transit photometry systematics', homeDomain: 'Not A Key' } })
    expect(bad.statusCode).toBe(400)

    const created = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { name: 'Ada', intent: 'Transit photometry systematics', homeDomain: 'astronomy', quotaRunsPerDay: 1 } })
    expect(created.statusCode).toBe(201)
    const { agent, run } = created.json() as { agent: AgentRecord; run: { id: string; kind: string } }
    expect(run.kind).toBe('research')
    await settle(run.id)

    const dup = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { name: 'Ada', intent: 'Another', homeDomain: 'astronomy' } })
    expect(dup.statusCode).toBe(409)

    const list = await app.inject({ method: 'GET', url: '/api/v1/agents' })
    expect((list.json() as { fellows: unknown[] }).fellows).toHaveLength(1)

    const card = await app.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}/card` })
    expect(card.statusCode).toBe(200)
    expect((card.json() as { quota: { used: number } }).quota.used).toBe(1)

    const over = await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/step`, payload: { topic: 'A follow-up' } })
    expect(over.statusCode).toBe(409)

    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${agent.id}`, payload: { quotaRunsPerDay: 3, model: 'fable-5-1' } })
    expect((patched.json() as { agent: AgentRecord }).agent).toMatchObject({ quotaRunsPerDay: 3, model: 'fable-5-1' })

    const step = await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/step`, payload: { topic: 'A follow-up' } })
    expect(step.statusCode).toBe(202)
    const stepRun = (step.json() as { run: { id: string; kind: string; model: string } }).run
    expect(stepRun).toMatchObject({ kind: 'research-step', model: 'claude-fable-5-1' })
    await settle(stepRun.id)

    expect((await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/pause` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/step` })).statusCode).toBe(409)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/agents/${agent.id}` })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/retire` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/agents/${agent.id}` })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: `/api/v1/agents/${agent.id}` })).statusCode).toBe(404)
  })

  it('gives a new Fellow one run a day per standing task, and takes a stated number as stated', async () => {
    /*
     * `nightly` defaults to `sweep`, and a planning run skips this quota while the run it
     * produces does not. A default of 1 against three tasks would plan three every night and
     * carry out one.
     */
    const three = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: {
        name: 'Kepler',
        intent: 'What is new in transit photometry?',
        homeDomain: 'astronomy',
        tasks: [
          { text: 'What is new in transit photometry?', kind: 'watch' },
          { text: 'How well do ground-based systematics bound retrievals?', kind: 'explore' },
          { text: 'Extend what the vault says about transit timing', kind: 'deepen' },
        ],
      },
    })
    expect(three.statusCode, JSON.stringify(three.json())).toBe(201)
    expect((three.json() as { agent: AgentRecord }).agent).toMatchObject({ quotaRunsPerDay: 3, nightly: 'sweep' })

    const stated = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: {
        name: 'Halley',
        intent: 'Which periodic comets are being re-observed this season?',
        homeDomain: 'astronomy',
        quotaRunsPerDay: 1,
        tasks: [
          { text: 'Which periodic comets are being re-observed this season?', kind: 'watch' },
          { text: 'What is new in cometary outgassing measurements?', kind: 'watch' },
        ],
      },
    })
    expect((stated.json() as { agent: AgentRecord }).agent.quotaRunsPerDay).toBe(1)
  })

  it('refuses a task the Fellow\'s art does not hold, instead of quietly keeping the old list', async () => {
    /*
     * The refusal existed before this; what did not was a way to see it. `update` returned the
     * unchanged record, so a 200 came back with the old list and the dashboard would have shown
     * "saved" for an edit that never happened.
     */
    const spawned = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: { name: 'Cassini', intent: 'What is new in transit photometry?', homeDomain: 'astronomy', art: 'watch', tasks: [{ text: 'What is new in transit photometry?', kind: 'watch' }] },
    })
    const id = (spawned.json() as { agent: AgentRecord }).agent.id

    const wrong = await app.inject({
      method: 'PATCH',
      url: `/api/v1/agents/${id}`,
      payload: { tasks: [{ text: 'Extend what the vault says about transit timing', kind: 'deepen' }] },
    })
    expect(wrong.statusCode).toBe(409)
    expect((wrong.json() as { error: string }).error).toContain('watch tasks only')

    // And the other direction: narrowing the art has to hold the list it lands on.
    const narrow = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${id}`, payload: { art: 'deepen' } })
    expect(narrow.statusCode).toBe(409)

    // What the art does hold goes through, and so does widening it to custom.
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/agents/${id}`, payload: { nightly: 'rotate' } })).statusCode).toBe(200)
    const wide = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${id}`, payload: { art: 'custom', tasks: [{ text: 'What is new in transit photometry?', kind: 'watch' }, { text: 'Extend what the vault says about transit timing', kind: 'deepen' }] } })
    expect(wide.statusCode).toBe(200)
    expect((wide.json() as { agent: AgentRecord }).agent).toMatchObject({ art: 'custom', nightly: 'rotate' })
  })
})

/**
 * The two bounds a hand-started deepening gets (docs/agents/ideas.md, decision 2026-09-07).
 * Until this, `POST /agents/:id/step` with a page set was limited by nothing: any number of
 * pages, any domain. The planner's own sets were bounded on the way in, so the gap only
 * existed for the entry point the UI is about to grow.
 */
describe('bounds of a hand-started deepening', () => {
  let vaultRoot: string
  let db: Db
  let calls: RunAgentOptions[]
  let service: FellowService
  let runner: MaintenanceRunner
  const git = (...args: string[]): string => execFileSync('git', ['-C', vaultRoot, ...args], { encoding: 'utf8' })

  const page = (name: string, domain: string | null): string => {
    const rel = `wiki/concepts/${name}.md`
    const fm = domain === null ? '' : `domain: ${domain}\n`
    fs.writeFileSync(path.join(vaultRoot, rel), `---\ntype: concept\ntitle: "${name}"\n${fm}---\n# ${name}\n\nThin.\n`)
    return rel
  }

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepen-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'concepts'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'index.md'), '# index\n')
    git('init', '-q')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed')
    db = openDb(MEMORY_DB)
    calls = []
    const commitMutex = new Mutex()
    const runs = new SqliteAgentRunStore(db)
    runner = new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex,
      runAgent: async (opts) => {
        calls.push(opts)
        return okResult('deepened')
      },
      commit: async () => ({ committed: true, hash: 'abc12345', committedPages: [] }),
      runStore: runs,
    })
    service = new FellowService({
      agents: new SqliteAgentStore(db),
      runs,
      proposals: new SqliteProposalStore(db),
      maintenance: runner,
      notebook: new NotebookWriter({ vaultRoot, commitMutex }),
      candidateSources: { vaultRoot },
    })
  })
  afterEach(() => {
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const fellow = async (): Promise<string> => {
    const { agent } = await service.spawn({ name: 'Ada', intent: 'Transit photometry', homeDomain: 'astronomy', extraDomains: ['computing'], runFirstStep: false })
    return agent!.id
  }

  it('refuses more pages than a hand start may name', async () => {
    const id = await fellow()
    const many = Array.from({ length: 9 }, (_, i) => page(`P${i}`, 'astronomy'))
    const { refusal } = service.step(id, { kind: 'research-expand', pageSet: many, override: true })
    expect(refusal).toMatchObject({ status: 409, code: 'kind' })
    expect(refusal!.error).toContain('at most 8')
  })

  it('refuses a domain the Fellow does not work, and names it', async () => {
    const id = await fellow()
    const { refusal } = service.step(id, { kind: 'research-expand', pageSet: [page('Sourdough', 'cooking')], override: true })
    expect(refusal).toMatchObject({ status: 409, code: 'scope' })
    expect(refusal!.error).toContain('cooking')
  })

  it('allows the home domain, an extra domain, and an unfiled page', async () => {
    const id = await fellow()
    const set = [page('Transit', 'astronomy'), page('Cache', 'computing'), page('Nobody Filed This', null)]
    const { refusal, run } = service.step(id, { kind: 'research-expand', pageSet: set, override: true })
    expect(refusal).toBeUndefined()
    expect(run).toBeDefined()
  })

  it('refuses a page that is not there rather than sending the run at it', async () => {
    const id = await fellow()
    const { refusal } = service.step(id, { kind: 'research-expand', pageSet: ['wiki/concepts/Never Written.md'], override: true })
    expect(refusal).toMatchObject({ status: 409, code: 'kind' })
    expect(refusal!.error).toContain('no such page')
  })

  it('pays and waits for the set it was given, not for a fixed four', async () => {
    const id = await fellow()
    // One at a time: a Fellow with a run in flight refuses the next, so the second start
    // has to wait for the first to settle.
    const deepen = async (pages: readonly string[]): Promise<void> => {
      const { refusal, run } = service.step(id, { kind: 'research-expand', pageSet: pages, override: true })
      expect(refusal).toBeUndefined()
      for (let i = 0; i < 400 && runner.getRun(run!.id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 5))
      await service.flush()
    }
    await deepen(Array.from({ length: 4 }, (_, i) => page(`F${i}`, 'astronomy')))
    await deepen(Array.from({ length: 8 }, (_, i) => page(`E${i}`, 'astronomy')))
    // Sonnet's factor is 1, so the numbers are the USD of the decision: 6 for four, 10 for eight.
    expect(calls.map((c) => c.maxBudgetUsd)).toEqual([6, 10])
    expect(calls[1]!.timeoutMs).toBe(calls[0]!.timeoutMs! * 2)
  })

  it('leaves the set of a planner proposal alone - it was bounded on the way in', async () => {
    const id = await fellow()
    const set = [page('Foreign', 'cooking')]
    const { refusal } = service.step(id, { kind: 'research-expand', pageSet: set, proposalId: 'p1', override: true })
    expect(refusal).toBeUndefined()
  })
})

/*
 * Which night a run belongs to (2026-09-14).
 *
 * The board calls the coming window "Tonight" and the quota calls its allowance "runs a day",
 * and both used to be read against the local calendar day. A window of 23:30 to 04:00 agrees
 * with neither: it carries the cycle date of the morning after, and it crosses midnight in the
 * middle. So a run finished in the afternoon was drawn under "Tonight" with a done mark, while
 * a shift that started at 23:30 inherited the day's spent quota and then got a fresh one at
 * midnight, halfway through its own night.
 */
describe('the night a run is counted in', () => {
  const WINDOW = { start: '23:30', end: '04:00' }
  const TASK = { id: 't1', text: 'Antibody drug conjugates', kind: 'watch' as const, state: 'active' as const }

  const build = (now: Date, runAt: Date): { service: FellowService; agentId: string } => {
    const agents = new MemoryAgentStore()
    const runs = new MemoryAgentRunStore()
    const proposals = new MemoryProposalStore()
    const agent = { ...agentRecord(), tasks: [TASK], quotaRunsPerDay: 2, autonomy: 'auto' as const }
    agents.create(agent)
    proposals.create({
      id: 'p1',
      agentId: agent.id,
      createdAt: runAt.toISOString(),
      cycleDate: localDate(runAt),
      kind: 'research',
      topic: 'what 2026 added',
      lens: 'broad',
      rationale: '',
      provenance: { candidate: 'sweep', text: TASK.text, sourcePages: [], task: TASK.text },
      pageSet: [],
      estCostUsd: 6,
      estPlanPct: null,
      scopeScore: 1,
      rank: 1,
      status: 'executed',
      decidedAt: null,
      decidedVia: null,
      userNote: null,
      runId: 'r1',
    })
    runs.record({ ...runRecord(), kind: 'research', agentId: agent.id, proposalId: 'p1', startedAt: runAt.toISOString(), finishedAt: runAt.toISOString() })
    const service = new FellowService({
      agents,
      runs,
      proposals,
      maintenance: {} as unknown as MaintenanceRunner,
      notebook: {} as unknown as NotebookWriter,
      now: () => now,
      settings: () => ({ window: WINDOW, defaultModel: 'sonnet-5' }),
    })
    return { service, agentId: agent.id }
  }

  it('an afternoon run is not what the coming night did, and does not spend its quota', () => {
    // 19:40, four hours before the window opens. The run happened at 16:55 the same afternoon.
    const { service, agentId } = build(new Date(2026, 8, 14, 19, 40), new Date(2026, 8, 14, 16, 55))
    const card = service.card(agentId)!
    expect(card.tonight).toEqual([{ id: 't1', outcome: 'open' }])
    expect(card.runsTonight).toBe(0)
    /*
     * The quota still counts it, and that is the other half of the fix: the forecast looks
     * forward, the gate covers the present moment. The run belongs to the night that opened
     * this day, so a hand-started run this afternoon meets a quota with one of two spent - and
     * at 23:30, when the next window opens, the count starts over.
     */
    expect(card.quota).toEqual({ runsPerDay: 2, used: 1 })
  })

  it('inside the window the night is one cycle, on both sides of midnight', () => {
    const started = new Date(2026, 8, 14, 23, 40)
    // 00:10: past midnight, still the same night, and the run at 23:40 still counts.
    const { service, agentId } = build(new Date(2026, 8, 15, 0, 10), started)
    const card = service.card(agentId)!
    expect(card.tonight).toEqual([{ id: 't1', outcome: 'ran' }])
    expect(card.runsTonight).toBe(1)
    expect(card.quota).toEqual({ runsPerDay: 2, used: 1 })
  })

  it('once the night is over its runs are off tonight\'s count again', () => {
    // The morning after: 09:00, with last night's run at 23:40. The next window is a new night.
    const { service, agentId } = build(new Date(2026, 8, 15, 9, 0), new Date(2026, 8, 14, 23, 40))
    expect(service.card(agentId)!.tonight).toEqual([{ id: 't1', outcome: 'open' }])
  })
})
