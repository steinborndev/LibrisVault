import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureAutoCommitDisabled, isAutoCommitDisabled, AUTO_COMMIT_FLAG } from '../src/pipeline/vault-guards.js'

/**
 * The flag that stops the vault plugin from committing this service's writes out from under it.
 *
 * It existed on the live vault by luck: one dev script created it, nothing asserted it, and no
 * code path read it. These tests are about the four answers the guard can give, because each
 * one means something different at startup - `created` says the vault was unguarded until now,
 * `unwritable` says it still is and that this is expected on a read-only instance.
 */
describe('ensureAutoCommitDisabled', () => {
  const made: string[] = []
  const vault = (withSkills = true): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'))
    made.push(root)
    fs.mkdirSync(path.join(root, 'wiki'), { recursive: true })
    if (withSkills) fs.mkdirSync(path.join(root, 'skills'), { recursive: true })
    return root
  }

  afterEach(() => {
    for (const root of made.splice(0)) {
      try {
        fs.chmodSync(path.join(root, '.vault-meta'), 0o755)
      } catch {
        /* the case that did not create it */
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates the flag on a vault that does not carry it, and says so', () => {
    const root = vault()
    expect(isAutoCommitDisabled(root)).toBe(false)
    expect(ensureAutoCommitDisabled(root)).toBe('created')
    expect(isAutoCommitDisabled(root)).toBe(true)
  })

  it('is idempotent and leaves an existing flag exactly as it was', () => {
    const root = vault()
    ensureAutoCommitDisabled(root)
    const flag = path.join(root, AUTO_COMMIT_FLAG)
    // The mtime is the only record of when this vault stopped auto-committing. Rewriting the
    // file every startup would destroy it, so the second call must not touch the file at all.
    const before = fs.statSync(flag).mtimeMs
    fs.writeFileSync(flag, 'a marker someone left in it')
    expect(ensureAutoCommitDisabled(root)).toBe('present')
    expect(fs.readFileSync(flag, 'utf8')).toBe('a marker someone left in it')
    expect(fs.statSync(flag).mtimeMs).toBeGreaterThanOrEqual(before)
  })

  it('leaves a directory that is not a claude-obsidian vault alone', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-plain-'))
    made.push(plain)
    expect(ensureAutoCommitDisabled(plain)).toBe('no-vault')
    expect(fs.existsSync(path.join(plain, '.vault-meta'))).toBe(false)
    // A wiki alone is not enough either: without skills/ there is no plugin to auto-commit.
    const half = vault(false)
    expect(ensureAutoCommitDisabled(half)).toBe('no-vault')
  })

  // Root ignores directory modes, so the refusal cannot be provoked there.
  it.skipIf(process.getuid?.() === 0)('reports a vault it cannot write instead of throwing', () => {
    const root = vault()
    const meta = path.join(root, '.vault-meta')
    fs.mkdirSync(meta)
    fs.chmodSync(meta, 0o555)
    expect(ensureAutoCommitDisabled(root)).toBe('unwritable')
    expect(isAutoCommitDisabled(root)).toBe(false)
  })

  it('answers about the flag as it is now, not as it was at startup', () => {
    const root = vault()
    ensureAutoCommitDisabled(root)
    expect(isAutoCommitDisabled(root)).toBe(true)
    // A `git clean` in the vault takes the flag away without restarting the service, which is
    // why /health reads it live rather than reporting the startup verdict.
    fs.rmSync(path.join(root, AUTO_COMMIT_FLAG))
    expect(isAutoCommitDisabled(root)).toBe(false)
  })
})
