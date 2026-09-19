/**
 * The one-off repair of existing vault content (phase 8 of the vault-layer work).
 *
 *   npm run vaultrepair                      # dry run, every pass, over VAULT_ROOT
 *   npm run vaultrepair -- --pass em-dash    # one pass
 *   npm run vaultrepair -- --pass em-dash --diff 3   # with three sample diffs
 *   npm run vaultrepair -- --pass em-dash --apply    # write it, one commit
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
  type RepairPass,
  type RepairPlan,
} from '../pipeline/repair.js'
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
  const chosen = only === undefined ? PASSES : PASSES.filter((p) => p.name === only)
  if (chosen.length === 0) {
    console.error(`no such pass: ${only}. Known: ${PASSES.map((p) => p.name).join(', ')}`)
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
  if (only === undefined) reportTitleDrift(vaultRoot)
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
