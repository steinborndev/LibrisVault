import { describe, expect, it } from 'vitest'
import { questionDomains, questionView } from '../src/lib/questions.ts'
import { researchRoute } from '../src/components/library/QuestionBoard.tsx'
import type { QuestionItem } from '../src/api/types.ts'

const q = (over: Partial<QuestionItem> & Pick<QuestionItem, 'id' | 'text'>): QuestionItem => ({ page: 'wiki/concepts/X.md', domain: 'astronomy', archived: false, planned: null, researching: null, ...over })

describe('the pinboard view', () => {
  const entries = [
    q({ id: '1', text: 'A?', domain: 'computing' }),
    q({ id: '2', text: 'B?', planned: { proposalId: 'p1', agentId: 'a1', fellow: 'Ada', status: 'proposed' } }),
    q({ id: '3', text: 'C?', archived: true }),
    q({ id: '4', text: 'D?', domain: null, researching: { runId: 'r1' } }),
  ]
  it('cuts by tab, then by domain, and counts what is planned and running', () => {
    const all = questionView(entries)
    expect(all.shown.map((e) => e.id)).toEqual(['1', '2', '4'])
    expect(all).toMatchObject({ total: 3, archived: 1, planned: 1, researching: 1 })
    expect(questionView(entries, 'archived').shown.map((e) => e.id)).toEqual(['3'])
    expect(questionView(entries, 'current', 'astronomy').shown.map((e) => e.id)).toEqual(['2'])
    // A question without a domain stands under "all domains" only.
    expect(questionView(entries, 'current', 'computing').shown.map((e) => e.id)).toEqual(['1'])
  })
  it('rings the domains alphabetically, without the domain-less', () => {
    expect(questionDomains(questionView(entries).shown)).toEqual(['astronomy', 'computing'])
  })
  it('hands a question to the Research tab as its topic', () => {
    expect(researchRoute('Why does it climb?')).toBe('/research?prefill=Why%20does%20it%20climb%3F')
  })
})
