/**
 * The pinboard's two cuts (prototype 2026-09-17), on the reading list's model: which list
 * you are looking at - open or archived - and then which domain. Pure, so the tests pin it.
 */
import type { QuestionItem } from '../api/types.ts'

export type QuestionTab = 'current' | 'archived'

/**
 * One row of the board as the screen around it sees it: the question, and the page it stands
 * on. The page rides along because handing a question to a research run carries its origin
 * page with it (docs/tasks/TASKS-QUESTIONS.md, phase 1), and the keyboard path has to be able
 * to do exactly what the row's own button does.
 */
export interface QuestionRow {
  readonly text: string
  readonly page: string
}

export interface QuestionView {
  readonly shown: QuestionItem[]
  /** How many stand in the domain you are looking at, on this tab. */
  readonly total: number
  /** How many sit in the other tab, for the toggle's own count. */
  readonly archived: number
  /** Of the shown: planned for tonight by a Fellow, and being researched right now. */
  readonly planned: number
  readonly researching: number
}

/**
 * The domains that have something on the list, alphabetical: a ring whose order followed the
 * counts would reshuffle itself as questions close. Questions without a domain stand under
 * "all domains" alone.
 */
export function questionDomains(shown: readonly QuestionItem[]): string[] {
  return [...new Set(shown.map((e) => e.domain).filter((d): d is string => d !== null))].sort((a, b) => a.localeCompare(b))
}

export function questionView(entries: readonly QuestionItem[], tab: QuestionTab = 'current', domain: string | null = null): QuestionView {
  const inTab = entries.filter((e) => (tab === 'archived' ? e.archived : !e.archived))
  const shown = domain === null ? inTab : inTab.filter((e) => e.domain === domain)
  return {
    shown,
    total: shown.length,
    archived: entries.filter((e) => e.archived).length,
    planned: shown.filter((e) => e.planned !== null).length,
    researching: shown.filter((e) => e.researching !== null).length,
  }
}

/**
 * Whether a reformulation that has just come back may replace what is in the composer
 * (docs/tasks/TASKS-QUESTIONS.md, phase 2, decision D3).
 *
 * The suggestion is asked for the moment a question lands in the box, and it takes a few
 * seconds to arrive. In that window the user may already be typing, and their edit wins: the
 * answer is only accepted when the box still holds exactly the text it was asked about. It is
 * a suggestion, so losing it costs nothing; overwriting somebody mid-sentence would.
 */
export function acceptsSuggestion(current: string, askedAbout: string): boolean {
  return current.trim() === askedAbout.trim()
}
