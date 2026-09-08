/**
 * How long a run of a kind usually takes (server/src/pipeline/run-duration.ts) - the
 * denominator of the progress figure in the Library's bubbles.
 *
 * The rules worth pinning are the ones that decide whether the number is honest: the median
 * rather than the mean, failed runs left out, the vault's own history beating the reference
 * sizes once there is enough of it, and no number at all for a kind nobody has measured.
 */

import { describe, it, expect } from 'vitest'
import { median, typicalRunMs, MIN_SAMPLES, REFERENCE_MS, type DurationSample } from '../src/pipeline/run-duration.js'

const run = (over: Partial<DurationSample> & { readonly seconds: number }): DurationSample => ({
  kind: 'research',
  model: 'claude-sonnet-5',
  ok: true,
  startedAt: '2026-09-08T10:00:00.000Z',
  finishedAt: new Date(Date.parse('2026-09-08T10:00:00.000Z') + over.seconds * 1000).toISOString(),
  ...over,
})

describe('median', () => {
  it('takes the middle value, and the mean of the two middles of an even set', () => {
    expect(median([])).toBeNull()
    expect(median([5])).toBe(5)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(3)
  })

  it('is what keeps one run that hit its timeout from moving the figure', () => {
    const ordinary = [300, 320, 340, 310]
    const withOutlier = [...ordinary, 3600]
    expect(median(withOutlier)).toBe(320)
    // The mean, for contrast, would be over three times the median.
    expect(withOutlier.reduce((a, b) => a + b, 0) / withOutlier.length).toBeGreaterThan(900)
  })
})

describe('typicalRunMs', () => {
  it('takes the median of the vault\'s own runs of that kind once there are enough', () => {
    const history = [run({ seconds: 300 }), run({ seconds: 400 }), run({ seconds: 500 })]
    expect(history).toHaveLength(MIN_SAMPLES)
    expect(typicalRunMs(history, 'research', 'claude-sonnet-5')).toBe(400_000)
  })

  it('falls back to the reference size while the vault is younger than that', () => {
    const history = [run({ seconds: 300 }), run({ seconds: 400 })]
    expect(typicalRunMs(history, 'research', 'claude-sonnet-5')).toBe(REFERENCE_MS['research'])
  })

  it('says nothing about a kind nobody has measured, rather than guessing', () => {
    expect(typicalRunMs([], 'domain-review', null)).toBeNull()
    expect(typicalRunMs([run({ kind: 'domain-review', seconds: 15 })], 'domain-review', null)).toBeNull()
  })

  it('leaves failed runs out - a run that died in its second minute describes a fault', () => {
    const history = [run({ seconds: 300 }), run({ seconds: 400 }), run({ seconds: 500 }), run({ seconds: 40, ok: false }), run({ seconds: 30, ok: false })]
    expect(typicalRunMs(history, 'research', 'claude-sonnet-5')).toBe(400_000)
  })

  it('prefers the same model, but a kind with more samples on any model beats two of the right one', () => {
    const opus = [run({ seconds: 900, model: 'claude-opus-5' }), run({ seconds: 1000, model: 'claude-opus-5' })]
    const sonnet = [run({ seconds: 300 }), run({ seconds: 300 }), run({ seconds: 300 })]
    // Two Opus samples are below MIN_SAMPLES, so the kind's own median carries it.
    expect(typicalRunMs([...opus, ...sonnet], 'research', 'claude-opus-5')).toBe(300_000)
    // A third makes the model's own median the better answer.
    expect(typicalRunMs([...opus, run({ seconds: 950, model: 'claude-opus-5' }), ...sonnet], 'research', 'claude-opus-5')).toBe(950_000)
  })

  it('ignores other kinds, and a row whose stamps do not describe a duration', () => {
    const history = [
      run({ seconds: 300 }),
      run({ seconds: 400 }),
      run({ seconds: 500 }),
      run({ kind: 'plan', seconds: 60 }),
      run({ seconds: 0 }),
      { kind: 'research', model: 'claude-sonnet-5', ok: true, startedAt: '2026-09-08T10:10:00.000Z', finishedAt: '2026-09-08T10:00:00.000Z' },
    ]
    expect(typicalRunMs(history, 'research', 'claude-sonnet-5')).toBe(400_000)
  })
})
