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
import { UsageMonitor, OVERRIDE_PCT, isPermanentRefusal, type PlanSettings } from '../src/pipeline/usage-monitor.js'
import { SqliteAgentRunStore } from '../src/db/agent-runs.js'

const SETTINGS: PlanSettings = {
  researchShareWeekPct: 10,
  researchShare5hPct: 15,
  reserve5hPct: 60,
  reserveWeekPct: 80,
  planWeekUsd: 1000,
  plan5hUsd: 80,
  planName: '',
  fiveHourOverrideEnabled: true, weekOverrideEnabled: false,
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
    /*
     * A second past the reset the window this grant belonged to is over, and so is the reading
     * that reported it - a measurement of the window before last says nothing about the one
     * that just began (2026-09-17). What the reserve does WITHOUT a grant is therefore asked
     * of the new window, with a reading about it: the grant is gone, so 70% refuses again.
     */
    expect(gate()).toBeNull()
    sample('five_hour', 70, '2026-09-07T23:00:00.000Z')
    expect(gate()).toMatchObject({ code: 'reserve', window: 'five_hour' })
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
      // A transient reason, so this tests the masking and not the permanent-refusal path.
      fetchEndpoint: async () => ({ ok: false, reason: 'the usage endpoint answered 503' }),
    })
    return withEndpoint.refresh(true).then(() => {
      expect(withEndpoint.status({ estCostUsd: 2, model: 'sonnet-5' }).liveReason).toBe('the usage endpoint answered 503')
      // A run samples successfully - and the endpoint's silence still has its reason.
      withEndpoint.recordSdk({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 5, resets_at: RESET } } }, 'after', 'r1')
      expect(withEndpoint.status({ estCostUsd: 2, model: 'sonnet-5' }).liveReason).toBe('the usage endpoint answered 503')
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

  it('stops asking once the endpoint refuses for a reason no waiting fixes, and says why', async () => {
    let asked = 0
    const m = new UsageMonitor({
      store: new SqliteUsageSampleStore(db),
      overrides: new SqlitePlanOverrideStore(db),
      runs: new SqliteAgentRunStore(db),
      settings: () => SETTINGS,
      now: () => clock,
      fetchEndpoint: async () => {
        asked++
        return { ok: false, reason: 'OAuth token does not meet scope requirement user:profile' }
      },
    })
    await m.refresh(true)
    expect(asked).toBe(1)
    // Asked again, forced, and after the cache would have expired: still not asked.
    await m.refresh(true)
    clock = new Date(clock.getTime() + 6 * 3600_000)
    await m.refresh()
    expect(asked).toBe(1)
    // And what it says is the reason, not the HTTP answer that produced it.
    const reason = m.status({ estCostUsd: 2, model: 'sonnet-5' }).liveReason ?? ''
    expect(reason).toContain('inference-only by design')
    expect(reason).not.toContain('scope requirement')
  })

  it('keeps retrying a refusal that IS a moment, like a rate limit', async () => {
    let asked = 0
    const m = new UsageMonitor({
      store: new SqliteUsageSampleStore(db),
      overrides: new SqlitePlanOverrideStore(db),
      runs: new SqliteAgentRunStore(db),
      settings: () => SETTINGS,
      now: () => clock,
      fetchEndpoint: async () => {
        asked++
        return { ok: false, reason: 'Rate limited. Please try again later.' }
      },
    })
    await m.refresh(true)
    await m.refresh(true)
    expect(asked).toBe(2)
    expect(m.status({ estCostUsd: 2, model: 'sonnet-5' }).liveReason).toContain('Rate limited')
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

describe('telling a permanent refusal from a moment', () => {
  it('knows the scope refusal, whatever wording it arrives in', () => {
    expect(isPermanentRefusal('OAuth token does not meet scope requirement user:profile')).toBe(true)
    expect(isPermanentRefusal('missing user:profile')).toBe(true)
  })

  it('leaves everything else to the backoff', () => {
    expect(isPermanentRefusal('Rate limited. Please try again later.')).toBe(false)
    expect(isPermanentRefusal('the usage endpoint answered 503')).toBe(false)
    expect(isPermanentRefusal(null)).toBe(false)
  })
})

/**
 * Releasing the WEEK for one night (SPEC section 8.6a).
 *
 * The week was the bound every other grant survived, and that is what made a released
 * afternoon a bounded decision. So what is tested here is the bound that replaced it: the
 * grant ends with the night it was asked for, never with the week, and it is refused without
 * a night to end at.
 */
describe('the week release', () => {
  let db: Db
  let monitor: UsageMonitor
  let clock: Date
  const NIGHT_END = '2026-09-08T00:00:00.000Z'
  const WEEK_RESET = '2026-09-13T12:00:00.000Z'

  const sample = (window: string, utilization: number, resetsAt: string | null): void => {
    new SqliteUsageSampleStore(db).record({ ts: clock.toISOString(), window, utilization, resetsAt, runId: null, phase: 'tick', source: 'endpoint' })
  }

  beforeEach(() => {
    db = openDb(MEMORY_DB)
    migrate(db)
    clock = new Date('2026-09-07T21:00:00.000Z')
    monitor = new UsageMonitor({
      store: new SqliteUsageSampleStore(db),
      overrides: new SqlitePlanOverrideStore(db),
      runs: new SqliteAgentRunStore(db),
      settings: () => ({ ...SETTINGS, weekOverrideEnabled: true }),
      now: () => clock,
    })
    sample('five_hour', 10, '2026-09-08T02:00:00.000Z')
    sample('seven_day', 83, WEEK_RESET)
  })

  const gate = (): ReturnType<UsageMonitor['gate']> => monitor.gate({ estCostUsd: 2, model: 'sonnet-5', kind: 'research-step' })

  it('opens a night the week reserve had closed', () => {
    // The case this was built for: 83 % against an 80 % reserve stops even the planning runs.
    expect(gate()).toMatchObject({ code: 'reserve', window: 'seven_day' })
    expect(monitor.grantWeek(NIGHT_END)).toMatchObject({ ok: true })
    expect(gate()).toBeNull()
  })

  it('ends with the night, not with the week', () => {
    /*
     * The whole point of the design. The week's own reset is five days out; a grant that ran
     * to it would be the open tap the five-hour release was built to avoid.
     */
    monitor.grantWeek(NIGHT_END)
    expect(monitor.weekOverrideNow()?.expiresAt).toBe(NIGHT_END)
    clock = new Date('2026-09-08T00:00:01.000Z')
    expect(monitor.weekOverrideNow()).toBeNull()
    expect(gate()).toMatchObject({ code: 'reserve', window: 'seven_day' })
  })

  it('refuses without a night to end at, and refuses a night already over', () => {
    // An open-ended release is the one thing this must never become.
    expect(monitor.grantWeek(null)).toMatchObject({ ok: false })
    expect(monitor.grantWeek('2026-09-07T20:00:00.000Z')).toMatchObject({ ok: false })
    expect(monitor.weekOverrideNow()).toBeNull()
  })

  it('renews nothing, and can be withdrawn', () => {
    monitor.grantWeek(NIGHT_END)
    expect(monitor.grantWeek(NIGHT_END)).toMatchObject({ ok: false })
    expect(monitor.revokeWeek()).not.toBeNull()
    expect(monitor.weekOverrideNow()).toBeNull()
    expect(gate()).toMatchObject({ code: 'reserve', window: 'seven_day' })
    // Withdrawing twice is not an error; there is simply nothing left to end.
    expect(monitor.revokeWeek()).toBeNull()
  })

  it('lifts both week bounds, and leaves the five-hour ones alone', () => {
    monitor.grantWeek(NIGHT_END)
    const s = monitor.status({ estCostUsd: 2, model: 'sonnet-5' })
    expect(s.weekOverride).toMatchObject({ enabled: true, active: true, pct: OVERRIDE_PCT, expiresAt: NIGHT_END })
    /*
     * The reported share is the lifted one: the number a reader judges the night by has to be
     * the number the gate judges it by. Uncalibrated, the shares are stated in USD, so this is
     * 90 % of the week's 1000 rather than 10 % of it.
     */
    expect(s.shares.unit).toBe('usd')
    expect(s.shares.week).toBe(900)
    expect(s.override.active).toBe(false)
    // And the five-hour reserve still stops a night of its own.
    sample('five_hour', 95, '2026-09-08T02:00:00.000Z')
    expect(gate()).toMatchObject({ code: 'reserve', window: 'five_hour' })
  })

  it('is nothing at all while its switch is off', () => {
    // The switch lives in the route, not here - but the status has to say so, or the button
    // would offer what the endpoint refuses.
    const off = new UsageMonitor({
      store: new SqliteUsageSampleStore(db),
      overrides: new SqlitePlanOverrideStore(db),
      runs: new SqliteAgentRunStore(db),
      settings: () => SETTINGS,
      now: () => clock,
    })
    expect(off.status({ estCostUsd: 2, model: 'sonnet-5' }).weekOverride.enabled).toBe(false)
  })
})
