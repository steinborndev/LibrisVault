/**
 * The plan card (docs/agents/SPEC.md section 8.3): which plan is running, how much of each
 * window is used, what the runs since the last measurement have probably added, and how old
 * the reading is. One component for the three places it stands - the Library's corner, the
 * Research tab's rail and the Home column - so the three cannot drift apart again.
 *
 * The lines come from `planCorner`, which is where the reading is worked out; this only
 * draws them. `foot` is for the one place with an action beside the age (the Library's
 * five-hour release).
 */

import type React from 'react'
import type { PlanCorner } from '../lib/library/planCorner.ts'

export function PlanCard({ corner, dark = false, foot }: { corner: PlanCorner; dark?: boolean; foot?: React.ReactNode }): React.ReactElement {
  return (
    <div className={`lib-plan${dark ? ' dark' : ''}`}>
      {/* "used" once, in the head: with a per-model window or three it would be four
          repetitions of the same word in a card this size. The unit sits over the column it
          describes, right-aligned with the figures. */}
      <div className="lp-name">
        <span>{corner.plan ?? 'plan'}</span>
        <span className="lp-unit">{corner.unit}</span>
      </div>
      {corner.lines.map((l) => (
        <div key={l.window} className={`lp-row${l.usedPct + (l.sincePct ?? 0) >= 90 ? ' spent' : l.usedPct + (l.sincePct ?? 0) >= 75 ? ' low' : ''}`}>
          <span className="lp-w">{l.label}</span>
          <span className="lp-n">
            {l.usedPct}%
            {l.sincePct !== null && (
              <span className="lp-est" title={`plus about ${l.sincePct}% from ${corner.runsSince} run(s) since the last measurement`}>
                +{l.sincePct}
              </span>
            )}
          </span>
        </div>
      ))}
      {/* The age is always said - "0m old" is a fact worth having - and an old reading says
          why there is no newer one. A card that vanished after a day left the question "can
          I afford tonight" with no answer at all, which is worse than an old one. */}
      <div className="lp-foot">
        <span className={corner.stale ? 'lp-stale' : 'lp-age'} title={corner.stale ? (corner.reason ?? 'the plan has not reported since') : 'when the plan last reported these numbers'}>
          {corner.ageText}
        </span>
        {foot}
      </div>
    </div>
  )
}
