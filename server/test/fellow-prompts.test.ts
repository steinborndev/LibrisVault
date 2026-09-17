/**
 * The prompt blocks a Fellow's run carries (src/pipeline/fellow-prompts.ts).
 *
 * Written 2026-09-08, when a review found the file had no test - despite its own docstring
 * saying it exists so that "what a Fellow's run is told can be unit-tested without a runner".
 * The same day made the case for it twice over: a planning prompt that stated a number
 * without saying what it was for cost three planning runs (TASKS-A1.md F5), and topic
 * sentences phrased as questions produced pages that answered the question instead of
 * bringing back the thing asked for. In this system prompt text IS behaviour, and the parts
 * of it that are assembled deterministically can be held in place like any other code.
 *
 * What each test pins is a rule that was learned the expensive way, so a rewrite that drops
 * one shows up here rather than in a run three nights later.
 */

import { describe, it, expect } from 'vitest'
import { renderFellowBlock, renderReadingList, renderStepCaps, type FellowRunContext } from '../src/pipeline/fellow-prompts.js'

const ctx = (over: Partial<FellowRunContext> = {}): FellowRunContext => ({
  agentId: 'a1',
  name: 'Ada',
  slug: 'ada',
  notebookPath: 'wiki/meta/agents/ada.md',
  intent: 'transit photometry systematics',
  scope: null,
  model: 'claude-sonnet-5',
  effort: 'high',
  maxBudgetUsd: 6,
  recentLog: [],
  today: '2026-09-08',
  ...over,
})

describe('the Fellow block', () => {
  it('names who is working, on what, and where the open questions go', () => {
    const p = renderFellowBlock(ctx())
    expect(p).toContain('<fellow>')
    expect(p).toContain('</fellow>')
    expect(p).toContain('"Ada"')
    expect(p).toContain('transit photometry systematics')
    expect(p).toContain('wiki/meta/agents/ada.md')
    expect(p).toContain('## Open Questions')
  })

  it('carries the scope notes when there are any, and says nothing when there are none', () => {
    // The scope is the user's steer on HOW to work, and the 2026-09-08 diagnosis turned on
    // its absence: a Fellow with no scope note had nothing telling it what artifact to file.
    expect(renderFellowBlock(ctx({ scope: 'File every recipe with its full method.' }))).toContain(
      'Scope notes from the user: File every recipe with its full method.',
    )
    expect(renderFellowBlock(ctx())).not.toContain('Scope notes')
  })

  it('says it is the first run when there is no log, and lists the lines when there is one', () => {
    expect(renderFellowBlock(ctx())).toContain('this is your first run')
    const withLog = renderFellowBlock(ctx({ recentLog: ['2026-09-07 · research · x · 3 page(s)'] }))
    expect(withLog).toContain('- 2026-09-07 · research · x · 3 page(s)')
    expect(withLog).not.toContain('this is your first run')
  })

  it('holds the notebook to appending, and to its OWN notebook', () => {
    /*
     * Both halves are boundaries, not style. Appending is what keeps a run from rewriting
     * the record it is judged against; the other-Fellows half is the cross-Fellow write ban
     * (OPEN-16, handoffs are service-side) stated where the agent can read it.
     */
    const p = renderFellowBlock(ctx())
    expect(p).toContain('Append only')
    expect(p).toMatch(/never rewrite or remove other sections/i)
    expect(p).toMatch(/never\s+touch the notebooks of other Fellows/i)
    expect(p).toContain('wiki/meta/agents/')
  })

  it('carries the reading list, because every writing run does', () => {
    // It used to hang off the research STEP alone, so a full sweep left nothing behind
    // (section 10.6). The block is part of the Fellow block now, not of one run kind.
    const p = renderFellowBlock(ctx())
    expect(p).toContain('<reading_list>')
    expect(p).toContain('wiki/meta/reading-list.md')
  })
})

describe('the reading list block', () => {
  it('asks for one entry per publication in a fixed shape, signed and dated', () => {
    const p = renderReadingList('Ada', '2026-09-08')
    for (const field of ['title:', 'url:', 'ref:', 'domain:', 'why:', 'access:', 'blocked:']) {
      expect(p).toContain(field)
    }
    expect(p).toContain('by: Ada')
    expect(p).toContain('at: 2026-09-08')
    // The name is given, not left to the run: one copied its by line from the entries
    // already on the page and signed a retired Fellow.
    expect(p).toContain('never a name copied')
  })

  it('asks hardest for what it could NOT read, and forbids fetching the document itself', () => {
    /*
     * The two rules that make the list worth having. A paper behind a paywall is exactly the
     * one the user's own access can get and the agent's cannot, so it belongs on the list
     * WITH the reason; and the entry is a request, not a download - the service fetches when
     * the user asks.
     */
    const p = renderReadingList('Ada', '2026-09-08')
    expect(p).toMatch(/could NOT read matter most/i)
    expect(p).toContain('open, paywalled or unreachable')
    expect(p).toMatch(/Do not download the document yourself/i)
    expect(p).toMatch(/Append only/i)
  })
})

describe('the research step caps', () => {
  it('tightens the program for one run, in numbers the run can check itself against', () => {
    // The step's whole identity is that it is smaller than a sweep. `program.md` lives in the
    // vault and is not ours to edit (hard rule 5), so a step narrows it by saying so.
    const p = renderStepCaps()
    expect(p).toContain('<research_step>')
    expect(p).toContain('skills/autoresearch/references/program.md')
    expect(p).toContain('at most 1 search round')
    expect(p).toContain('at most 5 sources')
    expect(p).toContain('at most 5 new wiki pages')
  })

  it('tells a step that found nothing to say so rather than pad', () => {
    expect(renderStepCaps()).toMatch(/keep the synthesis page short and say so/i)
  })
})
