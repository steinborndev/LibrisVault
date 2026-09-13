/**
 * Preprocessing plugin-chain contracts (SPEC.md §5, §3.1).
 *
 * The chain is `detect → normalize → manifest`. New material types are added as
 * plugins, NEVER as special cases in the chain core (SPEC.md §5, CLAUDE.md
 * conventions) — the whole point of the interface below is that `index.ts` never
 * grows a `switch (type)`.
 */

import type { JobType } from '../../db/jobs.js'
import type { OaDisclosure } from './oa.js'

/** What `detect` learns about an input before any plugin runs. */
export interface Probe {
  /** Absolute path to the original file, already sitting in the job dir. */
  readonly filePath: string
  readonly originalName: string
  /** Lower-cased extension without the dot, or '' when there is none. */
  readonly ext: string
  /** First bytes of the file, for magic-byte checks. */
  readonly head: Buffer
  /** File size in bytes. */
  readonly size: number
}

export interface NormalizeContext {
  readonly probe: Probe
  /** Absolute path to `.raw/<job-id>/` — plugins write normalized output here. */
  readonly jobDir: string
  /** Which external tools are installed (poppler, pandoc, …). */
  readonly tools: ToolAvailability
}

export interface NormalizeResult {
  /** Absolute path to a normalized text/markdown artifact the agent should read, if any. */
  readonly normalizedPath?: string
  readonly normalizedChars?: number
  /** Image types set this: the agent receives the image itself, not a text extraction. */
  readonly passImageToAgent?: boolean
  readonly ocrApplied?: boolean
  readonly exif?: Record<string, unknown>
  /** True for unsupported types (audio/video, archives): job ends `deferred`, not ingested. */
  readonly deferred?: boolean
  /** The address the material names for itself (a saved page's canonical link); the manifest's `url` when the job has none. */
  readonly url?: string
  /**
   * The document's own title, when it states one. Kept because the extraction usually drops it,
   * and a quotation of the title is then unverifiable (docs/sources/SPEC.md 7.6).
   */
  readonly title?: string
  /** Human-readable decisions worth recording in the manifest and job log. */
  readonly notes: readonly string[]
  /**
   * Notes that belong in the job log at level `warn` as well: text in the document aimed at an
   * assistant (docs/sources/SPEC.md section 4.3). The chain copies them into `notes` too, so a
   * plugin states one once and the manifest carries it beside the rest.
   */
  readonly warnings?: readonly string[]
}

export interface PreprocessPlugin {
  readonly name: string
  /** The job `type` this plugin produces (SPEC.md §8 enum). */
  readonly type: JobType
  /** First plugin whose `matches` returns true handles the input. */
  matches(probe: Probe): boolean
  normalize(ctx: NormalizeContext): Promise<NormalizeResult>
}

/** Presence of each external tool the plugins may shell out to. */
export interface ToolAvailability {
  readonly pdftotext: boolean
  readonly pdfinfo: boolean
  readonly ocrmypdf: boolean
  readonly pandoc: boolean
  readonly python3: boolean
  readonly exiftool: boolean
  readonly defuddle: boolean
  readonly ytDlp: boolean
  /** JS runtime yt-dlp needs for robust YouTube extraction (EJS); optional but recommended. */
  readonly deno: boolean
}

export interface Manifest {
  readonly jobId: string
  readonly source: string
  readonly type: JobType
  readonly originalName: string
  readonly url?: string
  /** The document's own title, when it states one (section 7.6); part of the quote corpus. */
  readonly title?: string
  readonly sha256?: string
  readonly createdAt: string
  /** Names (relative to the job dir) of the original and normalized artifacts. */
  readonly original: string
  readonly normalized?: string
  readonly normalizedChars?: number
  readonly ocrApplied: boolean
  readonly passImageToAgent: boolean
  readonly deferred: boolean
  readonly exif?: Record<string, unknown>
  /**
   * Where the text came from when it did NOT come from the address the job names
   * (docs/sources/SPEC.md section 5.4). `url` above stays the requested address.
   */
  readonly oa?: OaDisclosure
  readonly notes: readonly string[]
  /** The subset of `notes` the job log carries at level `warn` (section 4.3). */
  readonly warnings?: readonly string[]
}

export interface PreprocessResult {
  readonly type: JobType
  readonly deferred: boolean
  /** Absolute path to the written manifest.json. */
  readonly manifestPath: string
  /** Vault-relative POSIX path to the artifact the agent should ingest (normalized if any, else original). */
  readonly primaryArtifact: string
  readonly manifest: Manifest
}

export class PreprocessError extends Error {
  override readonly name = 'PreprocessError'
  constructor(
    message: string,
    /** True when the input was refused for safety (e.g. disguised executable). */
    readonly refused = false,
    /**
     * True when a later retry may succeed without anyone fixing anything (e.g. a YouTube
     * bot check or HTTP 429). The queue retries these like transient agent failures
     * instead of failing the job on the first attempt.
     */
    readonly transient = false,
  ) {
    super(message)
  }
}
