/**
 * The bound agent run over one defect, from the row (TASKS-DEFECT-PATHS phase 4).
 *
 * WHY THIS IS NOT THE REPAIR PANEL'S SHAPE (decision 15). A deterministic pass can be planned,
 * diffed and approved before it writes, because it is a function. A run cannot: what it will
 * write is what it decides while reading. So the run WRITES, and the diff comes after, with a
 * revert beside it - `revertCommit` already exists for ingests, and a two-step proposal for an
 * agent result would be a second proposal system beside the Fellows'.
 *
 * WHAT THE CONFIRMATION HAS TO SAY BEFORE IT STARTS, for `open-question-form`: a reformulated
 * question is a NEW question. The text is its identity, so a proposal a Fellow planned from the
 * old wording is vetoed and the board shows the new bullet as unplanned. That can discard a
 * planned night's work, which is not something to discover afterwards.
 */

import React, { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { DefectFixSettlement, DefectGuidance, StandingFinding } from '../api/types.ts'

/** What the confirmation says beyond the cost, per rule. */
const RULE_WARNING: Record<string, string> = {
  'open-question-form':
    'A reformulated question is a NEW question: the text is its identity. Any research a Fellow had planned ' +
    'from the old wording is vetoed, and the board shows the new bullet as unplanned. This can discard a ' +
    'planned night’s work.',
  quote:
    'The run checks the quotation against the document the job actually read. Where the source does not say it, ' +
    'the sentence around it becomes a paraphrase - the page will read differently afterwards.',
  'page-schema': 'The run fills the missing section from what the page and the vault already hold. It adds no new claim.',
}

export function DefectFixRun({
  finding,
  guidance,
  readOnly,
  onClose,
}: {
  finding: StandingFinding
  guidance: DefectGuidance | undefined
  readOnly: boolean
  onClose: () => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [runId, setRunId] = useState<string | null>(null)
  const [settled, setSettled] = useState<DefectFixSettlement | null>(null)

  const start = useMutation({
    mutationFn: () => api.repairRun(finding.rule, [finding.id]),
    onSuccess: (run) => setRunId(run.id),
  })

  /*
   * The run is followed through the run record rather than through a socket of its own: it is
   * an ordinary maintenance run and appears in the registry, the history and the activity feed
   * like every other one. Polling stops the moment it settles.
   */
  const run = useQuery({
    queryKey: ['maintenance-run', runId],
    queryFn: () => api.maintenanceRun(runId!),
    enabled: runId !== null && settled === null,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  })

  const settle = useMutation({
    mutationFn: () => api.repairRunSettle(runId!),
    onSuccess: (result) => {
      setSettled(result)
      void qc.invalidateQueries({ queryKey: ['validation'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  /*
   * The bookkeeping runs once, as soon as the run has settled: the re-check, the quote path and
   * the veto all need the commit that only exists now.
   *
   * `settle` is deliberately not a dependency - the mutation object is a new one on every
   * render, so depending on it re-fires the effect every render and the guard below would be
   * the only thing between that and a loop. The status IS the trigger.
   */
  const fire = settle.mutate
  const pending = settle.isPending
  useEffect(() => {
    const status = run.data?.status
    if (runId !== null && settled === null && status !== undefined && status !== 'running' && !pending) fire()
  }, [run.data?.status, runId, settled, pending, fire])

  const revert = useMutation({
    mutationFn: () => api.repairRevert(settled!.commit!),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['validation'] }),
  })

  return (
    <div className="repair-panel">
      <div className="repair-head">
        <h4 className="repair-title">Repair this with an agent run</h4>
        <span className="spacer" />
        <button className="linkish" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="repair-body">
        {settled !== null ? (
          <>
            <p>
              {settled.pages.length === 0
                ? 'The run finished and wrote nothing.'
                : `Wrote ${settled.pages.length === 1 ? '1 page' : `${settled.pages.length} pages`}` +
                  (settled.commit ? `, commit ${settled.commit.slice(0, 8)}.` : ', not committed.')}
            </p>
            <p className="defect-note">
              {settled.stillStanding === 0 ? 'The finding is gone from the list.' : 'The finding is still standing.'}{' '}
              Re-checked: {settled.resolved} cleared, {settled.recorded} newly recorded
              {settled.quotesCleared > 0 && `, ${settled.quotesCleared} quote finding(s) cleared by the run's own check`}
              {settled.recheckedAway > 0 && `, ${settled.recheckedAway} cleared elsewhere`}.
            </p>
            {settled.vetoedProposals.length > 0 && (
              <p className="defect-limit">
                {settled.vetoedProposals.length} planned research proposal(s) vetoed: the question they were planned
                from no longer exists in that wording.
              </p>
            )}
            {settled.commit !== null && (
              <div className="repair-actions">
                <button className="btn" disabled={readOnly || revert.isPending} onClick={() => revert.mutate()}>
                  {revert.isPending ? 'Reverting…' : 'Revert this commit'}
                </button>
                {revert.isError && (
                  <span className="defect-error">
                    {/* A dirty tree means something is still writing - an answer, not an error. */}
                    {(revert.error as Error).message}
                  </span>
                )}
                {revert.data?.reverted === true && (
                  <span className="dim">
                    Reverted as {revert.data.revertCommit?.slice(0, 8)}; the defect is back on the list.
                  </span>
                )}
              </div>
            )}
            <button className="btn" onClick={onClose}>
              Done
            </button>
          </>
        ) : runId !== null ? (
          <p className="dim">
            {run.data?.status === 'running' ? (run.data.waiting === true ? 'Queued behind another run…' : 'Running…') : 'Settling…'}
          </p>
        ) : (
          <>
            <p>
              One run, one page, one commit. {guidance?.what}
            </p>
            {RULE_WARNING[finding.rule] !== undefined && <p className="defect-limit">{RULE_WARNING[finding.rule]}</p>}
            {(finding.fixAttempts ?? 0) >= 2 && (
              <p className="defect-limit">
                {finding.fixAttempts} runs have already tried this one and it is still standing. Accepting it with a
                reason, or repairing the page by hand, is likely to cost less than a third.
              </p>
            )}
            <div className="repair-actions">
              <button className="btn primary" disabled={readOnly || start.isPending} onClick={() => start.mutate()}>
                {start.isPending ? 'Starting…' : 'Start the run'}
              </button>
              {readOnly && <span className="dim">This instance is read-only.</span>}
              {start.isError && <span className="defect-error">{(start.error as Error).message}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
