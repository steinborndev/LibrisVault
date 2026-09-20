/**
 * Service entrypoint (SPEC.md §3.1): one process hosting the queue, the watcher, and the
 * HTTP API. `startService` wires them and is returned so tests and the systemd unit (M5)
 * can stop it cleanly; the direct-run block adds signal handling.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, describeConfig, assertBindAllowed, ConfigError, type Config, requireAuth } from './config.js'
import { openDb, defaultDbPath } from './db/index.js'
import { JobStore } from './db/jobs.js'
import { ChatStore } from './db/chat.js'
import { SettingsStore } from './db/settings.js'
import { DomainDismissalStore } from './db/domain-dismissals.js'
import { CommitDismissalStore } from './db/commit-dismissals.js'
import { OaLookupStore } from './db/oa.js'
import {
  bestUntriedCandidate,
  lookupExhausted,
  lookupOpenAccess,
  lookupSaysNothing,
  oaCacheOver,
  recoverOpenAccess,
  type OaPdfReader,
} from './pipeline/preprocess/oa.js'
import { detectTools } from './pipeline/preprocess/index.js'
import { pdfPlugin } from './pipeline/preprocess/plugins/pdf.js'
import { buildProbe } from './pipeline/preprocess/detect.js'
import { documentTextOf } from './pipeline/preprocess/fence.js'
import type { ToolAvailability } from './pipeline/preprocess/types.js'
import { SqliteMaintenanceStateStore } from './db/maintenance-state.js'
import { SqliteAgentRunStore } from './db/agent-runs.js'
import { SAMPLE_LIMIT } from './pipeline/run-duration.js'
import { SqliteAgentStore } from './db/agents.js'
import { SqliteProposalStore } from './db/proposals.js'
import { SqliteShiftStore } from './db/shifts.js'
import { SqliteRecapStore } from './db/recaps.js'
import { SqliteValueEventStore } from './db/value-events.js'
import { SqliteShelfOrderStore } from './db/shelf-order.js'
import { SqliteHandoffStore } from './db/handoffs.js'
import { SqliteLibraryStore } from './db/library.js'
import { LibraryService } from './pipeline/library.js'
import { SqliteUsageSampleStore, SqlitePlanOverrideStore } from './db/usage-samples.js'
import { ReadingListService } from './pipeline/reading-list.js'
import { QuestionsService } from './pipeline/questions.js'
import { PENDING_STATUSES } from './db/proposals.js'
import { refKey } from './pipeline/dedupe.js'
import { SourceIndexBuilder } from './pipeline/sources.js'
import { UsageMonitor, type EndpointResult } from './pipeline/usage-monitor.js'
import { indexWikiPages } from './pipeline/citations.js'
import { FellowService, type GateBlock } from './pipeline/fellows.js'
import { NightShift } from './pipeline/shift.js'
import { judgePairs } from './pipeline/dedupe-judge.js'
import { RecapService, type RecapModel } from './pipeline/recap.js'
import { NotebookWriter } from './pipeline/notebook.js'
import { TelegramDropStore } from './db/telegram-drops.js'
import { IngestQueue } from './pipeline/queue.js'
import { EventBus } from './pipeline/events.js'
import { MaintenanceRunner } from './pipeline/maintenance.js'
import { RunRegistry } from './pipeline/run-registry.js'
import { GraphBuilder } from './pipeline/graph.js'
import { createValidator } from './pipeline/validator.js'
import { budgetStatus } from './pipeline/budget.js'
import { startRetrieveIndexScheduler, isRetrieveProvisioned, type RetrieveIndexScheduler } from './pipeline/retrieve-index.js'
import { Mutex } from './util/mutex.js'
import { checkTransport } from './pipeline/transport.js'
import { buildServer } from './api/server.js'
import { ensureVaultExcludes } from './pipeline/vault-excludes.js'
import { ensureAutoCommitDisabled } from './pipeline/vault-guards.js'
import { reapRunMarkers } from './pipeline/run-marker.js'
import { ValidationStore } from './db/validation.js'
import { VaultReconciler } from './pipeline/reconcile.js'
import { startWatcher, type Watcher } from './pipeline/watcher.js'
import { startVaultWatcher, type VaultWatcher } from './pipeline/vault-watcher.js'
import { startTelegramBot, type TelegramBot } from './telegram/bot.js'
import type { FastifyInstance } from 'fastify'

export interface RunningService {
  readonly app: FastifyInstance
  readonly queue: IngestQueue
  readonly store: JobStore
  readonly watcher: Watcher
  readonly vaultWatcher: VaultWatcher
  /** `null` unless TELEGRAM_BOT_TOKEN is configured (SPEC.md §4.3). */
  readonly telegram: TelegramBot | null
  readonly url: string
  stop(): Promise<void>
}

/**
 * How long shutdown waits for the HTTP server before giving up on it. Long enough for a real
 * upload or an in-flight request to finish, short enough that a systemd `restart` never sits
 * in its own stop timeout.
 */
const HTTP_CLOSE_GRACE_MS = 5_000

/**
 * How an open-access PDF candidate becomes text for the board's own search: the ordinary PDF
 * plugin, in a scratch directory outside the vault. The URL lane does the same inside an ingest;
 * this is the one caller that needs it without a job.
 */
function readPdfCandidate(dir: string, tools: ToolAvailability): OaPdfReader {
  return async (bytes, seq) => {
    const at = path.join(dir, `candidate-${seq}`)
    fs.mkdirSync(at, { recursive: true })
    const file = path.join(at, 'candidate.pdf')
    fs.writeFileSync(file, bytes)
    const res = await pdfPlugin.normalize({ probe: buildProbe(file, 'candidate.pdf'), jobDir: at, tools })
    const text = res.normalizedPath === undefined ? '' : documentTextOf(fs.readFileSync(res.normalizedPath, 'utf8'))
    return { text, notes: res.notes, ocrApplied: res.ocrApplied ?? false, deferred: res.deferred ?? false }
  }
}

export async function startService(config: Config = loadConfig()): Promise<RunningService> {
  // Fail fast, before opening anything, if the bind policy is violated (hard rule 2).
  assertBindAllowed(config.server)

  const transport = checkTransport(config.vaultRoot)
  const pin = transport.pin
  // Before anything can write: derived artifacts and agent scratch stay out of vault history.
  // Startup, not first-index-build, because an agent run can leave scratch long before one.
  // A vault this process cannot write (a read-only demo mount) is reported below, not fatal:
  // the exclude file is hygiene for writers, and such an instance has none.
  const excludes = ensureVaultExcludes(config.vaultRoot)
  // And before anything can COMMIT: the vault plugin's own PostToolUse hook commits after every
  // Write and Edit unless this flag is present, which would take every run's pages out from
  // under the service that wrote them (hard rule 1). Asserted here because until now the flag
  // was written by the dev-instance script and by nothing else, so a fresh clone was unguarded.
  const autoCommitGuard = ensureAutoCommitDisabled(config.vaultRoot)
  // Yesterday's run markers (SPEC.md §12.12): nothing reads one after its job is terminal, and
  // a directory that only grows is a slow leak. Same reaping the vault's lock script does.
  const reapedMarkers = reapRunMarkers(config.vaultRoot)

  const db = openDb(defaultDbPath())
  // The live-update bus is shared: the store publishes job/log events, the queue publishes
  // stats, and the SSE route (via the app) is the sole subscriber (SPEC.md §6.5).
  const events = new EventBus()
  const store = new JobStore(db, events)
  const chat = new ChatStore(db)
  // One commit mutex shared by the ingest queue and the maintenance runner so their commits
  // never interleave (one vault writer at a time, TASKS-M4 §2).
  const commitMutex = new Mutex()
  // Shared so ingest and maintenance can see each other's in-flight runs: a run may only sweep
  // unattributed vault changes into its commit while it is the SOLE writer (finding F4).
  const runRegistry = new RunRegistry()
  // Runtime settings (SPEC.md §6.4): env is the start-time baseline, these are the overrides.
  // `watchFolder`/`maxUploadBytes` are read once here (they bind at startup — changing them is
  // flagged "restart required"); `concurrency`/`gitAutoCommit` apply live via the queue.
  const settings = new SettingsStore(db)
  // Findings counted rather than repeated (A9): base product, not behind AGENTS_ENABLED.
  const validation = new ValidationStore(db)
  const effective = settings.effective(config)
  // One graph builder for the whole service (its per-file cache makes rebuilds cheap): the
  // graph/pages/domains routes serve it, and the post-run validator reads in-degrees off it.
  const graph = new GraphBuilder(config.vaultRoot)
  // One source index too, for the same reason: the Catalog's Source column and the reading
  // list's "in the vault" both read it, and one instance means one cache and one answer.
  const sources = new SourceIndexBuilder(config.vaultRoot)
  // Deterministic post-run checks (validator.ts) shared by ingest and maintenance runs —
  // findings land as warnings in the job/run log the moment a run introduces them.
  const validate = createValidator(config.vaultRoot, graph)
  // One reading list for the whole service: the routes read it, the Fellows write to it, and
  // it recognizes a publication through the queue's dedupe index - by its DOI or arXiv id, and
  // failing that by the url a source page records, which is how a PDF the user fetched by hand
  // closes the entry that asked for it even when the publication names no identifier. Built
  // before the queue because the queue and the maintenance runner sign the entries a run
  // adds; the index lookups are closures and run long after the queue exists.
  const readingList: ReadingListService = new ReadingListService(config.vaultRoot, store, {
    commitMutex,
    autoCommit: () => settings.effective(config).gitAutoCommit,
    byRef: (ref) => queue.dedupeIndex.byRef(ref),
    byUrl: (url) => queue.dedupeIndex.byUrl(url),
    /*
     * And whether a DOCUMENT stands behind the page those two find - the same index the
     * Catalog's Source column reads, so the board and the column answer as one. A research
     * step writes a source page from what it read on the web, and such a page carries the
     * publication's DOI and url: without this the entry that asked for the paper would match
     * the write-up its own request produced and call it arrived.
     */
    held: (page) => sources.build().pages[page] !== undefined,
    /*
     * Whether every copy this DOI has was already fetched and none was full text. The board then
     * says so instead of offering a click that would repeat the same failure; the mark on the
     * entry stays, because a copy does exist at that address (docs/sources/SPEC.md 6.3).
     */
    copyExhausted: (doi) => {
      const row = oaCacheOver(oaLookups).get(doi)
      return row !== undefined && lookupExhausted(row)
    },
  })
  // One lookup table for both readers: the queue's recovery and the nightly sweep (5.5, 6.1).
  const oaLookups = new OaLookupStore(db)
  const queue = new IngestQueue({
    store,
    vaultRoot: config.vaultRoot,
    auth: config.auth,
    events,
    commitMutex,
    concurrency: effective.concurrency,
    runRegistry,
    /*
     * The reading list is a FELLOWS concept (docs/agents/SPEC.md 10.6, TASKS-A6 D1), so an
     * ingest is told about it only when the extension is on. It used to be handed over
     * unconditionally, which meant the prompt asked every ingest to append entries and the
     * attribution pass rewrote the page afterwards - in a base product whose UI does not even
     * register the route that shows the list. Writing a vault page nobody can see is the
     * behaviour change the flag exists to prevent.
     */
    ...(config.agentsEnabled === true ? { reading: readingList } : {}),
    // A provider, not a value: a settings change takes effect on the next commit, no restart.
    autoCommit: () => settings.effective(config).gitAutoCommit,
    doiDedupe: () => settings.effective(config).doiDedupe,
    // A blocked or abstract-thin page with a DOI is worth one look for an open copy (5.1).
    oaRecovery: () => settings.effective(config).oaRecovery,
    oaLookups: oaCacheOver(oaLookups),
    urlDedupe: () => settings.effective(config).urlDedupe,
    // Same pattern for the daily budget — evaluated through the shared budget module so the
    // queue's pause decision and the dashboard's display can never disagree (SPEC.md §11.3).
    budgetExceeded: () => budgetStatus(config, settings.effective(config), store).exceeded,
    validate,
    validationStore: validation,
  })
  // The other half of the F4 rule: the per-run sweep sits out whenever runs overlap, which
  // with concurrency above 1 is most of the time. This picks up what nobody staged, on the
  // edge where the writer count returns to zero and attribution is no longer ambiguous.
  const reconciler = new VaultReconciler({
    vaultRoot: config.vaultRoot,
    commitMutex,
    runRegistry,
    events,
    autoCommit: () => settings.effective(config).gitAutoCommit,
  })
  // DEMO MODE (SPEC.md §12.8): the reconciler is a vault WRITER (it commits unattributed
  // changes) - on a read-only instance it stays detached like every other writer.
  if (!config.demoMode) reconciler.attach()
  // SETUP MODE (config.auth === null): serve the dashboard so the user can enter the
  // credential there, but start nothing that could spawn an agent — the queue never claims
  // and the inbox watcher stays off. A restart after the credential is written picks
  // everything up (queued rows included).
  // DEMO MODE keeps the same passive posture, permanently and regardless of credentials.
  const setupMode = config.auth === null
  const passive = setupMode || config.demoMode
  if (!passive) queue.start()

  // Dropped-sender counters (SPEC.md §9): written by the bot, read by the settings route.
  const telegramDrops = new TelegramDropStore(db)

  // Restart-proof per-kind settle state (SPEC.md §12.7 Stufe b): written by the runner,
  // read by the status endpoint the dashboard's "what's due" head polls.
  const maintenanceState = new SqliteMaintenanceStateStore(db)
  // One row per settled agent run (schema v12) - the run list the Research screen shows,
  // and the only place a failed run leaves a trace once the in-memory registry evicts it.
  const agentRuns = new SqliteAgentRunStore(db)

  // Plan utilization (docs/agents/SPEC.md section 8.3): samples through the SDK inside runs,
  // the raw usage endpoint for ticks (OAuth only; a token without the profile scope makes it
  // refuse, which the monitor reports and falls back from). Fellows only.
  const planSettings = () => {
    const e = settings.effective(config)
    return { researchShareWeekPct: e.researchShareWeekPct, researchShare5hPct: e.researchShare5hPct, reserve5hPct: e.reserve5hPct, reserveWeekPct: e.reserveWeekPct, planWeekUsd: e.planWeekUsd, plan5hUsd: e.plan5hUsd, planName: e.planName, fiveHourOverrideEnabled: e.fiveHourOverrideEnabled, weekOverrideEnabled: e.weekOverrideEnabled }
  }
  // The app logger exists only after buildServer; until then these lines are dropped. Declared
  // here because the usage monitor below wants it too - a plan endpoint that stops answering is
  // the kind of silence that should reach the log.
  const logSink: { sink?: (level: 'info' | 'warn' | 'error', message: string) => void } = {}
  const fellowsLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    logSink.sink?.(level, message)
  }

  const usage =
    config.agentsEnabled === true
      ? new UsageMonitor({
          store: new SqliteUsageSampleStore(db),
          overrides: new SqlitePlanOverrideStore(db),
          runs: agentRuns,
          settings: planSettings,
          log: fellowsLog,
          ...(config.auth?.mode === 'oauth'
            ? {
                fetchEndpoint: async (): Promise<EndpointResult> => {
                  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
                    headers: { authorization: `Bearer ${config.auth!.credential}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
                    signal: AbortSignal.timeout(15_000),
                  })
                  const json: unknown = await res.json().catch(() => null)
                  if (!res.ok) {
                    const message = (json as { error?: { message?: string } } | null)?.error?.message
                    return { ok: false, reason: message ?? `the usage endpoint answered ${res.status}` }
                  }
                  return { ok: true, json }
                },
              }
            : {}),
        })
      : undefined

  const maintenance = new MaintenanceRunner({
    vaultRoot: config.vaultRoot,
    auth: config.auth,
    events,
    commitMutex,
    runRegistry,
    validate,
    validation,
    stateStore: maintenanceState,
    runStore: agentRuns,
    // Same as the queue above: a maintenance run only hears about the list behind the flag.
    ...(config.agentsEnabled === true ? { reading: readingList } : {}),
    ...(usage !== undefined ? { usage } : {}),
  })

  // Fellows (docs/agents/SPEC.md) live behind AGENTS_ENABLED. A demo instance constructs them
  // too, so the Library, the recaps and the pinboard can be READ from a seeded database, but
  // never runs one: the shift and the recap scheduler stay off behind `passive` below, and the
  // request guard refuses every write before a handler runs (SPEC.md §12.8). The notebook
  // writer commits behind the shared mutex and honours gitAutoCommit like a user edit. The app
  // logger exists only after buildServer; until then Fellow log lines are dropped.
  const handoffStore = new SqliteHandoffStore(db)
  const fellows =
    config.agentsEnabled === true
      ? new FellowService({
          // A live five-hour release suspends the runs-per-day quota (SPEC section 8.6).
          quotaSuspended: () => usage?.overrideNow() != null,
          agents: new SqliteAgentStore(db),
          runs: agentRuns,
          proposals: new SqliteProposalStore(db),
          maintenance,
          notebook: new NotebookWriter({
            vaultRoot: config.vaultRoot,
            commitMutex,
            autoCommit: () => settings.effective(config).gitAutoCommit,
          }),
          // The planner names publications it cannot fetch itself (read-only, no web); the
          // service puts them on the reading list, one commit like every other page write.
          reading: readingList,
          // Candidates (docs/agents/SPEC.md section 6.1) come from the vault, the live graph and
          // the finished ingests; the same graph the routes serve, so nothing is built twice.
          candidateSources: { vaultRoot: config.vaultRoot, graph: () => graph.build(), jobs: () => store.list({ status: 'done', limit: 100 }) },
          // The service-wide gate of section 8.4 as far as A1 measures it: the daily budget
          // (the same module the queue and the stats route use) and a rate-limit pause.
          gate: (ctx): GateBlock | null => {
            const budget = budgetStatus(config, settings.effective(config), store)
            if (budget.exceeded) return { code: 'budget', reason: `the daily budget is reached (${budget.spent} of ${budget.limit} ${budget.unit})` }
            const q = queue.stats()
            if (q.paused && q.pauseReason === 'rate-limit') return { code: 'budget', reason: 'the queue is paused on a usage-limit signal' }
            // The plan shares and reserves (section 8.4), priced per run kind and model.
            if (usage) {
              const verdict = usage.gate(ctx)
              if (verdict) return { code: verdict.code, reason: verdict.reason, resetsAt: verdict.resetsAt }
            }
            return null
          },
          ...(usage !== undefined ? { estimatePct: (cost: number, model: Parameters<UsageMonitor['estimatePct']>[1]) => usage.estimatePct(cost, model) } : {}),
          settings: () => {
            const e = settings.effective(config)
            return { window: { start: e.nightWindowStart, end: e.nightWindowEnd }, defaultModel: e.researchModelDefault }
          },
          values: new SqliteValueEventStore(db),
          shelfOrder: new SqliteShelfOrderStore(db),
          handoffs: handoffStore,
          log: fellowsLog,
        })
      : undefined
  // The night shift (section 4.2) ticks once a minute and runs inside the window; it never
  // starts in setup or demo mode, where nothing may spawn an agent.
  const shiftStore = fellows !== undefined ? new SqliteShiftStore(db) : undefined
  const shift =
    fellows !== undefined && shiftStore !== undefined
      ? new NightShift({
          fellows,
          shifts: shiftStore,
          window: () => {
            const e = settings.effective(config)
            return { start: e.nightWindowStart, end: e.nightWindowEnd }
          },
          // The plan windows before a round (section 8.5), cached by the monitor.
          ...(usage !== undefined ? { beforeRound: () => usage.refresh() } : {}),
          // Existing synthesis pages, for the dedupe notes (section 6.6).
          synthesisTitles: () =>
            [...indexWikiPages(config.vaultRoot)]
              .filter(([, rel]) => rel.startsWith('wiki/questions/'))
              .map(([, rel]) => rel.slice('wiki/questions/'.length).replace(/\.md$/, '')),
          /*
           * The duplicate judge (section 6.6), off unless the setting says otherwise: it costs
           * a read-only run a night, and the two lexical passes work without it. Read per call,
           * so turning it off takes effect on the next shift rather than the next restart.
           */
          judge: async (pairs) => {
            if (!settings.effective(config).dedupeJudgeEnabled) return pairs.map(() => ({ score: Number.NaN }))
            return judgePairs([...pairs], { vaultRoot: config.vaultRoot, auth: requireAuth(config) })
          },
          /*
           * Before phase 0 (docs/sources/SPEC.md section 6.1): the entries the Fellows could not
           * read are checked for a legal open copy and marked. Twenty lookups a night, no
           * download and no ingest - the board offers that in the morning, the user decides.
           * Off when the setting that governs the whole mechanism is off.
           */
          openCopies: async (today) => {
            if (!settings.effective(config).oaRecovery) return { checked: 0, found: 0 }
            const cache = oaCacheOver(oaLookups)
            const { checked, found } = await readingList.markOpenCopies({
              today,
              // Only a round that named no copy at all stops the sweep asking; a round that
              // named one is read from the row and marked without touching an API.
              answeredRecently: (doi) => {
                const row = cache.get(doi)
                return row !== undefined && lookupSaysNothing(row, new Date())
              },
              lookup: async (doi) => {
                const round = await lookupOpenAccess(doi, { jobDir: config.vaultRoot, tools: await detectTools(), cache })
                // Only a copy nobody has fetched yet: one an ingest already threw away as a
                // record page is not somewhere to send the user.
                const best = bestUntriedCandidate(round)
                // The sweep ASKS; it does not open the copy, so nothing measured is written.
                return best === undefined ? undefined : { url: best.url, version: best.version, at: today, chars: null }
              },
            })
            return { checked, found: found.length }
          },
          // Phase 0: the ingests held for tonight run through the ordinary queue, first.
          ingests: {
            release: () => queue.releaseHeld('night'),
            onIdle: () => queue.onIdle(),
            statusOf: (id) => store.get(id)?.status,
          },
          log: fellowsLog,
        })
      : undefined
  // The daily recap (section 9): built at the recap time, delivered to the dashboard, the
  // vault and, once the bot is up, Telegram (late-bound: the bot starts after listen).
  const telegramSink: { send?: (messages: readonly string[]) => Promise<number[]> } = {}
  const recaps =
    fellows !== undefined && shiftStore !== undefined
      ? new RecapService({
          vaultRoot: config.vaultRoot,
          fellows,
          runs: agentRuns,
          recaps: new SqliteRecapStore<RecapModel>(db),
          shifts: shiftStore,
          handoffs: handoffStore,
          ...(usage !== undefined ? { plan: () => usage.status({ estCostUsd: 2, model: settings.effective(config).researchModelDefault }) } : {}),
          maintenance,
          jobs: store,
          reading: readingList,
          commitMutex,
          autoCommit: () => settings.effective(config).gitAutoCommit,
          settings: () => {
            const e = settings.effective(config)
            return { window: { start: e.nightWindowStart, end: e.nightWindowEnd }, recapTime: e.recapTime }
          },
          telegram: () => telegramSink.send,
          log: fellowsLog,
        })
      : undefined

  // The Library screen's scene (section 10): a renderer's snapshot over the graph, the queue,
  // the run registry and the Fellows, plus the user's wings and shelf placement.
  /*
   * The pinboard of open questions (prototype 2026-09-17): every page's open questions, the
   * archive as a strike-through on the page, and a veto for the proposal a Fellow had planned
   * from an archived one. With the Fellows, like the room it hangs in.
   */
  const questions =
    fellows !== undefined
      ? new QuestionsService({
          vaultRoot: config.vaultRoot,
          graph: () => graph.build(),
          notebooks: () =>
            fellows
              .list()
              .filter((f) => f.agent.state !== 'retired')
              .map((f) => ({ path: f.agent.notebookPath, domain: f.agent.homeDomain })),
          proposals: () => new SqliteProposalStore(db).list({ status: PENDING_STATUSES, limit: 200 }),
          fellowName: (id) => fellows.list().find((f) => f.agent.id === id)?.agent.name ?? 'a Fellow',
          runs: () => maintenance.listRuns(),
          commitMutex,
          autoCommit: () => settings.effective(config).gitAutoCommit,
          veto: async (id) => {
            await fellows.decide(id, { status: 'vetoed', via: 'dashboard', note: 'the question was archived on the pinboard' })
          },
        })
      : undefined
  const library =
    fellows !== undefined
      ? new LibraryService({
          vaultRoot: config.vaultRoot,
          store: new SqliteLibraryStore(db),
          graph: () => graph.build(),
          // Tonight's released ingests first, whatever their status: they stay in the queue
          // the Library draws until their commit is made (v26), and the scene keeps one row per id.
          jobs: () => [...store.nightReleased(), ...store.list({ status: 'queued', limit: 50 }), ...store.list({ status: 'preprocessing', limit: 50 }), ...store.list({ status: 'ingesting', limit: 50 })],
          runs: () => maintenance.listRuns(),
          fellows: () => fellows.list(),
          runHistory: (kind) => agentRuns.list({ kind, limit: SAMPLE_LIMIT }),
          jobHistory: () => store.list({ status: 'done', limit: 200 }),
          window: () => {
            const e = settings.effective(config)
            return { start: e.nightWindowStart, end: e.nightWindowEnd }
          },
          concurrency: () => queue.stats().concurrency,
        })
      : undefined

  // The start-time-bound settings folded into the config the watcher and HTTP server see. The
  // bind (host/port) is deliberately NOT overridable — it stays whatever assertBindAllowed
  // approved above (hard rule 2).
  const effectiveConfig: Config = {
    ...config,
    server: {
      ...config.server,
      watchFolder: effective.watchFolder,
      maxUploadBytes: effective.maxUploadBytes,
    },
  }

  const watcher: Watcher = passive
    ? { close: async () => {} }
    : startWatcher({
        queue,
        config: effectiveConfig,
        ...(config.server.watchPolling !== undefined ? { usePolling: config.server.watchPolling } : {}),
      })

  // Live-graph signal (SPEC.md §12.4): wiki file changes → debounced `vault` SSE event.
  const vaultWatcher = startVaultWatcher({ vaultRoot: config.vaultRoot, events })

  // Retrieval-index freshness (SPEC.md §12.6): finished ingests reset a quiet window; when it
  // elapses, ONE deterministic rebuild runs. Inert until the index is provisioned — checked at
  // fire time, so provisioning it (first manual rebuild) needs no restart.
  const retrieveScheduler: RetrieveIndexScheduler = config.demoMode
    ? { close: () => {} }
    : startRetrieveIndexScheduler({
        events,
        isProvisioned: () => isRetrieveProvisioned(config.vaultRoot),
        start: () => void maintenance.startRetrieveIndex(),
      })

  const app = await buildServer({
    config: effectiveConfig,
    store,
    chat,
    queue,
    events,
    maintenance,
    settings,
    validation,
    validate,
    // User page edits/deletes commit behind the same mutex as ingest + maintenance, and
    // honour the live gitAutoCommit setting exactly like the queue does.
    commitMutex,
    autoCommit: () => settings.effective(config).gitAutoCommit,
    // Persistent, so a rejected domain candidate stays rejected across restarts.
    domainDismissals: new DomainDismissalStore(db),
    commitDismissals: new CommitDismissalStore(db),
    maintenanceState,
    agentRuns,
    telegramDrops,
    graph,
    sources,
    ...(fellows !== undefined ? { fellows } : {}),
    ...(shift !== undefined ? { shift } : {}),
    ...(recaps !== undefined ? { recaps } : {}),
    ...(library !== undefined ? { library } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(config.agentsEnabled === true ? { reading: readingList } : {}),
    ...(questions !== undefined ? { questions } : {}),
    /*
     * "Find open-access" on the board (docs/sources/SPEC.md 6.3): the same recovery an ingest
     * runs, in a scratch directory outside the vault and without writing a page - so a find is
     * VERIFIED (fetched, extracted, measured at the two bars) rather than merely registered
     * somewhere. The accepted copy lands in `oa_lookups`, so the ingest the user starts
     * afterwards goes straight to it.
     */
    findOpenAccess: async (entry) => {
      if (!settings.effective(config).oaRecovery) return { found: false, reason: 'open-access recovery is switched off in the System tab' }
      const ref = refKey(entry.ref) ?? refKey(entry.url)
      if (ref === undefined) return { found: false, reason: 'this entry names no DOI, arXiv id or PMC id' }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-find-'))
      try {
        const tools = await detectTools()
        const out = await recoverOpenAccess({
          ...(ref.startsWith('doi:') ? { doi: ref.slice('doi:'.length) } : {}),
          kind: 'rescued',
          haveChars: 0,
          deps: {
            jobDir: dir,
            tools,
            cache: oaCacheOver(oaLookups),
            readPdf: readPdfCandidate(dir, tools),
            // An arXiv or a PMC id IS the copy; there is nothing to ask a resolver about.
            ...(ref.startsWith('arxiv:')
              ? { hint: { url: `https://arxiv.org/pdf/${ref.slice('arxiv:'.length)}`, version: 'submittedVersion' } }
              : ref.startsWith('pmc:')
                ? { hint: { url: `https://pmc.ncbi.nlm.nih.gov/articles/${ref.slice('pmc:'.length)}/` } }
                : {}),
          },
        })
        if (out.recovery === undefined) {
          const last = out.notes[out.notes.length - 1]
          return { found: false, reason: last ?? 'no open copy was found' }
        }
        return {
          found: true,
          url: out.recovery.disclosure.url,
          version: out.recovery.disclosure.version,
          chars: out.recovery.text.trim().length,
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  })
  await app.listen({ host: config.server.host, port: config.server.port })
  const url = `http://${config.server.host}:${config.server.port}`
  logSink.sink = (level, message) => app.log[level](message)
  if (shift !== undefined && !passive) shift.start()
  if (recaps !== undefined && !passive) recaps.start()

  // Log what the service actually runs with (overrides applied), not the bare baseline.
  app.log.info(
    { ...describeConfig(effectiveConfig), transportPin: pin, transport: transport.pinned, vaultExcludes: excludes, vaultAutoCommitGuard: autoCommitGuard, reapedRunMarkers: reapedMarkers },
    'vault-service started',
  )
  if (excludes === 'unwritable') {
    app.log.warn('the vault is not writable by this process: .git/info/exclude was left as it is (expected on a read-only instance)')
  }
  // The pin decides how a run writes a page, and therefore whether this service can see what
  // it wrote (see transport.ts). Detected hang-proof; reported, never overwritten.
  if (transport.warning !== null) app.log.warn(transport.warning)
  if (autoCommitGuard === 'created') {
    app.log.warn(
      'the vault was auto-committing its own writes: .vault-meta/auto-commit.disabled created, this service now owns every commit',
    )
  } else if (autoCommitGuard === 'unwritable') {
    app.log.warn(
      'the vault plugin may auto-commit: .vault-meta/auto-commit.disabled is missing and cannot be written (expected on a read-only instance)',
    )
  }
  if (config.demoMode) {
    app.log.info(
      'DEMO MODE: read-only instance. Ingestion, research, maintenance, page edits and Telegram are disabled' +
        (fellows !== undefined ? '; the Fellows are shown from the database and never run.' : '.'),
    )
  } else if (setupMode) {
    app.log.warn(
      `SETUP MODE: no Anthropic credential configured — ingestion, watcher, query and maintenance ` +
        `are disabled. Open ${url} and add the credential under System → Integrations.`,
    )
  }

  // Telegram channel (SPEC.md §4.3), symmetric to the watcher but ALSO alive in setup mode:
  // /status still answers there (reporting setup mode) while ingests are refused — the bot
  // gates them itself. Started after listen so its log lines go through the app logger.
  const telegram: TelegramBot | null = config.telegram && !config.demoMode
    ? startTelegramBot({
        telegram: config.telegram,
        queue,
        store,
        setupMode,
        // Completion notifications ride the same bus as the dashboard's SSE stream.
        events,
        drops: telegramDrops,
        // Same provider pattern (and the same budget module) as the queue and the stats
        // route, so all three always agree (SPEC.md §11.3).
        budget: () => budgetStatus(config, settings.effective(config), store),
        // `/research <topic>` runs through the maintenance runner (web-egress research profile),
        // not the ingest queue; the callback reports the settled run back to the chat.
        startResearch: (topic, onSettled) => {
          const run = maintenance.startResearch(topic)
          maintenance.onRunSettled(run.id, onSettled)
          return run
        },
        // Recap answers in the code grammar are applied instead of ingested (section 9.3).
        ...(recaps !== undefined ? { recapAnswer: (text: string) => recaps.answerText(text) } : {}),
        log: (level, message) => app.log[level](`[telegram] ${message}`),
      })
    : null
  if (telegram) telegramSink.send = (messages) => telegram.broadcast(messages)

  const stop = async (): Promise<void> => {
    // Bot first: no new updates may reach the queue while it is draining/stopping.
    if (telegram) await telegram.stop()
    shift?.stop()
    recaps?.stop()
    await watcher.close()
    await vaultWatcher.close()
    retrieveScheduler.close()
    queue.stop()
    /*
     * `app.close()` resolves only once every connection has ended, and a route that holds a
     * connection open forever therefore holds the shutdown open forever - which is exactly
     * what the SSE stream did until it learned to end itself in a `preClose` hook. That fix
     * is the mechanism; this is the net under it, so the next open-ended route costs a
     * warning line instead of a service that has to be killed. `db.close()` still runs, and
     * whatever is left goes with the process.
     */
    const closed = await Promise.race([
      app.close().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), HTTP_CLOSE_GRACE_MS).unref()),
    ])
    if (!closed) {
      app.log.warn(`http server did not close within ${HTTP_CLOSE_GRACE_MS} ms - shutting down anyway`)
    }
    db.close()
  }

  return { app, queue, store, watcher, vaultWatcher, telegram, url, stop }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  startService()
    .then((service) => {
      const shutdown = (signal: string): void => {
        service.app.log.info(`received ${signal}, shutting down`)
        service.stop().then(
          () => process.exit(0),
          (err: unknown) => {
            console.error('error during shutdown:', err)
            process.exit(1)
          },
        )
      }
      process.on('SIGINT', () => shutdown('SIGINT'))
      process.on('SIGTERM', () => shutdown('SIGTERM'))
    })
    .catch((err: unknown) => {
      if (err instanceof ConfigError) {
        console.error(`configuration error:\n${err.message}`)
        process.exit(2)
      }
      console.error('failed to start vault-service:', err)
      process.exit(1)
    })
}
