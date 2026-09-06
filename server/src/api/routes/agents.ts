/**
 * Fellows over HTTP (docs/agents/SPEC.md section 12), registered only with `AGENTS_ENABLED`:
 *
 *   GET    /api/v1/agents                 every Fellow with its current run and today's count
 *   POST   /api/v1/agents                 spawn (201): record, notebook, first run by default
 *   GET    /api/v1/agents/:id             the record
 *   GET    /api/v1/agents/:id/card        the card: runs, pages, quota, current run
 *   PATCH  /api/v1/agents/:id             edit intent, scope, model, effort, step, quota, autonomy
 *   DELETE /api/v1/agents/:id             remove a RETIRED Fellow's record (409 otherwise)
 *   POST   /api/v1/agents/:id/step        run one step now (202), gated
 *   POST   /api/v1/agents/:id/pause|resume|retire
 *
 * Every run-starting POST answers 503 in setup mode, like the maintenance routes.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../server.js'
import type { FellowService, SpawnInput, StepKind } from '../../pipeline/fellows.js'
import type { AgentPatch } from '../../db/agents.js'
import { AGENT_AUTONOMIES, AGENT_EFFORTS, AGENT_MODELS, AGENT_STEPS, MODEL_FACTOR, MODEL_IDS } from '../../db/agents.js'
import { readDomainRegistry, isValidDomainKey } from '../../pipeline/domains.js'
import { isResearchProfileKey } from '../../pipeline/research-profiles.js'

/** zod leaves optional keys as `undefined`; the service types are exact-optional, so drop them. */
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

const spawnSchema = z.object({
  name: z.string().trim().min(1).max(40),
  intent: z.string().trim().min(3).max(2000),
  scope: z.string().trim().max(2000).optional(),
  homeDomain: z.string().trim().min(1).max(64),
  extraDomains: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
  lens: z.string().optional(),
  model: z.enum(AGENT_MODELS).optional(),
  effort: z.enum(AGENT_EFFORTS).optional(),
  step: z.enum(AGENT_STEPS).optional(),
  quotaRunsPerDay: z.number().int().min(0).max(24).optional(),
  autonomy: z.enum(AGENT_AUTONOMIES).optional(),
  runFirstStep: z.boolean().optional(),
})

const patchSchema = spawnSchema
  .pick({ name: true, intent: true, scope: true, homeDomain: true, extraDomains: true, lens: true, model: true, effort: true, step: true, quotaRunsPerDay: true, autonomy: true })
  .partial()

const stepSchema = z.object({
  topic: z.string().trim().min(3).max(500).optional(),
  kind: z.enum(['research', 'research-step']).optional(),
})

export function registerAgentsRoute(app: FastifyInstance, ctx: AppContext, fellows: FellowService): void {
  const credentialMissing = (reply: FastifyReply): boolean => {
    if (ctx.config.auth !== null) return false
    void reply.code(503).send({ error: 'no Anthropic credential configured - add it under System, then restart' })
    return true
  }

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
    })
  })

  app.post('/api/v1/agents', async (req, reply) => {
    const parsed = spawnSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
    const body = parsed.data
    const bad = domainError(body.homeDomain) ?? lensError(body.lens)
    if (bad) return reply.code(400).send({ error: bad })
    if (body.runFirstStep !== false && credentialMissing(reply)) return reply
    const outcome = await fellows.spawn(compact(body) as SpawnInput)
    if (outcome.refusal && !outcome.agent) return reply.code(outcome.refusal.status).send({ error: outcome.refusal.error })
    return reply.code(201).send({ agent: outcome.agent, run: outcome.run ?? null, refusal: outcome.refusal?.error ?? null })
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

  app.patch('/api/v1/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = patchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
    const body = parsed.data
    const bad = (body.homeDomain !== undefined ? domainError(body.homeDomain) : null) ?? lensError(body.lens)
    if (bad) return reply.code(400).send({ error: bad })
    const agent = fellows.update(id, compact({ ...body, ...(body.scope !== undefined ? { scope: body.scope === '' ? null : body.scope } : {}) }) as AgentPatch)
    if (!agent) return reply.code(404).send({ error: 'no such Fellow' })
    return reply.send({ agent })
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
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
    const outcome = fellows.step(id, compact(parsed.data) as { topic?: string; kind?: StepKind })
    if (outcome.refusal) return reply.code(outcome.refusal.status).send({ error: outcome.refusal.error })
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
}
