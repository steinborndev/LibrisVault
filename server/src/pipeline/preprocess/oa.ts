/**
 * Open-access recovery (docs/sources/SPEC.md section 5).
 *
 * A URL job whose page is a login wall, a bot wall or an abstract stub is a job that failed for
 * a reason the user cannot fix and the literature often can: the same DOI is frequently readable
 * in a repository, in Europe PMC, or as the accepted manuscript. So when a fetch is refused or
 * the text is too thin to be a paper, and the address names a DOI, the resolvers are asked for a
 * legal copy, and the copy - not the wall - is what the run reads.
 *
 * TWO THINGS THIS MODULE MUST KEEP STRAIGHT.
 *
 * 1. A resolver answer is DATA, not a licence. Every candidate address goes through
 *    `validateUrl` and the byte caps in `fetch.ts`, exactly like an address the user typed
 *    (section 10). There is no other way out of this module.
 * 2. The reader must be told. Nothing here is silent: the accepted copy reaches the manifest,
 *    a banner above the document, the prompt block of the run, and the reading-list entry. A
 *    substituted source that looked like the publisher's page would be a lie of omission.
 *
 * Credentials (`CORE_API_KEY`, `OA_CONTACT_EMAIL`) are read from the service environment
 * and attached only to their own host; a redirect off that host drops them (`fetch.ts`). They
 * are never logged, never returned by a route and never stored.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PreprocessError, type ToolAvailability } from './types.js'
import {
  DEFAULT_MAX_BYTES,
  FetchStatusError,
  MAX_PDF_BYTES,
  fetchBytes,
  validateUrl,
  type FetchOptions,
  type PinnedRequestFn,
} from './fetch.js'
import { assessExtractedContent, extractArticle } from './html.js'
import { runConverter } from './sandbox.js'

/** A copy has to be at least this long to pass for full text; below it, it is a record page. */
export const OA_MIN_FULL_TEXT_CHARS = 6000
/** How many candidate DOCUMENTS one job may download while looking for a copy. */
export const OA_MAX_ATTEMPTS = 3
/** How long a "nothing found" answer stands before the resolvers are asked again. */
export const OA_NEGATIVE_TTL_DAYS = 7
/** Minimum gap between two requests to one host. Courtesy, not a rate limiter. */
const DEFAULT_COURTESY_MS = 1000
/** A 429 is retried this many times before the DOI is recorded as rate limited, never as absent. */
const RATE_LIMIT_RETRIES = 2

/**
 * Where the address of a copy came from. `reading-list` is the entry's own `oa_url`, written
 * there by an earlier round of the same three resolvers - naming it honestly beats reporting a
 * resolver that was not asked this time.
 */
export type OaSource = 'openalex' | 'europepmc' | 'core' | 'reading-list'
/** Version of record first, then the accepted and the submitted manuscript (D14). */
export type OaVersion = 'publishedVersion' | 'acceptedVersion' | 'submittedVersion'
/** What happened to the address the user gave: it was read but thin, or not read at all (2.4). */
export type OaKind = 'substituted' | 'rescued'
/** How a candidate has to be read. */
export type OaFormat = 'pdf' | 'landing' | 'jats'

export interface OaCandidate {
  readonly url: string
  readonly format: OaFormat
  readonly version: OaVersion | null
  readonly host: string
  readonly license: string | null
  readonly source: OaSource
}

/** What the resolvers answered about one DOI: exactly the row `oa_lookups` keeps (5.5). */
export interface OaLookup {
  readonly doi: string
  readonly checkedAt: string
  /** Every copy a resolver named. A sweep fills this and fetches none of them (6.1). */
  readonly candidates: readonly OaCandidate[]
  /**
   * The ones that were actually fetched and did not clear the bars. Kept apart from
   * `candidates` because the two answer different questions: a copy nobody has tried is worth
   * trying, and a copy that came back as a record page is not worth fetching twice.
   */
  readonly tried: readonly OaCandidate[]
  readonly retracted: boolean
  /** True when a resolver answered 429 twice: NOT the same statement as "nothing found". */
  readonly rateLimited: boolean
  /** The candidate that produced usable text, so the next job can go straight to it. */
  readonly accepted: OaCandidate | null
}

/** The cache the store implements; injected so the pipeline never reaches into SQLite itself. */
export interface OaLookupCache {
  get(doi: string): OaLookup | undefined
  put(lookup: OaLookup): void
}

/** What a candidate PDF's bytes become. Injected: the PDF plugin belongs to the URL lane. */
export interface OaPdfReader {
  (bytes: Buffer, seq: number): Promise<{
    readonly text: string
    readonly notes: readonly string[]
    readonly ocrApplied: boolean
    readonly deferred: boolean
  }>
}

export interface OaDeps {
  /** `.raw/<job-id>/`: where a candidate's raw file is written when it is accepted. */
  readonly jobDir: string
  readonly tools: ToolAvailability
  readonly timeoutMs?: number
  readonly resolve?: (host: string) => Promise<string[]>
  readonly request?: PinnedRequestFn
  /** The service environment. Only `CORE_API_KEY` and `OA_CONTACT_EMAIL` are read. */
  readonly env?: NodeJS.ProcessEnv
  readonly cache?: OaLookupCache
  readonly courtesyMs?: number
  readonly now?: () => Date
  /** How a PDF candidate is turned into text; without it a PDF candidate is skipped. */
  readonly readPdf?: OaPdfReader
  /**
   * A copy the service already knows about, tried before any resolver: the `oa_url` of the
   * reading-list entry this job came from (docs/sources/SPEC.md 6.3).
   *
   * It is what makes "Ingest via the open copy" work for an entry whose identity is an arXiv id
   * rather than a DOI - the publisher page it posts has no DOI to resolve, and without the hint
   * the job would fail on the same wall the Fellow met. It is a CANDIDATE like any other: the
   * SSRF gate, the caps and the two acceptance bars all apply, and the resolvers still run when
   * it does not work out.
   */
  readonly hint?: { readonly url: string; readonly version?: string | null }
}

/** What the manifest, the banner and the frontmatter say about the copy (5.4). */
export interface OaDisclosure {
  /**
   * The DOI the copy was found by, or null when it was not found by one: the board's one click
   * carries a copy's address from an entry whose identity is an arXiv id (6.3).
   */
  readonly doi: string | null
  readonly kind: OaKind
  readonly url: string
  readonly source: OaSource
  readonly host: string
  readonly version: OaVersion | null
  readonly license: string | null
  readonly retracted: boolean
  readonly triedAt: string
}

export interface OaRecovery {
  readonly disclosure: OaDisclosure
  /** The copy's text, extracted, unfenced. */
  readonly text: string
  /** Job-dir-relative name of the raw file the copy was saved as. */
  readonly original: string
  /** True when the copy is a PDF: the job's type becomes `pdf`, as a dropped PDF's would. */
  readonly isPdf: boolean
  readonly ocrApplied: boolean
  readonly notes: readonly string[]
}

/** The row a store hands back; kept structural so the pipeline does not import SQLite. */
export interface OaLookupRowLike {
  readonly checkedAt: string
  readonly result: unknown
}

/** Loose shape check on a stored row: a row from an older build is treated as no answer. */
function isOaLookup(value: unknown): value is OaLookup {
  const l = value as OaLookup | null
  return (
    l !== null &&
    typeof l === 'object' &&
    typeof l.doi === 'string' &&
    typeof l.checkedAt === 'string' &&
    Array.isArray(l.candidates)
  )
}

/**
 * The lookup table, seen as the resolver's cache. The stored `result` IS the round, so a find
 * comes back with the candidate that worked and the next job goes straight to it (5.5).
 */
export function oaCacheOver(store: {
  get(doi: string): OaLookupRowLike | undefined
  put(doi: string, found: boolean, result: unknown): void
}): OaLookupCache {
  return {
    get: (doi) => {
      const row = store.get(doi)
      return row !== undefined && isOaLookup(row.result) ? row.result : undefined
    },
    // `found` is "a resolver named an open copy", which is what a sweep learns and what the
    // counts are about; whether one of them read as full text is `accepted`.
    put: (lookup) => store.put(lookup.doi, lookup.accepted !== null || lookup.candidates.length > 0, lookup),
  }
}

/** Wall-clock gap per host, so three resolvers plus three candidates stay polite. */
const lastRequestAt = new Map<string, number>()

async function courtesyWait(host: string, gapMs: number): Promise<void> {
  if (gapMs <= 0) return
  const last = lastRequestAt.get(host)
  const now = Date.now()
  const wait = last === undefined ? 0 : last + gapMs - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt.set(host, Date.now())
}

/** The version words, ordered; anything else a resolver says is "no version stated". */
const VERSION_ORDER: readonly OaVersion[] = ['publishedVersion', 'acceptedVersion', 'submittedVersion']

function asVersion(raw: unknown): OaVersion | null {
  const v = typeof raw === 'string' ? raw.trim() : ''
  return VERSION_ORDER.find((known) => known.toLowerCase() === v.toLowerCase()) ?? null
}

/**
 * Version of record before manuscript, and inside one version a document before a landing page:
 * a PDF is the full text, a landing page is a chance at it. A candidate with no version stated
 * sorts last, because "some copy somewhere" is the weakest claim a resolver makes.
 */
export function orderCandidates(candidates: readonly OaCandidate[]): OaCandidate[] {
  const rank = (c: OaCandidate): number => {
    const v = c.version === null ? VERSION_ORDER.length : VERSION_ORDER.indexOf(c.version)
    const f = c.format === 'pdf' ? 0 : c.format === 'jats' ? 1 : 2
    return v * 10 + f
  }
  return [...candidates].sort((a, b) => rank(a) - rank(b))
}

/**
 * Whether a lookup may be reused: a FIND always, everything else for a week (5.5).
 *
 * What counts as negative is "no candidate produced usable text", not "no candidate existed".
 * A round that tried two repository copies and found both too thin is exactly the answer worth
 * remembering: asking the three APIs again the same week gives the same two copies, and the
 * nightly sweep would ask about the same entries every night.
 */
export function lookupIsFresh(lookup: OaLookup, now: Date): boolean {
  if (lookup.accepted !== null) return true
  // A rate-limited answer is not an answer; ask again next time.
  if (lookup.rateLimited) return false
  const ageMs = now.getTime() - Date.parse(lookup.checkedAt)
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < OA_NEGATIVE_TTL_DAYS * 24 * 3600 * 1000
}

/**
 * The best copy nobody has FETCHED yet, which is the only kind worth marking on a reading-list
 * entry: a candidate an ingest already pulled and threw away as a record page is not an open copy
 * the user can be sent to. Undefined when every named copy has been tried.
 */
export function bestUntriedCandidate(lookup: OaLookup): OaCandidate | undefined {
  if (lookup.accepted !== null) return lookup.accepted
  return orderCandidates(lookup.candidates).find((c) => !lookup.tried.some((t) => t.url === c.url))
}

/**
 * Whether every copy this DOI has was fetched and none of them read as full text. The board says
 * so instead of offering a button that would repeat the same failure, and the mark on the entry
 * stays true either way: a copy exists at that address, it just is not the paper.
 */
export function lookupExhausted(lookup: OaLookup): boolean {
  return lookup.accepted === null && lookup.candidates.length > 0 && bestUntriedCandidate(lookup) === undefined
}

/**
 * The ONE case a sweep may skip a DOI outright: a fresh round that named no copy at all.
 *
 * "Asked this week" is not enough on its own. A round that named copies but marked nothing - a
 * dry run of the sweep, or a lookup by an ingest that then failed - must still reach the entry,
 * or asking once would keep the mark off the board for a week. Reading the row is free; it is
 * the three APIs that are not.
 */
export function lookupSaysNothing(lookup: OaLookup, now: Date): boolean {
  return lookupIsFresh(lookup, now) && lookup.accepted === null && lookup.candidates.length === 0
}

/** The banner above the document, in the words section 5.4 fixes. */
export function oaBanner(oa: OaDisclosure): string[] {
  const version = oa.version ?? 'version not stated'
  const what = oa.kind === 'substituted' ? 'was read as an abstract only' : 'could not be read'
  const lines = [`Text from an open-access copy (${version}) at ${oa.host}: ${oa.url}. The requested address ${what}.`]
  if (oa.retracted) lines.push('OpenAlex marks this work as retracted.')
  return lines
}

// --- the resolvers -----------------------------------------------------------

interface ResolverContext {
  readonly deps: OaDeps
  readonly fetchOpts: FetchOptions
  readonly timeoutMs: number
  /** Collects what happened, for the job log and the manifest notes. */
  readonly notes: string[]
  /** Set when a resolver was rate limited, so the DOI is not recorded as "nothing found". */
  rateLimited: boolean
  retracted: boolean
}

/** One JSON request to a resolver's API, under the page cap, with the courtesy gap and 429 retries. */
async function askApi(ctx: ResolverContext, url: string, headers?: Readonly<Record<string, string>>): Promise<unknown> {
  const gap = ctx.deps.courtesyMs ?? DEFAULT_COURTESY_MS
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    const validated = await validateUrl(url, ctx.deps.resolve)
    await courtesyWait(validated.url.hostname, gap)
    try {
      const answer = await fetchBytes(validated, DEFAULT_MAX_BYTES, ctx.timeoutMs, {
        ...ctx.fetchOpts,
        ...(headers ? { headers } : {}),
      })
      return JSON.parse(answer.body.toString('utf8'))
    } catch (err) {
      const message = (err as Error).message
      const tooManyRequests = err instanceof FetchStatusError && err.status === 429
      if (tooManyRequests && attempt < RATE_LIMIT_RETRIES) {
        await new Promise((r) => setTimeout(r, gap * (attempt + 1)))
        continue
      }
      if (tooManyRequests) {
        ctx.rateLimited = true
        ctx.notes.push(`open access: ${new URL(url).hostname} is rate limiting; not recorded as "nothing found"`)
        return undefined
      }
      ctx.notes.push(`open access: ${new URL(url).hostname} answered nothing usable (${message.slice(0, 120)})`)
      return undefined
    }
  }
  return undefined
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

/** Candidates OpenAlex knows about: the best location first, then every other open one. */
async function openalex(doi: string, ctx: ResolverContext): Promise<OaCandidate[]> {
  /*
   * The polite pool wants a contact address, and OpenAlex takes it either as a `mailto`
   * parameter or inside the User-Agent. It goes in the HEADER (D15): a query parameter ends up
   * in every error message this module writes into the job log and the manifest, and an address
   * that must never be logged cannot ride in a URL. The header is host-bound and is dropped on
   * a redirect off api.openalex.org.
   */
  const mail = (ctx.deps.env ?? process.env)['OA_CONTACT_EMAIL']?.trim()
  const select = 'id,title,open_access,best_oa_location,locations,is_retracted'
  const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}?select=${select}`
  const headers = mail !== undefined && mail !== '' ? { 'user-agent': `vault-service/0.1 (mailto:${mail})` } : undefined
  const body = (await askApi(ctx, url, headers)) as
    | {
        is_retracted?: boolean
        best_oa_location?: Record<string, unknown> | null
        locations?: Array<Record<string, unknown>> | null
      }
    | undefined
  if (body === undefined) return []
  if (body.is_retracted === true) {
    ctx.retracted = true
    ctx.notes.push('open access: OpenAlex marks this work as retracted')
  }
  const locations = [body.best_oa_location, ...(body.locations ?? [])].filter(
    (l): l is Record<string, unknown> => l !== null && l !== undefined && l['is_oa'] !== false,
  )
  const out: OaCandidate[] = []
  for (const loc of locations) {
    const version = asVersion(loc['version'])
    const license = typeof loc['license'] === 'string' ? loc['license'] : null
    const source = loc['source'] as { display_name?: string } | null | undefined
    const pdf = typeof loc['pdf_url'] === 'string' ? loc['pdf_url'] : undefined
    const landing = typeof loc['landing_page_url'] === 'string' ? loc['landing_page_url'] : undefined
    for (const [url, format] of [
      [pdf, 'pdf' as OaFormat],
      [landing, 'landing' as OaFormat],
    ] as const) {
      if (url === undefined || url === '') continue
      out.push({
        url,
        format,
        version,
        host: hostOf(url) || (source?.display_name ?? 'unknown'),
        license,
        source: 'openalex',
      })
    }
  }
  // Same address twice (the best location IS one of the locations) is one candidate.
  const seen = new Set<string>()
  return out.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
}

/** Europe PMC: only when the record is open access and has a PMC id; the full text is JATS. */
async function europepmc(doi: string, ctx: ResolverContext): Promise<OaCandidate[]> {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22${encodeURIComponent(doi)}%22&resultType=core&format=json`
  const body = (await askApi(ctx, url)) as
    | { resultList?: { result?: Array<Record<string, unknown>> } }
    | undefined
  const record = body?.resultList?.result?.[0]
  if (record === undefined) return []
  const pmcid = typeof record['pmcid'] === 'string' ? record['pmcid'] : undefined
  const open = record['isOpenAccess'] === 'Y' || record['inEPMC'] === 'Y'
  if (pmcid === undefined || !open) return []
  /*
   * The record's own version: a journal article in Europe PMC is the published one. A preprint
   * is marked by its SOURCE (`PPR`); `pubType` is a comma-separated list of article types and
   * never says "preprint" on its own.
   */
  const version: OaVersion = record['source'] === 'PPR' ? 'submittedVersion' : 'publishedVersion'
  return [
    {
      url: `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`,
      format: 'jats',
      version,
      host: 'europepmc.org',
      license: typeof record['license'] === 'string' ? record['license'] : null,
      source: 'europepmc',
    },
  ]
}

/** CORE, only with a key in the service environment. The key never leaves its own host. */
async function core(doi: string, ctx: ResolverContext): Promise<OaCandidate[]> {
  const key = (ctx.deps.env ?? process.env)['CORE_API_KEY']?.trim()
  if (key === undefined || key === '') return []
  const url = `https://api.core.ac.uk/v3/search/works?q=doi:%22${encodeURIComponent(doi)}%22&limit=3`
  const body = (await askApi(ctx, url, { authorization: `Bearer ${key}` })) as
    | { results?: Array<Record<string, unknown>> }
    | undefined
  const out: OaCandidate[] = []
  for (const record of body?.results ?? []) {
    const download = typeof record['downloadUrl'] === 'string' ? record['downloadUrl'] : undefined
    if (download === undefined || download === '') continue
    out.push({
      url: download,
      format: /\.pdf($|\?)/i.test(download) ? 'pdf' : 'landing',
      /*
       * CORE states no version: its `documentType` says "research" or "thesis". Guessing
       * `acceptedVersion` would make the run mark a quote from the version of record as an
       * accepted manuscript, which is D14 pointed the wrong way - so the banner says
       * "version not stated" and the run knows it does not know.
       */
      version: null,
      host: hostOf(download) || 'core.ac.uk',
      license: null,
      source: 'core',
    })
  }
  return out
}

const RESOLVERS: ReadonlyArray<{ readonly name: OaSource; readonly run: (doi: string, ctx: ResolverContext) => Promise<OaCandidate[]> }> = [
  { name: 'openalex', run: openalex },
  { name: 'europepmc', run: europepmc },
  { name: 'core', run: core },
]

// --- reading one candidate ---------------------------------------------------

/**
 * JATS full text through pandoc, in the converter jail like every other conversion (2.3).
 * Answered on stdout rather than into a file: the conversion of a candidate that may be
 * rejected should leave nothing behind at all.
 */
async function jatsToMarkdown(xmlPath: string, scratchDir: string, tools: ToolAvailability): Promise<string> {
  if (!tools.pandoc) throw new PreprocessError('pandoc is not installed - the JATS full text cannot be converted')
  const { stdout } = await runConverter('pandoc', ['-f', 'jats', '-t', 'gfm', xmlPath], {
    reads: [xmlPath],
    writes: scratchDir,
    timeoutMs: 120_000,
  })
  return stdout
}

interface CandidateText {
  readonly text: string
  /** The candidate's own bytes, kept until it is accepted and nowhere else. */
  readonly bytes: Buffer
  /** The name the raw file would get IF this candidate clears the bars. */
  readonly original: string
  readonly isPdf: boolean
  readonly ocrApplied: boolean
  readonly notes: readonly string[]
}

/**
 * Fetches one candidate and turns it into text. THE one way out of this module: `validateUrl`
 * first, then {@link fetchBytes} under the format's cap, and only then a converter.
 *
 * WRITES NOTHING INTO THE JOB DIRECTORY. A candidate is judged before it is kept: the job's
 * `.raw/<job-id>/` is committed with the job, so a copy that turns out to be a record page
 * would otherwise ride into the vault beside the one that was accepted. Conversions happen in
 * a scratch directory outside the vault, which goes away with the attempt.
 */
async function readCandidate(candidate: OaCandidate, seq: number, ctx: ResolverContext): Promise<CandidateText> {
  const validated = await validateUrl(candidate.url, ctx.deps.resolve)
  await courtesyWait(validated.url.hostname, ctx.deps.courtesyMs ?? DEFAULT_COURTESY_MS)
  const cap = candidate.format === 'pdf' ? MAX_PDF_BYTES : DEFAULT_MAX_BYTES
  const answer = await fetchBytes(validated, cap, ctx.timeoutMs, ctx.fetchOpts)

  // Magic bytes decide, here as in the URL lane: a "landing page" that is a PDF is a PDF.
  const isPdf = candidate.format === 'pdf' || answer.body.subarray(0, 5).toString('latin1') === '%PDF-'
  if (isPdf) {
    if (ctx.deps.readPdf === undefined) throw new PreprocessError('no PDF reader available for an open-access PDF candidate')
    const read = await ctx.deps.readPdf(answer.body, seq)
    if (read.deferred) throw new PreprocessError(`the copy is a PDF the plugin declined: ${read.notes.join('; ')}`)
    return { text: read.text, bytes: answer.body, original: 'oa-copy.pdf', isPdf: true, ocrApplied: read.ocrApplied, notes: read.notes }
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `oa-candidate-${seq}-`))
  try {
    if (candidate.format === 'jats') {
      const xmlPath = path.join(scratch, 'candidate.xml')
      fs.writeFileSync(xmlPath, answer.body)
      const text = await jatsToMarkdown(xmlPath, scratch, ctx.deps.tools)
      return {
        text,
        bytes: answer.body,
        original: 'oa-copy.xml',
        isPdf: false,
        ocrApplied: false,
        notes: ['open access: JATS full text converted with pandoc'],
      }
    }
    const htmlPath = path.join(scratch, 'candidate.html')
    const html = answer.body.toString('utf8')
    fs.writeFileSync(htmlPath, html, 'utf8')
    const extracted = await extractArticle({ filePath: htmlPath, html, tools: ctx.deps.tools, notePrefix: 'open access: ' })
    const junk = assessExtractedContent(extracted.markdown)
    if (junk !== null) throw new PreprocessError(`the copy is not readable either: ${junk}`)
    return { text: extracted.markdown, bytes: answer.body, original: 'oa-copy.html', isPdf: false, ocrApplied: false, notes: extracted.notes }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Asks the resolvers about one DOI and fetches NO document (docs/sources/SPEC.md 6.1).
 *
 * What the nightly reading-list sweep needs: twenty entries a night, each answered with "is
 * there an open copy, and which is the best one", without twenty downloads. The round is cached
 * like any other, so the ingest the user then starts from a find goes straight to the copy
 * instead of asking the three APIs again minutes later (6.3).
 */
export async function lookupOpenAccess(doi: string, deps: OaDeps): Promise<OaLookup> {
  const now = deps.now ?? ((): Date => new Date())
  const ctx: ResolverContext = {
    deps,
    fetchOpts: {
      ...(deps.resolve ? { resolve: deps.resolve } : {}),
      ...(deps.request ? { request: deps.request } : {}),
    },
    timeoutMs: deps.timeoutMs ?? 30_000,
    notes: [],
    rateLimited: false,
    retracted: false,
  }
  const cached = deps.cache?.get(doi)
  if (cached !== undefined && lookupIsFresh(cached, now())) return cached

  const candidates: OaCandidate[] = []
  for (const resolver of RESOLVERS) {
    candidates.push(...(await resolver.run(doi, ctx)))
    // One find is enough for a mark on a reading-list entry; the ingest does the rest.
    if (candidates.length > 0) break
  }
  const lookup: OaLookup = {
    doi,
    checkedAt: now().toISOString(),
    candidates: orderCandidates(candidates),
    tried: [],
    retracted: ctx.retracted,
    rateLimited: ctx.rateLimited,
    accepted: null,
  }
  deps.cache?.put(lookup)
  return lookup
}

// --- the recovery ------------------------------------------------------------

/**
 * Looks for a copy of `doi` and returns one when it clears both bars (5.3): longer than what is
 * in hand, and long enough to be full text rather than a repository record page.
 *
 * Never throws for a candidate's sake: a refused address, a cap, a converter that cannot read
 * the file are all "this candidate did not work", recorded in the notes and followed by the next
 * one. The caller decides what a failure means - a rescue fails the job as the fetch did, a
 * substitute keeps the thin text (5.3).
 */
export async function recoverOpenAccess(args: {
  /** The DOI to ask the resolvers about. Absent = only what `deps.hint` names can be tried. */
  readonly doi?: string
  readonly kind: OaKind
  /** How many characters the job already has: 0 for a rescue, the thin text's length otherwise. */
  readonly haveChars: number
  readonly deps: OaDeps
}): Promise<{ readonly recovery?: OaRecovery; readonly notes: readonly string[] }> {
  const { doi, kind, deps } = args
  const now = deps.now ?? ((): Date => new Date())
  const ctx: ResolverContext = {
    deps,
    fetchOpts: {
      ...(deps.resolve ? { resolve: deps.resolve } : {}),
      ...(deps.request ? { request: deps.request } : {}),
    },
    timeoutMs: deps.timeoutMs ?? 30_000,
    notes: [],
    rateLimited: false,
    retracted: false,
  }

  // No DOI, no lookup table: a row is keyed by one, and a hint is an address rather than an identity.
  const cached = doi === undefined ? undefined : deps.cache?.get(doi)
  const fresh = cached !== undefined && lookupIsFresh(cached, now())
  /*
   * What a fresh row is good for, in order: the copy that worked last time, then copies a sweep
   * named but nobody has fetched yet (6.3 - this is what lets the ingest started from a find
   * rescue itself at once), and otherwise nothing at all, which is an answer too and spares
   * three APIs the same question for a week.
   */
  const fromCache = fresh
    ? [...(cached.accepted === null ? [] : [cached.accepted]), ...cached.candidates.filter((c) => !cached.tried.some((t) => t.url === c.url))]
    : []
  if (fresh) ctx.retracted = cached.retracted
  if (fresh && fromCache.length === 0 && deps.hint === undefined) {
    ctx.notes.push(
      `open access: nothing usable was found for this DOI when it was last asked (${cached.checkedAt}, tried ${cached.tried.length})`,
    )
    return { notes: ctx.notes }
  }

  let attempts = 0
  const tried: OaCandidate[] = []

  /** Tries candidates in order until one clears the bars or the budget is gone. */
  const tryAll = async (candidates: readonly OaCandidate[]): Promise<OaRecovery | undefined> => {
    for (const candidate of orderCandidates(candidates)) {
      if (attempts >= OA_MAX_ATTEMPTS) {
        ctx.notes.push(`open access: stopped after ${OA_MAX_ATTEMPTS} candidates`)
        return undefined
      }
      if (tried.some((t) => t.url === candidate.url)) continue
      attempts++
      tried.push(candidate)
      let read: CandidateText
      try {
        read = await readCandidate(candidate, attempts, ctx)
      } catch (err) {
        ctx.notes.push(`open access: ${candidate.host} did not work out (${(err as Error).message.slice(0, 160)})`)
        continue
      }
      const chars = read.text.trim().length
      if (chars <= args.haveChars || chars < OA_MIN_FULL_TEXT_CHARS) {
        ctx.notes.push(`open access: the copy at ${candidate.host} is ${chars} characters, not full text`)
        continue
      }
      // Accepted: NOW the raw file is kept, in the job's own staging directory (5.4).
      fs.writeFileSync(path.join(deps.jobDir, read.original), read.bytes)
      const disclosure: OaDisclosure = {
        doi: doi ?? null,
        kind,
        url: candidate.url,
        source: candidate.source,
        host: candidate.host,
        version: candidate.version,
        license: candidate.license,
        retracted: ctx.retracted,
        triedAt: now().toISOString(),
      }
      return {
        disclosure,
        text: read.text,
        original: read.original,
        isPdf: read.isPdf,
        ocrApplied: read.ocrApplied,
        notes: [`open access: ${kind} from ${candidate.source} (${candidate.version ?? 'version not stated'}) at ${candidate.host}`, ...read.notes],
      }
    }
    return undefined
  }

  /*
   * What is already known comes first, and no API is asked while an untried copy stands: the
   * address the reading-list entry names, then the round in the lookup table.
   */
  const hinted: OaCandidate[] =
    deps.hint === undefined
      ? []
      : [
          {
            url: deps.hint.url,
            format: /\.pdf($|\?)/i.test(deps.hint.url) ? 'pdf' : 'landing',
            version: asVersion(deps.hint.version),
            host: hostOf(deps.hint.url) || 'unknown',
            license: null,
            source: 'reading-list',
          },
        ]
  let recovery = hinted.length + fromCache.length > 0 ? await tryAll([...hinted, ...fromCache]) : undefined
  // The resolvers are asked about a DOI; without one, the hint above was the whole chance.
  if (recovery === undefined && doi !== undefined) {
    for (const resolver of RESOLVERS) {
      if (attempts >= OA_MAX_ATTEMPTS) break
      const candidates = await resolver.run(doi, ctx)
      if (candidates.length === 0) continue
      recovery = await tryAll(candidates)
      if (recovery !== undefined) break
    }
  }

  const accepted = recovery === undefined ? null : (tried.find((t) => t.url === recovery?.disclosure.url) ?? null)
  // No DOI, nothing to key a row on: a hint is an address, not an identity.
  if (doi !== undefined) {
    deps.cache?.put({
      doi,
      checkedAt: now().toISOString(),
      // Everything known about the DOI, and separately what this job actually fetched: a copy
      // that came back as a record page must not be downloaded again next week.
      candidates: [...new Map([...(fresh ? cached.candidates : []), ...tried].map((c) => [c.url, c])).values()],
      tried: accepted === null ? tried : tried.filter((t) => t.url !== accepted.url),
      retracted: ctx.retracted,
      rateLimited: ctx.rateLimited,
      accepted,
    })
  }

  if (recovery === undefined) {
    ctx.notes.push(`no open copy cleared the bar (tried ${tried.length})`)
    return { notes: ctx.notes }
  }
  return { recovery, notes: [...ctx.notes, ...recovery.notes] }
}
