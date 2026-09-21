/**
 * Runtime settings (SPEC.md §6.4 "Einstellungen", §6.5 `GET/PUT /api/v1/settings`) stored in
 * the key/value `settings` table.
 *
 * PRECEDENCE — one model, decided and enforced here so no call site has to guess:
 *
 *   env / env-file (config.ts)  =  START-TIME BASELINE
 *   settings table              =  RUNTIME OVERRIDES, for an explicit allowlist of keys
 *   effective value             =  override ?? baseline
 *
 * An override outlives a restart (it is in SQLite); clearing one (write `null`) falls back to
 * the baseline. Losing the DB therefore only loses overrides, never the vault (hard rule 1).
 *
 * What is deliberately NOT settable at runtime, and why:
 *  - bind host/port — hard rule 2 / SPEC.md §9: a settings write must never be able to move the
 *    service off localhost. The bind stays a start-time decision guarded by assertBindAllowed().
 *  - the Anthropic credential and HTTP auth token — hard rule 3: credentials live only in the
 *    service environment, are never stored in SQLite, and are never returned by the API.
 * The schema below is `.strict()`, so a PUT naming any of those is a 400 rather than a silent no-op.
 *
 * This table holds service configuration rather than per-user data, so unlike the other tables
 * it carries no `user_id`.
 */

import { z } from 'zod'
import type { Db } from './index.js'
import type { Config } from '../config.js'

/**
 * Queue worker default when nothing overrides it (SPEC.md §3.1).
 *
 * ONE, not two, since 2026-09-19. The vault's own ingest skill states the constraint it was
 * built under: "Single-writer only ... Do not run parallel ingests from multiple Claude
 * sessions or sub-agents that assign addresses. The flock in the helper prevents counter
 * corruption but does not serialize page writes themselves."
 *
 * We ran two, and 13 of 31 finished jobs overlapped another job in time. Nothing has corrupted
 * a page yet, but nothing was protecting one either: the per-file lock is a 60 s window (now
 * 600, see wiki-lock.ts) that 9.6 % of measured holds outlived, and two runs that both create
 * the "same" new concept page create it twice under two addresses.
 *
 * The setting stays live-applicable and still accepts up to 8, because a vault whose runs are
 * short and whose pages never overlap is a different vault. Raising it is a decision with
 * evidence behind it, which is why the UI says what the evidence would have to be.
 */
export const DEFAULT_CONCURRENCY = 1
/** Whether the service commits after each ingest by default (SPEC.md §7 "Git-Auto-Commit"). */
export const DEFAULT_GIT_AUTO_COMMIT = true
/** The post-preprocessing DOI dedupe (SPEC.md §12.9) is on unless switched off. */
export const DEFAULT_DOI_DEDUPE = true
/** The enqueue-time URL dedupe (SPEC.md §12.9, 2026-09-18) is on unless switched off. */
export const DEFAULT_URL_DEDUPE = true

/**
 * The settable keys. `null` clears an override (falls back to the baseline). `.strict()` makes
 * an unknown key — notably `host`, `port`, or any credential — a validation error.
 */
export const SETTINGS_SCHEMA = z
  .object({
    /** Folder watched for drops. Bound at startup by the watcher → restart required. */
    watchFolder: z.string().min(1).nullable(),
    /** Concurrent ingest workers. Applied live to the running queue. */
    concurrency: z.number().int().min(1).max(8).nullable(),
    /** Upload size limit. Registered with the multipart plugin at startup → restart required. */
    maxUploadBytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024)
      .nullable(),
    /** Whether an ingest auto-commits to the vault. Applied live. */
    gitAutoCommit: z.boolean().nullable(),
    /**
     * Whether a document whose DOI a source page already declares is settled as a duplicate
     * after preprocessing instead of being ingested (SPEC.md §12.9). The escape hatch for a
     * wrong match: switch it off, drop the file again. Applied live.
     */
    doiDedupe: z.boolean().nullable(),
    /**
     * Whether a link whose canonical address a source page already declares is settled as a
     * duplicate at enqueue, before anything is fetched (SPEC.md §12.9). The escape hatch for
     * re-ingesting a page that changed since: switch it off, submit the link again. Applied live.
     */
    urlDedupe: z.boolean().nullable(),
    /**
     * Per-day ceiling before the queue pauses (SPEC.md §7.1, §11.3). The UNIT depends on the
     * auth mode — ingests/day in oauth (subscription) mode, USD/day with an API key — see
     * `pipeline/budget.ts`. `null` (the default) means no budget. Applied live.
     */
    dailyBudget: z.number().positive().nullable(),
    /**
     * The Fellows' night shift window, local wall-clock `HH:MM` (docs/agents/SPEC.md
     * section 8.2). Read at every scheduler tick, so a change applies to the next night.
     */
    nightWindowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
    nightWindowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
    /** Default model for a newly spawned Fellow. */
    researchModelDefault: z.enum(['sonnet-5', 'opus-5', 'fable-5-1']).nullable(),
    /** When the daily recap is built, local `HH:MM` (docs/agents/SPEC.md section 9). */
    recapTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
    /** The Fellows' research shares and reserves in plan percent (section 8.2, A5). */
    researchShareWeekPct: z.number().min(0).max(100).nullable(),
    researchShare5hPct: z.number().min(0).max(100).nullable(),
    reserve5hPct: z.number().min(0).max(100).nullable(),
    reserveWeekPct: z.number().min(0).max(100).nullable(),
    /** USD-equivalent size of the plan windows for the fallback accounting (section 16). */
    planWeekUsd: z.number().positive().max(100_000).nullable(),
    plan5hUsd: z.number().positive().max(10_000).nullable(),
    /**
     * What the subscription is called, for the corner of the Library ("5x max"). The SDK
     * reports `subscription_type` on some accounts and not on others, and the usage endpoint
     * that also carries it is rate limited here - so the one thing the user knows for certain
     * about their own plan is a setting, not a measurement. Empty = show what is measured.
     */
    planName: z.string().max(40).nullable(),
    /**
     * Whether the five-hour override exists at all (SPEC section 8.6). Off by default: it is
     * the one control in the service that releases budget, and a feature that can only be
     * turned OFF after the fact is not a safety switch. Off means the button is gone and the
     * endpoint refuses, whoever asks.
     */
    fiveHourOverrideEnabled: z.boolean().nullable(),
    weekOverrideEnabled: z.boolean().nullable(),
    /**
     * Whether the shift may spend a read-only run asking a model which topics are duplicates
     * (section 6.6). Off by default: it costs a run a night, and the two lexical passes keep
     * working without it. Measured before it was built - it is the only mechanism tried that
     * separates real duplicates from the follow-ups that must still run.
     */
    dedupeJudgeEnabled: z.boolean().nullable(),
    /**
     * Whether a URL job whose page is blocked or abstract-thin looks for a legal open-access
     * copy of the same DOI (docs/sources/SPEC.md section 5). On by default: it turns a failed
     * job into a read one, and every candidate goes through the same SSRF guard and caps as a
     * user's own address. Off means the job fails or stays thin exactly as it did before.
     */
    oaRecovery: z.boolean().nullable(),
  })
  .partial()
  .strict()

export type SettingsPatch = z.infer<typeof SETTINGS_SCHEMA>
/** Stored overrides — same keys, but never null (a null write deletes the row instead). */
export type SettingsOverrides = { -readonly [K in keyof SettingsPatch]?: NonNullable<SettingsPatch[K]> }

/** Keys whose change only takes effect after a service restart (bound at startup). */
export const RESTART_REQUIRED_KEYS = ['watchFolder', 'maxUploadBytes'] as const
export type RestartRequiredKey = (typeof RESTART_REQUIRED_KEYS)[number]

/** The fully-resolved configuration the service actually runs with. */
export interface EffectiveSettings {
  readonly watchFolder: string
  readonly concurrency: number
  readonly maxUploadBytes: number
  readonly gitAutoCommit: boolean
  readonly doiDedupe: boolean
  readonly urlDedupe: boolean
  /** null = no daily budget (the default). Unit depends on auth mode — see pipeline/budget.ts. */
  readonly dailyBudget: number | null
  /** The Fellows' night shift, local `HH:MM` (docs/agents/SPEC.md section 8.2). */
  readonly nightWindowStart: string
  readonly nightWindowEnd: string
  /** Model a new Fellow gets when the spawn names none. */
  readonly researchModelDefault: 'sonnet-5' | 'opus-5' | 'fable-5-1'
  /** When the daily recap is built, local `HH:MM`. */
  readonly recapTime: string
  /** Plan-percent shares and reserves (section 8.2). */
  readonly researchShareWeekPct: number
  readonly researchShare5hPct: number
  readonly reserve5hPct: number
  readonly reserveWeekPct: number
  /** USD-equivalent window sizes for the fallback accounting (section 16). */
  readonly planWeekUsd: number
  readonly plan5hUsd: number
  /** The subscription's own name, when the user has told us; '' = go by what is measured. */
  readonly planName: string
  /** Whether the five-hour override may be granted at all (section 8.6). */
  readonly fiveHourOverrideEnabled: boolean
  /**
   * Whether the week's reserve and share may be released for a night (SPEC section 8.6a). Off
   * by default, and off means the button is gone and the endpoint refuses whoever asks: the
   * week is the bound every other grant survives, so turning it off after the fact would not
   * be a safety switch.
   */
  readonly weekOverrideEnabled: boolean
  /** Whether the shift asks a model to judge duplicate topics (section 6.6). */
  readonly dedupeJudgeEnabled: boolean
  /** Whether a blocked or thin URL job looks for an open-access copy (docs/sources/SPEC.md 5). */
  readonly oaRecovery: boolean
}

/** On unless switched off: a blocked page with a DOI is worth one look for an open copy. */
export const DEFAULT_OA_RECOVERY = true

/** The plan-percent defaults (review decision OPEN-12) and the section 16 reference sizes. */
export const DEFAULT_PLAN = { researchShareWeekPct: 10, researchShare5hPct: 15, reserve5hPct: 60, reserveWeekPct: 80, planWeekUsd: 1000, plan5hUsd: 80, planName: '', fiveHourOverrideEnabled: false, weekOverrideEnabled: false, dedupeJudgeEnabled: false } as const

/** The night shift defaults (review decision OPEN-11). */
export const DEFAULT_NIGHT_WINDOW = { start: '01:00', end: '06:00' } as const
export const DEFAULT_RESEARCH_MODEL = 'sonnet-5' as const
export const DEFAULT_RECAP_TIME = '07:00'

/** Baseline (start-time) values, before any override is applied. */
export function baselineSettings(config: Config): EffectiveSettings {
  return {
    watchFolder: config.server.watchFolder,
    concurrency: DEFAULT_CONCURRENCY,
    maxUploadBytes: config.server.maxUploadBytes,
    gitAutoCommit: DEFAULT_GIT_AUTO_COMMIT,
    doiDedupe: DEFAULT_DOI_DEDUPE,
    oaRecovery: DEFAULT_OA_RECOVERY,
    urlDedupe: DEFAULT_URL_DEDUPE,
    // No env baseline: a budget is opt-in, so "unset" means unlimited. Clearing the override
    // therefore lands back on null, which reads the same as never having set one.
    dailyBudget: null,
    nightWindowStart: DEFAULT_NIGHT_WINDOW.start,
    nightWindowEnd: DEFAULT_NIGHT_WINDOW.end,
    researchModelDefault: DEFAULT_RESEARCH_MODEL,
    recapTime: DEFAULT_RECAP_TIME,
    ...DEFAULT_PLAN,
  }
}

/** Applies overrides on top of the baseline — the single definition of "effective". */
export function effectiveSettings(config: Config, overrides: SettingsOverrides): EffectiveSettings {
  const base = baselineSettings(config)
  return {
    watchFolder: overrides.watchFolder ?? base.watchFolder,
    concurrency: overrides.concurrency ?? base.concurrency,
    maxUploadBytes: overrides.maxUploadBytes ?? base.maxUploadBytes,
    gitAutoCommit: overrides.gitAutoCommit ?? base.gitAutoCommit,
    doiDedupe: overrides.doiDedupe ?? base.doiDedupe,
    oaRecovery: overrides.oaRecovery ?? base.oaRecovery,
    urlDedupe: overrides.urlDedupe ?? base.urlDedupe,
    dailyBudget: overrides.dailyBudget ?? base.dailyBudget,
    nightWindowStart: overrides.nightWindowStart ?? base.nightWindowStart,
    nightWindowEnd: overrides.nightWindowEnd ?? base.nightWindowEnd,
    researchModelDefault: overrides.researchModelDefault ?? base.researchModelDefault,
    recapTime: overrides.recapTime ?? base.recapTime,
    researchShareWeekPct: overrides.researchShareWeekPct ?? base.researchShareWeekPct,
    researchShare5hPct: overrides.researchShare5hPct ?? base.researchShare5hPct,
    reserve5hPct: overrides.reserve5hPct ?? base.reserve5hPct,
    reserveWeekPct: overrides.reserveWeekPct ?? base.reserveWeekPct,
    planWeekUsd: overrides.planWeekUsd ?? base.planWeekUsd,
    plan5hUsd: overrides.plan5hUsd ?? base.plan5hUsd,
    planName: overrides.planName ?? base.planName,
    fiveHourOverrideEnabled: overrides.fiveHourOverrideEnabled ?? base.fiveHourOverrideEnabled,
    weekOverrideEnabled: overrides.weekOverrideEnabled ?? base.weekOverrideEnabled,
    dedupeJudgeEnabled: overrides.dedupeJudgeEnabled ?? base.dedupeJudgeEnabled,
  }
}

export class SettingsStore {
  constructor(private readonly db: Db) {}

  /**
   * All stored overrides. Values that no longer validate (e.g. written by an older build, or
   * hand-edited in the DB) are ignored rather than thrown: a bad row must not stop the service
   * from starting — it simply falls back to the baseline.
   */
  overrides(): SettingsOverrides {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string
      value: string | null
    }>
    const raw: Record<string, unknown> = {}
    for (const row of rows) {
      if (row.value === null) continue
      try {
        raw[row.key] = JSON.parse(row.value)
      } catch {
        // Unparseable row — ignore it, the baseline applies.
      }
    }
    const parsed = SETTINGS_SCHEMA.safeParse(raw)
    if (parsed.success) return stripNulls(parsed.data)
    // Salvage the keys that do validate individually so one bad row can't blank the rest.
    const salvaged: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) {
      const one = SETTINGS_SCHEMA.safeParse({ [key]: value })
      if (one.success) Object.assign(salvaged, stripNulls(one.data))
    }
    return salvaged as SettingsOverrides
  }

  /**
   * Applies a validated patch: a value writes/updates an override, `null` deletes it (falling
   * back to the baseline). Returns the resulting override set.
   */
  set(patch: SettingsPatch): SettingsOverrides {
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    const remove = this.db.prepare('DELETE FROM settings WHERE key = ?')
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) remove.run(key)
        else if (value !== undefined) upsert.run(key, JSON.stringify(value))
      }
    })()
    return this.overrides()
  }

  /** The effective configuration (baseline + overrides). */
  effective(config: Config): EffectiveSettings {
    return effectiveSettings(config, this.overrides())
  }
}

/** Drops explicit nulls so the override map only carries real values. */
function stripNulls(data: SettingsPatch): SettingsOverrides {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) out[key] = value
  }
  return out as SettingsOverrides
}
