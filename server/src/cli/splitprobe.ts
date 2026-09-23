/**
 * The split proposal for one domain of a real vault (docs/tasks/TASKS-DOMAIN-SPLIT.md 1.7).
 * Read-only like `vaultprobe`: it builds the graph, reads the pages' addresses and prints what
 * `GET /api/v1/domains/:key/split` would answer. It writes nothing, so it is safe against the
 * live vault.
 *
 *   npm run splitprobe -- <domain>                 # the proposal, as counts
 *   npm run splitprobe -- <domain> --stability     # plus five other seeds and the vault
 *                                                  # 3, 14 and 30 days back
 *   npm run splitprobe -- <domain> --names         # plus landmark titles and tags
 *   npm run splitprobe -- --vault <path> <domain>  # another vault than VAULT_ROOT
 *   npm run splitprobe -- <domain> --json          # the proposal and the stability cases as
 *                                                  # JSON, for scripts/e2e-domain-split.mjs
 *
 * The default output is counts, shares and fingerprints only, so it can be quoted into a task
 * file of this public repo (hard rule 7). `--names` prints vault text and is for the terminal.
 *
 * `--stability` replaces the analysis's throwaway scripts. Per case it prints the share of the
 * pages both proposals hold that land on another shelf (`shelfDrift`). "N days back" leaves out
 * every page whose freshness date (`content_updated:`, else `created:`) is newer than N days
 * ago; a page stating neither stays in.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { GraphBuilder } from '../pipeline/graph.js'
import { readAddresses } from '../pipeline/hubs.js'
import {
  CONSENSUS_SEED,
  proposeSplit,
  restrictGraph,
  shelfDrift,
  type SplitProposal,
} from '../pipeline/domain-split.js'

const DAY_MS = 24 * 60 * 60 * 1000
const pct = (x: number | null): string => (x === null ? '   -  ' : `${(x * 100).toFixed(1).padStart(5)}%`)
const short = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)

function printProposal(p: SplitProposal, names: boolean): void {
  console.log(`domain pages ${p.pages} · eligible ${p.eligible} · shelves ${p.shelves.length} · with parent ${p.totals.withParent}`)
  if (p.reason !== null) console.log(`reason: ${p.reason}`)
  if (p.shelves.length === 0) return
  console.log(`sizes: ${p.shelves.map((s) => s.size).sort((a, b) => b - a).join(', ')}`)
  console.log(
    `internal links ${p.totals.internalLinks} · untagged ${p.totals.untagged} · unaddressed ${p.unaddressed.length} · ` +
      `largest domain now ${pct(p.totals.largestNow.share).trim()} (${p.totals.largestNow.pages}), after promoting all ${pct(p.totals.largestAfter.share).trim()} (${p.totals.largestAfter.pages})`,
  )
  console.log('\nrank  size  ent  conduct  stabil  precis  recall  separ  misfile  confused  outside  fingerprint')
  for (const s of p.shelves) {
    console.log(
      `${String(s.rank).padStart(4)}  ${String(s.size).padStart(4)}  ${String(s.entities).padStart(3)}  ` +
        `${s.conductance.toFixed(3).padStart(7)}  ${s.stability.toFixed(3).padStart(6)}  ${pct(s.precision)}  ${pct(s.recall)}  ` +
        `${s.separability.toFixed(3).padStart(5)}  ${(s.misfile ? 'yes' : 'no').padStart(7)}  ` +
        `${s.confusedWith.map((c) => (c.with === 'rest' ? 'r' : String(c.with + 1))).join(',').padStart(8)}  ` +
        `${String(s.outsideNeighbours.count).padStart(7)}  ${short(s.fingerprint)}`,
    )
    if (names) {
      console.log(`        landmarks: ${s.landmarks.map((l) => l.title).join(' · ')}`)
      console.log(`        tags: ${s.tags.join(', ')}${s.topTagCollision ? `  (top tag inside ${s.topTagCollision.inside}, elsewhere ${s.topTagCollision.elsewhere})` : ''}`)
    }
  }
}

function main(): number {
  const args = process.argv.slice(2)
  const flag = (f: string): boolean => args.includes(f)
  const vaultAt = args.indexOf('--vault')
  const vaultRoot = vaultAt >= 0 && args[vaultAt + 1] ? args[vaultAt + 1]! : process.env['VAULT_ROOT'] ?? path.join(os.homedir(), 'vault')
  const domain = args.find((a, i) => !a.startsWith('--') && (vaultAt < 0 || i !== vaultAt + 1))
  if (domain === undefined) {
    console.error('usage: splitprobe <domain> [--stability] [--names] [--vault <path>]')
    return 2
  }
  if (!fs.existsSync(path.join(vaultRoot, 'wiki'))) {
    console.error(`no wiki/ under ${vaultRoot} - not a vault`)
    return 2
  }

  const graph = new GraphBuilder(vaultRoot).build()
  const paths = graph.nodes.filter((n) => n.domain === domain).map((n) => n.path)
  const addresses = readAddresses(vaultRoot, paths)

  const t0 = performance.now()
  const base = proposeSplit(graph, domain, addresses)
  const ms = performance.now() - t0
  const cases: Array<{ case: string; shelves: number; pages: number; common: number; moved: number; share: number }> = []
  if (flag('--stability') && base.shelves.length > 0) {
    for (let k = 1; k <= 5; k++) {
      const other = proposeSplit(graph, domain, addresses, { seed: CONSENSUS_SEED + k })
      cases.push({ case: `seed+${k}`, shelves: other.shelves.length, pages: other.pages, ...shelfDrift(base, other) })
    }
    const now = Date.now()
    for (const days of [3, 14, 30]) {
      const cut = now - days * DAY_MS
      const then = proposeSplit(restrictGraph(graph, (n) => n.freshMs === undefined || n.freshMs <= cut), domain, addresses)
      cases.push({ case: `${days}d`, shelves: then.shelves.length, pages: then.pages, ...shelfDrift(base, then) })
    }
  }
  if (flag('--json')) {
    // Vault text rides along (titles, tags): this is for a script on this machine, not for a file.
    console.log(JSON.stringify({ ms, proposal: base, stability: cases }))
    return 0
  }
  console.log(`splitprobe: ${vaultRoot} · ${graph.nodes.length} pages, ${graph.edges.length} links`)
  console.log(`one proposal: ${ms.toFixed(0)} ms\n`)
  printProposal(base, flag('--names'))

  if (cases.length > 0) {
    console.log('\nstability (share of common pages on another shelf):')
    for (const c of cases) {
      console.log(
        `  ${c.case.padEnd(8)}  shelves ${String(c.shelves).padStart(2)}  pages ${String(c.pages).padStart(4)}  moved ${String(c.moved).padStart(3)} of ${c.common}  ${pct(c.share)}`,
      )
    }
  }
  return 0
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
// exitCode rather than exit(): a large --json write to a pipe would be cut off mid-flush.
if (isDirectRun) process.exitCode = main()
