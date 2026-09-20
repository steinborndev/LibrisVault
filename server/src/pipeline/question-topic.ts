/**
 * Turning an open question into a topic a research run can act on
 * (docs/tasks/TASKS-QUESTIONS.md, phase 2).
 *
 * The planner has always done this. A candidate reaches it as whatever the last run wrote, and
 * it answers with "a precise topic sentence a research run can act on, one sentence, not a
 * paragraph" - so a Fellow's nightly work never sees the raw bullet. The board's own "Start
 * research" had no such step: the bullet went through as the topic, into the prompt, into the
 * title match, and into the name of the page the run files. On the measured vault that means
 * 95 % of them would have named a page with a sentence cut mid-clause.
 *
 * Same shape as `dedupe-judge.ts`, for the same reason: a pure prompt builder, a schema that
 * binds the answer, and one thin call, so everything except the call is unit-testable.
 *
 * Three properties the callers depend on:
 *   - It NEVER throws. A failed run, a schema violation, a timeout: all return null, and the
 *     caller keeps the raw text (decision D3). A reformulation is an improvement on an action
 *     that already works, so it may not be able to break it.
 *   - It is read-only. `profile: 'query'` gives the run no vault write path and no web.
 *   - The excerpt is bounded. The run is handed a slice of the origin page rather than a read
 *     tool and the freedom to wander, which keeps one sentence from costing a file-reading loop.
 */

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { runAgent, type AgentAuth } from './agent-runner.js'
import { FIELD_CAPS } from './planner.js'
import { RESEARCH_PREFIX, RESEARCH_PROFILES, TITLE_MAX_CHARS, titleSafe } from './research-profiles.js'
import { PASS_DEIXIS } from './question-form.js'
import { parseNotebook } from './notebook.js'
import { resolveWikiPage } from './vault-paths.js'

/** The topic sentence may be as long as the one the planner is allowed to write, and no longer. */
export const TOPIC_MAX_CHARS = FIELD_CAPS.topic

/**
 * How long the title may be, computed rather than chosen: what is left of a page name once the
 * service has added its `Research - ` prefix and the longest lens suffix. A title that fits here
 * survives `researchTargetTitle` without being cut, which is the whole point of asking for one.
 */
export const TITLE_BUDGET =
  TITLE_MAX_CHARS - RESEARCH_PREFIX.length - Math.max(...RESEARCH_PROFILES.map((p) => p.titleSuffix.length))

/**
 * How much of the origin page reaches the prompt. Two thousand characters is a page's opening
 * and its open-questions section on this vault, and it keeps the call's cost flat whatever the
 * page weighs - `index.md` here is half a megabyte.
 */
export const EXCERPT_MAX_CHARS = 2000

/** Default timeout: this is one sentence, not a research run. */
export const TOPIC_TIMEOUT_MS = 2 * 60_000

export interface TopicInput {
  /** The bullet as it stands on the page. */
  readonly text: string
  /** The page it stands on, vault-relative, when it has one. */
  readonly page?: string
  /** A bounded slice of that page; {@link readPageExcerpt} produces it. */
  readonly pageExcerpt?: string
}

/** What a successful reformulation returns. */
export interface TopicSuggestion {
  readonly topic: string
  readonly title: string
}

const answerSchema = z.object({
  topic: z.string().trim().min(1).max(TOPIC_MAX_CHARS),
  title: z.string().trim().min(1).max(TITLE_BUDGET),
})

/** The JSON schema that binds the answer, in the shape the SDK's structured output takes. */
export function topicSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['topic', 'title'],
    properties: {
      topic: { type: 'string', minLength: 1, maxLength: TOPIC_MAX_CHARS },
      title: { type: 'string', minLength: 1, maxLength: TITLE_BUDGET },
    },
  }
}

/**
 * A bounded slice of the page a question stands on: what it calls itself, how it opens, and its
 * own open-questions section. That is what resolves a reference like "either source" - the
 * sources are named further up the page - without handing over the whole file.
 */
export function readPageExcerpt(vaultRoot: string, page: string, max = EXCERPT_MAX_CHARS): string | undefined {
  const abs = resolveWikiPage(vaultRoot, page)
  if (abs === null) return undefined
  let markdown: string
  try {
    markdown = fs.readFileSync(abs, 'utf8')
  } catch {
    return undefined
  }
  const name = path.posix.basename(page, '.md')
  const body = markdown.startsWith('---') ? markdown.slice(markdown.indexOf('\n---', 3) + 4) : markdown
  const questions = parseNotebook(markdown).sections.get('Open questions') ?? parseNotebook(markdown).sections.get('Open Questions')
  const opening = body.trim().slice(0, max)
  const tail = questions === undefined ? '' : `\n\nIts open questions section:\n${questions.slice(0, max)}`
  return `Page "${name}":\n${opening}${tail}`.slice(0, max * 2)
}

/**
 * The prompt.
 *
 * Every rule below is a measured defect rather than a preference (the numbers are section 0 of
 * the task file, over the 355 bullets standing on this vault):
 *   - 8 % end in a question mark, so it asks for a question and says that plainly.
 *   - 43 % refer to the run that wrote them, so the deixis list comes from `question-form.ts` -
 *     the same list the audit counts with and the validator will flag with.
 *   - 95 % are too long to be a page name, so the title is asked for separately and capped.
 *   - 43 % open by reporting what could not be found, which is worth keeping and is not the
 *     question: it goes in brackets at the end, where it informs without being the topic.
 *
 * The `Research - ` prefix is the service's to add. A model that helpfully includes it produces
 * "Research - Research - ..."; the instruction says so, and `cleanTitle` enforces it anyway.
 */
export function renderTopicPrompt(input: TopicInput): string {
  const deixis = PASS_DEIXIS.slice(0, 6)
    .map((d) => `"${d.name}"`)
    .join(', ')
  return (
    'A research run left this note under the "Open questions" heading of a page in a knowledge ' +
    'vault. Someone now wants to research it. Turn it into a topic a fresh research run can act ' +
    'on without ever seeing the page it came from.\n\n' +
    `The note:\n${input.text}\n\n` +
    (input.page !== undefined ? `It stands on this page: ${input.page}\n` : '') +
    (input.pageExcerpt !== undefined ? `\n${input.pageExcerpt}\n` : '') +
    '\nAnswer with two things.\n\n' +
    '`topic`: one sentence, phrased as what is to be found out. It must stand on its own:\n' +
    `- No reference to the run that wrote the note (${deixis} and anything like them). The run ` +
    'that reads your topic is a different run and knows nothing about that one.\n' +
    '- Spell out every name the note refers to indirectly. "Either source", "the figures above" ' +
    'and "both companies" mean nothing once the sentence travels alone; if the page names them, ' +
    'name them; if it does not, describe them.\n' +
    '- Ask something, and END THE SENTENCE WITH A QUESTION MARK. Not "Determine whether ...", ' +
    'not "Find the ...", not "Investigate ...": an actual question. A note that reports what ' +
    'could not be established says what is missing, which is not the same as saying what to go ' +
    'and find.\n' +
    '- Keep what the note knew. If it said why the question stayed open (a paywall, only trade ' +
    'coverage, no independent data), put that in brackets just BEFORE the question mark, so the ' +
    'sentence still ends as a question. It steers the run without becoming the question.\n' +
    `- At most ${TOPIC_MAX_CHARS} characters, and one sentence rather than a paragraph.\n\n` +
    '`title`: a short name for the page this research will be filed under. Not a sentence: the ' +
    'subject, the way an encyclopedia would name the article.\n' +
    `- At most ${TITLE_BUDGET} characters.\n` +
    `- Do NOT start it with "${RESEARCH_PREFIX.trim()}" or any other prefix. The service adds that.\n` +
    '- No question mark, no trailing punctuation, and none of / \\ : ? * " < > |\n\n' +
    'If the note is already a good research question, keep its wording and answer with it. Do ' +
    'not invent facts that are in neither the note nor the page.'
  )
}

/**
 * The title as it may be used: the service's own prefix stripped if the answer carried it,
 * then through the same `titleSafe` a topic-derived title goes through.
 */
export function cleanTitle(title: string): string {
  const withoutPrefix = title.trim().replace(/^research\s*[-:]\s*/i, '')
  return titleSafe(withoutPrefix === '' ? title : withoutPrefix)
}

export interface ReformulateOptions {
  readonly vaultRoot: string
  readonly auth: AgentAuth
  readonly model?: string
  readonly timeoutMs?: number
  /** Injectable for tests; defaults to the real runner. */
  readonly run?: typeof runAgent
}

/**
 * One reformulation. Returns null rather than throwing, for every way this can fail: the caller
 * falls back to the raw text and the action still works (D3).
 */
export async function reformulate(input: TopicInput, opts: ReformulateOptions): Promise<TopicSuggestion | null> {
  if (input.text.trim() === '') return null
  const run = opts.run ?? runAgent
  const excerpt = input.pageExcerpt ?? (input.page !== undefined ? readPageExcerpt(opts.vaultRoot, input.page) : undefined)
  /*
   * The page is NAMED only when it could actually be read. A path that resolved to nothing is
   * a claim the run cannot check, and it arrives from a request body: naming it would put an
   * unvalidated string into the prompt for no benefit. When the excerpt is there, the path has
   * been through `resolveWikiPage` and is a real page under `wiki/`.
   */
  const named = excerpt !== undefined && input.page !== undefined ? input.page : undefined
  try {
    const result = await run({
      vaultRoot: opts.vaultRoot,
      prompt: renderTopicPrompt({
        text: input.text,
        ...(named !== undefined ? { page: named } : {}),
        ...(excerpt !== undefined ? { pageExcerpt: excerpt } : {}),
      }),
      auth: opts.auth,
      // Read-only, no web: this reads one note and one page slice and writes a sentence.
      profile: 'query',
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      timeoutMs: opts.timeoutMs ?? TOPIC_TIMEOUT_MS,
      outputFormat: { type: 'json_schema', schema: topicSchema() },
    })
    if (!result.ok) return null
    const parsed = answerSchema.safeParse(result.structuredOutput)
    if (!parsed.success) return null
    const title = cleanTitle(parsed.data.title)
    if (title === '' || title === 'untitled') return null
    return { topic: parsed.data.topic.trim(), title }
  } catch {
    return null
  }
}
