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

export const demoSeedPass: RepairPass = (rel, markdown) => {
  if (rel.startsWith('wiki/meta/') || rel.endsWith('/_index.md')) return null
  const fm = markdown.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (fm === null) return null
  const front = fm[2]!
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
