/**
 * The order the night walks the shelves (docs/tasks/TASKS-A7.md 3.5).
 *
 * The night is one serial queue, so it has an order whether or not anyone chose it. Before
 * this it was whatever `priority` and age happened to produce, which is a per-FELLOW ordering
 * standing in for a per-shelf one: two Fellows of one domain could end up either side of a
 * third domain's, and the schedule then showed a shelf in two pieces.
 *
 * So the domain gets the primary key and `agents.priority` keeps its meaning INSIDE a shelf.
 * The two live at different levels and cannot contradict each other, which is the whole reason
 * for storing this separately rather than rewriting priorities when a shelf moves. `targetFor`,
 * the handoff router, already reads priority only among the Fellows of one domain, so nothing
 * there changes.
 *
 * A domain with no row sorts after every domain that has one, in registry order: an order
 * nobody has set is not a statement that a shelf comes last, only that nothing was said.
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

export interface ShelfOrderStore {
  /** Domain keys in the order the night should walk them; only the ones that were set. */
  list(): string[]
  /** Replaces the whole order. An empty list clears it and the fallback takes over again. */
  put(domains: readonly string[]): void
}

export class MemoryShelfOrderStore implements ShelfOrderStore {
  private order: string[] = []
  list(): string[] {
    return [...this.order]
  }
  put(domains: readonly string[]): void {
    this.order = [...domains]
  }
}

export class SqliteShelfOrderStore implements ShelfOrderStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  list(): string[] {
    return (
      this.db
        .prepare('SELECT domain FROM shelf_order WHERE user_id = ? ORDER BY rank ASC, domain ASC')
        .all(this.userId) as Array<{ domain: string }>
    ).map((r) => r.domain)
  }

  put(domains: readonly string[]): void {
    const now = new Date().toISOString()
    const wipe = this.db.prepare('DELETE FROM shelf_order WHERE user_id = ?')
    const add = this.db.prepare('INSERT INTO shelf_order (user_id, domain, rank, updated_at) VALUES (?, ?, ?, ?)')
    // One transaction: a half-written order is an order nobody chose.
    this.db.transaction(() => {
      wipe.run(this.userId)
      domains.forEach((d, i) => add.run(this.userId, d, i, now))
    })()
  }
}

/**
 * Sorts Fellows into the night's order: their shelf's rank first, then their own priority
 * inside it, then age. `rank` for a shelf nobody placed is +Infinity, which puts it after
 * every placed one while keeping the placed ones in the order that was chosen.
 */
export function byShelfThenPriority<T extends { readonly homeDomain: string; readonly priority: number; readonly createdAt: string }>(
  agents: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((d, i) => [d, i]))
  const of = (a: T): number => rank.get(a.homeDomain) ?? Number.POSITIVE_INFINITY
  return [...agents].sort(
    (a, b) => of(a) - of(b) || b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
  )
}
