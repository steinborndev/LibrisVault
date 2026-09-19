/**
 * Keeps derived artifacts and agent scratch out of the vault's git history.
 *
 * The vault is a git repo whose history is the user's record of what their knowledge base
 * actually is. Four kinds of file must never enter it:
 *
 *  - REBUILDABLE INDEX DATA (`.vault-meta/chunks`, `bm25`, `embed-cache.json`) - hundreds of
 *    megabytes that regenerate from the wiki, and that `dirtyPaths` bracketing would
 *    otherwise sweep into whatever ingest happened to be running.
 *
 *  - AGENT SCRATCH. An agent asked to health-check 750 pages will reasonably write itself a
 *    scanner and dump its findings somewhere. That happened: a lint run committed a 254-line
 *    Python script and a 472 KB JSON dump into the vault permanently. The scratch was
 *    legitimate; keeping it forever was not.
 *
 *  - SERVICE RUN STATE (`.vault-meta/runs/`, `.vault-meta/locks/`) - the per-run completion
 *    markers and the vault's own per-file locks. Both are derived and self-reaping: state
 *    ABOUT the vault, never content OF it.
 *
 *  - DEFERRED PAYLOADS (`.raw/deferred/`) - the waiting room for sources the pipeline
 *    recognises but deliberately does not process, which are large by the very criteria
 *    that park them there.
 *
 * Why an exclude and not "tell the agent to clean up": `BOOKKEEPING_PATHS` stages
 * `.vault-meta` wholesale on every commit, so anything left there at commit time lands in
 * history whatever the prompt said. `git add` skips ignored untracked files, which makes
 * this the one mechanism that holds regardless of what the agent does.
 *
 * `.git/info/exclude` rather than `.gitignore`: repo-local, never a tracked file, so the
 * service never modifies vault CONTENT to do this (hard rule 1). Note the limit - excludes
 * only affect untracked files. Anything already committed stays committed until someone
 * removes it deliberately, which is a decision about the user's history, not ours.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Rebuildable index artifacts (SPEC.md §12.6).
 *
 * `tiling-cache.json` joins them (2026-09-19): the vault's own duplicate check writes one
 * embedding per page there, it rebuilds from the pages in minutes, and until the service
 * started running that check nothing had ever created it.
 */
export const RETRIEVE_EXCLUDE_ENTRIES = [
  '.vault-meta/chunks/',
  '.vault-meta/bm25/',
  '.vault-meta/embed-cache.json',
  '.vault-meta/tiling-cache.json',
  // The check can also write a full report; ours reads stdout, but a hand run with --report
  // would otherwise leave half a megabyte for the next commit to sweep up.
  '.vault-meta/tiling-report.md',
] as const

/**
 * Agent scratch under `.vault-meta/`.
 *
 * `.vault-meta` is the vault's STATE directory - the plugin's own code lives in `scripts/`,
 * so a `.py` file appearing here is by definition something an agent wrote for itself. The
 * `lint-scan` entries cover the pinned intermediate path the lint prompt names, plus the
 * underscore spelling a run picked on its own before that path existed.
 */
export const SCRATCH_EXCLUDE_ENTRIES = [
  '.vault-meta/*.py',
  '.vault-meta/lint-scan.json',
  '.vault-meta/lint_scan*',
] as const

/**
 * Service run state under `.vault-meta/`: the per-run completion markers (`run-marker.ts`) and
 * the vault's own per-file locks. Both are derived and self-reaping - state ABOUT the vault,
 * never content OF it - and both would otherwise be swept into a commit by the bookkeeping
 * pathspec, which stages `.vault-meta` wholesale.
 */
export const RUN_STATE_EXCLUDE_ENTRIES = ['.vault-meta/runs/', '.vault-meta/locks/'] as const

/**
 * The deferred waiting room (`.raw/deferred/`, SPEC.md §4.2).
 *
 * `.raw/` is otherwise TRACKED on purpose - a commit captures the original source next to the
 * pages made from it. Deferred payloads are the exception, because of what puts them there:
 * audio/video awaiting a transcription plugin, unextracted archives, and PDFs deferred for
 * being too large to OCR. They are big by definition (this vault parked a 179 MB scan), they
 * are a WAITING ROOM rather than a record, and the moment one is actually processed it is
 * re-dropped and lands in its own committed `.raw/<job-id>/`. Versioning the waiting room
 * would put hundreds of megabytes into the user's history for material that either never
 * gets ingested or gets committed properly on the second pass.
 */
export const DEFERRED_EXCLUDE_ENTRIES = ['.raw/deferred/'] as const

const ALL_ENTRIES = [
  ...RETRIEVE_EXCLUDE_ENTRIES,
  ...SCRATCH_EXCLUDE_ENTRIES,
  ...RUN_STATE_EXCLUDE_ENTRIES,
  ...DEFERRED_EXCLUDE_ENTRIES,
] as const

/**
 * What the call found: `present` (nothing to add), `written` (entries appended), `no-git` (not
 * a repository, nothing to exclude from) or `unwritable`: the vault is read-only for this
 * process, as on a hosted demo whose unit mounts it that way. The last is reported rather than
 * thrown, because the exclude file protects writers and such an instance has none.
 */
export type VaultExcludesResult = 'present' | 'written' | 'no-git' | 'unwritable'

/**
 * Idempotently appends the entries to the vault's `.git/info/exclude`. No-op when the vault
 * is not a git repo (fresh clone, test fixture) - this is hygiene, never a gate.
 *
 * Only appends what is missing, so a user's own additions to that file are left alone.
 */
export function ensureVaultExcludes(vaultRoot: string, entries: readonly string[] = ALL_ENTRIES): VaultExcludesResult {
  if (!fs.existsSync(path.join(vaultRoot, '.git'))) return 'no-git'
  const infoDir = path.join(vaultRoot, '.git', 'info')
  const file = path.join(infoDir, 'exclude')
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const present = new Set(existing.split('\n').map((line) => line.trim()))
  const missing = entries.filter((entry) => !present.has(entry))
  if (missing.length === 0) return 'present'
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
  try {
    fs.mkdirSync(infoDir, { recursive: true })
    fs.appendFileSync(file, `${sep}${missing.join('\n')}\n`)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') return 'unwritable'
    throw err
  }
  return 'written'
}
