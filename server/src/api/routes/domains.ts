/**
 * /api/v1/domains — the vault's meta-category registry and the governance loop around it
 * (SPEC.md §12.4, Meta-Kategorien Stufe 2/3).
 *
 *   GET    /domains                      the registry (installed? + parsed entries)
 *   GET    /domains/candidates           themes among `unassigned` pages big enough to
 *                                        justify a new domain — deterministic, free
 *   POST   /domains                      create a domain: append a section to the registry
 *                                        page, as ONE git commit behind the shared mutex
 *   POST   /domains/candidates/:key/dismiss    stop proposing this theme
 *   DELETE /domains/candidates/:key/dismiss    reconsider it
 *   GET    /domains/:key/split          the shelves a domain falls into - deterministic,
 *                                        free, read-only (docs/tasks/TASKS-DOMAIN-SPLIT.md),
 *                                        with the remembered shelf decisions
 *   POST   /domains/:key/split/naming   start the read-only naming pass (`query` profile)
 *   POST   /domains/:key/split/plan     dry run of a decision set, writes nothing
 *   POST   /domains/:key/split/apply    the one-commit split
 *   POST   /domains/:key/split/decisions              leave or defer a shelf, by fingerprint
 *   DELETE /domains/:key/split/decisions/:fingerprint restore it
 *   GET    /domains/splits              applied splits, their commits and live remainder
 *   POST   /domains/splits/:id/remainder              re-file what did not move
 *   POST   /domains/splits/:id/revert                 revert the split's commits, newest first
 *
 * Creating a domain is the one write here, and it goes through the same discipline as a user
 * page edit (CLAUDE.md hard rule 1 as amended): `commitPaths` with an exact pathspec — never
 * `commitVault`, whose `add -A` fallback could sweep a concurrent agent's half-written pages
 * into this commit — inside the shared commit mutex so it cannot interleave with an agent's.
 *
 * New domains are created HERE, by a user action, and never by an agent: that asymmetry is the
 * whole point of the registry (the ingest guardrail forbids agents coining keys).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from '../server.js'
import type { GraphBuilder } from '../../pipeline/graph.js'
import { commitPaths, type CommitResult } from '../../pipeline/git.js'
import { WikiLockBusy, withWikiLock } from '../../pipeline/wiki-lock.js'
import { Mutex } from '../../util/mutex.js'
import {
  readDomainRegistry,
  appendDomainSection,
  isValidDomainKey,
  DOMAIN_REGISTRY_PATH,
} from '../../pipeline/domains.js'
import { findDomainCandidates, STRUCTURAL_TAGS } from '../../pipeline/domain-candidates.js'
import type { DismissalStore } from '../../db/domain-dismissals.js'
import type { VaultGraph } from '../../pipeline/graph.js'
import { proposeSplit, type SplitProposal } from '../../pipeline/domain-split.js'
import { readAddresses } from '../../pipeline/hubs.js'
import { isDepartmentDomain } from '../../pipeline/library.js'
import { RunRegistry } from '../../pipeline/run-registry.js'
import { MemoryDomainSplitStore, type ShelfDecision } from '../../db/domain-splits.js'
import {
  applyRemainder,
  applySplit,
  listSplits,
  parseSplitRequest,
  planSplit,
  revertSplit,
  SplitRefused,
  type SplitWriterOptions,
} from '../../pipeline/domain-split-write.js'
import type { NamingInput } from '../../pipeline/split-naming.js'

/**
 * The rules a split can change: it rewrites `domain:` and `updated:` and nothing else, and
 * `tag-mirroring` is the one rule that reads `domain:`, `dates` the one that reads `updated:`.
 *
 * Checked on the written pages and on nothing else. Validating them under every rule was tried
 * on a copy of the live vault and booked 158 findings on the 218 pages of one split -
 * `page-schema`, `open-question-form`, `title-name` and more, every one of them there before the
 * split and invisible to the standing list only because nothing had re-read those pages since
 * their rule arrived. Booked by a split, they read as the split's doing, which they are not.
 */
const SPLIT_RULES: ReadonlySet<string> = new Set(['tag-mirroring', 'dates'])

/** Validates and records what a split wrote, under the rules a split can change. */
function checkSplitWrite(ctx: AppContext, written: readonly string[]): { recorded: number; resolved: number } {
  if (written.length === 0 || ctx.validate === undefined || ctx.validation === undefined) return { recorded: 0, resolved: 0 }
  const findings = ctx.validate(written).filter((f) => SPLIT_RULES.has(f.rule))
  const { created } = ctx.validation.record(findings, null)
  const resolved = ctx.validation.resolveMissing([...written], findings, { checked: SPLIT_RULES })
  return { recorded: created.length, resolved }
}

/** How each refusal of the split writer answers over HTTP. */
const REFUSAL_STATUS: Record<SplitRefused['code'], number> = {
  'run-active': 409,
  'auto-commit-off': 409,
  'no-registry': 409,
  'registry-busy': 409,
  'nothing-to-move': 409,
  'already-reverted': 409,
  orphans: 409,
  'revert-failed': 409,
  'duplicate-key': 409,
  'unknown-split': 404,
  'unknown-parent': 404,
  'invalid-key': 400,
  'reserved-key': 400,
}

/**
 * The split proposal, memoised per graph object and key (TASKS-DOMAIN-SPLIT 2.2, 2.3). The
 * graph builder hands back the SAME object for an unchanged vault, so an unchanged vault costs
 * one computation per domain, and any change to a page - which is what could change the answer -
 * produces a new object and a fresh proposal. A WeakMap, so an old graph and its proposals go
 * together.
 *
 * The addresses are read here, from the pages themselves, and handed to the engine, which never
 * reads a file. A page without one is listed in `unaddressed` and can never be approved.
 */
export function splitProposals(vaultRoot: string): (graph: VaultGraph, key: string) => SplitProposal {
  const memo = new WeakMap<VaultGraph, Map<string, SplitProposal>>()
  return (graph, key) => {
    let perKey = memo.get(graph)
    if (perKey === undefined) {
      perKey = new Map()
      memo.set(graph, perKey)
    }
    const hit = perKey.get(key)
    if (hit !== undefined) return hit
    const paths = graph.nodes.filter((n) => n.domain === key).map((n) => n.path)
    const proposal = proposeSplit(graph, key, readAddresses(vaultRoot, paths))
    perKey.set(key, proposal)
    return proposal
  }
}

export function registerDomainsRoute(
  app: FastifyInstance,
  ctx: AppContext,
  graph: GraphBuilder,
  dismissals: DismissalStore,
): void {
  const { config } = ctx
  const commitMutex = ctx.commitMutex ?? new Mutex()
  const autoCommit = ctx.autoCommit ?? ((): boolean => true)
  const proposalFor = splitProposals(config.vaultRoot)
  const splits = ctx.domainSplits ?? new MemoryDomainSplitStore()
  /** A private one for a context that wired none (tests); `main.ts` passes the shared one. */
  const fallbackRegistry = new RunRegistry()

  app.get('/api/v1/domains', async (_req, reply) => {
    const registry = readDomainRegistry(config.vaultRoot)
    return reply.send({
      installed: registry !== null,
      path: DOMAIN_REGISTRY_PATH,
      domains: registry?.domains ?? [],
    })
  })

  app.get('/api/v1/domains/candidates', async (_req, reply) => {
    const report = findDomainCandidates({
      graph: graph.build(),
      registry: readDomainRegistry(config.vaultRoot),
      dismissed: dismissals.keys(),
    })
    return reply.send({ ...report, dismissed: dismissals.list() })
  })

  /*
   * The split proposal (SPEC.md §12.4 stage 4, part one). Base product, not behind
   * `AGENTS_ENABLED`: it reads the registry and the graph, both of which the base product owns.
   * A small domain and one that holds together are ANSWERS (200 with the reason), not errors;
   * only a key that is no domain at all is one.
   */
  app.get('/api/v1/domains/:key/split', async (req, reply) => {
    const key = (req.params as { key: string }).key.trim().toLowerCase()
    if (!isDepartmentDomain(key)) {
      return reply.code(400).send({ error: `"${key}" is not a domain a split can be proposed for` })
    }
    const registry = readDomainRegistry(config.vaultRoot)
    if (registry === null || !registry.domains.some((d) => d.key === key)) {
      return reply.code(404).send({ error: `the registry lists no domain "${key}"` })
    }
    // The proposal itself is memoised and shared; the decisions ride beside it, never in it.
    return reply.send({ ...proposalFor(graph.build(), key), decisions: splits.decisions(key) })
  })

  /*
   * The write half (SPEC.md §12.4 stage 4, part two; TASKS-DOMAIN-SPLIT phases 5 and 6). Base
   * product like the proposal, and every POST and DELETE is refused in demo mode by the one
   * request guard in `server.ts`, before any of this runs.
   */
  const writer = (): SplitWriterOptions => ({
    commitMutex,
    runRegistry: ctx.runRegistry ?? fallbackRegistry,
    autoCommit,
    store: splits,
  })

  /** A refusal as its status and sentence; anything else goes up as the 500 it is. */
  const refuse = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof SplitRefused) {
      return reply.code(REFUSAL_STATUS[err.code]).send({ error: err.message, code: err.code, ...(err.detail ?? {}) })
    }
    throw err
  }

  /** The key a split route is about: a department domain the registry lists, or the answer why not. */
  const splitKey = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const key = (req.params as { key: string }).key.trim().toLowerCase()
    if (!isDepartmentDomain(key)) {
      void reply.code(400).send({ error: `"${key}" is not a domain a split can be proposed for` })
      return null
    }
    const registry = readDomainRegistry(config.vaultRoot)
    if (registry === null || !registry.domains.some((d) => d.key === key)) {
      void reply.code(404).send({ error: `the registry lists no domain "${key}"` })
      return null
    }
    return key
  }

  app.post('/api/v1/domains/:key/split/plan', async (req, reply) => {
    const key = splitKey(req, reply)
    if (key === null) return reply
    const parsed = parseSplitRequest(key, req.body)
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
    try {
      const g = graph.build()
      return reply.send(planSplit(config.vaultRoot, parsed.request, g, proposalFor(g, key)))
    } catch (err) {
      return refuse(reply, err)
    }
  })

  app.post('/api/v1/domains/:key/split/apply', async (req, reply) => {
    const key = splitKey(req, reply)
    if (key === null) return reply
    const parsed = parseSplitRequest(key, req.body)
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
    try {
      const result = await applySplit(config.vaultRoot, parsed.request, writer())
      // A split that booked a finding (a key equal to a tag, say) puts it on the standing list
      // at once - under the rules a split can change, and no others (`SPLIT_RULES`).
      const validation = checkSplitWrite(ctx, result.written.map((w) => w.path))
      return reply.send({ ...result, validation })
    } catch (err) {
      return refuse(reply, err)
    }
  })

  app.get('/api/v1/domains/splits', async (_req, reply) => {
    return reply.send({ splits: listSplits(config.vaultRoot, splits) })
  })

  app.post('/api/v1/domains/splits/:id/remainder', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      const result = await applyRemainder(config.vaultRoot, id, writer())
      const validation = checkSplitWrite(ctx, result.written.map((w) => w.path))
      return reply.send({ ...result, validation })
    } catch (err) {
      return refuse(reply, err)
    }
  })

  app.post('/api/v1/domains/splits/:id/revert', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      return reply.send(await revertSplit(config.vaultRoot, id, writer()))
    } catch (err) {
      return refuse(reply, err)
    }
  })

  app.post('/api/v1/domains/:key/split/decisions', async (req, reply) => {
    const key = splitKey(req, reply)
    if (key === null) return reply
    const body = (req.body ?? {}) as { fingerprint?: unknown; decision?: unknown }
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.trim() : ''
    const decision = body.decision
    if (fingerprint === '') return reply.code(400).send({ error: 'provide the shelf\'s "fingerprint"' })
    if (decision !== 'leave' && decision !== 'defer') return reply.code(400).send({ error: '"decision" is "leave" or "defer"' })
    splits.decide(key, fingerprint, decision as ShelfDecision)
    return reply.send({ ok: true, decisions: splits.decisions(key) })
  })

  app.delete('/api/v1/domains/:key/split/decisions/:fingerprint', async (req, reply) => {
    const key = splitKey(req, reply)
    if (key === null) return reply
    const { fingerprint } = req.params as { fingerprint: string }
    splits.restore(key, fingerprint)
    return reply.send({ ok: true, decisions: splits.decisions(key) })
  })

  /*
   * The naming pass (6.2, D14): a maintenance run of the kind `split-naming` under the `query`
   * profile, through the read-only run path. The body names the chosen shelves as GROUPS of
   * shelf ids (a merge is a group of two or more); the route reads their evidence from the
   * proposal itself, so the prompt carries what the proposal says and nothing the client made up.
   */
  app.post('/api/v1/domains/:key/split/naming', async (req, reply) => {
    const key = splitKey(req, reply)
    if (key === null) return reply
    const body = (req.body ?? {}) as { groups?: unknown }
    const proposal = proposalFor(graph.build(), key)
    const ids = new Set(proposal.shelves.map((s) => s.id))
    const groups = Array.isArray(body.groups)
      ? body.groups.map((g) => (Array.isArray(g) ? g.filter((n): n is number => typeof n === 'number' && ids.has(n)) : []))
      : []
    if (groups.length === 0 || groups.some((g) => g.length === 0)) {
      return reply.code(400).send({ error: 'name at least one group of shelf ids from the current proposal' })
    }
    const registry = readDomainRegistry(config.vaultRoot)
    const parent = registry?.domains.find((d) => d.key === key)
    // What stays with the parent - the rest and every shelf not being named - so the agent
    // narrows the parent by what left rather than redescribing it by what it happens to see.
    const chosen = new Set(groups.flat())
    const staying = new Set([
      ...proposal.rest.pages.map((m) => m.path),
      ...proposal.shelves.filter((s) => !chosen.has(s.id)).flatMap((s) => s.pages.map((m) => m.path)),
    ])
    const tagCount = new Map<string, number>()
    for (const n of graph.build().nodes) {
      if (!staying.has(n.path)) continue
      for (const t of n.tags) {
        const tag = t.toLowerCase()
        if (!STRUCTURAL_TAGS.has(tag)) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)
      }
    }
    const stayTags = [...tagCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15).map(([t]) => t)
    const input: NamingInput = {
      parent: {
        key,
        description: parent?.description ?? '',
        tags: parent?.tags ?? [],
        stays: { pages: staying.size, tags: stayTags },
      },
      otherKeys: (registry?.domains ?? []).map((d) => d.key).filter((k) => k !== key),
      shelves: groups.map((group, i) => {
        const shelves = group.map((id) => proposal.shelves.find((s) => s.id === id)!)
        return {
          n: i + 1,
          size: shelves.reduce((a, s) => a + s.size, 0),
          tags: [...new Set(shelves.flatMap((s) => s.tags))],
          landmarks: shelves.flatMap((s) => s.landmarks.map((l) => ({ title: l.title, path: l.path }))),
          frequentTags: shelves.map((s) => s.topTagCollision).filter((c) => c !== null && c.inside + c.elsewhere > 5).map((c) => c!.key),
        }
      }),
    }
    try {
      return reply.code(202).send(ctx.maintenance.startSplitNaming(input))
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message })
    }
  })

  app.post('/api/v1/domains/candidates/:key/dismiss', async (req, reply) => {
    const { key } = req.params as { key: string }
    dismissals.dismiss(key.toLowerCase())
    return reply.send({ ok: true, key: key.toLowerCase() })
  })

  app.delete('/api/v1/domains/candidates/:key/dismiss', async (req, reply) => {
    const { key } = req.params as { key: string }
    dismissals.restore(key.toLowerCase())
    return reply.send({ ok: true, key: key.toLowerCase() })
  })

  app.post('/api/v1/domains', async (req, reply) => {
    const body = (req.body ?? {}) as { key?: unknown; description?: unknown; tags?: unknown; dismissCandidate?: unknown }
    const key = typeof body.key === 'string' ? body.key.trim().toLowerCase() : ''
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean)
      : []

    if (!isValidDomainKey(key)) {
      return reply.code(400).send({ error: 'key must be lowercase letters, digits and hyphens' })
    }
    if (description === '') return reply.code(400).send({ error: 'provide a "description"' })

    const abs = path.join(config.vaultRoot, DOMAIN_REGISTRY_PATH)
    if (!fs.existsSync(abs)) {
      return reply.code(409).send({ error: `no registry at ${DOMAIN_REGISTRY_PATH}`, registryPath: DOMAIN_REGISTRY_PATH })
    }

    // Read-modify-write inside the mutex: two concurrent creates (or an agent commit landing
    // mid-write) must not be able to lose one of the sections.
    let result: { duplicate: true } | { duplicate: false; commit: CommitResult | undefined }
    try {
      // The vault's per-file lock outside our mutex (`wiki-lock.ts`): the registry is a wiki
      // page, and an agent run reads it on every write - it may as well be writing it.
      result = await withWikiLock(config.vaultRoot, DOMAIN_REGISTRY_PATH, async () =>
        commitMutex.runExclusive(async () => {
          const markdown = fs.readFileSync(abs, 'utf8')
          const next = appendDomainSection(markdown, { key, description, tags })
          if (next === null) return { duplicate: true as const }
          fs.writeFileSync(abs, next, 'utf8')
          const commit = autoCommit()
            ? await commitPaths(config.vaultRoot, `domains: add ${key}`, [DOMAIN_REGISTRY_PATH])
            : undefined
          return { duplicate: false as const, commit }
        }),
      )
    } catch (err) {
      if (err instanceof WikiLockBusy) {
        return reply.code(409).send({ error: 'an agent run is writing the domain registry right now - try again in a moment', busy: true })
      }
      throw err
    }

    if (result.duplicate) return reply.code(409).send({ error: `domain "${key}" already exists` })

    // A candidate that became a domain must stop being proposed. Its pages still carry
    // `unassigned` until a backfill runs, so without this the theme would reappear at once.
    if (typeof body.dismissCandidate === 'string' && body.dismissCandidate.trim() !== '') {
      dismissals.dismiss(body.dismissCandidate.trim().toLowerCase())
    }

    return reply.send({
      ok: true,
      key,
      path: DOMAIN_REGISTRY_PATH,
      commit: result.commit?.hash ?? null,
      committed: result.commit?.committed ?? false,
    })
  })
}
