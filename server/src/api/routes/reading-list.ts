/**
 * The reading list over HTTP (docs/agents/SPEC.md section 10.6), behind `AGENTS_ENABLED`:
 *
 *   GET  /api/v1/reading-list           what the Fellows found, with each entry's ingest state
 *   POST /api/v1/reading-list/ingest    fetch one entry through the ordinary URL ingest
 *   POST /api/v1/reading-list/archive   put one entry out of sight, or bring it back
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

export function registerReadingListRoute(app: FastifyInstance, reading: ReadingListService, queue: IngestQueue): void {
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
