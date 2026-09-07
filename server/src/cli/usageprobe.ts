/**
 * Can the plan windows be read WITHOUT paying for a turn?
 *
 * `usage_EXPERIMENTAL_...()` is a control request to the CLI process, not a call to the model,
 * so in principle it could answer the moment the session is up. The runner does not rely on
 * that: it waits for the first assistant message, because a sample taken earlier came back
 * with no windows. This probe settles whether that is a rule or was a coincidence - the answer
 * decides whether the plan card can refresh between runs for nothing, or whether refreshing it
 * costs a run every time.
 *
 * Not a unit test: the thing being measured is what a real CLI process does at startup.
 *
 * Run: VAULT_ROOT=~/vault npx tsx server/src/cli/usageprobe.ts
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { loadConfig, requireAuth } from '../config.js'
import { buildOptions } from '../pipeline/agent-runner.js'
import { parseSdkUsage } from '../pipeline/usage-monitor.js'

const config = loadConfig()
const abortController = new AbortController()
setTimeout(() => abortController.abort(), 90_000)

/** The same options every run gets, so the answer is about timing and not about a lean profile. */
const options = buildOptions({ vaultRoot: config.vaultRoot, prompt: '', auth: requireAuth(config) }, abortController)

const sample = async (q: unknown, when: string): Promise<boolean> => {
  const fn = (q as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown> })
    .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
  if (typeof fn !== 'function') {
    console.log(`${when}: the SDK has no usage method`)
    return false
  }
  const started = Date.now()
  try {
    const res = await Promise.race([
      fn.call(q),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 15_000)),
    ])
    const parsed = parseSdkUsage(res)
    const cost = (res as { session?: { total_cost_usd?: number } } | undefined)?.session?.total_cost_usd ?? 0
    console.log(
      `${when}: ${Date.now() - started} ms · available=${parsed.available} · windows=${parsed.windows.map((w) => `${w.window} ${w.utilization}%`).join(', ') || 'none'} · subscription=${parsed.subscription ?? 'null'} · session cost so far $${cost.toFixed(4)}${parsed.reason ? ` · ${parsed.reason}` : ''}`,
    )
    return parsed.windows.length > 0
  } catch (err) {
    console.log(`${when}: threw - ${(err as Error).message}`)
    return false
  }
}

const run = async (): Promise<void> => {
  // A prompt that costs as little as a prompt can, in case the sample DOES need a turn.
  const q = query({ prompt: 'ok', options })

  // 1. Immediately, before anything is pulled from the stream: is the session even up?
  const early = await sample(q, 'before reading the stream')

  if (early) {
    console.log('\nRESULT: the windows are there before any model turn - a free sampler is possible.')
    abortController.abort()
    return
  }

  // 2. Then follow the stream and sample at every message, to find the first one that carries
  //    windows. That message is the price of a sample.
  let seen = 0
  try {
    for await (const message of q) {
      seen++
      const got = await sample(q, `after message ${seen} (${message.type})`)
      if (got) {
        console.log(`\nRESULT: the windows arrive at message ${seen} (${message.type}) - a sample costs at least that much.`)
        break
      }
      if (seen >= 8) {
        console.log('\nRESULT: no windows within 8 messages.')
        break
      }
    }
  } catch (err) {
    console.log(`stream ended: ${(err as Error).message}`)
  }
  abortController.abort()
}

void run().then(
  () => setTimeout(() => process.exit(0), 500),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)
