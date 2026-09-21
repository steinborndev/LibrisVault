import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureVaultExcludes, DERIVED_RAW_ENTRIES } from '../src/pipeline/vault-excludes.js'

/**
 * The write path (entries appended, idempotent, a user's own lines kept) is covered next to the
 * retrieval index in retrieve-index.test.ts. This file is about the one case that used to fail
 * the whole start-up: a vault this process cannot write. A hosted demo mounts its vault
 * read-only on purpose (SPEC.md §12.8), and a fresh seed there has no exclude file yet.
 */
describe('ensureVaultExcludes', () => {
  const vault = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-'))
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
    return root
  }

  it('names what it did: nothing to exclude from, written, then present', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-'))
    expect(ensureVaultExcludes(plain)).toBe('no-git')
    const root = vault()
    expect(ensureVaultExcludes(root)).toBe('written')
    expect(ensureVaultExcludes(root)).toBe('present')
    fs.rmSync(plain, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  })

  // Root ignores directory modes, so the refusal cannot be provoked there.
  it.skipIf(process.getuid?.() === 0)('reports a vault it cannot write instead of throwing', () => {
    const root = vault()
    const info = path.join(root, '.git', 'info')
    fs.chmodSync(info, 0o555)
    try {
      expect(ensureVaultExcludes(root)).toBe('unwritable')
      expect(fs.existsSync(path.join(info, 'exclude'))).toBe(false)
    } finally {
      fs.chmodSync(info, 0o755)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * Derived payloads inside a tracked job directory (N2, D4, 6.1).
 *
 * `.raw/` is tracked on purpose - a commit captures the source beside the pages made from it -
 * and `ocr.pdf` is not a source: it is rebuilt from the original PDF lying next to it. The
 * measurement that made this a task: 627 MiB in 16 blobs, 37 % of the vault's whole history,
 * against 232 MiB for every wiki page ever written.
 */
describe('the derived-payload exclude', () => {
  const vault = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-derived-'))
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
    return root
  }

  it('covers the OCR rendering and nothing else of the job directory', () => {
    expect([...DERIVED_RAW_ENTRIES]).toEqual(['.raw/*/ocr.pdf'])
  })

  it('leaves the normalised text tracked, because it is what the run actually read', () => {
    // 1.8 MB across 300 blobs, and both the quote check and the provenance links point at it.
    // Cheap, and evidence.
    for (const entry of DERIVED_RAW_ENTRIES) {
      expect(entry).not.toContain('normalized')
    }
  })

  it('appends the entry once, and leaves a user\'s own lines alone', () => {
    const root = vault()
    fs.writeFileSync(path.join(root, '.git/info/exclude'), '# mine\nscratch/\n')
    expect(ensureVaultExcludes(root)).toBe('written')
    expect(ensureVaultExcludes(root)).toBe('present')
    const written = fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8')
    expect(written).toContain('# mine')
    expect(written).toContain('scratch/')
    expect(written.split('\n').filter((l) => l === '.raw/*/ocr.pdf')).toHaveLength(1)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('is a no-op on a directory that is not a git repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-plain-'))
    expect(ensureVaultExcludes(plain)).toBe('no-git')
    fs.rmSync(plain, { recursive: true, force: true })
  })

  it('really keeps git from seeing the file', () => {
    // The pattern, not just the string: `.raw/*/ocr.pdf` has to match a job directory one
    // level down, and to leave the original beside it alone.
    const root = vault()
    execFileSync('git', ['-C', root, 'init', '-q'])
    ensureVaultExcludes(root)
    fs.mkdirSync(path.join(root, '.raw/01JOB'), { recursive: true })
    fs.writeFileSync(path.join(root, '.raw/01JOB/original.pdf'), 'the source')
    fs.writeFileSync(path.join(root, '.raw/01JOB/ocr.pdf'), 'the rendering')
    fs.writeFileSync(path.join(root, '.raw/01JOB/normalized.md'), '# text')
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
    })
    expect(status).toContain('.raw/01JOB/original.pdf')
    expect(status).toContain('.raw/01JOB/normalized.md')
    expect(status).not.toContain('ocr.pdf')
    fs.rmSync(root, { recursive: true, force: true })
  })
})
