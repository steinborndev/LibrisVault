import { describe, it, expect } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { formatMessage } from '../src/pipeline/format-message.js'

const msg = (m: unknown): SDKMessage => m as SDKMessage

/**
 * job_logs volume (2026-09-18): one ingest run persisted 60 lines and 23 KB, of which 18.5 KB
 * was the ingest skill's full body echoed back as a user turn, plus fifteen thinking-token
 * progress frames. Across the history the two made up more than half of all log bytes.
 */
describe('formatMessage', () => {
  it('drops the thinking-token progress frames and keeps the other system frames', () => {
    expect(
      formatMessage(msg({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 120, estimated_tokens_delta: 20 })),
    ).toBeUndefined()
    expect(formatMessage(msg({ type: 'system', subtype: 'init' }))).toBe('[system] init')
    expect(formatMessage(msg({ type: 'system', subtype: 'hook_response' }))).toBe('[system] hook_response')
  })

  it('clips injected user text (a skill body) to its first lines and says how much it left out', () => {
    const body = `Base directory for this skill: /vault/skills/wiki-ingest\n\n# wiki-ingest\n${'x'.repeat(18_000)}`
    const line = formatMessage(msg({ type: 'user', message: { content: [{ type: 'text', text: body }] } }))!
    expect(line.startsWith('[user] Base directory for this skill: /vault/skills/wiki-ingest')).toBe(true)
    expect(line.length).toBeLessThan(500)
    expect(line).toMatch(/\[\+\d+ chars\]$/)
    // String-typed user content is clipped the same way.
    const plain = formatMessage(msg({ type: 'user', message: { content: body } }))!
    expect(plain.length).toBeLessThan(500)
  })

  it('leaves short user text and every assistant text whole', () => {
    expect(formatMessage(msg({ type: 'user', message: { content: [{ type: 'text', text: 'ingest this' }] } }))).toBe(
      '[user] ingest this',
    )
    const narrative = 'a'.repeat(2_000)
    expect(formatMessage(msg({ type: 'assistant', message: { content: [{ type: 'text', text: narrative }] } }))).toBe(
      `[assistant] ${narrative}`,
    )
  })

  it('renders tool calls and tool results as before', () => {
    const call = msg({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/v/wiki/log.md' } }] },
    })
    expect(formatMessage(call)).toBe('[assistant] → Edit({"file_path":"/v/wiki/log.md"})')
    expect(formatMessage(msg({ type: 'user', message: { content: [{ type: 'tool_result', is_error: false }] } }))).toBe(
      '[user] ← tool ok',
    )
    expect(formatMessage(msg({ type: 'result', subtype: 'success' }))).toBeUndefined()
  })
})
