/**
 * Thin typed fetch client for the vault-service API. All endpoints are same-origin under
 * `/api/v1` (the SPA is served by the same Fastify process, and the Vite dev proxy forwards
 * `/api` in dev), so no base URL or CORS handling is needed.
 */

import type {
  Job,
  JobDetail,
  Stats,
  Health,
  JobStatus,
  Session,
  ChatMessage,
  QueryResponse,
  Citation,
  MaintenanceRun,
  MaintenanceRunsResponse,
  MaintenanceStateResponse,
  AgentRunHistoryResponse,
  RevertResponse,
  RetrieveIndexStatus,
  RepairTask,
  TagFixAction,
  ResearchProfilesResponse,
  DomainsResponse,
  CandidatesResponse,
  SettingsResponse,
  SettingsPatch,
  CredentialResponse,
  TelegramSettingsResponse,
  TelegramStatusResponse,
  RecapsResponse,
  RecapRow,
  RecapStatus,
  RecapAnswer,
  RecapAnswersResponse,
  LibraryScene,
  Wing,
  Placement,
  AgentsResponse,
  FellowRecord,
  FellowCard,
  ProposalRecord,
  SpawnBody,
  AgentPatchBody,
  PlanStatus,
  ReadingItem,
  QuestionItem,
  PagePreview,
  PageFull,
  VaultGraph,
  SourceIndex,
  PageWriteResult,
  PageDeleteResult,
} from './types.ts'

const BASE = '/api/v1'

/**
 * A failed request, with the machine-readable reason where the endpoint sends one. The
 * message stays what it always was; `code` lets a screen tell one refusal from another -
 * a used-up daily quota (which the user may override) from a share or reserve (which
 * protects the user's own capacity and may not).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * The code a hosted read-only instance answers every write with (SPEC.md §12.8). The guard
 * sits in front of every route, so any screen's mutation can run into it; the shell shows one
 * notice for all of them rather than each screen growing its own.
 */
export const DEMO_READ_ONLY = 'demo_read_only'

const demoRefusalListeners = new Set<() => void>()

/** Hear about writes a read-only demo refused; returns the unsubscribe. */
export function onDemoRefusal(listener: () => void): () => void {
  demoRefusalListeners.add(listener)
  return () => {
    demoRefusalListeners.delete(listener)
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = ''
    let code: string | undefined
    try {
      const body = (await res.json()) as { error?: string; message?: string; issues?: string[]; code?: string }
      detail = body.error ? `: ${body.error}` : ''
      code = body.code
      // The demo guard names its reason in `error` and explains it in `message`: the message
      // is what a person should read, the reason is what the shell reacts to.
      if (res.status === 403 && body.error === DEMO_READ_ONLY) {
        code = DEMO_READ_ONLY
        if (body.message) detail = `: ${body.message}`
        for (const listener of demoRefusalListeners) listener()
      }
      // Validation endpoints (e.g. PUT /settings) return per-field issues - surfacing them
      // turns "400 Bad Request" into something the user can actually act on.
      if (Array.isArray(body.issues) && body.issues.length > 0) detail += ` (${body.issues.join('; ')})`
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(`${res.status} ${res.statusText}${detail}`, res.status, code)
  }
  return res.json() as Promise<T>
}

export interface EnqueueResult {
  batchId?: string
  jobs: Array<{ id: string; name: string; status: JobStatus; duplicateOf?: string }>
}

/** `?when=night` holds a job for the night shift (docs/tasks/TASKS-SWEEP-2026-09.md, chunk 6). */
const whenQs = (when?: 'night'): string => (when === undefined ? '' : `?when=${when}`)

export const api = {
  health: (): Promise<Health> => fetch(`${BASE}/health`).then(json<Health>),

  stats: (): Promise<Stats> => fetch(`${BASE}/stats`).then(json<Stats>),

  jobs: (params?: { status?: JobStatus; limit?: number }): Promise<{ jobs: Job[] }> => {
    const q = new URLSearchParams()
    if (params?.status) q.set('status', params.status)
    if (params?.limit) q.set('limit', String(params.limit))
    const qs = q.toString()
    return fetch(`${BASE}/jobs${qs ? `?${qs}` : ''}`).then(json<{ jobs: Job[] }>)
  },

  job: (id: string): Promise<JobDetail> => fetch(`${BASE}/jobs/${id}`).then(json<JobDetail>),

  /**
   * Upload files (multipart). Multiple files → one batch (the server groups them). `when:
   * 'night'` holds the jobs for the night shift, which runs them ahead of the Fellows.
   */
  uploadFiles: (files: File[], when?: 'night'): Promise<EnqueueResult> => {
    const form = new FormData()
    for (const f of files) form.append('files', f, f.name)
    return fetch(`${BASE}/jobs${whenQs(when)}`, { method: 'POST', body: form }).then(json<EnqueueResult>)
  },

  /** Submit a pasted URL. */
  submitUrl: (url: string, when?: 'night'): Promise<EnqueueResult> =>
    fetch(`${BASE}/jobs${whenQs(when)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then(json<EnqueueResult>),

  /** Submit pasted text as a note. */
  submitText: (text: string, title?: string, when?: 'night'): Promise<EnqueueResult> =>
    fetch(`${BASE}/jobs${whenQs(when)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(title ? { text, title } : { text }),
    }).then(json<EnqueueResult>),

  retry: (id: string): Promise<{ job: Job }> =>
    fetch(`${BASE}/jobs/${id}/retry`, { method: 'POST' }).then(json<{ job: Job }>),

  cancel: (id: string): Promise<{ job: Job }> =>
    fetch(`${BASE}/jobs/${id}`, { method: 'DELETE' }).then(json<{ job: Job }>),

  /** Removes one settled job from the history (the same verb cancels a queued one). */
  deleteJob: (id: string): Promise<{ deleted: boolean }> =>
    fetch(`${BASE}/jobs/${id}`, { method: 'DELETE' }).then(json<{ deleted: boolean }>),

  /** Removes one settled agent run from the history. */
  deleteRun: (id: string): Promise<{ deleted: boolean }> =>
    fetch(`${BASE}/maintenance/history/${id}`, { method: 'DELETE' }).then(json<{ deleted: boolean }>),

  /** Takes a commit off the Activity stream; the vault keeps it. */
  dismissCommit: (hash: string): Promise<{ ok: boolean }> =>
    fetch(`${BASE}/stats/commits/${encodeURIComponent(hash)}/dismiss`, { method: 'POST' }).then(json<{ ok: boolean }>),

  /** Clear finished jobs from history. With `status`, only that status; otherwise all at-rest jobs. */
  clearHistory: (status?: JobStatus): Promise<{ removed: number }> => {
    const qs = status ? `?status=${status}` : ''
    return fetch(`${BASE}/jobs${qs}`, { method: 'DELETE' }).then(json<{ removed: number }>)
  },

  // ---- Query / Chat ----

  query: (question: string, sessionId?: string, requestId?: string): Promise<QueryResponse> =>
    fetch(`${BASE}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question,
        ...(sessionId ? { sessionId } : {}),
        // Streamed deltas echo this id, so a FIRST question (no session id yet) can render live.
        ...(requestId ? { requestId } : {}),
      }),
    }).then(json<QueryResponse>),

  sessions: (): Promise<{ sessions: Session[] }> => fetch(`${BASE}/sessions`).then(json<{ sessions: Session[] }>),

  session: (id: string): Promise<{ session: Session; messages: ChatMessage[] }> =>
    fetch(`${BASE}/sessions/${id}`).then(json<{ session: Session; messages: ChatMessage[] }>),

  createSession: (title?: string): Promise<{ session: Session }> =>
    fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(title ? { title } : {}),
    }).then(json<{ session: Session }>),

  renameSession: (id: string, title: string): Promise<{ session: Session }> =>
    fetch(`${BASE}/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then(json<{ session: Session }>),

  deleteSession: (id: string): Promise<{ ok: boolean }> =>
    fetch(`${BASE}/sessions/${id}`, { method: 'DELETE' }).then(json<{ ok: boolean }>),

  /** Raw markdown of one wiki page, for the Chat tab's inline citation preview. */
  page: (path: string): Promise<PagePreview> =>
    fetch(`${BASE}/pages?path=${encodeURIComponent(path)}`).then(json<PagePreview>),

  /** Full page content + metadata for the vault viewer (SPEC.md §12.4). */
  pageFull: (path: string): Promise<PageFull> =>
    fetch(`${BASE}/pages?path=${encodeURIComponent(path)}&full=1`).then(json<PageFull>),

  /** The vault's wikilink graph (server-side cached; cheap to refetch). */
  graph: (): Promise<VaultGraph> => fetch(`${BASE}/graph`).then(json<VaultGraph>),

  /** Where each page came from - the Library's source column joins this onto the graph. */
  sources: (): Promise<SourceIndex> => fetch(`${BASE}/sources`).then(json<SourceIndex>),

  /**
   * User edit of one page (SPEC.md §12.4). `baseMtime` is the optimistic lock: the server
   * 409s if the page changed since it was loaded, instead of silently overwriting.
   */
  savePage: (path: string, markdown: string, baseMtime?: string): Promise<PageWriteResult> =>
    fetch(`${BASE}/pages`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, markdown, ...(baseMtime ? { baseMtime } : {}) }),
    }).then(json<PageWriteResult>),

  /** User delete of one page; the response's staleLinks feeds the lint-guidance banner. */
  deletePage: (path: string): Promise<PageDeleteResult> =>
    fetch(`${BASE}/pages?path=${encodeURIComponent(path)}`, { method: 'DELETE' }).then(json<PageDeleteResult>),

  /** "Session in Vault sichern" - starts an async write-enabled run; poll it like a maintenance run. */
  saveSession: (id: string): Promise<MaintenanceRun> =>
    fetch(`${BASE}/sessions/${id}/save`, { method: 'POST' }).then(json<MaintenanceRun>),

  // ---- Maintenance (async: POST starts a run, GET polls its result) ----

  lint: (): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/lint`, { method: 'POST' }).then(json<MaintenanceRun>),

  /** Fixes the newest lint report's SAFE findings (409 when no report exists). */
  lintFix: (): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/lint-fix`, { method: 'POST' }).then(json<MaintenanceRun>),

  hotCache: (): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/hot-cache`, { method: 'POST' }).then(json<MaintenanceRun>),

  /** Joins wikilinks a line wrap broke. Deterministic: no agent, no cost. */
  rejoinLinks: (dry = false): Promise<{ pages: string[]; fixed: number; left: number; commit: string | null }> =>
    fetch(`${BASE}/maintenance/rejoin-links${dry ? '?dry=1' : ''}`, { method: 'POST' }).then(
      json<{ pages: string[]; fixed: number; left: number; commit: string | null }>,
    ),

  /** Resolve open graph gaps by unlinking them (one bounded run; titles must be live gaps). */
  cleanupGaps: (titles: readonly string[]): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/cleanup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'gap', pages: titles }),
    }).then(json<MaintenanceRun>),

  /** Reference cleanup after deletions: a bounded agent run over the named pages' dangling refs. */
  cleanupReferences: (pages: readonly string[]): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/cleanup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pages }),
    }).then(json<MaintenanceRun>),

  /** Tag repair: a bounded agent run over user-selected drop/merge tag actions. */
  tagFix: (actions: readonly TagFixAction[]): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/tag-fix`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actions }),
    }).then(json<MaintenanceRun>),

  /** Graph repair: a bounded agent run over user-selected connectivity problems. */
  graphRepair: (tasks: readonly RepairTask[]): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks }),
    }).then(json<MaintenanceRun>),

  /** The closed research-lens list for the composer's profile picker ("Achse A"). */
  researchProfiles: (): Promise<ResearchProfilesResponse> =>
    fetch(`${BASE}/maintenance/research/profiles`).then(json<ResearchProfilesResponse>),

  research: (topic: string, profileKey?: string): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/research`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(profileKey ? { topic, profileKey } : { topic }),
    }).then(json<MaintenanceRun>),

  domainBackfill: (): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/domain-backfill`, { method: 'POST' }).then(json<MaintenanceRun>),

  /** Undo one ingest: reverts its vault commit as a new commit (SPEC §9). */
  revertJob: (id: string): Promise<RevertResponse> =>
    fetch(`${BASE}/jobs/${id}/revert`, { method: 'POST' }).then(json<RevertResponse>),

  maintenanceRun: (id: string): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/runs/${id}`).then(json<MaintenanceRun>),

  /**
   * Every tracked maintenance run, newest first. This is what makes an agent run visible
   * from OUTSIDE the screen that started it: the run state used to live only in the
   * starting component's hook, so a research run was invisible on Home and gone after a
   * reload. Home's in-flight list and the sidebar badge read this.
   */
  maintenanceRuns: (): Promise<MaintenanceRunsResponse> =>
    fetch(`${BASE}/maintenance/runs`).then(json<MaintenanceRunsResponse>),

  /** Per-kind last-settle state (SPEC §12.7 Stufe b) - feeds the status head's "last run" facts. */
  /** The persistent run log (schema v12). `kind` narrows it, e.g. to research runs. */
  maintenanceHistory: (params: { kind?: string; limit?: number } = {}): Promise<AgentRunHistoryResponse> => {
    const q = new URLSearchParams()
    if (params.kind !== undefined) q.set('kind', params.kind)
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    const suffix = q.toString() === '' ? '' : `?${q.toString()}`
    return fetch(`${BASE}/maintenance/history${suffix}`).then(json<AgentRunHistoryResponse>)
  },

  maintenanceState: (): Promise<MaintenanceStateResponse> =>
    fetch(`${BASE}/maintenance/state`).then(json<MaintenanceStateResponse>),

  /** Hybrid-retrieval index status (SPEC §12.6): provisioned?, chunk count, index age. */
  retrieveIndexStatus: (): Promise<RetrieveIndexStatus> =>
    fetch(`${BASE}/maintenance/retrieve-index`).then(json<RetrieveIndexStatus>),

  /** Rebuild (or first-time provision) the retrieval index - deterministic, no credential. */
  retrieveIndex: (): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/retrieve-index`, { method: 'POST' }).then(json<MaintenanceRun>),

  domains: (): Promise<DomainsResponse> => fetch(`${BASE}/domains`).then(json<DomainsResponse>),

  // ---- Domain governance (SPEC §12.4 Stufe 3) ----

  domainCandidates: (): Promise<CandidatesResponse> =>
    fetch(`${BASE}/domains/candidates`).then(json<CandidatesResponse>),

  domainReview: (): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/domain-review`, { method: 'POST' }).then(json<MaintenanceRun>),

  createDomain: (body: {
    key: string
    description: string
    tags: string[]
    dismissCandidate?: string
  }): Promise<{ ok: boolean; key: string; committed: boolean }> =>
    fetch(`${BASE}/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<{ ok: boolean; key: string; committed: boolean }>),

  dismissCandidate: (key: string): Promise<{ ok: boolean }> =>
    fetch(`${BASE}/domains/candidates/${encodeURIComponent(key)}/dismiss`, { method: 'POST' }).then(
      json<{ ok: boolean }>,
    ),

  restoreCandidate: (key: string): Promise<{ ok: boolean }> =>
    fetch(`${BASE}/domains/candidates/${encodeURIComponent(key)}/dismiss`, { method: 'DELETE' }).then(
      json<{ ok: boolean }>,
    ),

  // ---- Settings ----

  settings: (): Promise<SettingsResponse> => fetch(`${BASE}/settings`).then(json<SettingsResponse>),

  saveSettings: (patch: SettingsPatch): Promise<SettingsResponse> =>
    fetch(`${BASE}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(json<SettingsResponse>),

  /** First-run onboarding / key replacement. The value goes out once and never comes back. */
  setCredential: (body: { kind: 'oauth' | 'api-key'; value: string }): Promise<CredentialResponse> =>
    fetch(`${BASE}/settings/credential`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<CredentialResponse>),

  /** Telegram bot on/off (SPEC.md §4.3). The token goes out once and never comes back. */
  setTelegram: (body: { botToken: string; allowedUserIds: string }): Promise<TelegramSettingsResponse> =>
    fetch(`${BASE}/settings/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<TelegramSettingsResponse>),

  disableTelegram: (): Promise<TelegramSettingsResponse> =>
    fetch(`${BASE}/settings/telegram`, { method: 'DELETE' }).then(json<TelegramSettingsResponse>),

  /** Dropped-sender counters for the Maintenance card. Ids only, never content or token. */
  // ---- Fellows and recaps (present only with AGENTS_ENABLED; `health.fellows` says so) ----
  recaps: (): Promise<RecapsResponse> => fetch(`${BASE}/recaps`).then(json<RecapsResponse>),

  recap: (date: string): Promise<{ recap: RecapRow }> =>
    fetch(`${BASE}/recaps/${encodeURIComponent(date)}`).then(json<{ recap: RecapRow }>),

  buildRecap: (body: { force?: boolean } = {}): Promise<{ started: boolean; status: RecapStatus }> =>
    fetch(`${BASE}/recaps/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<{ started: boolean; status: RecapStatus }>),

  answerRecap: (date: string, body: { answers?: RecapAnswer[]; text?: string }): Promise<RecapAnswersResponse> =>
    fetch(`${BASE}/recaps/${encodeURIComponent(date)}/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<RecapAnswersResponse>),

  /** Fire and forget: the value signal (section 9.6). Never throws; a 404 without the extension is fine. */
  valueEvent: (body: { kind: 'page_open' | 'recap_link'; page?: string; agentId?: string }): void => {
    void fetch(`${BASE}/value-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => undefined)
  },

  // ---- The Library screen and the Fellows (behind AGENTS_ENABLED) ----
  libraryScene: (): Promise<LibraryScene> => fetch(`${BASE}/library/scene`).then(json<LibraryScene>),

  moveShelf: (body: { domain: string; room: string; slot?: number }): Promise<{ placements: Placement[] }> =>
    fetch(`${BASE}/library/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json<{ placements: Placement[] }>),

  wings: (): Promise<{ wings: Wing[] }> => fetch(`${BASE}/wings`).then(json<{ wings: Wing[] }>),

  createWing: (name?: string): Promise<{ wing: Wing }> =>
    fetch(`${BASE}/wings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(name !== undefined ? { name } : {}) }).then(json<{ wing: Wing }>),

  renameWing: (id: string, name: string): Promise<{ wing: Wing }> =>
    fetch(`${BASE}/wings/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).then(json<{ wing: Wing }>),

  /** Moves one row's gap in one wing: `wall` is the doorway, `mid` the aisle. */
  moveAisle: (id: string, row: 'wall' | 'mid', at: number): Promise<{ wing: Wing }> =>
    fetch(`${BASE}/wings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row === 'wall' ? { wallAisle: at } : { midAisle: at }),
    }).then(json<{ wing: Wing }>),

  reorderWings: (ids: string[]): Promise<{ wings: Wing[] }> =>
    fetch(`${BASE}/wings/order`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) }).then(json<{ wings: Wing[] }>),

  deleteWing: (id: string): Promise<void> =>
    fetch(`${BASE}/wings/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(async (r) => {
      // No body on success; a refusal goes through the same reader as every other call, so a
      // read-only demo's answer is recognised here too.
      if (!r.ok) await json<never>(r)
    }),

  agents: (): Promise<AgentsResponse> => fetch(`${BASE}/agents`).then(json<AgentsResponse>),

  /** The order the night walks the shelves. One serial queue, so this is a setting, not a view. */
  saveShelfOrder: (domains: readonly string[]): Promise<{ shelfOrder: string[] }> =>
    fetch(`${BASE}/agents/shelf-order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domains }),
    }).then(json<{ shelfOrder: string[] }>),

  usagePlan: (): Promise<PlanStatus> => fetch(`${BASE}/usage/plan`).then(json<PlanStatus>),

  /**
   * Releases the rest of the current 5-hour window to the Fellows, until that window resets
   * (SPEC section 8.6). POST on purpose: it hands out budget, and a GET would be reachable
   * from anything that can only fetch.
   */
  releaseFiveHour: (): Promise<{ override: { pct: number; expiresAt: string } }> =>
    fetch(`${BASE}/usage/override`, { method: 'POST' }).then(json<{ override: { pct: number; expiresAt: string } }>),

  withdrawFiveHour: (): Promise<{ override: unknown }> => fetch(`${BASE}/usage/override`, { method: 'DELETE' }).then(json<{ override: unknown }>),

  /**
   * Releases the WEEK's two bounds for one night (SPEC section 8.6a). The week is the bound
   * every other grant survives, so this one ends with the night rather than with the week.
   */
  releaseWeek: (): Promise<{ override: { pct: number; expiresAt: string } }> =>
    fetch(`${BASE}/usage/override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ window: 'seven_day' }),
    }).then(json<{ override: { pct: number; expiresAt: string } }>),

  withdrawWeek: (): Promise<{ override: unknown }> =>
    fetch(`${BASE}/usage/override`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ window: 'seven_day' }),
    }).then(json<{ override: unknown }>),

  readingList: (): Promise<{ entries: ReadingItem[] }> => fetch(`${BASE}/reading-list`).then(json<{ entries: ReadingItem[] }>),

  /** Fetch one entry through the ordinary URL ingest; the service does the downloading. */
  ingestReading: (url: string): Promise<{ job: Job }> =>
    fetch(`${BASE}/reading-list/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then(json<{ job: Job }>),

  /**
   * Look for a legal open copy of one entry, now. It VERIFIES - the copy is fetched, extracted
   * and measured against the acceptance bars - so it can take a few seconds, and a find is
   * written into the entry on the page.
   */
  findOpenAccess: (url: string): Promise<{ found: boolean; reason?: string; oa?: { url: string; version: string | null; chars: number } }> =>
    fetch(`${BASE}/reading-list/open-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then(json<{ found: boolean; reason?: string; oa?: { url: string; version: string | null; chars: number } }>),

  /** Put one entry out of sight, or bring it back. A mark on the entry, never a removal. */
  questions: (): Promise<{ entries: QuestionItem[] }> => fetch(`${BASE}/questions`).then(json<{ entries: QuestionItem[] }>),
  archiveQuestion: (page: string, text: string, archived: boolean): Promise<{ archived: boolean; vetoed: string[] }> =>
    fetch(`${BASE}/questions/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page, text, archived }),
    }).then(json<{ archived: boolean; vetoed: string[] }>),
  archiveReading: (url: string, archived: boolean): Promise<{ archived: boolean }> =>
    fetch(`${BASE}/reading-list/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, archived }),
    }).then(json<{ archived: boolean }>),

  agentCard: (id: string): Promise<FellowCard> => fetch(`${BASE}/agents/${encodeURIComponent(id)}/card`).then(json<FellowCard>),

  spawnAgent: (body: SpawnBody): Promise<{ agent: FellowRecord; run: MaintenanceRun | null; refusal: string | null }> =>
    fetch(`${BASE}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json<{ agent: FellowRecord; run: MaintenanceRun | null; refusal: string | null }>),

  /**
   * Edits one Fellow. The service refuses an edit it cannot make (a task of an art the Fellow
   * does not hold, say) with a 409 rather than a silently unchanged record, so the caller can
   * show what was refused.
   */
  patchAgent: (id: string, body: AgentPatchBody): Promise<{ agent: FellowRecord }> =>
    fetch(`${BASE}/agents/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json<{ agent: FellowRecord }>),

  stepAgent: (id: string, body: { topic?: string; kind?: string; pageSet?: string[]; override?: boolean } = {}): Promise<{ run: MaintenanceRun }> =>
    fetch(`${BASE}/agents/${encodeURIComponent(id)}/step`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json<{ run: MaintenanceRun }>),

  /** Starts a planning run now; the daily quota does not apply to planning (section 8.4). */
  planAgent: (id: string): Promise<{ run: MaintenanceRun | null; skipped?: string }> =>
    fetch(`${BASE}/agents/${encodeURIComponent(id)}/plan`, { method: 'POST' }).then(json<{ run: MaintenanceRun | null; skipped?: string }>),

  agentAction: (id: string, action: 'pause' | 'resume' | 'retire'): Promise<{ agent: FellowRecord }> =>
    fetch(`${BASE}/agents/${encodeURIComponent(id)}/${action}`, { method: 'POST' }).then(json<{ agent: FellowRecord }>),

  decideProposal: (id: string, body: { status?: 'approved' | 'vetoed' | 'proposed'; note?: string; topic?: string; rank?: number }): Promise<{ proposal: ProposalRecord }> =>
    fetch(`${BASE}/proposals/${encodeURIComponent(id)}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json<{ proposal: ProposalRecord }>),

  telegramStatus: (): Promise<TelegramStatusResponse> =>
    fetch(`${BASE}/settings/telegram`).then(json<TelegramStatusResponse>),
}

/** Parse the stored `citations` JSON string on a message into a typed array. */
export function parseCitations(citations: string | null): Citation[] {
  if (!citations) return []
  try {
    const parsed = JSON.parse(citations)
    return Array.isArray(parsed) ? (parsed as Citation[]) : []
  } catch {
    return []
  }
}
