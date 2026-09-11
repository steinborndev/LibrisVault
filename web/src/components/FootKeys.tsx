/**
 * The keys a screen answers to, in a box's foot: one line, the hints set apart by a bar and a
 * breath of space, so the eye can take them one at a time. Both of Home's views print theirs
 * through this, in the same slot, so switching the view moves nothing.
 */

import { Fragment } from 'react'

export function FootKeys({ items }: { items: readonly string[] }): React.ReactElement {
  return (
    <span className="foot-keys" aria-label="Keys">
      {items.map((t, i) => (
        <Fragment key={t}>
          {i > 0 && (
            <i className="sep" aria-hidden>
              |
            </i>
          )}
          <span>{t}</span>
        </Fragment>
      ))}
    </span>
  )
}
