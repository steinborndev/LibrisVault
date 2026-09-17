/**
 * The pinboard's two cuts (prototype 2026-09-17), on the reading list's model: which list
 * you are looking at - open or archived - and then which domain. Pure, so the tests pin it.
 */
import type { QuestionItem } from '../api/types.ts'

export type QuestionTab = 'current' | 'archived'

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
