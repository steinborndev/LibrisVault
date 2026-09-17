/**
 * Open-access recovery inside a URL job (docs/sources/SPEC.md section 5).
 *
 * HTTP is stubbed at the pinned-request seam and the converters are mocked: what is under test is
 * which candidate is chosen, what has to be true before it is accepted, and what the job then
 * says about itself. That every candidate address passes the SSRF guard and the caps is a
 * property of its own and lives in `oa-guard.test.ts`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { doiFromHtml, doiFromUrl } from '../src/pipeline/identifiers.js'
import {
  OA_MIN_FULL_TEXT_CHARS,
  bestUntriedCandidate,
  lookupExhausted,
  lookupIsFresh,
  lookupSaysNothing,
  oaBanner,
  oaCacheOver,
  orderCandidates,
  type OaCandidate,
  type OaDisclosure,
  type OaLookup,
} from '../src/pipeline/preprocess/oa.js'
import { renderOaNotice } from '../src/pipeline/system-prompt.js'
import { documentTextOf } from '../src/pipeline/preprocess/fence.js'
import type { PinnedRequestFn, PinnedResponse } from '../src/pipeline/preprocess/fetch.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/types.js'

vi.mock('../src/pipeline/preprocess/sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline/preprocess/sandbox.js')>()
  return {
    ...actual,
    runConverter: async (bin: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
      if (bin === 'pdftotext') {
        fs.writeFileSync(args[args.length - 1]!, converted, 'utf8')
        return { stdout: '', stderr: '' }
      }
      if (bin === 'pandoc') {
        // The JATS lane reads on stdout so a rejected candidate leaves nothing behind; the
        // office lane still writes a file. Both shapes are answered here.
        const at = args.indexOf('-o')
        if (at === -1) return { stdout: converted, stderr: '' }
        fs.writeFileSync(args[at + 1]!, converted, 'utf8')
        return { stdout: '', stderr: '' }
      }
      throw new Error(`the test did not expect ${bin}`)
    },
  }
})

const { preprocessUrl } = await import('../src/pipeline/preprocess/web.js')

/** What the mocked converter produces for the copy under test. */
let converted = ''

const TOOLS: ToolAvailability = {
  pdftotext: true,
  pdfinfo: false,
  ocrmypdf: false,
  pandoc: true,
  python3: false,
  exiftool: false,
  // Off on purpose: the built-in HTML-to-text fallback keeps these tests about the lanes.
  defuddle: false,
  ytDlp: false,
  deno: false,
}

const DOI = '10.1234/example.2026.001'
const fullText = (chars = OA_MIN_FULL_TEXT_CHARS + 500): string => 'A sentence of the paper. '.repeat(Math.ceil(chars / 25))
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('document bytes')])

/** A publisher page with just an abstract on it, and its own DOI in a citation meta tag. */
const abstractPage = (doi = DOI): string =>
  `<html><head><meta name="citation_doi" content="${doi}"></head><body><article><p>${'Abstract sentence. '.repeat(30)}</p></article></body></html>`

interface Answer {
  readonly status?: number
  readonly contentType?: string
  readonly body?: Buffer | string
}

describe('a URL job that cannot read its page (docs/sources/SPEC.md section 5)', () => {
  let vaultRoot: string
  let asked: string[]

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-'))
    asked = []
    converted = fullText()
  })
  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const resolve = async (): Promise<string[]> => ['93.184.216.34']

  /** Answers by host + path prefix; anything unmatched is a 404, which is what a wrong URL is. */
  const routes = (table: Record<string, Answer>): PinnedRequestFn =>
    async (v): Promise<PinnedResponse> => {
      asked.push(v.url.href)
      const key = Object.keys(table).find((k) => v.url.href.startsWith(k))
      const answer = key === undefined ? { status: 404 } : table[key]!
      const body = answer.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.body)
      return { status: answer.status ?? 200, contentType: answer.contentType ?? 'text/html', body }
    }

  const openalex = (locations: unknown[], retracted = false): Answer => ({
    contentType: 'application/json',
    body: JSON.stringify({ id: 'https://openalex.org/W1', is_retracted: retracted, open_access: { is_oa: true }, best_oa_location: locations[0] ?? null, locations }),
  })

  const europepmc = (record: Record<string, unknown>): Answer => ({
    contentType: 'application/json',
    body: JSON.stringify({ resultList: { result: [record] } }),
  })

  const run = async (
    url: string,
    request: PinnedRequestFn,
    enabled = true,
    tools: ToolAvailability = TOOLS,
  ): Promise<import('../src/pipeline/preprocess/types.js').PreprocessResult> =>
    preprocessUrl({
      jobId: 'job-1',
      url,
      vaultRoot,
      jobDir: path.join(vaultRoot, '.raw', 'job-1'),
      resolve,
      request,
      tools,
      oa: { enabled, courtesyMs: 0, env: {}, now: () => new Date('2026-09-13T22:00:00.000Z') },
    })

  const artifactOf = (res: { primaryArtifact: string }): string => fs.readFileSync(path.join(vaultRoot, res.primaryArtifact), 'utf8')

  it('rescues a refused fetch from an open-access PDF, and the job becomes a pdf job', async () => {
    const res = await run(
      `https://doi.org/${DOI}`,
      routes({
        [`https://doi.org/${DOI}`]: { status: 403 },
        'https://api.openalex.org/': openalex([
          { is_oa: true, pdf_url: 'https://repository.example/paper.pdf', landing_page_url: 'https://repository.example/paper', version: 'acceptedVersion', license: 'cc-by', source: { display_name: 'Repository' } },
        ]),
        'https://repository.example/paper.pdf': { contentType: 'application/pdf', body: PDF_BYTES },
      }),
    )
    expect(res.type).toBe('pdf')
    expect(res.manifest.oa).toMatchObject({
      doi: DOI,
      kind: 'rescued',
      url: 'https://repository.example/paper.pdf',
      source: 'openalex',
      host: 'repository.example',
      version: 'acceptedVersion',
      license: 'cc-by',
      retracted: false,
    })
    // The requested address stays the job's own (D3).
    expect(res.manifest.url).toBe(`https://doi.org/${DOI}`)
    expect(res.manifest.original).toBe('oa-copy.pdf')
    expect(res.manifest.normalized).toBe('normalized.txt')
    const artifact = artifactOf(res)
    expect(artifact.split('\n')[1]).toBe(
      'Text from an open-access copy (acceptedVersion) at repository.example: https://repository.example/paper.pdf. The requested address could not be read.',
    )
    expect(documentTextOf(artifact).trim()).toBe(converted.trim())
    expect(res.manifest.notes.join(' ')).toMatch(/open access: rescued from openalex \(acceptedVersion\) at repository\.example/)
  })

  it('substitutes an abstract-only page from the Europe PMC full text', async () => {
    const res = await run(
      'https://publisher.example/articles/one',
      routes({
        'https://publisher.example/articles/one': { body: abstractPage() },
        // OpenAlex knows the work but has no open location for it.
        'https://api.openalex.org/': openalex([]),
        'https://www.ebi.ac.uk/europepmc/webservices/rest/search': europepmc({ pmcid: 'PMC1234567', isOpenAccess: 'Y', license: 'cc-by-nc' }),
        'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1234567/fullTextXML': { contentType: 'application/xml', body: '<article><body><p>full text</p></body></article>' },
      }),
    )
    // A substituted source stays a web job; only the text came from somewhere else.
    expect(res.type).toBe('web')
    expect(res.manifest.oa).toMatchObject({ kind: 'substituted', source: 'europepmc', host: 'europepmc.org', version: 'publishedVersion' })
    expect(res.manifest.original).toBe('oa-copy.xml')
    expect(artifactOf(res)).toContain('The requested address was read as an abstract only.')
    // The DOI came out of the page's own meta tag, not out of the address.
    expect(res.manifest.oa?.doi).toBe(DOI)
  })

  it('keeps a thin page when every copy is thinner, and says what it tried', async () => {
    converted = 'A record page with a title, the authors and two lines of summary.'
    const res = await run(
      'https://publisher.example/articles/one',
      routes({
        'https://publisher.example/articles/one': { body: abstractPage() },
        'https://api.openalex.org/': openalex([
          { is_oa: true, pdf_url: 'https://repository.example/record.pdf', landing_page_url: null, version: 'publishedVersion', license: null, source: { display_name: 'Repository' } },
        ]),
        'https://repository.example/record.pdf': { contentType: 'application/pdf', body: PDF_BYTES },
      }),
    )
    expect(res.manifest.oa).toBeUndefined()
    expect(res.type).toBe('web')
    expect(res.manifest.notes.join(' ')).toMatch(/the copy at repository\.example is \d+ characters, not full text/)
    expect(res.manifest.notes).toContain('no open copy cleared the bar (tried 1)')
    // The thin text is still what the job ingests: an abstract is better than nothing.
    expect(documentTextOf(artifactOf(res))).toMatch(/Abstract sentence/)
  })

  it('fails a refused fetch as before when the address names no DOI', async () => {
    await expect(
      run('https://publisher.example/articles/one', routes({ 'https://publisher.example/articles/one': { status: 403 } })),
    ).rejects.toThrow(/HTTP 403 .*save the page from your browser/s)
    // Nothing was asked of any resolver: without a DOI there is nothing to ask about.
    expect(asked.filter((a) => a.includes('openalex'))).toEqual([])
  })

  it('appends what it tried to the error when a rescue finds nothing', async () => {
    await expect(
      run(
        `https://doi.org/${DOI}`,
        routes({ [`https://doi.org/${DOI}`]: { status: 401 }, 'https://api.openalex.org/': openalex([]) }),
      ),
    ).rejects.toThrow(/HTTP 401 .*no open copy cleared the bar \(tried 0\)/s)
  })

  it('carries a retraction into the manifest and into the banner', async () => {
    const res = await run(
      `https://doi.org/${DOI}`,
      routes({
        [`https://doi.org/${DOI}`]: { status: 403 },
        'https://api.openalex.org/': openalex(
          [{ is_oa: true, pdf_url: null, landing_page_url: 'https://repository.example/paper', version: 'publishedVersion', license: null, source: { display_name: 'Repository' } }],
          true,
        ),
        'https://repository.example/paper': { body: `<html><body><article><p>${fullText()}</p></article></body></html>` },
      }),
    )
    expect(res.manifest.oa?.retracted).toBe(true)
    expect(artifactOf(res)).toContain('OpenAlex marks this work as retracted.')
    expect(res.manifest.notes.join(' ')).toMatch(/OpenAlex marks this work as retracted/)
  })

  it('takes the copy a reading-list entry names, before any resolver and without a DOI', async () => {
    /*
     * The board's one click (6.3): it posts the ENTRY's address, which here is a publisher page
     * with no DOI anywhere - the entry's identity was an arXiv id. Without the hint the job would
     * fail on the same wall the Fellow met.
     */
    const request = routes({
      'https://publisher.example/articles/one': { status: 403 },
      'https://arxiv.org/pdf/2506.20907': { contentType: 'application/pdf', body: PDF_BYTES },
    })
    const res = await preprocessUrl({
      jobId: 'job-1',
      url: 'https://publisher.example/articles/one',
      vaultRoot,
      jobDir: path.join(vaultRoot, '.raw', 'job-1'),
      resolve,
      request,
      tools: TOOLS,
      oa: { enabled: true, courtesyMs: 0, env: {}, hint: { url: 'https://arxiv.org/pdf/2506.20907', version: 'submittedVersion' } },
    })
    expect(res.type).toBe('pdf')
    expect(res.manifest.oa).toMatchObject({
      kind: 'rescued',
      url: 'https://arxiv.org/pdf/2506.20907',
      source: 'reading-list',
      host: 'arxiv.org',
      version: 'submittedVersion',
    })
    // No resolver was asked: the address was already known.
    expect(asked.filter((a) => a.includes('openalex'))).toEqual([])
    // And it is a candidate like any other - the same gate and the same bars.
    expect(asked).toContain('https://arxiv.org/pdf/2506.20907')
  })

  it('falls back to the resolvers when the entry\'s copy does not work out', async () => {
    const request = routes({
      [`https://doi.org/${DOI}`]: { status: 403 },
      // The hinted copy is a record page, under the full-text bar.
      // A record page: long enough to pass the junk gate, too short to be the paper.
      'https://repository.example/stale': { body: `<html><body><p>${'A record page with a title and two authors. '.repeat(10)}</p></body></html>` },
      'https://api.openalex.org/': openalex([
        { is_oa: true, pdf_url: null, landing_page_url: 'https://repository.example/paper', version: 'publishedVersion', license: null, source: { display_name: 'Repository' } },
      ]),
      'https://repository.example/paper': { body: `<html><body><article><p>${fullText()}</p></article></body></html>` },
    })
    const res = await preprocessUrl({
      jobId: 'job-1',
      url: `https://doi.org/${DOI}`,
      vaultRoot,
      jobDir: path.join(vaultRoot, '.raw', 'job-1'),
      resolve,
      request,
      tools: TOOLS,
      oa: { enabled: true, courtesyMs: 0, env: {}, hint: { url: 'https://repository.example/stale' } },
    })
    expect(res.manifest.oa).toMatchObject({ source: 'openalex', url: 'https://repository.example/paper' })
    expect(res.manifest.notes.join(' ')).toMatch(/the copy at repository\.example is \d+ characters, not full text/)
  })

  it('does nothing at all when the setting is off', async () => {
    await expect(
      run(`https://doi.org/${DOI}`, routes({ [`https://doi.org/${DOI}`]: { status: 403 } }), false),
    ).rejects.toThrow(/HTTP 403/)
    expect(asked).toEqual([`https://doi.org/${DOI}`])
  })

  it('never asks about an arXiv address: the PDF lane already reads the full text', async () => {
    const res = await run(
      'https://arxiv.org/abs/2506.20907',
      routes({ 'https://arxiv.org/pdf/2506.20907': { contentType: 'application/pdf', body: PDF_BYTES } }),
    )
    expect(res.type).toBe('pdf')
    expect(res.manifest.oa).toBeUndefined()
    expect(asked.filter((a) => a.includes('openalex'))).toEqual([])
  })
  /*
   * A round that tried copies and found none usable is an ANSWER (5.5). Before this was fixed,
   * `lookupIsFresh` called such a round fresh but the early return demanded an empty candidate
   * list, so every job and every nightly sweep asked all three APIs again.
   */
  it('does not ask again within the week after a round that tried copies and found none', async () => {
    const rows = new Map<string, { checkedAt: string; found: boolean; result: unknown }>()
    const store = {
      get: (doi: string) => rows.get(doi.toLowerCase()),
      put: (doi: string, found: boolean, result: unknown) => rows.set(doi.toLowerCase(), { checkedAt: new Date().toISOString(), found, result }),
    }
    const cache = oaCacheOver(store)
    converted = 'A record page with a title and two lines of summary.'
    const request = routes({
      [`https://doi.org/${DOI}`]: { status: 403 },
      'https://api.openalex.org/': openalex([
        { is_oa: true, pdf_url: 'https://repository.example/record.pdf', landing_page_url: null, version: 'publishedVersion', license: null, source: { display_name: 'Repository' } },
      ]),
      'https://repository.example/record.pdf': { contentType: 'application/pdf', body: PDF_BYTES },
    })
    const attempt = async (at: string): Promise<void> => {
      asked = []
      await expect(
        preprocessUrl({
          jobId: 'job-1',
          url: `https://doi.org/${DOI}`,
          vaultRoot,
          jobDir: path.join(vaultRoot, '.raw', 'job-1'),
          resolve,
          request,
          tools: TOOLS,
          oa: { enabled: true, courtesyMs: 0, env: {}, cache, now: () => new Date(at) },
        }),
      ).rejects.toThrow(/HTTP 403/)
    }

    await attempt('2026-09-13T22:00:00.000Z')
    expect(asked.filter((a) => a.includes('openalex'))).toHaveLength(1)
    // A copy exists (so the row counts as `found`), but none of them read as full text.
    expect(rows.get(DOI)?.found).toBe(true)
    expect((rows.get(DOI)?.result as { accepted: unknown; tried: unknown[] }).accepted).toBeNull()
    expect((rows.get(DOI)?.result as { tried: unknown[] }).tried).toHaveLength(1)
    // One candidate was tried and remembered, so the next job goes straight past the resolvers.
    await attempt('2026-09-16T22:00:00.000Z')
    expect(asked.filter((a) => a.includes('openalex'))).toEqual([])
    expect(asked.filter((a) => a.includes('repository.example'))).toEqual([])
    // Eight days on, the question is worth asking again: a copy may have been deposited.
    await attempt('2026-09-21T22:00:00.000Z')
    expect(asked.filter((a) => a.includes('openalex'))).toHaveLength(1)
  })

  it('records a rate-limited resolver as rate limited, and asks again next time', async () => {
    const rows = new Map<string, { checkedAt: string; found: boolean; result: unknown }>()
    const store = {
      get: (doi: string) => rows.get(doi.toLowerCase()),
      put: (doi: string, found: boolean, result: unknown) => rows.set(doi.toLowerCase(), { checkedAt: new Date().toISOString(), found, result }),
    }
    const cache = oaCacheOver(store)
    const request = routes({ [`https://doi.org/${DOI}`]: { status: 403 }, 'https://api.openalex.org/': { status: 429 } })
    const once = async (): Promise<void> => {
      asked = []
      await expect(
        preprocessUrl({
          jobId: 'job-1',
          url: `https://doi.org/${DOI}`,
          vaultRoot,
          jobDir: path.join(vaultRoot, '.raw', 'job-1'),
          resolve,
          request,
          tools: TOOLS,
          oa: { enabled: true, courtesyMs: 0, env: {}, cache, now: () => new Date('2026-09-13T22:00:00.000Z') },
        }),
      ).rejects.toThrow(/HTTP 403/)
    }
    await once()
    // Two retries, then the round is recorded as rate limited rather than as an absence.
    expect(asked.filter((a) => a.includes('openalex'))).toHaveLength(3)
    expect((rows.get(DOI)?.result as { rateLimited: boolean }).rateLimited).toBe(true)
    // A rate limit is not an answer, so the next job asks again.
    await once()
    expect(asked.filter((a) => a.includes('openalex'))).toHaveLength(3)
  })

  it('leaves nothing in the job directory for a candidate it rejected', async () => {
    converted = 'A record page with a title and two lines of summary.'
    const res = await run(
      'https://publisher.example/articles/one',
      routes({
        'https://publisher.example/articles/one': { body: abstractPage() },
        'https://api.openalex.org/': openalex([
          { is_oa: true, pdf_url: 'https://repository.example/record.pdf', landing_page_url: 'https://repository.example/record', version: 'publishedVersion', license: null, source: { display_name: 'Repository' } },
        ]),
        'https://repository.example/record.pdf': { contentType: 'application/pdf', body: PDF_BYTES },
        'https://repository.example/record': { body: `<html><body><p>${converted}</p></body></html>` },
      }),
    )
    expect(res.manifest.oa).toBeUndefined()
    /*
     * `.raw/<job-id>/` is committed with the job: a copy that turned out to be a record page
     * must not ride into the vault beside the document, and two rejected formats must not leave
     * two `oa-copy.*` files behind.
     */
    const left = fs.readdirSync(path.join(vaultRoot, '.raw', 'job-1'))
    expect(left.filter((f) => f.startsWith('oa-'))).toEqual([])
    expect(left.sort()).toEqual(['manifest.json', 'normalized.md', 'raw.html'])
  })

  it('rescues a document the PDF lane declined', async () => {
    // A textless PDF over the OCR page limit: the lane defers it, as it does for a dropped file.
    converted = `${'\f'.repeat(320)}`
    // A publisher's document address that names the DOI, which is where a rescue gets one from:
    // a PDF has no meta tags to read (5.1).
    const res = await run(
      `https://publisher.example/pdf/${DOI}`,
      routes({
        [`https://publisher.example/pdf/${DOI}`]: { contentType: 'application/pdf', body: PDF_BYTES },
        'https://api.openalex.org/': openalex([
          { is_oa: true, pdf_url: null, landing_page_url: 'https://repository.example/paper', version: 'publishedVersion', license: 'cc-by', source: { display_name: 'Repository' } },
        ]),
        'https://repository.example/paper': { body: `<html><body><article><p>${fullText()}</p></article></body></html>` },
      }),
      true,
      { ...TOOLS, ocrmypdf: true },
    )
    expect(res.deferred).toBe(false)
    expect(res.type).toBe('web')
    expect(res.manifest.oa).toMatchObject({ kind: 'rescued', host: 'repository.example' })
    expect(res.manifest.notes.join(' ')).toMatch(/deferred/)
  })

  it('keeps the contact address out of every line it writes (D15)', async () => {
    const mail = 'someone@example.org'
    asked = []
    const notes: string[] = []
    const headersSeen: Array<Readonly<Record<string, string>> | undefined> = []
    const request: PinnedRequestFn = async (v, _t, _m, headers) => {
      asked.push(v.url.href)
      if (v.url.hostname === 'api.openalex.org') {
        headersSeen.push(headers)
        // A 404 is what a DOI OpenAlex does not know answers with, and its message is a note.
        return { status: 404, contentType: 'application/json', body: Buffer.alloc(0) }
      }
      return { status: 403, contentType: 'text/html', body: Buffer.alloc(0) }
    }
    await expect(
      preprocessUrl({
        jobId: 'job-1',
        url: `https://doi.org/${DOI}`,
        vaultRoot,
        jobDir: path.join(vaultRoot, '.raw', 'job-1'),
        resolve,
        request,
        tools: TOOLS,
        oa: { enabled: true, courtesyMs: 0, env: { OA_CONTACT_EMAIL: mail } },
      }),
    ).rejects.toThrow(/HTTP 403/)
    // It reached OpenAlex as a User-Agent, which no error message repeats...
    expect(headersSeen[0]?.['user-agent']).toBe(`vault-service/0.1 (mailto:${mail})`)
    // ...and nowhere in the address, which every failure line quotes.
    expect(asked.join(' ')).not.toContain('example.org')
    expect(notes.join(' ')).not.toContain('example.org')
  })
})

describe('the lookup table (5.5)', () => {
  /** A store in memory with the shape `OaLookupStore` has. */
  const memory = (): { rows: Map<string, { checkedAt: string; found: boolean; result: unknown }> } & {
    get(doi: string): { checkedAt: string; result: unknown } | undefined
    put(doi: string, found: boolean, result: unknown): void
  } => {
    const rows = new Map<string, { checkedAt: string; found: boolean; result: unknown }>()
    return {
      rows,
      get: (doi) => rows.get(doi.toLowerCase()),
      put: (doi, found, result) => rows.set(doi.toLowerCase(), { checkedAt: new Date().toISOString(), found, result }),
    }
  }

  const lookup = (over: Partial<OaLookup> = {}): OaLookup => ({
    doi: DOI,
    checkedAt: '2026-09-13T00:00:00.000Z',
    candidates: [],
    tried: [],
    retracted: false,
    rateLimited: false,
    accepted: null,
    ...over,
  })

  it('reuses a find at once and a blank for seven days, and asks again after that', () => {
    const now = new Date('2026-09-13T00:00:00.000Z')
    expect(lookupIsFresh(lookup({ accepted: { url: 'u', format: 'pdf', version: null, host: 'h', license: null, source: 'openalex' } }), now)).toBe(true)
    expect(lookupIsFresh(lookup(), now)).toBe(true)
    expect(lookupIsFresh(lookup(), new Date('2026-09-19T00:00:00.000Z'))).toBe(true)
    expect(lookupIsFresh(lookup(), new Date('2026-09-21T00:00:00.000Z'))).toBe(false)
  })

  it('only a round that named no copy at all lets a sweep skip the DOI', () => {
    const now = new Date('2026-09-13T01:00:00.000Z')
    const candidate: OaCandidate = { url: 'https://repository.example/x.pdf', format: 'pdf', version: null, host: 'repository.example', license: null, source: 'openalex' }
    expect(lookupSaysNothing(lookup(), now)).toBe(true)
    // A dry run of the sweep leaves a row like this; the entry must still get its mark.
    expect(lookupSaysNothing(lookup({ candidates: [candidate] }), now)).toBe(false)
    expect(lookupSaysNothing(lookup({ accepted: candidate }), now)).toBe(false)
    // An old blank is no answer either.
    expect(lookupSaysNothing(lookup(), new Date('2026-09-25T00:00:00.000Z'))).toBe(false)
  })

  it('never lets a rate-limited round stand as "nothing found"', () => {
    expect(lookupIsFresh(lookup({ rateLimited: true }), new Date('2026-09-13T01:00:00.000Z'))).toBe(false)
  })

  it('round-trips a round through a store and marks a find as found', () => {
    const store = memory()
    const cache = oaCacheOver(store)
    const accepted: OaCandidate = { url: 'https://repository.example/x.pdf', format: 'pdf', version: 'publishedVersion', host: 'repository.example', license: null, source: 'openalex' }
    cache.put(lookup({ accepted, candidates: [accepted], tried: [] }))
    expect(store.rows.get(DOI)?.found).toBe(true)
    expect(cache.get(DOI)?.accepted).toEqual(accepted)
    // A row from an older build is no answer rather than a crash.
    store.rows.set(DOI, { checkedAt: 'x', found: true, result: { nonsense: true } })
    expect(cache.get(DOI)).toBeUndefined()
  })
})

describe('what may be marked on a reading-list entry, and what may not (6.3)', () => {
  const candidate = (over: Partial<OaCandidate>): OaCandidate => ({
    url: 'https://repository.example/paper.pdf',
    format: 'pdf',
    version: 'publishedVersion',
    host: 'repository.example',
    license: null,
    source: 'openalex',
    ...over,
  })
  const round = (over: Partial<OaLookup>): OaLookup => ({
    doi: DOI,
    checkedAt: '2026-09-13T00:00:00.000Z',
    candidates: [],
    tried: [],
    retracted: false,
    rateLimited: false,
    accepted: null,
    ...over,
  })

  it('takes the accepted copy, else the best copy nobody has fetched yet', () => {
    const pdf = candidate({})
    const landing = candidate({ url: 'https://repository.example/paper', format: 'landing' })
    expect(bestUntriedCandidate(round({ accepted: landing, candidates: [pdf, landing] }))?.url).toBe(landing.url)
    expect(bestUntriedCandidate(round({ candidates: [landing, pdf] }))?.url).toBe(pdf.url)
    // A copy an ingest already pulled and threw away as a record page is not somewhere to send
    // the user; the next one is.
    expect(bestUntriedCandidate(round({ candidates: [pdf, landing], tried: [pdf] }))?.url).toBe(landing.url)
    expect(bestUntriedCandidate(round({ candidates: [pdf, landing], tried: [pdf, landing] }))).toBeUndefined()
  })

  it('calls a DOI exhausted only when every copy it has was fetched and none held', () => {
    const pdf = candidate({})
    expect(lookupExhausted(round({ candidates: [pdf], tried: [pdf] }))).toBe(true)
    expect(lookupExhausted(round({ candidates: [pdf] }))).toBe(false)
    expect(lookupExhausted(round({ candidates: [pdf], tried: [pdf], accepted: pdf }))).toBe(false)
    // Nothing was ever named: that is "nothing found", not "everything tried".
    expect(lookupExhausted(round({}))).toBe(false)
  })
})

describe('candidate ordering and the words of the disclosure', () => {
  const candidate = (over: Partial<OaCandidate>): OaCandidate => ({
    url: 'https://repository.example/x',
    format: 'landing',
    version: null,
    host: 'repository.example',
    license: null,
    source: 'openalex',
    ...over,
  })

  it('takes the version of record first, and inside a version the document before the page', () => {
    const ordered = orderCandidates([
      candidate({ url: 'submitted-landing', version: 'submittedVersion' }),
      candidate({ url: 'none' }),
      candidate({ url: 'published-landing', version: 'publishedVersion' }),
      candidate({ url: 'accepted-pdf', version: 'acceptedVersion', format: 'pdf' }),
      candidate({ url: 'published-pdf', version: 'publishedVersion', format: 'pdf' }),
    ]).map((c) => c.url)
    expect(ordered).toEqual(['published-pdf', 'published-landing', 'accepted-pdf', 'submitted-landing', 'none'])
  })

  const oa = (over: Partial<OaDisclosure> = {}): OaDisclosure => ({
    doi: DOI,
    kind: 'rescued',
    url: 'https://repository.example/paper.pdf',
    source: 'openalex',
    host: 'repository.example',
    version: 'acceptedVersion',
    license: 'cc-by',
    retracted: false,
    triedAt: '2026-09-13T22:00:00.000Z',
    ...over,
  })

  it('says the same two words everywhere: substituted and rescued (2.4)', () => {
    expect(oaBanner(oa())[0]).toBe(
      'Text from an open-access copy (acceptedVersion) at repository.example: https://repository.example/paper.pdf. The requested address could not be read.',
    )
    expect(oaBanner(oa({ kind: 'substituted' }))[0]).toMatch(/The requested address was read as an abstract only\./)
    expect(oaBanner(oa({ version: null }))[0]).toMatch(/\(version not stated\)/)
    expect(oaBanner(oa({ retracted: true }))[1]).toBe('OpenAlex marks this work as retracted.')
  })

  it('tells the run to keep url: and to add the three fields beside it', () => {
    const block = renderOaNotice([{ artifact: '.raw/job-1/normalized.txt', oa: oa() }])
    expect(block).toContain('<open_access_copy>')
    expect(block).toMatch(/`url:` stays the REQUESTED address/)
    expect(block).toMatch(/oa_url:.*oa_version:.*oa_source:/s)
    expect(block).toMatch(/accepted manuscript/)
    expect(renderOaNotice([{ artifact: 'a', oa: oa({ retracted: true }) }])).toMatch(/RETRACTED/)
    // No copy, no block: an ordinary job's prompt is byte-for-byte what it was.
    expect(renderOaNotice([])).toBe('')
  })
})

describe('the DOI a job has to go on (2.2)', () => {
  it('reads a DOI out of an address, however it is carried', () => {
    expect(doiFromUrl(`https://doi.org/${DOI}`)).toBe(DOI)
    expect(doiFromUrl(`https://dx.doi.org/${DOI.toUpperCase()}`)).toBe(DOI)
    expect(doiFromUrl(`https://publisher.example/doi/full/${DOI}`)).toBe(DOI)
    expect(doiFromUrl('https://publisher.example/article?doi=10.1234%2Fexample.2026.001')).toBe(DOI)
    expect(doiFromUrl('https://publisher.example/articles/one')).toBeUndefined()
  })

  it('reads a page\'s OWN doi from its meta tags, and never one out of its running text', () => {
    expect(doiFromHtml(`<meta name="citation_doi" content="${DOI}">`)).toBe(DOI)
    expect(doiFromHtml(`<meta name="DC.Identifier" content="doi:${DOI}">`)).toBe(DOI)
    expect(doiFromHtml(`<meta property="prism.doi" content="${DOI}">`)).toBe(DOI)
    expect(doiFromHtml(`<link rel="canonical" href="https://doi.org/${DOI}">`)).toBe(DOI)
    // A reference list is full of other papers' DOIs; resolving one would fetch the wrong work.
    expect(doiFromHtml(`<html><body><p>As shown in an earlier study (${DOI}), the effect holds.</p></body></html>`)).toBeUndefined()
    expect(doiFromHtml('<html><head><title>a page</title></head></html>')).toBeUndefined()
  })
})
