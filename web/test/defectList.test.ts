import { describe, it, expect } from 'vitest'
import { blockOf, canAccept, splitBlocks, subjectLink, provenanceOf } from '../src/lib/defectList.ts'
import type { DefectGuidance, StandingFinding } from '../src/api/types.ts'

/**
 * How a defect row is read (TASKS-DEFECT-PATHS phase 1).
 *
 * The two decisions worth a test are which block a row belongs in and what it links to. The
 * second one is where the measurement bit: `lastJobId` is NOT the job a finding is about, and
 * a row that linked to it would have pointed at a maintenance run for 18 of 57 rows.
 */
const guidance = (over: Record<string, DefectGuidance['path']>): Record<string, DefectGuidance> =>
  Object.fromEntries(Object.entries(over).map(([rule, path]) => [rule, { path, what: '', who: '', cost: '' }]))

const finding = (over: Partial<StandingFinding> = {}): StandingFinding => ({
  id: 'f1',
  rule: 'orphan',
  path: 'wiki/concepts/a.md',
  message: 'nothing links here',
  count: 1,
  firstSeen: '2026-09-01T00:00:00.000Z',
  lastSeen: '2026-09-20T00:00:00.000Z',
  lastJobId: null,
  resolvedAt: null,
  ...over,
})

describe('which block a finding belongs in', () => {
  it('counts a deterministic pass and a bound run as the same answer: fixable', () => {
    const g = guidance({ 'em-dash': 'pass', quote: 'run', orphan: 'decision' })
    expect(blockOf('em-dash', g)).toBe('fixable')
    expect(blockOf('quote', g)).toBe('fixable')
    expect(blockOf('orphan', g)).toBe('decision')
  })

  it('falls to a decision for a rule the server has not classified', () => {
    // A rule in no table is exactly a rule nobody decided about, and a button for it would be
    // the guess the classification exists to avoid.
    expect(blockOf('brand-new-rule', guidance({}))).toBe('decision')
    expect(blockOf('em-dash', undefined)).toBe('decision')
  })

  it('splits a list keeping each block in the list’s own order', () => {
    const g = guidance({ 'em-dash': 'pass', orphan: 'decision' })
    const rows = [
      finding({ id: '1', rule: 'orphan' }),
      finding({ id: '2', rule: 'em-dash' }),
      finding({ id: '3', rule: 'orphan' }),
    ]
    const blocks = splitBlocks(rows, g)
    expect(blocks.fixable.map((f) => f.id)).toEqual(['2'])
    expect(blocks.decision.map((f) => f.id)).toEqual(['1', '3'])
    expect(blocks.accepted).toEqual([])
  })
})

describe('what a row links to', () => {
  it('links a page finding to its page', () => {
    expect(subjectLink(finding({ subject: { kind: 'page', path: 'wiki/concepts/a.md' } }))).toEqual({
      kind: 'page',
      path: 'wiki/concepts/a.md',
    })
  })

  it('links a .raw finding to the job its DIRECTORY NAME is', () => {
    const link = subjectLink(
      finding({ path: '.raw/job-42/', lastJobId: 'some-maintenance-run', subject: { kind: 'job', jobId: 'job-42', exists: true } }),
    )
    expect(link).toEqual({ kind: 'job', jobId: 'job-42', href: '/?job=job-42' })
  })

  it('says the history no longer holds the run rather than rendering a dead link', () => {
    const link = subjectLink(finding({ path: '.raw/job-42/', subject: { kind: 'job', jobId: 'job-42', exists: false } }))
    expect(link.kind).toBe('none')
    expect(link.kind === 'none' && link.why).toContain('no longer holds this run')
  })

  it('never uses lastJobId as a link target', () => {
    // The whole point: `lastJobId` is whoever last REPORTED the finding.
    const link = subjectLink(finding({ path: '.raw/job-42/', lastJobId: 'run-abc', subject: { kind: 'job', jobId: 'job-42', exists: true } }))
    expect(JSON.stringify(link)).not.toContain('run-abc')
  })

  it('gives a reason when the finding is about the vault as a whole', () => {
    const link = subjectLink(finding({ path: '.vault-meta/x', subject: { kind: 'none', why: 'about the vault as a whole' } }))
    expect(link).toEqual({ kind: 'none', why: 'about the vault as a whole' })
  })

  it('still resolves a page from an older response that carries no subject', () => {
    // A browser tab open across a service restart holds rows from before the route resolved
    // subjects at all; those must still link rather than render as "no target".
    const old = finding()
    delete (old as { subject?: unknown }).subject
    expect(subjectLink(old).kind).toBe('page')
  })
})

describe('whether a row may be accepted', () => {
  it('is offered on a standing finding', () => {
    expect(canAccept(finding(), false)).toBe(true)
  })

  it('is never offered on a read-only instance: the demo refuses every non-GET anyway', () => {
    expect(canAccept(finding(), true)).toBe(false)
  })

  it('is not offered twice: an accepted row has its own way back', () => {
    expect(canAccept(finding({ acceptedAt: '2026-09-21T00:00:00.000Z' }), false)).toBe(false)
  })
})

describe('the provenance line', () => {
  it('names a run that left no id rather than showing an empty field', () => {
    expect(provenanceOf(finding({ lastJobId: null }))).toBe('a run that left no id')
  })

  it('says when the run that reported it is gone from the history', () => {
    expect(provenanceOf(finding({ lastJobId: 'abcdefghij', lastJobExists: false }))).toContain('no longer in the history')
    expect(provenanceOf(finding({ lastJobId: 'abcdefghij', lastJobExists: true }))).toBe('abcdefgh')
  })
})
