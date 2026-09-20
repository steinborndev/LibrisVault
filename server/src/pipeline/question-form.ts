/**
 * The FORM of an open question: the one vocabulary the three places that judge it share
 * (docs/tasks/TASKS-QUESTIONS.md, phases 0, 3 and 5).
 *
 * Measured on this vault 2026-09-20, over the 355 bullets the pinboard was showing: 29 of them
 * (8 %) ended in a question mark, 153 opened by reporting what a run could not do, and 152
 * referred to the run that wrote them ("in this pass", "either source") in a way that stops
 * meaning anything the moment the bullet leaves its page. That is what the classifiers below
 * count, what the prompt rule will ask runs to avoid, and what the validator will flag.
 *
 * Deliberately pure and import-free. The audit CLI, a prompt builder and `validator.ts` all
 * read it, and the validator must not drag a planning module in behind it.
 *
 * There is no length threshold here on purpose. The two caps a question can actually collide
 * with already exist and are owned elsewhere - `TITLE_MAX_CHARS` (a topic that becomes a page
 * name) and the planner's `FIELD_CAPS.topic` - so the audit imports those rather than inventing
 * a third number nobody can defend.
 */

/** How a bullet reads, once. The three are exclusive and tested in this order. */
export type QuestionForm =
  /** Ends in a question mark: it asks something. */
  | 'question'
  /** Opens by reporting what a run could not establish, reach or verify. */
  | 'limitation'
  /** Any other declarative sentence. */
  | 'statement'

/**
 * Phrases that tie a bullet to the run that wrote it. Each is counted separately by the audit,
 * because the prompt rule of phase 3 should name the ones that actually occur rather than a
 * plausible-looking list.
 *
 * `above` is the widest of them and is kept deliberately: "the figures above" is exactly the
 * reference that survives a handoff as a dangling pointer. The audit's per-phrase counts say
 * how much of the total it carries.
 */
export const PASS_DEIXIS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: 'this pass', re: /\bthis pass\b/i },
  { name: 'this step', re: /\bthis step\b/i },
  { name: 'this run', re: /\bthis run\b/i },
  { name: 'this session', re: /\bthis session\b/i },
  { name: 'in this vault', re: /\bin this vault\b/i },
  { name: 'either source', re: /\beither source\b/i },
  { name: 'both sources', re: /\bboth sources\b/i },
  { name: 'neither source', re: /\bneither source\b/i },
  { name: 'the N sources', re: /\bthe (two|three) sources\b/i },
  { name: 'sourced here', re: /\bsourced here\b/i },
  { name: 'not sourced', re: /\bnot sourced\b/i },
  { name: 'this synthesis', re: /\bthis synthesis\b/i },
  { name: 'above', re: /\babove\b/i },
  { name: 'the sources here', re: /\bthe sources here\b/i },
]

/**
 * How a limitation note opens. Not a style judgement: every pattern here was read off the
 * bullets themselves, and each one describes the absence of a finding rather than the finding
 * that is wanted.
 */
export const LIMITATION_PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: 'negated verb', re: /\b(was|were|is|are|did|does|could|can)( not|n't)\b/i },
  { name: 'no <evidence>', re: /\bno (independent|performance|source|evidence|data|benchmark)/i },
  {
    name: 'not <done>',
    re: /\bnot (searched|chased|verified|found|covered|filed|detailed|attempted|pursued|confirmed|resolved|independently)\b/i,
  },
  { name: 'remains open', re: /\bremains? (unstarted|open|unverified)\b/i },
  { name: 'needs a pass', re: /\bneeds? a\b|\bwould need\b|\bworth a\b/i },
]

/** True when the bullet ends in a question mark, which is the only thing that makes it ask. */
export function asksAQuestion(text: string): boolean {
  return /\?\s*$/.test(text)
}

/** True when the bullet refers to the run that wrote it. Also see {@link passDeixisIn}. */
export function hasPassDeixis(text: string): boolean {
  return PASS_DEIXIS.some((d) => d.re.test(text))
}

/** Which deixis phrases the bullet carries, by name, for the audit's per-phrase counts. */
export function passDeixisIn(text: string): string[] {
  return PASS_DEIXIS.filter((d) => d.re.test(text)).map((d) => d.name)
}

/** True when the bullet reports what could not be established. */
export function readsAsLimitation(text: string): boolean {
  return LIMITATION_PATTERNS.some((p) => p.re.test(text))
}

/**
 * The bullet's form. A question mark wins over everything: a sentence that asks has done its
 * job however it explains itself, and half of the few real questions on this vault also carry
 * a limitation clause.
 */
export function classifyQuestion(text: string): QuestionForm {
  if (asksAQuestion(text)) return 'question'
  if (readsAsLimitation(text)) return 'limitation'
  return 'statement'
}
