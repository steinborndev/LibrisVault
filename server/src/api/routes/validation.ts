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
import {
  applyManifest,
  applySelection,
  buildPass,
  passForRule,
  planForPaths,
  planManifest,
  subjectFor,
  PlanInFlightError,
  SingleFlight,
} from '../../pipeline/defect-repair.js'
import { planRepair } from '../../pipeline/repair.js'
import { VALIDATOR_RULES, VAULT_WIDE_RULES } from '../../pipeline/validator.js'
import { recheckStanding } from '../../pipeline/standing-recheck.js'
import { Mutex } from '../../util/mutex.js'
import { DEFECT_FIX_RULES } from '../../pipeline/defect-fix-prompt.js'
import { defectFixBlock, NOTEBOOK_PREFIX, type NotebookContext } from '../../pipeline/defect-fix-scope.js'
import { parseQuestionBullets, questionKey } from '../../pipeline/questions.js'
import { checkQuotes, gitPageBefore } from '../../pipeline/quotes.js'
import { commitFileStatus, readAtRevision, revertCommit } from '../../pipeline/git.js'
import { findingIdentity } from '../../db/validation.js'
import fs from 'node:fs'
import nodePath from 'node:path'

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

/** How long an accept's reason may be. Trimmed and stored verbatim inside that. */
const ACCEPT_REASON_MAX = 500

export function resolveSubject(finding: { path: string }, jobExists: (id: string) => boolean): FindingSubject {
  const raw = RAW_DIR.exec(finding.path)
  if (raw !== null) {
    const jobId = raw[1]!
    return { kind: 'job', jobId, exists: jobExists(jobId) }
  }
  if (finding.path.startsWith('wiki/') && finding.path.endsWith('.md')) return { kind: 'page', path: finding.path }
  return { kind: 'none', why: 'this finding is about the vault as a whole rather than one page' }
}

/** At most this many findings in one repair, matching the caps the other actions carry. */
const MAX_SELECTION = 40

/**
 * At most this many findings in one bound RUN - a tenth of the deterministic cap, and for a
 * different reason. A pass is a rule; a run is a model reading ten pages and rewriting them,
 * and the narrowest scope a bad run can have is what makes it cheap to undo. The same shape as
 * the graph repair's 10.
 */
const RUN_SELECTION_MAX = 10

/**
 * The finding ids a request names, resolved to their rule and their paths.
 *
 * ALL-OR-NOTHING, the same validation `tag-fix` uses: the user selected specific repairs, and
 * silently dropping one repairs less than they asked for. One rule per request, because a pass
 * belongs to a rule.
 */
function resolveIds(
  store: { byId(id: string): StandingFinding | undefined },
  body: { rule?: unknown; ids?: unknown },
  cap: number = MAX_SELECTION,
): { rule: string; paths: string[]; findings: StandingFinding[] } | { error: string; code: number } {
  const rule = typeof body.rule === 'string' ? body.rule : ''
  if (rule === '') return { error: 'provide "rule": the rule whose findings are being repaired', code: 400 }
  const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === 'string') : []
  if (ids.length === 0) return { error: 'provide "ids": the findings to repair', code: 400 }
  if (ids.length > cap) return { error: `at most ${cap} findings in one repair`, code: 400 }
  const findings: StandingFinding[] = []
  for (const id of ids) {
    const f = store.byId(id)
    if (f === undefined) return { error: `no such finding: ${id}`, code: 404 }
    if (f.rule !== rule) return { error: `finding ${id} is a ${f.rule}, not a ${rule}`, code: 400 }
    if (f.acceptedAt !== null) return { error: `finding ${id} has been accepted; un-accept it first`, code: 409 }
    findings.push(f)
  }
  return { rule, paths: [...new Set(findings.map((f) => f.path))], findings }
}

/**
 * The question keys a page carries right now: what a reformulation is measured against.
 *
 * Read BEFORE the run, because afterwards the old text is gone and that is exactly what makes
 * the proposals standing on it stale (4.6).
 */
function questionKeysOf(vaultRoot: string, rel: string): string[] {
  try {
    return parseQuestionBullets(fs.readFileSync(nodePath.join(vaultRoot, rel), 'utf8')).map((b) => questionKey(b.text))
  } catch {
    return []
  }
}

/** The wiki pages one commit touched, for the revert's own re-record. */
async function commitPagesOf(vaultRoot: string, hash: string): Promise<string[]> {
  try {
    return [...(await commitFileStatus(vaultRoot, hash)).keys()].filter((p) => p.startsWith('wiki/') && p.endsWith('.md'))
  } catch {
    return []
  }
}

export function registerValidationRoute(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Fix runs waiting to settle, by run id. In memory and deliberately so: a service restart
   * loses the follow-up bookkeeping for a run in flight, and what that costs is one veto not
   * fired and one quote finding cleared by the next ingest instead. Persisting it would be a
   * second run registry beside the one that already exists.
   */
  const pendingFixes = new Map<string, { rule: string; ids: string[]; paths: string[]; before: Map<string, string[]> }>()

  /** What the notebook condition needs to know, assembled from whatever is wired (4.5). */
  const notebookContext = (c: AppContext): NotebookContext => ({
    fellowsWired: c.fellows !== undefined,
    ownerOf: (p: string) => {
      const agent = c.fellows?.list().find((f) => f.agent.notebookPath === p)
      return agent === undefined
        ? undefined
        : { id: agent.agent.id, name: agent.agent.name, retired: agent.agent.state === 'retired' }
    },
    ...(c.fellows === undefined ? {} : { hasRunInFlight: (agentId: string) => c.fellows!.hasRunInFlight(agentId) }),
  })

  /**
   * The quote rule's own clearing path (4.8).
   *
   * `recheckStanding` hardcodes `checked: VALIDATOR_RULES`, and `VALIDATOR_RULES` excludes
   * `quote`, because a quotation is compared against the artifact the job read and only the
   * ingest path holds one. So a SUCCESSFUL quote repair would never clear its own finding, the
   * attempt counter would rise on every success, and at three the row would call three
   * successes two failures.
   *
   * So the run clears its own: re-run `checkQuotes` for the finding's job over exactly the page
   * it names, and resolve with `checked: {quote}` over that one page. Never throws - this is
   * bookkeeping after a run that already did its work.
   */
  const clearRepairedQuotes = async (c: AppContext, ids: readonly string[], written: readonly string[]): Promise<number> => {
    if (c.validation === undefined) return 0
    let cleared = 0
    for (const id of ids) {
      const finding = c.validation.byId(id)
      if (finding === undefined || finding.resolvedAt !== null) continue
      if (!written.includes(finding.path)) continue
      const jobId = finding.lastJobId
      if (jobId === null) continue
      const job = c.store.get(jobId)
      const hash = job?.commit_hash ?? null
      if (hash === null) continue
      try {
        const out = await checkQuotes({
          vaultRoot: c.config.vaultRoot,
          jobIds: [jobId],
          pages: [finding.path],
          before: gitPageBefore((rev, rel) => readAtRevision(c.config.vaultRoot, rev, rel), hash),
        })
        // Only when the check actually ran: a missing artifact returns a note and no findings,
        // and reading that silence as a repair is the bug `resolveMissing`'s `checked` exists
        // to prevent.
        if (out.summary.note !== undefined) continue
        const stillThere = out.findings.some((f) => findingIdentity(f) === id)
        if (stillThere) continue
        cleared += c.validation.resolveMissing([finding.path], out.findings, { checked: new Set(['quote']) })
      } catch {
        /* a crash here must not fail the settle: the run's work is already committed */
      }
    }
    return cleared
  }

  /** One plan at a time per rule: a plan is a synchronous read of every page it is given. */
  const planning = new SingleFlight()
  /**
   * A private mutex for a context that wired none. Tests do that; `main.ts` always passes the
   * shared one, which is what makes the repair serialise against agent commits.
   */
  const fallbackMutex = new Mutex()

  /**
   * The three calls every write to the vault gets, in this order (3.5):
   *   1. validate + record  - so a defect the repair itself introduced lands on the list;
   *   2. resolveMissing     - what this write covered and no longer finds;
   *   3. recheckStanding    - the rest of the list, whose pages nothing else re-reads.
   *
   * `recheckStanding` hardcodes `checked: VALIDATOR_RULES` and passes no `fullyChecked`, so it
   * can clear neither `quote` nor `near-duplicate` and never clears a whole-vault rule per
   * page. Both of SPEC.md §12.16's conditions hold by construction.
   */
  const afterWrite = (written: readonly string[]): { recorded: number; resolved: number; recheckedAway: number } => {
    if (written.length === 0 || ctx.validate === undefined || ctx.validation === undefined) {
      return { recorded: 0, resolved: 0, recheckedAway: 0 }
    }
    const findings = ctx.validate(written)
    const { created } = ctx.validation.record(findings, null)
    const resolved = ctx.validation.resolveMissing([...written], findings, {
      checked: VALIDATOR_RULES,
      fullyChecked: VAULT_WIDE_RULES,
    })
    const recheckedAway = recheckStanding(ctx.validation, ctx.validate, { exclude: [...written] })
    return { recorded: created.length, resolved, recheckedAway }
  }

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
    /*
     * Whether a bound run may repair this row RIGHT NOW, and the reason when it may not (4.5).
     * Answered by the server because the second half of it - is this Fellow working - is
     * in-process state the browser cannot see, and the first half has to hold with
     * `AGENTS_ENABLED` off, where there is no Fellow surface to ask at all.
     *
     * Only asked for the rules that HAVE a run; everything else is a pass or a decision and
     * the notebook condition never arises.
     */
    ...(DEFECT_FIX_RULES.has(f.rule) && f.path.startsWith(NOTEBOOK_PREFIX)
      ? { fixBlock: defectFixBlock(f, notebookContext(ctx)) }
      : {}),
  })

  app.get('/api/v1/validation', async (request) => {
    if (ctx.validation === undefined) return { findings: [], byRule: [], total: 0, accepted: 0, guidance: DEFECT_GUIDANCE }
    const query = request.query as { rule?: string; limit?: string; offset?: string; accepted?: string }
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200)
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0)
    const byRule = ctx.validation.countsByRule()
    return {
      findings: ctx.validation
        .list({
          ...(query.rule === undefined || query.rule === '' ? {} : { rule: query.rule }),
          ...(query.accepted === '1' ? { accepted: true } : {}),
          limit,
          offset,
        })
        .map(withSubject),
      byRule,
      total: byRule.reduce((sum, r) => sum + r.findings, 0),
      // The third block, always carried: it is collapsed in the UI and its count is what says
      // whether to render it at all. `?accepted=1` asks for the accepted rows instead of the
      // standing ones, which is how that block fills without a second endpoint.
      accepted: ctx.validation.acceptedCount(),
      // What can be done about each rule and by whom. Served rather than mirrored in the web
      // bundle: the records are exhaustive over the rule union at compile time on the server,
      // and a second copy in TypeScript on the client would drift the first time a rule lands.
      guidance: DEFECT_GUIDANCE,
    }
  })

  /**
   * Accepting a defect: it may stay, and here is why (TASKS-DEFECT-PATHS 2.4).
   *
   * THE REASON IS REQUIRED. A snooze only postpones the reading, and an accept without a
   * reason is indistinguishable from neglect six months on - which is the state the 406
   * job-log lines were in. Trimmed, capped, and stored verbatim: it is the user's sentence,
   * not the service's.
   *
   * Base product, registered unconditionally (hard rule 8). The demo instance refuses every
   * non-GET before this handler runs (`api/server.ts`), so the UI reads `health.demoMode` and
   * disables the surface rather than offering a button that 403s.
   */
  app.post('/api/v1/validation/:id/accept', async (request, reply) => {
    if (ctx.validation === undefined) return reply.code(404).send({ error: 'no validation store' })
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { reason?: unknown }
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, ACCEPT_REASON_MAX) : ''
    if (reason === '') {
      return reply.code(400).send({ error: 'an accept needs a reason: what makes this defect allowed to stand' })
    }
    const result = ctx.validation.accept(id, reason)
    if (result === 'missing') return reply.code(404).send({ error: 'no such finding' })
    if (result === 'already') return reply.code(409).send({ error: 'this finding is already accepted' })
    return reply.send({ finding: withSubject(result) })
  })

  /** Taking an accept back. The finding returns to whichever block it belonged to. */
  app.delete('/api/v1/validation/:id/accept', async (request, reply) => {
    if (ctx.validation === undefined) return reply.code(404).send({ error: 'no validation store' })
    const { id } = request.params as { id: string }
    const result = ctx.validation.unaccept(id)
    if (result === 'missing') return reply.code(404).send({ error: 'no such finding' })
    if (result === 'already') return reply.code(409).send({ error: 'this finding is not accepted' })
    return reply.send({ finding: withSubject(result) })
  })

  /**
   * The deterministic repair, planned (TASKS-DEFECT-PATHS 3.2).
   *
   * READ-ONLY and needs no credential, like `rejoin-links`: the rule is mechanical, so this
   * starts no agent and can invent nothing. The client names FINDING IDS; the server resolves
   * them to paths through the store. A request naming paths would let a browser tab ask for a
   * page the list never showed, which is the one thing this flow promises not to do.
   */
  app.post('/api/v1/validation/repair/plan', async (request, reply) => {
    if (ctx.validation === undefined) return reply.code(404).send({ error: 'no validation store' })
    const body = (request.body ?? {}) as { rule?: unknown; ids?: unknown }
    const resolved = resolveIds(ctx.validation, body)
    if ('error' in resolved) return reply.code(resolved.code).send({ error: resolved.error })
    try {
      const plan = planning.run(resolved.rule, () => planForPaths(ctx.config.vaultRoot, resolved.rule, resolved.paths))
      return reply.send({ ...plan, findings: resolved.findings.length })
    } catch (err) {
      if (err instanceof PlanInFlightError) return reply.code(409).send({ error: err.message })
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  /**
   * The same selection, applied (3.3, 3.4, 3.5).
   *
   * The server PLANS AGAIN and writes only what the approval still matches. That is why the
   * plan response carries a `beforeHash` per page: re-planning sets `before` to the current
   * content, so `applyRepair`'s own stale check would be unreachable outside a microsecond
   * race. The hash carries the user's approval forward - the approval was of a diff, and a
   * diff the page no longer has is not the one that was approved.
   *
   * Locks and commit in the order hard rule 1 states, inside `applySelection`. It takes the
   * per-file locks and the commit mutex and NOT the maintenance runner's run mutex: it starts
   * no agent, so serialising it against a night shift would only make it unavailable for
   * hours.
   */
  app.post('/api/v1/validation/repair/apply', async (request, reply) => {
    if (ctx.validation === undefined) return reply.code(404).send({ error: 'no validation store' })
    const body = (request.body ?? {}) as { rule?: unknown; ids?: unknown; pages?: unknown }
    const resolved = resolveIds(ctx.validation, body)
    if ('error' in resolved) return reply.code(resolved.code).send({ error: resolved.error })
    const approved = new Map<string, string>()
    for (const entry of Array.isArray(body.pages) ? body.pages : []) {
      const p = (entry ?? {}) as { rel?: unknown; beforeHash?: unknown }
      if (typeof p.rel === 'string' && typeof p.beforeHash === 'string') approved.set(p.rel, p.beforeHash)
    }
    if (approved.size === 0) {
      return reply.code(400).send({ error: 'provide "pages": the pages you approved, each with the beforeHash the plan gave' })
    }
    // A page in the approval that the findings do not name is refused outright rather than
    // silently dropped: the selection is what bounds this write.
    const allowed = new Set(resolved.paths)
    const outside = [...approved.keys()].filter((rel) => !allowed.has(rel))
    if (outside.length > 0) {
      return reply.code(400).send({ error: `these pages are not named by the findings selected: ${outside.join(', ')}` })
    }
    const pass = passForRule(resolved.rule)
    if (pass === undefined) return reply.code(400).send({ error: `no repair pass is exposed for ${resolved.rule}` })

    try {
      const outcome = await planning.runAsync(resolved.rule, async () => {
        const fresh = planRepair(ctx.config.vaultRoot, pass, buildPass(ctx.config.vaultRoot, pass), undefined, [...approved.keys()])
        return await applySelection(ctx.config.vaultRoot, fresh, subjectFor(pass), approved, {
          commitMutex: ctx.commitMutex ?? fallbackMutex,
        })
      })
      const recheck = afterWrite(outcome.written)
      return reply.send({ ...outcome, ...recheck })
    } catch (err) {
      if (err instanceof PlanInFlightError) return reply.code(409).send({ error: err.message })
      throw err
    }
  })

  /**
   * The BOUND AGENT RUN (TASKS-DEFECT-PATHS phase 4).
   *
   * Three rules name a defect whose repair needs reading - `open-question-form`, `quote`,
   * `page-schema` - and no deterministic pass can ever produce one. This starts a `defect-fix`
   * run over exactly the pages of the findings selected, at most ten, one rule per request.
   *
   * Needs a credential like every other agent action. The request names FINDING IDS and never
   * paths or prompts; the server resolves them, and rejects the WHOLE request if any id is
   * unknown, accepted, of the wrong rule, or blocked by the notebook condition - the same
   * all-or-nothing validation `tag-fix` uses, because the user selected specific repairs and
   * silently dropping one repairs less than they asked for.
   */
  app.post('/api/v1/validation/repair/run', async (request, reply) => {
    if (ctx.validation === undefined) return reply.code(404).send({ error: 'no validation store' })
    if (ctx.config.auth === null) {
      return reply.code(503).send({
        error: 'no Anthropic credential configured: add it under System → Integrations, then restart',
      })
    }
    const body = (request.body ?? {}) as { rule?: unknown; ids?: unknown }
    const resolved = resolveIds(ctx.validation, body, RUN_SELECTION_MAX)
    if ('error' in resolved) return reply.code(resolved.code).send({ error: resolved.error })
    if (!DEFECT_FIX_RULES.has(resolved.rule)) {
      return reply.code(400).send({ error: `${resolved.rule} has no bound run; it is repaired by a pass or by you` })
    }
    /*
     * The notebook condition, re-checked HERE and not only in the browser: the UI's view of
     * whether a Fellow is working can be seconds old, and the window this guards is exactly
     * the one a stale view misses.
     */
    const notebooks = notebookContext(ctx)
    for (const f of resolved.findings) {
      const block = defectFixBlock(f, notebooks)
      if (!block.fixable) return reply.code(409).send({ error: block.why, finding: f.id })
    }
    /*
     * The bullets of every open-question page as they stand BEFORE the run (4.6). Nothing in
     * the finding carries them - the message counts bullets and names none - and after the run
     * the old text is gone, which is precisely what makes the proposals standing on it stale.
     */
    const before = new Map<string, string[]>()
    if (resolved.rule === 'open-question-form') {
      for (const path of resolved.paths) before.set(path, questionKeysOf(ctx.config.vaultRoot, path))
    }
    // Counted BEFORE the run, so a run that crashes still spent a try (4.8).
    ctx.validation.markFixAttempt(resolved.findings.map((f) => f.id))
    const run = ctx.maintenance.startDefectFix(resolved.rule, resolved.findings, resolved.paths)
    pendingFixes.set(run.id, { rule: resolved.rule, ids: resolved.findings.map((f) => f.id), paths: resolved.paths, before })
    return reply.code(202).send({ ...run, findings: resolved.findings.length, pages: resolved.paths.length })
  })

  /**
   * What a finished fix run did, and the bookkeeping that only makes sense once it has (4.6 to
   * 4.9). Called by the dashboard when the run settles rather than run inside the runner: the
   * runner is shared by ten kinds and knows nothing about findings.
   */
  app.post('/api/v1/validation/repair/run/:id/settle', async (request, reply) => {
    if (ctx.validation === undefined) return reply.code(404).send({ error: 'no validation store' })
    const { id } = request.params as { id: string }
    const pending = pendingFixes.get(id)
    if (pending === undefined) return reply.code(404).send({ error: 'no fix run by that id is waiting to settle' })
    const run = ctx.maintenance.getRun(id)
    if (run === undefined) return reply.code(404).send({ error: 'no such run' })
    if (run.status === 'running') return reply.code(409).send({ error: 'the run is still going' })
    pendingFixes.delete(id)

    const written = run.result?.pages ?? []
    // 1 to 3: the same post-write sequence every other write to the vault gets.
    const recheck = afterWrite(written)
    // 4: the quote rule's own clearing path (4.8). `recheckStanding` hardcodes VALIDATOR_RULES,
    // which excludes `quote`, so a successful quote repair would never clear its own finding -
    // and the attempt counter would call every success a failure.
    let quotesCleared = 0
    if (pending.rule === 'quote') quotesCleared = await clearRepairedQuotes(ctx, pending.ids, written)
    // 5: a reformulated question is a NEW question, so the proposals standing on the old
    // wording are vetoed (4.6). Skipped without error when the Fellows are unwired.
    const vetoed: string[] = []
    if (pending.rule === 'open-question-form' && ctx.questions !== undefined) {
      for (const [path, was] of pending.before) {
        vetoed.push(...(await ctx.questions.vetoReformulated(path, was)))
      }
    }
    return reply.send({
      ok: run.status === 'done' && run.result?.ok === true,
      commit: run.result?.commit ?? null,
      pages: written,
      ...recheck,
      quotesCleared,
      vetoedProposals: vetoed,
      stillStanding: pending.ids.filter((fid) => ctx.validation!.list({ limit: 200 }).some((f) => f.id === fid)).length,
    })
  })

  /**
   * Reverting one fix run's commit (4.7), on the function `POST /jobs/:id/revert` uses. The
   * ROUTE is not reusable - it marks `jobs.reverted_at` and counts the jobs sharing the hash,
   * and a maintenance run has neither - but `revertCommit` is, with all three of its guards:
   * the commit mutex, a refusal on a dirty tree, and a clean abort on conflict.
   *
   * AND IT RE-RECORDS. Reverting puts the defect back on disk, and the list would not know
   * until some later run happened to read the page again. So the pages of the reverted commit
   * are validated and recorded in the same request.
   */
  app.post('/api/v1/validation/repair/revert', async (request, reply) => {
    const body = (request.body ?? {}) as { commit?: unknown }
    const hash = typeof body.commit === 'string' ? body.commit.trim() : ''
    if (!/^[0-9a-f]{7,40}$/.test(hash)) return reply.code(400).send({ error: 'provide "commit": the hash to revert' })
    if (ctx.commitMutex === undefined) return reply.code(503).send({ error: 'commit mutex unavailable' })
    const pages = await commitPagesOf(ctx.config.vaultRoot, hash)
    const result = await ctx.commitMutex.runExclusive(() => revertCommit(ctx.config.vaultRoot, hash))
    if (!result.reverted) {
      // A dirty tree means a run is still writing, which is an answer and not an error.
      return reply.code(409).send({ error: result.message, refusal: result.refusal })
    }
    let recorded = 0
    if (pages.length > 0 && ctx.validate !== undefined && ctx.validation !== undefined) {
      const findings = ctx.validate(pages)
      recorded = ctx.validation.record(findings, null).created.length
      // The defect is back on disk; anything else this page had that is now gone goes too.
      ctx.validation.resolveMissing(pages, findings, { checked: VALIDATOR_RULES, fullyChecked: VAULT_WIDE_RULES })
    }
    ctx.events.publish({ kind: 'stats' })
    ctx.events.publish({ kind: 'vault' })
    return reply.send({ reverted: true, revertCommit: result.hash, pages, recorded })
  })

  /** The address map's own plan (3.6): a JSON change, not page edits, and its own commit. */
  app.post('/api/v1/validation/repair/manifest/plan', async (_request, reply) => {
    return reply.send(planManifest(ctx.config.vaultRoot))
  })

  app.post('/api/v1/validation/repair/manifest/apply', async (request, reply) => {
    const body = (request.body ?? {}) as { beforeHash?: unknown }
    if (typeof body.beforeHash !== 'string' || body.beforeHash === '') {
      return reply.code(400).send({ error: 'provide the beforeHash the plan gave' })
    }
    const outcome = await applyManifest(ctx.config.vaultRoot, body.beforeHash, {
      commitMutex: ctx.commitMutex ?? fallbackMutex,
    })
    return reply.send(outcome)
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
