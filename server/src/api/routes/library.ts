/**
 * The Library screen's data (docs/agents/SPEC.md sections 10 and 12), registered only with
 * `AGENTS_ENABLED`:
 *
 *   GET    /api/v1/library/scene     the snapshot the renderer draws (rooms, departments, actors, night)
 *   POST   /api/v1/library/move      { domain, room, slot? } move a shelf, swap with `slot`
 *   GET    /api/v1/wings             the wings in order
 *   POST   /api/v1/wings             { name? } create one (201), appended to the sequence
 *   PATCH  /api/v1/wings/order       { ids } reorder
 *   PATCH  /api/v1/wings/:id         { name } rename
 *   DELETE /api/v1/wings/:id         remove an empty wing (409 otherwise)
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { WingRecord } from '../../db/library.js'
import type { LibraryService } from '../../pipeline/library.js'

const nameSchema = z.string().trim().min(1).max(40)

export function registerLibraryRoute(app: FastifyInstance, library: LibraryService): void {
  const issues = (error: z.ZodError): string => error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')

  app.get('/api/v1/library/scene', async (_req, reply) => reply.send(library.scene()))

  app.post('/api/v1/library/move', async (req, reply) => {
    const parsed = z.object({ domain: z.string().trim().min(1).max(64), room: z.string().trim().min(1).max(64), slot: z.number().int().min(0).max(11).optional() }).safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    const result = library.move(parsed.data.domain, parsed.data.room, parsed.data.slot)
    if (result.error !== undefined) return reply.code(result.status ?? 400).send({ error: result.error })
    return reply.send({ placements: result.placements })
  })

  app.get('/api/v1/wings', async (_req, reply) => reply.send({ wings: library.wings() }))

  app.post('/api/v1/wings', async (req, reply) => {
    const parsed = z.object({ name: nameSchema.optional() }).safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    return reply.code(201).send({ wing: library.createWing(parsed.data.name) })
  })

  // Static before parametric: `order` is not a wing id.
  app.patch('/api/v1/wings/order', async (req, reply) => {
    const parsed = z.object({ ids: z.array(z.string().min(1)).max(100) }).safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    return reply.send({ wings: library.reorderWings(parsed.data.ids) })
  })

  /*
   * One route for both things a wing carries: its name, and where each row's gap stands. A
   * body may name either, and naming neither is a 400 rather than a silent success.
   */
  app.patch('/api/v1/wings/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const aisle = z.number().int().min(0).max(6)
    const parsed = z
      .object({ name: nameSchema.optional(), wallAisle: aisle.optional(), midAisle: aisle.optional() })
      .refine((b) => b.name !== undefined || b.wallAisle !== undefined || b.midAisle !== undefined, {
        message: 'name, wallAisle or midAisle is required',
      })
      .safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) })
    let wing: WingRecord | undefined
    if (parsed.data.name !== undefined) wing = library.renameWing(id, parsed.data.name)
    if (parsed.data.wallAisle !== undefined) wing = library.setAisle(id, 'wall', parsed.data.wallAisle)
    if (parsed.data.midAisle !== undefined) wing = library.setAisle(id, 'mid', parsed.data.midAisle)
    if (!wing) return reply.code(404).send({ error: 'no such wing' })
    return reply.send({ wing })
  })

  app.delete('/api/v1/wings/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = library.deleteWing(id)
    if ('error' in result) return reply.code(result.status).send({ error: result.error })
    return reply.code(204).send()
  })
}
