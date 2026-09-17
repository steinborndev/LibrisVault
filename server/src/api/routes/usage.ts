/**
 * Plan utilization over HTTP (docs/agents/SPEC.md sections 8 and 12, A5), registered only
 * with `AGENTS_ENABLED`:
 *
 *   GET  /api/v1/usage/plan      availability and source, windows, calibration, shares and reserves, the gate's answer
 *   GET  /api/v1/usage/samples   the newest samples (`?limit=`)
 *   POST /api/v1/usage/override  release a window's bounds: the rest of this 5-hour one
 *                                (section 8.6), or the week for one night (section 8.6a)
 *   DELETE /api/v1/usage/override  withdraw a live release
 *
 * The release is the one endpoint here that hands out budget, so it is bounded rather than
 * guarded (the security review of 2026-09-07): the API is unauthenticated on a loopback port
 * that other WSL distributions share, an agent run can already reach `PUT /settings` and raise
 * the same two numbers, and no secret the browser holds is out of a local process's reach. What
 * makes this safe is therefore not who may call it but what a call can do - a hard ceiling, an
 * expiry the plan itself draws, a week reserve it never touches, one line in the log, a refusal
 * while any run is in flight, and a settings switch that removes it entirely.
 */

import type { FastifyInstance } from 'fastify'
import type { UsageMonitor } from '../../pipeline/usage-monitor.js'
import type { AgentModel } from '../../db/agents.js'
import { estimateCostUsd } from '../../pipeline/planner.js'
import type { CostSample } from '../../pipeline/run-cost.js'

export function registerUsageRoute(
  app: FastifyInstance,
  usage: UsageMonitor,
  defaultModel: () => AgentModel,
  guards: {
    readonly enabled: () => boolean
    /** Whether the week may be released at all; its own switch, off by default. */
    readonly weekEnabled: () => boolean
    /**
     * The end of the night this would be released for: the window `now` is inside, or the
     * next one. A week grant ends there rather than at the week's own reset, which can be
     * seven days out (section 8.6a).
     */
    readonly nightEndsAt: () => string | null
    readonly runInFlight: () => boolean
    /**
     * Starts a round of work now. A release ends with its five-hour window, and the night
     * shift runs at 01:00 - so without this a release granted at any other hour expires
     * unused, which made the whole control decorative.
     */
    readonly workNow?: () => void
    /** Settled runs to price the gate's sample step from (`pipeline/run-cost.ts`). */
    readonly runs?: () => readonly CostSample[]
  },
): void {
  app.get('/api/v1/usage/plan', async (_req, reply) => {
    await usage.refresh()
    const model = defaultModel()
    return reply.send(usage.status({ estCostUsd: estimateCostUsd('research-step', model, guards.runs?.() ?? []), model }))
  })

  /**
   * `window` says which bound is being released, and defaults to the five-hour one so the
   * endpoint keeps the contract it had. Two windows, two switches, two expiries - but one
   * route, so there is one place where a grant is guarded, logged and answered.
   */
  const windowOf = (body: unknown): 'five_hour' | 'seven_day' | null => {
    const w = (body as { window?: unknown } | null)?.window
    if (w === undefined || w === 'five_hour') return 'five_hour'
    return w === 'seven_day' ? 'seven_day' : null
  }

  app.post('/api/v1/usage/override', async (req, reply) => {
    const window = windowOf(req.body)
    if (window === null) return reply.code(400).send({ error: 'window must be five_hour or seven_day' })
    const week = window === 'seven_day'
    if (!(week ? guards.weekEnabled() : guards.enabled())) {
      return reply.code(409).send({
        error: week
          ? 'the week release is switched off (weekOverrideEnabled)'
          : 'the 5-hour release is switched off (fiveHourOverrideEnabled)',
        code: 'disabled',
      })
    }
    // A run in flight must not be able to raise the bound it is running under.
    if (guards.runInFlight()) {
      return reply.code(409).send({ error: `a run is in flight; the ${week ? 'week' : '5-hour'} release only happens between runs`, code: 'in-flight' })
    }
    const out = week ? usage.grantWeek(guards.nightEndsAt()) : usage.grantFiveHour()
    if (!out.ok) return reply.code(409).send({ error: out.reason, code: 'kind' })
    // Answer first, then work: a shift round takes minutes and the caller wants its button back.
    guards.workNow?.()
    return reply.send({ override: out.override })
  })

  app.delete('/api/v1/usage/override', async (req, reply) => {
    const window = windowOf(req.body)
    if (window === null) return reply.code(400).send({ error: 'window must be five_hour or seven_day' })
    const ended = window === 'seven_day' ? usage.revokeWeek() : usage.revokeFiveHour()
    return reply.send({ override: ended })
  })

  app.get('/api/v1/usage/samples', async (req, reply) => {
    const raw = (req.query as { limit?: string }).limit
    const limit = Math.max(1, Math.min(2000, Number(raw) || 200))
    return reply.send({ samples: usage.samples(limit) })
  })
}
