/**
 * Whose text wins when a reformulation comes back (docs/tasks/TASKS-QUESTIONS.md, phase 2,
 * decision D3).
 *
 * The suggestion is asked for the moment a question lands in the composer and arrives a few
 * seconds later. Three orderings matter and the rule settles all of them: the answer arrives
 * into an untouched box and is taken; it arrives after the user typed and is dropped; it never
 * arrives and the raw question stands. The composer's own wiring around this rule has no test
 * because the web suite has no DOM - the acceptance pass walks it by hand.
 */

import { describe, it, expect } from 'vitest'
import { acceptsSuggestion } from '../src/lib/questions.ts'

const QUESTION = 'No source in this pass gives an installed-cost figure per megawatt.'

describe('acceptsSuggestion', () => {
  it('takes the answer when the box still holds what was asked about', () => {
    expect(acceptsSuggestion(QUESTION, QUESTION)).toBe(true)
  })

  it('ignores whitespace the composer may have trimmed either side', () => {
    expect(acceptsSuggestion(`  ${QUESTION}\n`, QUESTION)).toBe(true)
  })

  it('drops the answer once the user has typed', () => {
    expect(acceptsSuggestion(`${QUESTION} and what about cabling?`, QUESTION)).toBe(false)
    expect(acceptsSuggestion('something else entirely', QUESTION)).toBe(false)
    // Including clearing the box, which is a decision as much as typing is.
    expect(acceptsSuggestion('', QUESTION)).toBe(false)
  })

  it('drops it after a send, when the box has moved on to the next question', () => {
    expect(acceptsSuggestion('a different question', QUESTION)).toBe(false)
  })
})
