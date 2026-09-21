/**
 * How the standing defect list is read, as pure functions (TASKS-DEFECT-PATHS phase 1).
 *
 * Same shape as `maintenanceStatus.ts` and for the same reason: the two decisions that matter
 * here - which block a row belongs in, and what a row links to - are the ones worth holding to
 * a test, and a component that owns them can only be tested through a DOM. The component
 * renders what these return.
 */

import type { DefectGuidance, StandingFinding } from '../api/types.ts'

/** The blocks a reader works, in order. `accepted` is phase 2 and empty until then. */
export type DefectBlockId = 'fixable' | 'decision' | 'accepted'

/**
 * Which block a finding belongs in.
 *
 * `pass` and `run` are both FIXABLE: the first question a person has is "what can I get rid of
 * without thinking about it", and from that side a deterministic pass and a bound run on one
 * page are the same answer - press it. What separates them is cost, which the row states.
 *
 * Unknown rules fall to `decision`. A rule the server has not classified is exactly a rule
 * nobody has decided about, and offering a button for it would be the guess this whole
 * classification exists to avoid.
 */
export function blockOf(rule: string, guidance: Record<string, DefectGuidance> | undefined): DefectBlockId {
  const path = guidance?.[rule]?.path
  return path === 'pass' || path === 'run' ? 'fixable' : 'decision'
}

/** What a row links to, or why it cannot link anywhere. */
export type SubjectLink =
  | { readonly kind: 'page'; readonly path: string }
  | { readonly kind: 'job'; readonly jobId: string; readonly href: string }
  | { readonly kind: 'none'; readonly why: string }

/**
 * Where a row points.
 *
 * A `.raw/<job-id>/` finding names its job by the DIRECTORY NAME, which is the job id. Never by
 * `lastJobId`: that holds whichever run last REPORTED the finding, which is a maintenance run's
 * id as often as a job's - measured 2026-09-21, 18 of 57 rows carried one, and none of the four
 * `.raw/` rows had a `lastJobId` equal to its own directory. A job the history no longer holds
 * says so rather than rendering a link that goes nowhere.
 */
export function subjectLink(finding: StandingFinding): SubjectLink {
  const subject = finding.subject
  if (subject === undefined) {
    return finding.path.startsWith('wiki/') && finding.path.endsWith('.md')
      ? { kind: 'page', path: finding.path }
      : { kind: 'none', why: finding.path }
  }
  if (subject.kind === 'page') return { kind: 'page', path: subject.path }
  if (subject.kind === 'job') {
    return subject.exists
      ? { kind: 'job', jobId: subject.jobId, href: `/?job=${encodeURIComponent(subject.jobId)}` }
      : { kind: 'none', why: `job ${subject.jobId.slice(0, 8)} - the job history no longer holds this run` }
  }
  return { kind: 'none', why: subject.why }
}

/** The findings grouped into blocks, each keeping the list's own order. */
export function splitBlocks(
  findings: readonly StandingFinding[],
  guidance: Record<string, DefectGuidance> | undefined,
): Record<DefectBlockId, StandingFinding[]> {
  const out: Record<DefectBlockId, StandingFinding[]> = { fixable: [], decision: [], accepted: [] }
  for (const f of findings) out[blockOf(f.rule, guidance)].push(f)
  return out
}

/** How the provenance line reads: never a link, always named for what it is. */
export function provenanceOf(finding: StandingFinding): string {
  if (finding.lastJobId === null) return 'a run that left no id'
  return `${finding.lastJobId.slice(0, 8)}${finding.lastJobExists === true ? '' : ' (no longer in the history)'}`
}
