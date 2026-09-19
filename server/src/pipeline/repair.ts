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
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|https?:\/\/\S+)/)
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

export const runProtocolPass: RepairPass = (_rel, markdown) => {
  const heads = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm)]
  if (heads.length === 0) return null
  const cuts: Array<{ start: number; end: number; name: string }> = []
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
    cuts.push({ start: h.index!, end, name: hit[1] })
  }
  if (cuts.length === 0) return null
  let after = markdown
  for (const cut of [...cuts].sort((a, b) => b.start - a.start)) {
    after = after.slice(0, cut.start) + after.slice(cut.end)
  }
  return {
    after: after.replace(/\n{3,}/g, '\n\n'),
    why: `removed ${cuts.length} bookkeeping section(s): ${cuts.map((c) => c.name).join(', ')}`,
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
