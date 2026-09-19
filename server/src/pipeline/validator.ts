/**
 * Deterministic post-run validation — the mechanical subset of the wiki-lint checks, run
 * against exactly the pages an agent run or user edit just touched. Rationale (derived from
 * the 2026-07-19 lint report): most lint findings (frontmatter gaps, missing DragonScale
 * addresses, dead links, orphans, stale `.raw/.manifest.json` address_map entries) are
 * mechanically decidable and were all introduced *between* two expensive agent-lint runs.
 * Checking the touched pages right after each mutation surfaces them in the job log while
 * the context is fresh, instead of weeks later in the next full lint. The one editorial
 * check, single-source-entity, backstops the ENTITY_NOTABILITY_RULES prompt extension
 * (system-prompt.ts) — deterministic proxy, advisory like everything else here.
 *
 * READ-ONLY by design (hard rule 1): this module never writes to the vault. Findings are
 * warnings for the operator; fixes remain agent runs or user-initiated edits. Judgment-shaped
 * checks (stale claims, missing pages, cross-reference quality) stay with the wiki-lint skill.
 *
 * The DragonScale address rules mirror skills/wiki-lint/SKILL.md "Address Validation":
 * feature-gated on the vault's own artifacts, rollout baseline + grandfather list from
 * `.vault-meta/legacy-pages.txt`, `c-`/`l-` format, uniqueness, counter consistency, and the
 * address_map ↔ disk ↔ frontmatter three-way agreement. When the vault has not adopted
 * DragonScale, no address finding is ever produced.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseWikilinks } from './citations.js'
import { findWrappedLinks } from './link-repair.js'
import { pluginDocPages } from './upstream-guard.js'
import { TITLE_MAX_CHARS } from './research-profiles.js'
import { parseFrontmatterMeta, type VaultGraph } from './graph.js'

export type ValidationRule =
  | 'frontmatter'
  | 'dates'
  | 'address'
  | 'dead-link'
  | 'wrapped-link'
  | 'orphan'
  | 'address-map'
  | 'stale-counter'
  | 'single-source-entity'
  | 'source-url'
  | 'nested-page'
  | 'hot-cache-size'
  /** A quotation that is not in the text the job read (docs/sources/SPEC.md section 7). */
  | 'quote'
  /** Two pages the vault's own tiling check reads as saying the same thing (A5, `tiling.ts`). */
  | 'near-duplicate'
  /** A `title:` its own file name cannot carry, or one too long to be a name at all (B3). */
  | 'title-name'
  /** A page missing the one heading its type is supposed to have (B4). */
  | 'page-schema'
  /** A section about what a RUN did, sitting inside the article it wrote (B5). */
  | 'run-protocol'
  /** A tag that repeats the page's own `type:` or `domain:` (B6). */
  | 'tag-mirroring'
  /** A tag no other page in the vault uses - an index of one is a note to yourself (B6). */
  | 'tag-singleton'
  /** An em-dash or en-dash on a page, against a house style that has always banned them (B9). */
  | 'em-dash'

export interface ValidationFinding {
  readonly rule: ValidationRule
  /** Vault-relative POSIX path of the page the finding is about. */
  readonly path: string
  readonly message: string
}

/** Signature the queue / maintenance runner / pages routes consume (injectable in tests). */
export type Validator = (paths: readonly string[]) => ValidationFinding[]

/** Required frontmatter fields per the vault's page template (wiki-lint "Frontmatter Gaps"). */
export const REQUIRED_FIELDS = ['type', 'status', 'created', 'updated', 'tags'] as const

/** Baseline the wiki-ingest skill documents for vaults that adopted DragonScale on ship day. */
const DEFAULT_ROLLOUT = '2026-04-23'

/** Buckets whose pages are content that should be reachable — the orphan check's scope.
 * meta/folds/root nav pages are legitimately unlinked-from and stay out. */
const CONTENT_BUCKETS = new Set(['concepts', 'entities', 'sources', 'questions', 'comparisons', 'references'])

const ADDRESS_RE = /^[cl]-\d{6}$/

/** Characters a file name cannot portably carry, so a title holding one drifts from its name. */
const UNSAFE_TITLE_CHARS = /[/\\:?*"<>|]/

/**
 * The smallest useful required heading per page type (B4).
 *
 * 604 concept pages carry 2243 DISTINCT `##` headings between them, so a later run has nowhere
 * predictable to add to. The floor is deliberately tiny and codifies what runs already reach
 * for rather than inventing a template: `## Connections` is the best-shared heading on concepts
 * (41 %) and entities (36 %), and `## Why This Source Matters` on sources (41 %). Everything
 * else stays free, which is the point - the free prose is good.
 */
const REQUIRED_HEADINGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['concept', ['Connections']],
  ['entity', ['Connections']],
  ['source', ['Why This Source Matters', 'Connections']],
])

/**
 * Whether a tag repeats the page's own `type:` or `domain:` (B6).
 *
 * Measured: type mirroring runs at 82 to 96 % by creation month, domain mirroring at 0 to 2 %.
 * The two rules sat in the same prompt block; the domain one is absolute and the type one said
 * "beyond the structural ones the vault prescribes", which reads as permission. The wording is
 * the whole difference, and this rule is the mechanical half of closing it.
 *
 * An exact match or a singular/plural variant, and deliberately NOT a synonym search: "which
 * words mean the same as this type" is a judgement, and a validator that makes it silently
 * reports a number nobody can check.
 */
const mirrorsField = (field: string | undefined, tag: string): boolean => {
  if (field === undefined || field === '') return false
  const norm = (v: string): string => {
    const lower = v.toLowerCase().trim().replace(/[\s_]+/g, '-')
    return lower.length > 3 && lower.endsWith('s') ? lower.slice(0, -1) : lower
  }
  return norm(field) === norm(tag)
}

/**
 * Headings that describe what a RUN did, sitting inside the article it wrote (B5).
 *
 * 352 of 1210 content pages carry at least one, 302 kB in total. They belong in the log entry
 * the service writes from the run's final answer (SPEC.md §12.12), not in an encyclopedia
 * article - three pages currently explain this service's own untrusted-content wrapper to a
 * reader who came for the subject.
 *
 * `## Assessment` and `## Open Questions` are deliberately NOT here: assessment is source
 * criticism and belongs to the source, and the standing agents plan from the open questions.
 */
const RUN_PROTOCOL_HEADINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^editorial note/i, 'Editorial Note'],
  [/^provenance/i, 'Provenance'],
  [/^status of this page/i, 'Status of This Page'],
  [/^relation(?:ship)? to (?:this )?vault/i, 'Relation to this vault'],
  [/^vault context/i, 'Vault context'],
  [/^entity notability/i, 'Entity Notability Note'],
  [/^automated decisions?/i, 'Automated Decisions'],
]

/**
 * Lint reports QUOTE findings as wikilinks - dead links deliberately, orphans linked by the
 * act of reporting them. Validating a report page against the link checks (or counting its
 * links as inbound edges) would therefore invert the report's own findings.
 */
const isLintReport = (rel: string): boolean => /^wiki\/meta\/lint-report-.*\.md$/.test(rel)

/**
 * Pages exempt from the dead-link check: lint reports (above), plus log.md and hot.md -
 * append-only records that legitimately keep referring to deleted pages (the same policy the
 * reference-cleanup run enforces). Every ingest appends to log.md, so flagging its historical
 * links would repeat the identical findings after every single run.
 *
 * `pluginDocs` adds the plugin-shipped pages under wiki/: claude-obsidian's own docs carry
 * `related:` links into docs a Generic-mode vault has no page for, and upstream-guard refuses
 * every agent write to those pages - so the finding names a fix that is structurally
 * forbidden. The graph's gap list drops them for the same reason (graph.ts, GraphGap).
 */
const skipLinkCheck = (rel: string, pluginDocs: ReadonlySet<string>): boolean =>
  isLintReport(rel) || rel === 'wiki/log.md' || rel === 'wiki/hot.md' || pluginDocs.has(rel)

const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '')

interface Frontmatter {
  readonly present: boolean
  /** Scalar `key: value` pairs (first occurrence wins), values trimmed and unquoted. */
  readonly fields: ReadonlyMap<string, string>
  /** `tags:` present at all — a block list leaves the scalar value empty, so track the key. */
  readonly hasTags: boolean
}

/** Shallow frontmatter reader (same stance as graph.ts: agent-written flat YAML, no library). */
function parseFrontmatter(markdown: string): Frontmatter {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return { present: false, fields: new Map(), hasTags: false }
  const body = fm[1]!
  const fields = new Map<string, string>()
  for (const m of body.matchAll(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/gm)) {
    if (!fields.has(m[1]!)) fields.set(m[1]!, unquote(m[2]!))
  }
  return { present: true, fields, hasTags: /^tags:/m.test(body) }
}

/** Below this many distinct tags, a vault has no tag vocabulary to reuse from yet. */
const TAG_CENSUS_FLOOR = 50

/**
 * How many pages carry each tag, over the whole vault.
 *
 * Built lazily and once per call, the same way the file index is: half of this vault's 648
 * tags are used exactly once, and "is this tag an index or a note to yourself" cannot be
 * answered from one page.
 */
function buildTagCensus(vaultRoot: string): Map<string, number> {
  const census = new Map<string, number>()
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
      else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          for (const tag of new Set(parseTagList(fs.readFileSync(abs, 'utf8')).map((t) => t.toLowerCase()))) {
            census.set(tag, (census.get(tag) ?? 0) + 1)
          }
        } catch {
          /* an unreadable page carries no tags for this purpose */
        }
      }
    }
  }
  walk(path.join(vaultRoot, 'wiki'))
  return census
}

/** Frontmatter `tags:` as written (block or inline), for the mirroring rule. */
function parseTagList(markdown: string): string[] {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return []
  const body = fm[1]!
  const block = body.match(/^tags:[ \t]*\r?\n((?:[ \t]+-[ \t]*.*\r?\n?)+)/m)
  if (block) {
    return [...block[1]!.matchAll(/^[ \t]+-[ \t]*(.+)$/gm)].map((m) => unquote(m[1]!)).filter((t) => t !== '')
  }
  const inline = body.match(/^tags:[ \t]*\[([^\]]*)\]/m)
  if (!inline) return []
  return inline[1]!.split(',').map((t) => unquote(t)).filter((t) => t !== '')
}

interface DragonScaleState {
  readonly active: boolean
  /** `YYYY-MM-DD`; pages created on/after this date must carry an address. */
  readonly rollout: string
  /** Post-rollout paths explicitly grandfathered in `.vault-meta/legacy-pages.txt`. */
  readonly legacy: ReadonlySet<string>
  /** Next value the allocator would hand out; null when the counter file is unreadable. */
  readonly counter: number | null
}

function readDragonScale(vaultRoot: string): DragonScaleState {
  const counterFile = path.join(vaultRoot, '.vault-meta', 'address-counter.txt')
  const active = fs.existsSync(counterFile) && fs.existsSync(path.join(vaultRoot, 'scripts', 'allocate-address.sh'))
  if (!active) return { active: false, rollout: DEFAULT_ROLLOUT, legacy: new Set(), counter: null }

  let counter: number | null = null
  try {
    const raw = fs.readFileSync(counterFile, 'utf8').trim()
    if (/^\d+$/.test(raw)) counter = Number(raw)
  } catch {
    /* unreadable counter → skip the drift check, keep the others */
  }

  let rollout = DEFAULT_ROLLOUT
  const legacy = new Set<string>()
  try {
    for (const line of fs.readFileSync(path.join(vaultRoot, '.vault-meta', 'legacy-pages.txt'), 'utf8').split('\n')) {
      const t = line.trim()
      const m = /^#\s*rollout:\s*(\d{4}-\d{2}-\d{2})/.exec(t)
      if (m) rollout = m[1]!
      else if (t !== '' && !t.startsWith('#')) legacy.add(t)
    }
  } catch {
    /* no manifest → default baseline, nothing grandfathered */
  }
  return { active: true, rollout, legacy, counter }
}

/**
 * Case-insensitive name index over EVERY vault file, keyed by basename, by basename minus
 * extension, AND — for markdown pages — by frontmatter `title:` and `aliases:`. Deliberately
 * wider than a pure filename index: Obsidian resolves `[[fold-template]]` to
 * skills/…/fold-template.md and `[[Wiki Map]]` to Wiki Map.canvas, and a page linked by a
 * title that differs from its filename (e.g. `transport-fallback.md` titled "Transport Fallback
 * Decision Tree") resolves too. The title/alias layer mirrors the graph resolver
 * (graph.ts `byTitle`) so the two agree — otherwise the graph links a page the validator calls
 * dead, which was a recurring false-positive class on every run that touched wiki/index.md.
 */
function buildFileIndex(vaultRoot: string): Set<string> {
  const index = new Set<string>()
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(abs)
        continue
      }
      if (!e.isFile()) continue
      index.add(e.name.toLowerCase())
      const stem = e.name.replace(/\.[^.]+$/, '')
      if (stem !== '') index.add(stem.toLowerCase())
      // Frontmatter title/aliases let a link resolve by a name the filename does not carry.
      // Same source the graph resolver reads, so a link is never "dead here, live there".
      if (e.name.toLowerCase().endsWith('.md')) {
        try {
          const meta = parseFrontmatterMeta(fs.readFileSync(abs, 'utf8'))
          for (const name of [meta.title, ...meta.aliases]) {
            if (name) index.add(name.toLowerCase())
          }
        } catch {
          /* unreadable page — its filename-derived keys still apply */
        }
      }
    }
  }
  walk(vaultRoot)
  return index
}

function linkResolves(vaultRoot: string, index: ReadonlySet<string>, target: string): boolean {
  if (target.includes('/')) {
    // Path-qualified: try the path as written, with `.md`, and wiki-relative (the vault's
    // `[[concepts/_index]]` navigation style) — confined to the vault.
    for (const cand of [target, `${target}.md`, `wiki/${target}`, `wiki/${target}.md`]) {
      const abs = path.resolve(vaultRoot, cand)
      if (abs.startsWith(vaultRoot + path.sep) && fs.existsSync(abs)) return true
    }
    const base = target.split('/').filter(Boolean).pop() ?? ''
    return base !== '' && index.has(base.toLowerCase())
  }
  return index.has(target.toLowerCase())
}

/** Every `address:` in the wiki, address → paths (the uniqueness check's evidence base). */
function scanAddresses(vaultRoot: string): Map<string, string[]> {
  const byAddress = new Map<string, string[]>()
  const wikiRoot = path.join(vaultRoot, 'wiki')
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
      else if (e.isFile() && e.name.endsWith('.md')) {
        let address: string | undefined
        try {
          address = parseFrontmatter(fs.readFileSync(abs, 'utf8')).fields.get('address')
        } catch {
          continue
        }
        if (!address) continue
        const rel = path.relative(vaultRoot, abs).split(path.sep).join(path.posix.sep)
        const holders = byAddress.get(address)
        if (holders === undefined) byAddress.set(address, [rel])
        else holders.push(rel)
      }
    }
  }
  walk(wikiRoot)
  return byAddress
}

/**
 * Validates the given wiki pages (vault-relative POSIX paths; non-wiki paths are ignored).
 * Pass a freshly built graph to enable the orphan check; without it that check is skipped.
 * Never throws and never writes; a page deleted since the run simply yields no findings.
 */
export function validatePages(vaultRoot: string, paths: readonly string[], graph?: VaultGraph): ValidationFinding[] {
  const findings: ValidationFinding[] = []
  /** Built once per call, and only when a page actually has a tag worth asking about. */
  let tagCensus: Map<string, number> | undefined
  const pages = [...new Set(paths)].filter((p) => p.startsWith('wiki/') && p.endsWith('.md'))
  if (pages.length === 0) return findings

  const ds = readDragonScale(vaultRoot)
  const pluginDocs = pluginDocPages(vaultRoot)
  // These cost a vault walk / edge scan — built only when a page actually needs them.
  let fileIndex: Set<string> | undefined
  let addresses: Map<string, string[]> | undefined
  let inbound: number[] | undefined
  let inboundSources: number[] | undefined

  for (const rel of pages) {
    let markdown: string
    try {
      markdown = fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
    } catch {
      continue
    }

    /*
     * A page one folder below its bucket (2026-09-10). A page title carrying a path separator
     * is written as a directory plus a page named after the rest of the title, and every
     * wikilink aimed at the whole title then resolves to nothing - which is how it was found,
     * long after the run that wrote it reported success. The buckets under `wiki/` are flat;
     * `wiki/meta/` is the exception, where the agent and recap journals live in folders of
     * their own.
     */
    const inBucket = rel.startsWith('wiki/') ? rel.slice('wiki/'.length) : rel
    if (!rel.startsWith('wiki/meta/') && inBucket.split('/').length > 2) {
      findings.push({
        rule: 'nested-page',
        path: rel,
        message: 'page sits a folder below its bucket - a path separator in the title makes one',
      })
    }

    const fm = parseFrontmatter(markdown)
    if (!fm.present) {
      findings.push({ rule: 'frontmatter', path: rel, message: 'page has no YAML frontmatter block' })
    } else {
      const missing = REQUIRED_FIELDS.filter((f) => (f === 'tags' ? !fm.hasTags : (fm.fields.get(f) ?? '') === ''))
      if (missing.length > 0) {
        findings.push({
          rule: 'frontmatter',
          path: rel,
          message: `missing required frontmatter field(s): ${missing.join(', ')}`,
        })
      }
    }

    /*
     * A title its own file name cannot carry (B3). This is the vault's largest mechanical
     * dead-link class: the title keeps the character, the file name loses it, and every link
     * written from the title lands nowhere. 55 occurrences today, 43 of them from two pages.
     *
     * Checked against the file name AS IT IS, not against a guess: a page called `Foo - Bar`
     * whose title says `Foo: Bar` is the defect, and one where both say the same thing is not,
     * whatever characters that happens to be.
     */
    const title = (fm.fields.get('title') ?? '').trim()
    if (title !== '') {
      const fileName = rel.split('/').pop()!.replace(/\.md$/, '')
      if (title !== fileName && UNSAFE_TITLE_CHARS.test(title)) {
        findings.push({
          rule: 'title-name',
          path: rel,
          message:
            `title "${title}" carries a character the file name cannot (it is filed as "${fileName}"), ` +
            `so every wikilink written from the title resolves to nothing - use a hyphen in both`,
        })
      }
      if (title.length > TITLE_MAX_CHARS) {
        findings.push({
          rule: 'title-name',
          path: rel,
          message: `title is ${title.length} characters; keep it under ${TITLE_MAX_CHARS} so the file name stays inside every filesystem's limit`,
        })
      }
    }

    /*
     * The heading floor for this page's type (B4), and the run-protocol sections that belong
     * in the log rather than in the article (B5). Both are advisory, like every rule here.
     */
    const pageType = (fm.fields.get('type') ?? '').toLowerCase()
    const headings = [...markdown.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1]!.trim())
    const required = REQUIRED_HEADINGS.get(pageType)
    if (required !== undefined) {
      const present = new Set(headings.map((h) => h.toLowerCase()))
      const missing = required.filter((r) => !present.has(r.toLowerCase()))
      if (missing.length > 0) {
        findings.push({
          rule: 'page-schema',
          path: rel,
          message: `a ${pageType} page needs ${missing.map((m) => `## ${m}`).join(' and ')} - it is where the next run adds to this page`,
        })
      }
    }
    for (const heading of headings) {
      const hit = RUN_PROTOCOL_HEADINGS.find(([re]) => re.test(heading))
      if (hit === undefined) continue
      findings.push({
        rule: 'run-protocol',
        path: rel,
        message: `"## ${heading}" is about what a RUN did, not about the subject - it belongs in the log entry`,
      })
    }

    /*
     * Tags that repeat the frontmatter (B6). `meta` is the documented exception: it names what
     * a page IS - vault machinery, an index, a report - as well as being a domain key.
     */
    const domain = fm.fields.get('domain')
    for (const tag of parseTagList(markdown)) {
      if (tag.toLowerCase() === 'meta') continue
      const mirrorsType = mirrorsField(pageType, tag)
      const mirrorsDomain = mirrorsField(domain, tag)
      if (mirrorsType || mirrorsDomain) {
        findings.push({
          rule: 'tag-mirroring',
          path: rel,
          message: `tag "${tag}" repeats this page's own ${mirrorsType ? 'type:' : 'domain:'} - the field already carries it, and every reader of it reads the field`,
        })
        continue
      }
      tagCensus ??= buildTagCensus(vaultRoot)
      /*
       * "Reuse before coining" is only advice when there is something to reuse. On a young
       * vault every tag is used once by construction, and a hint that fires on every tag of
       * every page is noise rather than a finding.
       */
      if (tagCensus.size < TAG_CENSUS_FLOOR) continue
      if ((tagCensus.get(tag.toLowerCase()) ?? 0) <= 1) {
        findings.push({
          rule: 'tag-singleton',
          path: rel,
          message: `tag "${tag}" is on no other page - if an existing tag means the same thing, use that one instead`,
        })
      }
    }

    /*
     * Em-dashes and en-dashes (B9). The house style has banned them from the start and no
     * prompt had ever said so, which is how 819 pages came to carry 10,257 of them. Code
     * fences and inline code are excluded: inside them the character is content.
     */
    const prose = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
    const dashes = (prose.match(/[\u2014\u2013]/g) ?? []).length
    if (dashes > 0) {
      findings.push({
        rule: 'em-dash',
        path: rel,
        message: `${dashes} em-dash or en-dash${dashes === 1 ? '' : 'es'} outside code - the house style uses a hyphen, a comma or a restructured sentence`,
      })
    }

    const created = fm.fields.get('created') ?? ''
    const updated = fm.fields.get('updated') ?? ''
    const createdMs = Date.parse(created)
    const updatedMs = Date.parse(updated)
    if (Number.isFinite(createdMs) && Number.isFinite(updatedMs) && createdMs > updatedMs) {
      findings.push({
        rule: 'dates',
        path: rel,
        message: `created (${created}) is after updated (${updated}) - bump updated: when editing`,
      })
    }

    /*
     * A source page's `url:` is read literally by the dedupe index and the reading list, so a
     * value that merely CONTAINS an address is as good as blank to them. Three pages had one
     * written as a sentence with the address in brackets inside it, and four held placeholder
     * words; none of the seven could answer "is this document already here?".
     *
     * An empty field is fine and stays silent: plenty of documents state no address.
     */
    const rawUrl = (fm.fields.get('url') ?? '').trim().replace(/^["']|["']$/g, '')
    if ((fm.fields.get('type') ?? '').toLowerCase() === 'source' && rawUrl !== '' && !/^https?:\/\/\S+$/.test(rawUrl)) {
      findings.push({
        rule: 'source-url',
        path: rel,
        message: `url: must be a bare address or empty, not ${JSON.stringify(rawUrl.slice(0, 60))}`,
      })
    }

    // DragonScale addresses. Fold pages use fold_id instead and are exempt from the c-/l- rules.
    const type = (fm.fields.get('type') ?? '').toLowerCase()
    const address = fm.fields.get('address') ?? ''
    if (ds.active && type !== 'fold' && !rel.startsWith('wiki/folds/')) {
      const createdDay = created.slice(0, 10)
      if (address === '') {
        const required =
          type !== 'meta' && /^\d{4}-\d{2}-\d{2}$/.test(createdDay) && createdDay >= ds.rollout && !ds.legacy.has(rel)
        if (required) {
          findings.push({
            rule: 'address',
            path: rel,
            message: `post-rollout page (created ${createdDay}) has no address: - allocate one via scripts/allocate-address.sh`,
          })
        }
      } else if (!ADDRESS_RE.test(address)) {
        findings.push({
          rule: 'address',
          path: rel,
          message: `malformed address "${address}" - expected c-NNNNNN or l-NNNNNN`,
        })
      } else {
        if (address.startsWith('c-') && ds.counter !== null && Number(address.slice(2)) >= ds.counter) {
          findings.push({
            rule: 'address',
            path: rel,
            message: `address ${address} is at/above the allocation counter (${ds.counter}) - counter drift`,
          })
        }
        addresses ??= scanAddresses(vaultRoot)
        const others = (addresses.get(address) ?? []).filter((h) => h !== rel)
        if (others.length > 0) {
          findings.push({
            rule: 'address',
            path: rel,
            message: `address ${address} collides with ${others.join(', ')}`,
          })
        }
      }
    }

    /*
     * A link broken by a line wrap is its own finding, not a dead link. It names a page that
     * EXISTS, so calling it dead buries a one-character repair in a list of genuine gaps -
     * one lint run reported 36 of these among 87 "dead" links. `link-repair.ts` fixes them
     * without a model; this is what tells anyone they are there.
     */
    const joined = new Set<string>()
    if (!skipLinkCheck(rel, pluginDocs)) {
      const wrapped = findWrappedLinks(markdown)
      if (wrapped.length > 0) {
        fileIndex ??= buildFileIndex(vaultRoot)
        for (const w of wrapped) {
          if (!linkResolves(vaultRoot, fileIndex, w.target)) continue
          joined.add(w.target.toLowerCase())
          findings.push({
            rule: 'wrapped-link',
            path: rel,
            message: `[[${w.target}]] is split across a line break, so it resolves to nothing - join it back onto one line`,
          })
        }
      }
    }

    const targets = skipLinkCheck(rel, pluginDocs) ? [] : parseWikilinks(markdown)
    if (targets.length > 0) {
      fileIndex ??= buildFileIndex(vaultRoot)
      for (const t of targets) {
        // Reported as a wrapped link already: one repair, one finding.
        if (joined.has(t.replace(/\s+/g, ' ').trim().toLowerCase())) continue
        if (!linkResolves(vaultRoot, fileIndex, t)) {
          findings.push({ rule: 'dead-link', path: rel, message: `[[${t}]] does not resolve to any file in the vault` })
        }
      }
    }

    if (graph !== undefined) {
      const parts = rel.split('/')
      const bucket = parts.length > 2 ? parts[1]! : 'root'
      if (CONTENT_BUCKETS.has(bucket) && !parts[parts.length - 1]!.startsWith('_')) {
        // In-degree minus lint-report sources (see isLintReport) - computed once per call.
        inbound ??= countInboundExcludingReports(graph)
        const idx = graph.nodes.findIndex((n) => n.path === rel)
        if (idx >= 0 && inbound[idx] === 0) {
          findings.push({
            rule: 'orphan',
            path: rel,
            message: 'no other page links here - add a link from the index or a related page',
          })
        }

        // Entity-notability backstop (prevention side: ENTITY_NOTABILITY_RULES in
        // system-prompt.ts). Deterministic proxy for "single-source entity": a seed-status
        // entity referenced by at most one source page. Bumping status past seed is the
        // operator's deliberate keep-anyway override.
        if (bucket === 'entities' && idx >= 0 && (fm.fields.get('status') ?? '').toLowerCase() === 'seed') {
          inboundSources ??= countInboundSourcePages(graph)
          const n = inboundSources[idx]!
          if (n <= 1) {
            findings.push({
              rule: 'single-source-entity',
              path: rel,
              message:
                `seed entity is referenced by ${n === 0 ? 'no' : 'only one'} source page - ` +
                'prefer an inline attribution on the source page unless the entity is independently ' +
                'notable (entity notability rules); bump status past seed to keep it deliberately',
            })
          }
        }
      }
    }
  }
  return findings
}

/** Distinct source pages (wiki/sources/*, `_index` hubs excluded) linking TO each node —
 * the single-source-entity check's evidence base. Concept/index backlinks deliberately do
 * not count: concepts minted from the same ingest all link their author, so counting them
 * would launder a single-source entity into an apparently well-referenced one. */
function countInboundSourcePages(graph: VaultGraph): number[] {
  const isSource = graph.nodes.map((n) => {
    const parts = n.path.split('/')
    return parts.length > 2 && parts[1] === 'sources' && !parts[parts.length - 1]!.startsWith('_')
  })
  const linkingSources = graph.nodes.map(() => new Set<number>())
  for (const [from, to] of graph.edges) {
    if (isSource[from]) linkingSources[to]!.add(from)
  }
  return linkingSources.map((s) => s.size)
}

/** Per-node in-degree over the graph's edges, not counting links FROM lint-report pages. */
function countInboundExcludingReports(graph: VaultGraph): number[] {
  const counts = new Array<number>(graph.nodes.length).fill(0)
  for (const [from, to] of graph.edges) {
    if (!isLintReport(graph.nodes[from]!.path)) counts[to]!++
  }
  return counts
}

/**
 * The address_map ↔ disk ↔ frontmatter consistency check (`.raw/.manifest.json`): a deletion
 * is not a manifest-aware operation, so every DELETE of a mapped page silently strands an
 * entry claiming its address is in use — the 2026-07-19 lint found four. Vaults without the
 * manifest (or without address_map) yield no findings.
 */
export function validateAddressMap(vaultRoot: string): ValidationFinding[] {
  let manifest: { address_map?: Record<string, unknown>; sources?: Record<string, unknown> }
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(vaultRoot, '.raw', '.manifest.json'), 'utf8')) as typeof manifest
  } catch {
    return []
  }
  const map = manifest.address_map ?? {}

  const findings: ValidationFinding[] = []
  for (const [rel, addr] of Object.entries(map)) {
    if (typeof addr !== 'string') continue
    const abs = path.resolve(vaultRoot, rel)
    if (!abs.startsWith(vaultRoot + path.sep)) continue // hostile/garbled entry - not ours to judge
    if (!fs.existsSync(abs)) {
      findings.push({
        rule: 'address-map',
        path: rel,
        message: `.raw/.manifest.json address_map still maps ${addr} to this page, but it no longer exists - remove the stale entry`,
      })
      continue
    }
    let onPage: string
    try {
      onPage = parseFrontmatter(fs.readFileSync(abs, 'utf8')).fields.get('address') ?? ''
    } catch {
      continue
    }
    if (onPage !== addr) {
      findings.push({
        rule: 'address-map',
        path: rel,
        message: `address_map says ${addr} but the page's frontmatter says ${onPage || '(none)'} - map and page diverged`,
      })
    }
  }

  /*
   * THE DIRECTION NOTHING EVER WALKED (N1). The loop above asks of each map entry whether its
   * page still resolves. Nothing asked of each PAGE whether the map knows it - which is how
   * 274 of 1174 addressed pages came to be missing from the map without a single finding.
   *
   * What it costs when the map is wrong in this direction: `buildSourceIndex` and
   * `dedupe.jobForPage` both read the map, so a page missing from it has no document behind it
   * as far as the service is concerned.
   */
  const mapped = new Set(Object.keys(map))
  for (const [address, holders] of scanAddresses(vaultRoot)) {
    for (const rel of holders) {
      if (mapped.has(rel)) continue
      findings.push({
        rule: 'address-map',
        path: rel,
        message: `page carries ${address} but .raw/.manifest.json's address_map has no entry for it - the source index cannot find the document behind it`,
      })
    }
  }

  /*
   * The `sources` half of the same file, which nothing checked either:
   *
   *  - a `.raw/<job-id>/` directory named in no source entry (20 of 226 today), so whatever
   *    that document produced is invisible to the source index and to dedupe;
   *  - a `pages_created` entry pointing at a page that is gone (7 today).
   */
  const sources = manifest.sources ?? {}
  const namedDirs = new Set<string>()
  for (const [key, entry] of Object.entries(sources)) {
    const parts = key.split('/')
    if (parts[0] === '.raw' && parts.length > 1) namedDirs.add(parts[1]!)
    const created = (entry as { pages_created?: unknown })?.pages_created
    if (!Array.isArray(created)) continue
    for (const page of created) {
      if (typeof page !== 'string') continue
      const abs = path.resolve(vaultRoot, page)
      if (!abs.startsWith(vaultRoot + path.sep) || fs.existsSync(abs)) continue
      findings.push({
        rule: 'address-map',
        path: page,
        message: `.raw/.manifest.json lists this page as created by ${key}, but it no longer exists - remove the stale entry`,
      })
    }
  }

  let rawDirs: string[] = []
  try {
    rawDirs = fs
      .readdirSync(path.join(vaultRoot, '.raw'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    /* no .raw at all: the checks above already returned nothing */
  }
  for (const dir of rawDirs) {
    if (namedDirs.has(dir)) continue
    findings.push({
      rule: 'address-map',
      path: `.raw/${dir}`,
      message: 'this job directory is named in no source entry of .raw/.manifest.json - whatever it produced has no document behind it',
    })
  }

  return findings
}

/**
 * How far a hand-maintained header counter may lag the real count before it is flagged.
 * The tolerance absorbs legitimate semantic differences (a "Total pages" line that never
 * counted meta pages); the lint report's real drift cases were 13 and 8 pages behind.
 */
const COUNTER_SLACK = 3

/**
 * The stale-counter check (lint report "Stale Claims"): wiki/index.md and wiki/overview.md
 * carry hand-maintained "Total pages: N" / "Sources ingested: N" header lines that had
 * drifted for 3+ ingest sessions because every single-source run correctly deferred fixing
 * them. Compare the claimed numbers against the counted reality; findings are advisory.
 */
export function validateCounters(vaultRoot: string): ValidationFinding[] {
  const findings: ValidationFinding[] = []
  const totals = countWikiPages(vaultRoot)
  if (totals === undefined) return findings

  for (const rel of ['wiki/index.md', 'wiki/overview.md']) {
    let markdown: string
    try {
      markdown = fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
    } catch {
      continue
    }
    const checks: Array<{ re: RegExp; label: string; actual: number }> = [
      { re: /(?:total|wiki) pages\D{0,5}(\d+)/i, label: 'pages', actual: totals.pages },
      { re: /sources ingested\D{0,5}(\d+)/i, label: 'sources', actual: totals.sources },
    ]
    for (const { re, label, actual } of checks) {
      const m = re.exec(markdown)
      if (!m) continue
      const claimed = Number(m[1])
      if (Math.abs(actual - claimed) > COUNTER_SLACK) {
        findings.push({
          rule: 'stale-counter',
          path: rel,
          message: `header claims ${claimed} ${label} but the vault has ${actual} - update the counter (or drop it from the header)`,
        })
      }
    }
  }
  return findings
}

/** Counts wiki pages and source pages on disk (`_index` hubs excluded from sources). */
function countWikiPages(vaultRoot: string): { pages: number; sources: number } | undefined {
  const wikiRoot = path.join(vaultRoot, 'wiki')
  if (!fs.existsSync(wikiRoot)) return undefined
  let pages = 0
  let sources = 0
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
      else if (e.isFile() && e.name.endsWith('.md')) {
        pages++
        if (path.basename(dir) === 'sources' && !e.name.startsWith('_')) sources++
      }
    }
  }
  walk(wikiRoot)
  return { pages, sources }
}

/** The hot cache is a cache, not a journal: the wiki skill sizes it at ~500 words, overwritten each run. */
export const HOT_CACHE_WORD_BUDGET = 500
/** Findings start here; the gap above the budget absorbs a long "Last Updated" line without nagging. */
export const HOT_CACHE_WORD_LIMIT = 750
/** `related:` on the hot cache names the pages of the latest pass, not every page ever touched. */
export const HOT_CACHE_RELATED_LIMIT = 40

/**
 * The hot-cache-size check. wiki/hot.md is loaded into context at the start of every session and
 * read by every query, and the wiki skill specifies it as a ~500-word summary of recent context
 * that is overwritten on each update. Left to accumulate instead, one vault's copy reached 53,000
 * words across 89 appended passes with a 647-entry `related:` list, which turned the recency
 * buffer into 70,000 tokens of preamble and into a page that outranked real content in retrieval.
 * Findings are advisory; the hot-cache refresh run is what rewrites the file.
 */
export function validateHotCache(vaultRoot: string): ValidationFinding[] {
  const rel = 'wiki/hot.md'
  let markdown: string
  try {
    markdown = fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
  } catch {
    return []
  }
  const findings: ValidationFinding[] = []
  const words = markdown.split(/\s+/).filter(Boolean).length
  if (words > HOT_CACHE_WORD_LIMIT) {
    findings.push({
      rule: 'hot-cache-size',
      path: rel,
      message:
        `hot cache is ${words} words; the skill contract is a ~${HOT_CACHE_WORD_BUDGET}-word summary ` +
        'of recent context, overwritten each run, not a journal - rewrite it within the budget',
    })
  }
  const relatedBlock = /^related:\s*$([\s\S]*?)(?=^\S)/m.exec(markdown)?.[1] ?? ''
  const relatedEntries = relatedBlock.split('\n').filter((l) => /^\s*-\s/.test(l)).length
  if (relatedEntries > HOT_CACHE_RELATED_LIMIT) {
    findings.push({
      rule: 'hot-cache-size',
      path: rel,
      message:
        `hot cache lists ${relatedEntries} related pages; keep related: to the pages of the latest ` +
        `pass (at most ${HOT_CACHE_RELATED_LIMIT})`,
    })
  }
  return findings
}

/** The standard composition the service wires in: per-page, address_map, counter and hot-cache checks. */
export function createValidator(vaultRoot: string, graph?: { build(): VaultGraph }): Validator {
  return (paths) => [
    ...validatePages(vaultRoot, paths, graph?.build()),
    ...validateAddressMap(vaultRoot),
    ...validateCounters(vaultRoot),
    ...validateHotCache(vaultRoot),
  ]
}
