/**
 * The decisions a person makes about a split proposal (docs/tasks/TASKS-DOMAIN-SPLIT.md 6.1), as
 * a pure reducer: per shelf promote, leave, defer or "merge with" another; per promoted shelf a
 * key, a description and tags; and the parent's narrowed entry. No React and no fetching, so
 * every rule here is a unit test rather than a click.
 *
 * WHAT A FIELD SHOWS, in order of precedence: what the user typed, then what the naming pass
 * answered, then the deterministic draft. The user's own edits always win (6.2), and the draft
 * means a promoted shelf never starts with an empty description.
 *
 * A KEY IS NEVER DRAFTED. It stays empty until the user or the naming pass coins one, because
 * the obvious draft - the shelf's top tag - is exactly the copy D7 forbids.
 *
 * The same reducer serves the expert panel and the guided maintenance run (6.7); the one
 * difference is where a DEFERRED shelf starts: deferred in the panel, open again in the run,
 * which is "comes back at the next maintenance run" (6.3).
 */

import type { SplitMember, SplitNaming, SplitProposal, SplitRequestBody, ShelfDecisionRecord } from '../api/types.ts'
import { draftDomainDescription, draftParentEntry } from './domainDraft.ts'
import { isValidDomainKey } from './domains.ts'

export type ShelfChoice = 'open' | 'promote' | 'leave' | 'defer'

export interface ChildFields {
  key: string
  description: string
  tags: string[]
}

export interface SplitDecisionState {
  choice: Record<number, ShelfChoice>
  /** A shelf merged into another: its id to the group leader's. */
  mergedInto: Record<number, number>
  /** What the user typed, per group leader. */
  edits: Record<number, Partial<ChildFields>>
  /** What the naming pass answered, per group leader. */
  named: Record<number, Partial<ChildFields>>
  parentEdits: { description?: string; tags?: string[] }
  parentNamed: { description?: string; tags?: string[] }
}

export type SplitAction =
  | { type: 'choose'; id: number; choice: ShelfChoice }
  | { type: 'merge'; id: number; into: number }
  | { type: 'unmerge'; id: number }
  | { type: 'edit'; leader: number; field: keyof ChildFields; value: string | string[] }
  | { type: 'edit-parent'; field: 'description' | 'tags'; value: string | string[] }
  /** The naming pass's answer, for the groups it was asked about, in that order. */
  | { type: 'named'; naming: SplitNaming; leaders: readonly number[] }

type Shelves = Pick<SplitProposal, 'shelves'>

/** The starting state: remembered leaves stay left; a defer is deferred, or open in the guided run. */
export function initialDecisions(
  proposal: Shelves,
  stored: readonly ShelfDecisionRecord[],
  opts: { guided?: boolean } = {},
): SplitDecisionState {
  const byFp = new Map(stored.map((d) => [d.fingerprint, d.decision]))
  const choice: Record<number, ShelfChoice> = {}
  for (const s of proposal.shelves) {
    const d = byFp.get(s.fingerprint)
    choice[s.id] = d === 'leave' ? 'leave' : d === 'defer' && opts.guided !== true ? 'defer' : 'open'
  }
  return { choice, mergedInto: {}, edits: {}, named: {}, parentEdits: {}, parentNamed: {} }
}

/** The leader a shelf answers to: itself, or the shelf it was merged into. */
export const leaderOf = (s: SplitDecisionState, id: number): number => s.mergedInto[id] ?? id

/** Dissolves a group: its followers go back to open, each on its own. */
function dissolve(s: SplitDecisionState, leader: number): SplitDecisionState {
  const mergedInto = { ...s.mergedInto }
  const choice = { ...s.choice }
  for (const [id, to] of Object.entries(mergedInto)) {
    if (to === leader) {
      delete mergedInto[Number(id)]
      choice[Number(id)] = 'open'
    }
  }
  return { ...s, mergedInto, choice }
}

export function splitDecisionReducer(s: SplitDecisionState, a: SplitAction): SplitDecisionState {
  switch (a.type) {
    case 'choose': {
      let next = s
      // Deciding a follower on its own takes it out of its group first.
      if (next.mergedInto[a.id] !== undefined) next = splitDecisionReducer(next, { type: 'unmerge', id: a.id })
      // A leader that stops being promoted takes its group apart: a merge is only a promotion.
      if (a.choice !== 'promote') next = dissolve(next, a.id)
      return { ...next, choice: { ...next.choice, [a.id]: a.choice } }
    }
    case 'merge': {
      const into = leaderOf(s, a.into)
      if (into === a.id || s.choice[a.id] === undefined || s.choice[into] === undefined) return s
      const mergedInto = { ...s.mergedInto }
      // What followed `id` now follows the new leader; `id` itself follows it too.
      for (const [f, to] of Object.entries(mergedInto)) if (to === a.id) mergedInto[Number(f)] = into
      mergedInto[a.id] = into
      const choice = { ...s.choice, [a.id]: 'promote' as const, [into]: 'promote' as const }
      for (const f of Object.keys(mergedInto)) if (mergedInto[Number(f)] === into) choice[Number(f)] = 'promote'
      return { ...s, mergedInto, choice }
    }
    case 'unmerge': {
      if (s.mergedInto[a.id] === undefined) return s
      const mergedInto = { ...s.mergedInto }
      delete mergedInto[a.id]
      return { ...s, mergedInto, choice: { ...s.choice, [a.id]: 'open' } }
    }
    case 'edit':
      return { ...s, edits: { ...s.edits, [a.leader]: { ...s.edits[a.leader], [a.field]: a.value } } }
    case 'edit-parent':
      return { ...s, parentEdits: { ...s.parentEdits, [a.field]: a.value } }
    case 'named': {
      const named = { ...s.named }
      a.leaders.forEach((leader, i) => {
        const n = a.naming.shelves[i + 1]
        if (n !== undefined) named[leader] = { ...n }
      })
      return { ...s, named, parentNamed: { ...a.naming.parent } }
    }
  }
}

/** The promoted groups, leaders in rank order, each with its members in rank order. */
export function promotedGroups(s: SplitDecisionState, proposal: Shelves): Array<{ leader: number; members: number[] }> {
  const order = proposal.shelves.map((sh) => sh.id)
  return order
    .filter((id) => s.choice[id] === 'promote' && s.mergedInto[id] === undefined)
    .map((leader) => ({ leader, members: order.filter((id) => id === leader || s.mergedInto[id] === leader) }))
}

/** The shelves' own tags, united over a group, as the draft of its tag hints. */
function groupTags(proposal: Shelves, members: readonly number[]): string[] {
  return [...new Set(members.flatMap((id) => proposal.shelves.find((sh) => sh.id === id)?.tags ?? []))]
}

/** What the fields of one group show: the user's edit, then the naming pass, then the draft. */
export function childFields(s: SplitDecisionState, proposal: Shelves, group: { leader: number; members: readonly number[] }): ChildFields {
  const edit = s.edits[group.leader] ?? {}
  const named = s.named[group.leader] ?? {}
  const key = edit.key ?? named.key ?? ''
  const tags = edit.tags ?? named.tags ?? groupTags(proposal, group.members)
  const description = edit.description ?? named.description ?? draftDomainDescription({ key: key === '' ? 'this shelf' : key, tags })
  return { key, description, tags }
}

/** The parent's narrowed entry: the user's edit, then the naming pass, then 4.4's draft. */
export function parentFields(
  s: SplitDecisionState,
  proposal: Shelves,
  current: { description: string; tags: readonly string[] },
): { description: string; tags: string[] } {
  const children = promotedGroups(s, proposal).map((g) => childFields(s, proposal, g))
  const draft = draftParentEntry(current, children.map((c) => ({ key: c.key === '' ? '?' : c.key, tags: c.tags })))
  return {
    description: s.parentEdits.description ?? s.parentNamed.description ?? draft.description,
    tags: s.parentEdits.tags ?? s.parentNamed.tags ?? draft.tags,
  }
}

/** Why a group's key cannot be applied yet, or null when it can. */
export function keyProblem(key: string, others: readonly string[], registryKeys: readonly string[], parent: string): string | null {
  if (key === '') return 'Coin a key'
  if (!isValidDomainKey(key)) return 'Lowercase letters, digits and hyphens only'
  if (key === 'meta' || key === 'unassigned') return 'That key is reserved'
  if (key === parent) return 'That is the parent\'s own key'
  if (registryKeys.includes(key)) return 'A domain with that key exists already'
  if (others.includes(key)) return 'Two new domains cannot share a key'
  return null
}

/** Every problem that stands between the decisions and a plan request, by group leader. */
export function decisionProblems(
  s: SplitDecisionState,
  proposal: Shelves & Pick<SplitProposal, 'domain'>,
  registryKeys: readonly string[],
): Map<number, string> {
  const groups = promotedGroups(s, proposal)
  const fields = groups.map((g) => childFields(s, proposal, g))
  const out = new Map<number, string>()
  groups.forEach((g, i) => {
    const others = fields.filter((_, j) => j !== i).map((f) => f.key)
    const problem = keyProblem(fields[i]!.key, others, registryKeys, proposal.domain)
    if (problem !== null) out.set(g.leader, problem)
    else if (fields[i]!.description.trim() === '') out.set(g.leader, 'Write a description')
  })
  return out
}

/**
 * The plan (and apply) request the decisions produce, or null while there is nothing to promote.
 * A merged group is ONE child with the union of its shelves' pages: the server knows nothing
 * about merges. Unaddressed pages ride along and come back as `unaddressed`, never moved.
 */
export function planRequest(
  s: SplitDecisionState,
  proposal: Shelves,
  current: { description: string; tags: readonly string[] },
): SplitRequestBody | null {
  const groups = promotedGroups(s, proposal)
  if (groups.length === 0) return null
  const pagesOf = (members: readonly number[]): SplitMember[] =>
    members.flatMap((id) => proposal.shelves.find((sh) => sh.id === id)?.pages ?? []).map((p) => ({ path: p.path, address: p.address }))
  const parent = parentFields(s, proposal, current)
  return {
    parentEntry: { description: parent.description.trim(), tags: parent.tags },
    children: groups.map((g) => {
      const f = childFields(s, proposal, g)
      return { key: f.key, description: f.description.trim(), tags: f.tags, pages: pagesOf(g.members) }
    }),
  }
}
