import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue, classifyFailure, guessType, sanitizeOriginalName, type IngestRunner } from '../src/pipeline/queue.js'
import type { AgentRunResult } from '../src/pipeline/agent-runner.js'
import type { Validator } from '../src/pipeline/validator.js'
import { ReadingListService, parseReadingList, READING_LIST_PAGE } from '../src/pipeline/reading-list.js'
import { PreprocessError, type PreprocessResult, type ToolAvailability } from '../src/pipeline/preprocess/index.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

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

function okResult(over: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    ok: true,
    result: 'ingest done',
    usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.01 },
    durationMs: 1000,
    numTurns: 5,
    sessionId: 's1',
    timedOut: false,
    ...over,
  }
}
function failResult(error: string, over: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    ok: false,
    result: '',
    usage: { tokensIn: 5, tokensOut: 0, costUsd: 0 },
    durationMs: 100,
    numTurns: 1,
    sessionId: 's1',
    timedOut: false,
    error,
    ...over,
  }
}

let db: Db
let store: JobStore
let vaultRoot: string
let srcDir: string
let commitCalls: string[]
let commitPathspecs: string[][]
let pausedTimers: Array<() => void>

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'))
  commitCalls = []
  commitPathspecs = []
  pausedTimers = []
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
  fs.rmSync(srcDir, { recursive: true, force: true })
})

function writeSource(name: string, content = 'hello'): string {
  const p = path.join(srcDir, name)
  fs.writeFileSync(p, content)
  return p
}

interface QueueOverrides {
  runIngest?: IngestRunner
  concurrency?: number
  maxRetries?: number
  budgetExceeded?: () => boolean
  validate?: Validator
  reading?: ReadingListService
}

function makeQueue(over: QueueOverrides = {}): IngestQueue {
  return new IngestQueue({
    store,
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    concurrency: over.concurrency ?? 2,
    maxRetries: over.maxRetries ?? 2,
    detectToolsFn: async () => NO_TOOLS,
    commit: async (_root, message, opts) => {
      commitCalls.push(message)
      commitPathspecs.push([...(opts?.pathspec ?? [])])
      return { committed: true, hash: 'abcd1234ef', committedPages: ['wiki/concepts/Foo.md'] }
    },
    refreshHotCache: async () => 'hot cache noted',
    setTimeoutFn: (fn) => void pausedTimers.push(fn),
    runIngest: over.runIngest ?? (async () => okResult()),
    ...(over.budgetExceeded ? { budgetExceeded: over.budgetExceeded } : {}),
    ...(over.validate ? { validate: over.validate } : {}),
    ...(over.reading ? { reading: over.reading } : {}),
  })
}

describe('pure helpers', () => {
  it('guessType maps extensions', () => {
    expect(guessType('a.pdf')).toBe('pdf')
    expect(guessType('a.docx')).toBe('office')
    expect(guessType('a.png')).toBe('image')
    expect(guessType('a.mp3')).toBe('av')
    expect(guessType('a.zip')).toBe('other')
    expect(guessType('a.md')).toBe('text')
  })
  it('sanitizeOriginalName strips directories and traversal segments', () => {
    expect(sanitizeOriginalName('report.pdf')).toBe('report.pdf')
    expect(sanitizeOriginalName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeOriginalName('..\\..\\evil.txt')).toBe('evil.txt')
    expect(sanitizeOriginalName('dir/sub/x.md')).toBe('x.md')
    expect(sanitizeOriginalName('..')).toMatch(/^upload-/)
    expect(sanitizeOriginalName('')).toMatch(/^upload-/)
  })
  it('classifyFailure distinguishes rate-limit, transient and permanent', () => {
    expect(classifyFailure(failResult('rate limit exceeded (429)'))).toBe('rate_limit')
    expect(classifyFailure(failResult('fetch failed ECONNRESET'))).toBe('transient')
    expect(classifyFailure(okResult({ ok: false, timedOut: true }))).toBe('transient')
    expect(classifyFailure(failResult('run consumed zero tokens — auth failure'))).toBe('permanent')
  })
})

describe('system-prompt extension', () => {
  it('every ingest run carries the page-hygiene checklist and entity-notability rules', async () => {
    let extra = ''
    const q = makeQueue({
      runIngest: async (opts) => {
        extra = opts.systemPromptExtra ?? ''
        return okResult()
      },
    })
    q.start()
    await q.enqueueFile({ sourcePath: writeSource('note.md'), source: 'drop' })
    await q.onIdle()
    expect(extra).toContain('<page_hygiene>')
    expect(extra).toContain('<entity_notability>')
    // A link split by a paragraph wrap stops resolving and reads as a dead link everywhere.
    expect(extra).toContain('NEVER break a wikilink across a line')
    // The reading list is NOT in it: a queue without a list is a base product without the
    // Fellows extension, and it must not be told to write a page only the extension has.
    expect(extra).not.toContain('<reading_list>')
    expect(extra).not.toContain('reading-list.md')
  })

  /*
   * The other half of the same rule (TASKS-A6 D1). With a list wired - which `main.ts` does
   * only behind `AGENTS_ENABLED` - the run gets the entry shape, the actor to sign with, and
   * the append-only rule that protects a request from the run that fulfils it: one ingest
   * deleted the entry asking for the very document it was filing, which is how a request and
   * the Fellow behind it disappear (docs/agents/SPEC.md 10.6).
   */
  it('carries the reading list only when one is wired, and signs it as the ingest', async () => {
    let extra = ''
    const q = makeQueue({
      reading: new ReadingListService(vaultRoot, store),
      runIngest: async (opts) => {
        extra = opts.systemPromptExtra ?? ''
        return okResult()
      },
    })
    q.start()
    await q.enqueueFile({ sourcePath: writeSource('note.md'), source: 'drop' })
    await q.onIdle()
    expect(extra).toContain('<reading_list>')
    // Signed as the ingest: without the name the run copied the one it saw on the entries
    // already there, a retired Fellow's.
    expect(extra).toContain('by: ingest')
    expect(extra).toMatch(/at: \d{4}-\d{2}-\d{2}/)
    expect(extra).toContain('append-only')
    expect(extra).toContain('NEVER remove or rewrite an entry')
  })

  /*
   * The ingest prompt is `ingest <path>` and nothing else, so a url job's address used to stop
   * at the queue: the run filed the document without ever being told where it came from, and
   * the source page came out with an empty `sources:`. That page is the reading list's most
   * reliable route to "this document is already here", so the address has to reach the run.
   */
  it('tells a url run the address the service knows', async () => {
    let extra = ''
    const q = new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      detectToolsFn: async () => NO_TOOLS,
      commit: async () => ({ committed: true, hash: 'h', committedPages: ['wiki/x.md'] }),
      refreshHotCache: async () => 'noop',
      runIngest: async (opts) => {
        extra = opts.systemPromptExtra ?? ''
        return okResult()
      },
      preprocessUrlFn: async (input) => {
        fs.mkdirSync(input.jobDir, { recursive: true })
        return {
          type: 'web',
          deferred: false,
          manifestPath: path.join(input.jobDir, 'manifest.json'),
          primaryArtifact: `.raw/${input.jobId}/normalized.md`,
          manifest: {} as never,
        }
      },
    })
    q.start()
    q.enqueueUrl({ url: 'https://example.org/report.pdf', source: 'drop' })
    await q.onIdle()
    expect(extra).toContain('<provenance>')
    expect(extra).toContain('https://example.org/report.pdf')
  })

  it('signs the reading list entries the run added as the ingest, in the ingest commit', async () => {
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    const page = path.join(vaultRoot, READING_LIST_PAGE)
    fs.writeFileSync(page, '# Reading list\n\n## Entries\n\n- title: An earlier find\n  url: https://a.invalid/1\n  by: Ada\n  at: 2026-09-01\n')
    const q = makeQueue({
      reading: new ReadingListService(vaultRoot, store),
      runIngest: async () => {
        // The agent copies the name it sees on the page.
        fs.appendFileSync(page, '\n- title: A paper the ingest found\n  url: https://a.invalid/2\n  why: Primary source.\n  by: Ada\n  at: 2026-09-10\n')
        return okResult()
      },
    })
    q.start()
    await q.enqueueFile({ sourcePath: writeSource('note.md'), source: 'drop' })
    await q.onIdle()
    expect(parseReadingList(fs.readFileSync(page, 'utf8')).map((e) => e.by)).toEqual(['Ada', 'ingest'])
    // Staged into the ingest's own commit, and said in the job log.
    expect(commitPathspecs.at(-1)).toContain(READING_LIST_PAGE)
    const job = store.list({ limit: 1 })[0]!
    expect(store.logs(job.id).map((l) => l.message)).toContainEqual(expect.stringContaining('reading list: 1 new entry signed "ingest" (the run had written: Ada)'))
  })

  it('tells a dropped file that the service has no address for it', async () => {
    let extra = ''
    const q = makeQueue({
      runIngest: async (opts) => {
        extra = opts.systemPromptExtra ?? ''
        return okResult()
      },
    })
    q.start()
    await q.enqueueFile({ sourcePath: writeSource('note.md'), source: 'drop' })
    await q.onIdle()
    // Said out loud rather than left silent: silence is what a run fills with a guess.
    expect(extra).toContain('handed over as a file; the service has no address for it')
  })
})

describe('post-run validation', () => {
  it('runs the validator over written+committed pages and logs findings as warnings', async () => {
    const seen: string[][] = []
    const q = makeQueue({
      validate: (paths) => {
        seen.push([...paths])
        return [
          { rule: 'frontmatter', path: 'wiki/concepts/Foo.md', message: 'missing required frontmatter field(s): tags' },
        ]
      },
    })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('note.md'), source: 'drop' })
    await q.onIdle()

    expect(store.getOrThrow(job.id).status).toBe('done') // findings are advisory, never fail the job
    expect(seen[0]).toContain('wiki/concepts/Foo.md') // the fake commit's committedPages reached the validator
    const logs = store.logs(job.id)
    const finding = logs.find((l) => l.message.includes('validation [frontmatter] wiki/concepts/Foo.md'))
    expect(finding?.level).toBe('warn')
    expect(logs.some((l) => l.message.includes('post-run validation: 1 finding(s)'))).toBe(true)
  })

  it('logs a clean pass, and a validator crash never fails the job', async () => {
    const clean = makeQueue({ validate: () => [] })
    clean.start()
    const { job: ok } = await clean.enqueueFile({ sourcePath: writeSource('a.md'), source: 'drop' })
    await clean.onIdle()
    expect(store.logs(ok.id).some((l) => l.message.includes('post-run validation: no findings'))).toBe(true)

    const crashing = makeQueue({
      validate: () => {
        throw new Error('boom')
      },
    })
    crashing.start()
    // Distinct content — identical bytes would dedupe against the job above.
    const { job } = await crashing.enqueueFile({ sourcePath: writeSource('b.md', 'other'), source: 'drop' })
    await crashing.onIdle()
    expect(store.getOrThrow(job.id).status).toBe('done')
    expect(store.logs(job.id).some((l) => l.message.includes('post-run validation crashed'))).toBe(true)
  })
})

describe('upload name traversal (security regression)', () => {
  it('a ../-carrying upload name is staged inside .raw/<job-id>/, never outside the vault', async () => {
    const q = makeQueue()
    // Aim the escape at srcDir (also under tmp) so a regression writes somewhere we clean up.
    const hostile = `../../../${path.basename(srcDir)}/owned.txt`
    const escapeTarget = path.join(srcDir, 'owned.txt')

    const { job } = await q.enqueueFile({
      sourcePath: writeSource('benign.txt'),
      source: 'drop',
      originalName: hostile,
    })

    expect(fs.existsSync(escapeTarget)).toBe(false)
    expect(job.original_name).toBe('owned.txt')
    expect(job.status).toBe('queued')
    expect(fs.existsSync(path.join(vaultRoot, '.raw', job.id, 'owned.txt'))).toBe(true)
  })
})

describe('notify_channel forwarding (SPEC.md §4.3)', () => {
  it('enqueueFile, enqueueUrl and every enqueueBatch member persist the channel', async () => {
    const q = makeQueue()
    const { job: fileJob } = await q.enqueueFile({
      sourcePath: writeSource('n1.txt'),
      source: 'telegram',
      notifyChannel: 'telegram:42',
    })
    expect(store.getOrThrow(fileJob.id).notify_channel).toBe('telegram:42')

    const { job: urlJob } = q.enqueueUrl({ url: 'https://example.org', source: 'telegram', notifyChannel: 'telegram:42' })
    expect(store.getOrThrow(urlJob.id).notify_channel).toBe('telegram:42')

    const { jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: writeSource('n2.txt'), originalName: 'n2.txt' },
        { kind: 'url', url: 'https://example.org/b' },
      ],
      'telegram',
      { notifyChannel: 'telegram:42' },
    )
    for (const r of jobs) expect(store.getOrThrow(r.job.id).notify_channel).toBe('telegram:42')

    // Channels stay opt-in: without one, the column remains NULL.
    const { job: plain } = await q.enqueueFile({ sourcePath: writeSource('n3.txt'), source: 'drop' })
    expect(store.getOrThrow(plain.id).notify_channel).toBeNull()
  })
})

describe('happy path', () => {
  it('drives a text file to done, commits, records pages/tokens, and persists the stream', async () => {
    const messages: SDKMessage[] = []
    const runIngest: IngestRunner = async (opts) => {
      const m = { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } } as unknown as SDKMessage
      messages.push(m)
      opts.onMessage(m)
      return okResult()
    }
    const q = makeQueue({ runIngest })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('note.md'), source: 'drop' })
    await q.onIdle()

    const done = store.getOrThrow(job.id)
    expect(done.status).toBe('done')
    expect(done.type).toBe('text')
    expect(done.tokens_in).toBe(100)
    expect(JSON.parse(done.created_pages!)).toEqual(['wiki/concepts/Foo.md'])
    expect(commitCalls).toEqual(['ingest: note.md'])
    const logMessages = store.logs(job.id).map((l) => l.message)
    expect(logMessages.some((m) => m.includes('working'))).toBe(true)
    expect(logMessages.some((m) => m.includes('committed abcd1234'))).toBe(true)
    expect(logMessages.some((m) => m.includes('hot cache noted'))).toBe(true)
  })

  it('stages the shared bookkeeping paths so the vault does not stay dirty (regression)', async () => {
    // wiki-ingest rewrites .raw/.manifest.json as its delta tracker on every run. It was
    // missing from the pathspec, so each ingest left the vault permanently dirty
    // (TASKS-M5 §0). Both bookkeeping paths must ride along with the ingest commit.
    const q = makeQueue()
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('note.md'), source: 'drop' })
    await q.onIdle()

    expect(store.getOrThrow(job.id).status).toBe('done')
    expect(commitPathspecs).toHaveLength(1)
    expect(commitPathspecs[0]).toEqual(expect.arrayContaining(['.vault-meta', '.raw/.manifest.json']))
  })

  it('pauses instead of claiming work when the daily budget is spent', async () => {
    // SPEC.md §11.3: the queue pauses on an exceeded budget and resumes at the next window.
    let overBudget = true
    const q = makeQueue({ budgetExceeded: () => overBudget })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('note.md'), source: 'drop' })
    await q.onIdle()

    // The job was never claimed — it is still queued behind the pause.
    expect(store.getOrThrow(job.id).status).toBe('queued')
    expect(q.stats().paused).toBe(true)
    expect(q.stats().pauseReason).toBe('budget')
    expect(commitCalls).toHaveLength(0)

    // The window resets: the captured resume timer fires and the work goes through.
    overBudget = false
    pausedTimers.forEach((fn) => fn())
    await q.onIdle()
    expect(store.getOrThrow(job.id).status).toBe('done')
    expect(q.stats().paused).toBe(false)
    expect(q.stats().pauseReason).toBeNull()
  })

  it('lets in-flight work finish rather than aborting it when the budget trips', async () => {
    // The check runs before claiming, so a budget can be overshot only by runs already started.
    let overBudget = false
    const q = makeQueue({
      concurrency: 1,
      budgetExceeded: () => overBudget,
      runIngest: async () => {
        overBudget = true // trips while this job is mid-run
        return okResult()
      },
    })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('a.md'), source: 'drop' })
    await q.onIdle()

    expect(store.getOrThrow(job.id).status).toBe('done') // finished, not aborted
    expect(q.stats().pauseReason).toBe('budget') // and the queue then stopped claiming
  })

  it('routes a URL job by its url, not its source channel (regression)', async () => {
    // A URL dropped via the CLI/dashboard has source 'drop' but must still preprocess as
    // a web job. Injecting preprocessUrlFn avoids real network.
    let urlSeen: string | undefined
    const q = new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      detectToolsFn: async () => NO_TOOLS,
      commit: async () => ({ committed: true, hash: 'h', committedPages: ['wiki/x.md'] }),
      refreshHotCache: async () => 'noop',
      runIngest: async () => okResult(),
      preprocessUrlFn: async (input) => {
        urlSeen = input.url
        fs.mkdirSync(input.jobDir, { recursive: true })
        return {
          type: 'web',
          deferred: false,
          manifestPath: path.join(input.jobDir, 'manifest.json'),
          primaryArtifact: `.raw/${input.jobId}/normalized.md`,
          manifest: {} as never,
        }
      },
    })
    q.start()
    const { job } = q.enqueueUrl({ url: 'https://example.com/x', source: 'drop' })
    await q.onIdle()
    expect(urlSeen).toBe('https://example.com/x')
    expect(store.getOrThrow(job.id).status).toBe('done')
  })

  const urlQueue = (preprocessUrlFn: (input: { jobId: string; jobDir: string }) => Promise<PreprocessResult>) =>
    new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      detectToolsFn: async () => NO_TOOLS,
      commit: async () => ({ committed: true, hash: 'h', committedPages: ['wiki/x.md'] }),
      refreshHotCache: async () => 'noop',
      runIngest: async () => okResult(),
      setTimeoutFn: (fn) => void pausedTimers.push(fn),
      preprocessUrlFn,
    })

  it('retries a TRANSIENT preprocess failure (e.g. YouTube bot check) after a delay', async () => {
    let attempts = 0
    const q = urlQueue(async (input) => {
      attempts++
      if (attempts === 1) throw new PreprocessError('yt-dlp could not read video x: bot check', false, true)
      fs.mkdirSync(input.jobDir, { recursive: true })
      return {
        type: 'web',
        deferred: false,
        manifestPath: path.join(input.jobDir, 'manifest.json'),
        primaryArtifact: `.raw/${input.jobId}/normalized.md`,
        manifest: {} as never,
      }
    })
    q.start()
    const { job } = q.enqueueUrl({ url: 'https://www.youtube.com/watch?v=x', source: 'drop' })
    await q.onIdle()
    // Parked in `failed` (visible, manually retryable) until the backoff timer fires.
    expect(store.getOrThrow(job.id).status).toBe('failed')
    expect(pausedTimers).toHaveLength(1)
    pausedTimers.shift()!()
    await q.onIdle()
    expect(store.getOrThrow(job.id).status).toBe('done')
    expect(attempts).toBe(2)
  })

  it('gives up on a transient preprocess failure once retries are exhausted', async () => {
    let attempts = 0
    const q = urlQueue(async () => {
      attempts++
      throw new PreprocessError('still bot-checked', false, true)
    })
    q.start()
    const { job } = q.enqueueUrl({ url: 'https://www.youtube.com/watch?v=x', source: 'drop' })
    await q.onIdle()
    while (pausedTimers.length > 0) {
      pausedTimers.shift()!()
      await q.onIdle()
    }
    expect(store.getOrThrow(job.id).status).toBe('failed')
    expect(attempts).toBe(3) // initial + maxRetries (2)
  })

  it('does not schedule a retry for a permanent preprocess failure', async () => {
    const q = urlQueue(async () => {
      throw new PreprocessError('Private video', false, false)
    })
    q.start()
    const { job } = q.enqueueUrl({ url: 'https://www.youtube.com/watch?v=x', source: 'drop' })
    await q.onIdle()
    expect(store.getOrThrow(job.id).status).toBe('failed')
    expect(pausedTimers).toHaveLength(0)
  })

  it('skips ingest for a duplicate', async () => {
    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()) })
    q.start()
    const src = writeSource('dup.md', 'same bytes')
    await q.enqueueFile({ sourcePath: src, source: 'drop' })
    const second = await q.enqueueFile({ sourcePath: src, source: 'watch' })
    await q.onIdle()
    expect(second.job.status).toBe('duplicate')
    expect(runs).toBe(1)
  })
})

describe('deferred', () => {
  it('defers audio and moves the original to .raw/deferred/', async () => {
    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()) })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('talk.mp3', 'ID3'), source: 'drop' })
    await q.onIdle()
    expect(store.getOrThrow(job.id).status).toBe('deferred')
    expect(runs).toBe(0)
    expect(fs.existsSync(path.join(vaultRoot, '.raw', 'deferred', `${job.id}-talk.mp3`))).toBe(true)
  })
})

describe('retry and failure', () => {
  it('retries a transient failure, then succeeds', async () => {
    let n = 0
    const q = makeQueue({
      runIngest: async () => (n++ === 0 ? failResult('fetch failed') : okResult()),
    })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('a.md'), source: 'drop' })
    await q.onIdle()
    const done = store.getOrThrow(job.id)
    expect(done.status).toBe('done')
    expect(done.attempts).toBe(2)
  })

  it('gives up after maxRetries on persistent transient failures', async () => {
    const q = makeQueue({ runIngest: async () => failResult('ETIMEDOUT'), maxRetries: 2 })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('a.md'), source: 'drop' })
    await q.onIdle()
    const failed = store.getOrThrow(job.id)
    expect(failed.status).toBe('failed')
    expect(failed.attempts).toBe(3) // initial + 2 retries
  })

  it('does not retry a permanent failure', async () => {
    let n = 0
    const q = makeQueue({ runIngest: async () => (n++, failResult('run consumed zero tokens — auth')) })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('a.md'), source: 'drop' })
    await q.onIdle()
    expect(store.getOrThrow(job.id).status).toBe('failed')
    expect(n).toBe(1)
  })
})

describe('rate-limit pause', () => {
  it('pauses on a usage-limit signal, and a pause does not burn a retry', async () => {
    let n = 0
    const q = makeQueue({ runIngest: async () => (n++ === 0 ? failResult('rate limit (429)') : okResult()) })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('a.md'), source: 'drop' })
    await q.onIdle() // settles once the job is re-queued and the queue paused

    expect(q.isPaused).toBe(true)
    expect(store.getOrThrow(job.id).status).toBe('queued')
    expect(pausedTimers).toHaveLength(1)

    // Fire the auto-resume timer.
    pausedTimers[0]!()
    await q.onIdle()

    const done = store.getOrThrow(job.id)
    expect(done.status).toBe('done')
    expect(done.attempts).toBe(1) // the failed rate-limited attempt was refunded
  })
})

describe('batching', () => {
  it('preprocesses members individually then runs ONE combined ingest', async () => {
    const prompts: string[] = []
    let runs = 0
    const q = makeQueue({
      runIngest: async (o) => {
        runs++
        prompts.push(o.prompt)
        return okResult()
      },
    })
    q.start()
    const a = writeSource('a.md', 'alpha')
    const b = writeSource('b.md', 'bravo')
    const { batchId, jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: a },
        { kind: 'file', sourcePath: b },
      ],
      'drop',
    )
    await q.onIdle()

    expect(runs).toBe(1) // one combined run, not one per file
    expect(prompts[0]).toContain('ingest all of these')
    expect(prompts[0]).toContain('.raw/')
    for (const r of jobs) {
      const job = store.getOrThrow(r.job.id)
      expect(job.status).toBe('done')
      expect(job.batch_id).toBe(batchId)
    }
    expect(commitCalls).toHaveLength(1) // one commit for the whole batch
  })

  it('defers an unsupported member without sinking the batch', async () => {
    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()) })
    q.start()
    const a = writeSource('a.md', 'alpha')
    const mp3 = writeSource('song.mp3', 'ID3 audio')
    const { jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: a },
        { kind: 'file', sourcePath: mp3 },
      ],
      'drop',
    )
    await q.onIdle()
    expect(runs).toBe(1)
    const statuses = jobs.map((r) => store.getOrThrow(r.job.id).status).sort()
    expect(statuses).toEqual(['deferred', 'done'])
  })

  it('retries a transient batch failure then succeeds', async () => {
    let n = 0
    const q = makeQueue({ runIngest: async () => (n++ === 0 ? failResult('ETIMEDOUT') : okResult()) })
    q.start()
    const a = writeSource('a.md', 'alpha')
    const b = writeSource('b.md', 'bravo')
    const { jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: a },
        { kind: 'file', sourcePath: b },
      ],
      'drop',
    )
    await q.onIdle()
    expect(n).toBe(2)
    for (const r of jobs) expect(store.getOrThrow(r.job.id).status).toBe('done')
  })

  it('splits usage across members so aggregate totals are not inflated', async () => {
    const q = makeQueue({
      runIngest: async () => okResult({ usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.02 } }),
    })
    q.start()
    const a = writeSource('a.md', 'alpha')
    const b = writeSource('b.md', 'bravo')
    const { jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: a },
        { kind: 'file', sourcePath: b },
      ],
      'drop',
    )
    await q.onIdle()
    const totalIn = jobs.reduce((s, r) => s + (store.getOrThrow(r.job.id).tokens_in ?? 0), 0)
    expect(totalIn).toBe(100) // 50 + 50, not 200
  })
})

describe('concurrency', () => {
  it('runs at most `concurrency` ingests at once and completes all', async () => {
    /*
     * Held, not timed (2026-09-17). Each fake ingest keeps its slot until the test lets it go,
     * so both slots are provably full while the third job waits, whatever the machine is
     * doing. The version with a 10 ms sleep per ingest had the two never overlap on a loaded
     * runner and reported a peak of one.
     */
    let inFlight = 0
    let peak = 0
    const gates: Array<() => void> = []
    const runIngest: IngestRunner = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise<void>((release) => gates.push(release))
      inFlight--
      return okResult()
    }
    const until = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
      expect(cond()).toBe(true)
    }
    const q = makeQueue({ runIngest, concurrency: 2 })
    q.start()
    for (let i = 0; i < 5; i++) {
      await q.enqueueFile({ sourcePath: writeSource(`f${i}.md`, `body ${i}`), source: 'drop' })
    }
    await until(() => gates.length === 2)
    // A third slot would have to open in this window; the queue has none to open.
    await new Promise((r) => setTimeout(r, 25))
    expect(inFlight).toBe(2)
    for (let released = 0; released < 5; released++) {
      await until(() => gates.length > 0)
      gates.shift()!()
    }
    await q.onIdle()
    expect(peak).toBe(2)
    expect(store.listByStatus('done')).toHaveLength(5)
  })
})

describe('jobs held for the night shift', () => {
  it('holds a job until it is released, then runs it; the queue is idle meanwhile', async () => {
    let runs = 0
    const q = makeQueue({
      runIngest: async () => {
        runs++
        return okResult()
      },
    })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('tonight.md'), source: 'drop', hold: 'night' })
    expect(job).toMatchObject({ status: 'queued', hold: 'night' })
    // Resolves with a job still queued: a held job does not keep the queue awake, or the
    // shift's wait for an empty queue (and every test's) would never end.
    await q.onIdle()
    expect(runs).toBe(0)
    expect(store.getOrThrow(job.id).status).toBe('queued')

    expect(q.releaseHeld('night')).toEqual([job.id])
    // Released, the job keeps its place in tonight's queue (v26) until it is through.
    expect(store.getOrThrow(job.id).night_released_at).toEqual(expect.any(String))
    await q.onIdle()
    expect(runs).toBe(1)
    // Through: done AND committed (the commit step ran), so the place is cleared.
    expect(store.getOrThrow(job.id)).toMatchObject({ status: 'done', hold: null, night_released_at: null, commit_hash: 'abcd1234ef' })
    expect(q.releaseHeld('night')).toEqual([])
  })

  it('keeps a released job in tonight\'s queue while a retry is pending, and drops it once it gives up', async () => {
    let attempts = 0
    const q = makeQueue({
      maxRetries: 1,
      runIngest: async () => {
        attempts++
        return failResult('fetch failed ECONNRESET')
      },
    })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('tonight.md'), source: 'drop', hold: 'night' })
    q.releaseHeld('night')
    await q.onIdle()
    // Two attempts (the retry is immediate: the job is queued again), then it gave up.
    expect(attempts).toBe(2)
    expect(store.getOrThrow(job.id)).toMatchObject({ status: 'failed', night_released_at: null })
  })

  it('holds a batch as a unit and runs it as one combined ingest once released', async () => {
    let runs = 0
    const q = makeQueue({
      runIngest: async () => {
        runs++
        return okResult()
      },
    })
    q.start()
    const { jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: writeSource('h1.md'), originalName: 'h1.md' },
        { kind: 'file', sourcePath: writeSource('h2.md', 'a different note'), originalName: 'h2.md' },
      ],
      'drop',
      { hold: 'night' },
    )
    await q.onIdle()
    expect(runs).toBe(0)
    for (const r of jobs) expect(store.getOrThrow(r.job.id)).toMatchObject({ status: 'queued', hold: 'night' })

    expect(q.releaseHeld('night').sort()).toEqual(jobs.map((r) => r.job.id).sort())
    await q.onIdle()
    // One run for the batch, not one per member.
    expect(runs).toBe(1)
    for (const r of jobs) expect(store.getOrThrow(r.job.id).status).toBe('done')
  })
})
