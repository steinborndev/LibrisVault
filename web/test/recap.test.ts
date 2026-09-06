import { describe, expect, it } from 'vitest'
import { answerCode, needsDecision, nightLine, undecidedCount } from '../src/lib/recap.ts'
import type { RecapModel, RecapRow } from '../src/api/types.ts'

const model = (over: Partial<RecapModel> = {}): RecapModel => ({
  cycleDate: '2026-09-07',
  generatedAt: '2026-09-07T05:00:00.000Z',
  quiet: false,
  since: '2026-09-06T05:00:00.000Z',
  window: { start: '01:00', end: '06:00' },
  shift: null,
  totals: { runs: 2, failed: 1, costUsd: 4.5, pages: 7 },
  usage: { today: { costUsd: 1, runs: 1 }, week: { costUsd: 2, runs: 2 } },
  value: { pageOpens: 0, recapLinks: 0 },
  fellows: [
    {
      index: 1,
      agentId: 'a1',
      name: 'Ada',
      homeDomain: 'astronomy',
      model: 'sonnet-5',
      autonomy: 'veto',
      state: 'waiting',
      sleepCode: null,
      sleepReason: null,
      skipUntil: null,
      notebookPath: 'wiki/meta/agents/ada.md',
      runs: [],
      found: [],
      openQuestions: [],
      proposals: [
        { code: '1a', proposalId: 'p1', kind: 'research-step', topic: 'T', rationale: '', provenance: { candidate: 'gap', text: 'x', sourcePages: [] }, estCostUsd: 2, scopeScore: 0.5, drift: false, status: 'approved', rank: 1 },
        { code: '1b', proposalId: 'p2', kind: 'research-step', topic: 'U', rationale: '', provenance: { candidate: 'gap', text: 'x', sourcePages: [] }, estCostUsd: 2, scopeScore: 0.5, drift: false, status: 'proposed', rank: 2 },
      ],
      value: { pageOpens: 0, recapLinks: 0 },
    },
  ],
  sleeping: [],
  summaryNote: null,
  summaryCostUsd: null,
  unclaimed: [],
  dedupe: { merged: [], overlaps: [] },
  ...over,
})

describe('recap helpers', () => {
  it('counts what is undecided and knows when a recap needs nothing', () => {
    const row: RecapRow = { cycleDate: '2026-09-07', generatedAt: 'g', path: 'p', quiet: false, model: model(), delivered: {}, answeredAt: null }
    expect(undecidedCount(row.model)).toBe(1)
    expect(needsDecision(row)).toBe(true)
    expect(needsDecision({ ...row, quiet: true, model: model({ quiet: true }) })).toBe(false)
  })

  it('spells the Telegram code for every answer kind', () => {
    expect(answerCode({ action: 'pick', fellow: 1, letter: 'b' })).toBe('1b')
    expect(answerCode({ action: 'veto', fellow: 1 })).toBe('veto 1')
    expect(answerCode({ action: 'veto', fellow: 1, letter: 'a' })).toBe('veto 1a')
    expect(answerCode({ action: 'skip', fellow: 2 })).toBe('skip 2')
    expect(answerCode({ action: 'note', fellow: 2, text: 'hi' })).toBe('note 2: hi')
    expect(answerCode({ action: 'model', fellow: 2, value: 'opus-5' })).toBe('model 2 opus-5')
    expect(answerCode({ action: 'topic', fellow: 2, letter: 'a', text: 'new' })).toBe('topic 2a: new')
    expect(answerCode({ action: 'spawn', request: 1, name: 'Cleo' })).toBe('spawn u1 Cleo')
    expect(answerCode({ action: 'spawn', request: 2 })).toBe('spawn u2')
  })

  it('sums the night into one line', () => {
    expect(nightLine(model())).toBe('2 runs · 1 failed · 7 pages · 4.50 USD')
    expect(nightLine(model({ quiet: true }))).toBe('Nothing ran tonight.')
  })
})
