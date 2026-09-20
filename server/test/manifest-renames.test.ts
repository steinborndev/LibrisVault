/**
 * Following a rename into `.raw/.manifest.json` (2026-09-21).
 *
 * A lint-fix run shortened a source page's over-long title, which shortened its file name, and
 * rewrote every wikilink to it. It left the manifest alone on purpose, treating `.raw/` as
 * service-owned. Nothing else followed the rename, so the manifest kept naming a file that no
 * longer existed, in the `address_map` entry carrying the page's address and in the
 * `pages_created` list of the job that produced it. Both halves are pinned here, and the last
 * test runs a real rename through a real commit.
 *
 * Page names are invented (hard rule 7), but shaped like the real ones: spaces, commas,
 * parentheses and periods, which is what broke a line-based parse of `--name-status`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { followRenames, parseStagedRenames, MANIFEST_PATH } from '../src/pipeline/manifest-renames.js'
import { commitVault } from '../src/pipeline/git.js'

const OLD = 'wiki/sources/A Very Long Title About Films (Author et al., Journal 2021).md'
const NEW = 'wiki/sources/A Shorter Title About Films (Author et al., Journal 2021).md'

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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-manifest-'))
  fs.mkdirSync(path.join(root, '.raw'), { recursive: true })
  fs.writeFileSync(path.join(root, MANIFEST_PATH), `${JSON.stringify(manifest(), null, 2)}\n`)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('reading the renames out of a staged diff', () => {
  const z = (...fields: string[]): string => fields.join('\0')

  it('reads the three-field rename record, and leaves every other status alone', () => {
    const out = parseStagedRenames(z('M', 'wiki/concepts/Kept.md', 'R096', OLD, NEW, 'A', 'wiki/concepts/New.md', ''))
    expect(out).toEqual([{ from: OLD, to: NEW }])
  })

  it('ignores a rename outside wiki/, which is not a page', () => {
    expect(parseStagedRenames(z('R100', '.raw/a.txt', '.raw/b.txt', ''))).toEqual([])
  })

  it('reads several renames in one diff', () => {
    const out = parseStagedRenames(z('R090', OLD, NEW, 'R100', 'wiki/concepts/A.md', 'wiki/concepts/B.md', ''))
    expect(out.map((r) => r.to)).toEqual([NEW, 'wiki/concepts/B.md'])
  })

  it('is not confused by a truncated record', () => {
    expect(parseStagedRenames(z('R096', OLD))).toEqual([])
  })
})

describe('following a rename into the manifest', () => {
  it('moves the address entry and the pages_created entry, and nothing else', () => {
    expect(followRenames(root, [{ from: OLD, to: NEW }])).toBe(true)
    const m = readManifest()
    expect(m.address_map[NEW]).toBe('c-001189')
    expect(m.address_map[OLD]).toBeUndefined()
    expect(m.sources['.raw/01ABC/normalized.txt']!.pages_created).toEqual(['wiki/concepts/Kept.md', NEW])
    // Untouched neighbours, and the address itself is never invented or changed.
    expect(m.address_map['wiki/concepts/Kept.md']).toBe('c-000001')
    expect(m.sources['.raw/01DEF/normalized.txt']!.pages_created).toEqual(['wiki/concepts/Other.md'])
  })

  it('keeps the order of the address map, so the repair is not a whole-file reformat', () => {
    followRenames(root, [{ from: OLD, to: NEW }])
    expect(Object.keys(readManifest().address_map)).toEqual(['wiki/concepts/Kept.md', NEW, 'wiki/concepts/Other.md'])
  })

  it('reports no change when the manifest never named the page', () => {
    expect(followRenames(root, [{ from: 'wiki/concepts/Unknown.md', to: 'wiki/concepts/Renamed.md' }])).toBe(false)
  })

  it('refuses to merge onto an entry that already exists', () => {
    const to = 'wiki/concepts/Kept.md'
    expect(followRenames(root, [{ from: OLD, to }])).toBe(true) // the pages_created half still applies
    expect(readManifest().address_map[to]).toBe('c-000001')
    expect(readManifest().address_map[OLD]).toBe('c-001189')
  })

  it('leaves a manifest it cannot parse exactly as it found it', () => {
    fs.writeFileSync(path.join(root, MANIFEST_PATH), '{ not json')
    expect(followRenames(root, [{ from: OLD, to: NEW }])).toBe(false)
    expect(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8')).toBe('{ not json')
  })

  it('does nothing when there is no manifest at all', () => {
    fs.rmSync(path.join(root, MANIFEST_PATH))
    expect(followRenames(root, [{ from: OLD, to: NEW }])).toBe(false)
  })
})

describe('a commit that renames a page', () => {
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  }

  it('carries the manifest repair in the runs own commit', async () => {
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    fs.mkdirSync(path.join(root, 'wiki/sources'), { recursive: true })
    fs.writeFileSync(path.join(root, OLD), 'body long enough for git to match on content\n'.repeat(8))
    git('add', '-A')
    git('commit', '-q', '-m', 'base')

    // What the run does: the page moves, the manifest does not.
    fs.renameSync(path.join(root, OLD), path.join(root, NEW))
    const res = await commitVault(root, 'maintenance: lint-fix (safe findings)')

    expect(res.committed).toBe(true)
    const m = readManifest()
    expect(m.address_map[NEW]).toBe('c-001189')
    expect(m.sources['.raw/01ABC/normalized.txt']!.pages_created).toContain(NEW)
    // One commit, not two: the repair is inside the run's own.
    const files = execFileSync('git', ['-C', root, 'show', '--name-only', '--pretty=format:', 'HEAD'], { encoding: 'utf8' })
    expect(files).toContain(MANIFEST_PATH)
    expect(execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('2')
  })
})
