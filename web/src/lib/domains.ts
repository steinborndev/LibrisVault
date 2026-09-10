/**
 * Domain color, the page-kind color map and page-health constants, shared between the graph
 * canvas, the library and Home's constellation. Lives outside GraphCanvas so the main bundle
 * never pulls in d3-force - the graph stays the only lazy chunk that pays for it.
 */

/**
 * Page-kind bucket → CSS variable. A CATEGORICAL scale of its own (--type-*): reusing the
 * status tokens painted every source amber and every question red, so a healthy graph read
 * as a field of warnings - and the orphans lens (red) collided with the question color.
 * Falls back to --muted for unknown buckets.
 */
export const TYPE_VARS: Record<string, string> = {
  concepts: '--type-concept',
  entities: '--type-entity',
  sources: '--type-source',
  meta: '--type-meta',
  root: '--type-root',
  questions: '--type-question',
}

/**
 * Deterministic color for a domain: string hash → hue, fixed saturation/lightness that read
 * on both themes. Domains are open-ended (the user coins new ones), so a fixed palette can't
 * work - and hashing keeps a domain's color stable across sessions with zero bookkeeping.
 */
export function domainHue(domain: string): number {
  let h = 0
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0
  return h % 360
}

/**
 * Cached, because the graph asks for the same handful of colours thousands of times per
 * frame: once per node, and twice more per bridge under the network lens. The template
 * literal was a fresh string allocation on every one of those, which showed up as garbage
 * collection in a profile of a pan gesture. A vault has tens of domains, so the map is tiny
 * and never needs clearing.
 */
const domainColors = new Map<string, string>()

export function domainColor(domain: string): string {
  let c = domainColors.get(domain)
  if (c === undefined) {
    c = `hsl(${domainHue(domain)} 62% 52%)`
    domainColors.set(domain, c)
  }
  return c
}

/** A page under ~this many bytes is treated as a stub (frontmatter + a line). */
export const STUB_BYTES = 1024
