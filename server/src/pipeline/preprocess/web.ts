/**
 * URL / web-page preprocessing (SPEC.md §5). Unlike the file plugins, this runs BEFORE
 * the agent and is the ONE place the pipeline itself reaches the network — the agent
 * run has no web egress (SPEC.md §9). Because we fetch here, the repo's egress-hygiene
 * rules apply and are enforced below: http/https only (no `file://`), no RFC1918 /
 * loopback / link-local targets (SSRF guard), and a hard size cap on the response.
 *
 * Extraction uses `defuddle-cli` when present; otherwise a minimal HTML-to-text
 * fallback keeps the job moving rather than failing on a missing optional tool.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import dns from 'node:dns/promises'
import net from 'node:net'
import type { JobType } from '../../db/jobs.js'
import { nowIso } from '../../db/index.js'
import { arxivIdFromUrl } from '../identifiers.js'
import type { Manifest, PreprocessPlugin, PreprocessResult, ToolAvailability } from './types.js'
import { PreprocessError } from './types.js'
import { fenceWithWarnings } from './fence.js'
import { assessExtractedContent, htmlToText } from './html.js'
import { preprocess } from './index.js'
import { runConverter } from './sandbox.js'
import { detectTools } from './tools.js'
import { findUrlHandler } from './url-handlers.js'

/** Default response cap. Web pages are larger than the 50 KB autoresearch fetch cap. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/**
 * The cap for the PDF lane (docs/sources/SPEC.md section 2.1). A paper is one or two MB and a
 * scanned report can be twenty, so the HTML cap would refuse documents the PDF plugin handles
 * every day - and the plugin has its own limits beyond this one (page count, OCR budget).
 */
export const MAX_PDF_BYTES = 25 * 1024 * 1024
const MAX_REDIRECTS = 5

/** True for addresses an outbound fetch must never reach (SSRF guard). */
export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip)
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true // link-local
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }
  if (kind === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe80')) return true // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA
    // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1]!)
    return false
  }
  return false
}

export interface ValidatedUrl {
  readonly url: URL
  readonly address: string
}

/** Validates scheme + resolves the host, refusing private/loopback targets. */
export async function validateUrl(
  raw: string,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<ValidatedUrl> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PreprocessError(`not a valid URL: ${raw}`, true)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PreprocessError(`refused URL scheme ${url.protocol} — only http/https are fetched`, true)
  }
  const addresses = await resolve(url.hostname)
  if (addresses.length === 0) {
    throw new PreprocessError(`could not resolve host: ${url.hostname}`, true)
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new PreprocessError(
        `refused: ${url.hostname} resolves to a private/loopback address (${addr}) — SSRF guard`,
        true,
      )
    }
  }
  return { url, address: addresses[0]! }
}

async function defaultResolve(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host]
  const records = await dns.lookup(host, { all: true })
  return records.map((r) => r.address)
}

/** One answer from the pinned request, as bytes: the caller decides whether it is text. */
export interface PinnedResponse {
  readonly status: number
  readonly location?: string
  /** The `Content-Type` header, lowercased, or '' when the answer carried none. */
  readonly contentType: string
  readonly body: Buffer
}

/**
 * The HTTP layer under the SSRF guard. A seam, not an abstraction: a test drives the lanes
 * through it without opening a socket, and nothing in the pipeline passes anything but
 * {@link pinnedRequest}.
 */
export type PinnedRequestFn = (v: ValidatedUrl, timeoutMs: number, maxBytes: number) => Promise<PinnedResponse>

/** What the fetch layer may be told: how to resolve a redirect hop, and who makes the request. */
export interface FetchOptions {
  readonly resolve?: (host: string) => Promise<string[]>
  readonly request?: PinnedRequestFn
}

/** An answer that arrived, with the address it actually came from after every redirect hop. */
export interface FetchedBytes {
  readonly body: Buffer
  readonly contentType: string
  readonly url: URL
}

/**
 * Fetches with a byte cap, manual redirect handling (each hop re-validated), and a timeout.
 *
 * Every hop connects to the ADDRESS that passed the SSRF check, never to the hostname:
 * letting the HTTP client re-resolve the name would reopen the guard to DNS rebinding
 * (public answer during validation, private answer at connect time). TLS still verifies
 * against the hostname — only the socket target is pinned.
 *
 * Bytes, not a string (docs/sources/SPEC.md section 2.1): a PDF decoded as UTF-8 is corrupt
 * before anything can look at it, and whether an answer is a document or a page is decided
 * from its first bytes. {@link fetchCapped} keeps the string contract for the HTML lane.
 */
export async function fetchBytes(
  start: ValidatedUrl,
  maxBytes: number,
  timeoutMs: number,
  opts: FetchOptions = {},
): Promise<FetchedBytes> {
  const request = opts.request ?? pinnedRequest
  let current = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await request(current, timeoutMs, maxBytes)
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new PreprocessError(`redirect with no Location from ${current.url.href}`)
      const next = new URL(res.location, current.url)
      // Re-validate every hop against the SSRF guard; the returned address is the pin.
      current = opts.resolve ? await validateUrl(next.href, opts.resolve) : await validateUrl(next.href)
      continue
    }
    if (res.status < 200 || res.status >= 300) {
      throw new PreprocessError(fetchFailureMessage(res.status, current.url.href))
    }
    return { body: res.body, contentType: res.contentType, url: current.url }
  }
  throw new PreprocessError(`too many redirects (> ${MAX_REDIRECTS}) starting at ${start.url.href}`)
}

/** {@link fetchBytes} decoded as UTF-8, for the HTML lane and the domain handlers. */
async function fetchCapped(
  start: ValidatedUrl,
  maxBytes: number,
  timeoutMs: number,
  opts: FetchOptions = {},
): Promise<string> {
  return (await fetchBytes(start, maxBytes, timeoutMs, opts)).body.toString('utf8')
}

/**
 * One HTTP(S) request to the validated address (exported for the pinning tests). The `lookup`
 * override is what makes the pin real: whatever DNS says now, the socket goes to `v.address`.
 * The body is read under the cap and the request destroyed the moment it exceeds it.
 */
export function pinnedRequest(v: ValidatedUrl, timeoutMs: number, maxBytes: number): Promise<PinnedResponse> {
  return new Promise((resolvePromise, reject) => {
    const family = net.isIP(v.address)
    const client = v.url.protocol === 'https:' ? https : http
    const req = client.request(
      v.url,
      {
        // Some sites (e.g. Wikipedia) return 403 to requests without a User-Agent.
        headers: {
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) vault-service/0.1 (+local ingestion)',
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        },
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [{ address: v.address, family }])
          } else {
            ;(callback as (err: null, address: string, family: number) => void)(null, v.address, family)
          }
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        const declared = Number(res.headers['content-length'] ?? '0')
        if (declared > maxBytes) {
          res.destroy()
          reject(new PreprocessError(`response too large: ${declared} bytes > cap ${maxBytes}`))
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength
          if (total > maxBytes) {
            res.destroy()
            reject(new PreprocessError(`response exceeded cap ${maxBytes} bytes mid-stream`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const result: { status: number; location?: string; contentType: string; body: Buffer } = {
            status,
            contentType: (res.headers['content-type'] ?? '').toLowerCase(),
            body: Buffer.concat(chunks),
          }
          const location = res.headers['location']
          if (typeof location === 'string') result.location = location
          resolvePromise(result)
        })
        res.on('error', (err) => reject(new PreprocessError(`fetch failed for ${v.url.href}: ${err.message}`)))
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timed out after ${timeoutMs} ms`))
    })
    req.on('error', (err) => reject(new PreprocessError(`fetch failed for ${v.url.href}: ${err.message}`)))
    req.end()
  })
}

/**
 * The line a non-2xx answer fails the job with. A 401 or 403 is nearly always a site
 * refusing automated fetches - bot protection in front of a public page - and the way
 * through is the browser: the line says so, because the job's error is the one thing the
 * user reads before deciding what to do next (2026-09-12: a night ingest of a blog post
 * ended this way, and the saved page was dropped by hand the same evening).
 */
export function fetchFailureMessage(status: number, href: string): string {
  const refused = status === 401 || status === 403
  return `fetch failed: HTTP ${status} for ${href}${
    refused ? ' - the site refuses automated fetches; save the page from your browser and drop the .html file instead, it is extracted the same way' : ''
  }`
}

/*
 * The address of a saved page, the HTML-to-text fallback and the junk gate live in `html.ts`
 * and are re-exported here: they are shared with the text plugin, which reads a page saved
 * from a browser, and a module the two lanes both import cannot import one of them back.
 */
export {
  assessExtractedContent,
  canonicalUrlOf,
  htmlToText,
  MIN_WEB_CONTENT_CHARS,
} from './html.js'

export interface PreprocessUrlInput {
  readonly jobId: string
  readonly url: string
  readonly vaultRoot: string
  readonly jobDir: string
  readonly maxBytes?: number
  readonly timeoutMs?: number
  readonly tools?: ToolAvailability
  /** Injected for tests: DNS resolution behind the SSRF guard. Defaults to the real resolver. */
  readonly resolve?: (host: string) => Promise<string[]>
  /**
   * Injected for tests: the pinned HTTP request. The service passes nothing here - the SSRF
   * guard, the pin and the caps all live below this seam, so a test can exercise the lanes
   * without ever opening a socket.
   */
  readonly request?: PinnedRequestFn
  /** Injected for tests: the plugin chain the PDF lane hands its download to. */
  readonly registry?: readonly PreprocessPlugin[]
}

/**
 * The PDF address an address IS, or undefined when it is a page (docs/sources/SPEC.md 3.2).
 *
 * A URL that names a PDF is a document, not a web page: sending it through defuddle and the
 * junk gate produced either a failed job or a vault page written from markup. The three shapes
 * that say so are an arXiv abstract (which has a PDF beside it), a path ending in `.pdf`, and
 * a `/pdf/` segment, which is how most publishers route the document behind a landing page.
 */
export function pdfUrlFor(url: URL): string | undefined {
  const arxiv = arxivIdFromUrl(url)
  // The abstract page and the PDF are the same publication; the PDF is the one that ingests.
  if (arxiv !== undefined) return `https://arxiv.org/pdf/${arxiv}`
  const p = url.pathname.toLowerCase()
  return p.endsWith('.pdf') || p.includes('/pdf/') ? url.href : undefined
}

/** `%PDF-`, the only thing every PDF starts with. */
const hasPdfMagic = (body: Buffer): boolean => body.subarray(0, 5).toString('latin1') === '%PDF-'

/** The first bytes of an HTML answer, whatever a header claims: a doctype, a comment, or `<html`. */
const looksLikeHtml = (body: Buffer): boolean =>
  /^\s*(?:<!doctype\s+html|<html|<\?xml|<!--)/i.test(body.subarray(0, 200).toString('latin1'))

/**
 * Whether an answer is a PDF, whatever its address looked like (docs/sources/SPEC.md 3.2).
 *
 * MAGIC BYTES WIN OVER THE CONTENT TYPE IN BOTH DIRECTIONS. A site serving a paper as
 * `text/html` is still serving a paper; and a `.pdf` address that answers with a login page is
 * a page, which has to reach the junk gate so the job's error says why rather than handing
 * `pdftotext` a document that is not one.
 */
export function isPdfAnswer(body: Buffer, contentType: string): boolean {
  if (hasPdfMagic(body)) return true
  if (looksLikeHtml(body)) return false
  return /^\s*application\/(pdf|x-pdf)\b/.test(contentType)
}

/**
 * What to call the document the job fetched. The last path segment when it is a file name, so
 * the manifest and the source page can name the paper the way the publisher does; otherwise
 * the arXiv id, and failing that the host with a short digest of the address, which keeps two
 * documents from one host apart.
 */
export function pdfOriginalName(url: URL): string {
  const last = (() => {
    try {
      return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
    } catch {
      return url.pathname.split('/').filter(Boolean).pop() ?? ''
    }
  })()
  // A name, never a path: a decoded segment can carry a separator, and the file on disk is
  // `raw.pdf` either way - this string only ever names the document.
  const safe = (name: string): string =>
    [...name].map((c) => (c === '/' || c === '\\' || c.codePointAt(0)! < 0x20 ? '-' : c)).join('').slice(0, 120)
  if (/\.pdf$/i.test(last)) return safe(last)
  const arxiv = arxivIdFromUrl(url)
  if (arxiv !== undefined) return `${safe(arxiv)}.pdf`
  const digest = crypto.createHash('sha256').update(url.href).digest('hex').slice(0, 8)
  return `${safe(url.hostname)}-${digest}.pdf`
}

/**
 * The PDF lane (docs/sources/SPEC.md section 3.3): the bytes are written to the job directory
 * and handed to the ordinary file chain, so every PDF rule applies unchanged - `pdfinfo`,
 * `pdftotext`, the OCR path with its page and byte limits, and the deferral beyond them. The
 * job's type becomes `pdf` because the chain says so, and the address rides along in the
 * manifest so the source page can still name where the document came from.
 */
async function pdfLane(args: {
  readonly input: PreprocessUrlInput
  /** The address the job named; what the manifest and the source page call the document's own. */
  readonly requested: URL
  /** Where the bytes actually came from, after a rewrite and every redirect hop. */
  readonly fetched: URL
  readonly body: Buffer
  readonly tools: ToolAvailability
  readonly notes: readonly string[]
}): Promise<PreprocessResult> {
  const rawPath = path.join(args.input.jobDir, 'raw.pdf')
  fs.writeFileSync(rawPath, args.body)
  return preprocess({
    jobId: args.input.jobId,
    source: 'url',
    sourcePath: rawPath,
    originalName: pdfOriginalName(args.fetched),
    vaultRoot: args.input.vaultRoot,
    jobDir: args.input.jobDir,
    url: args.requested.href,
    tools: args.tools,
    ...(args.input.registry ? { registry: args.input.registry } : {}),
    notePrefix: 'pdf url:',
    extraNotes: args.notes,
  })
}

export async function preprocessUrl(input: PreprocessUrlInput): Promise<PreprocessResult> {
  fs.mkdirSync(input.jobDir, { recursive: true })
  const fetchOpts: FetchOptions = {
    ...(input.resolve ? { resolve: input.resolve } : {}),
    ...(input.request ? { request: input.request } : {}),
  }
  const validated = await validateUrl(input.url, input.resolve)
  const { url } = validated
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = input.timeoutMs ?? 30_000
  const tools = input.tools ?? (await detectTools())
  const notes: string[] = []
  let markdown: string
  let original: string

  /*
   * An address that names a PDF goes to the PDF lane before any domain handler sees it: the
   * handlers exist for pages whose HTML cannot be read (a JavaScript shell, a video page), and
   * a document is not one of those.
   */
  const pdfAddress = pdfUrlFor(url)
  const handler = pdfAddress === undefined ? findUrlHandler(url) : undefined
  if (handler) {
    // Domain handler path: content comes from a structured channel (API / yt-dlp), which
    // does its own error handling — the generic junk gate below does not apply (a
    // legitimate tweet is shorter than any sane minimum for an article).
    const result = await handler.handle({
      url,
      jobDir: input.jobDir,
      tools,
      fetchText: async (raw: string) => fetchCapped(await validateUrl(raw, input.resolve), maxBytes, timeoutMs, fetchOpts),
    })
    markdown = result.markdown
    original = result.original
    notes.push(`handled by ${handler.name}`, ...result.notes)
  } else {
    const target = pdfAddress === undefined ? validated : await validateUrl(pdfAddress, input.resolve)
    const answer = await fetchBytes(target, pdfAddress === undefined ? maxBytes : (input.maxBytes ?? MAX_PDF_BYTES), timeoutMs, fetchOpts)
    if (isPdfAnswer(answer.body, answer.contentType)) {
      const lane: string[] = []
      if (target.url.href !== url.href) lane.push(`pdf url: read ${target.url.href} instead of the address given, which names the same document`)
      else if (pdfAddress === undefined) lane.push(`pdf url: the answer is a PDF (${answer.contentType || 'no content type'}) though the address does not say so`)
      lane.push(`pdf url: ${answer.body.byteLength} bytes fetched from ${answer.url.href}`)
      return pdfLane({ input, requested: url, fetched: answer.url, body: answer.body, tools, notes: lane })
    }
    const html = answer.body.toString('utf8')
    if (pdfAddress !== undefined) {
      // A login page in front of a PDF looks exactly like this. The junk gate below is what
      // says so, and this note is how the reader knows which lane was tried first.
      notes.push(`pdf url: ${target.url.href} names a PDF but answered with ${answer.contentType || 'no content type'} - read as a page`)
    }
    const rawPath = path.join(input.jobDir, 'raw.html')
    fs.writeFileSync(rawPath, html, 'utf8')
    original = 'raw.html'

    if (tools.defuddle) {
      try {
        const { stdout } = await runConverter('defuddle', ['parse', rawPath, '--md'], { reads: [rawPath], timeoutMs: 30_000 })
        markdown = stdout.trim()
        notes.push('extracted via defuddle')
      } catch {
        markdown = htmlToText(html)
        notes.push('defuddle failed — used built-in HTML-to-text fallback')
      }
    } else {
      markdown = htmlToText(html)
      notes.push('defuddle not installed — used built-in HTML-to-text fallback')
    }

    const problem = assessExtractedContent(markdown)
    if (problem) {
      throw new PreprocessError(
        `web content sanity check failed for ${url.href}: ${problem}. Nothing was ingested — the page would only have produced a junk vault entry.`,
      )
    }
  }

  /*
   * The fence goes on last (docs/sources/SPEC.md 4.1): the junk gate above ran on the document
   * as it arrived, and so will the open-access decision - what the service wrapped around it is
   * the service's own words and must not count as the page's text.
   */
  const normalizedPath = path.join(input.jobDir, 'normalized.md')
  const fenced = fenceWithWarnings({ title: url.href, source: url.href, kind: 'web', text: markdown })
  fs.writeFileSync(normalizedPath, fenced.text, 'utf8')
  notes.push(...fenced.warnings)

  const manifest: Manifest = {
    jobId: input.jobId,
    source: 'url',
    type: 'web' as JobType,
    originalName: url.href,
    url: url.href,
    createdAt: nowIso(),
    original,
    normalized: 'normalized.md',
    normalizedChars: markdown.length,
    ocrApplied: false,
    passImageToAgent: false,
    deferred: false,
    notes,
    ...(fenced.warnings.length > 0 ? { warnings: fenced.warnings } : {}),
  }
  const manifestPath = path.join(input.jobDir, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  return {
    type: 'web',
    deferred: false,
    manifestPath,
    primaryArtifact: path
      .relative(input.vaultRoot, normalizedPath)
      .split(path.sep)
      .join(path.posix.sep),
    manifest,
  }
}
