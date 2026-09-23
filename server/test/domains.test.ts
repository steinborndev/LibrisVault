/**
 * Domain registry tests (SPEC.md §12.4 Stufe 2): parsing the vault's `wiki/meta/domains.md`,
 * the system-prompt extension it produces, and the backfill's refusal to run without one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseDomainRegistry,
  readDomainRegistry,
  domainSystemPrompt,
  DOMAIN_REGISTRY_PATH,
  UNASSIGNED,
  replaceDomainSection,
  insertDomainSectionsAfter,
  applyRegistrySplit,
  draftParentEntry,
} from '../src/pipeline/domains.js'
import {
  MaintenanceRunner,
  DomainRegistryMissingError,
  domainBackfillPrompt,
  DOMAIN_TAGS_THAT_STAY,
} from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import { IngestQueue, type IngestRunner } from '../src/pipeline/queue.js'
import { JobStore } from '../src/db/jobs.js'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'

const REGISTRY = `---
type: meta
title: "Domain Registry"
tags:
  - meta
---

# Domain Registry

Prose the parser must ignore, including a decoy heading below.

## How a new domain is born

Five or more coherent pages. This section is documentation, not a domain.

## Domains

## biomedicine

Biology, medicine and drug delivery.

Further notes for the human that must NOT reach the agent instruction.

**Tags:** \`mrna-delivery\`, \`biomedical\`, \`Drug-Delivery\`, \`mrna-delivery\`

## finance

Money and markets.

**Tags:** \`german-finance\`, \`investment-funds\`,
\`banking\`, \`regulation\`,
\`securities\`

## meta

The wiki's own machinery.
`

let vaultRoot: string
beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'domains-vault-'))
  fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
})
afterEach(() => fs.rmSync(vaultRoot, { recursive: true, force: true }))

describe('parseDomainRegistry', () => {
  it('reads keys, lead-paragraph descriptions and deduped lowercase tags', () => {
    const reg = parseDomainRegistry(REGISTRY)
    expect(reg.domains.map((d) => d.key)).toEqual(['biomedicine', 'finance', 'meta'])

    const bio = reg.domains[0]!
    expect(bio.description).toBe('Biology, medicine and drug delivery.')
    expect(bio.description).not.toContain('Further notes') // lead paragraph only
    expect(bio.tags).toEqual(['mrna-delivery', 'biomedical', 'drug-delivery']) // deduped, lowercased
    expect(reg.domains[2]!.tags).toEqual([]) // a domain may list no tags
  })

  it('collects a tag list that wraps across lines', () => {
    // Regression: the first live registry had 12-tag domains wrapped over three lines and
    // arrived with 4 — everything past the `**Tags:**` line itself was dropped.
    const finance = parseDomainRegistry(REGISTRY).domains.find((d) => d.key === 'finance')!
    expect(finance.tags).toEqual(['german-finance', 'investment-funds', 'banking', 'regulation', 'securities'])
  })

  it('stops collecting tags at the blank line, so the next section is unaffected', () => {
    const reg = parseDomainRegistry(
      '## Domains\n\n## a\n\ndesc a\n\n**Tags:** `x`,\n`y`\n\nTrailing prose with `not-a-tag`.\n\n## b\n\ndesc b\n',
    )
    expect(reg.domains[0]!.tags).toEqual(['x', 'y'])
    expect(reg.domains.map((d) => d.key)).toEqual(['a', 'b'])
  })

  it('ignores everything above the "## Domains" marker', () => {
    // "How a new domain is born" sits above the marker and is registry-key-shaped enough to
    // be a trap; it must not become a domain.
    expect(parseDomainRegistry(REGISTRY).domains.map((d) => d.key)).not.toContain('how a new domain is born')
  })

  it('returns no domains when the marker is missing, and ignores prose subheadings after it', () => {
    expect(parseDomainRegistry('# Nothing here\n\n## biomedicine\n\ntext').domains).toEqual([])
    const reg = parseDomainRegistry('## Domains\n\n## Not A Key\n\ntext\n\n## ok-key\n\ndesc\n')
    expect(reg.domains.map((d) => d.key)).toEqual(['ok-key'])
  })

  it('lets the first definition win when a key is duplicated', () => {
    const reg = parseDomainRegistry('## Domains\n\n## dup\n\nfirst\n\n## dup\n\nsecond\n')
    expect(reg.domains).toHaveLength(1)
    expect(reg.domains[0]!.description).toBe('first')
  })
})

describe('readDomainRegistry', () => {
  it('returns null when the vault has no registry, and the parsed registry when it does', () => {
    expect(readDomainRegistry(vaultRoot)).toBeNull()
    fs.writeFileSync(path.join(vaultRoot, DOMAIN_REGISTRY_PATH), REGISTRY)
    expect(readDomainRegistry(vaultRoot)?.domains).toHaveLength(3)
  })

  it('treats an empty (marker-less) registry as absent', () => {
    fs.writeFileSync(path.join(vaultRoot, DOMAIN_REGISTRY_PATH), '# Empty\n\nno domains here\n')
    expect(readDomainRegistry(vaultRoot)).toBeNull()
  })
})

describe('domainSystemPrompt', () => {
  it('is empty without a registry, so runs behave exactly as before the feature', () => {
    expect(domainSystemPrompt(null)).toBe('')
    expect(domainSystemPrompt({ domains: [], path: DOMAIN_REGISTRY_PATH })).toBe('')
  })

  it('lists every key plus the unassigned escape hatch and forbids inventing keys', () => {
    const prompt = domainSystemPrompt(parseDomainRegistry(REGISTRY))
    expect(prompt).toContain('- biomedicine - Biology, medicine and drug delivery.')
    expect(prompt).toContain('typical tags: mrna-delivery, biomedical, drug-delivery')
    expect(prompt).toContain(`- ${UNASSIGNED} -`)
    expect(prompt).toContain('Never invent a domain key')
    expect(prompt).toContain(DOMAIN_REGISTRY_PATH)
  })
})

describe('ingest runs receive the registry', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(MEMORY_DB)
  })
  afterEach(() => db.close())

  /** Runs one file through the queue and returns the systemPromptExtra the runner saw. */
  async function ingestOnce(): Promise<string | undefined> {
    let seen: string | undefined
    const runIngest: IngestRunner = async (opts) => {
      seen = opts.systemPromptExtra
      return {
        ok: true,
        result: 'done',
        usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
        messages: [],
        durationMs: 1,
        numTurns: 1,
        sessionId: 'test-session',
        timedOut: false,
      }
    }
    const queue = new IngestQueue({
      store: new JobStore(db),
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 1,
      detectToolsFn: async () => ({}) as never,
      commit: async () => ({ committed: true, hash: 'abc', committedPages: [] }),
      refreshHotCache: async () => '',
      runIngest,
    })
    queue.start()
    const src = path.join(vaultRoot, 'note.md')
    fs.writeFileSync(src, 'hello')
    await queue.enqueueFile({ sourcePath: src, source: 'drop' })
    await queue.onIdle()
    queue.stop()
    return seen
  }

  it('passes the domain rules when a registry exists', async () => {
    fs.writeFileSync(path.join(vaultRoot, DOMAIN_REGISTRY_PATH), REGISTRY)
    const extra = await ingestOnce()
    expect(extra).toContain('<domain_registry>')
    expect(extra).toContain('biomedicine')
    expect(extra).toContain(UNASSIGNED)
  })

  it('passes no domain block when the vault has no registry (the hygiene checklist still rides)', async () => {
    const extra = await ingestOnce()
    expect(extra).not.toContain('<domain_registry>')
    expect(extra).toContain('<page_hygiene>')
    expect(extra).toContain('<entity_notability>')
  })
})

describe('domain backfill guard', () => {
  const runner = (): MaintenanceRunner =>
    new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex: new Mutex(),
      // Never reached in these tests: the guard throws before any agent work.
      runAgent: async () => {
        throw new Error('agent must not run without a registry')
      },
    })

  it('refuses to start without a registry', () => {
    expect(() => runner().startDomainBackfill()).toThrow(DomainRegistryMissingError)
    expect(() => runner().startDomainBackfill()).toThrow(/install it/)
  })

  it('starts a tracked run once a registry exists', () => {
    fs.writeFileSync(path.join(vaultRoot, DOMAIN_REGISTRY_PATH), REGISTRY)
    const run = runner().startDomainBackfill()
    expect(run.kind).toBe('domain-backfill')
    expect(run.channel).toBe('maintenance:domain-backfill')
    expect(run.status).toBe('running')
  })
})

/**
 * The backfill prompt used to require the domain key to be mirrored into `tags:`, which
 * closed a loop with the dashboard's tag hygiene: the backfill set the tag, the tag repair
 * (correctly) read it as repeating the `domain:` field and removed it, and the next backfill
 * set it again. Every new domain produced a due tag repair within minutes of being filled.
 */
describe('domain backfill prompt', () => {
  const prompt = (): string => domainBackfillPrompt(['biomedicine', 'quantum-computing', 'meta'])

  it('tells the agent to REMOVE a tag that repeats a domain key', () => {
    const p = prompt()
    expect(p).toMatch(/REMOVE any tag equal to a domain key/)
    expect(p).toMatch(/the `domain:` field and NOWHERE else|domain belongs in the `domain:` field and NOWHERE else/)
  })

  it('never asks for the key to be mirrored into tags again', () => {
    const p = prompt().toLowerCase()
    expect(p).not.toMatch(/mirror/)
    expect(p).not.toMatch(/present as a tag/)
    expect(p).not.toMatch(/keep the `unassigned` tag/)
  })

  it('exempts the keys that double as a content tag, and only those', () => {
    expect(DOMAIN_TAGS_THAT_STAY).toEqual(['meta'])
    expect(prompt()).toMatch(/only exception is `meta`/)
  })

  it('still carries the parts that make the run safe', () => {
    const p = prompt()
    // Frontmatter-only: the semantic-tiling cache hashes bodies, and a backfill must not
    // invalidate it - nor create, delete or rename anything.
    expect(p).toMatch(/page bodies, titles, and wikilinks untouched/)
    expect(p).toMatch(/Do not create, delete, rename or merge any page/)
    expect(p).toMatch(/Do not invent new keys/)
    expect(p).toContain(UNASSIGNED)
  })
})

/* ------------------------------------------------------ splitting a domain (TASKS-DOMAIN-SPLIT phase 4) */

describe('replaceDomainSection', () => {
  it('replaces exactly the section and leaves the text before and after it byte for byte', () => {
    const next = replaceDomainSection(REGISTRY, 'biomedicine', { description: 'Narrowed.', tags: ['biomedical'] })!
    const start = REGISTRY.indexOf('## biomedicine')
    const end = REGISTRY.indexOf('## finance')
    expect(next.slice(0, start)).toBe(REGISTRY.slice(0, start))
    expect(next.slice(next.indexOf('## finance'))).toBe(REGISTRY.slice(end))
    expect(next.slice(start, next.indexOf('## finance'))).toBe('## biomedicine\n\nNarrowed.\n\n**Tags:** `biomedical`\n\n')
  })

  it('handles the last section of the file', () => {
    const next = replaceDomainSection(REGISTRY, 'meta', { description: 'Machinery, narrowed.', tags: [] })!
    expect(next.slice(0, REGISTRY.indexOf('## meta'))).toBe(REGISTRY.slice(0, REGISTRY.indexOf('## meta')))
    expect(next.endsWith('## meta\n\nMachinery, narrowed.\n')).toBe(true)
  })

  it('never touches a heading above the marker, and is null for a key it does not list', () => {
    expect(replaceDomainSection(REGISTRY, 'how a new domain is born', { description: 'x', tags: [] })).toBeNull()
    expect(replaceDomainSection(REGISTRY, 'cooking', { description: 'x', tags: [] })).toBeNull()
  })
})

describe('insertDomainSectionsAfter', () => {
  it('inserts directly after the section, in order, in the shape appendDomainSection writes', () => {
    const next = insertDomainSectionsAfter(REGISTRY, 'biomedicine', [
      { key: 'alpha', description: 'First child.', tags: ['a1', 'a2'] },
      { key: 'beta', description: 'Second child.', tags: [] },
    ])!
    expect(parseDomainRegistry(next).domains.map((d) => d.key)).toEqual(['biomedicine', 'alpha', 'beta', 'finance', 'meta'])
    expect(next).toContain('## alpha\n\nFirst child.\n\n**Tags:** `a1`, `a2`\n\n## beta\n\nSecond child.\n\n## finance')
    // Everything up to the end of the parent's section is untouched.
    const end = REGISTRY.indexOf('## finance')
    expect(next.slice(0, end)).toBe(REGISTRY.slice(0, end))
  })

  it('appends after a parent that is the last section', () => {
    const next = insertDomainSectionsAfter(REGISTRY, 'meta', [{ key: 'alpha', description: 'Child.', tags: [] }])!
    expect(parseDomainRegistry(next).domains.map((d) => d.key)).toEqual(['biomedicine', 'finance', 'meta', 'alpha'])
    expect(next.endsWith('## meta\n\nThe wiki\'s own machinery.\n\n## alpha\n\nChild.\n')).toBe(true)
  })

  it('is null for a missing parent, a taken key, or a key repeated among the entries', () => {
    expect(insertDomainSectionsAfter(REGISTRY, 'cooking', [{ key: 'alpha', description: 'x', tags: [] }])).toBeNull()
    expect(insertDomainSectionsAfter(REGISTRY, 'biomedicine', [{ key: 'finance', description: 'x', tags: [] }])).toBeNull()
    expect(
      insertDomainSectionsAfter(REGISTRY, 'biomedicine', [
        { key: 'alpha', description: 'x', tags: [] },
        { key: 'alpha', description: 'y', tags: [] },
      ]),
    ).toBeNull()
  })
})

describe('applyRegistrySplit', () => {
  const split = {
    parent: 'biomedicine',
    parentEntry: { description: 'Biology, narrowed.', tags: ['biomedical'] },
    children: [
      { key: 'drug-delivery', description: 'Getting drugs where they act.', tags: ['mrna-delivery', 'drug-delivery'] },
      { key: 'gene-editing', description: 'Changing genomes.', tags: [] },
    ],
  }

  it('lists the narrowed parent and the children directly after it, and nothing else changes', () => {
    const r = applyRegistrySplit(REGISTRY, split)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const parsed = parseDomainRegistry(r.markdown).domains
    expect(parsed.map((d) => d.key)).toEqual(['biomedicine', 'drug-delivery', 'gene-editing', 'finance', 'meta'])
    expect(parsed[0]).toEqual({ key: 'biomedicine', description: 'Biology, narrowed.', tags: ['biomedical'] })
    expect(parsed[1]!.tags).toEqual(['mrna-delivery', 'drug-delivery'])
    const before = parseDomainRegistry(REGISTRY).domains
    expect(parsed.slice(3)).toEqual(before.slice(1))
    // The conventions above `## Domains` untouched, byte for byte.
    const marker = REGISTRY.indexOf('## Domains')
    expect(r.markdown.slice(0, marker)).toBe(REGISTRY.slice(0, marker))
    // And what follows the parent's old section too.
    expect(r.markdown.slice(r.markdown.indexOf('## finance'))).toBe(REGISTRY.slice(REGISTRY.indexOf('## finance')))
  })

  it('refuses each case with its own reason and writes nothing', () => {
    expect(applyRegistrySplit(REGISTRY, { ...split, parent: 'cooking' })).toEqual({ ok: false, refusal: 'unknown-parent', key: 'cooking' })
    const child = (key: string) => ({ ...split, children: [{ key, description: 'x', tags: [] }] })
    expect(applyRegistrySplit(REGISTRY, child('finance'))).toEqual({ ok: false, refusal: 'duplicate-key', key: 'finance' })
    expect(applyRegistrySplit(REGISTRY, child('Not A Key'))).toEqual({ ok: false, refusal: 'invalid-key', key: 'Not A Key' })
    expect(applyRegistrySplit(REGISTRY, child('meta'))).toEqual({ ok: false, refusal: 'reserved-key', key: 'meta' })
    expect(applyRegistrySplit(REGISTRY, child(UNASSIGNED))).toEqual({ ok: false, refusal: 'reserved-key', key: UNASSIGNED })
    expect(
      applyRegistrySplit(REGISTRY, {
        ...split,
        children: [
          { key: 'alpha', description: 'x', tags: [] },
          { key: 'alpha', description: 'y', tags: [] },
        ],
      }),
    ).toEqual({ ok: false, refusal: 'duplicate-key', key: 'alpha' })
  })

  it('splits a parent that is the last section', () => {
    const r = applyRegistrySplit(REGISTRY, { parent: 'meta', parentEntry: { description: 'M.', tags: [] }, children: [{ key: 'alpha', description: 'A.', tags: [] }] })
    expect(r.ok && parseDomainRegistry(r.markdown).domains.map((d) => d.key)).toEqual(['biomedicine', 'finance', 'meta', 'alpha'])
  })
})

describe('draftParentEntry', () => {
  it('appends one sentence naming what left, and never keeps a tag a child lists', () => {
    const d = draftParentEntry(
      { description: 'Biology, medicine and drug delivery.', tags: ['mrna-delivery', 'biomedical', 'drug-delivery', 'genomics'] },
      [
        { key: 'drug-delivery', tags: ['mrna-delivery', 'Drug-Delivery'] },
        { key: 'gene-editing', tags: ['genomics'] },
        { key: 'imaging', tags: [] },
      ],
    )
    expect(d.description).toBe('Biology, medicine and drug delivery. Pages on `drug-delivery`, `gene-editing` and `imaging` have their own domains.')
    expect(d.tags).toEqual(['biomedical'])
  })

  it('reads right for one child and for two', () => {
    expect(draftParentEntry({ description: 'X.', tags: [] }, [{ key: 'a', tags: [] }]).description).toBe('X. Pages on `a` have their own domain.')
    expect(draftParentEntry({ description: 'X.', tags: [] }, [{ key: 'a', tags: [] }, { key: 'b', tags: [] }]).description).toBe(
      'X. Pages on `a` and `b` have their own domains.',
    )
  })
})
