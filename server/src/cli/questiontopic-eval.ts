/**
 * Reformulation quality harness (docs/tasks/TASKS-QUESTIONS.md, task 2.5).
 *
 * Same reasoning as `dedupe-eval`: a reformulation nobody measured is a second guess standing
 * in front of the first one. The board's questions reach a research run through this step now,
 * so if it turns a limitation note into a differently-worded limitation note, the change has
 * bought a metered call and nothing else.
 *
 * What it measures is exactly what phase 0 measured on the INPUT, applied to the OUTPUT, so
 * the before and after are the same numbers: does it ask something, does it still refer to the
 * run that wrote it, does the title fit a page name, is it one sentence.
 *
 *   npm run questiontopic-eval -- ~/vault --dry          # print prompts, spend nothing
 *   npm run questiontopic-eval -- ~/vault -n 30          # 30 real reformulations
 *   npm run questiontopic-eval -- ~/vault -n 30 --seed 7 # a different sample, reproducibly
 *
 * Its output quotes vault content, so it is LOCAL ONLY: never committed, never pasted into a
 * commit message or a PR body (hard rule 7).
 *
 * The sample is drawn from the same file walk the audit uses rather than from
 * `QuestionsService.list()`: the file set is the superset (it does not move when a Fellow is
 * retired or the flag is off), and the eval wants material rather than a faithful board.
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, requireAuth, ConfigError } from '../config.js'
import { runAgent } from '../pipeline/agent-runner.js'
import { collectBullets } from './questionaudit.js'
import { asksAQuestion, passDeixisIn } from '../pipeline/question-form.js'
import { readPageExcerpt, reformulate, renderTopicPrompt, TITLE_BUDGET, TOPIC_MAX_CHARS } from '../pipeline/question-topic.js'
import { researchTargetTitle, getResearchProfile, TITLE_MAX_CHARS } from '../pipeline/research-profiles.js'

/** The thresholds task 2.5 is judged against. Below any of them is a prompt to fix, not a bar to lower. */
export const TARGETS = { asks: 0.9, deixis: 0, overTitleCap: 0, multiSentence: 0 } as const

/**
 * How many sentences a topic reads as. A heuristic, and named as one.
 *
 * It splits where a sentence end is followed by a capital, and does NOT split when a single
 * capital stands immediately before the stop - which is what an initial and an abbreviation
 * ("U.S.") look like. The first measured run flagged exactly one topic as two sentences and it
 * was a single sentence carrying a name's middle initial, so the naive form cost a false
 * failure on a 30-question sample.
 *
 * The trade goes this way deliberately: a genuine second sentence that ends on a capital slips
 * through, and the failure being watched is a whole PARAGRAPH, which has several plain stops.
 */
export function sentenceCount(text: string): number {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  return trimmed.split(/(?<![A-Z]\.)(?<=[.?!])\s+(?=[A-Z])/).length
}

/** Deterministic shuffle, so `--seed` makes a sample reproducible. */
function sample<T>(items: readonly T[], n: number, seed: number): T[] {
  const out = [...items]
  let state = seed || 1
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out.slice(0, n)
}

const pct = (n: number, of: number): string => (of === 0 ? '-' : `${Math.round((n / of) * 100)} %`)

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flag = (name: string): boolean => argv.includes(name)
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const flagged = new Set(['-n', '--seed'])
  const positional = argv.filter((a, i) => !a.startsWith('-') && !flagged.has(argv[i - 1] ?? ''))
  const from = process.env.INIT_CWD ?? process.cwd()

  /*
   * The vault comes from the argument; the CREDENTIAL comes from the service environment, and
   * `loadConfig` refuses to produce one without a `VAULT_ROOT`. So the argument fills that in
   * first. Nothing else about the environment is touched, and the file this reads is the same
   * one the service reads (hard rule 3: the credential lives there and nowhere else).
   */
  const vaultRoot = path.resolve(from, positional[0] ?? process.env.VAULT_ROOT ?? '')
  if (vaultRoot !== '' && (process.env.VAULT_ROOT ?? '') === '') process.env.VAULT_ROOT = vaultRoot
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    config = undefined
  }
  const n = Number(value('-n') ?? 10)
  const seed = Number(value('--seed') ?? 1)
  const dry = flag('--dry')

  const open = collectBullets(vaultRoot).filter((b) => !b.archived)
  if (open.length === 0) {
    console.error(`no open questions under ${vaultRoot}/wiki`)
    return 2
  }
  const picked = sample(open, Math.min(n, open.length), seed)
  console.log(`${open.length} open question(s); sampling ${picked.length} (seed ${seed})\n`)

  if (dry) {
    for (const b of picked) {
      const excerpt = readPageExcerpt(vaultRoot, b.page)
      console.log('='.repeat(78))
      console.log(renderTopicPrompt({ text: b.text, page: b.page, ...(excerpt !== undefined ? { pageExcerpt: excerpt } : {}) }))
      console.log('')
    }
    console.log(`${picked.length} prompt(s) printed. Nothing was called and nothing was spent.`)
    return 0
  }

  if (config === undefined || config.auth === null) {
    console.error('no credential in the service environment; a real run needs one (use --dry to review prompts)')
    return 2
  }
  const auth = requireAuth(config)
  const broad = getResearchProfile(undefined)

  let asks = 0
  let deictic = 0
  let overCap = 0
  let multi = 0
  let failed = 0
  /*
   * Cost (task 2.6), measured by wrapping the injectable runner rather than by widening
   * `reformulate`'s answer: the suggestion the composer gets should carry a topic and a title
   * and nothing else. Tokens in/out ride along because the excerpt is what makes this call
   * bigger than a sentence, and that is the knob if it ever gets expensive.
   */
  let costUsd = 0
  let tokensIn = 0
  let tokensOut = 0
  let calls = 0
  const metered: typeof runAgent = async (opts) => {
    const result = await runAgent(opts)
    calls++
    costUsd += result.usage?.costUsd ?? 0
    tokensIn += result.usage?.tokensIn ?? 0
    tokensOut += result.usage?.tokensOut ?? 0
    return result
  }
  for (const [i, b] of picked.entries()) {
    const out = await reformulate({ text: b.text, page: b.page }, { vaultRoot, auth, run: metered })
    console.log('='.repeat(78))
    console.log(`[${i + 1}/${picked.length}] ${b.page}`)
    console.log(`  in  [${String(b.text.length).padStart(3)}] ${b.text}`)
    if (out === null) {
      failed++
      console.log('  out  (no suggestion)')
      continue
    }
    const deixis = passDeixisIn(out.topic)
    const pinned = researchTargetTitle(broad, out.topic, out.title)
    const sentences = sentenceCount(out.topic)
    if (asksAQuestion(out.topic)) asks++
    if (deixis.length > 0) deictic++
    if (pinned.length > TITLE_MAX_CHARS) overCap++
    if (sentences > 1) multi++
    console.log(`  out [${String(out.topic.length).padStart(3)}] ${out.topic}`)
    console.log(`  page  ${pinned}`)
    const flags = [
      asksAQuestion(out.topic) ? null : 'does not ask',
      deixis.length > 0 ? `deixis: ${deixis.join(', ')}` : null,
      pinned.length > TITLE_MAX_CHARS ? `title ${pinned.length} > ${TITLE_MAX_CHARS}` : null,
      sentences > 1 ? `${sentences} sentences` : null,
      out.topic.length > TOPIC_MAX_CHARS ? 'over the topic cap' : null,
      out.title.length > TITLE_BUDGET ? 'over the title budget' : null,
    ].filter((f): f is string => f !== null)
    if (flags.length > 0) console.log(`  FLAG  ${flags.join('; ')}`)
  }

  const got = picked.length - failed
  console.log(`\n${'='.repeat(78)}\nOver ${got} suggestion(s) (${failed} produced none):`)
  console.log(`  asks a question    ${asks}/${got} (${pct(asks, got)}), target ${Math.round(TARGETS.asks * 100)} %`)
  console.log(`  carries deixis     ${deictic} (${pct(deictic, got)}), target 0`)
  console.log(`  page name too long ${overCap}, target 0`)
  console.log(`  more than one sentence ${multi}, target 0`)
  if (calls > 0) {
    console.log(
      `\nCost over ${calls} call(s): ${costUsd.toFixed(4)} USD total, ${(costUsd / calls).toFixed(4)} USD each ` +
        `(${Math.round(tokensIn / calls)} tokens in, ${Math.round(tokensOut / calls)} out per call).`,
    )
  }
  const passed = got > 0 && asks / got >= TARGETS.asks && deictic === 0 && overCap === 0 && multi === 0
  console.log(passed ? '\nPASS' : '\nBELOW TARGET: fix the prompt in question-topic.ts, not the target.')
  return passed ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exitCode = 1
    })
}
