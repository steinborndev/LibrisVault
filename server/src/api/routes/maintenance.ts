/**
 * Maintenance API (SPEC.md §6.4, §6.5): lint, autoresearch, hot-cache refresh. Each is a
 * vault-mutating agent run. Runs are ASYNC/job-style (TASKS-M5 §0): the POST registers a run
 * and returns `202 { id, channel, status: 'running' }` immediately — it does NOT hold the
 * request for the (up to 15-min) run, so a slow or stuck run can never wedge the HTTP request.
 * The run streams a live log over the event bus on its `channel` (`maintenance:<kind>`), which
 * the Wartung tab renders; the client polls `GET /maintenance/runs/:id` for the final result.
 * Runs are serialized (one vault writer) and share the ingest commit mutex.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AppContext } from '../server.js'
import type { GraphBuilder } from '../../pipeline/graph.js'
import { VALIDATOR_RULES, VAULT_WIDE_RULES } from '../../pipeline/validator.js'
import type { DismissalStore } from '../../db/domain-dismissals.js'
import type { MaintenanceStateStore } from '../../db/maintenance-state.js'
import type { AgentRunStore } from '../../db/agent-runs.js'
import {
  DomainRegistryMissingError,
  LintReportMissingError,
  LintScanMissingError,
  type RepairTask,
  type TagFixAction,
} from '../../pipeline/maintenance.js'
import { RetrieveScriptsMissingError, retrieveIndexStats } from '../../pipeline/retrieve-index.js'
import { readDomainRegistry, DOMAIN_REGISTRY_PATH } from '../../pipeline/domains.js'
import { findDomainCandidates } from '../../pipeline/domain-candidates.js'
import { repairWrappedLinks } from '../../pipeline/link-repair.js'
import {
  researchProfileList,
  isResearchProfileKey,
  DEFAULT_PROFILE_KEY,
} from '../../pipeline/research-profiles.js'

/**
 * How long the composer waits for a suggestion. Shorter than `reformulate`'s own default: a
 * person is watching the box, and a raw question they can edit beats a better one that arrives
 * after they have given up on it.
 */
const TOPIC_ENDPOINT_TIMEOUT_MS = 60_000

export function registerMaintenanceRoute(
  app: FastifyInstance,
  ctx: AppContext,
  graph?: GraphBuilder,
  dismissals?: DismissalStore,
  state?: MaintenanceStateStore,
  runs?: AgentRunStore,
): void {
  const { maintenance } = ctx

  /** Setup mode (no credential): every run-starting POST answers 503 instead of spawning. */
  const credentialMissing = (reply: FastifyReply): boolean => {
    if (ctx.config.auth !== null) return false
    void reply.code(503).send({
      error: 'no Anthropic credential configured: add it under System → Integrations, then restart',
    })
    return true
  }

  app.post('/api/v1/maintenance/lint', async (_req, reply) => {
    if (credentialMissing(reply)) return reply
    return reply.code(202).send(maintenance.startLint())
  })

  // Fix the newest lint report's SAFE findings (the skill's own safe/needs-review split).
  // 409 without a report — the report is what bounds the run.
  app.post('/api/v1/maintenance/lint-fix', async (_req, reply) => {
    if (credentialMissing(reply)) return reply
    try {
      return reply.code(202).send(maintenance.startLintFix())
    } catch (err) {
      if (err instanceof LintReportMissingError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  /**
   * Render the report from a scan a previous run already produced - the cheap half of a
   * lint, without repeating the expensive half. 409 when there is nothing newer than the
   * current report to render: the artifact is what bounds the run.
   */
  app.post('/api/v1/maintenance/lint-report', async (_req, reply) => {
    if (credentialMissing(reply)) return reply
    try {
      return reply.code(202).send(maintenance.startLintReport())
    } catch (err) {
      if (err instanceof LintScanMissingError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  app.post('/api/v1/maintenance/hot-cache', async (_req, reply) => {
    if (credentialMissing(reply)) return reply
    return reply.code(202).send(maintenance.startHotCache())
  })

  /**
   * Joins wikilinks a line wrap broke, across the whole wiki. No agent and no credential: the
   * rule is mechanical, so this is the one maintenance action that costs nothing and cannot
   * invent anything. `?dry=1` reports what it would join without writing.
   */
  app.post('/api/v1/maintenance/rejoin-links', async (req, reply) => {
    const dry = (req.query as { dry?: string } | undefined)?.dry === '1'
    const out = await repairWrappedLinks(ctx.config.vaultRoot, {
      ...(ctx.commitMutex ? { commitMutex: ctx.commitMutex } : {}),
      autoCommit: () => ctx.settings?.effective(ctx.config).gitAutoCommit ?? true,
      ...(dry ? { dryRun: true } : {}),
    })
    /*
     * A write to the vault gets the same check every other run gets (2026-09-21). This is the
     * one writing path that runs without a model, and it was also the one that reported
     * nothing afterwards: if it broke a page, no finding would say so, and the standing list
     * stayed as stale as it was before the run.
     */
    if (!dry && out.pages.length > 0 && ctx.validate !== undefined && ctx.validation !== undefined) {
      const findings = ctx.validate(out.pages)
      ctx.validation.record(findings, null)
      ctx.validation.resolveMissing(out.pages, findings, { checked: VALIDATOR_RULES, fullyChecked: VAULT_WIDE_RULES })
    }
    return reply.send(out)
  })

  /**
   * Reference cleanup, two premises behind one bounded agent run. Titles are
   * attacker-adjacent input that ends up in a prompt — enforce shape and size hard.
   *
   *   - default (`mode: 'deleted'`): the delete flow's follow-up offer over the dangling
   *     references the named deletions left behind;
   *   - `mode: 'gap'`: Home's "Worth a run" panel resolving a gap by unlinking it (SPEC.md
   *     §12.4, 2026-09-05). Every title must be an open gap of the LIVE graph - no free-text
   *     targets - and one unknown title rejects the whole request, exactly like `repair`:
   *     the user picked specific gaps, and silently dropping one would resolve less than
   *     they asked for.
   */
  app.post('/api/v1/maintenance/cleanup', async (req, reply) => {
    if (credentialMissing(reply)) return reply
    const body = (req.body ?? {}) as { pages?: unknown; mode?: unknown }
    const raw = Array.isArray(body.pages) ? body.pages : []
    const pages = raw
      .filter((p): p is string => typeof p === 'string')
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p !== '' && p.length <= 200)
      .slice(0, 20)
    if (pages.length === 0) {
      return reply.code(400).send({ error: 'provide "pages": the page titles to clean up after' })
    }
    if (body.mode === 'gap') {
      if (graph === undefined) return reply.code(409).send({ error: 'graph unavailable' })
      const open = new Set(graph.build().gaps.map((g) => g.title))
      const unknown = pages.filter((p) => !open.has(p))
      if (unknown.length > 0) {
        return reply.code(400).send({ error: `not an open gap of the vault graph: ${unknown.join(', ')}` })
      }
      return reply.code(202).send(maintenance.startGapCleanup(pages))
    }
    if (body.mode !== undefined && body.mode !== 'deleted') {
      return reply.code(400).send({ error: 'mode must be "deleted" (default) or "gap"' })
    }
    return reply.code(202).send(maintenance.startReferenceCleanup(pages))
  })

  /**
   * Graph repair (the explorer panel's "Repair" action): a bounded agent run over
   * user-selected connectivity problems. Task paths are attacker-adjacent input headed for
   * a prompt — every path must name a page in the LIVE graph (no free-text targets), any
   * invalid task rejects the whole request (the user selected specific things; silently
   * dropping one would repair less than they asked), and free-text reasons are size-capped.
   */
  app.post('/api/v1/maintenance/repair', async (req, reply) => {
    if (credentialMissing(reply)) return reply
    if (graph === undefined) return reply.code(409).send({ error: 'graph unavailable' })
    const known = new Set(graph.build().nodes.map((n) => n.path))
    const clean = (v: unknown, max: number): string | undefined => {
      if (typeof v !== 'string') return undefined
      const s = v.replace(/\s+/g, ' ').trim()
      return s !== '' && s.length <= max ? s : undefined
    }
    const body = (req.body ?? {}) as { tasks?: unknown }
    const raw = Array.isArray(body.tasks) ? body.tasks : []
    if (raw.length === 0 || raw.length > 10) {
      return reply.code(400).send({ error: 'provide "tasks": 1-10 repair tasks' })
    }
    const tasks: RepairTask[] = []
    for (const item of raw) {
      const t = (item ?? {}) as Record<string, unknown>
      const reason = clean(t['reason'], 200)
      if (t['kind'] === 'connect') {
        const path = clean(t['path'], 300)
        if (path === undefined || !known.has(path)) {
          return reply.code(400).send({ error: `connect task names no known wiki page: ${String(t['path'])}` })
        }
        tasks.push({ kind: 'connect', path, ...(reason ? { reason } : {}) })
      } else if (t['kind'] === 'edge') {
        const from = clean(t['from'], 300)
        const to = clean(t['to'], 300)
        if (from === undefined || !known.has(from) || to === undefined || !known.has(to)) {
          return reply.code(400).send({ error: `edge task names an unknown wiki page: ${String(t['from'])} -> ${String(t['to'])}` })
        }
        tasks.push({ kind: 'edge', from, to, ...(reason ? { reason } : {}) })
      } else {
        return reply.code(400).send({ error: 'each task needs kind "connect" or "edge"' })
      }
    }
    return reply.code(202).send(maintenance.startGraphRepair(tasks))
  })

  /**
   * Tag repair (the Maintenance tab's tag-hygiene card): a bounded agent run over
   * user-selected drop/merge actions. Tags are attacker-adjacent input headed for a
   * prompt — every named tag must exist in the LIVE graph (no free-text tags), any invalid
   * action rejects the whole request (the user selected specific repairs; silently dropping
   * one would repair less than they asked), and the action count is hard-capped.
   */
  app.post('/api/v1/maintenance/tag-fix', async (req, reply) => {
    if (credentialMissing(reply)) return reply
    if (graph === undefined) return reply.code(409).send({ error: 'graph unavailable' })
    const known = new Set(graph.build().nodes.flatMap((n) => n.tags))
    const cleanTag = (v: unknown): string | undefined => {
      if (typeof v !== 'string') return undefined
      const s = v.trim().replace(/^#/, '')
      return s !== '' && s.length <= 100 && known.has(s) ? s : undefined
    }
    const body = (req.body ?? {}) as { actions?: unknown }
    const raw = Array.isArray(body.actions) ? body.actions : []
    if (raw.length === 0 || raw.length > 20) {
      return reply.code(400).send({ error: 'provide "actions": 1-20 tag repairs' })
    }
    const actions: TagFixAction[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      const a = (item ?? {}) as Record<string, unknown>
      if (a['kind'] === 'drop') {
        const tag = cleanTag(a['tag'])
        if (tag === undefined) {
          return reply.code(400).send({ error: `drop action names no known tag: ${String(a['tag'])}` })
        }
        if (!seen.has(`drop|${tag}`)) actions.push({ kind: 'drop', tag })
        seen.add(`drop|${tag}`)
      } else if (a['kind'] === 'merge') {
        const from = cleanTag(a['from'])
        const to = cleanTag(a['to'])
        if (from === undefined || to === undefined || from === to) {
          return reply.code(400).send({ error: `merge action needs two distinct known tags: ${String(a['from'])} -> ${String(a['to'])}` })
        }
        if (!seen.has(`merge|${from}|${to}`)) actions.push({ kind: 'merge', from, to })
        seen.add(`merge|${from}|${to}`)
      } else {
        return reply.code(400).send({ error: 'each action needs kind "drop" or "merge"' })
      }
    }
    return reply.code(202).send(maintenance.startTagFix(actions))
  })

  // The domain backfill (SPEC.md §12.4 Stufe 2). 409 when no registry is installed — the
  // action is meaningless without the closed list it files against.
  app.post('/api/v1/maintenance/domain-backfill', async (_req, reply) => {
    if (credentialMissing(reply)) return reply
    try {
      return reply.code(202).send(maintenance.startDomainBackfill())
    } catch (err) {
      if (err instanceof DomainRegistryMissingError) {
        return reply.code(409).send({ error: err.message, registryPath: DOMAIN_REGISTRY_PATH })
      }
      throw err
    }
  })

  /**
   * The OPTIONAL agent pass over the deterministic candidates (SPEC.md §12.4 Stufe 3). The
   * candidates are recomputed here rather than taken from the client, so a stale browser tab
   * cannot make the agent judge themes that no longer exist. 409 when there is nothing to judge.
   */
  app.post('/api/v1/maintenance/domain-review', async (_req, reply) => {
    if (credentialMissing(reply)) return reply
    if (graph === undefined) return reply.code(409).send({ error: 'graph unavailable' })
    const { candidates } = findDomainCandidates({
      graph: graph.build(),
      registry: readDomainRegistry(ctx.config.vaultRoot),
      dismissed: dismissals?.keys() ?? new Set<string>(),
    })
    if (candidates.length === 0) {
      return reply.code(409).send({ error: 'no domain candidates to review' })
    }
    return reply.code(202).send(maintenance.startDomainReview(candidates))
  })

  // The closed lens list for the composer's profile picker ("Achse A"). Static — served so the
  // UI never hardcodes what the service accepts, and the POST below validates against the same set.
  app.get('/api/v1/maintenance/research/profiles', async (_req, reply) => {
    return reply.send({ profiles: researchProfileList(), default: DEFAULT_PROFILE_KEY })
  })

  /*
   * Reformulating one open question into a topic a run can act on
   * (docs/tasks/TASKS-QUESTIONS.md, phase 2).
   *
   * Deliberately NOT behind `AGENTS_ENABLED` (decision D4). The pinboard that sends most of
   * these IS behind it, but the Graph screen's gap backlog is base product and reaches the
   * composer through the same path; a route the base product calls has to answer with the flag
   * off, or it is one 404 per click - the exact rot hard rule 8 names.
   *
   * Synchronous, unlike every run-starting POST above it: the answer is one sentence, the user
   * is waiting on it in the composer, and there is nothing to stream. It is bounded by its own
   * timeout and answers `{ topic: null }` rather than an error when it does not work out, so a
   * failure costs the caller its suggestion and nothing else.
   */
  app.post('/api/v1/maintenance/research/topic', async (req, reply) => {
    if (credentialMissing(reply)) return reply
    const body = (req.body ?? {}) as { text?: unknown; from?: unknown }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text === '') return reply.code(400).send({ error: 'provide a non-empty "text"' })
    const from = typeof body.from === 'string' && body.from !== '' ? body.from : undefined
    const suggestion = await maintenance.suggestTopic(text, from, TOPIC_ENDPOINT_TIMEOUT_MS)
    return reply.send(suggestion ?? { topic: null })
  })

  app.post('/api/v1/maintenance/research', async (req, reply) => {
    if (credentialMissing(reply)) return reply
    const body = (req.body ?? {}) as { topic?: unknown; profileKey?: unknown; from?: unknown; title?: unknown }
    const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
    if (topic === '') return reply.code(400).send({ error: 'provide a non-empty "topic"' })
    /*
     * The page this topic was left open on (docs/tasks/TASKS-QUESTIONS.md, phase 1). Only the
     * TYPE is checked here; containment and existence are `startResearch`'s, so every caller of
     * it gets one answer. A path that fails there is dropped, not refused: naming the origin
     * page is an optimisation on the prompt and never the request itself.
     */
    const from = typeof body.from === 'string' && body.from !== '' ? body.from : undefined
    /*
     * The synthesis page's name, when the composer had a reformulation to offer (phase 2).
     * Same rule as `from`: type-checked here, made safe and capped by `researchTargetTitle`,
     * and simply absent when it is not usable.
     */
    const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title : undefined
    // A lens is optional (omit → default "broad"), but a PROVIDED one must be on the closed list:
    // free-text lenses are exactly the free-for-all the closed set exists to prevent.
    let profileKey: string | undefined
    if (body.profileKey !== undefined) {
      if (typeof body.profileKey !== 'string' || !isResearchProfileKey(body.profileKey)) {
        return reply.code(400).send({ error: `unknown research profile: ${String(body.profileKey)}` })
      }
      profileKey = body.profileKey
    }
    return reply.code(202).send(maintenance.startResearch(topic, profileKey, undefined, { ...(from !== undefined ? { from } : {}), ...(title !== undefined ? { title } : {}) }))
  })

  /**
   * Deterministic retrieval-index rebuild (SPEC.md §12.6). Deliberately NOT gated on the
   * credential: no agent runs, so it works in setup mode too. First run provisions.
   * 409 when the vault clone predates the wiki-retrieve skill (no scripts to run).
   */
  app.post('/api/v1/maintenance/retrieve-index', async (_req, reply) => {
    try {
      return reply.code(202).send(maintenance.startRetrieveIndex())
    } catch (err) {
      if (err instanceof RetrieveScriptsMissingError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  // Index status for the Maintenance-tab card: provisioned?, chunk count, index age.
  app.get('/api/v1/maintenance/retrieve-index', async (_req, reply) => {
    return reply.send(retrieveIndexStats(ctx.config.vaultRoot))
  })

  // Poll a run's state/result. Returns 404 once the run has been evicted from history.
  app.get('/api/v1/maintenance/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = maintenance.getRun(id)
    if (!run) return reply.code(404).send({ error: 'unknown maintenance run' })
    return reply.send(run)
  })

  // Recent runs, newest first — lets the UI restore state after a reload.
  app.get('/api/v1/maintenance/runs', async (_req, reply) => {
    return reply.send({ runs: maintenance.listRuns() })
  })

  /**
   * The persistent run log (schema v12), newest first. `?kind=research` is what the Research
   * screen asks for; without it the caller gets every kind.
   *
   * Distinct from `/maintenance/runs`, which is the in-memory registry of runs the process
   * still holds - that one answers "what is happening now", this one "what has happened".
   */
  app.get('/api/v1/maintenance/history', async (req, reply) => {
    const { kind, limit } = req.query as { kind?: string; limit?: string }
    const parsed = limit === undefined ? NaN : Number.parseInt(limit, 10)
    const capped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 100
    return reply.send({ runs: runs?.list({ ...(kind !== undefined ? { kind } : {}), limit: capped }) ?? [] })
  })

  // Drops one settled run from the history - the per-row "clear" the activity stream offers
  // for agent runs (SPEC.md §6.2 amendment 2026-09-05). Operational rows only; the pages the
  // run wrote stay in the vault, as does its commit.
  app.delete('/api/v1/maintenance/history/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (runs === undefined || !runs.remove(id)) return reply.code(404).send({ error: 'no such run in the history' })
    /*
     * The run's settle goes with it. The stream shows a kind's last settle in place of a run the
     * history no longer holds, and that fallback row has no history entry to delete - so a run
     * removed here came straight back as a row nobody could remove (found 2026-09-24: a failed
     * expand run of 2026-09-17, its history row long gone, still in the stream).
     */
    state?.forget(id)
    ctx.events.publish({ kind: 'stats' })
    return reply.send({ deleted: true })
  })

  /*
   * Forget one run's settle: the stream's fallback row for a run the history no longer holds.
   * Only that run's, by id; operational state, the vault untouched (hard rule 1). The status
   * head then no longer reports that run as its kind's last.
   */
  app.delete('/api/v1/maintenance/state/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string }
    if (state === undefined || !state.forget(runId)) return reply.code(404).send({ error: 'no settle of that run is kept' })
    ctx.events.publish({ kind: 'stats' })
    return reply.send({ forgotten: true })
  })

  // Per-kind last-settle state (SPEC.md §12.7 Stufe b) — restart-proof "zuletzt erledigt"
  // for the status head. Areas whose outcome lives in the vault (lint report, hot.md mtime,
  // index artifacts) additionally keep their vault facts; this fills the gaps and failures.
  app.get('/api/v1/maintenance/state', async (_req, reply) => {
    return reply.send({ areas: state?.list() ?? [] })
  })
}
