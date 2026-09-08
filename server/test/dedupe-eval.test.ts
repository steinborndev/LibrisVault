/**
 * The dedupe harness's own arithmetic (server/src/cli/dedupe-eval.ts).
 *
 * Small surface, but it is the thing that decides whether a future semantic dedupe ships, so
 * a bug here would be a bug in the judgement rather than in the code being judged. The point
 * pinned hardest is the refusal: two classes that overlap yield NO threshold, rather than a
 * plausible-looking number that would kill a legitimate run.
 */

import { describe, it, expect } from 'vitest'
import { loadPairs, separation, atThreshold, precisionCut } from '../src/cli/dedupe-eval.js'

const pair = (id: string, same: boolean, cohort = 'observed'): { id: string; a: string; b: string; same: boolean; cohort: string } => ({
  id,
  a: 'a',
  b: 'b',
  same,
  cohort,
})

describe('the dedupe harness', () => {
  it('reads a pair file, skipping blanks and comments, and defaults the cohort', () => {
    const pairs = loadPairs(
      ['# a comment', '', '{"id":"x","a":"one topic","b":"another","same":true,"cohort":"paraphrase"}', '{"a":"third","b":"fourth","same":false}'].join('\n'),
    )
    expect(pairs).toHaveLength(2)
    expect(pairs[0]).toMatchObject({ id: 'x', same: true, cohort: 'paraphrase' })
    // An unlabelled cohort is named, not guessed: it shows up in the report as its own row.
    expect(pairs[1]).toMatchObject({ id: 'pair-4', cohort: 'unsorted' })
  })

  it('refuses a line that cannot decide what it is', () => {
    expect(() => loadPairs('{"a":"x","b":"y"}')).toThrow(/boolean "same"/)
    expect(() => loadPairs('not json')).toThrow(/line 1/)
    // `same` must be a boolean, not a string that looks like one.
    expect(() => loadPairs('{"a":"x","b":"y","same":"true"}')).toThrow(/boolean "same"/)
  })

  it('finds a cut only when the classes actually separate', () => {
    const clean = [
      { pair: pair('d1', true), score: 0.8 },
      { pair: pair('d2', true), score: 0.7 },
      { pair: pair('n1', false), score: 0.3 },
    ]
    expect(separation(clean)).toMatchObject({ worstSame: 0.7, bestDiff: 0.3, threshold: 0.5 })
  })

  /*
   * The case that matters. Measured on the real set the shipping metric lands here: a genuine
   * duplicate at 0.56 and a genuine distinct pair at 0.54. A harness that answered "cut at
   * 0.55" would be reporting a coincidence as a margin.
   */
  it('reports NO threshold when a distinct pair outscores a duplicate', () => {
    const overlapping = [
      { pair: pair('d1', true), score: 0.56 },
      { pair: pair('d2', true), score: 0.13 },
      { pair: pair('n1', false), score: 0.54 },
    ]
    expect(separation(overlapping).threshold).toBeNull()
  })

  it('counts what a cut would actually do, and names the runs it would kill', () => {
    const scored = [
      { pair: pair('d1', true), score: 0.8 },
      { pair: pair('d2', true), score: 0.4 },
      { pair: pair('n1', false), score: 0.9 },
      { pair: pair('n2', false), score: 0.1 },
    ]
    const at = atThreshold(scored, 0.6)
    expect(at).toMatchObject({ caught: 1, missed: 1 })
    // A false positive is named, because it is the expensive mistake: a run that should have run.
    expect(at.wrong).toEqual(['n1'])
    // A cut nothing reaches catches nothing and breaks nothing.
    expect(atThreshold(scored, 1.1)).toMatchObject({ caught: 0, missed: 2, wrong: [] })
  })

  /*
   * The question a graded action asks, and the one that decided stage 2. A mechanism can fail
   * to separate the classes and still be worth something if it has a bar above which it is
   * never wrong. Measured, the embedder has no such bar at all: its highest-scoring pair is a
   * pair that must NOT be merged.
   */
  it('finds the highest-precision cut, and says when there is nothing above it', () => {
    const usable = [
      { pair: pair('d1', true), score: 0.9 },
      { pair: pair('d2', true), score: 0.3 },
      { pair: pair('n1', false), score: 0.5 },
    ]
    // Just above the best distinct pair, and one duplicate still stands over it.
    expect(precisionCut(usable)).toMatchObject({ cut: 0.51, caught: 1 })

    // The embedder's shape: a distinct pair scores at the very top, so a safe cut catches none.
    const worthless = [
      { pair: pair('d1', true), score: 0.835 },
      { pair: pair('n1', false), score: 0.835 },
      { pair: pair('d2', true), score: 0.65 },
    ]
    expect(precisionCut(worthless).caught).toBe(0)
  })

  it('scores an empty class as zero rather than dividing by nothing', () => {
    expect(separation([{ pair: pair('n1', false), score: 0.4 }])).toMatchObject({ worstSame: 0, bestDiff: 0.4, threshold: null })
    expect(separation([])).toMatchObject({ worstSame: 0, bestDiff: 0, threshold: null })
  })
})
