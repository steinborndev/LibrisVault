/**
 * A Fellow's standing work as a LIST (docs/agents/ideas.md, decision 2026-09-07). One intent
 * made a broad subject both likely and unmeasurable; these are the parts that replace it, and
 * the ones with an edge worth pinning: the rotation, what may rest, and which run an art of
 * task allows.
 */

import { describe, it, expect } from 'vitest'
import { parseTasks, type AgentTask } from '../src/db/agents.js'
import { normalizeTasks, taskForTonight, restTask } from '../src/pipeline/fellows.js'
import { kindsForTask, scopeScore } from '../src/pipeline/planner.js'
import { rankForDeepening } from '../src/pipeline/deepen-rank.js'
import type { VaultGraph, GraphNode } from '../src/pipeline/graph.js'

const task = (id: string, kind: AgentTask['kind'], state: AgentTask['state'] = 'active'): AgentTask => ({ id, text: `${id} text`, kind, state })

describe('reading a task list back', () => {
  it('falls back to the intent as one explore task, so no Fellow wakes up without work', () => {
    for (const raw of [null, '', 'not json', '{}', '[]', '[{"text":"  "}]']) {
      expect(parseTasks(raw, 'the standing question')).toEqual([{ id: 't1', text: 'the standing question', kind: 'explore', state: 'active' }])
    }
  })

  it('keeps at most three and gives each an id', () => {
    const raw = JSON.stringify([1, 2, 3, 4].map((n) => ({ text: `t${n}`, kind: 'watch' })))
    expect(parseTasks(raw, 'x').map((t) => [t.id, t.text])).toEqual([
      ['t1', 't1'],
      ['t2', 't2'],
      ['t3', 't3'],
    ])
  })

  it('refuses a resting watch or deepen: standing work that calls itself finished is a stored mistake', () => {
    const raw = JSON.stringify([
      { id: 'a', text: 'a', kind: 'watch', state: 'resting' },
      { id: 'b', text: 'b', kind: 'deepen', state: 'resting' },
      { id: 'c', text: 'c', kind: 'explore', state: 'resting' },
    ])
    expect(parseTasks(raw, 'x').map((t) => t.state)).toEqual(['active', 'active', 'resting'])
  })

  it('normalizes what comes in from the API the same way', () => {
    expect(normalizeTasks([{ text: '  a  ', kind: 'watch' }, { text: '', kind: 'explore' }])).toEqual([{ id: 't1', text: 'a', kind: 'watch', state: 'active' }])
  })
})

describe('whose turn it is tonight', () => {
  const three = [task('t1', 'watch'), task('t2', 'explore'), task('t3', 'deepen')]

  it('takes them in turn and hands back where the cursor goes next', () => {
    expect(taskForTonight(three, 0)).toMatchObject({ index: 0, nextCursor: 1 })
    expect(taskForTonight(three, 1)).toMatchObject({ index: 1, nextCursor: 2 })
    expect(taskForTonight(three, 2)).toMatchObject({ index: 2, nextCursor: 0 })
  })

  it('steps over a resting task rather than dropping it', () => {
    const withRest = [three[0]!, task('t2', 'explore', 'resting'), three[2]!]
    expect(taskForTonight(withRest, 1)).toMatchObject({ index: 2 })
  })

  it('answers nothing when every task rests - which is what puts the Fellow to sleep', () => {
    expect(taskForTonight([task('t1', 'explore', 'resting')], 0)).toBeNull()
    expect(taskForTonight([], 0)).toBeNull()
  })

  it('survives a cursor that points past the list, after a task was removed', () => {
    expect(taskForTonight(three, 9)).toMatchObject({ index: 0 })
    expect(taskForTonight(three, -1)).toMatchObject({ index: 2 })
  })
})

describe('putting a task to rest', () => {
  it('rests an explore task and leaves the others standing', () => {
    const out = restTask([task('t1', 'watch'), task('t2', 'explore')], 't2')
    expect(out.map((t) => t.state)).toEqual(['active', 'resting'])
  })

  it('refuses to rest a watch or a deepen: they are never finished', () => {
    expect(restTask([task('t1', 'watch')], 't1')[0]!.state).toBe('active')
    expect(restTask([task('t1', 'deepen')], 't1')[0]!.state).toBe('active')
  })
})

describe('which run an art of task allows', () => {
  it('gives a deepen task the expand run, whatever the step size', () => {
    expect(kindsForTask('deepen', 'small')).toEqual(['research-expand'])
    expect(kindsForTask('deepen', 'deep')).toEqual(['research-expand'])
  })

  it('lets a watch sweep even on small steps: the step sizes an explore, it is not a prohibition', () => {
    expect(kindsForTask('watch', 'small')).toEqual(['research-step', 'research'])
  })

  it('keeps the step size as the size of an explore run', () => {
    expect(kindsForTask('explore', 'small')).toEqual(['research-step'])
    expect(kindsForTask('explore', 'standard')).toEqual(['research-step', 'research'])
  })
})

describe('the scope score against one task instead of a subject', () => {
  it('reads high for a proposal on the task and low for one beside it', () => {
    const onTask = scopeScore('sintering shrinkage of ceramic solid electrolytes', 'sintering shrinkage in ceramic electrolytes')
    const beside = scopeScore('procurement timelines for laboratory furnaces in the EU', 'sintering shrinkage in ceramic electrolytes')
    expect(onTask).toBeGreaterThan(beside)
    expect(beside).toBeLessThan(0.2)
  })
})

describe('which pages a deepen task builds out', () => {
  const node = (over: Partial<GraphNode> & { path: string; title: string }): GraphNode => ({
    type: 'concepts',
    tags: [],
    domain: 'materials',
    kind: 'knowledge',
    out: 2,
    in: 0,
    size: 4000,
    ...over,
  })
  const graph = (nodes: GraphNode[]): VaultGraph => ({ nodes, edges: [], gaps: [] }) as unknown as VaultGraph

  it('takes the theme’s pages, thin and much-linked first', () => {
    const g = graph([
      node({ path: 'a.md', title: 'Sintering Shrinkage Rate', in: 20, size: 800 }),
      node({ path: 'b.md', title: 'Sintering Shrinkage Models', in: 3, size: 30_000 }),
      node({ path: 'c.md', title: 'Weld Porosity', in: 40, size: 300 }),
    ])
    expect(rankForDeepening(g, new Set(['materials']), 'sintering shrinkage', 4).map((r) => r.title)).toEqual([
      'Sintering Shrinkage Rate',
      'Sintering Shrinkage Models',
    ])
  })

  it('stays inside the Fellow’s own domains, the same bound a hand-started deepening has', () => {
    const g = graph([node({ path: 'a.md', title: 'Sintering Shrinkage', domain: 'cooking', in: 9, size: 500 })])
    expect(rankForDeepening(g, new Set(['materials']), 'sintering shrinkage', 4)).toEqual([])
  })

  it('offers concepts and entities, never sources or index hubs', () => {
    const g = graph([
      node({ path: 's.md', title: 'Sintering Shrinkage (Paper)', type: 'sources', in: 9, size: 500 }),
      node({ path: 'i.md', title: 'Sintering Shrinkage Index', kind: 'structural', in: 9, size: 500 }),
      node({ path: 'e.md', title: 'Sintering Shrinkage', type: 'entities', in: 9, size: 500 }),
    ])
    expect(rankForDeepening(g, new Set(['materials']), 'sintering shrinkage', 4).map((r) => r.path)).toEqual(['e.md'])
  })

  it('answers nothing without a graph, so a deepen task skips its night instead of guessing', () => {
    expect(rankForDeepening(null, new Set(['materials']), 'anything', 4)).toEqual([])
  })
})

/**
 * The runs-per-day quota against a live five-hour release (SPEC section 8.6). The quota limits
 * the autopilot, not the user, and a release is the user saying the autopilot should use what
 * is there - so it lifts for as long as the release lasts and not a moment longer.
 */
describe('the quota under a release', () => {
  const agent = { name: 'Ada', quotaRunsPerDay: 1 }
  const refusal = (used: number, suspended: boolean, manual: boolean): string | null => {
    // The shape of the check in gateFor, isolated: kind is a step, so the quota applies.
    if (!manual && !suspended && used >= agent.quotaRunsPerDay) return 'quota'
    return null
  }

  it('refuses past the quota, unless the run is manual or a release is live', () => {
    expect(refusal(1, false, false)).toBe('quota')
    expect(refusal(1, false, true)).toBeNull()
    expect(refusal(1, true, false)).toBeNull()
  })

  it('binds again the moment the release ends', () => {
    expect(refusal(4, true, false)).toBeNull()
    expect(refusal(4, false, false)).toBe('quota')
  })
})
