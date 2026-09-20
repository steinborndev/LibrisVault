/**
 * The marker a run leaves behind to say it finished (A6 contract 1, SPEC.md §12.12).
 *
 * WHAT THIS REPLACES. The queue used to decide whether a crashed ingest had finished by
 * reading `wiki/log.md` and searching it for the job's `.raw` directory - the vault skill
 * wrote that entry as its last action, so its presence meant the run got to the end. Three
 * things were wrong with it:
 *
 *   - it made a SKILL'S PROSE TEMPLATE load-bearing for crash recovery. An upstream change to
 *     the log format would have classified every interrupted job as unfinished, silently, and
 *     no test could have seen it (that is what `vaultprobe` is for now);
 *   - it read 777 kB per stuck job to look for one substring;
 *   - and since the service writes the log entry itself (D2), the agent no longer writes one
 *     at all, so the old marker would simply never appear again.
 *
 * WHAT IT IS. One empty file per run under `.vault-meta/runs/`, touched by the run as its
 * final step. Derived, self-reaping, excluded from vault git - the same category as
 * `.vault-meta/locks/` and the retrieval index, and the same reasoning: it is state ABOUT the
 * vault, never content OF it.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Where the markers live, vault-relative. Excluded from vault git (`vault-excludes.ts`). */
export const RUN_MARKER_DIR = '.vault-meta/runs'

/** How long a marker is kept. A day is long past any run; the reaper takes the rest. */
export const RUN_MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** A job id is ours (a ULID), but never trust it into a path without checking the shape. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Vault-relative path of one run's marker, or null when the id is not a plain identifier. */
export function runMarkerPath(jobId: string): string | null {
  return SAFE_ID.test(jobId) ? `${RUN_MARKER_DIR}/${jobId}.done` : null
}

/** Whether this run left its marker: the one question crash recovery asks. */
export function hasRunMarker(vaultRoot: string, jobId: string): boolean {
  const rel = runMarkerPath(jobId)
  if (rel === null) return false
  try {
    return fs.statSync(path.join(vaultRoot, rel)).isFile()
  } catch {
    return false
  }
}

/**
 * Removes markers older than `maxAgeMs`. Called at startup next to the excludes, for the same
 * reason the lock script reaps its own: a directory that only ever grows is a slow leak, and
 * nothing reads a marker after the job that made it has reached a terminal state.
 *
 * Returns how many it removed. Never throws: a vault that cannot be written has no markers to
 * reap, which is the same answer as having none.
 */
export function reapRunMarkers(vaultRoot: string, maxAgeMs: number = RUN_MARKER_MAX_AGE_MS): number {
  const dir = path.join(vaultRoot, RUN_MARKER_DIR)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.done')) continue
    const abs = path.join(dir, name)
    try {
      if (fs.statSync(abs).mtimeMs >= cutoff) continue
      fs.rmSync(abs, { force: true })
      removed++
    } catch {
      /* gone already, or unreadable: either way it is not ours to insist on */
    }
  }
  return removed
}
