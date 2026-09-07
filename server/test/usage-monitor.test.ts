/**
 * Milestone A5 (docs/tasks/TASKS-A5.md): the usage monitor's three sources, the per-run
 * deltas and the median calibration, consumption per window, the gate in its three modes
 * (reserves from the latest sample, shares in points once calibrated, USD-equivalent shares
 * before that), the endpoint cache, and the two routes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { MemoryUsageSampleStore, SqliteUsageSampleStore } from '../src/db/usage-samples.js'
import { MemoryAgentRunStore, type AgentRunRecord } from '../src/db/agent-runs.js'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import {
  UsageMonitor,
  CALIBRATION_MIN,
  deltaBetween,
  eventReset,
  median,
  modelKey,
  parseEndpointUsage,
  parseRateLimitEvent,
  parseSdkUsage,
  type EndpointResult,
} from '../src/pipeline/usage-monitor.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { EventBus } from '../src/pipeline/events.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer } from '../src/api/server.js'
import type { Config } from '../src/config.js'

const SETTINGS = { researchShareWeekPct: 10, researchShare5hPct: 15, reserve5hPct: 60, reserveWeekPct: 80, planWeekUsd: 1000, plan5hUsd: 80, planName: '', fiveHourOverrideEnabled: false }
const NOW = new Date('2026-09-07T10:00:00.000Z')
const FIVE_RESET = '2026-09-07T12:00:00.000Z'
const WEEK_RESET = '2026-09-13T00:00:00.000Z'

const sdk = (five: number, week: number): Record<string, unknown> => ({
  rate_limits_available: true,
  subscription_type: 'max',
  rate_limits: {
    five_hour: { utilization: five, resets_at: FIVE_RESET },
    seven_day: { utilization: week, resets_at: WEEK_RESET },
    seven_day_sonnet: { utilization: 3, resets_at: null },
    model_scoped: [{ display_name: 'Opus', utilization: 7, resets_at: null }],
  },
})

const run = (over: Partial<AgentRunRecord>): AgentRunRecord => ({
  id: `r-${Math.random().toString(36).slice(2, 8)}`,
  kind: 'research-step',
  label: 'x',
  profileKey: 'broad',
  ok: true,
  pages: [],
  tokensIn: 10,
  tokensOut: 1,
  costUsd: 2,
  error: null,
  commitHash: null,
  startedAt: '2026-09-07T09:00:00.000Z',
  finishedAt: '2026-09-07T09:10:00.000Z',
  agentId: 'a1',
  model: 'claude-sonnet-5',
  ...over,
})

const monitorWith = (runs: AgentRunRecord[], fetchEndpoint?: () => Promise<EndpointResult>, now: () => Date = () => NOW): { m: UsageMonitor; store: MemoryUsageSampleStore } => {
  const store = new MemoryUsageSampleStore()
  const runStore = new MemoryAgentRunStore()
  for (const r of runs) runStore.record(r)
  return { m: new UsageMonitor({ store, runs: runStore, settings: () => SETTINGS, now, ...(fetchEndpoint ? { fetchEndpoint } : {}) }), store }
}

describe('parsing the three sources', () => {
  it('reads the SDK response, the endpoint JSON and a rate-limit event', () => {
    const parsed = parseSdkUsage(sdk(10, 20))
    expect(parsed).toMatchObject({ available: true, subscription: 'max', reason: null })
    expect(parsed.windows).toEqual([
      { window: 'five_hour', utilization: 10, resetsAt: FIVE_RESET },
      { window: 'seven_day', utilization: 20, resetsAt: WEEK_RESET },
      { window: 'seven_day_sonnet', utilization: 3, resetsAt: null },
      { window: 'model:opus', utilization: 7, resetsAt: null },
    ])
    expect(parseSdkUsage({ rate_limits_available: false })).toMatchObject({ available: false, windows: [], reason: 'the SDK reports no plan rate limits for this credential' })
    // Seen for real: the sample before the session's first API response.
    expect(parseSdkUsage({ rate_limits_available: true, rate_limits: null, subscription_type: null })).toMatchObject({ available: false, windows: [], reason: 'the SDK carried no plan windows yet (no API response in this session)' })
    expect(parseSdkUsage(undefined)).toMatchObject({ available: false, reason: 'no usage response' })

    expect(parseEndpointUsage({ error: { type: 'permission_error', message: 'OAuth token does not meet scope requirement user:profile' } })).toMatchObject({ available: false, reason: 'OAuth token does not meet scope requirement user:profile' })
    expect(parseEndpointUsage({ five_hour: { utilization: 5, resets_at: FIVE_RESET } }).windows).toEqual([{ window: 'five_hour', utilization: 5, resetsAt: FIVE_RESET }])
    expect(parseEndpointUsage({ rate_limits: { seven_day: { utilization: 41 } } }).windows).toEqual([{ window: 'seven_day', utilization: 41, resetsAt: null }])
    expect(parseEndpointUsage({})).toMatchObject({ available: false, reason: 'the usage endpoint carried no windows' })

    const resets = Date.UTC(2026, 8, 7, 12) / 1000
    expect(parseRateLimitEvent({ rateLimitType: 'five_hour', utilization: 12, resetsAt: resets, status: 'allowed' })).toEqual({ window: 'five_hour', utilization: 12, resetsAt: FIVE_RESET })
    expect(parseRateLimitEvent({ rateLimitType: 'five_hour', status: 'allowed' })).toBeNull()
    expect(parseRateLimitEvent(null)).toBeNull()
    // The events seen for real: a window and its reset, no utilization.
    expect(eventReset({ status: 'allowed', resetsAt: resets, rateLimitType: 'five_hour', overageStatus: 'rejected' })).toEqual({ window: 'five_hour', resetsAt: FIVE_RESET })
    expect(eventReset({ rateLimitType: 'five_hour' })).toBeNull()
  })

  it('median, deltas across a reset, model keys', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    const before = [{ window: 'five_hour', utilization: 10, resetsAt: null }, { window: 'seven_day', utilization: 40, resetsAt: null }]
    const after = [{ window: 'five_hour', utilization: 12.5, resetsAt: null }, { window: 'seven_day', utilization: 3, resetsAt: null }, { window: 'model:opus', utilization: 1, resetsAt: null }]
    // The week reset in between: what it shows after is what the run took.
    expect(deltaBetween(before, after)).toEqual({ five_hour: 2.5, seven_day: 3 })
    expect(modelKey('claude-sonnet-5')).toBe('sonnet-5')
    expect(modelKey('opus-5')).toBe('opus-5')
    expect(modelKey(null)).toBe('default')
  })
})

describe('the monitor', () => {
  it('records samples, calibrates over Fellow runs, prices a run and accounts the windows', () => {
    const runs = [0, 1, 2].map((i) => run({ id: `r${i}`, planPctDelta: { five_hour: 2, seven_day: 0.4 } }))
    const { m, store } = monitorWith([...runs, run({ id: 'ingest', agentId: null, planPctDelta: { five_hour: 9, seven_day: 9 } })])
    expect(m.recordSdk(sdk(10, 20), 'before', 'r9')).toHaveLength(4)
    expect(store.ofRun('r9').map((s) => [s.window, s.phase, s.source])).toEqual([
      ['five_hour', 'before', 'sdk'],
      ['seven_day', 'before', 'sdk'],
      ['seven_day_sonnet', 'before', 'sdk'],
      ['model:opus', 'before', 'sdk'],
    ])
    expect(m.recordEvent({ rateLimitType: 'five_hour', utilization: 11 }, 'r9')).toEqual({ window: 'five_hour', utilization: 11, resetsAt: null })
    expect(m.latest()).toMatchObject({ available: true, source: 'event', sampledAt: NOW.toISOString() })
    expect(m.latest().windows.find((w) => w.window === 'five_hour')).toEqual({ window: 'five_hour', utilization: 11, resetsAt: null })

    // The ingest run is not a Fellow run: it never enters the calibration.
    const cal = m.calibration()
    expect(cal).toEqual({ perModel: { 'sonnet-5': { fiveHour: 1, sevenDay: 0.2, n: 3 } }, ready: true })
    expect(CALIBRATION_MIN).toBe(3)
    expect(m.estimatePct(2, 'sonnet-5')).toEqual({ fiveHour: 2, sevenDay: 0.4 })
    expect(m.estimatePct(2, 'claude-sonnet-5')).toEqual({ fiveHour: 2, sevenDay: 0.4 })
    expect(m.estimatePct(2, 'opus-5')).toEqual({ fiveHour: null, sevenDay: null })

    // Windows from the reset stamps: the week from 09-06, the 5-hour window from 07:00; the runs at 09:00 fall in both.
    expect(m.consumption()).toEqual({ weekPct: 1.2, fiveHourPct: 6, weekUsd: 6, fiveHourUsd: 6, weekRuns: 3, fiveHourRuns: 3 })
    const status = m.status({ estCostUsd: 2, model: 'sonnet-5' })
    expect(status).toMatchObject({ available: true, source: 'event', subscription: 'max', reason: null, gate: null })
    expect(status.shares).toEqual({ unit: 'points', week: 10, fiveHour: 15, weekUsed: 1.2, fiveHourUsed: 6, stepsLeftWeek: 22 })
    expect(m.samples(2)).toHaveLength(2)
  })

  it('the baseline: the newest samples from just before a run, both main windows or nothing', () => {
    const { m, store } = monitorWith([])
    const at = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString()
    store.record({ ts: at(30), window: 'five_hour', utilization: 5, resetsAt: null, runId: null, phase: 'tick', source: 'endpoint' })
    store.record({ ts: at(30), window: 'seven_day', utilization: 40, resetsAt: null, runId: null, phase: 'tick', source: 'endpoint' })
    expect(m.baseline(NOW.toISOString())).toBeNull()
    expect(m.baseline(NOW.toISOString(), 60 * 60_000)).toEqual([{ window: 'five_hour', utilization: 5, resetsAt: null }, { window: 'seven_day', utilization: 40, resetsAt: null }])
    store.record({ ts: at(2), window: 'five_hour', utilization: 9, resetsAt: FIVE_RESET, runId: 'prev', phase: 'after', source: 'sdk' })
    expect(m.baseline(NOW.toISOString())).toBeNull()
    store.record({ ts: at(1), window: 'seven_day', utilization: 41, resetsAt: null, runId: 'prev', phase: 'after', source: 'sdk' })
    // Older than three minutes: the gap would be charged to the run.
    expect(m.baseline(new Date(NOW.getTime() + 3 * 60_000).toISOString())).toBeNull()
    // A sample taken after the start (this run's own) is not a baseline.
    store.record({ ts: new Date(NOW.getTime() + 60_000).toISOString(), window: 'five_hour', utilization: 12, resetsAt: null, runId: 'this', phase: 'before', source: 'sdk' })
    expect(m.baseline(NOW.toISOString())).toEqual(expect.arrayContaining([{ window: 'five_hour', utilization: 9, resetsAt: FIVE_RESET }, { window: 'seven_day', utilization: 41, resetsAt: null }]))
  })

  it('the gate: USD-equivalent shares without plan data, points once calibrated, reserves from the latest sample', () => {
    const ctx = (estCostUsd: number): { estCostUsd: number; model: 'sonnet-5'; kind: string } => ({ estCostUsd, model: 'sonnet-5', kind: 'research-step' })
    // No samples, no calibration: the week's share is 10% of 1000 USD, the 5-hour share 15% of 80 USD.
    const { m } = monitorWith([run({ id: 'old', startedAt: '2026-09-01T10:00:00.000Z', costUsd: 50 }), run({ id: 'recent', startedAt: '2026-09-07T09:00:00.000Z', costUsd: 5 })])
    expect(m.gate(ctx(6))).toBeNull()
    expect(m.gate(ctx(8))).toMatchObject({ code: 'share', window: 'five_hour', resetsAt: null })
    expect(m.gate(ctx(8))!.reason).toContain('5.00 of about 12 USD')
    // A rate-limit event without utilization still tells the monitor when the window resets:
    // the refusal names it, and the 5-hour window is counted from the reset, not from now.
    expect(m.recordEvent({ rateLimitType: 'five_hour', resetsAt: Date.UTC(2026, 8, 7, 12) / 1000, status: 'allowed' }, 'r1')).toBeNull()
    expect(m.gate(ctx(8))).toMatchObject({ code: 'share', window: 'five_hour', resetsAt: FIVE_RESET })
    expect(m.status({ estCostUsd: 6, model: 'sonnet-5' }).resets).toEqual({ five_hour: FIVE_RESET })
    expect(m.recordEvent({ rateLimitType: 'five_hour', resetsAt: Date.UTC(2026, 8, 7, 9) / 1000 }, 'r1')).toBeNull()
    expect(m.status({ estCostUsd: 6, model: 'sonnet-5' }).resets).toEqual({})
    const status = m.status({ estCostUsd: 6, model: 'sonnet-5' })
    expect(status).toMatchObject({ available: false, reason: 'no plan windows on an API key; USD accounting' })
    expect(status.shares).toEqual({ unit: 'usd', week: 100, fiveHour: 12, weekUsed: 55, fiveHourUsed: 5, stepsLeftWeek: 7 })

    const weekly = monitorWith([run({ id: 'old', startedAt: '2026-09-01T10:00:00.000Z', costUsd: 50 }), run({ id: 'mid', startedAt: '2026-09-04T10:00:00.000Z', costUsd: 45 }), run({ id: 'recent', costUsd: 5 })]).m
    expect(weekly.gate(ctx(2))).toMatchObject({ code: 'share', window: 'seven_day' })
    expect(weekly.gate(ctx(2))!.reason).toContain('100.00 of about 100 USD')

    // Calibrated: three runs of 3 points each consumed 9 of the week's 10 points; a 3-point step does not fit.
    const points = monitorWith([0, 1, 2].map((i) => run({ id: `c${i}`, planPctDelta: { five_hour: 1, seven_day: 3 } }))).m
    const verdict = points.gate(ctx(2))
    expect(verdict).toMatchObject({ code: 'share', window: 'seven_day' })
    expect(verdict!.reason).toBe('the research share of the week is used up (9 of 10 points, this step about 3)')
    expect(points.gate(ctx(0.5))).toBeNull()

    // Reserves win over everything once a sample says the window is above them.
    points.recordSdk(sdk(65, 20), 'tick', null)
    expect(points.gate(ctx(0.5))).toEqual({ code: 'reserve', window: 'five_hour', reason: 'the 5-hour window is at 65%, above the 60% reserve', resetsAt: FIVE_RESET })
    points.recordSdk(sdk(10, 85), 'tick', null)
    expect(points.gate(ctx(0.5))).toMatchObject({ code: 'reserve', window: 'seven_day', resetsAt: WEEK_RESET })
    points.recordSdk(sdk(10, 20), 'tick', null)
    expect(points.gate(ctx(0.5))).toBeNull()
  })

  it('refreshes from the endpoint behind a cache, one flight at a time, and keeps its refusal', async () => {
    let calls = 0
    // A refusal that IS a moment: the scope refusal closes the endpoint for good and is
    // covered in plan-override.test.ts, so it would not test the cache at all.
    let answer: EndpointResult = { ok: false, reason: 'the usage endpoint answered 503' }
    let clock = NOW
    const { m } = monitorWith([], async () => {
      calls++
      return answer
    }, () => clock)
    await m.refresh()
    expect(calls).toBe(1)
    expect(m.status({ estCostUsd: 2, model: 'sonnet-5' })).toMatchObject({ available: false, reason: 'the usage endpoint answered 503', shares: { unit: 'usd' } })
    await m.refresh()
    expect(calls).toBe(1)
    answer = { ok: true, json: { five_hour: { utilization: 22, resets_at: FIVE_RESET }, seven_day: { utilization: 9, resets_at: WEEK_RESET } } }
    await Promise.all([m.refresh(true), m.refresh(true)])
    expect(calls).toBe(2)
    expect(m.latest()).toMatchObject({ available: true, source: 'endpoint' })
    expect(m.status({ estCostUsd: 2, model: 'sonnet-5' })).toMatchObject({ available: true, reason: null, windows: [{ window: 'five_hour', utilization: 22 }, { window: 'seven_day', utilization: 9 }] })
    // A day later the sample says nothing about now.
    clock = new Date(NOW.getTime() + 25 * 3600_000)
    expect(m.latest().available).toBe(false)
    answer = { ok: false, reason: 'the usage endpoint answered 500' }
    await m.refresh()
    expect(calls).toBe(3)
    expect(m.status({ estCostUsd: 2, model: 'sonnet-5' }).reason).toBe('the usage endpoint answered 500')
  })

  it('the sqlite sample store keeps the newest per window and the rows of a run', () => {
    const db = openDb(MEMORY_DB)
    const store = new SqliteUsageSampleStore(db)
    store.record({ ts: '2026-09-07T09:00:00.000Z', window: 'five_hour', utilization: 10, resetsAt: FIVE_RESET, runId: 'r1', phase: 'before', source: 'sdk' })
    store.record({ ts: '2026-09-07T09:10:00.000Z', window: 'five_hour', utilization: 12, resetsAt: FIVE_RESET, runId: 'r1', phase: 'after', source: 'sdk' })
    store.record({ ts: '2026-09-07T09:05:00.000Z', window: 'seven_day', utilization: 4, resetsAt: null, runId: null, phase: 'tick', source: 'endpoint' })
    expect(store.latest().map((s) => [s.window, s.utilization])).toEqual(expect.arrayContaining([['five_hour', 12], ['seven_day', 4]]))
    expect(store.ofRun('r1').map((s) => s.phase)).toEqual(['before', 'after'])
    expect(store.list(2).map((s) => s.ts)).toEqual(['2026-09-07T09:10:00.000Z', '2026-09-07T09:05:00.000Z'])
    db.close()
  })
})

describe('usage routes', () => {
  let vaultRoot: string
  let db: Db
  let app: FastifyInstance
  beforeEach(async () => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-api-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki'), { recursive: true })
    db = openDb(MEMORY_DB)
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
    const queue = new IngestQueue({ store, vaultRoot, auth: config.auth, runIngest: async () => { throw new Error('no agent') } })
    const runner = new MaintenanceRunner({ vaultRoot, auth: config.auth, events, commitMutex: new Mutex() })
    const usage = new UsageMonitor({ store: new SqliteUsageSampleStore(db), runs: new MemoryAgentRunStore(), settings: () => SETTINGS, now: () => NOW, fetchEndpoint: async () => ({ ok: true, json: sdk(10, 20)['rate_limits'] }) })
    app = await buildServer({ config, store, chat: new ChatStore(db), queue, events, maintenance: runner, logger: false, usage })
  })
  afterEach(async () => {
    await app.close()
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('serves the plan status (refreshing the endpoint) and the samples', async () => {
    const plan = await app.inject({ method: 'GET', url: '/api/v1/usage/plan' })
    expect(plan.statusCode).toBe(200)
    expect(plan.json()).toMatchObject({ available: true, source: 'endpoint', settings: SETTINGS, shares: { unit: 'usd', week: 100 }, gate: null })
    const samples = await app.inject({ method: 'GET', url: '/api/v1/usage/samples?limit=2' })
    expect(samples.statusCode).toBe(200)
    expect((samples.json() as { samples: unknown[] }).samples).toHaveLength(2)
  })
})
