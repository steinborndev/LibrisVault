import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore, JobStateError, ALLOWED_TRANSITIONS } from '../src/db/jobs.js'
import { EventBus } from '../src/pipeline/events.js'

let db: Db
let store: JobStore

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
})

const pdf = { source: 'drop', type: 'pdf', originalName: 'a.pdf' } as const

describe('create', () => {
  it('creates a queued job with an id and a creation log line', () => {
    const { job, duplicateOf } = store.create({ ...pdf, sha256: 'h1' })
    expect(job.status).toBe('queued')
    expect(job.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/) // ulid
    expect(job.user_id).toBe('local')
    expect(duplicateOf).toBeUndefined()
    expect(store.logs(job.id)[0]?.message).toMatch(/job created from drop/)
  })

  it('marks a second job with the same sha256 as duplicate and keeps it visible', () => {
    const first = store.create({ ...pdf, sha256: 'same' })
    const second = store.create({ source: 'watch', type: 'pdf', sha256: 'same' })
    expect(second.job.status).toBe('duplicate')
    expect(second.duplicateOf).toBe(first.job.id)
    expect(second.job.sha256).toBeNull() // original owns the UNIQUE hash
    expect(second.job.finished_at).not.toBeNull()
    expect(store.listByStatus('duplicate')).toHaveLength(1)
    expect(store.logs(second.job.id)[0]?.message).toMatch(/duplicate of/)
  })

  it('records a duplicate the caller recognised by a source page, with or without a job to point at', () => {
    const note = 'already in the vault as wiki/sources/P.md (same URL https://example.org/p, ingested by job JOBOLD)'
    const attributed = store.create({ source: 'telegram', type: 'web', url: 'https://example.org/p?s=1', duplicateOf: 'JOBOLD', duplicateNote: note })
    expect(attributed.job.status).toBe('duplicate')
    expect(attributed.duplicateOf).toBe('JOBOLD')
    expect(attributed.job.duplicate_of).toBe('JOBOLD')
    expect(attributed.job.error).toBe(note)
    expect(store.logs(attributed.job.id)[0]?.message).toMatch(/^duplicate of job JOBOLD \(already in the vault/)

    const unattributed = store.create({ source: 'telegram', type: 'web', url: 'https://example.org/p', duplicateNote: note })
    expect(unattributed.job.status).toBe('duplicate')
    expect(unattributed.duplicateOf).toBeUndefined()
    expect(unattributed.job.duplicate_of).toBeNull()
    expect(unattributed.job.finished_at).not.toBeNull()
    expect(unattributed.job.error).toBe(note)
    expect(store.logs(unattributed.job.id)[0]?.message).toMatch(/^duplicate \(already in the vault/)
  })

  it('does not dedupe URL jobs (no sha256)', () => {
    const a = store.create({ source: 'url', type: 'web', url: 'https://x' })
    const b = store.create({ source: 'url', type: 'web', url: 'https://x' })
    expect(a.job.status).toBe('queued')
    expect(b.job.status).toBe('queued')
  })
})

describe('finished_at stamping (F2 regression)', () => {
  // The Overview's "Fehler (7 T.)" KPI read 0 forever because failed/deferred never got a
  // finished_at, so countsSince (which filters on it) silently skipped them.
  const run = (sha: string, to: 'done' | 'failed' | 'deferred'): string => {
    const { job } = store.create({ ...pdf, sha256: sha })
    store.transition(job.id, 'preprocessing')
    if (to === 'deferred') {
      store.transition(job.id, 'deferred')
      return job.id
    }
    store.transition(job.id, 'ingesting')
    store.transition(job.id, to)
    return job.id
  }

  it('stamps finished_at for failed and deferred, not just terminal states', () => {
    for (const status of ['done', 'failed', 'deferred'] as const) {
      const id = run(`sha-${status}`, status)
      expect(store.getOrThrow(id).finished_at, `${status} should be stamped`).not.toBeNull()
    }
  })

  it('counts failures and deferrals in the 7-day KPIs', () => {
    run('a', 'done')
    run('b', 'failed')
    run('c', 'deferred')
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const counts = store.countsSince(since)
    expect(counts['done']).toBe(1)
    expect(counts['failed']).toBe(1) // was 0 before the fix
    expect(counts['deferred']).toBe(1) // was 0 before the fix
  })

  it('clears finished_at again on retry, so a re-queued job is not counted as finished', () => {
    const id = run('r', 'failed')
    expect(store.getOrThrow(id).finished_at).not.toBeNull()
    store.transition(id, 'queued', { log: 'retry' })
    expect(store.getOrThrow(id).finished_at).toBeNull()
  })

  it('keeps failed/deferred re-queueable — they are finished, not terminal', () => {
    expect(ALLOWED_TRANSITIONS.failed).toContain('queued')
    expect(ALLOWED_TRANSITIONS.deferred).toContain('queued')
    expect(ALLOWED_TRANSITIONS.done).toEqual([])
  })

  it('groups done/failed per UTC day for the KPI sparklines (dailyFinished)', () => {
    run('d1', 'done')
    run('d2', 'done')
    run('d3', 'failed')
    run('d4', 'deferred') // not done/failed — must not appear
    const days = store.dailyFinished(14)
    expect(days).toHaveLength(1) // everything finished just now → one (today) bucket
    const today = days[0]!
    expect(today.date).toBe(new Date().toISOString().slice(0, 10))
    expect(today.done).toBe(2)
    expect(today.failed).toBe(1)
  })
})

describe('recoverInterrupted', () => {
  it('fails jobs stranded mid-flight and leaves queued/terminal ones alone', () => {
    const queued = store.create({ ...pdf, sha256: 'q' }).job
    const pre = store.create({ ...pdf, sha256: 'p' }).job
    store.transition(pre.id, 'preprocessing')
    const ing = store.create({ ...pdf, sha256: 'i' }).job
    store.transition(ing.id, 'preprocessing')
    store.transition(ing.id, 'ingesting')
    const done = store.create({ ...pdf, sha256: 'd' }).job
    store.transition(done.id, 'preprocessing')
    store.transition(done.id, 'ingesting')
    store.transition(done.id, 'done')

    const recovered = store.recoverInterrupted()

    expect(recovered.sort()).toEqual([pre.id, ing.id].sort())
    expect(store.getOrThrow(pre.id).status).toBe('failed')
    expect(store.getOrThrow(ing.id).status).toBe('failed')
    expect(store.getOrThrow(ing.id).error).toMatch(/interrupted by a service restart/)
    // Recovered jobs are retryable (failed → queued is allowed).
    expect(ALLOWED_TRANSITIONS.failed).toContain('queued')
    // Untouched:
    expect(store.getOrThrow(queued.id).status).toBe('queued')
    expect(store.getOrThrow(done.id).status).toBe('done')
    // Idempotent: a second pass finds nothing active.
    expect(store.recoverInterrupted()).toEqual([])
  })
})

describe('what a finished job fills in afterwards', () => {
  /*
   * The reported case: an ingest that had just settled showed no pages and no Article tab in
   * the dashboard. Everything a finished ingest is worth looking at arrives AFTER the status
   * does - the pages come from the commit, which happens next - and the dashboard refetches
   * the list when a job event says so. Silent writes meant it kept the version it had fetched
   * the moment the status changed.
   */
  const settled = (): { store: JobStore; seen: Array<{ id: string; pages: string | null }> } => {
    const seen: Array<{ id: string; pages: string | null }> = []
    const bus = new EventBus()
    bus.subscribe((e) => {
      if (e.kind === 'job') seen.push({ id: e.job.id, pages: e.job.created_pages })
    })
    const withBus = new JobStore(db, bus)
    return { store: withBus, seen }
  }

  it('announces the pages the commit recorded', () => {
    const { store: s, seen } = settled()
    const { job } = s.create(pdf)
    s.transition(job.id, 'preprocessing')
    s.transition(job.id, 'ingesting')
    s.transition(job.id, 'done')
    const afterStatus = seen.length
    expect(seen[afterStatus - 1]).toMatchObject({ id: job.id, pages: null })

    s.setCreatedPages(job.id, ['wiki/concepts/A.md', 'wiki/sources/B.md'])
    expect(seen).toHaveLength(afterStatus + 1)
    expect(JSON.parse(seen[seen.length - 1]!.pages!)).toEqual(['wiki/concepts/A.md', 'wiki/sources/B.md'])
  })

  it('announces the other three late fills too', () => {
    const { store: s, seen } = settled()
    const { job } = s.create(pdf)
    s.transition(job.id, 'preprocessing')
    s.transition(job.id, 'ingesting')
    s.transition(job.id, 'done')
    const before = seen.length
    s.setCommitHash(job.id, 'abc1234')
    s.setValidation(job.id, { quotes: { checked: 3, unverified: 0 } })
    s.setOutcome(job.id, 'no-changes')
    expect(seen).toHaveLength(before + 3)
  })

  it('says nothing about a job that is not there', () => {
    const { store: s, seen } = settled()
    const before = seen.length
    s.setCreatedPages('nope', ['wiki/x.md'])
    expect(seen).toHaveLength(before)
  })
})

describe('transition', () => {
  it('walks the happy path and stamps timestamps', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    expect(job.started_at).toBeNull()

    const pre = store.transition(job.id, 'preprocessing')
    expect(pre.started_at).not.toBeNull()

    const ing = store.transition(job.id, 'ingesting')
    expect(ing.started_at).toBe(pre.started_at) // not re-stamped

    const done = store.transition(job.id, 'done', { patch: { createdPages: ['Wiki/Foo.md'] } })
    expect(done.status).toBe('done')
    expect(done.finished_at).not.toBeNull()
    expect(JSON.parse(done.created_pages!)).toEqual(['Wiki/Foo.md'])
  })

  it('rejects an illegal transition', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    expect(() => store.transition(job.id, 'done')).toThrow(JobStateError)
  })

  it('rejects any transition out of a terminal state', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    store.transition(job.id, 'cancelled')
    expect(() => store.transition(job.id, 'queued')).toThrow(/terminal/)
  })

  it('records usage and error on failure', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    store.transition(job.id, 'preprocessing')
    store.transition(job.id, 'ingesting')
    const failed = store.transition(job.id, 'failed', {
      patch: { error: 'boom', tokensIn: 100, tokensOut: 5, costUsd: 0.01 },
    })
    expect(failed.error).toBe('boom')
    expect(failed.tokens_in).toBe(100)
    expect(store.logs(job.id).some((l) => l.level === 'error')).toBe(true)
  })

  it('clears the stale error when a failed job is retried', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    store.transition(job.id, 'preprocessing')
    store.transition(job.id, 'ingesting')
    store.transition(job.id, 'failed', { patch: { error: 'transient' } })
    const requeued = store.transition(job.id, 'queued')
    expect(requeued.error).toBeNull()
    expect(requeued.finished_at).toBeNull()
  })
})

describe('claimNextQueued', () => {
  it('claims the oldest queued job and moves it to preprocessing', () => {
    const a = store.create({ ...pdf, sha256: 'a' })
    store.create({ ...pdf, sha256: 'b' })
    const claimed = store.claimNextQueued()
    expect(claimed?.id).toBe(a.job.id)
    expect(claimed?.status).toBe('preprocessing')
    expect(store.listByStatus('queued')).toHaveLength(1)
  })

  it('never returns the same job twice (no double-claim)', () => {
    store.create({ ...pdf, sha256: 'a' })
    const first = store.claimNextQueued()
    const second = store.claimNextQueued()
    expect(first).toBeDefined()
    expect(second).toBeUndefined()
  })

  it('returns undefined on an empty queue', () => {
    expect(store.claimNextQueued()).toBeUndefined()
  })

  it('claims in the order the jobs were queued, even when the clock stepped back between them', () => {
    // The wall clock can step back under load, which gives the later drop the earlier stamp.
    // The queue follows insertion, not the stamp (2026-09-25).
    const a = store.create({ ...pdf, sha256: 'a' })
    const b = store.create({ ...pdf, sha256: 'b' })
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run('2030-01-01T00:00:00.000Z', a.job.id)
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', b.job.id)
    expect(store.claimNextQueued()?.id).toBe(a.job.id)
    expect(store.claimNextQueued()?.id).toBe(b.job.id)
  })
})

describe('incrementAttempts', () => {
  it('counts up', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    expect(store.incrementAttempts(job.id)).toBe(1)
    expect(store.incrementAttempts(job.id)).toBe(2)
  })
})

describe('ALLOWED_TRANSITIONS', () => {
  it('lists duplicate as a target of preprocessing only (the post-preprocess DOI check)', () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      if (from === 'preprocessing') expect(targets).toContain('duplicate')
      else expect(targets).not.toContain('duplicate')
    }
  })
})

describe('a job held for the night shift (schema v24)', () => {
  it('is queued but not claimable until it is released, and does not keep the queue awake', () => {
    const { job } = store.create({ source: 'drop', type: 'web', url: 'https://example.org/tonight', hold: 'night' })
    expect(job.status).toBe('queued')
    expect(job.hold).toBe('night')
    expect(store.claimNextQueued()).toBeUndefined()
    expect(store.queuedReady()).toBe(0)
    expect(store.held('night').map((j) => j.id)).toEqual([job.id])
    // An ordinary job beside it is claimed as ever.
    const { job: now } = store.create({ source: 'drop', type: 'web', url: 'https://example.org/now' })
    expect(store.queuedReady()).toBe(1)
    expect(store.claimNextQueued()?.id).toBe(now.id)

    expect(store.release('night')).toEqual([job.id])
    // Released, the job keeps its place in tonight's ingest queue (v26) until it is through.
    expect(store.getOrThrow(job.id)).toMatchObject({ status: 'queued', hold: null, night_released_at: expect.any(String) })
    expect(store.nightReleased().map((j) => j.id)).toEqual([job.id])
    expect(store.claimNextQueued()?.id).toBe(job.id)
    expect(store.release('night')).toEqual([])
    expect(store.logs(job.id).map((l) => l.message)).toContainEqual(expect.stringContaining('released to the queue by the night shift'))
    store.clearNightRelease(job.id)
    expect(store.getOrThrow(job.id).night_released_at).toBeNull()
    expect(store.nightReleased()).toEqual([])
  })

  it('leaves tonight\'s queue when it is cancelled, and stays in it through done until the queue clears it', () => {
    // `done` is written before the commit is made, so the store never clears the place on
    // its own; the queue does, once the commit step is over. A cancel is final at once.
    const { job } = store.create({ source: 'drop', type: 'web', url: 'https://example.org/tonight', hold: 'night' })
    store.release('night')
    const claimed = store.claimNextQueued()!
    store.transition(claimed.id, 'ingesting')
    store.transition(claimed.id, 'done')
    expect(store.nightReleased().map((j) => j.id)).toEqual([job.id])
    const { job: other } = store.create({ source: 'drop', type: 'web', url: 'https://example.org/other', hold: 'night' })
    store.release('night')
    store.transition(other.id, 'cancelled')
    expect(store.getOrThrow(other.id).night_released_at).toBeNull()
    expect(store.nightReleased().map((j) => j.id)).toEqual([job.id])
  })

  it('never holds a duplicate: it is terminal on arrival', () => {
    store.create({ source: 'drop', type: 'pdf', originalName: 'a.pdf', sha256: 'same' })
    const { job } = store.create({ source: 'drop', type: 'pdf', originalName: 'b.pdf', sha256: 'same', hold: 'night' })
    expect(job.status).toBe('duplicate')
    expect(job.hold).toBeNull()
  })
})
