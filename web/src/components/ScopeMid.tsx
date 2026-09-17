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
  const { text, domain, tag } = heading
  // A hollow ring where no one colour applies: a count, a wing, the whole vault.
  const dotClass = domain === null ? 'chip-dot mid-dot none' : 'chip-dot mid-dot'
  const dotStyle = domain === null ? undefined : { background: domain === '' ? 'var(--muted)' : domainColor(domain) }
  return (
    <span className={tag ? 'bar-mid has-tag' : 'bar-mid'} title={tag?.around != null ? `${text} around ${tag.around}` : text}>
      <span className={dotClass} style={dotStyle} aria-hidden />
      <span className={tag ? 'mid-name mid-tag' : 'mid-name'}>{text}</span>
      {/* The page the tag was scoped to, quieter than the tag: the tag is what you chose,
          this is where you chose it. Truncated rather than wrapped - the bar is one line. */}
      {tag?.around != null && <span className="mid-around">around {tag.around}</span>}
    </span>
  )
}
