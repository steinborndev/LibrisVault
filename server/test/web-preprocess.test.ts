import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  canonicalUrlOf,
  fetchBytes,
  fetchFailureMessage,
  htmlToText,
  isPdfAnswer,
  isPrivateAddress,
  pdfOriginalName,
  pdfUrlFor,
  preprocessUrl,
  validateUrl,
  type PinnedRequestFn,
} from '../src/pipeline/preprocess/web.js'
import { PreprocessError, type PreprocessPlugin, type PreprocessResult } from '../src/pipeline/preprocess/index.js'

describe('isPrivateAddress', () => {
  it('flags RFC1918, loopback and link-local v4', () => {
    for (const ip of ['10.0.0.1', '172.16.5.5', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })
  it('allows public v4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })
  it('flags loopback/ULA/link-local v6 and mapped v4', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
  })
})

describe('validateUrl', () => {
  const publicResolver = async () => ['93.184.216.34']

  it('accepts a public https URL', async () => {
    const { url } = await validateUrl('https://example.com/page', publicResolver)
    expect(url.hostname).toBe('example.com')
  })

  it('refuses file:// and other schemes', async () => {
    await expect(validateUrl('file:///etc/passwd', publicResolver)).rejects.toThrow(/scheme/)
    await expect(validateUrl('ftp://example.com', publicResolver)).rejects.toThrow(/scheme/)
  })

  it('refuses a host that resolves to a private address (SSRF guard)', async () => {
    const privateResolver = async () => ['192.168.0.10']
    await expect(validateUrl('http://intranet.local', privateResolver)).rejects.toThrow(/SSRF/)
  })

  it('refuses when any resolved address is private', async () => {
    const mixed = async () => ['93.184.216.34', '10.0.0.1']
    await expect(validateUrl('http://sneaky.example', mixed)).rejects.toThrow(/private/)
  })

  it('rejects malformed URLs', async () => {
    await expect(validateUrl('not a url', publicResolver)).rejects.toThrow(PreprocessError)
  })
})

describe('htmlToText', () => {
  it('strips scripts, styles and tags', () => {
    const html = '<html><style>a{}</style><body><script>x()</script><h1>Hi</h1><p>Body&nbsp;text</p></body></html>'
    const text = htmlToText(html)
    expect(text).toContain('Hi')
    expect(text).toContain('Body text')
    expect(text).not.toContain('x()')
    expect(text).not.toContain('<')
  })
})

describe('fetchFailureMessage', () => {
  it('tells a refused fetch how to get through, and says nothing more for other statuses', () => {
    // A 403 in front of a public page is bot protection; the job's error is the one line the
    // user reads, and the browser is the way through.
    expect(fetchFailureMessage(403, 'https://publisher.example/posts/an-article')).toMatch(/save the page from your browser and drop the \.html file/)
    expect(fetchFailureMessage(401, 'https://publisher.example/x')).toMatch(/refuses automated fetches/)
    expect(fetchFailureMessage(500, 'https://publisher.example/x')).toBe('fetch failed: HTTP 500 for https://publisher.example/x')
    expect(fetchFailureMessage(404, 'https://publisher.example/x')).not.toMatch(/browser/)
  })
})

describe('canonicalUrlOf', () => {
  it('reads the canonical link in either attribute order, then the Open Graph URL, and only http(s)', () => {
    expect(canonicalUrlOf('<link rel="canonical" href="https://publisher.example/a">')).toBe('https://publisher.example/a')
    expect(canonicalUrlOf("<link href='https://publisher.example/b' rel='canonical'>")).toBe('https://publisher.example/b')
    expect(canonicalUrlOf('<meta property="og:url" content="https://publisher.example/c">')).toBe('https://publisher.example/c')
    expect(canonicalUrlOf('<link rel="canonical" href="https://publisher.example/a"><meta property="og:url" content="https://publisher.example/c">')).toBe('https://publisher.example/a')
    expect(canonicalUrlOf('<link rel="canonical" href="javascript:void(0)">')).toBeUndefined()
    expect(canonicalUrlOf('<link rel="stylesheet" href="https://publisher.example/x.css">')).toBeUndefined()
    expect(canonicalUrlOf('<p>no head at all</p>')).toBeUndefined()
  })
})

describe('pdfUrlFor (docs/sources/SPEC.md 3.2)', () => {
  const pdfFor = (href: string): string | undefined => pdfUrlFor(new URL(href))

  it('rewrites an arXiv abstract to its PDF and keeps the version the address named', () => {
    expect(pdfFor('https://arxiv.org/abs/2506.20907')).toBe('https://arxiv.org/pdf/2506.20907')
    // A version is part of the identity: fetching the latest would ingest another document.
    expect(pdfFor('https://arxiv.org/abs/2506.20907v2')).toBe('https://arxiv.org/pdf/2506.20907v2')
    expect(pdfFor('https://arxiv.org/abs/astro-ph/0601001')).toBe('https://arxiv.org/pdf/astro-ph/0601001')
    expect(pdfFor('https://arxiv.org/pdf/2506.20907')).toBe('https://arxiv.org/pdf/2506.20907')
    expect(pdfFor('https://arxiv.org/pdf/2506.20907.pdf')).toBe('https://arxiv.org/pdf/2506.20907')
  })

  it('takes a .pdf path and a /pdf/ segment, and leaves every other address alone', () => {
    expect(pdfFor('https://publisher.example/files/paper.PDF')).toBe('https://publisher.example/files/paper.PDF')
    expect(pdfFor('https://publisher.example/content/pdf/10.1234/example.2026.001')).toBe(
      'https://publisher.example/content/pdf/10.1234/example.2026.001',
    )
    expect(pdfFor('https://doi.org/10.1234/example.2026.001')).toBeUndefined()
    expect(pdfFor('https://publisher.example/articles/an-article')).toBeUndefined()
    // The word in a query string is not the path: only the path decides.
    expect(pdfFor('https://publisher.example/download?format=pdf')).toBeUndefined()
  })
})

describe('isPdfAnswer (magic bytes win over the content type, both ways)', () => {
  it('takes %PDF- bytes served as text/html', () => {
    expect(isPdfAnswer(Buffer.from('%PDF-1.7\nstuff'), 'text/html; charset=utf-8')).toBe(true)
  })

  it('refuses HTML served as application/pdf - a login page in front of a PDF', () => {
    expect(isPdfAnswer(Buffer.from('<!DOCTYPE html><html><body>Log in to continue'), 'application/pdf')).toBe(false)
  })

  it('trusts the content type when the bytes say neither', () => {
    expect(isPdfAnswer(Buffer.from('\x00\x01binary'), 'application/pdf')).toBe(true)
    expect(isPdfAnswer(Buffer.from('plain words'), 'text/plain')).toBe(false)
  })
})

describe('pdfOriginalName', () => {
  it('uses the file name, else the arXiv id, else the host with a digest', () => {
    expect(pdfOriginalName(new URL('https://publisher.example/files/paper.pdf'))).toBe('paper.pdf')
    expect(pdfOriginalName(new URL('https://arxiv.org/pdf/2506.20907'))).toBe('2506.20907.pdf')
    // The old arXiv scheme carries a slash, which a name may not.
    expect(pdfOriginalName(new URL('https://arxiv.org/pdf/astro-ph/0601001'))).toBe('astro-ph-0601001.pdf')
    const generic = pdfOriginalName(new URL('https://publisher.example/content/pdf/10.1234/example.2026.001'))
    expect(generic).toMatch(/^publisher\.example-[0-9a-f]{8}\.pdf$/)
  })
})

describe('preprocessUrl: the PDF lane (docs/sources/SPEC.md section 3)', () => {
  const resolve = async (): Promise<string[]> => ['93.184.216.34']
  /** A PDF whose text layer `pdftotext` would read; the plugin is stubbed, so bytes suffice. */
  const pdfBytes = Buffer.from('%PDF-1.4\n% a document the plugin chain reads\n')
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-url-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Answers every request with the same body, and records which addresses were asked for. */
  const stub = (body: Buffer, contentType: string, asked: string[] = []): PinnedRequestFn =>
    async (v) => {
      asked.push(v.url.href)
      return { status: 200, contentType, body }
    }

  /** The PDF plugin with its converters replaced: the lane under test is the routing, not poppler. */
  const fakePdfPlugin = {
    name: 'pdf',
    type: 'pdf' as const,
    matches: (probe: { ext: string; head: Buffer }): boolean =>
      probe.ext === 'pdf' || probe.head.subarray(0, 4).toString('latin1') === '%PDF',
    normalize: async (ctx: { jobDir: string }): Promise<{ normalizedPath: string; normalizedChars: number; notes: string[] }> => {
      const out = path.join(ctx.jobDir, 'normalized.txt')
      fs.writeFileSync(out, 'the text of the document', 'utf8')
      return { normalizedPath: out, normalizedChars: 24, notes: ['OCR applied (yield was 0 chars/page over 1 pages)'] }
    },
  }

  const run = async (url: string, request: PinnedRequestFn): Promise<PreprocessResult> => {
    const jobDir = path.join(dir, 'raw', 'job-1')
    return preprocessUrl({
      jobId: 'job-1',
      url,
      vaultRoot: dir,
      jobDir,
      resolve,
      request,
      tools: { pdftotext: true, pdfinfo: true, ocrmypdf: true, pandoc: true, python3: true, exiftool: true, defuddle: false, ytDlp: false, deno: false },
      registry: [fakePdfPlugin as unknown as PreprocessPlugin],
    })
  }

  it('ingests an arXiv abstract address as a pdf job, through the rewritten address', async () => {
    const asked: string[] = []
    const res = await run('https://arxiv.org/abs/2506.20907', stub(pdfBytes, 'application/pdf', asked))
    expect(asked).toEqual(['https://arxiv.org/pdf/2506.20907'])
    expect(res.type).toBe('pdf')
    expect(res.manifest.url).toBe('https://arxiv.org/abs/2506.20907')
    expect(res.manifest.originalName).toBe('2506.20907.pdf')
    expect(res.manifest.original).toBe('raw.pdf')
    expect(res.primaryArtifact).toBe('raw/job-1/normalized.txt')
    // The plugin's own notes ride along, prefixed with the lane that produced them.
    expect(res.manifest.notes).toContain('pdf url: OCR applied (yield was 0 chars/page over 1 pages)')
    expect(res.manifest.notes.join(' ')).toMatch(/read https:\/\/arxiv\.org\/pdf\/2506\.20907 instead/)
    expect(fs.readFileSync(path.join(dir, 'raw', 'job-1', 'raw.pdf'))).toEqual(pdfBytes)
  })

  it('takes a PDF served from an address that does not name one', async () => {
    const res = await run('https://publisher.example/download/17', stub(pdfBytes, 'text/html'))
    expect(res.type).toBe('pdf')
    expect(res.manifest.notes.join(' ')).toMatch(/the answer is a PDF \(text\/html\) though the address does not say so/)
  })

  it('reads a .pdf address that answers with a login page as a page, and says why the job failed', async () => {
    const wall = Buffer.from(
      `<!DOCTYPE html><html><body><h1>Sign in to continue</h1><p>${'This article is available to subscribers. '.repeat(12)}</p></body></html>`,
    )
    await expect(run('https://publisher.example/files/paper.pdf', stub(wall, 'application/pdf'))).rejects.toThrow(
      /login\/anti-bot\/paywall shell/,
    )
  })

  it('fails the way a dropped PDF does when the tools are missing', async () => {
    const jobDir = path.join(dir, 'raw', 'job-2')
    await expect(
      preprocessUrl({
        jobId: 'job-2',
        url: 'https://publisher.example/files/paper.pdf',
        vaultRoot: dir,
        jobDir,
        resolve,
        request: stub(pdfBytes, 'application/pdf'),
        tools: { pdftotext: false, pdfinfo: false, ocrmypdf: false, pandoc: false, python3: false, exiftool: false, defuddle: false, ytDlp: false, deno: false },
      }),
    ).rejects.toThrow(/pdftotext \(poppler-utils\) is not installed/)
  })
})


describe('fetchBytes: an extra header belongs to one host only', () => {
  const resolve = async (): Promise<string[]> => ['93.184.216.34']

  /** Records what each hop was asked, including the headers it carried. */
  const hops = (): { seen: Array<{ href: string; headers?: Readonly<Record<string, string>> }>; request: PinnedRequestFn } => {
    const seen: Array<{ href: string; headers?: Readonly<Record<string, string>> }> = []
    const request: PinnedRequestFn = async (v, _t, _m, headers) => {
      seen.push({ href: v.url.href, ...(headers ? { headers } : {}) })
      if (v.url.pathname === '/off-host') return { status: 301, location: 'https://elsewhere.example/paper', contentType: '', body: Buffer.alloc(0) }
      if (v.url.pathname === '/same-host') return { status: 301, location: 'https://api.example/final', contentType: '', body: Buffer.alloc(0) }
      return { status: 200, contentType: 'text/plain', body: Buffer.from('body') }
    }
    return { seen, request }
  }

  it('drops the header on a redirect that leaves the host it was meant for', async () => {
    const { seen, request } = hops()
    await fetchBytes(await validateUrl('https://api.example/off-host', resolve), 1024, 1000, {
      resolve,
      request,
      headers: { authorization: 'Bearer secret-key' },
    })
    expect(seen.map((h) => new URL(h.href).hostname)).toEqual(['api.example', 'elsewhere.example'])
    expect(seen[0]!.headers).toEqual({ authorization: 'Bearer secret-key' })
    // A credential follows a Location wherever it points; the host that answered is not
    // necessarily the one the key belongs to.
    expect(seen[1]!.headers).toBeUndefined()
  })

  it('keeps it across a redirect that stays on the host', async () => {
    const { seen, request } = hops()
    await fetchBytes(await validateUrl('https://api.example/same-host', resolve), 1024, 1000, {
      resolve,
      request,
      headers: { authorization: 'Bearer secret-key' },
    })
    expect(seen).toHaveLength(2)
    expect(seen[1]!.headers).toEqual({ authorization: 'Bearer secret-key' })
  })
})
