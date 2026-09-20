/**
 * The open-question audit (docs/tasks/TASKS-QUESTIONS.md, phase 0).
 *
 *   npm run questionaudit -- ~/vault              # the table
 *   npm run questionaudit -- ~/vault --json       # machine-readable, for diffing two runs
 *   npm run questionaudit -- ~/vault --json --redact   # counts only: the committable form
 *   npm run questionaudit -- ~/vault --samples 6  # example bullets per form, local only
 *
 * It measures what the pinboard is made of: how many open questions stand on the vault's
 * pages, how many of them actually ask something, how many refer to the run that wrote them,
 * how long they are against the two caps a topic collides with, and how many say the same
 * thing on more than one page. Phases 3 and 5 are judged against these numbers, which is the
 * whole reason it is written before them.
 *
 * READ-ONLY. It opens files and prints; it writes nothing, anywhere, ever.
 *
 * Three things it deliberately does not own:
 *   - what a question IS. That is `parseQuestionBullets` in `pipeline/questions.ts`, the same
 *     parser the board reads with, so an audit and a board can never disagree about a bullet.
 *   - how two questions are compared. That is `scopeScore` in `pipeline/planner.ts`, over
 *     `tokenize` from `pipeline/related-pages.ts`: the measure the planner already judges
 *     topics with. A second similarity measure would be a second opinion nobody asked for.
 *   - what counts as a defect. That is `pipeline/question-form.ts`, shared with the prompt
 *     rule and the validator rule that come later.
 *
 * Scope note: this walks every `.md` under `wiki/`, while the BOARD shows the graph's
 * knowledge pages plus the notebooks of living Fellows. The file set here is the superset and
 * is the stable thing to measure - it does not move when a Fellow is retired or the flag is
 * off. Expect the board's own count to sit at or below these numbers.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseQuestionBullets } from '../pipeline/questions.js'
import { classifyQuestion, passDeixisIn, PASS_DEIXIS, type QuestionForm } from '../pipeline/question-form.js'
import { scopeScore, FIELD_CAPS } from '../pipeline/planner.js'
import { TITLE_MAX_CHARS } from '../pipeline/research-profiles.js'

/**
 * Overlap at or above which two bullets are read as the same question.
 *
 * 0.7 over `scopeScore`'s coefficient. Chosen the way `dedupe-judge.ts` argues thresholds
 * should be: low enough to catch the shape this vault actually produces - one run writing the
 * same open item onto its notebook, its synthesis page and the concept page it touched, in
 * three wordings - and high enough that a narrower follow-up on a subject stays its own
 * question. The audit prints the clusters so the number can be re-argued against real output.
 */
export const CLUSTER_THRESHOLD = 0.7

/** One bullet, with where it stands. */
export interface AuditBullet {
  readonly text: string
  readonly archived: boolean
  /** Vault-relative POSIX path. */
  readonly page: string
  /** Top-level bucket under `wiki/`: concepts, entities, sources, meta, questions, root. */
  readonly bucket: string
}

/** A set of bullets that read as one question, as indices into the list handed in. */
export type QuestionCluster = readonly number[]

/** Every `.md` under `wiki/`, vault-relative, sorted so two runs list them in one order. */
export function listWikiPages(vaultRoot: string): string[] {
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
      else if (e.name.endsWith('.md')) out.push(path.relative(vaultRoot, abs).split(path.sep).join('/'))
    }
  }
  walk(path.join(vaultRoot, 'wiki'))
  return out.sort()
}

/** The bucket a page sits in: its first directory under `wiki/`, or `root` for `wiki/*.md`. */
export function bucketOf(relPath: string): string {
  const parts = relPath.split('/')
  return parts.length > 2 ? parts[1]! : 'root'
}

/** Every open-question bullet on every wiki page, in page order. */
export function collectBullets(vaultRoot: string): AuditBullet[] {
  const out: AuditBullet[] = []
  for (const rel of listWikiPages(vaultRoot)) {
    let markdown: string
    try {
      markdown = fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
    } catch {
      continue
    }
    for (const b of parseQuestionBullets(markdown)) {
      out.push({ text: b.text, archived: b.archived, page: rel, bucket: bucketOf(rel) })
    }
  }
  return out
}

/**
 * Groups bullets that read as the same question, by transitive closure over pairs at or above
 * {@link CLUSTER_THRESHOLD}. Returns only the groups with more than one member, largest first;
 * a question that stands alone is not a cluster.
 */
export function clusterQuestions(texts: readonly string[], threshold = CLUSTER_THRESHOLD): QuestionCluster[] {
  const parent = texts.map((_, i) => i)
  const find = (x: number): number => {
    let root = x
    while (parent[root] !== root) root = parent[root]!
    // Path compression, so a long chain of near-duplicates stays cheap to resolve.
    let cur = x
    while (parent[cur] !== root) {
      const next = parent[cur]!
      parent[cur] = root
      cur = next
    }
    return root
  }
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (find(i) === find(j)) continue
      if (scopeScore(texts[i]!, texts[j]!) >= threshold) parent[find(i)] = find(j)
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < texts.length; i++) {
    const root = find(i)
    const g = groups.get(root)
    if (g) g.push(i)
    else groups.set(root, [i])
  }
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length || a[0]! - b[0]!)
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) * p)]!

export interface AuditReport {
  readonly takenAt: string
  readonly vaultRoot?: string
  readonly pagesScanned: number
  readonly pagesWithQuestions: number
  readonly bullets: { readonly total: number; readonly open: number; readonly archived: number }
  readonly form: Readonly<Record<QuestionForm, number>>
  readonly deixis: { readonly total: number; readonly byPhrase: Readonly<Record<string, number>> }
  readonly length: {
    readonly min: number
    readonly p50: number
    readonly p90: number
    readonly max: number
    readonly titleCap: number
    readonly overTitleCap: number
    readonly topicCap: number
    readonly overTopicCap: number
  }
  readonly clusters: {
    readonly threshold: number
    readonly count: number
    readonly questionsCovered: number
    readonly crossPage: number
    readonly distinctAfterClustering: number
  }
  readonly byBucket: Readonly<Record<string, number>>
  /** Only without `--redact`: the clusters themselves, for reading. */
  readonly clusterMembers?: ReadonlyArray<ReadonlyArray<{ readonly page: string; readonly text: string }>>
}

/** Everything the report says, computed from a vault path. Reads files, writes nothing. */
export function auditQuestions(vaultRoot: string, now = new Date()): AuditReport {
  const pages = listWikiPages(vaultRoot)
  const bullets = collectBullets(vaultRoot)
  const open = bullets.filter((b) => !b.archived)

  const form: Record<QuestionForm, number> = { question: 0, limitation: 0, statement: 0 }
  for (const b of open) form[classifyQuestion(b.text)]++

  const byPhrase: Record<string, number> = {}
  for (const d of PASS_DEIXIS) byPhrase[d.name] = 0
  let deictic = 0
  for (const b of open) {
    const hits = passDeixisIn(b.text)
    if (hits.length > 0) deictic++
    for (const h of hits) byPhrase[h] = (byPhrase[h] ?? 0) + 1
  }

  const lengths = open.map((b) => b.text.length).sort((a, b) => a - b)
  const byBucket: Record<string, number> = {}
  for (const b of open) byBucket[b.bucket] = (byBucket[b.bucket] ?? 0) + 1

  const clusters = clusterQuestions(open.map((b) => b.text))
  const covered = clusters.reduce((n, g) => n + g.length, 0)
  const crossPage = clusters.filter((g) => new Set(g.map((i) => open[i]!.page)).size > 1).length

  return {
    takenAt: now.toISOString().slice(0, 10),
    pagesScanned: pages.length,
    pagesWithQuestions: new Set(bullets.map((b) => b.page)).size,
    bullets: { total: bullets.length, open: open.length, archived: bullets.length - open.length },
    form,
    deixis: { total: deictic, byPhrase },
    length: {
      min: lengths[0] ?? 0,
      p50: percentile(lengths, 0.5),
      p90: percentile(lengths, 0.9),
      max: lengths[lengths.length - 1] ?? 0,
      titleCap: TITLE_MAX_CHARS,
      overTitleCap: open.filter((b) => b.text.length > TITLE_MAX_CHARS).length,
      topicCap: FIELD_CAPS.topic,
      overTopicCap: open.filter((b) => b.text.length > FIELD_CAPS.topic).length,
    },
    clusters: {
      threshold: CLUSTER_THRESHOLD,
      count: clusters.length,
      questionsCovered: covered,
      crossPage,
      distinctAfterClustering: open.length - covered + clusters.length,
    },
    byBucket,
    clusterMembers: clusters.map((g) => g.map((i) => ({ page: open[i]!.page, text: open[i]!.text }))),
  }
}

/** The committable form: counts only, no page path and no question text (hard rule 7). */
export function redact({ vaultRoot: _vaultRoot, clusterMembers: _members, ...rest }: AuditReport): AuditReport {
  return rest
}

const pct = (n: number, of: number): string => (of === 0 ? '0 %' : `${Math.round((n / of) * 100)} %`)

function printReport(report: AuditReport, bullets: readonly AuditBullet[], samples: number): void {
  const open = report.bullets.open
  console.log(`Open questions, ${report.takenAt}`)
  console.log(`  pages scanned        ${report.pagesScanned}`)
  console.log(`  pages with questions ${report.pagesWithQuestions}`)
  console.log(`  bullets              ${report.bullets.total} (open ${open}, archived ${report.bullets.archived})`)
  console.log('')
  console.log('Form')
  console.log(`  asks a question      ${report.form.question} (${pct(report.form.question, open)})`)
  console.log(`  limitation note      ${report.form.limitation} (${pct(report.form.limitation, open)})`)
  console.log(`  other statement      ${report.form.statement} (${pct(report.form.statement, open)})`)
  console.log('')
  console.log('Pass-relative deixis')
  console.log(`  carrying any         ${report.deixis.total} (${pct(report.deixis.total, open)})`)
  for (const [name, n] of Object.entries(report.deixis.byPhrase).sort((a, b) => b[1] - a[1])) {
    if (n > 0) console.log(`    ${name.padEnd(20)} ${n}`)
  }
  console.log('')
  console.log('Length in characters')
  console.log(`  min / p50 / p90 / max  ${report.length.min} / ${report.length.p50} / ${report.length.p90} / ${report.length.max}`)
  console.log(`  over title cap (${report.length.titleCap})    ${report.length.overTitleCap} (${pct(report.length.overTitleCap, open)})`)
  console.log(`  over topic cap (${report.length.topicCap})    ${report.length.overTopicCap} (${pct(report.length.overTopicCap, open)})`)
  console.log('')
  console.log(`Near-duplicates (overlap >= ${report.clusters.threshold})`)
  console.log(`  clusters             ${report.clusters.count}, covering ${report.clusters.questionsCovered} questions`)
  console.log(`  spanning >1 page     ${report.clusters.crossPage}`)
  console.log(`  distinct after       ${report.clusters.distinctAfterClustering}`)
  console.log('')
  console.log('By bucket')
  for (const [bucket, n] of Object.entries(report.byBucket).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${bucket.padEnd(20)} ${n}`)
  }
  if (samples > 0) {
    const openBullets = bullets.filter((b) => !b.archived)
    for (const f of ['question', 'limitation', 'statement'] as const) {
      console.log(`\nSamples: ${f}`)
      for (const b of openBullets.filter((b) => classifyQuestion(b.text) === f).slice(0, samples)) {
        console.log(`  [${String(b.text.length).padStart(3)}] ${b.text.slice(0, 160)}`)
      }
    }
    for (const g of (report.clusterMembers ?? []).slice(0, 3)) {
      console.log(`\nSample cluster (${g.length} copies on ${new Set(g.map((m) => m.page)).size} pages)`)
      for (const m of g) console.log(`  ${m.page}\n    ${m.text.slice(0, 160)}`)
    }
  }
}

function main(): number {
  const argv = process.argv.slice(2)
  const flag = (name: string): boolean => argv.includes(name)
  const valueOf = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--samples')
  /*
   * `npm run` executes inside the workspace, so a relative path would resolve against
   * `server/` rather than against where it was typed. npm hands the original directory over in
   * INIT_CWD; without npm (a bare `tsx`), the cwd is already the right one.
   */
  const from = process.env.INIT_CWD ?? process.cwd()
  const vaultRoot = path.resolve(from, positional[0] ?? process.env.VAULT_ROOT ?? '')
  if (positional[0] === undefined && (process.env.VAULT_ROOT ?? '') === '') {
    console.error('usage: npm run questionaudit -- <vault path> [--json] [--redact] [--samples N]')
    return 2
  }
  if (!fs.existsSync(path.join(vaultRoot, 'wiki'))) {
    console.error(`no wiki/ under ${vaultRoot}`)
    return 2
  }

  const report = auditQuestions(vaultRoot)
  if (flag('--json')) {
    const out = flag('--redact') ? redact(report) : { ...report, vaultRoot }
    console.log(JSON.stringify(out, null, 2))
    return 0
  }
  printReport(report, collectBullets(vaultRoot), Number(valueOf('--samples') ?? 0))
  return 0
}

/*
 * Only when run as a CLI. The exports above are what the tests read, and a module that runs
 * its own `main()` on import would take the test process with it.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
