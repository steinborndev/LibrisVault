#!/usr/bin/env node
/**
 * One-off repair of the `title:` line on the meta pages this service writes itself
 * (2026-09-21). Read-only unless `--apply` is passed.
 *
 *   node scripts/fix-meta-page-titles.mjs ~/vault            # report
 *   node scripts/fix-meta-page-titles.mjs ~/vault --apply    # write and commit once
 *
 * WHY THIS EXISTS. `pipeline/notebook.ts` wrote `title: "Fellow: Ada"` onto a page filed as
 * `ada.md`, and `pipeline/recap.ts` wrote `title: "Recap: 2026-09-15"` onto `Recap
 * 2026-09-15.md`. A file name cannot carry a colon, so every wikilink an agent writes from
 * such a title resolves to nothing. Both writers are fixed; the pages they already wrote are
 * not, and a lint-fix run would otherwise be handed them as a mechanical defect and could
 * repair them the wrong way round, by renaming the file. Both paths are COMPUTED
 * (`notebookPath(slug)`, `recapPath(date)`), so a rename would leave the writer creating a
 * second page on its next run.
 *
 * It also lifts `status: active` on a notebook to `developing`: `active` is outside the
 * vocabulary the vault uses (seed, developing, mature, evergreen, retired).
 *
 * Scope is deliberately tiny: the frontmatter `title:` line, the first `# ` heading, and a
 * notebook's `status:` line. Nothing else in the file is touched, no file is renamed, no page
 * outside `wiki/meta/agents/` and `wiki/meta/recaps/` is read. The vault's own per-file lock
 * is taken around each write when the vault carries `scripts/wiki-lock.sh`, and the whole set
 * lands as one commit, the same way every other writer behaves.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const vault = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(process.env.HOME ?? '', 'vault'))

if (!fs.existsSync(path.join(vault, 'wiki'))) {
  console.error(`not a vault: ${vault}`)
  process.exit(2)
}

const LOCK = 'scripts/wiki-lock.sh'
const hasLock = fs.existsSync(path.join(vault, LOCK))
const git = (...a) => execFileSync('git', ['-C', vault, ...a], { encoding: 'utf8' }).trim()

/** The title each page should carry: the file name it is filed as, minus the extension. */
const wantTitle = (rel) => path.basename(rel, '.md')

/** A notebook is filed as `<slug>.md` but reads as its Fellow's name, e.g. `ada.md` -> `Ada`. */
const notebookTitle = (rel, current) => {
  const name = current.replace(/^Fellow:\s*/i, '').trim()
  return name === '' ? wantTitle(rel) : name
}

const dirs = [
  { rel: 'wiki/meta/agents', title: notebookTitle, status: true },
  { rel: 'wiki/meta/recaps', title: (rel) => wantTitle(rel), status: false },
]

const UNSAFE = /[/\\:?*"<>|]/
const changes = []

for (const d of dirs) {
  const abs = path.join(vault, d.rel)
  if (!fs.existsSync(abs)) continue
  for (const name of fs.readdirSync(abs).filter((f) => f.endsWith('.md')).sort()) {
    const rel = `${d.rel}/${name}`
    const text = fs.readFileSync(path.join(vault, rel), 'utf8')
    const titleLine = /^title:\s*"?(.*?)"?\s*$/m.exec(text)
    if (titleLine === null) continue
    const current = titleLine[1]
    const edits = []
    let next = text

    if (UNSAFE.test(current)) {
      const wanted = d.title(rel, current)
      next = next.replace(titleLine[0], `title: "${wanted}"`)
      // The body heading repeats the title, and an agent linking the page reads that first.
      const h1 = new RegExp(`^# ${current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
      if (h1.test(next)) next = next.replace(h1, `# ${wanted}`)
      edits.push(`title "${current}" -> "${wanted}"`)
    }
    if (d.status) {
      const st = /^status:\s*active\s*$/m.exec(next)
      if (st !== null) {
        next = next.replace(st[0], 'status: developing')
        edits.push('status active -> developing')
      }
    }
    if (edits.length > 0) changes.push({ rel, next, edits })
  }
}

if (changes.length === 0) {
  console.log('nothing to repair.')
  process.exit(0)
}

for (const c of changes) console.log(`${c.rel}\n  ${c.edits.join('\n  ')}`)
console.log(`\n${changes.length} page(s)${apply ? '' : ' - dry run, pass --apply to write'}`)
if (!apply) process.exit(0)

const dirty = git('status', '--short')
if (dirty !== '') {
  console.error(`vault has uncommitted changes; commit or stash them first:\n${dirty}`)
  process.exit(3)
}

for (const c of changes) {
  const write = () => fs.writeFileSync(path.join(vault, c.rel), c.next)
  if (!hasLock) {
    write()
    continue
  }
  // Same contract as the service's own writers: take the vault's per-file lock, always release.
  const code = (a) => {
    try {
      execFileSync(path.join(vault, LOCK), a, { cwd: vault, stdio: 'pipe' })
      return 0
    } catch (err) {
      return typeof err.status === 'number' ? err.status : 1
    }
  }
  const acquired = code(['acquire', '--stale-after-sec', '900', c.rel])
  if (acquired === 75) {
    console.error(`page is locked by another writer, stopping: ${c.rel}`)
    process.exit(4)
  }
  try {
    write()
  } finally {
    if (acquired === 0) code(['release', c.rel])
  }
}

git('add', '--', ...changes.map((c) => c.rel))
git('commit', '-m', 'fix: title the service-written meta pages as the files they are filed as')
console.log(`\ncommitted ${git('log', '-1', '--format=%h %s')}`)
