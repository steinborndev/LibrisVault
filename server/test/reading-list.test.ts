/**
 * The reading list (docs/agents/SPEC.md section 10.6): the entries a research step appends
 * to its page, read back and matched against the job log, plus the route that turns one
 * into an ordinary URL ingest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { EventBus } from '../src/pipeline/events.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { ChatStore } from '../src/db/chat.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer } from '../src/api/server.js'
import { ReadingListService, parseReadingList, reachOf, urlKey, READING_LIST_PAGE, type ReadingEntry } from '../src/pipeline/reading-list.js'
import type { Config } from '../src/config.js'

const PAGE = `---
type: meta
title: "Reading list"
---
# Reading list

## Entries

- title: Multi-facility transit campaign for HIP 41378 f
  url: https://example.invalid/hip41378f
  ref: arXiv:2506.20907
  domain: astronomy
  why: The only campaign that pooled heterogeneous sites for a spectrum.
  found: Ada, 2026-09-06

- title: Sparse array scaling without a ceiling
  url: https://example.invalid/array-theory?utm=x
  domain: astronomy
  found: Ada, 2026-09-06

- title: A duplicate of the first
  url: https://example.invalid/hip41378f#section-2
  found: Cleo, 2026-09-07

- title: Three papers nobody could open
  url: https://acs.invalid/lithium-sulfur
  domain: materials-science
  why: The only per-cell figures behind the disputed record.
  access: paywalled
  blocked: HTTP 403
  by: Jane
  at: 2026-09-07

- title: No link at all, so not an entry
  ref: doi:10.0000/nothing
`

describe('parsing the page a Fellow writes', () => {
  it('reads the fields, drops what has no url, and folds a repeated url into one entry', () => {
    const entries = parseReadingList(PAGE)
    expect(entries.map((e) => e.title)).toEqual([
      'Multi-facility transit campaign for HIP 41378 f',
      'Sparse array scaling without a ceiling',
      'Three papers nobody could open',
    ])
    expect(entries[0]).toEqual({
      title: 'Multi-facility transit campaign for HIP 41378 f',
      url: 'https://example.invalid/hip41378f',
      ref: 'arXiv:2506.20907',
      domain: 'astronomy',
      why: 'The only campaign that pooled heterogeneous sites for a spectrum.',
      found: 'Ada, 2026-09-06',
      // The finder is split out of the legacy line, so a filter has something to work with.
      by: 'Ada',
      at: '2026-09-06',
      access: null,
      blocked: null,
    })
    expect(entries[1]).toMatchObject({ ref: null, why: null, domain: 'astronomy' })
    // The entry worth the most: nobody could read it, and it says why.
    expect(entries[2]).toMatchObject({ access: 'paywalled', blocked: 'HTTP 403', by: 'Jane', at: '2026-09-07' })
  })

  it('says what the reader can expect to reach, from the Fellow or from the host', () => {
    const entry = (over: Partial<ReadingEntry>): ReadingEntry => ({
      title: 't',
      url: 'https://example.invalid/x',
      ref: null,
      domain: null,
      why: null,
      found: null,
      by: null,
      at: null,
      access: null,
      blocked: null,
      ...over,
    })
    // The Fellow's own word always wins.
    expect(reachOf(entry({ access: 'paywalled', url: 'https://arxiv.org/abs/1' }))).toBe('paywalled')
    // Without one, only hosts that serve full text unconditionally count as open.
    expect(reachOf(entry({ url: 'https://arxiv.org/abs/2506.20907' }))).toBe('open')
    expect(reachOf(entry({ url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/' }))).toBe('open')
    // Everything else stays unknown rather than being called paywalled, which would hide it.
    expect(reachOf(entry({ url: 'https://pubs.acs.org/doi/10.1/x' }))).toBe('unknown')
    expect(reachOf(entry({ url: 'not a url' }))).toBe('unknown')
  })

  it('an empty or shapeless page yields nothing', () => {
    expect(parseReadingList('')).toEqual([])
    expect(parseReadingList('# Reading list\n\nNothing here yet.\n')).toEqual([])
    expect(parseReadingList('- title: no url\n  ref: x\n')).toEqual([])
  })
})

describe('entries the service writes for the planner', () => {
  let vaultRoot: string
  let db: Db
  let store: JobStore

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-add-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE)
    db = openDb(MEMORY_DB)
    store = new JobStore(db, new EventBus())
  })
  afterEach(() => {
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const entry = (over: Partial<ReadingEntry>): ReadingEntry => ({
    title: 'A paper the planner named',
    url: 'https://osti.invalid/1981578',
    ref: null,
    domain: 'materials-science',
    why: 'The only primary techno-economic comparison.',
    found: null,
    by: 'Jane',
    at: '2026-09-07',
    access: 'unreachable',
    blocked: 'no extractable text',
    ...over,
  })

  it('appends what the page does not have, in the shape a Fellow would have written', async () => {
    const reading = new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false })
    const { added } = await reading.add([entry({}), entry({ url: 'https://example.invalid/hip41378f' })])
    expect(added).toBe(1)

    const page = fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')
    expect(page).toContain('- title: A paper the planner named')
    expect(page).toContain('  access: unreachable')
    expect(page).toContain('  blocked: no extractable text')
    expect(page).toContain('  by: Jane')
    // Read back through the parser, it is one more entry and nothing else moved.
    const parsed = parseReadingList(page)
    expect(parsed).toHaveLength(4)
    expect(parsed.at(-1)).toMatchObject({ title: 'A paper the planner named', access: 'unreachable', by: 'Jane', at: '2026-09-07' })
  })

  it('never writes the same publication twice, however the url is spelled', async () => {
    const reading = new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false })
    await reading.add([entry({})])
    const second = await reading.add([entry({ url: 'https://osti.invalid/1981578/?utm_source=x' }), entry({ url: 'not-a-url' })])
    expect(second.added).toBe(0)
    expect(parseReadingList(fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8'))).toHaveLength(4)
    expect(urlKey('https://osti.invalid/1981578/?utm_source=x')).toBe(urlKey('https://osti.invalid/1981578'))
  })

  it('without a mutex it writes nothing: the vault is only ever written behind it', async () => {
    const reading = new ReadingListService(vaultRoot, store)
    expect((await reading.add([entry({})])).added).toBe(0)
    expect(fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')).toBe(PAGE)
  })
})

describe('the reading list route', () => {
  let vaultRoot: string
  let db: Db
  let app: FastifyInstance
  let store: JobStore

  beforeEach(async () => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE)
    db = openDb(MEMORY_DB)
    const events = new EventBus()
    store = new JobStore(db, events)
    const config: Config = {
      vaultRoot,
      obsidianVaultName: 'vault',
      demoMode: false,
      agentsEnabled: true,
      auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
      telegram: null,
      server: { host: '127.0.0.1', port: 0, watchFolder: path.join(vaultRoot, 'inbox'), maxUploadBytes: 1024, authMode: 'local-single-user' },
    }
    const queue = new IngestQueue({ store, vaultRoot, auth: config.auth, runIngest: async () => { throw new Error('no agent') } })
    const runner = new MaintenanceRunner({ vaultRoot, auth: config.auth, events, commitMutex: new Mutex() })
    app = await buildServer({
      config,
      store,
      chat: new ChatStore(db),
      queue,
      events,
      maintenance: runner,
      logger: false,
      reading: new ReadingListService(vaultRoot, store),
    })
  })
  afterEach(async () => {
    await app.close()
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('lists the entries, ingests one through the URL path, and refuses anything not on the list', async () => {
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/reading-list' })).json() as { entries: Array<{ title: string; job: unknown; reach: string }> }
    expect(listed.entries).toHaveLength(3)
    expect(listed.entries.map((e) => e.reach)).toEqual(['unknown', 'unknown', 'paywalled'])
    expect(listed.entries[0]!.job).toBeNull()

    const started = await app.inject({ method: 'POST', url: '/api/v1/reading-list/ingest', payload: { url: 'https://example.invalid/hip41378f' } })
    expect(started.statusCode).toBe(202)
    expect(store.list({ limit: 10 })[0]).toMatchObject({ type: 'web', url: 'https://example.invalid/hip41378f', source: 'url' })

    // The entry now carries its job, and a second request is refused rather than queued twice.
    const again = (await app.inject({ method: 'GET', url: '/api/v1/reading-list' })).json() as { entries: Array<{ job: { status: string } | null }> }
    expect(again.entries[0]!.job).toMatchObject({ status: 'queued' })
    expect((await app.inject({ method: 'POST', url: '/api/v1/reading-list/ingest', payload: { url: 'https://example.invalid/hip41378f' } })).statusCode).toBe(409)

    // Not on the list: the route is not an open fetch proxy.
    expect((await app.inject({ method: 'POST', url: '/api/v1/reading-list/ingest', payload: { url: 'https://example.invalid/elsewhere' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/v1/reading-list/ingest', payload: { url: 'not-a-url' } })).statusCode).toBe(400)
  })
})
