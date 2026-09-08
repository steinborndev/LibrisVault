/**
 * In-memory buffer for the answer currently being streamed, keyed by chat session. The SSE hook
 * appends `chat` deltas here; the Chat tab renders the active session's buffer through
 * `useSyncExternalStore` and clears it once the authoritative answer lands.
 *
 * Deliberately tiny compared to {@link logStore}: only ONE answer streams at a time per session,
 * the text is thrown away the moment the real message arrives, and nothing here is ever
 * persisted. The streamed text is a preview of what the model is typing - the answer of record
 * is the `/query` response, which alone carries citations and usage.
 */

type Listener = () => void

/** Hard cap per session so a runaway run cannot grow a tab's memory without bound. */
const MAX_CHARS = 100_000

/** What retrieval did for the answer in flight, as the server reported it. */
export interface Retrieval {
  readonly count: number
  readonly strategy: string | null
}

class ChatStream {
  private readonly text = new Map<string, string>()
  /** One per session, set before the first delta; cleared with the text. */
  private readonly retrievals = new Map<string, Retrieval>()
  private readonly listeners = new Map<string, Set<Listener>>()

  append(sessionId: string, delta: string): void {
    if (delta === '') return
    const next = (this.text.get(sessionId) ?? '') + delta
    this.text.set(sessionId, next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next)
    this.notify(sessionId)
  }

  markRetrieval(sessionId: string, retrieval: Retrieval): void {
    this.retrievals.set(sessionId, retrieval)
    this.notify(sessionId)
  }

  /** Called when the real answer arrives (or the ask fails) - the preview has served its purpose. */
  clear(sessionId: string): void {
    if (!this.text.has(sessionId) && !this.retrievals.has(sessionId)) return
    this.text.delete(sessionId)
    this.retrievals.delete(sessionId)
    this.notify(sessionId)
  }

  snapshot(sessionId: string): string {
    return this.text.get(sessionId) ?? ''
  }

  /** The same object until it changes, as `useSyncExternalStore` requires of a snapshot. */
  retrieval(sessionId: string): Retrieval | null {
    return this.retrievals.get(sessionId) ?? null
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(sessionId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(sessionId)
    }
  }

  private notify(sessionId: string): void {
    for (const l of this.listeners.get(sessionId) ?? []) l()
  }
}

export const chatStream = new ChatStream()
