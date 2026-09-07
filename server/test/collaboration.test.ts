/**
 * Milestone A3 (docs/tasks/TASKS-A3.md): routing of a planner's handoffs to the Fellow of
 * the domain or to an unclaimed request, the handoff as the target's candidate, retire and
 * spawn-from-request, the shift's dedupe, the recap's unclaimed requests with the spawn
 * answer, and the routes. Acceptance: a cross-domain question reaches the other Fellow.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { SqliteAgentStore, type AgentRecord } from '../src/db/agents.js'
import { SqliteAgentRunStore } from '../src/db/agent-runs.js'
import { SqliteProposalStore } from '../src/db/proposals.js'
import { SqliteShiftStore } from '../src/db/shifts.js'
import { SqliteRecapStore } from '../src/db/recaps.js'
import { SqliteHandoffStore, MemoryHandoffStore, type HandoffRecord, type HandoffStore } from '../src/db/handoffs.js'
import { NotebookWriter } from '../src/pipeline/notebook.js'
import { FellowService } from '../src/pipeline/fellows.js'
import { NightShift, topicOverlap } from '../src/pipeline/shift.js'
import { RecapService, parseRecapAnswers, type RecapModel } from '../src/pipeline/recap.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { buildServer } from '../src/api/server.js'
import type { Config } from '../src/config.js'
import type { AgentRunResult, RunAgentOptions } from '../src/pipeline/agent-runner.js'
import { computeCandidates, type Candidate } from '../src/pipeline/candidates.js'
import { buildProposals, parsePlannerAnswer, plannerSchema, renderPlannerPrompt, kindsForStep } from '../src/pipeline/planner.js'

/** The task every planner prompt is now asked for; the tests judge against this one. */
const TASK = { id: 't1', text: 'x', kind: 'explore' as const, state: 'active' as const }

const INTENT = 'How well can ground-based transit photometry constrain exoplanet atmospheres, and where do the systematics come from?'
const at = (d: number, h: number, mi = 0): Date => new Date(2026, 8, d, h, mi)
const WINDOW = { start: '01:00', end: '06:00' }
const DOMAINS = [
  { key: 'astronomy', description: 'stars, planets, instruments' },
  { key: 'climate-science', description: 'climate, aerosols, feedbacks' },
]

const CANDIDATES_ADA: Candidate[] = [
  { id: 'C1', kind: 'open-question', text: 'Does the precision hold for fainter hosts?', sourcePages: ['wiki/meta/agents/ada.md'], weight: 3 },
  { id: 'C2', kind: 'gap', text: 'Aerosol Indirect Effect', sourcePages: ['wiki/concepts/Granulation Noise.md'], weight: 1.1 },
  { id: 'C3', kind: 'gap', text: 'Carbonate Weathering Feedback', sourcePages: ['wiki/concepts/Free Retrieval.md'], weight: 1.1 },
]

/** The planner keeps one question and routes the two climate gaps. */
const ADA_PLAN = {
  proposals: [{ candidate: 'C1', kind: 'research-step', topic: 'Does the transit photometry precision hold for faint host stars?', rationale: 'Systematics of ground-based transit photometry constrain atmospheres.', lens: 'broad', pages: [] }],
  handoffs: [
    { candidate: 'C2', domain: 'climate-science', reason: 'an aerosol question, not photometry' },
    { candidate: 'C3', domain: 'climate-science', reason: 'a carbon cycle question' },
    { candidate: 'C1', domain: 'astronomy', reason: 'its own domain, must be ignored' },
  ],
  nothing_worth_a_run: false,
  intent_covered: false,
  reason: '',
}

interface Harness {
  vaultRoot: string
  db: Db
  calls: RunAgentOptions[]
  clock: { now: Date }
  planFor: (prompt: string) => unknown
  candidatesFor: (agent: AgentRecord, handoffs: Candidate[]) => Candidate[]
  runner: MaintenanceRunner
  service: FellowService
  shift: NightShift
  recaps: RecapService
  handoffs: SqliteHandoffStore
  commitMutex: Mutex
  events: EventBus
  runs: SqliteAgentRunStore
  titles: string[]
}

function makeHarness(): Harness {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-'))
  fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
  fs.writeFileSync(path.join(vaultRoot, 'wiki', 'index.md'), '# index\n')
  const git = (...args: string[]): string => execFileSync('git', ['-C', vaultRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
  const db = openDb(MEMORY_DB)
  const h: Partial<Harness> = { vaultRoot, db, calls: [], clock: { now: at(7, 1, 30) }, titles: [] }
  h.planFor = () => ADA_PLAN
  h.candidatesFor = (agent, handoffs) => (agent.name === 'Ada' ? CANDIDATES_ADA : handoffs)
  const now = (): Date => h.clock!.now
  const commitMutex = new Mutex()
  const events = new EventBus()
  const runs = new SqliteAgentRunStore(db)
  const okResult = (text: string): AgentRunResult => ({ ok: true, result: text, usage: { tokensIn: 12, tokensOut: 3, costUsd: 0.5 }, durationMs: 1, numTurns: 1, sessionId: 's', timedOut: false })
  const runner = new MaintenanceRunner({
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    events,
    commitMutex,
    now,
    runAgent: async (opts) => {
      h.calls!.push(opts)
      await new Promise((r) => setTimeout(r, 5))
      if (opts.profile === 'query') {
        const schema = opts.outputFormat?.schema as { properties?: Record<string, unknown> } | undefined
        if (schema?.properties?.['fellows']) return { ...okResult('summary'), structuredOutput: { fellows: [] } }
        return { ...okResult('planned'), usage: { tokensIn: 5, tokensOut: 2, costUsd: 0.4 }, structuredOutput: h.planFor!(opts.prompt) }
      }
      return okResult('filed')
    },
    commit: async () => ({ committed: true, hash: 'abc12345', committedPages: ['wiki/questions/Research: Q.md', 'wiki/concepts/New Concept.md'] }),
    runStore: runs,
  })
  const agents = new SqliteAgentStore(db)
  const proposals = new SqliteProposalStore(db)
  const handoffs = new SqliteHandoffStore(db)
  const service = new FellowService({
    agents,
    runs,
    proposals,
    maintenance: runner,
    notebook: new NotebookWriter({ vaultRoot, commitMutex }),
    now,
    candidateSources: { vaultRoot },
    // The real computation with the handoffs of the store, so a routed question shows up as a candidate.
    candidates: (agent, runsOf, since) => {
      const pending = handoffs.list({ status: ['pending'], toAgentId: agent.id }).map((x) => ({ id: x.id, question: x.question, sourcePage: x.sourcePage, fromName: agents.get(x.fromAgentId)?.name ?? 'someone' }))
      const computed = computeCandidates({ agent, runs: runsOf, vaultRoot, graph: null, jobs: [], since, handoffs: pending })
      return h.candidatesFor!(agent, computed.filter((c) => c.kind === 'handoff'))
    },
    handoffs,
    registry: () => DOMAINS,
  })
  const shifts = new SqliteShiftStore(db)
  const shift = new NightShift({ fellows: service, shifts, window: () => WINDOW, now, synthesisTitles: () => h.titles! })
  const store = new JobStore(db, events)
  const recaps = new RecapService({
    vaultRoot,
    fellows: service,
    runs,
    recaps: new SqliteRecapStore<RecapModel>(db),
    shifts,
    handoffs,
    maintenance: runner,
    jobs: store,
    commitMutex,
    settings: () => ({ window: WINDOW, recapTime: '07:00' }),
    now,
    summarize: false,
  })
  Object.assign(h, { runner, service, shift, recaps, handoffs, commitMutex, events, runs })
  return h as Harness
}

describe('planner: expand page sets and handoffs', () => {
  const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({
    id: 'a1', name: 'Ada', slug: 'ada', intent: INTENT, scope: null, tasks: [{ id: 't1', text: INTENT, kind: 'explore', state: 'active' }], taskCursor: 0, homeDomain: 'astronomy', extraDomains: [], lens: 'broad', model: 'sonnet-5', effort: 'high', step: 'standard',
    quotaRunsPerDay: 1, quotaWeekPct: null, autonomy: 'veto', priority: 0, state: 'waiting', sleepReason: null, sleepCode: null, skipUntil: null, notebookPath: 'wiki/meta/agents/ada.md',
    createdAt: '2026-09-06T08:00:00.000Z', updatedAt: '2026-09-06T08:00:00.000Z', retiredAt: null, ...over,
  })

  it('offers expand to standard and deep Fellows, carries the registry and asks for handoffs', () => {
    expect(kindsForStep('standard')).toEqual(['research-step', 'research-expand', 'research'])
    expect(kindsForStep('small')).toEqual(['research-step'])
    const prompt = renderPlannerPrompt({ task: TASK, agent: agent(), candidates: CANDIDATES_ADA, recentLog: [], vetoed: [], runsLeftToday: 1, kinds: kindsForStep('standard'), domains: DOMAINS })
    expect(prompt).toContain("The library's domains (registry keys): astronomy (stars, planets, instruments); climate-science")
    expect(prompt).toContain('list it under `handoffs`')
    expect(prompt).toContain('research-expand (deepen up to 4 EXISTING pages')
    const schema = plannerSchema({ kinds: kindsForStep('standard'), candidateIds: ['C1'], domainKeys: ['astronomy', 'climate-science'] }) as { properties: { handoffs: { items: { properties: { domain: { enum: string[] } } } }; proposals: { items: { required: string[] } } }; required: string[] }
    expect(schema.required).toContain('handoffs')
    expect(schema.properties.handoffs.items.properties.domain.enum).toEqual(['astronomy', 'climate-science'])
    expect(schema.properties.proposals.items.required).toContain('pages')
  })

  it('keeps existing listed pages, adds the own pages, and clamps an expand without pages to a step', () => {
    const answer = parsePlannerAnswer({
      proposals: [
        { candidate: 'C1', kind: 'research-expand', topic: 'Deepen faint host photometry pages', rationale: 'transit photometry systematics', lens: 'broad', pages: ['wiki/concepts/Photometric Precision.md', 'wiki/concepts/Missing.md', 'wiki/concepts/A.md', 'wiki/concepts/B.md', 'wiki/concepts/C.md', 'wiki/concepts/D.md'] },
        { candidate: 'C2', kind: 'research-expand', topic: 'Deepen the aerosol page about transit photometry', rationale: 'transit photometry', lens: 'broad', pages: ['wiki/concepts/Nope.md'] },
      ],
      handoffs: [],
      nothing_worth_a_run: false,
      intent_covered: false,
      reason: '',
    })!
    const exists = new Set(['wiki/concepts/Photometric Precision.md', 'wiki/concepts/A.md', 'wiki/concepts/B.md', 'wiki/concepts/C.md', 'wiki/concepts/D.md', 'wiki/questions/Research: Own.md', 'wiki/meta/agents/ada.md'])
    let n = 0
    const built = buildProposals({ agent: agent(), answer, candidates: CANDIDATES_ADA, kinds: kindsForStep('standard'), cycleDate: '2026-09-07', now: 'n', newId: () => `p${++n}`, pageExists: (p) => exists.has(p), ownPages: ['wiki/questions/Research: Own.md', 'wiki/meta/agents/ada.md'] })
    expect(built.proposals[0]).toMatchObject({ kind: 'research-expand', estCostUsd: 3 })
    // Four listed pages at most (the candidate's source page joins the list), then the own pages.
    expect(built.proposals[0]!.pageSet).toEqual(['wiki/concepts/Photometric Precision.md', 'wiki/concepts/A.md', 'wiki/concepts/B.md', 'wiki/concepts/C.md', 'wiki/questions/Research: Own.md', 'wiki/meta/agents/ada.md'])
    expect(built.proposals[1]).toMatchObject({ kind: 'research-step', pageSet: [] })
    expect(built.clamped).toEqual(['Deepen the aerosol page about transit photometry'])
    expect(parsePlannerAnswer({ proposals: [], handoffs: [{ candidate: 'c2', domain: 'Climate-Science', reason: 'x' }], nothing_worth_a_run: true })?.handoffs).toEqual([{ candidate: 'C2', domain: 'climate-science', reason: 'x' }])
  })

  it('a small-step Fellow never gets expand kinds', () => {
    expect(kindsForStep('small')).toEqual(['research-step'])
  })
})

describe('routing, dedupe and the recap', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => {
    h.db.close()
    fs.rmSync(h.vaultRoot, { recursive: true, force: true })
  })
  const spawn = async (over: Partial<Parameters<FellowService['spawn']>[0]> = {}): Promise<AgentRecord> => {
    const { agent, refusal } = await h.service.spawn({ name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false, ...over })
    expect(refusal).toBeUndefined()
    return agent!
  }
  const pending = (agentId: string): HandoffRecord[] => h.handoffs.list({ status: ['pending'], toAgentId: agentId })

  it('acceptance: a cross-domain question reaches the other Fellow, or stays unclaimed and spawns one', async () => {
    const ada = await spawn({})
    const cleo = await spawn({ name: 'Cleo', intent: 'How do aerosols change cloud lifetime?', homeDomain: 'climate-science' })
    // Ada plans: one proposal, two questions routed to climate-science (Cleo), the own-domain one ignored.
    const plan = h.service.plan(ada.id, { cycleDate: '2026-09-07' })
    await h.service.settled(plan.run!.id)
    const toCleo = pending(cleo.id)
    expect(toCleo.map((x) => x.question).sort()).toEqual(['Aerosol Indirect Effect', 'Carbonate Weathering Feedback'])
    expect(toCleo[0]).toMatchObject({ fromAgentId: ada.id, domain: 'climate-science', status: 'pending', sourcePage: expect.stringContaining('wiki/concepts/') })
    expect(h.service.listHandoffs()).toHaveLength(2)
    // Planning Ada again does not duplicate them.
    h.clock.now = at(8, 1, 30)
    const again = h.service.plan(ada.id, { cycleDate: '2026-09-08' })
    await h.service.settled(again.run!.id)
    expect(h.service.listHandoffs()).toHaveLength(2)

    // Cleo's next planning run sees them as candidates and turns one into a proposal; that handoff is settled.
    const cleoCandidates = h.service.candidates(cleo.id)!.candidates
    expect(cleoCandidates.map((c) => [c.kind, c.text]).sort()).toEqual([
      ['handoff', 'Aerosol Indirect Effect (handed off by Ada)'],
      ['handoff', 'Carbonate Weathering Feedback (handed off by Ada)'],
    ])
    const aerosol = cleoCandidates.find((c) => c.text.startsWith('Aerosol'))!
    h.planFor = (prompt) =>
      prompt.includes('Cleo')
        ? { proposals: [{ candidate: aerosol.id, kind: 'research-step', topic: 'How strong is the aerosol indirect effect on cloud lifetime?', rationale: 'aerosols change cloud lifetime', lens: 'broad', pages: [] }], handoffs: [], nothing_worth_a_run: false, intent_covered: false, reason: '' }
        : ADA_PLAN
    const cleoPlan = h.service.plan(cleo.id, { cycleDate: '2026-09-08' })
    await h.service.settled(cleoPlan.run!.id)
    const cleoPending = h.service.pendingProposals(cleo.id)
    expect(cleoPending).toHaveLength(1)
    expect(cleoPending[0]!.provenance.candidate).toBe('handoff')
    const settledHandoff = h.handoffs.list({ status: ['proposed'] })
    expect(settledHandoff).toHaveLength(1)
    expect(settledHandoff[0]).toMatchObject({ question: 'Aerosol Indirect Effect', proposalId: cleoPending[0]!.id })
    expect(pending(cleo.id)).toHaveLength(1)

    // Retiring Cleo unclaims what is still pending to her; the recap offers a spawn; spawning claims it.
    await h.service.retire(cleo.id)
    const unclaimed = h.handoffs.list({ status: ['unclaimed'] })
    expect(unclaimed.map((u) => u.question)).toEqual(['Carbonate Weathering Feedback'])
    h.clock.now = at(8, 7, 0)
    const { row } = await h.recaps.build({ trigger: 'manual' })
    expect(row.model.unclaimed).toMatchObject([{ code: 'u1', question: 'Carbonate Weathering Feedback', domain: 'climate-science', fromName: 'Ada' }])
    const page = fs.readFileSync(path.join(h.vaultRoot, row.path!), 'utf8')
    expect(page).toContain('**Unclaimed requests** (no Fellow covers the domain; `spawn u1 <name>` spawns one):')
    expect(page).toContain('- **u1** [climate-science] Carbonate Weathering Feedback (from Ada, [[Free Retrieval]]) · a carbon cycle question')

    expect(parseRecapAnswers('spawn u1 Carla')?.answers).toEqual([{ action: 'spawn', request: 1, name: 'Carla' }])
    expect(parseRecapAnswers('spawn u1')?.answers).toEqual([{ action: 'spawn', request: 1 }])
    const reply = await h.recaps.answerText('spawn u1 Carla')
    expect(reply).toContain('✅ Carla spawned for climate-science with "Carbonate Weathering Feedback", first run started')
    const carla = h.service.list().find((s) => s.agent.name === 'Carla')!.agent
    // The spawn starts the first full run on the intent (section 5.1), so Carla is active.
    expect(carla).toMatchObject({ homeDomain: 'climate-science', intent: 'Carbonate Weathering Feedback', state: 'active' })
    expect(carla.scope).toContain('Handed off by Ada')
    expect(h.handoffs.get(unclaimed[0]!.id)).toMatchObject({ status: 'pending', toAgentId: carla.id })
    expect(h.service.candidates(carla.id)!.candidates[0]).toMatchObject({ kind: 'handoff', text: 'Carbonate Weathering Feedback (handed off by Ada)' })
    expect(await h.recaps.answerText('spawn u1 Again')).toContain('❌ the request is pending')
    expect(await h.recaps.answerText('spawn u7')).toContain('❌ no unclaimed request u7')
  })

  it('a question for a domain nobody covers is unclaimed at once; unknown domains are ignored', async () => {
    const ada = await spawn({})
    h.planFor = () => ({ ...ADA_PLAN, handoffs: [{ candidate: 'C2', domain: 'climate-science', reason: 'r' }, { candidate: 'C3', domain: 'made-up', reason: 'r' }] })
    const plan = h.service.plan(ada.id, { cycleDate: '2026-09-07' })
    await h.service.settled(plan.run!.id)
    const all = h.service.listHandoffs()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ status: 'unclaimed', toAgentId: null, question: 'Aerosol Indirect Effect' })
    // A day without runs but with an unclaimed request is not quiet.
    h.clock.now = at(7, 7, 0)
    const { row } = await h.recaps.build({ trigger: 'manual' })
    expect(row.quiet).toBe(false)
    expect(row.model.unclaimed).toHaveLength(1)
    // The handoff stores expire old requests.
    expect(h.handoffs.expire('2026-09-08', 'now')).toBe(1)
    expect(h.handoffs.get(all[0]!.id)!.status).toBe('expired')
  })

  it('the shift merges near-duplicate topics across Fellows and notes overlaps with existing pages', async () => {
    const ada = await spawn({ priority: 1 })
    const bo = await spawn({ name: 'Bo', intent: 'Transit photometry of exoplanets', homeDomain: 'astronomy' })
    h.planFor = (prompt) => ({
      proposals: [
        { candidate: 'C1', kind: 'research-step', topic: prompt.includes('"Ada"') ? 'Limb darkening models in ground-based transit photometry' : 'Limb darkening models for ground-based transit photometry', rationale: 'transit photometry systematics of exoplanet atmospheres', lens: 'broad', pages: [] },
      ],
      handoffs: [],
      nothing_worth_a_run: false,
      intent_covered: false,
      reason: '',
    })
    h.candidatesFor = () => CANDIDATES_ADA
    for (const id of [ada.id, bo.id]) {
      const plan = h.service.plan(id, { cycleDate: '2026-09-07' })
      await h.service.settled(plan.run!.id)
    }
    expect(h.service.pendingProposals(ada.id)).toHaveLength(1)
    expect(h.service.pendingProposals(bo.id)).toHaveLength(1)
    expect(topicOverlap('Limb darkening models in ground-based transit photometry', 'Limb darkening models for ground-based transit photometry')).toBeGreaterThanOrEqual(0.6)
    h.titles = ['Research: Limb darkening in transit photometry']

    h.clock.now = at(8, 1, 30)
    const night = await h.shift.run('timer')
    expect(night.summary.merged).toMatchObject([{ keptAgentName: 'Ada', droppedAgentName: 'Bo' }])
    expect(night.summary.overlaps).toMatchObject([{ agentName: 'Ada', page: 'Research: Limb darkening in transit photometry' }])
    expect(night.summary.executed.map((e) => e.agentName)).toEqual(['Ada'])
    // Bo's copy lost to Ada's; the shift's planning phase gave Bo a fresh plan afterwards.
    const boRows = h.service.listProposals(bo.id)
    expect(boRows.some((p) => p.status === 'superseded' && p.userNote?.includes("merged into Ada's"))).toBe(true)

    h.clock.now = at(8, 7, 0)
    const { row } = await h.recaps.build({ trigger: 'manual' })
    expect(row.model.dedupe.merged).toHaveLength(1)
    expect(row.model.dedupe.overlaps).toHaveLength(1)
    const page = fs.readFileSync(path.join(h.vaultRoot, row.path!), 'utf8')
    expect(page).toContain("**Merged**: Bo's \"Limb darkening models for ground-based transit photometry\" into Ada's")
    expect(page).toContain('**Overlaps an existing page**: Ada\'s')
  })

  it('memory handoff store behaves like the sqlite one', () => {
    const exercise = (store: HandoffStore): void => {
      const rec = (over: Partial<HandoffRecord>): HandoffRecord => ({ id: 'h1', fromAgentId: 'a', toAgentId: 'b', question: 'q', sourcePage: null, domain: 'd', reason: '', createdAt: '2026-09-07T00:00:00.000Z', cycleDate: '2026-09-07', status: 'pending', proposalId: null, updatedAt: 'u', ...over })
      store.create(rec({}))
      store.create(rec({ id: 'h2', toAgentId: null, status: 'unclaimed', createdAt: '2026-09-08T00:00:00.000Z', cycleDate: '2026-09-08' }))
      expect(store.list().map((r) => r.id)).toEqual(['h2', 'h1'])
      expect(store.list({ status: ['pending'], toAgentId: 'b' }).map((r) => r.id)).toEqual(['h1'])
      expect(store.update('h1', { status: 'proposed', proposalId: 'p1' })).toMatchObject({ status: 'proposed', proposalId: 'p1' })
      store.update('h1', { status: 'pending', proposalId: null })
      expect(store.unclaimTarget('b', 'now')).toBe(1)
      expect(store.get('h1')).toMatchObject({ status: 'unclaimed', toAgentId: null })
      expect(store.expire('2026-09-08', 'now')).toBe(1)
      expect(store.get('h2')!.status).toBe('unclaimed')
    }
    exercise(new MemoryHandoffStore())
    exercise(new SqliteHandoffStore(h.db))
  })
})

describe('handoff routes', () => {
  let h: Harness
  let app: FastifyInstance
  beforeEach(async () => {
    h = makeHarness()
    const config: Config = {
      vaultRoot: h.vaultRoot,
      obsidianVaultName: 'vault',
      demoMode: false,
      agentsEnabled: true,
      auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
      telegram: null,
      server: { host: '127.0.0.1', port: 0, watchFolder: path.join(h.vaultRoot, 'inbox'), maxUploadBytes: 1024 * 1024, authMode: 'local-single-user' },
    }
    const store = new JobStore(h.db, h.events)
    const queue = new IngestQueue({ store, vaultRoot: h.vaultRoot, auth: config.auth, runIngest: async () => { throw new Error('no agent') } })
    app = await buildServer({ config, store, chat: new ChatStore(h.db), queue, events: h.events, maintenance: h.runner, logger: false, commitMutex: h.commitMutex, agentRuns: h.runs, fellows: h.service, shift: h.shift, recaps: h.recaps })
  })
  afterEach(async () => {
    await app.close()
    h.db.close()
    fs.rmSync(h.vaultRoot, { recursive: true, force: true })
  })

  it('lists handoffs and spawns a prefilled Fellow from an unclaimed request', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { name: 'Ada', intent: INTENT, homeDomain: 'astronomy', runFirstStep: false } })
    const { agent } = created.json() as { agent: AgentRecord }
    const plan = h.service.plan(agent.id, { cycleDate: '2026-09-07' })
    await h.service.settled(plan.run!.id)
    const list = (await app.inject({ method: 'GET', url: '/api/v1/handoffs' })).json() as { handoffs: HandoffRecord[] }
    expect(list.handoffs).toHaveLength(2)
    expect(list.handoffs.every((x) => x.status === 'unclaimed')).toBe(true)
    const id = list.handoffs.find((x) => x.question === 'Aerosol Indirect Effect')!.id
    const bad = await app.inject({ method: 'POST', url: `/api/v1/handoffs/${id}/spawn`, payload: { homeDomain: 'Not A Key' } })
    expect(bad.statusCode).toBe(400)
    const spawned = await app.inject({ method: 'POST', url: `/api/v1/handoffs/${id}/spawn`, payload: { runFirstStep: false, model: 'opus-5' } })
    expect(spawned.statusCode).toBe(201)
    const body = spawned.json() as { agent: AgentRecord; handoff: HandoffRecord }
    expect(body.agent).toMatchObject({ name: 'Climate Science Fellow', homeDomain: 'climate-science', model: 'opus-5', intent: 'Aerosol Indirect Effect' })
    expect(body.handoff).toMatchObject({ status: 'pending', toAgentId: body.agent.id })
    expect((await app.inject({ method: 'POST', url: `/api/v1/handoffs/${id}/spawn`, payload: {} })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/v1/handoffs/nope/spawn', payload: {} })).statusCode).toBe(404)
  })
})
