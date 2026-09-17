/**
 * Freeze a real research run so the demo vault can be rebuilt with it.
 *
 * The demo vault is regenerated from scratch by `demo-vault.mjs`, so anything an agent wrote
 * into it lives exactly until the next run of that script. The five research runs the demo
 * shows are real - they cost real money and took real minutes - and they have to survive that.
 *
 * This copies what a run left behind into `scripts/demo-research/<slug>/`:
 *
 *   run.json     the ledger row: topic, lens, pages, tokens, cost, start and finish
 *   pages/       every vault page the run wrote, at its vault-relative path
 *
 * The generator reads that directory back. Nothing here is edited by hand afterwards: a page
 * that gets touched stops being the run's output and starts being a fixture pretending to be
 * one, and the whole point of paying for these is that they are not that.
 *
 *   node scripts/capture-research-run.mjs <runId> [--slug NAME] [--db PATH] [--vault DIR]
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const runId = args.find((a) => !a.startsWith('--'))
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
if (!runId) {
  console.error('usage: node scripts/capture-research-run.mjs <runId> [--slug NAME] [--db PATH] [--vault DIR]')
  process.exit(1)
}

const DB = argOf('--db', join(homedir(), '.local/share/vault-service/demo-jobs.db'))
const VAULT = argOf('--vault', join(homedir(), '.local/share/vault-service/demo-vault'))
const OUT_ROOT = join(process.cwd(), 'scripts/demo-research')

const { default: Database } = await import('better-sqlite3')
const db = new Database(DB, { readonly: true })
const row = db
  .prepare(
    `SELECT id, kind, label, profile_key, model, ok, pages, tokens_in, tokens_out, cost_usd,
            started_at, finished_at, answer
       FROM agent_runs WHERE id = ?`,
  )
  .get(runId)
db.close()

if (!row) {
  console.error(`no run ${runId} in ${DB}`)
  process.exit(1)
}
if (!row.ok) {
  console.error(`run ${runId} did not succeed; nothing worth freezing`)
  process.exit(1)
}

const pages = JSON.parse(row.pages ?? '[]')
/*
 * The synthesis is what names the capture, because it is what the run was FOR. A run that
 * filed none is a failed run whatever its status column says (`isSynthesisPath` is the same
 * check the service makes), and freezing one would put a hole in the demo that only shows up
 * in a screenshot.
 */
const synthesis = pages.find((p) => p.startsWith('wiki/questions/Research: '))
if (!synthesis) {
  console.error(`run ${runId} filed no synthesis page; its ${pages.length} page(s) are not a result`)
  process.exit(1)
}

const slug =
  argOf('--slug', null) ??
  synthesis
    .slice('wiki/questions/Research: '.length, -'.md'.length)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)

const out = join(OUT_ROOT, slug)
if (existsSync(out)) rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'pages'), { recursive: true })

let copied = 0
let missing = 0
for (const rel of pages) {
  const src = join(VAULT, rel)
  if (!existsSync(src)) {
    // A page in the ledger the vault does not have: the run named it and something else
    // removed it, or it was never written. Worth a line rather than a silent short capture.
    console.warn(`  missing from the vault, skipped: ${rel}`)
    missing++
    continue
  }
  const dest = join(out, 'pages', rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync(src))
  copied++
}

writeFileSync(
  join(out, 'run.json'),
  JSON.stringify(
    {
      topic: row.label,
      profileKey: row.profile_key,
      kind: row.kind,
      model: row.model,
      pages,
      synthesis,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      costUsd: row.cost_usd,
      durationMs: Date.parse(row.finished_at) - Date.parse(row.started_at),
      answer: row.answer,
      capturedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
)

console.log(`captured ${slug}`)
console.log(`  ${copied} page(s)${missing ? `, ${missing} missing` : ''}`)
console.log(`  $${row.cost_usd}, ${Math.round((Date.parse(row.finished_at) - Date.parse(row.started_at)) / 1000)}s`)
console.log(`  -> scripts/demo-research/${slug}/`)
