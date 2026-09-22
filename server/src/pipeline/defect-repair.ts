/**
 * The deterministic repair passes, reachable from the dashboard (TASKS-DEFECT-PATHS phase 3).
 *
 * The passes already existed, were tested, and held their own locks - in a hand-run CLI. That
 * left the dashboard user with a list of defects, four of whose rules have a mechanical repair
 * sitting in the repo, and no way to reach it. This is the second caller, with the dry run
 * kept as the default it is.
 *
 * WHAT IS DIFFERENT FROM THE CLI, and why each difference exists:
 *
 *   - **The plan is filtered to the pages the findings name** (3.2). A pass is built vault-wide
 *     and will find pages the validator has never checked - measured on the live vault,
 *     `tag-singleton` would change 26 pages against 14 findings. The dashboard writes what the
 *     list showed and nothing more; the vault-wide sweep stays `cli/vaultrepair.ts`.
 *   - **The approval carries a hash of the content it was given** (3.3). `applyRepair` compares
 *     against disk, but the apply RE-PLANS server-side, which sets `before` to the current
 *     content and makes its `stale` path unreachable outside a microsecond race. The hash is
 *     what carries the user's approval forward: the approval was of a DIFF, and a diff the page
 *     no longer has is not the one that was approved.
 *   - **It commits behind the shared mutex** (3.4). The CLI takes the vault's per-file locks and
 *     calls `commitPaths` directly with no commit mutex anywhere, which is acceptable for a
 *     one-off with no service running and is a hard rule 1 violation in a service writer.
 *
 * WHAT IT NEVER DOES: write a page the selection did not name, delete, rename or merge
 * anything, or wait for a lock somebody else holds (a busy page is skipped and reported as
 * skipped - which means something different to the reader than stale).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Mutex } from '../util/mutex.js'
import { commitPaths, type CommitResult } from './git.js'
import { withWikiLocks } from './wiki-lock.js'
import {
  applyRepair,
  diffOf,
  planRepair,
  emDashPass,
  tagMirrorPass,
  runProtocolPass,
  tagSingletonPass,
  planManifestRepair,
  type RepairPass,
  type RepairPlan,
} from './repair.js'
import { RULE_PASSES } from './defect-paths.js'
import type { ValidationRule } from './validator.js'

/**
 * The exposed passes, by the name `cli/vaultrepair.ts` knows them, with the commit subject
 * each one writes. MECHANISM ONLY in every subject (hard rule 7): this repo is public and the
 * vault is not, so a commit message never names what a page is about.
 */
const PASSES: Record<string, { readonly build: (vaultRoot: string) => RepairPass; readonly subject: string }> = {
  'em-dash': { build: () => emDashPass, subject: 'repair: replace em-dashes and en-dashes outside code' },
  'tag-mirror': { build: () => tagMirrorPass, subject: 'repair: drop tags that repeat a page’s own type or domain' },
  'tag-singleton': { build: tagSingletonPass, subject: 'repair: drop tags that name exactly one page' },
  'run-protocol': { build: () => runProtocolPass, subject: 'repair: move run bookkeeping out of the articles' },
}

/** The pass a rule's findings are repaired by, or undefined when the rule has none. */
export function passForRule(rule: string): string | undefined {
  return RULE_PASSES[rule as ValidationRule]
}

export function isExposedPass(pass: string): boolean {
  return Object.prototype.hasOwnProperty.call(PASSES, pass)
}

/**
 * The hash the approval carries. Short and content-only: it answers "is this the page I was
 * shown a diff of", not "which version of it is this".
 */
export function contentHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/** One page a plan would change, as the dashboard needs it. */
export interface PlannedPage {
  readonly rel: string
  /** One line naming what this pass changed on this page. */
  readonly why: string
  readonly diff: string
  /** The hash of the content the plan was made against; the apply is checked against it. */
  readonly beforeHash: string
}

export interface DefectRepairPlan {
  readonly pass: string
  readonly rule: string
  readonly pages: PlannedPage[]
  /** Pages of the selection the pass looked at and left alone, with the reason. */
  readonly unchanged: string[]
}

/**
 * What the pass would change on exactly these pages. Reads only; writes nothing, ever.
 *
 * `paths` comes from the STORE, resolved from the finding ids the client named - never from a
 * request body. The client names ids, the server names paths.
 */
export function planForPaths(vaultRoot: string, rule: string, paths: readonly string[]): DefectRepairPlan {
  const pass = passForRule(rule)
  if (pass === undefined || !isExposedPass(pass)) {
    throw new Error(`no repair pass is exposed for ${rule}`)
  }
  const unique = [...new Set(paths)].filter((p) => p.startsWith('wiki/') && p.endsWith('.md'))
  const plan = planRepair(vaultRoot, pass, PASSES[pass]!.build(vaultRoot), undefined, unique)
  const changed = new Set(plan.edits.map((e) => e.rel))
  return {
    pass,
    rule,
    pages: plan.edits.map((edit) => ({
      rel: edit.rel,
      why: edit.why,
      diff: diffOf(edit),
      beforeHash: contentHash(edit.before),
    })),
    // A page the pass cannot reach keeps its finding after a successful apply, and the UI has
    // to say so rather than let it read as a repair that did not hold. `run-protocol` is the
    // rule where this is normal: it names seven headings and the pass removes five.
    unchanged: unique.filter((p) => !changed.has(p)),
  }
}

export interface ApplyOutcome {
  readonly written: string[]
  /** Pages whose content no longer matches the diff that was approved. Not written. */
  readonly stale: string[]
  /** Pages somebody else is writing right now. Not written, and NOT the same as stale. */
  readonly busy: string[]
  readonly commit: CommitResult | null
  /** Set when the pages were written and the commit itself failed. */
  readonly commitError?: string
}

export interface ApplyOptions {
  /**
   * The shared commit mutex. REQUIRED, and checked at runtime rather than only by the type:
   * this is a service writer, and a vault writer that commits outside the mutex can interleave
   * with an agent's commit (hard rule 1). The CLI passes a private one, which is honest - it
   * runs with no service beside it.
   */
  readonly commitMutex: Mutex
  /** Injected in tests; defaults to the real `commitPaths`. */
  readonly commit?: (vaultRoot: string, message: string, paths: readonly string[]) => Promise<CommitResult>
  /** The vault's own lock runner, injected in tests. */
  readonly lock?: typeof withWikiLocks
}

/**
 * Writes a plan's edits and makes ONE commit, in the order hard rule 1 states: the vault's own
 * per-file lock (foreign) OUTSIDE, the commit mutex (ours) INSIDE, then the commit.
 *
 * `approved` is the per-page hash the plan response carried. A page whose freshly planned
 * `before` no longer hashes to it is reported as stale and NOT written: the approval was of a
 * diff, and this is no longer that diff.
 */
export async function applySelection(
  vaultRoot: string,
  plan: RepairPlan,
  subject: string,
  approved: ReadonlyMap<string, string>,
  opts: ApplyOptions,
): Promise<ApplyOutcome> {
  if (opts.commitMutex === undefined || typeof opts.commitMutex.runExclusive !== 'function') {
    throw new Error('applySelection needs the shared commit mutex: a vault writer never commits outside it')
  }
  const commit = opts.commit ?? commitPaths
  const locks = opts.lock ?? withWikiLocks

  // The approval check first, before a single lock is taken: a stale page is not written, so
  // there is nothing to lock it for.
  const fresh: RepairPlan = { ...plan, edits: plan.edits.filter((e) => approved.get(e.rel) === contentHash(e.before)) }
  const stale = plan.edits.filter((e) => approved.get(e.rel) !== contentHash(e.before)).map((e) => e.rel)
  if (fresh.edits.length === 0) return { written: [], stale, busy: [], commit: null }

  return await locks(vaultRoot, fresh.edits.map((e) => e.rel), async (held, busy) => {
    const mine: RepairPlan = { ...fresh, edits: fresh.edits.filter((e) => held.includes(e.rel)) }
    // `applyRepair`'s own comparison against disk stays as the last line of defence: the hash
    // carries the APPROVAL, this catches a write that landed between the re-plan and the lock.
    const { written, stale: raced } = applyRepair(vaultRoot, mine)
    if (written.length === 0) return { written, stale: [...stale, ...raced], busy: [...busy], commit: null }
    /*
     * ONE commit, inside the lock and behind the shared mutex. `commitPaths` commits by
     * pathspec, so an agent's half-written pages elsewhere cannot be swept into it.
     */
    /*
     * A commit that THROWS must not lose the report. The pages are already written at this
     * point, so a 500 would leave the reader with no idea what happened to them - and the one
     * reachable cause is a vault that is not a git repository at all, which is a configuration
     * fact rather than a failure of this write.
     */
    try {
      const result = await opts.commitMutex.runExclusive(() => commit(vaultRoot, subject, written))
      return { written, stale: [...stale, ...raced], busy: [...busy], commit: result }
    } catch (err) {
      return {
        written,
        stale: [...stale, ...raced],
        busy: [...busy],
        commit: null,
        commitError: (err as Error).message,
      }
    }
  })
}

/** The commit subject for one pass. Mechanism only, never the subject of a page. */
export function subjectFor(pass: string): string {
  const entry = PASSES[pass]
  if (entry === undefined) throw new Error(`no such pass: ${pass}`)
  return entry.subject
}

/** Builds the pass itself, for a caller that needs the re-plan (the apply route). */
export function buildPass(vaultRoot: string, pass: string): RepairPass {
  const entry = PASSES[pass]
  if (entry === undefined) throw new Error(`no such pass: ${pass}`)
  return entry.build(vaultRoot)
}

/**
 * One plan at a time per rule (3.10).
 *
 * `planRepair` reads every page it is given synchronously on the Fastify event loop, and
 * `tagSingletonPass` reads the WHOLE vault in its factory before it decides anything - it has
 * to, since a singleton is only knowable vault-wide. Two plans of the same rule racing would
 * double that for no gain: the second would return what the first is already computing.
 */
export class SingleFlight {
  private readonly busy = new Set<string>()

  run<T>(key: string, fn: () => T): T {
    if (this.busy.has(key)) throw new PlanInFlightError(key)
    this.busy.add(key)
    try {
      return fn()
    } finally {
      this.busy.delete(key)
    }
  }

  async runAsync<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new PlanInFlightError(key)
    this.busy.add(key)
    try {
      return await fn()
    } finally {
      this.busy.delete(key)
    }
  }
}

export class PlanInFlightError extends Error {
  constructor(public readonly key: string) {
    super(`a ${key} repair is already being planned; wait for it to finish`)
    this.name = 'PlanInFlightError'
  }
}

/* ------------------------------------------------------- the manifest repair (task 3.6) */

/**
 * The address map's own repair, given the same flow and NOT pretending to reach today's rows.
 *
 * Two limits, both measured on the live vault 2026-09-21 and both stated in the UI rather than
 * only here:
 *
 *   - **It reaches none of the four `address-map` findings standing today.** All four name a
 *     `.raw/<job-id>/` directory that no source entry mentions, which `planManifestRepair`
 *     reports and repairs by design: what a job directory held is not derivable from the
 *     directory, and a repair that invented it would be inventing provenance. Measured: the
 *     plan is empty (`after: null`) and lists 4 unnamed directories.
 *   - **It cannot be scoped to selected findings.** It returns one whole-file `after`, so
 *     applying it fixes every drift the map has, including entries the list never showed. The
 *     confirmation says exactly that before the commit; this is the one place where "write only
 *     what the list showed" does not hold, and it is stated rather than hidden.
 *
 * The flow exists for the two directions the repair DOES cover - a page missing from the map,
 * a `pages_created` entry whose page is gone - which stand at 0 today and will not stay there.
 */


/** The file the manifest repair writes. It is tracked, so the commit is the whole record. */
export const MANIFEST_PATH = '.raw/.manifest.json'

export interface ManifestRepairPlan {
  readonly added: ReadonlyArray<{ rel: string; address: string }>
  readonly droppedPages: ReadonlyArray<{ source: string; page: string }>
  readonly droppedAddresses: ReadonlyArray<{ rel: string; address: string }>
  readonly unnamedDirs: readonly string[]
  /** True when there is something to write. */
  readonly changes: boolean
  /** The hash of the manifest the plan was made against, for the same approval check. */
  readonly beforeHash: string
  /** A readable diff of the JSON, never the file itself: it is 691 entries long. */
  readonly summary: string
}

export function planManifest(vaultRoot: string): ManifestRepairPlan {
  const plan = planManifestRepair(vaultRoot)
  let before = ''
  try {
    before = fs.readFileSync(path.join(vaultRoot, MANIFEST_PATH), 'utf8')
  } catch {
    /* no manifest: the plan will be empty too */
  }
  const parts = [
    `${plan.added.length} page(s) to record`,
    `${plan.droppedPages.length} stale pages_created to drop`,
    `${plan.droppedAddresses.length} retired address(es) to drop`,
  ]
  if (plan.unnamedDirs.length > 0) {
    parts.push(`${plan.unnamedDirs.length} job director(ies) named in no source entry - reported, never invented`)
  }
  return {
    added: plan.added,
    droppedPages: plan.droppedPages,
    droppedAddresses: plan.droppedAddresses,
    unnamedDirs: plan.unnamedDirs,
    changes: plan.after !== null,
    beforeHash: contentHash(before),
    summary: parts.join('; '),
  }
}

/**
 * Writes the repaired manifest in a commit of ITS OWN.
 *
 * No page lock: it writes no page (the same reasoning `pipeline/manifest-sync.ts` carries). The
 * commit mutex still applies, because it commits.
 */
export async function applyManifest(
  vaultRoot: string,
  approvedHash: string,
  opts: ApplyOptions,
): Promise<{ written: boolean; stale: boolean; commit: CommitResult | null }> {
  if (opts.commitMutex === undefined || typeof opts.commitMutex.runExclusive !== 'function') {
    throw new Error('applyManifest needs the shared commit mutex: a vault writer never commits outside it')
  }
  const plan = planManifestRepair(vaultRoot)
  const abs = path.join(vaultRoot, MANIFEST_PATH)
  let before = ''
  try {
    before = fs.readFileSync(abs, 'utf8')
  } catch {
    /* treated as empty, and the hash check below decides */
  }
  if (contentHash(before) !== approvedHash) return { written: false, stale: true, commit: null }
  if (plan.after === null) return { written: false, stale: false, commit: null }
  const commit = opts.commit ?? commitPaths
  fs.writeFileSync(abs, plan.after, 'utf8')
  const result = await opts.commitMutex.runExclusive(() =>
    commit(vaultRoot, 'repair: record every addressed page in the address map', [MANIFEST_PATH]),
  )
  return { written: true, stale: false, commit: result }
}
