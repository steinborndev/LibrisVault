/**
 * Graph snapshots through the vault's own history, for a growth timelapse.
 *
 * The graph API has no creation timestamp: a node carries `mtimeMs`, which is when the page
 * was last CHANGED. A page written in April and edited yesterday would date from yesterday,
 * which is the wrong way round for a timelapse. Git has the right answer and a better one:
 * the whole state of the vault at any commit, so the edges grow with the nodes instead of
 * nodes popping into a finished web.
 *
 * How it works: one throwaway worktree is checked out at each sampled commit and the ordinary
 * `GraphBuilder` runs against it. Nothing here reimplements the graph - the frames are what
 * the app itself would have drawn on those days.
 *
 * Sampling is by PAGE COUNT, not by time. This vault grew 47 pages in April, 3 in May and
 * 450 in August; sampled evenly over time, a third of the film would be an empty screen.
 *
 *   npx tsx src/cli/graph-timelapse.ts --vault ~/vault --out /tmp/frames [--steps 140]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { GraphBuilder } from '../pipeline/graph.js'

interface Args {
  readonly vault: string
  readonly out: string
  readonly steps: number
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string, fallback?: string): string => {
    const i = argv.indexOf(`--${name}`)
    if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1]!
    if (fallback !== undefined) return fallback
    throw new Error(`missing --${name}`)
  }
  return {
    vault: path.resolve(get('vault').replace(/^~/, os.homedir())),
    out: path.resolve(get('out').replace(/^~/, os.homedir())),
    steps: Number(get('steps', '140')),
  }
}

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** Commits that changed a wiki page, oldest first, with the page count each one left behind. */
function historyByPages(vault: string): Array<{ sha: string; date: string; pages: number }> {
  const shas = git(vault, ['log', '--format=%H %aI', '--reverse', '--', 'wiki'])
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [sha, date] = l.split(' ')
      return { sha: sha!, date: date! }
    })
  const out: Array<{ sha: string; date: string; pages: number }> = []
  for (const c of shas) {
    // `ls-tree` at the commit is the page count without checking anything out.
    const listed = git(vault, ['ls-tree', '-r', '--name-only', c.sha, 'wiki']).split('\n')
    out.push({ ...c, pages: listed.filter((p) => p.endsWith('.md')).length })
  }
  return out
}

/**
 * `steps` commits spread evenly over the PAGE axis: each frame adds about the same number of
 * pages, so a quiet month passes quickly and a busy week gets the screen time it earned.
 * The first and last commits are always in.
 */
function sampleByPages(history: ReadonlyArray<{ sha: string; date: string; pages: number }>, steps: number): typeof history {
  if (history.length <= steps) return history
  const total = history[history.length - 1]!.pages
  const picked: typeof history[number][] = []
  const seen = new Set<string>()
  for (let i = 0; i < steps; i++) {
    const want = (total * i) / (steps - 1)
    // The first commit that has reached this many pages.
    const hit = history.find((c) => c.pages >= want) ?? history[history.length - 1]!
    if (!seen.has(hit.sha)) {
      seen.add(hit.sha)
      picked.push(hit)
    }
  }
  const last = history[history.length - 1]!
  if (!seen.has(last.sha)) picked.push(last)
  return picked
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(args.out, { recursive: true })

  process.stdout.write('reading history…\n')
  const history = historyByPages(args.vault)
  const frames = sampleByPages(history, args.steps)
  process.stdout.write(
    `${history.length} commits touched wiki, ${history[history.length - 1]?.pages ?? 0} pages now; ` +
      `${frames.length} frames sampled by page count\n`,
  )

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'timelapse-wt-'))
  fs.rmdirSync(worktree)
  git(args.vault, ['worktree', 'add', '--detach', '-f', worktree, frames[0]!.sha])
  try {
    const index: Array<{ i: number; sha: string; date: string; nodes: number; edges: number }> = []
    frames.forEach((c, i) => {
      git(worktree, ['checkout', '-q', '--detach', c.sha])
      // A fresh builder per frame: its cache is keyed on mtime, and a checkout rewrites those.
      const graph = new GraphBuilder(worktree).build()
      const file = path.join(args.out, `${String(i).padStart(4, '0')}.json`)
      fs.writeFileSync(file, JSON.stringify(graph))
      index.push({ i, sha: c.sha.slice(0, 8), date: c.date, nodes: graph.nodes.length, edges: graph.edges.length })
      if (i % 10 === 0 || i === frames.length - 1) {
        process.stdout.write(`  ${i + 1}/${frames.length}  ${c.date.slice(0, 10)}  ${graph.nodes.length} nodes, ${graph.edges.length} edges\n`)
      }
    })
    fs.writeFileSync(path.join(args.out, 'index.json'), JSON.stringify(index, null, 1))
    process.stdout.write(`wrote ${index.length} frames to ${args.out}\n`)
  } finally {
    git(args.vault, ['worktree', 'remove', '--force', worktree])
  }
}

main()
