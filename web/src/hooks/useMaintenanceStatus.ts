/**
 * Feeds the deterministic status model (lib/maintenanceStatus.ts, SPEC §12.7 Stufe b) from
 * the queries the dashboard already runs - every key here is shared with the Maintenance
 * tab's cards, so mounting this hook in a second place (the Overview badge) costs no extra
 * fetches thanks to TanStack's dedup. SSE keeps `stats`/`graph` fresh; the candidate and
 * state queries refetch with the tab's own invalidations.
 *
 * Returns null until every input is loaded - a half-derived status would flicker between
 * severities on first paint.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { MaintenanceAreaState } from '../api/types.ts'
import { computeTagReport, recommendedKeys, MAX_TAG_ACTIONS } from '../lib/tagReport.ts'
import { deriveMaintenanceStatus, type MaintStatus } from '../lib/maintenanceStatus.ts'
import { largestDepartment } from '../lib/splitShelves.ts'

export interface MaintenanceStatusData {
  readonly status: MaintStatus
  /** Restart-proof last-settle facts, keyed by run kind (tag-fix, domain-backfill, …). */
  readonly lastRuns: ReadonlyMap<string, MaintenanceAreaState>
}

export interface MaintenanceStatusResult {
  /** Null while loading - or while failed (check `failed` to tell the two apart). */
  readonly data: MaintenanceStatusData | null
  /** True when any input query errored: the head must offer a retry, not spin forever. */
  readonly failed: boolean
  readonly retry: () => void
}

export function useMaintenanceStatus(): MaintenanceStatusResult {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const candidates = useQuery({ queryKey: ['domain-candidates'], queryFn: api.domainCandidates })
  const index = useQuery({ queryKey: ['retrieve-index-status'], queryFn: api.retrieveIndexStatus })
  const state = useQuery({ queryKey: ['maintenance-state'], queryFn: api.maintenanceState })
  /*
   * The standing defect list (SPEC §12.16). Base product - the route answers with
   * `AGENTS_ENABLED` off too, so no `enabled` guard belongs here (hard rule 8 runs the other
   * way for a Fellow-only route: a query without a guard costs one 404 per mount).
   *
   * `limit: 200` is the route's own cap: the item counts the whole backlog rather than the
   * page the card happens to show, and the per-rule counts are what the split is built from,
   * so a finding past the first fifty still moves the severity.
   */
  const defects = useQuery({ queryKey: ['validation', null, 200], queryFn: () => api.validation({ limit: 200 }), staleTime: 30_000 })

  const report = useMemo(
    () => (graph.data !== undefined ? computeTagReport(graph.data.nodes) : null),
    [graph.data],
  )
  /** The split item's input, from the graph already loaded: no request of its own. */
  const largest = useMemo(() => (graph.data !== undefined ? largestDepartment(graph.data.nodes) : null), [graph.data])

  const failed = stats.isError || graph.isError || domains.isError || candidates.isError
  const retry = (): void => {
    for (const q of [stats, graph, domains, candidates, index, state]) {
      if (q.isError) void q.refetch()
    }
  }

  /**
   * The list split the way the card splits it: fixable (a pass or a bound run exists for the
   * rule) against everything else. The classification is the SERVER's - it rides along in the
   * response - so the two surfaces cannot disagree about what is fixable.
   */
  const defectCounts = useMemo(() => {
    const d = defects.data
    if (d === undefined) return null
    let fixable = 0
    let decision = 0
    for (const r of d.byRule) {
      const path = d.guidance?.[r.rule]?.path
      if (path === 'pass' || path === 'run') fixable += r.findings
      else decision += r.findings
    }
    return { fixable, decision }
  }, [defects.data])

  const data = useMemo(() => {
    if (
      stats.data === undefined ||
      domains.data === undefined ||
      candidates.data === undefined ||
      report === null
    ) {
      return null
    }
    // The lint area needs the RUN record, not just the report file - a run that finished
    // without writing one is otherwise indistinguishable from no run at all.
    const lintRun = (state.data?.areas ?? []).find((a) => a.kind === 'lint')
    const hotRun = (state.data?.areas ?? []).find((a) => a.kind === 'hot-cache' && a.ok)
    const status = deriveMaintenanceStatus({
      undomained: candidates.data.undomainedCount,
      registryInstalled: domains.data.installed,
      candidateCount: candidates.data.candidates.length,
      missingDomainEchoes: report.domainEchoes.filter((e) => e.domain === 'unassigned').length,
      tagRepairCount: recommendedKeys(report, MAX_TAG_ACTIONS).size,
      lintReport: stats.data.lintReport,
      lastLintRun: lintRun !== undefined ? { finishedAt: lintRun.finishedAt, ok: lintRun.ok } : null,
      // Dated from the last REFRESH run, as the hot cache card dates it: the file's mtime moves
      // with every research run that writes the cache, so it made a cache that was never
      // refreshed look fresh here while the card beside it said "16 d ago".
      hotCacheUpdatedAt: hotRun?.finishedAt ?? null,
      index: index.data ?? null,
      unversioned: stats.data.unversioned ?? null,
      defects: defectCounts,
      largestDomain: largest,
      now: new Date(),
    })
    const lastRuns = new Map((state.data?.areas ?? []).map((a) => [a.kind, a]))
    return { status, lastRuns }
  }, [stats.data, domains.data, candidates.data, report, index.data, state.data, defectCounts, largest])

  return { data, failed, retry }
}
