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
} from '../src/pipeline/repair.js'
import { fieldOf, CONTENT_UPDATED } from '../src/pipeline/page-dates.js'

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
