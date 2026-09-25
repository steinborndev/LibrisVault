/**
 * Force-layout worker for the vault graph (SPEC.md §12.4). The d3-force simulation runs
 * entirely off the UI thread - the page stays responsive while the layout "warms up", which
 * is exactly the failure mode of Obsidian's graph under WSLg that this view replaces.
 *
 * Protocol (one long-lived worker per canvas mount, layouts are replaceable in flight):
 *   in : { gen, nodes: Array<{ degree: number }>, edges: Array<[number, number]>,
 *          groups: Int32Array,   // domain group id per node, -1 = uncategorized
 *          seed: Float32Array,   // [x0, y0, …]; NaN pairs = unplaced, d3 places them
 *          alpha: number }       // 1 = cold start, ~0.3 = gentle reheat of a live layout
 *   out: { gen, type: 'tick' | 'done', positions: Float32Array }
 *
 * `gen` (generation) ties every outgoing frame to the request that produced it - the main
 * thread bumps it per layout and drops stale frames, so a superseded layout can never
 * scribble over a newer one.
 *
 * Ticking is timer-sliced, NOT a blocking while-loop: between batches the worker yields to
 * its message queue, so a new layout request (live vault update mid-ingest, filter toggle)
 * interrupts the current one immediately. The simulation still cools and STOPS (alphaMin)
 * - no perpetual ticking, no idle CPU burn.
 */

import { buildNodeSimulation } from './graphForces.ts'

interface LayoutRequest {
  gen: number
  nodes: Array<{ degree: number }>
  edges: Array<[number, number]>
  groups: Int32Array
  seed: Float32Array
  alpha: number
}

let timer: ReturnType<typeof setTimeout> | undefined

self.onmessage = (ev: MessageEvent<LayoutRequest>) => {
  const { gen, nodes, edges, seed, alpha } = ev.data
  const groups = ev.data.groups ?? new Int32Array(nodes.length).fill(-1)

  // A new request supersedes whatever is still cooling.
  if (timer !== undefined) clearTimeout(timer)

  // Level 1 of the two-level layout (graphForces.ts): pack one non-overlapping disc per
  // domain, then seed unplaced nodes INSIDE their disc - a force layout is a local minimizer,
  // so a domain that starts scattered never fully gathers. Level 2 is the node simulation.
  // Built by `buildNodeSimulation`, which the layout probe runs too, so what it measures is
  // what this worker draws.
  const { sim, nodes: simNodes } = buildNodeSimulation({
    degrees: nodes.map((n) => n.degree),
    edges,
    groups,
    seed,
    alpha,
  })

  const positions = (): Float32Array => {
    const out = new Float32Array(simNodes.length * 2)
    simNodes.forEach((n, i) => {
      out[i * 2] = n.x ?? 0
      out[i * 2 + 1] = n.y ?? 0
    })
    return out
  }

  // Tick in batches; post intermediate frames so the warm-up (or the live re-settle) is
  // visible, then yield so an interrupting request gets through.
  const BATCH = 5
  const step = (): void => {
    for (let i = 0; i < BATCH && sim.alpha() > sim.alphaMin(); i++) sim.tick()
    const buf = positions()
    if (sim.alpha() > sim.alphaMin()) {
      self.postMessage({ gen, type: 'tick', positions: buf }, { transfer: [buf.buffer] })
      timer = setTimeout(step, 0)
    } else {
      timer = undefined
      self.postMessage({ gen, type: 'done', positions: buf }, { transfer: [buf.buffer] })
    }
  }
  step()
}
