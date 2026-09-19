/**
 * Upstream-protection guard for vault-writing agent runs (CLAUDE.md hard rule 5).
 *
 * The vault is a CLONE of the claude-obsidian repo: the plugin's machinery (skills/,
 * scripts/, bin/, docs/, hooks/, commands/, agents/, _templates/, root files like
 * CLAUDE.md) lives side by side with the user's knowledge under wiki/. Hard rule 5
 * forbids modifying the plugin's internals — but until now nothing ENFORCED that for
 * agent runs, whose sandbox legitimately allows writing anywhere under VAULT_ROOT.
 *
 * Two-part policy, deliberately narrow so no sanctioned flow is affected:
 *
 *  1. WRITABLE AREAS (allowlist, robust against future upstream additions): write tools
 *     may only touch wiki/, .raw/, .vault-meta/, assets/ and _attachments/. Everything
 *     else — plugin machinery and repo-root files — is refused. Reads stay unrestricted
 *     (skills READ their own docs constantly).
 *
 *  2. PROTECTED WIKI PAGES: the plugin ships documentation INSIDE wiki/ that skills
 *     consult by exact path (wiki/references/transport-fallback.md is read by 7 skills
 *     before vault mutations; methodology-modes by wiki-mode; getting-started is the
 *     onboarding page). These are derived from git — the files present under
 *     wiki/references/ + wiki/getting-started.md at the nearest reachable upstream tag
 *     (`git describe --tags`) — with a static fallback when the vault has no usable git
 *     history. NOT protected: the upstream demo wiki content.
 *
 *  3. SERVICE-OWNED HUBS (added 2026-09-19, SPEC.md §12.12): `wiki/index.md`, `wiki/log.md`
 *     and `wiki/overview.md` are written by the SERVICE after every run, from the pages
 *     themselves. A run that edits them is doing work that will be overwritten minutes later,
 *     and the refusal says where that work belongs instead - a run adapts to a reason and
 *     retries a bare "no". `wiki/hot.md` and the `_index.md` hubs stay writable: the hot cache
 *     is a semantic summary no generator can produce, and the bucket hubs carry curated prose.
 *
 *     The load-bearing mechanism is still regeneration, not this guard. An index derived from
 *     frontmatter is overwritten by the next run whatever a guard did or did not catch; the
 *     guard is here so a run does not waste a turn writing something that cannot survive.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * The hubs the service writes after every run (SPEC.md §12.12). An agent write to one is
 * refused with a reason that names the alternative, because a run that is told only "no"
 * retries, and a run that is told where the work goes adapts.
 *
 * `wiki/hot.md` is deliberately absent: it is a semantic summary of what matters right now,
 * no generator can produce it, and a lost update there costs a cache rather than knowledge.
 */
export const SERVICE_OWNED_HUBS: ReadonlySet<string> = new Set([
  'wiki/index.md',
  'wiki/log.md',
  'wiki/overview.md',
])

/** Top-level vault areas agent write tools may touch. Everything else is the plugin's. */
export const WRITABLE_AREAS: ReadonlySet<string> = new Set([
  'wiki',
  '.raw',
  '.vault-meta',
  'assets',
  '_attachments',
])

/**
 * The known plugin-doc pages inside wiki/, used when git can't answer (no repo, no
 * reachable tag). Kept in sync with claude-obsidian v1.9.2 — the derivation from git is
 * what keeps this honest across upgrades.
 */
export const FALLBACK_PROTECTED_WIKI: readonly string[] = [
  'wiki/getting-started.md',
  'wiki/references/methodology-modes.md',
  'wiki/references/transport-fallback.md',
]

/** Paths (vault-relative POSIX) whose files at the upstream tag count as protected. */
const PROTECTED_WIKI_SCOPES = ['wiki/references', 'wiki/getting-started.md'] as const

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep)

function git(vaultRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: vaultRoot,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/**
 * The plugin-shipped wiki pages, derived from the vault's own git history: whatever
 * lived under the protected scopes at the nearest reachable upstream tag. Falls back to
 * the static list on ANY failure — protection must never silently vanish because git
 * misbehaved.
 */
export function protectedWikiPages(vaultRoot: string): ReadonlySet<string> {
  try {
    const tag = git(vaultRoot, ['describe', '--tags', '--abbrev=0'])
    if (tag === '') return new Set(FALLBACK_PROTECTED_WIKI)
    const listing = git(vaultRoot, ['ls-tree', '-r', '--name-only', tag, '--', ...PROTECTED_WIKI_SCOPES])
    const files = listing.split('\n').map((l) => l.trim()).filter(Boolean)
    return files.length > 0 ? new Set(files) : new Set(FALLBACK_PROTECTED_WIKI)
  } catch {
    return new Set(FALLBACK_PROTECTED_WIKI)
  }
}

/**
 * Memoized `protectedWikiPages`. The derivation shells out to git twice, and the read-only
 * consumers ask per graph build and per page validation - a plugin upgrade means a service
 * restart anyway, which is exactly when the answer may change. The bare function stays
 * uncached so its own tests can re-derive against changing git state.
 */
const pluginDocsCache = new Map<string, ReadonlySet<string>>()

export function pluginDocPages(vaultRoot: string): ReadonlySet<string> {
  let pages = pluginDocsCache.get(vaultRoot)
  if (pages === undefined) {
    pages = protectedWikiPages(vaultRoot)
    pluginDocsCache.set(vaultRoot, pages)
  }
  return pages
}

export interface UpstreamGuard {
  /** Refusal reason for a WRITE to `resolvedPath` (absolute), or undefined to allow. */
  writeRefusalReason(resolvedPath: string): string | undefined
}

/** One guard per vault root; the protected set is derived once (a plugin upgrade means a service restart anyway). */
const guards = new Map<string, UpstreamGuard>()

export function createUpstreamGuard(vaultRoot: string): UpstreamGuard {
  const cached = guards.get(vaultRoot)
  if (cached !== undefined) return cached

  const protectedPages = pluginDocPages(vaultRoot)
  const guard: UpstreamGuard = {
    writeRefusalReason(resolvedPath: string): string | undefined {
      const rel = toPosix(path.relative(vaultRoot, resolvedPath))
      // Outside the vault (or the root itself) is the confinement check's business,
      // not this guard's — never double-report it here.
      if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
        return undefined
      }
      const top = rel.split('/')[0]!
      if (!WRITABLE_AREAS.has(top)) {
        return (
          `"${rel}" belongs to the claude-obsidian plugin, not the knowledge base. ` +
          `Agent runs may write only under wiki/, .raw/, .vault-meta/, assets/ and _attachments/.`
        )
      }
      if (protectedPages.has(rel)) {
        return (
          `"${rel}" is plugin-shipped documentation that skills consult by exact path ` +
          `(claude-obsidian upstream). It must not be edited by agent runs.`
        )
      }
      if (SERVICE_OWNED_HUBS.has(rel)) {
        return (
          `"${rel}" is written by the ingestion service after this run finishes, from the pages ` +
          `themselves - an edit here would be overwritten. Report what you did in your final ` +
          `answer instead: the service renders it into the log entry. Keep wiki/hot.md current ` +
          `yourself; that one is still yours.`
        )
      }
      return undefined
    },
  }
  guards.set(vaultRoot, guard)
  return guard
}
