/**
 * The write of a domain split (docs/tasks/TASKS-DOMAIN-SPLIT.md phases 5 and 6.6, SPEC.md §12.4
 * stage 4 part two): the parent's registry section narrowed, the children's sections inserted
 * after it, the `domain:` field of exactly the approved pages, and `wiki/index.md`, in ONE
 * commit that one revert undoes.
 *
 * A VAULT WRITER (CLAUDE.md hard rule 1, its row in the writer table). It takes the vault's
 * per-file locks itself, OUTSIDE the shared commit mutex, and writes and commits INSIDE it. It
 * also registers with `RunRegistry` for the whole apply, like a run does: a run that starts
 * while the split writes must not count itself the sole writer and sweep the split's files into
 * its own commit as leftovers (the F4 discipline `run-registry.ts` describes).
 *
 * WHAT IT DECIDES AND WHAT IT DOES NOT. The approval is the explicit page list, by `address:`
 * (D10). The apply re-clusters nothing: a page is written only while its `domain:` still equals
 * the parent key, and every page it leaves alone is reported with the reason. It never touches
 * a page's content, only the `domain:` line and `updated:`; `content_updated:` stays, because
 * the page still says the same thing (D13, SPEC.md §12.13).
 *
 * WHAT IT REFUSES, before any lock (D11): while an agent run writes the vault, and while the
 * service's git auto-commit is off, because the undo of a split is a revert and a split that
 * was never committed has none.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Mutex } from '../util/mutex.js'
import type { RunRegistry } from './run-registry.js'
import type { VaultGraph } from './graph.js'
import type { DomainSplitStore, SplitRecord } from '../db/domain-splits.js'
import { commitPaths, commitFileStatus, dirtyPaths, headHash, resetHardTo, revertCommit, unstagePaths, type CommitResult } from './git.js'
import { withWikiLocks } from './wiki-lock.js'
import { collectPages, renderIndex, type HubPage } from './hubs.js'
import { fieldOf, stampDates } from './page-dates.js'
import { diffOf } from './repair.js'
import {
  applyRegistrySplit,
  isValidDomainKey,
  parseDomainRegistry,
  DOMAIN_REGISTRY_PATH,
  RESERVED_DOMAIN_KEYS,
  type RegistrySplitRefusal,
} from './domains.js'
import { isKnowledge, keyCollision, SHELF_MIN_PAGES, type SplitProposal } from './domain-split.js'

/** The generated index, rewritten inside the split's own commit because it groups by domain (D9). */
export const INDEX_PATH = 'wiki/index.md'

/* ------------------------------------------------------------------------------ the request */

export interface SplitPageRequest {
  readonly address: string | null
  /** Where the page was when the proposal was made; only for the report, never trusted. */
  readonly path: string
}

export interface SplitChildRequest {
  readonly key: string
  readonly description: string
  readonly tags: readonly string[]
  readonly pages: readonly SplitPageRequest[]
}

export interface SplitRequest {
  readonly parent: string
  readonly parentEntry: { readonly description: string; readonly tags: readonly string[] }
  readonly children: readonly SplitChildRequest[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean) : []

/**
 * The request, validated before anything else (5.1). A merged shelf is simply one child with
 * the union of the pages: the server knows nothing about merges.
 *
 * Checks what the request itself can get wrong: keys valid, not reserved and not repeated, at
 * least one child, every child with a description and a page, every address listed once. That
 * a key is NEW is the registry's question and is asked against the registry by the plan and the
 * apply, so it cannot go stale between the two.
 */
export function parseSplitRequest(parent: string, body: unknown): { ok: true; request: SplitRequest } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const pe = (b['parentEntry'] ?? {}) as Record<string, unknown>
  const parentEntry = { description: str(pe['description']), tags: [...new Set(strList(pe['tags']))] }
  if (parentEntry.description === '') return { ok: false, error: 'the parent needs a description (parentEntry.description)' }
  const rawChildren = Array.isArray(b['children']) ? (b['children'] as unknown[]) : []
  if (rawChildren.length === 0) return { ok: false, error: 'a split needs at least one child' }

  const children: SplitChildRequest[] = []
  const keys = new Set<string>()
  const addresses = new Set<string>()
  for (const raw of rawChildren) {
    const c = (raw ?? {}) as Record<string, unknown>
    const key = str(c['key']).toLowerCase()
    if (!isValidDomainKey(key)) return { ok: false, error: `"${key}" is not a domain key: lowercase letters, digits and hyphens` }
    if (RESERVED_DOMAIN_KEYS.has(key)) return { ok: false, error: `"${key}" is reserved and can never be a new domain` }
    if (key === parent) return { ok: false, error: `a child cannot take the parent's own key "${key}"` }
    if (keys.has(key)) return { ok: false, error: `"${key}" is listed twice` }
    keys.add(key)
    const description = str(c['description'])
    if (description === '') return { ok: false, error: `"${key}" needs a description` }
    const rawPages = Array.isArray(c['pages']) ? (c['pages'] as unknown[]) : []
    if (rawPages.length === 0) return { ok: false, error: `"${key}" has no pages` }
    const pages: SplitPageRequest[] = []
    for (const rp of rawPages) {
      const p = (rp ?? {}) as Record<string, unknown>
      const address = str(p['address']) || null
      const rel = str(p['path'])
      if (address === null && rel === '') return { ok: false, error: `a page of "${key}" names neither an address nor a path` }
      if (address !== null) {
        if (addresses.has(address)) return { ok: false, error: `address ${address} is listed more than once` }
        addresses.add(address)
      }
      pages.push({ address, path: rel })
    }
    children.push({ key, description, tags: [...new Set(strList(c['tags']))], pages })
  }
  return { ok: true, request: { parent, parentEntry, children } }
}

/* ---------------------------------------------------------------------------- the pages */

export type PageVerdict = 'ok' | 'gone' | 'moved' | 'unaddressed'
export type SkipReason = Exclude<PageVerdict, 'ok'> | 'busy'

/** Where each address lives NOW, from the pages themselves (a page renamed since is still found). */
function pagesByAddress(pages: readonly HubPage[], parent: string): Map<string, HubPage> {
  const out = new Map<string, HubPage>()
  for (const p of pages) {
    if (p.address === null) continue
    const seen = out.get(p.address)
    // Addresses are unique in a healthy vault. If two pages share one, the one still in the
    // parent is the one the approval can have meant; otherwise the first by path, so the
    // answer does not depend on the walk order.
    if (seen === undefined || (seen.domain !== parent && (p.domain === parent || p.rel < seen.rel))) out.set(p.address, p)
  }
  return out
}

interface ResolvedPage {
  readonly address: string | null
  readonly child: string
  /** The CURRENT path, or the requested one when the address resolves to nothing. */
  readonly rel: string
  readonly verdict: PageVerdict
}

function resolve(request: SplitRequest, index: Map<string, HubPage>): ResolvedPage[] {
  const out: ResolvedPage[] = []
  for (const child of request.children) {
    for (const p of child.pages) {
      if (p.address === null) {
        out.push({ address: null, child: child.key, rel: p.path, verdict: 'unaddressed' })
        continue
      }
      const page = index.get(p.address)
      if (page === undefined) out.push({ address: p.address, child: child.key, rel: p.path, verdict: 'gone' })
      else out.push({ address: p.address, child: child.key, rel: page.rel, verdict: page.domain === request.parent ? 'ok' : 'moved' })
    }
  }
  return out
}

/**
 * The page's text with its `domain:` set to `key`, keeping the line's own quoting, and
 * `updated:` stamped; `content_updated:` is never touched. Null when the frontmatter carries no
 * `domain:` line to change - a page with none is not in the parent and never reaches here, and
 * one that lost its line since the check is left alone rather than given a new one.
 */
export function refileText(markdown: string, key: string, day?: string): string | null {
  const fm = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(markdown)
  if (fm === null) return null
  const front = fm[2]!
  const line = /^(domain:[ \t]*)(["']?)([^"'\r\n]*?)\2([ \t]*)$/m
  if (!line.test(front)) return null
  const nextFront = front.replace(line, (_m, head: string, q: string, _v: string, tail: string) => `${head}${q}${key}${q}${tail}`)
  const next = markdown.slice(0, fm[1]!.length) + nextFront + markdown.slice(fm[1]!.length + front.length)
  return stampDates(next, { content: false, ...(day !== undefined ? { day } : {}) })
}

/* ------------------------------------------------------------------------------- the plan */

export interface PlannedMove {
  readonly address: string | null
  readonly path: string
  readonly child: string
  readonly verdict: PageVerdict
  /** The line pair the apply would write, for an `ok` page. */
  readonly from?: string
  readonly to?: string
}

export type SplitWarning =
  | { readonly kind: 'parent-small'; readonly keeps: number; readonly min: number }
  | { readonly kind: 'key-collision'; readonly key: string; readonly inside: number; readonly elsewhere: number }
  | { readonly kind: 'misfile'; readonly key: string }

export interface SplitPlan {
  readonly parent: string
  /** The registry before and after, as a readable diff; `after` is what the apply writes. */
  readonly registry: { readonly diff: string; readonly sections: readonly string[] }
  readonly pages: readonly PlannedMove[]
  readonly counts: Readonly<Record<PageVerdict, number>>
  /** What `wiki/index.md` will show per domain heading, in registry order. */
  readonly index: ReadonlyArray<{ readonly domain: string; readonly pages: number }>
  readonly warnings: readonly SplitWarning[]
}

export class SplitRefused extends Error {
  constructor(
    readonly code:
      | 'run-active'
      | 'auto-commit-off'
      | 'no-registry'
      | 'registry-busy'
      | 'nothing-to-move'
      | 'unknown-split'
      | 'already-reverted'
      | 'orphans'
      | 'revert-failed'
      | RegistrySplitRefusal,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'SplitRefused'
  }
}

const REFUSAL_TEXT: Record<RegistrySplitRefusal, (key: string) => string> = {
  'unknown-parent': (k) => `the registry lists no domain "${k}"`,
  'duplicate-key': (k) => `domain "${k}" already exists`,
  'invalid-key': (k) => `"${k}" is not a domain key`,
  'reserved-key': (k) => `"${k}" is reserved and can never be a new domain`,
}

function readRegistry(vaultRoot: string): string {
  try {
    return fs.readFileSync(path.join(vaultRoot, DOMAIN_REGISTRY_PATH), 'utf8')
  } catch {
    throw new SplitRefused('no-registry', `no registry at ${DOMAIN_REGISTRY_PATH}`)
  }
}

function registryAfter(markdown: string, request: SplitRequest): string {
  const r = applyRegistrySplit(markdown, {
    parent: request.parent,
    parentEntry: request.parentEntry,
    children: request.children.map((c) => ({ key: c.key, description: c.description, tags: c.tags })),
  })
  if (!r.ok) throw new SplitRefused(r.refusal, REFUSAL_TEXT[r.refusal](r.key), { key: r.key })
  return r.markdown
}

/**
 * The dry run (5.2). Reads only; writes nothing, ever.
 *
 * `graph` and `proposal` feed the warnings (the collision counts come from `keyCollision`, the
 * misfiling flag from the shelves a child is made of); both are optional so the plan still
 * answers without them.
 */
export function planSplit(vaultRoot: string, request: SplitRequest, graph?: VaultGraph, proposal?: SplitProposal): SplitPlan {
  const before = readRegistry(vaultRoot)
  const after = registryAfter(before, request)
  const { pages: all } = collectPages(vaultRoot)
  const resolved = resolve(request, pagesByAddress(all, request.parent))

  const moves: PlannedMove[] = resolved.map((r) => {
    if (r.verdict !== 'ok') return { address: r.address, path: r.rel, child: r.child, verdict: r.verdict }
    let from: string | undefined
    try {
      from = /^domain:.*$/m.exec(fs.readFileSync(path.join(vaultRoot, r.rel), 'utf8'))?.[0]
    } catch {
      /* vanished since the walk: reported as the line it had */
    }
    return {
      address: r.address,
      path: r.rel,
      child: r.child,
      verdict: 'ok',
      from: from ?? `domain: ${request.parent}`,
      to: (from ?? `domain: ${request.parent}`).replace(/^(domain:[ \t]*)(["']?)[^"'\r\n]*?\2([ \t]*)$/, (_m, h: string, q: string, t: string) => `${h}${q}${r.child}${q}${t}`),
    }
  })
  const counts: Record<PageVerdict, number> = { ok: 0, gone: 0, moved: 0, unaddressed: 0 }
  for (const m of moves) counts[m.verdict]++

  // What the index will show: the pages per domain now, with the `ok` moves applied.
  const perDomain = new Map<string, number>()
  for (const p of all) perDomain.set(p.domain, (perDomain.get(p.domain) ?? 0) + 1)
  for (const m of moves) {
    if (m.verdict !== 'ok') continue
    perDomain.set(request.parent, (perDomain.get(request.parent) ?? 0) - 1)
    perDomain.set(m.child, (perDomain.get(m.child) ?? 0) + 1)
  }
  const order = parseDomainRegistry(after).domains.map((d) => d.key)
  const index = [...order, ...[...perDomain.keys()].filter((d) => !order.includes(d)).sort()]
    .filter((d) => (perDomain.get(d) ?? 0) > 0)
    .map((domain) => ({ domain, pages: perDomain.get(domain)! }))

  const warnings: SplitWarning[] = []
  if (graph !== undefined) {
    const keeps = graph.nodes.filter((n) => n.domain === request.parent && isKnowledge(n)).length - counts.ok
    if (keeps < SHELF_MIN_PAGES) warnings.push({ kind: 'parent-small', keeps, min: SHELF_MIN_PAGES })
    for (const c of request.children) {
      const paths = moves.filter((m) => m.child === c.key).map((m) => m.path)
      const col = keyCollision(graph, paths, c.key)
      if (col.inside > 0 || col.elsewhere > 0) warnings.push({ kind: 'key-collision', key: c.key, inside: col.inside, elsewhere: col.elsewhere })
    }
  }
  if (proposal !== undefined) {
    for (const c of request.children) {
      const mine = new Set(c.pages.map((p) => p.address).filter((a): a is string => a !== null))
      // A child carries the warning of any shelf it is mostly made of: a merge inherits it.
      const flagged = proposal.shelves.some((s) => s.misfile && s.pages.filter((m) => m.address !== null && mine.has(m.address)).length * 2 > s.size)
      if (flagged) warnings.push({ kind: 'misfile', key: c.key })
    }
  }

  return {
    parent: request.parent,
    registry: {
      diff: diffOf({ rel: DOMAIN_REGISTRY_PATH, before, after, why: 'split' }, 2),
      sections: [request.parent, ...request.children.map((c) => c.key)],
    },
    pages: moves,
    counts,
    index,
    warnings,
  }
}

/* ------------------------------------------------------------------------------ the write */

export interface SplitWriterOptions {
  /** The shared commit mutex. REQUIRED: a vault writer never commits outside it (hard rule 1). */
  readonly commitMutex: Mutex
  /** The registry of writing runs, shared with the queue and the maintenance runner. */
  readonly runRegistry: RunRegistry
  /** The service's gitAutoCommit setting, read at the moment of the apply. */
  readonly autoCommit: () => boolean
  readonly store: DomainSplitStore
  /** Injected in tests. */
  readonly lock?: typeof withWikiLocks
  readonly commit?: (vaultRoot: string, message: string, paths: readonly string[]) => Promise<CommitResult>
  readonly day?: string
  /** Test hook: runs between the commit and the read-back, which is what the read-back is for. */
  readonly afterCommit?: () => void
}

export interface SplitSkip {
  readonly address: string | null
  readonly path: string
  readonly reason: SkipReason
}

export interface SplitApplyResult {
  readonly splitId: string
  readonly commit: string
  readonly written: ReadonlyArray<{ readonly address: string | null; readonly path: string; readonly child: string }>
  readonly skipped: readonly SplitSkip[]
  /** True when every written page read back with its child key. */
  readonly verified: boolean
  /** Written pages whose `domain:` did not read back as their child key. */
  readonly unverified: readonly string[]
  readonly durationMs: number
}

/** The refusals that come before any lock (5.3), and the registration that brackets the write. */
async function beginWrite(vaultRoot: string, opts: SplitWriterOptions): Promise<() => void> {
  if (opts.commitMutex === undefined || typeof opts.commitMutex.runExclusive !== 'function') {
    throw new Error('the split writer needs the shared commit mutex: a vault writer never commits outside it')
  }
  if (!opts.autoCommit()) {
    throw new SplitRefused('auto-commit-off', 'a split is only offered with commits on, because its undo is a revert')
  }
  // The dirty set first (it is async), then the check and the registration with no await
  // between them, so no run can start in the gap and find itself the sole writer.
  const dirtyBefore = await dirtyPaths(vaultRoot)
  if (opts.runRegistry.activeRuns > 0) {
    throw new SplitRefused('run-active', 'a run is writing the vault - wait for it to finish, then try again')
  }
  return opts.runRegistry.begin(dirtyBefore)
}

interface Refile {
  readonly rel: string
  readonly address: string | null
  readonly child: string
}

/**
 * The shared core of the apply and the remainder: lock, re-check, write, one commit, read back.
 * `registry` is the registry's new text computed from what is on disk INSIDE the mutex, or null
 * when the registry is not part of this write (the remainder).
 */
async function refile(
  vaultRoot: string,
  parent: string,
  moves: readonly Refile[],
  subject: (written: number) => string,
  registry: ((current: string) => string) | null,
  opts: SplitWriterOptions,
): Promise<{ commit: string; written: Refile[]; busy: Refile[]; moved: Refile[]; unverified: string[] }> {
  const locks = opts.lock ?? withWikiLocks
  const commit = opts.commit ?? commitPaths
  const hubs = registry === null ? [INDEX_PATH] : [DOMAIN_REGISTRY_PATH, INDEX_PATH]
  const pagePaths = moves.map((m) => m.rel)

  return locks(vaultRoot, [...hubs, ...pagePaths], async (held, busyPaths) => {
    // A split without its registry change is not a split, and an index left behind would list
    // every moved page under the wrong heading: either one busy refuses the whole write.
    const busyHub = hubs.find((h) => busyPaths.includes(h))
    if (busyHub !== undefined) {
      throw new SplitRefused('registry-busy', `${busyHub} is being written right now - try again in a moment`, { path: busyHub })
    }
    const heldSet = new Set(held)
    const busy = moves.filter((m) => !heldSet.has(m.rel))

    return opts.commitMutex.runExclusive(async () => {
      const originals = new Map<string, string | null>()
      const read = (rel: string): string | null => {
        try {
          return fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
        } catch {
          return null
        }
      }
      // Everything is computed before anything is written, so a refusal writes nothing.
      const nextRegistry = registry === null ? null : registry(read(DOMAIN_REGISTRY_PATH) ?? '')
      const written: Refile[] = []
      const moved: Refile[] = []
      const texts = new Map<string, string>()
      for (const m of moves) {
        if (!heldSet.has(m.rel)) continue
        const text = read(m.rel)
        if (text === null || fieldOf(text, 'domain') !== parent) {
          moved.push(m)
          continue
        }
        const next = refileText(text, m.child, opts.day)
        if (next === null) {
          moved.push(m)
          continue
        }
        originals.set(m.rel, text)
        texts.set(m.rel, next)
        written.push(m)
      }
      if (written.length === 0) {
        throw new SplitRefused('nothing-to-move', 'no approved page can be moved: every one is busy, gone or no longer in the parent', {
          busy: busy.length,
          moved: moved.length,
        })
      }

      const restore = (): void => {
        for (const [rel, text] of originals) {
          if (text === null) fs.rmSync(path.join(vaultRoot, rel), { force: true })
          else fs.writeFileSync(path.join(vaultRoot, rel), text, 'utf8')
        }
      }
      let hash: string | undefined
      try {
        for (const [rel, text] of texts) fs.writeFileSync(path.join(vaultRoot, rel), text, 'utf8')
        if (nextRegistry !== null) {
          originals.set(DOMAIN_REGISTRY_PATH, read(DOMAIN_REGISTRY_PATH))
          fs.writeFileSync(path.join(vaultRoot, DOMAIN_REGISTRY_PATH), nextRegistry, 'utf8')
        }
        // After the registry, because the index orders its headings by it.
        originals.set(INDEX_PATH, read(INDEX_PATH))
        fs.writeFileSync(path.join(vaultRoot, INDEX_PATH), renderIndex(vaultRoot), 'utf8')
        const result = await commit(vaultRoot, subject(written.length), [
          ...(nextRegistry !== null ? [DOMAIN_REGISTRY_PATH] : []),
          INDEX_PATH,
          ...written.map((w) => w.rel),
        ])
        hash = result.committed ? result.hash : undefined
      } catch (err) {
        // All or nothing: the files go back to what they were, unstaged, and the error goes up.
        restore()
        await unstagePaths(vaultRoot, [...originals.keys()]).catch(() => undefined)
        throw err
      }
      if (hash === undefined) {
        restore()
        await unstagePaths(vaultRoot, [...originals.keys()]).catch(() => undefined)
        throw new Error('the split wrote nothing git could commit')
      }

      opts.afterCommit?.()
      const unverified = written.filter((w) => fieldOf(read(w.rel) ?? '', 'domain') !== w.child).map((w) => w.rel)
      return { commit: hash, written, busy, moved, unverified }
    })
  })
}

/** Addresses resolved against the vault as it is now, for the apply and the remainder. */
function currentIndex(vaultRoot: string, parent: string): Map<string, HubPage> {
  return pagesByAddress(collectPages(vaultRoot).pages, parent)
}

/**
 * The split (5.4): the registry, the approved pages and the index in ONE commit, subject
 * `domains: split <parent> into <k> (<n> pages)` - keys and counts, never a title.
 */
export async function applySplit(vaultRoot: string, request: SplitRequest, opts: SplitWriterOptions): Promise<SplitApplyResult> {
  const started = Date.now()
  const end = await beginWrite(vaultRoot, opts)
  try {
    // Checked against the registry now, so a refusal answers before a single lock is taken.
    registryAfter(readRegistry(vaultRoot), request)
    const resolved = resolve(request, currentIndex(vaultRoot, request.parent))
    const skipped: SplitSkip[] = resolved
      .filter((r) => r.verdict !== 'ok')
      .map((r) => ({ address: r.address, path: r.rel, reason: r.verdict as SkipReason }))
    const moves = resolved.filter((r) => r.verdict === 'ok').map((r) => ({ rel: r.rel, address: r.address, child: r.child }))
    if (moves.length === 0) {
      throw new SplitRefused('nothing-to-move', 'no approved page is still in the parent', { skipped: skipped.length })
    }
    const out = await refile(
      vaultRoot,
      request.parent,
      moves,
      (n) => `domains: split ${request.parent} into ${request.children.length} (${n} pages)`,
      (current) => registryAfter(current, request),
      opts,
    )
    const rec = opts.store.create(
      request.parent,
      request.children.map((c) => ({ key: c.key, addresses: c.pages.map((p) => p.address).filter((a): a is string => a !== null) })),
      out.commit,
    )
    return {
      splitId: rec.id,
      commit: out.commit,
      written: out.written.map((w) => ({ address: w.address, path: w.rel, child: w.child })),
      skipped: [
        ...skipped,
        ...out.busy.map((b) => ({ address: b.address, path: b.rel, reason: 'busy' as const })),
        ...out.moved.map((m) => ({ address: m.address, path: m.rel, reason: 'moved' as const })),
      ],
      verified: out.unverified.length === 0,
      unverified: out.unverified,
      durationMs: Date.now() - started,
    }
  } finally {
    end()
  }
}

/* -------------------------------------------------------------------------- the remainder */

export interface RemainderPage {
  readonly address: string
  readonly path: string
  readonly child: string
}

/**
 * The pages of an applied split whose `domain:` is still, or again, the parent (D12). A page
 * that went elsewhere by the user's hand is not remainder; neither is a page that is gone.
 */
export function remainderOf(vaultRoot: string, rec: SplitRecord, index?: Map<string, HubPage>): RemainderPage[] {
  const byAddress = index ?? currentIndex(vaultRoot, rec.parent)
  const out: RemainderPage[] = []
  for (const child of rec.children) {
    for (const address of child.addresses) {
      const page = byAddress.get(address)
      if (page !== undefined && page.domain === rec.parent) out.push({ address, path: page.rel, child: child.key })
    }
  }
  return out
}

export interface SplitSummary extends SplitRecord {
  readonly remainder: number
}

/** Every applied split with its live remainder count, one vault walk for all of them. */
export function listSplits(vaultRoot: string, store: DomainSplitStore): SplitSummary[] {
  const records = store.list()
  if (records.length === 0) return []
  const pages = collectPages(vaultRoot).pages
  return records.map((rec) => ({
    ...rec,
    remainder: rec.revertedAt !== null ? 0 : remainderOf(vaultRoot, rec, pagesByAddress(pages, rec.parent)).length,
  }))
}

/**
 * Re-files the remainder (5.5): the same writer over the pages still in the parent. The registry
 * is untouched (its sections exist); one commit, subject `domains: re-file <n> pages after the
 * split of <parent>`, added to the split's record so its revert takes it back too.
 */
export async function applyRemainder(
  vaultRoot: string,
  splitId: string,
  opts: SplitWriterOptions,
): Promise<{ commit: string; written: RemainderPage[]; skipped: SplitSkip[] }> {
  const rec = opts.store.get(splitId)
  if (rec === undefined) throw new SplitRefused('unknown-split', `no split ${splitId}`)
  if (rec.revertedAt !== null) throw new SplitRefused('already-reverted', 'this split was reverted')
  const end = await beginWrite(vaultRoot, opts)
  try {
    const pages = remainderOf(vaultRoot, rec)
    if (pages.length === 0) throw new SplitRefused('nothing-to-move', 'the remainder is empty')
    const out = await refile(
      vaultRoot,
      rec.parent,
      pages.map((p) => ({ rel: p.path, address: p.address, child: p.child })),
      (n) => `domains: re-file ${n} ${n === 1 ? 'page' : 'pages'} after the split of ${rec.parent}`,
      null,
      opts,
    )
    opts.store.addCommit(rec.id, out.commit)
    const byRel = new Map(pages.map((p) => [p.path, p]))
    return {
      commit: out.commit,
      written: out.written.map((w) => byRel.get(w.rel)!),
      skipped: [
        ...out.busy.map((b) => ({ address: b.address, path: b.rel, reason: 'busy' as const })),
        ...out.moved.map((m) => ({ address: m.address, path: m.rel, reason: 'moved' as const })),
      ],
    }
  } finally {
    end()
  }
}

/* ---------------------------------------------------------------------------- the revert */

/**
 * Reverts a split (6.6, D17): its commits newest first, through `revertCommit` (clean tree,
 * all-or-nothing apply, behind the commit mutex), then one commit that re-renders the index,
 * which `revertCommit` leaves alone on purpose because it is derived.
 *
 * It REFUSES, naming the pages, while any page outside the split's commits carries one of its
 * child keys: reverting the registry would leave that page with a key the registry no longer
 * lists, which is the orphaning the split exists to avoid. The user re-files or reverts those
 * first. A conflict on any commit puts HEAD back where it was, so the vault is left exactly as
 * it was found.
 */
export async function revertSplit(
  vaultRoot: string,
  splitId: string,
  opts: SplitWriterOptions,
): Promise<{ commits: string[]; indexCommit: string | null }> {
  const rec = opts.store.get(splitId)
  if (rec === undefined) throw new SplitRefused('unknown-split', `no split ${splitId}`)
  if (rec.revertedAt !== null) throw new SplitRefused('already-reverted', 'this split was reverted already')
  const end = await beginWrite(vaultRoot, opts)
  try {
    const keys = new Set(rec.children.map((c) => c.key))
    const touched = new Set<string>()
    for (const hash of rec.commits) for (const p of (await commitFileStatus(vaultRoot, hash)).keys()) touched.add(p)
    const orphans = collectPages(vaultRoot)
      .pages.filter((p) => keys.has(p.domain) && !touched.has(p.rel))
      .map((p) => p.rel)
      .sort()
    if (orphans.length > 0) {
      throw new SplitRefused(
        'orphans',
        `${orphans.length} ${orphans.length === 1 ? 'page carries' : 'pages carry'} one of this split's keys without the split having put it there - re-file or revert ${orphans.length === 1 ? 'it' : 'them'} first`,
        { pages: orphans },
      )
    }

    return await opts.commitMutex.runExclusive(async () => {
      const before = await headHash(vaultRoot)
      const done: string[] = []
      for (const hash of [...rec.commits].reverse()) {
        const r = await revertCommit(vaultRoot, hash, `domains: revert ${hash.slice(0, 8)}, part of the split of ${rec.parent}`)
        if (r.reverted && r.hash !== undefined) {
          done.push(r.hash)
          continue
        }
        if (r.refusal === 'already-reverted') continue
        // Undo the reverts this call already made: all or nothing, like each revert on its own.
        if (before !== null && done.length > 0) await resetHardTo(vaultRoot, before)
        throw new SplitRefused('revert-failed', r.message ?? `reverting ${hash.slice(0, 8)} failed`, { refusal: r.refusal ?? null })
      }
      fs.writeFileSync(path.join(vaultRoot, INDEX_PATH), renderIndex(vaultRoot), 'utf8')
      const commit = opts.commit ?? commitPaths
      const idx = await commit(vaultRoot, `domains: re-render the index after reverting the split of ${rec.parent}`, [INDEX_PATH])
      opts.store.markReverted(rec.id)
      return { commits: done, indexCommit: idx.committed ? (idx.hash ?? null) : null }
    })
  } finally {
    end()
  }
}
