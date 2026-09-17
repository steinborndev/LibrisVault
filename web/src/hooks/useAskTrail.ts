/**
 * The activity box's lines for the question in flight: `lib/askTrail.ts` applied to each
 * change of what the client can see. The lines survive the answer landing - the box shows
 * how the last answer came about until the next question starts it over.
 */

import { useEffect, useRef, useState } from 'react'
import { advanceTrail, TRAIL_START, type TrailInput, type TrailLine } from '../lib/askTrail.ts'

export function useAskTrail(input: TrailInput): TrailLine[] {
  const [trail, setTrail] = useState<TrailLine[]>([])
  const prev = useRef<TrailInput>(TRAIL_START)
  useEffect(() => {
    const before = prev.current
    prev.current = input
    setTrail((t) => advanceTrail(t, before, input, new Date().toISOString()))
    // `input` itself is a fresh object on every render - the caller builds it inline - so
    // depending on it would append a line per render. Its five fields are the identity that
    // matters, and `advanceTrail` appends nothing when none of them changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.pending, input.retrieval, input.writing, input.landed, input.error])
  return trail
}
