import { describe, it, expect, vi, beforeEach } from 'vitest'

// The SDK spawns a real Claude Code process, so it is mocked here
// (CLAUDE.md: "agent runs are mocked in tests").
const queryMock = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }))

const { runAgent, buildOptions, buildAgentEnv, DEFAULT_TIMEOUT_MS } = await import(
  '../src/pipeline/agent-runner.js',
)
const { AUTOMATION_SYSTEM_PROMPT } = await import('../src/pipeline/system-prompt.js')

const VAULT = '/home/user/vault'
const AUTH = { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'tok-abc' } as const

/** Builds a result message matching the SDK's SDKResultSuccess shape. */
function successResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1234,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: 3,
    result: 'created 9 pages',
    stop_reason: 'end_turn',
    total_cost_usd: 0.42,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900 },
    modelUsage: {},
    permission_denials: [],
    uuid: 'u-1',
    session_id: 'sess-1',
    ...overrides,
  }
}

function streamOf(...messages: unknown[]) {
  return (async function* () {
    for (const m of messages) yield m
  })()
}

// Braces matter: an expression-bodied arrow would return mockReset()'s value (the
// mock itself), and vitest treats a beforeEach return value as a teardown callback —
// it would then call queryMock() with no arguments after every test.
beforeEach(() => {
  queryMock.mockReset()
})

describe('buildOptions', () => {
  const options = () => buildOptions({ vaultRoot: VAULT, prompt: 'ingest x', auth: AUTH }, new AbortController())

  it('runs in the vault and loads project settings so the ingest skill exists', () => {
    // Without settingSources: ['project'], the vault's CLAUDE.md and skills never
    // load and `ingest` is just chat text — this is the load-bearing option.
    const o = options()
    expect(o.cwd).toBe(VAULT)
    expect(o.settingSources).toEqual(['project'])
  })

  it('appends the automation extension to the claude_code preset', () => {
    expect(options().systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: AUTOMATION_SYSTEM_PROMPT,
    })
  })

  it('does NOT use acceptEdits — permission scoping goes through canUseTool', () => {
    // acceptEdits would auto-accept edits anywhere on disk, not just under VAULT_ROOT.
    const o = options()
    expect(o.permissionMode).toBe('default')
    expect(o.canUseTool).toBeTypeOf('function')
  })

  it('disallows web tools as defense in depth', () => {
    expect(options().disallowedTools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']))
  })

  it('wires canUseTool to the vault scope', async () => {
    const canUseTool = options().canUseTool!
    const ctx = {
      signal: new AbortController().signal,
      toolUseID: 'tu-1',
      requestId: 'req-1',
    }
    await expect(canUseTool('Write', { file_path: '/etc/passwd' }, ctx)).resolves.toMatchObject({
      behavior: 'deny',
    })
    await expect(
      canUseTool('Write', { file_path: `${VAULT}/wiki/a.md` }, ctx),
    ).resolves.toMatchObject({ behavior: 'allow' })
  })
})

describe('structured output (a Fellow planning run)', () => {
  it('passes the schema to the SDK and surfaces structured_output on the result', async () => {
    const schema = { type: 'object', properties: { proposals: { type: 'array' } }, required: ['proposals'] }
    const o = buildOptions({ vaultRoot: VAULT, prompt: 'plan', auth: AUTH, profile: 'query', outputFormat: { type: 'json_schema', schema } }, new AbortController())
    expect(o.outputFormat).toEqual({ type: 'json_schema', schema })
    expect(buildOptions({ vaultRoot: VAULT, prompt: 'x', auth: AUTH }, new AbortController()).outputFormat).toBeUndefined()

    queryMock.mockReturnValue(streamOf(successResult({ structured_output: { proposals: [] } })))
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'plan', auth: AUTH, profile: 'query', outputFormat: { type: 'json_schema', schema } })
    expect(run.ok).toBe(true)
    expect(run.structuredOutput).toEqual({ proposals: [] })

    queryMock.mockReturnValue(streamOf(successResult()))
    expect((await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH })).structuredOutput).toBeUndefined()
  })
})

describe('runAgent', () => {
  it('returns the result and usage from a successful run', async () => {
    queryMock.mockReturnValue(streamOf(successResult()))
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'ingest x', auth: AUTH })

    expect(run.ok).toBe(true)
    expect(run.result).toBe('created 9 pages')
    expect(run.numTurns).toBe(3)
    expect(run.sessionId).toBe('sess-1')
    expect(run.timedOut).toBe(false)
  })

  it('counts cached input tokens in tokensIn rather than under-reporting them', () => {
    queryMock.mockReturnValue(streamOf(successResult()))
    return runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH }).then((run) => {
      // 100 fresh + 900 cache read
      expect(run.usage.tokensIn).toBe(1000)
      expect(run.usage.tokensOut).toBe(50)
      expect(run.usage.costUsd).toBe(0.42)
    })
  })

  it('streams every message to onMessage', async () => {
    const assistant = { type: 'assistant', message: { content: [] }, uuid: 'a', session_id: 's' }
    queryMock.mockReturnValue(streamOf(assistant, successResult()))
    const seen: string[] = []
    await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH, onMessage: (m) => seen.push(m.type) })
    expect(seen).toEqual(['assistant', 'result'])
  })

  it('treats is_error: true as a failed run even on a success subtype', async () => {
    queryMock.mockReturnValue(streamOf(successResult({ is_error: true })))
    expect((await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH })).ok).toBe(false)
  })

  it('reports usage even when the run failed', async () => {
    queryMock.mockReturnValue(
      streamOf(successResult({ subtype: 'error_max_turns', is_error: true })),
    )
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('error_max_turns')
    // A failed run still burned tokens; the dashboard must see them.
    expect(run.usage.tokensIn).toBe(1000)
  })

  it('fails cleanly when the stream ends with no result message', async () => {
    queryMock.mockReturnValue(streamOf())
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('no result message')
  })

  it('does not throw when the SDK throws — a failed run is a result', async () => {
    queryMock.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('spawn failed')
  })

  it('aborts the run when the timeout fires', async () => {
    queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) =>
      // Never yields: it models an SDK call that hangs until aborted, which is
      // exactly the case the timeout has to rescue.
      // eslint-disable-next-line require-yield
      (async function* () {
        await new Promise((resolve) => {
          options.abortController.signal.addEventListener('abort', resolve, { once: true })
        })
        throw new Error('aborted')
      })(),
    )

    const run = await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH, timeoutMs: 20 })
    expect(run.timedOut).toBe(true)
    expect(run.ok).toBe(false)
    expect(run.error).toContain('timeout')
  })

  it('aborts when the caller signal fires', async () => {
    const controller = new AbortController()
    queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) =>
      // Never yields: it models an SDK call that hangs until aborted, which is
      // exactly the case the timeout has to rescue.
      // eslint-disable-next-line require-yield
      (async function* () {
        await new Promise((resolve) => {
          options.abortController.signal.addEventListener('abort', resolve, { once: true })
        })
        throw new Error('aborted')
      })(),
    )

    const promise = runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH, signal: controller.signal })
    controller.abort()
    const run = await promise
    expect(run.ok).toBe(false)
    // Caller-cancelled, not timed out — the queue must distinguish these in M1.
    expect(run.timedOut).toBe(false)
  })

  it('defaults to the 30-minute timeout from SPEC.md §3.1', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })

  it('fails a run that spent zero tokens instead of reporting success', async () => {
    // Regression: an unauthenticated subprocess replies "Not logged in · Please
    // run /login" with subtype 'success', is_error: false and zero tokens. Trusting
    // the subtype recorded that no-op as a completed ingest.
    queryMock.mockReturnValue(
      streamOf(
        successResult({
          result: 'Not logged in · Please run /login',
          usage: { input_tokens: 0, output_tokens: 0 },
          total_cost_usd: 0,
        }),
      ),
    )
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('zero tokens')
    expect(run.error).toContain('Not logged in')
  })
})

describe('buildAgentEnv (credential reaches the subprocess)', () => {
  it('passes the configured credential to the child', () => {
    // The SDK spawns a separate process that reads the credential from its own
    // environment — holding it in our config object does nothing for it.
    const env = buildAgentEnv(AUTH, { PATH: '/usr/bin' })
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok-abc')
  })

  it('inherits the base environment (Options.env replaces, it does not merge)', () => {
    const env = buildAgentEnv(AUTH, { PATH: '/usr/bin', HOME: '/home/user' })
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['HOME']).toBe('/home/user')
  })

  it('strips a stray ANTHROPIC_API_KEY so it cannot override the chosen token', () => {
    // config refuses to start when both are set, but the service's own environment
    // must not be able to silently redirect billing (SPEC.md §7.1).
    const env = buildAgentEnv(AUTH, { ANTHROPIC_API_KEY: 'stray-key', PATH: '/usr/bin' })
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok-abc')
  })

  it('strips a stray OAuth token when running in api-key mode', () => {
    const env = buildAgentEnv(
      { envVar: 'ANTHROPIC_API_KEY', credential: 'key-1' },
      { CLAUDE_CODE_OAUTH_TOKEN: 'stray-token' },
    )
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined()
    expect(env['ANTHROPIC_API_KEY']).toBe('key-1')
  })
})

describe('plan usage sampling (A5)', () => {
  /** A stream that also carries the SDK's experimental usage method, like the real Query object. */
  function queryWithUsage(messages: unknown[], usage?: () => Promise<unknown>) {
    const gen = streamOf(...messages)
    return Object.assign(gen, usage ? { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage } : {})
  }
  const limits = (five: number | null) => ({ rate_limits_available: true, subscription_type: 'max', rate_limits: five === null ? null : { five_hour: { utilization: five, resets_at: 'r' }, seven_day: { utilization: 1, resets_at: 'w' } } })
  const five = (res: unknown): string => String((res as { rate_limits: { five_hour: { utilization: number } } | null }).rate_limits?.five_hour.utilization ?? 'none')

  const assistant = (...blocks: Array<Record<string, unknown>>) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } })
  const thinking = assistant({ type: 'thinking', thinking: '...' })
  const toolCall = assistant({ type: 'tool_use', id: 't1', name: 'Read', input: {} })
  const answer = assistant({ type: 'text', text: 'Done.' })
  const turnSummary = { type: 'system', subtype: 'post_turn_summary' }
  const sequence = (values: Array<number | null>) => {
    let n = 0
    return async () => limits(values[Math.min(n++, values.length - 1)]!)
  }

  it('samples until windows appear (the before), again on a text-only message and the turn summary, forwards rate-limit events', async () => {
    // As seen for real: the thinking block streams before the first response completes (no
    // windows yet), the tool call after it carries them; the throttle skips the second tool
    // call; the final answer and the SDK's end-of-turn note are sampled.
    queryMock.mockReturnValue(
      queryWithUsage(
        [{ type: 'system', subtype: 'init' }, thinking, toolCall, { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 11, status: 'allowed' } }, toolCall, answer, turnSummary, successResult()],
        sequence([null, 10, 11, 12]),
      ),
    )
    const phases: string[] = []
    const events: unknown[] = []
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH, onPlanUsage: (phase, res) => phases.push(`${phase}:${five(res)}`), onRateLimit: (info) => events.push(info) })
    expect(run.ok).toBe(true)
    expect(phases).toEqual(['before:10', 'after:11', 'after:12'])
    expect(events).toEqual([{ rateLimitType: 'five_hour', utilization: 11, status: 'allowed' }])
    expect(run.planUsage).toEqual({ before: limits(10), after: limits(12) })

    // With the throttle off every assistant message is sampled once the before is in.
    phases.length = 0
    queryMock.mockReturnValue(queryWithUsage([{ type: 'system', subtype: 'init' }, toolCall, toolCall, answer, successResult()], sequence([10, 11, 12])))
    const every = await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH, usageSampleEveryMs: 0, onPlanUsage: (phase, res) => phases.push(`${phase}:${five(res)}`) })
    expect(phases).toEqual(['before:10', 'after:11', 'after:12'])
    expect(every.planUsage).toEqual({ before: limits(10), after: limits(12) })

    // A single-turn run has a "before" and nothing to diff against.
    queryMock.mockReturnValue(queryWithUsage([{ type: 'system', subtype: 'init' }, answer, successResult()], sequence([10])))
    expect((await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH, onPlanUsage: () => {} })).planUsage).toEqual({ before: limits(10) })

    // Windows that never come: the runner gives up on the before after a few tries and reports the last try.
    phases.length = 0
    const many = Array.from({ length: 8 }, () => toolCall)
    queryMock.mockReturnValue(queryWithUsage([{ type: 'system', subtype: 'init' }, ...many, answer, successResult()], sequence([null])))
    const none = await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH, usageSampleEveryMs: 0, onPlanUsage: (phase, res) => phases.push(`${phase}:${five(res)}`) })
    expect(phases).toEqual(['before:none', 'after:none', 'after:none', 'after:none'])
    expect(none.planUsage).toEqual({ before: limits(null), after: limits(null) })
  })

  it('does nothing without a hook, and copes with an SDK that lacks the method or throws', async () => {
    let called = 0
    queryMock.mockReturnValue(queryWithUsage([successResult()], async () => (called++, limits(1))))
    expect((await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH })).planUsage).toBeUndefined()
    expect(called).toBe(0)

    queryMock.mockReturnValue(queryWithUsage([answer, successResult()]))
    const phases: string[] = []
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH, onPlanUsage: (phase) => phases.push(phase) })
    expect(run.ok).toBe(true)
    expect(phases).toEqual([])
    expect(run.planUsage).toBeUndefined()

    queryMock.mockReturnValue(queryWithUsage([answer, successResult()], async () => { throw new Error('not available') }))
    const failed = await runAgent({ vaultRoot: VAULT, prompt: 'x', auth: AUTH, onPlanUsage: (phase) => phases.push(phase) })
    expect(failed.ok).toBe(true)
    expect(phases).toEqual([])
  })
})
