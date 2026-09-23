/**
 * Vault git commits (SPEC.md §3.1, §9; TASKS-M1 §0). Every successful ingest becomes one
 * commit `ingest: <source>` so a bad run is revertible (the §9 undo mechanism). The
 * vault's own auto-commit hook is disabled (`.vault-meta/auto-commit.disabled`), so this
 * is the ONLY thing committing — "only one of the two commits" (SPEC.md §3.1) is settled
 * in the service's favour.
 *
 * `.raw/` is tracked in the vault, so a commit captures the original + normalized source
 * alongside the wiki pages — matching how the M0 ingests were committed by hand.
 */

import fs from 'node:fs'
import { syncManifest, parseStagedChanges, MANIFEST_PATH } from './manifest-sync.js'
import os from 'node:os'
import path from 'node:path'
import { runTool } from './preprocess/tools.js'

/**
 * Bookkeeping paths that ride along with EVERY vault commit — script-written, regenerable,
 * shared across runs rather than owned by one job.
 *
 * `.raw/.manifest.json` is load-bearing here: the wiki-ingest skill rewrites it as its delta
 * tracker on every run. Leaving it out of the pathspec meant each ingest re-dirtied it and
 * `git status` in the vault never came back clean (TASKS-M5 §0). Both the ingest queue and the
 * maintenance runner stage these, so they are defined once here to stop the two drifting apart.
 */
export const BOOKKEEPING_PATHS = ['.vault-meta', '.raw/.manifest.json'] as const

/** Commit identity, matching the M0 hand-made ingest commits. */
const AUTHOR_ARGS = [
  '-c',
  'user.name=vault-service',
  '-c',
  'user.email=vault-service@localhost',
] as const

export interface CommitResult {
  readonly committed: boolean
  readonly hash?: string
  /** Wiki markdown pages contained in THIS commit, vault-relative POSIX paths. */
  readonly committedPages: string[]
  /** Why nothing was committed, when `committed` is false. */
  readonly note?: string
}

/**
 * `.git/index.lock` is held by every git command that writes the index, and a plain
 * `git status` is one of them - it refreshes the index and writes it back. Our own commits
 * are serialized by the shared commit mutex, but the vault is a shared DIRECTORY: the
 * dashboard's own status polling, Obsidian's git plugin, a terminal, anything can hold the
 * lock for a few milliseconds at exactly the wrong moment.
 *
 * A command that fails this way did no work at all - git bails before touching anything - so
 * retrying it is safe for reads and writes alike, `commit` included. Measured 2026-08-24: an
 * ingest's `git add` lost this race, the run's commit was dropped, and its `.raw/` payload
 * and address counter stayed unversioned (the wiki pages were recovered by the reconcile
 * pass, which only covers `wiki/**`).
 */
const LOCK_RETRIES = 3
const LOCK_BACKOFF_MS = 120

function isIndexLockContention(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('index.lock') && message.includes('File exists')
}

/**
 * Of the paths given, the ones the vault deliberately ignores.
 *
 * `git add` refuses an ignored path and stages NOTHING else in the same call, so one such path
 * in a run's pathspec loses the whole commit. That is not hypothetical: a lint run wrote itself
 * a scanner into `.vault-meta/`, which `.git/info/exclude` holds out of history on purpose
 * (derived artifacts, task 6.2), and the run failed after five minutes with its report written
 * and nothing committed (2026-09-20).
 *
 * An ignored path is not an error - it is the vault saying this file is not history. It is
 * dropped from the pathspec and the rest is staged.
 */
async function ignoredPaths(vaultRoot: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  try {
    const out = await git(vaultRoot, ['check-ignore', '--', ...paths])
    return new Set(
      out
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p !== ''),
    )
  } catch {
    /*
     * `check-ignore` exits 1 when nothing matched, which lands here as a throw and is the
     * common case, not a failure. A real failure lands here too and yields the same answer:
     * nothing filtered, and the `add` below behaves exactly as it did before this existed.
     */
    return new Set()
  }
}

async function git(vaultRoot: string, args: readonly string[]): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await runTool('git', ['-C', vaultRoot, ...args], { timeoutMs: 60_000 })
      return stdout
    } catch (err) {
      // A lock held by a crashed git never clears, so this stays bounded: after the last
      // attempt the caller sees the original failure, exactly as before.
      if (attempt > LOCK_RETRIES || !isIndexLockContention(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, LOCK_BACKOFF_MS * attempt))
    }
  }
}

/**
 * Read-only git, for the status calls that run OUTSIDE the commit mutex - `/api/v1/stats`
 * polls one on every SSE tick, and a `done` transition publishes that tick milliseconds
 * before the run's own commit runs, so an open dashboard sat right in the window.
 *
 * `--no-optional-locks` is what keeps a read out of `.git/index.lock`: git then skips the
 * index write-back it would otherwise do to refresh cached stat info. The reported status is
 * identical - only the write is skipped (verified against a 400-file repo: the index mtime
 * moves after a plain `git status` and does not move with the flag).
 */
async function gitRead(vaultRoot: string, args: readonly string[]): Promise<string> {
  return git(vaultRoot, ['--no-optional-locks', ...args])
}

/**
 * Vault-relative paths git currently reports as dirty (modified, staged, or untracked).
 *
 * Used to bracket an agent run: what is dirty AFTER minus what was dirty BEFORE is what the run
 * actually touched — including files it created or renamed with **Bash**, which the Write/Edit
 * derived pathspec cannot see (finding F4: an autoresearch run's synthesis page was written with
 * Write and then renamed with Bash, so the staged path no longer existed and the real one was
 * never staged, leaving the page unversioned).
 *
 * `-z` is deliberate: the default porcelain output quotes and escapes paths containing spaces or
 * colons, which vault page names routinely have. NUL-separated output needs no unquoting.
 */
export async function dirtyPaths(vaultRoot: string): Promise<Set<string>> {
  let raw: string
  try {
    raw = await gitRead(vaultRoot, ['status', '--porcelain', '-z', '--untracked-files=all'])
  } catch {
    // Not a repo, or git unavailable. Degrade to the Write/Edit-derived pathspec rather than
    // sinking the run: a commit that stages a little less is recoverable, a failed ingest is not.
    return new Set()
  }
  const fields = raw.split('\0')
  const paths = new Set<string>()
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry === undefined || entry.length < 4) continue
    const status = entry.slice(0, 2)
    paths.add(entry.slice(3))
    // A rename/copy entry is followed by its ORIGIN path in the next NUL field; consume it so it
    // is not misread as another status entry, and record it — the old name needs staging too, or
    // the deletion half of the rename never lands.
    if (status.startsWith('R') || status.startsWith('C')) {
      const origin = fields[++i]
      if (origin !== undefined && origin !== '') paths.add(origin)
    }
  }
  return paths
}

export interface UnversionedPages {
  /** Wiki pages git has never seen: on disk, absent from history entirely. */
  readonly untracked: string[]
  /** Wiki pages whose working copy differs from the last commit. */
  readonly modified: string[]
}

/**
 * Wiki pages that exist on disk but not in git as committed content.
 *
 * This is the missing half of finding F4. The commit pathspec is built from a run's
 * `Write`/`Edit` tool calls, so a page the agent creates with **Bash** is invisible to it -
 * and the sweep that would catch those (`newWikiPaths`) is deliberately skipped whenever the
 * run cannot prove it was the sole vault writer, because misattributing a page to the wrong
 * job is worse than missing it. That trade-off is sound, and it rests on one assumption:
 *
 *     "Losing a page from a commit is visible and fixable."
 *
 * Nothing made it visible. With concurrency above 1 - and a batch drop routinely puts eight
 * jobs in flight at once - "not the sole writer" is the normal case, not the exception, so
 * pages accumulate outside git silently. They still render, still resolve links, still get
 * indexed; they simply have no history, cannot be reverted, and disappear without trace if
 * the vault is ever restored from git. This function is what turns that into a fact the
 * dashboard can state.
 *
 * Deliberately NOT included: deletions. A page deleted but not yet committed is a divergence
 * too, but it is not content at risk, and mixing the two would blur what the number means.
 *
 * Costs one `git status` (~8ms on a 750-page vault). Returns empty when git is unavailable,
 * for the same reason `dirtyPaths` does: this is a report, never a gate.
 */
export async function unversionedWikiPages(vaultRoot: string): Promise<UnversionedPages> {
  let raw: string
  try {
    raw = await gitRead(vaultRoot, ['status', '--porcelain', '-z', '--untracked-files=all'])
  } catch {
    return { untracked: [], modified: [] }
  }
  const untracked: string[] = []
  const modified: string[] = []
  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry === undefined || entry.length < 4) continue
    const status = entry.slice(0, 2)
    const file = entry.slice(3)
    // A rename/copy entry carries its origin in the next field; consume it so it is not
    // misread as a status entry of its own.
    if (status.startsWith('R') || status.startsWith('C')) i++
    if (!file.startsWith('wiki/') || !file.endsWith('.md')) continue
    if (status === '??') untracked.push(file)
    else if (status.includes('D')) continue
    else modified.push(file)
  }
  return { untracked: untracked.sort(), modified: modified.sort() }
}

/**
 * Wiki paths that became dirty during a run — `after` minus `before`, scoped to `wiki/`.
 *
 * Scoping matters twice over: it keeps the vault's own churn (Obsidian rewriting
 * `.obsidian/workspace.json` mid-run) out of our commits, and it means files the user already had
 * dirty before the run are never swept in (SPEC.md §11.3 risk 5 — the user may be editing the
 * vault while the pipeline runs). Only what this run newly touched under the wiki is returned.
 */
export function newWikiPaths(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...after].filter((p) => !before.has(p) && p.startsWith('wiki/')).sort()
}

/**
 * Wiki markdown paths from a NUL-separated list of files, vault-relative POSIX.
 *
 * NUL-separated, and every caller must pass `-z`. Git's default output QUOTES any path
 * holding a byte outside plain ASCII and escapes it octally, so
 * `wiki/questions/… — State of the Art.md` arrives as
 * `"wiki/questions/… \342\200\224 State of the Art.md"` - which starts with a quote, not
 * with `wiki/`, and was silently dropped here (2026-08-26). Every page with an em dash or an
 * umlaut in its name went unrecorded, which in this vault is every research synthesis page:
 * a run that wrote fifteen pages reported fourteen, and the one page it was FOR was the one
 * missing. The same trap is already documented one function up for `dirtyPaths`.
 */
function wikiPagesFrom(files: string): string[] {
  return files
    .split('\0')
    .filter((p) => p.startsWith('wiki/') && p.endsWith('.md'))
    .map((p) => p.split(path.sep).join(path.posix.sep))
}

/**
 * The newest commit that touched `pathspec`, with the wiki pages it changed - or null when
 * nothing did, or the newest one predates `since`.
 *
 * This exists because the service is not the only thing that commits this vault. The wiki
 * ingest skill commits its own work, and when it wins the race the service's own
 * `commitVault` finds an empty index and reports `committed: false` - which used to mean the
 * job recorded no pages and no commit hash at all, even though its work was safely in git
 * (2026-08-26). Passing this job's `.raw/<job-id>/` as the pathspec is what makes the answer
 * attributable: that directory belongs to exactly one job, so a commit touching it is that
 * job's commit and no other's, even at concurrency 2. `since` guards the remaining case -
 * a run that committed NOTHING would otherwise adopt the older commit that first carried
 * its raw payload.
 */
export async function commitTouching(
  vaultRoot: string,
  pathspec: string,
  since: Date | null = null,
): Promise<{ hash: string; date: string; pages: string[] } | null> {
  const line = (await gitRead(vaultRoot, ['log', '-1', '--format=%H %cI', '--', pathspec])).trim()
  if (line === '') return null
  const [hash, iso] = line.split(' ')
  if (hash === undefined || iso === undefined) return null
  // A second of slack, because git timestamps have second resolution and `since` has
  // millisecond resolution: a commit made in the same second the run started reads as
  // fractionally OLDER than the run, and a strict comparison throws away the very commit
  // this function exists to find.
  if (since !== null && Date.parse(iso) < since.getTime() - 1000) return null
  const files = await gitRead(vaultRoot, ['show', '--name-only', '-z', '--pretty=format:', hash])
  return { hash, date: iso, pages: wikiPagesFrom(files) }
}

/**
 * Commits EXACTLY the given paths — used by user-initiated page edits/deletes from the
 * dashboard (SPEC.md §12.4 editing). Unlike commitVault there is deliberately NO
 * `git add -A` fallback and the commit itself is pathspec-limited: these commits can run
 * while an agent is mid-write (the agent's own commit comes later, under the same mutex),
 * and sweeping its half-written pages into a user's edit commit would file them under the
 * wrong change. `git add -- <path>` stages a deletion of a tracked file just fine.
 */
export async function commitPaths(
  vaultRoot: string,
  message: string,
  paths: readonly string[],
): Promise<CommitResult> {
  await git(vaultRoot, ['add', '--', ...paths])
  const staged = await git(vaultRoot, ['diff', '--cached', '--name-only', '--', ...paths])
  if (staged.trim() === '') {
    return { committed: false, committedPages: [], note: 'nothing to commit — content unchanged' }
  }
  // `commit -- <paths>` commits only these paths, leaving anything else staged untouched.
  await git(vaultRoot, [...AUTHOR_ARGS, 'commit', '--no-verify', '-m', message, '--', ...paths])
  const hash = (await git(vaultRoot, ['rev-parse', 'HEAD'])).trim()
  const files = await git(vaultRoot, ['show', '--name-only', '-z', '--pretty=format:', 'HEAD'])
  return { committed: true, hash, committedPages: wikiPagesFrom(files) }
}

/** Why a revert could not be performed — each maps to a specific, actionable message. */
export type RevertRefusal = 'unknown-commit' | 'dirty-tree' | 'conflict' | 'already-reverted'

export interface RevertResult {
  readonly reverted: boolean
  /** The NEW commit that undoes the original (present only on success). */
  readonly hash?: string
  readonly refusal?: RevertRefusal
  readonly message?: string
}

/**
 * Undoes exactly one vault commit (SPEC.md §9's undo mechanism, surfaced as the dashboard's
 * "revert this ingest"). Callers MUST hold the shared commit mutex — this writes the vault.
 *
 * The whole value of this function is that it either fully succeeds or leaves the vault exactly
 * as it found it. Three guards, in order:
 *
 *  1. The commit must exist and be an ancestor of HEAD.
 *  2. The working tree must be CLEAN. `git revert` on a dirty tree either refuses or mixes an
 *     in-flight agent's half-written pages into the revert; the commit mutex serializes
 *     COMMITS but agents write files outside it, so this check is what actually protects us.
 *  3. On conflict (a later commit touched the same lines) we `git revert --abort` and report it,
 *     rather than leaving conflict markers in wiki pages for the next ingest to read as content.
 */
/**
 * Files a revert leaves exactly as they are.
 *
 * The hub layer (SPEC.md §12.12) is written by the service into EVERY run's commit, so every
 * one of these files is touched by every later commit. `git revert` on the whole commit
 * therefore conflicts on them for any ingest that is not the most recent one - which is the
 * revert button, the undo mechanism of SPEC.md §9, failing on exactly the runs somebody would
 * want to undo.
 *
 * Leaving them alone is also what reverting MEANS here:
 *
 *  - `index.md` is derived from the pages. Once the pages are gone the next run regenerates it,
 *    and restoring an old copy would only put back entries for pages that no longer exist.
 *  - `log.md` is an append-only record. The run really did happen, and the revert is a second
 *    event rather than a reason to forget the first.
 *  - `hot.md` and the `_index.md` hubs are caches and curated navigation that later runs have
 *    rewritten; an old copy of either is not a better copy.
 */
const isHubPath = (p: string): boolean =>
  p === 'wiki/index.md' || p === 'wiki/log.md' || p === 'wiki/overview.md' || p === 'wiki/hot.md' || p.endsWith('/_index.md')

/**
 * The address allocator, which a revert must never roll back.
 *
 * `.vault-meta/address-counter.txt` holds the NEXT address to issue, and it only ever moves
 * forward. A recovery commit carries it (so the reservation is versioned with the pages that
 * used it), and that is what made this reachable: reverting such a commit would wind the
 * allocator back past addresses that pages in OTHER commits still hold, and the next ingest
 * would issue one of them a second time.
 *
 * Measured on the live vault, 2026-09-20, before it could happen: a recovery commit moved the
 * counter 1200 -> 1208 while an earlier commit's surviving page held `c-001200`. Reverting it
 * would have put the counter back at 1200, and the next page would have been the second
 * `c-001200` in a vault whose duplicate-address count is zero and worth keeping at zero.
 *
 * Same reasoning as `isHubPath` one category over: state that is derived or monotonic is not
 * content, and undoing content must not drag it backwards. Leaving it high costs nothing - an
 * address nobody used is just never issued.
 */
const isMonotonicPath = (p: string): boolean => p === '.vault-meta/address-counter.txt'

/** git's empty tree, so a root commit (no parent) can still be diffed against "before". */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * Undoes exactly one vault commit (SPEC.md §9's undo mechanism, surfaced as the dashboard's
 * "revert this ingest"). Callers MUST hold the shared commit mutex — this writes the vault.
 *
 * The whole value of this function is that it either fully succeeds or leaves the vault exactly
 * as it found it. Three guards, in order:
 *
 *  1. The commit must exist and be an ancestor of HEAD.
 *  2. The working tree must be CLEAN. A revert on a dirty tree either refuses or mixes an
 *     in-flight agent's half-written pages into the revert; the commit mutex serializes
 *     COMMITS but agents write files outside it, so this check is what actually protects us.
 *  3. On conflict (a later commit touched the same lines) nothing is applied and we report it,
 *     rather than leaving conflict markers in wiki pages for the next ingest to read as content.
 *
 * Mechanism: the commit's own reverse diff, applied to the commit's paths MINUS the hub files
 * (see `isHubPath`), and neither is the address allocator (see `isMonotonicPath`). `git revert`
 * cannot take a pathspec, which is why this is a reverse-diff apply rather than a revert - and
 * `git apply` is all-or-nothing, so guard 3 holds without an abort path to get wrong.
 */
export async function revertCommit(vaultRoot: string, hash: string, message?: string): Promise<RevertResult> {
  try {
    await git(vaultRoot, ['cat-file', '-e', `${hash}^{commit}`])
  } catch {
    return { reverted: false, refusal: 'unknown-commit', message: `no such commit in the vault: ${hash}` }
  }
  try {
    await git(vaultRoot, ['merge-base', '--is-ancestor', hash, 'HEAD'])
  } catch {
    return {
      reverted: false,
      refusal: 'unknown-commit',
      message: `commit ${hash.slice(0, 8)} is not part of the current history`,
    }
  }

  const dirty = await dirtyPaths(vaultRoot)
  if (dirty.size > 0) {
    return {
      reverted: false,
      refusal: 'dirty-tree',
      message:
        'the vault has uncommitted changes — a run may still be writing. Wait for it to finish, then retry.',
    }
  }

  const touched = (await gitRead(vaultRoot, ['show', '--name-only', '--pretty=format:', '-z', hash]))
    .split('\0')
    .filter((p) => p !== '')
  const paths = touched.filter((p) => !isHubPath(p) && !isMonotonicPath(p))
  if (paths.length === 0) {
    return {
      reverted: false,
      refusal: 'already-reverted',
      message: `nothing to undo — ${hash.slice(0, 8)} carries only hub bookkeeping, which the next run regenerates`,
    }
  }

  let parent = EMPTY_TREE
  try {
    parent = (await gitRead(vaultRoot, ['rev-parse', `${hash}^`])).trim()
  } catch {
    /* a root commit has no parent: "before" is the empty tree */
  }

  const patch = await gitRead(vaultRoot, ['diff', '--binary', hash, parent, '--', ...paths])
  if (patch.trim() === '') {
    return {
      reverted: false,
      refusal: 'already-reverted',
      message: `nothing to undo — ${hash.slice(0, 8)} has already been reverted or superseded`,
    }
  }

  // The patch goes through a file rather than a pipe: the git helper runs a tool and reads its
  // output, and a temp file keeps that one-way shape. It lands outside the vault, always.
  const patchFile = path.join(os.tmpdir(), `vault-revert-${hash.slice(0, 8)}-${process.pid}.patch`)
  fs.writeFileSync(patchFile, patch)
  try {
    await git(vaultRoot, ['apply', '--index', '--binary', '--whitespace=nowarn', patchFile])
  } catch (err) {
    // `git apply` applies nothing when it cannot apply everything, so there is no half state
    // to clean up - but the index is reset anyway, for the case where git surprises us.
    try {
      await git(vaultRoot, ['reset', '--hard', 'HEAD'])
    } catch {
      /* nothing further we can safely do; the message below tells the operator */
    }
    /*
     * "Will not apply" has two causes and they need different answers. If the patch's own
     * REVERSE applies, the tree already looks the way this revert would leave it: the commit
     * was undone earlier, or superseded. Only the other case is a real conflict with later
     * work, and telling them apart is the difference between "nothing to do" and "look at
     * this by hand".
     */
    try {
      await git(vaultRoot, ['apply', '--check', '--reverse', '--binary', patchFile])
      return {
        reverted: false,
        refusal: 'already-reverted',
        message: `nothing to undo — ${hash.slice(0, 8)} has already been reverted or superseded`,
      }
    } catch {
      /* not already applied: a genuine conflict, reported below */
    }
    return {
      reverted: false,
      refusal: 'conflict',
      message:
        `reverting ${hash.slice(0, 8)} conflicts with later changes — the vault was left untouched. ` +
        `Undo it by hand if you still want it: git -C <vault> revert ${hash.slice(0, 8)}. ` +
        `(${(err as Error).message.split('\n')[0]})`,
    }
  } finally {
    fs.rmSync(patchFile, { force: true })
  }

  const staged = await git(vaultRoot, ['diff', '--cached', '--name-only'])
  if (staged.trim() === '') {
    // Nothing to undo — the commit's changes are already gone (reverted earlier, or overwritten).
    await git(vaultRoot, ['reset', '--hard', 'HEAD'])
    return {
      reverted: false,
      refusal: 'already-reverted',
      message: `nothing to undo — ${hash.slice(0, 8)} has already been reverted or superseded`,
    }
  }

  await git(vaultRoot, [...AUTHOR_ARGS, 'commit', '--no-verify', '-m', message ?? `revert ingest ${hash.slice(0, 8)}`])
  const newHash = (await git(vaultRoot, ['rev-parse', 'HEAD'])).trim()
  return { reverted: true, hash: newHash }
}

/**
 * Unstages exactly these paths, leaving the working tree alone: what a writer that restored its
 * files after a failed commit does, so the index does not keep what the tree no longer has.
 */
export async function unstagePaths(vaultRoot: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  await git(vaultRoot, ['reset', '-q', '--', ...paths])
}

/**
 * Moves HEAD, the index and the tree back to `hash`. Only for a caller that recorded `hash`
 * itself, inside the commit mutex, on a tree `revertCommit` had just found clean - the split's
 * revert undoing its own earlier reverts after a later one conflicted. Never a general undo.
 */
export async function resetHardTo(vaultRoot: string, hash: string): Promise<void> {
  await git(vaultRoot, ['reset', '--hard', '-q', hash])
}

export interface CommitOptions {
  /**
   * Vault-relative paths to stage for THIS commit (F4). Staging only a job's own paths
   * keeps a `git revert` of one ingest from disturbing a concurrently-committed sibling.
   * Omit to stage everything (`git add -A`, legacy/coarse behaviour). If a targeted stage
   * matches nothing on disk, we fall back to `git add -A` so the tree never silently keeps
   * uncommitted changes.
   */
  readonly pathspec?: readonly string[]
}

/**
 * Stages and commits. Returns `committed: false` (not an error) when there is nothing to
 * stage. Callers serialize this behind a mutex.
 *
 * `committedPages` is read back from the commit itself (`git show`), NOT a pre-commit
 * status snapshot, so it is authoritative about what actually landed.
 */
export async function commitVault(
  vaultRoot: string,
  message: string,
  opts: CommitOptions = {},
): Promise<CommitResult> {
  const targeted = (opts.pathspec ?? []).filter((p) => fs.existsSync(path.join(vaultRoot, p)))
  if (opts.pathspec !== undefined) {
    // Explicit pathspec: stage ONLY these paths, and NEVER fall back to `git add -A`. A
    // pathspec that matches nothing on disk means this run wrote nothing of its own that
    // survives — falling back to `add -A` here is precisely what swept an interrupted ingest's
    // orphaned pages into an unrelated maintenance commit (the 2026-07-21 Q8/Q14 incident).
    // Draining orphaned dirty pages is startup reconciliation's job (queue.reconcileInterrupted),
    // never any run's own commit. The old fallback existed "so the tree never silently
    // accumulates changes"; that trade — mis-attributing another run's work vs. leaving it for
    // reconciliation — is the wrong one, so it is gone.
    if (targeted.length > 0) {
      // An ignored path would make `git add` refuse the whole call; see `ignoredPaths`.
      const ignored = await ignoredPaths(vaultRoot, targeted)
      const stageable = targeted.filter((p) => !ignored.has(p))
      if (stageable.length > 0) await git(vaultRoot, ['add', '--', ...stageable])
    }
  } else {
    // Legacy no-pathspec callers keep the coarse `add -A` behaviour.
    await git(vaultRoot, ['add', '-A'])
  }

  /*
   * `.raw/.manifest.json` records which page holds which DragonScale address, and a run does
   * not keep it: the ingest skill tells its runs to, and no other skill mentions addressing at
   * all. So the service brings it into step here, with the rename this commit records and with
   * the address each new page already carries, inside this same commit - one run, one commit.
   * See `manifest-sync.ts`.
   */
  const changes = parseStagedChanges(await git(vaultRoot, ['diff', '--cached', '--find-renames', '--name-status', '-z']))
  if (syncManifest(vaultRoot, changes)) await git(vaultRoot, ['add', '--', MANIFEST_PATH])

  // Gate on what is actually STAGED, not the whole working tree: with the fallback gone, a
  // pathspec that matched nothing leaves the tree dirty (orphans) but the index empty, and a
  // bare `git commit` would then fail. `diff --cached` sees only what this call staged.
  const staged = await git(vaultRoot, ['diff', '--cached', '--name-only'])
  if (staged.trim() === '') {
    return {
      committed: false,
      committedPages: [],
      note: 'nothing to commit (no matching paths staged; a concurrent job may have committed them)',
    }
  }
  await git(vaultRoot, [...AUTHOR_ARGS, 'commit', '--no-verify', '-m', message])
  const hash = (await git(vaultRoot, ['rev-parse', 'HEAD'])).trim()
  const files = await git(vaultRoot, ['show', '--name-only', '-z', '--pretty=format:', 'HEAD'])
  return { committed: true, hash, committedPages: wikiPagesFrom(files) }
}

/**
 * Removes a directory the service staged but never committed - the `.raw/<job-id>/` of a
 * job that turned out to be a duplicate after preprocessing (SPEC.md §12.9). Refuses, and
 * returns false, when git tracks anything under it: a committed original is vault history
 * and is never removed by pipeline code (CLAUDE.md hard rule 1). Confined to `.raw/`.
 */
export async function discardUntrackedDir(vaultRoot: string, relDir: string): Promise<boolean> {
  const abs = path.resolve(vaultRoot, relDir)
  const rawRoot = path.resolve(vaultRoot, '.raw')
  if (path.dirname(abs) !== rawRoot) {
    throw new Error(`refusing to discard "${relDir}": only a direct child of .raw/ may be discarded`)
  }
  if (!fs.existsSync(abs)) return false
  const tracked = await gitRead(vaultRoot, ['ls-files', '-z', '--', relDir])
  if (tracked.length > 0) return false
  fs.rmSync(abs, { recursive: true, force: true })
  return true
}

/**
 * The current commit, or null when the vault is not a repository or has no commit yet.
 *
 * Read before and after an agent run: the run's work is whatever moved HEAD, whoever
 * committed it. The service commits what the agent left dirty, but the vault's own skill
 * sometimes commits first, and then the service's commit finds a clean tree and reports
 * nothing (see `runOne`).
 */
export async function headHash(vaultRoot: string): Promise<string | null> {
  try {
    const out = (await git(vaultRoot, ['rev-parse', 'HEAD'])).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** What one commit did to each path: added, modified or deleted (the recap's created/updated split). */
export async function commitFileStatus(vaultRoot: string, hash: string, from?: string): Promise<Map<string, 'A' | 'M' | 'D'>> {
  const out = new Map<string, 'A' | 'M' | 'D'>()
  try {
    // With `from`, the run produced a RANGE of commits rather than one: the net effect of
    // `from..hash` is what it did, and `diff` reports it in the same shape as `show`.
    /*
     * NUL-separated, like every other listing in this file, and not as lines: git quotes a path
     * that carries a non-ASCII character and escapes its bytes, and the quoted text handed back
     * to git as a pathspec matches nothing. That is how the revert of an expand run failed on a
     * page whose name held a dash (2026-09-17), leaving the run's commit in the vault. The
     * records are `status\0path\0`, and `R<score>\0old\0new\0` for a rename.
     */
    const stdout =
      from === undefined
        ? await git(vaultRoot, ['show', '--name-status', '-z', '--format=', '-M', hash])
        : await git(vaultRoot, ['diff', '--name-status', '-z', '-M', from, hash])
    const parts = stdout.split('\0')
    for (let k = 0; k < parts.length; k++) {
      const status = parts[k]!.replace(/^\s+/, '')
      if (!/^[AMDR]/.test(status)) continue
      // A rename is a deletion of the old path plus an addition of the new one: the expand
      // validator must see the old page go (a rename is a violation), and a restore must
      // bring it back while removing the new path.
      if (status.startsWith('R')) {
        const oldPath = parts[++k]
        const newPath = parts[++k]
        if (oldPath) out.set(oldPath, 'D')
        if (newPath) out.set(newPath, 'A')
      } else {
        const p = parts[++k]
        if (p) out.set(p, status.charAt(0) as 'A' | 'M' | 'D')
      }
    }
  } catch {
    /* an unknown or unreadable commit reports nothing; the caller falls back to "touched" */
  }
  return out
}

/** A file's content at a revision (`git show rev:path`), or null when the revision lacks it. */
export async function readAtRevision(vaultRoot: string, rev: string, relPath: string): Promise<string | null> {
  try {
    return await gitRead(vaultRoot, ['show', `${rev}:${relPath}`])
  } catch {
    return null
  }
}

export interface RestoreResult {
  readonly reverted: boolean
  /** The NEW commit that undoes the original (present only on success). */
  readonly hash?: string
  readonly message?: string
}

/**
 * Undoes one commit by restoring every path it touched to the parent's state and committing
 * that as a NEW commit (docs/tasks/TASKS-A3.md D3): modified and deleted files come back
 * from the parent, added files are removed. Unlike `revertCommit` it does not need a clean
 * tree, because right after an agent run the tree holds the run's untracked leftovers; it
 * touches only the commit's own paths. Callers MUST hold the shared commit mutex.
 */
export async function restoreCommitPaths(vaultRoot: string, hash: string, message: string, from?: string): Promise<RestoreResult> {
  const status = await commitFileStatus(vaultRoot, hash, from)
  if (status.size === 0) return { reverted: false, message: `no such commit, or an empty one: ${hash}` }
  const parent = from ?? `${hash}^`
  const added = [...status].filter(([, s]) => s === 'A').map(([p]) => p)
  const restored = [...status].filter(([, s]) => s !== 'A').map(([p]) => p)
  try {
    if (restored.length > 0) await git(vaultRoot, ['checkout', parent, '--', ...restored])
    if (added.length > 0) await git(vaultRoot, ['rm', '-q', '-f', '--ignore-unmatch', '--', ...added])
    const staged = await git(vaultRoot, ['diff', '--cached', '--name-only'])
    if (staged.trim() === '') return { reverted: false, message: `nothing to undo: ${hash.slice(0, 8)} leaves no difference to its parent` }
    await git(vaultRoot, [...AUTHOR_ARGS, 'commit', '--no-verify', '-m', message])
    const newHash = (await git(vaultRoot, ['rev-parse', 'HEAD'])).trim()
    return { reverted: true, hash: newHash }
  } catch (err) {
    return { reverted: false, message: `restore of ${hash.slice(0, 8)} failed: ${(err as Error).message.split('\n')[0]}` }
  }
}
