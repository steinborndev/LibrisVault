import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue, type IngestRunner } from '../src/pipeline/queue.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/index.js'

/**
 * The hub layer, wired (SPEC.md §12.12, decision D2): after a run that wrote a page, the
 * service writes the index and the log entry into that run's OWN commit.
 *
 * Real git and the real queue. What is asserted is the shape of the commit, because that is
 * what the design promises: one run, one commit, containing the pages and the hubs and nothing
 * else - and a hub write that fails leaving the run finished all the same.
 */
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

const NO_TOOLS: ToolAvailability = {
  pdftotext: false,
  pdfinfo: false,
  ocrmypdf: false,
  pandoc: false,
  python3: false,
  exiftool: false,
  defuddle: false,
  ytDlp: false,
  deno: false,
}

let db: Db
let store: JobStore
let vaultRoot: string
let srcDir: string

const seedPage = (rel: string, title: string, domain: string): void => {
  const abs = path.join(vaultRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(
    abs,
    `---\ntype: concept\ntitle: "${title}"\ndomain: ${domain}\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: seed\ntags:\n  - concept\n---\n\n# ${title}\n`,
  )
}

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hubwire-'))
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubsrc-'))
  git(vaultRoot, 'init', '-q')
  git(vaultRoot, 'config', 'user.email', 't@t')
  git(vaultRoot, 'config', 'user.name', 't')
  git(vaultRoot, 'config', 'commit.gpgsign', 'false')
  fs.mkdirSync(path.join(vaultRoot, '.raw'), { recursive: true })
  seedPage('wiki/concepts/Existing.md', 'Existing', 'physics')
  fs.writeFileSync(path.join(vaultRoot, 'wiki/index.md'), '# Index\n')
  fs.writeFileSync(path.join(vaultRoot, 'wiki/log.md'), '# Operation Log\n')
  git(vaultRoot, 'add', '-A')
  git(vaultRoot, 'commit', '-q', '-m', 'init')
})

afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
  fs.rmSync(srcDir, { recursive: true, force: true })
})

/** A run that writes one page and reports it, the way the real agent does. */
const writesOnePage = (name: string): IngestRunner => async (opts) => {
  const page = path.join(vaultRoot, 'wiki', 'concepts', `${name}.md`)
  fs.mkdirSync(path.dirname(page), { recursive: true })
  fs.writeFileSync(
    page,
    `---\ntype: concept\ntitle: "${name}"\ndomain: physics\ncreated: 2026-02-02\nupdated: 2026-02-02\nstatus: seed\ntags:\n  - concept\n---\n\n# ${name}\n`,
  )
  opts.onMessage({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: page } }] },
  } as never)
  return {
    ok: true,
    result: `Filed ${name} under physics and left the rest alone.`,
    usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
    durationMs: 1,
    numTurns: 1,
    sessionId: 's',
    timedOut: false,
  }
}

/** A run that writes nothing at all - the "no changes" outcome. */
const writesNothing: IngestRunner = async () => ({
  ok: true,
  result: 'Nothing new here: the vault already covers this.',
  usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
  durationMs: 1,
  numTurns: 1,
  sessionId: 's',
  timedOut: false,
})

const queueWith = (runIngest: IngestRunner): IngestQueue =>
  new IngestQueue({
    store,
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    concurrency: 1,
    detectToolsFn: async () => NO_TOOLS,
    refreshHotCache: async () => 'noop',
    runIngest,
  })

const ingestOne = async (queue: IngestQueue, body: string): Promise<string> => {
  const src = path.join(srcDir, `${Math.random().toString(36).slice(2)}.md`)
  fs.writeFileSync(src, body)
  const { job } = await queue.enqueueFile({ sourcePath: src, source: 'drop' })
  await queue.onIdle()
  return job.id
}

describe('the hub layer, in a run\'s own commit', () => {
  it('writes the index and the log entry into the same commit as the pages', async () => {
    const queue = queueWith(writesOnePage('Tide Table'))
    queue.start()
    const id = await ingestOne(queue, '# Tide tables\n\nA note about harmonic constants.\n')
    expect(store.getOrThrow(id).status).toBe('done')

    const head = git(vaultRoot, 'log', '-1', '--format=%H').trim()
    const files = git(vaultRoot, 'show', '--name-only', '--pretty=format:', head).trim().split('\n')
    expect(files).toContain('wiki/concepts/Tide Table.md')
    expect(files).toContain('wiki/index.md')
    expect(files).toContain('wiki/log.md')
    // One run, one commit: the hubs did not arrive in a second one.
    expect(git(vaultRoot, 'log', '--format=%s').trim().split('\n').filter((l) => l.startsWith('ingest:'))).toHaveLength(1)
    expect(git(vaultRoot, 'status', '--porcelain').trim()).toBe('')

    const index = fs.readFileSync(path.join(vaultRoot, 'wiki/index.md'), 'utf8')
    expect(index).toContain('[[Tide Table]]')
    expect(index).toContain('[[Existing]]')
    const log = fs.readFileSync(path.join(vaultRoot, 'wiki/log.md'), 'utf8')
    expect(log).toContain('] ingest | ')
    expect(log).toContain('- Pages created: [[Tide Table]]')
    // The run's own account of itself is the entry's paragraph - no new agent contract.
    expect(log).toContain('Filed Tide Table under physics')
  })

  it('names the .raw source, which is what crash recovery keys on', async () => {
    const queue = queueWith(writesOnePage('Another'))
    queue.start()
    const id = await ingestOne(queue, '# Another\n\nDistinct body.\n')
    expect(fs.readFileSync(path.join(vaultRoot, 'wiki/log.md'), 'utf8')).toContain(`- Source: \`.raw/${id}`)
  })

  it('leaves the hubs untouched when the run wrote no page', async () => {
    const queue = queueWith(writesNothing)
    queue.start()
    const before = {
      index: fs.readFileSync(path.join(vaultRoot, 'wiki/index.md'), 'utf8'),
      log: fs.readFileSync(path.join(vaultRoot, 'wiki/log.md'), 'utf8'),
    }
    await ingestOne(queue, '# Nothing new\n\nAlready covered.\n')
    expect(fs.readFileSync(path.join(vaultRoot, 'wiki/index.md'), 'utf8')).toBe(before.index)
    expect(fs.readFileSync(path.join(vaultRoot, 'wiki/log.md'), 'utf8')).toBe(before.log)
  })

  it('finishes the run when a hub write fails, and says so', async () => {
    const queue = queueWith(writesOnePage('Unwritable'))
    queue.start()
    // The log is a directory: every write to it throws, the way a permission problem would.
    fs.rmSync(path.join(vaultRoot, 'wiki/log.md'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki/log.md'))
    const id = await ingestOne(queue, '# Unwritable\n\nBody.\n')

    // Loud and non-fatal: the pages are what matters, and the next run regenerates the index.
    expect(store.getOrThrow(id).status).toBe('done')
    const logs = store.logs(id).map((l) => `${l.level}:${l.message}`)
    expect(logs.some((l) => l.startsWith('warn:') && l.includes('log entry could not be written'))).toBe(true)
    const head = git(vaultRoot, 'log', '-1', '--format=%H').trim()
    expect(git(vaultRoot, 'show', '--name-only', '--pretty=format:', head)).toContain('wiki/concepts/Unwritable.md')
  })

  it('writes no second copy of an index that did not change', async () => {
    const queue = queueWith(writesOnePage('Once'))
    queue.start()
    await ingestOne(queue, '# Once\n\nBody.\n')
    const first = git(vaultRoot, 'log', '-1', '--format=%H').trim()
    // A second run that writes the same page changes nothing about the catalog, so the
    // regenerated index is byte-identical and never reaches the commit.
    const again = queueWith(writesOnePage('Once'))
    again.start()
    await ingestOne(again, '# Once again\n\nA different body, same page.\n')
    const second = git(vaultRoot, 'log', '-1', '--format=%H').trim()
    expect(second).not.toBe(first)
    expect(git(vaultRoot, 'show', '--name-only', '--pretty=format:', second)).not.toContain('wiki/index.md')
  })

  it('takes the vault lock before the commit mutex, and releases it after', async () => {
    /*
     * Foreign-then-ours (hard rule 1): the vault's own per-file lock is taken OUTSIDE our
     * commit mutex and released after it. Asserted on the real call SEQUENCE - the lock script
     * and the commit both append to one file - because an order mistake here is a deadlock or
     * a race, and neither shows up in a green unit test that only checks the outcome.
     */
    const trace = path.join(srcDir, 'trace.txt')
    const lockScript = path.join(vaultRoot, 'scripts', 'wiki-lock.sh')
    fs.mkdirSync(path.dirname(lockScript), { recursive: true })
    fs.writeFileSync(
      lockScript,
      `#!/usr/bin/env bash\ncmd="$1"; shift\nwhile [ $# -gt 1 ]; do case "$1" in --stale-after-sec) shift 2 ;; *) break ;; esac; done\nprintf '%s %s\\n' "$cmd" "$1" >> ${JSON.stringify(trace)}\nexit 0\n`,
      { mode: 0o755 },
    )

    const queue = new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 1,
      detectToolsFn: async () => NO_TOOLS,
      refreshHotCache: async () => 'noop',
      runIngest: writesOnePage('Ordered'),
      commit: async (root, message, opts) => {
        fs.appendFileSync(trace, 'commit -\n')
        const { commitVault } = await import('../src/pipeline/git.js')
        return commitVault(root, message, opts)
      },
    })
    queue.start()
    await ingestOne(queue, '# Ordered\n\nBody.\n')

    const steps = fs.readFileSync(trace, 'utf8').trim().split('\n')
    const verbs = steps.map((l) => l.split(' ')[0])
    const commitAt = verbs.indexOf('commit')
    expect(commitAt).toBeGreaterThan(0)
    // Every acquire happens before the commit, every release after it.
    expect(verbs.slice(0, commitAt).every((v) => v === 'acquire')).toBe(true)
    expect(verbs.slice(commitAt + 1).every((v) => v === 'release')).toBe(true)
    /*
     * What is locked: the three hubs the service owns, AND the content pages the run wrote.
     * The pages joined the list when `content_updated:` started being stamped after a run
     * (SPEC.md §12.13) - that write needs the same protection as the hub write, and it has to
     * be acquired out here, because hard rule 1 puts every foreign lock outside our mutex.
     */
    const locked = steps.filter((l) => l.startsWith('acquire ')).map((l) => l.slice('acquire '.length)).sort()
    expect(locked).toEqual(['wiki/concepts/Ordered.md', 'wiki/index.md', 'wiki/log.md', 'wiki/overview.md'])
    expect(steps.filter((l) => l.startsWith('release ')).length).toBe(locked.length)
  })
})
