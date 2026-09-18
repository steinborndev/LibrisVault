import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVaultExcludes } from '../src/pipeline/vault-excludes.js'

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
