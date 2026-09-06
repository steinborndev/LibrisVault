/**
 * Milestone A4 (docs/tasks/TASKS-A4.md): the Library's placement model (first free slot of
 * the newest wing, a new wing when none is free, favorites only by hand), the wing rules,
 * moving and swapping shelves, and the scene snapshot with zero Fellows and with runs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { SqliteLibraryStore, MemoryLibraryStore, autoPlace, freeSlot, nextWingName, MAIN_ROOM, WING_CAPACITY, type LibraryStore, type WingRecord } from '../src/db/library.js'
import { LibraryService, isNight } from '../src/pipeline/library.js'
import type { VaultGraph, GraphNode } from '../src/pipeline/graph.js'
import type { JobRow } from '../src/db/jobs.js'
import type { MaintenanceRun } from '../src/pipeline/maintenance.js'
import type { FellowSummary } from '../src/pipeline/fellows.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { EventBus } from '../src/pipeline/events.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer } from '../src/api/server.js'
import type { Config } from '../src/config.js'

const WINDOW = { start: '01:00', end: '06:00' }
const node = (over: Partial<GraphNode>): GraphNode => ({ path: 'wiki/concepts/X.md', title: 'X', type: 'concepts', tags: [], domain: 'astronomy', kind: 'knowledge', out: 0, in: 0, size: 2000, ...over })
const graphOf = (nodes: GraphNode[]): VaultGraph => ({ nodes, edges: [], unresolved: 0, gaps: [{ title: 'Gap', refBy: [0] }], builtAt: 'b' })

describe('placement model', () => {
  it('names wings by letter and finds free slots', () => {
    const w = (n: number): WingRecord[] => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, name: `Wing ${i}`, position: i, createdAt: 'c' }))
    expect(nextWingName([])).toBe('Wing A')
    expect(nextWingName(w(1))).toBe('Wing B')
    expect(nextWingName(w(26))).toBe('Wing AA')
    expect(freeSlot(MAIN_ROOM, [{ domain: 'a', room: MAIN_ROOM, slot: 0, placedBy: 'user', updatedAt: 'u' }])).toBe(1)
    expect(freeSlot(MAIN_ROOM, [0, 1, 2, 3].map((s) => ({ domain: `d${s}`, room: MAIN_ROOM, slot: s, placedBy: 'user' as const, updatedAt: 'u' })))).toBe(-1)
  })

  it('places new departments in the newest wing, opens a wing when full, never the main room', () => {
    let n = 0
    const first = autoPlace([], [], ['astronomy', 'computing'], 'now', () => `w${++n}`)
    expect(first.newWings.map((w) => w.name)).toEqual(['Wing A'])
    expect(first.added.map((p) => [p.room, p.slot, p.placedBy])).toEqual([
      ['w1', 0, 'auto'],
      ['w1', 1, 'auto'],
    ])
    const twelve = Array.from({ length: WING_CAPACITY + 1 }, (_, i) => `d${i}`)
    const second = autoPlace(first.placements, first.wings, twelve, 'now', () => `w${++n}`)
    expect(second.newWings.map((w) => w.name)).toEqual(['Wing B'])
    expect(second.added.filter((p) => p.room === 'w1')).toHaveLength(WING_CAPACITY - 2)
    expect(second.added.filter((p) => p.room === 'w2').map((p) => p.slot)).toEqual([0, 1, 2])
    expect(second.placements.some((p) => p.room === MAIN_ROOM)).toBe(false)
    // Idempotent: nothing new to place, nothing changes.
    const third = autoPlace(second.placements, second.wings, twelve, 'later', () => 'nope')
    expect(third.added).toEqual([])
    expect(third.newWings).toEqual([])
  })
})

describe('library stores', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(MEMORY_DB)
  })
  afterEach(() => {
    db.close()
  })
  const exercise = (store: LibraryStore): void => {
    store.createWing({ id: 'a', name: 'Wing A', position: 0, createdAt: '1' })
    store.createWing({ id: 'b', name: 'Wing B', position: 1, createdAt: '2' })
    expect(store.renameWing('b', 'Sciences')?.name).toBe('Sciences')
    expect(store.renameWing('zzz', 'x')).toBeUndefined()
    expect(store.reorderWings(['b']).map((w) => [w.id, w.position])).toEqual([
      ['b', 0],
      ['a', 1],
    ])
    store.place({ domain: 'astronomy', room: 'a', slot: 0, placedBy: 'auto', updatedAt: 'u' })
    store.place({ domain: 'astronomy', room: MAIN_ROOM, slot: 2, placedBy: 'user', updatedAt: 'u2' })
    expect(store.placements()).toEqual([{ domain: 'astronomy', room: MAIN_ROOM, slot: 2, placedBy: 'user', updatedAt: 'u2' }])
    expect(store.unplace('astronomy')).toBe(true)
    expect(store.unplace('astronomy')).toBe(false)
    expect(store.deleteWing('a')).toBe(true)
    expect(store.wings().map((w) => w.id)).toEqual(['b'])
  }
  it('sqlite', () => exercise(new SqliteLibraryStore(db)))
  it('memory', () => exercise(new MemoryLibraryStore()))
})

describe('LibraryService', () => {
  let vaultRoot: string
  let store: MemoryLibraryStore
  let nodes: GraphNode[]
  let jobs: JobRow[]
  let runs: MaintenanceRun[]
  let fellows: FellowSummary[]
  let clock: Date
  let service: LibraryService

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'library-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki/meta/domains.md'), '# Domains\n\n## Domains\n\n## astronomy\n\nStars.\n\n## computing\n\nBits.\n\n## meta\n\nSystem.\n')
    store = new MemoryLibraryStore()
    nodes = [
      node({ path: 'wiki/concepts/A.md', title: 'A' }),
      node({ path: 'wiki/sources/S.md', title: 'S', type: 'sources' }),
      node({ path: 'wiki/concepts/Tiny.md', title: 'Tiny', size: 100 }),
      node({ path: 'wiki/concepts/C.md', title: 'C', domain: 'cooking' }),
      node({ path: 'wiki/concepts/U.md', title: 'U', domain: null }),
      node({ path: 'wiki/meta/domains.md', title: 'domains', domain: 'meta', kind: 'structural', type: 'meta' }),
    ]
    jobs = []
    runs = []
    fellows = []
    clock = new Date(2026, 8, 7, 14, 0)
    service = new LibraryService({
      vaultRoot,
      store,
      graph: () => graphOf(nodes),
      jobs: () => jobs,
      runs: () => runs,
      fellows: () => fellows,
      window: () => WINDOW,
      concurrency: () => 2,
      now: () => clock,
    })
  })
  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('builds the scene with zero Fellows: departments in registry order, counts, auto placement, unfiled, night', () => {
    const scene = service.scene()
    expect(scene.night).toBe(false)
    expect(scene.rooms.map((r) => [r.kind, r.name, r.capacity])).toEqual([
      ['main', 'Main room', 4],
      ['wing', 'Wing A', 12],
    ])
    expect(scene.rooms[1]!.shelves.map((s) => [s.slot, s.domain, s.books, s.volumes, s.stubs, s.placedBy])).toEqual([
      [0, 'astronomy', 2, 1, 1, 'auto'],
      [1, 'computing', 0, 0, 0, 'auto'],
      [2, 'cooking', 1, 0, 0, 'auto'],
    ])
    expect(scene.departments.map((d) => d.domain)).toEqual(['astronomy', 'computing', 'cooking'])
    expect(scene.unfiled).toBe(1)
    expect(scene.gaps).toBe(1)
    expect(scene.fellows).toEqual([])
    expect(scene.runs).toEqual([])
    expect(scene.concurrency).toBe(2)
    // Placement persisted: a second scene changes nothing.
    expect(store.placements()).toHaveLength(3)
    expect(service.scene().rooms[1]!.shelves.map((s) => s.domain)).toEqual(['astronomy', 'computing', 'cooking'])
    clock = new Date(2026, 8, 7, 23, 30)
    expect(service.scene().night).toBe(true)
    expect(isNight(new Date(2026, 8, 7, 2, 0), WINDOW)).toBe(true)
    expect(isNight(new Date(2026, 8, 7, 9, 0), WINDOW)).toBe(false)
  })

  it('carries runs, jobs and Fellows; a Fellow\'s run is not listed twice', () => {
    runs = [
      { id: 'r1', kind: 'research', channel: 'maintenance:research', status: 'running', label: 'Topic', startedAt: 's' },
      { id: 'r2', kind: 'lint', channel: 'maintenance:lint', status: 'done', startedAt: 's' },
      { id: 'r3', kind: 'research-step', channel: 'maintenance:research-step', status: 'running', label: 'Fellow topic', startedAt: 's', agentId: 'a1' },
    ]
    jobs = [{ id: 'j1', status: 'queued', original_name: 'paper.pdf', url: null, source: 'upload', batch_id: null } as unknown as JobRow, { id: 'j2', status: 'done', original_name: 'x', url: null, source: 'upload', batch_id: null } as unknown as JobRow]
    fellows = [
      {
        agent: { id: 'a1', name: 'Ada', homeDomain: 'astronomy', model: 'sonnet-5', state: 'active', sleepCode: null, sleepReason: null, skipUntil: null } as FellowSummary['agent'],
        currentRun: runs[2]!,
        lastRun: null,
        runsToday: 1,
        pendingProposals: 1,
        next: { topic: 'Next', kind: 'research-step', estCostUsd: 2, status: 'proposed' } as FellowSummary['next'],
      },
    ]
    const scene = service.scene()
    expect(scene.runs.map((r) => r.id)).toEqual(['r1'])
    expect(scene.jobs).toEqual([{ id: 'j1', status: 'queued', name: 'paper.pdf', source: 'upload', batchId: null }])
    expect(scene.fellows[0]).toMatchObject({ agentId: 'a1', name: 'Ada', state: 'active', run: { id: 'r3', channel: 'maintenance:research-step' }, next: { topic: 'Next' } })
  })

  it('wings: create, rename, reorder, delete only when empty; moves and swaps', () => {
    service.scene()
    const wingA = service.wings()[0]!
    const wingB = service.createWing()
    expect(wingB.name).toBe('Wing B')
    expect(service.createWing('  Humanities ').name).toBe('Humanities')
    expect(service.renameWing(wingB.id, 'Sciences')?.name).toBe('Sciences')
    expect(service.reorderWings([wingB.id]).map((w) => w.name)).toEqual(['Sciences', 'Wing A', 'Humanities'])
    expect(service.deleteWing(wingA.id)).toMatchObject({ status: 409 })
    expect(service.deleteWing('nope')).toMatchObject({ status: 404 })

    // Move computing to the main room (first free favorite), then astronomy into the same slot: swap.
    expect(service.move('computing', MAIN_ROOM)).toMatchObject({ ok: true })
    let placements = store.placements()
    expect(placements.find((p) => p.domain === 'computing')).toMatchObject({ room: MAIN_ROOM, slot: 0, placedBy: 'user' })
    expect(service.move('astronomy', MAIN_ROOM, 0)).toMatchObject({ ok: true })
    placements = store.placements()
    expect(placements.find((p) => p.domain === 'astronomy')).toMatchObject({ room: MAIN_ROOM, slot: 0 })
    expect(placements.find((p) => p.domain === 'computing')).toMatchObject({ room: wingA.id, slot: 0 })
    // Unknown room, bad slot, full room.
    expect(service.move('cooking', 'nope')).toMatchObject({ status: 404 })
    expect(service.move('cooking', MAIN_ROOM, 9)).toMatchObject({ status: 400 })
    for (const d of ['cooking', 'computing']) expect(service.move(d, MAIN_ROOM)).toMatchObject({ ok: true })
    expect(service.move('astronomy', MAIN_ROOM)).toMatchObject({ ok: true })
    // Main room full now? astronomy, cooking, computing take 3; move a fourth and a fifth.
    expect(service.scene().rooms[0]!.shelves).toHaveLength(3)
    // A wing with no shelves can be deleted; the sequence closes.
    const empty = service.wings().find((w) => w.name === 'Humanities')!
    expect(service.deleteWing(empty.id)).toEqual({ ok: true })
    expect(service.wings().map((w) => [w.name, w.position])).toEqual([
      ['Sciences', 0],
      ['Wing A', 1],
    ])
    // The scene renders the favorites in the main room.
    expect(service.scene().rooms[0]!.shelves.map((s) => s.domain).sort()).toEqual(['astronomy', 'computing', 'cooking'])
  })
})

describe('library routes', () => {
  let vaultRoot: string
  let db: Db
  let app: FastifyInstance
  beforeEach(async () => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'library-api-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki'), { recursive: true })
    db = openDb(MEMORY_DB)
    const events = new EventBus()
    const store = new JobStore(db, events)
    const config: Config = {
      vaultRoot,
      obsidianVaultName: 'vault',
      demoMode: false,
      agentsEnabled: true,
      auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
      telegram: null,
      server: { host: '127.0.0.1', port: 0, watchFolder: path.join(vaultRoot, 'inbox'), maxUploadBytes: 1024 * 1024, authMode: 'local-single-user' },
    }
    const queue = new IngestQueue({ store, vaultRoot, auth: config.auth, runIngest: async () => { throw new Error('no agent') } })
    const runner = new MaintenanceRunner({ vaultRoot, auth: config.auth, events, commitMutex: new Mutex() })
    const library = new LibraryService({
      vaultRoot,
      store: new SqliteLibraryStore(db),
      graph: () => graphOf([node({ path: 'wiki/concepts/A.md', title: 'A' }), node({ path: 'wiki/concepts/B.md', title: 'B', domain: 'computing' })]),
      jobs: () => [],
      runs: () => [],
      fellows: () => [],
      window: () => WINDOW,
      concurrency: () => 2,
    })
    app = await buildServer({ config, store, chat: new ChatStore(db), queue, events, maintenance: runner, logger: false, library })
  })
  afterEach(async () => {
    await app.close()
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('serves the scene, wings and moves', async () => {
    const scene = (await app.inject({ method: 'GET', url: '/api/v1/library/scene' })).json() as { rooms: Array<{ id: string; kind: string; shelves: unknown[] }> }
    expect(scene.rooms.map((r) => r.kind)).toEqual(['main', 'wing'])
    expect(scene.rooms[1]!.shelves).toHaveLength(2)
    const wingId = scene.rooms[1]!.id
    const created = await app.inject({ method: 'POST', url: '/api/v1/wings', payload: { name: 'Arts' } })
    expect(created.statusCode).toBe(201)
    const { wing } = created.json() as { wing: { id: string; name: string } }
    expect(wing.name).toBe('Arts')
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/wings/${wing.id}`, payload: { name: 'Humanities' } })).json()).toMatchObject({ wing: { name: 'Humanities' } })
    expect(((await app.inject({ method: 'PATCH', url: '/api/v1/wings/order', payload: { ids: [wing.id] } })).json() as { wings: Array<{ name: string }> }).wings.map((w) => w.name)).toEqual(['Humanities', 'Wing A'])
    expect(((await app.inject({ method: 'GET', url: '/api/v1/wings' })).json() as { wings: Array<{ name: string }> }).wings[0]!.name).toBe('Humanities')
    const moved = await app.inject({ method: 'POST', url: '/api/v1/library/move', payload: { domain: 'astronomy', room: 'main' } })
    expect(moved.statusCode).toBe(200)
    expect((moved.json() as { placements: Array<{ domain: string; room: string }> }).placements.find((p) => p.domain === 'astronomy')?.room).toBe('main')
    expect((await app.inject({ method: 'POST', url: '/api/v1/library/move', payload: { domain: 'astronomy', room: 'nope' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/wings/${wingId}` })).statusCode).toBe(409)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/wings/${wing.id}` })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/wings/nope' })).statusCode).toBe(404)
  })
})
