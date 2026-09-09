/**
 * Fellows over HTTP (docs/agents/SPEC.md section 12), registered only with `AGENTS_ENABLED`:
 *
 *   GET    /api/v1/agents                     every Fellow with its current run, count and next proposal; the shift status
 *   POST   /api/v1/agents                     spawn (201): record, notebook, first run by default
 *   GET    /api/v1/agents/shift               night shift status and recent shifts
 *   POST   /api/v1/agents/shift               run the shift now (202), ignoring the window
 *   GET    /api/v1/agents/:id                 the record
 *   GET    /api/v1/agents/:id/card            the card: runs, pages, quota, proposals, spend
 *   GET    /api/v1/agents/:id/candidates      what the planner would be shown now
 *   GET    /api/v1/agents/:id/proposals       pending first, then history
 *   PATCH  /api/v1/agents/:id                 edit intent, scope, model, effort, step, quota, autonomy, priority
 *   DELETE /api/v1/agents/:id                 remove a RETIRED Fellow's record (409 otherwise)
 *   POST   /api/v1/agents/:id/step            run one step now (202), gated
 *   POST   /api/v1/agents/:id/plan            run the planner now (202), or 200 when there was nothing to plan from
 *   POST   /api/v1/agents/:id/pause|resume|retire
 *   POST   /api/v1/proposals/:id/decide       approve, veto, undo, edit the topic, reorder
 *   POST   /api/v1/proposals/:id/run          execute a pending proposal now (202), gated
 *   GET    /api/v1/handoffs                   routed and unclaimed handoffs between Fellows (A3)
 *   POST   /api/v1/handoffs/:id/spawn         spawn a Fellow from an unclaimed request, prefilled (201)
 *
 * Every run-starting POST answers 503 in setup mode, like the maintenance routes.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../server.js'
import type { FellowService, SpawnInput, StepKind, DecisionInput } from '../../pipeline/fellows.js'
import { EXPAND_MANUAL_MAX_PAGES } from '../../pipeline/expand.js'
import type { AgentPatch } from '../../db/agents.js'
import { MAX_TASKS, TASK_KINDS } from '../../db/agents.js'
import { AGENT_ARTS, AGENT_AUTONOMIES, AGENT_EFFORTS, AGENT_MODELS, AGENT_NIGHTLY, AGENT_STEPS, MODEL_FACTOR, MODEL_IDS } from '../../db/agents.js'
import { readDomainRegistry, isValidDomainKey } from '../../pipeline/domains.js'
import { isResearchProfileKey } from '../../pipeline/research-profiles.js'
import { KIND_COST_USD } from '../../pipeline/planner.js'
import { typicalRunMs } from '../../pipeline/run-duration.js'

/** zod leaves optional keys as `undefined`; the service types are exact-optional, so drop them. */
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/** One piece of standing work: a sentence and what kind of work it is (decision 2026-09-07). */
const taskSchema = z.object({
  text: z.string().trim().min(3).max(2000),
  kind: z.enum(TASK_KINDS),
})

const spawnSchema = z.object({
  name: z.string().trim().min(1).max(40),
  /** The first task's sentence; a caller may still spawn with one line and no task list. */
  intent: z.string().trim().min(3).max(2000),
  tasks: z.array(taskSchema).min(1).max(MAX_TASKS).optional(),
  scope: z.string().trim().max(2000).optional(),
  homeDomain: z.string().trim().min(1).max(64),
  extraDomains: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
  lens: z.string().optional(),
  model: z.enum(AGENT_MODELS).optional(),
  effort: z.enum(AGENT_EFFORTS).optional(),
  step: z.enum(AGENT_STEPS).optional(),
  quotaRunsPerDay: z.number().int().min(0).max(24).optional(),
  autonomy: z.enum(AGENT_AUTONOMIES).optional(),
  /** The arts this Fellow's tasks may be; inferred from the first task list when absent. */
  art: z.enum(AGENT_ARTS).optional(),
  /** Every standing task each night (the default), or one in turn. */
  nightly: z.enum(AGENT_NIGHTLY).optional(),
  priority: z.number().int().min(-10).max(10).optional(),
  runFirstStep: z.boolean().optional(),
})

const patchSchema = spawnSchema
  .pick({ name: true, intent: true, tasks: true, scope: true, homeDomain: true, extraDomains: true, lens: true, model: true, effort: true, step: true, quotaRunsPerDay: true, autonomy: true, art: true, nightly: true, priority: true })
  .partial()

const stepSchema = z.object({
  topic: z.string().trim().min(3).max(500).optional(),
  kind: z.enum(['research', 'research-step', 'research-expand']).optional(),
  /** For an expand step started by hand: the existing pages it may deepen. */
  pageSet: z.array(z.string().trim().min(1).max(500)).max(EXPAND_MANUAL_MAX_PAGES).optional(),
  /**
   * A deliberate manual start: run even though today's runs-per-day quota is used up
   * (section 8.4). The quota limits the autopilot, not the user; the shares, reserves,
   * budget and rate-limit pause still refuse.
   */
  override: z.boolean().optional(),
})

const runProposalSchema = z.object({ override: z.boolean().optional() })

const decideSchema = z.object({
  status: z.enum(['approved', 'vetoed', 'proposed']).optional(),
  note: z.string().trim().max(1000).optional(),
  topic: z.string().trim().min(3).max(500).optional(),
  rank: z.number().int().min(1).max(50).optional(),
  via: z.enum(['dashboard', 'telegram']).optional(),
})

export function registerAgentsRoute(app: FastifyInstance, ctx: AppContext, fellows: FellowService): void {
  const credentialMissing = (reply: FastifyReply): boolean => {
    if (ctx.config.auth !== null) return false
    void reply.code(503).send({ error: 'no Anthropic credential configured - add it under System, then restart' })
    return true
  }
  const issues = (error: z.ZodError): string => error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')

  /** A home domain must be a registry key when the registry exists, a valid key shape otherwise. */
  const domainError = (key: string): string | null => {
    if (!isValidDomainKey(key)) return `"${key}" is not a valid domain key (lowercase, digits, hyphens)`
    const registry = readDomainRegistry(ctx.config.vaultRoot)
    if (registry !== null && !registry.domains.some((d) => d.key === key)) {
      return `"${key}" is not in the domain registry (wiki/meta/domains.md)`
    }
    return null
  }

  const lensError = (lens: string | undefined): string | null =>
    lens !== undefined && !isResearchProfileKey(lens) ? `unknown research profile: ${lens}` : null

  app.get('/api/v1/agents', async (_req, reply) => {
    return reply.send({
      fellows: fellows.list(),
      models: AGENT_MODELS.map((m) => ({ key: m, id: MODEL_IDS[m], factor: MODEL_FACTOR[m] })),
      costs: KIND_COST_USD,
      /*
       * How long each kind of run usually takes, in ms, so a schedule can be drawn BEFORE
       * anything starts. `typicalMs` on a run already answers this for one in flight; the
       * command centre needs it for work that has not begun (docs/tasks/TASKS-A7.md 3.3.4).
       */
      durations: Object.fromEntries(
        (['research', 'research-expand', 'research-step', 'plan'] as const).map((k) => [
          k,
          typicalRunMs(ctx.agentRuns?.list({ limit: 200 }) ?? [], k, null),
        ]),
      ),
      shift: ctx.shift?.status() ?? null,
      /** The order the night walks the shelves; empty means nobody has set one (A7 3.5). */
      shelfOrder: fellows.shelves(),
    })
  })

  /**
   * The order the night walks the shelves. It is one serial queue, so the order is a real
   * setting rather than a view preference - and it belongs to the DOMAIN, with `priority`
   * keeping its meaning inside a shelf (A7 3.5).
   */
  app.put('/api/v1/agents/shelf-order', async (req, reply) => {
    const parsed = z.object({ domains: z.array(z.string().trim().min(1).max(64)).max(200) }).safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    fellows.setShelves(parsed.data.domains)
    return reply.send({ shelfOrder: fellows.shelves() })
  })

  app.post('/api/v1/agents', async (req, reply) => {
    const parsed = spawnSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    const body = parsed.data
    const bad = domainError(body.homeDomain) ?? lensError(body.lens)
    if (bad) return reply.code(400).send({ error: bad })
    if (body.runFirstStep !== false && credentialMissing(reply)) return reply
    const outcome = await fellows.spawn(compact(body) as SpawnInput)
    if (outcome.refusal && !outcome.agent) return reply.code(outcome.refusal.status).send({ error: outcome.refusal.error, code: outcome.refusal.code })
    return reply.code(201).send({ agent: outcome.agent, run: outcome.run ?? null, refusal: outcome.refusal?.error ?? null })
  })

  // Static before parametric so `/agents/shift` never reads as a Fellow id.
  app.get('/api/v1/agents/shift', async (_req, reply) => {
    if (!ctx.shift) return reply.code(503).send({ error: 'the night shift is not running on this instance' })
    return reply.send(ctx.shift.status())
  })

  app.post('/api/v1/agents/shift', async (_req, reply) => {
    if (!ctx.shift) return reply.code(503).send({ error: 'the night shift is not running on this instance' })
    if (credentialMissing(reply)) return reply
    if (ctx.shift.isRunning) return reply.code(409).send({ error: 'a shift is already running' })
    void ctx.shift.run('manual')
    return reply.code(202).send({ started: true, status: ctx.shift.status() })
  })

  app.get('/api/v1/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = fellows.get(id)
    if (!agent) return reply.code(404).send({ error: 'no such Fellow' })
    return reply.send({ agent })
  })

  app.get('/api/v1/agents/:id/card', async (req, reply) => {
    const { id } = req.params as { id: string }
    const card = fellows.card(id)
    if (!card) return reply.code(404).send({ error: 'no such Fellow' })
    return reply.send(card)
  })

  app.get('/api/v1/agents/:id/candidates', async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = fellows.candidates(id)
    if (!result) return reply.code(404).send({ error: 'no such Fellow' })
    return reply.send(result)
  })

  app.get('/api/v1/agents/:id/proposals', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!fellows.get(id)) return reply.code(404).send({ error: 'no such Fellow' })
    return reply.send({ proposals: fellows.listProposals(id), next: fellows.runnable(id) ?? null })
  })

  app.patch('/api/v1/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = patchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    const body = parsed.data
    const bad = (body.homeDomain !== undefined ? domainError(body.homeDomain) : null) ?? lensError(body.lens)
    if (bad) return reply.code(400).send({ error: bad })
    // `tasks` goes in as sentences and arts; the service gives them ids and keeps `intent`
    // and the cursor in step with the list.
    const { tasks, ...fields } = body
    const outcome = await fellows.update(id, {
      ...(compact({ ...fields, ...(fields.scope !== undefined ? { scope: fields.scope === '' ? null : fields.scope } : {}) }) as AgentPatch),
      ...(tasks !== undefined ? { taskInput: tasks } : {}),
    })
    if (outcome.refusal) return reply.code(outcome.refusal.status).send({ error: outcome.refusal.error })
    return reply.send({ agent: outcome.agent })
  })

  app.delete('/api/v1/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = fellows.remove(id)
    if ('ok' in result) return reply.code(204).send()
    return reply.code(result.status).send({ error: result.error })
  })

  app.post('/api/v1/agents/:id/step', async (req, reply) => {
    if (credentialMissing(reply)) return reply
    const { id } = req.params as { id: string }
    const parsed = stepSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    const outcome = fellows.step(id, compact(parsed.data) as { topic?: string; kind?: StepKind; pageSet?: string[]; override?: boolean })
    if (outcome.refusal) return reply.code(outcome.refusal.status).send({ error: outcome.refusal.error, code: outcome.refusal.code })
    return reply.code(202).send({ run: outcome.run })
  })

  app.post('/api/v1/agents/:id/plan', async (req, reply) => {
    if (credentialMissing(reply)) return reply
    const { id } = req.params as { id: string }
    const outcome = fellows.plan(id)
    if (outcome.refusal) return reply.code(outcome.refusal.status).send({ error: outcome.refusal.error, code: outcome.refusal.code })
    if (outcome.skipped !== undefined) return reply.send({ run: null, skipped: outcome.skipped, agent: fellows.get(id) })
    return reply.code(202).send({ run: outcome.run })
  })

  for (const action of ['pause', 'resume', 'retire'] as const) {
    app.post(`/api/v1/agents/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string }
      const agent = await fellows[action](id)
      if (!agent) return reply.code(404).send({ error: 'no such Fellow' })
      return reply.send({ agent })
    })
  }

  // Handoffs (docs/agents/SPEC.md section 6.6, A3): what is routed and what is unclaimed.
  app.get('/api/v1/handoffs', async (_req, reply) => {
    return reply.send({ handoffs: fellows.listHandoffs() })
  })

  app.post('/api/v1/handoffs/:id/spawn', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = spawnSchema.partial().safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    const body = parsed.data
    const bad = (body.homeDomain !== undefined ? domainError(body.homeDomain) : null) ?? lensError(body.lens)
    if (bad) return reply.code(400).send({ error: bad })
    if (body.runFirstStep !== false && credentialMissing(reply)) return reply
    const outcome = await fellows.spawnFromHandoff(id, compact(body) as Partial<SpawnInput>)
    if (outcome.refusal && !outcome.agent) return reply.code(outcome.refusal.status).send({ error: outcome.refusal.error, code: outcome.refusal.code })
    return reply.code(201).send({ agent: outcome.agent, run: outcome.run ?? null, handoff: outcome.handoff ?? null, refusal: outcome.refusal?.error ?? null })
  })

  app.post('/api/v1/proposals/:id/decide', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = decideSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    const outcome = await fellows.decide(id, compact(parsed.data) as DecisionInput)
    if (outcome.refusal) return reply.code(outcome.refusal.status).send({ error: outcome.refusal.error, code: outcome.refusal.code })
    return reply.send({ proposal: outcome.proposal })
  })

  app.post('/api/v1/proposals/:id/run', async (req, reply) => {
    if (credentialMissing(reply)) return reply
    const { id } = req.params as { id: string }
    const parsed = runProposalSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    const outcome = fellows.execute(id, compact(parsed.data) as { override?: boolean })
    if (outcome.refusal) return reply.code(outcome.refusal.status).send({ error: outcome.refusal.error, code: outcome.refusal.code })
    return reply.code(202).send({ run: outcome.run })
  })
}
