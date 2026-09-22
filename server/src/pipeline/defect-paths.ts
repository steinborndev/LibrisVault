/**
 * What can be done about each standing defect, and by whom (TASKS-DEFECT-PATHS phase 1).
 *
 * WHY THIS IS A THIRD CLASSIFICATION rather than a widening of the one that exists.
 * `MECHANICAL_RULES` / `JUDGEMENT_RULES` (`maintenance.ts`) answer a different question: what a
 * lint-fix AGENT PROMPT may be told about. The two axes cross, and they are meant to.
 * `tag-singleton` and `run-protocol` are judgement rules WITH a deterministic pass;
 * `open-question-form`, `quote` and `page-schema` are judgement rules with a bound run;
 * `frontmatter`, `dates` and `wrapped-link` are mechanical rules with no button here at all.
 * Widening `MECHANICAL_RULES` to build the "fixable" block would put judgement calls into an
 * agent prompt, which `server/test/lint-fix-routing.test.ts` exists to prevent.
 *
 * WHY IT LIVES HERE AND NOT IN `validator.ts`. `validator.ts` is imported by the queue, the
 * maintenance runner, the pages route and the standing re-check. Putting a table that names
 * repair passes there would pull `repair.ts` - and with it `hubs.ts` and `domains.ts` - into
 * all four for a lookup. The compile-time exhaustiveness is unaffected by where the record
 * lives: it comes from `Record<ValidationRule, …>`, which is the rule union's own type.
 *
 * WHAT THE TEXT PROMISES. The honest limits as MEASURED on 2026-09-21, not the intended ones.
 * `title-name` says the pass repairs the links and not the name, `run-protocol` says the pass
 * reaches five of the seven headings, and a `.raw/` `address-map` row says why no repair can
 * invent a provenance record. A row that promised more than the pass delivers would read as a
 * failed fix the first time somebody pressed it.
 */

import type { ValidationRule } from './validator.js'

/**
 * How a defect of this rule gets repaired.
 *
 * `pass`     a deterministic repair pass exists AND reaches the page the finding stands on
 * `run`      a bound agent run can do it, one page per finding (phase 4)
 * `decision` a person decides; the row explains what the decision is
 */
export type RepairPath = 'pass' | 'run' | 'decision'

/** One rule's guidance line: what the repair is, who performs it, and what it costs. */
export interface DefectGuidance {
  readonly path: RepairPath
  /** What the repair actually is, in one sentence. */
  readonly what: string
  /** Who performs it: a button, an agent run, or the reader. */
  readonly who: string
  /** What it costs, in the vocabulary the maintenance cards already use. */
  readonly cost: string
  /** The limit this path has, where it has one the reader would otherwise discover by pressing. */
  readonly limit?: string
}

/**
 * The path per rule. Exhaustive over the rule union by type, so a rule added to `validator.ts`
 * is a compile error here until somebody decides what can be done about it - which is exactly
 * the gap `open-question-form` sat in for the whole of its first day.
 */
export const DEFECT_PATHS: Record<ValidationRule, RepairPath> = {
  frontmatter: 'decision',
  dates: 'decision',
  address: 'decision',
  'dead-link': 'decision',
  'wrapped-link': 'decision',
  orphan: 'decision',
  'address-map': 'decision',
  'stale-counter': 'decision',
  'single-source-entity': 'decision',
  'source-url': 'decision',
  'nested-page': 'decision',
  'hot-cache-size': 'decision',
  quote: 'run',
  'near-duplicate': 'decision',
  'title-name': 'decision',
  'page-schema': 'run',
  'run-protocol': 'pass',
  'tag-mirroring': 'pass',
  'tag-singleton': 'pass',
  'em-dash': 'pass',
  'status-vocabulary': 'decision',
  /*
   * A RUN EXISTS FOR THIS RULE AND IS NOT OFFERED (measured 2026-09-21, the threshold agreed
   * before the run: every bullet asks something, and at most 2 of 10 pages still carry a
   * deictic bullet). One run over 10 findings moved the pages from 17 of 61 bullets asking
   * something to 66 of 68, and from 10 of 10 pages carrying a deictic bullet to 5 of 10. Both
   * halves are short of the bar, so the rule stays a decision, which is what the bar was
   * agreed in advance to decide.
   *
   * What the number hides, and the reason this is worth revisiting rather than closing: 6 of
   * the 7 remaining deictic bullets carry ONE phrase, `in this vault`, which `PASS_DEIXIS`
   * counts beside `in this pass`. The two are not the same kind of reference - "in this pass"
   * means nothing away from the page, and "in this vault" is a scope a question asked OF this
   * vault legitimately carries. Counted without it, the run leaves 1 of 10 pages deictic,
   * inside the bar. That is a question about the classifier in SPEC.md §12.15, not about this
   * run, and it is recorded rather than decided here.
   */
  'open-question-form': 'decision',
}

/**
 * The repair pass behind a `'pass'` rule, by the name `cli/vaultrepair.ts` knows it.
 *
 * Only the four that belong to a defect rule AND repair the page the finding stands on are
 * here. `title-link` is deliberately absent: it edits the pages that LINK to a drifted title,
 * never the page the `title-name` finding is about, so filtering it to the findings' pages
 * reduces it to nothing (measured: 0 pages vault-wide).
 */
export const RULE_PASSES: Partial<Record<ValidationRule, string>> = {
  'em-dash': 'em-dash',
  'tag-mirroring': 'tag-mirror',
  'tag-singleton': 'tag-singleton',
  'run-protocol': 'run-protocol',
}

/** Rules a bound agent run repairs (phase 4), one page per finding. */
export const RUN_RULES: ReadonlySet<ValidationRule> = new Set(
  (Object.keys(DEFECT_PATHS) as ValidationRule[]).filter((r) => DEFECT_PATHS[r] === 'run'),
)

/**
 * What the expanded row says under each rule. The second `Record` beside `DEFECT_PATHS`:
 * that one classifies the PATH, this one carries the TEXT, and both are exhaustive.
 */
export const DEFECT_GUIDANCE: Record<ValidationRule, DefectGuidance> = {
  frontmatter: {
    path: 'decision',
    what: 'Add the missing frontmatter field by editing the page.',
    who: 'you, in the page view',
    cost: 'one edit',
    limit: 'A lint-fix run repairs this class from a fresh lint report; there is no per-row button.',
  },
  dates: {
    path: 'decision',
    what: 'Correct the date field the page carries out of order.',
    who: 'you, in the page view',
    cost: 'one edit',
    limit: 'A lint-fix run repairs this class from a fresh lint report; there is no per-row button.',
  },
  address: {
    path: 'decision',
    what: 'Give the page a DragonScale address, or correct the one it has.',
    who: 'you, in the page view',
    cost: 'one edit',
    limit: 'Allocating an address is the vault’s own bookkeeping; nothing here invents one.',
  },
  'dead-link': {
    path: 'decision',
    what: 'Either the page the link names should exist, or the link should go. Both are decisions.',
    who: 'you, in the page view',
    cost: 'one edit, or an ingest',
    limit: 'A link that merely wrapped across a line is the separate wrapped-link rule, and that one is mechanical.',
  },
  'wrapped-link': {
    path: 'decision',
    what: 'Join the wikilink a line wrap broke apart.',
    who: 'the "Rejoin wikilinks" button on this screen',
    cost: 'deterministic · no credential needed',
    limit: 'It repairs the whole vault at once rather than this row, which is why it is not a per-row button.',
  },
  orphan: {
    path: 'decision',
    what: 'Link the page into the graph from somewhere it belongs.',
    who: 'you, or a graph-repair run from the Graph screen',
    cost: 'one edit, or an agent run',
    limit: 'Where a page belongs is the judgement; nothing mechanical can make it.',
  },
  'address-map': {
    path: 'decision',
    what: 'Record the page in .raw/.manifest.json, or drop the entry whose page is gone.',
    who: 'the manifest repair on this screen, where the drift is one of those two',
    cost: 'deterministic · one commit',
    limit:
      'A finding that names a .raw/<job-id>/ directory no source entry mentions is NOT repairable: ' +
      'what a job directory held is not derivable from the directory, and a repair that invented it ' +
      'would be inventing provenance. Those rows stay a decision.',
  },
  'stale-counter': {
    path: 'decision',
    what: 'The hub counter drifted from the pages it counts; a hub write corrects it.',
    who: 'the next run that writes the hub layer',
    cost: 'nothing to do',
    limit: 'A whole-vault rule: it is re-read in full on every call and cannot be cleared per page.',
  },
  'single-source-entity': {
    path: 'decision',
    what: 'An entity standing on one source either earns a second one or should not be its own page.',
    who: 'you',
    cost: 'a decision, then an ingest or a delete',
    limit: 'Merging and deleting pages are never a run’s decision.',
  },
  'source-url': {
    path: 'decision',
    what: 'Give the source page the URL it was read from, or record why there is none.',
    who: 'you, in the page view',
    cost: 'one edit',
  },
  'nested-page': {
    path: 'decision',
    what: 'Move the page up to its bucket, or accept the nesting.',
    who: 'you',
    cost: 'a rename, by hand',
    limit: 'No pass here renames a page: a rename breaks every link to it and that repair is a decision.',
  },
  'hot-cache-size': {
    path: 'decision',
    what: 'Refresh the hot cache so it is rebuilt at its intended size.',
    who: 'the "Refresh hot cache" button on this screen',
    cost: 'agent run · ~1 min',
    limit: 'A whole-vault rule: it reads its file whole on every call and cannot be cleared per page.',
  },
  quote: {
    path: 'run',
    what:
      'Check the quotation against the document the job read, then either correct the quotation or ' +
      'rewrite the sentence around it as a paraphrase. A quotation is never invented.',
    who: 'a bound agent run, one page',
    cost: 'agent run · one page, one commit',
    limit:
      'This is the one rule whose repair the standing re-check cannot confirm: a quotation is compared ' +
      'against the job’s own artifact, which only the run holds. The run therefore clears its own finding.',
  },
  'near-duplicate': {
    path: 'decision',
    what: 'Two pages say the same thing. Merging them, or deciding they differ, is yours.',
    who: 'you, with both pages open',
    cost: 'a decision',
    limit:
      'Deliberately given no run. Merging is forbidden to every writer here, and a run that only ' +
      'cross-referenced the two would pre-empt the decision it is not allowed to make.',
  },
  'title-name': {
    path: 'decision',
    what: 'Rename the file and its title together, then repoint the links that used the old title.',
    who: 'you',
    cost: 'a rename, by hand',
    limit:
      'The title-link pass repairs the LINKS to a drifted title and never the page the finding stands ' +
      'on, so it is not offered here: it would write pages this list never showed.',
  },
  'page-schema': {
    path: 'run',
    what:
      'Add the heading this page type is supposed to carry and fill it from what the page and the ' +
      'graph already hold. An empty heading is not a repair.',
    who: 'a bound agent run, one page',
    cost: 'agent run · one page, one commit',
  },
  'run-protocol': {
    path: 'pass',
    what: 'Remove the section about what a RUN did from the article it was written into.',
    who: 'a deterministic pass, from this row',
    cost: 'deterministic · one commit',
    limit:
      'A PARTIAL path: the pass removes five of the seven headings this rule names, and only where the ' +
      'section is short and cites no other page. A finding it cannot reach keeps its row after a ' +
      'successful apply, and that is not a failed fix.',
  },
  'tag-mirroring': {
    path: 'pass',
    what: 'Drop the tag that repeats the page’s own type: or domain: field.',
    who: 'a deterministic pass, from this row',
    cost: 'deterministic · one commit',
  },
  'tag-singleton': {
    path: 'pass',
    what: 'Drop the tag no other page in the vault uses - an index of one indexes nothing.',
    who: 'a deterministic pass, from this row',
    cost: 'deterministic · one commit',
    limit:
      'The pass is built vault-wide and this button is filtered to the pages the list names. Pages the ' +
      'validator has never read carry the same defect and will surface as NEW findings the first time ' +
      'a run touches them. That is expected, not a repair that did not hold.',
  },
  'em-dash': {
    path: 'pass',
    what: 'Replace em-dashes and en-dashes outside code with the house style’s hyphen.',
    who: 'a deterministic pass, from this row',
    cost: 'deterministic · one commit',
    limit:
      'Filtered to the pages the list names, like every pass here. Unchecked pages carrying the same ' +
      'defect surface later as new findings.',
  },
  'status-vocabulary': {
    path: 'decision',
    what: 'Put the page’s status: back inside the vocabulary the vault uses, or widen the vocabulary.',
    who: 'you, in the page view',
    cost: 'one edit',
    limit: 'Which of the two is right is the judgement, and a pass that guessed would standardise the wrong way.',
  },
  'open-question-form': {
    path: 'decision',
    what:
      'Rewrite the bullets so each asks one thing, ends in a question mark, names its subjects in full, ' +
      'and carries no reference to the run that wrote it. The reformulation on the board does one at a time.',
    who: 'you, or the reformulation from the board',
    cost: 'your reading, one bullet at a time',
    limit:
      'A bound run for this exists and is deliberately not offered. Measured over 10 pages against a bar ' +
      'agreed before the run (every bullet asks something, at most 2 of 10 pages still deictic): it left ' +
      '2 of 68 bullets asking nothing and 5 of 10 pages carrying a deictic bullet. A large improvement on ' +
      'where those pages started - 17 of 61 bullets asked anything - and short of what was asked for.',
  },
}
