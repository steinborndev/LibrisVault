/**
 * The gate every open-access candidate goes through (docs/sources/SPEC.md sections 5.2 and 10).
 *
 * Written BEFORE the resolver had a body, because this is the property that matters: an address
 * that came out of OpenAlex, Europe PMC or CORE is data from a third party, and it must pass the
 * same SSRF guard and the same byte caps as an address the user typed. A resolver that could
 * reach the network any other way would be the hole the fetch layer exists to close.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { recoverOpenAccess, type OaDeps } from '../src/pipeline/preprocess/oa.js'
import { DEFAULT_MAX_BYTES, MAX_PDF_BYTES, type PinnedRequestFn } from '../src/pipeline/preprocess/fetch.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/types.js'

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

/** A body long enough to clear the full-text bar, so only the guard can be what stops a fetch. */
const FULL_TEXT = `<html><body><article><p>${'Sentence of the paper. '.repeat(600)}</p></article></body></html>`

const DOI = '10.1234/example.2026.001'

/** What OpenAlex answers: one candidate inside the network, one outside it. */
const openalexBody = (locations: unknown[]): Buffer =>
  Buffer.from(
    JSON.stringify({
      id: 'https://openalex.org/W1',
      title: 'A paper',
      is_retracted: false,
      open_access: { is_oa: true },
      best_oa_location: locations[0],
      locations,
    }),
  )

interface Asked {
  readonly href: string
  readonly maxBytes: number
}

describe('every resolver address passes the SSRF guard and the caps', () => {
  let jobDir: string
  let asked: Asked[]

  beforeEach(() => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-guard-'))
    asked = []
  })
  afterEach(() => {
    fs.rmSync(jobDir, { recursive: true, force: true })
  })

  /** Resolves the service's own network for `inside.internal`, the public internet otherwise. */
  const resolve = async (host: string): Promise<string[]> =>
    host === 'inside.internal' ? ['127.0.0.1'] : host === 'private.example' ? ['192.168.0.7'] : ['93.184.216.34']

  const deps = (request: PinnedRequestFn, extra: Partial<OaDeps> = {}): OaDeps => ({
    jobDir,
    tools: NO_TOOLS,
    resolve,
    request,
    courtesyMs: 0,
    env: {},
    ...extra,
  })

  const record = (body: Buffer, contentType: string): PinnedRequestFn =>
    async (v, _timeoutMs, maxBytes) => {
      asked.push({ href: v.url.href, maxBytes })
      if (v.url.hostname === 'api.openalex.org') return { status: 200, contentType: 'application/json', body: openalexBody(openalexLocations) }
      return { status: 200, contentType, body }
    }

  let openalexLocations: unknown[] = []

  it('never fetches a candidate whose host resolves inside the network, and still tries the next one', async () => {
    openalexLocations = [
      { is_oa: true, pdf_url: 'http://inside.internal/paper.pdf', landing_page_url: null, version: 'publishedVersion', license: 'cc-by', source: { display_name: 'Inside' } },
      { is_oa: true, pdf_url: null, landing_page_url: 'http://private.example/paper', version: 'publishedVersion', license: null, source: { display_name: 'Private' } },
      { is_oa: true, pdf_url: null, landing_page_url: 'https://repository.example/paper', version: 'acceptedVersion', license: 'cc-by', source: { display_name: 'Repository' } },
    ]
    const out = await recoverOpenAccess({
      doi: DOI,
      kind: 'rescued',
      haveChars: 0,
      deps: deps(record(Buffer.from(FULL_TEXT), 'text/html'), { tools: { ...NO_TOOLS, defuddle: false } }),
    })
    const hosts = asked.map((a) => new URL(a.href).hostname)
    expect(hosts).toContain('api.openalex.org')
    // The two addresses inside the network were never opened.
    expect(hosts).not.toContain('inside.internal')
    expect(hosts).not.toContain('private.example')
    // And the guard did not end the recovery: the public candidate was still tried and taken.
    expect(hosts).toContain('repository.example')
    expect(out.recovery?.disclosure.host).toBe('repository.example')
    expect(out.notes.join(' ')).toMatch(/SSRF|private/)
  })

  it('fetches every candidate under a cap: the PDF cap for a document, the page cap for a landing page', async () => {
    openalexLocations = [
      { is_oa: true, pdf_url: 'https://repository.example/paper.pdf', landing_page_url: 'https://repository.example/paper', version: 'publishedVersion', license: 'cc-by', source: { display_name: 'Repository' } },
    ]
    await recoverOpenAccess({
      doi: DOI,
      kind: 'rescued',
      haveChars: 0,
      deps: deps(record(Buffer.from(FULL_TEXT), 'text/html')),
    })
    const caps = new Map(asked.map((a) => [new URL(a.href).pathname, a.maxBytes]))
    expect(caps.get('/paper.pdf')).toBe(MAX_PDF_BYTES)
    expect(caps.get('/paper')).toBe(DEFAULT_MAX_BYTES)
    // The metadata request is a page, not a document.
    expect(asked.find((a) => a.href.includes('openalex'))?.maxBytes).toBe(DEFAULT_MAX_BYTES)
  })

  it('refuses a candidate that answers over its cap, and says so rather than accepting it', async () => {
    openalexLocations = [
      { is_oa: true, pdf_url: null, landing_page_url: 'https://repository.example/huge', version: 'publishedVersion', license: null, source: { display_name: 'Repository' } },
    ]
    const oversized = Buffer.alloc(DEFAULT_MAX_BYTES + 1, 0x61)
    const out = await recoverOpenAccess({
      doi: DOI,
      kind: 'rescued',
      haveChars: 0,
      deps: deps(record(oversized, 'text/html')),
    })
    expect(out.recovery).toBeUndefined()
    expect(out.notes.join(' ')).toMatch(/cap/)
  })

  it('refuses a candidate address that is not http(s) at all', async () => {
    openalexLocations = [
      { is_oa: true, pdf_url: 'file:///etc/passwd', landing_page_url: null, version: 'publishedVersion', license: null, source: { display_name: 'Local' } },
    ]
    const out = await recoverOpenAccess({
      doi: DOI,
      kind: 'rescued',
      haveChars: 0,
      deps: deps(record(Buffer.from(FULL_TEXT), 'text/html')),
    })
    expect(out.recovery).toBeUndefined()
    expect(asked.map((a) => a.href).filter((h) => h.startsWith('file:'))).toEqual([])
  })
})
