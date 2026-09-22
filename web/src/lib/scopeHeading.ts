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
   * A tag filter, when one is on (2026-09-16). It OUTRANKS the domain heading, because it is
   * the narrower statement: with a tag on, "all domains" is true of the vault and false of
   * the drawing, and the middle of the bar is where a reader looks to find out what they are
   * looking at. `around` names the page the tag was scoped to, when it was.
   */
  readonly tag?: { readonly name: string; readonly around: string | null }
  /**
   * Which domain colours the dot ahead of the text: the named one, the empty key for the
   * pages without a domain, or null when the heading is a count, a wing or the whole vault
   * - none of which is one colour.
   */
  readonly domain: string | null
  /**
   * The page whose neighbourhood is open, when one is (the Graph's Landmarks overlay). It
   * REFINES the heading rather than replacing it - the domain, then the page, so a reader who
   * has expanded one landmark can see which one without looking away from the drawing. Absent
   * whenever nothing is expanded.
   */
  readonly bloom?: string
}

export function scopeHeading(
  selected: ReadonlySet<string>,
  wingName: string | null,
  tag: { name: string; around: string | null } | null = null,
  bloom: string | null = null,
): ScopeHeading {
  // The tag first: it is the thing the reader just did, and the domain heading behind it
  // would describe a wider view than the one on screen. An open neighbourhood rides along with
  // every other heading, because it says which page the drawing has been narrowed AROUND.
  if (tag !== null) return { text: `#${tag.name}`, domain: null, tag }
  const under = (h: ScopeHeading): ScopeHeading => (bloom === null ? h : { ...h, bloom })
  if (selected.size === 1) {
    const only = [...selected][0]!
    return under({ text: only === '' ? 'no domain' : only, domain: only })
  }
  if (selected.size > 1) return under({ text: `${selected.size} domains`, domain: null })
  if (wingName !== null) return under({ text: wingName, domain: null })
  return under({ text: 'all domains', domain: null })
}
