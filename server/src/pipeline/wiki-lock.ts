/**
 * The vault's own per-file write lock, taken by the service's own writers.
 *
 * WHY THIS EXISTS. claude-obsidian ships `scripts/wiki-lock.sh` (v1.7+) and makes it a rule
 * rather than an offer: "Every wiki page write MUST be preceded by `wiki-lock acquire <path>`
 * … unconditional in v1.7+ - there is no feature gate, no fallback. Skills that don't acquire
 * locks are racing against any other writer." It closes the corruption the vault hit in v1.6,
 * where two writers on one page silently trampled each other.
 *
 * Our AGENT runs obey it, because they execute those skills. Our own writers did not, and that
 * left the one pairing neither mechanism covered (measured 2026-09-16): a dashboard edit and an
 * agent run writing the SAME page. `commitMutex` serializes our commits against each other and
 * is invisible to an agent; the mtime check on `PUT /pages` catches an agent write that landed
 * BEFORE the page was loaded, and cannot see one that lands mid-save. The lock is the piece
 * that makes both directions safe, and it is the vault's, not ours - which is the point. Two
 * locks that do not see each other are not locking.
 *
 * ORDER, so nothing deadlocks: this lock is taken OUTSIDE our `commitMutex` wherever both are
 * held. It is per-file and foreign; ours is global and ours. Always foreign-then-ours.
 *
 * DEGRADING. A vault without the script - an older clone, a test fixture, a directory that is
 * vault-shaped but not a claude-obsidian one - runs the write unlocked rather than failing. The
 * alternative would make the service refuse to work against every vault below v1.7, which is a
 * worse answer than the behaviour those vaults already had.
 *
 * The script's contract (its own header): exit 0 acquired, 75 held by a live writer, 2 usage,
 * 3 lock dir, 4 path escape. It reaps a lock older than `STALE_AFTER_SEC` (60) itself, so a
 * crashed holder cannot wedge us for longer than that.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Where the script lives inside a claude-obsidian vault. */
const SCRIPT = 'scripts/wiki-lock.sh'

/** Another writer holds the page and did not let go within the retry budget. */
export class WikiLockBusy extends Error {
  readonly page: string
  constructor(page: string) {
    super(`another writer holds ${page} - it is being written right now`)
    this.name = 'WikiLockBusy'
    this.page = page
  }
}

export interface WikiLockOptions {
  /** How many acquire attempts, the first one included. The skill doc retries once. */
  readonly attempts?: number
  /** Pause between attempts. Short: a page write is milliseconds, and a caller is waiting. */
  readonly retryMs?: number
  /** Injected in tests; the real one shells out to the vault's script. */
  readonly exec?: (args: readonly string[], vaultRoot: string) => Promise<number>
}

/** True when this vault carries the script at all (v1.7+ claude-obsidian). */
export function hasWikiLock(vaultRoot: string): boolean {
  try {
    return fs.statSync(path.join(vaultRoot, SCRIPT)).isFile()
  } catch {
    return false
  }
}

/**
 * Runs the script and returns its exit code, never throwing on a non-zero one: 75 is an answer
 * here, not a failure. `WIKI_LOCK_VAULT` pins the vault explicitly rather than letting the
 * script infer it from its own location, so a symlinked or copied script cannot lock the wrong
 * tree.
 */
const shell = async (args: readonly string[], vaultRoot: string): Promise<number> => {
  try {
    await run('bash', [path.join(vaultRoot, SCRIPT), ...args], {
      cwd: vaultRoot,
      env: { ...process.env, WIKI_LOCK_VAULT: vaultRoot },
      timeout: 10_000,
    })
    return 0
  } catch (err) {
    const code = (err as { code?: number | string }).code
    return typeof code === 'number' ? code : 1
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Hold the vault's lock on one page for the duration of `fn`.
 *
 * Throws {@link WikiLockBusy} when another writer holds it - callers decide what that means:
 * a user edit answers 409, a background repair leaves the page alone and says so, which is
 * what the vault's own guidance tells a skill to do ("log … and skip this page rather than
 * overwrite").
 *
 * The release is in a `finally`, so a throwing `fn` does not leave the page locked for the
 * next 60 seconds.
 */
export async function withWikiLock<T>(
  vaultRoot: string,
  rel: string,
  fn: () => Promise<T> | T,
  opts: WikiLockOptions = {},
): Promise<T> {
  const exec = opts.exec ?? shell
  if (!hasWikiLock(vaultRoot)) return await fn()

  const attempts = Math.max(1, opts.attempts ?? 2)
  const retryMs = opts.retryMs ?? 250
  let code = 75
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(retryMs)
    code = await exec(['acquire', rel], vaultRoot)
    if (code === 0) break
    // 75 is contention and worth another try. Anything else is the script saying the request
    // itself is wrong (a bad path, no lock directory), and retrying would not change it.
    if (code !== 75) break
  }
  if (code === 75) throw new WikiLockBusy(rel)
  /*
   * Any other non-zero code means the lock was NOT taken and the reason is not contention.
   * Writing anyway is the pre-2026-09-16 behaviour and no worse than it, so the write goes
   * ahead unlocked rather than a page edit failing because a vault script is broken.
   */
  if (code !== 0) return await fn()

  try {
    return await fn()
  } finally {
    await exec(['release', rel], vaultRoot)
  }
}

/**
 * The batch form, for a writer that touches several pages at once and can leave one out.
 *
 * It acquires what it can and hands `fn` the two lists: the pages it holds, and the pages
 * somebody else is writing. That is the vault's own guidance for a skill that meets a held
 * lock - "log … and skip this page rather than overwrite" - rather than failing the whole
 * batch because one page of thirty is busy.
 *
 * Every acquired lock is released in a `finally`, including the ones acquired before a later
 * acquire threw.
 */
export async function withWikiLocks<T>(
  vaultRoot: string,
  rels: readonly string[],
  fn: (held: readonly string[], busy: readonly string[]) => Promise<T> | T,
  opts: WikiLockOptions = {},
): Promise<T> {
  const exec = opts.exec ?? shell
  if (!hasWikiLock(vaultRoot)) return await fn(rels, [])

  const held: string[] = []
  const busy: string[] = []
  for (const rel of rels) {
    // One attempt per page here, not two: a batch walks many pages and a caller should not
    // wait `rels.length * retryMs` for a repair that can simply leave the busy ones alone.
    const code = await exec(['acquire', rel], vaultRoot)
    if (code === 0) held.push(rel)
    else busy.push(rel)
  }
  try {
    return await fn(held, busy)
  } finally {
    for (const rel of held) await exec(['release', rel], vaultRoot)
  }
}
