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
import { ReadingListService, parseReadingList, reachOf, urlKey, urlFileName, entryRef, READING_LIST_PAGE, type ReadingEntry } from '../src/pipeline/reading-list.js'
import { refKey } from '../src/pipeline/dedupe.js'
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
      filed: null,
      filedAt: null,
      archivedAt: null,
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
      filed: null,
      filedAt: null,
      archivedAt: null,
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

describe('recognizing a publication that is already in the vault', () => {
  let vaultRoot: string
  let db: Db
  let store: JobStore

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-ref-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    db = openDb(MEMORY_DB)
    store = new JobStore(db, new EventBus())
  })
  afterEach(() => {
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const PAGE_WITH_REFS = `---
type: meta
title: "Reading list"
---
# Reading list

## Entries

- title: A preprint the user fetched by hand
  url: https://arxiv.org/abs/2506.20907
  ref: arXiv:2506.20907
  domain: astronomy
  why: The only campaign that pooled heterogeneous sites.
  by: Ada
  at: 2026-09-06

- title: A paper with a DOI
  url: https://acs.invalid/paper
  ref: doi:10.1021/example
  domain: materials-science
  by: Jane
  at: 2026-09-07
`

  it('matches by DOI and arXiv id, which is what a dropped PDF leaves behind', () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_WITH_REFS)
    // No ingest ever ran for these urls; the source pages carry the identifiers.
    const pages: Record<string, string> = {
      'wiki/sources/Transit Campaign.md': 'https://arxiv.org/pdf/2506.20907v2',
      'wiki/sources/A Paper.md': 'https://doi.org/10.1021/EXAMPLE',
    }
    const reading = new ReadingListService(vaultRoot, store, {
      byRef: (ref) => {
        for (const [page, url] of Object.entries(pages)) if (refKey(url) === refKey(ref)) return { page }
        return undefined
      },
    })
    const entries = reading.entries()
    expect(entries[0]).toMatchObject({ page: 'wiki/sources/Transit Campaign.md', via: 'ref', job: null })
    // A version suffix, a pdf link instead of abs, and a capitalised DOI are the same document.
    expect(entries[1]).toMatchObject({ page: 'wiki/sources/A Paper.md', via: 'ref' })
    expect(entryRef({ ref: 'arXiv:2506.20907', url: '' })).toBe('arxiv:2506.20907')
    expect(entryRef({ ref: null, url: 'https://arxiv.org/abs/2506.20907' })).toBe('arxiv:2506.20907')
    expect(entryRef({ ref: null, url: 'https://example.invalid/x' })).toBeUndefined()
    // A PubMed Central accession is an identity too: often the only readable version.
    expect(entryRef({ ref: null, url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC12214508/' })).toBe('pmc:PMC12214508')
  })

  it('marks what arrived, once, and reports it for the Fellow that asked', async () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_WITH_REFS)
    const reading = new ReadingListService(vaultRoot, store, {
      commitMutex: new Mutex(),
      autoCommit: () => false,
      byRef: (ref) => (refKey(ref) === 'arxiv:2506.20907' ? { page: 'wiki/sources/Transit Campaign.md' } : undefined),
    })
    const filed = await reading.reconcile('2026-09-08')
    expect(filed).toHaveLength(1)
    expect(filed[0]).toMatchObject({ page: 'wiki/sources/Transit Campaign.md' })
    expect(filed[0]!.entry).toMatchObject({ title: 'A preprint the user fetched by hand', by: 'Ada' })

    const page = fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')
    expect(page).toContain('  filed: wiki/sources/Transit Campaign.md')
    expect(page).toContain('  filedAt: 2026-09-08')
    // The mark is also the record that the Fellow has been told: a second pass reports nothing.
    expect(await reading.reconcile('2026-09-09')).toHaveLength(0)
    // And the entry that is not in the vault is untouched.
    expect(parseReadingList(page)[1]).toMatchObject({ filed: null, filedAt: null })
  })

  /*
   * The case that started this: a Fellow asks for an article whose url names no DOI, the user
   * fetches the PDF and drops it in, and the entry and the source page have nothing in common
   * but the address the document came from. Before `byUrl` the entry stayed unfiled forever and
   * the Fellow was never told the paper it had asked for was sitting in the vault.
   */
  const PAGE_WITHOUT_A_REF = `---
type: meta
title: "Reading list"
---
# Reading list

## Entries

- title: An article whose url carries no identifier
  url: https://journal.invalid/abt/article/9/3/332/8697373
  domain: biomedicine
  why: It lists what was approved last year.
  by: Beatrice
  at: 2026-09-07
`

  it('falls back to the source url when the publication names no identifier', async () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_WITHOUT_A_REF)
    const opts = {
      commitMutex: new Mutex(),
      autoCommit: () => false,
      // A tracking parameter and a trailing slash are the same address.
      byUrl: (url: string) =>
        urlKey(url) === 'https://journal.invalid/abt/article/9/3/332/8697373' ? { page: 'wiki/sources/Approved Antibodies.md' } : undefined,
    }
    const reading = new ReadingListService(vaultRoot, store, opts)
    expect(reading.entries()[0]).toMatchObject({ page: 'wiki/sources/Approved Antibodies.md', via: 'url', job: null })

    const filed = await reading.reconcile('2026-09-08')
    expect(filed).toHaveLength(1)
    expect(filed[0]!.entry).toMatchObject({ title: 'An article whose url carries no identifier', by: 'Beatrice' })
    expect(fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')).toContain('  filed: wiki/sources/Approved Antibodies.md')
  })

  /*
   * Archiving is a MARK, not a removal: the page is append-only for every writer including the
   * service, and an entry carries the request and the reason a Fellow wrote it down. It says
   * "I have dealt with this", which is a different statement from `filed` and can be true
   * without it - a publication the user decides not to fetch is what the list had no answer for.
   */
  it('marks one entry archived and takes the mark off again, touching nothing else', async () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_WITH_REFS)
    const reading = new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false })
    const [first, second] = reading.entries()

    expect(await reading.setArchived(first!.url, '2026-09-08')).toBe(true)
    let page = fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')
    expect(parseReadingList(page)[0]).toMatchObject({ title: first!.title, archivedAt: '2026-09-08' })
    // The other entry is untouched, and so is everything the archived one already said.
    expect(parseReadingList(page)[1]).toMatchObject({ title: second!.title, archivedAt: null })
    expect(page).toContain(first!.why!)

    // Idempotent, and a second entry's mark does not disturb the first's.
    expect(await reading.setArchived(first!.url, '2026-09-08')).toBe(false)
    expect(await reading.setArchived(second!.url, '2026-09-09')).toBe(true)
    page = fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')
    expect(parseReadingList(page).map((e) => e.archivedAt)).toEqual(['2026-09-08', '2026-09-09'])

    // And back: a one-way button beside an Ingest button would be a trap.
    expect(await reading.setArchived(first!.url, null)).toBe(true)
    page = fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')
    expect(parseReadingList(page).map((e) => e.archivedAt)).toEqual([null, '2026-09-09'])
    expect(await reading.setArchived('https://nowhere.invalid/x', '2026-09-08')).toBe(false)
  })

  it('matches the entry the way the list dedupes, and survives a reload', async () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_WITH_REFS)
    const reading = new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false })
    const [first] = reading.entries()
    // A tracking parameter is the same entry here as everywhere else on this page.
    expect(await reading.setArchived(`${first!.url}?utm_source=x`, '2026-09-08')).toBe(true)
    // Read back through the service, not just off the page.
    expect(reading.entries()[0]).toMatchObject({ archivedAt: '2026-09-08' })
  })

  it('an identifier still beats a url, because it is the stronger claim', () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_WITH_REFS)
    const reading = new ReadingListService(vaultRoot, store, {
      byRef: () => ({ page: 'wiki/sources/By Identifier.md' }),
      byUrl: () => ({ page: 'wiki/sources/By Url.md' }),
    })
    expect(reading.entries()[0]).toMatchObject({ page: 'wiki/sources/By Identifier.md', via: 'ref' })
  })

  /*
   * The route of last resort, and the case that needed it: a regulator's PDF with no DOI,
   * whose ingest wrote the local staging path into the page's `url:` rather than an address,
   * dropped in by hand so the job log has no url either. Every other route is blind to it. The
   * one thing left is the file name - a browser names a download after the last segment of the
   * url it came from, which is the very link the board offers.
   */
  const PAGE_OF_A_DOWNLOAD = `---
type: meta
title: "Reading list"
---
# Reading list

## Entries

- title: An agency's own assessment report
  url: https://agency.invalid/en/documents/assessment-report/kostaive-epar-public-assessment-report_en.pdf
  domain: biomedicine
  why: The regulator's own reading of the sponsor's claim.
  by: Beatrice
  at: 2026-09-07
`

  const droppedFile = (name: string): string => {
    const { job } = store.create({ source: 'drop', type: 'pdf', originalName: name })
    store.setCreatedPages(job.id, [`wiki/sources/${name}.md`])
    for (const to of ['preprocessing', 'ingesting', 'done'] as const) store.transition(job.id, to)
    return job.id
  }

  it('recognizes the file the user downloaded from the link on the board', async () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_OF_A_DOWNLOAD)
    droppedFile('kostaive-epar-public-assessment-report_en.pdf')
    const reading = new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false })
    expect(reading.entries()[0]).toMatchObject({
      page: 'wiki/sources/kostaive-epar-public-assessment-report_en.pdf.md',
      via: 'file',
      job: null,
    })
    const filed = await reading.reconcile('2026-09-08')
    expect(filed).toHaveLength(1)
    expect(filed[0]!.entry).toMatchObject({ by: 'Beatrice' })
  })

  it('refuses to guess when a file name is not unambiguous', () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_OF_A_DOWNLOAD)
    // Two ingests of the same name: which document the entry asked for is no longer knowable,
    // and a wrong answer would tell a Fellow its publication had arrived over someone else's.
    droppedFile('kostaive-epar-public-assessment-report_en.pdf')
    droppedFile('kostaive-epar-public-assessment-report_en.pdf')
    const reading = new ReadingListService(vaultRoot, store, {})
    expect(reading.entries()[0]).toMatchObject({ page: null, via: null })
  })

  it('reads a file name off a url only when there is one', () => {
    expect(urlFileName('https://a.invalid/x/report_en.pdf')).toBe('report_en.pdf')
    // Capitalisation and a tracking parameter do not change the file.
    expect(urlFileName('https://a.invalid/x/Report_EN.PDF?utm=1')).toBe('report_en.pdf')
    // An article id is not a file, or every entry on such a host would compete for one match.
    expect(urlFileName('https://a.invalid/abt/article/9/3/332/8697373')).toBeUndefined()
    expect(urlFileName('https://a.invalid/doi/10.1056/NEJMoa2504747')).toBeUndefined()
    expect(urlFileName('https://a.invalid/')).toBeUndefined()
  })

  /*
   * The board and the nightly reconcile used to answer this question separately, and the
   * reconcile knew one route where the board knew three: a row could read "in the vault" while
   * the entry stayed unfiled and the Fellow uninformed. They share one resolver now.
   */
  it('files what an ingest of its url produced, the way the board already showed it', async () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_WITHOUT_A_REF)
    const { job } = store.create({
      source: 'url',
      type: 'web',
      url: 'https://journal.invalid/abt/article/9/3/332/8697373?utm_source=x',
      originalName: 'article',
    })
    store.setCreatedPages(job.id, ['wiki/sources/From The Board.md'])
    for (const to of ['preprocessing', 'ingesting', 'done'] as const) store.transition(job.id, to)
    const reading = new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false })
    expect(reading.entries()[0]).toMatchObject({ page: 'wiki/sources/From The Board.md', via: 'job' })

    const filed = await reading.reconcile('2026-09-08')
    expect(filed).toHaveLength(1)
    expect(filed[0]).toMatchObject({ page: 'wiki/sources/From The Board.md' })
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
    filed: null,
    filedAt: null,
    archivedAt: null,
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
