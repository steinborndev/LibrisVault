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
import { ReadingListService, parseReadingList, READING_LIST_PAGE } from '../src/pipeline/reading-list.js'
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

- title: No link at all, so not an entry
  ref: doi:10.0000/nothing
`

describe('parsing the page a Fellow writes', () => {
  it('reads the fields, drops what has no url, and folds a repeated url into one entry', () => {
    const entries = parseReadingList(PAGE)
    expect(entries.map((e) => e.title)).toEqual(['Multi-facility transit campaign for HIP 41378 f', 'Sparse array scaling without a ceiling'])
    expect(entries[0]).toEqual({
      title: 'Multi-facility transit campaign for HIP 41378 f',
      url: 'https://example.invalid/hip41378f',
      ref: 'arXiv:2506.20907',
      domain: 'astronomy',
      why: 'The only campaign that pooled heterogeneous sites for a spectrum.',
      found: 'Ada, 2026-09-06',
    })
    expect(entries[1]).toMatchObject({ ref: null, why: null, domain: 'astronomy' })
  })

  it('an empty or shapeless page yields nothing', () => {
    expect(parseReadingList('')).toEqual([])
    expect(parseReadingList('# Reading list\n\nNothing here yet.\n')).toEqual([])
    expect(parseReadingList('- title: no url\n  ref: x\n')).toEqual([])
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
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/reading-list' })).json() as { entries: Array<{ title: string; job: unknown }> }
    expect(listed.entries).toHaveLength(2)
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
