/**
 * The Domains section of a control column, shared by the Graph and the Catalog (chunk 4 of
 * docs/tasks/TASKS-SWEEP-2026-09.md). Two screens carried the same twenty lines with
 * different selection rules; the rules stay with the screens (a set here, one domain there)
 * and the section only draws, filters and walks.
 *
 * Two modes. "showing all" is the flat list the screen hands over, filtered by the box. "by
 * wing" shows one Library room at a time, its domains in shelf order, with two arrows and the
 * left and right keys to walk the rooms; the room on show is the screen's filter, so walking
 * the rooms is browsing the vault. The box searches every room: a hit in another one turns
 * the page there, and an empty box stays where the search led.
 */

import { useEffect, useState, type Ref } from 'react'
import { Icon } from './Icon.tsx'
import { stepWing, wingOf, wingWithMatch, type WingGroup } from '../lib/wings.ts'

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
  /** The room on show, or null for the flat list. The screen owns it: the room is its filter. */
  readonly wing: string | null
  readonly onWing: (id: string | null) => void
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

export function DomainSection({ domains, label, color, selected, onToggle, onClear, groups, wing, onWing, active, rowTitle, listRef }: DomainSectionProps): React.ReactElement {
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const matches = (d: string): boolean => needle === '' || label(d).toLowerCase().includes(needle)
  const group = wing === null ? undefined : groups.find((g) => g.id === wing)
  const at = group === undefined ? -1 : groups.indexOf(group)
  const counts = new Map(domains)
  const rows: ReadonlyArray<readonly [string, number]> = group === undefined ? domains : group.domains.map((d) => [d, counts.get(d) ?? 0] as const)
  const shown = rows.filter(([d]) => matches(d))

  // The search runs over every room: when the one on show has no hit and another has, turn
  // the page there. Nothing matching anywhere leaves the page where it is.
  useEffect(() => {
    if (wing === null || needle === '') return
    const target = wingWithMatch(groups, wing, (d) => label(d).toLowerCase().includes(needle))
    if (target !== null && target !== wing) onWing(target)
  }, [needle, wing, groups, label, onWing])

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

  /** Entering wing mode opens on the room of the first selected domain, else the first room. */
  const enter = (): void => {
    const fromSelection = [...selected].map((d) => wingOf(groups, d)).find((id): id is string => id !== undefined)
    onWing(fromSelection ?? groups[0]?.id ?? null)
  }

  return (
    <div className="gp-sec grow">
      <div className="gp-head">
        <span className="gp-eyebrow">Domains</span>
        <span className="spacer" />
        {selected.size > 0 && (
          <button className="btn ghost" onClick={onClear} title="Show all domains">
            <Icon name="x" /> Clear
          </button>
        )}
        {/* The state word is the switch: "showing all" turns into "by wing" and back. */}
        {groups.length > 0 ? (
          <button
            className="gp-state switch"
            onClick={() => (wing === null ? enter() : onWing(null))}
            title={wing === null ? 'One wing at a time: the room is the filter, and the arrows walk the rooms' : 'Every domain in one list'}
          >
            {wing === null ? 'showing all' : 'by wing'}
          </button>
        ) : (
          <span className="gp-state">showing all</span>
        )}
      </div>
      <div className="gp-search">
        <Icon name="search" />
        <input type="search" value={filter} placeholder={wing === null ? 'Filter domains…' : 'Find a domain in any wing…'} onChange={(e) => setFilter(e.target.value)} aria-label="Filter the domain list" />
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
        {shown.map(([d, count]) => {
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
        {shown.length === 0 && <div className="gp-none">{group === undefined ? `No domain matches “${filter.trim()}”.` : `No domain matches “${filter.trim()}” in any wing.`}</div>}
      </div>
    </div>
  )
}
