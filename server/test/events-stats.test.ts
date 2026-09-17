import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventBus, type BusEvent } from '../src/pipeline/events.js'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { pageCounts, recentPages, readHotCache } from '../src/pipeline/vault-stats.js'

describe('EventBus', () => {
  it('fans out to subscribers and stops after unsubscribe', () => {
    const bus = new EventBus()
    const seen: BusEvent[] = []
    const off = bus.subscribe((e) => seen.push(e))
    bus.publish({ kind: 'stats' })
    off()
    bus.publish({ kind: 'stats' })
    expect(seen).toHaveLength(1)
    expect(bus.size).toBe(0)
  })

  it('a throwing listener never breaks the publisher', () => {
    const bus = new EventBus()
    const seen: BusEvent[] = []
    bus.subscribe(() => {
      throw new Error('dead socket')
    })
    bus.subscribe((e) => seen.push(e))
    expect(() => bus.publish({ kind: 'stats' })).not.toThrow()
    expect(seen).toHaveLength(1)
  })
})

describe('JobStore → bus', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(MEMORY_DB)
  })
  afterEach(() => db.close())

  it('publishes a job event on transition and a log event on log', () => {
    const bus = new EventBus()
    const events: BusEvent[] = []
    bus.subscribe((e) => events.push(e))
    const store = new JobStore(db, bus)

    const { job } = store.create({ source: 'drop', type: 'text', originalName: 'a.md' })
    store.transition(job.id, 'cancelled', { log: 'bye' })

    const jobEvents = events.filter((e) => e.kind === 'job')
    const logEvents = events.filter((e) => e.kind === 'log')
    expect(jobEvents.some((e) => e.kind === 'job' && e.job.status === 'cancelled')).toBe(true)
    expect(logEvents.some((e) => e.kind === 'log' && e.log.jobId === job.id)).toBe(true)
  })
})

describe('vault-stats page counts', () => {
  let vault: string
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-stats-'))
    fs.mkdirSync(path.join(vault, 'wiki', 'concepts'), { recursive: true })
    fs.mkdirSync(path.join(vault, 'wiki', 'entities'), { recursive: true })
    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'one.md'), '# one')
    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'two.md'), '# two')
    fs.writeFileSync(path.join(vault, 'wiki', 'entities', 'e.md'), '# e')
    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'ignore.txt'), 'not md')
    fs.writeFileSync(path.join(vault, 'wiki', 'hot.md'), '# hot cache')
    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', '_index.md'), '# concepts')
  })
  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }))

  it('counts markdown pages per dir, lists recent, reads hot cache', () => {
    const counts = pageCounts(vault)
    // 3, not 2: `_index.md` is a file in the folder and this is a count of files. The graph's
    // per-type chip reads one lower because it counts knowledge nodes - a different axis.
    expect(counts.byDir['concepts']).toBe(3)
    expect(counts.byDir['entities']).toBe(1)
    // `wiki/hot.md` sits in no folder. It used to be counted by nobody, because the counter
    // summed a fixed list of subfolders - the Home tab was short by exactly the pages at the
    // wiki root while the graph, which walks the tree, had them all.
    expect(counts.byDir['root']).toBe(1)
    expect(counts.total).toBe(5)

    const recent = recentPages(vault, 8)
    // One fewer than the count: an `_index.md` is rewritten by every run that files a page in
    // its folder, so it would sit at the top of "recently changed" forever.
    expect(recent.length).toBe(4)
    expect(recent.map((p) => p.path)).not.toContain('wiki/concepts/_index.md')
    expect(recent.every((p) => p.path.startsWith('wiki/') && p.path.endsWith('.md'))).toBe(true)
    // hot.md is touched by every ingest, so the most-changed page in a real vault was the one
    // "recently changed" structurally could not report.
    expect(recent.map((p) => p.path)).toContain('wiki/hot.md')
    expect(recent.find((p) => p.path === 'wiki/hot.md')?.dir).toBe('root')

    expect(readHotCache(vault)).toContain('hot cache')
  })

  it('gives an unknown folder its own bucket instead of dropping it', () => {
    /*
     * The failure mode the walk replaces: an allowlist is silent about what it does not know.
     * A vault that grows a new page type would lose it from the dashboard's headline figure
     * with no error anywhere - which is how five pages went missing in the first place.
     */
    fs.mkdirSync(path.join(vault, 'wiki', 'decisions'), { recursive: true })
    fs.writeFileSync(path.join(vault, 'wiki', 'decisions', 'd.md'), '# d')
    const counts = pageCounts(vault)
    expect(counts.byDir['decisions']).toBe(1)
    expect(counts.total).toBe(6)
  })

  it('keeps a known folder visible at zero, so the bars do not reshuffle', () => {
    expect(pageCounts(vault).byDir['questions']).toBe(0)
  })
})
