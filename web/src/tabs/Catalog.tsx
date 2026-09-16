/**
 * Catalog - the browse path the vault never had (redesign 2026-08; renamed from Library when
 * the Library screen of docs/agents/SPEC.md section 10 took the name). A filterable, sortable
 * table over every page, fed by the same `['graph']` query the canvas uses (no new
 * endpoint). The graph stays the spatial view; this is the retrieval view: find by type,
 * domain, recency - and surface health problems (orphans, stubs) as filters instead of
 * leaving them to a lucky node click.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { navigate, pageRoute, catalogPageRoute } from '../lib/router.ts'
import { CatalogArticle } from '../components/CatalogArticle.tsx'
import { FootKeys } from '../components/FootKeys.tsx'
import { openableRow } from '../lib/tableRow.ts'
import { timeAgo } from '../lib/format.ts'
import { obsidianUri } from '../lib/obsidian.ts'
import { domainColor, STUB_BYTES } from '../lib/domains.ts'
import { DeepenDialog } from '../components/library/DeepenDialog.tsx'
import { addressLink, sourceLink } from '../lib/sources.ts'
import { CATALOG_SORTS, naturalDir, sortCatalog, type CatalogSortKey, type SortDir } from '../lib/catalogSort.ts'
import { SOURCE_FILTERS, hasSource, matchesSources, sourceCounts, sourceSummary } from '../lib/catalogSourceFilter.ts'
import { Icon } from '../components/Icon.tsx'
import { DomainSection } from '../components/DomainSection.tsx'
import { ScopeMid } from '../components/ScopeMid.tsx'
import { scopeHeading } from '../lib/scopeHeading.ts'
import { wingGroups, wingOf } from '../lib/wings.ts'
import { useWingMode } from '../hooks/useWingMode.ts'
import { queryState } from '../components/QueryState.tsx'
import type { GraphNode, SourceRef } from '../api/types.ts'

/** Bucket display labels, shared vocabulary with the graph's type filter. */
const BUCKET_LABELS: Record<string, string> = {
  concepts: 'Concepts',
  entities: 'Entities',
  sources: 'Sources',
  meta: 'Meta',
  root: 'Root',
  // Renamed 2026-09-16: the bucket keeps its key `questions` - the vault's folder, the
  // frontmatter, every route and filter are unchanged - and only what a reader sees moves.
  questions: 'Research',
  references: 'References',
  comparisons: 'Comparisons',
  folds: 'Folds',
}
const bucketLabel = (type: string): string => BUCKET_LABELS[type] ?? type

/**
 * The four subsets of the page index, as ONE choice. System used to be a separate
 * toggle sitting apart from the three it belongs with - but it is a subset like the
 * others, not a second axis, so the other three now never show system pages.
 */
type Subset = 'all' | 'sourced' | 'orphans' | 'stubs' | 'system'

const SUBSETS: Array<{ key: Subset; label: string; desc: string }> = [
  { key: 'all', label: 'All pages', desc: 'every page except the system ones' },
  /*
   * The pages something stands behind. Measured over this vault, 150 of 1,095 knowledge pages
   * have neither a document nor an address: a maintenance run wrote them out of what the other
   * pages already said. This hides exactly those, and it is one CHOICE among the subsets rather
   * than a toggle of its own, because that is what this section is. Narrowing to particular
   * kinds is the Source types section below.
   */
  { key: 'sourced', label: 'With source', desc: 'pages with a document or an address' },
  { key: 'orphans', label: 'Orphans', desc: 'nothing links to these' },
  { key: 'stubs', label: 'Stubs', desc: 'thin pages, under 1 KB' },
  { key: 'system', label: 'System', desc: 'index hubs, MOCs, reports' },
]


function isOrphan(n: GraphNode): boolean {
  return n.in === 0 && n.out === 0 && (n.kind ?? 'knowledge') === 'knowledge'
}
function isStub(n: GraphNode): boolean {
  return (n.size ?? Infinity) < STUB_BYTES && (n.kind ?? 'knowledge') === 'knowledge'
}

export function Catalog({
  vaultName,
  domainParam = '',
  active = true,
  openPage = null,
}: {
  vaultName: string
  /**
   * `?domain=` from Home's domain bars: list this domain. A one-shot COMMAND, not view
   * state - see the effect below, which consumes it the way the graph consumes `?gaps=1`.
   */
  domainParam?: string
  /** Whether this is the screen in front; the domain section's keys listen only then. */
  active?: boolean
  /** The page the tab is reading (`/catalog/page/<path>`), or null for the list. */
  openPage?: string | null
}): React.ReactElement {
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  // Provenance rides its OWN query, not the graph payload: the canvas, Home and the Library
  // all fetch ['graph'], and only one of them has a Source column. A failure here costs the
  // column, never the table.
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources })
  const refs = sources.data?.pages

  const [query, setQuery] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [domain, setDomain] = useState<string | null | 'none'>(null)
  /** The deepening dialog for the domain currently filtered (docs/agents/ideas.md, 2026-09-07). */
  const [deepening, setDeepening] = useState(false)
  const [subset, setSubset] = useState<Subset>('all')
  /** The source types on show, ORed; empty is not a filter but "whatever it came from". */
  const [kinds, setKinds] = useState<ReadonlySet<string>>(() => new Set())
  const [sort, setSort] = useState<CatalogSortKey>('changed')
  /** Which way, per column: a first click gives the natural direction, a second reverses it. */
  const [dir, setDir] = useState<SortDir>(naturalDir('changed'))
  /** Hover previews an option's meaning; leaving falls back to the one in force. */
  const [subsetHover, setSubsetHover] = useState<Subset | null>(null)
  const [sortHover, setSortHover] = useState<CatalogSortKey | null>(null)
  const [kindHover, setKindHover] = useState<string | null>(null)
  const domListRef = useRef<HTMLDivElement>(null)

  /**
   * "Show me this domain", from Home's domain bars. The other narrowing filters are cleared
   * with it: they are whatever this screen was last left at, and a leftover type or search
   * would silently answer a different question than the one the bar was clicked to ask.
   *
   * The param is consumed and dropped from the URL right away, the same one-shot the graph
   * makes of `?gaps=1` and for the same two reasons: the screens stay mounted behind
   * [hidden], so seeding state would only fire on the app's first visit here - and without
   * dropping it, clicking the SAME domain again would pass an identical path string, this
   * effect would not re-run, and the click would do nothing.
   */
  useEffect(() => {
    if (domainParam === '') return
    setDomain(domainParam)
    setQuery('')
    setType(null)
    setSubset('all')
    setKinds(new Set())
    navigate('/catalog', { replace: true })
    // The list is longer than the panel: a filter set from another screen must be visible
    // as a filter, not just as a shorter table.
    requestAnimationFrame(() => {
      domListRef.current?.querySelector('.domrow.active')?.scrollIntoView({ block: 'nearest' })
    })
  }, [domainParam])

  const nodes = graph.data?.nodes

  // Reading a page: Escape returns to the list, from anywhere on the screen but a field.
  useEffect(() => {
    if (!active || openPage === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
      e.preventDefault()
      navigate('/catalog')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, openPage])

  /*
   * Up and down walk the table's rows (2026-09-11), the Research ledger's mechanic: the rows
   * are already the focusable, Enter-openable things (lib/tableRow.ts), so this only moves
   * focus between them - no cursor state of its own, and Enter keeps meaning what it meant.
   * From anywhere on the screen the first press lands on the first (or last) row; the walk
   * wraps at both ends. Scoped to this screen's own table: the Library's shelf window draws
   * the same table, mounted and hidden, and must not be walked from here.
   */
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active || openPage !== null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
      const rows = Array.from(rootRef.current?.querySelectorAll<HTMLTableRowElement>('.lib-table tbody tr[tabindex="0"]') ?? [])
      if (rows.length === 0) return
      e.preventDefault()
      const at = rows.indexOf(document.activeElement as HTMLTableRowElement)
      const next = at === -1 ? (e.key === 'ArrowDown' ? 0 : rows.length - 1) : (at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length
      rows[next]!.focus()
      rows[next]!.scrollIntoView({ block: 'nearest' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, openPage])

  // System pages (index hubs, reports) are scaffolding - hidden unless asked for, same
  // default the graph uses.
  const knowledge = useMemo(
    () => (nodes ?? []).filter((n) => (subset === 'system' ? (n.kind ?? 'knowledge') !== 'knowledge' : (n.kind ?? 'knowledge') === 'knowledge')),
    [nodes, subset],
  )

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of knowledge) m.set(n.type, (m.get(n.type) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [knowledge])

  const domainCounts = useMemo(() => {
    const m = new Map<string, number>()
    let none = 0
    for (const n of knowledge) {
      if (n.domain === null) none++
      else m.set(n.domain, (m.get(n.domain) ?? 0) + 1)
    }
    return { domains: [...m.entries()].sort((a, b) => b[1] - a[1]), none }
  }, [knowledge])

  /**
   * What each source pill would show. Counted over the same pool the type chips count over, so
   * the figures do not move while another filter narrows the table.
   */
  const kindCounts = useMemo(() => sourceCounts(knowledge, refs), [knowledge, refs])

  /** The flat list's order: alphabetical, the no-domain bucket (key '') last. */
  const domainRows = useMemo(
    () =>
      [...domainCounts.domains.map(([d, c]) => [d, c] as const), ...(domainCounts.none > 0 ? [['', domainCounts.none] as const] : [])].sort(([a], [b]) =>
        a === '' ? 1 : b === '' ? -1 : a.localeCompare(b),
      ),
    [domainCounts],
  )
  /*
   * The Library's rooms, for the domain section's wing mode: the same placement the
   * Library draws. Without the Library (agents off) there is no scene and no wing mode.
   */
  /*
   * Asked only when the extension is wired. The route exists only then, so without this the
   * base product issues a request per mount that can only 404 - `retry: false` kept it to one
   * apiece, which is a quieter version of the same thing rather than an answer to it. The
   * acceptance of the merge milestone is that the flag off changes NOTHING, network included
   * (docs/tasks/TASKS-A6.md 1).
   */
  const fellowsOn = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 }).data?.fellows === true
  const sceneQ = useQuery({ queryKey: ['library-scene'], queryFn: api.libraryScene, staleTime: 60_000, retry: false, enabled: fellowsOn })
  const wings = useMemo(() => wingGroups(sceneQ.data, domainRows.map(([d]) => d)), [sceneQ.data, domainRows])
  /** The wing on show (by wing is the default, remembered per screen), or null for the flat list; the wing narrows the table. */
  const wingMode = useWingMode('vault.domainMode.catalog', wings)
  const wing = wingMode.wing
  const wingScope = useMemo(() => (wing === null ? null : new Set(wings.find((g) => g.id === wing)?.domains ?? [])), [wing, wings])
  /** Turning the page drops a pick outside it: the room is the filter now. */
  const pickWing = useCallback(
    (id: string): void => {
      wingMode.setWing(id)
      const inside = new Set(wings.find((g) => g.id === id)?.domains ?? [])
      setDomain((d) => (d === null || inside.has(d === 'none' ? '' : d) ? d : null))
    },
    [wings, wingMode],
  )
  // A domain picked elsewhere (Home's bars) lands in its own room: when the room on show
  // does not hold it, the page turns there, so the row is there to see.
  useEffect(() => {
    if (wing === null || domain === null) return
    const key = domain === 'none' ? '' : domain
    if (wings.find((g) => g.id === wing)?.domains.includes(key)) return
    const target = wingOf(wings, key)
    if (target !== undefined) wingMode.setWing(target)
  }, [domain, wing, wings, wingMode])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const terms = q === '' ? [] : q.split(/\s+/)
    const list = knowledge.filter((n) => {
      if (type !== null && n.type !== type) return false
      if (domain === 'none' && n.domain !== null) return false
      if (domain !== null && domain !== 'none' && n.domain !== domain) return false
      // The wing on show narrows the table until one of its domains is picked.
      if (domain === null && wingScope !== null && !wingScope.has(n.domain ?? '')) return false
      if (subset === 'orphans' && !isOrphan(n)) return false
      if (subset === 'stubs' && !isStub(n)) return false
      if (subset === 'sourced' && !hasSource(n, refs)) return false
      if (!matchesSources(n, refs, kinds)) return false
      if (terms.length > 0) {
        // `names` carries the page's own title and aliases where they differ from the file
        // name - the same reason the graph search reads them.
        const hay = `${n.title} ${(n.names ?? []).join(' ')} ${n.tags.join(' ')} ${n.domain ?? ''}`.toLowerCase()
        if (!terms.every((t) => hay.includes(t))) return false
      }
      return true
    })
    /*
     * Filtered only. The ORDER is the table's, from the state this screen owns and its headings
     * set (lib/catalogSort.ts) - a sidebar pill and a column heading are the same choice, and
     * sorting here as well would be a second implementation of it.
     */
    return list
  }, [knowledge, query, type, domain, wingScope, subset, refs, kinds])

  /*
   * Every match, in one list. It was paged in 50s and grew as you reached the bottom, which
   * meant the scrollbar shrank each time you got near the end - the one part of a window a
   * reader uses to judge how much is left, contradicting itself on every scroll. A few
   * thousand rows of plain markup cost less than that confusion.
   */
  const shown = filtered

  const state = queryState(graph, 'the page index')
  // Deliberately NOT an early return any more: the panel and the table box stay on screen
  // while the index loads or fails, so a retry does not make the whole workspace jump.
  // Only the table's own area changes.

  /** Whether anything is narrowing the list - the reset only appears when it would do something. */
  const dirty =
    query !== '' ||
    type !== null ||
    domain !== null ||
    subset !== 'all' ||
    kinds.size > 0 ||
    sort !== 'changed' ||
    dir !== naturalDir('changed')
  /*
   * What the head says: the count against the pool a type narrows to ("4 of 529 concepts")
   * on the left, and the domain in the middle, the way the graph's bar says it (2026-09-11;
   * the narrowing used to trail the count in words). The chips say the rest.
   */
  const pool = type === null ? knowledge : knowledge.filter((n) => n.type === type)
  const noun = type === null ? 'pages' : bucketLabel(type).toLowerCase()
  const scopeMid = scopeHeading(
    new Set(domain === null ? [] : [domain === 'none' ? '' : domain]),
    wing === null ? null : (wings.find((g) => g.id === wing)?.name ?? 'one wing'),
  )
  const subsetHint = SUBSETS.find((x) => x.key === (subsetHover ?? subset))!.desc
  const sortHint = CATALOG_SORTS.find((x) => x.key === (sortHover ?? sort))!.desc
  /*
   * The pills a vault actually has, plus any that are selected: a selection whose pill went
   * away with the last subset change would keep narrowing the table with nothing on screen to
   * say so, and nothing to click to undo it.
   */
  const kindPills = SOURCE_FILTERS.filter((f) => (kindCounts.get(f.key) ?? 0) > 0 || kinds.has(f.key))
  const kindHint = kindHover !== null ? (SOURCE_FILTERS.find((f) => f.key === kindHover)?.desc ?? '') : sourceSummary(kinds)
  const toggleKind = (key: string): void => {
    setKinds((cur) => {
      const next = new Set(cur)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }
  /** Choose a column, or reverse it when it is already the one - from a pill or from a heading. */
  const chooseSort = (key: CatalogSortKey, next?: SortDir): void => {
    setDir(next ?? (key === sort ? (dir === 'asc' ? 'desc' : 'asc') : naturalDir(key)))
    setSort(key)
  }
  const reset = (): void => {
    setQuery('')
    setType(null)
    setDomain(null)
    setSubset('all')
    setKinds(new Set())
    setSort('changed')
    setDir(naturalDir('changed'))
  }

  return (
    <div className="workspace" ref={rootRef}>
      {/* The same standing panel as the graph, and the ONLY chrome this screen has
          (2026-08-26): the bar that used to sit above both columns held a search box and a
          sentence restating what the panel and the table foot already say, so the screen
          started one row lower than the graph and switching between them jumped. The
          search moved in here, at the top, above what it narrows.

          Order follows how the list is read: find it, then say what kind of page it is,
          which subset and in what order - and domains last, because that is the section
          that grows with the vault and it takes the leftover height. */}
      <aside className="gpanel" aria-label="Library filters">

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Type</span>
            <span className="spacer" />
            <span className="gp-state">{type === null ? 'all' : bucketLabel(type)}</span>
          </div>
          <div className="typechips">
            {/* "All" is a chip like the others rather than the absence of a choice - the
                selected state was invisible while every type chip sat unselected. */}
            <button
              className={`chip${type === null ? ' active' : ''}`}
              aria-pressed={type === null}
              onClick={() => setType(null)}
            >
              All <span className="chip-n">{knowledge.length}</span>
            </button>
            {typeCounts.map(([t, count]) => {
              const active = type === t
              return (
                <button
                  key={t}
                  className={`chip${active ? ' active' : ''}${type !== null && !active ? ' dimmed' : ''}`}
                  aria-pressed={active}
                  onClick={() => setType(active ? null : t)}
                >
                  {bucketLabel(t)} <span className="chip-n">{count}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Show</span>
          </div>
          <div className="pillrow" role="radiogroup" aria-label="Subset">
            {SUBSETS.map((x) => (
              <button
                key={x.key}
                className="viewpill"
                role="radio"
                aria-checked={subset === x.key}
                onClick={() => {
                  setSubset(x.key)
                }}
                onMouseEnter={() => setSubsetHover(x.key)}
                onMouseLeave={() => setSubsetHover(null)}
                onFocus={() => setSubsetHover(x.key)}
                onBlur={() => setSubsetHover(null)}
              >
                {x.label}
              </button>
            ))}
          </div>
          <div className="pillhint">{subsetHint}</div>
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Sort by</span>
          </div>
          <div className="pillrow" role="radiogroup" aria-label="Sort by">
            {CATALOG_SORTS.map((x) => (
              <button
                key={x.key}
                className="viewpill"
                role="radio"
                aria-checked={sort === x.key}
                /* The same rule as a column heading: choose it, or reverse it when it already
                   sorts. One behaviour, so neither place has to be learned separately. */
                onClick={() => chooseSort(x.key)}
                title={sort === x.key ? `${x.desc} - click again to reverse` : x.desc}
                onMouseEnter={() => setSortHover(x.key)}
                onMouseLeave={() => setSortHover(null)}
                onFocus={() => setSortHover(x.key)}
                onBlur={() => setSortHover(null)}
              >
                {x.label}
                {sort === x.key && (
                  <span className="lt-arrow" aria-hidden>
                    {dir === 'asc' ? '↑' : '↓'}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="pillhint">{sortHint}</div>
        </div>

        {/* What a page came from, as a filter rather than only as a column and an order
            (2026-09-14). Multi-select, ORed: the question a reader has here is "show me the
            papers and the web pages", not "show me exactly one kind" - which is why these are
            toggles and the sorts above them are a radio group. `Publication` is the one pill
            that is not a document type; see lib/catalogSourceFilter.ts. */}
        {kindPills.length > 0 && (
          <div className="gp-sec">
            <div className="gp-head">
              <span className="gp-eyebrow">Source types</span>
              {/* The same × the domains carry, in the same place: one gesture for "stop
                  narrowing by this", wherever a section narrows. */}
              {kinds.size > 0 && (
                <button
                  className="btn ghost head-clear"
                  onClick={() => setKinds(new Set())}
                  title="Clear the source filter"
                  aria-label="Clear the source filter"
                >
                  <Icon name="x" />
                </button>
              )}
            </div>
            <div className="pillrow multi" role="group" aria-label="Source types">
              {kindPills.map((f) => (
                <button
                  key={f.key}
                  className="viewpill"
                  aria-pressed={kinds.has(f.key)}
                  onClick={() => toggleKind(f.key)}
                  title={f.desc}
                  onMouseEnter={() => setKindHover(f.key)}
                  onMouseLeave={() => setKindHover(null)}
                  onFocus={() => setKindHover(f.key)}
                  onBlur={() => setKindHover(null)}
                >
                  {f.label}
                  <span className="pn">{kindCounts.get(f.key) ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="pillhint">{kindHint}</div>
          </div>
        )}

        <DomainSection
          domains={domainRows}
          label={(d) => (d === '' ? 'no domain' : d)}
          color={(d) => (d === '' ? 'var(--muted)' : domainColor(d))}
          selected={new Set(domain === null ? [] : [domain === 'none' ? '' : domain])}
          onToggle={(d) => {
            const key = d === '' ? 'none' : d
            setDomain((cur) => (cur === key ? null : key))
          }}
          onClear={() => setDomain(null)}
          groups={wings}
          mode={wingMode.mode}
          onMode={wingMode.setMode}
          wing={wing}
          onWing={pickWing}
          active={active}
          listRef={domListRef}
        />
      </aside>

      <div className="box">
        {/* A page opened from a row (or from Home, or from the graph) is read here, over the
            list's slot; Escape and the arrow return to the list. */}
        {openPage !== null ? (
          <CatalogArticle path={openPage} vaultName={vaultName} nodes={nodes ?? []} onBack={() => navigate('/catalog')} />
        ) : (
          <>
        {/* The same bar the graph draws over its canvas, in the same three groups: a slot
            as wide as the graph's Fit button (the reset stands in it once a filter is set)
            and the count on the left, the domain in the middle, the search at the right
            edge. Switching the tabs moves neither the sentence, the heading nor the box. */}
        <div className="graph-controls scope-bar catalog-head">
          <span className="bar-l">
            {dirty ? (
              <button className="btn ghost head-slot" onClick={reset} title="Back to every page, newest first">
                Reset
              </button>
            ) : (
              <span className="head-slot" aria-hidden />
            )}
            <span className="scopeline">
              Showing{' '}
              <strong>
                {filtered.length} of {pool.length}
              </strong>{' '}
              {noun}
            </span>
          </span>
          <ScopeMid heading={scopeMid} />
          <span className="bar-r">
            <div className="graph-search graph-search-inbar">
              <Icon name="search" />
              <input
                type="search"
                placeholder="Filter by title, tag or domain…"
                aria-label="Filter pages by title, tag or domain"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </span>
        </div>
        {/* The scroll box is a DIV, not the table: a table set to `display: block` (the old
            way of making it scroll) shrinks to its content, so the columns moved every time
            a domain filter changed the longest title on screen. */}
        <div className="box-body">
        {state !== null ? (
          <div className="library-empty">{state}</div>
        ) : shown.length === 0 ? (
          <div className="library-empty">
            <div className="empty">Nothing matches the current filters.</div>
          </div>
        ) : (
          <CatalogTable
            nodes={shown}
            refs={refs}
            vaultName={vaultName}
            onOpenPage={(p) => navigate(catalogPageRoute(p))}
            sort={sort}
            dir={dir}
            onSort={chooseSort}
          />
        )}
        </div>
        <div className="box-foot keys" hidden={state !== null}>
          {/* The count moved up into the head; the foot keeps the keys and the one action. */}
          <span className="fl" />
          {/* The wing keys are bound only while the domains are listed by wing, and the
              hint says only what the keys do. */}
          <FootKeys items={['↑ ↓ walk the rows', ...(wing !== null ? ['← → step the wing'] : []), 'Enter opens a row', 'Esc closes a page']} />
          <span className="fr">
            {/* Only with a domain filter on: a deepening run is bounded by a domain, and this
                is where the domain is already the thing you are looking at. */}
            {domain !== null && domain !== 'none' && (
              <button className="btn" onClick={() => setDeepening(true)} title={`Have the Fellow of ${domain} append to its thinnest, most linked pages`}>
                Deepen this domain
              </button>
            )}
          </span>
        </div>
          </>
        )}
      </div>
      {deepening && domain !== null && domain !== 'none' && <DeepenDialog domain={domain} onClose={() => setDeepening(false)} />}
    </div>
  )
}

/**
 * One row's provenance: the type of the document the page came from, as an inline link to
 * the document itself. Pages with nothing behind them - written by hand, or filed by a
 * research run that never ingested a file - show a dash rather than a guess.
 */
function SourceCell({
  node,
  refs,
}: {
  node: GraphNode
  refs: Record<string, SourceRef> | undefined
}): React.ReactElement {
  // Still loading: nothing at all, not a dash. A dash is a statement ("no source"), and
  // making it before the index arrives would be a lie that flickers.
  if (refs === undefined) return <span className="src-none" />
  /*
   * The ingested document first, the page's own address second. A page a research run wrote
   * has no ingest behind it - the run read the web rather than filing a document - so the
   * index never knew it and the column said "no source" about a page that names one.
   */
  const link = sourceLink(refs[node.path]) ?? addressLink(node.url)
  if (link === null) return <span className="src-none">-</span>
  return (
    <a
      className="src-link"
      href={link.href}
      title={link.title}
      target="_blank"
      rel={link.external ? 'noreferrer noopener' : undefined}
    >
      <Icon name={link.icon} />
      {link.label}
    </a>
  )
}

/**
 * The page table itself (2026-09-06): the Catalog screen renders it over the whole vault,
 * the Library's shelf window over one department. One table, so the two can never drift
 * apart on what a row shows or what clicking it does.
 */
export function CatalogTable({
  nodes,
  refs,
  vaultName,
  hideDomain = false,
  onOpenPage,
  sort,
  dir,
  onSort,
}: {
  nodes: readonly GraphNode[]
  refs: Record<string, SourceRef> | undefined
  vaultName: string
  /** The window is already one domain, so its column would repeat the heading. */
  hideDomain?: boolean
  /** Where a row click goes. Default: the vault viewer. The Library reads the page in place. */
  onOpenPage?: (path: string) => void
  /**
   * The order, when a screen around the table owns it - the Catalog does, because its sidebar
   * shows the same choice as a row of pills. Left out, the table keeps its own: the Library's
   * shelf window has no sidebar and still sorts by its headings.
   */
  sort?: CatalogSortKey
  dir?: SortDir
  onSort?: (key: CatalogSortKey, dir: SortDir) => void
}): React.ReactElement {
  // Uncontrolled fallback, so a table without a screen around it is still sortable.
  const [ownSort, setOwnSort] = useState<{ key: CatalogSortKey; dir: SortDir }>({ key: 'changed', dir: naturalDir('changed') })
  const activeSort = sort ?? ownSort.key
  const activeDir = dir ?? ownSort.dir
  /** A heading click: the column's natural direction, or the reverse when it already sorts. */
  const chooseSort = (key: CatalogSortKey): void => {
    const next = key === activeSort ? (activeDir === 'asc' ? 'desc' : 'asc') : naturalDir(key)
    if (onSort !== undefined) onSort(key, next)
    else setOwnSort({ key, dir: next })
  }
  const shown = useMemo(() => sortCatalog(nodes, activeSort, activeDir, refs), [nodes, activeSort, activeDir, refs])
  const sources = { data: { pages: refs } }
  const domainCol = !hideDomain
  const head = (key: CatalogSortKey, label: string): React.ReactElement => (
    <button
      type="button"
      className={`lt-sort${activeSort === key ? ' on' : ''}`}
      onClick={() => chooseSort(key)}
      title={`Sort by ${CATALOG_SORTS.find((x) => x.key === key)?.label.toLowerCase() ?? label}${activeSort === key ? ' - again to reverse' : ''}`}
    >
      {label}
      {activeSort === key && <span className="lt-arrow" aria-hidden>{activeDir === 'asc' ? '↑' : '↓'}</span>}
    </button>
  )
  const ariaSort = (key: CatalogSortKey): 'ascending' | 'descending' | 'none' =>
    activeSort !== key ? 'none' : activeDir === 'asc' ? 'ascending' : 'descending'
  return (
      <table className="dtable lib-table">
        <thead>
          <tr>
            {/* Two headings in one cell, because two columns share it: the kind chip sits in its
                own slot ahead of the title, and each sorts by what stands under it. */}
            <th aria-sort={ariaSort('type') === 'none' ? ariaSort('title') : ariaSort('type')}>
              <span className="lt-cell">
                <span className="lt-kind">{head('type', 'Type')}</span>
                {head('title', 'Title')}
              </span>
            </th>
            {domainCol && <th aria-sort={ariaSort('domain')}>{head('domain', 'Domain')}</th>}
            <th className="num" aria-sort={ariaSort('backlinks')}>
              {head('backlinks', 'In / out')}
            </th>
            <th aria-sort={ariaSort('changed')}>{head('changed', 'Changed')}</th>
            <th aria-sort={ariaSort('source')}>{head('source', 'Source')}</th>
            <th aria-hidden />
          </tr>
        </thead>
        <tbody>
          {shown.map((n) => (
            <tr key={n.path} {...openableRow(() => (onOpenPage ? onOpenPage(n.path) : navigate(pageRoute(n.path))), `Open ${n.title}`)}>
              <td className="lt-title" title={n.title}>
                {/* The flex row is a span inside the cell: a `td` set to `display: flex`
                    leaves the table layout, and its baseline then drifts against the
                    cells beside it, a little further with every row. */}
                <span className="lt-cell">
                  {/* The chip sits in a fixed slot, not just next to the title: its width
                      follows the label ("Meta" 48px, "Comparisons" 97px), which started
                      every title at a different x - five distinct ones down one screen. */}
                  <span className="lt-kind">
                    <span className="badge type">{bucketLabel(n.type)}</span>
                  </span>
                  <strong className="lt-name">{n.title}</strong>
                  {isOrphan(n) && <span className="lt-flag err">orphan</span>}
                  {isStub(n) && <span className="lt-flag warn">stub</span>}
                </span>
              </td>
              {domainCol && (
                <td className="lt-domain">
                  {n.domain !== null ? (
                    <>
                      <span className="chip-dot" style={{ background: domainColor(n.domain) }} />
                      {n.domain}
                    </>
                  ) : (
                    <span className="dim">-</span>
                  )}
                </td>
              )}
              <td className="num lt-links">
                {n.in} / {n.out}
              </td>
              <td className="lt-when">{n.mtimeMs !== undefined ? timeAgo(new Date(n.mtimeMs).toISOString()) : ''}</td>
              {/* The document this page came from. The click must not also open the
                  page - the whole row is a link to it. */}
              <td className="lt-source" onClick={(e) => e.stopPropagation()}>
                <SourceCell node={n} refs={sources.data?.pages} />
              </td>
              {/* Zero-width cell: the buttons float out of it on hover instead of
                  reserving 78px in every row for something that is invisible most of
                  the time. They land over "Changed", never over Source - covering the
                  link the column exists for would be a poor trade. */}
              <td className="lt-acts" onClick={(e) => e.stopPropagation()}>
                <span className="lt-actgroup">
                  <button
                    className="btn ghost"
                    aria-label={`Focus ${n.title} in the graph`}
                    title="Focus in graph"
                    onClick={() => navigate(`/graph?focus=${encodeURIComponent(n.path)}`)}
                  >
                    <Icon name="spotlight" />
                  </button>
                  <button
                    className="btn ghost"
                    aria-label={`Open ${n.title} in Obsidian`}
                    title="Open in Obsidian"
                    onClick={() => {
                      window.location.href = obsidianUri(vaultName, n.path)
                    }}
                  >
                    <Icon name="link" />
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
  )
}
