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
 *                                        free, read-only (docs/tasks/TASKS-DOMAIN-SPLIT.md)
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
import type { FastifyInstance } from 'fastify'
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
import { findDomainCandidates } from '../../pipeline/domain-candidates.js'
import type { DismissalStore } from '../../db/domain-dismissals.js'
import type { VaultGraph } from '../../pipeline/graph.js'
import { proposeSplit, type SplitProposal } from '../../pipeline/domain-split.js'
import { readAddresses } from '../../pipeline/hubs.js'
import { isDepartmentDomain } from '../../pipeline/library.js'

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
    return reply.send(proposalFor(graph.build(), key))
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
