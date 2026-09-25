/**
 * The graph layout, measured (2026-09-24). Runs the SAME two-level simulation the Graph screen's
 * worker runs (`buildNodeSimulation` in web/src/lib/graphForces.ts) to convergence over a live
 * graph, and prints how clean the result is (web/src/lib/graphLayoutQuality.ts): the spread of
 * each domain over its slot, the share of pages drawn inside another domain, overlapping domain
 * pairs, and how long the fibres between domains are.
 *
 *   npm run graphprobe                                  the graph of 8421, cold, as a reload draws it
 *   npm run graphprobe -- --before a,b=parent           also: the layout before a split that took
 *                                                       domains a and b out of parent, and what the
 *                                                       open tab drew after it - the old gentle
 *                                                       reheat against the re-seed of reseedPlan
 *   … --url http://127.0.0.1:8435/api/v1/graph         another instance
 *   … --system                                          with the system pages, as the screen's switch
 *   … --domain <key>                                    also that one domain's spread and fragments
 *   … --names                                           name the worst domain (vault content: terminal only)
 *   … --json                                            the figures as JSON
 *
 * READ-ONLY: one GET of /api/v1/graph, nothing else. Output is numbers only unless --names, so a
 * run can be quoted into a task file (CLAUDE.md hard rule 7).
 *
 * Run with tsx (it imports the web's TypeScript): the npm script does that.
 */

import { buildNodeSimulation, domainGroups, reseedPlan } from '../web/src/lib/graphForces.ts'
import { centroidDrift, layoutQuality } from '../web/src/lib/graphLayoutQuality.ts'

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)
const URL_ = arg('--url', 'http://127.0.0.1:8421/api/v1/graph')
const BEFORE = arg('--before')
const NAMES = has('--names')
const JSON_OUT = has('--json')
const SYSTEM = has('--system')
const DOMAIN = arg('--domain')

const graph = await (await fetch(URL_)).json()
const isKnowledge = (n) => (n.kind ?? 'knowledge') === 'knowledge' && n.origin !== 'upstream-demo'
const keep = graph.nodes.map((n, i) => [n, i]).filter(([n]) => SYSTEM || isKnowledge(n))
const newIndex = new Map(keep.map(([, i], j) => [i, j]))
const nodes = keep.map(([n]) => n)
const edges = graph.edges
  .map(([a, b]) => [newIndex.get(a), newIndex.get(b)])
  .filter(([a, b]) => a !== undefined && b !== undefined)
const degrees = nodes.map((n) => (n.in ?? 0) + (n.out ?? 0))
const paths = nodes.map((n) => n.path)
const domains = nodes.map((n) => n.domain ?? null)

/** One layout to convergence, as the worker would cool it. */
function run(domainList, seed, alpha) {
  const groups = domainGroups(domainList)
  const t0 = performance.now()
  const { sim, nodes: simNodes, slots } = buildNodeSimulation({ degrees, edges, groups, seed, alpha })
  let ticks = 0
  while (sim.alpha() > sim.alphaMin() && ticks < 3000) {
    sim.tick()
    ticks++
  }
  const positions = new Float32Array(simNodes.length * 2)
  simNodes.forEach((n, i) => {
    positions[i * 2] = n.x ?? 0
    positions[i * 2 + 1] = n.y ?? 0
  })
  const quality = layoutQuality(positions, groups, slots.map((s) => s.r), edges)
  const keyOfGroup = new Map()
  groups.forEach((g, i) => g >= 0 && !keyOfGroup.has(g) && keyOfGroup.set(g, domainList[i]))
  const centroids = new Map(quality.perDomain.map((q) => [keyOfGroup.get(q.group), { x: q.cx, y: q.cy }]))
  return { positions, quality, centroids, keyOfGroup, ticks, ms: Math.round(performance.now() - t0) }
}

/** The one domain asked about, by key: its spread and fragment share in this run. */
function domainCols(r) {
  const g = [...r.keyOfGroup].find(([, k]) => k === DOMAIN)?.[0]
  const q = r.quality.perDomain.find((d) => d.group === g)
  return q === undefined ? { domSpread: null, domFragPct: null } : { domSpread: +q.spread.toFixed(2), domFragPct: +(q.fragments * 100).toFixed(1) }
}

const unplaced = () => new Float32Array(nodes.length * 2).fill(NaN)
const rows = []
const row = (name, r, extra = {}) =>
  rows.push({
    scenario: name,
    spreadMedian: +r.quality.spreadMedian.toFixed(2),
    spreadMax: +r.quality.spreadMax.toFixed(2),
    ...(NAMES ? { spreadWorst: r.keyOfGroup.get(r.quality.spreadWorst) ?? null } : {}),
    misplacedPct: +(r.quality.misplacedShare * 100).toFixed(1),
    overlapPairs: r.quality.overlapPairs,
    bridgeRatio: r.quality.bridgeRatio === null ? null : +r.quality.bridgeRatio.toFixed(2),
    fragmentPct: +(r.quality.fragmentShare * 100).toFixed(1),
    fragmentMaxPct: +(r.quality.fragmentMax * 100).toFixed(1),
    ...(NAMES ? { fragmentWorst: r.keyOfGroup.get(r.quality.fragmentWorst) ?? null } : {}),
    ...(DOMAIN !== null ? domainCols(r) : {}),
    ticks: r.ticks,
    ms: r.ms,
    ...extra,
  })

const cold = run(domains, unplaced(), 1)
row('now, cold (a reload)', cold)

if (BEFORE !== null) {
  // "a,b=parent;c=other": the domains a split took out, mapped back onto their parent.
  const back = new Map()
  for (const part of BEFORE.split(';')) {
    const [kids, parent] = part.split('=')
    for (const k of (kids ?? '').split(',').map((s) => s.trim()).filter(Boolean)) back.set(k, parent.trim())
  }
  const beforeDomains = domains.map((d) => (d !== null && back.has(d) ? back.get(d) : d))
  const before = run(beforeDomains, unplaced(), 1)
  row('before the split, cold', before)

  // What the open tab drew until 2026-09-24: every known position kept, a gentle reheat.
  const reheat = run(domains, before.positions.slice(), 0.3)
  row('after, old: gentle reheat', reheat, { driftMedian: Math.round(centroidDrift(before.centroids, reheat.centroids).median) })

  // What it draws now: reseedPlan decides.
  const plan = reseedPlan(paths, domains, new Map(paths.map((p, i) => [p, beforeDomains[i]])))
  const seed = before.positions.slice()
  let alpha = 0.3
  if (plan.mode === 'full') {
    seed.fill(NaN)
    alpha = 1
  } else if (plan.mode === 'partial') for (const i of plan.drop) seed.fill(NaN, i * 2, i * 2 + 2)
  const reseed = run(domains, seed, alpha)
  row(`after, new: ${plan.mode}`, reseed, { driftMedian: Math.round(centroidDrift(before.centroids, reseed.centroids).median) })
}

if (JSON_OUT) console.log(JSON.stringify({ nodes: nodes.length, edges: edges.length, rows }, null, 2))
else {
  console.log(`${nodes.length} pages, ${edges.length} links, ${cold.quality.domains} domains${SYSTEM ? ' (system pages included)' : ''}`)
  console.table(rows)
  console.log('spread: p90 distance from the domain centroid over its slot radius (about 1 fills its territory)')
  console.log('misplaced: pages nearer another domain than their own; overlaps: domain pairs drawn into each other')
  console.log('bridgeRatio: median cross-domain link length over an internal one; drift: median centroid move')
  console.log('fragment: pages outside their domain\'s largest spatial island (all domains / the most frayed one)')
}
