/**
 * The Domains section of a control column, shared by the Graph and the Catalog (chunks 4
 * and, in the second sweep, 3 of docs/tasks/TASKS-SWEEP-2026-09.md). Two screens carried
 * the same twenty lines with different selection rules; the rules stay with the screens (a
 * set here, one domain there) and the section only draws and walks.
 *
 * Two modes, switched by a toggle in the head. "show all", the default since 2026-09-16, is
 * the flat list of every domain; it stands on the left because it is where the section starts
 * and the wings are the narrowing. "by wing" shows one Library
 * room at a time, its domains in shelf order, with two arrows and the left and right keys to
 * walk the rooms; the room on show is the screen's filter, so walking the rooms is browsing
 * the vault. "show all" is the flat list the screen hands over. There is no filter box any
 * more: with a room a page, the list is short enough to read.
 *
 * Left and right walk BOTH modes (2026-09-16). By wing they turn the page of rooms; in the
 * flat list they walk the domains one at a time, each step replacing the selection, so the
 * same two keys mean the same thing in both: move to the next thing this section filters by.
 * The flat list treats "no domain picked" as the position before the first, which is how left
 * gets you back out to the whole vault.
 */

import { useCallback, useEffect, useRef, type Ref } from 'react'
import { Icon } from './Icon.tsx'
import { stepDomain, stepWing, type WingGroup, type WingListMode } from '../lib/wings.ts'

export interface DomainSectionProps {
  /** Every domain the screen knows, with its count, in the order the flat list shows them. */
  readonly domains: ReadonlyArray<readonly [string, number]>
  readonly label: (key: string) => string
  readonly color: (key: string) => string
  readonly selected: ReadonlySet<string>
  readonly onToggle: (key: string) => void
  /** Make this domain the only one selected - what an arrow step means, unlike a click. */
  readonly onPick: (key: string) => void
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

export function DomainSection({ domains, label, color, selected, onToggle, onPick, onClear, groups, mode, onMode, wing, onWing, active, rowTitle, listRef }: DomainSectionProps): React.ReactElement {
  const list = useRef<HTMLDivElement>(null)
  // The section scrolls its own list (the arrow step, below); the screen gets the same node
  // for its own reasons (the Catalog scrolls to a domain arriving from another screen).
  const setList = useCallback(
    (el: HTMLDivElement | null): void => {
      list.current = el
      if (typeof listRef === 'function') listRef(el)
      else if (listRef !== null && listRef !== undefined) (listRef as { current: HTMLDivElement | null }).current = el
    },
    [listRef],
  )
  const group = wing === null ? undefined : groups.find((g) => g.id === wing)
  const at = group === undefined ? -1 : groups.indexOf(group)
  const counts = new Map(domains)
  const rows: ReadonlyArray<readonly [string, number]> = group === undefined ? domains : group.domains.map((d) => [d, counts.get(d) ?? 0] as const)
  const order = rows.map(([d]) => d)

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

  /*
   * The same two keys in the flat list, walking the domains (`stepDomain` holds the rules). The
   * step is a SOLO select and not a click: a click builds a set up, an arrow moves along, and a
   * key that grew the selection with every press would give no way to walk past a domain
   * without picking it up.
   */
  useEffect(() => {
    if (!active || wing !== null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (inField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const step = stepDomain(order, selected, e.key === 'ArrowLeft' ? -1 : 1)
      if (step === null) return
      e.preventDefault()
      if (step === 'clear') onClear()
      else onPick(step.pick)
      // The list is taller than its slot: a step that lands out of sight has not shown you
      // anything. React flushes a key press before paint, so the row is already marked here.
      requestAnimationFrame(() => list.current?.querySelector('.domrow.active')?.scrollIntoView({ block: 'nearest' }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, wing, order, selected, onPick, onClear])

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
        {groups.length === 0 && <span className="gp-state dom-state">showing all</span>}
      </div>
      {/* A row of its own under the heading since 2026-09-16, in the same two-sided strip the
          View section's lenses use and at the same distance from its heading: it is a choice
          between two ways of listing, which is exactly what those strips say elsewhere, and
          squeezed into the head it had 122px to say it in. Without rooms there is nothing to
          choose and the head carries the state instead. */}
      {groups.length > 0 && (
        <div className="gp-lenses">
          <div className="lib-strip gp-lens dom-mode" role="radiogroup" aria-label="Domain list">
            <button
              className={`rp${mode === 'all' ? ' on' : ''}`}
              role="radio"
              aria-checked={mode === 'all'}
              onClick={() => onMode('all')}
              title="Every domain in one list"
            >
              Show all
            </button>
            <button
              className={`rp${mode === 'wing' ? ' on' : ''}`}
              role="radio"
              aria-checked={mode === 'wing'}
              onClick={() => onMode('wing')}
              title="One wing at a time: the room is the filter, and the arrows walk the rooms"
            >
              By wing
            </button>
          </div>
        </div>
      )}
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
      <div className="domlist" ref={setList}>
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
