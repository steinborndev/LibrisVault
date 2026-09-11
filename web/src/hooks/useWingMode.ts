/**
 * The domain section's mode and wing, remembered per screen (second sweep, chunk 3): "by
 * wing" is the default, "show all" the flat list, and whoever switched or walked to a room
 * finds it again on the next load. The wing itself is derived from the rooms at hand, so a
 * remembered room that no longer exists falls back to the first.
 */

import { useCallback, useState } from 'react'
import { resolveWing, type WingGroup, type WingListMode } from '../lib/wings.ts'

interface Stored {
  readonly mode: WingListMode
  readonly id: string | null
}

function load(key: string): Stored {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return { mode: 'wing', id: null }
    const p = JSON.parse(raw) as Partial<Stored>
    return { mode: p.mode === 'all' ? 'all' : 'wing', id: typeof p.id === 'string' ? p.id : null }
  } catch {
    return { mode: 'wing', id: null }
  }
}

function save(key: string, value: Stored): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode or full storage: the choice lives for the session */
  }
}

export interface WingMode {
  readonly mode: WingListMode
  /** The room on show, or null in the flat list (or with no rooms at all). */
  readonly wing: string | null
  readonly setMode: (mode: WingListMode) => void
  readonly setWing: (id: string) => void
}

export function useWingMode(storageKey: string, groups: readonly WingGroup[]): WingMode {
  const [stored, setStored] = useState<Stored>(() => load(storageKey))
  const setMode = useCallback(
    (mode: WingListMode): void =>
      setStored((s) => {
        const next = { ...s, mode }
        save(storageKey, next)
        return next
      }),
    [storageKey],
  )
  const setWing = useCallback(
    (id: string): void => {
      const next = { mode: 'wing' as const, id }
      save(storageKey, next)
      setStored(next)
    },
    [storageKey],
  )
  return { mode: stored.mode, wing: resolveWing(stored.mode, stored.id, groups), setMode, setWing }
}
