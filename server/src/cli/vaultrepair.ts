/**
 * The one-off repair of existing vault content (phase 8 of the vault-layer work).
 *
 *   npm run vaultrepair                      # dry run, every pass, over VAULT_ROOT
 *   npm run vaultrepair -- --pass em-dash    # one pass
 *   npm run vaultrepair -- --pass em-dash --diff 3   # with three sample diffs
 *   npm run vaultrepair -- --pass em-dash --apply    # write it, one commit
 *   npm run vaultrepair -- --pass hubs --with-buckets  # also insert the bucket page lists
 *
 * **A DRY RUN IS THE DEFAULT AND `--apply` IS THE ONLY WAY PAST IT.** Every pass here rewrites
 * pages a person wrote months ago, in bulk, by rule, so the summary comes first and the diff
 * is meant to be read before anything is written.
 *
 * What applying does, in the order hard rule 1 states: take the vault's own per-file lock on
 * every page the pass touches (foreign), then the commit inside it (ours), then ONE commit for
 * the whole pass with a mechanism-only message. A page somebody else is writing is skipped
 * rather than waited for - that is the vault's own guidance for a held lock.
 *
 * What no pass does: delete a page, rename one, merge two, or rewrite prose. Those are the
 * user's decisions (docs/tasks/TASKS-VAULT-LAYER.md, phase 8's rules).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  planRepair,
  applyRepair,
  diffOf,
  wikiPages,
  planTitleDrift,
  emDashPass,
  tagMirrorPass,
  runProtocolPass,
  demoSeedPass,
  dashLinkPass,
  overviewPass,
  tagSingletonPass,
  recordSectionPass,
  titleLinkPass,
  type RepairPass,
  type RepairPlan,
} from '../pipeline/repair.js'
import { planManifestRepair, planLogArchive } from '../pipeline/repair.js'
import { renderIndex, renderOverviewCounters, updateOverview, renderBucketPages, updateBucketHub, bucketHubs } from '../pipeline/hubs.js'
import { withWikiLocks } from '../pipeline/wiki-lock.js'
import { commitPaths } from '../pipeline/git.js'

/**
 * The passes, in the order phase 8 runs them. Each is one commit.
 *
 * `run` takes the vault root because one of them has to read the whole page set before it can
 * decide anything: repointing a link needs to know which pages exist.
 */
const PASSES: ReadonlyArray<{ name: string; task: string; run: (vaultRoot: string) => RepairPass; subject: string }> = [
  {
    name: 'dash-link',
    task: '8.2',
    run: dashLinkPass,
    subject: 'repair: repoint links that differ from a page only in the dash',
  },
  {
    name: 'tag-mirror',
    task: '8.4',
    run: () => tagMirrorPass,
    subject: 'repair: drop tags that repeat a page’s own type or domain',
  },
  {
    name: 'run-protocol',
    task: '8.5',
    run: () => runProtocolPass,
    subject: 'repair: move run bookkeeping out of the articles',
  },
  {
    name: 'em-dash',
    task: '8.6',
    run: () => emDashPass,
    subject: 'repair: replace em-dashes and en-dashes outside code',
  },
  {
    name: 'demo-seed',
    task: '8.7',
    run: () => demoSeedPass,
    subject: 'repair: mark the upstream demo pages as what they are',
  },
  {
    name: 'title-link',
    task: '8.2',
    run: titleLinkPass,
    subject: 'repair: repoint links written from a title a file name cannot carry',
  },
  {
    name: 'record-section',
    task: '8.5',
    run: () => recordSectionPass,
    subject: 'repair: move the run record to the foot of the page',
  },
  {
    name: 'tag-singleton',
    task: '8.4',
    run: tagSingletonPass,
    subject: 'repair: drop tags that name exactly one page',
  },
  {
    name: 'overview',
    task: '2.6 / 8.1',
    run: () => overviewPass,
    subject: 'repair: drop the overview sections that are counted or logged elsewhere',
  },
]

const kB = (n: number): string => `${Math.round(n / 100) / 10} kB`

function summarise(plan: RepairPlan, diffs: number): void {
  const bytes = plan.edits.reduce((sum, e) => sum + (e.before.length - e.after.length), 0)
  console.log(`\n${plan.pass}: ${plan.edits.length} page(s) would change, ${kB(bytes)} smaller`)
  const reasons = new Map<string, number>()
  for (const e of plan.edits) {
    const key = e.why.replace(/\d+/g, 'N').replace(/:.*/, '')
    reasons.set(key, (reasons.get(key) ?? 0) + 1)
  }
  for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`  ${String(n).padStart(4)}  ${why}`)
  }
  if (plan.skipped.length > 0) console.log(`  ${plan.skipped.length} page(s) skipped: ${plan.skipped[0]?.why}`)
  for (const edit of plan.edits.slice(0, diffs)) {
    console.log(`\n--- ${edit.rel}  (${edit.why})`)
    console.log(diffOf(edit).split('\n').slice(0, 14).join('\n'))
  }
}

/** The title-drift report (8.2). Reported rather than applied: it rewrites two ends at once. */
function reportTitleDrift(vaultRoot: string): void {
  const drift = planTitleDrift(vaultRoot, wikiPages(vaultRoot))
  const links = drift.reduce((sum, d) => sum + d.linkedFrom.length, 0)
  console.log(`\ntitle-drift (8.2): ${drift.length} page(s) whose title their file name cannot carry, linked from ${links} page(s)`)
  for (const d of [...drift].sort((a, b) => b.linkedFrom.length - a.linkedFrom.length).slice(0, 5)) {
    console.log(`  ${String(d.linkedFrom.length).padStart(3)} link(s)  ${d.rel}`)
  }
  console.log('  (reported only: repairing it rewrites the title AND every link, which is one commit of its own)')
}

async function apply(vaultRoot: string, plan: RepairPlan, subject: string): Promise<number> {
  if (plan.edits.length === 0) {
    console.log('nothing to apply')
    return 0
  }
  const rels = plan.edits.map((e) => e.rel)
  const result = await withWikiLocks(vaultRoot, rels, async (held, busy) => {
    if (busy.length > 0) console.log(`skipping ${busy.length} page(s) somebody else is writing`)
    const mine: RepairPlan = { ...plan, edits: plan.edits.filter((e) => held.includes(e.rel)) }
    const { written, stale } = applyRepair(vaultRoot, mine)
    if (stale.length > 0) console.log(`skipping ${stale.length} page(s) that changed since the plan was made`)
    if (written.length === 0) return { written, commit: undefined }
    const commit = await commitPaths(vaultRoot, subject, written)
    return { written, commit }
  })
  console.log(`wrote ${result.written.length} page(s)` + (result.commit?.hash ? `, commit ${result.commit.hash.slice(0, 8)}` : ', not committed'))
  return 0
}

/**
 * 8.3: the address map, both directions. Not a page pass - it writes one JSON file - so it has
 * its own plan-and-apply, with the same rule: report first, write only with `--apply`.
 */
async function addressMap(vaultRoot: string, wantApply: boolean): Promise<void> {
  const plan = planManifestRepair(vaultRoot)
  console.log(`\naddress-map (8.3): ${plan.added.length} page(s) to add, ${plan.droppedPages.length} stale pages_created to drop`)
  if (plan.unnamedDirs.length > 0) {
    console.log(`  ${plan.unnamedDirs.length} job director(ies) named in no source entry - reported, never invented:`)
    console.log(`    ${plan.unnamedDirs.slice(0, 6).join(', ')}${plan.unnamedDirs.length > 6 ? ', ...' : ''}`)
  }
  if (plan.after === null) {
    console.log('  nothing to change')
    return
  }
  if (!wantApply) return
  const rel = '.raw/.manifest.json'
  fs.writeFileSync(path.join(vaultRoot, rel), plan.after, 'utf8')
  const commit = await commitPaths(vaultRoot, 'repair: record every addressed page in the address map', [rel])
  console.log(`  wrote ${rel}${commit.hash ? `, commit ${commit.hash.slice(0, 8)}` : ', not committed'}`)
}

/**
 * 8.1: the hubs, rendered by the same code that keeps them current after every run.
 *
 * The bucket hubs are the one place this passes `create: true`: their marker region does not
 * exist yet, and inserting it is exactly what this one-off is for (see `updateBucketHub`).
 */
async function hubs(vaultRoot: string, wantApply: boolean, withBuckets = false): Promise<void> {
  const planned: Array<{ rel: string; before: string; after: string }> = []
  const read = (rel: string): string => {
    try {
      return fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
    } catch {
      return ''
    }
  }
  const index = read('wiki/index.md')
  planned.push({ rel: 'wiki/index.md', before: index, after: renderIndex(vaultRoot) })
  const overview = read('wiki/overview.md')
  planned.push({ rel: 'wiki/overview.md', before: overview, after: updateOverview(overview, renderOverviewCounters(vaultRoot)) })
  /*
   * THE BUCKET HUBS ARE OPT-IN, and the dry run over the live vault is why (2026-09-19).
   *
   * Inserting the generated page list into them adds 83 kB: `concepts/_index.md` 153 to 187,
   * `sources/_index.md` 123 to 164. Nothing is removed in exchange, because what is already
   * in those files is the curated one-line description per page, which no generator can
   * produce and which this work is forbidden to throw away.
   *
   * And the value the region would add - "every page of this bucket is reachable" - is already
   * delivered for the WHOLE vault by the generated `index.md`, at a fifth of the size the old
   * one had. A second copy per bucket buys nothing and costs exactly the kind of hub bloat
   * this phase exists to remove.
   *
   * The mechanism stays: where a marker region exists, every run keeps it current. It is only
   * the one-off INSERTION that is a judgement, and the judgement is no.
   */
  if (withBuckets) {
    for (const rel of bucketHubs(vaultRoot)) {
      const bucket = rel.split('/')[1] ?? ''
      const before = read(rel)
      planned.push({ rel, before, after: updateBucketHub(before, renderBucketPages(vaultRoot, bucket), bucket, { create: true }) })
    }
  }
  const changed = planned.filter((p) => p.after !== p.before)
  console.log(`\nhubs (8.1): ${changed.length} hub file(s) would change`)
  for (const p of changed) {
    const delta = p.after.length - p.before.length
    console.log(`  ${p.rel.padEnd(28)} ${Math.round(p.before.length / 100) / 10} kB -> ${Math.round(p.after.length / 100) / 10} kB (${delta > 0 ? '+' : ''}${Math.round(delta / 100) / 10} kB)`)
  }
  if (!wantApply || changed.length === 0) return
  const written = await withWikiLocks(vaultRoot, changed.map((p) => p.rel), async (held, busy) => {
    if (busy.length > 0) console.log(`  skipping ${busy.length} hub(s) somebody else is writing`)
    const mine = changed.filter((p) => held.includes(p.rel))
    for (const p of mine) fs.writeFileSync(path.join(vaultRoot, p.rel), p.after, 'utf8')
    if (mine.length === 0) return []
    const commit = await commitPaths(vaultRoot, 'repair: regenerate the hub layer from the pages themselves', mine.map((p) => p.rel))
    console.log(`  wrote ${mine.length} hub file(s)${commit.hash ? `, commit ${commit.hash.slice(0, 8)}` : ', not committed'}`)
    return mine.map((p) => p.rel)
  })
  void written
}

/**
 * 8.8: the operation log, bounded. Last of the phase, and only safe because nothing decides a
 * job's status from this file any more (2.4).
 */
async function logArchive(vaultRoot: string, wantApply: boolean): Promise<void> {
  const before = (() => {
    try {
      return fs.readFileSync(path.join(vaultRoot, 'wiki/log.md'), 'utf8').length
    } catch {
      return 0
    }
  })()
  const plan = planLogArchive(vaultRoot)
  if (plan.log === null) {
    console.log(`\nlog-archive (8.8): ${plan.kept} entries, nothing to archive`)
    return
  }
  console.log(`\nlog-archive (8.8): keeping ${plan.kept} entries, archiving ${plan.archived} into ${plan.archives.length} page(s)`)
  console.log(`  wiki/log.md  ${Math.round(before / 100) / 10} kB -> ${Math.round(plan.log.length / 100) / 10} kB`)
  for (const a of plan.archives) {
    console.log(`  ${a.rel.padEnd(28)} ${a.entries} entries, ${Math.round(a.content.length / 100) / 10} kB`)
  }
  if (!wantApply) return
  const paths = ['wiki/log.md', ...plan.archives.map((a) => a.rel)]
  await withWikiLocks(vaultRoot, paths, async (held, busy) => {
    if (busy.length > 0) {
      console.log(`  another writer holds ${busy.join(', ')} - not archiving`)
      return
    }
    void held
    fs.mkdirSync(path.join(vaultRoot, 'wiki/folds'), { recursive: true })
    for (const a of plan.archives) fs.writeFileSync(path.join(vaultRoot, a.rel), a.content, 'utf8')
    fs.writeFileSync(path.join(vaultRoot, 'wiki/log.md'), plan.log!, 'utf8')
    const commit = await commitPaths(vaultRoot, 'repair: archive the older log entries by month', paths)
    console.log(`  wrote ${paths.length} file(s)${commit.hash ? `, commit ${commit.hash.slice(0, 8)}` : ', not committed'}`)
  })
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const valueOf = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const vaultRoot = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true)
    ?? process.env['VAULT_ROOT']
    ?? path.join(os.homedir(), 'vault')
  if (!fs.existsSync(path.join(vaultRoot, 'wiki'))) {
    console.error(`no wiki/ under ${vaultRoot} - not a vault`)
    return 2
  }
  const only = valueOf('--pass')
  const diffs = Number(valueOf('--diff') ?? 0) || 0
  const wantApply = args.includes('--apply')

  console.log(`vaultrepair: ${vaultRoot}${wantApply ? '  (APPLYING)' : '  (dry run)'}`)
  // The two passes that are not page passes: one writes a JSON file, one writes the hubs.
  if (only === 'address-map') {
    await addressMap(vaultRoot, wantApply)
    if (!wantApply) console.log('\nnothing was written. Add --apply to run it for real.')
    return 0
  }
  if (only === 'log-archive') {
    await logArchive(vaultRoot, wantApply)
    if (!wantApply) console.log('\nnothing was written. Add --apply to run it for real.')
    return 0
  }
  if (only === 'hubs') {
    await hubs(vaultRoot, wantApply, args.includes('--with-buckets'))
    if (!wantApply) console.log('\nnothing was written. Add --apply to run it for real.')
    return 0
  }
  const chosen = only === undefined ? PASSES : PASSES.filter((p) => p.name === only)
  if (chosen.length === 0) {
    console.error(`no such pass: ${only}. Known: ${[...PASSES.map((p) => p.name), 'address-map', 'hubs', 'log-archive'].join(', ')}`)
    return 2
  }

  for (const pass of chosen) {
    const plan = planRepair(vaultRoot, `${pass.name} (${pass.task})`, pass.run(vaultRoot))
    summarise(plan, diffs)
    if (wantApply) {
      const code = await apply(vaultRoot, plan, pass.subject)
      if (code !== 0) return code
    }
  }
  if (only === undefined) {
    await addressMap(vaultRoot, wantApply)
    await hubs(vaultRoot, wantApply)
    await logArchive(vaultRoot, wantApply)
    reportTitleDrift(vaultRoot)
  }
  if (!wantApply) console.log('\nnothing was written. Add --apply to run it for real.')
  return 0
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main()
    .then((c) => process.exit(c))
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
