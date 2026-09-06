/**
 * The daily recap and the value signal over HTTP (docs/agents/SPEC.md sections 9 and 12),
 * registered only with `AGENTS_ENABLED`:
 *
 *   GET  /api/v1/recaps                 the recaps, newest first (model included), and the schedule
 *   GET  /api/v1/recaps/:date           one recap
 *   POST /api/v1/recaps/build           build today's recap now (202); `force` rebuilds, `cycleDate` picks a day
 *   POST /api/v1/recaps/:date/answers   apply answers: `{ answers: [...] }` structured, or `{ text }` in the code grammar
 *   POST /api/v1/value-events           `{ kind: 'page_open' | 'recap_link', page?, agentId? }`
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../server.js'
import type { RecapService, RecapAnswer } from '../../pipeline/recap.js'
import { parseRecapAnswers } from '../../pipeline/recap.js'
import type { FellowService } from '../../pipeline/fellows.js'

const fellowNo = z.number().int().min(1).max(99)
const letter = z.string().regex(/^[a-j]$/)

const answerSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pick'), fellow: fellowNo, letter }),
  z.object({ action: z.literal('veto'), fellow: fellowNo, letter: letter.optional() }),
  z.object({ action: z.literal('skip'), fellow: fellowNo }),
  z.object({ action: z.literal('pause'), fellow: fellowNo }),
  z.object({ action: z.literal('resume'), fellow: fellowNo }),
  z.object({ action: z.literal('note'), fellow: fellowNo, text: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal('model'), fellow: fellowNo, value: z.string().trim().min(1).max(40) }),
  z.object({ action: z.literal('step'), fellow: fellowNo, value: z.string().trim().min(1).max(40) }),
  z.object({ action: z.literal('topic'), fellow: fellowNo, letter, text: z.string().trim().min(3).max(500) }),
])

const answersSchema = z.object({
  answers: z.array(answerSchema).max(50).optional(),
  text: z.string().trim().max(4000).optional(),
  via: z.enum(['dashboard', 'telegram']).optional(),
})

const buildSchema = z.object({
  cycleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  force: z.boolean().optional(),
})

const valueSchema = z.object({
  kind: z.enum(['page_open', 'recap_link']),
  page: z.string().trim().min(1).max(500).optional(),
  agentId: z.string().trim().min(1).max(64).optional(),
})

export function registerRecapsRoute(app: FastifyInstance, ctx: AppContext, recaps: RecapService, fellows: FellowService): void {
  const issues = (error: z.ZodError): string => error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')

  app.get('/api/v1/recaps', async (_req, reply) => {
    return reply.send({ recaps: recaps.list(), status: recaps.status() })
  })

  // Static before parametric: `/recaps/build` is not a date.
  app.post('/api/v1/recaps/build', async (req, reply) => {
    const parsed = buildSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    if (ctx.config.auth === null) return reply.code(503).send({ error: 'no Anthropic credential configured - add it under System, then restart' })
    if (recaps.isBuilding) return reply.code(409).send({ error: 'a recap is already being built' })
    void recaps.build({ trigger: 'manual', ...(parsed.data.cycleDate !== undefined ? { cycleDate: parsed.data.cycleDate } : {}), ...(parsed.data.force !== undefined ? { force: parsed.data.force } : {}) })
    return reply.code(202).send({ started: true, status: recaps.status() })
  })

  app.get('/api/v1/recaps/:date', async (req, reply) => {
    const { date } = req.params as { date: string }
    const recap = recaps.get(date)
    if (!recap) return reply.code(404).send({ error: 'no recap for that date' })
    return reply.send({ recap })
  })

  app.post('/api/v1/recaps/:date/answers', async (req, reply) => {
    const { date } = req.params as { date: string }
    const parsed = answersSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    const answers: RecapAnswer[] = [...(parsed.data.answers ?? [])] as RecapAnswer[]
    const errors: string[] = []
    if (parsed.data.text !== undefined && parsed.data.text !== '') {
      const fromText = parseRecapAnswers(parsed.data.text)
      if (!fromText) return reply.code(400).send({ error: 'the text is not an answer in the code grammar (1b, veto 1b, skip 1, pause 1, note 1: ...)' })
      answers.push(...fromText.answers)
      errors.push(...fromText.errors)
    }
    if (answers.length === 0 && errors.length === 0) return reply.code(400).send({ error: 'no answers given' })
    const outcome = await recaps.answer(date, answers, parsed.data.via ?? 'dashboard')
    if (!outcome) return reply.code(404).send({ error: 'no recap for that date' })
    return reply.send({ results: outcome.results, errors, recap: outcome.recap })
  })

  app.post('/api/v1/value-events', async (req, reply) => {
    const parsed = valueSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    const { kind, page, agentId } = parsed.data
    const result = fellows.recordValue(kind, page ?? null, agentId)
    return reply.code(202).send({ ok: true, agentId: result.agentId })
  })
}
