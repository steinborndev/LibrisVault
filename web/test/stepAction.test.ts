/**
 * The card's "run a step now" button (docs/agents/SPEC.md section 8.4): a used-up daily
 * quota is asked about before the click, not answered with a 409 after it, and the override
 * only ever rides along on the confirmed run.
 *
 * And the other half of the same figure: which NIGHT it counts. The quota's count and every
 * other number beside it are anchored on different nights outside the shift window, so the
 * line has to say which one it means.
 */

import { describe, expect, it } from 'vitest'
import { quotaLine, stepButton } from '../src/lib/stepAction.ts'

describe('the step button', () => {
  it('runs straight away while the Fellow has runs left tonight', () => {
    expect(stepButton({ used: 0, runsPerDay: 1 }, false)).toEqual({ label: 'Run next step now', asks: false, override: false, note: null })
    expect(stepButton({ used: 1, runsPerDay: 3 }, false).override).toBe(false)
  })

  it('asks once when the quota is spent, and only then sends the override', () => {
    const asking = stepButton({ used: 1, runsPerDay: 1 }, false)
    expect(asking).toMatchObject({ asks: true, override: false, note: null })
    expect(asking.label).toBe('Run a step anyway · 1 of 1 used')

    const confirmed = stepButton({ used: 1, runsPerDay: 1 }, true)
    expect(confirmed).toMatchObject({ label: 'Yes, run it now', asks: false, override: true })
    expect(confirmed.note).toContain('night shift')
  })

  it('a quota of zero is not a spent quota that can be clicked past by accident', () => {
    expect(stepButton({ used: 0, runsPerDay: 0 }, false)).toMatchObject({ asks: false, override: false })
  })

  it('takes the noun of the screen it is on', () => {
    expect(stepButton({ used: 0, runsPerDay: 2 }, false, 'task').label).toBe('Run next task now')
    expect(stepButton({ used: 2, runsPerDay: 2 }, false, 'task').label).toBe('Run a task anyway · 2 of 2 used')
    // The confirmed click is the same sentence whatever the screen calls the work.
    expect(stepButton({ used: 2, runsPerDay: 2 }, true, 'task').label).toBe('Yes, run it now')
  })
})

describe('which night the quota figure is about', () => {
  it('says tonight only while the shift is running', () => {
    const inside = quotaLine({ used: 1, runsPerDay: 2 }, true, '23:15')
    expect(inside.text).toBe('1 of 2 used tonight')
    expect(inside.title).toContain('night now running')
  })

  it('outside the window it names the night that has been, and when the count turns', () => {
    // The bug this exists for: "13 min tonight · 2 of 2 runs used" at breakfast, which reads as
    // a night ahead that is already spent. It is the night behind that is spent.
    const after = quotaLine({ used: 2, runsPerDay: 2 }, false, '23:15')
    expect(after.text).toBe('2 of 2 used since last night')
    expect(after.title).toContain('23:15')
    expect(after.title).toContain('begins at 0 of 2')
  })

  it('never says midnight, which is the unit it is not counted in', () => {
    expect(quotaLine({ used: 0, runsPerDay: 3 }, false, '01:00').title).toContain('not at midnight')
  })

  it('takes the hour from the setting, and names none when there is none to name', () => {
    // The window is the user's own, moved from the same screen: no hour may be baked in here.
    expect(quotaLine({ used: 1, runsPerDay: 2 }, false, '02:30').title).toContain('opens at 02:30')
    const unknown = quotaLine({ used: 1, runsPerDay: 2 }, false, null)
    expect(unknown.title).toContain('when the night window opens,')
    expect(unknown.title).not.toMatch(/\d\d:\d\d/)
  })
})
