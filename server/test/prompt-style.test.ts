import { describe, it, expect } from 'vitest'
import {
  OPEN_QUESTION_FORM,
  PAGE_HYGIENE_CHECKLIST,
  TAG_HYGIENE_RULES,
  UNTRUSTED_CONTENT_RULES,
  ENTITY_NOTABILITY_RULES,
  renderProvenance,
  renderCompletionMarker,
  renderOaNotice,
} from '../src/pipeline/system-prompt.js'
import { renderProfileBlock, renderSynthesisMandate, getResearchProfile, RESEARCH_PROFILES } from '../src/pipeline/research-profiles.js'
import { renderOverlapBlock, renderQuestionOrigin } from '../src/pipeline/related-pages.js'
import { renderIngestOverlap } from '../src/pipeline/ingest-overlap.js'
import { domainSystemPrompt } from '../src/pipeline/domains.js'
import { renderLogEntry } from '../src/pipeline/hubs.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'

/**
 * The house style, applied to the text this service writes for an agent (B9, 4.5).
 *
 * 10,257 em-dashes across 819 vault pages, against a style that has banned them from the
 * start - and until now not one prompt said so, while the prompts themselves carried them.
 * A rule its own statement breaks is not a rule, so this asserts the statement first.
 *
 * It tests the RENDERED text rather than the source, because "agent-facing" is a property of
 * where a string ends up, not of which file it lives in.
 */
const DASHES = /[—–]/

/** Every block this service can put in front of an agent, rendered with plausible input. */
const promptText = (): Array<[string, string]> => {
  const profile = getResearchProfile(undefined)
  const blocks: Array<[string, string]> = [
    ['PAGE_HYGIENE_CHECKLIST', PAGE_HYGIENE_CHECKLIST],
    ['OPEN_QUESTION_FORM', OPEN_QUESTION_FORM],
    ['TAG_HYGIENE_RULES', TAG_HYGIENE_RULES],
    ['UNTRUSTED_CONTENT_RULES', UNTRUSTED_CONTENT_RULES],
    ['ENTITY_NOTABILITY_RULES', ENTITY_NOTABILITY_RULES],
    ['renderCompletionMarker', renderCompletionMarker('.vault-meta/runs/01JOB.done')],
    ['renderProvenance', renderProvenance([{ artifact: '.raw/01JOB/normalized.md', url: 'https://example.org/x' }])],
    ['renderOaNotice', renderOaNotice([])],
    ['renderSynthesisMandate', renderSynthesisMandate(profile, 'tidal turbines')],
    ['renderOverlapBlock', renderOverlapBlock({ pages: ['wiki/concepts/A.md'], syntheses: ['wiki/questions/B.md'] })],
    ['renderQuestionOrigin', renderQuestionOrigin('wiki/concepts/A.md')],
    ['renderIngestOverlap', renderIngestOverlap({ pages: ['wiki/concepts/A.md'], syntheses: [] }, ['wiki/concepts/B.md'])],
    [
      'domainSystemPrompt',
      domainSystemPrompt({ path: 'x.md', domains: [{ key: 'physics', description: 'Physics and optics.', tags: ['optics'] }] }),
    ],
    [
      'renderLogEntry',
      renderLogEntry({ date: '2026-09-19', kind: 'ingest', title: 'A Document', created: [{ rel: 'wiki/concepts/A.md' }], summary: 'It went well.' }),
    ],
  ]
  for (const p of RESEARCH_PROFILES) {
    blocks.push([`renderProfileBlock(${p.key})`, renderProfileBlock(p)])
    blocks.push([`synthesis title(${p.key})`, renderSynthesisMandate(p, 'tidal turbines')])
  }
  return blocks
}

/**
 * The lint prompt and the report it owns (2026-09-20).
 *
 * The report path carries a date, so a second lint on one day meets the first one's file. The
 * prompt said "do not modify any EXISTING wiki page", the run found today's report already
 * there, read that as covering it, and stopped - eleven minutes and 2.36 USD for nothing.
 */
describe('the lint prompt', () => {
  it('says today\'s report is the run\'s to replace', async () => {
    let seen = ''
    const runner = new MaintenanceRunner({
      vaultRoot: '/tmp/does-not-need-to-exist',
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex: new Mutex(),
      // The prompt is built before the model is reached, which is what this reads.
      runAgent: async (opts) => {
        seen = opts.prompt
        throw new Error('stopped before the model')
      },
      commit: async () => ({ committed: false, committedPages: [] }),
    })
    const run = runner.startLint()
    for (let i = 0; i < 200 && runner.getRun(run.id)?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(seen).toMatch(/report for TODAY already exists/i)
    expect(seen).toMatch(/yours to\s+replace/i)
    // And the rule it is an exception to is still stated.
    expect(seen).toMatch(/do not modify any EXISTING wiki page/)
  })
})

describe('the text this service puts in front of an agent', () => {
  it('carries no em-dash and no en-dash', () => {
    const offenders = promptText().filter(([, text]) => DASHES.test(text)).map(([name]) => name)
    expect(offenders).toEqual([])
  })

  it('states the rule it follows', () => {
    // The prompt has to SAY it, or a run has no way to know: the vault filled up with 10,257
    // of them while every rule about them lived only in this repo's own style guide.
    expect(PAGE_HYGIENE_CHECKLIST).toContain('No em-dashes and no en-dashes')
  })

  it('covers a research lens title, which becomes a page name', () => {
    // The lens suffixes end up in a title and therefore in a file name, where an em-dash is
    // both a style violation and a character some sync tools mangle.
    for (const p of RESEARCH_PROFILES) expect(p.titleSuffix, p.key).not.toMatch(DASHES)
  })
})
