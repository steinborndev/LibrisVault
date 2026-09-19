import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  renderIndex,
  collectPages,
  pageLink,
  SERVICE_OWNED_HUBS,
  renderLogEntry,
  narrativeOf,
  prependLogEntry,
  LOG_NARRATIVE_CAP,
} from '../src/pipeline/hubs.js'

/**
 * The generated catalog (D2). The property that carries the whole design is IDEMPOTENCE: an
 * index derived from frontmatter is overwritten by the next run rather than having to be
 * protected from an agent, and a render that changed every time would be exactly the history
 * churn this replaces - 83 % of the wiki's git history was six hub files being rewritten whole.
 */
let vault: string

const page = (rel: string, fm: Record<string, string>, body = 'Body.\n'): void => {
  const abs = path.join(vault, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`)
  fs.writeFileSync(abs, `---\n${lines.join('\n')}\n---\n\n# ${path.basename(rel, '.md')}\n\n${body}`)
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hubs-'))
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true })
  page('wiki/concepts/Alpha.md', { type: 'concept', title: '"Alpha"', domain: 'physics', address: 'c-000001', created: '2026-01-01', updated: '2026-01-03' })
  page('wiki/concepts/Beta.md', { type: 'concept', title: '"Beta"', domain: 'cooking', address: 'c-000002', created: '2026-01-02', updated: '2026-01-02' })
  page('wiki/entities/Someone.md', { type: 'entity', title: '"Someone"', domain: 'physics', address: 'c-000003', created: '2026-01-01', updated: '2026-01-01' })
  page('wiki/sources/A Paper.md', { type: 'source', title: '"A Paper"', domain: 'physics', created: '2026-01-01', updated: '2026-01-01' })
})

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true })
})

describe('renderIndex', () => {
  it('renders the same bytes twice over an unchanged vault', () => {
    const first = renderIndex(vault)
    const second = renderIndex(vault)
    expect(second).toBe(first)
  })

  it('groups by domain and then by type, with computed counters', () => {
    const out = renderIndex(vault)
    expect(out).toContain('**4 pages** across 2 domains: 2 concepts, 1 entities, 1 sources.')
    expect(out).toContain('## physics (3)')
    expect(out).toContain('## cooking (1)')
    // Without a registry the domains fall back to alphabetical, so cooking comes first and
    // the physics section runs to the end of the file.
    expect(out.indexOf('## cooking')).toBeLessThan(out.indexOf('## physics'))
    const physics = out.slice(out.indexOf('## physics'))
    expect(physics.indexOf('### Concepts')).toBeLessThan(physics.indexOf('### Entities'))
    expect(physics.indexOf('### Entities')).toBeLessThan(physics.indexOf('### Sources'))
  })

  it('puts a new page in its group without touching anything else', () => {
    const before = renderIndex(vault)
    page('wiki/concepts/Gamma.md', { type: 'concept', title: '"Gamma"', domain: 'physics', address: 'c-000004', created: '2026-01-04', updated: '2026-01-04' })
    const after = renderIndex(vault)
    expect(after).toContain('- [[Gamma]] `c-000004`')
    expect(after).toContain('## physics (4)')
    // Everything else is unchanged: this is what makes the diff of a run's commit readable.
    const removed = before.split('\n').filter((l) => !after.includes(l))
    expect(removed).toEqual(['updated: 2026-01-03', '**4 pages** across 2 domains: 2 concepts, 1 entities, 1 sources.', '## physics (3)'])
  })

  it('lists a page whose frontmatter cannot be read instead of dropping it', () => {
    fs.writeFileSync(path.join(vault, 'wiki/concepts/Broken.md'), '# Broken\n\nNo frontmatter at all.\n')
    fs.writeFileSync(path.join(vault, 'wiki/concepts/Typeless.md'), '---\ntitle: "Typeless"\n---\n\n# Typeless\n')
    const out = renderIndex(vault)
    expect(out).toContain('## Unfiled (2)')
    expect(out).toContain('`wiki/concepts/Broken.md` - no frontmatter block')
    expect(out).toContain('`wiki/concepts/Typeless.md` - no type: in frontmatter')
    // The counters count what is filed; the unfiled section is what says the rest exists.
    expect(out).toContain('**4 pages**')
  })

  it('carries no dated event section, which is what made the index a second changelog', () => {
    const out = renderIndex(vault)
    const headings = out.split('\n').filter((l) => l.startsWith('## '))
    expect(headings.filter((h) => /\d{4}-\d{2}-\d{2}/.test(h))).toEqual([])
  })

  it('dates itself from the content, never from the clock', () => {
    // The newest `updated:` any page states. A timestamp here would make every render a
    // different file, and the whole design rests on two renders being identical.
    expect(renderIndex(vault)).toContain('updated: 2026-01-03')
    page('wiki/concepts/Later.md', { type: 'concept', title: '"Later"', domain: 'physics', created: '2026-02-01', updated: '2026-02-09' })
    expect(renderIndex(vault)).toContain('updated: 2026-02-09')
  })

  it('keeps the index\'s own created date across a regeneration', () => {
    fs.writeFileSync(path.join(vault, 'wiki/index.md'), '---\ntype: meta\ncreated: 2025-11-11\nupdated: 2026-01-01\n---\n\n# Wiki Index\n')
    expect(renderIndex(vault)).toContain('created: 2025-11-11')
  })

  it('bounds the related list to the hubs', () => {
    const fm = renderIndex(vault).split('---')[1] ?? ''
    expect(fm).toContain('related:')
    // It used to accumulate every page any run had touched, duplicates included, and nothing
    // ever read it.
    expect((fm.match(/\[\[/g) ?? []).length).toBe(3)
  })

  it('follows the domain registry order when the vault has one', () => {
    const out = renderIndex(vault, { domainOrder: ['cooking', 'physics'] })
    expect(out.indexOf('## cooking')).toBeLessThan(out.indexOf('## physics'))
  })

  it('files a page with no domain under unassigned, and puts that bucket last', () => {
    page('wiki/concepts/Homeless.md', { type: 'concept', title: '"Homeless"', created: '2026-01-01', updated: '2026-01-01' })
    const out = renderIndex(vault, { domainOrder: ['physics', 'cooking'] })
    expect(out).toContain('## unassigned (1)')
    expect(out.lastIndexOf('## unassigned')).toBeGreaterThan(out.lastIndexOf('## cooking'))
  })

  it('renders 1200 pages in well under two seconds', () => {
    for (let i = 0; i < 1200; i++) {
      page(`wiki/concepts/Page ${i}.md`, { type: 'concept', title: `"Page ${i}"`, domain: 'physics', address: `c-${String(i).padStart(6, '0')}`, created: '2026-01-01', updated: '2026-01-01' })
    }
    const started = Date.now()
    const out = renderIndex(vault)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(out).toContain('**1204 pages**')
  })
})

describe('pageLink', () => {
  const base = { rel: 'wiki/concepts/X.md', bucket: 'concepts', domain: 'physics', address: null, updated: null }

  it('links by file name, not by title', () => {
    // The largest dead-link class in this vault is a title the file name cannot carry: the
    // page is filed as `Foo - Bar` and every link written from `Foo: Bar` lands nowhere.
    expect(pageLink({ ...base, name: 'Foo - Bar', title: 'Foo: Bar' })).toBe('[[Foo - Bar|Foo: Bar]]')
  })

  it('writes a plain link when the two agree', () => {
    expect(pageLink({ ...base, name: 'Alpha', title: 'Alpha' })).toBe('[[Alpha]]')
  })

  it('never lets a title split the link', () => {
    expect(pageLink({ ...base, name: 'A', title: 'A|B' })).toBe('[[A|A-B]]')
  })
})

describe('collectPages', () => {
  it('lists content pages only: no hub, no bucket index, no meta page', () => {
    fs.writeFileSync(path.join(vault, 'wiki/index.md'), '---\ntype: meta\n---\n\n# Wiki Index\n')
    page('wiki/concepts/_index.md', { type: 'meta', title: '"Concepts"' })
    page('wiki/meta/agents/Someone.md', { type: 'meta', title: '"A notebook"' })
    const { pages } = collectPages(vault)
    expect(pages.map((p) => p.rel).sort()).toEqual([
      'wiki/concepts/Alpha.md',
      'wiki/concepts/Beta.md',
      'wiki/entities/Someone.md',
      'wiki/sources/A Paper.md',
    ])
  })

  it('names the three hubs the service owns, and leaves the hot cache with the agent', () => {
    // hot.md is a semantic summary no generator can produce; a lost update there costs a
    // cache, not knowledge.
    expect([...SERVICE_OWNED_HUBS]).toEqual(['wiki/index.md', 'wiki/log.md', 'wiki/overview.md'])
    expect(SERVICE_OWNED_HUBS).not.toContain('wiki/hot.md')
  })
})

describe('renderLogEntry', () => {
  const base = { date: '2026-09-19', kind: 'ingest', title: 'A Short Note On Tide Tables' }

  it('renders an ingest: the shape the log has always carried', () => {
    const entry = renderLogEntry({
      ...base,
      source: '.raw/01JOBID/normalized.md',
      created: [
        { rel: 'wiki/sources/A Short Note On Tide Tables.md', address: 'c-001190' },
        { rel: 'wiki/concepts/Tide Table.md', address: 'c-001191' },
      ],
      updated: [{ rel: 'wiki/concepts/Harmonic Analysis.md', address: 'c-000442' }],
      summary: 'Filed one source page and one concept; the harmonic-constants page gained a paragraph.',
    })
    expect(entry).toContain('## [2026-09-19] ingest | A Short Note On Tide Tables')
    // The `.raw` line is load-bearing while crash recovery still falls back to reading this
    // file for it (2.4): the queue decides a crashed job's status by finding it.
    expect(entry).toContain('- Source: `.raw/01JOBID/normalized.md`')
    expect(entry).toContain('- Pages created: [[A Short Note On Tide Tables]] `c-001190`, [[Tide Table]] `c-001191`')
    expect(entry).toContain('- Pages updated: [[Harmonic Analysis]] `c-000442`')
    expect(entry).toContain('the harmonic-constants page gained a paragraph.')
  })

  it('says none rather than leaving a line out, so an entry always answers the same questions', () => {
    const entry = renderLogEntry({ ...base, created: [], updated: [] })
    expect(entry).toContain('- Pages created: none')
    expect(entry).toContain('- Pages updated: none')
  })

  it('names an outcome that is not the ordinary one', () => {
    const dup = renderLogEntry({ ...base, kind: 'ingest', outcome: 'duplicate', source: '.raw/01JOBID/normalized.md' })
    expect(dup).toContain('- Outcome: duplicate')
    // `done` is the default and would be noise on every entry.
    expect(renderLogEntry({ ...base, outcome: 'done' })).not.toContain('- Outcome:')
  })

  it('renders a batch, a research run and a Fellow run in the same shape', () => {
    for (const kind of ['batch ingest', 'research', 'fellow', 'maintenance']) {
      const entry = renderLogEntry({ ...base, kind, title: 'Something', created: [{ rel: 'wiki/concepts/X.md' }] })
      expect(entry.startsWith(`## [2026-09-19] ${kind} | Something`)).toBe(true)
      expect(entry).toContain('- Pages created: [[X]]')
    }
  })

  it('takes a page by name as readily as by path', () => {
    const entry = renderLogEntry({ ...base, created: [{ rel: 'Tide Table' }] })
    expect(entry).toContain('- Pages created: [[Tide Table]]')
  })
})

describe('narrativeOf', () => {
  it('flattens a run report into one paragraph of log prose', () => {
    const answer = '## What I did\n\n- Filed two pages\n- Updated one\n\n```bash\ngit commit\n```\n\nThe second page needed a new address.'
    expect(narrativeOf(answer)).toBe('What I did Filed two pages Updated one The second page needed a new address.')
  })

  it('caps a long answer on a sentence boundary and says it cut', () => {
    const long = `${'One sentence that goes on. '.repeat(80)}End.`
    const out = narrativeOf(long)
    expect(out.length).toBeLessThanOrEqual(LOG_NARRATIVE_CAP + 6)
    expect(out.endsWith('[...]')).toBe(true)
    expect(out).toContain('goes on.')
  })

  it('is empty for a run that said nothing', () => {
    expect(narrativeOf(null)).toBe('')
    expect(narrativeOf('   ')).toBe('')
  })
})

describe('prependLogEntry', () => {
  const head = '---\ntype: meta\n---\n\n# Operation Log\n\nNavigation: [[index]]\n'
  const older = '## [2026-09-18] ingest | Older\n\n- Pages created: none\n'

  it('puts the newest entry first, under the head', () => {
    const out = prependLogEntry(`${head}\n${older}`, '## [2026-09-19] ingest | Newer\n\n- Pages created: none\n')
    expect(out.indexOf('Newer')).toBeLessThan(out.indexOf('Older'))
    expect(out.indexOf('# Operation Log')).toBeLessThan(out.indexOf('Newer'))
  })

  it('keeps the file parseable: frontmatter intact, one blank line between entries', () => {
    const out = prependLogEntry(`${head}\n${older}`, '## [2026-09-19] ingest | Newer\n\n- Pages created: none\n')
    expect(out.startsWith('---\ntype: meta\n---')).toBe(true)
    expect(out).not.toMatch(/\n{3,}/)
    expect(out.split('\n').filter((l) => l.startsWith('## ')).length).toBe(2)
  })

  it('writes the head itself when the log does not exist yet', () => {
    const out = prependLogEntry('', '## [2026-09-19] ingest | First\n\n- Pages created: none\n')
    expect(out).toContain('# Operation Log')
    expect(out).toContain('First')
  })

  it('loses no entry when two renders are applied one after the other', () => {
    // The mutex is what makes them sequential; this is the other half - that applying two
    // entries in a row keeps both, which a naive "write the whole file" would not.
    const first = prependLogEntry(`${head}\n${older}`, renderLogEntry({ date: '2026-09-19', kind: 'ingest', title: 'A' }))
    const second = prependLogEntry(first, renderLogEntry({ date: '2026-09-19', kind: 'ingest', title: 'B' }))
    const titles = second.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.split('| ')[1])
    expect(titles).toEqual(['B', 'A', 'Older'])
  })
})
