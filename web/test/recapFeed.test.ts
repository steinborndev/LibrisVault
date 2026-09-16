/**
 * Home's recap feed (docs/agents/SPEC.md section 9.3): the week the rail shows, the day
 * format it prints, which recaps the feed renders under the filters, and the sentence a
 * dimmed day answers with.
 */

import { describe, expect, it } from 'vitest'
import {
  absenceOf,
  addDays,
  dayRail,
  earliestWeek,
  feedRows,
  fmtDay,
  fmtWeek,
  localDate,
  nightOf,
  openingWeek,
  runsInWeek,
  weekDays,
  weekOf,
  weekStartOf,
  workedOn,
} from '../src/lib/recapFeed.ts'
import type { RecapFellow, RecapModel, RecapRow, RecapRun } from '../src/api/types.ts'

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

/**
 * The Fellow filter is not only about WHOSE SECTIONS show (docs/agents/SPEC.md section 9.3):
 * the strip above them and the day's own rows underneath answered for the whole night however
 * the filter stood, which reads as a bug rather than as a scope.
 */
describe('what one Fellow did with a night', () => {
  // Typed against RecapRun, not against the shared `run` const: its empty page arrays infer
  // as `never[]`, so a fixture that gives a run pages would not typecheck.
  const mkRun = (over: Partial<RecapRun> = {}): RecapRun => ({ ...run, ...over })
  const proposal = (status: string) => ({
    code: '1a',
    proposalId: `p-${status}`,
    kind: 'research',
    topic: 'T',
    rationale: 'R',
    provenance: { candidate: 'c', text: 't', sourcePages: [] },
    estCostUsd: 1,
    scopeScore: 0.9,
    drift: false,
    status,
    rank: 1,
  })
  const ada = fellow({
    name: 'Ada',
    agentId: 'a-ada',
    runs: [mkRun({ runId: 'a1', costUsd: 3, pagesCreated: ['p1', 'p2'], pagesUpdated: ['p3'] }), mkRun({ runId: 'a2', costUsd: 1.5, ok: false, pagesCreated: [] })],
    proposals: [proposal('proposed'), proposal('vetoed')],
    value: { pageOpens: 7, recapLinks: 2 },
  })
  const mira = fellow({
    name: 'Mira',
    agentId: 'a-mira',
    index: 2,
    runs: [mkRun({ runId: 'm1', costUsd: 0.5, pagesCreated: ['q1'] })],
    proposals: [proposal('proposed'), proposal('proposed')],
    value: { pageOpens: 1, recapLinks: 0 },
  })
  const night = row('2026-09-06', { fellows: [ada, mira], totals: { runs: 3, failed: 1, costUsd: 5, pages: 4 } })

  it('sums the same arithmetic the whole-night totals do, over a subset of the same runs', () => {
    // The property that makes a filtered strip comparable rather than merely similar.
    const everybody = nightOf(night, [])
    expect({ runs: everybody.runs, failed: everybody.failed, costUsd: everybody.costUsd, pages: everybody.pages }).toEqual(night.model.totals)
    const parts = [nightOf(night, ['Ada']), nightOf(night, ['Mira'])]
    expect(parts.reduce((n, p) => n + p.costUsd, 0)).toBe(night.model.totals.costUsd)
    expect(parts.reduce((n, p) => n + p.pages, 0)).toBe(night.model.totals.pages)
  })

  it('counts one Fellow\'s runs, pages, failures, cost, undecided and value', () => {
    expect(nightOf(night, ['Ada'])).toEqual({ runs: 2, pages: 3, failed: 1, costUsd: 4.5, undecided: 1, pageOpens: 7, recapLinks: 2, present: true })
    expect(nightOf(night, ['Mira'])).toEqual({ runs: 1, pages: 1, failed: 0, costUsd: 0.5, undecided: 2, pageOpens: 1, recapLinks: 0, present: true })
  })

  it('reports a Fellow the recap has no section for as absent rather than as a zero night', () => {
    // The strip says "not in this recap" for one and "nothing of its own ran" for the other,
    // and only `present` tells them apart - both are all-zero.
    const missing = nightOf(night, ['Cleo'])
    expect(missing.present).toBe(false)
    expect(missing.runs).toBe(0)
    expect(nightOf(row('2026-09-06', { fellows: [fellow({ name: 'Cleo', runs: [] })] }), ['Cleo']).present).toBe(true)
  })

  it('adds a week up out of its nights, and only the days of that week', () => {
    const rows = [night, row('2026-09-04', { fellows: [fellow({ name: 'Ada', runs: [mkRun({ costUsd: 2 })] })] }), row('2026-08-30', { fellows: [fellow({ name: 'Ada', runs: [mkRun({ costUsd: 99 })] })] })]
    expect(weekOf(rows, '2026-08-31', ['Ada'])).toEqual({ runs: 3, costUsd: 6.5 })
    expect(weekOf(rows, '2026-08-31', ['Ada', 'Mira'])).toEqual({ runs: 4, costUsd: 7 })
    // `runsInWeek` is the same count, so the pill and the strip can never disagree.
    expect(runsInWeek(rows, '2026-08-31', 'Ada')).toBe(weekOf(rows, '2026-08-31', ['Ada']).runs)
  })
})

describe('the day\'s own rows, under a Fellow filter', () => {
  const m = row('2026-09-06', {
    readingAdded: [
      { title: 'One', url: 'u1', by: 'Ada', page: null },
      { title: 'Two', url: 'u2', by: 'Mira', page: 'wiki/sources/Two.md' },
      { title: 'Three', url: 'u3', by: 'ingest', page: null },
      { title: 'Four', url: 'u4', by: null, page: null },
    ],
    shift: { trigger: 'timer', startedAt: 's', finishedAt: null, executed: 1, planned: 2, skipped: [{ agentName: 'Ada', reason: 'quota' }, { agentName: 'Mira', reason: 'nothing runnable' }], costUsd: 1 },
    dedupe: {
      merged: [{ keptAgentName: 'Ada', keptTopic: 'K', droppedAgentName: 'Mira', droppedTopic: 'D' }],
      overlaps: [{ agentName: 'Mira', topic: 'T', page: 'wiki/questions/T.md' }],
    },
  }).model

  it('gives every row back when nobody is picked', () => {
    const all = dayRail(m, [])
    expect(all.reading).toHaveLength(4)
    expect(all.skipped).toHaveLength(2)
    expect(all.merged).toHaveLength(1)
    expect(all.overlaps).toHaveLength(1)
  })

  it('keeps only what the picked Fellow asked for, was skipped for, or was merged into', () => {
    const ada = dayRail(m, ['Ada'])
    expect(ada.reading.map((r) => r.title)).toEqual(['One'])
    expect(ada.skipped.map((s) => s.agentName)).toEqual(['Ada'])
    // A merge names two Fellows and is the answer to "why did mine not run" as much as to
    // "why did mine cover that", so it shows for the kept side too.
    expect(ada.merged).toHaveLength(1)
    expect(ada.overlaps).toHaveLength(0)

    const mira = dayRail(m, ['Mira'])
    expect(mira.reading.map((r) => r.title)).toEqual(['Two'])
    expect(mira.skipped.map((s) => s.reason)).toEqual(['nothing runnable'])
    expect(mira.merged).toHaveLength(1)
    expect(mira.overlaps).toHaveLength(1)
  })

  it('drops what nobody claimed: an ingest asked, or nobody did', () => {
    // These are real entries and they stay under no filter at all - they are simply not
    // this Fellow's, which is the whole point of picking one.
    expect(dayRail(m, ['Ada', 'Mira']).reading.map((r) => r.title)).toEqual(['One', 'Two'])
  })

  it('files nothing on a quiet night, however the filter stands', () => {
    const quiet = row('2026-09-06', { quiet: true, readingAdded: [{ title: 'One', url: 'u1', by: 'Ada', page: null }] }).model
    expect(dayRail(quiet, []).reading).toHaveLength(0)
    expect(dayRail(quiet, ['Ada']).reading).toHaveLength(0)
  })
})
