/**
 * GraphBuilder tests (SPEC.md §12.4): wikilink graph extraction, resolution rules (alias,
 * heading, case-insensitivity, dangling links), and the two cache layers that keep the
 * endpoint cheap as the vault grows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GraphBuilder, parseFrontmatterMeta, classifyKind } from '../src/pipeline/graph.js'

let vaultRoot: string

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-vault-'))
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

function page(rel: string, content: string): void {
  const abs = path.join(vaultRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

describe('GraphBuilder', () => {
  it('builds nodes with types and resolved directed edges', () => {
    page('wiki/concepts/Alpha.md', 'links to [[Beta]] and [[Gamma Source|the source]]')
    page('wiki/concepts/Beta.md', 'back to [[Alpha#History]]')
    page('wiki/sources/Gamma Source.md', 'no links')
    page('wiki/index.md', '[[Alpha]] [[Beta]] [[Gamma Source]]')

    const g = new GraphBuilder(vaultRoot).build()
    const byTitle = new Map(g.nodes.map((n, i) => [n.title, i]))

    expect(g.nodes).toHaveLength(4)
    expect(g.nodes[byTitle.get('Alpha')!]!.type).toBe('concepts')
    expect(g.nodes[byTitle.get('Gamma Source')!]!.type).toBe('sources')
    expect(g.nodes[byTitle.get('index')!]!.type).toBe('root')

    const edgeSet = new Set(g.edges.map(([a, b]) => `${g.nodes[a]!.title}->${g.nodes[b]!.title}`))
    expect(edgeSet).toContain('Alpha->Beta') // plain link
    expect(edgeSet).toContain('Alpha->Gamma Source') // alias resolved to target
    expect(edgeSet).toContain('Beta->Alpha') // heading stripped
    expect(g.nodes[byTitle.get('Alpha')!]!.in).toBe(2) // Beta + index
    expect(g.nodes[byTitle.get('Alpha')!]!.out).toBe(2)
  })

  /*
   * The date the recency lens colours by (B7, and the reason the lens was useless until
   * 2026-09-20). It is what the PAGE says about itself, never the file mtime: a repair pass
   * rewrites every file, so on this vault 1326 of 1332 mtimes landed inside the lens's 21-day
   * window and the whole graph went green.
   */
  describe('the freshness date', () => {
    const ms = (d: string): number => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))

    it('prefers content_updated: over created:', () => {
      page('wiki/concepts/Both.md', '---\ncreated: 2026-04-01\nupdated: 2026-09-20\ncontent_updated: 2026-07-15\n---\n\nbody')
      const n = new GraphBuilder(vaultRoot).build().nodes[0]!
      expect(n.freshMs).toBe(ms('2026-07-15'))
    })

    it('falls back to created:, never to updated:', () => {
      // `updated:` is the date of the last mass pass on most of this vault, which is exactly
      // the signal that had to be replaced. Using it here would reintroduce the defect.
      page('wiki/concepts/Old.md', '---\ncreated: 2026-04-01\nupdated: 2026-09-20\n---\n\nbody')
      const n = new GraphBuilder(vaultRoot).build().nodes[0]!
      expect(n.freshMs).toBe(ms('2026-04-01'))
      expect(n.freshMs).not.toBe(ms('2026-09-20'))
    })

    it('is absent when the page states neither date, so the lens can fall back to the mtime', () => {
      page('wiki/concepts/Bare.md', 'no frontmatter at all')
      const n = new GraphBuilder(vaultRoot).build().nodes[0]!
      expect(n.freshMs).toBeUndefined()
      expect(n.mtimeMs).toBeGreaterThan(0)
    })

    it('reads a date with a time as the same day, whatever the timezone', () => {
      page('wiki/concepts/Timed.md', '---\ncreated: 2026-04-01T23:30:00+02:00\n---\n\nbody')
      const n = new GraphBuilder(vaultRoot).build().nodes[0]!
      expect(n.freshMs).toBe(ms('2026-04-01'))
    })

    it('ignores a date it cannot read rather than guessing', () => {
      page('wiki/concepts/Junk.md', '---\ncreated: sometime last spring\n---\n\nbody')
      expect(new GraphBuilder(vaultRoot).build().nodes[0]!.freshMs).toBeUndefined()
    })

    it('re-reads it when the page changes', () => {
      page('wiki/concepts/Moves.md', '---\ncreated: 2026-04-01\n---\n\nbody')
      const b = new GraphBuilder(vaultRoot)
      expect(b.build().nodes[0]!.freshMs).toBe(ms('2026-04-01'))
      page('wiki/concepts/Moves.md', '---\ncreated: 2026-04-01\ncontent_updated: 2026-09-19\n---\n\nbody, rewritten')
      expect(b.build().nodes[0]!.freshMs).toBe(ms('2026-09-19'))
    })
  })

  it('carries frontmatter tags + domain on nodes and re-reads them on change', () => {
    page(
      'wiki/concepts/Fund.md',
      '---\ntitle: "Fund"\ntags:\n  - german-finance\n  - "investment-funds"\n  - german-finance\ndomain: investment-funds\n---\n\n[[Bare]]',
    )
    page('wiki/concepts/Bare.md', 'no frontmatter at all')

    const builder = new GraphBuilder(vaultRoot)
    let g = builder.build()
    const fund = g.nodes.find((n) => n.title === 'Fund')!
    const bare = g.nodes.find((n) => n.title === 'Bare')!
    expect(fund.tags).toEqual(['german-finance', 'investment-funds']) // deduped, unquoted
    expect(fund.domain).toBe('investment-funds')
    expect(bare.tags).toEqual([])
    expect(bare.domain).toBeNull()

    // A changed file must be re-parsed (per-file cache keys on mtime+size).
    const abs = path.join(vaultRoot, 'wiki/concepts/Fund.md')
    fs.writeFileSync(abs, '---\ntags: [cooking, recipe]\ndomain: "cooking"\n---\n\n[[Bare]]')
    fs.utimesSync(abs, new Date(), new Date(Date.now() + 5000))
    g = builder.build()
    const changed = g.nodes.find((n) => n.title === 'Fund')!
    expect(changed.tags).toEqual(['cooking', 'recipe']) // inline list form
    expect(changed.domain).toBe('cooking')
  })

  it('parseFrontmatterMeta handles absence and malformed frontmatter', () => {
    const empty = { tags: [], domain: null, fmType: null, title: null, aliases: [], url: null, origin: null, fresh: null }
    expect(parseFrontmatterMeta('no frontmatter')).toEqual(empty)
    expect(parseFrontmatterMeta('---\ntags:\n---\nbody')).toEqual(empty)
    expect(parseFrontmatterMeta('---\ndomain:\n---\nbody')).toEqual(empty)
    // tags mentioned mid-body must not count — only the leading frontmatter block parses.
    expect(parseFrontmatterMeta('body first\n---\ntags:\n  - nope\n---')).toEqual(empty)
    // `type:` is lowercased — the classifier compares against lowercase sets.
    expect(parseFrontmatterMeta('---\ntype: "Concept"\n---\nbody').fmType).toBe('concept')
    // `title:` keeps its casing and punctuation; aliases parse in both list forms.
    const meta = parseFrontmatterMeta('---\ntitle: "Does it work?"\naliases:\n  - "The Q"\n---\nbody')
    expect(meta.title).toBe('Does it work?')
    expect(meta.aliases).toEqual(['The Q'])
    // `origin:` marks material the vault did not collect (task 8.7); quoted or bare.
    expect(parseFrontmatterMeta('---\norigin: upstream-demo\n---\nbody').origin).toBe('upstream-demo')
    expect(parseFrontmatterMeta('---\norigin: "upstream-demo"\n---\nbody').origin).toBe('upstream-demo')

    /*
     * The address a page states for itself, in the two spellings the vault has. An ingest
     * writes `url:` and puts the stored copy in `sources:`; a research run has no stored
     * copy and writes the address into `sources:` directly.
     */
    expect(parseFrontmatterMeta('---\nurl: "https://example.org/a"\n---\nb').url).toBe('https://example.org/a')
    expect(parseFrontmatterMeta('---\nsources:\n  - "https://example.org/b"\n---\nb').url).toBe('https://example.org/b')
    // `url:` leads when both are there: `sources:` may hold the stored copy instead.
    expect(parseFrontmatterMeta('---\nurl: "https://a.test/x"\nsources:\n  - "[[.raw/j1/raw.html]]"\n---\nb').url).toBe('https://a.test/x')
    // Only links to follow. A DOI, an archive path and a wikilink are none of them.
    expect(parseFrontmatterMeta('---\nurl: "10.1016/j.onano.2026.100319"\n---\nb').url).toBeNull()
    expect(parseFrontmatterMeta('---\nsources:\n  - "[[.raw/j1/raw.html]]"\n---\nb').url).toBeNull()
    // `sources:` is read as a block, so a list somewhere ABOVE it is not mistaken for one.
    expect(parseFrontmatterMeta('---\ntags:\n  - "https://not-a-source.test/"\nsources:\n  - "[[x]]"\n---\nb').url).toBeNull()
    expect(parseFrontmatterMeta('---\naliases: [A, "B"]\n---\nbody').aliases).toEqual(['A', 'B'])
  })

  it('classifies pages as knowledge, structural or artifact', () => {
    // Frontmatter type leads.
    expect(classifyKind('concept', 'finance', 'concepts', 'Compound Interest')).toBe('knowledge')
    expect(classifyKind('session', 'meta', 'meta', '2026-04-15-release-report-session')).toBe('artifact')
    expect(classifyKind('fold', 'meta', 'folds', 'fold-k3-from-2026-04-23')).toBe('artifact')
    // `type: meta` splits by name/location: registries and hubs are structure, reports are runs.
    expect(classifyKind('meta', 'meta', 'meta', 'domains')).toBe('structural')
    expect(classifyKind('meta', 'meta', 'root', 'index')).toBe('structural')
    expect(classifyKind('meta', 'meta', 'concepts', '_index')).toBe('structural') // MOC inside a knowledge folder
    expect(classifyKind('meta', 'meta', 'concepts', 'Hot Cache')).toBe('structural')
    expect(classifyKind('meta', 'meta', 'meta', 'lint-report-2026-07-19')).toBe('artifact')
    expect(classifyKind('meta', 'meta', 'meta', 'retrieval-benchmark-v1.7')).toBe('artifact')
    // `domain: meta` overrides a knowledge type — ops notes reuse them (`type: decision`).
    expect(classifyKind('decision', 'meta', 'meta', '2026-04-14-community-cta-rollout')).toBe('artifact')
    expect(classifyKind('decision', 'ai-tooling', 'concepts', 'Stack Choice')).toBe('knowledge')
    // No frontmatter type at all: location decides, defaulting to knowledge.
    expect(classifyKind(null, null, 'concepts', 'Osmosis')).toBe('knowledge')
    expect(classifyKind(null, null, 'root', 'getting-started')).toBe('structural')
    expect(classifyKind(null, 'meta', 'meta', 'boundary-frontier-2026-04-24')).toBe('artifact')
    // The artifact-name heuristic never touches ordinary knowledge pages.
    expect(classifyKind('concept', 'ai-tooling', 'concepts', 'Retrieval Benchmark')).toBe('knowledge')
    expect(classifyKind(null, null, 'concepts', 'Security Audit')).toBe('knowledge')
  })

  it('carries kind on built nodes', () => {
    page('wiki/concepts/Alpha.md', '---\ntype: concept\ndomain: finance\n---\nbody')
    page('wiki/concepts/_index.md', '---\ntype: meta\ndomain: meta\n---\n[[Alpha]]')
    page('wiki/meta/lint-report-2026-07-19.md', '---\ntype: meta\ndomain: meta\n---\nfindings')
    page('wiki/index.md', '[[Alpha]]')
    const g = new GraphBuilder(vaultRoot).build()
    const kind = (title: string): string => g.nodes.find((n) => n.title === title)!.kind
    expect(kind('Alpha')).toBe('knowledge')
    expect(kind('_index')).toBe('structural')
    expect(kind('lint-report-2026-07-19')).toBe('artifact')
    expect(kind('index')).toBe('structural')
  })

  it('resolves case-insensitively and counts dangling links as unresolved', () => {
    page('wiki/concepts/Compound Interest.md', 'see [[compound interest]] (self), [[Nowhere]]')
    page('wiki/concepts/Other.md', '[[COMPOUND INTEREST]]')
    const g = new GraphBuilder(vaultRoot).build()
    // Self-links are dropped, case-insensitive resolution works, [[Nowhere]] is dangling.
    expect(g.edges).toHaveLength(1)
    expect(g.unresolved).toBe(1)
  })

  it('aggregates unresolved targets into ranked gaps grouped case-insensitively', () => {
    page('wiki/concepts/A.md', 'wants [[Photosynthesis]] and [[Lattice Creep]]')
    page('wiki/concepts/B.md', 'also [[photosynthesis]] here') // same gap, different case
    page('wiki/concepts/C.md', 'again [[Photosynthesis]] plus a dupe [[Photosynthesis]]')
    const g = new GraphBuilder(vaultRoot).build()
    const byTitle = new Map(g.nodes.map((n, i) => [n.title, i]))

    expect(g.unresolved).toBe(4) // 2 in A, 1 in B, 1 in C (parseWikilinks dedupes C's repeat)
    expect(g.gaps).toHaveLength(2)

    const pk = g.gaps[0]! // most-referenced first
    expect(pk.title).toBe('Photosynthesis') // first-written casing
    // refBy is deduped per page (C links twice but appears once) and holds node indices.
    expect(pk.refBy.map((i) => g.nodes[i]!.title).sort()).toEqual(['A', 'B', 'C'])
    expect(pk.refBy).toContain(byTitle.get('A'))

    expect(g.gaps[1]!.title).toBe('Lattice Creep')
    expect(g.gaps[1]!.refBy).toHaveLength(1)
  })

  it('never lets the journal or the hot cache nominate a gap', () => {
    // The append-only log keeps naming pages that were deleted or deliberately unlinked, and
    // the hot cache is rewritten from scratch; a link there is a record, not a missing page.
    page('wiki/log.md', '- created [[Widget Basics]] and [[Osmosis]]')
    page('wiki/hot.md', 'recent: [[Widget Basics]]')
    page('wiki/concepts/A.md', 'content gap [[Osmosis]]')

    const g = new GraphBuilder(vaultRoot).build()
    expect(g.unresolved).toBe(4) // every dangling link still counts
    expect(g.gaps).toHaveLength(1) // but only the content page's want is a gap
    expect(g.gaps[0]!.title).toBe('Osmosis')
    const a = g.nodes.findIndex((n) => n.path === 'wiki/concepts/A.md')
    expect(g.gaps[0]!.refBy).toEqual([a])
  })

  it('counts dangling path-qualified links as unresolved but excludes them from gaps', () => {
    // Path targets whose page really doesn't exist stay dangling — and stay out of the
    // gap list (navigation/staging references, not missing content pages).
    page('wiki/concepts/A.md', 'nav [[concepts/_index]] and content gap [[Osmosis]]')
    page('wiki/concepts/B.md', 'more nav [[notes/Foo]]')
    const g = new GraphBuilder(vaultRoot).build()
    expect(g.unresolved).toBe(3) // all three dangling links still count
    expect(g.gaps).toHaveLength(1) // only the real content gap surfaces
    expect(g.gaps[0]!.title).toBe('Osmosis')
  })

  it('resolves path-qualified links against the actual page path, with or without wiki/ prefix', () => {
    // The vault links its folder hubs as [[concepts/_index]] — the basename index can't
    // match a path, but the page exists, so it must resolve to a real edge, not a gap.
    page('wiki/concepts/_index.md', '---\ntype: meta\ndomain: meta\n---\nhub')
    page('wiki/concepts/A.md', 'nav [[concepts/_index]]')
    page('wiki/concepts/B.md', 'nav [[wiki/concepts/_index]] spelled from the vault root')
    const g = new GraphBuilder(vaultRoot).build()
    expect(g.unresolved).toBe(0)
    expect(g.gaps).toHaveLength(0)
    const hub = g.nodes.find((n) => n.title === '_index')!
    expect(hub.in).toBe(2)
  })

  it('resolves links to non-markdown wiki files without creating nodes or gaps', () => {
    // Canvases are linked without their extension, bases with it — both spellings exist
    // in the vault. Neither is a missing page.
    page('wiki/index.md', 'see [[Wiki Map]], [[dashboard.base]] and [[canvases/presentation]]')
    fs.writeFileSync(path.join(vaultRoot, 'wiki/Wiki Map.canvas'), '{}')
    fs.mkdirSync(path.join(vaultRoot, 'wiki/meta'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki/meta/dashboard.base'), '{}')
    fs.mkdirSync(path.join(vaultRoot, 'wiki/canvases'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki/canvases/presentation.canvas'), '{}')
    const g = new GraphBuilder(vaultRoot).build()
    expect(g.unresolved).toBe(0)
    expect(g.gaps).toHaveLength(0)
    expect(g.nodes).toHaveLength(1) // assets resolve links but never become nodes
    expect(g.edges).toHaveLength(0)
  })

  it('rebuilds when an asset appears — a former gap resolves', () => {
    page('wiki/index.md', '[[Wiki Map]]')
    const builder = new GraphBuilder(vaultRoot)
    expect(builder.build().unresolved).toBe(1)
    fs.writeFileSync(path.join(vaultRoot, 'wiki/Wiki Map.canvas'), '{}')
    expect(builder.build().unresolved).toBe(0) // asset set is part of the cache signature
  })

  it('never counts artifact pages as gap referrers — they quote dangling links', () => {
    page('wiki/concepts/A.md', '---\ntype: concept\ndomain: bio\n---\nwants [[Osmosis]]')
    page(
      'wiki/meta/lint-report-2026-07-19.md',
      '---\ntype: meta\ndomain: meta\n---\ndangling: [[Osmosis]], [[...]], [[Rankenstein]]',
    )
    const g = new GraphBuilder(vaultRoot).build()
    expect(g.unresolved).toBe(4) // the report's dangling links still count as unresolved
    expect(g.gaps).toHaveLength(1) // but mint no gaps ("..." and "Rankenstein" vanish)
    expect(g.gaps[0]!.title).toBe('Osmosis')
    // ...and don't inflate a real gap's referrer list either.
    expect(g.gaps[0]!.refBy.map((i) => g.nodes[i]!.title)).toEqual(['A'])
  })

  it('ignores wikilinks inside code, so code literals never become gaps', () => {
    // `tf.constant([[1.]] * n)` is a Python list literal. It used to mint a page named "1."
    // and, with two knowledge pages "linking" to it, rank FIRST in most-wanted pages.
    page(
      'wiki/concepts/Net.md',
      '---\ntype: concept\n---\ntrains on [[Tensors]]\n\n```python\ny = tf.constant([[0.]] * n + [[1.]] * n)\n```\n',
    )
    // A lint report QUOTES the dangling links it reports. The artifact rule already kept
    // those out of the gap list; stripping code keeps them out of the unresolved count too.
    page('wiki/meta/lint-report-2026-08-24.md', '---\ntype: report\n---\n- `[[Ghost]]` does not exist.')
    const g = new GraphBuilder(vaultRoot).build()
    expect(g.gaps.map((x) => x.title)).toEqual(['Tensors'])
    expect(g.unresolved).toBe(1)
  })

  it('resolves a table-escaped alias pipe instead of calling the page missing', () => {
    // Inside a markdown table the alias separator must be written `\|` or the cell breaks.
    // Splitting on the bare pipe left the escape in the page name, so three concept pages
    // that exist showed up at the top of most-wanted pages.
    page('wiki/concepts/Comparison.md', '| [[Compound Interest\\|CI]] | dominant |')
    page('wiki/concepts/Compound Interest.md', 'the page that exists')
    const g = new GraphBuilder(vaultRoot).build()
    expect(g.unresolved).toBe(0)
    expect(g.gaps).toHaveLength(0)
    expect(g.nodes.find((n) => n.title === 'Compound Interest')!.in).toBe(1)
  })

  it('resolves embeds against the media roots outside wiki/, and never gaps on one', () => {
    page('wiki/sources/Infographic.md', 'the picture: ![[chart.png]] plus a broken one ![[gone.png]]')
    fs.mkdirSync(path.join(vaultRoot, '_attachments/images'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, '_attachments/images/chart.png'), 'x')
    const g = new GraphBuilder(vaultRoot).build()
    expect(g.nodes).toHaveLength(1) // media resolves links but never becomes a node
    expect(g.unresolved).toBe(1) // the broken embed is still a dangling reference...
    expect(g.gaps).toHaveLength(0) // ...but a missing image is not a page to write
  })

  it('never lets plugin-shipped doc pages nominate gaps', () => {
    // claude-obsidian ships wiki/references/* carrying `related:` links into its own docs
    // that a Generic-mode vault has no page for. Those gaps are upstream's, they name
    // nothing the user collects, and upstream-guard forbids agent runs from editing the
    // pages anyway - a backlog entry for them is work nobody can do. (No git in the temp
    // vault, so protectedWikiPages falls back to the static upstream list.)
    page(
      'wiki/references/transport-fallback.md',
      '---\ntype: reference\n---\nrelated: [[wiki-cli]] and [[mcp-setup]]',
    )
    page('wiki/concepts/A.md', '---\ntype: concept\n---\nwants [[Osmosis]]')
    const g = new GraphBuilder(vaultRoot).build()
    expect(g.unresolved).toBe(3) // upstream's dangling links are still dangling
    expect(g.gaps.map((x) => x.title)).toEqual(['Osmosis']) // but never a backlog entry
  })

  it('resolves links via frontmatter title and aliases when the basename differs', () => {
    // Filenames drop filesystem-hostile characters that links keep: the vault files
    // "…hold?" as "…hold.md" with the `?` preserved only in `title:`.
    page(
      'wiki/questions/How long does a sintered seal hold.md',
      '---\ntype: question\ndomain: km\ntitle: "How long does a sintered seal hold?"\n---\nanswer',
    )
    page('wiki/meta/domains.md', '---\ntype: meta\ndomain: meta\ntitle: "Domain Registry"\n---\nregistry')
    page('wiki/concepts/Reg Alias.md', '---\ntype: concept\ndomain: km\naliases:\n  - "The Registry"\n---\nx')
    page(
      'wiki/concepts/A.md',
      '[[How long does a sintered seal hold?]] and [[Domain Registry]] and [[The Registry]]',
    )
    const g = new GraphBuilder(vaultRoot).build()
    expect(g.unresolved).toBe(0)
    expect(g.gaps).toHaveLength(0)
    const inDeg = (title: string): number => g.nodes.find((n) => n.title === title)!.in
    expect(inDeg('How long does a sintered seal hold')).toBe(1)
    expect(inDeg('domains')).toBe(1)
    expect(inDeg('Reg Alias')).toBe(1)
  })

  it('prefers the basename over another page claiming the same name as title', () => {
    page('wiki/concepts/Osmosis.md', 'the real page')
    page('wiki/concepts/Pretender.md', '---\ntitle: "Osmosis"\n---\nnot it')
    page('wiki/concepts/A.md', '[[Osmosis]]')
    const g = new GraphBuilder(vaultRoot).build()
    const edge = g.edges.map(([a, b]) => `${g.nodes[a]!.title}->${g.nodes[b]!.title}`)
    expect(edge).toEqual(['A->Osmosis'])
  })

  it('ranks gaps wanted by knowledge pages above ones only system pages mention', () => {
    // "Widgetry" has MORE referrers, but both are structural (log + index); "Osmosis" has
    // one knowledge referrer and must outrank it — the list is a research backlog.
    page('wiki/concepts/A.md', '---\ntype: concept\ndomain: bio\n---\nwants [[Osmosis]]')
    page('wiki/log.md', 'ingested [[Widgetry]]')
    page('wiki/index.md', 'todo [[Widgetry]]')
    const g = new GraphBuilder(vaultRoot).build()
    expect(g.gaps.map((x) => x.title)).toEqual(['Osmosis', 'Widgetry'])
  })

  it('returns the identical graph object while nothing changed (whole-graph cache)', () => {
    page('wiki/concepts/A.md', '[[B]]')
    page('wiki/concepts/B.md', 'x')
    const builder = new GraphBuilder(vaultRoot)
    const first = builder.build()
    expect(builder.build()).toBe(first)
  })

  it('re-parses only changed files and reflects edits, additions and deletions', async () => {
    page('wiki/concepts/A.md', '[[B]]')
    page('wiki/concepts/B.md', 'x')
    const builder = new GraphBuilder(vaultRoot)
    expect(builder.build().edges).toHaveLength(1)

    // mtime granularity can be coarse — make sure the edit is observable.
    await new Promise((r) => setTimeout(r, 20))
    page('wiki/concepts/A.md', 'no links any more, but longer than before')
    expect(builder.build().edges).toHaveLength(0)

    page('wiki/concepts/C.md', '[[A]] [[B]]')
    expect(builder.build().edges).toHaveLength(2)

    fs.rmSync(path.join(vaultRoot, 'wiki/concepts/C.md'))
    const afterDelete = builder.build()
    expect(afterDelete.nodes.map((n) => n.title).sort()).toEqual(['A', 'B'])
    expect(afterDelete.edges).toHaveLength(0)
  })
})
