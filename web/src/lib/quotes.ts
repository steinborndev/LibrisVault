/**
 * What the record and the stream say about a job's quotes (docs/sources/SPEC.md 7.5).
 *
 * The server checks every quotation a run ADDED against the text that run read, and puts the
 * two numbers on the job. Here they become the one fact a reader needs - and a chip when
 * something did not hold, because a quotation that is not in the source is the kind of thing
 * one wants to see without opening the record.
 *
 * Pure, so the parsing of a column written by an older build is under test.
 */

/** The summary as the job row carries it (a JSON string in `validation`). */
export interface QuoteSummary {
  checked: number
  unverified: number
  /** Why nothing was checked, when the service had nothing to compare against. */
  note?: string
}

/** Reads the `validation` column. Anything unexpected reads as "nothing to say". */
export function parseQuoteSummary(validation: string | null | undefined): QuoteSummary | null {
  if (validation == null || validation === '') return null
  try {
    const parsed = JSON.parse(validation) as { quotes?: { checked?: unknown; unverified?: unknown; note?: unknown } }
    const quotes = parsed.quotes
    if (quotes === undefined || typeof quotes.checked !== 'number' || typeof quotes.unverified !== 'number') return null
    return {
      checked: quotes.checked,
      unverified: quotes.unverified,
      ...(typeof quotes.note === 'string' ? { note: quotes.note } : {}),
    }
  } catch {
    return null
  }
}

/** The fact on the opened record: `12 checked · 1 unverified`, `12 checked`, or `-`. */
export function quotesFact(summary: QuoteSummary | null): string {
  if (summary === null || summary.checked === 0) return '-'
  return summary.unverified === 0 ? `${summary.checked} checked` : `${summary.checked} checked · ${summary.unverified} unverified`
}

/** What the fact's tooltip adds: the reason nothing was checked, or what the check means. */
export function quotesTitle(summary: QuoteSummary | null): string {
  if (summary === null) return 'Quotations are checked against the text the run read; this run has no record of it.'
  if (summary.checked === 0) {
    return summary.note !== undefined
      ? `Nothing was checked: ${summary.note}.`
      : 'The run added no quotation of five words or more.'
  }
  const held = summary.checked - summary.unverified
  return `${held} of ${summary.checked} quotation(s) this run added stand verbatim in the text it read. Advisory: nothing was changed.`
}

/** The stream chip, or null when there is nothing to flag. */
export function quotesChip(summary: QuoteSummary | null): string | null {
  if (summary === null || summary.unverified === 0) return null
  return `${summary.unverified} quote${summary.unverified === 1 ? '' : 's'}`
}
