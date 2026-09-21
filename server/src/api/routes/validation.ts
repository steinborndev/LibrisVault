/**
 * GET /api/v1/validation - the standing defect list (A9, SPEC.md §12.16).
 *
 * The validator's findings used to live only in job logs, one line per occurrence, each
 * labelled "advisory only". 406 of them accumulated there, one dead link reported 109 times.
 * This is where they live instead: one row per defect, with how often it has been seen and
 * how long it has been standing.
 *
 * Base product, not behind `AGENTS_ENABLED` (hard rule 8): the validator runs for every ingest
 * whether or not the research agents exist, and a screen that asked a Fellow-only route for
 * this would 404 on every mount with the flag off.
 *
 * WHAT PHASE 1 OF TASKS-DEFECT-PATHS ADDED. The list was a reporter with no actor: every row
 * was a `<span>`, with no link to its subject, no evidence, and no statement of who is
 * supposed to do something about it. Three things answer that, all of them read-only:
 *
 *   - `subject` per finding: where it is, resolved HERE rather than guessed in the browser.
 *     `.raw/<job-id>/` is a job, `wiki/**.md` is a page, and a `last_job_id` is provenance
 *     and never a link target (see below).
 *   - `guidance`: the rule tables of `pipeline/defect-paths.ts`, so the UI renders what the
 *     server decided rather than keeping a second copy of the classification.
 *   - `GET /api/v1/validation/:id/evidence`: one page read, on demand, when a row expands.
 */

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import { DEFECT_GUIDANCE } from '../../pipeline/defect-paths.js'
import { evidenceFor, vaultReader } from '../../pipeline/defect-evidence.js'
import type { StandingFinding } from '../../db/validation.js'

/** Where a finding's subject is, as far as the server can resolve it. */
export type FindingSubject =
  | { readonly kind: 'page'; readonly path: string }
  | { readonly kind: 'job'; readonly jobId: string; readonly exists: boolean }
  | { readonly kind: 'none'; readonly why: string }

/**
 * A `.raw/<job-id>/` path names its job BY THE DIRECTORY NAME, which is the job id
 * (`queue.ts`). Never by `last_job_id`.
 *
 * `last_job_id` holds whichever run last REPORTED the finding - a maintenance run's 36-character
 * id when a maintenance run last validated the page, and null when the `rejoin-links` route did.
 * Measured 2026-09-21 over the live list: 18 of 57 rows carried a run id rather than a job id,
 * only 39 of 57 resolved to a job that still exists, and none of the four `.raw/` rows had a
 * `last_job_id` equal to its own directory. So it is shown as provenance and never linked.
 */
const RAW_DIR = /^\.raw\/([^/]+)\/?$/

export function resolveSubject(finding: { path: string }, jobExists: (id: string) => boolean): FindingSubject {
  const raw = RAW_DIR.exec(finding.path)
  if (raw !== null) {
    const jobId = raw[1]!
    return { kind: 'job', jobId, exists: jobExists(jobId) }
  }
  if (finding.path.startsWith('wiki/') && finding.path.endsWith('.md')) return { kind: 'page', path: finding.path }
  return { kind: 'none', why: 'this finding is about the vault as a whole rather than one page' }
}

export function registerValidationRoute(app: FastifyInstance, ctx: AppContext): void {
  const jobExists = (id: string): boolean => {
    try {
      return ctx.store.get(id) !== undefined
    } catch {
      return false
    }
  }

  /** The row as the dashboard needs it: the stored finding plus where its subject is. */
  const withSubject = (f: StandingFinding): unknown => ({
    ...f,
    subject: resolveSubject(f, jobExists),
    // Provenance, not a link target: `lastJobId` is whoever last reported this, and 18 of 57
    // rows carried a maintenance run id rather than a job id when this was measured.
    lastJobExists: f.lastJobId === null ? false : jobExists(f.lastJobId),
    // Whether the expanded row has anything to show without a second request.
    hasEvidence: f.evidence !== null,
  })

  app.get('/api/v1/validation', async (request) => {
    if (ctx.validation === undefined) return { findings: [], byRule: [], total: 0, guidance: DEFECT_GUIDANCE }
    const query = request.query as { rule?: string; limit?: string; offset?: string }
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200)
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0)
    const byRule = ctx.validation.countsByRule()
    return {
      findings: ctx.validation
        .list({
          ...(query.rule === undefined || query.rule === '' ? {} : { rule: query.rule }),
          limit,
          offset,
        })
        .map(withSubject),
      byRule,
      total: byRule.reduce((sum, r) => sum + r.findings, 0),
      // What can be done about each rule and by whom. Served rather than mirrored in the web
      // bundle: the records are exhaustive over the rule union at compile time on the server,
      // and a second copy in TypeScript on the client would drift the first time a rule lands.
      guidance: DEFECT_GUIDANCE,
    }
  })

  /**
   * What one finding is based on: the stored column where the producer filled it, otherwise a
   * fresh read of the page. On demand rather than in the list, because it is a page read per
   * row and the list renders fifty of them.
   */
  app.get('/api/v1/validation/:id/evidence', async (request, reply) => {
    if (ctx.validation === undefined) return reply.code(404).send({ error: 'no validation store' })
    const { id } = request.params as { id: string }
    const finding = ctx.validation.byId(id)
    if (finding === undefined) return reply.code(404).send({ error: 'no such finding' })
    return reply.send({
      id: finding.id,
      rule: finding.rule,
      path: finding.path,
      ...evidenceFor(finding, vaultReader(ctx.config.vaultRoot)),
    })
  })
}
