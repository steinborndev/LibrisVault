/**
 * The reading list (docs/agents/SPEC.md section 10.6): what the Fellows read on the web and
 * thought worth keeping in the original.
 *
 * A research step reads sources over the web and writes prose about them; nothing of the
 * document itself reaches the vault. Letting the agent download it instead would step
 * around every check the ingest path makes - the SSRF guard, the size cap, the magic-byte
 * refusal of executables, the dedupe and the job log - and a research run reads pages
 * written by strangers, so what it is told to save is not always what the user wants saved.
 *
 * So the agent writes an ENTRY, and the service does the downloading. Each run appends its
 * finds to `wiki/meta/reading-list.md` in a fixed field format; this module reads that page
 * back, matches each entry against the job log (has it been ingested, is one running), and
 * the dashboard offers the ingest as one click that goes through the ordinary URL path.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { JobStore } from '../db/jobs.js'
import type { Mutex } from '../util/mutex.js'
import { commitPaths, type CommitResult } from './git.js'
import { refKey, urlKey } from './dedupe.js'

/** Where the Fellows write their finds. One page, appended to, never rewritten. */
export const READING_LIST_PAGE = 'wiki/meta/reading-list.md'

/**
 * How far the Fellow got with the document itself. The list used to hold only what a run had
 * actually read, which quietly dropped the entries worth the most: a paper behind a paywall,
 * or a PDF that would not extract, is exactly the one the user's own access can get and the
 * agent's cannot.
 */
export type ReadingAccess = 'open' | 'paywalled' | 'unreachable'

export interface ReadingEntry {
  /** The publication as the Fellow named it. */
  readonly title: string
  readonly url: string
  /** DOI, arXiv id or another stable reference, when the Fellow found one. */
  readonly ref: string | null
  readonly domain: string | null
  /** Why it is worth the original, in the Fellow's words. */
  readonly why: string | null
  /** Who found it and when, as written (older entries carry this instead of `by`/`at`). */
  readonly found: string | null
  /** The Fellow's name, for filtering; parsed out of `by:` or the legacy `found:` line. */
  readonly by: string | null
  /** The date it was found, ISO where it could be read. */
  readonly at: string | null
  /** What the run could do with it, as the Fellow reported it; null when it said nothing. */
  readonly access: ReadingAccess | null
  /** Why it could not be read: an HTTP status, "paywall", "no extractable text". */
  readonly blocked: string | null
  /** The vault page this publication became, once the service saw it arrive. */
  readonly filed: string | null
  /** When it was filed, as a date; what the recap reads to mention it once. */
  readonly filedAt: string | null
}

export interface ReadingItem extends ReadingEntry {
  /** The ingest of this URL, when one exists. */
  readonly job: { readonly id: string; readonly status: string; readonly pages: number } | null
  /** `access` where the Fellow gave one, else read off the host; never null, so a filter can rely on it. */
  readonly reach: ReadingAccess | 'unknown'
  /** The source page this publication became, from the entry itself or found by identity. */
  readonly page: string | null
  /**
   * How it was recognized, weakest last: its DOI / arXiv id (`ref`), the url a source page
   * records (`url`), the ingest that ran for its url (`job`), or a dropped file named exactly
   * as its url names it (`file`).
   */
  readonly via: 'job' | 'ref' | 'url' | 'file' | null
}

const FIELD = /^\s*(title|url|ref|domain|why|found|by|at|access|blocked|filed|filedat)\s*:\s*(.*)$/i

/** Hosts that only ever serve the full text: an entry from one of them needs no toggle to be useful. */
const OPEN_HOSTS = [
  'arxiv.org',
  'biorxiv.org',
  'medrxiv.org',
  'pmc.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov',
  'plos.org',
  'doaj.org',
  'zenodo.org',
  'osti.gov',
  'europepmc.org',
  'openreview.net',
  'aclanthology.org',
  'dspace.mit.edu',
  'hal.science',
]

/**
 * What the reader can expect to reach. The Fellow's own word wins; without one the host
 * decides, and only for hosts that serve full text unconditionally. Everything else is
 * `unknown` rather than a guess, because calling a readable paper paywalled hides it.
 */
export function reachOf(entry: ReadingEntry): ReadingAccess | 'unknown' {
  if (entry.access !== null) return entry.access
  let host: string
  try {
    host = new URL(entry.url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return 'unknown'
  }
  return OPEN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? 'open' : 'unknown'
}

/**
 * One stable identity for an entry: the DOI or arXiv id it names, from its `ref` line or out
 * of its url. A publication that arrives as a dropped PDF has no url the job log knows, but
 * its source page carries the same identifier, which is how the two find each other.
 */
export function entryRef(entry: Pick<ReadingEntry, 'ref' | 'url'>): string | undefined {
  return refKey(entry.ref) ?? refKey(entry.url)
}

/** Re-exported from the dedupe index, which needs the same normalization for its page urls. */
export { urlKey } from './dedupe.js'

/**
 * The file a url points at, lowercased, or undefined when the url ends in something that is
 * not a filename.
 *
 * The last path segment only counts as one when it carries an extension: `/8697373` and
 * `/NEJMoa2504747` are article ids and must never be read as files, or every entry on such a
 * host would compete for the same match.
 */
export function urlFileName(url: string): string | undefined {
  const trimmed = urlKey(url)
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return /^[^/]+\.[a-z0-9]{2,5}$/.test(last) ? last : undefined
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `Ada, 2026-09-06` - the shape the first version wrote, kept readable for the entries that carry it. */
function splitFound(found: string | null): { by: string | null; at: string | null } {
  if (found === null) return { by: null, at: null }
  const m = /^(.*?),\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(found)
  return m ? { by: m[1]!.trim() || null, at: m[2]! } : { by: found.trim() || null, at: null }
}

/**
 * Entries out of the page. One starts at a `- title:` line and runs to the next one; the
 * lines under it carry the other fields. Anything that carries no url is dropped: the
 * entry exists to be fetched.
 */
export function parseReadingList(markdown: string): ReadingEntry[] {
  const out: ReadingEntry[] = []
  let cur: Record<string, string> | null = null
  const flush = (): void => {
    if (cur && typeof cur['title'] === 'string' && typeof cur['url'] === 'string' && /^https?:\/\//i.test(cur['url'])) {
      const found = cur['found']?.trim() || null
      const legacy = splitFound(found)
      const access = cur['access']?.trim().toLowerCase()
      out.push({
        title: cur['title'].trim(),
        url: cur['url'].trim(),
        ref: cur['ref']?.trim() || null,
        domain: cur['domain']?.trim().toLowerCase() || null,
        why: cur['why']?.trim() || null,
        found,
        by: cur['by']?.trim() || legacy.by,
        at: cur['at']?.trim() || legacy.at,
        access: access === 'open' || access === 'paywalled' || access === 'unreachable' ? access : null,
        blocked: cur['blocked']?.trim() || null,
        filed: cur['filed']?.trim() || null,
        filedAt: cur['filedat']?.trim() || null,
      })
    }
    cur = null
  }
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/^\s*[-*]\s+/, (m) => (m ? '' : m))
    const startsEntry = /^\s*[-*]\s+title\s*:/i.test(raw)
    if (startsEntry) {
      flush()
      cur = {}
    }
    const m = FIELD.exec(line)
    if (m && cur !== null) {
      const key = m[1]!.toLowerCase()
      // A field never overwrites itself inside one entry: the first line wins, so a "why"
      // that runs long cannot swallow the next entry's fields.
      if (cur[key] === undefined) cur[key] = m[2] ?? ''
    }
  }
  flush()
  // Same URL twice (two Fellows, or two nights) is one entry; the first note wins.
  const seen = new Set<string>()
  return out.filter((e) => {
    const key = urlKey(e.url)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The list as the dashboard shows it: entries plus what the job log knows about each URL. */
export interface ReadingListWriteOptions {
  /** The shared commit mutex: an added entry is one commit, like every other service write. */
  readonly commitMutex?: Mutex
  readonly commit?: (root: string, message: string, paths: readonly string[]) => Promise<CommitResult>
  readonly autoCommit?: () => boolean
  /** The dedupe index's lookup by DOI / arXiv id; without it only the job log is matched. */
  readonly byRef?: (ref: string) => { readonly page: string } | undefined
  /**
   * The dedupe index's lookup by source url - the fallback for a publication whose url names
   * no DOI, which is most articles outside the preprint servers.
   */
  readonly byUrl?: (url: string) => { readonly page: string } | undefined
}

export class ReadingListService {
  private readonly write: ReadingListWriteOptions

  constructor(
    private readonly vaultRoot: string,
    private readonly jobs: JobStore,
    write: ReadingListWriteOptions = {},
  ) {
    this.write = write
    this.byRef = write.byRef ?? ((): undefined => undefined)
    this.byUrl = write.byUrl ?? ((): undefined => undefined)
  }

  /** Looks a publication up by its DOI or arXiv id; wired to the dedupe index in the service. */
  private readonly byRef: (ref: string) => { readonly page: string } | undefined
  /** The same, by the url a source page records; the fallback when there is no identifier. */
  private readonly byUrl: (url: string) => { readonly page: string } | undefined

  entries(): ReadingItem[] {
    const file = path.join(this.vaultRoot, READING_LIST_PAGE)
    let markdown: string
    try {
      markdown = fs.readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const list = parseReadingList(markdown)
    const jobs = this.jobsByUrl()
    const files = this.filesFor(list)
    return list.map((e) => {
      const { job, page, via } = this.locate(e, jobs, files)
      return { ...e, job, reach: reachOf(e), page, via }
    })
  }

  /**
   * Ingested files, by name, for the entries whose url names a file - and ONLY where the name
   * is unambiguous on both sides.
   *
   * A browser names a download after the last segment of the url it came from, so a document
   * the user fetched from the very link the board offers arrives carrying that name. That is
   * the only thing such an ingest and its entry still have in common: there is no identifier,
   * the page records the local staging path rather than an address, and a dropped file puts no
   * url in the job log.
   *
   * The guard is what keeps a filename honest. A name shared by two entries, or by two
   * ingests, matches NOTHING: a wrong match here would mark an entry filed and tell a Fellow
   * its publication had arrived, pointing at someone else's document. Refusing to guess is
   * cheap; the entry simply stays open, which is where it was anyway.
   */
  private filesFor(list: readonly ReadingEntry[]): Map<string, { id: string; status: string }> {
    const wanted = new Map<string, number>()
    for (const e of list) {
      const name = urlFileName(e.url)
      if (name !== undefined) wanted.set(name, (wanted.get(name) ?? 0) + 1)
    }
    const out = new Map<string, { id: string; status: string }>()
    const ambiguous = new Set<string>()
    for (const j of this.jobs.list({ limit: 500 })) {
      const name = (j.original_name ?? '').trim().toLowerCase()
      if (name === '' || wanted.get(name) !== 1) continue
      if (out.has(name)) {
        ambiguous.add(name)
        continue
      }
      out.set(name, { id: j.id, status: j.status })
    }
    for (const name of ambiguous) out.delete(name)
    return out
  }

  /** What the job log knows about each ingested url, first job per url, built once per pass. */
  private jobsByUrl(): Map<string, { id: string; status: string; pages: number }> {
    const out = new Map<string, { id: string; status: string; pages: number }>()
    for (const j of this.jobs.list({ limit: 500 })) {
      if (typeof j.url !== 'string' || j.url === null) continue
      const key = urlKey(j.url)
      if (key === '' || out.has(key)) continue
      let pages: number
      try {
        pages = (JSON.parse(j.created_pages ?? '[]') as unknown[]).length
      } catch {
        pages = 0
      }
      out.set(key, { id: j.id, status: j.status, pages })
    }
    return out
  }

  /**
   * Where an entry's publication already sits in the vault, and what the job log knows about
   * it. THE one answer, used by both the board and the nightly reconcile.
   *
   * They used to answer separately, and differently: the board knew four ways in and the
   * reconcile only the identifier, so an entry without a DOI was shown as "in the vault" and
   * never written back as filed - and the Fellow that had asked for it was never told. A
   * single resolver is the fix; two call sites cannot drift apart if there is only one.
   *
   * In order of certainty:
   *   1. the entry says `filed` itself
   *   2. its identifier stands on a source page (a DOI is the same publication anywhere)
   *   3. a source page records its url (weaker, and one route for a paper with no DOI that
   *      arrived as a hand-dropped PDF - but only when the ingest wrote a real address, which
   *      it can only do when the document itself carried one)
   *   4. an ingest ran for its url and finished
   *   5. an ingest of a file named exactly as the entry's url names it (weakest, guarded by
   *      {@link filesFor}: the download the user made from the link on the board)
   */
  private locate(
    e: ReadingEntry,
    jobs: Map<string, { id: string; status: string; pages: number }>,
    files: Map<string, { id: string; status: string }>,
  ): { job: { id: string; status: string; pages: number } | null; page: string | null; via: 'job' | 'ref' | 'url' | 'file' | null } {
    const job = jobs.get(urlKey(e.url)) ?? null
    if (e.filed !== null) return { job, page: e.filed, via: 'ref' }
    const ref = entryRef(e)
    const byRef = ref !== undefined ? (this.byRef(ref)?.page ?? null) : null
    if (byRef !== null) return { job, page: byRef, via: 'ref' }
    const byUrl = this.byUrl(e.url)?.page ?? null
    if (byUrl !== null) return { job, page: byUrl, via: 'url' }
    const fromJob = job?.status === 'done' ? (this.pageOfJob(job.id) ?? null) : null
    if (fromJob !== null) return { job, page: fromJob, via: 'job' }
    const name = urlFileName(e.url)
    const dropped = name !== undefined ? files.get(name) : undefined
    const fromFile = dropped?.status === 'done' ? (this.pageOfJob(dropped.id) ?? null) : null
    return { job, page: fromFile, via: fromFile === null ? null : 'file' }
  }

  /** The first source page an ingest wrote, for the row's link into the vault. */
  private pageOfJob(jobId: string): string | undefined {
    const job = this.jobs.get(jobId)
    if (!job) return undefined
    try {
      const pages = JSON.parse(job.created_pages ?? '[]') as string[]
      return pages.find((p) => p.startsWith('wiki/sources/')) ?? pages[0]
    } catch {
      return undefined
    }
  }

  /** One entry as the page holds it: the field block a Fellow would have written by hand. */
  static render(e: ReadingEntry): string {
    const line = (k: string, v: string | null): string => (v === null || v === '' ? '' : `  ${k}: ${v}\n`)
    return (
      `- title: ${e.title}\n` +
      `  url: ${e.url}\n` +
      line('ref', e.ref) +
      line('domain', e.domain) +
      line('why', e.why) +
      line('access', e.access) +
      line('blocked', e.blocked) +
      line('by', e.by) +
      line('at', e.at) +
      line('filed', e.filed) +
      line('filedAt', e.filedAt)
    )
  }

  /**
   * Appends entries the service was told about (the planner's finds, section 10.6). Written
   * by the service rather than by the agent for the same reason the download is: the planning
   * run is read-only and has no web access at all, so what it names has to come in as data.
   * Urls already on the list are skipped, and the caller commits.
   */
  append(entries: readonly ReadingEntry[]): { readonly added: readonly ReadingEntry[]; readonly markdown: string | null } {
    const file = path.join(this.vaultRoot, READING_LIST_PAGE)
    let markdown: string
    try {
      markdown = fs.readFileSync(file, 'utf8')
    } catch {
      return { added: [], markdown: null }
    }
    const known = new Set(parseReadingList(markdown).map((e) => urlKey(e.url)))
    const added: ReadingEntry[] = []
    for (const e of entries) {
      const key = urlKey(e.url)
      if (key === '' || known.has(key) || !/^https?:\/\//i.test(e.url)) continue
      known.add(key)
      added.push(e)
    }
    if (added.length === 0) return { added: [], markdown: null }
    const body = added.map((e) => ReadingListService.render(e)).join('\n')
    const next = `${markdown.replace(/\s*$/, '')}\n\n${body.replace(/\s*$/, '')}\n`
    return { added, markdown: next }
  }

  /**
   * Marks the entries whose publication has arrived in the vault, and says which they are.
   *
   * This is what closes the loop for a paper the user fetched by hand: the ingest of a dropped
   * PDF has no url the list could match, but the source page it wrote carries the same DOI or
   * arXiv id the entry names. Writing `filed` into the entry does two things at once - it is
   * the link the row shows, and it is the record that the Fellow has been told, so the note is
   * written once and not on every read.
   */
  async reconcile(today: string): Promise<ReadonlyArray<{ readonly entry: ReadingEntry; readonly page: string }>> {
    const file = path.join(this.vaultRoot, READING_LIST_PAGE)
    let markdown: string
    try {
      markdown = fs.readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const found: Array<{ entry: ReadingEntry; page: string }> = []
    const list = parseReadingList(markdown)
    const jobs = this.jobsByUrl()
    const files = this.filesFor(list)
    let next = markdown
    for (const entry of list) {
      if (entry.filed !== null) continue
      // The same resolver the board uses, so what a row shows and what the Fellow is told
      // can never be two different answers again.
      const page = this.locate(entry, jobs, files).page
      if (page === null) continue
      // The entry's own block gains two lines; nothing else on the page is touched.
      const block = new RegExp(`(^[ \t]*[-*][ \t]+title:[ \t]*${escapeRe(entry.title)}[ \t]*$)`, 'm')
      if (!block.test(next)) continue
      next = next.replace(block, `$1\n  filed: ${page}\n  filedAt: ${today}`)
      found.push({ entry: { ...entry, filed: page, filedAt: today }, page })
    }
    if (found.length === 0 || this.write.commitMutex === undefined) return found.length > 0 ? found : []
    const commit = this.write.commit ?? commitPaths
    await this.write.commitMutex.runExclusive(async () => {
      fs.writeFileSync(file, next, 'utf8')
      if (this.write.autoCommit?.() ?? true) {
        await commit(this.vaultRoot, `fellows: ${found.length} reading list entr${found.length === 1 ? 'y is' : 'ies are'} in the vault`, [READING_LIST_PAGE])
      }
    })
    return found
  }

  /**
   * Writes what {@link append} produced, as one commit behind the shared mutex - the same path
   * the notebook and the recap page take. Without a mutex (a test, a read-only wiring) it
   * writes nothing and says so.
   */
  async add(entries: readonly ReadingEntry[]): Promise<{ readonly added: number }> {
    const { added, markdown } = this.append(entries)
    if (markdown === null || this.write.commitMutex === undefined) return { added: 0 }
    const commit = this.write.commit ?? commitPaths
    await this.write.commitMutex.runExclusive(async () => {
      fs.writeFileSync(path.join(this.vaultRoot, READING_LIST_PAGE), markdown, 'utf8')
      if (this.write.autoCommit?.() ?? true) {
        await commit(this.vaultRoot, `fellows: ${added.length} reading list entr${added.length === 1 ? 'y' : 'ies'}`, [READING_LIST_PAGE])
      }
    })
    return { added: added.length }
  }
}
