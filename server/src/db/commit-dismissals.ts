/**
 * Commits the user took off the Activity stream (schema v25). The stream's commit rows are
 * read out of `git log` on every request, so removing one has to be remembered somewhere
 * the vault is not: here, by short hash. Same interface as the domain dismissals, so a
 * test can stand a memory store in.
 */

import type { Db } from './index.js'
import type { Dismissal, DismissalStore } from './domain-dismissals.js'

const DEFAULT_USER = 'local'

export class CommitDismissalStore implements DismissalStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  /** The hashes currently off the stream - what the stats route filters against. */
  keys(): Set<string> {
    const rows = this.db.prepare('SELECT hash FROM commit_dismissals WHERE user_id = ?').all(this.userId) as Array<{ hash: string }>
    return new Set(rows.map((r) => r.hash))
  }

  list(): Dismissal[] {
    const rows = this.db
      .prepare('SELECT hash, dismissed_at FROM commit_dismissals WHERE user_id = ? ORDER BY dismissed_at DESC')
      .all(this.userId) as Array<{ hash: string; dismissed_at: string }>
    return rows.map((r) => ({ key: r.hash, dismissedAt: r.dismissed_at }))
  }

  /** Idempotent: a hash taken off twice keeps its first timestamp. */
  dismiss(key: string): void {
    this.db
      .prepare('INSERT INTO commit_dismissals (user_id, hash, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(user_id, hash) DO NOTHING')
      .run(this.userId, key, new Date().toISOString())
  }

  restore(key: string): void {
    this.db.prepare('DELETE FROM commit_dismissals WHERE user_id = ? AND hash = ?').run(this.userId, key)
  }
}
