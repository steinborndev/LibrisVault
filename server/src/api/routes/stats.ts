/**
 * GET /api/v1/stats — the Overview tab's numbers (SPEC.md §6.1, TASKS-M3 §1):
 * page counts by type, 7-day KPIs from `jobs`, wiki growth + last commits from git, the
 * most-recently-changed pages, the hot-cache markdown, and live queue/watcher state.
 *
 * Everything vault-derived is READ-only (hard rule 1) and cached for a short TTL, since a
 * `git log` scan isn't free; the cache is invalidated by the bus `stats` event (a commit
 * landed) so the Overview updates without a manual refresh (DoD).
 */

import { MemoryDismissalStore } from '../../db/domain-dismissals.js'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import {
  pageCounts,
  recentPages,
  recentCommits,
  growth,
  readHotCache,
  hotCacheUpdatedAt,
  hotCacheWords,
  latestLintReport,
  type PageCounts,
  type RecentPage,
  type Commit,
  type GrowthPoint,
} from '../../pipeline/vault-stats.js'
import { unversionedWikiPages } from '../../pipeline/git.js'
import { HOT_CACHE_WORD_BUDGET, HOT_CACHE_WORD_LIMIT } from '../../pipeline/validator.js'
import { budgetStatus, budgetUnit, startOfToday } from '../../pipeline/budget.js'

const CACHE_TTL_MS = 5_000
const GROWTH_DAYS = 30

interface VaultDerived {
  readonly pages: PageCounts
  readonly recentPages: RecentPage[]
  readonly commits: Commit[]
  readonly growth: GrowthPoint[]
  readonly hotCache: string | null
  readonly hotCacheUpdatedAt: string | null
  /** Its length, the budget it is written to, and the size the check warns at (validator.ts). */
  readonly hotCacheWords: number | null
  readonly hotCacheBudget: number
  readonly hotCacheLimit: number
  readonly lintReport: { path: string; date: string | null } | null
  readonly unversioned: UnversionedSummary
}

/** Wiki pages on disk that git has no committed copy of (finding F4's blind spot). */
interface UnversionedSummary {
  readonly untracked: number
  readonly modified: number
  /** A few page paths, so the dashboard can name what it is talking about. */
  readonly examples: string[]
}

export function registerStatsRoute(app: FastifyInstance, ctx: AppContext): void {
  const { config, store, queue, settings } = ctx
  // Commits the user took off the Activity stream: filtered out of the history below and
  // fetched over, so a row removed does not shorten the history it was removed from.
  const dismissed = ctx.commitDismissals ?? new MemoryDismissalStore()

  // Short-TTL cache for the filesystem+git scan. Invalidated eagerly on a `stats` bus event
  // so a completed ingest shows up immediately, and lazily after the TTL as a backstop.
  let cache: { at: number; data: VaultDerived } | undefined
  /*
   * One scan at a time (2026-09-25): when the cache expires, every request arriving before the
   * scan finishes waits for that scan instead of starting its own `git log` and `git status`.
   * A burst of cold requests on a public demo was otherwise one burst of git processes. The
   * generation makes a scan that an invalidation overtook return its data without caching it.
   */
  let inflight: Promise<VaultDerived> | undefined
  let generation = 0
  ctx.events.subscribe((e) => {
    if (e.kind === 'stats') {
      cache = undefined
      generation++
    }
  })

  function vaultDerived(): Promise<VaultDerived> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return Promise.resolve(cache.data)
    inflight ??= scanVault().finally(() => {
      inflight = undefined
    })
    return inflight
  }

  async function scanVault(): Promise<VaultDerived> {
    const now = Date.now()
    const startedAt = generation
    const pages = pageCounts(config.vaultRoot)
    // git can fail (no commits, not a repo) — never let it sink the whole Overview.
    const hidden = dismissed.keys()
    const [commits, growthPoints, unversionedPages] = await Promise.all([
      // 12, not 8: the System tab lists these as the vault's history, and eight rows of a
      // busy day is not a history. Home reads the same array for its activity stream.
      recentCommits(config.vaultRoot, 12 + hidden.size)
        .then((all) => all.filter((c) => !hidden.has(c.hash)).slice(0, 12))
        .catch(() => [] as Commit[]),
      growth(config.vaultRoot, GROWTH_DAYS, pages.total).catch(() => [] as GrowthPoint[]),
      // One `git status` (~8ms on a 750-page vault), and it rides this cache like the rest.
      unversionedWikiPages(config.vaultRoot).catch(() => ({ untracked: [], modified: [] })),
    ])
    const data: VaultDerived = {
      pages,
      recentPages: recentPages(config.vaultRoot, 12),
      commits,
      growth: growthPoints,
      hotCache: readHotCache(config.vaultRoot),
      hotCacheUpdatedAt: hotCacheUpdatedAt(config.vaultRoot),
      hotCacheWords: hotCacheWords(config.vaultRoot),
      hotCacheBudget: HOT_CACHE_WORD_BUDGET,
      hotCacheLimit: HOT_CACHE_WORD_LIMIT,
      lintReport: latestLintReport(config.vaultRoot),
      unversioned: {
        untracked: unversionedPages.untracked.length,
        modified: unversionedPages.modified.length,
        examples: [...unversionedPages.untracked, ...unversionedPages.modified].slice(0, 5),
      },
    }
    if (startedAt === generation) cache = { at: now, data }
    return data
  }

  app.get('/api/v1/stats', async () => {
    const derived = await vaultDerived()

    // 7-day KPIs: ingests completed, failures, and duplicates/sources seen (SPEC.md §6.1).
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const finishedSince = store.countsSince(since)
    const counts = store.counts()

    const queued = counts['queued'] ?? 0
    const active = (counts['preprocessing'] ?? 0) + (counts['ingesting'] ?? 0)

    // Token/cost aggregates (SPEC.md §7.1 "Anzeige"). In oauth mode `costUsd` is an API-price
    // equivalent, not money charged — the UI labels it "Schätzwert (Abo)", which is what
    // `authMode` below is here for.
    const usage = {
      today: store.usageSince(startOfToday().toISOString()),
      last7d: store.usageSince(since),
    }
    const budget = settings
      ? budgetStatus(config, settings.effective(config), store)
      : { limit: null, unit: budgetUnit(config), spent: 0, exceeded: false, resetsAt: '' }

    return {
      vaultName: config.obsidianVaultName,
      /** Anthropic auth mode — drives the "estimate (subscription)" labelling across the whole UI. */
      authMode: config.auth?.mode ?? 'none',
      pages: derived.pages,
      recentPages: derived.recentPages,
      commits: derived.commits,
      growth: derived.growth,
      hotCache: derived.hotCache,
      hotCacheUpdatedAt: derived.hotCacheUpdatedAt,
      hotCacheWords: derived.hotCacheWords,
      hotCacheBudget: derived.hotCacheBudget,
      hotCacheLimit: derived.hotCacheLimit,
      /** Newest lint report page in the vault — the Maintenance tab's persistent link. */
      lintReport: derived.lintReport,
      /** Wiki pages on disk with no committed copy - F4's blind spot, made visible. */
      unversioned: derived.unversioned,
      kpis7d: {
        ingests: finishedSince['done'] ?? 0,
        failures: finishedSince['failed'] ?? 0,
        deferred: finishedSince['deferred'] ?? 0,
        duplicates: finishedSince['duplicate'] ?? 0,
      },
      /** 14 days of per-day done/failed counts (sparse) — KPI sparklines + week-over-week deltas. */
      kpisDaily: store.dailyFinished(14),
      usage,
      budget,
      jobs: counts,
      queue: { queued, active, ...queue.stats() },
      // The watcher only starts outside setup mode (main.ts): report what actually runs. A
      // hosted demo keeps the folder's path to itself, as the settings view does (SPEC.md §12.8).
      watcher: { active: config.auth !== null, folder: config.demoMode ? '(hidden in demo)' : config.server.watchFolder },
      generatedAt: new Date().toISOString(),
    }
  })

  /*
   * Take a commit off the Activity stream, or put it back. The vault keeps the commit; only
   * the stream forgets it. A short hash, as the stream shows it.
   */
  const validHash = (hash: string): boolean => /^[0-9a-f]{7,40}$/i.test(hash)
  app.post('/api/v1/stats/commits/:hash/dismiss', async (req, reply) => {
    const { hash } = req.params as { hash: string }
    if (!validHash(hash)) return reply.code(400).send({ error: 'not a commit hash' })
    dismissed.dismiss(hash.toLowerCase())
    cache = undefined
    ctx.events.publish({ kind: 'stats' })
    return reply.send({ ok: true, hash: hash.toLowerCase() })
  })
  app.delete('/api/v1/stats/commits/:hash/dismiss', async (req, reply) => {
    const { hash } = req.params as { hash: string }
    if (!validHash(hash)) return reply.code(400).send({ error: 'not a commit hash' })
    dismissed.restore(hash.toLowerCase())
    cache = undefined
    ctx.events.publish({ kind: 'stats' })
    return reply.send({ ok: true, hash: hash.toLowerCase() })
  })

}
