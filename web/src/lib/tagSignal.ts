/**
 * Which tags say what a page is ABOUT, as opposed to what it IS. Two readers ask: "Related by
 * tag" in the link panels and the Areas captions (lib/communities.ts). Both used to treat every
 * tag but the page-type mirrors as a subject, and a form tag then passed for a strong one: the
 * one video about a field shared `#video` with twenty-one videos about everything else and was
 * "related" to all of them, and a cluster of company pages was captioned `#organization`
 * (measured 2026-09-25: 1623 related-by-tag entries came from another domain over one shared
 * tag, 20 of 144 captions carried such a tag). Rarity cannot catch these - a medium tag on 22
 * of 1352 pages looks rarer, so stronger, than most subjects - which is why they are named.
 */

import type { GraphNode } from '../api/types.ts'
import { isKnowledgeNode } from './knowledge.ts'

/**
 * Tags that are never a subject, lowercase. Three kinds:
 * - mirrors of a page's `type:` or kind (server/src/pipeline/graph.ts: KNOWLEDGE_TYPES,
 *   ARTIFACT_TYPES, the structural markers) - every source carries `#source`;
 * - the entity-shaped tags the vault's own domain registry excludes from classification ("say
 *   what a page is, not what it is about"), which the service already hands the runs
 *   (pipeline/domains.ts);
 * - the medium a source came in, the language it was written in, and `research`, which marks
 *   the research pages.
 * The rule in `formTagsOf` catches the widespread ones this list does not know yet; the list is
 * for the rare ones (a medium on two pages) that no statistic can tell from a subject.
 */
export const NON_THEMATIC_TAGS: ReadonlySet<string> = new Set([
  'concept', 'entity', 'source', 'reference', 'comparison', 'question', 'synthesis', 'decision',
  'session', 'fold', 'report', 'release', 'index', 'log', 'meta', 'moc',
  'person', 'organization', 'product', 'researcher',
  'video', 'youtube', 'youtube-channel', 'podcast', 'paper', 'preprint', 'press-release', 'trade-press',
  'german-language', 'english-language',
  'research',
])

/** A tag counts as a form once it runs across this many domains while staying on one page type. */
const FORM_MIN_DOMAINS = 5

/**
 * Tags the vault itself shows to be forms: carried by pages of ONE type only, and spread over
 * FORM_MIN_DOMAINS domains or more. A subject clusters in a field; a kind of page turns up in
 * every field, always as the same kind. On the vault this finds exactly the entity and medium
 * tags and nothing else. Read over the WHOLE graph, never a filtered view: inside one domain
 * every tag spans one domain.
 */
export function formTagsOf(nodes: readonly GraphNode[]): Set<string> {
  const types = new Map<string, Set<string>>()
  const domains = new Map<string, Set<string>>()
  for (const n of nodes) {
    if (!isKnowledgeNode(n)) continue
    for (const raw of n.tags) {
      const t = raw.toLowerCase()
      ;(types.get(t) ?? types.set(t, new Set()).get(t)!).add(n.type)
      if (n.domain !== null) (domains.get(t) ?? domains.set(t, new Set()).get(t)!).add(n.domain)
    }
  }
  const out = new Set<string>()
  for (const [t, ts] of types) if (ts.size === 1 && (domains.get(t)?.size ?? 0) >= FORM_MIN_DOMAINS) out.add(t)
  return out
}

/** The predicate both readers use: named forms and the vault's own widespread ones drop out. */
export function thematicTest(nodes: readonly GraphNode[]): (tag: string) => boolean {
  const forms = formTagsOf(nodes)
  return (tag) => {
    const t = tag.toLowerCase()
    return !NON_THEMATIC_TAGS.has(t) && !forms.has(t)
  }
}
