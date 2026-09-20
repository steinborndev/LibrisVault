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
