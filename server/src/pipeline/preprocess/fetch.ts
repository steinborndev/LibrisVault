/**
 * The fetch layer: the SSRF guard, the pinned request, the caps and the redirect walk.
 *
 * Its own module because three callers need exactly this and nothing else - the URL lane
 * (`web.ts`), the domain handlers through it, and the open-access resolver (`oa.ts`), whose
 * candidate addresses come from a third-party API and must pass the SAME gate as an address the
 * user typed (docs/sources/SPEC.md section 10). A resolver that could reach the network any
 * other way would be the hole this module exists to close, so there is only one way through.
 *
 * `web.ts` re-exports everything here: every call site that has always imported the guard from
 * there still can.
 */

import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns/promises'
import net from 'node:net'
import { PreprocessError } from './types.js'

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
export type PinnedRequestFn = (
  v: ValidatedUrl,
  timeoutMs: number,
  maxBytes: number,
  headers?: Readonly<Record<string, string>>,
) => Promise<PinnedResponse>

/** What the fetch layer may be told: how to resolve a redirect hop, and who makes the request. */
export interface FetchOptions {
  readonly resolve?: (host: string) => Promise<string[]>
  readonly request?: PinnedRequestFn
  /**
   * Extra request headers - today only an API key for the one resolver that needs one
   * (docs/sources/SPEC.md section 10). They are DROPPED on a redirect that leaves the host they
   * were meant for: a credential follows a `Location:` to wherever it points, and the host that
   * answered is not necessarily the one the key belongs to.
   */
  readonly headers?: Readonly<Record<string, string>>
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
  // The host the extra headers were meant for; a hop off it leaves them behind.
  const headerHost = start.url.hostname.toLowerCase()
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = opts.headers !== undefined && current.url.hostname.toLowerCase() === headerHost ? opts.headers : undefined
    const res = await request(current, timeoutMs, maxBytes, headers)
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new PreprocessError(`redirect with no Location from ${current.url.href}`)
      const next = new URL(res.location, current.url)
      // Re-validate every hop against the SSRF guard; the returned address is the pin.
      current = opts.resolve ? await validateUrl(next.href, opts.resolve) : await validateUrl(next.href)
      continue
    }
    if (res.status < 200 || res.status >= 300) {
      throw new FetchStatusError(res.status, current.url.href)
    }
    // The cap is enforced inside the request (declared length and mid-stream), and again here:
    // this is the seam a test - and one day another caller - can pass its own request through.
    if (res.body.byteLength > maxBytes) {
      throw new PreprocessError(`response exceeded cap ${maxBytes} bytes (${res.body.byteLength} received)`)
    }
    return { body: res.body, contentType: res.contentType, url: current.url }
  }
  throw new PreprocessError(`too many redirects (> ${MAX_REDIRECTS}) starting at ${start.url.href}`)
}

/** {@link fetchBytes} decoded as UTF-8, for the HTML lane and the domain handlers. */
export async function fetchCapped(
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
export function pinnedRequest(
  v: ValidatedUrl,
  timeoutMs: number,
  maxBytes: number,
  headers?: Readonly<Record<string, string>>,
): Promise<PinnedResponse> {
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
          ...headers,
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
 * A non-2xx answer, with the status kept.
 *
 * The URL lane has to tell a 401 or 403 - a site refusing an automated fetch, which an
 * open-access copy may get around (docs/sources/SPEC.md section 5.1) - from a 404 or a 500,
 * which no copy fixes. Reading the status back out of the message would be the alternative.
 */
export class FetchStatusError extends PreprocessError {
  constructor(
    readonly status: number,
    readonly href: string,
  ) {
    super(fetchFailureMessage(status, href))
  }
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
