/**
 * The split proposal, in System's Domains card (docs/tasks/TASKS-DOMAIN-SPLIT.md 3.4): which
 * shelves a domain falls into, ranked by how cleanly each stands apart, with the evidence a
 * person needs to judge it. READ-ONLY in milestone A: no control here writes anything; the
 * decision surface that promotes, merges, leaves or defers a shelf arrives with milestone B and
 * will reuse this panel and `splitShelves.ts` rather than grow a second one.
 *
 * Base product (hard rule 8): it asks the split route and the graph, nothing a Fellow owns.
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { GraphNode, SplitProposal, SplitShelf } from '../api/types.ts'
import { isKnowledgeNode } from '../lib/knowledge.ts'
import { shelfLabel, splitOutcome, SPLIT_MIN_PAGES } from '../lib/splitShelves.ts'
import { bucketLabel } from '../lib/buckets.ts'
import { clusterHue } from './GraphCanvas.tsx'
import { PageLink, PageLinks } from './PageLink.tsx'
import { Tip } from './Tip.tsx'

const pct = (x: number): string => `${Math.round(x * 100)} %`

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
}: {
  nodes: readonly GraphNode[] | undefined
  /** The graph's build time: the proposal is asked again when the vault changed. */
  builtAt: string | undefined
  vaultName: string
}): React.ReactElement | null {
  const sizes = useMemo(() => departmentSizes(nodes ?? []), [nodes])
  const [picked, setPicked] = useState<string | null>(null)
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
            text={`The shelves a domain falls into, from its links alone: a consensus of ${p?.params.runs ?? 40} runs, so the same vault gives the same shelves on every visit. Ranked by how cleanly each stands apart - how few of its links leave it, times how rarely other pages' tags look like its own. Nothing is written; the Graph's Shelves overlay draws the same shelves.`}
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

      {q.isError && <div className="toast err">Could not load the proposal: {(q.error as Error).message}</div>}
      {p === undefined ? (
        !q.isError && <p className="empty-inline">Computing the proposal…</p>
      ) : p.shelves.length === 0 ? (
        <p className="tab-hint">{p.reason ?? `No shelves: a domain under ${SPLIT_MIN_PAGES} pages is read whole.`}</p>
      ) : (
        <>
          <Totals proposal={p} />
          <div className="candidate-list">
            {p.shelves.map((s) => (
              <ShelfCard key={s.id} shelf={s} proposal={p} vaultName={vaultName} />
            ))}
          </div>
          {p.unaddressed.length > 0 && (
            <p className="tab-hint">
              {p.unaddressed.length} page{p.unaddressed.length === 1 ? '' : 's'} of this domain carry no{' '}
              <code>address:</code>; they can be shown, never moved by a split.
            </p>
          )}
        </>
      )}
    </div>
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

function ShelfCard({ shelf: s, proposal: p, vaultName }: { shelf: SplitShelf; proposal: SplitProposal; vaultName: string }): React.ReactElement {
  const types = Object.entries(s.types)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${bucketLabel(t).toLowerCase()}`)
    .join(' · ')
  const confused = s.confusedWith.map((c) => (c.with === 'rest' ? `the rest of ${p.domain}` : `shelf ${c.with + 1}`))
  return (
    <div className={`candidate subcard sc-pad split-shelf${s.misfile ? ' misfile' : ''}`}>
      <div className="candidate-head">
        <span className="chip-dot" style={{ background: `hsl(${clusterHue(s.id)} 60% 55%)` }} aria-hidden />
        <strong>{shelfLabel(s)}</strong>
        <span className="candidate-meta">
          {s.size} pages · {types}
        </span>
        {s.misfile && (
          <span
            className="chip verdict-existing"
            title="Other shelves' pages look like this one by their tags more often than a clear shelf allows: every later ingest on this subject may be filed into a sibling."
          >
            misfiling risk
          </span>
        )}
      </div>
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
              - as a key, <code>{s.topTagCollision.key}</code> is carried by {s.topTagCollision.inside} page
              {s.topTagCollision.inside === 1 ? '' : 's'} here and {s.topTagCollision.elsewhere} elsewhere, so a key is
              coined rather than copied.
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
