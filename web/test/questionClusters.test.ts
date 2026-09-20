/**
 * Grouping the rows that are the same question written more than once
 * (docs/tasks/TASKS-QUESTIONS.md, phase 4).
 *
 * **These are the same cases as `server/test/question-audit.test.ts`, deliberately.** The
 * measure lives twice - `scopeScore` over `tokenize` on the server, mirrored in
 * `web/src/lib/questions.ts` - because the audit CLI cannot be imported into a browser bundle
 * and the board cannot import server code. Two implementations of one measure drift unless
 * something pins them, and what pins them is this: the same three wordings must group here and
 * there, and the same follow-up must stay out of the group in both.
 *
 * Every question below is invented (hard rule 7).
 */

import { describe, expect, it } from 'vitest'
import { archiveCluster, CLUSTER_THRESHOLD, questionClusters, questionOverlap } from '../src/lib/questions.ts'
import type { QuestionItem } from '../src/api/types.ts'

const q = (id: string, text: string, over: Partial<QuestionItem> = {}): QuestionItem => ({
  id,
  text,
  page: `wiki/concepts/${id}.md`,
  domain: 'energy',
  archived: false,
  planned: null,
  researching: null,
  ...over,
})

/** The shape this vault actually produces: one run, three pages, three wordings. */
const SAME = [
  'Tidal turbine blade fatigue under continuous sediment loading was not measured by either source in this pass.',
  'Whether continuous sediment loading causes measurable blade fatigue in tidal turbines was not established.',
  'Blade fatigue from sediment loading in tidal turbines remains unquantified.',
]
const FOLLOW_UP = 'Which coating materials reduce sediment abrasion on tidal turbine blades?'

describe('the mirrored measure', () => {
  it('agrees with the server on the threshold', () => {
    // `CLUSTER_THRESHOLD` in server/src/cli/questionaudit.ts. If one moves, move both.
    expect(CLUSTER_THRESHOLD).toBe(0.7)
  })

  it('scores as an overlap coefficient over significant tokens', () => {
    expect(questionOverlap('tidal turbine blades', 'tidal turbine blades')).toBe(1)
    expect(questionOverlap('', 'anything')).toBe(0)
    // Shared function words are not similarity: every token here is a stopword or a question word.
    expect(questionOverlap('What is this about?', 'Which of these and those?')).toBe(0)
  })
})

describe('questionClusters', () => {
  it('groups three wordings of one question written on three pages', () => {
    const clusters = questionClusters([
      q('a', SAME[0]!, { page: 'wiki/concepts/Tidal Turbine.md' }),
      q('b', SAME[1]!, { page: 'wiki/questions/Research - tidal power.md' }),
      q('c', SAME[2]!, { page: 'wiki/meta/agents/fixture.md' }),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.members).toHaveLength(3)
  })

  it('leads with the longest wording, which carries the most context', () => {
    const clusters = questionClusters([q('a', SAME[2]!), q('b', SAME[0]!), q('c', SAME[1]!)])
    expect(clusters[0]!.lead.text).toBe(SAME[0])
    expect(clusters[0]!.id).toBe('b')
  })

  it('leaves a narrower follow-up on the same subject alone', () => {
    // The expensive error: merging away the most valuable kind of question.
    const clusters = questionClusters([q('a', SAME[2]!), q('b', FOLLOW_UP)])
    expect(clusters).toHaveLength(2)
  })

  it('leaves two different questions alone', () => {
    const clusters = questionClusters([
      q('a', 'What is the measured capacity factor of a rack-mounted tidal turbine over a full spring-neap cycle?'),
      q('b', 'How long does a pitch bearing last in continuous submerged service?'),
    ])
    expect(clusters).toHaveLength(2)
  })

  it('never mixes an archived wording with an open one', () => {
    const entries = [q('a', SAME[0]!), q('b', SAME[1]!, { archived: true })]
    expect(questionClusters(entries, 'current').map((c) => c.members.length)).toEqual([1])
    expect(questionClusters(entries, 'archived').map((c) => c.members.length)).toEqual([1])
  })

  it('claims the row when any wording is claimed', () => {
    const planned = { proposalId: 'p1', agentId: 'a1', fellow: 'Ada', status: 'proposed' }
    const clusters = questionClusters([q('a', SAME[0]!), q('b', SAME[1]!, { planned }), q('c', SAME[2]!, { researching: { runId: 'r1' } })])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.planned).toEqual(planned)
    expect(clusters[0]!.researching).toEqual({ runId: 'r1' })
  })

  it('stands in every domain one of its wordings stands in', () => {
    // Otherwise grouping would hide a question from a shelf it genuinely belongs to.
    const clusters = questionClusters([q('a', SAME[0]!, { domain: 'energy' }), q('b', SAME[1]!, { domain: 'materials' })])
    expect(clusters).toHaveLength(1)
    expect([...clusters[0]!.domains].sort()).toEqual(['energy', 'materials'])
  })

  it('keeps the order the entries arrived in, so rows do not reshuffle between polls', () => {
    const entries = [q('a', 'What powers the relay after sunset?'), q('b', SAME[0]!), q('c', SAME[1]!)]
    expect(questionClusters(entries).map((c) => c.id)).toEqual(['a', 'b'])
    // And the same input in the same order gives the same output, every time.
    expect(questionClusters(entries).map((c) => c.id)).toEqual(questionClusters(entries).map((c) => c.id))
  })

  it('handles the empty board', () => {
    expect(questionClusters([])).toEqual([])
  })
})

describe('archiving a row', () => {
  const members = [q('a', SAME[0]!, { page: 'wiki/concepts/One.md' }), q('b', SAME[1]!, { page: 'wiki/questions/Two.md' }), q('c', SAME[2]!, { page: 'wiki/meta/Three.md' })]

  it('strikes every wording, one call at a time, in order', async () => {
    const seen: string[] = []
    const done = await archiveCluster(members, true, async (page, _text, archived) => {
      expect(archived).toBe(true)
      seen.push(page)
    })
    expect(done).toBe(3)
    expect(seen).toEqual(['wiki/concepts/One.md', 'wiki/questions/Two.md', 'wiki/meta/Three.md'])
  })

  it('restores the same way', async () => {
    const flags: boolean[] = []
    await archiveCluster(members, false, async (_p, _t, archived) => {
      flags.push(archived)
    })
    expect(flags).toEqual([false, false, false])
  })

  it('says how far it got when one page fails', async () => {
    const calls: string[] = []
    await expect(
      archiveCluster(members, true, async (page) => {
        calls.push(page)
        if (page === 'wiki/questions/Two.md') throw new Error('that question is not on that page')
      }),
    ).rejects.toThrow(/1 of 3 page\(s\) done, then wiki\/questions\/Two.md failed: that question is not on that page/)
    // It stopped there rather than carrying on into an unknown state.
    expect(calls).toEqual(['wiki/concepts/One.md', 'wiki/questions/Two.md'])
  })

  it('keeps a single-page failure plain, with no count in front of it', async () => {
    await expect(
      archiveCluster([members[0]!], true, async () => {
        throw new Error('already stands that way')
      }),
    ).rejects.toThrow(/^already stands that way$/)
  })
})
