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
import os from 'node:os'
import path from 'node:path'
import type { JobType } from '../../db/jobs.js'
import { nowIso } from '../../db/index.js'
import { arxivIdFromUrl, doiFromHtml, doiFromUrl } from '../identifiers.js'
import type { Manifest, PreprocessPlugin, PreprocessResult, ToolAvailability } from './types.js'
import { PreprocessError } from './types.js'
import { buildProbe } from './detect.js'
import { documentTextOf, fenceWithWarnings } from './fence.js'
import { pdfPlugin } from './plugins/pdf.js'
import {
  OA_MIN_FULL_TEXT_CHARS,
  oaBanner,
  recoverOpenAccess,
  type OaDisclosure,
  type OaKind,
  type OaLookupCache,
  type OaPdfReader,
  type OaRecovery,
} from './oa.js'
import {
  DEFAULT_MAX_BYTES,
  FetchStatusError,
  MAX_PDF_BYTES,
  fetchBytes,
  fetchCapped,
  validateUrl,
  type FetchedBytes,
  type FetchOptions,
  type PinnedRequestFn,
} from './fetch.js'
import { assessExtractedContent, citationPdfUrl, extractArticle, htmlTitle } from './html.js'
import { preprocess } from './index.js'
import { detectTools } from './tools.js'
import { findUrlHandler } from './url-handlers.js'

/*
 * The SSRF guard, the pinned request and the caps live in `fetch.ts` and are re-exported here:
 * the open-access resolver needs the same gate for the addresses an API hands it, and a module
 * both lanes import cannot import one of them back.
 */
export {
  DEFAULT_MAX_BYTES,
  MAX_PDF_BYTES,
  fetchBytes,
  fetchFailureMessage,
  isPrivateAddress,
  pinnedRequest,
  validateUrl,
  FetchStatusError,
  type FetchOptions,
  type FetchedBytes,
  type PinnedRequestFn,
  type PinnedResponse,
  type ValidatedUrl,
} from './fetch.js'

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
  /**
   * Open-access recovery (docs/sources/SPEC.md section 5). Absent or `enabled: false` means a
   * blocked or thin page fails or stays thin exactly as it did before.
   */
  readonly oa?: {
    readonly enabled: boolean
    readonly cache?: OaLookupCache
    /** The service environment, for `CORE_API_KEY` and `OA_CONTACT_EMAIL`. */
    readonly env?: NodeJS.ProcessEnv
    readonly courtesyMs?: number
    readonly now?: () => Date
    /** A copy the service already knows of, tried before the resolvers (section 6.3). */
    readonly hint?: { readonly url: string; readonly version?: string | null }
  }
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
/**
 * The document a page named in `citation_pdf_url`, if it really is one (3.2, 2026-09-15).
 *
 * Every guard the ordinary fetch has, and one more: the address has to sit on the SAME HOST as
 * the page that named it. A meta tag is content, written by whoever wrote the page, and a
 * fetch aimed by it is a fetch aimed by a stranger - `validateUrl` already refuses the private
 * ranges, and the host check keeps the rest of the internet out of a redirect the reader never
 * asked for. A publisher hosting its own PDFs, which is all of them, is unaffected.
 *
 * Every failure is a shrug: the note says what was tried and the page is filed as a page,
 * which is what would have happened anyway.
 */
async function pdfBehindPage(
  named: string,
  page: URL,
  input: PreprocessUrlInput,
  timeoutMs: number,
  fetchOpts: FetchOptions,
  notes: string[],
): Promise<FetchedBytes | undefined> {
  let candidate: string
  try {
    candidate = new URL(named, page).href
  } catch {
    notes.push(`pdf url: citation_pdf_url is not an address (${named.slice(0, 80)})`)
    return undefined
  }
  if (new URL(candidate).host !== page.host) {
    notes.push(`pdf url: citation_pdf_url points at ${new URL(candidate).host}, off the page's own host - not followed`)
    return undefined
  }
  try {
    const target = await validateUrl(candidate, input.resolve)
    const answer = await fetchBytes(target, input.maxBytes ?? MAX_PDF_BYTES, timeoutMs, fetchOpts)
    if (isPdfAnswer(answer.body, answer.contentType)) return answer
    notes.push(`pdf url: citation_pdf_url named ${candidate} but it answered with ${answer.contentType || 'no content type'} - read the page instead`)
  } catch (err) {
    notes.push(`pdf url: citation_pdf_url named ${candidate} but it could not be fetched (${(err as Error).message}) - read the page instead`)
  }
  return undefined
}

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

/**
 * A helper for the one case a URL job can end in two manifests: the PDF lane wrote one, then the
 * open-access attempt added something a reader of the job log should see. Rewrites the notes of
 * the manifest already on disk and hands back the result with them.
 */
function withExtraNotes(result: PreprocessResult, extra: readonly string[]): PreprocessResult {
  if (extra.length === 0) return result
  const manifest: Manifest = { ...result.manifest, notes: [...result.manifest.notes, ...extra] }
  fs.writeFileSync(result.manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  return { ...result, manifest }
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
  /*
   * What the job turns out to be. One mutable record rather than five locals, because an
   * open-access copy replaces several of them at once and from inside a closure.
   */
  const out: {
    markdown: string
    /** Job-dir-relative name of the raw file the text came from. */
    original: string
    type: JobType
    normalizedName: string
    ocrApplied: boolean
    /** The document's own title, for the manifest and the quote corpus (7.6). */
    title?: string
    /** Set only when the text did not come from the address the job names (5.4). */
    oa?: OaDisclosure
  } = { markdown: '', original: '', type: 'web', normalizedName: 'normalized.md', ocrApplied: false }

  /*
   * An arXiv address is never rescued (docs/sources/SPEC.md 5.1): the PDF lane above already
   * reads the full text, so a resolver could only find the same document again.
   */
  const oaEnabled = input.oa?.enabled === true && arxivIdFromUrl(url) === undefined
  const addressDoi = doiFromUrl(url)

  /**
   * How an open-access PDF candidate becomes text: the ordinary PDF plugin, in a scratch
   * directory OUTSIDE the vault. A candidate that turns out to be too thin must leave nothing
   * behind in the job's staging directory, which is committed with the job.
   */
  const readPdfCandidate: OaPdfReader = async (bytes, seq) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `oa-candidate-${seq}-`))
    try {
      const file = path.join(dir, 'candidate.pdf')
      fs.writeFileSync(file, bytes)
      const res = await pdfPlugin.normalize({ probe: buildProbe(file, 'candidate.pdf'), jobDir: dir, tools })
      // The plugin fences its own output; the bars and the banner are about the document.
      const text = res.normalizedPath === undefined ? '' : documentTextOf(fs.readFileSync(res.normalizedPath, 'utf8'))
      return { text, notes: res.notes, ocrApplied: res.ocrApplied ?? false, deferred: res.deferred ?? false }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  /**
   * Whether there is anything to look for: a DOI to ask the resolvers about, or an address the
   * reading list already named (6.3), which is what carries an entry identified by an arXiv id.
   */
  const recoverable = (doi: string | undefined): boolean => oaEnabled && (doi !== undefined || input.oa?.hint !== undefined)

  /** One attempt at a copy. Collects its notes either way, so the job log says what was tried. */
  const recover = async (kind: OaKind, haveChars: number, doi: string | undefined): Promise<{ recovery?: OaRecovery; notes: readonly string[] }> => {
    const out = await recoverOpenAccess({
      ...(doi === undefined ? {} : { doi }),
      kind,
      haveChars,
      deps: {
        jobDir: input.jobDir,
        tools,
        timeoutMs,
        readPdf: readPdfCandidate,
        ...(input.resolve ? { resolve: input.resolve } : {}),
        ...(input.request ? { request: input.request } : {}),
        ...(input.oa?.cache ? { cache: input.oa.cache } : {}),
        ...(input.oa?.env ? { env: input.oa.env } : {}),
        ...(input.oa?.courtesyMs !== undefined ? { courtesyMs: input.oa.courtesyMs } : {}),
        ...(input.oa?.now ? { now: input.oa.now } : {}),
        ...(input.oa?.hint ? { hint: input.oa.hint } : {}),
      },
    })
    notes.push(...out.notes)
    return out
  }

  /** What a recovered copy replaces: the document, its raw file, and the job's type. */
  const takeRecovery = (recovery: OaRecovery): void => {
    out.oa = recovery.disclosure
    out.markdown = recovery.text
    out.original = recovery.original
    out.ocrApplied = recovery.ocrApplied
    if (recovery.isPdf) {
      // A rescued PDF is a PDF job, exactly as the dropped or the fetched one is (3.3).
      out.type = 'pdf'
      out.normalizedName = 'normalized.txt'
    }
  }

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
    out.markdown = result.markdown
    out.original = result.original
    notes.push(`handled by ${handler.name}`, ...result.notes)
  } else {
    const target = pdfAddress === undefined ? validated : await validateUrl(pdfAddress, input.resolve)
    const cap = pdfAddress === undefined ? maxBytes : (input.maxBytes ?? MAX_PDF_BYTES)
    let answer: FetchedBytes
    try {
      answer = await fetchBytes(target, cap, timeoutMs, fetchOpts)
    } catch (err) {
      /*
       * A 401 or a 403 is a site refusing an automated fetch, and the literature is often
       * readable elsewhere (5.1). Everything else - a 404, a 500, a timeout - is not a case an
       * open copy answers, and is raised as before.
       */
      const refused = err instanceof FetchStatusError && (err.status === 401 || err.status === 403)
      if (!refused || !recoverable(addressDoi)) throw err
      const rescue = await recover('rescued', 0, addressDoi)
      if (rescue.recovery === undefined) {
        // A rescue fails exactly as the fetch failed, with the note appended (5.3).
        throw new PreprocessError(`${(err as Error).message}. ${rescue.notes[rescue.notes.length - 1] ?? ''}`.trim())
      }
      takeRecovery(rescue.recovery)
      answer = undefined as unknown as FetchedBytes
    }

    if (out.oa === undefined) {
      if (isPdfAnswer(answer.body, answer.contentType)) {
        const lane: string[] = []
        if (target.url.href !== url.href) lane.push(`pdf url: read ${target.url.href} instead of the address given, which names the same document`)
        else if (pdfAddress === undefined) lane.push(`pdf url: the answer is a PDF (${answer.contentType || 'no content type'}) though the address does not say so`)
        lane.push(`pdf url: ${answer.body.byteLength} bytes fetched from ${answer.url.href}`)
        const result = await pdfLane({ input, requested: url, fetched: answer.url, body: answer.body, tools, notes: lane })
        /*
         * The PDF lane declined the document (too large to OCR, no readable text): a copy of the
         * same DOI may be a text PDF rather than a scan (5.1). Nothing is lost if it is not - the
         * job stays deferred with the lane's own reason.
         */
        if (!result.deferred || !recoverable(addressDoi)) return result
        /*
         * The lane's own reason comes along: if a copy is found, this manifest is replaced by the
         * one below, and without its notes the job log would no longer say why the document it
         * fetched first was declined.
         */
        notes.push(...result.manifest.notes)
        const rescue = await recover('rescued', 0, addressDoi)
        if (rescue.recovery === undefined) return withExtraNotes(result, rescue.notes)
        takeRecovery(rescue.recovery)
      } else {
        const html = answer.body.toString('utf8')
        /*
         * The page may say where its own PDF is (3.2). `pdfUrlFor` reads the ADDRESS, and an
         * address only says "PDF" in three shapes; a journal that routes its document to a
         * sibling of the article path matches none of them, so an open-access paper was filed
         * as the web page in front of it. `citation_pdf_url` is the publisher's own answer.
         *
         * Only from the ordinary path: an address that already named a PDF and answered with
         * markup is a login page, and the page behind a login does not name a document you
         * may have. And only a candidate - it is validated like any other address, fetched
         * under the PDF cap, and the magic bytes decide whether it was one.
         */
        if (pdfAddress === undefined) {
          const named = citationPdfUrl(html)
          const found = named === undefined ? undefined : await pdfBehindPage(named, answer.url, input, timeoutMs, fetchOpts, notes)
          if (found !== undefined) {
            return pdfLane({
              input,
              requested: url,
              fetched: found.url,
              body: found.body,
              tools,
              notes: [
                `pdf url: the page names its own document in citation_pdf_url`,
                `pdf url: ${found.body.byteLength} bytes fetched from ${found.url.href}`,
              ],
            })
          }
        }
        if (pdfAddress !== undefined) {
          // A login page in front of a PDF looks exactly like this. The junk gate below is what
          // says so, and this note is how the reader knows which lane was tried first.
          notes.push(`pdf url: ${target.url.href} names a PDF but answered with ${answer.contentType || 'no content type'} - read as a page`)
        }
        const rawPath = path.join(input.jobDir, 'raw.html')
        fs.writeFileSync(rawPath, html, 'utf8')
        out.original = 'raw.html'
        // The page's own title: the artifact's first line is the address, and defuddle drops
        // the heading, so a quotation of the title would be unverifiable without this (7.6).
        const pageTitle = htmlTitle(html)
        if (pageTitle !== undefined) out.title = pageTitle

        const extracted = await extractArticle({ filePath: rawPath, html, tools })
        out.markdown = extracted.markdown
        notes.push(...extracted.notes)

        /*
         * The page's OWN doi, from its citation meta tags - never one found in running text,
         * which is most often a work it cites (2.2).
         */
        const pageDoi = doiFromHtml(html) ?? addressDoi
        const problem = assessExtractedContent(out.markdown)
        if (problem !== null) {
          // A login wall, a bot wall, an empty shell: the page could not be read at all (5.1).
          if (recoverable(pageDoi)) notes.push(`open access: the page did not read as an article (${problem})`)
          const rescue: { recovery?: OaRecovery; notes: readonly string[] } = recoverable(pageDoi)
            ? await recover('rescued', 0, pageDoi)
            : { notes: [] }
          if (rescue.recovery === undefined) {
            const appended = rescue.notes.length > 0 ? ` ${rescue.notes[rescue.notes.length - 1]}.` : ''
            throw new PreprocessError(
              `web content sanity check failed for ${url.href}: ${problem}. Nothing was ingested: the page would only have produced a junk vault entry.${appended}`,
            )
          }
          takeRecovery(rescue.recovery)
        } else if (out.markdown.trim().length < OA_MIN_FULL_TEXT_CHARS && recoverable(pageDoi)) {
          /*
           * The page was read, but an abstract is not the paper (5.1). A copy has to be BOTH
           * longer than this and full text to replace it; otherwise the thin text stays, with
           * the note saying what was tried (5.3).
           */
          notes.push(
            `open access: the page holds ${out.markdown.trim().length} characters, under the ${OA_MIN_FULL_TEXT_CHARS} a paper needs`,
          )
          const thin = await recover('substituted', out.markdown.trim().length, pageDoi)
          if (thin.recovery !== undefined) takeRecovery(thin.recovery)
        }
      }
    }
  }

  /*
   * The fence goes on last (docs/sources/SPEC.md 4.1): the junk gate above ran on the document
   * as it arrived, and so did the open-access decision - what the service wrapped around it is
   * the service's own words and must not count as the page's text. The banner rides above it,
   * so a reader of the artifact learns in its first line that the text is a copy (5.4).
   */
  const normalizedPath = path.join(input.jobDir, out.normalizedName)
  const fenced = fenceWithWarnings({
    title: url.href,
    ...(out.oa !== undefined ? { banner: oaBanner(out.oa) } : {}),
    // Where the TEXT came from: the copy when there is one, the requested address otherwise.
    source: out.oa?.url ?? url.href,
    kind: out.type === 'pdf' ? 'pdf' : 'web',
    text: out.markdown,
  })
  fs.writeFileSync(normalizedPath, fenced.text, 'utf8')
  notes.push(...fenced.warnings)

  const manifest: Manifest = {
    jobId: input.jobId,
    source: 'url',
    type: out.type,
    originalName: url.href,
    // The requested address stays the job's own, whatever the text came from (5.4, D3).
    url: url.href,
    createdAt: nowIso(),
    ...(out.title !== undefined ? { title: out.title } : {}),
    original: out.original,
    normalized: out.normalizedName,
    normalizedChars: out.markdown.length,
    ocrApplied: out.ocrApplied,
    passImageToAgent: false,
    deferred: false,
    ...(out.oa !== undefined ? { oa: out.oa } : {}),
    notes,
    ...(fenced.warnings.length > 0 ? { warnings: fenced.warnings } : {}),
  }
  const manifestPath = path.join(input.jobDir, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  return {
    type: out.type,
    deferred: false,
    manifestPath,
    primaryArtifact: path
      .relative(input.vaultRoot, normalizedPath)
      .split(path.sep)
      .join(path.posix.sep),
    manifest,
  }
}
