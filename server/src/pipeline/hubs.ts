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
const CONTENT_BUCKETS = ['concepts', 'entities', 'sources', 'comparisons', 'questions', 'references'] as const

/** Bucket -> the heading the index files it under, in the order they are rendered. */
const BUCKET_HEADINGS: ReadonlyArray<readonly [string, string]> = [
  ['concepts', 'Concepts'],
  ['entities', 'Entities'],
  ['sources', 'Sources'],
  ['comparisons', 'Comparisons'],
  ['questions', 'Questions'],
  ['references', 'References'],
]

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
export function collectPages(vaultRoot: string): { pages: HubPage[]; unfiled: UnfiledPage[] } {
  const pages: HubPage[] = []
  const unfiled: UnfiledPage[] = []
  for (const abs of walk(path.join(vaultRoot, 'wiki'), [])) {
    const rel = toPosix(path.relative(vaultRoot, abs))
    const parts = rel.split('/')
    const name = parts[parts.length - 1]!.slice(0, -3)
    const bucket = parts.length > 2 ? parts[1]! : 'root'
    // Navigation and operational pages are what the index IS, not what it lists.
    if (!CONTENT_BUCKETS.includes(bucket as (typeof CONTENT_BUCKETS)[number])) continue
    if (name.startsWith('_')) continue

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
    })
  }
  return { pages, unfiled }
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
  const { pages, unfiled } = collectPages(vaultRoot)
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
