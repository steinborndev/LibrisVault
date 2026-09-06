/**
 * The reading list over HTTP (docs/agents/SPEC.md section 10.6), behind `AGENTS_ENABLED`:
 *
 *   GET  /api/v1/reading-list          what the Fellows found, with each entry's ingest state
 *   POST /api/v1/reading-list/ingest   fetch one entry through the ordinary URL ingest
 *
 * The POST takes a URL that must already stand in the list. That is the whole point of the
 * indirection: the agent proposes, the user (or a later rule) decides, and the download
 * happens in the service, where the SSRF guard, the size cap and the magic-byte check are.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { IngestQueue } from '../../pipeline/queue.js'
import type { ReadingListService } from '../../pipeline/reading-list.js'

const ingestSchema = z.object({ url: z.string().trim().url() })

export function registerReadingListRoute(app: FastifyInstance, reading: ReadingListService, queue: IngestQueue): void {
  app.get('/api/v1/reading-list', async (_req, reply) => reply.send({ entries: reading.entries() }))

  app.post('/api/v1/reading-list/ingest', async (req, reply) => {
    const parsed = ingestSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'a url is required' })
    const url = parsed.data.url
    // Only what a Fellow wrote down: the route must not become an open fetch proxy.
    const entry = reading.entries().find((e) => e.url === url)
    if (entry === undefined) return reply.code(404).send({ error: 'that url is not on the reading list' })
    if (entry.job !== null && entry.job.status !== 'failed') {
      return reply.code(409).send({ error: `already ingested (${entry.job.status})`, job: entry.job })
    }
    const { job } = queue.enqueueUrl({ url, source: 'url' })
    return reply.code(202).send({ job })
  })
}
