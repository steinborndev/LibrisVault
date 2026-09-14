/**
 * Home's recap feed (docs/agents/SPEC.md section 9.3): the week the rail shows, the day
 * format it prints, which recaps the feed renders under the filters, and the sentence a
 * dimmed day answers with.
 */

import { describe, expect, it } from 'vitest'
import {
  absenceOf,
  addDays,
  earliestWeek,
  feedRows,
  fmtDay,
  fmtWeek,
  localDate,
  openingWeek,
  runsInWeek,
  weekDays,
  weekStartOf,
  workedOn,
} from '../src/lib/recapFeed.ts'
import type { RecapFellow, RecapModel, RecapRow } from '../src/api/types.ts'

const fellow = (over: Partial<RecapFellow> = {}): RecapFellow => ({
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
  proposals: [],
  value: { pageOpens: 0, recapLinks: 0 },
  ...over,
})

const run = { runId: 'r1', kind: 'research-step', topic: 'T', ok: true, error: null, pagesCreated: [], pagesUpdated: [], commit: null, costUsd: 2, startedAt: '2026-09-06T02:00:00.000Z', proposalId: null }

const row = (date: string, over: Partial<RecapModel> = {}): RecapRow => ({
  cycleDate: date,
  generatedAt: `${date}T05:00:00.000Z`,
  path: `wiki/meta/recaps/Recap ${date}.md`,
  quiet: over.quiet ?? false,
  answeredAt: null,
  delivered: {},
  model: {
    cycleDate: date,
    generatedAt: `${date}T05:00:00.000Z`,
    quiet: false,
    sinceBuilt: null,
    readingFiled: [],
    since: `${date}T00:00:00.000Z`,
    window: { start: '01:00', end: '06:00' },
    shift: null,
    totals: { runs: 1, failed: 0, costUsd: 2, pages: 3 },
    usage: { today: { costUsd: 2, runs: 1 }, week: { costUsd: 8, runs: 4 } },
    value: { pageOpens: 0, recapLinks: 0 },
    fellows: [fellow({ runs: [run] })],
    sleeping: [],
    summaryNote: null,
    summaryCostUsd: null,
    unclaimed: [],
    dedupe: { merged: [], overlaps: [] },
    ...over,
  },
})

describe('the week the rail shows', () => {
  it('formats a day and a week, and walks days across month ends', () => {
    expect(fmtDay('2026-09-06')).toBe('06 Sep 2026')
    expect(fmtDay('2026-01-01')).toBe('01 Jan 2026')
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(localDate(new Date(2026, 8, 6))).toBe('2026-09-06')
    // 06 Sep 2026 is a Sunday, so its week starts on 31 Aug.
    expect(weekStartOf('2026-09-06')).toBe('2026-08-31')
    expect(weekStartOf('2026-08-31')).toBe('2026-08-31')
    expect(weekDays('2026-08-31')).toEqual(['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'])
    expect(fmtWeek('2026-08-31')).toBe('31 Aug - 06 Sep 2026')
  })

  it('opens on the week that holds today, and falls back to the newest recap', () => {
    const rows = [row('2026-09-06'), row('2026-09-04')]
    expect(openingWeek(rows, '2026-09-06')).toBe('2026-08-31')
    // A Monday before the first build: this week has nothing, so the rail shows the last one.
    expect(openingWeek(rows, '2026-09-07')).toBe('2026-08-31')
    expect(openingWeek([], '2026-09-07')).toBe('2026-09-07')
    expect(earliestWeek(rows, '2026-09-06')).toBe('2026-08-31')
    expect(earliestWeek([row('2026-08-21')], '2026-09-06')).toBe('2026-08-17')
  })
})

describe('what the feed shows', () => {
  const rows = [
    row('2026-09-06'),
    row('2026-09-05', { fellows: [fellow({ runs: [run] }), fellow({ index: 2, agentId: 'a2', name: 'Cleo', homeDomain: 'climate-science', runs: [] })] }),
    row('2026-09-04', { quiet: true, fellows: [] }),
    row('2026-08-28', { fellows: [fellow({ index: 1, agentId: 'a2', name: 'Cleo', homeDomain: 'climate-science', runs: [run] })] }),
  ]

  it('renders the week newest first, and one day when one is picked', () => {
    const week = feedRows(rows, { week: '2026-08-31', day: null, fellows: [] })
    expect(week.map((r) => r.cycleDate)).toEqual(['2026-09-06', '2026-09-05', '2026-09-04'])
    expect(feedRows(rows, { week: '2026-08-31', day: '2026-09-04', fellows: [] }).map((r) => r.cycleDate)).toEqual(['2026-09-04'])
    expect(feedRows(rows, { week: '2026-08-24', day: null, fellows: [] }).map((r) => r.cycleDate)).toEqual(['2026-08-28'])
  })

  it('two Fellows are an OR: a night either of them worked stays', () => {
    // Its own rows: Ada works one night, Cleo the next, and nobody the third.
    const ada = fellow({ runs: [run] })
    const cleo = fellow({ index: 2, agentId: 'a2', name: 'Cleo', homeDomain: 'climate-science', runs: [run] })
    const nights = [
      row('2026-09-06', { fellows: [ada] }),
      row('2026-09-05', { fellows: [cleo] }),
      row('2026-09-04', { quiet: true, fellows: [] }),
    ]
    const on = (fellows: string[]): string[] => feedRows(nights, { week: '2026-08-31', day: null, fellows }).map((r) => r.cycleDate)
    expect(on(['Ada', 'Cleo'])).toEqual(['2026-09-06', '2026-09-05'])
    expect(on(['Cleo'])).toEqual(['2026-09-05'])
    // Nobody picked is every Fellow, the quiet night included.
    expect(on([])).toEqual(['2026-09-06', '2026-09-05', '2026-09-04'])
  })

  it('a picked Fellow leaves the nights it worked, and a picked day opens even when it did not', () => {
    expect(feedRows(rows, { week: '2026-08-31', day: null, fellows: ['Ada'] }).map((r) => r.cycleDate)).toEqual(['2026-09-06', '2026-09-05'])
    // Cleo is in the 05 Sep recap but ran nothing, so the week hides it.
    expect(feedRows(rows, { week: '2026-08-31', day: null, fellows: ['Cleo'] })).toEqual([])
    // Picking that day still opens it: the reason is what you came for.
    expect(feedRows(rows, { week: '2026-08-31', day: '2026-09-05', fellows: ['Cleo'] }).map((r) => r.cycleDate)).toEqual(['2026-09-05'])
    expect(workedOn(rows[1]!, 'Ada')).toBe(true)
    expect(workedOn(rows[1]!, 'Cleo')).toBe(false)
    expect(runsInWeek(rows, '2026-08-31', 'Ada')).toBe(2)
    expect(runsInWeek(rows, '2026-08-31', 'Cleo')).toBe(0)
    expect(runsInWeek(rows, '2026-08-24', 'Cleo')).toBe(1)
  })

  it('says why a Fellow stayed put, in the recap\'s own words', () => {
    const skipped = row('2026-09-04', {
      fellows: [],
      shift: { trigger: 'timer', startedAt: 's', finishedAt: null, executed: 0, planned: 1, skipped: [{ agentName: 'Ada', reason: "Ada used today's quota (3 of 3 runs)" }], costUsd: 0 },
    })
    expect(absenceOf(skipped, 'Ada')).toBe("Ada used today's quota (3 of 3 runs)")

    const asleep = row('2026-09-04', { fellows: [], sleeping: [{ name: 'Cleo', reason: 'the intent is covered' }] })
    expect(absenceOf(asleep, 'Cleo')).toBe('the intent is covered')

    const present = row('2026-09-05', { fellows: [fellow({ name: 'Cleo', state: 'sleeping', sleepCode: 'no-candidates', sleepReason: 'nothing worth a run' })] })
    expect(absenceOf(present, 'Cleo')).toContain('sleeping: nothing worth a run')

    expect(absenceOf(row('2026-09-06'), 'Cleo')).toBe('not in this recap - it was not running on this day.')
  })
})
