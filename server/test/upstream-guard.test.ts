/**
 * Upstream-protection guard (CLAUDE.md hard rule 5): plugin machinery and shipped doc
 * pages must not be writable by agent runs. The git-derived protected set runs against a
 * REAL repo — the derivation (nearest reachable tag, ls-tree scopes) is the part a mock
 * could not verify.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  createUpstreamGuard,
  protectedWikiPages,
  FALLBACK_PROTECTED_WIKI,
} from '../src/pipeline/upstream-guard.js'
import { decidePermission } from '../src/pipeline/permissions.js'

let repo: string
const git = (...args: string[]): void => {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
}
const write = (rel: string, body = 'x'): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), body)
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-upstream-'))
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
})
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

describe('protectedWikiPages', () => {
  it('derives the shipped doc pages from the nearest reachable tag', () => {
    write('wiki/getting-started.md')
    write('wiki/references/transport-fallback.md')
    write('wiki/references/methodology-modes.md')
    write('wiki/concepts/Demo.md') // upstream demo CONTENT — not in the protected scopes
    git('add', '-A')
    git('commit', '-q', '-m', 'upstream release')
    git('tag', 'v9.9.9')
    // Local work after the clone point: a new reference page the USER created is not
    // protected — only what the tag shipped is.
    write('wiki/references/my-own-cheatsheet.md')
    git('add', '-A')
    git('commit', '-q', '-m', 'local')

    const pages = protectedWikiPages(repo)
    expect(pages).toEqual(
      new Set([
        'wiki/getting-started.md',
        'wiki/references/methodology-modes.md',
        'wiki/references/transport-fallback.md',
      ]),
    )
  })

  it('falls back to the static list without a repo or without tags', () => {
    const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-norepo-'))
    try {
      expect(protectedWikiPages(noRepo)).toEqual(new Set(FALLBACK_PROTECTED_WIKI))
    } finally {
      fs.rmSync(noRepo, { recursive: true, force: true })
    }
    // A repo with commits but no tag reachable also falls back.
    write('wiki/references/transport-fallback.md')
    git('add', '-A')
    git('commit', '-q', '-m', 'untagged')
    expect(protectedWikiPages(repo)).toEqual(new Set(FALLBACK_PROTECTED_WIKI))
  })
})

describe('createUpstreamGuard.writeRefusalReason', () => {
  it('refuses plugin machinery and repo-root files, allows the writable areas', () => {
    const guard = createUpstreamGuard(repo)
    const refuse = (rel: string): string | undefined =>
      guard.writeRefusalReason(path.join(repo, rel))

    // Plugin machinery — refused whatever the git state is.
    expect(refuse('skills/wiki-ingest/SKILL.md')).toContain('claude-obsidian plugin')
    expect(refuse('scripts/wiki-mode.py')).toBeDefined()
    expect(refuse('bin/setup-mode.sh')).toBeDefined()
    expect(refuse('docs/methodology-modes-guide.md')).toBeDefined()
    expect(refuse('_templates/concept.md')).toBeDefined()
    expect(refuse('CLAUDE.md')).toBeDefined() // repo-root file
    // Shipped wiki docs (fallback list here — the temp repo has no tag).
    expect(refuse('wiki/references/transport-fallback.md')).toContain('plugin-shipped')
    expect(refuse('wiki/getting-started.md')).toBeDefined()
    // The knowledge base and operational state stay writable.
    expect(refuse('wiki/concepts/Compound Interest.md')).toBeUndefined()
    // The service-owned hubs are refused since 2026-09-19 (SPEC.md §12.12); the hot cache and
    // the bucket hubs are still the agent's. Covered in full further down.
    expect(refuse('wiki/index.md')).toBeDefined()
    expect(refuse('wiki/hot.md')).toBeUndefined()
    expect(refuse('wiki/meta/lint-report-2026-07-19.md')).toBeUndefined()
    expect(refuse('.raw/01ABC/normalized.md')).toBeUndefined()
    expect(refuse('.vault-meta/address-counter.txt')).toBeUndefined()
    expect(refuse('assets/img.png')).toBeUndefined()
    // Outside the vault is the confinement check's business, not the guard's.
    expect(guard.writeRefusalReason('/tmp/elsewhere')).toBeUndefined()
  })

  it('is enforced by decidePermission for write tools only', () => {
    const guard = createUpstreamGuard(repo)
    const ctx = { vaultRoot: repo, writeGuard: guard.writeRefusalReason }
    const skillPath = path.join(repo, 'skills/wiki-ingest/SKILL.md')

    const write = decidePermission(ctx, 'Write', { file_path: skillPath, content: 'x' })
    expect(write.behavior).toBe('deny')
    const edit = decidePermission(ctx, 'Edit', { file_path: skillPath })
    expect(edit.behavior).toBe('deny')
    // Reading plugin files is fine — skills consult their own docs.
    const read = decidePermission(ctx, 'Read', { file_path: skillPath })
    expect(read.behavior).toBe('allow')
    // Knowledge pages stay writable through the same path.
    const page = decidePermission(ctx, 'Write', {
      file_path: path.join(repo, 'wiki/concepts/New.md'),
      content: 'x',
    })
    expect(page.behavior).toBe('allow')
  })
})

/**
 * The hubs the service writes (SPEC.md §12.12, task 2.5). The load-bearing mechanism is
 * regeneration, not this guard: an index derived from frontmatter is overwritten by the next
 * run whatever a guard caught. The guard is here so a run does not spend a turn writing
 * something that cannot survive - and so the refusal can say where the work belongs instead.
 */
describe('the service-owned hubs', () => {
  it('refuses a write to each hub the service owns', () => {
    const guard = createUpstreamGuard(repo)
    for (const hub of ['wiki/index.md', 'wiki/log.md', 'wiki/overview.md']) {
      const reason = guard.writeRefusalReason(path.join(repo, hub))
      expect(reason, hub).toBeDefined()
      expect(reason).toContain('written by the ingestion service')
    }
  })

  it('names the alternative, because a run that is told only "no" retries', () => {
    const reason = createUpstreamGuard(repo).writeRefusalReason(path.join(repo, 'wiki/log.md')) ?? ''
    expect(reason).toContain('final answer')
    expect(reason).toContain('wiki/hot.md')
  })

  it('leaves the hot cache and the bucket hubs with the agent', () => {
    const guard = createUpstreamGuard(repo)
    // hot.md is a semantic summary no generator can produce, and the bucket hubs carry
    // curated one-line descriptions per page.
    expect(guard.writeRefusalReason(path.join(repo, 'wiki/hot.md'))).toBeUndefined()
    expect(guard.writeRefusalReason(path.join(repo, 'wiki/concepts/_index.md'))).toBeUndefined()
    expect(guard.writeRefusalReason(path.join(repo, 'wiki/concepts/A Page.md'))).toBeUndefined()
  })

  it('is enforced by decidePermission for writes and edits, not for reads', () => {
    const guard = createUpstreamGuard(repo)
    const ctx = { vaultRoot: repo, writeGuard: guard.writeRefusalReason }
    const index = path.join(repo, 'wiki/index.md')
    expect(decidePermission(ctx, 'Write', { file_path: index, content: 'x' }).behavior).toBe('deny')
    expect(decidePermission(ctx, 'Edit', { file_path: index }).behavior).toBe('deny')
    // Reading the index stays allowed: a run may legitimately want to know what exists.
    expect(decidePermission(ctx, 'Read', { file_path: index }).behavior).toBe('allow')
  })

  it('holds for every write profile, including research and maintenance', () => {
    const guard = createUpstreamGuard(repo)
    for (const profile of ['ingest', 'research'] as const) {
      const ctx = { vaultRoot: repo, profile, writeGuard: guard.writeRefusalReason }
      expect(decidePermission(ctx, 'Write', { file_path: path.join(repo, 'wiki/index.md'), content: 'x' }).behavior).toBe('deny')
      expect(decidePermission(ctx, 'Write', { file_path: path.join(repo, 'wiki/hot.md'), content: 'x' }).behavior).toBe('allow')
    }
  })
})
