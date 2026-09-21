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
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { DefectGuidance, StandingFinding } from '../api/types.ts'
import { splitBlocks, subjectLink, provenanceOf, type DefectBlockId } from '../lib/defectList.ts'
import { PageLink } from './PageLink.tsx'
import { Tip } from './Tip.tsx'
import { queryState } from './QueryState.tsx'
import { navigate } from '../lib/router.ts'

/** One page of rows. The route caps at 200; "show more" walks it in steps of this. */
const PAGE = 50

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

/** One row: the closed line, and everything the open one adds. */
function DefectRow({
  finding,
  guidance,
  vaultName,
}: {
  finding: StandingFinding
  guidance: DefectGuidance | undefined
  vaultName: string
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

export function StandingDefects({ vaultName }: { vaultName: string }): React.ReactElement | null {
  const [rule, setRule] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const list = useQuery({
    queryKey: ['validation', rule, limit],
    queryFn: () => api.validation({ ...(rule === null ? {} : { rule }), limit }),
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
          {groups.map((g) =>
            g.rows.length === 0 ? null : (
              <section className="defect-group" key={g.id}>
                <h4 className="defect-group-title">
                  {g.title} <span className="chip-n">{g.rows.length}</span>
                  <Tip text={g.hint} />
                </h4>
                {g.rows.map((f) => (
                  <DefectRow key={f.id} finding={f} guidance={guidance?.[f.rule]} vaultName={vaultName} />
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
    </div>
  )
}
