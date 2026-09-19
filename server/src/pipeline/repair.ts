/**
 * The one-off repair passes over existing vault content (phase 8 of the vault-layer work).
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER WRITER IN THIS SERVICE. Those write what a run
 * just produced. These rewrite pages a person wrote months ago, in bulk, by rule. So the whole
 * module is built around one shape:
 *
 *     a pass is a pure function from the vault to a list of proposed edits.
 *
 * Nothing here writes. `planRepair` returns what WOULD change, with the before and after of
 * every page, so a dry run is the default and a diff can be read before anything is applied.
 * Applying is a separate call, and it is the caller that holds the locks and makes the commit.
 *
 * WHAT NO PASS HERE MAY DO, from the phase's own rules: no page is deleted, no page is renamed,
 * no page is merged, and no prose is rewritten. Those are the user's decisions, not a repair
 * run's. A pass that cannot make its change mechanically leaves the page alone and says so.
 *
 * And the rule that decides whether phase 8 is safe at all: a repair stamps `updated:` and
 * never `content_updated:` (B7). These passes touch hundreds of pages; if they claimed those
 * pages had said something new, they would destroy the same freshness signal they exist to
 * protect - which is exactly how it was destroyed the first time.
 */

import fs from 'node:fs'
import path from 'node:path'
import { stampDates } from './page-dates.js'
import { CONTENT_BUCKETS, UPSTREAM_DEMO, collectPages, orderDomains, pageLink, sortPages, type HubPage } from './hubs.js'
import { readDomainRegistry, UNASSIGNED } from './domains.js'

/** One proposed change to one page. `before` and `after` are the whole file. */
export interface PageEdit {
  /** Vault-relative POSIX path. */
  readonly rel: string
  readonly before: string
  readonly after: string
  /** One line naming what this pass changed on this page, for the dry-run summary. */
  readonly why: string
}

export interface RepairPlan {
  readonly pass: string
  readonly edits: readonly PageEdit[]
  /** Pages the pass looked at and deliberately left alone, with the reason. */
  readonly skipped: ReadonlyArray<{ rel: string; why: string }>
}

const toPosix = (p: string): string => p.split(path.sep).join('/')

/** Every `wiki/**\/*.md`, vault-relative. */
export function wikiPages(vaultRoot: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile() && e.name.endsWith('.md')) out.push(toPosix(path.relative(vaultRoot, abs)))
    }
  }
  walk(path.join(vaultRoot, 'wiki'))
  return out.sort()
}

/** A pass: given a page's current content, the content it should have, or null to leave it. */
export type RepairPass = (rel: string, markdown: string, vaultRoot: string) => { after: string; why: string } | null

/**
 * Runs a pass over the vault and returns what it would change. Reads only.
 *
 * `stampDates` is applied here rather than inside each pass, so no pass can forget it and none
 * can get it wrong: every repair is a mechanical change, so `content` is always false.
 */
export function planRepair(vaultRoot: string, pass: string, run: RepairPass, day?: string): RepairPlan {
  const edits: PageEdit[] = []
  const skipped: Array<{ rel: string; why: string }> = []
  for (const rel of wikiPages(vaultRoot)) {
    let before: string
    try {
      before = fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
    } catch {
      skipped.push({ rel, why: 'unreadable' })
      continue
    }
    let result: { after: string; why: string } | null
    try {
      result = run(rel, before, vaultRoot)
    } catch (err) {
      skipped.push({ rel, why: `the pass threw: ${(err as Error).message}` })
      continue
    }
    if (result === null || result.after === before) continue
    const after = stampDates(result.after, { content: false, ...(day === undefined ? {} : { day }) })
    if (after === before) continue
    edits.push({ rel, before, after, why: result.why })
  }
  return { pass, edits, skipped }
}

/**
 * Writes a plan's edits. The CALLER holds the vault's per-file locks and the commit mutex and
 * makes the commit - this only writes files, so the order stays where hard rule 1 puts it.
 *
 * Returns the paths written. A page that changed on disk since the plan was made is skipped
 * rather than overwritten: a plan is a snapshot, and a stale snapshot must not clobber a run.
 */
export function applyRepair(vaultRoot: string, plan: RepairPlan): { written: string[]; stale: string[] } {
  const written: string[] = []
  const stale: string[] = []
  for (const edit of plan.edits) {
    const abs = path.join(vaultRoot, edit.rel)
    let current: string
    try {
      current = fs.readFileSync(abs, 'utf8')
    } catch {
      stale.push(edit.rel)
      continue
    }
    if (current !== edit.before) {
      stale.push(edit.rel)
      continue
    }
    fs.writeFileSync(abs, edit.after, 'utf8')
    written.push(edit.rel)
  }
  return { written, stale }
}

/**
 * A readable diff of one edit.
 *
 * A real longest-common-subsequence walk rather than a line-for-line comparison. The naive
 * version is fine while lines only change in place and becomes actively misleading the moment
 * one is REMOVED - every line after it reads as changed, and a dry run whose diff cannot be
 * trusted is worse than no dry run. These passes remove lines (a tag, a whole section), so it
 * has to be the real thing.
 */
export function diffOf(edit: PageEdit, context = 1): string {
  const a = edit.before.split('\n')
  const b = edit.after.split('\n')

  // LCS lengths. Page-sized inputs, so the straightforward table is the right amount of code.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const rows: Array<{ mark: ' ' | '-' | '+'; text: string }> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ mark: ' ', text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ mark: '-', text: a[i]! })
      i++
    } else {
      rows.push({ mark: '+', text: b[j]! })
      j++
    }
  }
  while (i < a.length) rows.push({ mark: '-', text: a[i++]! })
  while (j < b.length) rows.push({ mark: '+', text: b[j++]! })

  // Only the changed lines and `context` lines around them; everything else is elided.
  const keep = new Set<number>()
  rows.forEach((row, k) => {
    if (row.mark === ' ') return
    for (let n = Math.max(0, k - context); n <= Math.min(rows.length - 1, k + context); n++) keep.add(n)
  })
  const out: string[] = []
  let elided = false
  rows.forEach((row, k) => {
    if (!keep.has(k)) {
      if (!elided) out.push('  ...')
      elided = true
      return
    }
    elided = false
    out.push(`${row.mark} ${row.text}`)
  })
  return out.join('\n')
}

/* --------------------------------------------------------------------------------- the passes */

/**
 * 8.6: em-dashes and en-dashes out of the prose.
 *
 * Code fences, inline code, frontmatter values and URLs are left exactly as they are - inside
 * them the character is content, not style. What is NOT safe to do mechanically is a dash
 * between two numbers (a range) and one inside a quotation, so those are left and reported.
 */
export const emDashPass: RepairPass = (_rel, markdown) => {
  const fm = markdown.match(/^---\r?\n[\s\S]*?\r?\n---/)
  const head = fm === null ? '' : fm[0]
  const body = fm === null ? markdown : markdown.slice(head.length)

  let replaced = 0
  let kept = 0
  const out = body
    /*
     * A WIKILINK TARGET IS A NAME, not prose (found the hard way on 2026-09-19: the first run
     * of this pass rewrote dashes inside `[[...]]` and 199 links stopped resolving, because
     * the pages they name still carry the dash in their own file names). Same reasoning as the
     * addresses and the code below it: inside these, the character is an identifier.
     */
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|!?\[\[[^\]]*\]\]|https?:\/\/\S+)/)
    .map((chunk, i) => {
      // Odd chunks are the delimiters themselves: code and addresses, left alone.
      if (i % 2 === 1) return chunk
      // Escapes, not the characters themselves: this regex is the one place in the repo
      // where a literal dash is correct, and a future de-dashing pass over the sources
      // would silently break it.
      return chunk.replace(/[\u2014\u2013]/g, (dash, at: number) => {
        // A dash BETWEEN DIGITS is a range ("1914-1918"), and a hyphen would change what it
        // says. Left in place and counted, so the pass reports what it did not do.
        const prev = chunk[at - 1] ?? ''
        const next = chunk[at + 1] ?? ''
        if (/\d/.test(prev) && /\d/.test(next)) {
          kept++
          return dash
        }
        replaced++
        // A spaced dash becomes a spaced hyphen; an unspaced one keeps its spacing.
        return '-'
      })
    })
    .join('')

  if (replaced === 0) return null
  return {
    after: head + out,
    why: `${replaced} dash${replaced === 1 ? '' : 'es'} replaced${kept > 0 ? `, ${kept} numeric range${kept === 1 ? '' : 's'} left` : ''}`,
  }
}

/**
 * 8.4: tags that repeat the page's own `type:` or `domain:`.
 *
 * Removes exactly those, and nothing else: no taxonomy is invented, no singleton is merged,
 * and `meta` stays because it names what a page IS as well as being a domain key.
 */
export const tagMirrorPass: RepairPass = (_rel, markdown) => {
  const fm = markdown.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (fm === null) return null
  const front = fm[2]!
  const valueOf = (field: string): string => {
    const m = new RegExp(`^${field}:[ \\t]*(.*)$`, 'm').exec(front)
    return (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  const norm = (v: string): string => {
    const lower = v.toLowerCase().trim().replace(/[\s_]+/g, '-')
    return lower.length > 3 && lower.endsWith('s') ? lower.slice(0, -1) : lower
  }
  const type = valueOf('type')
  const domain = valueOf('domain')
  const mirrors = new Set([type, domain].filter((v) => v !== '').map(norm))
  if (mirrors.size === 0) return null

  const removed: string[] = []
  const lines = front.split(/\r?\n/)
  const out: string[] = []
  let inTags = false
  for (const line of lines) {
    if (/^tags:/.test(line)) {
      inTags = true
      out.push(line)
      continue
    }
    if (inTags && /^[ \t]+-[ \t]*/.test(line)) {
      const tag = line.replace(/^[ \t]+-[ \t]*/, '').trim().replace(/^["']|["']$/g, '')
      if (tag.toLowerCase() !== 'meta' && mirrors.has(norm(tag))) {
        removed.push(tag)
        continue
      }
      out.push(line)
      continue
    }
    if (inTags && !/^[ \t]/.test(line)) inTags = false
    out.push(line)
  }
  if (removed.length === 0) return null
  return {
    after: markdown.slice(0, fm[1]!.length) + out.join('\n') + markdown.slice(fm[1]!.length + front.length),
    why: `removed ${removed.length} mirroring tag(s): ${removed.join(', ')}`,
  }
}

/**
 * 8.5: the run-protocol sections that are pure bookkeeping.
 *
 * Five of the seven headings carry nothing but a record of what a RUN did, and the service
 * writes that into the log entry now (SPEC.md §12.12). Those are removed.
 *
 * TWO ARE DELIBERATELY NOT TOUCHED. `## Editorial Note` and `## Provenance` sometimes carry a
 * real judgement about the source - a caveat, a reason a claim is hedged - and sometimes carry
 * nothing but bookkeeping, and no rule can tell the two apart. They are reported and left for
 * a person, which is what the phase's own "no prose rewrite" rule requires.
 */
const BOOKKEEPING_HEADINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^status of this page/i, 'Status of This Page'],
  [/^relation(?:ship)? to (?:this )?vault/i, 'Relation to this vault'],
  [/^vault context/i, 'Vault context'],
  [/^entity notability/i, 'Entity Notability Note'],
  [/^automated decisions?/i, 'Automated Decisions'],
]

/**
 * How long a section can be, and still be bookkeeping.
 *
 * Found in the dry run over the live vault, which is why the rule is here at all: a section
 * headed "Relation to This Vault's ... Coverage" turned out to carry a paragraph DISTINGUISHING
 * two sources, with wikilinks to both. That is a judgement about the material, in a section the
 * task's list calls droppable.
 *
 * So the heading alone does not decide it. A section that is short and links to nothing is the
 * boilerplate this pass exists to remove; one that is long or cites other pages is content, and
 * it is left for a person - which is what "no prose rewrite" means in practice.
 */
const BOOKKEEPING_MAX_CHARS = 400

export const runProtocolPass: RepairPass = (_rel, markdown) => {
  const heads = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm)]
  if (heads.length === 0) return null
  const cuts: Array<{ start: number; end: number; name: string }> = []
  const substantive: string[] = []
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!
    const level = h[1]!.length
    const title = h[2]!.trim()
    const hit = BOOKKEEPING_HEADINGS.find(([re]) => re.test(title))
    if (hit === undefined) continue
    // The section runs to the next heading of the same level or higher, never into a deeper
    // subsection of a DIFFERENT section.
    let end = markdown.length
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j]![1]!.length <= level) {
        end = heads[j]!.index!
        break
      }
    }
    const section = markdown.slice(h.index! + h[0].length, end).trim()
    // Long, or citing other pages: content, not bookkeeping. Left alone and counted.
    if (section.length > BOOKKEEPING_MAX_CHARS || /\[\[/.test(section)) {
      substantive.push(hit[1])
      continue
    }
    cuts.push({ start: h.index!, end, name: hit[1] })
  }
  if (cuts.length === 0) return null
  let after = markdown
  for (const cut of [...cuts].sort((a, b) => b.start - a.start)) {
    after = after.slice(0, cut.start) + after.slice(cut.end)
  }
  return {
    after: after.replace(/\n{3,}/g, '\n\n'),
    why:
      `removed ${cuts.length} bookkeeping section(s): ${cuts.map((c) => c.name).join(', ')}` +
      (substantive.length > 0 ? `; left ${substantive.length} that carries content` : ''),
  }
}

/**
 * 8.7: mark the plugin's own demo and release pages.
 *
 * NOT deleted - that decision stays with the user. Marked with `origin: upstream-demo` so the
 * generated hubs, the page counters and the retrieval index can leave them out while they stay
 * readable in Obsidian exactly as they are.
 *
 * Identified by what they are rather than by a list: a page created before the vault started
 * taking real material, carrying the upstream community footer. Both conditions, because
 * either alone would catch a real page.
 */
const DEMO_CUTOFF = '2026-07-01'
const UPSTREAM_FOOTER = /claude-obsidian|Built with \[?claude-obsidian|github\.com\/AgriciDaniel/i

/**
 * Whether a page is material the vault COLLECTED, which is the only kind that can be demo
 * material (8.7).
 *
 * The first run of this pass marked three hubs and would have marked a fold page: they were
 * created when the vault was, and they quote the upstream footer because the entries they
 * archive do. Both of the pass's conditions held and both conclusions were wrong - a page the
 * SERVICE writes is not material at all, and `origin: upstream-demo` on the vault's own index
 * tells every reader that counts pages to skip it.
 *
 * So the test is positive rather than a growing list of exclusions: a content bucket, and not
 * a bucket hub. `wiki/meta/`, `wiki/folds/`, the root hubs and the `_index` MOCs all fail it
 * without being named.
 */
function isContentPage(rel: string): boolean {
  const parts = rel.split('/')
  if (parts.length !== 3 || parts[0] !== 'wiki') return false
  if (!CONTENT_BUCKETS.includes(parts[1] as (typeof CONTENT_BUCKETS)[number])) return false
  return !parts[2]!.startsWith('_')
}

export const demoSeedPass: RepairPass = (rel, markdown) => {
  const fm = markdown.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (fm === null) return null
  const front = fm[2]!

  /*
   * A HUB IS NEVER DEMO MATERIAL, and the first run of this pass marked three of them.
   *
   * `log.md`, `overview.md` and `index.md` were created when the vault was created and they
   * carried the upstream footer, so both of the pass's conditions held. But they are not
   * material at all: they are the pages the SERVICE writes (SPEC.md 12.12), alive and
   * regenerated after every run, and `origin: upstream-demo` on them tells every reader that
   * counts pages to skip the vault's own index. `index.md` self-corrected on the next
   * regeneration, which is what a generated file does; the other two are hand-owned in part
   * and kept the mark.
   *
   * So the pass skips them, and REMOVES the mark where it already put one. A pass that only
   * stops making a mistake leaves the mistake.
   */
  if (!isContentPage(rel)) {
    const wrong = new RegExp(`^origin:[ \\t]*["']?${UPSTREAM_DEMO}["']?[ \\t]*$\\r?\\n?`, 'm')
    if (!wrong.test(front)) return null
    return {
      after:
        markdown.slice(0, fm[1]!.length) +
        front.replace(wrong, '').replace(/\r?\n\s*$/, '') +
        markdown.slice(fm[1]!.length + front.length),
      why: 'not a content page: the mark is removed',
    }
  }

  if (/^origin:/m.test(front)) return null
  const created = /^created:[ \t]*(\d{4}-\d{2}-\d{2})/m.exec(front)?.[1]
  if (created === undefined || created >= DEMO_CUTOFF) return null
  if (!UPSTREAM_FOOTER.test(markdown)) return null
  return {
    after:
      markdown.slice(0, fm[1]!.length) +
      `${front}\norigin: upstream-demo` +
      markdown.slice(fm[1]!.length + front.length),
    why: `created ${created} and carries the upstream footer: marked, not removed`,
  }
}

/* ------------------------------------------------------- the dead-link repair (8.2) is wider */

export interface TitleDrift {
  /** The page whose title its file name cannot carry. */
  readonly rel: string
  /** What the frontmatter says now. */
  readonly title: string
  /** What the file is actually called - the spelling every link has to use. */
  readonly fileName: string
  /** Pages carrying a link written from the old title. */
  readonly linkedFrom: readonly string[]
}

/**
 * 8.2: pages whose `title:` carries a character their file name does not, plus every page
 * linking to them by that title.
 *
 * The repair has to touch BOTH ends or it regenerates itself: the link is rewritten to the
 * file name, AND the page's own title is brought into line, because the next run writes its
 * links from the title again. 55 occurrences today, 43 of them from two pages.
 *
 * Read-only. The caller turns this into edits.
 */
export function planTitleDrift(vaultRoot: string, pages: readonly string[]): TitleDrift[] {
  const drifted: Array<{ rel: string; title: string; fileName: string }> = []
  const contents = new Map<string, string>()
  for (const rel of pages) {
    let markdown: string
    try {
      markdown = fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
    } catch {
      continue
    }
    contents.set(rel, markdown)
    const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (fm === null) continue
    const title = (/^title:[ \t]*(.*)$/m.exec(fm[1]!)?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
    if (title === '') continue
    const fileName = rel.split('/').pop()!.replace(/\.md$/, '')
    if (title === fileName) continue
    if (!/[/\\:?*"<>|]/.test(title)) continue
    drifted.push({ rel, title, fileName })
  }

  return drifted.map((d) => {
    const linkedFrom: string[] = []
    const needle = new RegExp(`\\[\\[${d.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\||#|\\]\\])`)
    for (const [rel, markdown] of contents) {
      if (rel !== d.rel && needle.test(markdown)) linkedFrom.push(rel)
    }
    return { ...d, linkedFrom }
  })
}

/* ------------------------------------------------------- the address map backfill (8.3) */

export interface ManifestRepair {
  /** Pages carrying an `address:` the map did not know, with the address to record. */
  readonly added: ReadonlyArray<{ rel: string; address: string }>
  /** `pages_created` entries naming a page that no longer exists, to drop. */
  readonly droppedPages: ReadonlyArray<{ source: string; page: string }>
  /** `.raw/<job>/` directories named in no source entry: reported, never invented. */
  readonly unnamedDirs: readonly string[]
  /** The manifest as it would be written, or null when nothing would change. */
  readonly after: string | null
}

/**
 * 8.3: the address map, repaired in the direction nothing ever walked (N1).
 *
 * Adds an entry for every page that carries an `address:` and is missing from the map - 274 of
 * 1174 today - and drops `pages_created` entries whose page is gone. Both are mechanical: the
 * page's own frontmatter is the authority for its address, and a page that does not exist
 * cannot have been created by anything.
 *
 * What it does NOT do: invent a source entry for the 20 job directories named nowhere. What
 * document a directory holds and which pages came out of it is not derivable from the
 * directory, and a made-up provenance record is worse than a missing one. They are reported.
 */
export function planManifestRepair(vaultRoot: string): ManifestRepair {
  const manifestPath = path.join(vaultRoot, '.raw', '.manifest.json')
  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch {
    return { added: [], droppedPages: [], unnamedDirs: [], after: null }
  }
  let manifest: { address_map?: Record<string, string>; sources?: Record<string, { pages_created?: string[] }> }
  try {
    manifest = JSON.parse(raw) as typeof manifest
  } catch {
    return { added: [], droppedPages: [], unnamedDirs: [], after: null }
  }

  const map = { ...(manifest.address_map ?? {}) }
  const added: Array<{ rel: string; address: string }> = []
  for (const rel of wikiPages(vaultRoot)) {
    if (map[rel] !== undefined) continue
    let markdown: string
    try {
      markdown = fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
    } catch {
      continue
    }
    const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (fm === null) continue
    const address = (/^address:[ \t]*(.*)$/m.exec(fm[1]!)?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
    if (!/^[cl]-\d{6}$/.test(address)) continue
    map[rel] = address
    added.push({ rel, address })
  }

  const sources: Record<string, { pages_created?: string[] }> = {}
  const droppedPages: Array<{ source: string; page: string }> = []
  const named = new Set<string>()
  for (const [key, entry] of Object.entries(manifest.sources ?? {})) {
    const parts = key.split('/')
    if (parts[0] === '.raw' && parts.length > 1) named.add(parts[1]!)
    const created = entry?.pages_created
    if (!Array.isArray(created)) {
      sources[key] = entry
      continue
    }
    const kept: string[] = []
    for (const page of created) {
      const abs = path.resolve(vaultRoot, page)
      if (abs.startsWith(vaultRoot + path.sep) && fs.existsSync(abs)) kept.push(page)
      else droppedPages.push({ source: key, page })
    }
    sources[key] = { ...entry, pages_created: kept }
  }

  let unnamedDirs: string[] = []
  try {
    unnamedDirs = fs
      .readdirSync(path.join(vaultRoot, '.raw'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !named.has(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    /* no .raw: nothing to reconcile */
  }

  if (added.length === 0 && droppedPages.length === 0) {
    return { added, droppedPages, unnamedDirs, after: null }
  }
  // Key order preserved where it was, new entries appended: the file is read by the vault's
  // own skill, and a wholesale reordering would make every future diff unreadable.
  const after = `${JSON.stringify({ ...manifest, address_map: map, sources }, null, 2)}\n`
  return { added, droppedPages, unnamedDirs, after }
}

/**
 * Repairs a wikilink whose target differs from a real page only in which dash it uses.
 *
 * WHY THIS EXISTS. The first run of `emDashPass` over the live vault rewrote dashes inside
 * `[[...]]` as well as in prose, and 199 links stopped resolving: the pages they name carry
 * the dash in their own file names, so `[[Foo - Bar]]` no longer found `Foo — Bar`. The pass
 * is fixed; this repairs what it did, and it repairs the same shape wherever else it occurs.
 *
 * It only ever rewrites a link that does NOT resolve today and whose dash-normalised form
 * matches exactly ONE page. Two matches is an ambiguity a rule must not resolve silently.
 */
export function dashLinkPass(vaultRoot: string): RepairPass {
  const byNormalised = new Map<string, string[]>()
  const normalise = (name: string): string => name.replace(/[—–-]+/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
  const known = new Set<string>()
  for (const rel of wikiPages(vaultRoot)) {
    const name = rel.split('/').pop()!.replace(/\.md$/, '')
    known.add(name.toLowerCase())
    const key = normalise(name)
    const holders = byNormalised.get(key)
    if (holders === undefined) byNormalised.set(key, [name])
    else holders.push(name)
    // A page's own title and aliases resolve too, so a link written from one is not dead.
    try {
      const fm = fs.readFileSync(path.join(vaultRoot, rel), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)
      if (fm === null) continue
      const title = (/^title:[ \t]*(.*)$/m.exec(fm[1]!)?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
      if (title !== '') known.add(title.toLowerCase())
      for (const m of fm[1]!.matchAll(/^[ \t]+-[ \t]*(.+)$/gm)) known.add(m[1]!.trim().replace(/^["']|["']$/g, '').toLowerCase())
    } catch {
      /* unreadable: its file name is still in the index */
    }
  }

  return (_rel, markdown) => {
    let repaired = 0
    const after = markdown.replace(/(!?\[\[)([^\]|#]+)([^\]]*\]\])/g, (whole, open: string, target: string, tail: string) => {
      const name = target.trim()
      if (name === '' || known.has(name.toLowerCase())) return whole
      const matches = byNormalised.get(normalise(name))
      if (matches === undefined || matches.length !== 1) return whole
      repaired++
      return `${open}${matches[0]}${tail}`
    })
    if (repaired === 0) return null
    return { after, why: `repointed ${repaired} link(s) that differed from a real page only in the dash` }
  }
}

/* ------------------------------------------------------------ the log archive (8.8) */

/**
 * How many entries `wiki/log.md` keeps. The rest move to dated archive pages.
 *
 * WHY A COUNT AND NOT A DATE WINDOW. The plan proposed "the current quarter plus fold pages
 * for everything older". Measured on the live vault, that keeps 236 of 257 entries and takes
 * the file from 776 kB to 752: this vault only started taking real material in July, so the
 * quarter IS almost the whole log. A count is what actually bounds the file, and 25 entries is
 * about two weeks at the current rate - and the number that lands the file under 100 kB, which
 * is the size at which it is still something a reader opens.
 *
 * NOTHING IS LOST. Every archived entry moves to a page under `wiki/folds/`, one per month,
 * linked from the log. And the whole file is in git besides.
 *
 * This is only safe because nothing reads `log.md` for a job's status any more (task 2.4, and
 * the fallback was removed once no job was left in `ingesting`). A truncated log under the old
 * check would have answered "not finished" for every job older than the window.
 */
export const LOG_KEEP_ENTRIES = 25

export interface LogArchivePlan {
  /** `wiki/log.md` as it would be left: head, the recent window, and the archive links. */
  readonly log: string | null
  /** One archive page per month, oldest first. */
  readonly archives: ReadonlyArray<{ rel: string; content: string; entries: number }>
  readonly kept: number
  readonly archived: number
}

/** Splits the log into its head and its `## [date] …` entries, newest first as written. */
function splitLog(markdown: string): { head: string; entries: Array<{ month: string; text: string }> } {
  const heads = [...markdown.matchAll(/^## \[(\d{4}-\d{2})-\d{2}\][^\n]*$/gm)]
  if (heads.length === 0) return { head: markdown, entries: [] }
  const head = markdown.slice(0, heads[0]!.index!).replace(/\s*$/, '')
  const entries = heads.map((h, i) => ({
    month: h[1]!,
    text: markdown.slice(h.index!, i + 1 < heads.length ? heads[i + 1]!.index! : markdown.length).replace(/\s*$/, ''),
  }))
  return { head, entries }
}

/** The archive page for one month: a fold page, readable in Obsidian, linked from the log. */
function archivePage(month: string, entries: ReadonlyArray<{ text: string }>): string {
  return [
    '---',
    'type: fold',
    'domain: meta',
    `title: "Operation Log ${month}"`,
    `created: ${month}-01`,
    `updated: ${month}-01`,
    'tags:',
    '  - meta',
    '  - log',
    'status: evergreen',
    'related:',
    '  - "[[log]]"',
    '---',
    '',
    `# Operation Log ${month}`,
    '',
    `Archived from [[log]]: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} of ${month}, moved here to keep the live log readable. Nothing was changed.`,
    '',
    ...entries.map((e) => `${e.text}\n`),
  ].join('\n')
}

/** Read-only: what the archival would produce. */
export function planLogArchive(vaultRoot: string, keep: number = LOG_KEEP_ENTRIES): LogArchivePlan {
  let markdown: string
  try {
    markdown = fs.readFileSync(path.join(vaultRoot, 'wiki', 'log.md'), 'utf8')
  } catch {
    return { log: null, archives: [], kept: 0, archived: 0 }
  }
  const { head, entries } = splitLog(markdown)
  if (entries.length <= keep) return { log: null, archives: [], kept: entries.length, archived: 0 }

  const recent = entries.slice(0, keep)
  const older = entries.slice(keep)
  const byMonth = new Map<string, Array<{ text: string }>>()
  for (const e of older) {
    const list = byMonth.get(e.month)
    if (list === undefined) byMonth.set(e.month, [e])
    else list.push(e)
  }
  const archives = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, list]) => ({
      rel: `wiki/folds/log-${month}.md`,
      content: archivePage(month, list),
      entries: list.length,
    }))

  const links = archives.map((a) => `- [[log-${a.rel.slice('wiki/folds/log-'.length, -3)}]] (${a.entries} entries)`)
  const log = [
    head,
    '',
    ...recent.map((e) => `${e.text}\n`),
    '## Older entries',
    '',
    `The ${older.length} entries before these are archived by month, unchanged:`,
    '',
    ...links,
    '',
  ].join('\n')
  return { log, archives, kept: recent.length, archived: older.length }
}

/* -------------------------------------------------- the overview rebuild (2.6's DoD, in 8.1) */

/**
 * `overview.md`: the sections that accumulated, and the demo text under them (2.6, applied in
 * 8.1).
 *
 * MEASURED, and the numbers say what this is. The page is 91.6 kB. Its `## Purpose` still says
 * "This is the claude-obsidian demo vault ... Run `/wiki` to scaffold this vault for your own
 * domain and replace this overview" - on a vault of 1208 pages across 21 domains - and
 * `## Current Seed Content` still lists the six pages the plugin shipped with. Those are 1.6 kB
 * of the 91.6.
 *
 * The other 88 kB is two hand-maintained accumulations, and they are the same class the hub
 * layer was built for one page further out:
 *
 *   - `## Current State`, 63.5 kB, is a page count, a source count and then one appended line
 *     per ingest going back months. The counts are in the generated block at the foot of this
 *     same page; the activity is `log.md`, which is the file whose whole job that is.
 *   - `## Beyond the Seed Domain`, 25 kB **on one line**, is a run-on sentence that every run
 *     extended with its domain. The domain count is in the generated block too.
 *
 * So this removes nothing that is not written down better elsewhere, which is the only reason
 * a pass may touch a hand-owned page at all.
 *
 * WHAT IT DOES NOT DO. It does not write a purpose for this vault. That is the user's sentence
 * and a generator has no business inventing it; the section is left with one line saying so.
 * `## Key Themes`, `## Canvases` and the generated counters block are untouched.
 */
export const OVERVIEW_PAGE = 'wiki/overview.md'

/** The demo sentence the plugin ships, and the marker of a vault nobody has adopted yet. */
const DEMO_OVERVIEW = /This is the claude-obsidian demo vault\./

/** Sections whose content is generated, logged or counted somewhere better. */
const OVERVIEW_DROP = ['Current Seed Content', 'Beyond the Seed Domain', 'Current State'] as const

const PURPOSE_PLACEHOLDER =
  'What this vault is for, in a few sentences. This section is hand-owned: nothing generates it,\n' +
  'and the ingestion service will not touch it again. It currently holds the text the\n' +
  'claude-obsidian plugin ships with, which was true of an empty vault and is not true of this one.'

/**
 * Splits a page into its `##` sections, keeping everything before the first one as the head.
 *
 * Deliberately not a markdown parser: a `##` inside a fenced code block would fool it. The one
 * page this runs against has no fences, and the dry run is what proves it rather than the
 * regex - which is the same bargain every pass in this file makes.
 */
function sections(markdown: string): { head: string; parts: { heading: string; body: string }[] } {
  const split = markdown.split(/^(?=## )/m)
  const head = split[0] ?? ''
  const parts = split.slice(1).map((chunk) => {
    const nl = chunk.indexOf('\n')
    return nl === -1
      ? { heading: chunk.trim(), body: '' }
      : { heading: chunk.slice(0, nl).trim(), body: chunk.slice(nl + 1) }
  })
  return { head, parts }
}

export const overviewPass: RepairPass = (rel, markdown) => {
  if (rel !== OVERVIEW_PAGE) return null
  const { head, parts } = sections(markdown)
  const dropped: string[] = []

  const kept = parts.filter((p) => {
    const name = p.heading.replace(/^##\s*/, '').trim()
    if (!OVERVIEW_DROP.includes(name as (typeof OVERVIEW_DROP)[number])) return true
    dropped.push(`${name} (${p.body.length} B)`)
    return false
  })

  let purposeRewritten = false
  for (const p of kept) {
    if (p.heading.replace(/^##\s*/, '').trim() !== 'Purpose') continue
    if (!DEMO_OVERVIEW.test(p.body)) continue
    // Keep the section's own trailing separator, which is what holds the page's rhythm.
    const rule = /\n---\s*\n\s*$/.test(p.body) ? '\n---\n\n' : '\n'
    p.body = `\n${PURPOSE_PLACEHOLDER}\n${rule}`
    purposeRewritten = true
  }

  if (dropped.length === 0 && !purposeRewritten) return null
  const after = head + kept.map((p) => `${p.heading}\n${p.body}`).join('')
  const why = [
    ...(purposeRewritten ? ['the shipped demo text replaced by a note that the section is the user\'s'] : []),
    ...(dropped.length > 0 ? [`dropped: ${dropped.join(', ')} - all of it counted or logged elsewhere`] : []),
  ].join('; ')
  return { after, why }
}

/* --------------------------------------------------------- the tag singletons (8.4, part two) */

/**
 * 8.4, part two: tags that name exactly one page.
 *
 * MEASURED, and the measurement is what decided the shape. 643 distinct tags over the working
 * vault, **322 used exactly once**, and - the part that was assumed rather than checked until
 * now - **none of the 322 is a spelling variant of a tag that IS used elsewhere**. There was
 * nothing to merge. They are 322 genuinely one-off names.
 *
 * A tag that names one page groups nothing. It is a second title, written in the tag field,
 * and it costs the tag axis its whole purpose: a reader who opens the tag pane to see what a
 * vault is about gets 322 entries of one.
 *
 * WHAT THIS IS NOT. It does not merge, rename or invent anything - the task rules that out and
 * the measurement removes the reason. A tag that gains a second page later is welcome back;
 * nothing here writes a rule against it. And it is reversible: one commit, one `git revert`.
 *
 * A page whose EVERY tag is a singleton keeps them all. See the note at the guard: emptying
 * the block put 36 pages in violation of the vault's own page template, which requires
 * `tags:`. The pass had not found those problems, it had made them.
 */
export function tagSingletonPass(vaultRoot: string): RepairPass {
  const counts = new Map<string, number>()
  for (const rel of wikiPages(vaultRoot)) {
    for (const tag of readTags(vaultRoot, rel)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  const singletons = new Set([...counts].filter(([, n]) => n === 1).map(([t]) => t))

  return (_rel, markdown) => {
    const fm = markdown.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
    if (fm === null) return null
    const front = fm[2]!
    const removed: string[] = []
    const lines = front.split(/\r?\n/)
    const out: string[] = []
    let inTags = false
    let kept = 0
    for (const line of lines) {
      if (/^tags:/.test(line)) {
        inTags = true
        out.push(line)
        continue
      }
      if (inTags && /^[ \t]+-[ \t]*/.test(line)) {
        const tag = line.replace(/^[ \t]+-[ \t]*/, '').trim().replace(/^["']|["']$/g, '')
        if (singletons.has(tag)) {
          removed.push(tag)
          continue
        }
        kept++
        out.push(line)
        continue
      }
      if (inTags && !/^[ \t]/.test(line)) inTags = false
      out.push(line)
    }
    if (removed.length === 0) return null
    /*
     * NEVER leave a page with no tags at all.
     *
     * Measured the hard way: the first run of this pass emptied the tag block on 36 pages
     * whose every tag was a one-off, and the validator went from 9 frontmatter findings to
     * 45. That rule is not ours - it mirrors the VAULT's own page template, which requires
     * `tags:` (wiki-lint "Frontmatter Gaps") - so the pass had not found 36 problems, it had
     * made them.
     *
     * A page whose only tags name nothing else keeps them. They group nothing, which is the
     * whole complaint, but an imperfect tag beats a page that violates the vault's own
     * template, and picking a replacement would be inventing the taxonomy this pass is
     * forbidden to invent.
     */
    if (kept === 0) return null
    return {
      after: markdown.slice(0, fm[1]!.length) + out.join('\n') + markdown.slice(fm[1]!.length + front.length),
      why: `${removed.length} tag${removed.length === 1 ? '' : 's'} naming only this page`,
    }
  }
}

/** The `tags:` a page carries, as written. Shared by the singleton scan and its tests. */
function readTags(vaultRoot: string, rel: string): string[] {
  let markdown: string
  try {
    markdown = fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
  } catch {
    return []
  }
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm === null) return []
  const block = fm[1]!.match(/^tags:[ \t]*\r?\n((?:[ \t]+-[ \t]*.*\r?\n?)+)/m)
  if (block === null) return []
  return [...block[1]!.matchAll(/^[ \t]+-[ \t]*(.+)$/gm)].map((m) =>
    m[1]!.trim().replace(/^["']|["']$/g, ''),
  )
}

/* ------------------------------------------- moving the run record to the foot (8.5, part two) */

/**
 * The heading every moved section ends up under.
 *
 * Named for what it separates rather than for what it contains: everything under it is about
 * the PAGE - how it came to be, what the writer thought of the material - and everything above
 * it is about the subject. That is the distinction a reader lost when a run wrote its own
 * notes into the middle of an article.
 */
export const RECORD_HEADING = 'About This Page'

/**
 * Sections that belong to the record rather than to the article (8.5, part two).
 *
 * `## Open Questions` is deliberately NOT here and must not be added. It is a live feature:
 * `candidates.ts` reads the section BY NAME to plan a Fellow's work, and
 * `POST /api/v1/questions/archive` strikes through its bullets. Moving it under another
 * heading would break the planner silently, which is the same shape of mistake as C-1.
 */
const RECORD_HEADINGS: ReadonlyArray<RegExp> = [
  /^status of this page/i,
  /^relation(?:ship)? to (?:this )?vault/i,
  /^vault context/i,
  /^entity notability/i,
  /^automated decisions?/i,
  /^editorial note/i,
  /^provenance/i,
  /^assessment/i,
]

/**
 * Moves the run's own notes out of the article and to its foot, keeping every word (8.5).
 *
 * WHY MOVE RATHER THAN DELETE. `runProtocolPass` removes a section that is short and cites
 * nothing, which is boilerplate by any reading. It left 273 sections over eight headings,
 * 232 kB, and they were left because they carry arguments: a caveat about a source, a reason a
 * claim is hedged, a paragraph distinguishing two papers. Deleting those is a prose rewrite,
 * which this phase forbids. But they do not belong in the middle of an encyclopedia article
 * either, so they go to the bottom under one heading and keep their own names as `###`.
 *
 * Nothing is dropped, nothing is reworded, and the byte count of the page barely moves - what
 * changes is that the article reads through.
 */
export const recordSectionPass: RepairPass = (rel, markdown) => {
  if (!rel.startsWith('wiki/') || rel.startsWith('wiki/meta/') || rel.startsWith('wiki/folds/')) return null
  const heads = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm)]
  if (heads.length === 0) return null

  const container = heads.find((h) => h[2]!.trim().toLowerCase() === RECORD_HEADING.toLowerCase())
  const moves: Array<{ start: number; end: number; title: string }> = []
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!
    const level = h[1]!.length
    // Level 3 and deeper is already a subsection of something, the container included.
    if (level > 2) continue
    if (!RECORD_HEADINGS.some((re) => re.test(h[2]!.trim()))) continue
    // Already at the foot, under the container: nothing to do. This is what makes the pass
    // idempotent, and idempotence is what lets it run after every ingest later.
    if (container !== undefined && h.index! > container.index!) continue
    let end = markdown.length
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j]![1]!.length <= level) {
        end = heads[j]!.index!
        break
      }
    }
    moves.push({ start: h.index!, end, title: h[2]!.trim() })
  }
  if (moves.length === 0) return null

  // Each section keeps its own name, one level deeper, and its text exactly as written.
  const block = moves
    .map((m) => {
      const text = markdown.slice(m.start, m.end).replace(/^#{1,6}[ \t]+.*(\r?\n)?/, '').trim()
      return `### ${m.title}\n\n${text}\n`
    })
    .join('\n')

  let body = markdown
  for (const m of [...moves].sort((a, b) => b.start - a.start)) {
    body = body.slice(0, m.start) + body.slice(m.end)
  }
  body = body.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')

  const marker = `## ${RECORD_HEADING}`
  const at = body.indexOf(marker)
  const after =
    at >= 0
      ? `${body.slice(0, at + marker.length)}\n\n${block}\n${body.slice(at + marker.length).replace(/^\s*/, '')}`
      : `${body}\n\n${marker}\n\n${block}`

  return {
    after: `${after.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`,
    why: `${moves.length} section(s) moved to "${RECORD_HEADING}": ${moves.map((m) => m.title).join(', ')}`,
  }
}

/* ------------------------------------------------- the title/link divergence (8.2, part two) */

/**
 * 8.2, part two: links written from a title the file name cannot carry.
 *
 * WHAT WAS ASSUMED, AND WHAT THE MEASUREMENT SAID. The plan read this as one mechanism: a page
 * titled `Foo: Bar` is filed as `Foo - Bar` because a colon cannot go in a file name, so every
 * link written from the title lands nowhere, and repairing the title at the source would stop
 * the class regenerating. That is a clean story and it is mostly not what happened.
 *
 * Of the 42 colon cases, the best single transformation explains **7**. `": " -> " - "` gets 7,
 * dropping the colon entirely gets 9, `"/" -> "_"` explains 3 of the 14 slash cases. Nothing
 * explains the rest, because the file names were never DERIVED from the titles: a run chose a
 * name and separately chose a title, and the two are simply different strings. A page's file
 * name is often a deliberately shorter one.
 *
 * SO THE REPAIR IS THE OTHER HALF, and it is the half that actually costs something. Of 61
 * drifted pages only **11 are linked from anywhere at all** - 36 linking pages between them.
 * Those links are rewritten to `[[File Name|Title]]`: the target resolves by basename, which is
 * the only thing Obsidian resolves by, and the reader still sees the page's own title. Nothing
 * is renamed, no title is invented, and the other 50 pages are left exactly as they are because
 * nothing is broken about them - they diverge, and no link depends on it.
 */
export function titleLinkPass(vaultRoot: string): RepairPass {
  const drift = planTitleDrift(vaultRoot, wikiPages(vaultRoot)).filter((d) => d.linkedFrom.length > 0)
  /** Linking page -> the rewrites it needs. */
  const byPage = new Map<string, Array<{ title: string; fileName: string }>>()
  for (const d of drift) {
    for (const rel of d.linkedFrom) {
      const list = byPage.get(rel)
      const entry = { title: d.title, fileName: d.fileName }
      if (list === undefined) byPage.set(rel, [entry])
      else list.push(entry)
    }
  }

  return (rel, markdown) => {
    const rewrites = byPage.get(rel)
    if (rewrites === undefined) return null
    let after = markdown
    let n = 0
    for (const { title, fileName } of rewrites) {
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Three shapes, and only these: a bare link, one that already carries display text, and
      // one with a heading anchor. An embed (`![[...]]`) is left alone - a missing image is a
      // broken picture, not a link to repoint.
      after = after.replace(new RegExp(`(^|[^!])\\[\\[${escaped}\\]\\]`, 'g'), (_m, lead: string) => {
        n++
        return `${lead}[[${fileName}|${title}]]`
      })
      after = after.replace(new RegExp(`(^|[^!])\\[\\[${escaped}\\|`, 'g'), (_m, lead: string) => {
        n++
        return `${lead}[[${fileName}|`
      })
      after = after.replace(new RegExp(`(^|[^!])\\[\\[${escaped}#`, 'g'), (_m, lead: string) => {
        n++
        return `${lead}[[${fileName}#`
      })
    }
    if (n === 0 || after === markdown) return null
    return { after, why: `${n} link(s) repointed from a title its file name cannot carry` }
  }
}

/* ------------------------------------------------- the bucket hubs, regrouped (2.7 / 8.1) */

/**
 * The `_index.md` bucket hubs: keep every description, group them by subject (2.7, applied
 * in 8.1).
 *
 * WHAT THESE PAGES ACTUALLY ARE, because the plan and the first reading of it both got this
 * wrong. They look like event logs - 394 headings across three files, most of them of the form
 * `## mRNA Delivery (new domain, 2026-07-17)` - and the plan called for dropping the dated
 * sections and generating a page list in their place. Measured before doing it: those sections
 * hold **1129 entries and every single one carries a hand-written one-line description**,
 * covering 595 of 604 concepts, 327 of 338 sources and 206 of 225 entities. Deleting them
 * would have been the largest content loss of this whole phase, and the text exists nowhere
 * else.
 *
 * So the defect is not the content, it is the ORGANISATION: the hub is grouped by the ingest
 * that happened to write each entry, which is the vault's history rather than its subject.
 * A reader looking for what the vault holds on a topic has to know when it arrived.
 *
 * WHAT THIS DOES. Every `- [[Page]] description` line is kept verbatim and re-filed under the
 * page's own `domain:`, in the same domain order the index uses. The dates leave the headings
 * because a domain is not an event. Pages the hub never listed are appended to their domain
 * with no description - a gap a person or a later run can fill, and visible rather than
 * silent. A page listed twice keeps its longer description.
 *
 * WHAT IT DOES NOT DO. It writes no description, edits none, and drops none - not even one
 * whose link no longer resolves, because that is a record of what was there. The page's head,
 * its frontmatter and everything above the first `##` survive byte for byte.
 */
export function bucketRegroupPass(vaultRoot: string): RepairPass {
  const { pages } = collectPages(vaultRoot)
  const byName = new Map(pages.map((p) => [p.name.toLowerCase(), p]))
  const order = readDomainRegistry(vaultRoot)?.domains.map((d) => d.key) ?? []

  return (rel, markdown) => {
    const m = /^wiki\/([^/]+)\/_index\.md$/.exec(rel)
    if (m === null) return null
    const bucket = m[1]!
    const firstHead = markdown.search(/^## /m)
    if (firstHead < 0) return null
    const head = markdown.slice(0, firstHead).replace(/\s+$/, '')

    /** Every entry, in the order it was written, first mention winning. */
    const entries = new Map<string, { line: string; page: HubPage | undefined }>()
    for (const line of markdown.slice(firstHead).split(/\r?\n/)) {
      const item = /^- \[\[([^\]|#]+)(?:[^\]]*)\]\]/.exec(line)
      if (item === null) continue
      const target = item[1]!.trim()
      const key = target.toLowerCase()
      const clean = line.replace(/\s+$/, '')
      // A page listed twice keeps the LONGER description rather than the first. Both were
      // written by runs and neither is authoritative; the longer one carries more, and
      // "whichever came first" is a coin toss dressed as a rule.
      const seen = entries.get(key)
      if (seen !== undefined && seen.line.length >= clean.length) continue
      entries.set(key, { line: clean, page: byName.get(key) })
    }
    if (entries.size === 0) return null

    const inBucket = pages.filter((p) => p.bucket === bucket)
    const listed = new Set(entries.keys())
    const missing = inBucket.filter((p) => !listed.has(p.name.toLowerCase()))

    const grouped = new Map<string, string[]>()
    const add = (domain: string, line: string): void => {
      const list = grouped.get(domain)
      if (list === undefined) grouped.set(domain, [line])
      else list.push(line)
    }
    for (const { line, page } of entries.values()) add(page?.domain ?? UNASSIGNED, line)
    for (const p of missing.sort(sortPages)) add(p.domain, `- ${pageLink(p)}`)

    const out = [head, '']
    for (const domain of orderDomains([...grouped.keys()], order)) {
      const lines = grouped.get(domain) ?? []
      out.push(`## ${domain} (${lines.length})`, '')
      out.push(...lines)
      out.push('')
    }
    const after = `${out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`
    if (after === markdown) return null
    return {
      after,
      why:
        `${entries.size} description(s) kept, regrouped into ${grouped.size} domain(s)` +
        (missing.length > 0 ? `, ${missing.length} unlisted page(s) added` : ''),
    }
  }
}
