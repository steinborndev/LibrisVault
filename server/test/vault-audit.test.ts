import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addressIntegrity,
  auditVault,
  classifyDeadLink,
  parseFrontmatter,
  parseWikilinks,
  tagMirroring,
  redactReport,
} from '../../scripts/vault-audit.mjs'

/**
 * The measurement harness behind every "the number is now zero" in docs/tasks/TASKS-VAULT-LAYER.md.
 *
 * It runs against a FIXTURE vault, never the real one: the real vault is private, it is 1247
 * pages, and it changes while the suite runs. The fixture carries one planted instance of each
 * defect class, so a classifier that stops firing fails here rather than silently reporting a
 * clean vault.
 */
const FIXTURE = path.resolve(fileURLToPath(new URL('./fixtures/audit-vault', import.meta.url)))

describe('classifyDeadLink', () => {
  it('names the mechanical causes and nothing else', () => {
    expect(classifyDeadLink('Beta: Gamma')).toBe('colon')
    expect(classifyDeadLink('concepts/Nope')).toBe('slash')
    expect(classifyDeadLink('Epsilon (E)\\')).toBe('trailing-backslash')
    expect(classifyDeadLink('Missing Page')).toBe('other')
  })

  it('reads a trailing backslash before a colon or a slash, because it is the outer defect', () => {
    // `[[Foo: Bar/Baz\]]` is a line-wrap escape around a title that also carries punctuation.
    // Joining the link back is the repair; the punctuation is a separate one.
    expect(classifyDeadLink('Foo: Bar/Baz\\')).toBe('trailing-backslash')
  })
})

describe('tagMirroring', () => {
  it('sees a tag that repeats the page type, including its plural', () => {
    expect(tagMirroring('concept', 'physics', ['concept', 'optics']).type).toBe(true)
    expect(tagMirroring('concept', 'physics', ['concepts', 'optics']).type).toBe(true)
    expect(tagMirroring('entity', 'physics', ['Entity']).type).toBe(true)
  })

  it('sees a tag that repeats the domain', () => {
    expect(tagMirroring('concept', 'machine-learning', ['machine-learning']).domain).toBe(true)
    expect(tagMirroring('concept', 'machine learning', ['machine-learning']).domain).toBe(true)
  })

  it('stays silent on a tag that carries information', () => {
    const m = tagMirroring('concept', 'physics', ['optics', 'interferometry'])
    expect(m.type).toBe(false)
    expect(m.domain).toBe(false)
  })

  it('does not guess synonyms: a near word is not a mirror', () => {
    // Deliberate limit. "Which words mean the same as this domain" is a judgement, and a
    // harness that makes it silently reports a number nobody can check.
    expect(tagMirroring('concept', 'biomedicine', ['biomedical']).domain).toBe(false)
  })

  it('handles a page with no type or domain at all', () => {
    expect(tagMirroring(null, null, ['anything'])).toEqual({ type: false, domain: false })
  })
})

describe('addressIntegrity', () => {
  const base = {
    pages: [
      { rel: 'wiki/concepts/A.md', address: 'c-000001' },
      { rel: 'wiki/concepts/B.md', address: 'c-000002' },
    ],
    map: { 'wiki/concepts/A.md': 'c-000001' },
    sources: { '.raw/job-a/in.pdf': { pages_created: ['wiki/concepts/A.md'] } },
    rawDirs: ['job-a', 'job-b'],
    pageExists: (rel: string) => rel === 'wiki/concepts/A.md' || rel === 'wiki/concepts/B.md',
  }

  it('walks the direction nothing ever walked: page to map', () => {
    const r = addressIntegrity(base)
    expect(r.pagesWithAddress).toBe(2)
    expect(r.mapEntries).toBe(1)
    expect(r.missingFromMap).toEqual(['wiki/concepts/B.md'])
  })

  it('still walks map to page: an entry pointing nowhere, and one that disagrees', () => {
    const r = addressIntegrity({
      ...base,
      map: {
        'wiki/concepts/A.md': 'c-000999',
        'wiki/concepts/Gone.md': 'c-000003',
      },
    })
    expect(r.staleMapEntries).toEqual(['wiki/concepts/Gone.md'])
    expect(r.divergent).toEqual(['wiki/concepts/A.md'])
  })

  it('finds a job directory named in no source, and a page_created that is gone', () => {
    const r = addressIntegrity({
      ...base,
      sources: { '.raw/job-a/in.pdf': { pages_created: ['wiki/concepts/A.md', 'wiki/concepts/Gone.md'] } },
    })
    expect(r.orphanRawDirs).toEqual(['job-b'])
    expect(r.danglingPagesCreated).toEqual([{ source: '.raw/job-a/in.pdf', page: 'wiki/concepts/Gone.md' }])
  })

  it('reports two pages holding one address', () => {
    const r = addressIntegrity({
      ...base,
      pages: [
        { rel: 'wiki/concepts/A.md', address: 'c-000001' },
        { rel: 'wiki/concepts/B.md', address: 'c-000001' },
      ],
    })
    expect(r.duplicates).toEqual([['c-000001', ['wiki/concepts/A.md', 'wiki/concepts/B.md']]])
    expect(r.maxAddress).toBe(1)
  })

  it('treats a missing manifest as a vault with no map rather than throwing', () => {
    const r = addressIntegrity({ ...base, map: undefined, sources: undefined })
    expect(r.mapEntries).toBe(0)
    expect(r.missingFromMap).toHaveLength(2)
    expect(r.orphanRawDirs).toEqual(['job-a', 'job-b'])
  })
})

describe('the readers the counts rest on', () => {
  it('reads flat frontmatter and keeps list order with duplicates intact', () => {
    const fm = parseFrontmatter('---\ntype: concept\ntags:\n  - a\n  - a\n  - b\n---\n\n# X\n')
    expect(fm.fields.get('type')).toBe('concept')
    expect(fm.lists.get('tags')).toEqual(['a', 'a', 'b'])
  })

  it('counts a link quoted inside code, because a reader can still click it', () => {
    expect(parseWikilinks('text `[[Quoted]]` and [[Plain]]')).toEqual(['Quoted', 'Plain'])
  })

  it('strips an alias and a heading anchor, and unescapes a table pipe', () => {
    expect(parseWikilinks('[[Page|Alias]] [[Page#Heading]] [[Page\\|In A Table]]')).toEqual([
      'Page',
      'Page',
      'Page',
    ])
  })
})

describe('auditVault over the fixture', () => {
  const report = auditVault(FIXTURE, { now: '2026-01-10' })

  /*
   * The fixture has to survive a fresh clone, and once it did not.
   *
   * `.raw/job-a/` and `.raw/job-b/` each held an `input.pdf`, and the repo ignores `*.pdf`
   * outright - a deliberate guard, since this repo is public and the vault is not. So the two
   * directories were never committed, and git stores no empty directory: they existed on the
   * machine that wrote them and nowhere else. Locally the suite was green and CI failed with
   * `expected [] to deeply equal [ 'job-b' ]`, which says nothing about the cause.
   *
   * This check runs first and names it. A fixture that a checkout cannot reproduce is not a
   * fixture, and the assertion that catches it should say so rather than leaving the reader to
   * infer it from a missing array element.
   */
  it('is reproducible from a checkout', () => {
    for (const rel of ['.raw/job-a/input.txt', '.raw/job-b/input.txt']) {
      expect(fs.existsSync(path.join(FIXTURE, rel)), `${rel} missing - is it caught by a .gitignore rule?`).toBe(true)
    }
  })

  it('counts pages by bucket and separates content from navigation', () => {
    expect(report.pages.total).toBe(9)
    expect(report.pages.content).toBe(4)
    expect(report.pages.byBucket).toEqual({ concepts: 3, entities: 1 })
  })

  it('classifies every planted dead link by cause', () => {
    expect(report.links.dead.byCause).toMatchObject({
      colon: 3,
      slash: 1,
      'trailing-backslash': 1,
    })
    // The service's resolver knows frontmatter titles, so the colon class is live for it and
    // dead for the reader. That gap is the repair backlog, and it has to stay visible.
    expect(report.links.dead.asTheServiceResolves).toBeLessThan(report.links.dead.occurrences)
  })

  it('finds both directions of the address map plus the raw-directory gaps', () => {
    expect(report.addresses.missingFromMap).toHaveLength(2)
    expect(report.addresses.staleMapEntries).toHaveLength(1)
    expect(report.addresses.divergent).toHaveLength(1)
    expect(report.addresses.duplicates).toHaveLength(1)
    expect(report.addresses.orphanRawDirs).toEqual(['job-b'])
    expect(report.addresses.danglingPagesCreated).toHaveLength(1)
  })

  it('sees the dated event section in the index and the run-protocol sections on pages', () => {
    const index = report.hubs.find((h) => h.path === 'wiki/index.md')
    expect(index?.datedSections).toBe(1)
    expect(report.runProtocol.pagesCarrying).toBe(2)
    expect(Object.keys(report.runProtocol.byHeading).sort()).toEqual(['editorialNote', 'statusOfThisPage'])
  })

  it('separates a contradiction that is open from one that says none', () => {
    expect(report.style.contradictions.sections).toBe(2)
    expect(report.style.contradictions.withContent).toBe(1)
  })

  it('counts em-dashes and the pages carrying them', () => {
    expect(report.style.emDash).toEqual({ occurrences: 2, pages: 1 })
  })

  it('reports the page that no hub links to', () => {
    expect(report.reachability.notInIndex).toEqual(['wiki/entities/Someone.md'])
    expect(report.reachability.notInAnyHub).toEqual(['wiki/entities/Someone.md'])
  })

  it('leaves git out when the vault is not its own repository', () => {
    // The fixture lives inside THIS repo. Reporting this repo's history as the vault's would
    // be a number that looks right and means nothing.
    expect(report.history).toBeNull()
    expect(report.git).toBeNull()
    expect(report.meta.head).toBeNull()
  })

  it('writes nothing: the same run twice is byte-identical apart from the timestamp', () => {
    const again = auditVault(FIXTURE, { now: '2026-01-10' })
    expect({ ...again, meta: null }).toEqual({ ...report, meta: null })
  })
})

describe('redactReport', () => {
  const report = auditVault(FIXTURE, { now: '2026-01-10' })
  const red = redactReport(report)

  it('drops every path, title and tag, and keeps the numbers', () => {
    const json = JSON.stringify(red)
    expect(json).not.toContain('Someone')
    expect(json).not.toContain('Beta')
    expect(json).not.toContain('alpha-only')
    expect(json).not.toContain(FIXTURE)
    expect(red.reachability.notInAnyHub).toBe(1)
    expect(red.addresses.missingFromMap).toBe(2)
    expect(red.pages.total).toBe(9)
  })

  it('keeps structural labels, which say nothing about what the vault holds', () => {
    expect(red.pages.byBucket).toEqual({ concepts: 3, entities: 1 })
    expect(Object.keys(red.pages.byType)).toContain('concept')
  })

  it('folds an unknown status value into a bucket rather than printing it', () => {
    const odd = redactReport({
      ...report,
      pages: { ...report.pages, status: { developing: 2, 'some-freetext-status': 3 } },
    })
    expect(odd.pages.status).toEqual({ developing: 2, '(other)': 3 })
  })

  it('does not mutate the report it was handed', () => {
    expect(Array.isArray(report.reachability.notInAnyHub)).toBe(true)
  })
})
