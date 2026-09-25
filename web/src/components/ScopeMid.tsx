/**
 * The bar's middle block: a dot and the heading `scopeHeading` composed. The block has one
 * width and sits at the bar's centre, and the text is set flush left inside it behind a
 * fixed lead - so switching domains makes the heading longer or shorter from a start that
 * never moves, instead of re-centring it (the letters would jump with every switch). The
 * lead puts a heading of typical length about the centre; a long one runs to the right and
 * is cut with an ellipsis, with the full text on hover.
 *
 * An open neighbourhood is named after the domain, and is the one thing allowed past the
 * block's own right edge rather than shortening what stands before it: the block keeps its
 * width, so nothing in the bar moves and the heading starts and sits where it always did,
 * and only the tail is longer.
 */

import { domainColor } from '../lib/domains.ts'
import type { ScopeHeading } from '../lib/scopeHeading.ts'

/**
 * `after`: what follows the heading on its line - the Areas stepper's ring of dots (2026-09-24),
 * which stands where the reading list keeps its own, beside the name of where you are.
 */
export function ScopeMid({ heading, after }: { heading: ScopeHeading; after?: React.ReactNode }): React.ReactElement {
  const { text, domain, tag, bloom } = heading
  // A hollow ring where no one colour applies: a count, a wing, the whole vault.
  const dotClass = domain === null ? 'chip-dot mid-dot none' : 'chip-dot mid-dot'
  const dotStyle = domain === null ? undefined : { background: domain === '' ? 'var(--muted)' : domainColor(domain) }
  return (
    <span
      className={`bar-mid${tag ? ' has-tag' : ''}${bloom === undefined ? '' : ' has-bloom'}${after !== undefined && after !== null ? ' has-after' : ''}`}
      title={tag?.around != null ? `${text} around ${tag.around}` : bloom === undefined ? text : `${text} - ${bloom}`}
    >
      <span className={dotClass} style={dotStyle} aria-hidden />
      <span className={tag ? 'mid-name mid-tag' : 'mid-name'}>{text}</span>
      {/* The page the tag was scoped to, quieter than the tag: the tag is what you chose,
          this is where you chose it. Truncated rather than wrapped - the bar is one line. */}
      {bloom !== undefined && <span className="mid-bloom">- {bloom}</span>}
      {tag?.around != null && <span className="mid-around">around {tag.around}</span>}
      {after !== undefined && after !== null && <span className="mid-after">{after}</span>}
    </span>
  )
}
