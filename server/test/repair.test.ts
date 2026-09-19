import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  planRepair,
  applyRepair,
  diffOf,
  planTitleDrift,
  wikiPages,
  emDashPass,
  tagMirrorPass,
  runProtocolPass,
  demoSeedPass,
  planManifestRepair,
  dashLinkPass,
  planLogArchive,
  overviewPass,
  tagSingletonPass,
  recordSectionPass,
  titleLinkPass,
  bucketRegroupPass,
} from '../src/pipeline/repair.js'
import { fieldOf, CONTENT_UPDATED, bodyOf } from '../src/pipeline/page-dates.js'

/**
 * The one-off repair passes (phase 8).
 *
 * These rewrite pages a person wrote months ago, in bulk, by rule, which makes them the most
 * dangerous code in this service. Two properties carry the whole design and are asserted first:
 * a plan WRITES NOTHING, and every repair stamps the mechanical date and never the content one.
 */
let vault: string

const page = (rel: string, front: string, body: string): void => {
  const abs = path.join(vault, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `---\n${front}\n---\n\n${body}`)
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-'))
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true })
})
afterEach(() => fs.rmSync(vault, { recursive: true, force: true }))

describe('planRepair', () => {
  it('writes nothing at all', () => {
    page('wiki/concepts/A.md', 'type: concept\nupdated: 2026-01-01', '# A\n\nOne — two.\n')
    const before = fs.readFileSync(path.join(vault, 'wiki/concepts/A.md'), 'utf8')
    const plan = planRepair(vault, 'em-dash', emDashPass)
    expect(plan.edits).toHaveLength(1)
    expect(fs.readFileSync(path.join(vault, 'wiki/concepts/A.md'), 'utf8')).toBe(before)
  })

  it('stamps updated: and never content_updated:', () => {
    // The property the whole of phase 8 rests on: a repair touches hundreds of pages, and if
    // it claimed they had said something new it would destroy the signal it exists to protect.
    page('wiki/concepts/A.md', `type: concept\nupdated: 2026-01-01\n${CONTENT_UPDATED}: 2026-05-05`, '# A\n\nOne — two.\n')
    const [edit] = planRepair(vault, 'em-dash', emDashPass, '2026-09-19').edits
    expect(fieldOf(edit!.after, 'updated')).toBe('2026-09-19')
    expect(fieldOf(edit!.after, CONTENT_UPDATED)).toBe('2026-05-05')
  })

  it('reports a page whose pass threw rather than dropping it silently', () => {
    page('wiki/concepts/A.md', 'type: concept', '# A\n')
    const plan = planRepair(vault, 'boom', () => {
      throw new Error('a pass with a bug in it')
    })
    expect(plan.edits).toEqual([])
    expect(plan.skipped[0]?.why).toContain('a pass with a bug in it')
  })
})

describe('applyRepair', () => {
  it('writes the plan and reports what it wrote', () => {
    page('wiki/concepts/A.md', 'type: concept\nupdated: 2026-01-01', '# A\n\nOne — two.\n')
    const plan = planRepair(vault, 'em-dash', emDashPass)
    const { written, stale } = applyRepair(vault, plan)
    expect(written).toEqual(['wiki/concepts/A.md'])
    expect(stale).toEqual([])
    expect(fs.readFileSync(path.join(vault, 'wiki/concepts/A.md'), 'utf8')).toContain('One - two.')
  })

  it('refuses to clobber a page that changed since the plan was made', () => {
    // A plan is a snapshot. An agent run that wrote the page in between must not have its work
    // overwritten by a repair that was planned against the older content.
    page('wiki/concepts/A.md', 'type: concept\nupdated: 2026-01-01', '# A\n\nOne — two.\n')
    const plan = planRepair(vault, 'em-dash', emDashPass)
    fs.writeFileSync(path.join(vault, 'wiki/concepts/A.md'), '---\ntype: concept\n---\n\n# A\n\nA run rewrote this.\n')
    const { written, stale } = applyRepair(vault, plan)
    expect(written).toEqual([])
    expect(stale).toEqual(['wiki/concepts/A.md'])
    expect(fs.readFileSync(path.join(vault, 'wiki/concepts/A.md'), 'utf8')).toContain('A run rewrote this.')
  })
})

describe('the em-dash pass', () => {
  const run = (body: string): string | null => {
    const out = emDashPass('wiki/concepts/A.md', `---\ntype: concept\n---\n\n${body}`, vault)
    return out === null ? null : out.after
  }

  it('replaces a dash in prose', () => {
    expect(run('One — two – three.\n')).toContain('One - two - three.')
  })

  it('leaves code fences and inline code alone, where the character is content', () => {
    const out = run('```\nconst a = "x — y"\n```\n\nAnd `p — q` inline, but this — one goes.\n')
    expect(out).toContain('const a = "x — y"')
    expect(out).toContain('`p — q`')
    expect(out).toContain('this - one goes')
  })

  it('leaves an address alone', () => {
    const out = run('See https://example.org/a—b for this — that.\n')
    expect(out).toContain('https://example.org/a—b')
    expect(out).toContain('this - that')
  })

  it('leaves a numeric range, because a hyphen there changes what it says', () => {
    const out = emDashPass('wiki/concepts/A.md', `---\ntype: concept\n---\n\nThe 1914–1918 war — and after.\n`, vault)
    expect(out?.after).toContain('1914–1918')
    expect(out?.after).toContain('war - and after')
    expect(out?.why).toContain('numeric range')
  })

  it('leaves the frontmatter alone', () => {
    const out = emDashPass('wiki/concepts/A.md', `---\ntype: concept\ntitle: "A — B"\n---\n\nText — here.\n`, vault)
    expect(out?.after).toContain('title: "A — B"')
  })

  it('says nothing about a page that has none', () => {
    expect(run('Plain prose with a - hyphen.\n')).toBeNull()
  })
})

describe('the tag-mirror pass', () => {
  it('removes a tag that repeats the type or the domain, and nothing else', () => {
    const out = tagMirrorPass(
      'wiki/concepts/A.md',
      '---\ntype: concept\ndomain: physics\ntags:\n  - concept\n  - physics\n  - optics\nstatus: seed\n---\n\n# A\n',
      vault,
    )
    expect(out?.after).toContain('  - optics')
    expect(out?.after).not.toContain('  - concept\n')
    expect(out?.after).not.toContain('  - physics\n')
    // Everything else about the frontmatter survives, in its order.
    expect(out?.after).toContain('status: seed')
    expect(out?.after).toContain('domain: physics')
  })

  it('keeps meta, which names what a page IS', () => {
    const out = tagMirrorPass('wiki/meta/A.md', '---\ntype: meta\ndomain: meta\ntags:\n  - meta\n---\n\n# A\n', vault)
    expect(out).toBeNull()
  })

  it('stops at the end of the tag list', () => {
    const out = tagMirrorPass(
      'wiki/concepts/A.md',
      '---\ntype: concept\ntags:\n  - concept\nrelated:\n  - "[[concept]]"\n---\n\n# A\n',
      vault,
    )
    // The related list has an entry that LOOKS like the tag; it is not a tag and stays.
    expect(out?.after).toContain('  - "[[concept]]"')
  })
})

describe('the run-protocol pass', () => {
  const body = [
    '# A',
    '',
    '## Connections',
    '',
    '- [[B]]',
    '',
    '## Status of This Page',
    '',
    'Written by a run on some date.',
    '',
    '## Assessment',
    '',
    'The source is thin on method.',
    '',
  ].join('\n')

  it('removes a bookkeeping section and stops at the next heading', () => {
    const out = runProtocolPass('wiki/concepts/A.md', `---\ntype: concept\n---\n\n${body}`, vault)
    expect(out?.after).not.toContain('Status of This Page')
    expect(out?.after).not.toContain('Written by a run')
    expect(out?.after).toContain('## Assessment')
    expect(out?.after).toContain('The source is thin on method.')
    expect(out?.after).toContain('## Connections')
  })

  it('leaves Editorial Note and Provenance for a person', () => {
    // They sometimes carry a real judgement about the source and sometimes nothing but
    // bookkeeping, and no rule tells the two apart. The phase forbids rewriting prose.
    for (const heading of ['Editorial Note', 'Provenance']) {
      const out = runProtocolPass('wiki/concepts/A.md', `---\ntype: concept\n---\n\n# A\n\n## ${heading}\n\nText.\n`, vault)
      expect(out, heading).toBeNull()
    }
  })

  it('takes a subsection with its section', () => {
    const out = runProtocolPass(
      'wiki/concepts/A.md',
      '---\ntype: concept\n---\n\n# A\n\n## Vault context\n\nText.\n\n### A detail of it\n\nMore.\n\n## Connections\n\n- [[B]]\n',
      vault,
    )
    expect(out?.after).not.toContain('A detail of it')
    expect(out?.after).toContain('## Connections')
  })
})

describe('the demo-seed pass', () => {
  it('marks an early page carrying the upstream footer', () => {
    const out = demoSeedPass(
      'wiki/concepts/A.md',
      '---\ntype: concept\ncreated: 2026-04-10\n---\n\n# A\n\nBuilt with claude-obsidian.\n',
      vault,
    )
    expect(out?.after).toContain('origin: upstream-demo')
    // Marked, never removed: the decision to delete stays with the user.
    expect(out?.after).toContain('# A')
  })

  it('needs both conditions, because either alone catches a real page', () => {
    const early = demoSeedPass('wiki/concepts/A.md', '---\ntype: concept\ncreated: 2026-04-10\n---\n\n# A\n\nReal material.\n', vault)
    expect(early).toBeNull()
    const footer = demoSeedPass('wiki/concepts/A.md', '---\ntype: concept\ncreated: 2026-08-10\n---\n\n# A\n\nBuilt with claude-obsidian.\n', vault)
    expect(footer).toBeNull()
  })

  it('does not mark a page twice', () => {
    const marked = '---\ntype: concept\ncreated: 2026-04-10\norigin: upstream-demo\n---\n\n# A\n\nclaude-obsidian.\n'
    expect(demoSeedPass('wiki/concepts/A.md', marked, vault)).toBeNull()
  })
})

describe('planTitleDrift', () => {
  it('finds a title its file name cannot carry, and who links to it by that title', () => {
    page('wiki/sources/Foo - Bar.md', 'type: source\ntitle: "Foo: Bar"', '# Foo: Bar\n')
    page('wiki/concepts/Other.md', 'type: concept', '# Other\n\nSee [[Foo: Bar]] and [[Foo: Bar|the source]].\n')
    page('wiki/concepts/Unrelated.md', 'type: concept', '# Unrelated\n\nNothing here.\n')
    const drift = planTitleDrift(vault, wikiPages(vault))
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ rel: 'wiki/sources/Foo - Bar.md', title: 'Foo: Bar', fileName: 'Foo - Bar' })
    expect(drift[0]?.linkedFrom).toEqual(['wiki/concepts/Other.md'])
  })

  it('says nothing about a page whose title and file name agree', () => {
    page('wiki/sources/Foo: Bar.md', 'type: source\ntitle: "Foo: Bar"', '# Foo: Bar\n')
    expect(planTitleDrift(vault, wikiPages(vault))).toEqual([])
  })
})

describe('diffOf', () => {
  it('shows the changed lines with context', () => {
    const edit = {
      rel: 'wiki/concepts/A.md',
      before: 'line one\nline — two\nline three\n',
      after: 'line one\nline - two\nline three\n',
      why: 'one dash replaced',
    }
    const diff = diffOf(edit)
    expect(diff).toContain('- line — two')
    expect(diff).toContain('+ line - two')
    expect(diff).toContain('  line one')
  })
})

/**
 * A diff whose display cannot be trusted is worse than no dry run, and the naive line-for-line
 * version becomes misleading the moment a line is REMOVED - which these passes do constantly.
 */
describe('diffOf handles a removed line', () => {
  it('shows one removal rather than rewriting every line after it', () => {
    const edit = {
      rel: 'wiki/concepts/A.md',
      before: 'tags:\n  - concept\n  - optics\nstatus: seed\nrelated:\n',
      after: 'tags:\n  - optics\nstatus: seed\nrelated:\n',
      why: 'removed 1 mirroring tag',
    }
    const diff = diffOf(edit)
    expect(diff.split('\n').filter((l) => l.startsWith('- '))).toEqual(['-   - concept'])
    expect(diff.split('\n').filter((l) => l.startsWith('+ '))).toEqual([])
    // The lines after the removal are context, not changes.
    expect(diff).toContain('    - optics')
  })

  it('elides the unchanged middle of a long page', () => {
    const before = ['# A', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'last — one'].join('\n')
    const edit = { rel: 'x', before, after: before.replace('—', '-'), why: 'one dash' }
    const diff = diffOf(edit)
    expect(diff).toContain('  ...')
    expect(diff.split('\n').length).toBeLessThan(10)
  })
})

/**
 * Found in the dry run over the live vault, and the reason the heading alone cannot decide it:
 * a section headed "Relation to This Vault's ... Coverage" carried a paragraph distinguishing
 * two sources, with wikilinks to both. That is a judgement about the material, under a heading
 * the task's list calls droppable. 99 of 116 such sections turned out to be like that.
 */
describe('the run-protocol pass refuses to drop content', () => {
  const withSection = (body: string): ReturnType<typeof runProtocolPass> =>
    runProtocolPass('wiki/concepts/A.md', `---\ntype: concept\n---\n\n# A\n\n## Status of This Page\n\n${body}\n`, vault)

  it('drops a short section that cites nothing', () => {
    expect(withSection('Written by an ingest run; no human review yet.')?.after).not.toContain('Status of This Page')
  })

  it('leaves one that cites other pages', () => {
    expect(withSection('This overlaps [[Another Page]] and should be read with it.')).toBeNull()
  })

  it('leaves a long one, whatever its heading says', () => {
    expect(withSection('A '.repeat(250))).toBeNull()
  })

  it('says what it left, so the number is visible rather than silent', () => {
    const out = runProtocolPass(
      'wiki/concepts/A.md',
      `---\ntype: concept\n---\n\n# A\n\n## Vault context\n\nShort and plain.\n\n## Automated Decisions\n\nSee [[Another Page]] for why.\n`,
      vault,
    )
    expect(out?.why).toContain('left 1 that carries content')
  })
})

/**
 * The address map, repaired in the direction nothing ever walked (8.3, N1).
 *
 * 274 of 1174 addressed pages are missing from the map, which makes the source index and the
 * dedupe lookup blind to the documents behind them.
 */
describe('planManifestRepair', () => {
  const manifest = (content: unknown): void => {
    fs.mkdirSync(path.join(vault, '.raw'), { recursive: true })
    fs.writeFileSync(path.join(vault, '.raw/.manifest.json'), JSON.stringify(content, null, 2))
  }

  it('adds an entry for every addressed page the map does not know', () => {
    page('wiki/concepts/Known.md', 'type: concept\naddress: c-000001', '# Known\n')
    page('wiki/concepts/Unknown.md', 'type: concept\naddress: c-000002', '# Unknown\n')
    manifest({ version: 1, address_map: { 'wiki/concepts/Known.md': 'c-000001' } })
    const plan = planManifestRepair(vault)
    expect(plan.added).toEqual([{ rel: 'wiki/concepts/Unknown.md', address: 'c-000002' }])
    expect(JSON.parse(plan.after!).address_map).toEqual({
      'wiki/concepts/Known.md': 'c-000001',
      'wiki/concepts/Unknown.md': 'c-000002',
    })
  })

  it('takes the page\'s own frontmatter as the authority, and ignores a malformed address', () => {
    page('wiki/concepts/Odd.md', 'type: concept\naddress: not-an-address', '# Odd\n')
    manifest({ version: 1, address_map: {} })
    expect(planManifestRepair(vault).added).toEqual([])
  })

  it('drops a pages_created entry whose page is gone, keeping the rest', () => {
    page('wiki/concepts/Here.md', 'type: concept', '# Here\n')
    manifest({
      version: 1,
      sources: { '.raw/01JOB/in.pdf': { pages_created: ['wiki/concepts/Here.md', 'wiki/concepts/Gone.md'] } },
    })
    const plan = planManifestRepair(vault)
    expect(plan.droppedPages).toEqual([{ source: '.raw/01JOB/in.pdf', page: 'wiki/concepts/Gone.md' }])
    expect(JSON.parse(plan.after!).sources['.raw/01JOB/in.pdf'].pages_created).toEqual(['wiki/concepts/Here.md'])
  })

  it('reports a job directory named nowhere rather than inventing a source for it', () => {
    // What document a directory holds and which pages came out of it is not derivable from
    // the directory, and a made-up provenance record is worse than a missing one.
    fs.mkdirSync(path.join(vault, '.raw/01ORPHAN'), { recursive: true })
    manifest({ version: 1, sources: {} })
    const plan = planManifestRepair(vault)
    expect(plan.unnamedDirs).toEqual(['01ORPHAN'])
    expect(plan.after).toBeNull()
  })

  it('changes nothing when the map is already right', () => {
    page('wiki/concepts/A.md', 'type: concept\naddress: c-000001', '# A\n')
    manifest({ version: 1, address_map: { 'wiki/concepts/A.md': 'c-000001' }, sources: {} })
    expect(planManifestRepair(vault).after).toBeNull()
  })

  it('is inert without a manifest, and on one that does not parse', () => {
    expect(planManifestRepair(vault).after).toBeNull()
    fs.mkdirSync(path.join(vault, '.raw'), { recursive: true })
    fs.writeFileSync(path.join(vault, '.raw/.manifest.json'), 'not json')
    expect(planManifestRepair(vault).after).toBeNull()
  })
})

/**
 * The regression this pass exists to repair, and the rule that caused it (2026-09-19).
 *
 * The first run of the em-dash pass over the live vault rewrote dashes inside `[[...]]` as
 * well as in prose. 199 links stopped resolving, because the pages they name carry the dash in
 * their own file names. A wikilink target is a NAME, the same as an address or a code span,
 * and the pass leaves all three alone now.
 */
describe('a wikilink target is a name', () => {
  it('is never touched by the em-dash pass', () => {
    const out = emDashPass(
      'wiki/concepts/A.md',
      '---\ntype: concept\n---\n\nSee [[Foo — Bar]] about this — that.\n',
      vault,
    )
    expect(out?.after).toContain('[[Foo — Bar]]')
    expect(out?.after).toContain('this - that')
  })

  it('is not touched inside an aliased or anchored link either', () => {
    const out = emDashPass(
      'wiki/concepts/A.md',
      '---\ntype: concept\n---\n\n[[Foo — Bar|the page]] and [[Foo — Bar#Section]] — here.\n',
      vault,
    )
    expect(out?.after).toContain('[[Foo — Bar|the page]]')
    expect(out?.after).toContain('[[Foo — Bar#Section]]')
  })
})

describe('dashLinkPass', () => {
  it('repoints a link that differs from a real page only in the dash', () => {
    page('wiki/sources/Foo — Bar.md', 'type: source\ntitle: "Foo — Bar"', '# Foo\n')
    page('wiki/concepts/Other.md', 'type: concept', '# Other\n\nSee [[Foo - Bar]].\n')
    const out = dashLinkPass(vault)('wiki/concepts/Other.md', '# Other\n\nSee [[Foo - Bar]].\n', vault)
    expect(out?.after).toContain('[[Foo — Bar]]')
  })

  it('leaves a link that already resolves', () => {
    page('wiki/sources/Foo - Bar.md', 'type: source', '# Foo\n')
    expect(dashLinkPass(vault)('x', 'See [[Foo - Bar]].\n', vault)).toBeNull()
  })

  it('refuses an ambiguous match rather than guessing', () => {
    // Two pages whose names differ only in the dash: which one a link meant is not a rule's
    // decision, and picking one silently is how a repair invents a fact.
    page('wiki/sources/Foo — Bar.md', 'type: source', '# A\n')
    page('wiki/sources/Foo – Bar.md', 'type: source', '# B\n')
    expect(dashLinkPass(vault)('x', 'See [[Foo - Bar]].\n', vault)).toBeNull()
  })

  it('keeps an alias and an anchor when it repoints', () => {
    page('wiki/sources/Foo — Bar.md', 'type: source', '# Foo\n')
    const out = dashLinkPass(vault)('x', 'See [[Foo - Bar|the source]] and [[Foo - Bar#Method]].\n', vault)
    expect(out?.after).toContain('[[Foo — Bar|the source]]')
    expect(out?.after).toContain('[[Foo — Bar#Method]]')
  })

  it('leaves a link to a page that does not exist in any spelling', () => {
    expect(dashLinkPass(vault)('x', 'See [[Nothing - Here]].\n', vault)).toBeNull()
  })
})

/**
 * The operation log, bounded (8.8). Last of the phase, and only safe because nothing decides a
 * job's status from this file any more (2.4): a truncated log under the old check would have
 * answered "not finished" for every job older than the window.
 */
describe('planLogArchive', () => {
  const log = (entries: number, month = '2026-09'): void => {
    const body = Array.from({ length: entries }, (_, i) => {
      const day = String(28 - (i % 28)).padStart(2, '0')
      return `## [${month}-${day}] ingest | Entry ${i}\n\n- Pages created: none\n`
    }).join('\n')
    page('wiki/log.md', 'type: meta\ntitle: "Operation Log"', `# Operation Log\n\nNavigation: [[index]]\n\n${body}`)
  }

  it('does nothing while the log is within the window', () => {
    log(5)
    expect(planLogArchive(vault, 25).log).toBeNull()
  })

  it('keeps the newest entries and archives the rest by month', () => {
    log(10, '2026-09')
    const before = fs.readFileSync(path.join(vault, 'wiki/log.md'), 'utf8')
    const plan = planLogArchive(vault, 4)
    expect(plan.kept).toBe(4)
    expect(plan.archived).toBe(6)
    expect(plan.archives.map((a) => a.rel)).toEqual(['wiki/folds/log-2026-09.md'])
    // The four newest are still in the log, and the archived ones are not.
    expect(plan.log).toContain('Entry 0')
    expect(plan.log).toContain('Entry 3')
    expect(plan.log).not.toContain('Entry 4')
    expect(plan.archives[0]?.content).toContain('Entry 4')
    // Nothing is lost: every entry is in one file or the other, unchanged.
    for (let i = 0; i < 10; i++) {
      const inLog = plan.log!.includes(`Entry ${i}\n`)
      const inArchive = plan.archives.some((a) => a.content.includes(`Entry ${i}\n`))
      expect(inLog !== inArchive, `Entry ${i}`).toBe(true)
    }
    expect(before).toContain('Entry 9')
  })

  it('keeps the head of the log and links to the archives', () => {
    log(10)
    const plan = planLogArchive(vault, 4)
    expect(plan.log).toContain('# Operation Log')
    expect(plan.log).toContain('Navigation: [[index]]')
    expect(plan.log).toContain('## Older entries')
    expect(plan.log).toContain('[[log-2026-09]]')
  })

  it('writes one archive page per month, each a readable fold page', () => {
    page('wiki/log.md', 'type: meta', [
      '# Operation Log',
      '',
      '## [2026-09-10] ingest | New',
      '',
      '- x',
      '',
      '## [2026-08-10] ingest | Older',
      '',
      '- y',
      '',
      '## [2026-07-10] ingest | Oldest',
      '',
      '- z',
      '',
    ].join('\n'))
    const plan = planLogArchive(vault, 1)
    expect(plan.archives.map((a) => a.rel)).toEqual(['wiki/folds/log-2026-07.md', 'wiki/folds/log-2026-08.md'])
    expect(plan.archives[0]?.content).toContain('type: fold')
    expect(plan.archives[0]?.content).toContain('Archived from [[log]]')
  })

  it('is inert on a vault with no log at all', () => {
    expect(planLogArchive(vault, 25)).toEqual({ log: null, archives: [], kept: 0, archived: 0 })
  })
})

/**
 * `overview.md` (2.6's DoD, applied in 8.1).
 *
 * The page was 89.4 kB. 1.6 kB of that was the plugin's shipped demo text on a vault of 1208
 * pages; the other 88 kB was two hand-maintained accumulations that the service now generates
 * or that `log.md` already holds. Measured before applying: of the 319 wikilinks in the dropped
 * sections, 318 are also in the regenerated index and the 319th is the page's own navigation
 * line, so the removal costs no reachability.
 */
describe('overviewPass', () => {
  // The pass reads nothing off disk; the vault root is part of the RepairPass contract.
  const VAULT_ROOT_UNUSED = '/nowhere'
  const page = (body: string): string => `---\ntype: overview\n---\n\n# Wiki Overview\n\nNav: [[index]]\n\n${body}`

  it('drops the sections that are counted or logged elsewhere', () => {
    const before = page(
      '## Current Seed Content\n\n- [[A]]\n\n## Beyond the Seed Domain\n\nOne very long line.\n\n' +
        '## Current State\n\n- Wiki pages: 1247\n- Prior activity: [[B]]\n\n## Key Themes\n\nKept.\n',
    )
    const out = overviewPass('wiki/overview.md', before, VAULT_ROOT_UNUSED)
    expect(out).not.toBeNull()
    expect(out!.after).not.toContain('Current Seed Content')
    expect(out!.after).not.toContain('Beyond the Seed Domain')
    expect(out!.after).not.toContain('Current State')
    expect(out!.after).toContain('## Key Themes')
    expect(out!.after).toContain('Kept.')
  })

  it('replaces the shipped demo text and says whose section it is', () => {
    const out = overviewPass(
      'wiki/overview.md',
      page('## Purpose\n\nThis is the claude-obsidian demo vault. It demonstrates things.\n\n---\n'),
      VAULT_ROOT_UNUSED,
    )
    expect(out!.after).not.toContain('claude-obsidian demo vault')
    expect(out!.after).toContain('## Purpose')
    expect(out!.after).toContain('hand-owned')
  })

  it('never writes a purpose for the vault, which is the user\'s sentence', () => {
    // A generator inventing what a vault is FOR is the one thing this pass must not do.
    const out = overviewPass('wiki/overview.md', page('## Purpose\n\nThis is the claude-obsidian demo vault.\n'), VAULT_ROOT_UNUSED)
    expect(out!.after).toContain('This section is hand-owned')
  })

  it('leaves a purpose the user already wrote exactly as it is', () => {
    const mine = page('## Purpose\n\nEverything I read about lipid chemistry.\n\n## Key Themes\n\nKept.\n')
    expect(overviewPass('wiki/overview.md', mine, VAULT_ROOT_UNUSED)).toBeNull()
  })

  it('leaves the generated counters block alone, markers included', () => {
    const before = page(
      '## Current State\n\n- Wiki pages: 1\n\n## Vault counters\n\n<!-- vault-service:counters -->\n\n- Pages: 7\n\n<!-- /vault-service:counters -->\n',
    )
    const out = overviewPass('wiki/overview.md', before, VAULT_ROOT_UNUSED)
    expect(out!.after).toContain('<!-- vault-service:counters -->')
    expect(out!.after).toContain('- Pages: 7')
    expect(out!.after).toContain('<!-- /vault-service:counters -->')
  })

  it('touches no other page, however much it looks like an overview', () => {
    const other = page('## Current State\n\n- Wiki pages: 1247\n')
    expect(overviewPass('wiki/meta/overview.md', other, VAULT_ROOT_UNUSED)).toBeNull()
    expect(overviewPass('wiki/concepts/Overview.md', other, VAULT_ROOT_UNUSED)).toBeNull()
  })

  it('is idempotent: a second run finds nothing to do', () => {
    const before = page('## Purpose\n\nThis is the claude-obsidian demo vault.\n\n## Current State\n\n- Wiki pages: 1\n')
    const once = overviewPass('wiki/overview.md', before, VAULT_ROOT_UNUSED)!.after
    expect(overviewPass('wiki/overview.md', once, VAULT_ROOT_UNUSED)).toBeNull()
  })
})

/**
 * `demoSeedPass` and the pages the SERVICE writes (8.7, corrected).
 *
 * The first run marked three hubs and would have marked a fold page. All four were created
 * when the vault was and quote the upstream footer, because the entries they carry do, so both
 * of the pass's conditions held and both conclusions were wrong. `origin: upstream-demo` on
 * the vault's own index tells every reader that counts pages to skip it.
 */
describe('demoSeedPass and service-written pages', () => {
  const V = '/nowhere'
  const shipped = (front = 'type: concept\ncreated: 2026-04-01'): string =>
    `---\n${front}\n---\n\n# A page\n\nBody.\n\n---\n\n*Part of the [claude-obsidian](https://github.com/x) community vault.*\n`

  it('still marks a content page that is really demo material', () => {
    const out = demoSeedPass('wiki/concepts/Shipped.md', shipped(), V)
    expect(out?.after).toContain('origin: upstream-demo')
  })

  it('does not mark a hub, however old it is', () => {
    for (const rel of ['wiki/index.md', 'wiki/log.md', 'wiki/overview.md', 'wiki/hot.md']) {
      // null, not "unchanged": the pass has nothing to say about a page the service writes.
      expect(demoSeedPass(rel, shipped('type: meta\ncreated: 2026-04-01'), V), rel).toBeNull()
    }
  })

  it('does not mark a fold page, which the service wrote in 8.8', () => {
    // Dated by the entries it archives, and it quotes the footer because they did.
    expect(demoSeedPass('wiki/folds/log-2026-04.md', shipped('type: fold\ncreated: 2026-04-01'), V)).toBeNull()
  })

  it('REMOVES a mark it already put on a page that is not content', () => {
    // A pass that only stops making a mistake leaves the mistake.
    const out = demoSeedPass('wiki/log.md', shipped('type: meta\ncreated: 2026-04-01\norigin: upstream-demo'), V)
    expect(out).not.toBeNull()
    expect(out!.after).not.toContain('origin:')
    expect(out!.why).toContain('not a content page')
  })

  it('leaves no blank line where the mark was', () => {
    const out = demoSeedPass('wiki/log.md', shipped('type: meta\norigin: upstream-demo'), V)
    expect(out!.after).toContain('---\ntype: meta\n---')
  })

  it('leaves a mark alone on a page that really is content', () => {
    expect(demoSeedPass('wiki/concepts/X.md', shipped('type: concept\ncreated: 2026-04-01\norigin: upstream-demo'), V)).toBeNull()
  })

  it('does not touch a bucket hub or a meta page', () => {
    expect(demoSeedPass('wiki/concepts/_index.md', shipped(), V)).toBeNull()
    expect(demoSeedPass('wiki/meta/notes.md', shipped(), V)).toBeNull()
  })
})

/**
 * `tagSingletonPass` (8.4, part two).
 *
 * 643 distinct tags over the working vault, 322 used exactly once, and none of those 322 a
 * spelling variant of a tag used elsewhere - so there was nothing to merge and the choice was
 * keep or drop. A tag naming one page groups nothing; it is a second title in the tag field.
 */
describe('tagSingletonPass', () => {
  let root = ''
  const page = (name: string, tags: string[]): void => {
    const abs = path.join(root, 'wiki', 'concepts', `${name}.md`)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const block = tags.length === 0 ? '' : `tags:\n${tags.map((t) => `  - ${t}`).join('\n')}\n`
    fs.writeFileSync(abs, `---\ntype: concept\n${block}status: seed\n---\n\n# ${name}\n`)
  }
  const run = (): ReturnType<typeof tagSingletonPass> => tagSingletonPass(root)
  const readOf = (name: string): string => fs.readFileSync(path.join(root, 'wiki', 'concepts', `${name}.md`), 'utf8')

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-single-'))
    page('A', ['shared', 'only-on-a'])
    page('B', ['shared', 'only-on-b'])
    page('C', ['just-this-one'])
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('drops a tag that names exactly one page', () => {
    const out = run()('wiki/concepts/A.md', readOf('A'), root)
    expect(out!.after).toContain('- shared')
    expect(out!.after).not.toContain('only-on-a')
  })

  it('keeps a tag two pages share, however few that is', () => {
    // Two is a group. The rule is "names one page", not "is rare".
    expect(run()('wiki/concepts/A.md', readOf('A'), root)!.after).toContain('- shared')
  })

  it('leaves a page whose EVERY tag is a singleton completely alone', () => {
    // Measured: emptying the block put 36 pages in violation of the vault's own page
    // template, which requires `tags:`. The pass had not found those problems, it had made
    // them. An imperfect tag beats a page the vault's own lint rejects.
    expect(run()('wiki/concepts/C.md', readOf('C'), root)).toBeNull()
  })

  it('leaves a page with no singleton alone', () => {
    page('D', ['shared'])
    expect(run()('wiki/concepts/D.md', readOf('D'), root)).toBeNull()
  })

  it('touches nothing but the tag block', () => {
    const before = readOf('A')
    const out = run()('wiki/concepts/A.md', before, root)!.after
    expect(out).toContain('type: concept')
    expect(out).toContain('status: seed')
    expect(bodyOf(out)).toBe(bodyOf(before))
  })

  it('is idempotent against its own output for the pages it already cleaned', () => {
    const once = run()('wiki/concepts/A.md', readOf('A'), root)!.after
    // The scan is of the vault on disk, so re-running the SAME pass over cleaned text finds
    // nothing more: the singleton it knew about is gone from this page.
    expect(run()('wiki/concepts/A.md', once, root)).toBeNull()
  })

  it('reads a quoted tag the same as a bare one', () => {
    page('E', ['"quoted-singleton"', 'shared'])
    const out = run()('wiki/concepts/E.md', readOf('E'), root)
    expect(out!.after).not.toContain('quoted-singleton')
  })
})

/**
 * `recordSectionPass` (8.5, part two): the run's notes move to the foot, keeping every word.
 *
 * `runProtocolPass` removes a section that is short and cites nothing, which is boilerplate by
 * any reading. It left 273 sections over eight headings, and they were left BECAUSE they carry
 * arguments. Deleting those would be a prose rewrite, which the phase forbids; leaving them
 * mid-article is what made the articles unreadable. So they move.
 */
describe('recordSectionPass', () => {
  const V = '/nowhere'
  const page = (body: string): string => `---\ntype: concept\n---\n\n# The Subject\n\nA paragraph.\n\n${body}`

  it('moves a section to the foot under one heading, keeping its own name', () => {
    const out = recordSectionPass('wiki/concepts/X.md', page('## Provenance\n\nA caveat with [[A Link]].\n'), V)
    expect(out!.after).toContain('## About This Page')
    expect(out!.after).toContain('### Provenance')
    expect(out!.after).toContain('A caveat with [[A Link]].')
    // The article now reads through: the subject's own prose comes before the record.
    expect(out!.after.indexOf('A paragraph.')).toBeLessThan(out!.after.indexOf('## About This Page'))
  })

  it('keeps every word, so the page barely changes size', () => {
    const before = page('## Assessment\n\nThe source overstates its case.\n\n## Findings\n\nReal content.\n')
    const out = recordSectionPass('wiki/concepts/X.md', before, V)!.after
    expect(out).toContain('The source overstates its case.')
    expect(out).toContain('Real content.')
  })

  it('moves several sections in the order they appeared', () => {
    const out = recordSectionPass(
      'wiki/concepts/X.md',
      page('## Editorial Note\n\nOne.\n\n## Findings\n\nKept.\n\n## Provenance\n\nTwo.\n'),
      V,
    )!.after
    expect(out.indexOf('### Editorial Note')).toBeLessThan(out.indexOf('### Provenance'))
    expect(out.indexOf('## Findings')).toBeLessThan(out.indexOf('## About This Page'))
  })

  it('is idempotent: a second run finds nothing to move', () => {
    // What makes it safe to run after every ingest later.
    const once = recordSectionPass('wiki/concepts/X.md', page('## Provenance\n\nA caveat.\n'), V)!.after
    expect(recordSectionPass('wiki/concepts/X.md', once, V)).toBeNull()
  })

  it('merges into a container the page already has', () => {
    const before = page('## Assessment\n\nNew.\n\n## About This Page\n\n### Provenance\n\nOld.\n')
    const out = recordSectionPass('wiki/concepts/X.md', before, V)!.after
    expect(out.match(/## About This Page/g)).toHaveLength(1)
    expect(out).toContain('### Assessment')
    expect(out).toContain('Old.')
  })

  it('NEVER moves Open Questions, which is a live feature', () => {
    // `candidates.ts` reads that section BY NAME to plan a Fellow's work and
    // `POST /questions/archive` strikes through its bullets. Renaming it breaks the planner
    // silently, which is the same shape of mistake as correction C-1.
    expect(recordSectionPass('wiki/concepts/X.md', page('## Open Questions\n\n- Does it?\n'), V)).toBeNull()
  })

  it('leaves a page with nothing to move alone', () => {
    expect(recordSectionPass('wiki/concepts/X.md', page('## Findings\n\nJust content.\n'), V)).toBeNull()
  })

  it('does not touch the vault\'s own pages', () => {
    const body = page('## Provenance\n\nA caveat.\n')
    expect(recordSectionPass('wiki/meta/report.md', body, V)).toBeNull()
    expect(recordSectionPass('wiki/folds/log-2026-04.md', body, V)).toBeNull()
  })

  it('leaves the frontmatter untouched', () => {
    const before = page('## Provenance\n\nA caveat.\n')
    const out = recordSectionPass('wiki/concepts/X.md', before, V)!.after
    expect(out.startsWith('---\ntype: concept\n---\n')).toBe(true)
  })

  it('ends the page with exactly one newline', () => {
    const out = recordSectionPass('wiki/concepts/X.md', page('## Provenance\n\nA caveat.\n'), V)!.after
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })
})

/**
 * `titleLinkPass` (8.2, part two), and a correction to the plan it implements.
 *
 * The plan read the divergence as one mechanism: a page titled `Foo: Bar` is FILED as
 * `Foo - Bar`, so repairing the title at the source stops the class regenerating. Measured, the
 * best single transformation explains 7 of the 42 colon cases and nothing explains the rest -
 * the file names were never derived from the titles. A run chose a name and separately chose a
 * title, and a file name is often a deliberately shorter one.
 *
 * So the repair is the other half: of 61 drifted pages only 11 are linked from anywhere, and
 * those links are repointed to the basename with the title kept as display text.
 */
describe('titleLinkPass', () => {
  let root = ''
  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  const readOf = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'title-link-'))
    // Filed under a name the colon cannot survive, titled with the colon.
    write('wiki/sources/Paper - A Study.md', '---\ntype: source\ntitle: "Paper: A Study"\n---\n\n# Paper\n')
    write('wiki/concepts/Cites It.md', '---\ntype: concept\n---\n\nSee [[Paper: A Study]] for detail.\n')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('repoints a link to the basename and keeps the title as display text', () => {
    const out = titleLinkPass(root)('wiki/concepts/Cites It.md', readOf('wiki/concepts/Cites It.md'), root)
    expect(out!.after).toContain('[[Paper - A Study|Paper: A Study]]')
  })

  it('rewrites only the target of a link that already has display text', () => {
    write('wiki/concepts/Cites It.md', '---\ntype: concept\n---\n\nSee [[Paper: A Study|the paper]].\n')
    const out = titleLinkPass(root)('wiki/concepts/Cites It.md', readOf('wiki/concepts/Cites It.md'), root)
    expect(out!.after).toContain('[[Paper - A Study|the paper]]')
  })

  it('keeps a heading anchor', () => {
    write('wiki/concepts/Cites It.md', '---\ntype: concept\n---\n\nSee [[Paper: A Study#Method]].\n')
    expect(titleLinkPass(root)('wiki/concepts/Cites It.md', readOf('wiki/concepts/Cites It.md'), root)!.after).toContain(
      '[[Paper - A Study#Method]]',
    )
  })

  it('leaves an embed alone, because a missing image is not a link to repoint', () => {
    write('wiki/concepts/Cites It.md', '---\ntype: concept\n---\n\n![[Paper: A Study]]\n')
    expect(titleLinkPass(root)('wiki/concepts/Cites It.md', readOf('wiki/concepts/Cites It.md'), root)).toBeNull()
  })

  it('touches a page that links to nothing drifted not at all', () => {
    write('wiki/concepts/Innocent.md', '---\ntype: concept\n---\n\nSee [[Something Else]].\n')
    expect(titleLinkPass(root)('wiki/concepts/Innocent.md', readOf('wiki/concepts/Innocent.md'), root)).toBeNull()
  })

  it('never renames a page or rewrites its title', () => {
    // 50 of the 61 are linked from nowhere. Nothing is broken about them, so nothing is done.
    const before = readOf('wiki/sources/Paper - A Study.md')
    expect(titleLinkPass(root)('wiki/sources/Paper - A Study.md', before, root)).toBeNull()
  })

  it('repoints links in frontmatter as well as in prose', () => {
    write(
      'wiki/concepts/Cites It.md',
      '---\ntype: concept\nrelated:\n  - "[[Paper: A Study]]"\n---\n\nAnd [[Paper: A Study]] again.\n',
    )
    const out = titleLinkPass(root)('wiki/concepts/Cites It.md', readOf('wiki/concepts/Cites It.md'), root)
    expect(out!.after.match(/\[\[Paper - A Study\|/g)).toHaveLength(2)
  })

  it('is idempotent: a repointed link is not repointed again', () => {
    const once = titleLinkPass(root)('wiki/concepts/Cites It.md', readOf('wiki/concepts/Cites It.md'), root)!.after
    expect(titleLinkPass(root)('wiki/concepts/Cites It.md', once, root)).toBeNull()
  })
})

/**
 * `bucketRegroupPass` (2.7, applied in 8.1) - and the measurement that changed the plan.
 *
 * The `_index.md` hubs look like event logs: 394 headings across three files, most of the form
 * `## mRNA Delivery (new domain, 2026-07-17)`, and the plan called for dropping them and
 * generating a page list in their place. Measured before doing it: those sections hold 1129
 * entries and EVERY ONE carries a hand-written one-line description, covering 595 of 604
 * concepts, 327 of 338 sources, 206 of 225 entities. The text exists nowhere else.
 *
 * So the defect is the organisation, not the content: grouped by the ingest that wrote each
 * entry, which is the vault's history rather than its subject.
 */
describe('bucketRegroupPass', () => {
  let root = ''
  const hub = (body: string): string =>
    `---\ntype: meta\n---\n\n# Concepts Index\n\nCurated prose nobody generated.\n\n${body}`
  const page = (name: string, domain: string): void => {
    const abs = path.join(root, 'wiki', 'concepts', `${name}.md`)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, `---\ntype: concept\ndomain: ${domain}\n---\n\n# ${name}\n`)
  }
  const run = (): ReturnType<typeof bucketRegroupPass> => bucketRegroupPass(root)

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bucket-regroup-'))
    page('Alpha', 'physics')
    page('Beta', 'biology')
    page('Gamma', 'physics')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('keeps every description, word for word', () => {
    const before = hub(
      '## Something (new domain, 2026-07-17)\n\n- [[Alpha]] - the first one, in detail\n\n## Later (2026-08-01)\n\n- [[Beta]] - a different subject entirely\n',
    )
    const out = run()('wiki/concepts/_index.md', before, root)!.after
    expect(out).toContain('- [[Alpha]] - the first one, in detail')
    expect(out).toContain('- [[Beta]] - a different subject entirely')
  })

  it('groups by the page\'s own domain and drops the dates from the headings', () => {
    const before = hub('## Whatever (2026-07-17)\n\n- [[Alpha]] - one\n- [[Beta]] - two\n')
    const out = run()('wiki/concepts/_index.md', before, root)!.after
    expect(out).toContain('## physics')
    expect(out).toContain('## biology')
    expect(out).not.toContain('2026-07-17')
  })

  it('adds a page the hub never listed, so the gap is visible rather than silent', () => {
    const out = run()('wiki/concepts/_index.md', hub('## X (2026-07-17)\n\n- [[Alpha]] - one\n'), root)!
    expect(out.after).toContain('[[Gamma]]')
    expect(out.why).toContain('unlisted page')
  })

  it('writes no description for a page it is adding', () => {
    // Inventing one is exactly what this pass may not do.
    const out = run()('wiki/concepts/_index.md', hub('## X (2026-07-17)\n\n- [[Alpha]] - one\n'), root)!.after
    expect(out).toMatch(/^- \[\[Gamma\]\]$/m)
  })

  it('keeps the LONGER description when a page is listed twice', () => {
    // Both were written by runs and neither is authoritative; "whichever came first" is a coin
    // toss dressed as a rule.
    const before = hub('## A (2026-07-17)\n\n- [[Alpha]] - short\n\n## B (2026-08-01)\n\n- [[Alpha]] - a much longer account\n')
    const out = run()('wiki/concepts/_index.md', before, root)!.after
    expect(out).toContain('a much longer account')
    expect(out.match(/\[\[Alpha\]\]/g)).toHaveLength(1)
  })

  it('leaves the head byte for byte, frontmatter and curated prose included', () => {
    const before = hub('## X (2026-07-17)\n\n- [[Alpha]] - one\n')
    const out = run()('wiki/concepts/_index.md', before, root)!.after
    expect(out.slice(0, out.search(/^## /m))).toBe(before.slice(0, before.search(/^## /m)))
    expect(out).toContain('Curated prose nobody generated.')
  })

  it('keeps an entry whose link resolves to nothing, because it is a record', () => {
    const out = run()('wiki/concepts/_index.md', hub('## X (2026-07-17)\n\n- [[A Deleted Page]] - what it was\n'), root)!
    expect(out.after).toContain('[[A Deleted Page]] - what it was')
  })

  it('is idempotent, which is what lets a run keep it current later', () => {
    const once = run()('wiki/concepts/_index.md', hub('## X (2026-07-17)\n\n- [[Alpha]] - one\n'), root)!.after
    expect(run()('wiki/concepts/_index.md', once, root)).toBeNull()
  })

  it('touches nothing but a bucket hub', () => {
    const body = hub('## X (2026-07-17)\n\n- [[Alpha]] - one\n')
    expect(run()('wiki/index.md', body, root)).toBeNull()
    expect(run()('wiki/concepts/Alpha.md', body, root)).toBeNull()
  })
})
