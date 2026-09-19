/**
 * The size cap for an ingested original (D4, N2).
 *
 * `.raw/` is tracked on purpose: a commit captures the source document beside the pages made
 * from it, which is what makes an ingest reviewable and revertable. That stops being a good
 * trade at a certain size. Measured on the working vault: **786 MiB of original payloads in
 * 641 blobs**, against 232 MiB for every wiki page ever written, with single scans past
 * 90 MB. A knowledge base whose history is 98 % scans is not versioning its knowledge.
 *
 * So an original over the cap stays ON DISK, exactly where the provenance link points and
 * exactly where the agent reads it, and is kept out of git. The manifest records that its
 * payload is local-only, so nothing has to guess later why the commit has no file in it.
 *
 * WHAT REVERTING SUCH AN INGEST DOES AND DOES NOT RESTORE. The revert undoes the pages and the
 * manifest, the same as any other. The payload is not in the commit, so it is not touched: it
 * stays on disk. That is the honest behaviour - the alternative would be a revert that deletes
 * a file it never captured - and the note in the manifest is what says so.
 */

import fs from 'node:fs'
import path from 'node:path'
import { appendExcludeEntries } from './vault-excludes.js'

/**
 * Default cap: 25 MB. Chosen against the measured distribution rather than as a round number -
 * it keeps every normalised text, every web capture and every ordinary paper inside git, and
 * excludes the scans that make up almost all of the weight.
 */
export const DEFAULT_RAW_PAYLOAD_CAP = 25 * 1024 * 1024

/** Read once per call, so a deployment can raise it without a code change. */
export function rawPayloadCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['RAW_PAYLOAD_MAX_BYTES']
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RAW_PAYLOAD_CAP
}

/** What is being kept out of the commit, and why the job row can say so. */
export interface LocalOnlyPayload {
  /** Vault-relative POSIX path of the file that stays on disk. */
  readonly rel: string
  readonly bytes: number
}

const toPosix = (p: string): string => p.split(path.sep).join('/')

/**
 * Files in one job directory that are over the cap.
 *
 * Only the payloads: the manifest, the normalised text and any other derived artifact are
 * small by nature, and a normalised text that somehow is not is still the thing the agent read
 * and the quote check verifies against. Nothing derived is considered here; that is
 * `DERIVED_RAW_ENTRIES`' job.
 */
export function oversizePayloads(vaultRoot: string, jobDirRel: string, cap: number): LocalOnlyPayload[] {
  const abs = path.join(vaultRoot, jobDirRel)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return []
  }
  const out: LocalOnlyPayload[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (e.name === 'manifest.json' || e.name.startsWith('normalized.')) continue
    let size: number
    try {
      size = fs.statSync(path.join(abs, e.name)).size
    } catch {
      continue
    }
    if (size <= cap) continue
    out.push({ rel: toPosix(path.posix.join(jobDirRel, e.name)), bytes: size })
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}

/**
 * Keeps the over-cap payloads of one job out of git, and says so in its manifest.
 *
 * An exclude entry per file rather than a pattern: the cap is about THIS file's size, and a
 * pattern cannot express that. The entries are what `git add` skips, which is the one
 * mechanism that holds whatever the pathspec says (see `vault-excludes.ts`).
 *
 * Returns what it excluded, so the caller can log it against the job. Never throws: a vault
 * that cannot be written keeps its old behaviour, which is to commit the payload.
 */
export function keepPayloadLocal(
  vaultRoot: string,
  jobDirRel: string,
  manifestPath: string,
  cap: number = rawPayloadCap(),
): LocalOnlyPayload[] {
  const oversize = oversizePayloads(vaultRoot, jobDirRel, cap)
  if (oversize.length === 0) return []
  /*
   * A vault with no git, or one this process cannot write, keeps the behaviour it had: the
   * payload commits as it always did. Saying "not versioned" in that case would be a lie in
   * the manifest, which is worse than a large commit.
   */
  let result: ReturnType<typeof appendExcludeEntries>
  try {
    result = appendExcludeEntries(
      vaultRoot,
      oversize.map((o) => o.rel),
    )
  } catch {
    return []
  }
  if (result === 'no-git' || result === 'unwritable') return []
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest['localOnly'] = oversize.map((o) => ({ path: o.rel, bytes: o.bytes }))
    const notes = Array.isArray(manifest['notes']) ? (manifest['notes'] as string[]) : []
    for (const o of oversize) {
      notes.push(
        `payload not versioned: ${o.rel} is ${Math.round(o.bytes / (1024 * 1024))} MB, over the ${Math.round(cap / (1024 * 1024))} MB cap - it stays on disk and out of git history`,
      )
    }
    manifest['notes'] = notes
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  } catch {
    /* the exclude is what matters; a manifest we cannot rewrite is not worth failing a job */
  }
  return oversize
}
