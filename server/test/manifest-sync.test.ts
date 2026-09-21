/**
 * Keeping `.raw/.manifest.json` in step with a run's commit (2026-09-21).
 *
 * Two ways it fell behind on the live vault, both pinned here.
 *
 * A lint-fix run shortened a source page's over-long title, which shortened its file name, and
 * rewrote every wikilink to it. It left the manifest alone on purpose, treating `.raw/` as
 * service-owned. Nothing else followed the rename, so the manifest kept naming a file that no
 * longer existed, in the `address_map` entry carrying the page's address and in the
 * `pages_created` list of the job that produced it.
 *
 * And a research run gave five new pages an address without recording any of them: the
 * autoresearch skill never mentions addressing, so nothing told the run to. 73 of 1274
 * addressed pages were missing from the map, every one of them written by a research run.
 *
 * The last test runs a real rename and a real new page through a real commit.
 *
 * Page names are invented (hard rule 7), but shaped like the real ones: spaces, commas,
 * parentheses and periods, which is what broke a line-based parse of `--name-status`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { syncManifest, parseStagedChanges, addressOf, MANIFEST_PATH, type StagedChanges } from '../src/pipeline/manifest-sync.js'
import { commitVault } from '../src/pipeline/git.js'

const OLD = 'wiki/sources/A Very Long Title About Films (Author et al., Journal 2021).md'
const NEW = 'wiki/sources/A Shorter Title About Films (Author et al., Journal 2021).md'
const FRESH = 'wiki/concepts/A Freshly Researched Thing.md'

const manifest = () => ({
  version: 1,
  sources: {
    '.raw/01ABC/normalized.txt': { pages_created: ['wiki/concepts/Kept.md', OLD] },
    '.raw/01DEF/normalized.txt': { pages_created: ['wiki/concepts/Other.md'] },
  },
  address_map: { 'wiki/concepts/Kept.md': 'c-000001', [OLD]: 'c-001189', 'wiki/concepts/Other.md': 'c-000002' },
})

let root: string
interface Manifest {
  readonly sources: Record<string, { pages_created: string[] } | undefined>
  readonly address_map: Record<string, string | undefined>
}
const readManifest = (): Manifest => JSON.parse(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8')) as Manifest
const changes = (over: Partial<StagedChanges> = {}): StagedChanges => ({ renames: [], added: [], ...over })

const page = (rel: string, front: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), `---\ntype: concept\n${front}---\n\n# A page\n\nBody.\n`)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-manifest-'))
  fs.mkdirSync(path.join(root, '.raw'), { recursive: true })
  fs.writeFileSync(path.join(root, MANIFEST_PATH), `${JSON.stringify(manifest(), null, 2)}\n`)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('reading what a commit is about to record', () => {
  const z = (...fields: string[]): string => fields.join('\0')

  it('reads the three-field rename record, and the two-field ones beside it', () => {
    const out = parseStagedChanges(z('M', 'wiki/concepts/Kept.md', 'R096', OLD, NEW, 'A', FRESH, ''))
    expect(out.renames).toEqual([{ from: OLD, to: NEW }])
    expect(out.added).toEqual([FRESH])
  })

  it('ignores what happens outside wiki/, which is not a page', () => {
    const out = parseStagedChanges(z('R100', '.raw/a.txt', '.raw/b.txt', 'A', '.raw/01ABC/normalized.txt', ''))
    expect(out).toEqual({ renames: [], added: [] })
  })

  it('reads several renames in one diff', () => {
    const out = parseStagedChanges(z('R090', OLD, NEW, 'R100', 'wiki/concepts/A.md', 'wiki/concepts/B.md', ''))
    expect(out.renames.map((r) => r.to)).toEqual([NEW, 'wiki/concepts/B.md'])
  })

  it('counts a modification or a deletion as neither', () => {
    const out = parseStagedChanges(z('M', 'wiki/concepts/Kept.md', 'D', 'wiki/concepts/Gone.md', ''))
    expect(out).toEqual({ renames: [], added: [] })
  })

  it('is not confused by a truncated record', () => {
    expect(parseStagedChanges(z('R096', OLD))).toEqual({ renames: [], added: [] })
  })
})

describe('following a rename into the manifest', () => {
  it('moves the address entry and the pages_created entry, and nothing else', () => {
    expect(syncManifest(root, changes({ renames: [{ from: OLD, to: NEW }] }))).toBe(true)
    const m = readManifest()
    expect(m.address_map[NEW]).toBe('c-001189')
    expect(m.address_map[OLD]).toBeUndefined()
    expect(m.sources['.raw/01ABC/normalized.txt']!.pages_created).toEqual(['wiki/concepts/Kept.md', NEW])
    // Untouched neighbours, and the address itself is never invented or changed.
    expect(m.address_map['wiki/concepts/Kept.md']).toBe('c-000001')
    expect(m.sources['.raw/01DEF/normalized.txt']!.pages_created).toEqual(['wiki/concepts/Other.md'])
  })

  it('keeps the order of the address map, so the update is not a whole-file reformat', () => {
    syncManifest(root, changes({ renames: [{ from: OLD, to: NEW }] }))
    expect(Object.keys(readManifest().address_map)).toEqual(['wiki/concepts/Kept.md', NEW, 'wiki/concepts/Other.md'])
  })

  it('reports no change when the manifest never named the page', () => {
    expect(syncManifest(root, changes({ renames: [{ from: 'wiki/concepts/Unknown.md', to: 'wiki/concepts/Renamed.md' }] }))).toBe(false)
  })

  it('refuses to merge onto an entry that already exists', () => {
    const to = 'wiki/concepts/Kept.md'
    expect(syncManifest(root, changes({ renames: [{ from: OLD, to }] }))).toBe(true) // the pages_created half still applies
    expect(readManifest().address_map[to]).toBe('c-000001')
    expect(readManifest().address_map[OLD]).toBe('c-001189')
  })
})

describe('recording a new page that already carries an address', () => {
  it('writes down which page holds it', () => {
    page(FRESH, 'address: c-001292\n')
    expect(syncManifest(root, changes({ added: [FRESH] }))).toBe(true)
    expect(readManifest().address_map[FRESH]).toBe('c-001292')
  })

  it('leaves a page with no address of its own alone', () => {
    // A missing address is a different defect, the one the vault's lint reports. Inventing a
    // number here would be the worst possible answer to it.
    page(FRESH, '')
    expect(syncManifest(root, changes({ added: [FRESH] }))).toBe(false)
    expect(readManifest().address_map[FRESH]).toBeUndefined()
  })

  it('never overwrites an entry the map already holds', () => {
    page(OLD, 'address: c-999999\n')
    expect(syncManifest(root, changes({ added: [OLD] }))).toBe(false)
    expect(readManifest().address_map[OLD]).toBe('c-001189')
  })

  it('does both halves when one commit renames a page and adds another', () => {
    // `||` between them would have skipped this second half entirely.
    page(FRESH, 'address: c-001292\n')
    expect(syncManifest(root, changes({ renames: [{ from: OLD, to: NEW }], added: [FRESH] }))).toBe(true)
    const m = readManifest()
    expect(m.address_map[NEW]).toBe('c-001189')
    expect(m.address_map[FRESH]).toBe('c-001292')
  })
})

describe('reading the address a page states', () => {
  it('takes it out of the frontmatter block, quoted or not', () => {
    page(FRESH, 'address: "c-000042"\n')
    expect(addressOf(root, FRESH)).toBe('c-000042')
  })

  it('refuses anything that is not an address', () => {
    page(FRESH, 'address: not-an-address\n')
    expect(addressOf(root, FRESH)).toBeNull()
  })

  it('does not take one out of the body, where it is prose', () => {
    fs.mkdirSync(path.join(root, 'wiki/concepts'), { recursive: true })
    fs.writeFileSync(path.join(root, FRESH), '---\ntype: concept\n---\n\n# A page\n\naddress: c-000042 is quoted here.\n')
    expect(addressOf(root, FRESH)).toBeNull()
  })

  it('returns null for a page that is not there', () => {
    expect(addressOf(root, 'wiki/concepts/Absent.md')).toBeNull()
  })
})

describe('a manifest that cannot be updated safely', () => {
  it('is left exactly as it was found when it will not parse', () => {
    fs.writeFileSync(path.join(root, MANIFEST_PATH), '{ not json')
    expect(syncManifest(root, changes({ renames: [{ from: OLD, to: NEW }] }))).toBe(false)
    expect(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8')).toBe('{ not json')
  })

  it('is not created when there is none', () => {
    fs.rmSync(path.join(root, MANIFEST_PATH))
    expect(syncManifest(root, changes({ renames: [{ from: OLD, to: NEW }] }))).toBe(false)
    expect(fs.existsSync(path.join(root, MANIFEST_PATH))).toBe(false)
  })
})

describe('a commit that renames one page and adds another', () => {
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  }

  it('carries both manifest updates in the run own commit', async () => {
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    fs.mkdirSync(path.join(root, 'wiki/sources'), { recursive: true })
    fs.writeFileSync(path.join(root, OLD), 'body long enough for git to match on content\n'.repeat(8))
    git('add', '-A')
    git('commit', '-q', '-m', 'base')

    // What the run does: one page moves, one is new, and the manifest is not touched by it.
    fs.renameSync(path.join(root, OLD), path.join(root, NEW))
    page(FRESH, 'address: c-001292\n')
    const res = await commitVault(root, 'maintenance: research-step')

    expect(res.committed).toBe(true)
    const m = readManifest()
    expect(m.address_map[NEW]).toBe('c-001189')
    expect(m.address_map[FRESH]).toBe('c-001292')
    expect(m.sources['.raw/01ABC/normalized.txt']!.pages_created).toContain(NEW)
    // One commit, not two: the update is inside the run's own.
    const files = execFileSync('git', ['-C', root, 'show', '--name-only', '--pretty=format:', 'HEAD'], { encoding: 'utf8' })
    expect(files).toContain(MANIFEST_PATH)
    expect(execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('2')
  })
})
