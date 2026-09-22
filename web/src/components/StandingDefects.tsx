/**
 * The standing defect list, with a path out of it (TASKS-DEFECT-PATHS phase 1).
 *
 * WHAT IT WAS. The validator's findings used to go into job logs, one line per occurrence,
 * each labelled "advisory only, nothing was modified" - 406 of them, one dead link reported
 * 109 times. A9 replaced that with one row per defect. And there it stopped: every row was a
 * `<span>`, with no link to its subject, no evidence, and no statement of who is supposed to
 * do something about it. Six of the nine standing rules are classified as needing judgement,
 * which means "a person decides" - and the person had been given a list and nothing else.
 *
 * WHAT IT IS NOW. Three blocks rather than one list, because the first question a reader has
 * is "what can I get rid of without thinking about it": FIXABLE (a deterministic pass or a
 * bound run exists), YOUR DECISION (everything else), and ACCEPTED (phase 2). The rule chips
 * stay underneath as a filter. A row expands and shows the evidence the finding is based on,
 * a link to its subject, and one line saying what the repair is, who performs it and what it
 * costs - all of it served by the API, so the classification lives in one place.
 *
 * Base product: the route answers with `AGENTS_ENABLED` off too, so this needs no flag guard.
 * A notebook finding is visible with the flag off and renders as a decision (4.5).
 */

import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { DefectGuidance, StandingFinding } from '../api/types.ts'
import { canAccept, splitBlocks, subjectLink, provenanceOf, type DefectBlockId } from '../lib/defectList.ts'
import { PageLink } from './PageLink.tsx'
import { Tip } from './Tip.tsx'
import { queryState } from './QueryState.tsx'
import { RepairPanel, type RepairTarget } from './RepairPanel.tsx'
import { DefectFixRun } from './DefectFixRun.tsx'
import { navigate } from '../lib/router.ts'

/** One page of rows. The route caps at 200; "show more" walks it in steps of this. */
const PAGE = 50

/** How long a reason may be. The route trims and caps at the same number. */
const REASON_MAX = 500

/** How many findings one "fix all" may carry. The route refuses more than this. */
const FIX_ALL_CAP = 40

/**
 * The three blocks, in the order a reader works them (decision 9).
 *
 * `accepted` renders from phase 2 on and is empty until then; it is listed here so the block
 * set is one list rather than two places that have to agree.
 */
const BLOCKS: ReadonlyArray<{ id: DefectBlockId; title: string; hint: string }> = [
  { id: 'fixable', title: 'Fixable', hint: 'A repair exists for these: a deterministic pass, or a bound agent run on one page.' },
  { id: 'decision', title: 'Your decision', hint: 'No repair can be produced without somebody deciding what the page should say.' },
]

/** The row's subject as a link, or the reason there is none (`lib/defectList.ts` decides). */
function Subject({ finding, vaultName }: { finding: StandingFinding; vaultName: string }): React.ReactElement {
  const link = subjectLink(finding)
  if (link.kind === 'page') return <PageLink vaultName={vaultName} path={link.path} plain tabbable={false} />
  if (link.kind === 'job') {
    return (
      <button
        className="linkish"
        onClick={(e) => {
          e.stopPropagation()
          navigate(link.href)
        }}
        title="Open this job's record"
      >
        job {link.jobId.slice(0, 8)}
      </button>
    )
  }
  return <span className="defect-nolink">{link.why}</span>
}

/** What the finding is based on, fetched when the row opens rather than for all fifty. */
function Evidence({ id }: { id: string }): React.ReactElement {
  const q = useQuery({ queryKey: ['finding-evidence', id], queryFn: () => api.findingEvidence(id), staleTime: 30_000 })
  const state = queryState(q, 'the evidence')
  if (q.data === undefined) return <div className="defect-evidence">{state ?? <span className="dim">Reading the page…</span>}</div>
  const { blocks, note } = q.data
  if (blocks.length === 0) return <div className="defect-evidence">{note ?? 'Nothing to show for this finding.'}</div>
  return (
    <div className="defect-evidence">
      {blocks.map((b, i) => (
        <div className="defect-block" key={i}>
          <div className="defect-block-label">{b.label}</div>
          <pre className="defect-block-text">{b.text}</pre>
        </div>
      ))}
      {note !== undefined && <p className="defect-note">{note}</p>}
    </div>
  )
}

/**
 * The accept, with its reason (decision 3).
 *
 * PERMANENT AND REASONED. A snooze would only postpone the reading; an accept without a reason
 * is indistinguishable from neglect six months on, which is the state the 406 job-log lines
 * were already in. The button stays disabled until something has been typed, so the 400 the
 * route answers is never reached from here.
 */
function AcceptForm({ id, disabled, readOnly }: { id: string; disabled: boolean; readOnly: boolean }): React.ReactElement {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const accept = useMutation({
    mutationFn: () => api.acceptFinding(id, reason),
    onSuccess: () => {
      setReason('')
      void qc.invalidateQueries({ queryKey: ['validation'] })
    },
  })
  return (
    <div className="defect-accept">
      <input
        className="input"
        value={reason}
        maxLength={REASON_MAX}
        placeholder="Why may this defect stay?"
        disabled={disabled || accept.isPending}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && reason.trim() !== '') accept.mutate()
        }}
      />
      <button
        className="btn"
        disabled={disabled || accept.isPending || reason.trim() === ''}
        onClick={() => accept.mutate()}
        title={disabled ? 'This instance is read-only' : 'Accept this defect permanently, with the reason above'}
      >
        {accept.isPending ? 'Accepting…' : 'Accept'}
      </button>
      {readOnly && <span className="dim">This instance is read-only.</span>}
      {accept.isError && <span className="defect-error">{(accept.error as Error).message}</span>}
    </div>
  )
}

/** One accepted row: its reason, when it was accepted, and the way back. */
function AcceptedRow({ finding, disabled }: { finding: StandingFinding; disabled: boolean }): React.ReactElement {
  const qc = useQueryClient()
  const unaccept = useMutation({
    mutationFn: () => api.unacceptFinding(finding.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['validation'] }),
  })
  return (
    <div className="defect-row">
      <div className="defect-line static">
        <span className="defect-rule">{finding.rule}</span>
        <span className="defect-msg" title={finding.message}>
          {finding.acceptedReason ?? finding.message}
        </span>
        <button className="linkish" disabled={disabled || unaccept.isPending} onClick={() => unaccept.mutate()}>
          {unaccept.isPending ? 'Undoing…' : 'Un-accept'}
        </button>
      </div>
      <div className="defect-provenance">
        {finding.path} &middot; accepted {finding.acceptedAt?.slice(0, 10) ?? ''}
      </div>
    </div>
  )
}

/** One row: the closed line, and everything the open one adds. */
function DefectRow({
  finding,
  guidance,
  vaultName,
  readOnly,
  onFix,
  onRun,
}: {
  finding: StandingFinding
  guidance: DefectGuidance | undefined
  vaultName: string
  readOnly: boolean
  /** Undefined when this rule has no deterministic pass: the row then offers no button. */
  onFix: (() => void) | undefined
  /** Undefined when this rule has no bound run, or the row is blocked from one (4.5). */
  onRun: (() => void) | undefined
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className={`defect-row${open ? ' open' : ''}`}>
      <button className="defect-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="defect-rule">{finding.rule}</span>
        <span className="defect-msg" title={finding.message}>
          {finding.message}
        </span>
        <span className="defect-count" title={`first seen ${finding.firstSeen.slice(0, 10)}`}>
          {finding.count}&times;
        </span>
      </button>
      {open && (
        <div className="defect-body">
          <div className="defect-where">
            <span className="defect-label">where</span>
            <Subject finding={finding} vaultName={vaultName} />
          </div>
          <Evidence id={finding.id} />
          {guidance !== undefined && (
            <div className="defect-guidance">
              <div>
                <span className="defect-label">what</span> {guidance.what}
              </div>
              <div>
                <span className="defect-label">who</span> {guidance.who} <span className="defect-cost">({guidance.cost})</span>
              </div>
              {guidance.limit !== undefined && (
                <div className="defect-limit">
                  <span className="defect-label">limit</span> {guidance.limit}
                </div>
              )}
            </div>
          )}
          {/*
            DISABLED rather than hidden on a read-only instance (SPEC.md §12.8): a surface that
            vanishes reads as a feature that does not exist, and the demo is meant to show what
            the product does. The route would refuse it anyway, before any handler runs.
          */}
          {/*
            Why this row has no run button, where a rule that HAS one is blocked (4.5): a
            Fellow's notebook while that Fellow is working, or a repair that the notebook
            renderer would undo. Rendered as a sentence, never as a disabled button with no
            explanation.
          */}
          {finding.fixBlock?.fixable === false && <p className="defect-limit">{finding.fixBlock.why}</p>}
          {(finding.fixAttempts ?? 0) >= 2 && (
            <p className="defect-limit">
              {finding.fixAttempts} run(s) have tried this one already and it is still standing
              {finding.occurrencesAtLastFix != null && finding.count < finding.occurrencesAtLastFix
                ? ', though it was reported fewer times than before - a partial repair, not a failure.'
                : '. Accepting it with a reason, or repairing it by hand, may cost less than another.'}
            </p>
          )}
          <div className="defect-buttons">
            {/*
              A button only where a deterministic pass reaches the page this finding stands on.
              A rule classified `run` gets its button in phase 4; a `decision` gets none, which
              is the honest rendering of "somebody has to decide what this page should say".
            */}
            {onFix !== undefined && (
              <button className="btn" onClick={onFix} disabled={readOnly} title={readOnly ? 'This instance is read-only' : 'Plan the repair for this page'}>
                Fix this
              </button>
            )}
            {onRun !== undefined && (
              <button className="btn" onClick={onRun} disabled={readOnly} title={readOnly ? 'This instance is read-only' : 'Repair this page with one bound agent run'}>
                Repair with a run
              </button>
            )}
            {finding.acceptedAt == null && <AcceptForm id={finding.id} disabled={!canAccept(finding, readOnly)} readOnly={readOnly} />}
          </div>
          <div className="defect-provenance">
            {/*
              Provenance, never a link: `lastJobId` holds whichever run last REPORTED this, which
              is a maintenance run's id as often as a job's, and 18 of 57 rows carried one when
              this was measured.
            */}
            last reported by {provenanceOf(finding)}, {finding.lastSeen.slice(0, 10)}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The address map's own repair (3.6), which is not a page pass and does not pretend to be.
 *
 * TWO LIMITS, both measured against the live vault and both said out loud here rather than
 * only recorded in the task file:
 *
 *   - it reaches NONE of the `address-map` findings standing today. All four name a
 *     `.raw/<job-id>/` directory that no source entry mentions, and what a job directory held
 *     is not derivable from the directory. A repair that invented it would be inventing
 *     provenance;
 *   - it cannot be scoped to selected findings. It writes one whole file, so applying it fixes
 *     every drift the map has, including entries the list never showed. This is the one place
 *     where "write only what the list showed" does not hold, and the confirmation says so
 *     before the commit rather than after it.
 */
function ManifestRepair({ readOnly }: { readOnly: boolean }): React.ReactElement {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const plan = useQuery({
    queryKey: ['manifest-repair-plan'],
    queryFn: () => api.manifestRepairPlan(),
    enabled: open,
    staleTime: Infinity,
    retry: false,
  })
  const apply = useMutation({
    mutationFn: () => api.manifestRepairApply(plan.data!.beforeHash),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['validation'] }),
  })
  return (
    <section className="defect-group">
      <button className="defect-group-title linkish" onClick={() => setOpen(!open)} aria-expanded={open}>
        The address map
        <span className="dim">{open ? ' - hide' : ' - check it'}</span>
      </button>
      {open && (
        <div className="repair-panel">
          {plan.data === undefined ? (
            <span className="dim">Reading the map…</span>
          ) : (
            <div className="repair-body">
              <p>{plan.data.summary}.</p>
              {plan.data.unnamedDirs.length > 0 && (
                <p className="defect-limit">
                  {plan.data.unnamedDirs.length} job director{plan.data.unnamedDirs.length === 1 ? 'y is' : 'ies are'} named
                  in no source entry. No repair can reach those: what a job directory held is not derivable from the
                  directory, and inventing it would be inventing provenance. They stay a decision.
                </p>
              )}
              {plan.data.changes ? (
                <>
                  <p className="defect-limit">
                    This writes the WHOLE map, not a selection: it fixes every drift it has, including entries the list
                    never showed. One commit of its own.
                  </p>
                  <button className="btn" disabled={readOnly || apply.isPending} onClick={() => apply.mutate()}>
                    {apply.isPending ? 'Writing…' : 'Repair the map'}
                  </button>
                  {apply.data !== undefined && (
                    <p className="defect-note">
                      {apply.data.stale
                        ? 'The map changed since this was planned; nothing was written. Check it again.'
                        : apply.data.written
                          ? `Written${apply.data.commit?.hash ? `, commit ${apply.data.commit.hash.slice(0, 8)}` : ', not committed'}.`
                          : 'Nothing to write.'}
                    </p>
                  )}
                </>
              ) : (
                <p className="defect-note">Nothing in the map to repair.</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export function StandingDefects({ vaultName, readOnly = false }: { vaultName: string; readOnly?: boolean }): React.ReactElement | null {
  const [rule, setRule] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  /** The third block is collapsed by default: it is a record, not a working list. */
  const [showAccepted, setShowAccepted] = useState(false)
  /** The repair being planned, if any. One at a time: the server plans one per rule anyway. */
  const [repair, setRepair] = useState<RepairTarget | null>(null)
  /** The finding being repaired by a bound run, if any. One page per run (decision 10). */
  const [runFor, setRunFor] = useState<StandingFinding | null>(null)
  const list = useQuery({
    queryKey: ['validation', rule, limit],
    queryFn: () => api.validation({ ...(rule === null ? {} : { rule }), limit }),
    staleTime: 30_000,
  })
  /*
   * The accepted rows, asked for only once the block is open. They are off every other query
   * by construction (`list()` excludes them), so this is the one place they come from.
   */
  const acceptedQ = useQuery({
    queryKey: ['validation', 'accepted'],
    queryFn: () => api.validation({ accepted: true, limit: 200 }),
    enabled: showAccepted,
    staleTime: 30_000,
  })
  const data = list.data
  const state = queryState(list, 'the standing defects')
  if (data === undefined) return <div className="sc-body">{state ?? <span className="dim">Reading the defect list…</span>}</div>

  const guidance = data.guidance
  const shown = data.findings
  const blocks = splitBlocks(shown, guidance)
  const groups = BLOCKS.map((b) => ({ ...b, rows: blocks[b.id] }))
  // What the filter is looking at, so "show more" knows whether there is more to ask for.
  const filtered = rule === null ? data.total : (data.byRule.find((r) => r.rule === rule)?.findings ?? 0)

  return (
    <div className="sc-body">
      {data.total === 0 ? (
        <div className="empty">Nothing standing. Every defect the validator has looked for is clear.</div>
      ) : (
        <>
          <div className="defect-rules">
            <button className={`chip${rule === null ? ' active' : ''}`} onClick={() => setRule(null)}>
              all
            </button>
            {data.byRule.map((r) => (
              <button
                key={r.rule}
                className={`chip${rule === r.rule ? ' active' : ''}`}
                onClick={() => {
                  setRule(rule === r.rule ? null : r.rule)
                  setLimit(PAGE)
                }}
              >
                {r.rule} <span className="chip-n">{r.findings}</span>
              </button>
            ))}
          </div>
          {/*
            "Fix all N" (decision 5), on the narrowed rule rather than on every chip: the ids it
            passes are the ones currently listed, so what the button promises is what the screen
            is showing. The cap is the route's; a rule with more findings than that is worked in
            pages, which is what "show more" is for.
          */}
          {rule !== null && guidance?.[rule]?.path === 'pass' && shown.length > 0 && (
            <button
              className="btn"
              disabled={readOnly}
              onClick={() => setRepair({ rule, ids: shown.slice(0, FIX_ALL_CAP).map((f) => f.id), label: `Fix ${Math.min(shown.length, FIX_ALL_CAP)} ${rule} finding(s)` })}
            >
              Fix all {Math.min(shown.length, FIX_ALL_CAP)}
            </button>
          )}
          {repair !== null && (
            <RepairPanel
              target={repair}
              guidance={guidance?.[repair.rule]}
              readOnly={readOnly}
              onClose={() => setRepair(null)}
            />
          )}
          {runFor !== null && (
            <DefectFixRun
              finding={runFor}
              guidance={guidance?.[runFor.rule]}
              readOnly={readOnly}
              onClose={() => setRunFor(null)}
            />
          )}
          {groups.map((g) =>
            g.rows.length === 0 ? null : (
              <section className="defect-group" key={g.id}>
                <h4 className="defect-group-title">
                  {g.title} <span className="chip-n">{g.rows.length}</span>
                  <Tip text={g.hint} />
                </h4>
                {g.rows.map((f) => (
                  <DefectRow
                    key={f.id}
                    finding={f}
                    guidance={guidance?.[f.rule]}
                    vaultName={vaultName}
                    readOnly={readOnly}
                    onFix={
                      guidance?.[f.rule]?.path === 'pass'
                        ? () => setRepair({ rule: f.rule, ids: [f.id], label: `Fix one ${f.rule} finding` })
                        : undefined
                    }
                    onRun={
                      // A run only where the rule has one AND the server has not blocked this
                      // particular row - which is the notebook condition, and holds with the
                      // flag off too, where there is no Fellow to ask.
                      guidance?.[f.rule]?.path === 'run' && f.fixBlock?.fixable !== false ? () => setRunFor(f) : undefined
                    }
                  />
                ))}
              </section>
            ),
          )}
          {shown.length < filtered && (
            <button className="btn" onClick={() => setLimit(Math.min(limit + PAGE, 200))}>
              Show more ({filtered - shown.length} further)
            </button>
          )}
        </>
      )}
      {/*
        The address map, always offered: it is whole-vault and its rows are decisions, so it
        belongs beside the list rather than inside a row.
      */}
      <ManifestRepair readOnly={readOnly} />
      {/*
        The third block (decision 9), outside the `total === 0` branch on purpose: a vault whose
        standing list is empty because every finding was accepted must still show what was
        accepted, or the record disappears exactly when it matters most.
      */}
      {(data.accepted ?? 0) > 0 && (
        <section className="defect-group">
          <button className="defect-group-title linkish" onClick={() => setShowAccepted(!showAccepted)} aria-expanded={showAccepted}>
            Accepted <span className="chip-n">{data.accepted}</span>
            <span className="dim">{showAccepted ? ' - hide' : ' - show'}</span>
          </button>
          {showAccepted &&
            (acceptedQ.data === undefined ? (
              <span className="dim">Reading the accepted findings…</span>
            ) : (
              acceptedQ.data.findings.map((f) => <AcceptedRow key={f.id} finding={f} disabled={readOnly} />)
            ))}
        </section>
      )}
    </div>
  )
}
