/**
 * Commits taken off the Activity stream (schema v25): the store, and the stats route that
 * filters the vault's history by it and fetches over what it hides.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { CommitDismissalStore } from '../src/db/commit-dismissals.js'
import { EventBus } from '../src/pipeline/events.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer } from '../src/api/server.js'
import type { Config } from '../src/config.js'

describe('the commit dismissal store', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(MEMORY_DB)
  })
  afterEach(() => db.close())

  it('remembers a hash once, lists newest first, and forgets it again', () => {
    const store = new CommitDismissalStore(db)
    expect(store.keys().size).toBe(0)
    store.dismiss('abcd1234')
    store.dismiss('abcd1234')
    store.dismiss('ef567890')
    expect(store.keys()).toEqual(new Set(['abcd1234', 'ef567890']))
    expect(store.list().map((d) => d.key)).toHaveLength(2)
    store.restore('abcd1234')
    expect(store.keys()).toEqual(new Set(['ef567890']))
  })
})

describe('the stats route with dismissed commits', () => {
  let vaultRoot: string
  let db: Db
  let app: FastifyInstance
  const git = (root: string, ...args: string[]): string =>
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })

  beforeEach(async () => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-dismiss-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'concepts'), { recursive: true })
    git(vaultRoot, 'init', '-q')
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', 'A.md'), '# A\n')
    git(vaultRoot, 'add', '-A')
    git(vaultRoot, 'commit', '-q', '--no-verify', '-m', 'edit: A')
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', 'B.md'), '# B\n')
    git(vaultRoot, 'add', '-A')
    git(vaultRoot, 'commit', '-q', '--no-verify', '-m', 'edit: B')
    db = openDb(MEMORY_DB)
    const events = new EventBus()
    const store = new JobStore(db, events)
    const config: Config = {
      vaultRoot,
      obsidianVaultName: 'vault',
      demoMode: false,
      agentsEnabled: false,
      auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
      telegram: null,
      server: { host: '127.0.0.1', port: 0, watchFolder: path.join(vaultRoot, 'inbox'), maxUploadBytes: 1024, authMode: 'local-single-user' },
    }
    const queue = new IngestQueue({ store, vaultRoot, auth: config.auth, runIngest: async () => { throw new Error('no agent') } })
    const runner = new MaintenanceRunner({ vaultRoot, auth: config.auth, events, commitMutex: new Mutex() })
    app = await buildServer({
      config,
      store,
      chat: new ChatStore(db),
      queue,
      events,
      maintenance: runner,
      logger: false,
      commitDismissals: new CommitDismissalStore(db),
    })
  })
  afterEach(async () => {
    await app.close()
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('leaves a dismissed commit out of the history and takes it back on restore', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/v1/stats' })).json() as { commits: Array<{ hash: string; subject: string }> }
    expect(before.commits.map((c) => c.subject)).toEqual(['edit: B', 'edit: A'])
    const b = before.commits[0]!.hash

    const off = await app.inject({ method: 'POST', url: `/api/v1/stats/commits/${b}/dismiss` })
    expect(off.statusCode).toBe(200)
    const after = (await app.inject({ method: 'GET', url: '/api/v1/stats' })).json() as { commits: Array<{ subject: string }> }
    expect(after.commits.map((c) => c.subject)).toEqual(['edit: A'])

    const back = await app.inject({ method: 'DELETE', url: `/api/v1/stats/commits/${b}/dismiss` })
    expect(back.statusCode).toBe(200)
    const restored = (await app.inject({ method: 'GET', url: '/api/v1/stats' })).json() as { commits: Array<{ subject: string }> }
    expect(restored.commits.map((c) => c.subject)).toEqual(['edit: B', 'edit: A'])

    // Not a hash: refused, nothing stored.
    expect((await app.inject({ method: 'POST', url: '/api/v1/stats/commits/not-a-hash/dismiss' })).statusCode).toBe(400)
  })
})
