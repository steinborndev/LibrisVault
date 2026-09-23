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
  }),
  unaddressed: z.array(z.string()),
  params: z.object({ runs: z.number(), gamma: z.number(), agree: z.number(), seed: z.number(), shelfMinPages: z.number() }),
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
    expect((await get('alpha')).body).toEqual(JSON.parse(JSON.stringify(first)))

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
