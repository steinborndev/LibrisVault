/**
 * Guards that make the vault safe for THIS service to write, asserted at startup.
 *
 * Distinct from `vault-excludes.ts`, which keeps derived files out of history: these are the
 * switches on the vault's own machinery that would otherwise act on the service's writes.
 *
 * The one that exists today is auto-commit. claude-obsidian ships a `PostToolUse` hook that
 * runs `git add -- wiki/ .raw/ .vault-meta/` plus a commit after every Write and Edit, unless
 * `.vault-meta/auto-commit.disabled` is present. With the hook live, a run's pages are
 * committed out from under the service: the job row records no commit, the revert button has
 * nothing to revert, and two runs' work lands in one "wiki: auto-commit" commit that belongs
 * to neither. Hard rule 1 says the service owns every run's commit, and this flag is what
 * makes that true.
 *
 * Until now the flag was created by `scripts/dev-instance.sh` and by nothing else. The live
 * vault carried one dated the day the service first ran, and it survived by luck: no setup
 * script wrote it, no code path read it, and a fresh clone or a `git clean` would have taken
 * it away silently. A guarantee that depends on a file nobody asserts is not a guarantee.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * What the call found. `created` means the vault was unprotected until this moment, which is
 * worth a log line rather than a shrug; `unwritable` is the read-only demo mount, reported
 * rather than thrown for the same reason `ensureVaultExcludes` reports it.
 */
export type AutoCommitGuardResult = 'present' | 'created' | 'no-vault' | 'unwritable'

/** The hook reads this exact path; it is the vault's contract, not ours to rename. */
export const AUTO_COMMIT_FLAG = path.posix.join('.vault-meta', 'auto-commit.disabled')

/**
 * Creates `.vault-meta/auto-commit.disabled` when the vault does not carry it.
 *
 * Idempotent, and deliberately does NOT touch an existing flag: its mtime is the only record
 * of when this vault stopped auto-committing, and rewriting it every startup would destroy
 * that. A directory that is not a claude-obsidian vault is left alone entirely - this service
 * asserts nothing about a directory it does not recognise.
 */
export function ensureAutoCommitDisabled(vaultRoot: string): AutoCommitGuardResult {
  const isVault = fs.existsSync(path.join(vaultRoot, 'wiki')) && fs.existsSync(path.join(vaultRoot, 'skills'))
  if (!isVault) return 'no-vault'

  const flag = path.join(vaultRoot, AUTO_COMMIT_FLAG)
  if (fs.existsSync(flag)) return 'present'
  try {
    fs.mkdirSync(path.dirname(flag), { recursive: true })
    // 'wx': create, never truncate. Two instances starting together then race harmlessly -
    // the loser finds the file and reports it present rather than emptying it.
    fs.writeFileSync(flag, '', { flag: 'wx' })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return 'present'
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') return 'unwritable'
    throw err
  }
  return 'created'
}

/** Whether the vault is protected right now - the boolean `/health` reports. */
export function isAutoCommitDisabled(vaultRoot: string): boolean {
  return fs.existsSync(path.join(vaultRoot, AUTO_COMMIT_FLAG))
}
