/**
 * Releasing the week's bounds for one night (SPEC section 8.6a).
 *
 * The week was the bound that survived every other grant, and that is what made a released
 * afternoon a bounded decision rather than an open tap. This lifts it, so the bound moves
 * rather than disappearing: the grant ends with the night it was asked for.
 *
 * It sits at the right end of the night's banner, which is where the reader already is when
 * the answer matters - the banner has just said that nothing runs tonight and why. Two steps,
 * the same shape as the five-hour release and the Fellow card's quota override, so there is
 * one gesture to learn for "this costs money, are you sure". The confirmation carries the
 * numbers rather than a warning, because the decision is about numbers.
 */

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api, ApiError } from '../../api/client.ts'

/** The end of the night, to the minute; that is where the grant ends. */
const at = (iso: string | null): string =>
  iso === null ? '' : new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function WeekRelease({
  release,
  weekPct,
  onDone,
}: {
  release: { enabled: boolean; active: boolean; pct: number; until: string | null }
  /** What the week is at now, for the sentence that asks. */
  weekPct: number | null
  onDone: () => void
}): React.ReactElement | null {
  const [asking, setAsking] = useState(false)
  /**
   * What came back, and whether it was an answer or a fault. "A run is in flight" is the
   * service doing its job, not something breaking, and must not be drawn as an error.
   */
  const [said, setSaid] = useState<{ text: string; refusal: boolean } | null>(null)

  const act = useMutation({
    mutationFn: (what: 'grant' | 'withdraw') => (what === 'grant' ? api.releaseWeek() : api.withdrawWeek()),
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

  // Off means gone, not disabled: a button that only refuses is a worse answer than no button.
  if (!release.enabled) return null

  if (release.active) {
    return (
      <button
        className="cc-rel on"
        disabled={act.isPending}
        title={`The week is released to ${release.pct}% until ${at(release.until)}, when this night ends. Click to withdraw it now.`}
        onClick={() => act.mutate('withdraw')}
      >
        released to {release.pct}% until {at(release.until)} · withdraw
      </button>
    )
  }

  if (asking) {
    return (
      <span className="cc-ask">
        <button className="cc-rel go" disabled={act.isPending} onClick={() => act.mutate('grant')}>
          {act.isPending ? 'releasing…' : `yes, to ${release.pct}% for tonight`}
        </button>
        <button className="cc-rel" onClick={() => setAsking(false)}>
          no
        </button>
        {said !== null && <span className={said.refusal ? 'cc-said' : 'cc-said err'}>{said.text}</span>}
      </span>
    )
  }

  return (
    <button
      className="cc-rel"
      title={
        `Lift the week's reserve and research share to ${release.pct}% for tonight only. ` +
        `The week is the bound every other release survives, so this one ends when the night does, ` +
        `and you can withdraw it before then.` +
        (weekPct !== null ? ` The week is at ${weekPct}% now.` : '')
      }
      onClick={() => {
        setSaid(null)
        setAsking(true)
      }}
    >
      Release the week for tonight
    </button>
  )
}
