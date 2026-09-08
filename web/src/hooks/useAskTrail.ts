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
  }, [input.pending, input.retrieval, input.writing, input.landed, input.error])
  return trail
}
