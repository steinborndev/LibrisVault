/**
 * The Library's rooms (docs/agents/SPEC.md sections 10.4 and 10.8, docs/tasks/TASKS-A4.md
 * D3 and D4): the user's wings in their order, and where each department's shelf stands.
 * A wing holds twelve shelves, the main room four favorite slots the user fills by hand.
 * Every department without a row is placed by the scene builder (first free slot of the
 * newest wing, a new wing when none is free) and written as `auto`, so a shelf never jumps.
 * Schema v19.
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

export const MAIN_ROOM = 'main'
export const WING_CAPACITY = 12
export const FAVORITE_SLOTS = 4

export interface WingRecord {
  readonly id: string
  readonly name: string
  /** Order in the room sequence after the main room, 0 first. */
  readonly position: number
  /**
   * Where each row's gap stands, as a position index 0 to 6 (schema v28). A row has seven
   * positions and six shelves, so one position is always the way through: the back row's gap
   * is the doorway, the front row's the aisle. 3 is the middle, which is what every wing was
   * fixed at before - three shelves, passage, three.
   */
  readonly wallAisle: number
  readonly midAisle: number
  readonly createdAt: string
}

/** The seven positions a row has, so a gap index can be checked wherever one arrives. */
export const ROW_POSITIONS = 7
export const DEFAULT_AISLE = 3
export const isAisle = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < ROW_POSITIONS

export interface PlacementRecord {
  readonly domain: string
  /** `main` or a wing id. */
  readonly room: string
  readonly slot: number
  readonly placedBy: 'user' | 'auto'
  readonly updatedAt: string
}

export interface LibraryStore {
  /** Wings by position. */
  wings(): WingRecord[]
  createWing(wing: WingRecord): void
  renameWing(id: string, name: string): WingRecord | undefined
  /** Moves one row's gap. Undefined when the wing is unknown; the index is validated by the caller. */
  setAisle(id: string, row: 'wall' | 'mid', at: number): WingRecord | undefined
  /** Positions follow the order of `ids`; wings not named keep their relative order after them. */
  reorderWings(ids: readonly string[]): WingRecord[]
  deleteWing(id: string): boolean
  placements(): PlacementRecord[]
  /** Upsert by domain. */
  place(record: PlacementRecord): void
  unplace(domain: string): boolean
}

/** `Wing A`, `Wing B`, ... by the count of wings so far (the 27th wing is `Wing AA`). */
export function nextWingName(existing: readonly WingRecord[]): string {
  let n = existing.length
  let letters = ''
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return `Wing ${letters}`
}

export function capacityOf(room: string): number {
  return room === MAIN_ROOM ? FAVORITE_SLOTS : WING_CAPACITY
}

/** The first free slot of a room, or -1 when it is full. */
export function freeSlot(room: string, placements: readonly PlacementRecord[]): number {
  const taken = new Set(placements.filter((p) => p.room === room).map((p) => p.slot))
  for (let s = 0; s < capacityOf(room); s++) if (!taken.has(s)) return s
  return -1
}

export interface AutoPlacement {
  readonly placements: PlacementRecord[]
  readonly wings: WingRecord[]
  readonly added: PlacementRecord[]
  readonly newWings: WingRecord[]
}

/**
 * Places every department without a row (D3): the first free slot of the newest wing, a new
 * wing named after its letter when none is free, never the main room. Pure: the caller
 * persists `added` and `newWings`. Domains come in birth order (the registry's order).
 */
export function autoPlace(
  placements: readonly PlacementRecord[],
  wings: readonly WingRecord[],
  domains: readonly string[],
  now: string,
  newId: () => string,
): AutoPlacement {
  const all = [...placements]
  const allWings = [...wings].sort((a, b) => a.position - b.position)
  const added: PlacementRecord[] = []
  const newWings: WingRecord[] = []
  const placed = new Set(all.map((p) => p.domain))
  for (const domain of domains) {
    if (placed.has(domain)) continue
    let wing = allWings[allWings.length - 1]
    let slot = wing ? freeSlot(wing.id, all) : -1
    if (!wing || slot < 0) {
      wing = { id: newId(), name: nextWingName(allWings), position: allWings.length, wallAisle: DEFAULT_AISLE, midAisle: DEFAULT_AISLE, createdAt: now }
      allWings.push(wing)
      newWings.push(wing)
      slot = 0
    }
    const record: PlacementRecord = { domain, room: wing.id, slot, placedBy: 'auto', updatedAt: now }
    all.push(record)
    added.push(record)
    placed.add(domain)
  }
  return { placements: all, wings: allWings, added, newWings }
}

export class MemoryLibraryStore implements LibraryStore {
  private readonly wingRows = new Map<string, WingRecord>()
  private readonly rows = new Map<string, PlacementRecord>()
  wings(): WingRecord[] {
    return [...this.wingRows.values()].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
  }
  createWing(wing: WingRecord): void {
    this.wingRows.set(wing.id, wing)
  }
  renameWing(id: string, name: string): WingRecord | undefined {
    const prev = this.wingRows.get(id)
    if (!prev) return undefined
    const next = { ...prev, name }
    this.wingRows.set(id, next)
    return next
  }
  reorderWings(ids: readonly string[]): WingRecord[] {
    const ordered = [...ids.map((id) => this.wingRows.get(id)).filter((w): w is WingRecord => w !== undefined), ...this.wings().filter((w) => !ids.includes(w.id))]
    ordered.forEach((w, i) => this.wingRows.set(w.id, { ...w, position: i }))
    return this.wings()
  }
  setAisle(id: string, row: 'wall' | 'mid', at: number): WingRecord | undefined {
    const w = this.wingRows.get(id)
    if (w === undefined) return undefined
    const next = row === 'wall' ? { ...w, wallAisle: at } : { ...w, midAisle: at }
    this.wingRows.set(id, next)
    return next
  }
  deleteWing(id: string): boolean {
    return this.wingRows.delete(id)
  }
  placements(): PlacementRecord[] {
    return [...this.rows.values()]
  }
  place(record: PlacementRecord): void {
    this.rows.set(record.domain, record)
  }
  unplace(domain: string): boolean {
    return this.rows.delete(domain)
  }
}

interface WingRow {
  id: string
  name: string
  position: number
  wall_aisle: number
  mid_aisle: number
  created_at: string
}
interface PlacementRow {
  domain: string
  room: string
  slot: number
  placed_by: string
  updated_at: string
}

export class SqliteLibraryStore implements LibraryStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  wings(): WingRecord[] {
    const rows = this.db
      .prepare('SELECT id, name, position, wall_aisle, mid_aisle, created_at FROM wings WHERE user_id = ? ORDER BY position, created_at')
      .all(this.userId) as WingRow[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      position: r.position,
      wallAisle: isAisle(r.wall_aisle) ? r.wall_aisle : DEFAULT_AISLE,
      midAisle: isAisle(r.mid_aisle) ? r.mid_aisle : DEFAULT_AISLE,
      createdAt: r.created_at,
    }))
  }
  createWing(w: WingRecord): void {
    this.db
      .prepare('INSERT INTO wings (id, user_id, name, position, wall_aisle, mid_aisle, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(w.id, this.userId, w.name, w.position, w.wallAisle, w.midAisle, w.createdAt)
  }
  setAisle(id: string, row: 'wall' | 'mid', at: number): WingRecord | undefined {
    const column = row === 'wall' ? 'wall_aisle' : 'mid_aisle'
    const changed = this.db.prepare(`UPDATE wings SET ${column} = ? WHERE id = ? AND user_id = ?`).run(at, id, this.userId).changes
    return changed > 0 ? this.wings().find((w) => w.id === id) : undefined
  }
  renameWing(id: string, name: string): WingRecord | undefined {
    const changed = this.db.prepare('UPDATE wings SET name = ? WHERE id = ? AND user_id = ?').run(name, id, this.userId).changes
    return changed > 0 ? this.wings().find((w) => w.id === id) : undefined
  }
  reorderWings(ids: readonly string[]): WingRecord[] {
    const current = this.wings()
    const ordered = [...ids.map((id) => current.find((w) => w.id === id)).filter((w): w is WingRecord => w !== undefined), ...current.filter((w) => !ids.includes(w.id))]
    const update = this.db.prepare('UPDATE wings SET position = ? WHERE id = ? AND user_id = ?')
    this.db.transaction(() => {
      ordered.forEach((w, i) => update.run(i, w.id, this.userId))
    })()
    return this.wings()
  }
  deleteWing(id: string): boolean {
    return this.db.prepare('DELETE FROM wings WHERE id = ? AND user_id = ?').run(id, this.userId).changes > 0
  }
  placements(): PlacementRecord[] {
    const rows = this.db.prepare('SELECT domain, room, slot, placed_by, updated_at FROM library_layout WHERE user_id = ?').all(this.userId) as PlacementRow[]
    return rows.map((r) => ({ domain: r.domain, room: r.room, slot: r.slot, placedBy: r.placed_by === 'user' ? 'user' : 'auto', updatedAt: r.updated_at }))
  }
  place(p: PlacementRecord): void {
    this.db
      .prepare(
        `INSERT INTO library_layout (domain, user_id, room, slot, placed_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, domain) DO UPDATE SET room = excluded.room, slot = excluded.slot, placed_by = excluded.placed_by, updated_at = excluded.updated_at`,
      )
      .run(p.domain, this.userId, p.room, p.slot, p.placedBy, p.updatedAt)
  }
  unplace(domain: string): boolean {
    return this.db.prepare('DELETE FROM library_layout WHERE domain = ? AND user_id = ?').run(domain, this.userId).changes > 0
  }
}
