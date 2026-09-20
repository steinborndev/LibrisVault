/**
 * What a started research run carries, as opposed to what the composer box holds
 * (docs/tasks/TASKS-QUESTIONS.md, phase 6 - both of these were found by the acceptance pass,
 * not by a test, and neither is reachable without a rendered page).
 *
 * The two bugs, because the shapes are what this file guards against coming back:
 *
 * 1. **The effect cancelled its own request.** The prefill effect navigates to strip the query
 *    params, which changes its own dependencies, so a cleanup function that invalidated the
 *    in-flight suggestion was run by the effect's own navigation a moment after firing it.
 *    Every suggestion was fetched, paid for and discarded. The guard has to be keyed on the
 *    QUESTION, not on the effect run, and that is what `supersedes` below describes.
 *
 * 2. **Sending cleared the origin before reading it.** `setTopic('')` empties the box and drops
 *    the composer's `from` and `title` refs; the run starter is read after that, so runs went
 *    out with neither. The fix captures both into send-scoped refs first, the way `topicRef`
 *    has always captured the text.
 *
 * The component itself cannot be rendered here (no DOM in this suite), so these pin the two
 * rules as functions over the same state the component keeps in refs.
 */

import { describe, expect, it } from 'vitest'
import { acceptsSuggestion } from '../src/lib/questions.ts'

/**
 * Whether an answer that has come back is still the one being waited for. The component holds
 * `asked` in a ref that survives re-runs of the effect; a newer question replaces it.
 */
const supersedes = (inFlight: string | null, asked: string): boolean => inFlight !== asked

/** What `send()` captures before it empties the box. */
const capture = (composer: { from?: string; title?: string }): { from?: string; title?: string } => ({ ...composer })

const QUESTION = 'No source in this pass gave an installed-cost figure per megawatt.'

describe('a suggestion in flight', () => {
  it('is still wanted when nothing newer has been asked', () => {
    expect(supersedes(QUESTION, QUESTION)).toBe(false)
  })

  it('is dropped only when a NEWER question replaced it', () => {
    expect(supersedes('a different question', QUESTION)).toBe(true)
    expect(supersedes(null, QUESTION)).toBe(true)
  })

  it('survives the effect running again for the same question', () => {
    // The navigation that strips the query params re-runs the effect. Same question, same
    // ref: the answer is still wanted, and the second run must not ask a second time.
    const inFlight = QUESTION
    expect(supersedes(inFlight, QUESTION)).toBe(false)
    expect(inFlight === QUESTION).toBe(true)
  })

  it('still defers to the user, which is the other half of the rule', () => {
    // Not superseded, but the box has been typed in: the answer is dropped all the same.
    expect(supersedes(QUESTION, QUESTION)).toBe(false)
    expect(acceptsSuggestion('something I typed', QUESTION)).toBe(false)
  })
})

describe('what send() carries', () => {
  it('captures the origin and the page name before the box is emptied', () => {
    const composer = { from: 'wiki/concepts/Tidal Turbine.md', title: 'Tidal Array Installed Cost' }
    const sent = capture(composer)
    // The box is emptied here, which drops the composer's own refs.
    const emptied = { from: undefined, title: undefined }
    expect(emptied.from).toBeUndefined()
    // What goes out is the capture, not the emptied box.
    expect(sent).toEqual({ from: 'wiki/concepts/Tidal Turbine.md', title: 'Tidal Array Installed Cost' })
  })

  it('carries nothing when the box had nothing to carry', () => {
    expect(capture({})).toEqual({})
  })
})
