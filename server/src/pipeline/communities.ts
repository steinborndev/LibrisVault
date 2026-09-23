/**
 * Deterministic multi-level Louvain, the server's copy (docs/tasks/TASKS-DOMAIN-SPLIT.md 1.1).
 *
 * A PORT of `louvainCommunities` in `web/src/lib/communities.ts`, with one addition: an
 * optional modularity resolution `gamma` (default 1, which is the web's behaviour). The split
 * proposal (`domain-split.ts`) runs here because a write must never be started from what a
 * browser tab computed, while the Graph's hull lens stays a client-side toggle with no round
 * trip - so there are two copies. That is the same trade-off `web/src/api/types.ts` states for
 * the hand-mirrored API types, and it is pinned the same way: `server/test/communities.test.ts`
 * and `web/test/communities-parity.test.ts` generate one seeded graph and assert ONE hard-coded
 * label array at γ = 1, so either copy drifting fails its own suite. Change both or neither.
 */

/**
 * One Louvain level: greedily move each node into the neighbouring community that most
 * raises modularity, until no move helps. Deterministic - nodes are visited in index order
 * and equal gains break toward the lowest community id. `self[i]` is a node's self-loop weight
 * (super-nodes accrue it during aggregation). `gamma` scales the null-model term: below 1 it
 * favours fewer, larger communities.
 */
function louvainLevel(
  n: number,
  adj: Array<Map<number, number>>,
  self: number[],
  twoM: number,
  gamma: number,
): number[] {
  const comm = Array.from({ length: n }, (_, i) => i)
  const deg = Array.from({ length: n }, (_, i) => self[i]! * 2 + [...adj[i]!.values()].reduce((s, x) => s + x, 0))
  const sigTot = deg.slice()
  let improved = true
  for (let pass = 0; improved && pass < 100; pass++) {
    improved = false
    for (let i = 0; i < n; i++) {
      const ci = comm[i]!
      sigTot[ci]! -= deg[i]!
      // Weight from i into each neighbouring community.
      const wc = new Map<number, number>()
      for (const [j, wij] of adj[i]!) {
        if (j === i) continue
        wc.set(comm[j]!, (wc.get(comm[j]!) ?? 0) + wij)
      }
      let best = ci
      let bestGain = (wc.get(ci) ?? 0) - (gamma * deg[i]! * sigTot[ci]!) / twoM
      for (const [c, wic] of wc) {
        const gain = wic - (gamma * deg[i]! * sigTot[c]!) / twoM
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) < 1e-12 && c < best)) {
          best = c
          bestGain = gain
        }
      }
      sigTot[best]! += deg[i]!
      if (best !== ci) {
        comm[i] = best
        improved = true
      }
    }
  }
  return comm
}

/**
 * Multi-level Louvain over `n` nodes. Returns a community id per node (stable, not necessarily
 * contiguous). `weightOf(a, b)` is an edge's weight; `gamma` the resolution.
 *
 * "Deterministic" means: the same input in the same ORDER gives the same output. It does not
 * mean stable under a reordering - one run over the same pages in another order moves a median
 * 4.8 % of them (analysis, R3) - which is why the split proposal runs a consensus over seeded
 * permutations rather than trusting one run.
 */
export function louvainCommunities(
  n: number,
  edges: ReadonlyArray<readonly [number, number]>,
  weightOf: (a: number, b: number) => number = () => 1,
  gamma = 1,
): number[] {
  let size = n
  let adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map())
  let self = new Array<number>(n).fill(0)
  let twoM = 0
  for (const [a, b] of edges) {
    if (a >= n || b >= n) continue
    const w = weightOf(a, b)
    if (w <= 0) continue
    twoM += 2 * w
    if (a === b) {
      self[a]! += w
      continue
    }
    adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + w)
    adj[b]!.set(a, (adj[b]!.get(a) ?? 0) + w)
  }
  const mapping = Array.from({ length: n }, (_, i) => i)
  if (twoM === 0) return mapping

  for (let level = 0; level < 10; level++) {
    const comm = louvainLevel(size, adj, self, twoM, gamma)
    const uniq = [...new Set(comm)].sort((x, y) => x - y)
    if (uniq.length === size) break // converged: this level merged nothing
    const relabel = new Map(uniq.map((c, i) => [c, i]))
    for (let i = 0; i < n; i++) mapping[i] = relabel.get(comm[mapping[i]!]!)!
    // Aggregate each community into one super-node for the next, coarser level.
    const K = uniq.length
    const nadj: Array<Map<number, number>> = Array.from({ length: K }, () => new Map())
    const nself = new Array<number>(K).fill(0)
    for (let i = 0; i < size; i++) {
      const ci = relabel.get(comm[i]!)!
      nself[ci]! += self[i]!
      for (const [j, wij] of adj[i]!) {
        const cj = relabel.get(comm[j]!)!
        if (ci === cj) {
          if (i <= j) nself[ci]! += wij // count each intra-community edge once
        } else {
          nadj[ci]!.set(cj, (nadj[ci]!.get(cj) ?? 0) + wij)
        }
      }
    }
    size = K
    adj = nadj
    self = nself
  }
  return mapping
}
