/**
 * The card's "run a step now" button (docs/agents/SPEC.md section 8.4): a used-up daily
 * quota is asked about before the click, not answered with a 409 after it, and the override
 * only ever rides along on the confirmed run.
 */

import { describe, expect, it } from 'vitest'
import { stepButton } from '../src/lib/stepAction.ts'

describe('the step button', () => {
  it('runs straight away while the Fellow has runs left today', () => {
    expect(stepButton({ usedToday: 0, runsPerDay: 1 }, false)).toEqual({ label: 'Run next step now', asks: false, override: false, note: null })
    expect(stepButton({ usedToday: 1, runsPerDay: 3 }, false).override).toBe(false)
  })

  it('asks once when the quota is spent, and only then sends the override', () => {
    const asking = stepButton({ usedToday: 1, runsPerDay: 1 }, false)
    expect(asking).toMatchObject({ asks: true, override: false, note: null })
    expect(asking.label).toBe('Run a step anyway · 1 of 1 today')

    const confirmed = stepButton({ usedToday: 1, runsPerDay: 1 }, true)
    expect(confirmed).toMatchObject({ label: 'Yes, run it now', asks: false, override: true })
    expect(confirmed.note).toContain('night shift')
  })

  it('a quota of zero is not a spent quota that can be clicked past by accident', () => {
    expect(stepButton({ usedToday: 0, runsPerDay: 0 }, false)).toMatchObject({ asks: false, override: false })
  })
})
