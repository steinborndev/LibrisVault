/**
 * The bar's middle block: a dot and the heading `scopeHeading` composed. The block has one
 * width and sits at the bar's centre, and the text is set flush left inside it behind a
 * fixed lead - so switching domains makes the heading longer or shorter from a start that
 * never moves, instead of re-centring it (the letters would jump with every switch). The
 * lead puts a heading of typical length about the centre; a long one runs to the right and
 * is cut with an ellipsis, with the full text on hover.
 */

import { domainColor } from '../lib/domains.ts'
import type { ScopeHeading } from '../lib/scopeHeading.ts'

export function ScopeMid({ heading }: { heading: ScopeHeading }): React.ReactElement {
  const { text, domain } = heading
  // A hollow ring where no one colour applies: a count, a wing, the whole vault.
  const dotClass = domain === null ? 'chip-dot mid-dot none' : 'chip-dot mid-dot'
  const dotStyle = domain === null ? undefined : { background: domain === '' ? 'var(--muted)' : domainColor(domain) }
  return (
    <span className="bar-mid" title={text}>
      <span className={dotClass} style={dotStyle} aria-hidden />
      <span className="mid-name">{text}</span>
    </span>
  )
}
