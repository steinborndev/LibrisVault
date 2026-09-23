/**
 * The domain registry (SPEC.md §12.4, Meta-Kategorien Stufe 2) — the list of meta-categories
 * pages may be filed under, read from the vault page `wiki/meta/domains.md`.
 *
 * The registry lives in the VAULT, not in this repo or SQLite, and that is deliberate: it is
 * git-versioned with the content it describes, editable in the dashboard's own page editor,
 * and readable by an agent run without any extra plumbing. `scripts/vault-extensions/domains.md`
 * holds the seed copy that `scripts/install-domain-registry.sh` installs; once installed, the
 * vault's copy is the source of truth and this module only ever READS it (hard rule 1).
 *
 * Absent registry = feature off, not an error: ingest runs then get no domain instruction and
 * the backfill refuses to run. That keeps a fresh checkout working before setup.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Vault-relative location of the registry page. */
export const DOMAIN_REGISTRY_PATH = 'wiki/meta/domains.md'

/** The sentinel a page carries when no domain in the registry fits it. */
export const UNASSIGNED = 'unassigned'

export interface DomainEntry {
  /** The key written into a page's `domain:` frontmatter, e.g. `biomedicine`. */
  readonly key: string
  /** First prose paragraph under the heading — what the domain covers. */
  readonly description: string
  /** Tags listed as classification guidance (lowercased, deduped). */
  readonly tags: readonly string[]
}

export interface DomainRegistry {
  readonly domains: readonly DomainEntry[]
  /** Where it was read from (vault-relative), for diagnostics. */
  readonly path: string
}

/**
 * Parses the registry page. The format is prose-first so the page stays readable and
 * hand-editable: each domain is an `## <key>` section under the `## Domains` marker, with an
 * optional `**Tags:** \`a\`, \`b\`` line. Everything above `## Domains` is documentation for
 * the human and is skipped — that is why the marker exists.
 */
export function parseDomainRegistry(markdown: string, from: string = DOMAIN_REGISTRY_PATH): DomainRegistry {
  // Body only: a `## Domains` line inside the frontmatter block would be nonsense, but
  // stripping frontmatter first also keeps a `related:` list from ever being read as prose.
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const marker = body.search(/^##[ \t]+Domains[ \t]*$/m)
  if (marker < 0) return { domains: [], path: from }

  const after = body.slice(marker).split(/\r?\n/).slice(1) // drop the marker line itself
  const domains: DomainEntry[] = []
  const seen = new Set<string>()
  let current: { key: string; description: string[]; tags: string[]; descDone: boolean; inTags: boolean } | null = null

  const flush = (): void => {
    if (!current) return
    // A duplicated key would silently shadow; first definition wins, like wikilink resolution.
    if (!seen.has(current.key)) {
      seen.add(current.key)
      domains.push({
        key: current.key,
        description: current.description.join(' ').trim(),
        tags: [...new Set(current.tags)],
      })
    }
    current = null
  }

  for (const line of after) {
    const heading = line.match(/^##[ \t]+(.+?)[ \t]*$/)
    if (heading) {
      flush()
      const key = heading[1]!.trim().toLowerCase()
      // Only registry-shaped keys start a domain; a prose subheading ("How this works") can't.
      current = /^[a-z0-9][a-z0-9-]*$/.test(key)
        ? { key, description: [], tags: [], descDone: false, inTags: false }
        : null
      continue
    }
    if (!current) continue
    const tagLine = line.match(/^\*\*Tags:\*\*[ \t]*(.*)$/)
    if (tagLine) {
      for (const m of tagLine[1]!.matchAll(/`([^`]+)`/g)) current.tags.push(m[1]!.trim().toLowerCase())
      current.descDone = true
      current.inTags = true
      continue
    }
    // Description is the LEAD paragraph only: the first blank line after prose closes it, so
    // a section may carry further notes for the human without bloating the agent instruction.
    if (line.trim() === '') {
      if (current.description.length > 0) current.descDone = true
      current.inTags = false
      continue
    }
    // A long tag list wraps across lines; keep collecting until a blank line ends it. Without
    // this, everything past the first wrap is silently dropped (found in a live vault, where
    // the seed registry's 12-tag domains arrived with 4).
    if (current.inTags) {
      for (const m of line.matchAll(/`([^`]+)`/g)) current.tags.push(m[1]!.trim().toLowerCase())
      continue
    }
    if (!current.descDone) current.description.push(line.trim())
  }
  flush()

  return { domains, path: from }
}

/** Reads and parses the registry, or returns null when the vault has none installed. */
export function readDomainRegistry(vaultRoot: string): DomainRegistry | null {
  const abs = path.join(vaultRoot, DOMAIN_REGISTRY_PATH)
  let markdown: string
  try {
    markdown = fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
  const registry = parseDomainRegistry(markdown)
  return registry.domains.length > 0 ? registry : null
}

/** A registry key: lowercase, hyphenated, no spaces — same shape the parser accepts. */
export const isValidDomainKey = (key: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(key)

/**
 * Appends a new domain section to the registry markdown, in the same shape the seed uses so a
 * grown registry stays indistinguishable from a hand-written one.
 *
 * Returns null when the key already exists (the caller turns that into a 409) — adding a
 * duplicate would silently shadow, since the parser lets the first definition win.
 */
export function appendDomainSection(
  markdown: string,
  entry: { key: string; description: string; tags: readonly string[] },
): string | null {
  const existing = parseDomainRegistry(markdown)
  if (existing.domains.some((d) => d.key === entry.key)) return null

  const tagLine =
    entry.tags.length > 0 ? `\n\n**Tags:** ${entry.tags.map((t) => `\`${t}\``).join(', ')}` : ''
  const section = `\n## ${entry.key}\n\n${entry.description.trim()}${tagLine}\n`
  // Exactly one blank line between sections, whatever trailing whitespace the file had.
  return `${markdown.replace(/\s*$/, '')}\n${section}`
}

/**
 * The system-prompt extension handed to vault-writing runs, or '' when no registry exists.
 *
 * This is the guardrail that stops the drift Stufe 1 measured: the agent may only pick a
 * listed key or `unassigned`, and explicitly may NOT coin a new one. New domains are a human
 * decision made by editing the registry page (SPEC.md §12.4 Stufe 3).
 */
export function domainSystemPrompt(registry: DomainRegistry | null): string {
  if (!registry || registry.domains.length === 0) return ''
  const list = registry.domains
    .map((d) => {
      const tags = d.tags.length > 0 ? `\n  typical tags: ${d.tags.join(', ')}` : ''
      return `- ${d.key} - ${d.description}${tags}`
    })
    .join('\n')
  return `
<domain_registry>
Every wiki page you create or substantially rewrite must carry a \`domain:\` field in its
YAML frontmatter, holding EXACTLY ONE key from this closed list:

${list}
- ${UNASSIGNED} - nothing above fits this page.

Rules:
- Never invent a domain key that is not on this list. If no listed domain fits, use
  \`${UNASSIGNED}\`. That is a correct, expected outcome, not a failure - new domains are
  added by a human editing ${DOMAIN_REGISTRY_PATH}, never by an ingest run.
- The tag hints are guidance, not a lookup table. Classify by what the page is ABOUT.
- Ignore entity-shaped tags (person, organization, product, researcher) when classifying:
  they describe what a page IS, not what it is about.
- The field goes on EVERY page type - sources and entities too, not just concepts. Filtering
  the graph by domain is the point, and it only works if every page carries one.
- Set \`domain:\` on pages you create. Do not retrofit unrelated existing pages in an ingest
  run; a separate backfill handles those.
</domain_registry>
`.trim()
}

/* ------------------------------------------------------------ splitting a domain (stage 4) */

/*
 * The registry operations of a split (docs/tasks/TASKS-DOMAIN-SPLIT.md phase 4). Pure, like
 * `appendDomainSection`, and for the same reason: the writer that calls them takes the locks
 * and makes the commit, and everything that decides what the text becomes is testable without
 * a vault.
 *
 * "The registry stays append-only" held until the split (analysis R1): a child that leaves its
 * parent has to take the parent's claim on its subject with it, or every later ingest meets the
 * broad parent first and the specific child after it, and the parent re-grows. So the parent's
 * section is REPLACED, narrowed, and the children are inserted DIRECTLY after it, so siblings
 * stand together in the prompt. Merging, renaming and retiring stay out of scope (D18).
 */

/** Keys a split can never coin: the registry's own escape hatch and its machinery. */
export const RESERVED_DOMAIN_KEYS: ReadonlySet<string> = new Set(['meta', UNASSIGNED])

interface SectionSpan {
  /** Offset of the `## key` heading line. */
  readonly start: number
  /** Offset of the next `## ` heading, or the end of the text. */
  readonly end: number
}

/**
 * Where the section of `key` sits in the raw text, or null. Only headings AFTER the
 * `## Domains` marker count, which is the parser's own rule: a heading in the conventions above
 * it is documentation, whatever it says.
 */
function sectionSpan(markdown: string, key: string): SectionSpan | null {
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
  const bodyStart = fm === null ? 0 : fm[0].length
  const marker = /^##[ \t]+Domains[ \t]*$/m.exec(markdown.slice(bodyStart))
  if (marker === null) return null
  const from = bodyStart + marker.index + marker[0].length
  const headings = [...markdown.slice(from).matchAll(/^##[ \t]+(.+?)[ \t]*\r?$/gm)].map((m) => ({
    at: from + m.index,
    key: m[1]!.trim().toLowerCase(),
  }))
  // The first definition wins, as in the parser: that is the section an ingest reads.
  const i = headings.findIndex((h) => h.key === key)
  if (i < 0) return null
  return { start: headings[i]!.at, end: headings[i + 1]?.at ?? markdown.length }
}

/** A section in the shape `appendDomainSection` writes, without its surrounding whitespace. */
function renderSection(entry: { key: string; description: string; tags: readonly string[] }): string {
  const tagLine = entry.tags.length > 0 ? `\n\n**Tags:** ${entry.tags.map((t) => `\`${t}\``).join(', ')}` : ''
  return `## ${entry.key}\n\n${entry.description.trim()}${tagLine}`
}

/**
 * Replaces exactly the section of `key`, from its `## key` heading to the next `## ` heading or
 * the end, and preserves every other byte - the whitespace that separated it from the next
 * section included. Null when the registry lists no such key.
 */
export function replaceDomainSection(
  markdown: string,
  key: string,
  entry: { description: string; tags: readonly string[] },
): string | null {
  const span = sectionSpan(markdown, key)
  if (span === null) return null
  const old = markdown.slice(span.start, span.end)
  const trailing = /\s*$/.exec(old)![0]
  return (
    markdown.slice(0, span.start) +
    renderSection({ key, description: entry.description, tags: entry.tags }) +
    (trailing === '' ? '\n' : trailing) +
    markdown.slice(span.end)
  )
}

/**
 * Inserts the sections directly after `afterKey`'s, in the given order and in the shape
 * `appendDomainSection` writes. Null when `afterKey` is missing, when any key exists already,
 * or when the entries repeat a key among themselves.
 */
export function insertDomainSectionsAfter(
  markdown: string,
  afterKey: string,
  entries: ReadonlyArray<{ key: string; description: string; tags: readonly string[] }>,
): string | null {
  const span = sectionSpan(markdown, afterKey)
  if (span === null) return null
  const existing = new Set(parseDomainRegistry(markdown).domains.map((d) => d.key))
  const keys = entries.map((e) => e.key)
  if (keys.some((k) => existing.has(k)) || new Set(keys).size !== keys.length) return null
  if (entries.length === 0) return markdown

  const before = markdown.slice(0, span.end)
  const after = markdown.slice(span.end)
  const blocks = entries.map(renderSection).join('\n\n')
  if (after === '') {
    // The parent is the last section: append after it, one blank line between, one newline at the end.
    return `${before.replace(/\s*$/, '')}\n\n${blocks}\n`
  }
  // `before` ends in the whitespace that separated the parent from its next section; the new
  // sections take the same separator, so the file reads as if it had been written in one go.
  const sep = /\s*$/.exec(before)![0] || '\n\n'
  return `${before}${blocks}${sep}${after}`
}

export type RegistrySplitRefusal = 'unknown-parent' | 'duplicate-key' | 'invalid-key' | 'reserved-key'

export interface RegistrySplitChild {
  readonly key: string
  readonly description: string
  readonly tags: readonly string[]
}

export type RegistrySplitResult =
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly refusal: RegistrySplitRefusal; readonly key: string }

/**
 * The registry half of a split (D8): the parent's section narrowed, the children inserted
 * directly after it. A typed refusal rather than null, because the route answers each one with
 * its own sentence and a reserved key is a different mistake from a taken one.
 */
export function applyRegistrySplit(
  markdown: string,
  split: {
    readonly parent: string
    readonly parentEntry: { readonly description: string; readonly tags: readonly string[] }
    readonly children: readonly RegistrySplitChild[]
  },
): RegistrySplitResult {
  const existing = new Set(parseDomainRegistry(markdown).domains.map((d) => d.key))
  if (!existing.has(split.parent)) return { ok: false, refusal: 'unknown-parent', key: split.parent }
  const seen = new Set<string>()
  for (const c of split.children) {
    if (RESERVED_DOMAIN_KEYS.has(c.key)) return { ok: false, refusal: 'reserved-key', key: c.key }
    if (!isValidDomainKey(c.key)) return { ok: false, refusal: 'invalid-key', key: c.key }
    if (existing.has(c.key) || seen.has(c.key)) return { ok: false, refusal: 'duplicate-key', key: c.key }
    seen.add(c.key)
  }
  const narrowed = replaceDomainSection(markdown, split.parent, split.parentEntry)
  if (narrowed === null) return { ok: false, refusal: 'unknown-parent', key: split.parent }
  const grown = insertDomainSectionsAfter(narrowed, split.parent, split.children)
  // Unreachable after the checks above; kept so a change to either function cannot turn a
  // refusal into a registry written half.
  if (grown === null) return { ok: false, refusal: 'duplicate-key', key: split.children[0]?.key ?? split.parent }
  return { ok: true, markdown: grown }
}

/** "a", "a and b", "a, b and c", each in backticks. */
const keyList = (keys: readonly string[]): string => {
  const q = keys.map((k) => `\`${k}\``)
  return q.length <= 1 ? (q[0] ?? '') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`
}

/**
 * The deterministic draft of the narrowed parent (4.4), the floor under the naming pass: its old
 * description with one sentence naming what now has its own domain, and its tag hints minus
 * every tag a child lists. It says what LEFT rather than rewriting what stays, because the
 * machine does not know what stays well enough to say it better than the person who wrote it.
 *
 * Mirrored in `web/src/lib/domainDraft.ts` (the decision surface shows it before any request),
 * pinned by the same cases on both sides.
 */
export function draftParentEntry(
  parent: { readonly description: string; readonly tags: readonly string[] },
  children: ReadonlyArray<{ readonly key: string; readonly tags: readonly string[] }>,
): { description: string; tags: string[] } {
  const taken = new Set(children.flatMap((c) => c.tags.map((t) => t.toLowerCase())))
  const tags = parent.tags.filter((t) => !taken.has(t.toLowerCase()))
  const keys = children.map((c) => c.key)
  if (keys.length === 0) return { description: parent.description.trim(), tags }
  const own = keys.length === 1 ? 'have their own domain' : 'have their own domains'
  const base = parent.description.trim()
  const sentence = `Pages on ${keyList(keys)} ${own}.`
  return { description: base === '' ? sentence : `${base.replace(/\s*$/, '')} ${sentence}`, tags }
}
