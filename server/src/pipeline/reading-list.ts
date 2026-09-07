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
}

export interface ReadingItem extends ReadingEntry {
  /** The ingest of this URL, when one exists. */
  readonly job: { readonly id: string; readonly status: string; readonly pages: number } | null
  /** `access` where the Fellow gave one, else read off the host; never null, so a filter can rely on it. */
  readonly reach: ReadingAccess | 'unknown'
}

const FIELD = /^\s*(title|url|ref|domain|why|found|by|at|access|blocked)\s*:\s*(.*)$/i

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

/** The url as identity: the same document with a tracking parameter is the same entry. */
export const urlKey = (url: string): string => url.trim().replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase()

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
}

export class ReadingListService {
  private readonly write: ReadingListWriteOptions

  constructor(
    private readonly vaultRoot: string,
    private readonly jobs: JobStore,
    write: ReadingListWriteOptions = {},
  ) {
    this.write = write
  }

  entries(): ReadingItem[] {
    const file = path.join(this.vaultRoot, READING_LIST_PAGE)
    let markdown: string
    try {
      markdown = fs.readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const jobs = this.jobs.list({ limit: 500 }).filter((j) => typeof j.url === 'string' && j.url !== null)
    const byUrl = new Map<string, { id: string; status: string; pages: number }>()
    for (const j of jobs) {
      const key = urlKey(j.url ?? '')
      if (key === '' || byUrl.has(key)) continue
      let pages: number
      try {
        pages = (JSON.parse(j.created_pages ?? '[]') as unknown[]).length
      } catch {
        pages = 0
      }
      byUrl.set(key, { id: j.id, status: j.status, pages })
    }
    return parseReadingList(markdown).map((e) => ({
      ...e,
      job: byUrl.get(urlKey(e.url)) ?? null,
      reach: reachOf(e),
    }))
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
      line('at', e.at)
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
