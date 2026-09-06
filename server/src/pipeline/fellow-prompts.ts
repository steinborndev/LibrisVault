/**
 * Prompt blocks for Fellow runs (docs/agents/SPEC.md sections 5 to 7). Pure text builders,
 * so what a Fellow's run is told can be unit-tested without a runner.
 *
 * Both blocks are SUBORDINATE to the hygiene, notability and domain blocks the system prompt
 * already carries: they say who is working and how much, never what page types or domains
 * exist. The vault's `program.md` stays untouched (hard rule 5); a step tightens its caps by
 * saying so in the prompt.
 */

export interface FellowRunContext {
  readonly agentId: string
  readonly name: string
  readonly slug: string
  /** Vault-relative notebook page path. */
  readonly notebookPath: string
  readonly intent: string
  readonly scope: string | null
  /** SDK model id the run is pinned to. */
  readonly model: string
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Hard USD cap for this run (list-price estimate). */
  readonly maxBudgetUsd: number
  /** The notebook's most recent log lines, newest last, so the run knows what came before. */
  readonly recentLog: readonly string[]
  /** Per-run timeout override (a `deep` step, a planning run); absent = the kind's default. */
  readonly timeoutMs?: number
  /** The proposal this run executes, for the run log. */
  readonly proposalId?: string
}

/** Who is working, on what standing intent, and where to leave open questions. */
export function renderFellowBlock(ctx: FellowRunContext): string {
  const log =
    ctx.recentLog.length > 0
      ? `Its most recent log lines:\n${ctx.recentLog.map((l) => `- ${l}`).join('\n')}`
      : 'It has no log entries yet; this is your first run.'
  return (
    '\n\n<fellow>\n' +
    `You are working as "${ctx.name}", a resident research Fellow of this library. Your standing research intent: ${ctx.intent}\n` +
    (ctx.scope ? `Scope notes from the user: ${ctx.scope}\n` : '') +
    `Your notebook page is ${ctx.notebookPath}. ${log}\n` +
    'When you are done filing pages, append the questions this run left open as bullet lines under the ' +
    '"## Open Questions" section of your notebook page, one question per line, without repeating questions ' +
    'already listed there. Append only: never rewrite or remove other sections of that page, and never ' +
    'touch the notebooks of other Fellows under wiki/meta/agents/.\n' +
    '</fellow>'
  )
}

/** A research STEP: the program's caps tightened for one run. */
export function renderStepCaps(): string {
  return (
    '\n\n<research_step>\n' +
    'This run is a research STEP, not a full sweep. For this run the loop constraints in ' +
    'skills/autoresearch/references/program.md are tightened: at most 1 search round, at most 5 sources ' +
    'fetched, at most 5 new wiki pages. Prefer extending the existing pages named above over filing new ' +
    'ones. If the step finds nothing the wiki does not already hold, keep the synthesis page short and say so.\n' +
    'Reading list: for every publication you actually read and that is worth having in the original (a paper, ' +
    'a standard, a dataset note - not a blog index or a search page), append one entry to ' +
    'wiki/meta/reading-list.md, under its "## Entries" heading, in exactly this shape, one field per line:\n' +
    '- title: <the publication as its authors name it>\n' +
    '  url: <a direct https link, the publisher or arXiv abstract page>\n' +
    '  ref: <DOI or arXiv id, or leave the line out>\n' +
    '  domain: <the vault domain it belongs to>\n' +
    '  why: <one sentence on what it settles>\n' +
    `  found: <your name>, <today's date>\n` +
    'Append only, never rewrite entries already there, and skip a url the page already lists. Do not download ' +
    'the document yourself: the list is the request, and the service fetches it when the user asks.\n' +
    '</research_step>'
  )
}
