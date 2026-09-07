/**
 * Releasing the rest of a five-hour window to the Fellows (SPEC section 8.6).
 *
 * This is the one thing in the service that hands out budget, so what is tested is not that it
 * works but what it cannot do: exceed its ceiling, outlive its window, touch the week, or renew
 * itself.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, MEMORY_DB, migrate, type Db } from '../src/db/index.js'
import { SqlitePlanOverrideStore, SqliteUsageSampleStore } from '../src/db/usage-samples.js'
import { UsageMonitor, OVERRIDE_PCT, type PlanSettings } from '../src/pipeline/usage-monitor.js'
import { SqliteAgentRunStore } from '../src/db/agent-runs.js'

const SETTINGS: PlanSettings = {
  researchShareWeekPct: 10,
  researchShare5hPct: 15,
  reserve5hPct: 60,
  reserveWeekPct: 80,
  planWeekUsd: 1000,
  plan5hUsd: 80,
  planName: '',
  fiveHourOverrideEnabled: true,
}

describe('the five-hour release', () => {
  let db: Db
  let monitor: UsageMonitor
  let clock: Date
  const RESET = '2026-09-07T18:00:00.000Z'

  const sample = (window: string, utilization: number, resetsAt: string | null): void => {
    new SqliteUsageSampleStore(db).record({ ts: clock.toISOString(), window, utilization, resetsAt, runId: null, phase: 'tick', source: 'endpoint' })
  }

  beforeEach(() => {
    db = openDb(MEMORY_DB)
    migrate(db)
    clock = new Date('2026-09-07T15:00:00.000Z')
    monitor = new UsageMonitor({
      store: new SqliteUsageSampleStore(db),
      overrides: new SqlitePlanOverrideStore(db),
      runs: new SqliteAgentRunStore(db),
      settings: () => SETTINGS,
      now: () => clock,
    })
    sample('five_hour', 70, RESET)
    sample('seven_day', 40, '2026-09-10T12:00:00.000Z')
  })

  const gate = (): ReturnType<UsageMonitor['gate']> => monitor.gate({ estCostUsd: 2, model: 'sonnet-5', kind: 'research-step' })

  it('opens a window the reserve had closed, and closes it again when the grant ends', () => {
    // 70 % used is past the 60 % reserve: without a grant nothing runs.
    expect(gate()).toMatchObject({ code: 'reserve', window: 'five_hour' })

    const granted = monitor.grantFiveHour()
    expect(granted).toMatchObject({ ok: true })
    expect(gate()).toBeNull()

    // Past the window's own reset the grant is simply gone - nothing had to expire it.
    clock = new Date('2026-09-07T18:00:01.000Z')
    expect(monitor.overrideNow()).toBeNull()
  })

  it('lifts BOTH bounds, because either alone leaves the other in the way', () => {
    const s = monitor.status({ estCostUsd: 2, model: 'sonnet-5' })
    expect(s.override).toMatchObject({ enabled: true, active: false, pct: OVERRIDE_PCT })
    monitor.grantFiveHour()
    const after = monitor.status({ estCostUsd: 2, model: 'sonnet-5' })
    expect(after.override).toMatchObject({ active: true, pct: OVERRIDE_PCT, expiresAt: RESET })
  })

  it('never reaches the whole window: the last tenth stays the user’s', () => {
    monitor.grantFiveHour()
    // Above the ceiling the reserve refuses again, grant or no grant.
    sample('five_hour', 95, RESET)
    expect(gate()).toMatchObject({ code: 'reserve', window: 'five_hour' })
  })

  it('never touches the week', () => {
    monitor.grantFiveHour()
    sample('seven_day', 95, '2026-09-10T12:00:00.000Z')
    expect(gate()).toMatchObject({ code: 'reserve', window: 'seven_day' })
  })

  it('ends with the window it was granted for, and nothing renews it', () => {
    monitor.grantFiveHour()
    expect(monitor.overrideNow()?.expiresAt).toBe(RESET)
    // A second grant while one is live is refused rather than extending anything.
    expect(monitor.grantFiveHour()).toMatchObject({ ok: false })
    clock = new Date('2026-09-07T18:00:01.000Z')
    expect(monitor.overrideNow()).toBeNull()
    expect(gate()).toMatchObject({ code: 'reserve' })
  })

  it('refuses without a known reset instant, so a grant can never be open-ended', () => {
    const fresh = new UsageMonitor({
      store: new SqliteUsageSampleStore(openDb(MEMORY_DB)),
      overrides: new SqlitePlanOverrideStore(db),
      runs: new SqliteAgentRunStore(db),
      settings: () => SETTINGS,
      now: () => clock,
    })
    expect(fresh.grantFiveHour()).toMatchObject({ ok: false })
    expect((fresh.grantFiveHour() as { reason: string }).reason).toContain('no known reset time')
  })

  it('reports the lifted share, not the setting - the panel must not disagree with the gate', () => {
    const before = monitor.status({ estCostUsd: 2, model: 'sonnet-5' })
    expect(before.shares.fiveHour).toBe((15 / 100) * 80)
    monitor.grantFiveHour()
    const after = monitor.status({ estCostUsd: 2, model: 'sonnet-5' })
    expect(after.shares.fiveHour).toBe((OVERRIDE_PCT / 100) * 80)
  })

  it('keeps saying why the endpoint is silent after a run has sampled', () => {
    // The SDK samples only inside runs, so a run used to clear the one field that explains
    // why nothing refreshes between them.
    const withEndpoint = new UsageMonitor({
      store: new SqliteUsageSampleStore(db),
      overrides: new SqlitePlanOverrideStore(db),
      runs: new SqliteAgentRunStore(db),
      settings: () => SETTINGS,
      now: () => clock,
      fetchEndpoint: async () => ({ ok: false, reason: 'the token lacks user:profile' }),
    })
    return withEndpoint.refresh(true).then(() => {
      expect(withEndpoint.status({ estCostUsd: 2, model: 'sonnet-5' }).liveReason).toBe('the token lacks user:profile')
      // A run samples successfully - and the endpoint's silence still has its reason.
      withEndpoint.recordSdk({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 5, resets_at: RESET } } }, 'after', 'r1')
      expect(withEndpoint.status({ estCostUsd: 2, model: 'sonnet-5' }).liveReason).toBe('the token lacks user:profile')
    })
  })

  it('suspends the runs-per-day quota while it lasts, and hands it back when it ends', () => {
    // The gate is the Fellow service's, not the monitor's, so this is the predicate it reads.
    const suspended = (): boolean => monitor.overrideNow() !== null
    expect(suspended()).toBe(false)
    monitor.grantFiveHour()
    expect(suspended()).toBe(true)
    monitor.revokeFiveHour()
    // Withdrawn: the very next start is bound by the quota again, which is what stops a round
    // that is still walking its Fellows.
    expect(suspended()).toBe(false)
  })

  it('can be withdrawn on the spot', () => {
    monitor.grantFiveHour()
    expect(gate()).toBeNull()
    expect(monitor.revokeFiveHour()).not.toBeNull()
    expect(monitor.overrideNow()).toBeNull()
    expect(gate()).toMatchObject({ code: 'reserve' })
  })

  it('keeps every grant as a row, which is the record of what was released', () => {
    monitor.grantFiveHour()
    monitor.revokeFiveHour()
    const store = new SqlitePlanOverrideStore(db)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ window: 'five_hour', pct: OVERRIDE_PCT, expiresAt: RESET })
    expect(store.list()[0]!.revokedAt).not.toBeNull()
  })
})
