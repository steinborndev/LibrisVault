/**
 * The reading list over HTTP (docs/agents/SPEC.md section 10.6), behind `AGENTS_ENABLED`:
 *
 *   GET  /api/v1/reading-list             what the Fellows found, with each entry's ingest state
 *   POST /api/v1/reading-list/ingest      fetch one entry through the ordinary URL ingest
 *   POST /api/v1/reading-list/archive     put one entry out of sight, or bring it back
 *   POST /api/v1/reading-list/open-access look for a legal open copy of one entry, now
 *
 * The POST takes a URL that must already stand in the list. That is the whole point of the
 * indirection: the agent proposes, the user (or a later rule) decides, and the download
 * happens in the service, where the SSRF guard, the size cap and the magic-byte check are.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { IngestQueue } from '../../pipeline/queue.js'
import { urlKey, type ReadingListService } from '../../pipeline/reading-list.js'

const ingestSchema = z.object({ url: z.string().trim().url() })
/** `archived: false` takes the mark off again, so a mis-click is not permanent. */
const archiveSchema = z.object({ url: z.string().trim().url(), archived: z.boolean().default(true) })

/** Local calendar date, the same shape `filedAt` carries. */
const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * What "Find open-access" does for one entry: ask the resolvers, FETCH the best copy, extract it
 * and measure it against the acceptance bars - the same work the ingest's rescue does, without
 * writing a page. Injected from `main.ts`, which owns the lookup table, the toolchain and the
 * setting; the route only decides who may ask.
 */
export interface OpenAccessFinder {
  (entry: { readonly url: string; readonly ref: string | null }): Promise<
    { readonly found: true; readonly url: string; readonly version: string | null; readonly chars: number } | { readonly found: false; readonly reason: string }
  >
}

export function registerReadingListRoute(
  app: FastifyInstance,
  reading: ReadingListService,
  queue: IngestQueue,
  findOpenAccess?: OpenAccessFinder,
): void {
  app.get('/api/v1/reading-list', async (_req, reply) => reply.send({ entries: reading.entries() }))

  app.post('/api/v1/reading-list/ingest', async (req, reply) => {
    const parsed = ingestSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'a url is required' })
    const url = parsed.data.url
    // Only what a Fellow wrote down: the route must not become an open fetch proxy. Matched the
    // way the list dedupes, so a trailing slash or a tracking parameter is still the same entry.
    const entry = reading.entries().find((e) => urlKey(e.url) === urlKey(url))
    if (entry === undefined) return reply.code(404).send({ error: 'that url is not on the reading list' })
    if (entry.job !== null && entry.job.status !== 'failed') {
      return reply.code(409).send({ error: `already ingested (${entry.job.status})`, job: entry.job })
    }
    // The entry's own url is what gets fetched, never the caller's spelling of it.
    const { job } = queue.enqueueUrl({ url: entry.url, source: 'url' })
    return reply.code(202).send({ job })
  })

  /**
   * Look for an open copy of one entry, now, instead of waiting for the night shift.
   *
   * It VERIFIES: the copy is fetched, extracted and measured, so the mark it leaves means "this
   * is the full text", not "a resolver has it on file". Measured over the live list before it was
   * built - asking costs up to 5.7 s when nothing is registered, and the fetch that follows a
   * find costs 0.2 to 2.4 s on top, so the worst case is the miss either way.
   *
   * The find is written into the entry (three lines plus `oa_chars`, one commit behind the shared
   * mutex), which is what makes it permanent and visible in Obsidian. Nothing is ingested here;
   * that stays the user's second click.
   */
  app.post('/api/v1/reading-list/open-access', async (req, reply) => {
    if (findOpenAccess === undefined) {
      return reply.code(503).send({ error: 'open-access recovery is not wired in this service' })
    }
    const parsed = ingestSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'a url is required' })
    const entry = reading.entries().find((e) => urlKey(e.url) === urlKey(parsed.data.url))
    if (entry === undefined) return reply.code(404).send({ error: 'that url is not on the reading list' })
    // The same rule the board draws its button from, asked again here: a client is not a guard.
    if (!entry.oaEligible) {
      return reply.code(409).send({
        error:
          entry.oa !== null
            ? 'this entry already names an open copy'
            : entry.filed !== null
              ? 'this publication is already in the vault'
              : 'nothing to look up: this entry names no DOI, arXiv id or PMC id',
      })
    }
    const found = await findOpenAccess({ url: entry.url, ref: entry.ref })
    if (!found.found) return reply.code(200).send({ found: false, reason: found.reason })
    await reading.markOpenCopy(entry.url, { url: found.url, version: found.version, at: localDate(new Date()), chars: found.chars }, localDate(new Date()))
    return reply.code(200).send({ found: true, oa: { url: found.url, version: found.version, chars: found.chars } })
  })

  /*
   * Archiving is a mark on the entry, never a removal: the page is append-only for content, and
   * the request and the reason a Fellow wrote down survive it. It says "I have dealt with this",
   * which is a different statement from "this is in the vault" and can be true without it - a
   * publication the user decides not to fetch is exactly what the list had no answer for.
   */
  app.post('/api/v1/reading-list/archive', async (req, reply) => {
    const parsed = archiveSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'a url is required' })
    const { url, archived } = parsed.data
    const entry = reading.entries().find((e) => urlKey(e.url) === urlKey(url))
    if (entry === undefined) return reply.code(404).send({ error: 'that url is not on the reading list' })
    // The service's date, not the caller's: this is a record of when it happened here.
    const changed = await reading.setArchived(entry.url, archived ? localDate(new Date()) : null)
    return reply.code(changed ? 200 : 409).send(changed ? { archived } : { error: `already ${archived ? 'archived' : 'current'}` })
  })
}
