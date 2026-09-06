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

/** Where the Fellows write their finds. One page, appended to, never rewritten. */
export const READING_LIST_PAGE = 'wiki/meta/reading-list.md'

export interface ReadingEntry {
  /** The publication as the Fellow named it. */
  readonly title: string
  readonly url: string
  /** DOI, arXiv id or another stable reference, when the Fellow found one. */
  readonly ref: string | null
  readonly domain: string | null
  /** Why it is worth the original, in the Fellow's words. */
  readonly why: string | null
  /** Who found it and when, as written. */
  readonly found: string | null
}

export interface ReadingItem extends ReadingEntry {
  /** The ingest of this URL, when one exists. */
  readonly job: { readonly id: string; readonly status: string; readonly pages: number } | null
}

const FIELD = /^\s*(title|url|ref|domain|why|found)\s*:\s*(.*)$/i

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
      out.push({
        title: cur['title'].trim(),
        url: cur['url'].trim(),
        ref: cur['ref']?.trim() || null,
        domain: cur['domain']?.trim().toLowerCase() || null,
        why: cur['why']?.trim() || null,
        found: cur['found']?.trim() || null,
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
    const key = e.url.replace(/[#?].*$/, '').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The list as the dashboard shows it: entries plus what the job log knows about each URL. */
export class ReadingListService {
  constructor(
    private readonly vaultRoot: string,
    private readonly jobs: JobStore,
  ) {}

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
      const key = (j.url ?? '').replace(/[#?].*$/, '').toLowerCase()
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
      job: byUrl.get(e.url.replace(/[#?].*$/, '').toLowerCase()) ?? null,
    }))
  }
}
