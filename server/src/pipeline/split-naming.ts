/**
 * The optional naming pass of a domain split (docs/tasks/TASKS-DOMAIN-SPLIT.md 6.2, D14): an
 * agent reads the chosen shelves' landmark pages and answers, per shelf, a key, a description
 * and tags, and for the parent a narrowed description and tags.
 *
 * READ-ONLY BY CONSTRUCTION, not by request. It runs as the maintenance kind `split-naming`
 * under the `query` profile through the read-only run path (`runReadOnly`): no writer
 * registration, no sweep, no commit, and a sandbox that gives the agent no write path into the
 * vault. The prompt says "edit nothing" as well, but that sentence is courtesy; the profile is
 * the guarantee. `domain-review` is the counter-example this was built against: it runs
 * write-capable and relies on its prompt.
 *
 * The answer is parsed from the final message, leniently, like `parseDomainReview`: a block
 * missing a field yields what it has, text that drifts yields nothing rather than throwing, and
 * the dashboard's own drafts stay in the fields. The user's edits always win over both.
 */

export interface NamingShelf {
  /** 1-based, as the prompt and the answer name it: `shelf 1`. */
  readonly n: number
  readonly size: number
  readonly tags: readonly string[]
  readonly landmarks: ReadonlyArray<{ readonly title: string; readonly path: string }>
  /** Tag counts of candidate keys that would collide, so the agent can avoid them. */
  readonly frequentTags: readonly string[]
}

export interface NamingInput {
  readonly parent: { readonly key: string; readonly description: string; readonly tags: readonly string[] }
  readonly shelves: readonly NamingShelf[]
  /** Every other key the registry lists: a new key must be none of them. */
  readonly otherKeys: readonly string[]
}

export interface NamingProposal {
  readonly key?: string
  readonly description?: string
  readonly tags?: readonly string[]
}

export interface SplitNaming {
  /** By 1-based shelf number. */
  readonly shelves: Readonly<Record<number, NamingProposal>>
  readonly parent: { readonly description?: string; readonly tags?: readonly string[] }
}

export const SPLIT_NAMING_FORMAT = [
  'Answer with one block per shelf and one for the parent, nothing else - no preamble, no closing summary:',
  '',
  '## shelf <n>',
  'key: <new registry key, lowercase-hyphenated>',
  'description: <one or two sentences: what this domain covers, and where its line to its siblings runs>',
  'tags: <comma-separated classification hints>',
  '',
  '## parent',
  'description: <the narrowed description of the parent: what it still covers, and that the shelves above have their own domains>',
  'tags: <comma-separated classification hints the parent keeps>',
].join('\n')

export function splitNamingPrompt(input: NamingInput): string {
  const shelves = input.shelves
    .map(
      (s) =>
        `## shelf ${s.n}\n` +
        `${s.size} pages\n` +
        `distinctive tags: ${s.tags.join(', ') || '(none)'}\n` +
        (s.frequentTags.length > 0 ? `tags too frequent to be the key: ${s.frequentTags.join(', ')}\n` : '') +
        `built around these pages (read some of them):\n` +
        s.landmarks.map((l) => `- ${l.title} (${l.path})`).join('\n'),
    )
    .join('\n\n')
  return (
    `A domain of this wiki has outgrown being a shelf, and the user is splitting it into peer ` +
    `domains. You name the new ones and narrow the old one. The pages were grouped by their ` +
    `links; your job is only the words.\n\n` +
    `The domain being split: \`${input.parent.key}\` - ${input.parent.description}\n` +
    `Its current tag hints: ${input.parent.tags.join(', ') || '(none)'}\n\n` +
    `The other domains that already exist (a new key must be none of these, and should sit at ` +
    `the same altitude - a domain is a shelf, not a book):\n` +
    `${input.otherKeys.map((k) => `- ${k}`).join('\n') || '(none)'}\n\n` +
    `The shelves that become domains:\n\n${shelves}\n\n` +
    `Rules:\n` +
    `- Coin each key; do NOT copy a tag the pages already carry. A key equal to a frequent tag ` +
    `makes every such page repeat its own domain in its tags.\n` +
    `- Each description is what a later ingest reads to decide where a new page goes. Say what ` +
    `the domain covers and where its line to its sibling shelves runs.\n` +
    `- The parent keeps its key. Its new description must no longer claim what the shelves took.\n` +
    `- Judge by what the pages are ABOUT. Read a few landmark pages before you answer.\n` +
    `- Do NOT edit any file. Your answer IS the deliverable.\n\n` +
    SPLIT_NAMING_FORMAT
  )
}

const tagList = (v: string): string[] =>
  v
    .split(',')
    .map((t) => t.trim().replace(/^[`#]+|`$/g, '').toLowerCase())
    .filter((t) => t !== '')

export function parseSplitNaming(text: string): SplitNaming {
  const shelves: Record<number, NamingProposal> = {}
  let parent: { description?: string; tags?: string[] } = {}
  let current: { target: number | 'parent'; fields: Map<string, string> } | null = null

  const flush = (): void => {
    if (current === null) return
    const f = current.fields
    const description = f.get('description')
    const tags = f.get('tags')
    if (current.target === 'parent') {
      parent = { ...(description ? { description } : {}), ...(tags ? { tags: tagList(tags) } : {}) }
    } else {
      const key = f.get('key')?.replace(/`/g, '').trim().toLowerCase()
      const entry: NamingProposal = {
        ...(key ? { key } : {}),
        ...(description ? { description } : {}),
        ...(tags ? { tags: tagList(tags) } : {}),
      }
      if (Object.keys(entry).length > 0) shelves[current.target] = entry
    }
    current = null
  }

  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{2,}[ \t]+(.+?)[ \t]*$/.exec(line)
    if (heading) {
      flush()
      const h = heading[1]!.toLowerCase().replace(/[*`]/g, '')
      const shelf = /shelf\s*(\d+)/.exec(h)
      if (shelf) current = { target: Number(shelf[1]), fields: new Map() }
      else if (/\bparent\b/.test(h)) current = { target: 'parent', fields: new Map() }
      continue
    }
    if (current === null) continue
    const field = /^[ \t]*[-*]?[ \t]*\**([a-zA-Z]+)\**[ \t]*:[ \t]*(.*)$/.exec(line)
    if (field) {
      // `**Key:** value` closes its bold after the colon: what is left of it belongs to no value.
      const value = field[2]!.replace(/^\*+/, '').trim()
      if (value !== '') current.fields.set(field[1]!.toLowerCase(), value)
    }
  }
  flush()
  return { shelves, parent }
}
