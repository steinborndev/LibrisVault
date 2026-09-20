/**
 * The ingestion queue and worker pool (SPEC.md §3.1, §3.2). The `jobs` table is the
 * single source of truth; this class is the engine that drives rows through it:
 *
 *   queued → preprocessing → ingesting → done | failed | deferred
 *
 * Responsibilities (TASKS-M1 §2):
 *   - a worker pool of default concurrency 2 (SPEC.md §3.1)
 *   - preprocessing via the plugin chain, then a headless agent ingest run
 *   - up to 2 automatic retries on transient errors, then `failed` (SPEC.md §3.1)
 *   - pause on a usage-limit signal, auto-resume (SPEC.md §7.1) — a pause never burns a retry
 *   - persist the agent stream to job_logs (SPEC.md §3.1)
 *   - one git commit per successful ingest (TASKS-M1 §0)
 *
 * Every external effect (agent run, git, tool detection, timers) is injectable so the
 * logic is unit-testable without a real SDK, a real vault, or the toolchain.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ulid } from 'ulid'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { JobRow, JobSource, JobType, CreateJobResult } from '../db/jobs.js'
import { JobStore, type JobHold } from '../db/jobs.js'
import type { AgentAuth, AgentRunResult } from './agent-runner.js'
import { runAgent, DEFAULT_TIMEOUT_MS } from './agent-runner.js'
import { formatMessage } from './format-message.js'
import { sha256File } from './hash.js'
import { DedupeIndex, extractDoi } from './dedupe.js'
import { canonicalUrl } from './url-identity.js'
import { contentPages } from './wiki-meta.js'
import {
  preprocess,
  detectTools,
  PreprocessError,
  type PreprocessResult,
  type Manifest,
  type ToolAvailability,
} from './preprocess/index.js'
import { preprocessUrl } from './preprocess/web.js'
import { checkQuotes, gitPageBefore } from './quotes.js'
import type { OaDisclosure, OaLookupCache } from './preprocess/oa.js'
import { extensionOf } from './preprocess/detect.js'
import {
  commitVault,
  commitPaths,
  commitTouching,
  dirtyPaths,
  discardUntrackedDir,
  newWikiPaths,
  readAtRevision,
  unversionedWikiPages,
  BOOKKEEPING_PATHS,
  type CommitResult,
  type CommitOptions,
} from './git.js'
import { RunRegistry } from './run-registry.js'
import { stampDates, CONTENT_UPDATED } from './page-dates.js'
import { withWikiLocks } from './wiki-lock.js'
import { hasRunMarker, runMarkerPath } from './run-marker.js'
import { topicForJob, vaultOverlapFor } from './ingest-overlap.js'
import { runTilingCheck, pairsTouching } from './tiling.js'
import { keepPayloadLocal, type LocalOnlyPayload } from './raw-payload.js'
import type { ValidationStore } from '../db/validation.js'
import { retrieveCandidates } from './retrieve-index.js'
import {
  SERVICE_OWNED_HUBS,
  bucketHubs,
  writeHubs,
  classifyLoggedPages,
  readAddresses,
  type HubPlan,
  type LogEntryInput,
} from './hubs.js'
import { extractWrittenPaths } from './written-paths.js'
import { msUntilReset } from './budget.js'
import { readDomainRegistry, domainSystemPrompt } from './domains.js'
import {
  ENTITY_NOTABILITY_RULES,
  PAGE_HYGIENE_CHECKLIST,
  TAG_HYGIENE_RULES,
  UNTRUSTED_CONTENT_RULES,
  renderOaNotice,
  renderProvenance,
  renderCompletionMarker,
  renderReadingList,
} from './system-prompt.js'
import { READING_LIST_PAGE, type ReadingListService } from './reading-list.js'
import { localDate } from './clock.js'
import type { ValidationFinding, Validator } from './validator.js'
import type { EventBus } from './events.js'
import { Mutex } from '../util/mutex.js'
import { DEFAULT_CONCURRENCY } from '../db/settings.js'

export type FailureClass = 'rate_limit' | 'transient' | 'permanent'

/** One member of a batch to enqueue: an uploaded/dropped file, or a URL. */
export type BatchItem =
  | { readonly kind: 'file'; readonly sourcePath: string; readonly originalName?: string }
  | { readonly kind: 'url'; readonly url: string }

/** In-memory record of a batch waiting for (or retrying) its combined ingest run. */
interface BatchUnit {
  readonly batchId: string
  readonly memberIds: string[]
}

/** Signature of the ingest agent run — injectable so tests supply a fake. */
export type IngestRunner = (opts: {
  readonly vaultRoot: string
  readonly prompt: string
  readonly auth: AgentAuth
  readonly timeoutMs: number
  readonly onMessage: (message: SDKMessage) => void
  /** Vault-derived system-prompt extension (the domain registry, SPEC.md §12.4). */
  readonly systemPromptExtra?: string
}) => Promise<AgentRunResult>

export interface IngestQueueOptions {
  readonly store: JobStore
  readonly vaultRoot: string
  /** `null` in setup mode (no credential yet): the queue accepts jobs but must not be started. */
  readonly auth: AgentAuth | null
  readonly concurrency?: number
  readonly timeoutMs?: number
  readonly maxRetries?: number
  /** How long to hold the queue after a usage-limit signal before auto-resuming. */
  readonly rateLimitPauseMs?: number
  /**
   * Base delay before retrying a TRANSIENT preprocess failure (e.g. a YouTube bot check
   * or HTTP 429), scaled linearly by attempt. Unlike agent retries these are delayed:
   * an immediate retry against a rate-limiting upstream is three fast failures in a row.
   */
  readonly preprocessRetryDelayMs?: number
  readonly runIngest?: IngestRunner
  readonly preprocessFile?: typeof preprocess
  readonly preprocessUrlFn?: typeof preprocessUrl
  readonly detectToolsFn?: () => Promise<ToolAvailability>
  readonly commit?: (vaultRoot: string, message: string, opts?: CommitOptions) => Promise<CommitResult>
  /** Hot-cache refresh hook; returns a note logged against the job. See file note in queue.ts. */
  readonly refreshHotCache?: (vaultRoot: string) => Promise<string>
  readonly setTimeoutFn?: (fn: () => void, ms: number) => void
  /**
   * Whether an ingest auto-commits to the vault ("Git-Commit-Verhalten", SPEC.md §6.4). Read
   * per commit — a provider, not a value — so a settings change applies live without a restart.
   * When it returns false the pages still land on disk; only the commit is skipped.
   */
  readonly autoCommit?: () => boolean
  /**
   * Daily-budget check (SPEC.md §7.1, §11.3). A provider, like `autoCommit`, so a settings
   * change applies live. When it returns true the queue pauses before claiming more work and
   * auto-resumes at the next local midnight. In-flight jobs always run to completion.
   */
  readonly budgetExceeded?: () => boolean
  /** Milliseconds until the budget window resets; injected so tests control the clock. */
  readonly msUntilBudgetReset?: () => number
  /** Live-update bus; the queue signals `stats` when a commit changes vault-visible numbers. */
  readonly events?: EventBus
  /**
   * Commit serialization mutex. Pass a shared instance so maintenance runs (lint, research,
   * hot-cache — M4) never interleave a commit with an ingest commit (TASKS-M4 §2: one writer).
   * Defaults to a fresh mutex when the queue is the only writer.
   */
  readonly commitMutex?: Mutex
  /**
   * Shared with the maintenance runner so each side can tell whether it is the sole vault writer
   * (finding F4). Defaults to a private registry when the queue is the only writer.
   */
  readonly runRegistry?: RunRegistry
  /**
   * The reading list (docs/agents/SPEC.md section 10.6): an ingest may add entries, and the
   * service signs the ones it added as `ingest` before the commit, whatever name the agent
   * wrote. Without it the entries stand as written.
   */
  readonly reading?: ReadingListService
  /**
   * Post-run validator (validator.ts): deterministic checks over the pages a run touched,
   * logged as warnings against the job. Read-only and advisory — findings never change the
   * job's outcome. Omitted (e.g. in the CLI) means no validation.
   */
  readonly validate?: Validator
  /** Where findings are counted rather than repeated (A9); absent leaves the old log behaviour. */
  readonly validationStore?: ValidationStore
  /**
   * The vault's own near-duplicate check (A5). Injected so tests never spawn python, and
   * defaulted to the real one - which skips itself on any vault that cannot run it.
   */
  readonly tilingCheck?: (vaultRoot: string) => Promise<Awaited<ReturnType<typeof runTilingCheck>>>
  /** The size cap for an ingested original (D4); injected so tests need no huge files. */
  readonly keepPayloadLocal?: (vaultRoot: string, jobDirRel: string, manifestPath: string) => LocalOnlyPayload[]
  /**
   * The vault-backed dedupe memory (SPEC.md §12.9): content hashes from `.raw/` manifests and
   * DOIs from source pages. Defaults to one over `vaultRoot`; tests inject a stub.
   */
  readonly dedupe?: DedupeIndex
  /**
   * Removes a job's never-committed `.raw/<job-id>/` staging once the job turns out to be a
   * duplicate after preprocessing. The default refuses anything git already tracks, so a
   * committed original can never be removed by this path. Returns whether it removed the dir.
   */
  readonly discardStaging?: (vaultRoot: string, relDir: string) => Promise<boolean>
  /**
   * Whether the post-preprocessing DOI check runs (settings `doiDedupe`, SPEC.md §12.9). A
   * provider like `autoCommit`, so switching it off applies to the next job without a
   * restart - it is the escape hatch for a document wrongly matched to a source page.
   */
  readonly doiDedupe?: () => boolean
  /**
   * Whether a blocked or abstract-thin URL job looks for an open-access copy (settings
   * `oaRecovery`, docs/sources/SPEC.md section 5). A provider, like `doiDedupe`: a settings
   * change applies to the next job.
   */
  readonly oaRecovery?: () => boolean
  /** The `oa_lookups` table, so three APIs are not asked the same DOI twice (5.5). */
  readonly oaLookups?: OaLookupCache
  /**
   * Whether the enqueue-time URL check runs (settings `urlDedupe`, SPEC.md §12.9, 2026-09-18).
   * A provider like `doiDedupe`; switching it off is how a page that changed since its ingest
   * gets fetched again.
   */
  readonly urlDedupe?: () => boolean
}

/**
 * What a run wants staged for its commit. `written` (Write/Edit tool calls) is the only signal
 * that is reliably per-run; `dirtyBefore` lets a SOLE writer additionally recover pages the agent
 * created or renamed via Bash, which the tool stream never reports (finding F4).
 */
interface CommitScope {
  readonly written: ReadonlySet<string>
  readonly dirtyBefore: ReadonlySet<string>
  /** Job-specific extras, e.g. `.raw/<job-id>`. */
  readonly extra: readonly string[]
  /** The reading list's urls before the run, when a list is wired: what the run added is what is not in here. */
  readonly readingBefore: ReadonlySet<string> | undefined
  /** The run's final answer, which becomes the log entry's narrative paragraph (SPEC.md §12.12). */
  readonly summary?: string | undefined
}

/** How an ingest signs the reading list entries it adds (the Fellow's name on a Fellow's run). */
const INGEST_ACTOR = 'ingest'

/** The `created_pages` JSON column as a list; anything unreadable counts as no pages. */
function parsePageList(raw: string | null): string[] {
  if (raw === null || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

/** Classifies an agent failure to decide retry vs pause vs give-up. */
export function classifyFailure(res: AgentRunResult): FailureClass {
  if (res.timedOut) return 'transient'
  const text = `${res.error ?? ''} ${res.result ?? ''}`
  if (/rate.?limit|usage limit|quota|429|too many requests/i.test(text)) return 'rate_limit'
  if (
    /overloaded|529|503|500|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|temporar/i.test(
      text,
    )
  ) {
    return 'transient'
  }
  return 'permanent'
}

/**
 * Tries to extract "when does the limit lift" from a usage-limit error (SPEC.md §7.1 wants the
 * pause to honour the expected release time when it is available). Understood shapes: a
 * `retry-after: <seconds>` header echo, the Claude usage-limit `…|<epoch-seconds>` marker, and
 * an ISO `resets at <timestamp>`. Returns undefined when nothing parseable is present — the
 * caller falls back to its fixed pause.
 */
export function parseRetryAfterMs(text: string, now: number = Date.now()): number | undefined {
  const secs = text.match(/retry[- ]?after[:\s]+(\d{1,6})(?:\D|$)/i)
  if (secs) return Number(secs[1]) * 1000
  const epoch = text.match(/\|(\d{10})(?:\D|$)/)
  if (epoch) {
    const ms = Number(epoch[1]) * 1000 - now
    return ms > 0 ? ms : undefined
  }
  const iso = text.match(/resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i)
  if (iso) {
    const t = Date.parse(iso[1]!)
    return Number.isNaN(t) || t <= now ? undefined : t - now
  }
  return undefined
}

/** Provisional type from the extension — corrected to the real type after preprocessing. */
export function guessType(name: string): JobType {
  const ext = extensionOf(name)
  if (ext === 'pdf') return 'pdf'
  if (['docx', 'doc', 'odt', 'pptx', 'ppt', 'xlsx', 'xls', 'ods', 'odp'].includes(ext)) return 'office'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic'].includes(ext)) return 'image'
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'm4v'].includes(ext))
    return 'av'
  if (['zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar', 'xz'].includes(ext)) return 'other'
  return 'text'
}

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep)

/**
 * Reduces a client-supplied filename to a bare basename. Upload names arrive verbatim from
 * the multipart Content-Disposition header, and `original_name` is later joined onto
 * `.raw/<job-id>/` for staging, preprocessing, and deferral — a `../`-carrying name would
 * escape the vault from OUTSIDE the agent sandbox (hard rule 1). Backslashes are treated as
 * separators too so a Windows-shaped `..\..\x` cannot smuggle segments past POSIX basename.
 */
export function sanitizeOriginalName(name: string): string {
  const base = path.basename(name.replaceAll('\\', '/'))
  return base === '' || base === '.' || base === '..' ? `upload-${ulid()}` : base
}

export class IngestQueue {
  private readonly store: JobStore
  private readonly vaultRoot: string
  private readonly auth: AgentAuth | null
  /** Not readonly: settings can raise/lower it live (SPEC.md §6.4 "Parallelität"). */
  private concurrency: number
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly rateLimitPauseMs: number
  private readonly preprocessRetryDelayMs: number
  private readonly runIngest: IngestRunner
  private readonly preprocessFile: typeof preprocess
  private readonly preprocessUrlFn: typeof preprocessUrl
  private readonly detectToolsFn: () => Promise<ToolAvailability>
  private readonly commit: (vaultRoot: string, message: string, opts?: CommitOptions) => Promise<CommitResult>
  private readonly refreshHotCache: (vaultRoot: string) => Promise<string>
  private readonly setTimeoutFn: (fn: () => void, ms: number) => void
  private readonly events: EventBus | undefined
  private readonly autoCommit: () => boolean
  private readonly budgetExceeded: () => boolean
  private readonly msUntilBudgetReset: () => number

  private readonly commitMutex: Mutex
  private readonly runRegistry: RunRegistry
  private readonly validate: Validator | undefined
  private readonly validationStore: ValidationStore | undefined
  /** Injected in tests; the real one spawns the vault's own `tiling-check.py`. */
  private readonly tiling: (vaultRoot: string) => Promise<Awaited<ReturnType<typeof runTilingCheck>>>
  private readonly keepPayloadLocal: (vaultRoot: string, jobDirRel: string, manifestPath: string) => LocalOnlyPayload[]
  private readonly dedupe: DedupeIndex
  private readonly reading: ReadingListService | undefined

  private readonly discardStaging: (vaultRoot: string, relDir: string) => Promise<boolean>
  private readonly doiDedupe: () => boolean
  private readonly oaRecovery: () => boolean
  private readonly oaLookups: OaLookupCache | undefined
  private readonly urlDedupe: () => boolean
  private running = false
  private paused = false
  /**
   * True while startup reconciliation of interrupted jobs is in flight. pump() is gated on it so
   * no newly-enqueued job can claim a worker and commit while reconcile is still reading the dirty
   * tree — otherwise reconcile could sweep the new job's pages into a recovered commit.
   */
  private reconciling = false
  /**
   * Resolves once startup reconciliation has finished and pumping has (re)started. Production
   * ignores it (jobs arrive later, long after reconcile); tests await it to assert recovery.
   */
  ready: Promise<void> = Promise.resolve()
  /** Why the queue is paused — the dashboard distinguishes a rate limit from a spent budget. */
  private pauseReason: 'rate-limit' | 'budget' | null = null
  private inFlight = 0
  /** Jobs sitting in `failed` only until their preprocess retry timer fires: still to run. */
  private readonly preprocessRetries = new Set<string>()
  private toolsCache: ToolAvailability | undefined
  private idleWaiters: Array<() => void> = []
  /** Batches awaiting their combined ingest run. A slot in the pool is one batch OR one job. */
  private pendingBatches: BatchUnit[] = []

  constructor(opts: IngestQueueOptions) {
    this.store = opts.store
    this.vaultRoot = opts.vaultRoot
    this.auth = opts.auth
    // One writer at a time: the vault's ingest skill is explicit that it was built for
    // single-writer use, and we measured 13 overlapping job pairs against it (A3).
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = opts.maxRetries ?? 2
    this.rateLimitPauseMs = opts.rateLimitPauseMs ?? 60_000
    this.preprocessRetryDelayMs = opts.preprocessRetryDelayMs ?? 60_000
    this.runIngest = opts.runIngest ?? ((o) => runAgent(o))
    this.preprocessFile = opts.preprocessFile ?? preprocess
    this.preprocessUrlFn = opts.preprocessUrlFn ?? preprocessUrl
    this.detectToolsFn = opts.detectToolsFn ?? detectTools
    this.commit = opts.commit ?? commitVault
    this.refreshHotCache =
      opts.refreshHotCache ??
      (async () =>
        'hot cache is maintained by the ingest skill itself (M0 evidence); no separate refresh pass in M1')
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => void setTimeout(fn, ms))
    this.events = opts.events
    this.autoCommit = opts.autoCommit ?? ((): boolean => true)
    this.budgetExceeded = opts.budgetExceeded ?? ((): boolean => false)
    this.msUntilBudgetReset = opts.msUntilBudgetReset ?? ((): number => msUntilReset())
    this.commitMutex = opts.commitMutex ?? new Mutex()
    this.runRegistry = opts.runRegistry ?? new RunRegistry()
    this.validate = opts.validate
    this.validationStore = opts.validationStore
    this.tiling = opts.tilingCheck ?? ((root) => runTilingCheck(root))
    this.keepPayloadLocal = opts.keepPayloadLocal ?? keepPayloadLocal
    this.dedupe = opts.dedupe ?? new DedupeIndex(opts.vaultRoot)
    this.reading = opts.reading
    this.discardStaging = opts.discardStaging ?? discardUntrackedDir
    this.doiDedupe = opts.doiDedupe ?? ((): boolean => true)
    this.oaRecovery = opts.oaRecovery ?? ((): boolean => false)
    this.oaLookups = opts.oaLookups
    this.urlDedupe = opts.urlDedupe ?? ((): boolean => true)
  }

  /**
   * Live-applies a concurrency change from settings (SPEC.md §6.4). Raising it starts more work
   * immediately; lowering it lets in-flight jobs finish and simply claims fewer afterwards.
   */
  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, Math.floor(concurrency))
    this.pump()
  }

  /**
   * The credential for a run. Runs are unreachable in setup mode (start() is never called,
   * pump() checks `running`), so this throwing means a wiring bug, not a user error.
   */
  private assertAuth(): AgentAuth {
    if (this.auth === null) throw new Error('agent run attempted with no credential configured (setup mode)')
    return this.auth
  }

  /** Starts pumping. Existing `queued` rows (e.g. after a restart) are picked up, and
   * batches whose members are still queued are reconstructed into pending units. Jobs stranded
   * mid-flight by an abrupt stop are first reconciled — a run that had finished writing the vault
   * before the crash is recovered to `done`, the rest to `failed` (retryable).
   *
   * Stays synchronous (the setup-mode guard must throw synchronously — callers and tests rely on
   * it, and ~30 call sites fire-and-forget this). The vault-aware reconcile is async, so it runs
   * off the synchronous path with pump() gated behind it via `reconciling`; enqueue's own pump()
   * calls are no-ops until reconcile finishes and re-pumps. */
  start(): void {
    if (this.auth === null) throw new Error('IngestQueue.start() requires a configured credential (setup mode)')
    this.running = true
    this.reconciling = true
    this.ready = this.reconcileInterrupted()
      // Runs whether or not anything was interrupted: what it repairs is a bookkeeping gap
      // left by a FINISHED run, not a crash.
      .then(() => this.backfillPageRecords())
      .catch((err: unknown) => {
        // 'queue' is a pseudo-source, not a job row, so this goes to the event bus (job_logs
        // would break its FK to jobs.id) — the same channel the reconcile warn uses.
        this.events?.publish({
          kind: 'log',
          log: {
            jobId: 'queue',
            ts: new Date().toISOString(),
            level: 'error',
            message: `startup reconcile failed: ${(err as Error).message}`,
          },
        })
      })
      .finally(() => {
        this.reconciling = false
        this.reloadPendingBatches()
        this.pump()
      })
  }

  /**
   * Recovers jobs an abrupt stop left in `preprocessing`/`ingesting` (queue.start only). Unlike
   * the store's blanket {@link JobStore.recoverInterrupted}, this looks at the VAULT to tell the
   * two cases apart:
   *
   *   - An `ingesting` run that left its completion marker (`.vault-meta/runs/<job-id>.done`,
   *     touched as its last action) had FINISHED writing; only its commit and status update were
   *     lost to the crash → commit its dirty pages and flip to `done`.
   *   - An `ingesting` run with NO completion marker was genuinely mid-write → still commit the
   *     pages it had already written (see below), then mark `failed` (retryable). A `preprocessing`
   *     job never reached the agent and wrote nothing → `failed`, no commit.
   *
   * Both `ingesting` cases commit the dirty wiki pages (via commitPaths — an explicit pathspec,
   * never `git add -A`, so nothing outside this run is swept in), differing only in the resulting
   * STATUS. The marker decides whether the JOB is done, not whether its on-disk pages get
   * versioned: committing a not-completed run's pages is what stops the RETRY from orphaning them
   * (its `dirtyBefore` snapshot would otherwise exclude them from the F4 sweep, and no later pass
   * ever picks them up — the 2026-07-23 retry-orphan bug). Committing happens BEFORE the status
   * flip, so a second crash mid-reconcile re-enters here (still `ingesting`) rather than stranding
   * a terminal job with uncommitted pages.
   *
   * Residual risk (SPEC §11.3 risk 5): the dirty-wiki set can, in principle, include a page the
   * user was editing in Obsidian at restart, which would then land in the recovered commit. It
   * only fires when a crash left an ingest's pages uncommitted, and the page stays fully versioned
   * and revertable — strictly better than orphaning it, or than the old `git add -A` sweeping it
   * into an unrelated run's commit.
   */
  private async reconcileInterrupted(): Promise<void> {
    const stuck = this.store.interruptedJobs()
    if (stuck.length === 0) return

    let recoveredToFailed = 0
    // A batch's members share one output set: once the first confirmed-complete member commits
    // the dirty tree, its siblings find nothing to commit and reuse the same page list.
    const committedByBatch = new Map<string, string[]>()

    for (const job of stuck) {
      const completed = job.status === 'ingesting' && this.ingestCompletionMarker(job)

      // Commit any wiki pages an interrupted INGESTING run already wrote — whether or not it
      // reached its log-marker. The marker decides the job's STATUS (done vs failed-retryable),
      // NOT whether its on-disk pages get versioned. A run cut off after writing pages but before
      // the marker (or before its own commit) would otherwise ORPHAN those pages permanently: the
      // NEXT attempt cannot recover them either — its `dirtyBefore` snapshot already contains them,
      // so the F4 sweep (`newWikiPaths`) excludes them, the retried agent sees them already on disk
      // and does not re-Write them, and once the job reaches `done` reconcile never revisits it
      // (it only scans non-terminal jobs). This bit a real ingest (2026-07-23): a restart mid-write
      // left 7 content pages, the retry committed only bookkeeping, and the pages sat untracked.
      // Committing here is the fix — the pages are versioned/revertable, and the retry (for the
      // not-completed case) then runs on a clean tree. A `preprocessing` job wrote nothing, so
      // there is nothing to commit. Batch members share one output set (the cache), so the first
      // member commits the tree and its siblings reuse the list.
      let pages: string[] = []
      if (job.status === 'ingesting') {
        const label = job.original_name ?? job.url ?? job.id
        const cached = job.batch_id !== null ? committedByBatch.get(job.batch_id) : undefined
        if (cached !== undefined) {
          pages = cached
        } else {
          pages = await this.commitReconciledPages(job, label, completed)
          if (job.batch_id !== null) committedByBatch.set(job.batch_id, pages)
        }
      }

      if (completed) {
        this.store.transition(job.id, 'done', {
          patch: pages.length > 0 ? { createdPages: pages } : {},
          log: 'reconciled to done after restart: run had completed; commit recovered',
        })
      } else {
        this.store.transition(job.id, 'failed', {
          patch: { error: 'interrupted by a service restart before it finished - retry to run it again' },
          log:
            pages.length > 0
              ? `recovered after restart: mid-flight with no completion marker - committed ${pages.length} page(s) it had already written so the retry cannot orphan them (retry to finish)`
              : 'recovered after restart: mid-flight with no completion marker',
        })
        recoveredToFailed++
      }
    }

    if (recoveredToFailed > 0) {
      this.events?.publish({
        kind: 'log',
        log: {
          jobId: 'queue',
          ts: new Date().toISOString(),
          level: 'warn',
          message: `recovered ${recoveredToFailed} interrupted job(s) after restart → failed (retryable)`,
        },
      })
    }
    this.events?.publish({ kind: 'stats' })
  }

  /**
   * Commits the wiki pages an interrupted run left dirty; returns what landed. Called for both
   * the completed branch (commit + `done`) and the not-completed branch (commit so the retry
   * cannot orphan them + `failed`); `completed` only varies the commit subject.
   */
  private async commitReconciledPages(job: JobRow, label: string, completed: boolean): Promise<string[]> {
    if (!this.autoCommit()) {
      this.store.log(job.id, 'info', 'reconcile: auto-commit disabled - pages left on disk, not committed')
      return []
    }
    const dirty = [...(await dirtyPaths(this.vaultRoot))]
    const dirtyWiki = dirty.filter((p) => p.startsWith('wiki/'))
    if (dirtyWiki.length === 0) {
      this.store.log(job.id, 'info', 'reconcile: run had completed and its pages were already committed')
      return []
    }
    /*
     * The bookkeeping rides along, and a crash test is what found that it did not.
     *
     * `.vault-meta/address-counter.txt` is the vault's address allocator, and a run bumps it as
     * it reserves addresses. The normal commit path carries it because `buildPathspec` appends
     * `BOOKKEEPING_PATHS`; this path built its own pathspec from the dirty `wiki/` files and
     * the job's payload, so after a recovery the counter stood at the reserved value on disk
     * and at the old one in git. Two consequences, both quiet: reverting the recovery commit
     * would not give the addresses back, and a `git reset --hard` would hand the next run five
     * addresses that are already on pages - which is how a vault with 0 duplicate addresses
     * stops having 0.
     *
     * Each path is included only when it is actually on disk: `git add -- <missing path>`
     * throws "pathspec did not match", which would abort the whole recovery commit.
     */
    const rawDir = path.posix.join('.raw', job.id)
    const paths = [
      ...dirtyWiki,
      ...(fs.existsSync(path.join(this.vaultRoot, rawDir)) ? [rawDir] : []),
      /*
       * The bookkeeping this run dirtied, named file by file rather than by its directory.
       *
       * `.vault-meta` also holds EXCLUDED state - run markers, locks - so on a vault where only
       * those changed, `git commit -- .vault-meta` matches nothing git knows about and fails the
       * whole recovery. "Exists on disk" is not "git has heard of it", which is what the first
       * attempt at this got wrong. `dirtyPaths` reports what git itself sees, so an excluded
       * file never reaches here.
       */
      ...dirty.filter((p) => BOOKKEEPING_PATHS.some((b) => p === b || p.startsWith(`${b}/`))),
    ]
    const subject = completed
      ? `ingest: ${label} (recovered after restart)`
      : `ingest: ${label} (recovered after restart - incomplete run, retry pending)`
    try {
      const result = await this.commitMutex.runExclusive(() => commitPaths(this.vaultRoot, subject, paths))
      if (result.committed) {
        if (result.hash) this.store.setCommitHash(job.id, result.hash)
        this.store.log(
          job.id,
          'info',
          `reconcile: committed ${result.hash?.slice(0, 8)} (${result.committedPages.length} page(s)) the crash left uncommitted`,
        )
        this.events?.publish({ kind: 'stats' })
        return result.committedPages
      }
      this.store.log(job.id, 'info', `reconcile: nothing to commit (${result.note ?? 'no changes'})`)
    } catch (err) {
      this.store.log(job.id, 'warn', `reconcile: git commit failed (pages are on disk): ${(err as Error).message}`)
    }
    return []
  }

  /**
   * Whether this run reached its end (A6 contract 1).
   *
   * The marker is a file the run touches as its last action (`run-marker.ts`). Before that it
   * was this job's `.raw` directory appearing in `wiki/log.md`, which the vault skill wrote
   * last - a skill's prose template as the basis of crash recovery, and a 777 kB read per
   * stuck job.
   *
   * THE LOG FALLBACK IS GONE (2026-09-19). It existed for jobs that were already `ingesting`
   * when the marker shipped, and the condition its own comment named has been met and
   * measured: no job is in that state. Keeping it would also have blocked shrinking the log,
   * because a truncated log would have answered "not finished" for anything old.
   */
  private ingestCompletionMarker(job: JobRow): boolean {
    return hasRunMarker(this.vaultRoot, job.id)
  }

  /** Reconstructs pending batch units from queued batch members not already tracked in memory. */
  private reloadPendingBatches(): void {
    const known = new Set(this.pendingBatches.map((u) => u.batchId))
    for (const b of this.store.queuedBatches()) {
      if (!known.has(b.batchId)) this.pendingBatches.push(b)
    }
  }

  /**
   * Manually re-queues a `failed` or `deferred` job (SPEC.md §6.2 "Erneut versuchen"). The
   * runner already retries *transient* errors automatically; this is the operator's path for
   * permanent failures and deferred jobs. A batch member is re-registered as a pending batch
   * so it rejoins its combined run. Throws if the job isn't in a re-queueable state.
   */
  retryJob(id: string): JobRow {
    const job = this.store.getOrThrow(id)
    if (job.status !== 'failed' && job.status !== 'deferred') {
      throw new Error(`job ${id} is ${job.status}, not failed/deferred - nothing to retry`)
    }
    const updated = this.store.transition(id, 'queued', { log: 'manual retry requested (SPEC.md §6.2)' })
    if (job.batch_id) this.reloadPendingBatches()
    this.pump()
    return updated
  }

  /** Stops claiming new work. In-flight jobs run to completion. */
  stop(): void {
    this.running = false
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Live queue state for the health/overview endpoints (SPEC.md §6.1). */
  /**
   * The dedupe index this queue keeps warm. Shared, not rebuilt: it caches the DOIs and arXiv
   * ids of every source page by mtime, and the reading list asks it whether a publication is
   * already in the vault - however the document got there.
   */
  get dedupeIndex(): DedupeIndex {
    return this.dedupe
  }

  stats(): {
    readonly inFlight: number
    readonly paused: boolean
    /** Distinguishes a usage-limit pause from a spent daily budget for the dashboard. */
    readonly pauseReason: 'rate-limit' | 'budget' | null
    readonly concurrency: number
  } {
    return {
      inFlight: this.inFlight,
      paused: this.paused,
      pauseReason: this.pauseReason,
      concurrency: this.concurrency,
    }
  }

  /**
   * Enqueues a file. Computes its SHA-256 (dedupe), records the job, and — unless it is a
   * duplicate — copies the original into `.raw/<job-id>/` where preprocessing expects it.
   */
  async enqueueFile(input: {
    readonly sourcePath: string
    readonly source: JobSource
    readonly originalName?: string
    readonly batchId?: string
    /** Where to report the terminal state, e.g. 'telegram:<chat_id>' (SPEC.md §4.3). */
    readonly notifyChannel?: string
    /** Hold the job for the night shift instead of running it now. */
    readonly hold?: JobHold
  }): Promise<CreateJobResult> {
    const originalName = sanitizeOriginalName(input.originalName ?? path.basename(input.sourcePath))
    const sha256 = await sha256File(input.sourcePath)
    const created = this.store.create({
      source: input.source,
      type: guessType(originalName),
      originalName,
      sha256,
      ...this.vaultKnows(sha256),
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.notifyChannel ? { notifyChannel: input.notifyChannel } : {}),
      ...(input.hold ? { hold: input.hold } : {}),
    })
    if (created.duplicateOf === undefined) {
      try {
        this.stageFile(created.job.id, input.sourcePath, originalName)
      } catch (err) {
        // The row exists but the original never reached `.raw/` — the job could only hang in
        // `queued` forever. Fail it visibly instead; a retry after fixing the cause re-stages.
        const job = this.store.transition(created.job.id, 'failed', {
          patch: { error: `staging failed: ${(err as Error).message}` },
          log: `staging into .raw/ failed: ${(err as Error).message}`,
          level: 'error',
        })
        this.pump()
        return { job }
      }
    }
    this.pump()
    return created
  }

  /**
   * Stage one of dedupe (SPEC.md §12.9): the vault's own memory of this hash. `jobs.sha256`
   * forgets when history is cleared; `.raw/<job-id>/manifest.json` does not. A hit becomes a
   * `duplicate` row at creation, exactly like a hash still present in `jobs`.
   *
   * What the hash alone cannot say is whether that earlier job ever produced anything, and
   * until 2026-09-16 this did not ask (the mirror of the same omission in `create`). The job
   * dir's manifest is written by PREPROCESSING, so a run that was interrupted a second later
   * left a permanent claim on those bytes - and the sentence it produced, "already in the
   * vault", was false: nothing of that document was in the vault, and once the failed row had
   * been tidied out of the history there was no retry left either. The file could then never
   * be ingested again, through any door.
   *
   * So the claim has to be backed. The job history answers first and answers exactly (a row
   * that failed or was cancelled owns nothing); when history no longer knows the job, the
   * vault's own delta tracker does. Neither says yes for an unfinished run. The deliberate
   * cost is at the other end: a document ingested long enough ago that its row is gone AND no
   * tracker entry survives can be taken in a second time. That is one agent run, and the
   * ingest skill itself recognises the case - against a document that could never be taken in
   * at all, it is the right way round.
   */
  private vaultKnows(sha256: string): { duplicateOf: string; duplicateNote: string } | Record<never, never> {
    const known = this.dedupe.byHash(sha256)
    if (known === undefined) return {}
    const row = this.store.get(known.jobId)
    const ingested = row !== undefined ? row.status === 'done' : this.dedupe.producedPages(known.jobId)
    if (!ingested) return {}
    const what = known.originalName !== null ? `"${known.originalName}"` : 'an original'
    return {
      duplicateOf: known.jobId,
      duplicateNote: `already ingested from ${what}: .raw/${known.jobId}/ holds the same content and its run wrote pages`,
    }
  }

  /**
   * Stage two of dedupe for a LINK (SPEC.md §12.9, 2026-09-18), decided at enqueue: the
   * canonical form of the address (share-link tracking stripped, a post by its status id, see
   * `url-identity.ts`) is one a source page already declares in its frontmatter. Nothing is
   * fetched and no staging dir is created; the row is a `duplicate` at creation, exactly like
   * a remembered hash. A source page is the only evidence accepted: a failed earlier job
   * leaves no page, so resubmitting its link is a retry, not a duplicate.
   */
  private vaultKnowsUrl(url: string): { duplicateOf?: string; duplicateNote: string } | Record<never, never> {
    if (!this.urlDedupe()) return {}
    const canonical = canonicalUrl(url)
    if (canonical === undefined) return {}
    const match = this.dedupe.byUrl(canonical)
    if (match === undefined) return {}
    const via = match.jobId !== null ? `job ${match.jobId}` : 'an earlier ingest'
    return {
      ...(match.jobId !== null ? { duplicateOf: match.jobId } : {}),
      duplicateNote: `already in the vault as ${match.page} (same URL ${canonical}, ingested by ${via})`,
    }
  }

  /**
   * Stage two of dedupe (SPEC.md §12.9), after preprocessing: the document identifies itself
   * by a DOI that a source page in the vault already declares. Bytes differ between two
   * downloads of the same paper (publisher watermarks), so only the normalized text can
   * answer this - and it has to be answered BEFORE an agent run is paid for.
   *
   * Guarded against a job recognising its own earlier attempt: a page this job created (by
   * the delta tracker) or one written after the job was created is not evidence of a prior
   * ingest. Returns undefined when the job proceeds to ingest.
   */
  private contentDuplicate(
    job: JobRow,
    pre: PreprocessResult,
  ): { readonly page: string; readonly jobId: string | null; readonly doi: string } | undefined {
    if (!this.doiDedupe()) return undefined
    const normalized = pre.manifest.normalized
    if (normalized === undefined) return undefined
    let text: string
    try {
      text = fs.readFileSync(path.join(this.vaultRoot, '.raw', job.id, normalized), 'utf8')
    } catch {
      return undefined
    }
    const doi = extractDoi(text)
    if (doi === undefined) return undefined
    const match = this.dedupe.byDoi(doi)
    if (match === undefined) return undefined
    if (match.jobId === job.id) return undefined
    if (match.jobId === null && match.pageMtimeMs >= Date.parse(job.created_at)) return undefined
    /*
     * ...nor is a page left behind by an attempt that did not finish (2026-09-16). A run
     * interrupted after it wrote the source page and before it was through leaves exactly the
     * evidence this check looks for, and the bytes of a second download differ (watermarks),
     * so the hash stage waves it past and this one stops it - which makes the DOI the reason
     * a paper cannot be retried. A failed or cancelled job's page is a fragment, not an
     * ingest; whoever is dropping the document again is saying so.
     */
    if (match.jobId !== null) {
      const by = this.store.get(match.jobId)
      if (by !== undefined && (by.status === 'failed' || by.status === 'cancelled')) return undefined
    }
    return { page: match.page, jobId: match.jobId, doi }
  }

  /**
   * Settles a job the DOI check caught: `preprocessing → duplicate`, and its staged copy goes
   * - the original is already in `.raw/` under the job that ingested it, and an untracked
   * second copy would sit dirty in the vault forever. Only a never-committed dir is removed
   * (the default `discardStaging` refuses tracked paths), so nothing versioned is touched.
   */
  private async settleContentDuplicate(
    job: JobRow,
    dup: { readonly page: string; readonly jobId: string | null; readonly doi: string },
  ): Promise<void> {
    const via = dup.jobId !== null ? `job ${dup.jobId}` : 'an earlier ingest'
    this.store.transition(job.id, 'duplicate', {
      patch: {
        error: `already in the vault as ${dup.page} (DOI ${dup.doi}, ingested by ${via})`,
        ...(dup.jobId !== null ? { duplicateOf: dup.jobId } : {}),
      },
      log: `duplicate by DOI ${dup.doi}: ${dup.page} already covers this document (${via}) - no agent run`,
      level: 'warn',
    })
    const relDir = path.posix.join('.raw', job.id)
    try {
      const removed = await this.discardStaging(this.vaultRoot, relDir)
      this.store.log(
        job.id,
        'info',
        removed ? `staged copy ${relDir}/ removed (never committed)` : `staged copy ${relDir}/ kept: git already tracks it`,
      )
    } catch (err) {
      this.store.log(job.id, 'warn', `could not remove staged copy ${relDir}/: ${(err as Error).message}`)
    }
  }

  /**
   * A `done` run that wrote no CONTENT page gets `outcome = 'no-changes'` (SPEC.md §12.9): the
   * agent finished cleanly and found nothing to add - typically a source it recognised as
   * already ingested by means the dedupe stages do not cover. The vault's meta pages do not
   * count (`wiki-meta.ts`): a run used to append its own entry to `wiki/log.md`, and until
   * 2026-09-18 that one line made it pass as an ingest with "1 page". The service writes that
   * entry now and only for a run that wrote a page (SPEC.md §12.12), so the case cannot arise
   * from the log any more - the rule stays because a meta page can still be the only thing a
   * run touched. Said in the log too, so the row and its record agree.
   */
  private markNoChanges(jobId: string, committed: readonly string[]): void {
    if (contentPages(committed).length > 0) return
    const row = this.store.get(jobId)
    if (row === undefined || row.status !== 'done') return
    // Only a run whose commit LANDED and carried no page is a no-change run. A skipped or
    // failed commit says nothing about what the run wrote - those pages are on disk.
    if (row.commit_hash === null) return
    if (contentPages(parsePageList(row.created_pages)).length > 0) return
    this.store.setOutcome(jobId, 'no-changes')
    this.store.log(
      jobId,
      'warn',
      'no changes: the run finished but wrote no wiki page beyond index, log and hot cache (the agent found nothing to add - usually a source it recognised as already ingested)',
    )
  }

  /** Copies an original into its `.raw/<job-id>/` dir where preprocessing expects it. */
  private stageFile(jobId: string, sourcePath: string, originalName: string): void {
    const jobDir = path.join(this.vaultRoot, '.raw', jobId)
    // Callers sanitize; this assert is the backstop for any future caller that forgets.
    const dest = path.resolve(jobDir, originalName)
    if (path.dirname(dest) !== path.resolve(jobDir)) {
      throw new Error(`refusing to stage "${originalName}": name must resolve to a direct child of the job dir`)
    }
    fs.mkdirSync(jobDir, { recursive: true })
    fs.copyFileSync(sourcePath, dest)
    this.store.setRawPath(jobId, path.posix.join('.raw', jobId))
  }

  /**
   * Enqueues a batch (SPEC.md §4.1): every member is preprocessed individually, then the
   * whole batch is ingested with ONE combined `ingest all of these` run so the agent can
   * cross-reference the sources. Members share a `batch_id`; duplicates are skipped and
   * left out of the run. Occupies ONE worker-pool slot for the whole batch.
   */
  async enqueueBatch(
    items: readonly BatchItem[],
    source: JobSource,
    opts: { readonly notifyChannel?: string; readonly hold?: JobHold } = {},
  ): Promise<{ batchId: string; jobs: CreateJobResult[] }> {
    const batchId = ulid()
    const notify = { ...(opts.notifyChannel ? { notifyChannel: opts.notifyChannel } : {}), ...(opts.hold ? { hold: opts.hold } : {}) }
    const jobs: CreateJobResult[] = []
    for (const item of items) {
      if (item.kind === 'url') {
        jobs.push(this.store.create({ source, type: 'web', url: item.url, ...this.vaultKnowsUrl(item.url), batchId, ...notify }))
        continue
      }
      const originalName = sanitizeOriginalName(item.originalName ?? path.basename(item.sourcePath))
      // One unreadable member must not strand its siblings: without the pending-batch unit
      // (pushed only after this loop) queued batch members are never claimed, so a throw here
      // used to freeze the whole batch until a restart. Fail the member visibly and carry on.
      let created: CreateJobResult | undefined
      try {
        const sha256 = await sha256File(item.sourcePath)
        created = this.store.create({
          source,
          type: guessType(originalName),
          originalName,
          sha256,
          ...this.vaultKnows(sha256),
          batchId,
          ...notify,
        })
        if (created.duplicateOf === undefined) this.stageFile(created.job.id, item.sourcePath, originalName)
        jobs.push(created)
      } catch (err) {
        created ??= this.store.create({ source, type: guessType(originalName), originalName, batchId, ...notify })
        const job = this.store.transition(created.job.id, 'failed', {
          patch: { error: `could not read/stage the file: ${(err as Error).message}` },
          log: `batch member failed before preprocessing: ${(err as Error).message}`,
          level: 'error',
        })
        jobs.push({ job })
      }
    }
    // Only members still queued join the combined run — duplicates and stage-failed drop out.
    const memberIds = jobs.filter((r) => r.duplicateOf === undefined && r.job.status === 'queued').map((r) => r.job.id)
    // A held batch is not pending yet: the release rebuilds its unit from the rows.
    if (memberIds.length > 0 && opts.hold === undefined) this.pendingBatches.push({ batchId, memberIds })
    this.pump()
    return { batchId, jobs }
  }

  /**
   * Records an over-limit file as a visible `failed` job (SPEC.md §4.2 applies the §4.1 size
   * cap to the watch folder too — uploads get a 413, the watcher lands here). The original is
   * still staged into `.raw/<job-id>/` so the inbox can be emptied without losing data, and a
   * retry after raising `maxUploadBytes` re-enters the pipeline normally. No hash is computed —
   * hashing a file we refuse to process would cost the most exactly when it helps the least.
   */
  rejectOversizedFile(input: {
    readonly sourcePath: string
    readonly originalName: string
    readonly source: JobSource
    readonly sizeBytes: number
    readonly limitBytes: number
  }): JobRow {
    const originalName = sanitizeOriginalName(input.originalName)
    const created = this.store.create({
      source: input.source,
      type: guessType(originalName),
      originalName,
    })
    this.stageFile(created.job.id, input.sourcePath, originalName)
    return this.store.transition(created.job.id, 'failed', {
      patch: {
        error: `file is ${input.sizeBytes} bytes - over the ${input.limitBytes}-byte limit (maxUploadBytes); raise the limit in settings and retry`,
      },
      log: `refused: ${input.sizeBytes} bytes exceeds the configured maxUploadBytes (${input.limitBytes})`,
      level: 'error',
    })
  }

  /** Enqueues a URL job (not content-addressed, so not deduped). */
  enqueueUrl(input: {
    readonly url: string
    readonly source?: JobSource
    readonly batchId?: string
    readonly notifyChannel?: string
    /** Hold the job for the night shift instead of running it now. */
    readonly hold?: JobHold
  }): CreateJobResult {
    const created = this.store.create({
      source: input.source ?? 'url',
      type: 'web',
      url: input.url,
      ...this.vaultKnowsUrl(input.url),
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.notifyChannel ? { notifyChannel: input.notifyChannel } : {}),
      ...(input.hold ? { hold: input.hold } : {}),
    })
    this.pump()
    return created
  }

  /**
   * Lets the jobs held for this moment run (docs/tasks/TASKS-SWEEP-2026-09.md, chunk 6):
   * the night shift calls it at its start and then waits on {@link onIdle}, so every held
   * ingest is done before the first Fellow works. A held batch becomes a pending unit here,
   * from its rows, the same way a restart rebuilds the units it lost.
   */
  releaseHeld(hold: JobHold): string[] {
    const ids = this.store.release(hold)
    if (ids.length === 0) return ids
    this.reloadPendingBatches()
    this.pump()
    return ids
  }

  /**
   * A job the night shift released leaves tonight's ingest queue once it is through (v26):
   * its commit made, or its run ended with nothing left to run tonight. Called when a
   * worker finishes with it, which is after the commit step - `done` alone is not through,
   * the commit comes after it, and the Library draws the queue until the commit is made. A
   * job queued again (a transient failure, a usage-limit pause) or waiting on a preprocess
   * retry stays: it still runs.
   */
  private settleNight(id: string): void {
    const row = this.store.get(id)
    if (row === undefined || row.night_released_at === null) return
    if (row.status === 'queued' || (row.status === 'failed' && this.preprocessRetries.has(id))) return
    this.store.clearNightRelease(id)
  }

  /** Resolves once the queue has no in-flight jobs and nothing left to claim. */
  onIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  /**
   * Manually resumes after a pause (also called by both auto-resume timers). If the reason still
   * holds — e.g. the budget is still spent — `pump()` simply pauses again rather than spinning.
   */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.pauseReason = null
    this.pump()
  }

  private isIdle(): boolean {
    if (this.inFlight > 0) return false
    // A paused queue makes no further progress until it resumes, so with nothing in
    // flight it counts as settled even though jobs are still queued behind the pause.
    if (this.paused) return true
    if (this.pendingBatches.length > 0) return false
    // Held jobs are queued but wait for their moment: they do not keep the queue awake.
    return this.store.queuedReady() === 0
  }

  private settleIdle(): void {
    if (this.isIdle()) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  private pump(): void {
    if (!this.running || this.paused || this.reconciling) {
      this.settleIdle()
      return
    }
    // Checked before claiming, never mid-job: an in-flight run always finishes, so a budget
    // can be overshot by at most the runs already started (SPEC.md §11.3).
    if (this.budgetExceeded()) {
      this.pauseForBudget()
      this.settleIdle()
      return
    }
    while (this.inFlight < this.concurrency) {
      // A batch occupies one slot for its whole combined run; drain pending batches first.
      const unit = this.pendingBatches.shift()
      if (unit !== undefined) {
        this.inFlight++
        void this.processBatch(unit)
          .catch((err: unknown) => {
            const id = unit.memberIds[0] ?? 'unknown'
            this.store.log(id, 'error', `batch worker crashed: ${(err as Error).message}`)
          })
          .finally(() => {
            this.inFlight--
            for (const id of unit.memberIds) this.settleNight(id)
            this.pump()
          })
        continue
      }
      const job = this.store.claimNextQueued()
      if (job === undefined) break
      this.inFlight++
      void this.processJob(job)
        .catch((err: unknown) => {
          // A crash here is a bug, not an ingest failure — record it and don't wedge the job.
          this.store.log(job.id, 'error', `worker crashed: ${(err as Error).message}`)
          try {
            this.store.transition(job.id, 'failed', { patch: { error: `worker crash: ${(err as Error).message}` } })
          } catch {
            /* job may already be terminal */
          }
        })
        .finally(() => {
          this.inFlight--
          this.settleNight(job.id)
          this.pump()
        })
    }
    this.settleIdle()
  }

  private async processJob(job: JobRow): Promise<void> {
    const jobDir = path.join(this.vaultRoot, '.raw', job.id)
    this.store.setRawPath(job.id, path.posix.join('.raw', job.id))

    let pre: PreprocessResult
    try {
      pre = await this.preprocessStep(job, jobDir)
    } catch (err) {
      const message = (err as Error).message
      this.store.transition(job.id, 'failed', {
        patch: { error: `preprocessing failed: ${message}` },
        log: `preprocessing failed: ${message}`,
        level: 'error',
      })
      if (err instanceof PreprocessError && err.transient) this.schedulePreprocessRetry(job.id)
      return
    }

    /*
     * The size cap (D4): an original past it stays on disk and out of git history. Decided
     * HERE, after preprocessing and before the run, so the payload is never in a commit - the
     * measured alternative is 786 MiB of scans in the history of a 16 MB knowledge base.
     */
    for (const kept of this.keepPayloadLocal(this.vaultRoot, path.posix.join('.raw', job.id), pre.manifestPath)) {
      this.store.log(
        job.id,
        'info',
        `payload not versioned: ${kept.rel} is ${Math.round(kept.bytes / (1024 * 1024))} MB, over the cap - it stays on disk, the pages and the manifest commit as usual`,
      )
    }

    this.store.setType(job.id, pre.type)
    this.logPreprocessWarnings(job.id, pre)

    if (pre.deferred) {
      this.deferJob(job, jobDir)
      this.store.transition(job.id, 'deferred', {
        log: pre.manifest.notes.join('; ') || 'unsupported type - deferred',
        level: 'warn',
      })
      return
    }

    const dup = this.contentDuplicate(job, pre)
    if (dup !== undefined) {
      await this.settleContentDuplicate(job, dup)
      return
    }

    this.store.transition(job.id, 'ingesting', { log: `preprocessed as ${pre.type}` })
    await this.ingestStep(job, pre)
  }

  /**
   * What preprocessing found in the document itself and the reader should know about: text
   * aimed at an assistant (docs/sources/SPEC.md section 4.3). A warning, never a failure - the
   * job runs on, and the line is in its log when someone asks why a page reads oddly.
   */
  private logPreprocessWarnings(jobId: string, pre: PreprocessResult): void {
    for (const warning of pre.manifest.warnings ?? []) this.store.log(jobId, 'warn', warning)
  }

  /** Runs preprocessing, skipping it when a prior attempt already produced a manifest. */
  private async preprocessStep(job: JobRow, jobDir: string): Promise<PreprocessResult> {
    const manifestPath = path.join(jobDir, 'manifest.json')
    if (fs.existsSync(manifestPath)) {
      this.store.log(job.id, 'info', 'preprocessing skipped - manifest from a prior attempt reused')
      return resultFromManifest(this.vaultRoot, jobDir, manifestPath)
    }
    this.toolsCache ??= await this.detectToolsFn()

    // A URL job is identified by carrying a url, NOT by `source`: `source` is the channel
    // (drop | watch | url), so a URL dropped via the dashboard/CLI has source 'drop' but
    // is still a web job. Keying off `source` here mis-routed it as a file (the M1 test's
    // one failure) — the presence of `url` is the correct discriminator.
    if (job.url) {
      return this.preprocessUrlFn({
        jobId: job.id,
        url: job.url,
        vaultRoot: this.vaultRoot,
        jobDir,
        tools: this.toolsCache,
        oa: {
          enabled: this.oaRecovery(),
          ...(this.oaLookups ? { cache: this.oaLookups } : {}),
          /*
           * A job started from the reading list carries the copy that list already names (6.3).
           * Read here rather than stored on the job: the page is the record, a retry gets the
           * same answer, and an entry marked after the job was queued is still honoured.
           */
          ...((): { hint?: { url: string; version?: string | null } } => {
            const copy = job.url === null ? undefined : this.reading?.openCopyFor(job.url)
            return copy === undefined ? {} : { hint: { url: copy.url, version: copy.version } }
          })(),
        },
      })
    }
    if (!job.original_name) throw new Error('file job has no original_name')
    return this.preprocessFile({
      jobId: job.id,
      source: job.source,
      sourcePath: path.join(jobDir, job.original_name),
      originalName: job.original_name,
      vaultRoot: this.vaultRoot,
      jobDir,
      ...(job.sha256 ? { sha256: job.sha256 } : {}),
      tools: this.toolsCache,
    })
  }

  private async ingestStep(job: JobRow, pre: PreprocessResult): Promise<void> {
    const attempt = this.store.incrementAttempts(job.id)
    const prompt = `ingest ${pre.primaryArtifact}`
    this.store.log(job.id, 'info', `ingest attempt ${attempt}: ${prompt}`)
    // What the vault already holds on this subject (A8). The one run type whose job is
    // "create or update" was the one with no pointer to existing pages but a 514 kB index.
    const overlap = await this.vaultOverlap(job, pre.manifest, pre.primaryArtifact)

    // Bracket + register as a writer so Bash-written pages can be swept into the commit, but
    // only when this turns out to be the sole writer (finding F4).
    const dirtyBefore = await dirtyPaths(this.vaultRoot)
    // The reading list before the run, so the entries the run adds can be signed by it.
    const readingBefore = this.reading?.urlKeys()
    const endRun = this.runRegistry.begin(dirtyBefore)
    const written = new Set<string>()
    const res = await this.runIngest({
      vaultRoot: this.vaultRoot,
      prompt,
      auth: this.assertAuth(),
      timeoutMs: this.timeoutMs,
      // Read per run, not cached: the registry is a vault page the user may edit at any
      // time, and the next ingest should honour the edit without a service restart.
      systemPromptExtra: [
        domainSystemPrompt(readDomainRegistry(this.vaultRoot)),
        PAGE_HYGIENE_CHECKLIST,
        UNTRUSTED_CONTENT_RULES,
        ENTITY_NOTABILITY_RULES,
        TAG_HYGIENE_RULES,
        // How this run says it reached its end (2.4): one file, touched last. Crash recovery
        // reads it instead of searching wiki/log.md, which the service now writes itself.
        renderCompletionMarker(runMarkerPath(job.id) ?? ''),
        // Only when a list is wired, which is only behind the flag (main.ts, TASKS-A6 D1).
        this.reading === undefined ? '' : renderReadingList(INGEST_ACTOR, localDate(new Date())),
        overlap,
        renderProvenance([{ artifact: pre.primaryArtifact, url: job.url }]),
        // Where the text came from when it did not come from the address (5.4).
        renderOaNotice(pre.manifest.oa === undefined ? [] : [{ artifact: pre.primaryArtifact, oa: pre.manifest.oa }]),
      ]
        .filter(Boolean)
        .join('\n\n'),
      onMessage: (m) => {
        const line = formatMessage(m)
        if (line !== undefined) this.store.log(job.id, 'info', line)
        for (const p of extractWrittenPaths(m, this.vaultRoot)) written.add(p)
      },
    })

    if (res.ok) {
      this.store.transition(job.id, 'done', {
        patch: {
          tokensIn: res.usage.tokensIn,
          tokensOut: res.usage.tokensOut,
          costUsd: res.usage.costUsd,
        },
        log: `ingest complete over ${res.numTurns} turns`,
      })
      // created_pages comes from the actual commit (see commitVault): the only
      // authoritative record of what landed, correct even at concurrency 2.
      const committed = await this.commitStep(job, {
        written,
        dirtyBefore,
        extra: [path.posix.join('.raw', job.id)],
        readingBefore,
        // The run's own account of what it did, which becomes the log entry's paragraph. No
        // new agent contract: every run already produces this.
        summary: res.result,
      })
      endRun()
      this.markNoChanges(job.id, committed)
      await this.validateStep(job.id, [...written, ...committed], [job.id])
      const note = await this.refreshHotCache(this.vaultRoot)
      this.store.log(job.id, 'info', note)
      return
    }

    endRun()
    const outcome = classifyFailure(res)
    this.store.transition(job.id, 'failed', {
      patch: {
        error: res.error ?? 'ingest failed',
        tokensIn: res.usage.tokensIn,
        tokensOut: res.usage.tokensOut,
        costUsd: res.usage.costUsd,
      },
      log: `ingest failed (${outcome}): ${res.error ?? 'unknown error'}`,
      level: 'error',
    })

    if (outcome === 'rate_limit') {
      this.store.decrementAttempts(job.id) // a usage-limit pause is not the job's fault
      this.store.transition(job.id, 'queued', { log: 'requeued - will retry after the usage-limit pause' })
      this.pauseForRateLimit(job.id, res.error)
      return
    }
    if (outcome === 'transient' && attempt <= this.maxRetries) {
      this.store.transition(job.id, 'queued', {
        log: `retry ${attempt}/${this.maxRetries} scheduled after transient error`,
      })
      return
    }
    this.store.log(
      job.id,
      'error',
      outcome === 'transient'
        ? `gave up after ${attempt} attempt(s) - retries exhausted`
        : 'permanent failure - not retried',
    )
  }

  /**
   * Builds the commit pathspec. MUST be called inside the commit mutex: the sole-writer question
   * and the sweep have to happen together, or another run could start writing in between.
   */
  private async buildPathspec(scope: CommitScope, log: (message: string) => void): Promise<string[]> {
    const sole = this.runRegistry.isSoleWriter()
    const swept = sole ? newWikiPaths(scope.dirtyBefore, await dirtyPaths(this.vaultRoot)) : []
    // The sweep sees every page the run dirtied, tool-reported ones included; only the rest
    // is the F4 blind spot worth a log line (until 2026-09-18 an Edit of `wiki/log.md` was
    // announced as a page "the tool stream did not report").
    const unreported = swept.filter((p) => !scope.written.has(p))
    if (unreported.length > 0) {
      log(`staging ${unreported.length} page(s) the tool stream did not report (F4)`)
    } else if (!sole) {
      log('another run is writing - staging only tool-reported paths (F4 sweep skipped)')
    }
    // The reading list entries this run added are signed by it, whatever the agent wrote on
    // their by line - only while it is the sole writer, for the same reason the sweep is.
    const signed = sole && scope.readingBefore !== undefined && this.reading !== undefined ? await this.reading.attributeRun(INGEST_ACTOR, scope.readingBefore) : []
    if (signed.length > 0) {
      const wrote = [...new Set(signed.map((s) => s.was ?? 'no name'))].join(', ')
      log(`reading list: ${signed.length} new entr${signed.length === 1 ? 'y' : 'ies'} signed "${INGEST_ACTOR}" (the run had written: ${wrote})`)
    }
    return [...new Set([...scope.written, ...swept, ...(signed.length > 0 ? [READING_LIST_PAGE] : []), ...scope.extra, ...BOOKKEEPING_PATHS])]
  }

  /** Returns the committed wiki pages, so the validation step can cover Bash-written pages
   * the tool stream never reported (empty when the commit was skipped or failed). */
  /**
   * The overlap block for one document (3.1): what the vault already holds on its subject.
   *
   * Both mechanisms, the same two the chat and the research paths get - title-token overlap
   * plus chunk retrieval when the index is provisioned. Advisory throughout: a failure here
   * leaves the prompt exactly as it was before this existed.
   */
  private async vaultOverlap(job: JobRow, manifest: Manifest, artifact: string): Promise<string> {
    const topic = topicForJob(this.vaultRoot, manifest, artifact)
    if (topic === '') return ''
    const block = await vaultOverlapFor(this.vaultRoot, topic, async (t) => {
      const { candidates } = await retrieveCandidates({ vaultRoot: this.vaultRoot, question: t })
      return candidates.map((c) => c.pagePath)
    })
    this.store.log(
      job.id,
      'info',
      block === ''
        ? `vault overlap: nothing on "${topic}" yet - this is a new subject for the vault`
        : `vault overlap on "${topic}": ${block.split('\n').filter((l) => l.startsWith('- ')).length} existing page(s) named in the prompt`,
    )
    return block
  }

  /**
   * The content pages a run wrote, which are the ones whose `content_updated:` it earns
   * (SPEC.md §12.13).
   *
   * Everything the run touched that is NOT a hub: the index, the log, the hot cache and the
   * bucket `_index` MOCs are navigation, and a run adding a line to one of them has not said
   * anything new about a subject. `wiki/meta/` is left out for the same reason - a notebook or
   * a recap is the service writing about a run, and its own writer stamps it.
   */
  private contentPagesOf(written: Iterable<string>): string[] {
    const hubs = new Set<string>([...SERVICE_OWNED_HUBS, 'wiki/hot.md'])
    return [...new Set(written)]
      .filter(
        (rel) =>
          rel.startsWith('wiki/') &&
          rel.endsWith('.md') &&
          !hubs.has(rel) &&
          !rel.endsWith('/_index.md') &&
          !rel.startsWith('wiki/meta/'),
      )
      .sort()
  }

  /**
   * Stamps `content_updated:` on the pages this run wrote (SPEC.md §12.13, task 7.3).
   *
   * WHY THIS EXISTS AT ALL, when `stampDates` already does the work. The field is written by
   * OUR writers, and an ingest's pages are written by the AGENT, from the vault's own
   * frontmatter template - which has no such field. Measured on the first real ingest after
   * 7.3 shipped: four of five new pages carried `updated:` and no `content_updated:`, so the
   * one path that produces most of the vault's pages was the one path not filling the field.
   *
   * Doing it here rather than asking the agent to is deliberate: a prompt rule holds only as
   * long as every run remembers it, and the whole point of the field is that a later reader can
   * trust it. `bodyChanged` is not consulted - a run that wrote a page said something, which is
   * exactly the judgement §12.13 asks the WRITER to make.
   *
   * Runs inside the commit mutex so the stamp rides in the run's own commit, and the pages'
   * locks are taken by the caller OUTSIDE it, which is hard rule 1's order.
   */
  private stampContentDates(job: JobRow, pages: readonly string[], held: ReadonlySet<string>): void {
    let stamped = 0
    const skipped: string[] = []
    for (const rel of pages) {
      if (!held.has(rel)) {
        skipped.push(rel)
        continue
      }
      const abs = path.join(this.vaultRoot, rel)
      try {
        const before = fs.readFileSync(abs, 'utf8')
        const after = stampDates(before, { content: true })
        if (after === before) continue
        fs.writeFileSync(abs, after)
        stamped++
      } catch (err) {
        // Never fatal: the page is written and committed either way, and a missing date is a
        // weaker signal, not a broken vault.
        this.store.log(job.id, 'warn', `content date: ${rel} could not be stamped (${(err as Error).message})`)
      }
    }
    if (stamped > 0) this.store.log(job.id, 'info', `content date: ${CONTENT_UPDATED} set on ${stamped} page(s)`)
    if (skipped.length > 0) {
      this.store.log(job.id, 'warn', `content date: another writer holds ${skipped.length} page(s) - left unstamped`)
    }
  }

  /**
   * The hub write for one run (D2): the log entry and the regenerated index, inside this run's
   * own commit.
   *
   * Called INSIDE the commit mutex with the hubs' vault locks already held. What it writes is
   * decided by what the commit carries: a run that wrote no content page writes no entry and
   * does not regenerate the index, because there is nothing to say and nothing would change.
   *
   * A hub whose lock is held by somebody else is left alone rather than written anyway - the
   * index is regenerated by the next run in any case, and that is the safety net a derived file
   * gives us.
   */
  private async writeHubsFor(
    job: JobRow,
    label: string,
    pathspec: readonly string[],
    held: ReadonlySet<string>,
    summary: string | undefined,
  ): Promise<string[]> {
    const git = await unversionedWikiPages(this.vaultRoot)
    const addresses = readAddresses(this.vaultRoot, [...git.untracked, ...git.modified])
    const { created, updated } = classifyLoggedPages(pathspec, git, addresses)
    if (created.length === 0 && updated.length === 0) return []

    const entry: LogEntryInput = {
      date: new Date().toISOString().slice(0, 10),
      kind: job.batch_id === null ? 'ingest' : 'batch ingest',
      title: label,
      source: job.raw_path ?? path.posix.join('.raw', job.id),
      created,
      updated,
      summary: summary ?? null,
    }
    const plan: HubPlan = {
      index: held.has('wiki/index.md'),
      // Only the bucket hubs this run actually holds: one somebody else is writing is left alone.
      buckets: bucketHubs(this.vaultRoot).filter((rel) => held.has(rel)),
      entry: held.has('wiki/log.md') ? entry : null,
    }
    const { paths, warnings } = writeHubs(this.vaultRoot, plan)
    // Loud, and not fatal: the pages are what matters, the job stays `done`, and the next run
    // regenerates the index anyway.
    for (const w of warnings) this.store.log(job.id, 'warn', w)
    if (paths.length > 0) this.store.log(job.id, 'info', `hub layer: wrote ${paths.join(', ')}`)
    return paths
  }

  private async commitStep(job: JobRow, scope: CommitScope): Promise<string[]> {
    const label = job.original_name ?? job.url ?? job.id
    if (!this.autoCommit()) {
      // Pages are already written; only the commit is skipped, so nothing is lost — the
      // operator (or the next run with auto-commit on) picks them up.
      this.store.log(job.id, 'info', 'auto-commit disabled in settings - pages are on disk, not committed')
      return []
    }
    try {
      /*
       * The hub layer (SPEC.md §12.12): the index and the log entry are written HERE, by the
       * service, into this run's own commit - one run, one commit, hubs included.
       *
       * Order is hard rule 1's: the vault's own per-file lock on the hubs OUTSIDE our commit
       * mutex, the write and the commit inside it. The plan is built from the pathspec that is
       * about to be committed, so the entry names exactly the pages this commit carries.
       */
      // The run's own content pages are locked alongside the hubs, because their
      // `content_updated:` is stamped in the same commit (SPEC.md §12.13). Both lists are
      // acquired here, OUTSIDE the mutex, which is hard rule 1's order.
      const contentPages = this.contentPagesOf(scope.written)
      const toLock = [...SERVICE_OWNED_HUBS, ...bucketHubs(this.vaultRoot), ...contentPages]
      const result = await withWikiLocks(this.vaultRoot, toLock, async (held, busy) => {
        if (busy.length > 0) {
          this.store.log(job.id, 'warn', `hub write: another writer holds ${busy.join(', ')} - leaving ${busy.length} hub(s) alone`)
        }
        return await this.commitMutex.runExclusive(async () => {
          const heldSet = new Set(held)
          this.stampContentDates(job, contentPages, heldSet)
          const pathspec = await this.buildPathspec(scope, (m) => this.store.log(job.id, 'info', m))
          const hubs = await this.writeHubsFor(job, label, pathspec, heldSet, scope.summary)
          return this.commit(this.vaultRoot, `ingest: ${label}`, { pathspec: [...pathspec, ...hubs] })
        })
      })
      if (result.committed) {
        // Anchor for "revert this ingest" (v9): persisted, not scraped back out of the log text.
        if (result.hash) this.store.setCommitHash(job.id, result.hash)
        this.store.log(
          job.id,
          'info',
          `committed ${result.hash?.slice(0, 8)} (${result.committedPages.length} wiki page(s))`,
        )
        // Vault-visible numbers (page counts, git history) changed → refresh the Overview.
        this.events?.publish({ kind: 'stats' })
        if (result.committedPages.length > 0) {
          this.store.setCreatedPages(job.id, result.committedPages)
          return result.committedPages
        }
        // Committed, but not a single wiki page: this commit carried only the raw payload,
        // and the run's pages went into someone else's - the ingest skill's own commit, or
        // a sibling's sweep at concurrency 2. Recording nothing here is what left a finished
        // ingest showing "-" pages in the dashboard.
        return await this.recoverPageRecord(job, scope.written)
      }
      // Staging nothing does NOT mean this run produced nothing - the ingest skill commits
      // its own work, and when it wins that race the index is empty by the time we get here.
      this.store.log(job.id, 'info', `not committed: ${result.note ?? 'no changes'}`)
      return await this.recoverPageRecord(job, scope.written)
    } catch (err) {
      // A commit failure must not undo a completed ingest — the pages are on disk. Note the job
      // is already `done` (terminal) by now, and the old net that eventually swept these in (a
      // later run's `git add -A`) is gone (see commitVault), so they are NOT auto-recovered:
      // the operator commits them from the dashboard. This is deliberately narrow — a commit
      // throwing while inside the mutex with a staged tree means disk-full or a broken repo,
      // where a silent later sweep would have failed too. Surface it loudly, don't fail the job.
      this.store.log(job.id, 'warn', `git commit failed (pages are on disk, commit manually): ${(err as Error).message}`)
    }
    return []
  }

  /**
   * Re-derives the page list and commit hash for finished ingests that never recorded
   * either (see {@link JobStore.settledWithoutPages}). Startup-only and bounded; every
   * repair is logged against its own job, so the correction is as traceable as the ingest.
   */
  private async backfillPageRecords(): Promise<void> {
    const missing = this.store.settledWithoutPages()
    let repaired = 0
    for (const job of missing) {
      const pages = await this.recoverPageRecord(job, new Set())
      if (pages.length > 0) repaired++
    }
    if (repaired > 0) {
      this.events?.publish({ kind: 'stats' })
    }
  }

  /**
   * What a run produced, when the service's own commit staged nothing.
   *
   * Without this the job kept an empty `created_pages` and no `commit_hash` whenever the
   * ingest skill committed first (2026-08-26): the dashboard's job row showed "-" pages and
   * no links, and the run's commit surfaced as a second, unexplained row beside it because
   * nothing could join the two. Two sources, in order of authority:
   *
   *  1. THE COMMIT that touched this job's `.raw/<job-id>/`. Whoever wrote it, that is what
   *     landed in git, and the raw directory makes it attributable to this job alone.
   *  2. The paths the run itself wrote. Only reached when nothing committed at all, so these
   *     pages are on disk and unversioned - said plainly in the log, because that is a state
   *     the operator has to resolve (the dashboard's "unversioned pages" figure counts them).
   */
  private async recoverPageRecord(job: JobRow, written: ReadonlySet<string>): Promise<string[]> {
    const rawDir = path.posix.join('.raw', job.id)
    const since = job.started_at !== null ? new Date(job.started_at) : null
    try {
      const own = await commitTouching(this.vaultRoot, rawDir, since)
      if (own !== null && own.pages.length > 0) {
        this.store.setCreatedPages(job.id, own.pages)
        this.store.setCommitHash(job.id, own.hash)
        this.store.log(
          job.id,
          'info',
          `the run committed its own work as ${own.hash.slice(0, 8)} (${own.pages.length} wiki page(s)) - recorded against this job`,
        )
        this.events?.publish({ kind: 'stats' })
        return own.pages
      }
    } catch (err) {
      this.store.log(job.id, 'warn', `could not read git for this job's commit: ${(err as Error).message}`)
    }

    const onDisk = [...written].filter((p) => p.startsWith('wiki/') && p.endsWith('.md')).sort()
    if (onDisk.length === 0) return []
    this.store.setCreatedPages(job.id, onDisk)
    // Deliberately not "these are uncommitted": at concurrency 2 a sibling's commit may
    // legitimately carry them. What IS certain is that no commit of this job's own did, and
    // that the run wrote them - which is exactly what the row should show.
    this.store.log(
      job.id,
      'info',
      `${onDisk.length} wiki page(s) recorded from the run's own writes; no commit of this job's own carried them`,
    )
    return []
  }

  /**
   * Post-run validation (validator.ts): the mechanical lint checks, scoped to the pages this
   * run touched, logged as warnings while the job's context is still on screen. Advisory by
   * design — a finding never fails a `done` job, and a validator crash only logs.
   */
  private async validateStep(jobId: string, touched: readonly string[], jobIds: readonly string[]): Promise<void> {
    const findings: ValidationFinding[] = []
    try {
      if (this.validate !== undefined) findings.push(...this.validate(touched))
    } catch (err) {
      this.store.log(jobId, 'warn', `post-run validation crashed (ignored): ${(err as Error).message}`)
    }
    /*
     * The quotes this run ADDED, against the text it read (docs/sources/SPEC.md section 7). Its
     * own step because it needs two things the page rules do not: the job's artifacts, and the
     * commit the run just made - without a before there is no telling this run's quotes from
     * those of the runs before it.
     */
    try {
      const hash = this.store.get(jobId)?.commit_hash ?? null
      const quotes = await checkQuotes({
        vaultRoot: this.vaultRoot,
        jobIds,
        pages: touched,
        ...(hash === null ? {} : { before: gitPageBefore((rev, rel) => readAtRevision(this.vaultRoot, rev, rel), hash) }),
      })
      findings.push(...quotes.findings)
      this.store.setValidation(jobId, { quotes: quotes.summary })
      if (quotes.summary.checked > 0) {
        this.store.log(
          jobId,
          quotes.summary.unverified > 0 ? 'warn' : 'info',
          `quotes: ${quotes.summary.checked} checked, ${quotes.summary.unverified} not found in the source`,
        )
      }
    } catch (err) {
      this.store.log(jobId, 'warn', `quote check crashed (ignored): ${(err as Error).message}`)
    }
    /*
     * Near-duplicates, through the VAULT'S own tiling check (A5). It is the only duplicate
     * detector in the system and it had never run; this is what finally asks it. Scoped to the
     * pages this run touched, so an ingest hears about the duplicates it created rather than
     * about every pair in the vault, and skipped silently on any of the reasons the script
     * documents (no ollama, no model, older vault).
     */
    try {
      const tiling = await this.tiling(this.vaultRoot)
      if (tiling.skipped !== undefined) this.store.log(jobId, 'info', `duplicate check: ${tiling.skipped}`)
      else {
        /*
         * The ERROR band only, on the job. Measured against the live vault with the thresholds
         * the vault ships: 215 pairs at or above 0.90, and 3218 between 0.80 and 0.90. The
         * shipped bands say of themselves that they are uncalibrated, and a review band that
         * size is a standing list (phase 5), never a per-run finding.
         */
        const mine = pairsTouching(tiling.pairs, touched)
        const review = mine.filter((p) => p.band === 'review').length
        if (review > 0) {
          this.store.log(jobId, 'info', `duplicate check: ${review} further pair(s) in the review band, below the vault's error threshold`)
        }
        for (const pair of mine.filter((p) => p.band === 'error')) {
          findings.push({
            rule: 'near-duplicate',
            path: pair.a,
            message:
              `reads as the same subject as ${pair.b} (similarity ${pair.similarity.toFixed(3)}, ` +
              `above the vault's own error threshold) - one of them should extend the other`,
          })
        }
      }
    } catch (err) {
      this.store.log(jobId, 'warn', `duplicate check crashed (ignored): ${(err as Error).message}`)
    }
    /*
     * One line per NEW finding, one number for the repeats (A9, 5.2). The old behaviour wrote
     * a line per occurrence: 406 warnings over the measured population, of which one dead link
     * accounted for 109. A defect reported again on every run cannot be told apart from one
     * that was just introduced, which is why nothing ever acted on any of them.
     */
    if (this.validationStore !== undefined) {
      const { created, repeated } = this.validationStore.record(findings, jobId)
      // What this run looked at and no longer finds is repaired: taking it off the list is how
      // a fix becomes visible at all.
      const resolved = this.validationStore.resolveMissing(touched, findings)
      for (const f of created) this.store.log(jobId, 'warn', `validation [${f.rule}] ${f.path}: ${f.message}`)
      const parts: string[] = []
      if (created.length > 0) parts.push(`${created.length} new`)
      if (repeated > 0) parts.push(`${repeated} standing`)
      if (resolved > 0) parts.push(`${resolved} fixed since the last run`)
      this.store.log(
        jobId,
        created.length > 0 ? 'warn' : 'info',
        parts.length === 0 ? 'post-run validation: no findings' : `post-run validation: ${parts.join(', ')} (the standing list is on the System screen)`,
      )
      return
    }
    if (findings.length === 0) {
      this.store.log(jobId, 'info', 'post-run validation: no findings')
      return
    }
    for (const f of findings) this.store.log(jobId, 'warn', `validation [${f.rule}] ${f.path}: ${f.message}`)
    this.store.log(
      jobId,
      'warn',
      `post-run validation: ${findings.length} finding(s), advisory only, nothing was modified`,
    )
  }

  /**
   * Processes one batch: preprocess each member individually, then a single combined
   * `ingest all of these` run over the surviving artifacts, one commit, all members done.
   * Deferred/failed members drop out but never sink the rest of the batch.
   */
  private async processBatch(unit: BatchUnit): Promise<void> {
    const ready: Array<{ id: string; artifact: string; url: string | null; oa?: OaDisclosure; manifest: Manifest }> = []
    const names: string[] = []

    for (const id of unit.memberIds) {
      const job = this.store.get(id)
      if (job === undefined || job.status !== 'queued') continue // already handled/cancelled
      const jobDir = path.join(this.vaultRoot, '.raw', id)
      this.store.setRawPath(id, path.posix.join('.raw', id))
      try {
        this.store.transition(id, 'preprocessing', { log: 'batch: preprocessing member' })
        const pre = await this.preprocessStep(job, jobDir)
        this.store.setType(id, pre.type)
        this.logPreprocessWarnings(id, pre)
        if (pre.deferred) {
          this.deferJob(job, jobDir)
          this.store.transition(id, 'deferred', {
            log: pre.manifest.notes.join('; ') || 'unsupported type - deferred',
            level: 'warn',
          })
          continue
        }
        const dup = this.contentDuplicate(job, pre)
        if (dup !== undefined) {
          await this.settleContentDuplicate(job, dup)
          continue
        }
        ready.push({ id, artifact: pre.primaryArtifact, url: job.url, manifest: pre.manifest, ...(pre.manifest.oa ? { oa: pre.manifest.oa } : {}) })
        names.push(job.original_name ?? job.url ?? id)
      } catch (err) {
        this.store.transition(id, 'failed', {
          patch: { error: `preprocessing failed: ${(err as Error).message}` },
          log: `batch member preprocessing failed: ${(err as Error).message}`,
          level: 'error',
        })
      }
    }

    if (ready.length === 0) return

    for (const r of ready) this.store.transition(r.id, 'ingesting', { log: 'batch: combined ingest' })
    const attempt = this.store.incrementAttempts(ready[0]!.id)
    for (const r of ready.slice(1)) this.store.incrementAttempts(r.id)

    const lead = ready[0]!.id
    const prompt = `ingest all of these:\n${ready.map((r) => `- ${r.artifact}`).join('\n')}`
    this.store.log(lead, 'info', `batch combined ingest of ${ready.length} artifact(s), attempt ${attempt}`)
    /*
     * One overlap block PER MEMBER, not one merged block (3.1). A batch is several documents
     * on several subjects; merging their topics into one query returns the pages that overlap
     * the mixture, which is nothing in particular.
     */
    const overlaps: string[] = []
    for (const member of ready) {
      const block = await this.vaultOverlap(this.store.getOrThrow(member.id), member.manifest, member.artifact)
      if (block !== '') overlaps.push(`\n\nFor ${member.artifact}:${block}`)
    }

    // Same F4 bracket as the single-job path.
    const dirtyBefore = await dirtyPaths(this.vaultRoot)
    const readingBefore = this.reading?.urlKeys()
    const endRun = this.runRegistry.begin(dirtyBefore)
    const written = new Set<string>()
    const res = await this.runIngest({
      vaultRoot: this.vaultRoot,
      prompt,
      auth: this.assertAuth(),
      timeoutMs: this.timeoutMs,
      // Read per run, not cached: the registry is a vault page the user may edit at any
      // time, and the next ingest should honour the edit without a service restart.
      systemPromptExtra: [
        domainSystemPrompt(readDomainRegistry(this.vaultRoot)),
        PAGE_HYGIENE_CHECKLIST,
        UNTRUSTED_CONTENT_RULES,
        ENTITY_NOTABILITY_RULES,
        TAG_HYGIENE_RULES,
        // A batch is one run with one lead job, so it leaves one marker - the lead's (2.4).
        renderCompletionMarker(runMarkerPath(lead) ?? ''),
        // Only when a list is wired, which is only behind the flag (main.ts, TASKS-A6 D1).
        this.reading === undefined ? '' : renderReadingList(INGEST_ACTOR, localDate(new Date())),
        overlaps.join(''),
        // Each member keeps its OWN origin: a batch is several documents, and one shared
        // address would file the wrong one on all but one of them.
        renderProvenance(ready.map((r) => ({ artifact: r.artifact, url: r.url }))),
        // Same per member: two documents in one batch can have come from two different copies.
        renderOaNotice(ready.flatMap((r) => (r.oa === undefined ? [] : [{ artifact: r.artifact, oa: r.oa }]))),
      ]
        .filter(Boolean)
        .join('\n\n'),
      onMessage: (m) => {
        const line = formatMessage(m)
        if (line !== undefined) this.store.log(lead, 'info', line)
        for (const p of extractWrittenPaths(m, this.vaultRoot)) written.add(p)
      },
    })

    if (res.ok) {
      // Split usage evenly so aggregate dashboard totals aren't multiplied by batch size;
      // the remainder lands on the lead member.
      const n = ready.length
      const perIn = Math.floor(res.usage.tokensIn / n)
      const perOut = Math.floor(res.usage.tokensOut / n)
      ready.forEach((r, i) => {
        this.store.transition(r.id, 'done', {
          patch: {
            tokensIn: perIn + (i === 0 ? res.usage.tokensIn - perIn * n : 0),
            tokensOut: perOut + (i === 0 ? res.usage.tokensOut - perOut * n : 0),
            costUsd: res.usage.costUsd / n,
          },
          log: `batch ingest complete (member ${i + 1}/${n}, ${res.numTurns} turns)`,
        })
      })
      const committed = await this.batchCommit(ready.map((r) => r.id), names, {
        written,
        dirtyBefore,
        extra: ready.map((r) => path.posix.join('.raw', r.id)),
        readingBefore,
      })
      endRun()
      for (const r of ready) this.markNoChanges(r.id, committed)
      // The corpus is the union over the batch: one combined run read all of their documents.
      await this.validateStep(lead, [...written, ...committed], ready.map((r) => r.id))
      const note = await this.refreshHotCache(this.vaultRoot)
      this.store.log(lead, 'info', note)
      return
    }

    endRun()
    const outcome = classifyFailure(res)
    // A failed batch run still spent tokens — split them like the success path does, or the
    // usage aggregate and daily budget under-count exactly the runs that waste the most.
    const n = ready.length
    const perIn = Math.floor(res.usage.tokensIn / n)
    const perOut = Math.floor(res.usage.tokensOut / n)
    ready.forEach((r, i) => {
      this.store.transition(r.id, 'failed', {
        patch: {
          error: res.error ?? 'batch ingest failed',
          tokensIn: perIn + (i === 0 ? res.usage.tokensIn - perIn * n : 0),
          tokensOut: perOut + (i === 0 ? res.usage.tokensOut - perOut * n : 0),
          costUsd: res.usage.costUsd / n,
        },
        log: `batch ingest failed (${outcome}): ${res.error ?? 'unknown error'}`,
        level: 'error',
      })
    })
    const requeue = (logLine: string): void => {
      for (const r of ready) this.store.transition(r.id, 'queued', { log: logLine })
      this.pendingBatches.push({ batchId: unit.batchId, memberIds: ready.map((r) => r.id) })
    }
    if (outcome === 'rate_limit') {
      for (const r of ready) this.store.decrementAttempts(r.id)
      requeue('batch requeued - will retry after the usage-limit pause')
      this.pauseForRateLimit(lead, res.error)
      return
    }
    if (outcome === 'transient' && attempt <= this.maxRetries) {
      requeue(`batch retry ${attempt}/${this.maxRetries} after transient error`)
      return
    }
    this.store.log(
      lead,
      'error',
      outcome === 'transient' ? `batch gave up after ${attempt} attempt(s)` : 'batch permanent failure - not retried',
    )
  }

  /** One commit for a whole batch; every member is attributed the same committed pages.
   * Returns the committed wiki pages for the validation step (empty when skipped/failed). */
  private async batchCommit(memberIds: string[], names: string[], scope: CommitScope): Promise<string[]> {
    const label = names.length <= 2 ? names.join(', ') : `${names[0]} +${names.length - 1} more`
    if (!this.autoCommit()) {
      this.store.log(memberIds[0]!, 'info', 'auto-commit disabled in settings - pages are on disk, not committed')
      return []
    }
    try {
      const result = await this.commitMutex.runExclusive(async () => {
        const pathspec = await this.buildPathspec(scope, (m) => this.store.log(memberIds[0]!, 'info', m))
        return this.commit(this.vaultRoot, `ingest: ${label}`, { pathspec })
      })
      if (result.committed) {
        for (const id of memberIds) this.store.setCreatedPages(id, result.committedPages)
        // Every member gets the SAME hash: one commit covers the batch, so reverting through any
        // one of them undoes all of them (the UI says so before arming the action).
        if (result.hash) for (const id of memberIds) this.store.setCommitHash(id, result.hash)
        this.store.log(memberIds[0]!, 'info', `committed ${result.hash?.slice(0, 8)} (${result.committedPages.length} pages, batch of ${memberIds.length})`)
        this.events?.publish({ kind: 'stats' })
        return result.committedPages
      }
      this.store.log(memberIds[0]!, 'info', `not committed: ${result.note ?? 'no changes'}`)
    } catch (err) {
      this.store.log(memberIds[0]!, 'warn', `git commit failed (pages are on disk): ${(err as Error).message}`)
    }
    return []
  }

  private deferJob(job: JobRow, jobDir: string): void {
    if (job.source === 'url' || !job.original_name) return
    const src = path.join(jobDir, job.original_name)
    if (!fs.existsSync(src)) return
    const deferredDir = path.join(this.vaultRoot, '.raw', 'deferred')
    fs.mkdirSync(deferredDir, { recursive: true })
    fs.renameSync(src, path.join(deferredDir, `${job.id}-${job.original_name}`))
  }

  /**
   * Retries a transient preprocess failure (bot check, upstream 429, timeout) after a
   * linear-backoff delay. The job sits in `failed` until the timer fires — visible and
   * manually retryable the whole time — then requeues itself; a manual retry or cancel
   * in the meantime wins (the timer checks the status before touching the job). Unlike
   * a usage-limit pause this never parks the whole queue: only this job waits.
   */
  private schedulePreprocessRetry(jobId: string): void {
    const attempt = this.store.incrementAttempts(jobId)
    if (attempt > this.maxRetries) {
      this.store.log(jobId, 'error', `gave up after ${attempt} attempt(s) - preprocess retries exhausted`)
      return
    }
    const delayMs = this.preprocessRetryDelayMs * attempt
    this.store.log(
      jobId,
      'info',
      `transient preprocess failure - retry ${attempt}/${this.maxRetries} in ${Math.round(delayMs / 1000)}s`,
    )
    this.preprocessRetries.add(jobId)
    this.setTimeoutFn(() => {
      this.preprocessRetries.delete(jobId)
      if (!this.running) return
      if (this.store.get(jobId)?.status !== 'failed') return // manually retried or cancelled meanwhile
      this.store.transition(jobId, 'queued', {
        log: `retry ${attempt}/${this.maxRetries} after transient preprocess failure`,
      })
      this.pump()
    }, delayMs)
  }

  private pauseForRateLimit(jobId: string, errorText?: string): void {
    if (this.paused) return
    this.paused = true
    this.pauseReason = 'rate-limit'
    // Honour the expected release time when the error carries one (SPEC.md §7.1), clamped to
    // sane bounds: never shorter than the configured pause, never longer than 6 h (a garbled
    // timestamp must not park the queue for a week).
    const parsed = errorText ? parseRetryAfterMs(errorText) : undefined
    const pauseMs =
      parsed === undefined ? this.rateLimitPauseMs : Math.min(Math.max(parsed, this.rateLimitPauseMs), 6 * 3600_000)
    this.store.log(
      jobId,
      'warn',
      `queue paused on a usage-limit signal; auto-resume in ${Math.round(pauseMs / 1000)}s` +
        `${parsed !== undefined ? ' (from the reported reset time)' : ''} (SPEC.md §7.1)`,
    )
    this.setTimeoutFn(() => this.resume(), pauseMs)
  }

  /**
   * Pauses because today's budget is spent, releasing at the next local midnight (SPEC.md §11.3).
   * There is no job to attribute this to — it happens before claiming — so it is announced on the
   * bus's `queue` channel rather than in a job log.
   */
  private pauseForBudget(): void {
    if (this.paused) return
    this.paused = true
    this.pauseReason = 'budget'
    const ms = this.msUntilBudgetReset()
    this.events?.publish({
      kind: 'log',
      log: {
        jobId: 'queue',
        ts: new Date().toISOString(),
        level: 'warn',
        message: `queue paused: daily budget reached; resumes in ${Math.round(ms / 60_000)} min (SPEC.md §11.3)`,
      },
    })
    this.events?.publish({ kind: 'stats' })
    this.setTimeoutFn(() => this.resume(), ms)
  }
}

/** Reconstructs a preprocess result from a manifest a prior attempt already wrote. */
function resultFromManifest(vaultRoot: string, jobDir: string, manifestPath: string): PreprocessResult {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest
  const primaryName = manifest.normalized ?? manifest.original
  const primaryAbs = path.join(jobDir, primaryName)
  return {
    type: manifest.type,
    deferred: manifest.deferred,
    manifestPath,
    primaryArtifact: toPosix(path.relative(vaultRoot, primaryAbs)),
    manifest,
  }
}
