/**
 * The decision surface's reducer (docs/tasks/TASKS-DOMAIN-SPLIT.md 6.1, 6.3): promote, leave,
 * defer, merge and un-merge, the field precedence (the user's edit, then the naming pass, then
 * the draft), the memory of a left or deferred shelf, and the plan request the decisions make.
 * Synthetic throughout: shelves `f0` to `f3`, tags `t-a` and so on.
 */
import { describe, it, expect } from 'vitest'
import {
  childFields,
  decisionProblems,
  initialDecisions,
  keyProblem,
  parentFields,
  planRequest,
  promotedGroups,
  splitDecisionReducer,
  type SplitAction,
  type SplitDecisionState,
} from '../src/lib/splitDecisions.ts'
import { draftParentEntry } from '../src/lib/domainDraft.ts'
import { keyCollisionOf } from '../src/lib/splitShelves.ts'
import type { SplitShelf } from '../src/api/types.ts'

const shelf = (id: number, n: number, tags: string[]): SplitShelf => ({
  id,
  rank: id + 1,
  size: n,
  types: { concepts: n },
  entities: 0,
  conductance: 0.1,
  stability: 1,
  precision: 1,
  recall: 1,
  separability: 0.9,
  misfile: false,
  confusedWith: [],
  landmarks: [],
  tags,
  topTagCollision: null,
  outsideNeighbours: { count: 0, pages: [] },
  fingerprint: `f${id}`,
  pages: Array.from({ length: n }, (_, i) => ({ path: `wiki/s${id}-${i}.md`, address: i === 0 && id === 3 ? null : `c-${id}-${i}` })),
})

const proposal = {
  domain: 'alpha',
  shelves: [shelf(0, 4, ['t-a', 't-b']), shelf(1, 3, ['t-c']), shelf(2, 2, ['t-d']), shelf(3, 2, [])],
}
const current = { description: 'Everything alpha.', tags: ['t-a', 't-c', 't-z'] }

const run = (s: SplitDecisionState, ...actions: SplitAction[]): SplitDecisionState => actions.reduce(splitDecisionReducer, s)
const fresh = (): SplitDecisionState => initialDecisions(proposal, [])

describe('choices', () => {
  it('promotes, leaves and defers one shelf at a time', () => {
    const s = run(fresh(), { type: 'choose', id: 0, choice: 'promote' }, { type: 'choose', id: 1, choice: 'leave' }, { type: 'choose', id: 2, choice: 'defer' })
    expect(s.choice).toEqual({ 0: 'promote', 1: 'leave', 2: 'defer', 3: 'open' })
    expect(promotedGroups(s, proposal)).toEqual([{ leader: 0, members: [0] }])
  })

  it('merges two shelves into one promoted group under the higher-ranked one', () => {
    const s = run(fresh(), { type: 'merge', id: 3, into: 2 })
    expect(promotedGroups(s, proposal)).toEqual([{ leader: 2, members: [2, 3] }])
    // Merging into a follower lands on its leader.
    const t = run(s, { type: 'merge', id: 1, into: 3 })
    expect(promotedGroups(t, proposal)).toEqual([{ leader: 2, members: [1, 2, 3] }])
  })

  it('un-merges a follower back to open, and a leader that stops being promoted dissolves its group', () => {
    const s = run(fresh(), { type: 'merge', id: 3, into: 2 }, { type: 'merge', id: 1, into: 2 })
    const u = run(s, { type: 'unmerge', id: 3 })
    expect(promotedGroups(u, proposal)).toEqual([{ leader: 2, members: [1, 2] }])
    expect(u.choice[3]).toBe('open')
    const d = run(s, { type: 'choose', id: 2, choice: 'leave' })
    expect(promotedGroups(d, proposal)).toEqual([])
    expect(d.choice).toEqual({ 0: 'open', 1: 'open', 2: 'leave', 3: 'open' })
    // Deciding a follower on its own takes it out of the group first.
    const f = run(s, { type: 'choose', id: 1, choice: 'defer' })
    expect(promotedGroups(f, proposal)).toEqual([{ leader: 2, members: [2, 3] }])
  })

  it('ignores a merge into itself', () => {
    expect(run(fresh(), { type: 'merge', id: 1, into: 1 })).toEqual(fresh())
  })
})

describe('the memory (6.3)', () => {
  const stored = [
    { fingerprint: 'f1', decision: 'leave' as const, decidedAt: 'x' },
    { fingerprint: 'f2', decision: 'defer' as const, decidedAt: 'x' },
    { fingerprint: 'gone-shelf', decision: 'leave' as const, decidedAt: 'x' },
  ]

  it('keeps a left fingerprint left and a deferred one deferred; a changed fingerprint is open', () => {
    const s = initialDecisions(proposal, stored)
    expect(s.choice).toEqual({ 0: 'open', 1: 'leave', 2: 'defer', 3: 'open' })
    const changed = initialDecisions({ shelves: proposal.shelves.map((sh) => (sh.id === 1 ? { ...sh, fingerprint: 'f1-moved' } : sh)) }, stored)
    expect(changed.choice[1]).toBe('open')
  })

  it('brings a deferred shelf back in the guided run, and a left one not', () => {
    expect(initialDecisions(proposal, stored, { guided: true }).choice).toEqual({ 0: 'open', 1: 'leave', 2: 'open', 3: 'open' })
  })

  it('opens a shelf again once its decision is restored', () => {
    expect(initialDecisions(proposal, stored.filter((d) => d.fingerprint !== 'f1')).choice[1]).toBe('open')
  })
})

describe('the fields', () => {
  it('never drafts a key, drafts a description and the group tags, and lets the naming pass fill them', () => {
    const s = run(fresh(), { type: 'merge', id: 1, into: 0 })
    const g = promotedGroups(s, proposal)[0]!
    const draft = childFields(s, proposal, g)
    expect(draft.key).toBe('')
    expect(draft.tags).toEqual(['t-a', 't-b', 't-c'])
    expect(draft.description).toMatch(/^This shelf and closely related work/)
    const named = run(s, {
      type: 'named',
      leaders: [0],
      naming: { shelves: { 1: { key: 'coined', description: 'Named.', tags: ['n'] } }, parent: { description: 'Parent named.' } },
    })
    expect(childFields(named, proposal, g)).toEqual({ key: 'coined', description: 'Named.', tags: ['n'] })
    expect(parentFields(named, proposal, current).description).toBe('Parent named.')
  })

  it('lets the user\'s own edit win over the naming pass, and the naming pass not overwrite it', () => {
    const s = run(
      fresh(),
      { type: 'choose', id: 0, choice: 'promote' },
      { type: 'edit', leader: 0, field: 'key', value: 'mine' },
      { type: 'named', leaders: [0], naming: { shelves: { 1: { key: 'theirs', description: 'Theirs.' } }, parent: {} } },
    )
    expect(childFields(s, proposal, { leader: 0, members: [0] })).toMatchObject({ key: 'mine', description: 'Theirs.' })
  })

  it('drafts the parent from 4.4: one sentence naming the children, no tag a child lists', () => {
    const s = run(
      fresh(),
      { type: 'choose', id: 0, choice: 'promote' },
      { type: 'edit', leader: 0, field: 'key', value: 'first' },
      { type: 'choose', id: 1, choice: 'promote' },
      { type: 'edit', leader: 1, field: 'key', value: 'second' },
    )
    expect(parentFields(s, proposal, current)).toEqual({
      description: 'Everything alpha. Pages on `first` and `second` have their own domains.',
      tags: ['t-z'],
    })
  })
})

describe('the plan request', () => {
  it('is null with nothing promoted, and one child per group with the union of its pages', () => {
    expect(planRequest(fresh(), proposal, current)).toBeNull()
    const s = run(
      fresh(),
      { type: 'choose', id: 0, choice: 'promote' },
      { type: 'edit', leader: 0, field: 'key', value: 'first' },
      { type: 'merge', id: 3, into: 2 },
      { type: 'edit', leader: 2, field: 'key', value: 'merged' },
      { type: 'choose', id: 1, choice: 'leave' },
    )
    const req = planRequest(s, proposal, current)!
    expect(req.children.map((c) => [c.key, c.pages.length])).toEqual([
      ['first', 4],
      ['merged', 4],
    ])
    // The unaddressed page rides along; the server reports it, never moves it.
    expect(req.children[1]!.pages.filter((p) => p.address === null)).toHaveLength(1)
    expect(req.parentEntry.description).toContain('Pages on `first` and `merged` have their own domains.')
  })

  it('names every problem that stands between the decisions and a plan', () => {
    const s = run(
      fresh(),
      { type: 'choose', id: 0, choice: 'promote' },
      { type: 'choose', id: 1, choice: 'promote' },
      { type: 'edit', leader: 1, field: 'key', value: 'beta' },
    )
    expect([...decisionProblems(s, proposal, ['alpha', 'beta'])]).toEqual([
      [0, 'Coin a key'],
      [1, 'A domain with that key exists already'],
    ])
    expect(keyProblem('Not a key', [], [], 'alpha')).toMatch(/Lowercase/)
    expect(keyProblem('unassigned', [], [], 'alpha')).toMatch(/reserved/)
    expect(keyProblem('alpha', [], [], 'alpha')).toMatch(/parent/)
    expect(keyProblem('x', ['x'], [], 'alpha')).toMatch(/share a key/)
  })
})

describe('draftParentEntry (the web mirror of the server draft)', () => {
  // The same cases as `server/test/domains.test.ts`, so the two copies cannot drift apart.
  it('matches the server on its own cases', () => {
    const d = draftParentEntry(
      { description: 'Biology, medicine and drug delivery.', tags: ['mrna-delivery', 'biomedical', 'drug-delivery', 'genomics'] },
      [
        { key: 'drug-delivery', tags: ['mrna-delivery', 'Drug-Delivery'] },
        { key: 'gene-editing', tags: ['genomics'] },
        { key: 'imaging', tags: [] },
      ],
    )
    expect(d.description).toBe('Biology, medicine and drug delivery. Pages on `drug-delivery`, `gene-editing` and `imaging` have their own domains.')
    expect(d.tags).toEqual(['biomedical'])
    expect(draftParentEntry({ description: 'X.', tags: [] }, [{ key: 'a', tags: [] }]).description).toBe('X. Pages on `a` have their own domain.')
  })
})

describe('keyCollisionOf', () => {
  it('counts the pages carrying the key as a tag, inside the new domain and elsewhere', () => {
    const nodes = [
      { path: 'a', tags: ['First'] },
      { path: 'b', tags: ['first', 'x'] },
      { path: 'c', tags: ['x'] },
      { path: 'd', tags: ['first'] },
    ]
    expect(keyCollisionOf(nodes, new Set(['a', 'c']), 'first')).toEqual({ inside: 1, elsewhere: 2 })
    expect(keyCollisionOf(nodes, new Set(['a']), '')).toEqual({ inside: 0, elsewhere: 0 })
  })
})
