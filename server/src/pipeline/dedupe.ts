/**
 * Dedupe memory that lives in the VAULT, not only in SQLite (2026-09-05).
 *
 * The `jobs.sha256` UNIQUE column was the whole dedupe until now, and it forgets: "Clear
 * history" deletes the rows, and with them every hash the service ever saw. The vault keeps
 * the same fact in a place that survives: every ingest leaves `.raw/<job-id>/manifest.json`
 * behind, and that manifest names the original's SHA-256. Reading it back makes dedupe as
 * durable as the vault itself (CLAUDE.md hard rule 1: losing the DB must cost nothing).
 *
 * A byte hash cannot recognise a publication that was downloaded a second time: publishers
 * stamp a per-download watermark (date, licensee) into the PDF, so the bytes differ while
 * the paper is the same. The DOI does not change. The second index maps the DOIs named in
 * the frontmatter of `wiki/sources/*.md` (`url:` / `doi:`) back to their page, and the queue
 * asks it once the normalized text exists - BEFORE an agent run is paid for.
 *
 * A link (2026-09-18) has no hash at all, and the same post re-shared from an app arrives with
 * a tracking tag on its address. The page index therefore also maps the CANONICAL address a
 * source page declares (`url:`, see `url-identity.ts`) back to the page, and the queue asks
 * it at enqueue, before anything is fetched. A source page is the only evidence accepted for
 * a URL: a failed earlier job leaves no page, so resubmitting its link is a retry.
 *
 * READ-ONLY over the vault. All indexes re-read only what changed on disk since the last
 * call, so asking on every enqueue is cheap.
 */

import fs from 'node:fs'
import path from 'node:path'
import { doisIn, normalizeDoi } from './identifiers.js'
import { canonicalUrl } from './url-identity.js'

/** An original the vault already holds, by content hash. */
export interface KnownSource {
  /** The job whose `.raw/<job-id>/` holds the original: the directory name. */
  readonly jobId: string
  readonly originalName: string | null
}

/** A source page that declares the same canonical address as a submitted link. */
export interface UrlMatch {
  /** The canonical form both sides were compared in (see `urlKey`). */
  readonly url: string
  /** Vault-relative POSIX path of the source page (`wiki/sources/....md`). */
  readonly page: string
  /** The job that created the page, when `.raw/.manifest.json` names one; null otherwise. */
  readonly jobId: string | null
  readonly pageMtimeMs: number
}

/** A source page that carries the same DOI as a freshly normalized document. */
export interface DoiMatch {
  readonly doi: string
  /** Vault-relative POSIX path of the source page (`wiki/sources/....md`). */
  readonly page: string
  /** The job that created the page, when `.raw/.manifest.json` names one; null otherwise. */
  readonly jobId: string | null
  /** When the page file was last written - the tie-breaker when no job is known. */
  readonly pageMtimeMs: number
}

/*
 * The DOI pattern and its normalization live in `identifiers.ts` now (docs/sources/SPEC.md
 * section 2.2): the dedupe index, the URL lane, the open-access resolver and the reading list
 * all read DOIs, and a disagreement between any two of them shows up as a document ingested
 * twice. Re-exported so this module's own callers keep importing it from here.
 */
export { normalizeDoi }

/**
 * How much of a document the "own DOI" heuristic looks at, in whitespace-collapsed
 * characters. Measured over the vault's PDF ingests (2026-09-05): every paper that states
 * its own DOI does so within the first ~5,500 collapsed characters (the title block, or the
 * publisher's first-page watermark after the abstract), while the first CITED DOI of a
 * paper without one of its own sits past 12,000. 8,000 clears the one and stays under the
 * other. Collapsing matters: `pdftotext -layout` pads a title page with kilobytes of spaces.
 */
const HEAD_CHARS = 8000
/** Counting occurrences is linear in the text; a scan beyond this is not worth its time. */
const COUNT_CHARS = 2_000_000

/**
 * The DOI a document identifies ITSELF by, or undefined when it names none up front.
 *
 * Candidates are the DOIs on the first page (the head of the normalized text): a paper
 * states its own DOI there, and the reference list - where other papers' DOIs live - comes
 * last. Among several candidates the most frequent one across the whole document wins,
 * because a publisher watermark repeats the paper's own DOI on every page while a cited DOI
 * appears once; ties go to the earliest mention.
 */
export function extractDoi(text: string): string | undefined {
  const collapsed = text.slice(0, COUNT_CHARS).replace(/\s+/g, ' ')
  const candidates = [...new Set(doisIn(collapsed.slice(0, HEAD_CHARS)))]
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  const counts = new Map<string, number>()
  for (const d of doisIn(collapsed)) counts.set(d, (counts.get(d) ?? 0) + 1)
  let best = candidates[0]!
  for (const c of candidates) if ((counts.get(c) ?? 0) > (counts.get(best) ?? 0)) best = c
  return best
}

/**
 * An arXiv identifier, as an id and inside an abs/pdf link: `2506.20907`, `arXiv:2506.20907v2`,
 * `https://arxiv.org/abs/2506.20907`, and the old scheme (`astro-ph/0601001`). Papers on the
 * reading list are named this way far more often than by DOI, and a preprint's id is as stable
 * an identity as a DOI is - which is what the list needs to tell "already in the vault" from
 * "not fetched yet" whatever route the document took in.
 */
const ARXIV = /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv[:\s]\s*)((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)/gi

/** Every arXiv id in a string, normalized to `arxiv:<id>` without the version suffix. */
export function arxivIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(ARXIV)) out.push(`arxiv:${m[1]!.toLowerCase().replace(/v\d+$/, '')}`)
  return [...new Set(out)]
}

/**
 * PubMed Central accessions (`PMC12214508`). The open-access mirror of a paper is often the
 * only version a run can read, and it is what a Fellow then writes down - so it has to count
 * as an identity like a DOI does, or the entry never matches the page it became.
 */
const PMC = /\bPMC\d{5,9}\b/gi

export function pmcIn(text: string): string[] {
  return [...new Set([...text.matchAll(PMC)].map((m) => `pmc:${m[0]!.toUpperCase()}`))]
}

/**
 * The url as identity: the same document with a tracking parameter or a trailing slash is
 * the same document. ONE definition for the reading list and for dedupe (2026-09-18): the
 * canonical form from `url-identity.ts` - https, lowercase host without `www.`, no fragment
 * or trailing slash, known click-tracking parameters removed, every other parameter kept and
 * sorted, a post identified by its status id and a video by its video id. Anything that is
 * not an http(s) url keys to '' and matches nothing. Lives here rather than in the reading
 * list because the page index needs it too, and the reading list already imports its
 * identity helpers from this module.
 */
export const urlKey = (url: string): string => canonicalUrl(url) ?? ''

/**
 * One stable identity for a publication: its DOI where it has one, else its arXiv id. Both
 * normalized, so `https://doi.org/10.1/x`, `doi:10.1/X` and `10.1/x` are one key, and so are
 * an abs link, a pdf link and a bare id.
 */
export function refKey(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined || text.trim() === '') return undefined
  const doi = doisIn(text)[0]
  if (doi !== undefined) return `doi:${doi}`
  return arxivIn(text)[0] ?? pmcIn(text)[0]
}

/** The frontmatter block of a markdown page, or null when the page has none. */
function frontmatterOf(markdown: string): string | null {
  if (!markdown.startsWith('---')) return null
  const end = markdown.indexOf('\n---', 3)
  return end === -1 ? null : markdown.slice(3, end)
}

/**
 * DOIs a source page declares about ITSELF: the values of its `url:` and `doi:` frontmatter
 * keys. The body is deliberately not scanned - a review's body cites dozens of other DOIs,
 * and matching one of those would call a new paper a duplicate of the review that cited it.
 */
export function pageDois(markdown: string): string[] {
  const fm = frontmatterOf(markdown)
  if (fm === null) return []
  const out: string[] = []
  for (const line of fm.split('\n')) {
    const m = /^(url|doi|source_url)\s*:\s*(.*)$/i.exec(line)
    if (m === null) continue
    out.push(...doisIn(m[2]!))
  }
  return [...new Set(out)]
}

/**
 * What a source page identifies ITSELF by: the DOIs and arXiv ids in its `url`, `doi` and
 * `source_url` frontmatter keys. Same rule as {@link pageDois} - the body is not scanned,
 * because a review cites dozens of other papers' identifiers.
 */
export function pageRefs(markdown: string): string[] {
  const fm = frontmatterOf(markdown)
  if (fm === null) return []
  const out: string[] = []
  for (const line of fm.split('\n')) {
    const m = /^(url|doi|source_url|arxiv)\s*:\s*(.*)$/i.exec(line)
    if (m === null) continue
    for (const d of doisIn(m[2]!)) out.push(`doi:${d}`)
    out.push(...arxivIn(m[2]!), ...pmcIn(m[2]!))
  }
  return [...new Set(out)]
}

/**
 * The urls a source page declares about ITSELF: its `url` and `source_url` frontmatter,
 * normalized. Same rule as {@link pageDois} - the body is not scanned, because a review's
 * body links dozens of other papers.
 *
 * This is the identity of last resort. A publication with a DOI is matched by that, whatever
 * route it took into the vault; one without a DOI - and a great many articles have none in
 * their url - can only be recognised by where it came from.
 */
export function pageUrls(markdown: string): string[] {
  const fm = frontmatterOf(markdown)
  if (fm === null) return []
  const out: string[] = []
  for (const line of fm.split('\n')) {
    const m = /^(url|source_url)\s*:\s*(.*)$/i.exec(line)
    if (m === null) continue
    // Frontmatter values are often quoted; the quotes are not part of the url.
    const raw = m[2]!.trim().replace(/^["']|["']$/g, '')
    const key = urlKey(raw)
    if (key !== '') out.push(key)
  }
  return [...new Set(out)]
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

interface RawEntry {
  readonly stamp: string
  readonly sha256: string | null
  readonly originalName: string | null
}

interface PageEntry {
  readonly stamp: string
  readonly dois: readonly string[]
  /** DOIs and arXiv ids together: the identity the reading list matches on. */
  readonly refs: readonly string[]
  /** Normalized `url`/`source_url` frontmatter: the fallback identity, for pages with no DOI. */
  readonly urls: readonly string[]
  readonly mtimeMs: number
}

/** The ingest skill's delta tracker at `.raw/.manifest.json` - only the part read here. */
interface RawManifest {
  sources?: Record<string, { pages_created?: unknown }>
}

export class DedupeIndex {
  private readonly raw = new Map<string, RawEntry>()
  private readonly pages = new Map<string, PageEntry>()

  constructor(private readonly vaultRoot: string) {}

  /**
   * The ingest whose original has this content hash, from the per-job manifests under
   * `.raw/`. Manifests are service-written, but the directory is agent-writable, so a
   * manifest without a usable hash is simply skipped.
   */
  byHash(sha256: string): KnownSource | undefined {
    this.refreshRaw()
    for (const [jobId, entry] of this.raw) {
      if (entry.sha256 === sha256) return { jobId, originalName: entry.originalName }
    }
    return undefined
  }

  /** The source page (and the job behind it) that declares this DOI, if any. */
  /**
   * The source page that already stands for this publication, by DOI or arXiv id - whatever
   * route the document took into the vault. The reading list asks this: an entry whose paper
   * arrived as a dropped PDF has no url in the job log to match on, but it has an identity.
   */
  byRef(ref: string): { readonly ref: string; readonly page: string } | undefined {
    const wanted = refKey(ref)
    if (wanted === undefined) return undefined
    this.refreshPages()
    for (const [page, entry] of this.pages) {
      if (entry.refs.includes(wanted)) return { ref: wanted, page }
    }
    return undefined
  }

  /**
   * The source page that came from this url, if any. The weaker sibling of {@link byRef} and
   * deliberately second in line: an identifier says two documents ARE the same publication,
   * a url only says one page recorded that address. It is what catches the case a DOI cannot
   * - a paper whose url carries no identifier, dropped in as a PDF by hand, where the only
   * thing the entry and the page have in common is where the document came from.
   */
  byUrl(url: string): UrlMatch | undefined {
    const wanted = urlKey(url)
    if (wanted === '') return undefined
    this.refreshPages()
    for (const [page, entry] of this.pages) {
      if (entry.urls.includes(wanted)) return { url: wanted, page, jobId: this.jobForPage(page), pageMtimeMs: entry.mtimeMs }
    }
    return undefined
  }

  byDoi(doi: string): DoiMatch | undefined {
    const wanted = normalizeDoi(doi)
    this.refreshPages()
    for (const [page, entry] of this.pages) {
      if (!entry.dois.includes(wanted)) continue
      return { doi: wanted, page, jobId: this.jobForPage(page), pageMtimeMs: entry.mtimeMs }
    }
    return undefined
  }

  /**
   * Whether the vault's own delta tracker credits any wiki page to this job (2026-09-16).
   *
   * `.raw/<job-id>/manifest.json` is written by PREPROCESSING, before an agent has read a
   * word, so its mere existence says a file was staged here - not that anything came of it.
   * `.raw/.manifest.json` is the other half: the ingest skill records what each raw file
   * produced. A job dir the tracker credits with pages is an ingest that happened; one it
   * credits with nothing is a file the vault took in and never wrote up.
   *
   * Measured over this vault's 120 hash-bearing job dirs: 114 are credited, and the handful
   * that are not are either genuinely unfinished or old enough that no tracker entry was
   * kept. So this is evidence FOR an ingest, never against one - the caller asks the job
   * history first and only falls back here.
   */
  producedPages(jobId: string): boolean {
    const manifest = readJson<RawManifest>(path.join(this.vaultRoot, '.raw', '.manifest.json'))
    if (manifest?.sources === undefined) return false
    const prefix = `.raw/${jobId}/`
    for (const [rawPath, entry] of Object.entries(manifest.sources)) {
      if (!rawPath.startsWith(prefix)) continue
      if (Array.isArray(entry.pages_created) && entry.pages_created.length > 0) return true
    }
    return false
  }

  /**
   * Which job created a page, read from `.raw/.manifest.json` (the skill records every
   * page a raw file produced under `sources[<raw path>].pages_created`). The job id is the
   * `.raw/<job-id>/` directory the raw path sits in; pre-service ingests (`.raw/m0-test/`)
   * and hand-written pages resolve to null.
   */
  private jobForPage(page: string): string | null {
    const manifest = readJson<RawManifest>(path.join(this.vaultRoot, '.raw', '.manifest.json'))
    if (manifest?.sources === undefined) return null
    for (const [rawPath, entry] of Object.entries(manifest.sources)) {
      const created = entry.pages_created
      if (!Array.isArray(created) || !created.includes(page)) continue
      const parts = rawPath.split('/')
      // `.raw/<job-id>/<file>` and nothing else: anything shallower or deeper is not a job dir.
      return parts.length === 3 && parts[0] === '.raw' ? parts[1]! : null
    }
    return null
  }

  private refreshRaw(): void {
    const rawRoot = path.join(this.vaultRoot, '.raw')
    let dirs: string[]
    try {
      dirs = fs.readdirSync(rawRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      this.raw.clear()
      return
    }
    const seen = new Set(dirs)
    for (const known of this.raw.keys()) if (!seen.has(known)) this.raw.delete(known)
    for (const dir of dirs) {
      const file = path.join(rawRoot, dir, 'manifest.json')
      const st = statOrNull(file)
      if (st === null) {
        this.raw.delete(dir)
        continue
      }
      const stamp = `${st.mtimeMs}:${st.size}`
      if (this.raw.get(dir)?.stamp === stamp) continue
      const m = readJson<{ sha256?: unknown; originalName?: unknown }>(file)
      this.raw.set(dir, {
        stamp,
        sha256: typeof m?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(m.sha256) ? m.sha256 : null,
        originalName: typeof m?.originalName === 'string' ? m.originalName : null,
      })
    }
  }

  private refreshPages(): void {
    const root = path.join(this.vaultRoot, 'wiki', 'sources')
    const files = new Set<string>()
    const walk = (dir: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) walk(abs)
        else if (e.isFile() && e.name.endsWith('.md')) files.add(abs)
      }
    }
    walk(root)
    const rels = new Map<string, string>()
    for (const abs of files) rels.set(path.relative(this.vaultRoot, abs).split(path.sep).join('/'), abs)
    for (const known of this.pages.keys()) if (!rels.has(known)) this.pages.delete(known)
    for (const [rel, abs] of rels) {
      const st = statOrNull(abs)
      if (st === null) {
        this.pages.delete(rel)
        continue
      }
      const stamp = `${st.mtimeMs}:${st.size}`
      if (this.pages.get(rel)?.stamp === stamp) continue
      let dois: string[]
      let refs: string[]
      let urls: string[]
      try {
        // Frontmatter sits at the top; 8 KB covers any page's header without reading a
        // long article for a field that is never past its first lines.
        const fd = fs.openSync(abs, 'r')
        try {
          const buf = Buffer.alloc(8192)
          const n = fs.readSync(fd, buf, 0, buf.length, 0)
          const head = buf.subarray(0, n).toString('utf8')
          dois = pageDois(head)
          refs = pageRefs(head)
          urls = pageUrls(head)
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        dois = []
        refs = []
        urls = []
      }
      this.pages.set(rel, { stamp, dois, refs, urls, mtimeMs: st.mtimeMs })
    }
  }
}
