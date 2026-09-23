/**
 * Applied domain splits and the per-shelf "leave" / "defer" memory (schema v37,
 * docs/tasks/TASKS-DOMAIN-SPLIT.md 5.6 and 6.3).
 *
 * Operational state only (SPEC.md §8). A split record is a convenience over what git already
 * holds: which addresses were approved for which child (so the remainder can be found again),
 * and which commits the split made (so its revert can take them back newest first). Losing it
 * loses those two buttons and nothing of the vault.
 *
 * An interface plus a memory implementation, like `DismissalStore`, so the routes can be built
 * without a database in tests.
 */

import { randomUUID } from 'node:crypto'
import type { Db } from './index.js'

const DEFAULT_USER = 'local'

export interface SplitChildRecord {
  readonly key: string
  /** Every address the user approved for this child, written or skipped. */
  readonly addresses: readonly string[]
}

export interface SplitRecord {
  readonly id: string
  readonly parent: string
  readonly children: readonly SplitChildRecord[]
  /** The split's own commits, oldest first: the split, then each remainder re-file. */
  readonly commits: readonly string[]
  readonly createdAt: string
  readonly revertedAt: string | null
}

export type ShelfDecision = 'leave' | 'defer'

export interface ShelfDecisionRecord {
  readonly fingerprint: string
  readonly decision: ShelfDecision
  readonly decidedAt: string
}

export interface DomainSplitStore {
  create(parent: string, children: readonly SplitChildRecord[], commit: string): SplitRecord
  get(id: string): SplitRecord | undefined
  /** Newest first. */
  list(): SplitRecord[]
  addCommit(id: string, commit: string): void
  markReverted(id: string): void
  decisions(parent: string): ShelfDecisionRecord[]
  decide(parent: string, fingerprint: string, decision: ShelfDecision): void
  restore(parent: string, fingerprint: string): void
}

const now = (): string => new Date().toISOString()

export class MemoryDomainSplitStore implements DomainSplitStore {
  private readonly splits = new Map<string, SplitRecord>()
  private readonly memory = new Map<string, Map<string, ShelfDecisionRecord>>()

  create(parent: string, children: readonly SplitChildRecord[], commit: string): SplitRecord {
    const rec: SplitRecord = { id: randomUUID(), parent, children, commits: [commit], createdAt: now(), revertedAt: null }
    this.splits.set(rec.id, rec)
    return rec
  }
  get(id: string): SplitRecord | undefined {
    return this.splits.get(id)
  }
  list(): SplitRecord[] {
    return [...this.splits.values()].reverse()
  }
  addCommit(id: string, commit: string): void {
    const rec = this.splits.get(id)
    if (rec) this.splits.set(id, { ...rec, commits: [...rec.commits, commit] })
  }
  markReverted(id: string): void {
    const rec = this.splits.get(id)
    if (rec) this.splits.set(id, { ...rec, revertedAt: now() })
  }
  decisions(parent: string): ShelfDecisionRecord[] {
    return [...(this.memory.get(parent)?.values() ?? [])]
  }
  decide(parent: string, fingerprint: string, decision: ShelfDecision): void {
    let m = this.memory.get(parent)
    if (m === undefined) this.memory.set(parent, (m = new Map()))
    m.set(fingerprint, { fingerprint, decision, decidedAt: now() })
  }
  restore(parent: string, fingerprint: string): void {
    this.memory.get(parent)?.delete(fingerprint)
  }
}

interface SplitRow {
  id: string
  parent: string
  children: string
  commits: string
  created_at: string
  reverted_at: string | null
}

const fromRow = (r: SplitRow): SplitRecord => ({
  id: r.id,
  parent: r.parent,
  children: JSON.parse(r.children) as SplitChildRecord[],
  commits: JSON.parse(r.commits) as string[],
  createdAt: r.created_at,
  revertedAt: r.reverted_at,
})

export class SqliteDomainSplitStore implements DomainSplitStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  create(parent: string, children: readonly SplitChildRecord[], commit: string): SplitRecord {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO domain_splits (id, user_id, parent, children, commits, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, this.userId, parent, JSON.stringify(children), JSON.stringify([commit]), now())
    return this.get(id)!
  }

  get(id: string): SplitRecord | undefined {
    const row = this.db.prepare('SELECT * FROM domain_splits WHERE id = ? AND user_id = ?').get(id, this.userId) as SplitRow | undefined
    return row === undefined ? undefined : fromRow(row)
  }

  list(): SplitRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM domain_splits WHERE user_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(this.userId) as SplitRow[]
    return rows.map(fromRow)
  }

  addCommit(id: string, commit: string): void {
    const rec = this.get(id)
    if (rec === undefined) return
    this.db.prepare('UPDATE domain_splits SET commits = ? WHERE id = ?').run(JSON.stringify([...rec.commits, commit]), id)
  }

  markReverted(id: string): void {
    this.db.prepare('UPDATE domain_splits SET reverted_at = ? WHERE id = ? AND user_id = ?').run(now(), id, this.userId)
  }

  decisions(parent: string): ShelfDecisionRecord[] {
    const rows = this.db
      .prepare('SELECT fingerprint, decision, decided_at FROM domain_split_decisions WHERE user_id = ? AND parent = ? ORDER BY decided_at DESC')
      .all(this.userId, parent) as Array<{ fingerprint: string; decision: ShelfDecision; decided_at: string }>
    return rows.map((r) => ({ fingerprint: r.fingerprint, decision: r.decision, decidedAt: r.decided_at }))
  }

  /** A second decision on the same shelf replaces the first: leave after defer means leave. */
  decide(parent: string, fingerprint: string, decision: ShelfDecision): void {
    this.db
      .prepare(
        `INSERT INTO domain_split_decisions (user_id, parent, fingerprint, decision, decided_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, parent, fingerprint) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`,
      )
      .run(this.userId, parent, fingerprint, decision, now())
  }

  restore(parent: string, fingerprint: string): void {
    this.db
      .prepare('DELETE FROM domain_split_decisions WHERE user_id = ? AND parent = ? AND fingerprint = ?')
      .run(this.userId, parent, fingerprint)
  }
}
