/**
 * Pure helpers for the Recap screen (docs/agents/SPEC.md section 9.3): what still needs a
 * decision, and the sentence a button's answer reads as. Kept out of the component so the
 * counting the Home inbox entry relies on is testable.
 */

import type { RecapAnswer, RecapModel, RecapRow } from '../api/types.ts'

/** Proposals the user has not decided on yet, across every Fellow of the recap. */
export function undecidedCount(model: RecapModel): number {
  return model.fellows.reduce((n, f) => n + f.proposals.filter((p) => p.status === 'proposed').length, 0)
}

/** True while the recap still wants something from the user. */
export function needsDecision(row: RecapRow): boolean {
  return !row.quiet && undecidedCount(row.model) > 0
}

/** The code an answer would be typed as on Telegram (shown on the button's tooltip). */
export function answerCode(answer: RecapAnswer): string {
  switch (answer.action) {
    case 'pick':
      return `${answer.fellow}${answer.letter}`
    case 'veto':
      return answer.letter !== undefined ? `veto ${answer.fellow}${answer.letter}` : `veto ${answer.fellow}`
    case 'skip':
    case 'pause':
    case 'resume':
      return `${answer.action} ${answer.fellow}`
    case 'note':
      return `note ${answer.fellow}: ${answer.text}`
    case 'model':
    case 'step':
      return `${answer.action} ${answer.fellow} ${answer.value}`
    case 'topic':
      return `topic ${answer.fellow}${answer.letter}: ${answer.text}`
  }
}

/** One line for the header: what the night did, in numbers. */
export function nightLine(model: RecapModel): string {
  if (model.quiet) return 'Nothing ran tonight.'
  const parts = [`${model.totals.runs} run${model.totals.runs === 1 ? '' : 's'}`]
  if (model.totals.failed > 0) parts.push(`${model.totals.failed} failed`)
  parts.push(`${model.totals.pages} page${model.totals.pages === 1 ? '' : 's'}`)
  parts.push(`${model.totals.costUsd.toFixed(2)} USD`)
  return parts.join(' · ')
}
