/**
 * Restore the address on source pages that lost one (2026-09-09).
 *
 * A source page records where its document came from in its `url:` frontmatter - the field the
 * vault's own source schema gives it. The dedupe index reads that field, and the reading list
 * resolves an entry to a page through it, so a page without it cannot answer "is this document
 * already here?".
 *
 * Two things can go wrong, and this repairs both:
 *
 *   - the field is missing or empty, on a page whose ingest DID know the address;
 *   - the field holds something that is not an address: a sentence about the file with the real
 *     address in brackets inside it, or a placeholder word.
 *
 * The addresses come from evidence, never from a guess, on two routes ordered by certainty:
 *
 *   git   - the vault's own ingest commit for that page has the address as its subject
 *           (`ingest: https://...`). Followed through renames. This route is verified against
 *           itself: on every page that already carries an address AND has such a commit, the
 *           two agree - 32 of 32 when this was written, 0 disagreements.
 *   list  - exactly one reading-list entry's url contains a fragment the page itself states
 *           (a bracketed host/path, or the filename of its `.raw/` document). Ranked above
 *           `field` for a specific reason: the match REQUIRES the page's fragment to sit
 *           inside the entry's url, so what comes back is the same address, complete. The
 *           field route can only return the fragment, which may be missing a `www.` or a
 *           trailing path segment - and the duplicate check compares literally.
 *   field - the page's own `url:` value contains a `host/path` in brackets. Promoting that to a
 *           real address rearranges what the page already states; it adds nothing.
 *
 * Dry run by default. `--apply` writes through `PUT /api/v1/pages`, which is the one sanctioned
 * path for a non-agent vault mutation (CLAUDE.md hard rule 1): the service holds the commit
 * mutex across check-and-write, so each page becomes one revertable commit that can never
 * interleave with an agent's.
 *
 *   npx tsx src/cli/backfill-sources.ts --vault ~/vault
 *   npx tsx src/cli/backfill-sources.ts --vault ~/vault --apply
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { READING_LIST_PAGE, parseReadingList, urlFileName } from '../pipeline/reading-list.js'

export interface Repair {
  /** Vault-relative page path. */
  readonly page: string
  /** The value sitting in `url:` now, or null when the page has no such key. */
  readonly before: string | null
  readonly after: string
  readonly via: 'git' | 'list' | 'field'
}

/** The frontmatter block of a page, without its `---` fences. */
function frontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return ''
  const end = markdown.indexOf('\n---', 3)
  return end < 0 ? '' : markdown.slice(3, end)
}

/** The raw `url:` value, unquoted; null when the page has no `url:` key at all. */
export function urlField(markdown: string): string | null {
  const m = /^url:[ \t]*(.*)$/m.exec(frontmatter(markdown))
  return m === null ? null : (m[1] ?? '').trim().replace(/^["']|["']$/g, '')
}

/**
 * Whether a `url:` value is an address the dedupe index can actually match on. It compares the
 * field literally, so "readable by a human" is not the bar: only a bare address clears it.
 */
export function isUsableAddress(value: string | null): boolean {
  return value !== null && /^https?:\/\/\S+$/.test(value)
}

/**
 * An address hiding inside a non-address value, e.g.
 * `local file: .raw/<job>/x.pdf (example.org/media/123)`. Only a bracketed `host/path` counts:
 * a bare word with a dot in it is as likely to be a filename as a host.
 */
export function addressInside(value: string | null): string | undefined {
  if (value === null || isUsableAddress(value)) return undefined
  const m = /\(((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s)]+)\)/i.exec(value)
  return m ? `https://${m[1]!}` : undefined
}

/** Separates hash from subject in the log format: a byte no commit subject can contain. */
const SEP = '\x01'

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })

/**
 * Every source page that exists at HEAD, mapped to the subject of the commit that ADDED it.
 *
 * Walked oldest-first with rename detection on, so a page that was retitled after its ingest
 * keeps the origin of the file it was renamed from. Without that the retitled pages silently
 * drop out of the mapping, which is a miss rather than a wrong answer, but a needless one.
 */
export function originSubjects(vaultRoot: string): Map<string, string> {
  const log = git(vaultRoot, [
    'log',
    '--reverse',
    `--format=%H${SEP}%s`,
    '--name-status',
    '-M',
    '--diff-filter=ARD',
    '--',
    'wiki/sources',
  ])
  const alive = new Map<string, string>()
  let subject: string | null = null
  for (const line of log.split('\n')) {
    if (line.includes(SEP)) {
      subject = line.split(SEP)[1] ?? null
      continue
    }
    if (line.trim() === '' || subject === null) continue
    const parts = line.split('\t')
    const status = (parts[0] ?? '')[0]
    const last = parts[parts.length - 1] ?? ''
    if (status === 'A' && last.startsWith('wiki/sources/')) alive.set(last, subject)
    else if (status === 'R' && parts.length >= 3) {
      const [, from, to] = parts as [string, string, string]
      const carried = alive.get(from)
      if (carried !== undefined) {
        alive.delete(from)
        alive.set(to, carried)
      } else if (to.startsWith('wiki/sources/')) {
        if (!alive.has(to)) alive.set(to, subject)
      }
    } else if (status === 'D') alive.delete(last)
  }
  return alive
}

/** The address an `ingest: <url>` commit subject carries, if it is one. */
export function subjectAddress(subject: string): string | undefined {
  const m = /^ingest:\s*(https?:\/\/\S+)$/.exec(subject.trim())
  return m ? m[1]! : undefined
}

/** Every source page at HEAD, vault-relative, `_index.md` excluded. */
function sourcePages(vaultRoot: string): string[] {
  const dir = path.join(vaultRoot, 'wiki', 'sources')
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(vaultRoot, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) walk(child)
      else if (e.name.endsWith('.md') && e.name !== '_index.md') out.push(child)
    }
  }
  walk('wiki/sources')
  return out.sort()
}

export interface Survey {
  readonly usable: number
  readonly nothingToRecover: number
  readonly repairs: readonly Repair[]
}

/**
 * Addresses on the reading list, for the `list` route. Empty when the page does not exist -
 * a vault with no reading list simply loses that route.
 */
function readingAddresses(vaultRoot: string): string[] {
  const file = path.join(vaultRoot, READING_LIST_PAGE)
  if (!fs.existsSync(file)) return []
  return parseReadingList(fs.readFileSync(file, 'utf8')).map((e) => e.url)
}

/**
 * The one reading-list address that a fragment of this page points at, or undefined.
 *
 * Two fragments are tried: a bracketed `host/path` the page states, and the filename of the
 * `.raw/` document it names - a browser names a download after the last segment of the url it
 * came from, which is what makes the second one evidence rather than coincidence.
 *
 * Two matches are not evidence, so an ambiguous fragment returns nothing.
 */
export function addressFromReadingList(value: string | null, addresses: readonly string[]): string | undefined {
  if (value === null || isUsableAddress(value)) return undefined
  const host = /\(((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s)]+)\)/i.exec(value)?.[1]?.toLowerCase()
  const file = /\.raw\/[^\s)]*\/([^\s/)]+\.[a-z0-9]{2,4})/i.exec(value)?.[1]?.toLowerCase()
  for (const [kind, fragment] of [
    ['host', host],
    ['file', file],
  ] as const) {
    if (fragment === undefined) continue
    const hits = addresses.filter((a) =>
      kind === 'host' ? a.toLowerCase().includes(fragment) : urlFileName(a) === fragment,
    )
    if (hits.length === 1) return hits[0]!
  }
  return undefined
}

/** What the vault holds now, and what evidence exists for the pages that lost their address. */
export function survey(vaultRoot: string): Survey {
  const origins = originSubjects(vaultRoot)
  const addresses = readingAddresses(vaultRoot)
  const repairs: Repair[] = []
  let usable = 0
  let nothing = 0
  for (const page of sourcePages(vaultRoot)) {
    const markdown = fs.readFileSync(path.join(vaultRoot, page), 'utf8')
    const before = urlField(markdown)
    if (isUsableAddress(before)) {
      usable++
      continue
    }
    const subject = origins.get(page)
    const fromGit = subject === undefined ? undefined : subjectAddress(subject)
    const fromList = addressFromReadingList(before, addresses)
    const fromField = addressInside(before)
    if (fromGit !== undefined) repairs.push({ page, before, after: fromGit, via: 'git' })
    else if (fromList !== undefined) repairs.push({ page, before, after: fromList, via: 'list' })
    else if (fromField !== undefined) repairs.push({ page, before, after: fromField, via: 'field' })
    else nothing++
  }
  return { usable, nothingToRecover: nothing, repairs }
}

/**
 * The page with its `url:` set to `address`, and nothing else touched.
 *
 * A page that has no `url:` key gets one where the schema puts it: after `date_published:`,
 * falling back to `source_type:` and then `title:`. Returns undefined when even the last
 * anchor is missing rather than inventing a position - a page that shapeless is one to look at
 * by hand.
 */
export function withAddress(markdown: string, address: string): string | undefined {
  const line = `url: "${address}"`
  if (urlField(markdown) !== null) return markdown.replace(/^url:[ \t]*.*$/m, line)
  const end = markdown.indexOf('\n---', 3)
  if (!markdown.startsWith('---') || end < 0) return undefined
  const head = markdown.slice(0, end)
  for (const anchor of [/^date_published:.*$/m, /^source_type:.*$/m, /^title:.*$/m]) {
    const m = anchor.exec(head)
    if (m) {
      const at = m.index + m[0].length
      return `${markdown.slice(0, at)}\n${line}${markdown.slice(at)}`
    }
  }
  return undefined
}

/**
 * The safety check on a rewrite: exactly one line differs, and it is the `url:` line.
 *
 * The tool edits frontmatter in a file it did not write, through regexes over text. This is
 * what stands between a regex that matched more than it should and a committed page whose body
 * quietly changed.
 */
export function touchesOnlyUrl(before: string, after: string): boolean {
  const a = before.split('\n')
  const b = after.split('\n')
  if (Math.abs(a.length - b.length) > 1) return false
  const changed: string[] = []
  for (let i = 0, j = 0; i < a.length || j < b.length; ) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (b.length > a.length) changed.push(b[j++] ?? '')
    else if (a.length > b.length) changed.push(a[i++] ?? '')
    else {
      changed.push(a[i] ?? '', b[j] ?? '')
      i++
      j++
    }
    if (changed.length > 2) return false
  }
  return changed.length > 0 && changed.every((l) => /^url:/.test(l.trim()))
}

interface Args {
  readonly vault: string
  readonly api: string
  readonly apply: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
  }
  const port = process.env['PORT'] ?? '8421'
  return {
    vault: path.resolve(get('vault', process.env['VAULT_ROOT'] ?? '~/vault').replace(/^~/, os.homedir())),
    api: get('api', `http://127.0.0.1:${port}`),
    apply: argv.includes('--apply'),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const { usable, nothingToRecover, repairs } = survey(args.vault)

  process.stdout.write(
    `${usable} source page(s) already carry an address, ${nothingToRecover} never had one to carry, ` +
      `${repairs.length} can be repaired\n\n`,
  )

  const skipped: string[] = []
  const planned: Array<Repair & { readonly markdown: string }> = []
  for (const r of repairs) {
    const file = path.join(args.vault, r.page)
    const before = fs.readFileSync(file, 'utf8')
    const after = withAddress(before, r.after)
    if (after === undefined || !touchesOnlyUrl(before, after)) {
      skipped.push(r.page)
      continue
    }
    planned.push({ ...r, markdown: after })
    process.stdout.write(`  ${path.basename(r.page)}\n`)
    process.stdout.write(`    - ${r.before === null ? '(no url: key)' : `url: ${r.before}`}\n`)
    process.stdout.write(`    + url: "${r.after}"   [${r.via}]\n`)
  }
  for (const page of skipped) process.stdout.write(`  SKIPPED (shape not recognised): ${page}\n`)

  if (!args.apply) {
    process.stdout.write(`\ndry run - nothing written. Re-run with --apply to write ${planned.length} page(s).\n`)
    return
  }

  process.stdout.write(`\nwriting ${planned.length} page(s) via ${args.api}/api/v1/pages\n`)
  let ok = 0
  for (const p of planned) {
    const baseMtime = fs.statSync(path.join(args.vault, p.page)).mtime.toISOString()
    const res = await fetch(`${args.api}/api/v1/pages`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p.page, markdown: p.markdown, baseMtime }),
    })
    const body = (await res.json()) as { commit?: string | null; error?: string }
    if (res.ok) {
      ok++
      process.stdout.write(`  ok   ${path.basename(p.page)}  ${body.commit ?? '(no commit)'}\n`)
    } else {
      process.stdout.write(`  FAIL ${path.basename(p.page)}  ${res.status} ${body.error ?? ''}\n`)
    }
  }
  process.stdout.write(`\n${ok}/${planned.length} written\n`)
}

if (process.argv[1]?.endsWith('backfill-sources.ts') === true || process.argv[1]?.endsWith('backfill-sources.js') === true) {
  void main()
}
