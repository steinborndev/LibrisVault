/**
 * The lines the activity box shows for an "ask the vault" question (2026-09-08).
 *
 * A research run streams its log, and its box shows the last four lines of it. A query
 * streams nothing but the answer text, so there is no log to show - but there are four
 * moments the client can observe, each a fact and each with a time: the question went out,
 * retrieval reported what it found, the first answer text arrived, the reply landed (or
 * failed). This turns those transitions into the same shape of line the run box shows,
 * newest at the head, so the two boxes read the same way.
 *
 * Every line is an observed transition, never a guess about what the runner is doing, and
 * the trail belongs to ONE question: the next one starts it over. Pure, so the hook around
 * it is three lines and the rules live where a test can reach them.
 */

import type { Retrieval } from './chatStream.ts'

export interface TrailLine {
  readonly ts: string
  readonly text: string
}

/** What the client can see of a question at one moment. */
export interface TrailInput {
  /** From the moment the question goes out until the reply lands. */
  readonly pending: boolean
  /** Retrieval's report for the answer in flight, once the server sent it. */
  readonly retrieval: Retrieval | null
  /** True once answer text has streamed. */
  readonly writing: boolean
  /** The landed reply's citation count, or null while nothing landed for this question. */
  readonly landed: number | null
  /** The failure, once the ask failed. */
  readonly error: string | null
}

export const TRAIL_START: TrailInput = { pending: false, retrieval: null, writing: false, landed: null, error: null }

const pages = (n: number): string => `${n} page${n === 1 ? '' : 's'}`

/**
 * The trail after `next`, given the trail up to `prev`. Each edge appends one line; the
 * question going out starts a new trail; anything that did not change appends nothing.
 */
export function advanceTrail(trail: readonly TrailLine[], prev: TrailInput, next: TrailInput, now: string): TrailLine[] {
  let out: TrailLine[] = [...trail]
  if (next.pending && !prev.pending) out = [{ ts: now, text: 'Searching the vault' }]
  if (next.retrieval !== null && next.retrieval !== prev.retrieval) {
    out.push({ ts: now, text: `Retrieved ${pages(next.retrieval.count)}` })
  }
  if (next.writing && !prev.writing) out.push({ ts: now, text: 'Writing the answer' })
  if (next.landed !== null && prev.landed === null) {
    out.push({ ts: now, text: next.landed > 0 ? `Answered with ${next.landed} source${next.landed === 1 ? '' : 's'}` : 'Answered' })
  }
  if (next.error !== null && next.error !== prev.error) out.push({ ts: now, text: `Failed: ${next.error}` })
  return out
}
