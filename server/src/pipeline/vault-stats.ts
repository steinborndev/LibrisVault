/**
 * Read-only vault statistics for the Overview tab (SPEC.md §6.1, TASKS-M3 §1).
 *
 * Everything here is derived from the vault filesystem + git history — the vault is the
 * single source of truth (hard rule 1), so these numbers are rebuildable and never mirrored
 * into SQLite. The service only ever READS the vault here; it never writes.
 *
 * Results are cheap for a personal vault (hundreds of pages) but not free (a `git log`
 * scan), so the caller caches them with a short TTL and invalidates on the bus `stats`
 * event (a commit landed).
 */

import fs from 'node:fs'
import path from 'node:path'
import { runTool } from './preprocess/tools.js'
import { freshnessDate } from './page-dates.js'

/**
 * Wiki subfolders the dashboard knows how to LABEL (SPEC.md §6.1).
 *
 * Not the definition of a page. It used to be: the counter summed these eight folders, so the
 * five pages that live at the wiki root (`index.md`, `hot.md`, `log.md`, `overview.md`,
 * `getting-started.md`) were in no bucket and simply did not exist for the dashboard - the
 * Home tab said 1069 while the graph, which walks the tree, said 1074. An allowlist fails that
 * way silently, and would swallow a whole new page type the same way. The counter now walks
 * `wiki/` and buckets by first path segment; this list only fixes the order of the known ones.
 */
export const WIKI_PAGE_DIRS = [
  'concepts',
  'entities',
  'sources',
  'references',
  'comparisons',
  'questions',
  'folds',
  'meta',
] as const

export type WikiPageDir = (typeof WIKI_PAGE_DIRS)[number]

/** Bucket for pages that sit directly in `wiki/` rather than in one of its folders. */
export const ROOT_BUCKET = 'root'

/** The bucket a wiki page counts towards: its folder under `wiki/`, or {@link ROOT_BUCKET}. */
function bucketOf(wikiRelative: string): string {
  const slash = wikiRelative.indexOf('/')
  return slash < 0 ? ROOT_BUCKET : wikiRelative.slice(0, slash)
}

export interface PageCounts {
  readonly byDir: Record<string, number>
  readonly total: number
}

export interface RecentPage {
  /** Vault-relative POSIX path, e.g. `wiki/concepts/foo.md`. */
  readonly path: string
  readonly dir: string
  /** ISO mtime. */
  readonly modified: string
}

export interface Commit {
  readonly hash: string
  readonly date: string
  readonly subject: string
  /** Wiki markdown pages touched by this commit (vault-relative POSIX). */
  readonly pages: string[]
}

export interface GrowthPoint {
  /** `YYYY-MM-DD`. */
  readonly date: string
  /** Cumulative wiki page count at end of that day. */
  readonly total: number
}

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep)

async function git(vaultRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runTool('git', ['-C', vaultRoot, ...args], { timeoutMs: 30_000 })
  return stdout
}

/**
 * Counts every `*.md` under `wiki/`, bucketed by folder.
 *
 * The known folders are seeded first so the bars keep their order and an emptied folder still
 * reads as 0 rather than vanishing; anything else the vault holds gets a bucket of its own,
 * named after the folder. The total is the count, not a sum of a fixed list, so it agrees with
 * what the graph shows.
 *
 * `_index.md` counts, because it is a file in the folder and this is a count of files. The
 * graph's per-type chips will read one lower per folder, and that is a different question:
 * they count knowledge nodes, and an `_index` is structural. Location and kind are two axes,
 * not two attempts at the same number.
 */
export function pageCounts(vaultRoot: string): PageCounts {
  const byDir: Record<string, number> = {}
  for (const dir of WIKI_PAGE_DIRS) byDir[dir] = 0
  let total = 0
  const wiki = path.join(vaultRoot, 'wiki')
  walkMarkdown(wiki, (abs) => {
    const bucket = bucketOf(toPosix(path.relative(wiki, abs)))
    byDir[bucket] = (byDir[bucket] ?? 0) + 1
    total += 1
  })
  return { byDir, total }
}

/**
 * Most-recently-modified wiki pages by mtime, "recently created/changed" (SPEC.md §6.1).
 *
 * Walks the same tree as {@link pageCounts}, and for the same reason: over the folder list it
 * could never surface `wiki/hot.md`, `wiki/index.md` or `wiki/log.md`, which is to say the
 * three pages every single ingest touches - the most-changed pages in the vault were the ones
 * "recently changed" structurally could not report.
 */
/**
 * The most recently WRITTEN pages, in the sense of what they say (B7, 7.3).
 *
 * Sorted by `content_updated:` where a page has it, falling back to `created:` and only then
 * to the file's mtime. Both the mtime and `updated:` answer "when was this file last touched",
 * and every mass pass touches everything: 1231 of 1247 pages claim an update within thirty
 * days, which makes a list sorted by it a list in no order at all.
 */
export function recentPages(vaultRoot: string, limit = 12): RecentPage[] {
  const found: RecentPage[] = []
  const wiki = path.join(vaultRoot, 'wiki')
  walkMarkdown(wiki, (abs, stat) => {
    // `_index.md` and friends are auto-generated folder indexes, rewritten by every run that
    // files a page there. They are pages for the counter and noise for this list, which is
    // why the rule sits here rather than in the walk (SPEC.md §6.1).
    if (path.basename(abs).startsWith('_')) return
    let said: string | null = null
    try {
      said = freshnessDate(fs.readFileSync(abs, 'utf8'))
    } catch {
      /* unreadable: the mtime is then the only answer there is */
    }
    found.push({
      path: toPosix(path.relative(vaultRoot, abs)),
      dir: bucketOf(toPosix(path.relative(wiki, abs))),
      modified: said === null ? stat.mtime.toISOString() : new Date(`${said}T12:00:00Z`).toISOString(),
    })
  })
  return found.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit)
}

/** Visits every `*.md` under `dir`, recursively. What counts as a page is the caller's call. */
function walkMarkdown(dir: string, visit: (abs: string, stat: fs.Stats) => void): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walkMarkdown(abs, visit)
    else if (e.isFile() && e.name.endsWith('.md')) {
      try {
        visit(abs, fs.statSync(abs))
      } catch {
        /* raced deletion — skip */
      }
    }
  }
}

/** The last `limit` commits with the wiki pages each touched (SPEC.md §6.1). */
export async function recentCommits(vaultRoot: string, limit = 5): Promise<Commit[]> {
  // Records separated by \x1e, fields by \x1f, so subjects with any punctuation stay intact.
  const raw = await git(vaultRoot, [
    'log',
    `-n`,
    String(limit),
    '--name-only',
    `--pretty=format:%x1e%H%x1f%cI%x1f%s`,
  ])
  const commits: Commit[] = []
  for (const record of raw.split('\x1e')) {
    if (record.trim() === '') continue
    const [header, ...fileLines] = record.split('\n')
    const [hash, date, subject] = (header ?? '').split('\x1f')
    if (!hash) continue
    const pages = fileLines
      .map((l) => l.trim())
      .filter((l) => l.startsWith('wiki/') && l.endsWith('.md'))
    commits.push({ hash: hash.slice(0, 8), date: date ?? '', subject: subject ?? '', pages })
  }
  return commits
}

/**
 * Cumulative wiki-page growth over the last `days`, anchored to the current on-disk total.
 *
 * Rather than replay the whole history, we walk recent commits newest→oldest, subtracting
 * each commit's net wiki add/delete from a running total that starts at `currentTotal`.
 * The result is a per-day series that ends today at the real page count — approximate for
 * the far past (renames count as add+delete), exact at the present.
 *
 * The deltas count any `wiki/**.md`, and the anchor now does too: while the anchor summed a
 * fixed folder list, a page added outside those folders moved the curve without ever being in
 * the total it was anchored to, so every earlier point was off by one.
 */
export async function growth(vaultRoot: string, days = 30, currentTotal?: number): Promise<GrowthPoint[]> {
  const total = currentTotal ?? pageCounts(vaultRoot).total
  const raw = await git(vaultRoot, [
    'log',
    `--since=${days} days ago`,
    '--diff-filter=AD',
    '--name-status',
    `--pretty=format:%x1e%cI`,
  ])

  // Net wiki-page delta per calendar day (A = +1, D = −1 for a wiki *.md path).
  const deltaByDay = new Map<string, number>()
  for (const record of raw.split('\x1e')) {
    if (record.trim() === '') continue
    const [iso, ...fileLines] = record.split('\n')
    const day = (iso ?? '').slice(0, 10)
    if (day === '') continue
    let delta = 0
    for (const line of fileLines) {
      const [status, file] = line.split('\t')
      if (!file || !file.startsWith('wiki/') || !file.endsWith('.md')) continue
      if (status === 'A') delta += 1
      else if (status === 'D') delta -= 1
    }
    deltaByDay.set(day, (deltaByDay.get(day) ?? 0) + delta)
  }

  // Walk days newest→oldest: today's cumulative is `total`; each earlier day is the day
  // after minus that day's additions.
  const days_sorted = [...deltaByDay.keys()].sort() // ascending
  const points: GrowthPoint[] = []
  let running = total
  for (let i = days_sorted.length - 1; i >= 0; i--) {
    const day = days_sorted[i]!
    points.push({ date: day, total: running })
    running -= deltaByDay.get(day) ?? 0
  }
  points.reverse() // ascending by date for the chart
  return points
}

/** Raw `wiki/hot.md` contents for the Overview hot-cache panel, or null if absent. */
export function readHotCache(vaultRoot: string): string | null {
  try {
    return fs.readFileSync(path.join(vaultRoot, 'wiki', 'hot.md'), 'utf8')
  } catch {
    return null
  }
}

/**
 * How long `wiki/hot.md` is, in words, or null when there is none. The cache is loaded at the
 * start of every run, so its size is a running cost; the budget it is measured against lives
 * in validator.ts, and the Wartung card shows both.
 */
export function hotCacheWords(vaultRoot: string): number | null {
  const text = readHotCache(vaultRoot)
  if (text === null) return null
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * When `wiki/hot.md` was last WRITTEN, as an ISO string. Not the same as when it was last
 * refreshed: every research run writes the file too, which is why the Wartung card dates the
 * refresh from the last `hot-cache` run and keeps this as "last written".
 */
export function hotCacheUpdatedAt(vaultRoot: string): string | null {
  try {
    return fs.statSync(path.join(vaultRoot, 'wiki', 'hot.md')).mtime.toISOString()
  } catch {
    return null
  }
}

/**
 * The newest `wiki/meta/lint-report-YYYY-MM-DD.md` in the vault, or null when none exists.
 * The Maintenance tab links it persistently — a lint result must survive tab switches and
 * restarts, and the report FILE in the vault is the durable artifact (the in-memory run
 * result is not). Date-named files sort lexicographically, so max(name) is the newest.
 */
export function latestLintReport(vaultRoot: string): { path: string; date: string | null } | null {
  const metaDir = path.join(vaultRoot, 'wiki', 'meta')
  let files: string[]
  try {
    files = fs.readdirSync(metaDir)
  } catch {
    return null
  }
  const reports = files.filter((f) => /^lint-report-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort()
  const newest = reports[reports.length - 1]
  if (newest === undefined) return null
  const date = /^lint-report-(\d{4}-\d{2}-\d{2})\.md$/.exec(newest)?.[1] ?? null
  return { path: toPosix(path.join('wiki', 'meta', newest)), date }
}
