/**
 * The domain heading in the middle of the Graph's and the Catalog's bar (2026-09-11): what
 * the drawing or the list is narrowed to, said once, in the domain's own colour. One
 * domain is named; more than one is a count; nothing picked names the wing in front while
 * the domains are listed by wing (the view IS narrowed to that wing, so "all domains"
 * would claim more than it shows), and says "all domains" otherwise.
 *
 * The empty key is the pages that carry no domain, the way both domain sections spell it.
 */

export interface ScopeHeading {
  readonly text: string
  /**
   * Which domain colours the dot ahead of the text: the named one, the empty key for the
   * pages without a domain, or null when the heading is a count, a wing or the whole vault
   * - none of which is one colour.
   */
  readonly domain: string | null
}

export function scopeHeading(selected: ReadonlySet<string>, wingName: string | null): ScopeHeading {
  if (selected.size === 1) {
    const only = [...selected][0]!
    return { text: only === '' ? 'no domain' : only, domain: only }
  }
  if (selected.size > 1) return { text: `${selected.size} domains`, domain: null }
  if (wingName !== null) return { text: wingName, domain: null }
  return { text: 'all domains', domain: null }
}
