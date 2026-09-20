/**
 * The vault's own duplicate detector, finally wired (A5).
 *
 * claude-obsidian ships `scripts/tiling-check.py`: per-page embeddings through a local ollama,
 * reporting page pairs that say the same thing. It is the ONLY duplicate detector in the whole
 * system and it had never run - not once, in 764 vault commits - while the vault filled up with
 * one-document-one-page islands that nothing compared against each other.
 *
 * Same category as the retrieval-index scripts (SPEC.md §12.6, hard rule 1's first sanctioned
 * exception): deterministic, no LLM, no egress beyond a local ollama, writes only its own cache
 * under `.vault-meta/`. We read its report and never its thresholds file - calibrating those is
 * the vault's business, and the shipped bands say plainly that they are uncalibrated.
 *
 * Failure is always a skip, never a failed run: an older vault has no script, a machine without
 * ollama exits 10, one without the model exits 11, and a duplicate check is advisory by nature.
 */

import fs from 'node:fs'
import path from 'node:path'
import { runTool } from './preprocess/tools.js'

/** Where the script lives inside a claude-obsidian vault (v1.7+ DragonScale). */
const SCRIPT = 'scripts/tiling-check.py'

/** Its own documented exit codes: 10 no ollama, 11 no model, 4 too many pages, 2 usage. */
const EXIT_NO_OLLAMA = 10
const EXIT_NO_MODEL = 11

/** Embedding a whole vault on a cold cache is minutes, not seconds; afterwards it is seconds. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000

export interface TilingPair {
  /** Cosine similarity the script reported, 0 to 1. */
  readonly similarity: number
  /** Vault-relative page paths, as the report names them. */
  readonly a: string
  readonly b: string
  /** Which band the script put it in: at or above its error threshold, or in review. */
  readonly band: 'error' | 'review'
}

export interface TilingResult {
  /** Why nothing ran, or undefined when it did. */
  readonly skipped?: string
  readonly pairs: readonly TilingPair[]
  /** The report's own header lines, for the job log. */
  readonly summary?: string
}

/** True when this vault carries the script at all. */
export function hasTilingCheck(vaultRoot: string): boolean {
  try {
    return fs.statSync(path.join(vaultRoot, SCRIPT)).isFile()
  } catch {
    return false
  }
}

/**
 * Parses the script's markdown report into pairs.
 *
 * The format is its own (`- \`0.9123\` a/path.md -- b/path.md`) under two headings, and it is
 * a text contract like the other four - which is why the parse is lenient and a shape it does
 * not recognise yields no pairs rather than an exception.
 */
export function parseTilingReport(report: string): { pairs: TilingPair[]; summary: string } {
  const pairs: TilingPair[] = []
  let band: 'error' | 'review' | null = null
  const summary: string[] = []
  for (const raw of report.split('\n')) {
    const line = raw.trimEnd()
    if (/^##\s+Errors\b/i.test(line)) {
      band = 'error'
      continue
    }
    if (/^##\s+Review\b/i.test(line)) {
      band = 'review'
      continue
    }
    if (line.startsWith('- pages scanned:') || line.startsWith('- cache hits:')) {
      summary.push(line.slice(2))
      continue
    }
    if (band === null) continue
    const m = /^-\s+`([0-9.]+)`\s+(.+?)\s+--\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const similarity = Number(m[1])
    if (!Number.isFinite(similarity)) continue
    pairs.push({ similarity, a: m[2]!, b: m[3]!, band })
  }
  return { pairs, summary: summary.join('; ') }
}

export interface TilingOptions {
  readonly timeoutMs?: number
  /** Injected in tests; the real one spawns the vault's python script. */
  readonly run?: (vaultRoot: string, timeoutMs: number) => Promise<{ stdout: string; code: number }>
}

const spawnScript = async (vaultRoot: string, timeoutMs: number): Promise<{ stdout: string; code: number }> => {
  try {
    const { stdout } = await runTool('python3', [SCRIPT], { cwd: vaultRoot, timeoutMs })
    return { stdout, code: 0 }
  } catch (err) {
    const code = (err as { code?: number }).code
    const stdout = (err as { stdout?: string }).stdout ?? ''
    return { stdout, code: typeof code === 'number' ? code : 1 }
  }
}

/**
 * Runs the check over the whole vault and returns the pairs it found.
 *
 * Never throws. Every failure mode the script documents becomes a `skipped` reason the caller
 * logs once: an old vault, no ollama, no embedding model, a vault too large for it, a crash.
 */
export async function runTilingCheck(vaultRoot: string, opts: TilingOptions = {}): Promise<TilingResult> {
  if (!hasTilingCheck(vaultRoot)) {
    return { skipped: 'this vault has no scripts/tiling-check.py (claude-obsidian below v1.7)', pairs: [] }
  }
  const run = opts.run ?? spawnScript
  let out: { stdout: string; code: number }
  try {
    out = await run(vaultRoot, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  } catch (err) {
    return { skipped: `the duplicate check could not be run (${(err as Error).message})`, pairs: [] }
  }
  if (out.code === EXIT_NO_OLLAMA) return { skipped: 'no local ollama, so no duplicate check', pairs: [] }
  if (out.code === EXIT_NO_MODEL) return { skipped: 'the embedding model is not pulled, so no duplicate check', pairs: [] }
  if (out.code !== 0) return { skipped: `the duplicate check exited ${out.code}`, pairs: [] }

  const { pairs, summary } = parseTilingReport(out.stdout)
  return { pairs, summary }
}

/**
 * The pairs that name a page this run touched, so an ingest hears about the duplicates IT
 * created rather than about every pair in the vault. With no paths given, everything is
 * reported - which is what a maintenance sweep wants.
 */
export function pairsTouching(pairs: readonly TilingPair[], paths: readonly string[]): TilingPair[] {
  if (paths.length === 0) return [...pairs]
  const touched = new Set(paths)
  return pairs.filter((p) => touched.has(p.a) || touched.has(p.b))
}
