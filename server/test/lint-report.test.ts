/**
 * Reading a lint report (vault contract 2).
 *
 * The skill's format drifted and the parser did not notice, which is the exact failure the
 * contract exists to catch: on 2026-09-20 the report stated 101 dead links, 29 frontmatter
 * gaps and 155 dash violations, and the maintenance view showed 4, 3 and 0. Two independent
 * causes, both fixed here and both pinned below - a summary total with anything after the
 * number was dropped, and a section's defects were counted by how many bullets it had while
 * the skill had moved to prose that groups them into patterns.
 *
 * Every report body here is invented (hard rule 7).
 */

import { describe, it, expect } from 'vitest'
import { parseLintReport } from '../src/pipeline/lint-report.js'
import type { Citation } from '../src/pipeline/citations.js'

const noResolve = (label: string): Citation => ({ label, path: null })
const parse = (md: string) => parseLintReport(md, noResolve)

describe('the summary block', () => {
  it('reads a total that has something after the number', () => {
    const r = parse(
      [
        '# Lint Report: 2026-09-20',
        '',
        '## Summary',
        '- Pages scanned: 1332',
        '- Dead links: 101 (78 distinct targets)',
        '- Frontmatter gaps: 29 (3 of them YAML parse errors)',
        '- Explicit callouts: 28 pages',
        '- Address integrity: clean except 3 mismatches',
        '',
      ].join('\n'),
    )
    expect(r.summary).toMatchObject({
      'Pages scanned': 1332,
      'Dead links': 101,
      'Frontmatter gaps': 29,
      'Explicit callouts': 28,
    })
    // A line that states no number at all states no total.
    expect(r.summary['Address integrity']).toBeUndefined()
  })
})

describe('what a section counts', () => {
  const body = (section: string, lines: readonly string[]): string =>
    ['# Lint Report: 2026-09-20', '', '## Summary', '- Dead links: 101 (78 distinct targets)', '', `## ${section}`, ...lines, ''].join('\n')

  it('takes the number the summary states, not the bullets it has', () => {
    const r = parse(
      body('Dead Links', ['101 unresolved wikilink targets across 78 distinct texts. They cluster into:', '', '- Canvas name mismatches', '- Title drift']),
    )
    const dead = r.sections.find((s) => s.title === 'Dead Links')!
    expect(dead.count).toBe(101)
    expect(dead.findings).toHaveLength(2)
  })

  it('matches a summary key to a section title across wording drift', () => {
    const md = [
      '# Lint Report: 2026-09-20',
      '',
      '## Summary',
      '- Em/en-dash house-style violations: 155 pages',
      '',
      '## House Style: Em/En-Dash Violations',
      'Listed in the appendix.',
      '',
    ].join('\n')
    expect(parse(md).sections[0]!.count).toBe(155)
  })

  it('falls back to the number the section opens with', () => {
    const md = ['# Lint Report: 2026-09-20', '', '## Stale Claims', '17 pages carry an "as of" older than a year.', '', '- one example', ''].join('\n')
    expect(parse(md).sections[0]!.count).toBe(17)
  })

  it('falls back to the bullets when nothing states a number', () => {
    const md = ['# Lint Report: 2026-09-20', '', '## Missing Pages', '- [[One]]', '- [[Two]]', ''].join('\n')
    expect(parse(md).sections[0]!.count).toBe(2)
  })

  it('finds the summary line of a section whose every word is a common one', () => {
    // "Missing" and "pages" were both stop words, which left this title with nothing to match
    // on and the count falling through to however many bullets the section happened to have.
    const md = [
      '# Lint Report: 2026-09-20',
      '',
      '## Summary',
      '- Missing pages (manual grouping): 6 concept gaps + 2 contradictions',
      '',
      '## Missing Pages',
      '- [[One]]',
      '- [[Two]]',
      '',
    ].join('\n')
    expect(parse(md).sections[0]!.count).toBe(6)
  })

  it('matches a summary key that overlaps the section title only in part', () => {
    // Neither side contains the other: "validation" is absent left, "errors" right.
    const md = [
      '# Lint Report: 2026-09-20',
      '',
      '## Summary',
      '- Address counter errors: 12',
      '',
      '## Address Counter Validation',
      '- one example',
      '',
    ].join('\n')
    expect(parse(md).sections[0]!.count).toBe(12)
  })

  it('reads an opening number only where the section opens', () => {
    // A bare number deep in a section belongs to a sub-list, not to the section.
    const md = [
      '# Lint Report: 2026-09-20',
      '',
      '## Stale Claims',
      'Grouped by cause below.',
      '',
      '- one example',
      '40 pages were checked in total.',
      '',
    ].join('\n')
    expect(parse(md).sections[0]!.count).toBe(1)
  })

  it('does not count a lint-fix log as open defects', () => {
    const md = [
      '# Lint Report: 2026-09-20',
      '',
      '## Dead Links',
      '4 unresolved targets.',
      '',
      '## Auto-fix run',
      '- fixed one frontmatter gap',
      '- fixed another',
      '',
    ].join('\n')
    const r = parse(md)
    // The section is still there to read; it just is not a defect count.
    expect(r.sections.map((s) => s.title)).toContain('Auto-fix run')
    expect(r.totalFindings).toBe(4)
  })
})

describe('a count with no section to show it', () => {
  const md = (...summary: readonly string[]): string =>
    ['# Lint Report: 2026-09-20', '', '## Summary', ...summary, '', '## Dead Links', '4 unresolved targets.', ''].join('\n')

  it('counts a defect category the report states and then never writes up', () => {
    const r = parse(md('- Dead links: 4', '- Domain-field gaps: 9'))
    expect(r.extras).toEqual({ 'Domain-field gaps': 9 })
    expect(r.totalFindings).toBe(13)
  })

  it('leaves out what describes the run rather than the vault', () => {
    const r = parse(md('- Dead links: 4', '- Pages scanned: 1337', '- Auto-fixed: 2'))
    expect(r.extras).toEqual({})
    expect(r.totalFindings).toBe(4)
  })

  it('leaves out the report\'s own sum of its sections', () => {
    // "Issues found" counts defects by any wording test, and adding it to the sections that
    // make it up counts the whole report twice.
    const r = parse(md('- Dead links: 4', '- Issues found: 4'))
    expect(r.extras).toEqual({})
    expect(r.totalFindings).toBe(4)
  })

  it('says nothing about a category that found nothing', () => {
    expect(parse(md('- Dead links: 4', '- Stale index entries: 0')).extras).toEqual({})
  })
})
