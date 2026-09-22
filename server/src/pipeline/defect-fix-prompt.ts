/**
 * The prompt a bound defect-fix run is given (TASKS-DEFECT-PATHS 4.3).
 *
 * THREE RULES GET A RUN, and only three: `open-question-form`, `quote` and `page-schema`. Each
 * names a defect whose repair needs READING - what did this question mean to ask, what does the
 * source actually say, what does this page and the graph around it already hold - and no
 * deterministic pass can ever produce that. Every other rule is either a pass or a decision.
 *
 * `near-duplicate` deliberately gets no run (decision 7): merging is forbidden to every writer
 * here, and a run that only cross-referenced the two pages would pre-empt the decision it is
 * not allowed to make.
 *
 * THE PROMPT ASKS; IT DOES NOT ENFORCE. The page set is enforced by the `PreToolUse` hook
 * (`DefectFixPolicy`, `permissions.ts`) and, behind that, by a commit check with auto-revert
 * that catches a page written through Bash. Hard rule 4: prompt wording is not a boundary.
 */

import type { StandingFinding } from '../db/validation.js'

/** How much of a finding's message and evidence reaches the prompt. */
const DETAIL_CHARS = 900

const clip = (text: string, n = DETAIL_CHARS): string => (text.length > n ? `${text.slice(0, n)}…` : text)

/**
 * What the run is told about one finding: its page, what the validator said, and the evidence
 * the producer wrote down, where there is any. The quote rule is the one that needs it -
 * the message carries the first 80 characters of the quotation and a length, and the run has
 * to check the whole thing.
 */
function renderFinding(f: StandingFinding, index: number): string {
  const lines = [`${index + 1}. ${f.path}`, `   what the check found: ${clip(f.message)}`]
  if (f.evidence !== null && f.evidence !== '') {
    if (f.rule === 'quote') {
      try {
        const parsed = JSON.parse(f.evidence) as { quote?: string; matched?: string; words?: number; matchedWords?: number }
        if (typeof parsed.quote === 'string') lines.push(`   the quotation as the page has it: ${JSON.stringify(clip(parsed.quote))}`)
        if (typeof parsed.matched === 'string' && parsed.matched !== '') {
          lines.push(
            `   the longest run of its own words that DOES stand in the source: ` +
              `${JSON.stringify(clip(parsed.matched, 300))} (${parsed.matchedWords ?? '?'} of ${parsed.words ?? '?'} words)`,
          )
        }
      } catch {
        lines.push(`   recorded evidence: ${clip(f.evidence)}`)
      }
    } else lines.push(`   recorded evidence: ${clip(f.evidence)}`)
  }
  return lines.join('\n')
}

/** The per-rule instruction. Nothing here is a boundary; the hook and the commit check are. */
const RULE_TASK: Record<string, string> = {
  'open-question-form': [
    'Rewrite the bullets under `## Open questions` on each page listed so that every one of them:',
    '  - asks exactly ONE thing and ends in a question mark;',
    '  - names its subjects IN FULL, so it can be read by somebody who does not have this page in front of them;',
    '  - carries NO reference to the run or the document that produced it ("in this pass", "either source", "above");',
    '  - keeps the reason it stayed open, in brackets BEFORE the question mark, where the bullet had one.',
    '',
    'Rewrite only bullets that fail one of those. A bullet that already reads cleanly stays character for',
    'character as it is. Do not add questions, do not remove questions, and do not answer any of them: what',
    'was open stays open, in better words. A struck-through bullet (`~~…~~`) is already closed - leave it.',
  ].join('\n'),
  quote: [
    'For each quotation named below, check it against the document the job actually read - the artifact under',
    '`.raw/<job-id>/` for the job that wrote this page. Then do ONE of two things:',
    '  - if the source says it and the page mis-transcribed it, correct the quotation to what the source says;',
    '  - if the source does not say it, rewrite the sentence around it into a PARAPHRASE, without quotation marks,',
    '    that says only what the source supports.',
    '',
    'NEVER invent a quotation, and never widen one to make it fit. If you cannot find the artifact or cannot',
    'establish what the source says, leave the page exactly as it is and say so in your final answer - an',
    'unchanged page is a correct outcome here, and a guessed quotation is not.',
  ].join('\n'),
  'page-schema': [
    'Add the missing heading to each page listed and FILL it from what the page and the vault around it already',
    'hold: its existing prose, the pages it links to, the pages that link to it. An empty heading is not a repair,',
    'and neither is a heading followed by a sentence that says nothing.',
    '',
    'Add the section where it belongs in the page’s own order, change nothing else on the page, and add no claim',
    'the vault does not already carry. If a page gives you nothing to fill the section with, leave it alone and',
    'say which one and why.',
  ].join('\n'),
}

/**
 * The whole prompt for one defect-fix run.
 *
 * One rule per run and one page per finding, at most ten. The caps are the same shape as the
 * ones every other bounded action here carries (tag-fix 20, graph repair 10, 40 findings in the
 * lint-fix prompt), and ten is where a bad run costs ten commits' worth of reading rather than
 * a vault.
 */
export function renderDefectFixPrompt(rule: string, findings: readonly StandingFinding[]): string {
  const task = RULE_TASK[rule]
  if (task === undefined) throw new Error(`no defect-fix prompt for ${rule}`)
  const pages = [...new Set(findings.map((f) => f.path))]
  return [
    `The service's validator reports a standing defect of the class \`${rule}\` on ${pages.length === 1 ? 'one page' : `${pages.length} pages`}.`,
    'Repair it, on those pages and nowhere else.',
    '',
    task,
    '',
    '<scope>',
    `You may edit ONLY these ${pages.length === 1 ? 'page' : 'pages'}:`,
    ...pages.map((p) => `- ${p}`),
    'Do not create a page, do not rename one, do not delete one, and do not edit any other page.',
    'This is enforced: a write outside that list is refused at tool time, and the commit is checked',
    'against the same list afterwards and reverted whole if it breaks it.',
    '</scope>',
    '',
    '<findings>',
    findings.map(renderFinding).join('\n'),
    '</findings>',
    '',
    'Work page by page. When you are done, say in one or two sentences what you changed per page, and name',
    'any page you deliberately left alone and why.',
  ].join('\n')
}

/** Rules a bound run repairs. The route refuses anything else before a prompt is built. */
export const DEFECT_FIX_RULES: ReadonlySet<string> = new Set(Object.keys(RULE_TASK))
