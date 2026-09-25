/**
 * Deterministic draft description for a domain candidate (SPEC §12.7 Stufe a): the create
 * form must never start with an empty description - writing an extensible one from nothing
 * is the hardest part of the flow, and the deterministic finder knows enough (key + member
 * tags) for a usable first draft. An agent-review proposal, when present, always wins over
 * this; the draft is the floor, not the ceiling.
 *
 * Wording follows the registry's own conventions page: broad on purpose ("a shelf, not a
 * book"), so the domain stays extensible as adjacent pages arrive.
 */

/** How many member tags beyond the key itself the draft names as examples. */
const MAX_EXAMPLE_TAGS = 3

export function draftDomainDescription(candidate: { key: string; tags: readonly string[] }): string {
  const label = candidate.key.replace(/[-_]+/g, ' ').trim()
  const topic = label.charAt(0).toUpperCase() + label.slice(1)
  const examples = candidate.tags.filter((t) => t !== candidate.key).slice(0, MAX_EXAMPLE_TAGS)
  const scope =
    examples.length > 0
      ? `including ${examples.join(', ')}`
      : 'methods, tools, entities and applications'
  return (
    `${topic} and closely related work - ${scope}. ` +
    `Kept deliberately broad (a shelf, not a book) so future pages on adjacent topics file here too.`
  )
}

/** "a", "a and b", "a, b and c", each in backticks. */
const keyList = (keys: readonly string[]): string => {
  const q = keys.map((k) => `\`${k}\``)
  return q.length <= 1 ? (q[0] ?? '') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`
}

/**
 * The deterministic draft of a split's narrowed parent (TASKS-DOMAIN-SPLIT 4.4), the floor under
 * the naming pass: the old description with one sentence naming what now has its own domain,
 * and the tag hints minus every tag a promoted child lists.
 *
 * A hand mirror of `draftParentEntry` in `server/src/pipeline/domains.ts`: the decision surface
 * shows it before any request is made. Both sides are pinned by the same cases.
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
