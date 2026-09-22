#!/usr/bin/env node
/**
 * The standing defect list, measured (docs/tasks/TASKS-DEFECT-PATHS.md, tasks 0.1 and 0.2).
 *
 *   node scripts/defect-measure.mjs                            # the table, from 127.0.0.1:8421
 *   node scripts/defect-measure.mjs --api http://127.0.0.1:8420
 *   node scripts/defect-measure.mjs --passes ~/vault           # what each exposed pass reaches
 *   node scripts/defect-measure.mjs --json                     # the same numbers, diffable
 *
 * WHY IT EXISTS. Every definition of done in the task file compares against section 0's table,
 * and a table produced by a shell pipeline in one session cannot be compared against the same
 * table five phases later, because the pipeline is gone. Same reasoning as `vault-audit.mjs`,
 * one layer up: this one reads the service rather than the vault.
 *
 * WHAT IT NEVER PRINTS. Aggregates only. A page title, a tag, a job id and a finding message
 * are all vault content, and this repo is public (CLAUDE.md hard rule 7). The bucket
 * distribution counts directories; nothing below a directory is ever named.
 *
 * WHAT IT WRITES. Nothing. `--passes` runs the repair CLI in its default DRY-RUN form, which
 * is read-only by construction (`--apply` is the only way past it, and this never passes it).
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const wantJson = args.includes('--json')

/**
 * The passes the dashboard exposes (task 3.1), plus the two the measurement showed reach
 * nothing, so the table can keep saying so rather than dropping them silently.
 */
const PASSES = ['em-dash', 'tag-mirror', 'tag-singleton', 'run-protocol', 'title-link', 'address-map']

/** Which bucket a finding's path belongs to, named by DIRECTORY and never below it. */
function bucketOf(p) {
  if (p.startsWith('.raw/')) return '.raw/<job-id>/'
  if (!p.startsWith('wiki/')) return 'other'
  const parts = p.split('/')
  if (parts.length <= 2) return `wiki/${parts[1] ?? ''}`
  return `wiki/${parts[1]}/`
}

async function table(base) {
  const res = await fetch(`${base}/api/v1/validation?limit=200`)
  if (!res.ok) throw new Error(`${base} answered ${res.status}`)
  const data = await res.json()
  const buckets = new Map()
  for (const f of data.findings) buckets.set(bucketOf(f.path), (buckets.get(bucketOf(f.path)) ?? 0) + 1)
  const seenTwice = data.findings.filter((f) => f.count > 1).length
  /*
   * The classification comes from the service, not from a copy kept here: `defect-paths.ts`
   * is exhaustive over the rule union at compile time and this file is not, so a second table
   * would drift the first time a rule is added.
   */
  const guidance = data.guidance ?? {}
  return {
    takenAt: new Date().toISOString(),
    api: base,
    total: data.total,
    listed: data.findings.length,
    rules: data.byRule.map((r) => ({
      rule: r.rule,
      findings: r.findings,
      occurrences: r.occurrences,
      path: guidance[r.rule]?.path ?? 'unknown',
    })),
    buckets: [...buckets].sort((a, b) => b[1] - a[1]).map(([bucket, n]) => ({ bucket, findings: n })),
    seenMoreThanOnce: seenTwice,
  }
}

/**
 * What each pass would change, from the repair CLI's own dry run. Parsed rather than
 * reimplemented: a second implementation of a pass would measure a different thing.
 */
function passes(vaultRoot) {
  const out = []
  for (const name of PASSES) {
    const run = spawnSync('npm', ['run', '--silent', 'vaultrepair', '--', '--pass', name], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
      env: { ...process.env, VAULT_ROOT: vaultRoot },
      encoding: 'utf8',
      timeout: 600_000,
    })
    const text = `${run.stdout ?? ''}${run.stderr ?? ''}`
    const pages = /(\d+) page\(s\) would change/.exec(text)
    const map = /(\d+) page\(s\) to add, (\d+) stale pages_created to drop, (\d+) retired address\(es\) to drop/.exec(text)
    const unnamed = /(\d+) job director\(ies\) named in no source entry/.exec(text)
    out.push({
      pass: name,
      ...(pages === null ? {} : { pagesWouldChange: Number(pages[1]) }),
      ...(map === null ? {} : { toAdd: Number(map[1]), staleToDrop: Number(map[2]), retiredToDrop: Number(map[3]) }),
      ...(unnamed === null ? {} : { unnamedJobDirs: Number(unnamed[1]) }),
      ...(pages === null && map === null ? { note: 'no count in the CLI output' } : {}),
    })
  }
  return out
}

function printTable(t) {
  console.log(`\nstanding defects: ${t.total} finding(s) (${t.api}, ${t.takenAt.slice(0, 19)}Z)\n`)
  console.log(`  ${'rule'.padEnd(22)} ${'findings'.padStart(8)} ${'occurrences'.padStart(11)}  path`)
  for (const r of t.rules) {
    console.log(`  ${r.rule.padEnd(22)} ${String(r.findings).padStart(8)} ${String(r.occurrences).padStart(11)}  ${r.path}`)
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${String(t.rules.reduce((s, r) => s + r.findings, 0)).padStart(8)} ${String(t.rules.reduce((s, r) => s + r.occurrences, 0)).padStart(11)}`)
  console.log('\n  where they stand:')
  for (const b of t.buckets) console.log(`    ${String(b.findings).padStart(4)}  ${b.bucket}`)
  console.log(`\n  ${t.seenMoreThanOnce} of ${t.listed} listed have been seen more than once`)
}

function printPasses(rows) {
  console.log('\nwhat a pass would reach (dry run, nothing written):\n')
  for (const r of rows) {
    if (r.pagesWouldChange !== undefined) console.log(`  ${r.pass.padEnd(16)} ${String(r.pagesWouldChange).padStart(4)} page(s) would change`)
    else if (r.toAdd !== undefined) {
      console.log(`  ${r.pass.padEnd(16)} ${r.toAdd} to add, ${r.staleToDrop} stale to drop, ${r.retiredToDrop} to retire` +
        (r.unnamedJobDirs === undefined ? '' : `; ${r.unnamedJobDirs} job director(ies) reported, never repaired`))
    } else console.log(`  ${r.pass.padEnd(16)} ${r.note}`)
  }
}

async function main() {
  const vaultRoot = valueOf('--passes', undefined)
  const out = {}
  if (!args.includes('--passes-only')) out.table = await table(valueOf('--api', 'http://127.0.0.1:8421'))
  if (vaultRoot !== undefined) {
    if (!existsSync(path.join(vaultRoot, 'wiki'))) throw new Error(`no wiki/ under ${vaultRoot} - not a vault`)
    out.passes = passes(vaultRoot)
  }
  if (wantJson) console.log(JSON.stringify(out, null, 2))
  else {
    if (out.table) printTable(out.table)
    if (out.passes) printPasses(out.passes)
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
})
