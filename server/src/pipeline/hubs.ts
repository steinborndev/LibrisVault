/**
 * The hub layer, written by the service (SPEC.md §12.12, decision D2 of the vault-layer work).
 *
 * WHAT CHANGED AND WHY. `wiki/index.md` was maintained by every ingest run: the prompt said
 * "link every new page from wiki/index.md", so every run opened a 514 kB file, appended to it,
 * and committed it. Four things followed from that, all measured on the working vault:
 *
 *   - the index cost roughly 128k tokens to read, against the 1000 the vault's own skill
 *     budgets for it, so in practice a run pattern-matched rather than read it;
 *   - 83 % of the wiki's entire git history is six hub files being rewritten whole - 570 kB of
 *     permanent history per ingest, for bookkeeping;
 *   - the long lock holds were all on these files, which is what made the 60 s lock window a
 *     real race rather than a theoretical one (A2);
 *   - the header counters were maintained by hand, so they drifted, and 77 of 406 validator
 *     findings were one counter being wrong on one page.
 *
 * So the service writes them instead, deterministically, from what the pages themselves say.
 * The load-bearing property is not the write guard - it is REGENERATION: the index is derived
 * from frontmatter, so an agent write to it is simply overwritten by the next run rather than
 * having to be prevented. A rule that repairs itself beats a rule that has to hold.
 *
 * `hot.md` deliberately stays with the agent. It is a semantic summary of what matters right
 * now, no generator can produce it, and a lost update there costs a cache rather than
 * knowledge.
 *
 * IDEMPOTENCE IS THE CONTRACT. Two renders of an unchanged vault produce byte-identical files.
 * That is what makes an agent write harmless, what keeps the file out of a commit when nothing
 * changed, and what stops this from becoming the churn it replaces - so nothing in here may
 * depend on the clock. `updated:` is the newest date the CONTENT carries, not today.
 */

import fs from 'node:fs'
import path from 'node:path'
import { readDomainRegistry, UNASSIGNED } from './domains.js'

/** The pages the service owns. `hot.md` is not one of them (see the header). */
export const SERVICE_OWNED_HUBS = ['wiki/index.md', 'wiki/log.md', 'wiki/overview.md'] as const

/** Buckets whose pages are knowledge rather than navigation or operations. */
/** The buckets that hold what the vault collected, as opposed to what it writes about itself. */
export const CONTENT_BUCKETS = ['concepts', 'entities', 'sources', 'comparisons', 'questions', 'references'] as const

/** Bucket -> the heading the index files it under, in the order they are rendered. */
const BUCKET_HEADINGS: ReadonlyArray<readonly [string, string]> = [
  ['concepts', 'Concepts'],
  ['entities', 'Entities'],
  ['sources', 'Sources'],
  ['comparisons', 'Comparisons'],
  ['questions', 'Questions'],
  ['references', 'References'],
]

/**
 * The `origin:` value marking the plugin's own release and demo material (task 8.7).
 *
 * 17 pages of this vault carry it: they were created before the vault started taking real
 * material AND carry the upstream community footer. They are not deleted and not hidden - they
 * are simply not this vault's knowledge, and counting them as such makes every number about
 * the vault slightly false.
 */
export const UPSTREAM_DEMO = 'upstream-demo'

/** Whether a page is the plugin's own demo material rather than this vault's knowledge. */
export const isUpstreamDemo = (page: { readonly origin: string | null }): boolean =>
  page.origin === UPSTREAM_DEMO

export interface HubPage {
  /** Vault-relative POSIX path. */
  readonly rel: string
  /** Basename without `.md`: what a wikilink resolves by, whatever the title says. */
  readonly name: string
  /** Frontmatter `title:`, or the basename when it has none. */
  readonly title: string
  /** Top-level bucket under `wiki/`. */
  readonly bucket: string
  /** Frontmatter `domain:`, or `unassigned`. */
  readonly domain: string
  /** Frontmatter `address:`, or null for a page that predates the address rollout. */
  readonly address: string | null
  /** Newest date the page states for itself, for the index's own `updated:`. */
  readonly updated: string | null
  /**
   * Frontmatter `origin:`, or null. `upstream-demo` marks the plugin's own release and demo
   * material (task 8.7): readable, reachable, and counted separately from what this vault
   * actually collected.
   */
  readonly origin: string | null
}

/** A page the walk could not read as a page. It is LISTED, never dropped - see `renderIndex`. */
export interface UnfiledPage {
  readonly rel: string
  readonly why: string
}

const toPosix = (p: string): string => p.split(path.sep).join('/')
const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '')

/** Shallow frontmatter read: the same stance as the validator and the graph, and one reason. */
function frontmatterFields(markdown: string): Map<string, string> | null {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return null
  const fields = new Map<string, string>()
  for (const m of fm[1]!.matchAll(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/gm)) {
    if (!fields.has(m[1]!)) fields.set(m[1]!, unquote(m[2]!))
  }
  return fields
}

function walk(dir: string, out: string[]): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walk(abs, out)
    else if (e.isFile() && e.name.endsWith('.md')) out.push(abs)
  }
  return out
}

/**
 * Every content page of the vault, plus the ones that could not be read as pages.
 *
 * "Could not be read" is a page with no frontmatter block, or one with no `type:`. Both are
 * LISTED rather than skipped: a generator that silently drops a page is a generator that can
 * lose knowledge, and the whole point of the index is that everything is reachable from it.
 */
export function collectPages(vaultRoot: string): { pages: HubPage[]; unfiled: UnfiledPage[]; machinery: string[] } {
  const pages: HubPage[] = []
  const unfiled: UnfiledPage[] = []
  /*
   * Everything under `wiki/` that is not a content page and not one of the hubs: the meta
   * pages, the fold pages, the bucket hubs, the onboarding page.
   *
   * They are listed because the index has to be COMPLETE. The hand-maintained one linked to
   * eight of them, and a generated index that dropped those links would lose reachability -
   * which is the one thing the rebuild is not allowed to do. Two kilobytes against ninety-two.
   */
  const machinery: string[] = []
  for (const abs of walk(path.join(vaultRoot, 'wiki'), [])) {
    const rel = toPosix(path.relative(vaultRoot, abs))
    const parts = rel.split('/')
    const name = parts[parts.length - 1]!.slice(0, -3)
    const bucket = parts.length > 2 ? parts[1]! : 'root'
    // Navigation and operational pages are what the index IS, not what it lists.
    // The hot cache is a hub too, though the agent owns it: it is in the navigation line.
    const isHub = SERVICE_OWNED_HUBS.includes(rel as (typeof SERVICE_OWNED_HUBS)[number]) || rel === 'wiki/hot.md'
    if (!CONTENT_BUCKETS.includes(bucket as (typeof CONTENT_BUCKETS)[number]) || name.startsWith('_')) {
      if (!isHub) machinery.push(rel)
      continue
    }

    let markdown: string
    try {
      markdown = fs.readFileSync(abs, 'utf8')
    } catch {
      unfiled.push({ rel, why: 'unreadable' })
      continue
    }
    const fields = frontmatterFields(markdown)
    if (fields === null) {
      unfiled.push({ rel, why: 'no frontmatter block' })
      continue
    }
    if (!fields.get('type')) {
      unfiled.push({ rel, why: 'no type: in frontmatter' })
      continue
    }
    const domain = fields.get('domain')
    const origin = fields.get('origin')
    const address = fields.get('address')
    const updated = fields.get('updated') ?? fields.get('created')
    pages.push({
      rel,
      name,
      title: fields.get('title') || name,
      bucket,
      domain: domain && domain !== '' ? domain : UNASSIGNED,
      address: address && address !== '' ? address : null,
      updated: updated && /^\d{4}-\d{2}-\d{2}/.test(updated) ? updated.slice(0, 10) : null,
      origin: origin && origin !== '' ? origin : null,
    })
  }
  return { pages, unfiled, machinery: machinery.sort() }
}

/**
 * The link a reader can actually follow.
 *
 * Written from the BASENAME, not from the title: a title the file name cannot carry (a colon,
 * a slash) produces a link that resolves to nothing, and that single mechanism accounts for the
 * largest class of dead links in this vault. The title rides along as the display text when the
 * two differ, so the catalog still reads in the page's own words.
 */
export function pageLink(page: HubPage): string {
  if (page.title === page.name || page.title === '') return `[[${page.name}]]`
  // A `|` inside a title would split the link; the vault has none, and this keeps it that way.
  return `[[${page.name}|${page.title.replace(/\|/g, '-')}]]`
}

/** Total and stable: two machines, two runs, one byte-identical file. */
function sortPages(a: HubPage, b: HubPage): number {
  return a.title.localeCompare(b.title, 'en') || a.rel.localeCompare(b.rel, 'en')
}

export interface RenderIndexOptions {
  /** Domain order; defaults to the vault's own registry, then alphabetical for the rest. */
  readonly domainOrder?: readonly string[]
}

/**
 * `wiki/index.md`, entirely from page frontmatter.
 *
 * Grouped by domain in registry order, then by type, one line per page carrying the link, the
 * type and the address. The counters in the header are COMPUTED, which is what retires the
 * whole `stale-counter` finding class - 77 of 406 warnings were a hand-maintained number that
 * had drifted.
 */
export function renderIndex(vaultRoot: string, opts: RenderIndexOptions = {}): string {
  const { pages: all, unfiled, machinery } = collectPages(vaultRoot)
  /*
   * The plugin's demo material gets its own section rather than a place in the domains (8.7).
   *
   * Not dropped: the index is the one page where "everything is here" has to stay true, and
   * 8.1 spent its whole effort getting pages-in-no-hub to zero. Not mixed in either: these
   * pages shipped with the plugin, and a reader scanning a domain should not have to know
   * which entries were never about this vault.
   */
  const pages = all.filter((p) => !isUpstreamDemo(p))
  const demo = all.filter(isUpstreamDemo)
  const registry = readDomainRegistry(vaultRoot)
  const order = opts.domainOrder ?? registry?.domains.map((d) => d.key) ?? []

  const byDomain = new Map<string, HubPage[]>()
  for (const p of pages) {
    const list = byDomain.get(p.domain)
    if (list === undefined) byDomain.set(p.domain, [p])
    else list.push(p)
  }
  // Registry order first, then anything the registry does not know, alphabetically, then the
  // unassigned bucket last - it is a waiting room, not a subject.
  const known = order.filter((k) => byDomain.has(k))
  const rest = [...byDomain.keys()].filter((k) => !order.includes(k) && k !== UNASSIGNED).sort()
  const domains = [...known, ...rest, ...(byDomain.has(UNASSIGNED) ? [UNASSIGNED] : [])]

  const byBucket = new Map<string, number>()
  for (const p of pages) byBucket.set(p.bucket, (byBucket.get(p.bucket) ?? 0) + 1)
  const counts = BUCKET_HEADINGS.filter(([b]) => byBucket.has(b))
    .map(([b, heading]) => `${byBucket.get(b)} ${heading.toLowerCase()}`)
    .join(', ')

  // Dates come from the CONTENT, never from the clock: two renders of an unchanged vault have
  // to be byte-identical or this file becomes the churn it replaces.
  const dates = pages.map((p) => p.updated).filter((d): d is string => d !== null).sort()
  const newest = dates[dates.length - 1] ?? '1970-01-01'
  const created = existingCreated(vaultRoot) ?? dates[0] ?? newest

  const out: string[] = []
  out.push('---')
  out.push('type: meta')
  out.push('domain: meta')
  out.push('title: "Wiki Index"')
  out.push(`created: ${created}`)
  out.push(`updated: ${newest}`)
  out.push('tags:')
  out.push('  - meta')
  out.push('  - index')
  out.push('status: evergreen')
  // Bounded on purpose: this list used to accumulate every page any run had ever touched, with
  // duplicates, and nothing ever read it.
  out.push('related:')
  out.push('  - "[[hot]]"')
  out.push('  - "[[log]]"')
  out.push('  - "[[overview]]"')
  out.push('---')
  out.push('')
  out.push('# Wiki Index')
  out.push('')
  out.push('Navigation: [[hot]] | [[log]] | [[overview]]')
  out.push('')
  out.push(
    'This page is generated by the ingestion service after every run that writes a page, from ' +
      'the frontmatter of the pages themselves. Edits to it are overwritten by the next run; ' +
      'what a run did belongs in [[log]], and what the vault is about belongs in [[overview]].',
  )
  out.push('')
  out.push(`**${pages.length} pages** across ${domains.length} domains: ${counts}.`)
  out.push('')

  for (const domain of domains) {
    const inDomain = byDomain.get(domain) ?? []
    out.push(`## ${domain} (${inDomain.length})`)
    out.push('')
    for (const [bucket, heading] of BUCKET_HEADINGS) {
      const group = inDomain.filter((p) => p.bucket === bucket).sort(sortPages)
      if (group.length === 0) continue
      out.push(`### ${heading}`)
      out.push('')
      for (const p of group) out.push(`- ${pageLink(p)}${p.address === null ? '' : ` \`${p.address}\``}`)
      out.push('')
    }
  }

  if (demo.length > 0) {
    out.push(`## Upstream demo material (${demo.length})`)
    out.push('')
    out.push(
      'Pages the claude-obsidian plugin shipped with, kept readable and reachable but counted ' +
        'separately: they are its release and demo material, not this vault\'s knowledge.',
    )
    out.push('')
    for (const p of [...demo].sort(sortPages)) out.push(`- ${pageLink(p)}`)
    out.push('')
  }

  if (machinery.length > 0) {
    // Last, and named for what it is: these are not knowledge, and a reader looking for the
    // vault's own pages should not have to know where they live.
    out.push(`## Vault machinery (${machinery.length})`)
    out.push('')
    out.push('The vault\'s own pages: navigation, reports, notebooks, folds.')
    out.push('')
    for (const rel of machinery) out.push(`- [[${rel.split('/').pop()!.slice(0, -3)}]]`)
    out.push('')
  }

  if (unfiled.length > 0) {
    // Never dropped. A page that cannot be read is a page that needs looking at, and the index
    // is the one place where "everything is here" has to stay true.
    out.push(`## Unfiled (${unfiled.length})`)
    out.push('')
    out.push('Pages whose frontmatter could not be read, listed so none is lost:')
    out.push('')
    for (const u of [...unfiled].sort((a, b) => a.rel.localeCompare(b.rel, 'en'))) {
      out.push(`- \`${u.rel}\` - ${u.why}`)
    }
    out.push('')
  }

  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

/** The index's own `created:`, so a regeneration does not reset the vault's own history. */
function existingCreated(vaultRoot: string): string | null {
  try {
    const fields = frontmatterFields(fs.readFileSync(path.join(vaultRoot, 'wiki', 'index.md'), 'utf8'))
    const created = fields?.get('created')
    return created && /^\d{4}-\d{2}-\d{2}/.test(created) ? created.slice(0, 10) : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------------- the log */

/**
 * How much of a run's own account of itself the log entry keeps.
 *
 * The median entry the agent wrote is 3.0 kB, and `log.md` reached 777 kB over 258 of them -
 * one third of the wiki's entire git history. The narrative is worth keeping (it is the only
 * prose record of why a run did what it did); its length is not. A run that writes an essay
 * gets the essay cut, not the entry dropped.
 */
export const LOG_NARRATIVE_CAP = 1200

/** One page as the log names it: the link a reader can follow, and its address. */
export interface LoggedPage {
  /** Vault-relative path, or the page name; either is accepted and reduced to the name. */
  readonly rel: string
  readonly address?: string | null
}

export interface LogEntryInput {
  /** `YYYY-MM-DD`. The caller's clock, so the renderer stays pure and testable. */
  readonly date: string
  /** What kind of run this was: `ingest`, `batch ingest`, `research`, `fellow`, `maintenance`. */
  readonly kind: string
  /** What it was about: the document's name, the topic, the maintenance kind. */
  readonly title: string
  /** The job's `.raw` directory or file - the provenance link, and the crash-recovery marker. */
  readonly source?: string | null
  readonly created?: readonly LoggedPage[]
  readonly updated?: readonly LoggedPage[]
  /** `done` by default; `duplicate` and `no changes` are outcomes a reader needs to see. */
  readonly outcome?: string
  /** The run's final answer, which every run already produces. No new agent contract. */
  readonly summary?: string | null
}

/** `wiki/concepts/Foo Bar.md` -> `Foo Bar`, and a bare name through unchanged. */
const pageName = (rel: string): string => {
  const base = rel.split('/').pop() ?? rel
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

const linkList = (pages: readonly LoggedPage[]): string =>
  pages.map((p) => `[[${pageName(p.rel)}]]${p.address ? ` \`${p.address}\`` : ''}`).join(', ')

/**
 * Collapses a run's final answer into one paragraph of log prose.
 *
 * Markdown headings, bullets and code fences are flattened: the answer is a report to a human,
 * the log is a record, and a run that returned six `##` sections used to put six sections into
 * `log.md`. Capped at {@link LOG_NARRATIVE_CAP} on a sentence boundary where there is one.
 */
export function narrativeOf(summary: string | null | undefined, cap = LOG_NARRATIVE_CAP): string {
  if (!summary) return ''
  const flat = summary
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (flat.length <= cap) return flat
  const cut = flat.slice(0, cap)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return `${(stop > cap * 0.6 ? cut.slice(0, stop + 1) : cut).trimEnd()} [...]`
}

/**
 * One log entry, in the shape `wiki/log.md` has always carried - `## [date] kind | title`
 * followed by a fact list and a paragraph.
 *
 * The format is now OURS rather than a skill's prose (A6 contract 1): the queue used to decide
 * whether a crashed ingest had finished by searching this file for the job's `.raw` path, which
 * made a skill's log template load-bearing for crash recovery. The `- Source:` line is kept
 * deliberately while that fallback exists (see 2.4).
 */
export function renderLogEntry(input: LogEntryInput): string {
  const created = input.created ?? []
  const updated = input.updated ?? []
  const lines: string[] = []
  lines.push(`## [${input.date}] ${input.kind} | ${input.title}`)
  lines.push('')
  if (input.source) lines.push(`- Source: \`${input.source}\``)
  lines.push(`- Pages created: ${created.length === 0 ? 'none' : linkList(created)}`)
  lines.push(`- Pages updated: ${updated.length === 0 ? 'none' : linkList(updated)}`)
  if (input.outcome && input.outcome !== 'done') lines.push(`- Outcome: ${input.outcome}`)
  const narrative = narrativeOf(input.summary)
  if (narrative !== '') {
    lines.push('')
    lines.push(narrative)
  }
  return `${lines.join('\n')}\n`
}

/** Everything above the first `## ` entry: frontmatter, title and navigation line. */
function splitLogHead(markdown: string): { head: string; entries: string } {
  const at = markdown.search(/^## /m)
  if (at < 0) return { head: markdown.replace(/\s*$/, ''), entries: '' }
  return { head: markdown.slice(0, at).replace(/\s*$/, ''), entries: markdown.slice(at) }
}

/**
 * The log with one entry prepended - newest first, which is the order the file has always had
 * and the reason only its head ever matters to a reader or to crash recovery.
 *
 * Pure: it takes the file's content and returns the new content. The caller does the writing,
 * inside the commit mutex and behind the vault's own per-file lock.
 */
export function prependLogEntry(existing: string, entry: string): string {
  const { head, entries } = splitLogHead(existing === '' ? DEFAULT_LOG_HEAD : existing)
  return `${head}\n\n${entry.trimEnd()}\n${entries === '' ? '' : `\n${entries.trimStart()}`}`
}

/** What a log looks like before it has an entry: enough frontmatter for the vault's own lint. */
export const DEFAULT_LOG_HEAD = [
  '---',
  'type: meta',
  'domain: meta',
  'title: "Operation Log"',
  'created: 1970-01-01',
  'updated: 1970-01-01',
  'tags:',
  '  - meta',
  '  - log',
  'status: evergreen',
  '---',
  '',
  '# Operation Log',
  '',
  'Navigation: [[index]] | [[hot]] | [[overview]]',
  '',
  'One entry per run, newest first, written by the ingestion service.',
].join('\n')

/* ------------------------------------------------------------------------------ the writer */

/** What a run asks the hub layer to do: log this, and regenerate the catalog. */
export interface HubPlan {
  /** The entry to prepend, or null for a run that wrote no page. */
  readonly entry: LogEntryInput | null
  /** Whether to regenerate `wiki/index.md`. False for a run that changed no page. */
  readonly index: boolean
  /** Bucket hubs whose page list this run may refresh: the ones whose lock it holds. */
  readonly buckets?: readonly string[]
}

export interface HubWriteResult {
  /** Vault-relative paths actually written, for the caller's commit pathspec. */
  readonly paths: string[]
  /** Non-fatal problems, one line each: the caller logs them against the job. */
  readonly warnings: string[]
}

/**
 * Writes the hubs this run's plan asks for, and returns what it wrote.
 *
 * MUST be called with the vault's own per-file lock on the hubs already held, and inside the
 * commit mutex - foreign-then-ours, the order hard rule 1 states. The caller does both,
 * because the commit that follows belongs to the caller.
 *
 * Nothing here throws. A hub write that fails leaves the run `done` with a warning: the pages
 * are what matters, and the next run regenerates the index anyway, which is the safety net a
 * generated file gives us that a maintained one never did.
 *
 * A write is SKIPPED when the rendered bytes match what is on disk. That is not an
 * optimisation - it is what keeps an unchanged index out of the commit, which is the whole
 * difference between this and the churn it replaces.
 */
export function writeHubs(vaultRoot: string, plan: HubPlan): HubWriteResult {
  const paths: string[] = []
  const warnings: string[] = []

  if (plan.index) {
    try {
      const abs = path.join(vaultRoot, 'wiki', 'index.md')
      const next = renderIndex(vaultRoot)
      let current = ''
      try {
        current = fs.readFileSync(abs, 'utf8')
      } catch {
        /* no index yet: writing one IS the change */
      }
      if (next !== current) {
        fs.writeFileSync(abs, next)
        paths.push('wiki/index.md')
      }
    } catch (err) {
      warnings.push(`hub write: the index could not be regenerated (${(err as Error).message})`)
    }
  }

  if (plan.index) {
    // The overview's counters ride with the index: same pass over the same pages, and the
    // drift they used to have was the same drift.
    try {
      const abs = path.join(vaultRoot, 'wiki', 'overview.md')
      let current = ''
      try {
        current = fs.readFileSync(abs, 'utf8')
      } catch {
        /* no overview: one is created with the block under its own heading */
      }
      const next = updateOverview(current, renderOverviewCounters(vaultRoot))
      if (next !== current) {
        fs.writeFileSync(abs, next)
        paths.push('wiki/overview.md')
      }
    } catch (err) {
      warnings.push(`hub write: the overview counters could not be refreshed (${(err as Error).message})`)
    }
  }

  if (plan.index) {
    for (const rel of plan.buckets ?? []) {
      const bucket = rel.split('/')[1] ?? ''
      try {
        const abs = path.join(vaultRoot, rel)
        let current = ''
        try {
          current = fs.readFileSync(abs, 'utf8')
        } catch {
          /* a bucket without a hub yet gets one with its page list */
        }
        const next = updateBucketHub(current, renderBucketPages(vaultRoot, bucket), bucket)
        if (next !== current) {
          fs.writeFileSync(abs, next)
          paths.push(rel)
        }
      } catch (err) {
        warnings.push(`hub write: ${rel} could not be refreshed (${(err as Error).message})`)
      }
    }
  }

  if (plan.entry !== null) {
    try {
      const abs = path.join(vaultRoot, 'wiki', 'log.md')
      let current = ''
      try {
        current = fs.readFileSync(abs, 'utf8')
      } catch {
        /* no log yet: prependLogEntry writes the head itself */
      }
      fs.writeFileSync(abs, prependLogEntry(current, renderLogEntry(plan.entry)))
      paths.push('wiki/log.md')
    } catch (err) {
      warnings.push(`hub write: the log entry could not be written (${(err as Error).message})`)
    }
  }

  return { paths, warnings }
}

/**
 * Splits a commit's pathspec into the pages a log entry should name.
 *
 * `untracked` and `modified` come from git's own view of the working tree, so a page the run
 * wrote through Bash is classified correctly and a page it merely read is not named at all.
 * Hub files are excluded: an entry that said it updated the index and the log on every run is
 * how the old entries grew a line nobody could learn anything from.
 */
export function classifyLoggedPages(
  pathspec: readonly string[],
  git: { readonly untracked: readonly string[]; readonly modified: readonly string[] },
  addresses: ReadonlyMap<string, string> = new Map(),
): { created: LoggedPage[]; updated: LoggedPage[] } {
  const inCommit = new Set(pathspec)
  const isContent = (p: string): boolean =>
    p.startsWith('wiki/') &&
    p.endsWith('.md') &&
    !SERVICE_OWNED_HUBS.includes(p as (typeof SERVICE_OWNED_HUBS)[number]) &&
    p !== 'wiki/hot.md' &&
    !p.endsWith('/_index.md')
  const pick = (list: readonly string[]): LoggedPage[] =>
    list
      .filter((p) => inCommit.has(p) && isContent(p))
      .sort()
      .map((rel) => ({ rel, address: addresses.get(rel) ?? null }))
  return { created: pick(git.untracked), updated: pick(git.modified) }
}

/** `address:` for each of the given pages, read from the pages themselves. */
export function readAddresses(vaultRoot: string, rels: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const rel of rels) {
    try {
      const address = frontmatterFields(fs.readFileSync(path.join(vaultRoot, rel), 'utf8'))?.get('address')
      if (address) out.set(rel, address)
    } catch {
      /* a page that vanished between the status call and this read names no address */
    }
  }
  return out
}

/* --------------------------------------------------------------------------- the overview */

/**
 * The generated region of `wiki/overview.md`.
 *
 * `overview.md` is not generated whole, and deliberately so: it carries what the vault is FOR,
 * which is the user's to write and no generator's to produce. What the service owns is the
 * block between these markers - the counters that were maintained by hand and drifted
 * (`stale-counter` was 77 of 406 validator findings, and the header on this page claimed 487
 * pages against a real 805).
 *
 * Same idempotence rule as the index: no clock, so two renders of an unchanged vault produce
 * identical bytes and the file stays out of the commit.
 */
export const OVERVIEW_MARKER_START = '<!-- vault-service:counters -->'
export const OVERVIEW_MARKER_END = '<!-- /vault-service:counters -->'

/** The counters block, markers included, ready to be spliced into the page. */
export function renderOverviewCounters(vaultRoot: string): string {
  const { pages: all, unfiled } = collectPages(vaultRoot)
  // What this vault collected, which is the number the page is asking for (8.7).
  const pages = all.filter((p) => !isUpstreamDemo(p))
  const demo = all.length - pages.length
  const byBucket = new Map<string, number>()
  for (const p of pages) byBucket.set(p.bucket, (byBucket.get(p.bucket) ?? 0) + 1)
  const domains = new Set(pages.map((p) => p.domain))
  const dates = pages.map((p) => p.updated).filter((d): d is string => d !== null).sort()
  const newest = dates[dates.length - 1] ?? 'not recorded'

  const lines = [OVERVIEW_MARKER_START, '']
  lines.push(`- Pages: ${pages.length} across ${domains.size} domains`)
  for (const [bucket, heading] of BUCKET_HEADINGS) {
    const n = byBucket.get(bucket)
    if (n !== undefined) lines.push(`- ${heading}: ${n}`)
  }
  if (demo > 0) lines.push(`- Upstream demo pages, not counted above: ${demo} (listed in [[index]])`)
  if (unfiled.length > 0) lines.push(`- Pages the generator could not read: ${unfiled.length} (listed in [[index]])`)
  lines.push(`- Newest page date: ${newest}`)
  lines.push('')
  lines.push('These counts are written by the ingestion service after every run; the prose around them is not.')
  lines.push('')
  lines.push(OVERVIEW_MARKER_END)
  return lines.join('\n')
}

/**
 * Splices a generated block into a hand-owned page, leaving every other byte alone.
 *
 * A page without the markers gets them once, appended under their own heading, and nothing
 * above is touched - the hand-written prose of a vault that has been running for months is
 * exactly what a generator must not rewrite.
 */
function spliceBlock(existing: string, block: string, start: string, end: string, heading: string, fallbackTitle: string): string {
  const from = existing.indexOf(start)
  const to = existing.indexOf(end)
  if (from >= 0 && to > from) {
    return existing.slice(0, from) + block + existing.slice(to + end.length)
  }
  const head = existing.replace(/\s*$/, '')
  return `${head === '' ? `# ${fallbackTitle}` : head}\n\n## ${heading}\n\n${block}\n`
}

/** The counters block into `wiki/overview.md`. */
export function updateOverview(existing: string, block: string): string {
  return spliceBlock(existing, block, OVERVIEW_MARKER_START, OVERVIEW_MARKER_END, 'Vault counters', 'Wiki Overview')
}

/* ------------------------------------------------------------------------ the bucket hubs */

/**
 * The generated region of a bucket's `_index.md`.
 *
 * These hubs are NOT generated whole, and that is the difference from `index.md`: they carry a
 * curated one-line description per page, written by the runs that filed those pages, and no
 * generator can produce that. What the service owns is the complete page LIST between the
 * markers, so the answer to "is every page of this bucket reachable" stops depending on whether
 * a run remembered to add its entry. The prose sections around it stay the agent's.
 *
 * What the generated region deliberately does NOT carry: dated event sections. 131 of the 135
 * `##` headings in one bucket hub were "(new sub-area, <date>)" entries - a second changelog
 * beside `log.md`, in a file whose job is navigation.
 */
export const BUCKET_MARKER_START = '<!-- vault-service:pages -->'
export const BUCKET_MARKER_END = '<!-- /vault-service:pages -->'

/** Every bucket that has a hub page, vault-relative. */
export function bucketHubs(vaultRoot: string): string[] {
  return CONTENT_BUCKETS.map((b) => `wiki/${b}/_index.md`).filter((rel) =>
    fs.existsSync(path.join(vaultRoot, rel)),
  )
}

/** The page list for one bucket, markers included. */
export function renderBucketPages(vaultRoot: string, bucket: string): string {
  const pages = collectPages(vaultRoot).pages.filter((p) => p.bucket === bucket).sort(sortPages)
  const lines = [BUCKET_MARKER_START, '']
  lines.push(`Every page in this bucket (${pages.length}), written by the ingestion service:`)
  lines.push('')
  for (const p of pages) lines.push(`- ${pageLink(p)}${p.address === null ? '' : ` \`${p.address}\``}`)
  lines.push('')
  lines.push(BUCKET_MARKER_END)
  return lines.join('\n')
}

/**
 * The page list into one bucket hub, leaving its curated prose alone.
 *
 * A hub with no markers is left UNTOUCHED unless `create` is passed, and that asymmetry is
 * deliberate. Measured on the working vault: inserting a complete page list into hubs that
 * still carry their 131 dated event sections would take `concepts/_index.md` from 154 kB to
 * 188 kB - bigger, not smaller, which is the opposite of what this work is for. Those sections
 * go in the one-off repair (phase 8.1), and that pass is what inserts the markers. Afterwards
 * every run keeps the region between them current, automatically.
 *
 * So the rule is exactly the contract: the service owns the region between the markers. No
 * markers, no region, nothing written.
 */
export function updateBucketHub(existing: string, block: string, bucket: string, opts: { create?: boolean } = {}): string {
  const hasMarkers = existing.includes(BUCKET_MARKER_START) && existing.includes(BUCKET_MARKER_END)
  if (!hasMarkers && opts.create !== true) return existing
  const title = `${bucket.charAt(0).toUpperCase()}${bucket.slice(1)} Index`
  return spliceBlock(existing, block, BUCKET_MARKER_START, BUCKET_MARKER_END, 'All pages', title)
}
