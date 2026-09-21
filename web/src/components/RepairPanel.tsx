/**
 * The repair panel: plan, read the diff, choose, apply (TASKS-DEFECT-PATHS 3.7).
 *
 * BOTH UNITS OPEN THE SAME PANEL (decision 5). "Fix this" on a row passes one finding id,
 * "fix all N" on a rule chip passes the rule's ids; the list shows rows and the passes work in
 * classes, and the person works in both. What follows is identical either way.
 *
 * THE APPROVAL IS OF A DIFF (decision 8). Every page comes with its own diff and its own
 * checkbox, all checked by default, and the apply carries back the `beforeHash` each diff was
 * made against. A page that changed in between comes back as stale and is not written - the
 * approval was of that diff, and this is no longer that diff.
 *
 * WHAT THE RESULT SAYS, and why all three: written, stale, and skipped-for-a-held-lock. The
 * last two mean different things to the reader. Stale means the page moved under the diff and
 * the repair should be re-planned; busy means somebody is writing that page right now and the
 * same repair will work in a minute.
 */

import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { DefectGuidance, RepairOutcome } from '../api/types.ts'
import { Diff } from './Diff.tsx'
import { queryState } from './QueryState.tsx'

export interface RepairTarget {
  readonly rule: string
  readonly ids: string[]
  /** What the button said, for the panel's own headline. */
  readonly label: string
}

export function RepairPanel({
  target,
  guidance,
  readOnly,
  onClose,
}: {
  target: RepairTarget
  guidance: DefectGuidance | undefined
  readOnly: boolean
  onClose: () => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [chosen, setChosen] = useState<Set<string> | null>(null)
  const [outcome, setOutcome] = useState<RepairOutcome | null>(null)

  const plan = useQuery({
    queryKey: ['repair-plan', target.rule, target.ids.join(',')],
    queryFn: () => api.repairPlan(target.rule, target.ids),
    // A plan is a synchronous read of every page it is given; nothing about it is worth
    // repeating on a window focus.
    staleTime: Infinity,
    retry: false,
  })

  const apply = useMutation({
    mutationFn: () => {
      const pages = (plan.data?.pages ?? []).filter((p) => selected.has(p.rel)).map((p) => ({ rel: p.rel, beforeHash: p.beforeHash }))
      return api.repairApply(target.rule, target.ids, pages)
    },
    onSuccess: (result) => {
      setOutcome(result)
      void qc.invalidateQueries({ queryKey: ['validation'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  const pages = plan.data?.pages ?? []
  // All checked by default; `chosen` only exists once somebody has unchecked something.
  const selected = chosen ?? new Set(pages.map((p) => p.rel))
  const toggle = (rel: string): void => {
    const next = new Set(selected)
    if (next.has(rel)) next.delete(rel)
    else next.add(rel)
    setChosen(next)
  }

  const state = queryState(plan, 'the repair plan')

  return (
    <div className="repair-panel">
      <div className="repair-head">
        <h4 className="repair-title">{target.label}</h4>
        <span className="spacer" />
        <button className="linkish" onClick={onClose}>
          Close
        </button>
      </div>

      {guidance?.limit !== undefined && <p className="defect-limit">{guidance.limit}</p>}

      {outcome !== null ? (
        <RepairResult outcome={outcome} onClose={onClose} />
      ) : plan.data === undefined ? (
        <div className="repair-body">{state ?? <span className="dim">Planning - reading the pages…</span>}</div>
      ) : (
        <div className="repair-body">
          {pages.length === 0 ? (
            <p className="tab-hint">
              The pass changes nothing on {plan.data.findings === 1 ? 'this page' : 'these pages'}. That is not a failed fix:
              a pass reaches a subset of what its rule reports, and the row stays until something else clears it.
            </p>
          ) : (
            <>
              <p className="tab-hint">
                {pages.length === 1 ? '1 page' : `${pages.length} pages`} would change. Read the diff, uncheck what you
                disagree with, then apply - one git commit, revertable.
              </p>
              {pages.map((p) => (
                <div className="repair-page" key={p.rel}>
                  <label className="repair-pick">
                    <input type="checkbox" checked={selected.has(p.rel)} onChange={() => toggle(p.rel)} />
                    <span className="repair-rel">{p.rel}</span>
                    <span className="dim">{p.why}</span>
                  </label>
                  <Diff text={p.diff} />
                </div>
              ))}
              {plan.data.unchanged.length > 0 && (
                <p className="defect-note">
                  {plan.data.unchanged.length} of the selected page(s) carry a defect this pass cannot reach; their rows
                  stay after the apply.
                </p>
              )}
              <div className="repair-actions">
                <button
                  className="btn primary"
                  disabled={readOnly || apply.isPending || selected.size === 0}
                  onClick={() => apply.mutate()}
                  title={readOnly ? 'This instance is read-only' : 'Write the checked pages - one commit'}
                >
                  {apply.isPending ? 'Writing…' : `Apply to ${selected.size === 1 ? '1 page' : `${selected.size} pages`}`}
                </button>
                {readOnly && <span className="dim">This instance is read-only.</span>}
                {apply.isError && <span className="defect-error">{(apply.error as Error).message}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** What happened, in the three categories that mean three different things. */
function RepairResult({ outcome, onClose }: { outcome: RepairOutcome; onClose: () => void }): React.ReactElement {
  return (
    <div className="repair-body">
      <p>
        {outcome.written.length === 0
          ? 'Nothing was written.'
          : `Wrote ${outcome.written.length === 1 ? '1 page' : `${outcome.written.length} pages`}` +
            (outcome.commit?.hash ? `, commit ${outcome.commit.hash.slice(0, 8)}.` : ', not committed.')}
      </p>
      {outcome.commitError !== undefined && (
        <p className="defect-error">The pages were written and the commit failed: {outcome.commitError}</p>
      )}
      {outcome.stale.length > 0 && (
        <p className="defect-limit">
          {outcome.stale.length} page(s) changed after the diff was made and were left alone. Plan again to see what they
          say now.
        </p>
      )}
      {outcome.busy.length > 0 && (
        <p className="defect-limit">
          {outcome.busy.length} page(s) are being written by something else right now and were skipped. The same repair
          will work once that settles.
        </p>
      )}
      <p className="defect-note">
        Re-checked afterwards: {outcome.resolved} finding(s) cleared on the pages written, {outcome.recorded} newly
        recorded, {outcome.recheckedAway} cleared elsewhere on the list.
      </p>
      <button className="btn" onClick={onClose}>
        Done
      </button>
    </div>
  )
}
