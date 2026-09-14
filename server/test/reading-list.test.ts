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
import { execFileSync } from 'node:child_process'
import type { AgentRunResult } from '../src/pipeline/agent-runner.js'
import type { FellowRunContext } from '../src/pipeline/fellow-prompts.js'
import { buildServer } from '../src/api/server.js'
import {
  ReadingListService,
  openCopyCandidates,
  parseReadingList,
  reachOf,
  urlKey,
  urlFileName,
  entryRef,
  READING_LIST_PAGE,
  type ReadingEntry,
} from '../src/pipeline/reading-list.js'
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
      oa: null,
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
      oa: null,
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
      // The user dropped the PDF in, so a document stands behind that page: this is arrival.
      held: (page) => page === 'wiki/sources/Transit Campaign.md',
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
   * The nightly sweep (docs/sources/SPEC.md section 6): the entries a Fellow could not read are
   * the only ones worth asking about, a find is a MARK and never an ingest, and the page keeps
   * everything else it says.
   */
  describe('the open-copy sweep', () => {
    const SWEEP_PAGE = `# Reading list

## Entries

- title: A paper behind a subscription
  url: https://publisher.example/articles/one
  ref: doi:10.1234/example.2026.001
  domain: example-domain
  access: paywalled
  blocked: HTTP 403
  by: Jane
  at: 2026-09-07

- title: A preprint nobody could fetch
  url: https://arxiv.org/abs/2506.20907
  ref: arXiv:2506.20907
  access: unreachable
  blocked: no extractable text
  by: Ada
  at: 2026-09-07

- title: An open paper that needs nothing
  url: https://arxiv.org/abs/2506.11111
  access: open
  by: Ada
  at: 2026-09-07

- title: A paper already in the vault
  url: https://publisher.example/articles/two
  ref: doi:10.1234/example.2026.002
  access: paywalled
  filed: wiki/sources/Two.md
  filedAt: 2026-09-08
  by: Jane
  at: 2026-09-07

- title: A paper the user has dealt with
  url: https://publisher.example/articles/three
  ref: doi:10.1234/example.2026.003
  access: paywalled
  archivedAt: 2026-09-09
  by: Jane
  at: 2026-09-07

- title: A paywalled paper with no identifier at all
  url: https://publisher.example/articles/four
  access: paywalled
  by: Jane
  at: 2026-09-07
`

    it('asks about what nobody could read and nothing else', () => {
      const candidates = openCopyCandidates(parseReadingList(SWEEP_PAGE))
      expect(candidates.map((c) => c.entry.title)).toEqual(['A paper behind a subscription', 'A preprint nobody could fetch'])
      expect(candidates[0]).toMatchObject({ doi: '10.1234/example.2026.001' })
      // An arXiv id needs no resolver: the PDF beside the abstract IS the copy.
      expect(candidates[1]).toMatchObject({ arxivId: '2506.20907' })
      expect(candidates[1]!.doi).toBeUndefined()
    })

    it('spends its lookups on DOIs nobody has asked about this week, up to the limit', () => {
      const entries = parseReadingList(SWEEP_PAGE)
      expect(openCopyCandidates(entries, { answeredRecently: (doi) => doi === '10.1234/example.2026.001' }).map((c) => c.entry.title)).toEqual([
        'A preprint nobody could fetch',
      ])
      expect(openCopyCandidates(entries, { limit: 1 })).toHaveLength(1)
    })

    it('marks a find inside the entry block, once, and leaves the rest of the page alone', async () => {
      fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), SWEEP_PAGE)
      const reading = new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false })
      const asked: string[] = []
      const out = await reading.markOpenCopies({
        today: '2026-09-13',
        lookup: async (doi) => {
          asked.push(doi)
          return { url: 'https://repository.example/paper.pdf', version: 'acceptedVersion', at: '2026-09-13', chars: null }
        },
      })
      expect(asked).toEqual(['10.1234/example.2026.001'])
      expect(out.checked).toBe(2)
      expect(out.found.map((f) => f.copy.url)).toEqual(['https://repository.example/paper.pdf', 'https://arxiv.org/pdf/2506.20907'])

      const marked = parseReadingList(fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8'))
      // The sweep asks, it does not open the copy: no measurement to write.
      expect(marked[0]!.oa).toEqual({ url: 'https://repository.example/paper.pdf', version: 'acceptedVersion', at: '2026-09-13', chars: null })
      expect(marked[1]!.oa).toEqual({ url: 'https://arxiv.org/pdf/2506.20907', version: 'submittedVersion', at: '2026-09-13', chars: null })
      // Everything the Fellows wrote is still there, and nothing else gained a mark.
      expect(marked).toHaveLength(6)
      expect(marked[0]).toMatchObject({ blocked: 'HTTP 403', by: 'Jane', access: 'paywalled' })
      expect(marked.slice(2).every((e) => e.oa === null)).toBe(true)
      // A second night asks about neither: both entries carry a copy now.
      const again = await reading.markOpenCopies({ today: '2026-09-14', lookup: async () => undefined })
      expect(again.checked).toBe(0)
    })

    it('writes nothing on a dry run, and nothing at all when no copy is found', async () => {
      fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), SWEEP_PAGE)
      const reading = new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false })
      const dry = await reading.markOpenCopies({
        today: '2026-09-13',
        dryRun: true,
        lookup: async () => ({ url: 'https://repository.example/paper.pdf', version: 'publishedVersion', at: '2026-09-13', chars: null }),
      })
      expect(dry.found).toHaveLength(2)
      expect(fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')).toBe(SWEEP_PAGE)

      const nothing = await reading.markOpenCopies({ today: '2026-09-13', limit: 1, lookup: async () => undefined })
      expect(nothing.found).toEqual([])
      expect(fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')).toBe(SWEEP_PAGE)
    })
  })

  /*
   * The other half of the disclosure (docs/sources/SPEC.md 5.4): when what arrived was read from
   * an open-access copy, the entry that asked for the publication says so too - otherwise the
   * board can only say "in the vault" about a text that did not come from the address it names.
   */
  it('writes the copy into the entry that asked for it, and leaves an unknown version out', async () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_WITH_REFS)
    // The ingest of the entry's own url, with the manifest that ingest wrote.
    const job = store.create({ source: 'url', type: 'web', url: 'https://acs.invalid/paper' })
    store.transition(job.job.id, 'preprocessing')
    store.transition(job.job.id, 'ingesting')
    store.transition(job.job.id, 'done', { patch: { createdPages: ['wiki/sources/A Paper.md'] } })
    const jobDir = path.join(vaultRoot, '.raw', job.job.id)
    fs.mkdirSync(jobDir, { recursive: true })
    const manifest = (oa: unknown): void =>
      fs.writeFileSync(path.join(jobDir, 'manifest.json'), JSON.stringify({ jobId: job.job.id, oa }), 'utf8')
    manifest({ url: 'https://repository.example/paper.pdf', version: 'acceptedVersion', kind: 'rescued' })

    const reading = new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false })
    expect(await reading.reconcile('2026-09-13')).toHaveLength(1)
    const page = fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')
    expect(page).toContain('  oa_url: https://repository.example/paper.pdf')
    expect(page).toContain('  oa_version: acceptedVersion')
    expect(page).toContain('  oa_at: 2026-09-13')
    // And the parser reads it back as one field.
    expect(parseReadingList(page).find((e) => e.url === 'https://acs.invalid/paper')?.oa).toEqual({
      url: 'https://repository.example/paper.pdf',
      version: 'acceptedVersion',
      at: '2026-09-13',
      // The reconcile step writes what the ingest's manifest knew; nobody measured a size here.
      chars: null,
    })
  })

  it('leaves the version line out when the resolver stated none, rather than writing words into it', async () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_WITH_REFS)
    const job = store.create({ source: 'url', type: 'web', url: 'https://acs.invalid/paper' })
    store.transition(job.job.id, 'preprocessing')
    store.transition(job.job.id, 'ingesting')
    store.transition(job.job.id, 'done', { patch: { createdPages: ['wiki/sources/A Paper.md'] } })
    const jobDir = path.join(vaultRoot, '.raw', job.job.id)
    fs.mkdirSync(jobDir, { recursive: true })
    fs.writeFileSync(
      path.join(jobDir, 'manifest.json'),
      JSON.stringify({ oa: { url: 'https://repository.example/paper.pdf', version: null } }),
      'utf8',
    )
    const reading = new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false })
    await reading.reconcile('2026-09-13')
    const page = fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')
    expect(page).not.toContain('oa_version')
    expect(parseReadingList(page).find((e) => e.url === 'https://acs.invalid/paper')?.oa).toEqual({
      url: 'https://repository.example/paper.pdf',
      version: null,
      at: '2026-09-13',
      chars: null,
    })
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
      // The PDF was dropped in and ingested; that page is what the ingest wrote.
      held: (page: string) => page === 'wiki/sources/Approved Antibodies.md',
    }
    const reading = new ReadingListService(vaultRoot, store, opts)
    expect(reading.entries()[0]).toMatchObject({ page: 'wiki/sources/Approved Antibodies.md', via: 'url', job: null, held: true })

    const filed = await reading.reconcile('2026-09-08')
    expect(filed).toHaveLength(1)
    expect(filed[0]!.entry).toMatchObject({ title: 'An article whose url carries no identifier', by: 'Beatrice' })
    expect(fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')).toContain('  filed: wiki/sources/Approved Antibodies.md')
  })

  /*
   * The same match, and the opposite answer (2026-09-14).
   *
   * A research step reads a publication on the web and writes a source page from it, and that
   * page carries the publication's url and DOI - which is exactly what `byUrl` and `byRef`
   * match on. So an entry could find the write-up its own request had produced and be marked
   * as arrived: the board said "in the vault", the ingest button disappeared, and the Fellow
   * that asked was told to go read a document the vault does not have. Finding a page and
   * holding the document are two questions, and only the source index answers the second.
   */
  it('a page written ABOUT the publication is not the publication, and does not close the entry', async () => {
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE_WITHOUT_A_REF)
    const reading = new ReadingListService(vaultRoot, store, {
      commitMutex: new Mutex(),
      autoCommit: () => false,
      byUrl: (url: string) =>
        urlKey(url) === 'https://journal.invalid/abt/article/9/3/332/8697373' ? { page: 'wiki/sources/Approved Antibodies.md' } : undefined,
      // No ingest ever ran: the page exists because a run read the paper on the web.
      held: () => false,
    })
    // The row still says where it is written up - that is worth seeing - but not that it arrived.
    expect(reading.entries()[0]).toMatchObject({ page: 'wiki/sources/Approved Antibodies.md', via: 'url', held: false })

    expect(await reading.reconcile('2026-09-08')).toHaveLength(0)
    const page = fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')
    expect(page).not.toContain('  filed:')
    expect(page).not.toContain('  filedAt:')
    expect(parseReadingList(page)[0]).toMatchObject({ filed: null, filedAt: null })
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
    oa: null,
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

/** The entry the route harness needs beyond the shared page: paywalled, and with a DOI. */
const PAYWALLED_WITH_DOI = `
- title: A paywalled paper that names its DOI
  url: https://publisher.example/articles/one
  ref: doi:10.1234/example.2026.001
  access: paywalled
  blocked: subscription
  by: Jane
  at: 2026-09-07
`

/** The config the route harness runs with; one shape for every server this file builds. */
const TEST_CONFIG = (vaultRoot: string): Config => ({
  vaultRoot,
  obsidianVaultName: 'vault',
  demoMode: false,
  agentsEnabled: true,
  auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
  telegram: null,
  server: { host: '127.0.0.1', port: 0, watchFolder: path.join(vaultRoot, 'inbox'), maxUploadBytes: 1024, authMode: 'local-single-user' },
})

describe('the reading list route', () => {
  let vaultRoot: string
  let db: Db
  let app: FastifyInstance
  let store: JobStore

  beforeEach(async () => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, READING_LIST_PAGE), PAGE + PAYWALLED_WITH_DOI)
    db = openDb(MEMORY_DB)
    const events = new EventBus()
    store = new JobStore(db, events)
    const config: Config = TEST_CONFIG(vaultRoot)
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
    expect(listed.entries).toHaveLength(4)
    expect(listed.entries.map((e) => e.reach)).toEqual(['unknown', 'unknown', 'paywalled', 'paywalled'])
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

  /**
   * "Find open-access" (docs/sources/SPEC.md 6.3, extended 2026-09-14). The finder itself is
   * stubbed: what it does is `recoverOpenAccess`, which is tested where it lives. What is asked
   * here is who may trigger it, and what a find leaves behind.
   */
  it('says which entries can be looked up at all', async () => {
    const entries = ((await app.inject({ method: 'GET', url: '/api/v1/reading-list' })).json() as {
      entries: Array<{ title: string; oaEligible: boolean; oa: unknown }>
    }).entries
    // Paywalled AND carrying an identity: the DOI entry and the arXiv one are eligible - but the
    // arXiv entry is open, so only the paywalled pair is offered the button.
    expect(entries.filter((e) => e.oaEligible).map((e) => e.title)).toEqual(['A paywalled paper that names its DOI'])
    // The other paywalled entry names no DOI, arXiv id or PMC id: nothing to ask about.
    expect(entries.find((e) => e.title === 'Three papers nobody could open')?.oaEligible).toBe(false)
  })

  it('writes a verified copy into the entry, and refuses a second search for it', async () => {
    const asked: Array<{ url: string; ref: string | null }> = []
    const server = await buildServer({
      config: TEST_CONFIG(vaultRoot),
      store,
      chat: new ChatStore(db),
      queue: new IngestQueue({ store, vaultRoot, auth: TEST_CONFIG(vaultRoot).auth, runIngest: async () => { throw new Error('no agent') } }),
      events: new EventBus(),
      maintenance: new MaintenanceRunner({ vaultRoot, auth: TEST_CONFIG(vaultRoot).auth, events: new EventBus(), commitMutex: new Mutex() }),
      logger: false,
      reading: new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false }),
      findOpenAccess: async (entry) => {
        asked.push({ url: entry.url, ref: entry.ref })
        return { found: true, url: 'https://repository.example/paper.pdf', version: 'acceptedVersion', chars: 35_718 }
      },
    })
    try {
      const res = await server.inject({ method: 'POST', url: '/api/v1/reading-list/open-access', payload: { url: 'https://publisher.example/articles/one' } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ found: true, oa: { url: 'https://repository.example/paper.pdf', chars: 35_718 } })
      expect(asked).toEqual([{ url: 'https://publisher.example/articles/one', ref: 'doi:10.1234/example.2026.001' }])

      // The mark is on the page, with what the verification measured, and the entry is no longer
      // eligible - a copy is never searched for twice, and never overwritten.
      const marked = parseReadingList(fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8'))
      expect(marked.find((e) => e.url === 'https://publisher.example/articles/one')?.oa).toEqual({
        url: 'https://repository.example/paper.pdf',
        version: 'acceptedVersion',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown as string,
        chars: 35_718,
      })
      const again = await server.inject({ method: 'POST', url: '/api/v1/reading-list/open-access', payload: { url: 'https://publisher.example/articles/one' } })
      expect(again.statusCode).toBe(409)
      expect(asked).toHaveLength(1)

      // An entry with no identity, and one that is not on the list at all.
      expect((await server.inject({ method: 'POST', url: '/api/v1/reading-list/open-access', payload: { url: 'https://acs.invalid/lithium-sulfur' } })).statusCode).toBe(409)
      expect((await server.inject({ method: 'POST', url: '/api/v1/reading-list/open-access', payload: { url: 'https://example.invalid/elsewhere' } })).statusCode).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('leaves the page alone when nothing was found, and says why', async () => {
    const server = await buildServer({
      config: TEST_CONFIG(vaultRoot),
      store,
      chat: new ChatStore(db),
      queue: new IngestQueue({ store, vaultRoot, auth: TEST_CONFIG(vaultRoot).auth, runIngest: async () => { throw new Error('no agent') } }),
      events: new EventBus(),
      maintenance: new MaintenanceRunner({ vaultRoot, auth: TEST_CONFIG(vaultRoot).auth, events: new EventBus(), commitMutex: new Mutex() }),
      logger: false,
      reading: new ReadingListService(vaultRoot, store, { commitMutex: new Mutex(), autoCommit: () => false }),
      findOpenAccess: async () => ({ found: false, reason: 'no open copy cleared the bar (tried 2)' }),
    })
    try {
      const before = fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')
      const res = await server.inject({ method: 'POST', url: '/api/v1/reading-list/open-access', payload: { url: 'https://publisher.example/articles/one' } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ found: false, reason: 'no open copy cleared the bar (tried 2)' })
      expect(fs.readFileSync(path.join(vaultRoot, READING_LIST_PAGE), 'utf8')).toBe(before)
    } finally {
      await server.close()
    }
  })
})

describe('signing the entries a run added', () => {
  let vaultRoot: string
  let db: Db
  let store: JobStore
  let page: string

  const BEFORE = `---
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

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-sign-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    page = path.join(vaultRoot, READING_LIST_PAGE)
    fs.writeFileSync(page, BEFORE)
    db = openDb(MEMORY_DB)
    store = new JobStore(db, new EventBus())
  })
  afterEach(() => {
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const okResult = (): AgentRunResult => ({ ok: true, result: 'done', usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 }, durationMs: 1, numTurns: 1, sessionId: 's', timedOut: false })
  const waitSettled = async (runner: MaintenanceRunner, id: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      const run = runner.getRun(id)
      if (run !== undefined && run.status !== 'running') return
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('run never settled')
  }

  it('puts the run on the by line of what it added, and leaves the rest of the entry and the page alone', async () => {
    /*
     * The failure this exists for: an ingest that found four publications signed them with
     * the name it saw on the entries above - a retired Fellow's - and the recap and that
     * Fellow's notebook took its word for it. The service knows who ran, so it says so.
     */
    const reading = new ReadingListService(vaultRoot, store)
    const before = reading.urlKeys()
    expect(before.size).toBe(2)
    // The run appends three entries: one signed with a name it copied, one unsigned, and one
    // the page already had (a duplicate the parser folds away, and not the run's to sign).
    fs.appendFileSync(
      page,
      '\n- title: "A paper the ingest found"\n  url: https://publisher.invalid/found?utm_source=x\n  domain: ai-tooling\n  why: The primary source behind the article.\n  access: open\n  by: Ada\n  at: 2026-09-10\n' +
        '\n- title: A paper without a signature\n  url: https://publisher.invalid/unsigned\n  why: Cited twice.\n  at: 2026-09-10\n' +
        '\n- title: A preprint the user fetched by hand\n  url: https://arxiv.org/abs/2506.20907\n  by: Ada\n  at: 2026-09-10\n',
    )
    const signed = await reading.attributeRun('ingest', before)
    expect(signed).toEqual([
      { title: '"A paper the ingest found"', url: 'https://publisher.invalid/found?utm_source=x', was: 'Ada' },
      { title: 'A paper without a signature', url: 'https://publisher.invalid/unsigned', was: null },
    ])
    const after = parseReadingList(fs.readFileSync(page, 'utf8'))
    expect(after.map((e) => e.by)).toEqual(['Ada', 'Jane', 'ingest', 'ingest'])
    // Everything else the agent wrote about the publication stays, and the page's own entries are untouched.
    expect(after[2]).toMatchObject({ why: 'The primary source behind the article.', access: 'open', domain: 'ai-tooling', at: '2026-09-10' })
    expect(after[3]).toMatchObject({ why: 'Cited twice.', at: '2026-09-10' })
    expect(after[0]).toMatchObject({ by: 'Ada', why: 'The only campaign that pooled heterogeneous sites.' })
    // The added line sits inside its entry's block, not at the end of the page.
    expect(fs.readFileSync(page, 'utf8')).toMatch(/why: Cited twice\.\n {2}at: 2026-09-10\n {2}by: ingest\n/)
    // Signed once: a second pass finds nothing to do and does not touch the file.
    expect(await reading.attributeRun('ingest', before)).toEqual([])
    // And a run that added nothing changes nothing.
    expect(await reading.attributeRun('ingest', reading.urlKeys())).toEqual([])
  })

  it('leaves alone what another run committed in the meantime', async () => {
    const git = (...args: string[]): string => execFileSync('git', ['-C', vaultRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'seed')
    const reading = new ReadingListService(vaultRoot, store)
    const before = reading.urlKeys()
    // Another run adds an entry and commits it while this one is still working.
    fs.appendFileSync(page, "\n- title: Someone else's find\n  url: https://other.invalid/find\n  by: Jane\n  at: 2026-09-10\n")
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'the other run')
    // This run adds its own, under a copied name.
    fs.appendFileSync(page, "\n- title: This run's find\n  url: https://mine.invalid/find\n  by: Jane\n  at: 2026-09-10\n")
    const signed = await reading.attributeRun('research', before)
    expect(signed.map((s) => s.title)).toEqual(["This run's find"])
    expect(parseReadingList(fs.readFileSync(page, 'utf8')).map((e) => e.by)).toEqual(['Ada', 'Jane', 'Jane', 'research'])
  })

  it('a maintenance run without a Fellow is told to sign as its kind, and the service holds it to that', async () => {
    const reading = new ReadingListService(vaultRoot, store)
    let extra = ''
    const pathspecs: string[][] = []
    const runner = new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex: new Mutex(),
      reading,
      runAgent: async (opts) => {
        extra = opts.systemPromptExtra ?? ''
        // The agent copies the name it sees on the page.
        fs.appendFileSync(page, '\n- title: A paper the research found\n  url: https://publisher.invalid/research\n  why: Primary source.\n  by: Ada\n  at: 2026-09-10\n')
        return okResult()
      },
      commit: async (_root, _message, opts) => {
        pathspecs.push([...(opts?.pathspec ?? [])])
        return { committed: true, hash: 'h', committedPages: [] }
      },
    })
    const run = runner.startResearch('Sodium-ion cathodes', 'sota')
    await waitSettled(runner, run.id)
    expect(extra).toContain('<reading_list>')
    expect(extra).toContain('by: research')
    expect(parseReadingList(fs.readFileSync(page, 'utf8')).map((e) => e.by)).toEqual(['Ada', 'Jane', 'research'])
    // In the run's own commit, not a commit of its own.
    expect(pathspecs).toHaveLength(1)
    expect(pathspecs[0]).toContain(READING_LIST_PAGE)
  })

  it("a Fellow's run signs with the Fellow's name", async () => {
    const reading = new ReadingListService(vaultRoot, store)
    const fellow: FellowRunContext = {
      agentId: 'a1',
      name: 'Cleo',
      slug: 'cleo',
      notebookPath: 'wiki/meta/agents/cleo.md',
      intent: 'sparse array scaling',
      scope: null,
      model: 'claude-sonnet-5',
      effort: 'high',
      maxBudgetUsd: 6,
      recentLog: [],
      today: '2026-09-10',
    }
    let extra = ''
    const runner = new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex: new Mutex(),
      reading,
      runAgent: async (opts) => {
        extra = opts.systemPromptExtra ?? ''
        fs.appendFileSync(page, '\n- title: A paper the step found\n  url: https://publisher.invalid/step\n  by: Ada\n  at: 2026-09-10\n')
        return okResult()
      },
      commit: async () => ({ committed: true, hash: 'h', committedPages: [] }),
    })
    const run = runner.startResearchStep('Sodium-ion cathodes', 'sota', fellow)
    await waitSettled(runner, run.id)
    expect(extra).toContain('by: Cleo')
    expect(parseReadingList(fs.readFileSync(page, 'utf8')).map((e) => e.by)).toEqual(['Ada', 'Jane', 'Cleo'])
  })
})
