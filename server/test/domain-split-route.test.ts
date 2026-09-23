/**
 * `GET /api/v1/domains/:key/split` (docs/tasks/TASKS-DOMAIN-SPLIT.md, phase 2), through the real
 * route over a fixture vault written to a temp directory: a registry and synthetic pages with
 * addresses, their links as wikilinks, so the graph builder reads them the way it reads a vault.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { SettingsStore } from '../src/db/settings.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { GraphBuilder } from '../src/pipeline/graph.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer } from '../src/api/server.js'
import { splitProposals } from '../src/api/routes/domains.js'
import { RunRegistry } from '../src/pipeline/run-registry.js'
import { SqliteDomainSplitStore } from '../src/db/domain-splits.js'
import { execFileSync } from 'node:child_process'
import type { Config } from '../src/config.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/index.js'

const NO_TOOLS: ToolAvailability = {
  pdftotext: false,
  pdfinfo: false,
  ocrmypdf: false,
  pandoc: false,
  python3: false,
  exiftool: false,
  defuddle: false,
  ytDlp: false,
  deno: false,
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The response contract, kept here so a change to it is a change to this test. */
const PageRef = z.object({ path: z.string(), title: z.string(), address: z.string().nullable() })
const Member = z.object({ path: z.string(), address: z.string().nullable() })
const Share = z.object({ domain: z.string(), pages: z.number(), share: z.number() })
const Shelf = z.object({
  id: z.number().int(),
  rank: z.number().int(),
  size: z.number().int(),
  types: z.record(z.string(), z.number()),
  entities: z.number().int(),
  conductance: z.number(),
  stability: z.number(),
  precision: z.number().nullable(),
  recall: z.number().nullable(),
  separability: z.number(),
  misfile: z.boolean(),
  confusedWith: z.array(z.object({ with: z.union([z.number(), z.literal('rest')]), gives: z.number(), receives: z.number() })),
  landmarks: z.array(PageRef.extend({ inShelf: z.number(), inDomain: z.number(), inVault: z.number() })),
  tags: z.array(z.string()),
  topTagCollision: z.object({ key: z.string(), inside: z.number(), elsewhere: z.number() }).nullable(),
  outsideNeighbours: z.object({
    count: z.number().int(),
    pages: z.array(PageRef.extend({ domain: z.string().nullable(), links: z.number() })),
  }),
  fingerprint: z.string(),
  pages: z.array(Member),
})
const Proposal = z.strictObject({
  domain: z.string(),
  pages: z.number().int(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  shelves: z.array(Shelf),
  rest: z.object({ size: z.number(), types: z.record(z.string(), z.number()), entities: z.number(), pages: z.array(Member) }),
  links: z.array(z.array(z.number())),
  totals: z.object({
    inShelves: z.number(),
    withParent: z.number(),
    internalLinks: z.number(),
    untagged: z.number(),
    knowledgePages: z.number(),
    largestNow: Share,
    largestAfter: Share,
    largestOther: Share,
  }),
  unaddressed: z.array(z.string()),
  params: z.object({ runs: z.number(), gamma: z.number(), agree: z.number(), seed: z.number(), shelfMinPages: z.number() }),
  // The remembered leave and defer decisions ride beside the memoised proposal (6.3).
  decisions: z.array(z.strictObject({ fingerprint: z.string(), decision: z.enum(['leave', 'defer']), decidedAt: z.string() })),
})

const REGISTRY = [
  '# Domain Registry',
  '',
  '## Domains',
  '',
  '## alpha',
  '',
  'Synthetic pages in three planted blocks.',
  '',
  '## beta',
  '',
  'A small synthetic domain.',
  '',
  '## gamma',
  '',
  'One dense synthetic block.',
  '',
].join('\n')

let counter = 0

/** Writes a planted partition of pages for one domain, links as wikilinks. */
function writeDomain(root: string, domain: string, sizes: number[], pIn: number, pOut: number, seed: number): void {
  const r = rng(seed)
  const block: number[] = []
  sizes.forEach((s, b) => {
    for (let i = 0; i < s; i++) block.push(b)
  })
  const title = (i: number): string => `${domain} B${block[i]}-${String(i).padStart(3, '0')}`
  const links: string[][] = block.map(() => [])
  for (let i = 0; i < block.length; i++)
    for (let j = i + 1; j < block.length; j++)
      if (r() < (block[i] === block[j] ? pIn : pOut)) {
        // The engine test's generator, draw for draw: one link per pair, its direction drawn.
        if (r() < 0.5) links[i]!.push(title(j))
        else links[j]!.push(title(i))
      }
  block.forEach((b, i) => {
    counter++
    const body = [
      '---',
      'type: concept',
      `domain: ${domain}`,
      `address: c-${String(counter).padStart(6, '0')}`,
      `tags: [concept, ${domain}-topic-${b}]`,
      '---',
      '',
      `# ${title(i)}`,
      '',
      ...links[i]!.map((t) => `- [[${t}]]`),
      '',
    ].join('\n')
    fs.writeFileSync(path.join(root, 'wiki/concepts', `${title(i)}.md`), body)
  })
}

describe('GET /api/v1/domains/:key/split', () => {
  let db: Db
  let vaultRoot: string
  let app: FastifyInstance
  let graph: GraphBuilder

  beforeAll(async () => {
    db = openDb(MEMORY_DB)
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'split-route-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki/concepts'), { recursive: true })
    fs.mkdirSync(path.join(vaultRoot, 'wiki/meta'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki/meta/domains.md'), REGISTRY)
    writeDomain(vaultRoot, 'alpha', [40, 40, 40], 0.25, 0.01, 1)
    writeDomain(vaultRoot, 'beta', [10], 0.3, 0, 2)
    writeDomain(vaultRoot, 'gamma', [60], 0.3, 0, 5)

    const events = new EventBus()
    const store = new JobStore(db, events)
    const config: Config = {
      vaultRoot,
      obsidianVaultName: 'vault',
      auth: null,
      telegram: null,
      demoMode: false,
      server: {
        host: '127.0.0.1',
        port: 0,
        watchFolder: path.join(vaultRoot, 'inbox'),
        maxUploadBytes: 1024 * 1024,
        authMode: 'local-single-user',
      },
    }
    graph = new GraphBuilder(vaultRoot)
    app = await buildServer({
      config,
      store,
      chat: new ChatStore(db),
      queue: new IngestQueue({
        store,
        vaultRoot,
        auth: null,
        events,
        detectToolsFn: async () => NO_TOOLS,
        commit: async () => ({ committed: false, hash: '', committedPages: [] }),
        refreshHotCache: async () => 'noop',
        runIngest: async () => {
          throw new Error('not reached')
        },
      }),
      events,
      maintenance: new MaintenanceRunner({
        vaultRoot,
        auth: null,
        events,
        commitMutex: new Mutex(),
        runAgent: async () => {
          throw new Error('not reached')
        },
        commit: async () => ({ committed: false, hash: '', committedPages: [] }),
      }),
      settings: new SettingsStore(db),
      graph,
      autoCommit: () => false,
      logger: false,
    })
  })

  afterAll(async () => {
    await app.close()
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const get = async (key: string): Promise<{ status: number; body: unknown }> => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/domains/${key}/split` })
    return { status: res.statusCode, body: res.json() }
  }

  it('answers 200 with three shelves for three planted blocks, in the documented shape', async () => {
    const { status, body } = await get('alpha')
    expect(status).toBe(200)
    const p = Proposal.parse(body)
    expect(p.eligible).toBe(true)
    expect(p.shelves.map((s) => s.size)).toEqual([40, 40, 40])
    expect(p.rest.size).toBe(0)
    expect(p.unaddressed).toEqual([])
    // Every page of a shelf is one block's.
    for (const s of p.shelves) expect(new Set(s.pages.map((m) => /B(\d)-/.exec(m.path)![1])).size).toBe(1)
    expect(p.shelves.every((s) => s.pages.every((m) => m.address !== null))).toBe(true)
  })

  it('answers 404 for a key the registry does not list', async () => {
    expect((await get('delta')).status).toBe(404)
  })

  it('answers 400 for meta and unassigned', async () => {
    expect((await get('meta')).status).toBe(400)
    expect((await get('unassigned')).status).toBe(400)
  })

  it('answers a small domain with eligible false and its reason', async () => {
    const { status, body } = await get('beta')
    expect(status).toBe(200)
    const p = Proposal.parse(body)
    expect(p.eligible).toBe(false)
    expect(p.reason).toMatch(/Only 10 knowledge pages/)
  })

  it('answers a domain that holds together with no shelves and its reason', async () => {
    const { status, body } = await get('gamma')
    expect(status).toBe(200)
    const p = Proposal.parse(body)
    expect(p.eligible).toBe(true)
    expect(p.shelves).toEqual([])
    expect(p.reason).toMatch(/^Holds together/)
  })

  it('returns the memoised object for an unchanged graph, and a new answer once a page is added', async () => {
    const proposalFor = splitProposals(vaultRoot)
    const g1 = graph.build()
    const first = proposalFor(g1, 'alpha')
    expect(proposalFor(graph.build(), 'alpha')).toBe(first)
    expect((await get('alpha')).body).toEqual({ ...JSON.parse(JSON.stringify(first)), decisions: [] })

    fs.writeFileSync(
      path.join(vaultRoot, 'wiki/concepts', 'alpha extra.md'),
      '---\ntype: concept\ndomain: alpha\naddress: c-999999\ntags: [concept]\n---\n\n# alpha extra\n\n- [[alpha B0-000]]\n',
    )
    const g2 = graph.build()
    expect(g2).not.toBe(g1)
    const second = proposalFor(g2, 'alpha')
    expect(second).not.toBe(first)
    expect(second.pages).toBe(first.pages + 1)
    expect(Proposal.parse((await get('alpha')).body).pages).toBe(121)
  })
})

/*
 * The write routes (TASKS-DOMAIN-SPLIT 5.7, 6.2, 6.9), through the real server over a git
 * fixture vault: what the writer tests prove on the module, proven once more at the boundary
 * the dashboard talks to - the demo guard, the refusals as 409s, the naming pass on the
 * read-only path.
 */
describe('the split write routes', () => {
  let db: Db
  let vaultRoot: string
  const apps: FastifyInstance[] = []
  let registry: RunRegistry
  let calls: Array<{ profile: string | undefined; prompt: string }>

  beforeAll(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'split-write-route-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki/concepts'), { recursive: true })
    fs.mkdirSync(path.join(vaultRoot, 'wiki/meta'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki/meta/domains.md'), REGISTRY)
    writeDomain(vaultRoot, 'alpha', [40, 40, 40], 0.25, 0.01, 1)
    writeDomain(vaultRoot, 'beta', [10], 0.3, 0, 2)
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', vaultRoot, ...args], { stdio: 'ignore' })
    }
    git('init', '-q')
    git('config', 'user.email', 't@example.invalid')
    git('config', 'user.name', 't')
    git('config', 'commit.gpgsign', 'false')
    git('add', '-A')
    git('commit', '-qm', 'fixture')
  })

  afterAll(async () => {
    for (const a of apps) await a.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  let logLines: string[] = []
  const build = async (over: { demoMode?: boolean; autoCommit?: boolean } = {}): Promise<{ app: FastifyInstance; maintenance: MaintenanceRunner }> => {
    db = openDb(MEMORY_DB)
    const events = new EventBus()
    logLines = []
    events.subscribe((e) => {
      if (e.kind === 'log') logLines.push(e.log.message)
    })
    const store = new JobStore(db, events)
    registry = new RunRegistry()
    calls = []
    const config: Config = {
      vaultRoot,
      obsidianVaultName: 'vault',
      auth: null,
      telegram: null,
      demoMode: over.demoMode ?? false,
      server: { host: '127.0.0.1', port: 0, watchFolder: path.join(vaultRoot, 'inbox'), maxUploadBytes: 1024 * 1024, authMode: 'local-single-user' },
    }
    const maintenance = new MaintenanceRunner({
      vaultRoot,
      auth: { kind: 'oauth', token: 'test' } as never,
      events,
      commitMutex: new Mutex(),
      runAgent: async (input: { profile?: string; prompt: string }) => {
        calls.push({ profile: input.profile, prompt: input.prompt })
        return {
          ok: true,
          result: '## shelf 1\nkey: coined-one\ndescription: The first.\ntags: a, b\n\n## parent\ndescription: What stays.\ntags: c',
          usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.01 },
        } as never
      },
      commit: async () => ({ committed: false, hash: '', committedPages: [] }),
    })
    const app = await buildServer({
      config,
      store,
      chat: new ChatStore(db),
      queue: new IngestQueue({
        store,
        vaultRoot,
        auth: null,
        events,
        detectToolsFn: async () => NO_TOOLS,
        commit: async () => ({ committed: false, hash: '', committedPages: [] }),
        refreshHotCache: async () => 'noop',
        runIngest: async () => {
          throw new Error('not reached')
        },
      }),
      events,
      maintenance,
      settings: new SettingsStore(db),
      graph: new GraphBuilder(vaultRoot),
      autoCommit: () => over.autoCommit ?? true,
      runRegistry: registry,
      domainSplits: new SqliteDomainSplitStore(db),
      logger: false,
    })
    apps.push(app)
    return { app, maintenance }
  }

  const proposalOf = async (app: FastifyInstance): Promise<z.infer<typeof Proposal>> =>
    Proposal.parse((await app.inject({ method: 'GET', url: '/api/v1/domains/alpha/split' })).json())

  const requestFor = (p: z.infer<typeof Proposal>): Record<string, unknown> => ({
    parentEntry: { description: 'Alpha, narrowed.', tags: [] },
    children: [{ key: 'coined-one', description: 'The first shelf.', tags: [], pages: p.shelves[0]!.pages }],
  })

  it('answers every split write 403 in demo mode', async () => {
    const { app } = await build({ demoMode: true })
    for (const [method, url] of [
      ['POST', '/api/v1/domains/alpha/split/plan'],
      ['POST', '/api/v1/domains/alpha/split/apply'],
      ['POST', '/api/v1/domains/alpha/split/naming'],
      ['POST', '/api/v1/domains/alpha/split/decisions'],
      ['DELETE', '/api/v1/domains/alpha/split/decisions/fp'],
      ['POST', '/api/v1/domains/splits/x/remainder'],
      ['POST', '/api/v1/domains/splits/x/revert'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} })
      expect(`${url} ${res.statusCode}`).toBe(`${url} 403`)
      expect((res.json() as { error: string }).error).toBe('demo_read_only')
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/domains/alpha/split' })).statusCode).toBe(200)
  })

  it('refuses the apply with 409 while a run writes and with auto-commit off, and plans without writing', async () => {
    const head = (): string => execFileSync('git', ['-C', vaultRoot, 'rev-parse', 'HEAD']).toString().trim()
    const before = head()
    let { app } = await build()
    const p = await proposalOf(app)
    const plan = await app.inject({ method: 'POST', url: '/api/v1/domains/alpha/split/plan', payload: requestFor(p) })
    expect(plan.statusCode).toBe(200)
    expect((plan.json() as { counts: { ok: number } }).counts.ok).toBe(40)
    const end = registry.begin()
    const busy = await app.inject({ method: 'POST', url: '/api/v1/domains/alpha/split/apply', payload: requestFor(p) })
    expect(busy.statusCode).toBe(409)
    expect((busy.json() as { code: string }).code).toBe('run-active')
    end()
    ;({ app } = await build({ autoCommit: false }))
    const off = await app.inject({ method: 'POST', url: '/api/v1/domains/alpha/split/apply', payload: requestFor(p) })
    expect((off.json() as { code: string }).code).toBe('auto-commit-off')
    expect(head()).toBe(before)
  })

  it('remembers a leave and a defer per fingerprint, and restores them', async () => {
    const { app } = await build()
    const p = await proposalOf(app)
    const fp = p.shelves[1]!.fingerprint
    expect((await app.inject({ method: 'POST', url: '/api/v1/domains/alpha/split/decisions', payload: { fingerprint: fp, decision: 'leave' } })).statusCode).toBe(200)
    expect((await proposalOf(app)).decisions).toMatchObject([{ fingerprint: fp, decision: 'leave' }])
    await app.inject({ method: 'DELETE', url: `/api/v1/domains/alpha/split/decisions/${encodeURIComponent(fp)}` })
    expect((await proposalOf(app)).decisions).toEqual([])
    expect((await app.inject({ method: 'POST', url: '/api/v1/domains/alpha/split/decisions', payload: { fingerprint: fp, decision: 'maybe' } })).statusCode).toBe(400)
  })

  it('runs the naming pass on the read-only path with the query profile, and parses its answer', async () => {
    const { app, maintenance } = await build()
    const p = await proposalOf(app)
    const res = await app.inject({ method: 'POST', url: '/api/v1/domains/alpha/split/naming', payload: { groups: [[p.shelves[0]!.id]] } })
    expect(res.statusCode).toBe(202)
    const id = (res.json() as { id: string }).id
    for (let i = 0; i < 50 && maintenance.getRun(id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10))
    const run = maintenance.getRun(id)!
    expect(run.status).toBe('done')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.profile).toBe('query')
    // And the run says so in its own log, which is what stage E4 reads on the live copy.
    expect(logLines).toContain('maintenance: split-naming runs read-only under the query profile - no vault write path, no commit')
    expect(calls[0]!.prompt).toContain('## shelf 1')
    expect(run.result?.commit).toBeNull()
    expect(run.result?.splitNaming?.shelves[1]).toEqual({ key: 'coined-one', description: 'The first.', tags: ['a', 'b'] })
    expect(run.result?.splitNaming?.parent).toEqual({ description: 'What stays.', tags: ['c'] })
  })

  it('applies through the route: one commit, the split listed, the promoted shelf gone from the proposal', async () => {
    const { app } = await build()
    const p = await proposalOf(app)
    const res = await app.inject({ method: 'POST', url: '/api/v1/domains/alpha/split/apply', payload: requestFor(p) })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { commit: string; written: unknown[]; verified: boolean; splitId: string }
    expect(body.written).toHaveLength(40)
    expect(body.verified).toBe(true)
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/domains/splits' })).json() as { splits: Array<{ id: string; remainder: number; commits: string[] }> }
    expect(listed.splits).toMatchObject([{ id: body.splitId, remainder: 0, commits: [body.commit] }])
    const after = await proposalOf(app)
    expect(after.pages).toBe(80)
    const domains = (await app.inject({ method: 'GET', url: '/api/v1/domains' })).json() as { domains: Array<{ key: string }> }
    expect(domains.domains.map((d) => d.key)).toEqual(['alpha', 'coined-one', 'beta', 'gamma'])
  })
})
