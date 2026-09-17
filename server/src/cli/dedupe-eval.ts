/**
 * Dedupe quality harness (docs/agents/ideas.md, decision 2026-09-08).
 *
 * The reason this exists before any semantic dedupe does: the first plausible design failed
 * when it was measured. Retrieval-set overlap over the BM25 index looks like it should tell
 * two phrasings of one question apart, and on this vault it does not - it ranks by shared
 * terms, so it finds topical NEIGHBOURS, and in a library concentrated on one subject that is
 * everything. Four variants (page sets, chunk sets, rank-weighted, IDF-weighted) all put the
 * weakest true duplicate below the strongest unrelated pair.
 *
 * So no threshold ships on an intuition again. A mechanism is a function from a pair of topics
 * to a score in [0, 1]; this runs every registered mechanism over the labelled set and reports
 * the only number that matters: whether the worst DUPLICATE still outscores the best DISTINCT
 * pair. If it does not, the mechanism cannot be given a threshold at all, however good its
 * average looks.
 *
 * The asymmetry is deliberate in the report. A false positive kills a run the user may have
 * approved; a false negative costs one duplicate run. So precision at a candidate threshold is
 * printed beside recall, and the suggested threshold is the one that admits NO false positive.
 *
 * The dataset is deliberately NOT in this repo: the pairs are vault topics, and this repo is
 * public (hard rule 7). Point `--data` at a JSONL file, one object per line:
 *   {"id":"…","a":"a topic sentence","b":"another","same":true,"note":"why"}
 * `same: true` means one run should serve both. A narrower FOLLOW-UP on a subject another
 * Fellow touched is `same: false` - that distinction is the whole difficulty, and this vault's
 * own history has real examples of it.
 *
 *   npm run dedupe-eval --workspace server -- --data ~/.local/share/librisvault-dev/dedupe-eval.jsonl
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { topicOverlap, DEDUPE_THRESHOLD } from '../pipeline/shift.js'
import { similarity, embedderAvailable, EMBED_MODEL } from '../pipeline/embed.js'
import { judgePairs } from '../pipeline/dedupe-judge.js'
import { loadConfig, requireAuth } from '../config.js'

interface EvalPair {
  readonly id: string
  readonly a: string
  readonly b: string
  /** True when one run should serve both topics. */
  readonly same: boolean
  /**
   * Where the pair came from. `observed` pairs are two topics this vault actually produced;
   * `paraphrase` pairs are written by hand to say one observed topic in different words.
   *
   * Reported apart, and the distinction is not cosmetic: a hand-written paraphrase flatters
   * any method that reads for meaning, because the person writing it knows what they mean. The
   * observed pairs are the ones that decide whether a mechanism ships.
   */
  readonly cohort: string
  readonly note?: string
}

/** A way of scoring how alike two topics are. Add one per candidate design, never replace. */
interface Mechanism {
  readonly label: string
  readonly score?: (a: string, b: string) => Promise<number> | number
  /**
   * For a mechanism that weighs the whole set in one go. A language-model judge is asked once
   * about every pair, which is also how it would run: a night produces a handful of candidate
   * pairs, and one call over all of them costs what one call costs.
   */
  readonly scoreAll?: (pairs: readonly EvalPair[]) => Promise<readonly number[]>
  /** Costs money and spawns an agent, so it only runs when asked for. */
  readonly optIn?: boolean
}

interface Scored {
  readonly pair: EvalPair
  readonly score: number
}

function parseArgs(argv: readonly string[]): { data: string; verbose: boolean; judge: boolean } {
  let data = ''
  let verbose = false
  let judge = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') data = argv[++i] ?? ''
    else if (argv[i] === '--verbose') verbose = true
    else if (argv[i] === '--judge') judge = true
  }
  return { data, verbose, judge }
}

export function loadPairs(raw: string): EvalPair[] {
  const pairs: EvalPair[] = []
  raw.split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    let parsed: Partial<EvalPair>
    try {
      parsed = JSON.parse(trimmed) as Partial<EvalPair>
    } catch {
      throw new Error(`line ${i + 1}: not valid JSON`)
    }
    if (!parsed.a || !parsed.b || typeof parsed.same !== 'boolean') {
      throw new Error(`line ${i + 1}: needs "a", "b" and a boolean "same"`)
    }
    pairs.push({
      id: parsed.id ?? `pair-${i + 1}`,
      a: parsed.a,
      b: parsed.b,
      same: parsed.same,
      cohort: parsed.cohort ?? 'unsorted',
      ...(parsed.note ? { note: parsed.note } : {}),
    })
  })
  return pairs
}

/**
 * The one question a threshold depends on: is there a cut that takes every duplicate and no
 * distinct pair? Returns the lowest such cut, or null when the two classes overlap - in which
 * case no threshold exists and the mechanism is not usable on its own, whatever its averages.
 */
export function separation(scored: readonly Scored[]): {
  readonly worstSame: number
  readonly bestDiff: number
  readonly threshold: number | null
} {
  const same = scored.filter((s) => s.pair.same).map((s) => s.score)
  const diff = scored.filter((s) => !s.pair.same).map((s) => s.score)
  const worstSame = same.length > 0 ? Math.min(...same) : 0
  const bestDiff = diff.length > 0 ? Math.max(...diff) : 0
  // Halfway between the two classes, rounded up to two places so the printed number is usable.
  const threshold = same.length > 0 && diff.length > 0 && worstSame > bestDiff ? Math.ceil(((worstSame + bestDiff) / 2) * 100) / 100 : null
  return { worstSame, bestDiff, threshold }
}

/**
 * The highest-precision cut: the lowest threshold that produces NO false positive, and how many
 * duplicates it still catches.
 *
 * This is the question a graded action actually asks. A mechanism that cannot separate the two
 * classes may still be worth something if there is a bar above which it is never wrong - that
 * bar can supersede, and everything under it can merely be noted in the recap. When the count
 * it catches is zero, there is nothing to grade and the mechanism buys nothing at all.
 */
export function precisionCut(scored: readonly Scored[]): { readonly cut: number; readonly caught: number } {
  const diff = scored.filter((s) => !s.pair.same).map((s) => s.score)
  // Just above the best distinct pair, so no cut can be reached by one of them.
  const cut = diff.length > 0 ? Math.ceil((Math.max(...diff) + 0.005) * 100) / 100 : 0
  return { cut, caught: scored.filter((s) => s.pair.same && s.score >= cut).length }
}

/** What a given cut would actually do to this set: caught, missed, and the costly mistakes. */
export function atThreshold(
  scored: readonly Scored[],
  cut: number,
): { readonly caught: number; readonly missed: number; readonly wrong: readonly string[] } {
  let caught = 0
  let missed = 0
  const wrong: string[] = []
  for (const s of scored) {
    if (s.pair.same) {
      if (s.score >= cut) caught++
      else missed++
    } else if (s.score >= cut) wrong.push(s.pair.id)
  }
  return { caught, missed, wrong }
}

/** A mechanism that needs the embedder yields null when there is none: not measured, not zero. */
const embedded = (label: string, prefix: string): Mechanism => ({
  label,
  score: async (a, b) => (await similarity(a, b, { prefix })) ?? Number.NaN,
})

const MECHANISMS: readonly Mechanism[] = [
  /*
   * What ships today: the overlap coefficient of significant tokens. It is here as the baseline
   * every candidate has to beat, and as the record of what it cannot do - a paraphrase that
   * reuses no words scores zero against its own twin.
   */
  { label: 'lexical (shipping)', score: topicOverlap },
  /*
   * Stage 2 under measurement: cosine between the two TOPIC SENTENCES, not between what they
   * retrieve. Raw text, the way the vault's own reranker embeds, so what is measured here is
   * the embedder as this machine actually runs it.
   */
  embedded(`embedding: ${EMBED_MODEL}, raw`, ''),
  /*
   * The same with nomic's symmetric task prefix. Its card asks for one, and `clustering:` is
   * the one meant for comparing two texts of the same kind - which is exactly this question,
   * where the retrieval prefixes (`search_query:` / `search_document:`) are not.
   */
  embedded(`embedding: ${EMBED_MODEL}, clustering prefix`, 'clustering: '),
  /*
   * The combination that would actually ship: the lexical floor, with the embedder consulted
   * where the words disagree. A duplicate has to be caught by ONE of them, so the pair is
   * scored by whichever sees it - and the distinct pairs have to stay below BOTH.
   */
  /*
   * The only mechanism that reads the question rather than its surface. One call over every
   * pair, which is also how it would run: a night produces a handful of candidates. Opt-in,
   * because unlike the others it spawns an agent and costs money.
   */
  {
    label: 'llm judge (one read-only run)',
    optIn: true,
    scoreAll: async (pairs) => {
      const config = loadConfig()
      const verdicts = await judgePairs(
        pairs.map((p) => ({ id: p.id, a: p.a, b: p.b })),
        { vaultRoot: config.vaultRoot, auth: requireAuth(config) },
      )
      return verdicts.map((v) => v.score)
    },
  },
  {
    label: 'max(lexical, embedding clustering)',
    score: async (a, b) => {
      const sem = await similarity(a, b, { prefix: 'clustering: ' })
      return sem === null ? Number.NaN : Math.max(topicOverlap(a, b), sem)
    },
  },
]

async function scoreAll(m: Mechanism, pairs: readonly EvalPair[]): Promise<Scored[]> {
  if (m.scoreAll !== undefined) {
    const scores = await m.scoreAll(pairs)
    return pairs.map((pair, i) => ({ pair, score: scores[i] ?? Number.NaN }))
  }
  const out: Scored[] = []
  const score = m.score ?? ((): number => Number.NaN)
  for (const pair of pairs) out.push({ pair, score: await score(pair.a, pair.b) })
  return out
}

function report(m: Mechanism, scored: readonly Scored[], verbose: boolean): void {
  console.log(`\n=== ${m.label} ===`)
  if (scored.some((s) => Number.isNaN(s.score))) {
    console.log('  NOT MEASURED: the embedder did not answer. Start ollama, or read this as absent rather than as zero.')
    return
  }
  const sep = separation(scored)
  if (verbose) {
    for (const s of [...scored].sort((x, y) => y.score - x.score)) {
      const mark = s.pair.same ? 'DUPLICATE' : 'distinct '
      console.log(`  ${s.score.toFixed(3)}  ${mark}  ${s.pair.id}`)
      console.log(`         a: ${s.pair.a.slice(0, 92)}`)
      console.log(`         b: ${s.pair.b.slice(0, 92)}`)
    }
  }
  console.log(`  worst duplicate ${sep.worstSame.toFixed(3)}   best distinct ${sep.bestDiff.toFixed(3)}`)
  if (sep.threshold === null) {
    console.log('  NO USABLE THRESHOLD: the classes overlap, so every cut either misses a duplicate or kills a distinct topic.')
  } else {
    console.log(`  separated: a cut at ${sep.threshold} takes every duplicate and no distinct pair.`)
  }
  const at = atThreshold(scored, DEDUPE_THRESHOLD)
  console.log(`  at the shipping threshold (${DEDUPE_THRESHOLD}): ${at.caught} caught, ${at.missed} missed, ${at.wrong.length} false positive(s)${at.wrong.length > 0 ? ` [${at.wrong.join(', ')}]` : ''}`)
  const pc = precisionCut(scored)
  console.log(
    pc.caught > 0
      ? `  a cut at ${pc.cut} never fires wrongly and still catches ${pc.caught} of ${scored.filter((s) => s.pair.same).length} duplicate(s): usable for the graded action.`
      : `  no cut fires safely and catches anything: above the best distinct pair (${pc.cut}) there is no duplicate left. Buys nothing.`,
  )
  // Per cohort, because a method can separate the paraphrases perfectly and still be useless
  // on the pairs the library actually produces.
  for (const cohort of [...new Set(scored.map((s) => s.pair.cohort))].sort()) {
    const subset = scored.filter((s) => s.pair.cohort === cohort)
    const sub = separation(subset)
    const n = subset.filter((s) => s.pair.same).length
    console.log(`  cohort ${cohort} (${n}/${subset.length} duplicate): worst dup ${sub.worstSame.toFixed(3)}, best distinct ${sub.bestDiff.toFixed(3)}${sub.threshold === null ? ' - overlaps' : ` - cut at ${sub.threshold}`}`)
  }
}

async function main(): Promise<void> {
  const { data, verbose, judge } = parseArgs(process.argv.slice(2))
  if (data === '') {
    console.error('usage: dedupe-eval --data <pairs.jsonl> [--verbose]')
    console.error('The dataset lives OUTSIDE this repo: the pairs are vault topics (hard rule 7).')
    process.exit(2)
  }
  const pairs = loadPairs(fs.readFileSync(data, 'utf8'))
  const dupes = pairs.filter((p) => p.same).length
  console.log(`${pairs.length} labelled pair(s): ${dupes} duplicate, ${pairs.length - dupes} distinct`)
  if (dupes === 0 || dupes === pairs.length) {
    console.error('A set with only one class measures nothing. Label both.')
    process.exit(2)
  }
  console.log(`embedder: ${(await embedderAvailable()) ? `${EMBED_MODEL} answering on loopback` : 'unreachable - the embedding rows will say so'}`)
  for (const m of MECHANISMS) {
    if (m.optIn === true && !judge) {
      console.log(`\n=== ${m.label} ===\n  skipped: costs an agent run. Pass --judge to measure it.`)
      continue
    }
    report(m, await scoreAll(m, pairs), verbose)
  }
  console.log('\nA mechanism with no usable threshold is not a dedupe, however good it looks on average.')
}

/*
 * Only when run as a command. The scoring helpers above are imported by the unit tests, and a
 * module that runs its own `main()` on import takes the test process down with it.
 */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
