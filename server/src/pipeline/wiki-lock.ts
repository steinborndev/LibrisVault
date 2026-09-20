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
 * 3 lock dir, 4 path escape. It reaps a lock older than `STALE_AFTER_SEC` itself, so a crashed
 * holder cannot wedge us for longer than that.
 *
 * THE WINDOW (A2, measured 2026-09-19 over 136 paired acquire/release spans on the live vault):
 * median 23 s, p75 34 s, p90 59 s, max 108 s. The script's default threshold is 60 s, so
 * **9.6 % of real holds outlive it** - and a lock that outlives its own threshold is not a
 * lock: the next acquirer reaps it and both writers proceed. The long holds were all on the
 * hub files, which is why phase 2 removes the need for most of them; until then the window is
 * widened to 600 s, ten times the longest hold ever measured.
 *
 * BOTH SIDES OF IT. The threshold is applied by the ACQUIRER, so passing it on our own
 * `acquire` only decides what WE reap. The other direction - an agent run reaping a lock this
 * service holds - is closed by exporting `STALE_AFTER_SEC` into the run's environment
 * (`buildAgentEnv`), which is the global the script itself documents. No vault file is
 * modified to do it (hard rule 5).
 *
 * BATCHES. `withWikiLocks` acquires serially and holds the first lock for the whole batch, so a
 * repair over hundreds of pages would outlive the window on its earliest locks. Of the two
 * options - cap the batch, or refresh - this file REFRESHES: a phase 8 repair pass legitimately
 * touches hundreds of pages, and a cap would only move the problem into every caller. The
 * refresh re-acquires each held lock with a zero threshold every half window, which reaps and
 * re-creates a lock we already hold, leaving its age at zero again.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Where the script lives inside a claude-obsidian vault. */
const SCRIPT = 'scripts/wiki-lock.sh'

/**
 * The staleness window we hand the script, in seconds. See the header for the measurement:
 * ten times the longest hold ever seen, against a default of 60 that 9.6 % of holds outlived.
 *
 * Environment, not settings: it is a safety margin whose right value follows from how long this
 * vault's runs take, not a preference anyone should be invited to tune in a UI.
 */
export const WIKI_LOCK_STALE_SEC = ((): number => {
  const raw = process.env['WIKI_LOCK_STALE_SEC']
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600
})()

/**
 * One page, one lock. The script hashes the RAW path string with no normalisation of its own,
 * so `wiki/x.md` and `./wiki/x.md` are two different locks on one page - which is not a lock at
 * all. Every caller on both sides happens to pass the canonical spelling today, so this has
 * never bitten; it is one function on our side, and unfixable on the agent's.
 */
export function normaliseLockPath(rel: string, vaultRoot?: string): string {
  let out = rel.trim().replace(/\\/g, '/')
  if (vaultRoot !== undefined) {
    const root = vaultRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    if (out === root) out = ''
    else if (out.startsWith(`${root}/`)) out = out.slice(root.length + 1)
  }
  return out.replace(/\/{2,}/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '')
}

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
  /** The staleness window handed to the script; defaults to {@link WIKI_LOCK_STALE_SEC}. */
  readonly staleAfterSec?: number
  /** Batch only: how often held locks are refreshed. Defaults to half the window. */
  readonly refreshMs?: number
}

/** `acquire` with the window this service runs with, and one spelling of the page. */
const acquireArgs = (rel: string, staleSec: number): string[] => [
  'acquire',
  '--stale-after-sec',
  String(staleSec),
  rel,
]

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

  const page = normaliseLockPath(rel, vaultRoot)
  const staleSec = opts.staleAfterSec ?? WIKI_LOCK_STALE_SEC
  const attempts = Math.max(1, opts.attempts ?? 2)
  const retryMs = opts.retryMs ?? 250
  let code = 75
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(retryMs)
    code = await exec(acquireArgs(page, staleSec), vaultRoot)
    if (code === 0) break
    // 75 is contention and worth another try. Anything else is the script saying the request
    // itself is wrong (a bad path, no lock directory), and retrying would not change it.
    if (code !== 75) break
  }
  if (code === 75) throw new WikiLockBusy(page)
  /*
   * Any other non-zero code means the lock was NOT taken and the reason is not contention.
   * Writing anyway is the pre-2026-09-16 behaviour and no worse than it, so the write goes
   * ahead unlocked rather than a page edit failing because a vault script is broken.
   */
  if (code !== 0) return await fn()

  try {
    return await fn()
  } finally {
    await exec(['release', page], vaultRoot)
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

  const staleSec = opts.staleAfterSec ?? WIKI_LOCK_STALE_SEC
  const held: string[] = []
  const busy: string[] = []
  // The caller's own spelling is what goes back to it in `held`/`busy`; the normalised one is
  // what the script sees. A caller comparing the returned list against the list it passed must
  // still get its own strings back.
  const lockPath = new Map<string, string>()
  for (const rel of rels) {
    // One attempt per page here, not two: a batch walks many pages and a caller should not
    // wait `rels.length * retryMs` for a repair that can simply leave the busy ones alone.
    const page = normaliseLockPath(rel, vaultRoot)
    const code = await exec(acquireArgs(page, staleSec), vaultRoot)
    if (code === 0) {
      held.push(rel)
      lockPath.set(rel, page)
    } else busy.push(rel)
  }

  /*
   * Keep the held locks young (see BATCHES in the header). `--stale-after-sec 0` reaps whatever
   * is there and takes it, which for a lock this process already holds is exactly a refresh:
   * same path, new timestamp. A refresh that does NOT come back 0 means the lock is somebody
   * else's now, so the page is dropped from the set rather than released out from under them
   * at the end - releasing is unconditional in the script, and that is the one way this
   * function could take a lock away from a writer that legitimately holds it.
   */
  let refreshing = false
  const refresh = async (): Promise<void> => {
    if (refreshing) return
    refreshing = true
    try {
      for (const [rel, page] of [...lockPath]) {
        const code = await exec(['acquire', '--stale-after-sec', '0', page], vaultRoot)
        if (code !== 0) lockPath.delete(rel)
      }
    } finally {
      refreshing = false
    }
  }
  const refreshMs = opts.refreshMs ?? Math.max(1_000, Math.floor((staleSec * 1000) / 2))
  const timer = setInterval(() => void refresh(), refreshMs)
  timer.unref?.()

  try {
    return await fn(held, busy)
  } finally {
    clearInterval(timer)
    for (const page of lockPath.values()) await exec(['release', page], vaultRoot)
  }
}
