#!/usr/bin/env node
/**
 * Read-only measurement harness for the vault layer.
 *
 *   node scripts/vault-audit.mjs ~/vault              # grouped, human readable
 *   node scripts/vault-audit.mjs ~/vault --json       # the same numbers as JSON
 *   node scripts/vault-audit.mjs ~/vault --json --redact   # numbers only, safe to commit
 *
 * WHY THIS EXISTS. Every definition of done in docs/tasks/TASKS-VAULT-LAYER.md is a number:
 * "the rule reports zero", "the index is under 200 kB", "type mirroring at or near 0 %". A
 * number that was produced by a one-off shell pipeline in one session cannot be compared
 * against the same number six phases later, because the pipeline is gone. So the measurement
 * is a committed script, it runs against a vault path given as an argument, and two runs of it
 * are diffable.
 *
 * WHY IT REIMPLEMENTS WHAT THE VALIDATOR ALREADY KNOWS. A harness that imports the code it
 * measures cannot see a defect the code shares: both would classify a link the same wrong way
 * and agree. The frontmatter reader, the link resolver and the address rules here are
 * deliberately a second implementation of `server/src/pipeline/validator.ts`, written from the
 * same vault, and a disagreement between the two is a finding rather than a bug in this file.
 *
 * WHAT IT NEVER DOES. It writes nothing, anywhere, ever - not even into the vault's own derived
 * directories. It shells out to `git` only with read-only subcommands. The `--redact` mode
 * drops every path, title, tag and domain from the output, which is the only mode whose output
 * may be committed to this PUBLIC repo (CLAUDE.md hard rule 7).
 *
 * METHOD NOTES, because a number here differs from a number measured by hand only by method:
 *   - "page" is any `wiki/**\/*.md`. "content page" excludes the hubs, `_index.md`, `wiki/meta/`
 *     and `wiki/folds/`.
 *   - "knowledge-adding commit" is a vault commit whose subject starts with ingest, fellow,
 *     research-expand or expand: the run kinds that write knowledge. Maintenance, recap,
 *     reading-list, domain and repair commits are not.
 *   - the multi-commit rate counts pages that EXIST now; `pathsWithHistory` additionally
 *     reports paths that history knows and the working tree no longer has, which is the
 *     denominator a by-hand `git log` walk produces.
 *   - "now" for the freshness share is `--now YYYY-MM-DD`, defaulting to today, and it is
 *     recorded in the output so a re-run can reproduce the share exactly.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, sep, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ vocabulary and structure */

/** Buckets whose pages are knowledge rather than navigation or operations. */
export const CONTENT_BUCKETS = ['concepts', 'entities', 'sources', 'questions', 'comparisons', 'references']

/** The pages the service takes over in phase 2 (D2); `hot.md` stays with the agent. */
export const HUB_FILES = ['wiki/index.md', 'wiki/log.md', 'wiki/overview.md', 'wiki/hot.md']

/**
 * Run-protocol headings: what a RUN did, sitting inside the article it wrote (B5). Assessment
 * and Open Questions are measured with them but belong on the page - assessment is source
 * criticism, and the open questions are what the standing agents plan from.
 */
export const RUN_PROTOCOL_HEADINGS = [
  ['openQuestions', /^open questions?\b/],
  ['editorialNote', /^editorial note/],
  ['provenance', /^provenance/],
  ['assessment', /^assessment/],
  ['statusOfThisPage', /^status of this page/],
  ['relationToVault', /^relation(?:ship)? to (?:this )?vault/],
  ['vaultContext', /^vault context/],
  ['entityNotability', /^entity notability/],
  ['automatedDecisions', /^automated decisions?/],
]

/** Frontmatter `type:` values the redacted output may name; anything else becomes "other". */
const KNOWN_TYPES = new Set([
  'concept', 'entity', 'source', 'reference', 'comparison', 'question', 'synthesis', 'decision',
  'meta', 'index', 'log', 'fold', 'recap', 'notebook', 'reading-list',
])

/** Same for `status:`; the tail of one-off values is what the vocabulary check in 7.3 is for. */
const KNOWN_STATUS = new Set(['seed', 'developing', 'mature', 'evergreen', 'stub', 'draft', 'archived'])

/* ---------------------------------------------------------------------------- small readers */

const unquote = (s) => s.trim().replace(/^["']|["']$/g, '')
const toPosix = (p) => p.split(sep).join('/')

/**
 * Shallow frontmatter reader, same stance as the service's: the vault's frontmatter is
 * agent-written and flat, and a YAML library would disagree with the code under measurement.
 * List values are returned in file order WITHOUT deduping, because a duplicate entry in the
 * hubs' `related:` is itself one of the things being counted.
 */
export function parseFrontmatter(markdown) {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { present: false, fields: new Map(), lists: new Map() }
  const body = m[1]
  const fields = new Map()
  for (const f of body.matchAll(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/gm)) {
    if (!fields.has(f[1])) fields.set(f[1], unquote(f[2]))
  }
  const lists = new Map()
  for (const key of ['tags', 'aliases', 'related', 'sources']) lists.set(key, parseFmList(body, key))
  return { present: true, fields, lists }
}

function parseFmList(body, key) {
  const out = []
  const block = body.match(new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]+-[ \\t]*.*\\r?\\n?)+)`, 'm'))
  if (block) {
    for (const line of block[1].split(/\r?\n/)) {
      const item = line.match(/^[ \t]+-[ \t]*(.+)$/)
      if (item) out.push(unquote(item[1]))
    }
    return out
  }
  const inline = body.match(new RegExp(`^${key}:[ \\t]*\\[([^\\]]*)\\]`, 'm'))
  if (inline) {
    for (const item of inline[1].split(',')) {
      const t = unquote(item)
      if (t) out.push(t)
    }
  }
  return out
}

/**
 * Wikilink targets in file order, embeds included, alias and heading suffixes removed.
 *
 * Unlike the service's parser this does NOT strip code first, and the difference is the point:
 * the service asks "which pages does this text link to", where a `[[...]]` inside a Python
 * literal is a false positive. The harness asks "how many links does this vault carry and how
 * many of them go nowhere", and a link quoted in a lint report is one a reader can still click.
 * It is also what makes this number comparable to the by-hand measurement (25,711 against
 * 25,712); stripping code first moves every count in this section.
 */
export function parseWikilinks(text) {
  const out = []
  for (const m of text.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
    const target = m[1].replace(/\\\|/g, '|').split('|')[0].split('#')[0].trim()
    if (target !== '') out.push(target)
  }
  return out
}

/** Links whose brackets span a line break: they name a page that exists and resolve to nothing. */
export function findWrappedLinks(markdown) {
  const out = []
  for (const m of markdown.matchAll(/\[\[([^[\]]*\n[^[\]]*)\]\]/g)) {
    const target = m[1]
      .split('\n')
      .map((line, i) => (i === 0 ? line : line.replace(/^\s*(?:>\s*)*(?:[-*+]\s+)?/, '')))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (target !== '') out.push(target)
  }
  return out
}

/* ------------------------------------------------------------------------------- classifiers */

/**
 * Why a dead link is dead, by the shape of the target it names (B3).
 *
 * The three mechanical classes are the ones a repair can fix without judgement, and each has a
 * single cause: a `:` or `/` in a page title survives in `title:` and is replaced in the file
 * name, so every link written from the title dies; a trailing backslash is a line-wrap escape
 * that ended up inside the brackets. Everything else is a page that was never written or was
 * deleted, and that is a judgement call, not a repair.
 */
export function classifyDeadLink(target) {
  if (/\\\s*$/.test(target)) return 'trailing-backslash'
  if (target.includes(':')) return 'colon'
  if (target.includes('/')) return 'slash'
  return 'other'
}

/**
 * Whether a page's tags mirror its own `type:` or `domain:` (B6). Both are already in the
 * frontmatter, so the tag carries no information and costs a tag-namespace entry; the vault's
 * rule bans the domain form absolutely and hedges the type form, and the hedge is visible in
 * the measurement - type mirroring runs above 80 %, domain mirroring at 0 to 2 %.
 *
 * A mirror is an exact match after normalisation, or a singular/plural variant of one. It is
 * deliberately NOT a synonym search: "which words mean the same as this domain" is a judgement
 * the harness must not make silently.
 */
export function tagMirroring(fmType, fmDomain, tags) {
  const norm = (s) => String(s ?? '').toLowerCase().trim().replace(/[\s_]+/g, '-')
  const singular = (s) => (s.length > 3 && s.endsWith('s') ? s.slice(0, -1) : s)
  const key = (s) => singular(norm(s))
  const typeKey = fmType ? key(fmType) : null
  const domainKey = fmDomain ? key(fmDomain) : null
  const tagKeys = tags.map(key)
  return {
    type: typeKey !== null && tagKeys.includes(typeKey),
    domain: domainKey !== null && tagKeys.includes(domainKey),
  }
}

/**
 * The address map's two directions (N1). The validator only ever walked the map and asked
 * whether each entry still resolves; nothing ever walked the pages and asked whether each has
 * an entry, which is why 23 % of the map could go missing unnoticed.
 *
 * `pages` is [{ rel, address }] for every page carrying an `address:`, `map` is the manifest's
 * `address_map`, `sources` its `sources` object, `rawDirs` the job directories on disk and
 * `pageExists` answers for a path the map names.
 */
export function addressIntegrity({ pages, map, sources, rawDirs, pageExists }) {
  const mapped = new Map(Object.entries(map ?? {}).filter(([, v]) => typeof v === 'string'))
  const byAddress = new Map()
  const missingFromMap = []
  for (const p of pages) {
    if (!mapped.has(p.rel)) missingFromMap.push(p.rel)
    const holders = byAddress.get(p.address)
    if (holders === undefined) byAddress.set(p.address, [p.rel])
    else holders.push(p.rel)
  }

  const staleMapEntries = []
  const divergent = []
  for (const [rel, addr] of mapped) {
    if (!pageExists(rel)) {
      staleMapEntries.push(rel)
      continue
    }
    const onPage = pages.find((p) => p.rel === rel)
    if (onPage !== undefined && onPage.address !== addr) divergent.push(rel)
  }

  // A job directory that produced pages but is named nowhere in `sources`: the source index and
  // the dedupe lookup are both blind to whatever that document produced.
  const named = new Set()
  for (const key of Object.keys(sources ?? {})) {
    const parts = key.split('/')
    if (parts[0] === '.raw' && parts.length > 1) named.add(parts[1])
  }
  const orphanRawDirs = rawDirs.filter((d) => !named.has(d))

  const danglingPagesCreated = []
  for (const [key, entry] of Object.entries(sources ?? {})) {
    for (const page of entry?.pages_created ?? []) {
      if (!pageExists(page)) danglingPagesCreated.push({ source: key, page })
    }
  }

  const duplicates = [...byAddress.entries()].filter(([, holders]) => holders.length > 1)
  const numeric = pages.map((p) => Number(/^[cl]-(\d+)$/.exec(p.address)?.[1] ?? NaN)).filter((n) => !Number.isNaN(n))
  return {
    pagesWithAddress: pages.length,
    mapEntries: mapped.size,
    missingFromMap,
    staleMapEntries,
    divergent,
    duplicates,
    orphanRawDirs,
    danglingPagesCreated,
    maxAddress: numeric.length > 0 ? Math.max(...numeric) : null,
  }
}

/* ------------------------------------------------------------------------------ vault loading */

function walkFiles(dir, predicate, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) walkFiles(abs, predicate, out)
    else if (e.isFile() && predicate(e.name)) out.push(abs)
  }
  return out
}

/** Every `wiki/**\/*.md`, read once, with everything the measurements need attached. */
export function loadPages(vaultRoot) {
  const wikiRoot = join(vaultRoot, 'wiki')
  return walkFiles(wikiRoot, (n) => n.endsWith('.md')).map((abs) => {
    const text = readFileSync(abs, 'utf8')
    const rel = toPosix(abs.slice(vaultRoot.length + 1))
    const parts = rel.split('/')
    const fm = parseFrontmatter(text)
    return {
      rel,
      abs,
      name: parts[parts.length - 1],
      bucket: parts.length > 2 ? parts[1] : 'root',
      bytes: Buffer.byteLength(text, 'utf8'),
      text,
      fm,
      isHub: HUB_FILES.includes(rel) || parts[parts.length - 1] === '_index.md',
      isContent:
        parts.length > 2 &&
        CONTENT_BUCKETS.includes(parts[1]) &&
        !parts[parts.length - 1].startsWith('_'),
    }
  })
}

/**
 * Name index for link resolution, in two strengths, because "is this link dead" has two honest
 * answers and they differ by 60 links.
 *
 *   'obsidian' - file basenames (with and without extension) and frontmatter `aliases:`. This
 *     is what a reader clicking a link in Obsidian gets, and it is the view the title-vs-
 *     filename class (B3) is measured in: a page titled `Foo: Bar` files as `Foo - Bar`, so
 *     every link written from its title lands nowhere however well the service resolves it.
 *   'service' - the same plus frontmatter `title:`, mirroring validator.ts and graph.ts. This
 *     is what our own dead-link findings count, and why a link can be live in the dashboard's
 *     graph and dead in the vault the user actually reads.
 *
 * The gap between the two is not noise, it is the repair backlog phase 8.2 works through.
 */
function buildNameIndex(vaultRoot, pages, strength) {
  const index = new Map()
  const add = (key, rel) => {
    const k = key.toLowerCase()
    if (!index.has(k)) index.set(k, rel)
  }
  for (const abs of walkFiles(vaultRoot, () => true)) {
    const rel = toPosix(abs.slice(vaultRoot.length + 1))
    const name = rel.split('/').pop()
    add(name, rel)
    const stem = name.replace(/\.[^.]+$/, '')
    if (stem !== '') add(stem, rel)
  }
  for (const p of pages) {
    for (const alias of p.fm.lists.get('aliases') ?? []) add(alias, p.rel)
    const title = p.fm.fields.get('title')
    if (strength === 'service' && title) add(title, p.rel)
  }
  return index
}

/**
 * One link target to the page it names, or null. Path-shaped targets are tried as written,
 * with `.md`, and wiki-relative (the vault's own `[[concepts/_index]]` navigation style), then
 * by basename - the same ladder the service climbs.
 */
function resolveLink(vaultRoot, index, target) {
  if (target.includes('/')) {
    for (const cand of [target, `${target}.md`, `wiki/${target}`, `wiki/${target}.md`]) {
      const abs = resolve(vaultRoot, cand)
      if (abs.startsWith(vaultRoot + sep) && existsSync(abs)) return toPosix(abs.slice(vaultRoot.length + 1))
    }
    const base = target.split('/').filter(Boolean).pop() ?? ''
    return base !== '' ? (index.get(base.toLowerCase()) ?? null) : null
  }
  return index.get(target.toLowerCase()) ?? null
}

/** Append-only records and reports legitimately name pages that are gone (validator policy). */
const skipLinkCheck = (rel) =>
  /^wiki\/meta\/lint-report-.*\.md$/.test(rel) ||
  rel === 'wiki/log.md' ||
  rel === 'wiki/hot.md' ||
  // The log's monthly archives (task 8.8) are the log, moved. Without this the archiving run
  // looks like it created dead links, when all it did was move where the old ones are written.
  /^wiki\/folds\/log-\d{4}-\d{2}\.md$/.test(rel)

/* -------------------------------------------------------------------------------- the report */

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)
const month = (d) => (typeof d === 'string' && /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : 'unknown')
const tally = (list) => {
  const m = new Map()
  for (const k of list) m.set(k, (m.get(k) ?? 0) + 1)
  return m
}
const sortedEntries = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
const asObject = (m) => Object.fromEntries(sortedEntries(m))

/** Headings as [{ level, title, start, end }], so a section's byte volume is measurable. */
function sections(text) {
  const heads = [...text.matchAll(/^(#{1,6}) +(.*)$/gm)]
  return heads.map((h, i) => ({
    level: h[1].length,
    title: h[2].trim(),
    start: h.index,
    headEnd: h.index + h[0].length,
    end: i + 1 < heads.length ? heads[i + 1].index : text.length,
  }))
}

function measurePages(pages, now) {
  const content = pages.filter((p) => p.isContent)
  const byBucket = tally(pages.filter((p) => p.isContent).map((p) => p.bucket))
  const byType = tally(pages.map((p) => p.fm.fields.get('type') ?? '(none)'))

  // Sources cited per page, by type: the vault's central defect is one document, one page.
  const sourcesByType = new Map()
  for (const p of content) {
    const type = p.fm.fields.get('type') ?? '(none)'
    const n = (p.fm.lists.get('sources') ?? []).length
    const slot = sourcesByType.get(type) ?? { total: 0, none: 0, one: 0, many: 0 }
    slot.total++
    if (n === 0) slot.none++
    else if (n === 1) slot.one++
    else slot.many++
    sourcesByType.set(type, slot)
  }

  /*
   * The same measurement sliced by WHEN the page was created (3.3). The vault's central defect
   * is one document one page, and the only way to see whether a change to the ingest prompt
   * moved it is to compare the pages written after the change against the ones before it.
   */
  const sourcesByMonth = new Map()
  for (const p of content) {
    const m = month(p.fm.fields.get('created'))
    const n = (p.fm.lists.get('sources') ?? []).length
    const slot = sourcesByMonth.get(m) ?? { pages: 0, none: 0, one: 0, many: 0 }
    slot.pages++
    if (n === 0) slot.none++
    else if (n === 1) slot.one++
    else slot.many++
    sourcesByMonth.set(m, slot)
  }

  const created = tally(content.map((p) => month(p.fm.fields.get('created'))))
  const updated = tally(pages.map((p) => month(p.fm.fields.get('updated'))))
  const status = tally(pages.map((p) => (p.fm.fields.get('status') ?? '(none)').toLowerCase()))

  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - 30)
  const fresh = pages.filter((p) => {
    const u = p.fm.fields.get('updated')
    return typeof u === 'string' && /^\d{4}-\d{2}-\d{2}/.test(u) && new Date(u.slice(0, 10)) >= cutoff
  }).length

  return {
    total: pages.length,
    content: content.length,
    byBucket: asObject(byBucket),
    byType: asObject(byType),
    sourcesByType: Object.fromEntries(
      [...sourcesByType.entries()].map(([t, s]) => [t, { ...s, singleSourceShare: pct(s.one, s.total) }]),
    ),
    createdByMonth: asObject(created),
    sourcesByMonth: Object.fromEntries(
      [...sourcesByMonth.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([m, v]) => [m, { ...v, singleSourceShare: pct(v.one, v.pages) }]),
    ),
    updatedByMonth: asObject(updated),
    status: asObject(status),
    freshness: { now, within30Days: fresh, share: pct(fresh, pages.length) },
  }
}

function measureHubs(pages) {
  const out = []
  for (const p of pages.filter((x) => x.isHub)) {
    const lines = p.text.split('\n')
    const heads = sections(p.text).filter((s) => s.level === 2)
    // A hub section that ends in a parenthesised date is a changelog entry, not a catalog
    // heading: this is the second event log that grew beside log.md.
    const dated = heads.filter((s) => /\(\s*[^()]*\d{4}-\d{2}-\d{2}\s*\)\s*$/.test(s.title)).length
    const related = p.fm.lists.get('related') ?? []
    out.push({
      path: p.rel,
      bytes: p.bytes,
      lines: lines.length,
      longestLine: lines.reduce((max, l) => Math.max(max, l.length), 0),
      sections: heads.length,
      datedSections: dated,
      relatedEntries: related.length,
      relatedDuplicates: related.length - new Set(related).size,
    })
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}

function measureLinks(vaultRoot, pages) {
  const asObsidian = buildNameIndex(vaultRoot, pages, 'obsidian')
  const asService = buildNameIndex(vaultRoot, pages, 'service')
  let total = 0
  let wrapped = 0
  const dead = []
  let deadForService = 0
  for (const p of pages) {
    for (const t of findWrappedLinks(p.text)) {
      if (resolveLink(vaultRoot, asService, t) !== null) wrapped++
    }
    for (const t of parseWikilinks(p.text)) {
      total++
      if (resolveLink(vaultRoot, asService, t) === null) deadForService++
      if (resolveLink(vaultRoot, asObsidian, t) !== null) continue
      dead.push({ path: p.rel, target: t, cause: classifyDeadLink(t) })
    }
  }
  const outsideRecords = dead.filter((d) => !skipLinkCheck(d.path))
  return {
    total,
    wrapped,
    dead: {
      occurrences: dead.length,
      distinctTargets: new Set(dead.map((d) => d.target.toLowerCase())).size,
      occurrencesOutsideRecords: outsideRecords.length,
      byCause: asObject(tally(dead.map((d) => d.cause))),
      byCauseOutsideRecords: asObject(tally(outsideRecords.map((d) => d.cause))),
      asTheServiceResolves: deadForService,
      worstPages: sortedEntries(tally(dead.map((d) => d.path)))
        .slice(0, 5)
        .map(([path, count]) => ({ path, count })),
    },
  }
}

function measureHeadings(pages) {
  const byType = new Map()
  for (const p of pages.filter((x) => x.isContent)) {
    const type = p.fm.fields.get('type') ?? '(none)'
    const slot = byType.get(type) ?? { pages: 0, counts: new Map() }
    slot.pages++
    for (const h of new Set(sections(p.text).filter((s) => s.level === 2).map((s) => s.title))) {
      slot.counts.set(h, (slot.counts.get(h) ?? 0) + 1)
    }
    byType.set(type, slot)
  }
  return Object.fromEntries(
    [...byType.entries()].map(([type, slot]) => {
      const best = sortedEntries(slot.counts)[0]
      return [
        type,
        {
          pages: slot.pages,
          distinctHeadings: slot.counts.size,
          bestShared: best ? { heading: best[0], pages: best[1], share: pct(best[1], slot.pages) } : null,
          top: sortedEntries(slot.counts)
            .slice(0, 8)
            .map(([heading, n]) => ({ heading, pages: n, share: pct(n, slot.pages) })),
        },
      ]
    }),
  )
}

function measureRunProtocol(pages) {
  const byHeading = new Map()
  const bytesByHeading = new Map()
  const carrying = new Set()
  let bytes = 0
  for (const p of pages.filter((x) => x.isContent)) {
    for (const s of sections(p.text)) {
      if (s.level > 3) continue
      const lower = s.title.toLowerCase()
      const hit = RUN_PROTOCOL_HEADINGS.find(([, re]) => re.test(lower))
      if (!hit) continue
      const [key] = hit
      byHeading.set(key, (byHeading.get(key) ?? 0) + 1)
      const size = Buffer.byteLength(p.text.slice(s.start, s.end), 'utf8')
      bytesByHeading.set(key, (bytesByHeading.get(key) ?? 0) + size)
      bytes += size
      carrying.add(p.rel)
    }
  }
  return {
    pagesCarrying: carrying.size,
    bytes,
    byHeading: asObject(byHeading),
    bytesByHeading: asObject(bytesByHeading),
  }
}

function measureTags(pages) {
  // The tag namespace is vault-wide - a meta page's tag competes for the same name - so the
  // counts cover every page. Mirroring is a property of a knowledge page's own frontmatter and
  // is measured over content pages only.
  const assignments = []
  for (const p of pages) for (const t of p.fm.lists.get('tags') ?? []) assignments.push(t.toLowerCase())

  const mirrorByMonth = new Map()
  for (const p of pages.filter((x) => x.isContent)) {
    const tags = p.fm.lists.get('tags') ?? []
    const m = month(p.fm.fields.get('created'))
    const slot = mirrorByMonth.get(m) ?? { pages: 0, type: 0, domain: 0 }
    slot.pages++
    const mirror = tagMirroring(p.fm.fields.get('type'), p.fm.fields.get('domain'), tags)
    if (mirror.type) slot.type++
    if (mirror.domain) slot.domain++
    mirrorByMonth.set(m, slot)
  }
  const counts = tally(assignments)
  const singleUse = [...counts.values()].filter((n) => n === 1).length
  return {
    assignments: assignments.length,
    distinct: counts.size,
    singleUse,
    singleUseShare: pct(singleUse, counts.size),
    top: sortedEntries(counts)
      .slice(0, 10)
      .map(([tag, n]) => ({ tag, pages: n })),
    mirroringByMonth: Object.fromEntries(
      [...mirrorByMonth.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([m, s]) => [m, { pages: s.pages, type: pct(s.type, s.pages), domain: pct(s.domain, s.pages) }]),
    ),
  }
}

function measureStyle(pages) {
  let emDash = 0
  let enDash = 0
  const emPages = new Set()
  const aliasOwners = new Map()
  const titles = new Map()
  let contradictionSections = 0
  let contradictionWithContent = 0
  let contradictionCallouts = 0
  for (const p of pages) {
    const em = (p.text.match(/—/g) ?? []).length
    const en = (p.text.match(/–/g) ?? []).length
    emDash += em
    enDash += en
    if (em > 0) emPages.add(p.rel)

    const title = p.fm.fields.get('title')
    if (title) titles.set(title.toLowerCase(), p.rel)
    for (const a of p.fm.lists.get('aliases') ?? []) {
      const k = a.toLowerCase()
      const owners = aliasOwners.get(k) ?? []
      owners.push(p.rel)
      aliasOwners.set(k, owners)
    }

    for (const s of sections(p.text)) {
      if (!/contradict/i.test(s.title)) continue
      contradictionSections++
      const body = p.text.slice(s.headEnd, s.end).trim()
      if (!/^(?:#+\s*)?(?:none|no contradictions?)\b/i.test(body) && body !== '') contradictionWithContent++
    }
    for (const line of p.text.split('\n')) {
      if (/^>\s*\[!\w+\].*contradict/i.test(line)) contradictionCallouts++
    }
  }
  const collisions = []
  for (const [alias, owners] of aliasOwners) {
    const distinct = [...new Set(owners)]
    if (distinct.length > 1) collisions.push({ alias, kind: 'two pages claim it', owners: distinct })
    else if (owners.length > 1) collisions.push({ alias, kind: 'listed twice in one file', owners: distinct })
    else if (titles.has(alias) && titles.get(alias) !== owners[0]) {
      collisions.push({ alias, kind: 'shadows a page title', owners: [owners[0], titles.get(alias)] })
    }
  }
  return {
    emDash: { occurrences: emDash, pages: emPages.size },
    enDash: { occurrences: enDash },
    aliasCollisions: collisions,
    contradictions: {
      sections: contradictionSections,
      withContent: contradictionWithContent,
      callouts: contradictionCallouts,
    },
  }
}

function measureReachability(vaultRoot, pages) {
  const index = buildNameIndex(vaultRoot, pages, 'service')
  const linkedFrom = (rels) => {
    const reached = new Set()
    for (const rel of rels) {
      const page = pages.find((p) => p.rel === rel)
      if (!page) continue
      for (const t of [...parseWikilinks(page.text), ...(page.fm.lists.get('related') ?? [])]) {
        const target = t.replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0].trim()
        const hit = resolveLink(vaultRoot, index, target)
        if (hit) reached.add(hit)
      }
    }
    return reached
  }
  const fromIndex = linkedFrom(['wiki/index.md'])
  const hubs = pages.filter((p) => p.isHub && p.rel !== 'wiki/log.md').map((p) => p.rel)
  const fromAnyHub = linkedFrom(hubs)
  const content = pages.filter((p) => p.isContent)
  return {
    contentPages: content.length,
    notInIndex: content.filter((p) => !fromIndex.has(p.rel)).map((p) => p.rel),
    notInAnyHub: content.filter((p) => !fromAnyHub.has(p.rel)).map((p) => p.rel),
    hubsConsidered: hubs,
  }
}

function measureAddresses(vaultRoot, pages) {
  const withAddress = pages
    .filter((p) => p.fm.fields.get('address'))
    .map((p) => ({ rel: p.rel, address: p.fm.fields.get('address') }))

  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(join(vaultRoot, '.raw', '.manifest.json'), 'utf8'))
  } catch {
    /* no manifest - every count below is then trivially zero, which is itself the finding */
  }
  let rawDirs = []
  try {
    rawDirs = readdirSync(join(vaultRoot, '.raw'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    /* no .raw - same */
  }
  let counter = null
  try {
    const raw = readFileSync(join(vaultRoot, '.vault-meta', 'address-counter.txt'), 'utf8').trim()
    if (/^\d+$/.test(raw)) counter = Number(raw)
  } catch {
    /* unreadable counter - the drift check is skipped, the rest still measured */
  }

  const integrity = addressIntegrity({
    pages: withAddress,
    map: manifest.address_map,
    sources: manifest.sources,
    rawDirs,
    pageExists: (rel) => {
      const abs = resolve(vaultRoot, rel)
      return abs.startsWith(vaultRoot + sep) && existsSync(abs)
    },
  })
  return {
    ...integrity,
    rawDirs: rawDirs.length,
    counter,
    counterDrift: counter !== null && integrity.maxAddress !== null ? counter - integrity.maxAddress - 1 : null,
  }
}

/** Page history: how many knowledge-adding commits ever wrote each page (B2). */
const KNOWLEDGE_COMMIT = /^(?:ingest|fellow|fellows|research-expand|expand)\b/

function measureHistory(vaultRoot, pages) {
  let log
  try {
    log = execFileSync('git', ['-C', vaultRoot, 'log', '--all', '--name-only', '--pretty=format:\x01%s'], {
      maxBuffer: 1 << 30,
      encoding: 'utf8',
    })
  } catch {
    return null
  }
  const byPath = new Map()
  let subject = ''
  for (const line of log.split('\n')) {
    if (line.startsWith('\x01')) {
      subject = line.slice(1)
      continue
    }
    const p = line.trim()
    if (!p.endsWith('.md') || !p.startsWith('wiki/')) continue
    const seen = byPath.get(p) ?? { all: 0, knowledge: 0 }
    seen.all++
    if (KNOWLEDGE_COMMIT.test(subject)) seen.knowledge++
    byPath.set(p, seen)
  }
  const existing = new Map(pages.filter((p) => p.isContent).map((p) => [p.rel, p]))
  const buckets = new Map()
  const months = new Map()
  let one = 0
  let multi = 0
  let zero = 0
  for (const [rel, page] of existing) {
    const seen = byPath.get(rel) ?? { all: 0, knowledge: 0 }
    const slot = buckets.get(page.bucket) ?? { pages: 0, multi: 0 }
    slot.pages++
    const m = month(page.fm.fields.get('created'))
    const byMonth = months.get(m) ?? { pages: 0, multi: 0 }
    byMonth.pages++
    months.set(m, byMonth)
    if (seen.knowledge === 0) zero++
    else if (seen.knowledge === 1) one++
    else {
      multi++
      slot.multi++
      byMonth.multi++
    }
    buckets.set(page.bucket, slot)
  }
  const contentPathsInHistory = [...byPath.keys()].filter((p) => {
    const parts = p.split('/')
    return parts.length > 2 && CONTENT_BUCKETS.includes(parts[1]) && !parts[parts.length - 1].startsWith('_')
  }).length
  return {
    contentPagesExisting: existing.size,
    contentPathsInHistory,
    oneKnowledgeCommit: one,
    multiKnowledgeCommit: multi,
    noKnowledgeCommit: zero,
    multiShare: pct(multi, existing.size),
    oneShare: pct(one, existing.size),
    byBucket: Object.fromEntries(
      [...buckets.entries()].map(([b, s]) => [b, { pages: s.pages, multi: s.multi, multiShare: pct(s.multi, s.pages) }]),
    ),
    byCreationMonth: Object.fromEntries(
      [...months.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([m, s]) => [m, { pages: s.pages, multi: s.multi, multiShare: pct(s.multi, s.pages) }]),
    ),
  }
}

/** Repository weight by what the bytes are FOR: knowledge, payload, or rebuildable derivative. */
function measureGitWeight(vaultRoot) {
  let objects
  try {
    objects = execFileSync('git', ['-C', vaultRoot, 'rev-list', '--objects', '--all'], {
      maxBuffer: 1 << 30,
      encoding: 'utf8',
    })
  } catch {
    return null
  }
  const paths = []
  const shas = []
  for (const line of objects.split('\n')) {
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    shas.push(line.slice(0, sp))
    paths.push(line.slice(sp + 1))
  }
  const sizes = execFileSync('git', ['-C', vaultRoot, 'cat-file', '--batch-check=%(objecttype) %(objectsize)'], {
    input: shas.join('\n'),
    maxBuffer: 1 << 30,
    encoding: 'utf8',
  }).split('\n')

  /*
   * What the bytes are FOR. `rawOcrDerived` is its own class because it is the whole of D4:
   * an OCR rendering is rebuildable from the original PDF lying beside it, and a handful of
   * those blobs outweigh every page of knowledge the vault has ever held.
   */
  const classOf = (p) => {
    if (!p.startsWith('.raw/')) return p.startsWith('wiki/') ? 'wiki' : 'other'
    if (/(?:^|\/)ocr\.pdf$/.test(p)) return 'rawOcrDerived'
    if (/(?:^|\/)(?:normalized\.md|text\.txt|manifest\.json|transcript\.\w+)$/.test(p)) return 'rawTextDerived'
    return 'rawOriginal'
  }
  const byClass = new Map()
  const byHub = new Map()
  const largest = []
  let total = 0
  for (let i = 0; i < paths.length; i++) {
    const [type, size] = (sizes[i] ?? '').split(' ')
    if (type !== 'blob') continue
    const bytes = Number(size)
    if (!Number.isFinite(bytes)) continue
    total += bytes
    if (bytes > 50_000_000) largest.push({ bytes, class: classOf(paths[i]) })
    const cls = classOf(paths[i])
    const slot = byClass.get(cls) ?? { bytes: 0, blobs: 0 }
    slot.bytes += bytes
    slot.blobs++
    byClass.set(cls, slot)
    const p = paths[i]
    if (HUB_FILES.includes(p) || p.endsWith('/_index.md')) {
      const key = HUB_FILES.includes(p) ? p : '*/_index.md'
      const hub = byHub.get(key) ?? { bytes: 0, versions: 0 }
      hub.bytes += bytes
      hub.versions++
      byHub.set(key, hub)
    }
  }
  largest.sort((a, b) => b.bytes - a.bytes)
  const wikiBytes = byClass.get('wiki')?.bytes ?? 0
  const hubBytes = [...byHub.values()].reduce((s, h) => s + h.bytes, 0)
  return {
    totalBlobBytes: total,
    byClass: Object.fromEntries(sortedEntries(new Map([...byClass].map(([k, v]) => [k, v.bytes]))).map(([k, b]) => [
      k,
      { bytes: b, blobs: byClass.get(k).blobs },
    ])),
    hubs: Object.fromEntries([...byHub.entries()].sort((a, b) => b[1].bytes - a[1].bytes)),
    hubShareOfWiki: pct(hubBytes, wikiBytes),
    blobsOver50MB: largest.slice(0, 10),
  }
}

/* ------------------------------------------------------------------------------------ public */

export function auditVault(vaultRoot, { now = new Date().toISOString().slice(0, 10) } = {}) {
  const root = resolve(vaultRoot)
  if (!existsSync(join(root, 'wiki'))) throw new Error(`no wiki/ under ${root} - not a vault`)
  const pages = loadPages(root)
  let head = null
  let ownRepo = false
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    ownRepo = resolve(top) === root
    if (ownRepo) head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    /* a vault without git is measurable, just without the history sections */
  }
  return {
    meta: { measuredAt: new Date().toISOString(), now, head, vaultRoot: root },
    pages: measurePages(pages, now),
    hubs: measureHubs(pages),
    links: measureLinks(root, pages),
    headings: measureHeadings(pages),
    runProtocol: measureRunProtocol(pages),
    tags: measureTags(pages),
    style: measureStyle(pages),
    reachability: measureReachability(root, pages),
    addresses: measureAddresses(root, pages),
    history: ownRepo ? measureHistory(root, pages) : null,
    git: ownRepo ? measureGitWeight(root) : null,
  }
}

/**
 * Drops every path, title, tag and domain, keeping the numbers (hard rule 7). This is the only
 * output that may be committed to this repo. Structural labels survive: a bucket name, a hub
 * file name and a known `type:`/`status:` value say nothing about what the vault holds.
 */
export function redactReport(report) {
  const knownOnly = (obj, allowed) => {
    const out = {}
    let other = 0
    for (const [k, v] of Object.entries(obj)) {
      if (allowed.has(k)) out[k] = v
      else other += typeof v === 'number' ? v : 0
    }
    if (other > 0) out['(other)'] = other
    return out
  }
  const countsOnly = (list) => (Array.isArray(list) ? list.length : list)
  const r = structuredClone(report)
  r.meta = { measuredAt: r.meta.measuredAt, now: r.meta.now, head: r.meta.head }
  r.pages.byType = knownOnly(r.pages.byType, KNOWN_TYPES)
  r.pages.status = knownOnly(r.pages.status, KNOWN_STATUS)
  r.pages.sourcesByType = knownOnly(r.pages.sourcesByType, KNOWN_TYPES)
  r.links.dead.worstPages = r.links.dead.worstPages.map((w) => ({ count: w.count }))
  for (const [type, h] of Object.entries(r.headings)) {
    r.headings[type] = {
      pages: h.pages,
      distinctHeadings: h.distinctHeadings,
      bestSharedShare: h.bestShared?.share ?? null,
    }
  }
  r.tags.top = r.tags.top.map((t) => ({ pages: t.pages }))
  r.style.aliasCollisions = r.style.aliasCollisions.length
  r.reachability = {
    contentPages: r.reachability.contentPages,
    notInIndex: countsOnly(r.reachability.notInIndex),
    notInAnyHub: countsOnly(r.reachability.notInAnyHub),
  }
  r.addresses = {
    ...r.addresses,
    missingFromMap: countsOnly(r.addresses.missingFromMap),
    staleMapEntries: countsOnly(r.addresses.staleMapEntries),
    divergent: countsOnly(r.addresses.divergent),
    duplicates: countsOnly(r.addresses.duplicates),
    orphanRawDirs: countsOnly(r.addresses.orphanRawDirs),
    danglingPagesCreated: countsOnly(r.addresses.danglingPagesCreated),
  }
  return r
}

/* --------------------------------------------------------------------------------------- CLI */

/* Decimal units throughout, so a size here is the same number `ls` and the review print. */
const kB = (n) => `${Math.round(n / 100) / 10} kB`
const MB = (n) => `${Math.round(n / 100000) / 10} MB`

function printReport(r) {
  const line = (label, value) => console.log(`  ${String(label).padEnd(34)} ${value}`)
  console.log(`\nvault @ ${r.meta.head?.slice(0, 7) ?? '(no git)'}   measured ${r.meta.measuredAt.slice(0, 19)}`)

  console.log('\nPAGES')
  line('wiki pages', r.pages.total)
  line('content pages', r.pages.content)
  for (const [b, n] of Object.entries(r.pages.byBucket)) line(`  ${b}`, n)
  console.log('\nSOURCES PER PAGE (content)')
  for (const [t, s] of Object.entries(r.pages.sourcesByType)) {
    line(t, `${s.total} pages | none ${s.none} | one ${s.one} (${s.singleSourceShare}%) | 2+ ${s.many}`)
  }
  if (r.history) {
    console.log('\nHISTORY (knowledge-adding commits per page)')
    line('content pages measured', r.history.contentPagesExisting)
    line('paths history knows', r.history.contentPathsInHistory)
    line('written once', `${r.history.oneKnowledgeCommit} (${r.history.oneShare}%)`)
    line('written twice or more', `${r.history.multiKnowledgeCommit} (${r.history.multiShare}%)`)
    line('never by such a commit', r.history.noKnowledgeCommit)
    for (const [b, s] of Object.entries(r.history.byBucket)) line(`  ${b}`, `${s.multiShare}% multi`)
    console.log('\nTHE EFFECT (3.3): one document, one page - by creation month')
    for (const [m, s] of Object.entries(r.pages.sourcesByMonth)) {
      const h = r.history.byCreationMonth[m]
      line(m, `${s.pages} pages | single-source ${s.singleSourceShare}% | 2+ sources ${s.many} | multi-commit ${h ? `${h.multiShare}%` : 'n/a'}`)
    }
  }

  console.log('\nHUBS')
  for (const h of r.hubs.slice(0, 8)) {
    line(h.path ?? '(redacted)', `${kB(h.bytes)} | ${h.lines} lines | longest ${h.longestLine} | ${h.sections} sections (${h.datedSections} dated) | related ${h.relatedEntries} (${h.relatedDuplicates} dup)`)
  }

  console.log('\nLINKS')
  line('wikilinks', r.links.total)
  line('dead occurrences', `${r.links.dead.occurrences} over ${r.links.dead.distinctTargets} targets`)
  line('dead outside log/reports', r.links.dead.occurrencesOutsideRecords)
  line('dead as the service resolves', r.links.dead.asTheServiceResolves)
  for (const [cause, n] of Object.entries(r.links.dead.byCause)) line(`  ${cause}`, n)
  line('wrapped (resolvable)', r.links.wrapped)

  console.log('\nHEADINGS (content pages, ## level)')
  for (const [type, h] of Object.entries(r.headings)) {
    const share = h.bestShared?.share ?? h.bestSharedShare
    line(type, `${h.distinctHeadings} distinct over ${h.pages} pages | best shared ${share === null || share === undefined ? 'n/a' : `${share}%`}`)
  }

  console.log('\nRUN-PROTOCOL SECTIONS')
  line('pages carrying one', r.runProtocol.pagesCarrying)
  line('total volume', kB(r.runProtocol.bytes))
  for (const [k, n] of Object.entries(r.runProtocol.byHeading)) line(`  ${k}`, `${n} pages | ${kB(r.runProtocol.bytesByHeading[k])}`)

  console.log('\nTAGS')
  line('assignments', r.tags.assignments)
  line('distinct', r.tags.distinct)
  line('used exactly once', `${r.tags.singleUse} (${r.tags.singleUseShare}%)`)
  for (const [m, s] of Object.entries(r.tags.mirroringByMonth)) line(`  ${m}`, `type ${s.type}% | domain ${s.domain}% (${s.pages} pages)`)

  console.log('\nDATES AND STATUS')
  line('updated within 30 days', `${r.pages.freshness.within30Days} (${r.pages.freshness.share}%) as of ${r.pages.freshness.now}`)
  for (const [s, n] of Object.entries(r.pages.status)) line(`  status: ${s}`, n)

  console.log('\nSTYLE')
  line('em-dashes', `${r.style.emDash.occurrences} across ${r.style.emDash.pages} pages`)
  line('en-dashes', r.style.enDash.occurrences)
  line('alias collisions', Array.isArray(r.style.aliasCollisions) ? r.style.aliasCollisions.length : r.style.aliasCollisions)
  line('contradiction sections', `${r.style.contradictions.sections} (${r.style.contradictions.withContent} with content), ${r.style.contradictions.callouts} callouts`)

  console.log('\nREACHABILITY')
  line('content pages', r.reachability.contentPages)
  line('in no index.md entry', Array.isArray(r.reachability.notInIndex) ? r.reachability.notInIndex.length : r.reachability.notInIndex)
  line('in no hub at all', Array.isArray(r.reachability.notInAnyHub) ? r.reachability.notInAnyHub.length : r.reachability.notInAnyHub)

  console.log('\nADDRESS INTEGRITY')
  const a = r.addresses
  const n = (v) => (Array.isArray(v) ? v.length : v)
  line('pages carrying an address', a.pagesWithAddress)
  line('address_map entries', a.mapEntries)
  line('pages missing from the map', n(a.missingFromMap))
  line('map entries pointing nowhere', n(a.staleMapEntries))
  line('map and page disagree', n(a.divergent))
  line('duplicate addresses', n(a.duplicates))
  line('.raw job dirs', a.rawDirs)
  line('job dirs named in no source', n(a.orphanRawDirs))
  line('pages_created now missing', n(a.danglingPagesCreated))
  line('counter vs max address', `${a.counter} vs ${a.maxAddress} (drift ${a.counterDrift})`)

  if (r.git) {
    console.log('\nGIT WEIGHT')
    line('all blobs', MB(r.git.totalBlobBytes))
    for (const [cls, s] of Object.entries(r.git.byClass)) line(`  ${cls}`, `${MB(s.bytes)} in ${s.blobs} blobs`)
    for (const [hub, s] of Object.entries(r.git.hubs)) line(`  ${hub}`, `${MB(s.bytes)} over ${s.versions} versions`)
    line('hub share of wiki history', `${r.git.hubShareOfWiki}%`)
    line('single blobs over 50 MB', r.git.blobsOver50MB.map((b) => `${MB(b.bytes)} (${b.class})`).join(', ') || 'none')
  }
  console.log('')
}

function main(argv) {
  const args = argv.slice(2)
  const flag = (name) => args.includes(name)
  const valueOf = (name, fallback) => {
    const i = args.indexOf(name)
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback
  }
  const target = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--now')
  if (!target) {
    console.error('usage: node scripts/vault-audit.mjs <vault-path> [--json] [--redact] [--now YYYY-MM-DD]')
    process.exit(2)
  }
  const report = auditVault(target, { now: valueOf('--now', new Date().toISOString().slice(0, 10)) })
  const out = flag('--redact') ? redactReport(report) : report
  if (flag('--json')) console.log(JSON.stringify(out, null, 2))
  else printReport(out)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main(process.argv)
