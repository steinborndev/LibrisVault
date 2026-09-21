/**
 * The research run list (redesign 2026-08-25, second pass).
 *
 * Since schema v12 the server keeps one row per settled run (`GET /maintenance/history`),
 * which is the source of record: topic, lens, pages, tokens, cost, duration, and the failed
 * runs that never wrote a page. Three older sources still contribute, in this order:
 *
 *   history      the persistent run log - everything, for every run since v12 landed
 *   run record   the in-memory registry, which is the only one that knows about a run
 *                still IN FLIGHT
 *   settle state one restart-proof row per kind; a pre-v12 failure can only appear here
 *   vault page   topic and lens parsed back out of the deterministic
 *                `Research: <topic><lens suffix>` title, dated by mtime - this is what
 *                surfaces runs from before the run log existed
 *
 * Each source is dropped where a better one already covers the same run: by id, by claimed
 * page path, or by topic+lens within an hour of the same settle. Pure functions over plain
 * arrays (no fetching, no `Date.now()`), so the merge stays testable.
 */

import type {
  AgentRunRecord,
  GraphNode,
  MaintenanceAreaState,
  MaintenanceRun,
  ResearchProfile,
} from '../api/types.ts'
import { contentPages } from './activity.ts'

export interface ResearchRunEntry {
  readonly id: string
  /**
   * The persistent history row this entry can be taken out of, or null when there is none.
   *
   * Only a settled run HAS such a row. A run still in flight, and an entry reconstructed from
   * a synthesis page whose run record is long gone, have nothing to remove - and offering a
   * cross that cannot do anything is worse than offering none.
   */
  readonly removableId: string | null
  /** The topic as typed, with the lens suffix stripped back off. */
  readonly topic: string
  readonly profileKey: string | null
  readonly status: 'running' | 'done' | 'failed'
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly pages: readonly string[]
  readonly costUsd: number | null
  readonly error: string | null
  /**
   * Where the row's facts come from: `history` = the persistent run log, `run` = the
   * in-memory registry (a run in flight), `state` = a per-kind settle record, `page` =
   * reconstructed from the synthesis page in the vault (pre-v12 runs).
   */
  readonly source: 'history' | 'run' | 'page' | 'state'
  /** The synthesis page, when this entry came from one. */
  readonly pagePath: string | null
}

/**
 * The prefix a synthesis page title carries, MIRRORING `RESEARCH_PREFIX` in
 * `server/src/pipeline/research-profiles.ts`. Colon-free since 2026-09-19 there; this copy was
 * left behind until 2026-09-21, which meant the composer previewed a name the run would not
 * use and every recognition path below missed a page filed after that date.
 */
export const RESEARCH_PREFIX = 'Research - '

/**
 * The spelling used before 2026-09-19. Recognition accepts both forever, for the same reason
 * the server does: the pages that carry it do not rename themselves, and a reader that stops
 * recognising them shows a run as having filed nothing.
 */
export const LEGACY_RESEARCH_PREFIX = 'Research: '

/** Either spelling, longest first so the result never keeps half a prefix. */
const researchPrefixOf = (s: string): string | null =>
  [RESEARCH_PREFIX, LEGACY_RESEARCH_PREFIX].find((p) => s.startsWith(p)) ?? null
/** Both research kinds file synthesis pages: a full run and a Fellow's bounded step. */
export const isResearchKind = (kind: string): boolean => kind === 'research' || kind === 'research-step'

/** How far apart a page mtime and a run settle may be and still be the same run. */
const SAME_RUN_MS = 60 * 60 * 1000

/**
 * Splits a synthesis page title back into topic and lens. Longest suffix first, so
 * ` - State of the Art` never loses to the empty default suffix.
 */
export function splitResearchTitle(
  title: string,
  profiles: readonly ResearchProfile[],
): { topic: string; profileKey: string | null } | null {
  const prefix = researchPrefixOf(title)
  if (prefix === null) return null
  const rest = title.slice(prefix.length)
  const withSuffix = [...profiles]
    .filter((p) => p.titleSuffix !== '')
    .sort((a, b) => b.titleSuffix.length - a.titleSuffix.length)
  for (const p of withSuffix) {
    // Titles are written with the profile's own suffix, but a vault page may carry an
    // em-dash variant from an earlier version - compare on a normalized dash.
    const suffix = normalizeDashes(p.titleSuffix)
    if (normalizeDashes(rest).endsWith(suffix)) {
      return { topic: rest.slice(0, rest.length - suffix.length).trim(), profileKey: p.key }
    }
  }
  return { topic: rest.trim(), profileKey: null }
}

const normalizeDashes = (s: string): string => s.replace(/[–—]/g, '-')

export interface ResearchRunsInput {
  /** The persistent run log from `GET /maintenance/history?kind=research` (schema v12). */
  readonly history?: readonly AgentRunRecord[]
  /** Tracked runs from `GET /maintenance/runs` (all kinds; research is picked out here). */
  readonly runs: readonly MaintenanceRun[]
  /** Restart-proof settle records; only a failed research one adds anything a page cannot. */
  readonly lastRuns: readonly MaintenanceAreaState[]
  /** Graph nodes, for the synthesis pages that outlive every run record. */
  readonly nodes: readonly GraphNode[]
  readonly profiles: readonly ResearchProfile[]
}

export function buildResearchRuns(input: ResearchRunsInput): ResearchRunEntry[] {
  const out: ResearchRunEntry[] = []
  const claimedPages = new Set<string>()
  const seenIds = new Set<string>()
  const runFingerprints: Array<{ topic: string; profileKey: string | null; at: number }> = []

  for (const h of input.history ?? []) {
    if (!isResearchKind(h.kind)) continue
    seenIds.add(h.id)
    for (const p of h.pages) claimedPages.add(p)
    runFingerprints.push({
      topic: (h.label ?? '').trim().toLowerCase(),
      profileKey: h.profileKey,
      at: Date.parse(h.finishedAt),
    })
    out.push({
      id: h.id,
      removableId: h.id,
      topic: h.label ?? 'Research run',
      profileKey: h.profileKey,
      status: h.ok ? 'done' : 'failed',
      startedAt: h.startedAt,
      finishedAt: h.finishedAt,
      // What the run wrote FOR THE READER. The log records every path the run's commit
      // carried, which always includes the index hubs an ingest or a run touches in passing
      // (`index`, `hot`, `log`, the `_index` MOCs) - counting and listing those told the
      // reader a run of five pages wrote nine. Same filter the activity stream applies.
      pages: contentPages(h.pages),
      costUsd: h.costUsd,
      error: h.error,
      source: 'history',
      pagePath: null,
    })
  }

  for (const r of input.runs) {
    if (!isResearchKind(r.kind)) continue
    // The run log already carries every settled run; the registry only adds what is live.
    if (seenIds.has(r.id)) continue
    const status: ResearchRunEntry['status'] =
      r.status === 'running' ? 'running' : r.status === 'error' || r.result?.ok === false ? 'failed' : 'done'
    seenIds.add(r.id)
    const pages = r.result?.pages ?? []
    // Claimed by the RAW list - a hub page this run touched is still one no page-derived
    // entry should reconstruct. Only what the reader is shown gets filtered, below.
    for (const p of pages) claimedPages.add(p)
    const finishedAt = r.finishedAt ?? null
    if (finishedAt !== null) {
      runFingerprints.push({
        topic: (r.label ?? '').trim().toLowerCase(),
        profileKey: r.profileKey ?? null,
        at: Date.parse(finishedAt),
      })
    }
    out.push({
      id: r.id,
      // A run still in flight has no history row yet; it gets one when it settles.
      removableId: null,
      topic: r.label ?? 'Research run',
      profileKey: r.profileKey ?? null,
      status,
      startedAt: r.startedAt,
      finishedAt,
      pages: contentPages(pages),
      costUsd: r.result?.usage.costUsd ?? null,
      error: r.error ?? r.result?.error ?? null,
      source: 'run',
      pagePath: null,
    })
  }

  for (const n of input.nodes) {
    if (claimedPages.has(n.path)) continue
    /**
     * Every name the page answers to, its own title first. A file name drops the characters
     * the filesystem dislikes while the frontmatter title keeps them, and the run log records
     * the topic as it was typed - so a run about "implantable/wearable" is filed as
     * "implantable_wearable" and, compared by file name alone, failed to recognise itself.
     * It was then reconstructed a second time and sat in the ledger beside the real run,
     * claiming one page where the run wrote fourteen (2026-08-26).
     */
    const splits = [...(n.names ?? []), n.title]
      .map((name) => splitResearchTitle(name, input.profiles))
      .filter((split): split is NonNullable<typeof split> => split !== null)
    const split = splits[0]
    if (split === undefined) continue
    const mtime = n.mtimeMs
    const finishedAt = mtime !== undefined ? new Date(mtime).toISOString() : null
    const duplicate = splits.some((s) =>
      runFingerprints.some(
        (f) =>
          f.topic === s.topic.trim().toLowerCase() &&
          f.profileKey === s.profileKey &&
          (mtime === undefined || Math.abs(f.at - mtime) < SAME_RUN_MS),
      ),
    )
    if (duplicate) continue
    out.push({
      id: `page:${n.path}`,
      // Reconstructed from the page alone: the run that wrote it left no record to remove.
      removableId: null,
      topic: split.topic,
      profileKey: split.profileKey,
      status: 'done',
      startedAt: null,
      finishedAt,
      pages: [n.path],
      costUsd: null,
      error: null,
      source: 'page',
      pagePath: n.path,
    })
  }

  // A failed run writes no page and leaves no tracked record after a restart - the settle
  // record is the only trace it ever happened, so it earns a row of its own.
  for (const a of input.lastRuns) {
    if (!isResearchKind(a.kind) || a.ok) continue
    if (seenIds.has(a.runId) || out.some((e) => e.id === a.runId)) continue
    out.push({
      id: `state:${a.runId}`,
      // The last settle of a kind. If its run were in the history it would be an `h` entry.
      removableId: null,
      topic: 'Research run',
      profileKey: null,
      status: 'failed',
      startedAt: null,
      finishedAt: a.finishedAt,
      pages: [],
      costUsd: null,
      error: a.error,
      source: 'state',
      pagePath: null,
    })
  }

  const when = (e: ResearchRunEntry): number => Date.parse(e.finishedAt ?? e.startedAt ?? '') || 0
  return out.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1
    if (b.status === 'running' && a.status !== 'running') return 1
    return when(b) - when(a)
  })
}

/**
 * The deterministic page title a run with this topic and lens will file as.
 *
 * Mirrors `titleSafe` in `server/src/pipeline/research-profiles.ts`, which is what actually
 * pins the title in the prompt. A topic with a path separator in it would otherwise be shown
 * here as one name and filed under another - and the lookup below, which finds a run's page
 * by its title, would miss it.
 */
export function targetTitle(topic: string, profile: ResearchProfile | undefined): string {
  return `${RESEARCH_PREFIX}${titleSafe(topic)}${profile?.titleSuffix ?? ''}`
}

/** A topic reduced to something that can be a file name. See the server-side original. */
export function titleSafe(topic: string): string {
  const cleaned = [...topic.replace(/[/\\]+/g, '-')]
    // Control characters, the other half of what the vault's own `safe_name()` strips. A
    // character class would say this more directly, but the lint rule that forbids control
    // characters in a regex is right about every other use of one.
    .filter((c) => (c.codePointAt(0) ?? 0) > 0x1f)
    .join('')
    .trim()
    // After the trim, not before: leading whitespace used to shelter the dot behind it.
    .replace(/^[.-]+/, '')
    .trim()
  return cleaned === '' ? 'untitled' : cleaned
}

/**
 * The runs the ledger lists (2026-08-27).
 *
 * Everything except the entries reconstructed from a vault page. Those are real runs, but
 * the only timestamp they have is the page's mtime, which is not when the run happened -
 * eleven of them in one vault shared a single bulk-touch mtime to the microsecond, and the
 * ledger reported all eleven as having run at the same moment. Their pages are reachable
 * from the Library and the Graph; what is dropped is the claim that they are dated records.
 *
 * The set cannot grow: every run since the run log landed (schema v12) is in the log.
 */
export function listedRuns(entries: readonly ResearchRunEntry[]): ResearchRunEntry[] {
  return entries.filter((e) => e.source !== 'page')
}

/**
 * The synthesis page a run was FOR, in the order the answers are trustworthy (2026-08-27).
 *
 * This used to guess only: rebuild the deterministic title and look for a graph node with
 * that name. But the agent names the page itself, and it does not always land on the title
 * the client predicted - a run labelled "expected effect of X on Y" may well be filed as
 * "Research: X effects on Y".
 * The name lookup missed, the detail view rendered no article at all, and the only thing
 * left on screen was the provenance footnote.
 *
 * What the run COMMITTED is the better source, and it is already in the entry. The name
 * match stays as the last resort: for one observed class of run the synthesis page is
 * missing from the commit's page list while the page itself sits in the vault.
 */
export function synthesisPage(
  entry: ResearchRunEntry,
  profiles: readonly ResearchProfile[],
  nodes: readonly GraphNode[],
): string | null {
  if (entry.pagePath !== null) return entry.pagePath
  const filed = entry.pages.find(isSynthesisPath)
  if (filed !== undefined) return filed
  // Both spellings, because this looks a page up by the name it WOULD have: a run filed before
  // 2026-09-19 carries the legacy prefix, and predicting only the current one would lose exactly
  // the older runs this last resort exists for.
  const wanted = targetTitle(entry.topic, profiles.find((p) => p.key === entry.profileKey))
  const candidates = [wanted, wanted.replace(RESEARCH_PREFIX, LEGACY_RESEARCH_PREFIX)]
  const node = nodes.find((n) =>
    candidates.some((w) => n.title === w || (n.names?.includes(w) ?? false)),
  )
  return node?.path ?? null
}

/** A `wiki/questions/Research - ….md` path - the shape a run's own synthesis page has. */
const isSynthesisPath = (path: string): boolean =>
  path.startsWith('wiki/questions/') && researchPrefixOf(path.split('/').pop() ?? '') !== null
