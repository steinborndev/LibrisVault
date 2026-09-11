/**
 * The Domains section of a control column, shared by the Graph and the Catalog (chunks 4
 * and, in the second sweep, 3 of docs/tasks/TASKS-SWEEP-2026-09.md). Two screens carried
 * the same twenty lines with different selection rules; the rules stay with the screens (a
 * set here, one domain there) and the section only draws and walks.
 *
 * Two modes, switched by a toggle in the head. "by wing", the default, shows one Library
 * room at a time, its domains in shelf order, with two arrows and the left and right keys to
 * walk the rooms; the room on show is the screen's filter, so walking the rooms is browsing
 * the vault. "show all" is the flat list the screen hands over. There is no filter box any
 * more: with a room a page, the list is short enough to read.
 */

import { useEffect, type Ref } from 'react'
import { Icon } from './Icon.tsx'
import { stepWing, type WingGroup, type WingListMode } from '../lib/wings.ts'

export interface DomainSectionProps {
  /** Every domain the screen knows, with its count, in the order the flat list shows them. */
  readonly domains: ReadonlyArray<readonly [string, number]>
  readonly label: (key: string) => string
  readonly color: (key: string) => string
  readonly selected: ReadonlySet<string>
  readonly onToggle: (key: string) => void
  readonly onClear: () => void
  /** The rooms, from `wingGroups`; empty when the Library offers none, and then there is no wing mode. */
  readonly groups: readonly WingGroup[]
  readonly mode: WingListMode
  readonly onMode: (mode: WingListMode) => void
  /** The room on show, or null for the flat list. The screen owns it: the room is its filter. */
  readonly wing: string | null
  readonly onWing: (id: string) => void
  /** Only the screen in front listens for the keys; the screens stay mounted behind [hidden]. */
  readonly active: boolean
  readonly rowTitle?: (key: string, active: boolean) => string | undefined
  readonly listRef?: Ref<HTMLDivElement>
}

function inField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

export function DomainSection({ domains, label, color, selected, onToggle, onClear, groups, mode, onMode, wing, onWing, active, rowTitle, listRef }: DomainSectionProps): React.ReactElement {
  const group = wing === null ? undefined : groups.find((g) => g.id === wing)
  const at = group === undefined ? -1 : groups.indexOf(group)
  const counts = new Map(domains)
  const rows: ReadonlyArray<readonly [string, number]> = group === undefined ? domains : group.domains.map((d) => [d, counts.get(d) ?? 0] as const)

  // Left and right walk the rooms, in wing mode, on the screen in front, never over a field.
  useEffect(() => {
    if (!active || wing === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (inField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const next = stepWing(groups, wing, e.key === 'ArrowLeft' ? -1 : 1)
      if (next === null) return
      e.preventDefault()
      onWing(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, wing, groups, onWing])

  return (
    <div className="gp-sec grow">
      {/* The head is 222px in the standing panel, and the toggle has to keep its two halves
          readable in it beside the label and, once a domain is picked, the clear action.
          "× Clear" and a 148px toggle came to 291px: the toggle gave way and its halves
          drew over each other (2026-09-11). So the clear action is the × alone, at the
          label it clears, and the toggle is as wide as what is left. */}
      <div className="gp-head">
        <span className="gp-eyebrow">Domains</span>
        {selected.size > 0 && (
          <button className="btn ghost dom-clear" onClick={onClear} title="Clear the domain filter" aria-label="Clear the domain filter">
            <Icon name="x" />
          </button>
        )}
        {/* The toggle, in two equal halves, at the right edge; without rooms there is only
            the flat list. */}
        {groups.length > 0 ? (
          <div className="seg sm ink dom-mode" role="radiogroup" aria-label="Domain list">
            <button role="radio" aria-checked={mode === 'wing'} onClick={() => onMode('wing')} title="One wing at a time: the room is the filter, and the arrows walk the rooms">
              by wing
            </button>
            <button role="radio" aria-checked={mode === 'all'} onClick={() => onMode('all')} title="Every domain in one list">
              show all
            </button>
          </div>
        ) : (
          <span className="gp-state dom-state">showing all</span>
        )}
      </div>
      {group !== undefined && (
        <div className="dom-wing">
          <button className="prev" aria-label="Previous wing" title="Previous wing · ←" disabled={at <= 0} onClick={() => onWing(stepWing(groups, group.id, -1) ?? group.id)}>
            <Icon name="chevron" />
          </button>
          <span className="nm" title={group.name}>
            {group.name}
          </span>
          <span className="pos">
            {at + 1}/{groups.length}
          </span>
          <button className="next" aria-label="Next wing" title="Next wing · →" disabled={at >= groups.length - 1} onClick={() => onWing(stepWing(groups, group.id, 1) ?? group.id)}>
            <Icon name="chevron" />
          </button>
        </div>
      )}
      <div className="domlist" ref={listRef}>
        {rows.map(([d, count]) => {
          const on = selected.has(d)
          return (
            <button
              key={d || '∅'}
              className={`domrow${on ? ' active' : ''}${selected.size > 0 && !on ? ' dimmed' : ''}`}
              aria-pressed={on}
              onClick={() => onToggle(d)}
              title={rowTitle?.(d, on)}
            >
              <span className="dot" style={{ background: color(d) }} aria-hidden />
              <span className="nm">{label(d)}</span>
              <span className="n">{count}</span>
            </button>
          )
        })}
        {rows.length === 0 && <div className="gp-none">No domain in this wing.</div>}
      </div>
    </div>
  )
}
