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
