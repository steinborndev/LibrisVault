/**
 * Plan utilization over HTTP (docs/agents/SPEC.md sections 8 and 12, A5), registered only
 * with `AGENTS_ENABLED`:
 *
 *   GET /api/v1/usage/plan      availability and source, windows, calibration, shares and reserves, the gate's answer
 *   GET /api/v1/usage/samples   the newest samples (`?limit=`)
 */

import type { FastifyInstance } from 'fastify'
import type { UsageMonitor } from '../../pipeline/usage-monitor.js'
import type { AgentModel } from '../../db/agents.js'
import { estimateCostUsd } from '../../pipeline/planner.js'

export function registerUsageRoute(app: FastifyInstance, usage: UsageMonitor, defaultModel: () => AgentModel): void {
  app.get('/api/v1/usage/plan', async (_req, reply) => {
    await usage.refresh()
    const model = defaultModel()
    return reply.send(usage.status({ estCostUsd: estimateCostUsd('research-step', model), model }))
  })

  app.get('/api/v1/usage/samples', async (req, reply) => {
    const raw = (req.query as { limit?: string }).limit
    const limit = Math.max(1, Math.min(2000, Number(raw) || 200))
    return reply.send({ samples: usage.samples(limit) })
  })
}
