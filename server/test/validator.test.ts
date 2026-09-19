/**
 * validator.ts — the deterministic post-run checks (mechanisms derived from the 2026-07-19
 * lint report): frontmatter gaps, created/updated ordering, DragonScale address rules,
 * dead links (with the lenient whole-vault resolution that killed the report's
 * false-positive classes), orphans, and the address_map consistency check (2c).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  validatePages,
  validateAddressMap,
  validateCounters,
  validateHotCache,
  createValidator,
  HOT_CACHE_WORD_LIMIT,
  HOT_CACHE_RELATED_LIMIT,
  type ValidationFinding,
} from '../src/pipeline/validator.js'
import { GraphBuilder } from '../src/pipeline/graph.js'

let vaultRoot: string

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-'))
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

function write(rel: string, content: string): void {
  const abs = path.join(vaultRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

/** A page with complete frontmatter; `over` overrides/adds fields, `null` drops one. */
/**
 * A page as the rules now define a complete one: the heading floor for its type is part of
 * that since 2026-09-19 (B4), so the default body carries it. A test about a MISSING floor
 * passes its own body.
 */
function page(rel: string, over: Record<string, string | null> = {}, body = 'Body prose.\n\n## Connections\n\nRelated work sits here.\n'): void {
  const fields: Record<string, string | null> = {
    type: 'concept',
    status: 'developing',
    created: '2026-07-01',
    updated: '2026-07-02',
    ...over,
  }
  const scalar = Object.entries(fields)
    .filter(([k, v]) => v !== null && k !== 'tags')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const tags = 'tags' in over ? (over['tags'] === null ? '' : `\ntags: ${over['tags']}`) : '\ntags:\n  - x'
  write(rel, `---\n${scalar}${tags}\n---\n\n${body}`)
}

/** Activates DragonScale Mechanism 2 in the fixture vault. */
function dragonScale(counter = 100, legacyLines: string[] = []): void {
  write('.vault-meta/address-counter.txt', `${counter}\n`)
  write('scripts/allocate-address.sh', '#!/usr/bin/env bash\n')
  write('.vault-meta/legacy-pages.txt', ['# rollout: 2026-04-23', ...legacyLines, ''].join('\n'))
}

const rules = (findings: ValidationFinding[]): string[] => findings.map((f) => f.rule)

describe('source url shape', () => {
  /*
   * The dedupe index and the reading list compare this field literally, so a value that a
   * human can read an address out of is still no address to them. Both shapes below were
   * found on real pages.
   */
  it('flags a value that merely contains an address', () => {
    page('wiki/sources/A.md', { type: 'source', url: '"local file: .raw/j1/x.pdf (example.org/media/123)"' })
    const findings = validatePages(vaultRoot, ['wiki/sources/A.md'])
    expect(rules(findings)).toContain('source-url')
    expect(findings.find((f) => f.rule === 'source-url')?.message).toContain('bare address')
  })

  it('flags a placeholder word', () => {
    page('wiki/sources/B.md', { type: 'source', url: 'unknown' })
    expect(rules(validatePages(vaultRoot, ['wiki/sources/B.md']))).toContain('source-url')
  })

  it('says nothing about a bare address, an empty field, or a page of another type', () => {
    page('wiki/sources/C.md', { type: 'source', url: '"https://example.org/a"' })
    page('wiki/sources/D.md', { type: 'source', url: '""' })
    // Plenty of documents state no address; an empty field is the correct way to say so.
    page('wiki/sources/E.md', { type: 'source' })
    // Only source pages carry an address of their own.
    page('wiki/concepts/F.md', { url: 'see the sources below' })
    const paths = ['wiki/sources/C.md', 'wiki/sources/D.md', 'wiki/sources/E.md', 'wiki/concepts/F.md']
    expect(rules(validatePages(vaultRoot, paths)).filter((r) => r === 'source-url')).toEqual([])
  })
})

describe('frontmatter and dates', () => {
  it('a complete page yields no findings', () => {
    page('wiki/concepts/Alpha.md')
    expect(validatePages(vaultRoot, ['wiki/concepts/Alpha.md'])).toEqual([])
  })

  it('flags missing required fields by name, and a missing frontmatter block outright', () => {
    page('wiki/concepts/Alpha.md', { status: null, tags: null })
    write('wiki/concepts/Bare.md', '# Bare\n\nno frontmatter at all\n')
    const findings = validatePages(vaultRoot, ['wiki/concepts/Alpha.md', 'wiki/concepts/Bare.md'])
    expect(findings).toHaveLength(2)
    expect(findings[0]!.message).toContain('status, tags')
    expect(findings[1]!.message).toContain('no YAML frontmatter')
  })

  it('accepts inline tag lists as tags being present', () => {
    page('wiki/concepts/Alpha.md', { tags: '[a, b]' })
    expect(validatePages(vaultRoot, ['wiki/concepts/Alpha.md'])).toEqual([])
  })

  it('flags created after updated (the hot.md drift class)', () => {
    page('wiki/concepts/Alpha.md', { created: '2026-07-19', updated: '2026-07-18T12:00:00' })
    const findings = validatePages(vaultRoot, ['wiki/concepts/Alpha.md'])
    expect(rules(findings)).toEqual(['dates'])
  })

  it('ignores non-wiki and vanished paths', () => {
    expect(validatePages(vaultRoot, ['.raw/j1/file.pdf', 'wiki/concepts/Gone.md'])).toEqual([])
  })
})

/**
 * The shape a title with a path separator in it makes: a folder named after the first half,
 * and a page inside it named after the second. Found the long way round, weeks later, because
 * every wikilink aimed at the whole title resolved to nothing while the run that wrote it
 * reported a synthesis filed.
 */
describe('pages a folder below their bucket', () => {
  it('flags a page written into a folder inside its bucket', () => {
    page('wiki/questions/Research: A/b.md')
    expect(rules(validatePages(vaultRoot, ['wiki/questions/Research: A/b.md']))).toEqual(['nested-page'])
  })

  it('leaves a page directly in its bucket alone', () => {
    page('wiki/questions/Research: A-b.md')
    expect(validatePages(vaultRoot, ['wiki/questions/Research: A-b.md'])).toEqual([])
  })

  it('leaves wiki/meta alone, where the journals legitimately live in folders', () => {
    page('wiki/meta/recaps/Recap 2026-09-08.md')
    page('wiki/meta/agents/somebody.md')
    expect(validatePages(vaultRoot, ['wiki/meta/recaps/Recap 2026-09-08.md', 'wiki/meta/agents/somebody.md'])).toEqual([])
  })
})

describe('DragonScale addresses', () => {
  it('is entirely inert when the vault has not adopted DragonScale', () => {
    page('wiki/concepts/Alpha.md') // post-rollout, no address
    expect(validatePages(vaultRoot, ['wiki/concepts/Alpha.md'])).toEqual([])
  })

  it('requires an address on post-rollout content pages only', () => {
    dragonScale(100, ['wiki/concepts/Grandfathered.md'])
    page('wiki/concepts/New.md') // created 2026-07-01 >= rollout, no address → error
    page('wiki/concepts/Old.md', { created: '2026-04-01', updated: '2026-04-01' }) // legacy by date
    page('wiki/concepts/Grandfathered.md') // legacy by manifest
    page('wiki/meta/report.md', { type: 'meta' }) // meta excluded
    page('wiki/folds/f1.md', { type: 'fold' }) // folds use fold_id
    const findings = validatePages(vaultRoot, [
      'wiki/concepts/New.md',
      'wiki/concepts/Old.md',
      'wiki/concepts/Grandfathered.md',
      'wiki/meta/report.md',
      'wiki/folds/f1.md',
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'address', path: 'wiki/concepts/New.md' })
  })

  it('validates format, uniqueness, and counter consistency', () => {
    dragonScale(100)
    page('wiki/concepts/Ok.md', { address: 'c-000042' })
    page('wiki/concepts/Legacy.md', { address: 'l-000007' })
    page('wiki/concepts/Malformed.md', { address: 'c-42' })
    page('wiki/concepts/Twin.md', { address: 'c-000042' })
    page('wiki/concepts/Drift.md', { address: 'c-000150' }) // >= counter 100
    const findings = validatePages(vaultRoot, [
      'wiki/concepts/Legacy.md',
      'wiki/concepts/Malformed.md',
      'wiki/concepts/Twin.md',
      'wiki/concepts/Drift.md',
    ])
    expect(rules(findings).sort()).toEqual(['address', 'address', 'address'])
    expect(findings.find((f) => f.path === 'wiki/concepts/Malformed.md')!.message).toContain('malformed')
    expect(findings.find((f) => f.path === 'wiki/concepts/Twin.md')!.message).toContain('wiki/concepts/Ok.md')
    expect(findings.find((f) => f.path === 'wiki/concepts/Drift.md')!.message).toContain('counter')
  })
})

describe('dead links', () => {
  it('flags links that resolve to nothing, with the lenient whole-vault resolution', () => {
    page('wiki/concepts/Beta.md')
    write('skills/wiki-cli/SKILL.md', '# skill\n')
    write('skills/wiki-fold/references/fold-template.md', '# template\n')
    write('Wiki Map.canvas', '{}\n')
    write('wiki/concepts/_index.md', '# index\n')
    page(
      'wiki/concepts/Alpha.md',
      {},
      [
        'A real page link: [[Beta]] and [[beta|case-insensitive alias]].',
        'Path-qualified: [[skills/wiki-cli/SKILL.md]] and [[concepts/_index]].',
        'Basename across the vault: [[fold-template]]; non-md: [[Wiki Map]].',
        'Illustrative, must not flag: `[[Inline Example]]`',
        '```',
        '[[Fenced Example]]',
        '```',
        'Actually dead: [[Nowhere To Be Found]] and [[wiki-cli]].',
        '',
      ].join('\n'),
    )
    const findings = validatePages(vaultRoot, ['wiki/concepts/Alpha.md'])
    // The body is written for the link rules and carries no heading floor, so filter to the
    // rule under test rather than asserting on the whole finding list.
    const dead = findings.filter((f) => f.rule === 'dead-link')
    expect(dead).toHaveLength(2)
    expect(dead[0]!.message).toContain('[[Nowhere To Be Found]]')
    // [[wiki-cli]] is a REAL dead link (the file is SKILL.md — filename-stem resolution fails
    // in Obsidian too); the lint report flagged it, and so do we.
    expect(dead[1]!.message).toContain('[[wiki-cli]]')
  })

  it('resolves a link written as a page frontmatter title or alias, not just its filename', () => {
    // A reference page whose filename ("transport-fallback") differs from its title. The graph
    // resolver treats [[Transport Fallback Decision Tree]] as resolved; the validator must agree.
    page(
      'wiki/references/transport-fallback.md',
      { type: 'reference', title: 'Transport Fallback Decision Tree', aliases: '[Transport Fallback]' },
      'Reference body.\n',
    )
    page('wiki/index.md', { type: 'meta' }, [
      'By title: [[Transport Fallback Decision Tree]].',
      'By alias: [[Transport Fallback]].',
      'By filename still works: [[transport-fallback]].',
      'Genuinely dead: [[No Such Page At All]].',
    ].join('\n'))
    const findings = validatePages(vaultRoot, ['wiki/index.md']).filter((f) => f.rule === 'dead-link')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('[[No Such Page At All]]')
  })

  it('never checks links on lint reports or the append-only log/hot pages', () => {
    page('wiki/meta/lint-report-2026-07-19.md', { type: 'meta' }, 'Finding: [[Deleted Page]] is dead.\n')
    // log.md gets appended to by EVERY ingest — flagging its historical links would repeat
    // the identical findings after every run.
    page('wiki/log.md', { type: 'meta' }, 'Ingested [[Deleted Page]] back in the day.\n')
    page('wiki/hot.md', { type: 'meta' }, 'Recent: [[Deleted Page]].\n')
    expect(
      validatePages(vaultRoot, ['wiki/meta/lint-report-2026-07-19.md', 'wiki/log.md', 'wiki/hot.md']),
    ).toEqual([])
  })
})

describe('orphans (graph-backed)', () => {
  it('flags an unlinked content page, but not meta/_index pages or linked ones', () => {
    page('wiki/concepts/Linked.md')
    page('wiki/concepts/Orphan.md')
    page('wiki/meta/session-notes.md', { type: 'meta' })
    page('wiki/concepts/_index.md', { type: 'meta' }) // full frontmatter — only its orphan-exemption is under test
    write('wiki/index.md', '---\ntype: meta\n---\n[[Linked]]\n')
    const graph = new GraphBuilder(vaultRoot).build()
    const paths = ['wiki/concepts/Linked.md', 'wiki/concepts/Orphan.md', 'wiki/meta/session-notes.md', 'wiki/concepts/_index.md']
    const findings = validatePages(vaultRoot, paths, graph)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'orphan', path: 'wiki/concepts/Orphan.md' })
  })

  it('skips the orphan check when no graph is provided', () => {
    page('wiki/concepts/Orphan.md')
    expect(validatePages(vaultRoot, ['wiki/concepts/Orphan.md'])).toEqual([])
  })

  it('a page linked ONLY from a lint report still counts as an orphan', () => {
    page('wiki/concepts/Orphan.md')
    page('wiki/meta/lint-report-2026-07-19.md', { type: 'meta' }, 'Orphan found: [[Orphan]].\n')
    const graph = new GraphBuilder(vaultRoot).build()
    const findings = validatePages(vaultRoot, ['wiki/concepts/Orphan.md'], graph)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'orphan', path: 'wiki/concepts/Orphan.md' })
  })
})

describe('single-source entities (graph-backed)', () => {
  /** A seed entity plus one source page linking it - the single-post-creator class. */
  function seedEntityWithOneSource(): void {
    page('wiki/entities/Solo Poster.md', { type: 'entity', status: 'seed' })
    page('wiki/sources/Viral Post.md', { type: 'source' }, 'By [[Solo Poster]].\n')
  }

  it('flags a seed entity referenced by only one source page', () => {
    seedEntityWithOneSource()
    const graph = new GraphBuilder(vaultRoot).build()
    const findings = validatePages(vaultRoot, ['wiki/entities/Solo Poster.md'], graph)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'single-source-entity', path: 'wiki/entities/Solo Poster.md' })
    expect(findings[0]!.message).toContain('only one source page')
  })

  it('flags a seed entity linked only from concept pages — concept backlinks do not launder it', () => {
    page('wiki/entities/Solo Poster.md', { type: 'entity', status: 'seed' })
    page('wiki/concepts/Reach Multiplier.md', {}, 'Coined by [[Solo Poster]].\n')
    page('wiki/concepts/Repost Funnel.md', {}, 'See [[Solo Poster]].\n')
    const graph = new GraphBuilder(vaultRoot).build()
    const findings = validatePages(vaultRoot, ['wiki/entities/Solo Poster.md'], graph)
    expect(rules(findings)).toEqual(['single-source-entity'])
    expect(findings[0]!.message).toContain('no source page')
  })

  it('stays quiet once a second independent source references the entity', () => {
    seedEntityWithOneSource()
    page('wiki/sources/Second Source.md', { type: 'source' }, 'Also features [[Solo Poster]].\n')
    const graph = new GraphBuilder(vaultRoot).build()
    expect(validatePages(vaultRoot, ['wiki/entities/Solo Poster.md'], graph)).toEqual([])
  })

  it('a source _index hub does not count as an independent source', () => {
    seedEntityWithOneSource()
    page('wiki/sources/_index.md', { type: 'meta' }, '- [[Solo Poster]]\n')
    const graph = new GraphBuilder(vaultRoot).build()
    expect(rules(validatePages(vaultRoot, ['wiki/entities/Solo Poster.md'], graph))).toEqual(['single-source-entity'])
  })

  it('bumping status past seed is the deliberate keep-anyway override', () => {
    page('wiki/entities/Solo Poster.md', { type: 'entity', status: 'developing' })
    page('wiki/sources/Viral Post.md', { type: 'source' }, 'By [[Solo Poster]].\n')
    const graph = new GraphBuilder(vaultRoot).build()
    expect(validatePages(vaultRoot, ['wiki/entities/Solo Poster.md'], graph)).toEqual([])
  })

  it('skips the check when no graph is provided, and never fires outside entities/', () => {
    seedEntityWithOneSource()
    page('wiki/concepts/Seedling.md', { status: 'seed' })
    page('wiki/index.md', { type: 'meta' }, '[[Seedling]]\n')
    expect(validatePages(vaultRoot, ['wiki/entities/Solo Poster.md'])).toEqual([])
    const graph = new GraphBuilder(vaultRoot).build()
    expect(validatePages(vaultRoot, ['wiki/concepts/Seedling.md'], graph)).toEqual([])
  })
})

describe('address_map consistency (2c)', () => {
  it('flags entries whose page was deleted, and map/frontmatter divergence', () => {
    page('wiki/concepts/Matching.md', { address: 'c-000010' })
    page('wiki/concepts/Diverged.md', { address: 'c-000099' })
    write(
      '.raw/.manifest.json',
      JSON.stringify({
        version: 1,
        address_map: {
          'wiki/concepts/Matching.md': 'c-000010',
          'wiki/concepts/Diverged.md': 'c-000011',
          'wiki/concepts/Deleted.md': 'c-000012',
        },
      }),
    )
    const findings = validateAddressMap(vaultRoot)
    expect(findings).toHaveLength(2)
    expect(findings.find((f) => f.path === 'wiki/concepts/Deleted.md')!.message).toContain('no longer exists')
    expect(findings.find((f) => f.path === 'wiki/concepts/Diverged.md')!.message).toContain('c-000099')
  })

  it('yields nothing without a manifest or without an address_map', () => {
    expect(validateAddressMap(vaultRoot)).toEqual([])
    write('.raw/.manifest.json', JSON.stringify({ version: 1, sources: {} }))
    expect(validateAddressMap(vaultRoot)).toEqual([])
  })
})

describe('hot cache size', () => {
  const hot = (words: number, relatedEntries: number): string =>
    '---\ntype: meta\ntitle: "Hot Cache"\nupdated: 2026-09-04\nrelated:\n' +
    Array.from({ length: relatedEntries }, (_, i) => `  - "[[Page ${i}]]"\n`).join('') +
    '---\n\n# Recent Context\n\n## Last Updated\n2026-09-04. ' +
    Array.from({ length: words }, () => 'word').join(' ') +
    '\n'

  it('flags a hot cache that has grown into a journal', () => {
    write('wiki/hot.md', hot(HOT_CACHE_WORD_LIMIT + 200, HOT_CACHE_RELATED_LIMIT + 10))
    const findings = validateHotCache(vaultRoot)
    expect(findings).toHaveLength(2)
    expect(findings.every((f) => f.rule === 'hot-cache-size' && f.path === 'wiki/hot.md')).toBe(true)
    expect(findings[0]!.message).toContain('not a journal')
    expect(findings[1]!.message).toContain(`${HOT_CACHE_RELATED_LIMIT + 10} related pages`)
  })

  it('accepts a hot cache that honours the contract, and a vault without one', () => {
    expect(validateHotCache(vaultRoot)).toEqual([])
    write('wiki/hot.md', hot(300, 12))
    expect(validateHotCache(vaultRoot)).toEqual([])
  })

  it('is part of the standard composition', () => {
    write('wiki/hot.md', hot(HOT_CACHE_WORD_LIMIT + 1, 0))
    const findings = createValidator(vaultRoot)([])
    expect(findings.some((f) => f.rule === 'hot-cache-size')).toBe(true)
  })
})

describe('stale counters', () => {
  it('flags header counters that lag the vault by more than the slack', () => {
    for (let i = 0; i < 6; i++) page(`wiki/concepts/C${i}.md`)
    for (let i = 0; i < 4; i++) page(`wiki/sources/S${i}.md`, { type: 'source' })
    write('wiki/index.md', '---\ntype: meta\n---\nTotal pages: 3 | Sources ingested: 4\n')
    const findings = validateCounters(vaultRoot)
    // 11 pages on disk vs claimed 3 → flagged; sources 4 vs 4 → fine.
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'stale-counter', path: 'wiki/index.md' })
    expect(findings[0]!.message).toContain('claims 3 pages')
  })

  it('tolerates small semantic differences and pages without counters', () => {
    for (let i = 0; i < 6; i++) page(`wiki/concepts/C${i}.md`)
    // 7 pages on disk, header says 5 — within the slack of 3 (a "content pages only" counter).
    write('wiki/overview.md', '---\ntype: meta\n---\nWiki pages: 5\n')
    write('wiki/index.md', '---\ntype: meta\n---\nno counters here\n')
    expect(validateCounters(vaultRoot)).toEqual([])
  })
})

describe('createValidator', () => {
  it('composes the per-page checks with the address_map check', () => {
    page('wiki/concepts/Alpha.md', { status: null })
    write('.raw/.manifest.json', JSON.stringify({ address_map: { 'wiki/concepts/Deleted.md': 'c-000012' } }))
    const validate = createValidator(vaultRoot, new GraphBuilder(vaultRoot))
    const findings = validate(['wiki/concepts/Alpha.md'])
    expect(rules(findings)).toContain('frontmatter')
    expect(rules(findings)).toContain('address-map')
    // Alpha is also an orphan — the graph came from the builder we passed in.
    expect(rules(findings)).toContain('orphan')
  })
})

/**
 * A title its own file name cannot carry (B3, 4.1): this vault's largest mechanical dead-link
 * class. The title keeps the character, the file name loses it, and every link written from
 * the title lands nowhere - 55 occurrences today, 43 of them from two pages alone.
 */
describe('the title-name rule', () => {
  const page = (rel: string, title: string): string => {
    const abs = path.join(vaultRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(
      abs,
      `---\ntype: concept\ntitle: "${title}"\nstatus: seed\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags:\n  - concept\n---\n\n# ${title}\n`,
    )
    return rel
  }

  it('fires on each character a file name cannot portably carry', () => {
    for (const bad of [':', '?', '*', '"', '<', '>', '|', '/', '\\']) {
      const rel = page('wiki/concepts/Foo - Bar.md', `Foo${bad}Bar`)
      const findings = validatePages(vaultRoot, [rel]).filter((f) => f.rule === 'title-name')
      expect(findings, bad).toHaveLength(1)
      expect(findings[0]?.message).toContain('resolves to nothing')
    }
  })

  it('stays silent when the title and the file name agree, whatever they contain', () => {
    // A colon is legal in a file name on this filesystem. The defect is the DRIFT, not the
    // character, and a rule that fired on the character would flag pages nothing is wrong with.
    const rel = page('wiki/concepts/Foo: Bar.md', 'Foo: Bar')
    expect(validatePages(vaultRoot, [rel]).filter((f) => f.rule === 'title-name')).toEqual([])
  })

  it('fires on a title too long to be a name', () => {
    const long = `A ${'very '.repeat(40)}long title`
    const rel = page(`wiki/concepts/${long}.md`, long)
    const findings = validatePages(vaultRoot, [rel]).filter((f) => f.rule === 'title-name')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('characters; keep it under 120')
  })

  it('says nothing about a page with no title at all', () => {
    const abs = path.join(vaultRoot, 'wiki/concepts/Untitled.md')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, '---\ntype: concept\nstatus: seed\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags:\n  - concept\n---\n\n# Untitled\n')
    expect(validatePages(vaultRoot, ['wiki/concepts/Untitled.md']).filter((f) => f.rule === 'title-name')).toEqual([])
  })
})

/**
 * The heading floor (B4, 4.2) and the run-protocol sections (B5, 4.3).
 *
 * Measured over the live vault when the rules landed: 356 of 604 concept pages (59 %), 143 of
 * 225 entities (64 %) and 302 of 338 sources (89 %) lack their floor; 215 pages carry a
 * run-protocol section. Both rules are advisory, like every other rule here.
 */
describe('the page schema floor', () => {
  const page = (rel: string, type: string, body: string): string => {
    const abs = path.join(vaultRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(
      abs,
      `---\ntype: ${type}\ntitle: "${path.basename(rel, '.md')}"\nstatus: seed\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags:\n  - ${type}\n---\n\n# ${path.basename(rel, '.md')}\n\n${body}`,
    )
    return rel
  }
  const schema = (rel: string): string[] =>
    validatePages(vaultRoot, [rel]).filter((f) => f.rule === 'page-schema').map((f) => f.message)

  it('asks a concept and an entity for Connections', () => {
    expect(schema(page('wiki/concepts/A.md', 'concept', '## Definition\n\nText.\n'))[0]).toContain('## Connections')
    expect(schema(page('wiki/entities/B.md', 'entity', '## Work\n\nText.\n'))[0]).toContain('## Connections')
  })

  it('asks a source for both of its headings, naming what is missing', () => {
    const one = schema(page('wiki/sources/C.md', 'source', '## Connections\n\nText.\n'))
    expect(one[0]).toContain('## Why This Source Matters')
    expect(one[0]).not.toContain('## Connections')
  })

  it('is silent when the floor is met, whatever else the page carries', () => {
    // A floor, not a template: the free prose is the good part, and 2243 heading variants
    // exist because runs were free to write them.
    expect(schema(page('wiki/concepts/D.md', 'concept', '## Anything At All\n\nText.\n\n## Connections\n\n- [[X]]\n'))).toEqual([])
  })

  it('matches the heading case-insensitively, not by exact spelling', () => {
    expect(schema(page('wiki/concepts/E.md', 'concept', '## connections\n\n- [[X]]\n'))).toEqual([])
  })

  it('says nothing about a type with no floor', () => {
    expect(schema(page('wiki/questions/F.md', 'question', '## Whatever\n'))).toEqual([])
  })
})

describe('the run-protocol rule', () => {
  const withHeading = (heading: string): string[] => {
    const rel = 'wiki/concepts/Protocol.md'
    const abs = path.join(vaultRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(
      abs,
      `---\ntype: concept\ntitle: "Protocol"\nstatus: seed\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags:\n  - concept\n---\n\n# Protocol\n\n## Connections\n\n- [[X]]\n\n## ${heading}\n\nText.\n`,
    )
    return validatePages(vaultRoot, [rel]).filter((f) => f.rule === 'run-protocol').map((f) => f.message)
  }

  it('fires on each of the seven headings that belong in the log', () => {
    for (const heading of [
      'Editorial Note',
      'Provenance',
      'Status of This Page',
      "Relation to this vault's existing coverage",
      'Vault context',
      'Entity Notability Note',
      'Automated Decisions',
    ]) {
      expect(withHeading(heading), heading).toHaveLength(1)
    }
  })

  it('stays silent on Assessment and Open Questions', () => {
    // Assessment is source criticism and belongs to the source; the standing agents plan from
    // the open questions. A rule read as "no meta sections at all" would take both away.
    expect(withHeading('Assessment')).toEqual([])
    expect(withHeading('Open Questions')).toEqual([])
  })
})
