/**
 * What a run of a kind costs, from the runs already made (`pipeline/run-cost.ts`).
 *
 * The prices were four constants until 2026-09-15, and after ten research runs and seventeen
 * steps this vault's own log said they were wrong in both directions. The gate decides with
 * that number whether a run still fits the research share, so a constant set too high refuses
 * runs that would have fitted and one set too low lets a night overrun.
 */

import { describe, it, expect } from 'vitest'
import { typicalRunUsd, runPrices, REFERENCE_USD, type CostSample } from '../src/pipeline/run-cost.js'

const run = (over: Partial<CostSample> = {}): CostSample => ({ kind: 'research-step', ok: true, costUsd: 2, model: 'claude-sonnet-5', ...over })

describe('typicalRunUsd', () => {
  it('falls back to the reference until a kind has enough of its own runs', () => {
    expect(typicalRunUsd([], 'research', 'sonnet-5')).toBe(REFERENCE_USD['research'])
    // Two is not a sample: the third is what lets the vault's own figure take over.
    const two = [run({ kind: 'research', costUsd: 4 }), run({ kind: 'research', costUsd: 4 })]
    expect(typicalRunUsd(two, 'research', 'sonnet-5')).toBe(6)
    expect(typicalRunUsd([...two, run({ kind: 'research', costUsd: 4 })], 'research', 'sonnet-5')).toBe(4)
  })

  it('takes the median, so one run that hit its cap does not price every run after it', () => {
    const rows = [run({ costUsd: 2 }), run({ costUsd: 2.4 }), run({ costUsd: 30 })]
    expect(typicalRunUsd(rows, 'research-step', 'sonnet-5')).toBe(2.4)
  })

  it('counts only the runs that settled and spent something', () => {
    /*
     * A run that failed before it spent anything is not a cheap run of that kind - it is no
     * measurement at all, and counting it would pull every estimate toward zero, which is the
     * one direction a price must never drift on its own.
     */
    const rows = [run({ costUsd: 3 }), run({ ok: false, costUsd: 0 }), run({ costUsd: 0 }), run({ costUsd: 3 }), run({ costUsd: 3 })]
    expect(typicalRunUsd(rows, 'research-step', 'sonnet-5')).toBe(3)
  })

  it('scales a model it has not measured off the one it has, instead of guessing', () => {
    /*
     * Cost follows the model far more sharply than duration does, so a median mixed across
     * models would price a sonnet run like an opus one. Three sonnet steps at 3.00 say an opus
     * step is about 7.50 here - its own factor over the factor each sample was run on - which
     * is a better first estimate for a fresh opus Fellow than the reference times the same
     * factor.
     */
    const sonnet = [run({ costUsd: 3 }), run({ costUsd: 3 }), run({ costUsd: 3 })]
    expect(typicalRunUsd(sonnet, 'research-step', 'opus-5')).toBe(7.5)
    // And once opus has three of its own, they answer for it.
    const opus = [...sonnet, ...[1, 2, 3].map(() => run({ costUsd: 9, model: 'claude-opus-5' }))]
    expect(typicalRunUsd(opus, 'research-step', 'opus-5')).toBe(9)
    // The sonnet figure is untouched by them.
    expect(typicalRunUsd(opus, 'research-step', 'sonnet-5')).toBe(3)
  })

  it('prices every kind at once for the payload the board forecasts with', () => {
    const rows = [1, 2, 3].map(() => run({ kind: 'plan', costUsd: 0.5 }))
    expect(runPrices(rows, 'sonnet-5')).toEqual({ ...REFERENCE_USD, plan: 0.5 })
  })
})
