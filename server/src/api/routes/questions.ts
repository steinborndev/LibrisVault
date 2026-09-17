/**
 * The pinboard of open questions (prototype 2026-09-17):
 *
 *   GET  /api/v1/questions           every question on every page, with what the Fellows make of it
 *   POST /api/v1/questions/archive   strike one through on its page, or take the strike off
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { QuestionsService } from '../../pipeline/questions.js'

const archiveSchema = z.object({ page: z.string().min(1), text: z.string().trim().min(1), archived: z.boolean().default(true) })

export function registerQuestionsRoute(app: FastifyInstance, questions: QuestionsService): void {
  app.get('/api/v1/questions', async (_req, reply) => reply.send({ entries: questions.list() }))
  app.post('/api/v1/questions/archive', async (req, reply) => {
    const parsed = archiveSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'a page and a question are required' })
    const { page, text, archived } = parsed.data
    const result = await questions.setArchived(page, text, archived)
    if (!result.changed) return reply.code(404).send({ error: 'that question is not on that page, or already stands that way' })
    return reply.send({ archived, vetoed: result.vetoed })
  })
}
