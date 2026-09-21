import type { GraphNode } from '../api/types.ts'

/**
 * Whether a page is this vault's own knowledge, which is what every screen filters on.
 *
 * TWO REASONS a page is not, and they are unrelated but get the same treatment:
 *
 *   - **`kind`** separates knowledge from the vault's scaffolding (index hubs, MOCs, the
 *     domain registry) and its operational artifacts (lint reports, session logs, folds).
 *     Absent on a synthetic ghost node, where `knowledge` is the right default.
 *   - **`origin: upstream-demo`** marks the 17 pages the claude-obsidian plugin shipped with.
 *     They were created before this vault took its first real material and they carry the
 *     upstream community footer. Counting them as knowledge makes every number about the
 *     vault slightly false, which is what task 8.7 was about.
 *
 * They share the System toggle because they answer the same question for a reader: "is this
 * a page about what I collect, or a page that came with the machine?" Neither is hidden -
 * turning the toggle on shows both, and both stay readable in Obsidian either way.
 *
 * One predicate rather than one per screen: the graph, the catalog and the counters used to
 * write the `kind` check inline, three copies of a rule that has since grown a second half.
 */
export const isKnowledgeNode = (n: Pick<GraphNode, 'kind' | 'origin'>): boolean =>
  (n.kind ?? 'knowledge') === 'knowledge' && n.origin !== UPSTREAM_DEMO

/** The `origin:` value marking the plugin's own release and demo material. */
export const UPSTREAM_DEMO = 'upstream-demo'

/** The counterpart, for a screen showing exactly what `isKnowledgeNode` hides. */
export const isSystemNode = (n: Pick<GraphNode, 'kind' | 'origin'>): boolean => !isKnowledgeNode(n)
