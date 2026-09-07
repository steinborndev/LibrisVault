/**
 * Releasing the rest of the current five-hour window to the Fellows (SPEC section 8.6).
 *
 * A finished afternoon often leaves plan budget standing that nothing will use before the
 * window resets. One click - and a second one to confirm - lets the Fellows fill it to 90 %
 * instead, until that window ends.
 *
 * The confirmation carries the numbers rather than a warning, because the decision is about
 * numbers: what the bound is now, what it becomes, and when it falls back. It is the same
 * two-step the Fellow card's quota override uses, so there is one shape to learn for "this
 * costs money, are you sure".
 */

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api, ApiError } from '../../api/client.ts'

/** Local time of an ISO instant, to the minute; the window's own reset is the end of the grant. */
const at = (iso: string | null): string =>
  iso === null ? '' : new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function FiveHourRelease({
  release,
  fiveHourUsed,
  onDone,
}: {
  release: { enabled: boolean; active: boolean; pct: number; until: string | null }
  /** What the window is at now, for the sentence that asks. */
  fiveHourUsed: number | null
  onDone: () => void
}): React.ReactElement {
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = useMutation({
    mutationFn: (what: 'grant' | 'withdraw') => (what === 'grant' ? api.releaseFiveHour() : api.withdrawFiveHour()),
    onSuccess: () => {
      setAsking(false)
      setError(null)
      onDone()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  })

  if (release.active) {
    return (
      <button
        className="lp-rel on"
        disabled={act.isPending}
        title={`The Fellows may fill this window to ${release.pct}% until ${at(release.until)}. Click to withdraw.`}
        onClick={() => act.mutate('withdraw')}
      >
        {release.pct}% until {at(release.until)}
      </button>
    )
  }

  if (asking) {
    return (
      <span className="lp-ask">
        <button className="lp-rel go" disabled={act.isPending} onClick={() => act.mutate('grant')}>
          {act.isPending ? 'releasing…' : `yes, to ${release.pct}%`}
        </button>
        <button className="lp-rel" onClick={() => setAsking(false)}>
          no
        </button>
        {error !== null && <span className="lp-err">{error}</span>}
      </span>
    )
  }

  return (
    <button
      className="lp-rel"
      title={
        `Let the Fellows use the rest of this 5-hour window - up to ${release.pct}% of it - until the window resets. ` +
        `The week's reserve is untouched, and the release ends with the window.` +
        (fiveHourUsed !== null ? ` The window is at ${fiveHourUsed}% now.` : '')
      }
      onClick={() => {
        setError(null)
        setAsking(true)
      }}
    >
      release 5h
    </button>
  )
}
