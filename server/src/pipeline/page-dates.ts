/**
 * `updated:` and `content_updated:` (B7).
 *
 * WHAT WENT WRONG. `updated:` was the only freshness signal a page had, and every mass pass
 * bumped it: a tag normalisation, a link repair, a counter refresh, a frontmatter backfill.
 * The result, measured on the working vault: **1231 of 1247 pages (99 %) claim an update within
 * thirty days**, which is another way of saying the field answers nothing. "What changed
 * recently" cannot be asked of a vault where everything changed recently.
 *
 * WHAT THIS ADDS. A second field, `content_updated:`, meaning the day a human or a run changed
 * what the page SAYS. `updated:` keeps its old meaning - the day anything about the file
 * changed - because the vault's OWN skills read it and repurposing it would break them
 * (hard rule 5: their behaviour is not ours to change).
 *
 * THE RULE FOR A WRITER, and it is a judgement the writer makes rather than a diff:
 *
 *   - a user's page edit, a run writing a page, a question struck through: content changed;
 *   - a link joined back onto one line, a tag dropped, an em-dash replaced, a heading moved,
 *     a counter refreshed: the file changed and the page still says the same thing.
 *
 * That distinction is why phase 8's repair passes can run at all. Without it the repair would
 * stamp every page it touched as freshly written, destroying the same signal it was fixing -
 * which is exactly how the field got into this state.
 */

/** The field name, used by the writers, the readers and the repair passes alike. */
export const CONTENT_UPDATED = 'content_updated'

/** `YYYY-MM-DD` in local time, the format every date field in this vault uses. */
export function localDay(at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---)/

/** Everything after the frontmatter block: what the page actually says. */
export function bodyOf(markdown: string): string {
  const m = FRONTMATTER.exec(markdown)
  return m === null ? markdown : markdown.slice(m[0].length)
}

/**
 * Whether two versions of a page differ in what they SAY.
 *
 * Whitespace at the ends is normalised away because a trailing newline is not a content
 * change, and neither is the editor that added it.
 */
export function bodyChanged(before: string, after: string): boolean {
  return bodyOf(before).trim() !== bodyOf(after).trim()
}

/** The value of one scalar frontmatter field, or null. */
export function fieldOf(markdown: string, field: string): string | null {
  const m = FRONTMATTER.exec(markdown)
  if (m === null) return null
  const found = new RegExp(`^${field}:[ \\t]*(.*)$`, 'm').exec(m[2]!)
  const value = found?.[1]?.trim().replace(/^["']|["']$/g, '')
  return value === undefined || value === '' ? null : value
}

/**
 * Sets `updated:`, and `content_updated:` when the caller says the page's content changed.
 *
 * Both are set in place when the field exists and inserted after `updated:` when it does not,
 * so a page's frontmatter keeps the order its writer chose. A page with no frontmatter block
 * at all is returned untouched: inventing one is a bigger decision than a date field.
 */
export function stampDates(markdown: string, opts: { content: boolean; day?: string }): string {
  const m = FRONTMATTER.exec(markdown)
  if (m === null) return markdown
  const day = opts.day ?? localDay()
  let front = m[2]!

  front = /^updated:/m.test(front)
    ? front.replace(/^updated:[ \t]*.*$/m, `updated: ${day}`)
    : `${front}\nupdated: ${day}`

  if (opts.content) {
    front = new RegExp(`^${CONTENT_UPDATED}:`, 'm').test(front)
      ? front.replace(new RegExp(`^${CONTENT_UPDATED}:[ \\t]*.*$`, 'm'), `${CONTENT_UPDATED}: ${day}`)
      : front.replace(/^updated:[ \t]*.*$/m, (line) => `${line}\n${CONTENT_UPDATED}: ${day}`)
  }

  return markdown.slice(0, m[1]!.length) + front + markdown.slice(m[1]!.length + m[2]!.length)
}

/**
 * The date a freshness view should sort by: when the page last SAID something new.
 *
 * Falls back to `created:` rather than to `updated:` for the 1247 pages that predate the field.
 * That is deliberate and it is the whole point: `updated:` on those pages is the date of the
 * last mass pass, and sorting by it is what made every page look equally fresh.
 */
export function freshnessDate(markdown: string): string | null {
  return fieldOf(markdown, CONTENT_UPDATED) ?? fieldOf(markdown, 'created')
}

/**
 * The `status:` vocabulary (B7).
 *
 * Measured: 786 developing, 244 seed, 150 mature, and then nine further values in ones and
 * twos. Advisory, like every other validator rule - a vault is allowed a word we did not think
 * of, and what this catches is the drift of five words meaning one thing.
 */
export const STATUS_VOCABULARY: ReadonlySet<string> = new Set([
  'seed',
  'developing',
  'mature',
  'evergreen',
  'retired',
])
