import { describe, expect, it } from 'vitest'
import { questionClusters, questionDomains, questionView } from '../src/lib/questions.ts'
import { researchRoute } from '../src/components/library/QuestionBoard.tsx'
import type { QuestionItem } from '../src/api/types.ts'

const q = (over: Partial<QuestionItem> & Pick<QuestionItem, 'id' | 'text'>): QuestionItem => ({ page: 'wiki/concepts/X.md', domain: 'astronomy', archived: false, planned: null, researching: null, ...over })

describe('the pinboard view', () => {
  const entries = [
    q({ id: '1', text: 'What is the orbital period of the inner moon?', domain: 'computing' }),
    q({ id: '2', text: 'How hot does the transfer chamber run?', planned: { proposalId: 'p1', agentId: 'a1', fellow: 'Ada', status: 'proposed' } }),
    q({ id: '3', text: 'Which coating survives the dust load?', archived: true }),
    q({ id: '4', text: 'What powers the relay after sunset?', domain: null, researching: { runId: 'r1' } }),
  ]
  const open = questionClusters(entries)

  it('cuts by tab, then by domain, and counts what is planned and running', () => {
    const all = questionView(open)
    expect(all.shown.map((c) => c.id)).toEqual(['1', '2', '4'])
    expect(all).toMatchObject({ total: 3, planned: 1, researching: 1 })
    expect(questionClusters(entries, 'archived').map((c) => c.id)).toEqual(['3'])
    expect(questionView(open, 'astronomy').shown.map((c) => c.id)).toEqual(['2'])
    // A question without a domain stands under "all domains" only.
    expect(questionView(open, 'computing').shown.map((c) => c.id)).toEqual(['1'])
  })

  it('rings the domains alphabetically, without the domain-less', () => {
    expect(questionDomains(open)).toEqual(['astronomy', 'computing'])
  })

  it('hands a question to the Research tab as its topic', () => {
    expect(researchRoute('Why does it climb?')).toBe('/research?prefill=Why%20does%20it%20climb%3F')
  })
})
