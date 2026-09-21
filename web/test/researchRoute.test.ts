/**
 * Where a question goes when it is handed to a research run
 * (docs/tasks/TASKS-QUESTIONS.md, phase 1).
 *
 * The URL carries two things now: the question as the topic, and the page it stands on. The
 * page is what lets the run resolve a question written to be read in place ("in this pass",
 * "either source"), and both halves have to survive encoding - a page name holds spaces and
 * ampersands, a question holds question marks and quotes.
 *
 * The composer's own rule (a `from` never outlives the text it belongs to) is a property of
 * the Chat component's state, which this suite has no DOM to render; it is checked by hand in
 * the acceptance pass instead.
 */

import { describe, it, expect } from 'vitest'
import { researchRoute } from '../src/components/library/QuestionBoard.tsx'

/** What `App` does with the string: the two parameters, read back. */
const params = (route: string): URLSearchParams => new URLSearchParams(route.slice(route.indexOf('?') + 1))

describe('researchRoute', () => {
  it('carries the question and the page it stands on', () => {
    const route = researchRoute('What is the capacity factor?', 'wiki/concepts/Tidal Turbine.md')
    const p = params(route)
    expect(route.startsWith('/research?')).toBe(true)
    expect(p.get('prefill')).toBe('What is the capacity factor?')
    expect(p.get('from')).toBe('wiki/concepts/Tidal Turbine.md')
  })

  it('omits the page when there is none, which is the gap backlog and the palette', () => {
    expect(params(researchRoute('tidal turbines')).has('from')).toBe(false)
    expect(params(researchRoute('tidal turbines', '')).has('from')).toBe(false)
  })

  it('survives the characters a question and a page name actually hold', () => {
    const question = 'Does "spring-neap" variation matter, and by how much? A & B, 50% of the time'
    const page = 'wiki/concepts/A & B - notes (2026).md'
    const p = params(researchRoute(question, page))
    expect(p.get('prefill')).toBe(question)
    expect(p.get('from')).toBe(page)
  })
})
