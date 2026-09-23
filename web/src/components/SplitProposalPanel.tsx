/**
 * The split proposal and its decision surface, in System's Domains card
 * (docs/tasks/TASKS-DOMAIN-SPLIT.md 3.4 and 6.1 to 6.8): which shelves a domain falls into,
 * ranked by how cleanly each stands apart, with the evidence a person needs to judge it - and,
 * per shelf, promote, leave, defer or merge with another. A promoted shelf gets a key, a
 * description and tags; the parent gets its narrowed entry; "Preview" shows the plan and
 * "Apply" writes it as ONE commit after a second click. The applied splits sit underneath,
 * each with its remainder and its revert.
 *
 * ONE implementation per decision surface: the guided maintenance run embeds this same
 * component (`guided`), which differs only in where a deferred shelf starts (6.3, 6.7).
 *
 * Base product (hard rule 8): it asks the split routes and the graph. The one Fellow line (6.8)
 * is rendered, and `GET /agents` asked, only when `health.fellows` is true. In the read-only
 * demo every write control is DISABLED rather than hidden, so the surface still reads.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../api/client.ts'
import type {
  GraphNode,
  SplitApplyResult,
  SplitPlan,
  SplitProposal,
  SplitShelf,
  SplitSummary,
  ShelfDecision,
} from '../api/types.ts'
import { isKnowledgeNode } from '../lib/knowledge.ts'
import { keyCollisionOf, shelfLabel, shelfTagHint, splitOutcome, SPLIT_MIN_PAGES } from '../lib/splitShelves.ts'
import {
  childFields,
  decisionProblems,
  initialDecisions,
  leaderOf,
  parentFields,
  planRequest,
  promotedGroups,
  splitDecisionReducer,
  type SplitDecisionState,
  type ShelfChoice,
} from '../lib/splitDecisions.ts'
import { bucketLabel } from '../lib/buckets.ts'
import { useMaintenanceRun } from '../hooks/useMaintenanceRun.ts'
import { clusterHue } from './GraphCanvas.tsx'
import { PageLink, PageLinks } from './PageLink.tsx'
import { Diff } from './Diff.tsx'
import { Tip } from './Tip.tsx'

const pct = (x: number): string => `${Math.round(x * 100)} %`
const tagsText = (tags: readonly string[]): string => tags.join(', ')
const tagsOf = (text: string): string[] => [...new Set(text.split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))]

/** The department domains of a graph by knowledge pages, largest first. */
function departmentSizes(nodes: readonly GraphNode[]): Array<[string, number]> {
  const m = new Map<string, number>()
  for (const n of nodes) {
    if (!isKnowledgeNode(n) || n.domain === null || n.domain === 'meta' || n.domain === 'unassigned') continue
    m.set(n.domain, (m.get(n.domain) ?? 0) + 1)
  }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

export function SplitProposalPanel({
  nodes,
  builtAt,
  vaultName,
  guided = false,
  onApplied,
}: {
  nodes: readonly GraphNode[] | undefined
  /** The graph's build time: the proposal is asked again when the vault changed. */
  builtAt: string | undefined
  vaultName: string
  /** Embedded in the guided maintenance run: a deferred shelf comes back open (6.3, 6.7). */
  guided?: boolean
  /** Told about an applied split, so the guided run can note it in its summary. */
  onApplied?: (result: SplitApplyResult, parent: string) => void
}): React.ReactElement | null {
  const sizes = useMemo(() => departmentSizes(nodes ?? []), [nodes])
  const [picked, setPicked] = useState<string | null>(null)
  // Held here, not in the surface: the apply changes the graph, which remounts the surface for
  // the new proposal, and the summary of what was written must outlive that.
  const [applied, setApplied] = useState<{ result: SplitApplyResult; parent: string } | null>(null)
  // The largest by default, and again whenever the picked one has gone from the vault.
  const domain = picked !== null && sizes.some(([d]) => d === picked) ? picked : (sizes[0]?.[0] ?? null)
  const q = useQuery({
    queryKey: ['domain-split', domain, builtAt],
    queryFn: () => api.domainSplit(domain!),
    enabled: domain !== null,
    staleTime: Infinity,
  })
  if (domain === null) return null
  const p = q.data?.domain === domain ? q.data : undefined

  return (
    <div className="domain-candidates split-proposal">
      <div className="sc-head">
        <h4 className="sc-title">
          Split proposal
          <Tip
            text={`The shelves a domain falls into, from its links alone: a consensus of ${p?.params.runs ?? 40} runs, so the same vault gives the same shelves on every visit. Ranked by how cleanly each stands apart - how few of its links leave it, times how rarely other pages' tags look like its own. Promote, merge, leave or defer each shelf; nothing is written until you apply a preview, and the apply is one git commit that one revert undoes.`}
          />
        </h4>
        <div className="candidate-actions">
          <label className="toggle">
            Domain
            <select value={domain} onChange={(e) => setPicked(e.target.value)} aria-label="Domain to propose a split for">
              {sizes.map(([d, n]) => (
                <option key={d} value={d}>
                  {d} ({n})
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {applied !== null && <AppliedSummary result={applied.result} parent={applied.parent} onDone={() => setApplied(null)} />}
      {q.isError && <div className="toast err">Could not load the proposal: {(q.error as Error).message}</div>}
      {p === undefined ? (
        !q.isError && <p className="empty-inline">Computing the proposal…</p>
      ) : p.shelves.length === 0 ? (
        <p className="tab-hint">{p.reason ?? `No shelves: a domain under ${SPLIT_MIN_PAGES} pages is read whole.`}</p>
      ) : (
        // Keyed by the shelves themselves: a background ingest that leaves them as they were
        // keeps what the user typed, and a proposal that changed starts the decisions afresh.
        <DecisionSurface
          key={`${p.domain}:${p.shelves.map((s) => s.fingerprint).join('|')}`}
          proposal={p}
          nodes={nodes ?? []}
          vaultName={vaultName}
          guided={guided}
          onApplied={(result, parent) => {
            setApplied({ result, parent })
            onApplied?.(result, parent)
          }}
        />
      )}
      <AppliedSplits vaultName={vaultName} />
    </div>
  )
}

/* ------------------------------------------------------------------------ the decisions */

function DecisionSurface({
  proposal: p,
  nodes,
  vaultName,
  guided,
  onApplied,
}: {
  proposal: SplitProposal
  nodes: readonly GraphNode[]
  vaultName: string
  guided: boolean
  onApplied: (result: SplitApplyResult, parent: string) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  const readOnly = health.data?.demoMode === true
  const registry = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const registryKeys = useMemo(() => (registry.data?.domains ?? []).map((d) => d.key), [registry.data])
  const current = useMemo(() => {
    const e = registry.data?.domains.find((d) => d.key === p.domain)
    return { description: e?.description ?? '', tags: e?.tags ?? [] }
  }, [registry.data, p.domain])

  const [state, dispatch] = useReducer(splitDecisionReducer, undefined, () => initialDecisions(p, p.decisions, { guided }))
  const groups = promotedGroups(state, p)
  const problems = decisionProblems(state, p, registryKeys)
  const request = planRequest(state, p, current)
  const outcome = splitOutcome(
    p,
    groups.map((g) => g.members),
  )

  // Leave and defer are remembered on the server at once (6.3): the memory is what stops the
  // next proposal asking again, and it must not depend on an apply that may never come.
  const remember = useMutation({
    mutationFn: ({ fingerprint, decision }: { fingerprint: string; decision: ShelfDecision | null }) =>
      decision === null ? api.domainSplitRestore(p.domain, fingerprint) : api.domainSplitDecide(p.domain, fingerprint, decision),
  })
  const choose = (shelf: SplitShelf, choice: ShelfChoice): void => {
    const was = state.choice[shelf.id]
    dispatch({ type: 'choose', id: shelf.id, choice })
    if (choice === 'leave' || choice === 'defer') remember.mutate({ fingerprint: shelf.fingerprint, decision: choice })
    else if (was === 'leave' || was === 'defer') remember.mutate({ fingerprint: shelf.fingerprint, decision: null })
  }

  const naming = useMaintenanceRun(() =>
    api.domainSplitNaming(
      p.domain,
      groups.map((g) => g.members),
    ),
  )
  const namedFor = useRef<number[]>([])
  useEffect(() => {
    const n = naming.result?.splitNaming
    if (n !== undefined) dispatch({ type: 'named', naming: n, leaders: namedFor.current })
  }, [naming.result])

  const plan = useMutation({ mutationFn: () => api.domainSplitPlan(p.domain, request!) })
  const [confirming, setConfirming] = useState(false)
  const apply = useMutation({
    mutationFn: () => api.domainSplitApply(p.domain, request!),
    onSuccess: (r) => {
      setConfirming(false)
      onApplied(r, p.domain)
      for (const key of [['graph'], ['domains'], ['domain-splits'], ['stats'], ['validation']]) void qc.invalidateQueries({ queryKey: key })
    },
    onError: () => setConfirming(false),
  })
  // A decision changed after the preview: the preview no longer shows what an apply would write.
  const planned = useRef<string>('')
  const requestKey = JSON.stringify(request)
  const planStale = plan.data !== undefined && planned.current !== requestKey

  const shown = p.shelves.filter((s) => state.choice[s.id] !== 'leave')
  const left = p.shelves.filter((s) => state.choice[s.id] === 'leave')
  const canPlan = request !== null && problems.size === 0

  return (
    <>
      <Totals proposal={p} />
      <div className="candidate-list">
        {shown.map((s) => (
          <ShelfCard
            key={s.id}
            shelf={s}
            proposal={p}
            vaultName={vaultName}
            state={state}
            dispatch={dispatch}
            choose={choose}
            nodes={nodes}
            registryKeys={registryKeys}
            problem={problems.get(s.id) ?? null}
            readOnly={readOnly}
          />
        ))}
      </div>
      {left.length > 0 && (
        <p className="tab-hint split-left">
          Left with <code>{p.domain}</code>, not proposed again while it stays as it is:{' '}
          {left.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ', '}
              {shelfLabel(s)} ({s.size}){' '}
              <button className="btn ghost sm" disabled={readOnly} onClick={() => choose(s, 'open')}>
                restore
              </button>
            </span>
          ))}
        </p>
      )}
      {p.unaddressed.length > 0 && (
        <p className="tab-hint">
          {p.unaddressed.length} page{p.unaddressed.length === 1 ? '' : 's'} of this domain carry no <code>address:</code>;
          they can be shown, never moved by a split.
        </p>
      )}

      {groups.length > 0 && (
        <div className="subcard sc-pad split-decision">
          <h4 className="sc-title">What the split would write</h4>
          <p className="tab-hint">
            {groups.length} new domain{groups.length === 1 ? '' : 's'}, {outcome.moved} pages move, <code>{p.domain}</code>{' '}
            keeps {outcome.parentKeeps}
            {outcome.parentKeeps < p.params.shelfMinPages && <strong> - fewer than {p.params.shelfMinPages}, so it would read as a tag</strong>}
            . The largest domain afterwards holds {pct(outcome.largestAfter.share)} of the vault (now {pct(p.totals.largestNow.share)}
            ), and {outcome.crossLinks} of {p.totals.internalLinks} links inside the domain would cross a domain boundary.
          </p>
          <ParentEntry
            proposal={p}
            current={current}
            state={state}
            onEdit={(field, value) => dispatch({ type: 'edit-parent', field, value })}
            readOnly={readOnly}
          />
          <FellowImpact parent={p.domain} keeps={outcome.parentKeeps} enabled={health.data?.fellows === true} />
          <div className="split-actions">
            <button
              className="btn"
              disabled={readOnly || naming.running}
              onClick={() => {
                namedFor.current = groups.map((g) => g.leader)
                naming.start()
              }}
              title={readOnly ? 'This instance is read-only' : 'One read-only agent run drafts keys, descriptions and tags; your own edits stay'}
            >
              {naming.running ? 'Drafting names…' : 'Draft names with an agent'}
            </button>
            <span className="dim">optional, read-only, about $0.40</span>
            <span className="spacer" />
            <button
              className="btn"
              disabled={readOnly || !canPlan || plan.isPending}
              onClick={() => {
                planned.current = requestKey
                plan.mutate()
              }}
              title={readOnly ? 'This instance is read-only' : !canPlan ? 'Every new domain needs a valid key and a description first' : 'Show what the apply would write - writes nothing'}
            >
              {plan.isPending ? 'Planning…' : 'Preview'}
            </button>
            <button
              className={`btn primary${confirming ? ' danger' : ''}`}
              disabled={readOnly || plan.data === undefined || planStale || plan.data.counts.ok === 0 || apply.isPending}
              onClick={() => (confirming ? apply.mutate() : setConfirming(true))}
              title={readOnly ? 'This instance is read-only' : planStale || plan.data === undefined ? 'Preview first' : 'One commit; one revert undoes it'}
            >
              {apply.isPending
                ? 'Writing…'
                : confirming
                  ? `Confirm: write ${plan.data?.counts.ok ?? 0} pages in one commit`
                  : 'Apply'}
            </button>
            {confirming && (
              <button className="btn ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            )}
          </div>
          {readOnly && <p className="dim">This instance is read-only: the decisions can be read and not applied.</p>}
          {naming.error !== null && <div className="toast err">The naming pass failed: {naming.error}</div>}
          {naming.result !== undefined && naming.result.splitNaming === undefined && (
            <div className="toast err">The naming pass answered in a shape the dashboard could not read; the drafts stay.</div>
          )}
          {plan.isError && <div className="toast err">{(plan.error as Error).message}</div>}
          {apply.isError && <div className="toast err">{(apply.error as Error).message}</div>}
          {plan.data !== undefined && !planStale && <PlanView plan={plan.data} vaultName={vaultName} />}
          {planStale && <p className="tab-hint">A decision changed since the preview - preview again before applying.</p>}
        </div>
      )}
    </>
  )
}

/** The whole proposal, and what promoting every shelf would do. */
function Totals({ proposal: p }: { proposal: SplitProposal }): React.ReactElement {
  const all = splitOutcome(
    p,
    p.shelves.map((s) => [s.id]),
  )
  return (
    <p className="tab-hint">
      <strong>{p.shelves.length} shelves</strong> over {p.pages} pages; {p.totals.withParent} stay with{' '}
      <code>{p.domain}</code> because no stable group of {p.params.shelfMinPages} takes them. Promoting all:{' '}
      {all.moved} pages move, the largest domain goes from {pct(p.totals.largestNow.share)} to{' '}
      {pct(all.largestAfter.share)} of the vault, and {all.crossLinks} of {p.totals.internalLinks} links inside the
      domain would cross a domain boundary.
    </p>
  )
}

const CHOICES: Array<[ShelfChoice, string, string]> = [
  ['promote', 'Promote', 'Becomes a domain of its own'],
  ['leave', 'Leave', 'Stays with the parent, and is not proposed again while it stays as it is'],
  ['defer', 'Defer', 'Not now: it comes back at the next maintenance run'],
]

function ShelfCard({
  shelf: s,
  proposal: p,
  vaultName,
  state,
  dispatch,
  choose,
  nodes,
  registryKeys,
  problem,
  readOnly,
}: {
  shelf: SplitShelf
  proposal: SplitProposal
  vaultName: string
  state: SplitDecisionState
  dispatch: React.Dispatch<Parameters<typeof splitDecisionReducer>[1]>
  choose: (shelf: SplitShelf, choice: ShelfChoice) => void
  nodes: readonly GraphNode[]
  registryKeys: readonly string[]
  problem: string | null
  readOnly: boolean
}): React.ReactElement {
  const types = Object.entries(s.types)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${bucketLabel(t).toLowerCase()}`)
    .join(' · ')
  const confused = s.confusedWith.map((c) => (c.with === 'rest' ? `the rest of ${p.domain}` : `shelf ${c.with + 1}`))
  const choice = state.choice[s.id] ?? 'open'
  const leader = leaderOf(state, s.id)
  const follower = leader !== s.id
  const group = promotedGroups(state, p).find((g) => g.leader === s.id)
  const others = p.shelves.filter((o) => o.id !== s.id && state.choice[o.id] !== 'leave' && leaderOf(state, o.id) !== s.id)
  const byId = (id: number): SplitShelf => p.shelves.find((o) => o.id === id)!

  return (
    <div className={`candidate subcard sc-pad split-shelf${s.misfile ? ' misfile' : ''} choice-${follower ? 'merged' : choice}`} data-shelf={s.id}>
      <div className="candidate-head">
        <span className="chip-dot" style={{ background: `hsl(${clusterHue(s.id)} 60% 55%)` }} aria-hidden />
        <strong>{shelfLabel(s)}</strong>
        <span className="candidate-meta">
          {s.size} pages · {types}
        </span>
        {shelfTagHint(s) !== '' && (
          <span className="candidate-meta split-tagged" title="Its most distinctive tags - a hint to what it holds, never its name">
            {shelfTagHint(s)}
          </span>
        )}
        {s.misfile && (
          <span
            className="chip verdict-existing"
            title="Other shelves' pages look like this one by their tags more often than a clear shelf allows: every later ingest on this subject may be filed into a sibling."
          >
            misfiling risk
          </span>
        )}
        {choice === 'defer' && <span className="chip">deferred</span>}
      </div>

      <div className="split-choice" role="group" aria-label={`Decision for ${shelfLabel(s)}`}>
        {follower ? (
          <>
            <span className="candidate-meta">Merged into {shelfLabel(byId(leader))}</span>
            <button className="btn ghost sm" disabled={readOnly} onClick={() => dispatch({ type: 'unmerge', id: s.id })}>
              Un-merge
            </button>
          </>
        ) : (
          <>
            {CHOICES.map(([c, label, why]) => (
              <button
                key={c}
                className={`btn sm${choice === c ? ' primary' : ' ghost'}`}
                aria-pressed={choice === c}
                disabled={readOnly}
                title={why}
                onClick={() => choose(s, choice === c ? 'open' : c)}
              >
                {label}
              </button>
            ))}
            {others.length > 0 && (
              <select
                className="split-merge"
                value=""
                disabled={readOnly}
                aria-label={`Merge ${shelfLabel(s)} with another shelf`}
                onChange={(e) => e.target.value !== '' && dispatch({ type: 'merge', id: s.id, into: Number(e.target.value) })}
              >
                <option value="">Merge with…</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {shelfLabel(o)} ({o.size})
                  </option>
                ))}
              </select>
            )}
          </>
        )}
      </div>

      {group !== undefined && (
        <ChildEditor
          group={group}
          proposal={p}
          state={state}
          dispatch={dispatch}
          nodes={nodes}
          registryKeys={registryKeys}
          problem={problem}
          readOnly={readOnly}
          byId={byId}
        />
      )}

      <p className="candidate-meta split-numbers">
        <span title="The share of its links inside the domain that leave it. Lower is more self-contained.">
          {pct(s.conductance)} of links leave it
        </span>
        {' · '}
        <span title="How reliably the runs put its linked pages together, over its own links.">stability {s.stability.toFixed(2)}</span>
        {' · '}
        <span title="From tags alone, leave one out: how many pages the tags put here really are here (precision), and how many of its own they find (recall).">
          tags: precision {s.precision === null ? '-' : pct(s.precision)}, recall {s.recall === null ? '-' : pct(s.recall)}
        </span>
      </p>
      {s.tags.length > 0 && (
        <p className="tab-hint">
          Distinctive tags: {s.tags.map((t) => `#${t}`).join(', ')}
          {s.topTagCollision !== null && (
            <>
              {' '}
              - <code>{s.topTagCollision.key}</code> would make a poor key: {s.topTagCollision.inside} page
              {s.topTagCollision.inside === 1 ? '' : 's'} here and {s.topTagCollision.elsewhere} elsewhere already carry it as
              a tag.
            </>
          )}
        </p>
      )}
      {confused.length > 0 && <p className="tab-hint">Its tags blur with {confused.join(', ')}.</p>}
      <div className="split-landmarks">
        <span className="candidate-meta">Built around</span>
        {s.landmarks.map((l) => (
          <PageLink key={l.path} path={l.path} vaultName={vaultName} />
        ))}
      </div>
      {s.outsideNeighbours.count > 0 && (
        <p className="tab-hint">
          {s.outsideNeighbours.count} page{s.outsideNeighbours.count === 1 ? '' : 's'} of other domains link into it three
          times or more; a split never moves them.
        </p>
      )}
      <details className="cand-pages">
        <summary>Show {s.size} pages</summary>
        <PageLinks paths={s.pages.map((m) => m.path)} vaultName={vaultName} />
      </details>
    </div>
  )
}

/** The fields of a promoted group: key (checked while typing), description, tags. */
function ChildEditor({
  group,
  proposal: p,
  state,
  dispatch,
  nodes,
  problem,
  readOnly,
  byId,
}: {
  group: { leader: number; members: number[] }
  proposal: SplitProposal
  state: SplitDecisionState
  dispatch: React.Dispatch<Parameters<typeof splitDecisionReducer>[1]>
  nodes: readonly GraphNode[]
  registryKeys: readonly string[]
  problem: string | null
  readOnly: boolean
  byId: (id: number) => SplitShelf
}): React.ReactElement {
  const f = childFields(state, p, group)
  const paths = useMemo(() => new Set(group.members.flatMap((id) => byId(id).pages.map((m) => m.path))), [group.members, byId])
  const collision = keyCollisionOf(nodes, paths, f.key)
  const edit = (field: 'key' | 'description' | 'tags', value: string | string[]): void => dispatch({ type: 'edit', leader: group.leader, field, value })
  const size = group.members.reduce((a, id) => a + byId(id).size, 0)
  return (
    <div className="split-child">
      <p className="tab-hint split-key-hint">
        This shelf becomes a new domain. Its key is its name in the registry and in the{' '}
        <code>domain:</code> field of every page it takes: coin one, or let the agent draft it. A tag the pages already
        carry makes a poor key.
      </p>
      {group.members.length > 1 && (
        <p className="candidate-meta">
          One new domain of {size} pages: {group.members.map((id) => shelfLabel(byId(id))).join(' + ')}
        </p>
      )}
      <label className="split-field">
        <span>Domain key</span>
        <input
          data-field="key"
          value={f.key}
          disabled={readOnly}
          placeholder="coin one - not a tag the pages carry"
          aria-invalid={problem !== null}
          onChange={(e) => edit('key', e.target.value.trim().toLowerCase())}
        />
        {problem !== null ? (
          <span className="field-err">{problem}</span>
        ) : (
          <span className={collision.inside > 0 ? 'field-warn' : 'dim'} data-collision={`${collision.inside},${collision.elsewhere}`}>
            as a tag: {collision.inside} page{collision.inside === 1 ? '' : 's'} here, {collision.elsewhere} elsewhere
            {collision.inside > 0 && ' - each would repeat its own domain in its tags'}
          </span>
        )}
      </label>
      <label className="split-field">
        <span>Description</span>
        <textarea rows={3} data-field="description" value={f.description} disabled={readOnly} onChange={(e) => edit('description', e.target.value)} />
      </label>
      <label className="split-field">
        <span>Tags</span>
        <input data-field="tags" value={tagsText(f.tags)} disabled={readOnly} onChange={(e) => edit('tags', tagsOf(e.target.value))} />
      </label>
    </div>
  )
}

/** The parent's section as it is and as the split would leave it, editable (4.4). */
function ParentEntry({
  proposal: p,
  current,
  state,
  onEdit,
  readOnly,
}: {
  proposal: SplitProposal
  current: { description: string; tags: string[] }
  state: SplitDecisionState
  onEdit: (field: 'description' | 'tags', value: string | string[]) => void
  readOnly: boolean
}): React.ReactElement {
  const next = parentFields(state, p, current)
  const diff = [
    ...(current.description !== next.description ? [`- ${current.description}`, `+ ${next.description}`] : [`  ${current.description}`]),
    ...(tagsText(current.tags) !== tagsText(next.tags) ? [`- tags: ${tagsText(current.tags)}`, `+ tags: ${tagsText(next.tags)}`] : [`  tags: ${tagsText(current.tags)}`]),
  ].join('\n')
  return (
    <div className="split-parent">
      <p className="candidate-meta">
        <code>{p.domain}</code> keeps its key and is narrowed in the same commit, so it no longer claims what left it.
      </p>
      <Diff text={diff} />
      <label className="split-field">
        <span>Description</span>
        <textarea rows={3} data-field="parent-description" value={next.description} disabled={readOnly} onChange={(e) => onEdit('description', e.target.value)} />
      </label>
      <label className="split-field">
        <span>Tags</span>
        <input data-field="parent-tags" value={tagsText(next.tags)} disabled={readOnly} onChange={(e) => onEdit('tags', tagsOf(e.target.value))} />
      </label>
    </div>
  )
}

/**
 * The Fellows whose home domain is the parent (6.8, hard rule 8): asked and rendered only when
 * `health.fellows` is true. A Fellow keeps its home key; the split changes what that key holds.
 */
function FellowImpact({ parent, keeps, enabled }: { parent: string; keeps: number; enabled: boolean }): React.ReactElement | null {
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, enabled })
  if (!enabled) return null
  const homed = (agents.data?.fellows ?? []).map((f) => f.agent).filter((a) => a.homeDomain === parent && a.retiredAt === null)
  if (homed.length === 0) return null
  return (
    <p className="tab-hint split-fellows">
      {homed.map((a) => a.name).join(', ')} {homed.length === 1 ? 'keeps' : 'keep'} <code>{parent}</code> as home domain,
      which would then hold {keeps} pages. A Fellow follows a new domain only if you change its home.
    </p>
  )
}

const SKIP_TEXT: Record<string, string> = {
  moved: 'no longer in the parent',
  gone: 'no page carries its address any more',
  unaddressed: 'carries no address, never moved',
  busy: 'being written right now',
}

/** The preview (6.4): the registry diff, the pages per child, what is skipped, the warnings. */
function PlanView({ plan, vaultName }: { plan: SplitPlan; vaultName: string }): React.ReactElement {
  const perChild = new Map<string, number>()
  for (const pg of plan.pages) if (pg.verdict === 'ok') perChild.set(pg.child, (perChild.get(pg.child) ?? 0) + 1)
  const skipped = plan.pages.filter((pg) => pg.verdict !== 'ok')
  return (
    <div className="split-plan">
      <p className="tab-hint">
        {plan.counts.ok} page{plan.counts.ok === 1 ? '' : 's'} would move:{' '}
        {[...perChild].map(([k, n]) => `${n} to ${k}`).join(', ')}. One commit with the registry, <code>wiki/index.md</code> and
        those pages; each page changes its <code>domain:</code> and <code>updated:</code> lines and nothing else. The write
        takes the vault's own lock page by page, so a few hundred pages take about a minute.
      </p>
      {plan.warnings.map((w, i) => (
        <p key={i} className="field-warn">
          {w.kind === 'parent-small'
            ? `The parent keeps ${w.keeps} pages, fewer than ${w.min}.`
            : w.kind === 'key-collision'
              ? `${w.key} is a tag on ${w.inside} page(s) of the new domain and ${w.elsewhere} elsewhere.`
              : `${w.key} is built from a shelf with a misfiling risk: its description has to draw the line to its siblings.`}
        </p>
      ))}
      {skipped.length > 0 && (
        <details className="cand-pages">
          <summary>{skipped.length} page(s) skipped</summary>
          {skipped.map((pg) => (
            <div key={`${pg.address}:${pg.path}`} className="split-skip">
              <PageLink path={pg.path} vaultName={vaultName} /> <span className="dim">{SKIP_TEXT[pg.verdict]}</span>
            </div>
          ))}
        </details>
      )}
      <details className="cand-pages" open>
        <summary>The registry</summary>
        <Diff text={plan.registry.diff} max={120} />
      </details>
      <p className="candidate-meta">
        The index afterwards: {plan.index.map((h) => `${h.domain} ${h.pages}`).join(' · ')}
      </p>
    </div>
  )
}

function AppliedSummary({ result, parent, onDone }: { result: SplitApplyResult; parent: string; onDone: () => void }): React.ReactElement {
  const busy = result.skipped.filter((s) => s.reason === 'busy').length
  return (
    <div className="subcard sc-pad split-applied">
      <div className="toast ok">
        Split <code>{parent}</code>: {result.written.length} pages in commit {result.commit.slice(0, 8)}.
      </div>
      {result.skipped.length > 0 && (
        <p className="tab-hint">
          {result.skipped.length} page(s) skipped
          {busy > 0 && `, ${busy} of them busy - they are the remainder below and can be re-filed once free`}.
        </p>
      )}
      {!result.verified && <p className="field-err">{result.unverified.length} page(s) did not read back with their new key.</p>}
      <button className="btn" onClick={onDone}>
        Done
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------- the applied splits */

/** Applied splits (6.5), each with its commits, its live remainder, the re-file and the revert. */
function AppliedSplits({ vaultName }: { vaultName: string }): React.ReactElement | null {
  const q = useQuery({ queryKey: ['domain-splits'], queryFn: api.domainSplits })
  const splits = q.data?.splits ?? []
  if (splits.length === 0) return null
  return (
    <div className="split-history">
      <h4 className="sc-title">Applied splits</h4>
      {splits.map((s) => (
        <AppliedSplitRow key={s.id} split={s} vaultName={vaultName} />
      ))}
    </div>
  )
}

function AppliedSplitRow({ split: s, vaultName }: { split: SplitSummary; vaultName: string }): React.ReactElement {
  const qc = useQueryClient()
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  const readOnly = health.data?.demoMode === true
  const [armed, setArmed] = useState<'remainder' | 'revert' | null>(null)
  const refresh = (): void => {
    for (const key of [['domain-splits'], ['graph'], ['domains'], ['stats']]) void qc.invalidateQueries({ queryKey: key })
  }
  const remainder = useMutation({ mutationFn: () => api.domainSplitRemainder(s.id), onSettled: () => (setArmed(null), refresh()) })
  const revert = useMutation({ mutationFn: () => api.domainSplitRevert(s.id), onSettled: () => (setArmed(null), refresh()) })
  const orphans = (revert.error instanceof ApiError ? (revert.error.body?.['pages'] as string[] | undefined) : undefined) ?? []
  const reverted = s.revertedAt !== null
  return (
    <div className={`subcard sc-pad split-row${reverted ? ' reverted' : ''}`} data-split={s.id}>
      <div className="candidate-head">
        <code>{s.parent}</code> → {s.children.map((c) => c.key).join(', ')}
        <span className="candidate-meta">
          {new Date(s.createdAt).toLocaleDateString()} · {s.commits.map((c) => c.slice(0, 8)).join(', ')}
          {reverted && ` · reverted ${new Date(s.revertedAt!).toLocaleDateString()}`}
        </span>
      </div>
      {!reverted && (
        <div className="split-actions">
          <span className="candidate-meta">
            Remainder: {s.remainder} page{s.remainder === 1 ? '' : 's'} still in <code>{s.parent}</code>
          </span>
          <span className="spacer" />
          <button
            className={`btn sm${armed === 'remainder' ? ' danger' : ''}`}
            disabled={readOnly || s.remainder === 0 || remainder.isPending}
            onClick={() => (armed === 'remainder' ? remainder.mutate() : setArmed('remainder'))}
            title={readOnly ? 'This instance is read-only' : 'Re-file the pages that did not move, one commit'}
          >
            {remainder.isPending ? 'Writing…' : armed === 'remainder' ? `Confirm: re-file ${s.remainder}` : 'Re-file the remainder'}
          </button>
          <button
            className={`btn ghost sm${armed === 'revert' ? ' danger' : ''}`}
            disabled={readOnly || revert.isPending}
            onClick={() => (armed === 'revert' ? revert.mutate() : setArmed('revert'))}
            title={readOnly ? 'This instance is read-only' : "Revert the split's commits, newest first"}
          >
            {revert.isPending ? 'Reverting…' : armed === 'revert' ? 'Confirm: revert the split' : 'Revert'}
          </button>
          {armed !== null && (
            <button className="btn ghost sm" onClick={() => setArmed(null)}>
              Cancel
            </button>
          )}
        </div>
      )}
      {remainder.isError && <div className="toast err">{(remainder.error as Error).message}</div>}
      {remainder.data !== undefined && (
        <div className="toast ok">
          Re-filed {remainder.data.written.length} page(s) in commit {remainder.data.commit.slice(0, 8)}.
        </div>
      )}
      {revert.isError && (
        <div className="toast err">
          {(revert.error as Error).message}
          {orphans.length > 0 && <PageLinks paths={orphans} vaultName={vaultName} />}
        </div>
      )}
      {revert.data !== undefined && <div className="toast ok">Reverted {revert.data.commits.length} commit(s).</div>}
    </div>
  )
}
