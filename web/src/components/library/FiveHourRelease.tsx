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
  /**
   * What came back, and whether it was an answer or a fault.
   *
   * "a run is in flight" is the service doing its job, not something breaking - but rendered in
   * red under the button, next to where run feedback appears, it read as a failed run. A
   * refusal says what to do instead; only an unexpected fault is an error.
   */
  const [said, setSaid] = useState<{ text: string; refusal: boolean } | null>(null)

  const act = useMutation({
    mutationFn: (what: 'grant' | 'withdraw') => (what === 'grant' ? api.releaseFiveHour() : api.withdrawFiveHour()),
    onSuccess: () => {
      setAsking(false)
      setSaid(null)
      onDone()
    },
    onError: (err) => {
      const refusal = err instanceof ApiError && err.status === 409
      // The 409 body carries the reason already; the HTTP prefix adds nothing a reader wants.
      const text = err instanceof ApiError ? err.message.replace(/^\d{3} [A-Za-z ]+: /, '') : (err as Error).message
      setSaid({ text, refusal })
    },
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
        {said !== null && <span className={said.refusal ? 'lp-note' : 'lp-err'}>{said.text}</span>}
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
        setSaid(null)
        setAsking(true)
      }}
    >
      release 5h
    </button>
  )
}
