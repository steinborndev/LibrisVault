/**
 * The focus-mode popover (docs/agents/SPEC.md section 10.6): anchored to the figure, the
 * kicker, the name, what runs now, what runs tonight, and two actions.
 */

import type { SceneFellow } from '../../api/types.ts'
import { usd } from '../../lib/format.ts'

export function FellowPopover({ fellow, x, y, roomName, onOpenCard, onPause, onClose }: { fellow: SceneFellow; x: number; y: number; roomName: string; onOpenCard: () => void; onPause: () => void; onClose: () => void }): React.ReactElement {
  const state = fellow.run ? (fellow.run.kind === 'plan' ? 'planning' : 'at work') : fellow.state
  return (
    <div className="lib-pop" style={{ left: x, top: y }} role="dialog" aria-label={`${fellow.name}`}>
      <button className="gx-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="gx-kicker">
        Fellow · {fellow.homeDomain} · {state}, {roomName}
      </div>
      <div className="lib-pop-title">{fellow.name}</div>
      <div className="lib-pop-line">
        <span className="k">Now</span>
        <span className="v">
          {fellow.run ? fellow.run.label ?? fellow.run.kind : fellow.sleepReason ?? fellow.state}
          {fellow.run && <small>{fellow.run.kind}</small>}
        </span>
      </div>
      <div className="lib-pop-line">
        <span className="k">Tonight</span>
        <span className="v">
          {fellow.next ? fellow.next.topic : 'nothing planned'}
          {fellow.next && (
            <small>
              {fellow.next.status === 'approved' ? 'approved' : 'undecided'} · about {usd(fellow.next.estCostUsd)}
            </small>
          )}
        </span>
      </div>
      <div className="lib-pop-acts">
        <button className="btn sm primary" onClick={onOpenCard}>
          Open card
        </button>
        <button className="btn sm" onClick={onPause}>
          {fellow.state === 'paused' ? 'Resume' : 'Pause'}
        </button>
      </div>
    </div>
  )
}
