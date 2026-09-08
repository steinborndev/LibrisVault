/**
 * The local embedder (server/src/pipeline/embed.ts).
 *
 * Nothing here talks to a real ollama: what is pinned is the part that must hold whether or
 * not one is running - the loopback rule, the arithmetic, and that an absent embedder is a
 * null rather than a zero. A zero would be a score, and a score gets compared to a threshold.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { cosine, isLoopback, embedUrl, similarity, embed, EMBED_MODEL } from '../src/pipeline/embed.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('the local embedder', () => {
  it('sends vault text only to a loopback endpoint', () => {
    expect(isLoopback('http://127.0.0.1:11434')).toBe(true)
    expect(isLoopback('http://localhost:11434')).toBe(true)
    expect(isLoopback('http://[::1]:11434')).toBe(true)
    // The text handed over is a Fellow's topic. Anywhere else is an egress path around every
    // check the run profiles make, which is why the vault's own scripts refuse it too.
    expect(isLoopback('http://10.0.0.5:11434')).toBe(false)
    expect(isLoopback('https://ollama.example.com')).toBe(false)
    expect(isLoopback('not a url')).toBe(false)
  })

  it('resolves the endpoint from the environment, and refuses a remote one outright', () => {
    expect(embedUrl({})).toBe('http://127.0.0.1:11434')
    expect(embedUrl({ OLLAMA_URL: 'http://127.0.0.1:9999/' })).toBe('http://127.0.0.1:9999')
    // Not "fall back to the default": a remote setting is a decision to send text off the
    // machine, and answering null makes the caller do without rather than quietly comply.
    expect(embedUrl({ OLLAMA_URL: 'http://elsewhere.invalid' })).toBeNull()
  })

  it('scores cosine, and returns 0 rather than NaN for the degenerate cases', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1)
    expect(cosine([1, 0], [0, 1])).toBe(0)
    expect(cosine([1, 1], [2, 2])).toBeCloseTo(1, 10)
    expect(cosine([1, 0], [-1, 0])).toBe(-1)
    // A NaN would propagate into a threshold comparison as `false` and read as "not a duplicate".
    expect(cosine([0, 0], [1, 1])).toBe(0)
    expect(cosine([1, 2, 3], [1, 2])).toBe(0)
    expect(cosine([], [])).toBe(0)
  })

  it('answers null when there is no embedder, and never a number', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch
    expect(await embed('anything', { url: 'http://127.0.0.1:1' })).toBeNull()
    expect(await similarity('a topic', 'another topic')).toBeNull()
  })

  it('refuses to embed at all when the endpoint is not loopback', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    expect(await embed('a topic', { url: null })).toBeNull()
    // Not merely discarded afterwards: the text never left the process.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the vector out of a real-shaped answer and compares two texts with it', async () => {
    const vectors: Record<string, number[]> = { 'x one': [1, 0, 0], 'x two': [0.6, 0.8, 0] }
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { prompt: string; model: string }
      expect(body.model).toBe(EMBED_MODEL)
      return { ok: true, json: async () => ({ embedding: vectors[body.prompt] ?? [0, 0, 1] }) }
    }) as unknown as typeof fetch
    // The prefix rides on the text, so a mechanism can ask for the model's symmetric task mode.
    expect(await similarity('one', 'two', { prefix: 'x ' })).toBeCloseTo(0.6, 6)
  })

  it('treats a malformed answer as no answer', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ embedding: ['not', 'numbers'] }) })) as unknown as typeof fetch
    expect(await embed('unique text for the malformed case', { url: 'http://127.0.0.1:11434' })).toBeNull()
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    expect(await embed('unique text for the not-ok case', { url: 'http://127.0.0.1:11434' })).toBeNull()
  })
})
