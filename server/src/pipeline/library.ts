/**
 * The Library scene (docs/agents/SPEC.md section 10, docs/tasks/TASKS-A4.md D2 to D4): what
 * only the server knows, in one snapshot for the dashboard's renderer. Rooms with their
 * placed shelves and department counts (knowledge pages are books, sources thin volumes,
 * meta invisible, OPEN-14), the Fellows with their current run and next proposal, the runs
 * and jobs in flight, and whether it is night. Poses, exits and animation are the
 * browser's; nothing here is stored except the layout the user or the auto placement chose.
 */

import { randomUUID } from 'node:crypto'
import {
  autoPlace,
  capacityOf,
  freeSlot,
  nextWingName,
  MAIN_ROOM,
  type LibraryStore,
  type PlacementRecord,
  type WingRecord,
} from '../db/library.js'
import type { VaultGraph } from './graph.js'
import type { JobRow, JobHold } from '../db/jobs.js'
import type { MaintenanceRun } from './maintenance.js'
import type { FellowSummary } from './fellows.js'
import { MODEL_IDS } from '../db/agents.js'
import { typicalRunMs, type DurationSample, typicalJobMs, type JobDurationSample } from './run-duration.js'
import { readDomainRegistry } from './domains.js'
import { windowAt, type NightWindow } from './clock.js'
import { STUB_BYTES } from './candidates.js'

export interface SceneShelf {
  readonly slot: number
  readonly domain: string
  readonly books: number
  readonly volumes: number
  readonly stubs: number
  readonly placedBy: 'user' | 'auto'
}

export interface SceneRoom {
  readonly id: string
  readonly name: string
  readonly kind: 'main' | 'wing'
  readonly position: number
  readonly capacity: number
  readonly shelves: readonly SceneShelf[]
}

export interface SceneDepartment {
  readonly domain: string
  readonly books: number
  readonly volumes: number
  readonly stubs: number
  readonly room: string | null
  readonly slot: number | null
}

export interface SceneFellow {
  readonly agentId: string
  readonly name: string
  readonly homeDomain: string
  readonly model: string
  readonly state: string
  readonly sleepCode: string | null
  readonly sleepReason: string | null
  readonly skipUntil: string | null
  readonly run: { readonly id: string; readonly kind: string; readonly channel: string; readonly label: string | null; readonly startedAt: string; readonly waiting: boolean; readonly typicalMs: number | null } | null
  readonly next: { readonly topic: string; readonly kind: string; readonly estCostUsd: number | null; readonly status: string } | null
  readonly lastActive: string | null
}

export interface SceneRun {
  readonly id: string
  readonly kind: string
  readonly channel: string
  readonly label: string | null
  readonly startedAt: string
  /** Queued behind the runner rather than executing: the figure waits instead of working. */
  readonly waiting: boolean
  /**
   * How long a run of this kind usually takes (run-duration.ts), or null when nothing says.
   * The scene draws a coarse progress figure from it and the run's own elapsed time.
   */
  readonly typicalMs: number | null
}

export interface SceneJob {
  readonly id: string
  readonly status: string
  readonly name: string
  readonly source: string
  readonly batchId: string | null
  /** `night` while the job waits for the shift (chunk 6); null for an ordinary job. */
  readonly hold: JobHold | null
  /** How long an ingest of its type usually takes, for the queue's blocks; null when nothing says. */
  readonly typicalMs: number | null
  readonly type: string
  readonly createdAt: string
}

export interface LibraryScene {
  readonly generatedAt: string
  readonly night: boolean
  readonly window: NightWindow
  readonly rooms: readonly SceneRoom[]
  readonly departments: readonly SceneDepartment[]
  /** Knowledge pages without a department (the intake cart). */
  readonly unfiled: number
  readonly gaps: number
  readonly fellows: readonly SceneFellow[]
  readonly runs: readonly SceneRun[]
  readonly jobs: readonly SceneJob[]
  readonly concurrency: number
}

export interface LibraryServiceOptions {
  readonly vaultRoot: string
  readonly store: LibraryStore
  readonly graph: () => VaultGraph | null
  readonly jobs: () => readonly JobRow[]
  readonly runs: () => readonly MaintenanceRun[]
  readonly fellows: () => readonly FellowSummary[]
  /**
   * Settled runs of one kind, newest first, for the typical-duration median. Optional:
   * without it every run falls back to the reference sizes, which is exactly what a fresh
   * vault does anyway.
   */
  readonly runHistory?: (kind: string) => readonly DurationSample[]
  /** Finished jobs, newest first, for the per-type ingest median; optional like `runHistory`. */
  readonly jobHistory?: () => readonly JobDurationSample[]
  readonly window: () => NightWindow
  readonly concurrency: () => number
  readonly now?: () => Date
}

export interface MoveResult {
  readonly ok?: true
  readonly placements?: PlacementRecord[]
  readonly error?: string
  readonly status?: 400 | 404 | 409
}

const isDepartmentDomain = (d: string | null): d is string => d !== null && d !== 'meta' && d !== 'unassigned' && d.trim() !== ''

/** Night look during the night window and from 21:00 to 06:00 local (D6). */
export function isNight(now: Date, window: NightWindow): boolean {
  if (windowAt(now, window).current !== null) return true
  const h = now.getHours()
  return h >= 21 || h < 6
}

export class LibraryService {
  private readonly o: LibraryServiceOptions
  private readonly now: () => Date

  constructor(opts: LibraryServiceOptions) {
    this.o = opts
    this.now = opts.now ?? ((): Date => new Date())
  }

  /** Department counts from the graph, in registry order first, then the rest alphabetically. */
  private departments(graph: VaultGraph | null): Map<string, { books: number; volumes: number; stubs: number }> {
    const counts = new Map<string, { books: number; volumes: number; stubs: number }>()
    const registry = readDomainRegistry(this.o.vaultRoot)
    for (const d of registry?.domains ?? []) if (isDepartmentDomain(d.key)) counts.set(d.key, { books: 0, volumes: 0, stubs: 0 })
    if (graph) {
      for (const n of graph.nodes) {
        if (n.kind !== 'knowledge' || !isDepartmentDomain(n.domain)) continue
        const c = counts.get(n.domain) ?? { books: 0, volumes: 0, stubs: 0 }
        if (n.type === 'sources') c.volumes++
        else c.books++
        if ((n.size ?? Infinity) < STUB_BYTES) c.stubs++
        counts.set(n.domain, c)
      }
    }
    return counts
  }

  /** The live graph, or null when it cannot be built (the scene then draws empty shelves). */
  private readGraph(): VaultGraph | null {
    try {
      return this.o.graph()
    } catch {
      return null
    }
  }

  /** The snapshot. Places departments without a row (D3) and persists what it placed. */
  scene(): LibraryScene {
    const now = this.now()
    const nowIso = now.toISOString()
    const graph = this.readGraph()
    const counts = this.departments(graph)
    const domains = [...counts.keys()]
    const placed = autoPlace(this.o.store.placements(), this.o.store.wings(), domains, nowIso, () => randomUUID())
    for (const w of placed.newWings) this.o.store.createWing(w)
    for (const p of placed.added) this.o.store.place(p)
    const byDomain = new Map(placed.placements.map((p) => [p.domain, p]))
    const shelfOf = (p: PlacementRecord): SceneShelf => {
      const c = counts.get(p.domain) ?? { books: 0, volumes: 0, stubs: 0 }
      return { slot: p.slot, domain: p.domain, books: c.books, volumes: c.volumes, stubs: c.stubs, placedBy: p.placedBy }
    }
    const shelvesIn = (room: string): SceneShelf[] =>
      placed.placements
        .filter((p) => p.room === room && counts.has(p.domain))
        .sort((a, b) => a.slot - b.slot)
        .map(shelfOf)
    const rooms: SceneRoom[] = [
      { id: MAIN_ROOM, name: 'Main room', kind: 'main', position: -1, capacity: capacityOf(MAIN_ROOM), shelves: shelvesIn(MAIN_ROOM) },
      ...placed.wings.map((w): SceneRoom => ({ id: w.id, name: w.name, kind: 'wing', position: w.position, capacity: capacityOf(w.id), shelves: shelvesIn(w.id) })),
    ]
    const departments: SceneDepartment[] = domains.map((domain) => {
      const c = counts.get(domain)!
      const p = byDomain.get(domain)
      return { domain, books: c.books, volumes: c.volumes, stubs: c.stubs, room: p?.room ?? null, slot: p?.slot ?? null }
    })
    let unfiled = 0
    if (graph) for (const n of graph.nodes) if (n.kind === 'knowledge' && !isDepartmentDomain(n.domain)) unfiled++
    /*
     * One median per kind per snapshot, not per run: two Fellows of the same kind at work
     * would otherwise read the same history twice on every poll.
     */
    const typicalCache = new Map<string, number | null>()
    const typical = (kind: string, model: string | null): number | null => {
      const key = `${kind}\u0000${model ?? ''}`
      const hit = typicalCache.get(key)
      if (hit !== undefined) return hit
      const value = typicalRunMs(this.o.runHistory?.(kind) ?? [], kind, model)
      typicalCache.set(key, value)
      return value
    }
    const runs = this.o
      .runs()
      .filter((r) => r.status === 'running')
      .map((r): SceneRun => ({ id: r.id, kind: r.kind, channel: r.channel, label: r.label ?? null, startedAt: r.startedAt, waiting: r.waiting === true, typicalMs: typical(r.kind, r.model ?? null) }))
    const fellows = this.o.fellows().map((s): SceneFellow => ({
      agentId: s.agent.id,
      name: s.agent.name,
      homeDomain: s.agent.homeDomain,
      model: s.agent.model,
      state: s.agent.state,
      sleepCode: s.agent.sleepCode,
      sleepReason: s.agent.sleepReason,
      skipUntil: s.agent.skipUntil,
      run: s.currentRun
        ? {
            id: s.currentRun.id,
            kind: s.currentRun.kind,
            channel: s.currentRun.channel,
            label: s.currentRun.label ?? null,
            startedAt: s.currentRun.startedAt,
            waiting: s.currentRun.waiting === true,
            // The run's own pin is the SDK id; the Fellow's `model` is the short name of
            // the closed set, so it has to be mapped before it can match a history row.
            typicalMs: typical(s.currentRun.kind, s.currentRun.model ?? MODEL_IDS[s.agent.model] ?? null),
          }
        : null,
      next: s.next ? { topic: s.next.topic, kind: s.next.kind, estCostUsd: s.next.estCostUsd, status: s.next.status } : null,
      lastActive: s.lastRun?.finishedAt ?? null,
    }))
    const attributed = new Set(fellows.map((f) => f.run?.id).filter((x): x is string => x !== undefined && x !== null))
    const jobHistory = this.o.jobHistory?.() ?? []
    const jobs = this.o
      .jobs()
      .filter((j) => j.status === 'queued' || j.status === 'preprocessing' || j.status === 'ingesting')
      .map(
        (j): SceneJob => ({
          id: j.id,
          status: j.status,
          name: j.original_name ?? j.url ?? j.id.slice(-6),
          source: j.source,
          batchId: j.batch_id,
          hold: j.hold ?? null,
          typicalMs: typicalJobMs(jobHistory, j.type),
          type: j.type,
          createdAt: j.created_at,
        }),
      )
    const window = this.o.window()
    return {
      generatedAt: nowIso,
      night: isNight(now, window),
      window,
      rooms,
      departments,
      unfiled,
      gaps: graph?.gaps.length ?? 0,
      fellows,
      runs: runs.filter((r) => !attributed.has(r.id)),
      jobs,
      concurrency: this.o.concurrency(),
    }
  }

  wings(): WingRecord[] {
    return this.o.store.wings()
  }

  createWing(name?: string): WingRecord {
    const wings = this.o.store.wings()
    const wing: WingRecord = { id: randomUUID(), name: name?.trim() || nextWingName(wings), position: wings.length, createdAt: this.now().toISOString() }
    this.o.store.createWing(wing)
    return wing
  }

  renameWing(id: string, name: string): WingRecord | undefined {
    return this.o.store.renameWing(id, name.trim())
  }

  reorderWings(ids: readonly string[]): WingRecord[] {
    return this.o.store.reorderWings(ids)
  }

  /** Deletes a wing when no shelf stands in it (section 12). */
  deleteWing(id: string): { ok: true } | { error: string; status: 404 | 409 } {
    const wing = this.o.store.wings().find((w) => w.id === id)
    if (!wing) return { error: 'no such wing', status: 404 }
    if (this.o.store.placements().some((p) => p.room === id)) return { error: 'the wing still holds shelves; move them first', status: 409 }
    this.o.store.deleteWing(id)
    // Close the gap in the sequence.
    this.o.store.reorderWings(this.o.store.wings().map((w) => w.id))
    return { ok: true }
  }

  /**
   * Moves a department's shelf (D4): to a room's first free slot, or with a `slot` into that
   * slot, swapping with the shelf standing there. Every move is the user's.
   */
  move(domain: string, room: string, slot?: number): MoveResult {
    const now = this.now().toISOString()
    const wings = this.o.store.wings()
    if (room !== MAIN_ROOM && !wings.some((w) => w.id === room)) return { error: 'no such room', status: 404 }
    const placements = this.o.store.placements()
    const current = placements.find((p) => p.domain === domain)
    if (slot !== undefined) {
      if (slot < 0 || slot >= capacityOf(room)) return { error: `slot ${slot} is outside the room`, status: 400 }
      const occupant = placements.find((p) => p.room === room && p.slot === slot && p.domain !== domain)
      if (occupant) {
        // Swap: the occupant takes the moving shelf's old place, or the room's next free slot.
        if (current) this.o.store.place({ ...occupant, room: current.room, slot: current.slot, placedBy: 'user', updatedAt: now })
        else {
          const free = freeSlot(room, placements.filter((p) => p.domain !== occupant.domain))
          if (free < 0) return { error: 'the room is full', status: 409 }
          this.o.store.place({ ...occupant, slot: free, placedBy: 'user', updatedAt: now })
        }
      }
      this.o.store.place({ domain, room, slot, placedBy: 'user', updatedAt: now })
      return { ok: true, placements: this.o.store.placements() }
    }
    const free = freeSlot(room, placements.filter((p) => p.domain !== domain))
    if (free < 0) return { error: room === MAIN_ROOM ? 'every favorite slot is taken' : 'the wing is full', status: 409 }
    this.o.store.place({ domain, room, slot: free, placedBy: 'user', updatedAt: now })
    return { ok: true, placements: this.o.store.placements() }
  }
}
