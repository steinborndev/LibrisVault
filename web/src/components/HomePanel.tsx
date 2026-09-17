/**
 * The ranked domain list in Home's band (2026-08-27; on its own since 2026-09-11).
 *
 * It used to be one of three views behind a switcher - Domains, This week, Gaps. The band
 * carries no switcher any more: the week is a door in the hero's growth line (the stream on
 * this week), the gaps are a door in the hero's gap line (the graph's gaps view, which also
 * took over the unlink picker - see GapCleanup.tsx). What is left is the one view that says
 * something the picture beside it cannot: what the vault is about, by weight.
 */

import { domainColor } from '../lib/domains.ts'
import { domainCounts } from '../lib/homePanels.ts'
import type { GraphNode } from '../api/types.ts'

export function DomainRanks({
  nodes,
  onOpenDomain,
}: {
  nodes: readonly GraphNode[]
  /** The domain's shelf in the Library (or the catalog filtered to it) - a bar you click is a question about that domain. */
  onOpenDomain: (domain: string) => void
}): React.ReactElement {
  const { domains } = domainCounts(nodes)
  if (domains.length === 0) return <div className="empty">No page carries a domain yet.</div>
  const max = domains[0]!.pages
  return (
    <div className="ranklist">
      {domains.map((d) => (
        <button
          key={d.domain}
          className="rank"
          onClick={() => onOpenDomain(d.domain)}
          title={`Open the ${d.domain} shelf: ${d.pages} pages`}
        >
          <span className="lab">
            <span className="dot" style={{ background: domainColor(d.domain) }} aria-hidden />
            <span className="nm">{d.domain}</span>
          </span>
          <span className="barrow">
            <span className="track">
              <i style={{ width: `${(d.pages / max) * 100}%`, background: domainColor(d.domain) }} />
            </span>
            <span className="n">{d.pages}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
