/**
 * GET /api/v1/validation - the standing defect list (A9, SPEC.md §12.12).
 *
 * The validator's findings used to live only in job logs, one line per occurrence, each
 * labelled "advisory only". 406 of them accumulated there, one dead link reported 109 times.
 * This is where they live instead: one row per defect, with how often it has been seen and
 * how long it has been standing.
 *
 * Base product, not behind `AGENTS_ENABLED` (hard rule 8): the validator runs for every ingest
 * whether or not the research agents exist, and a screen that asked a Fellow-only route for
 * this would 404 on every mount with the flag off.
 */

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'

export function registerValidationRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/validation', async (request) => {
    if (ctx.validation === undefined) return { findings: [], byRule: [], total: 0 }
    const query = request.query as { rule?: string; limit?: string; offset?: string }
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200)
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0)
    const byRule = ctx.validation.countsByRule()
    return {
      findings: ctx.validation.list({
        ...(query.rule === undefined || query.rule === '' ? {} : { rule: query.rule }),
        limit,
        offset,
      }),
      byRule,
      total: byRule.reduce((sum, r) => sum + r.findings, 0),
    }
  })
}
