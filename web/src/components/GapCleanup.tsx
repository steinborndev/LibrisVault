/**
 * The second way out of a knowledge gap (2026-09-05, moved from Home's Gaps panel to the
 * graph's gaps view on 2026-09-11). A gap closes either by research or by deciding it never
 * deserved a page and unlinking it - a single-mention person, an image caption, a callout
 * title an ingest linked by reflex. The picks are collected here; one bounded agent run
 * (`cleanupGaps`) then turns the links into words, as one revertable commit. Two steps to
 * start it, because it spends a run and rewrites pages; the run is tracked until it settles
 * and the graph refetches so the gaps disappear.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { Icon } from './Icon.tsx'

/** The cleanup run accepts at most this many titles; the picker stops there too. */
export const MAX_UNLINK = 20

export interface GapCleanup {
  /** The picked titles that are still gaps. */
  readonly live: readonly string[]
  readonly running: boolean
  readonly armed: boolean
  readonly note: string | null
  readonly toggle: (title: string) => void
  readonly clear: () => void
  /** First press arms, second press starts the run. */
  readonly press: () => void
  readonly dismiss: () => void
}

export function useGapCleanup(gaps: ReadonlyArray<{ title: string }>): GapCleanup {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<readonly string[]>([])
  const [armed, setArmed] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // Picks that stopped being gaps (a research run wrote the page) drop out on their own.
  const open = new Set(gaps.map((g) => g.title))
  const live = picked.filter((t) => open.has(t))

  const start = useMutation({
    mutationFn: () => api.cleanupGaps(live),
    onSuccess: (run) => {
      setRunId(run.id)
      setNote(null)
    },
    onError: (e: Error) => setNote(`Could not start: ${e.message}`),
    onSettled: () => setArmed(false),
  })
  const runQ = useQuery({
    queryKey: ['maintenance-run', runId],
    queryFn: () => api.maintenanceRun(runId as string),
    enabled: runId !== null,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'running' ? false : 2000),
  })
  const run = runQ.data
  const running = start.isPending || (runId !== null && (run === undefined || run.status === 'running'))

  useEffect(() => {
    if (run === undefined || run.status === 'running') return
    if (run.status === 'done') {
      setNote(`Unlinked ${live.length} gap${live.length === 1 ? '' : 's'} - revertable from the activity stream.`)
      setPicked([])
    } else {
      setNote(`Unlinking failed: ${run.error ?? run.result?.error ?? 'unknown error'}`)
    }
    setRunId(null)
    void qc.invalidateQueries({ queryKey: ['graph'] })
    void qc.invalidateQueries({ queryKey: ['stats'] })
    void qc.invalidateQueries({ queryKey: ['maintenance-history'] })
    // `live` is read once, when the run settles; re-running on every pick would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status])

  return {
    live,
    running,
    armed,
    note,
    toggle: (title) => {
      setArmed(false)
      setPicked((p) => (p.includes(title) ? p.filter((t) => t !== title) : p.length >= MAX_UNLINK ? p : [...p, title]))
    },
    clear: () => setPicked([]),
    press: () => (armed ? start.mutate() : setArmed(true)),
    dismiss: () => setNote(null),
  }
}

/** The bar above a gap list: what is picked, and the two-step start. Nothing while idle. */
export function GapCleanupBar({ c }: { c: GapCleanup }): React.ReactElement | null {
  if (c.live.length === 0 && !c.running && c.note === null) return null
  return (
    <div className="gapbar" role="status">
      {c.running ? (
        <span className="dim">Unlinking {c.live.length} gap{c.live.length === 1 ? '' : 's'}… one agent run, one commit.</span>
      ) : c.live.length > 0 ? (
        <>
          <span>
            {c.live.length} picked{c.live.length >= MAX_UNLINK ? ` (max ${MAX_UNLINK} per run)` : ''}
          </span>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={c.clear}>
            Clear
          </button>
          <button
            className={`btn sm${c.armed ? ' danger' : ''}`}
            onClick={c.press}
            title="Turns every link to these titles into plain text - one agent run, one revertable commit. No page is created or deleted."
          >
            {c.armed ? `Really unlink ${c.live.length}?` : 'Unlink these'}
          </button>
        </>
      ) : (
        <>
          <span className="dim">{c.note}</span>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={c.dismiss} aria-label="Dismiss">
            <Icon name="x" />
          </button>
        </>
      )}
    </div>
  )
}
