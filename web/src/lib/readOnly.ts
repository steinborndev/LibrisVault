import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'

/**
 * Whether this instance refuses writes: the hosted demo (SPEC.md §12.8). The server refuses
 * every non-GET before a handler runs, so this is not the guarantee; it is what lets a surface
 * show its actions switched off instead of offering a button that answers with a 403. System
 * uses it to stay browsable on the demo (2026-09-25): every section renders, the actions it
 * would take are visible and disabled.
 */
export function useReadOnly(): boolean {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  return health.data?.demoMode === true
}

/** The tooltip a switched-off action carries, one wording everywhere. */
export const READ_ONLY_HINT = 'Switched off in the hosted demo'
