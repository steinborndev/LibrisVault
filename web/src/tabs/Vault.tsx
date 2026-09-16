/**
 * The in-dashboard vault viewer (SPEC.md §12.4) - the tab that makes the Obsidian app
 * optional for everyday use. Two deep-linkable routes:
 *
 *   /vault                → the wikilink graph (search, type filters, local-neighborhood mode)
 *   /vault/page/<path>    → one rendered page: markdown with clickable [[wikilinks]],
 *                           a backlinks panel, and the obsidian:// bridge link
 *
 * Strictly read-only - everything here is derived from GET /graph and GET /pages
 * (hard rule 1: the vault is only ever written by agent runs).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { staleLinks, useStaleLinks } from '../lib/staleLinks.ts'
import type { GraphNode, VaultGraph, ValidationFinding, RepairTask } from '../api/types.ts'
import { GraphCanvas, domainColor, TYPE_VARS, type Lens } from '../components/GraphCanvas.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { Icon } from '../components/Icon.tsx'
import { DomainSection } from '../components/DomainSection.tsx'
import { wingGroups, wingOf, type WingGroup, type WingListMode } from '../lib/wings.ts'
import { useWingMode } from '../hooks/useWingMode.ts'
import { GapCleanupBar, useGapCleanup } from '../components/GapCleanup.tsx'
import { queryState } from '../components/QueryState.tsx'
import { frontmatter } from '../lib/frontmatter.ts'
import { Shortcuts } from '../components/Shortcuts.tsx'
import { ScopeMid } from '../components/ScopeMid.tsx'
import { scopeHeading } from '../lib/scopeHeading.ts'
import { linkifyText } from '../lib/linkify.tsx'
import { navigate, pageRoute, pageFromPath, originPath, catalogPageRoute } from '../lib/router.ts'
import { stepTrail } from '../lib/trail.ts'
import { detectClusters } from '../lib/communities.ts'
import { obsidianUri } from '../lib/obsidian.ts'
import { timeAgo } from '../lib/format.ts'

/**
 * Renders a frontmatter value: wikilinks become in-app navigation, and the plain text around
 * them gets bare URLs and patent numbers auto-linked (so a `url:` or patent field is clickable).
 */
function renderMetaValue(
  value: string,
  linkTo: (target: string, label: string, key: string) => React.ReactNode,
): React.ReactNode {
  const parts: React.ReactNode[] = []
  const re = /\[\[([^\]]+)\]\]/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) parts.push(...linkifyText(value.slice(last, m.index), `meta-t${i}`))
    const body = m[1]!
    const target = body.split('|')[0]!.split('#')[0]!.trim()
    const label = (body.split('|')[1] ?? body.split('#')[0])!.trim()
    parts.push(linkTo(target, label || target, `meta-${i++}`))
    last = m.index + m[0].length
  }
  if (last < value.length) parts.push(...linkifyText(value.slice(last), `meta-t${i}`))
  return parts
}

/** Display labels for the wiki buckets (fallback: the raw directory name). */
const TYPE_LABELS: Record<string, string> = {
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

/**
 * The graph's key bindings, in the order someone learning the view meets them. Kept by
 * hand against the handlers (the window-level ladder below, the canvas's own keys, the
 * wing keys in the domain section): the list is documentation, and a row that names a key
 * nothing binds any more is worse than no list.
 */
const GRAPH_SHORTCUTS = [
  { keys: ['2x click'], what: 'open a page from the graph' },
  { keys: ['click'], what: 'select a page; with Spotlight on, a cluster area drills in and a node opens' },
  { keys: ['Enter'], what: 'open the selected page (in the search box: the one match)' },
  { keys: ['Esc'], what: 'one step back: fullscreen, the search text, the panel, a cluster, the gaps, a focus' },
  { keys: ['Esc', 'Esc'], what: 'reset the view - the whole vault, every filter off' },
  { keys: ['/'], what: 'search pages and tags; a click outside folds the list, the filter stays' },
  { keys: ['←', '→'], what: 'previous or next wing, while the domains are listed by wing' },
  { keys: ['f'], what: 'fit the view' },
  { keys: ['+', '-'], what: 'zoom in and out' },
  { keys: ['wheel'], what: 'zoom towards the pointer' },
  { keys: ['drag'], what: 'pan the canvas; the overview in the corner jumps the view' },
]

export function Vault({ path, active = true }: { path: string; active?: boolean }): React.ReactElement {
  const graphQ = useQuery({ queryKey: ['graph'], queryFn: api.graph, staleTime: 30_000 })

  const [pathname, search] = path.split('?') as [string, string | undefined]
  const page = pageFromPath(pathname)
  const params = new URLSearchParams(search ?? '')
  const focus = params.get('focus')
  // `/graph?select=<path>`: the page selected in the whole graph, nothing narrowed - what a
  // record's "Graph view" and the Catalog's "In graph" mean. `?focus=` is the other door.
  const select = params.get('select')
  // `/graph?domain=<key>` (a shelf click in the Library, docs/tasks/TASKS-A4.md D10) sets the
  // domain filter once; the chips take over from there.
  const domainParam = params.get('domain')
  // `?gaps=1` arrives from Home's Gaps card: open the graph with the gaps overlay already on.
  const openGaps = params.get('gaps') === '1'
  // `?labels=off`: screenshot mode - the canvas draws structure and colors but no text, so
  // a capture of a real vault can be shared without leaking page titles.
  const hideLabels = params.get('labels') === 'off'
  // `?all=1`: arrive from a run's "View in graph" with every filter cleared and the whole
  // graph drawn, so the page is seen in the context of everything rather than of whatever
  // the last visit had narrowed the view to.
  const clearFilters = params.get('all') === '1'

  const state = queryState(graphQ, 'the graph')
  if (state !== null) return state
  // Neither loading nor failed, but nothing came back: the query settled empty. Rare, and
  // the retry is still the only useful thing to offer.
  if (!graphQ.data) {
    return (
      <div className="empty">
        <p className="qs-line">The graph came back empty.</p>
        <button className="btn" onClick={() => void graphQ.refetch()}>
          Try again
        </button>
      </div>
    )
  }

  if (page !== null) return <PageView graph={graphQ.data} path={page} />
  return <GraphView graph={graphQ.data} focusPath={focus} selectPath={select} openGaps={openGaps} hideLabels={hideLabels} domainParam={domainParam} clearFilters={clearFilters} active={active} />
}

// ---------------------------------------------------------------------------- graph view

/** Key under which "page has no domain" appears in the domain filter (SPEC §12.4 Stufe 1). */
const NO_DOMAIN = ''

/** Synthetic path prefix marking a ghost (gap) node in the canvas node list. */
const GAP_PATH_PREFIX = '#gap:'

/** Two Escape presses within this window are a "double Esc" - reset the whole graph view. */
const DOUBLE_ESC_MS = 400

/** The explorer selection: a real page (by path) or a knowledge gap (by title). */
type Selection = { kind: 'page'; path: string } | { kind: 'gap'; title: string } | null

/**
 * One level of isolated community (spotlight click, SPEC §12.4): the graph shows only these
 * pages until Esc. Levels stack - Louvain re-runs on the isolated subgraph and usually finds
 * sub-communities, so a spotlight click inside a focused cluster drills one level deeper;
 * Esc pops one level. Each level is a snapshot by PATH, not by subgraph index - indices churn
 * on every filter change and SSE live update (same reasoning as `Selection`) - and a proper
 * SUBSET of the level above, so the keep-filter only ever needs the top of the stack.
 * `anchor` is the clicked page, keying the camera re-fit; label/domain feed the clusterbar.
 * A cluster is NOT a domain: one domain typically splits into several Louvain communities,
 * and this isolates exactly one of them.
 */
interface ClusterFocus {
  paths: ReadonlySet<string>
  label: string
  domain: string | null
  anchor: string
}


/** Missing `kind` (ghost nodes, old cached responses) counts as knowledge - never hide it. */
const isKnowledge = (n: GraphNode): boolean => (n.kind ?? 'knowledge') === 'knowledge'

/**
 * Tags that mirror a page's `type:`/kind rather than its subject - they say WHAT a page is,
 * not what it's ABOUT, so they carry no thematic signal for "Related by tag". Every source
 * page shares `#source`, so matching on it drags in the whole source corpus. Mirrors the
 * server's KNOWLEDGE_TYPES/ARTIFACT_TYPES plus structural markers (server/src/pipeline/graph.ts).
 */
const STRUCTURAL_TAGS: ReadonlySet<string> = new Set([
  'concept', 'entity', 'source', 'reference', 'comparison', 'question', 'synthesis', 'decision',
  'session', 'fold', 'report', 'release', 'index', 'log', 'meta', 'moc',
])
const isThematicTag = (t: string): boolean => !STRUCTURAL_TAGS.has(t.toLowerCase())

/** localStorage key of the RETIRED standalone System toggle - read once as a migration
 *  fallback when the combined prefs key below doesn't exist yet. */
const SHOW_SYSTEM_KEY = 'vault.showSystem'

/**
 * localStorage key for the graph view preferences - the how-it's-drawn choices (lens, type
 * visibility, domain filter, overlay toggles, System). Persisted so an F5 keeps the graph
 * the user set up; System used to be the only survivor, which read as random amnesia.
 * Exploration state (search, selection, trail, cluster drill-down) stays session-only on
 * purpose - it describes where the user currently IS, not how they like the graph shown.
 * The payload carries a `v` field: bump it on shape changes and stale prefs fall back to
 * defaults instead of half-applying.
 */
/** How many hops the trail keeps, rolling. The rules are in `stepTrail`. */
const TRAIL_MAX = 3

const VIEW_PREFS_KEY = 'vault.graphPrefs'

const LENS_VALUES: ReadonlySet<string> = new Set(['domain', 'type', 'authority', 'orphans', 'stubs', 'recency'])

interface ViewPrefs {
  // v2: the type filter flipped from hide-set (`hiddenTypes`) to solo-select (`selectedTypes`),
  // mirroring the domain filter. The two carry OPPOSITE meaning, so a v1 payload must be
  // discarded, not read as the new field - the version bump is what makes the loader do that.
  v: 2
  lens: Lens
  selectedTypes: string[]
  selectedDomains: string[]
  showClusters: boolean
  showGaps: boolean
  showNetwork: boolean
  spotlight: boolean
  showSystem: boolean
}

/** loadViewPrefs result: every field optional AND possibly explicitly undefined (validation
 *  emits undefined for unusable fields; exactOptionalPropertyTypes makes that distinction). */
type LoadedPrefs = { [K in keyof Omit<ViewPrefs, 'v'>]?: ViewPrefs[K] | undefined }

/** Field-by-field validated load: a foreign or stale payload degrades to defaults, never
 *  throws. Exported for its unit tests only. */
export function loadViewPrefs(): LoadedPrefs {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY)
    if (raw === null) return { showSystem: localStorage.getItem(SHOW_SYSTEM_KEY) === '1' }
    const p: unknown = JSON.parse(raw)
    if (p === null || typeof p !== 'object' || (p as { v?: unknown }).v !== 2) return {}
    const o = p as Record<string, unknown>
    const strings = (x: unknown): string[] | undefined =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : undefined
    const bool = (x: unknown): boolean | undefined => (typeof x === 'boolean' ? x : undefined)
    return {
      lens: typeof o.lens === 'string' && LENS_VALUES.has(o.lens) ? (o.lens as Lens) : undefined,
      selectedTypes: strings(o.selectedTypes),
      selectedDomains: strings(o.selectedDomains),
      showClusters: bool(o.showClusters),
      showGaps: bool(o.showGaps),
      showNetwork: bool(o.showNetwork),
      spotlight: bool(o.spotlight),
      showSystem: bool(o.showSystem),
    }
  } catch {
    return {} // storage unavailable (private mode) or corrupt JSON - defaults win
  }
}

const savedPrefs = loadViewPrefs()

/**
 * GraphView state that OUTLIVES the component: graph and page view are mutually exclusive
 * routes, so opening an article unmounts the graph - without this, a double-click →
 * article → Escape round trip would come back to reset filters, lens, search, selection
 * and trail. Same module-scope pattern (and rationale) as the canvas's camera memory in
 * GraphCanvas.tsx; safe because the app has exactly one graph view. The ViewPrefs subset
 * additionally survives reloads via localStorage (seeded here, written by saveViewPrefs).
 */
const viewMemory = {
  query: '',
  selectedTypes: new Set(savedPrefs.selectedTypes ?? []) as ReadonlySet<string>,
  selectedDomains: new Set(savedPrefs.selectedDomains ?? []) as ReadonlySet<string>,
  lens: savedPrefs.lens ?? ('domain' as Lens),
  showClusters: savedPrefs.showClusters ?? false,
  showGaps: savedPrefs.showGaps ?? false,
  showNetwork: savedPrefs.showNetwork ?? false,
  spotlight: savedPrefs.spotlight ?? false,
  clusterStack: [] as readonly ClusterFocus[],
  showSystem: savedPrefs.showSystem ?? false,
  selection: null as Selection,
  trail: [] as string[],
}

/** Last-written prefs JSON - the snapshot effect runs on every commit, writes only on change. */
let lastSavedPrefs: string | null = null

function saveViewPrefs(): void {
  const prefs: ViewPrefs = {
    v: 2,
    lens: viewMemory.lens,
    selectedTypes: [...viewMemory.selectedTypes].sort(),
    selectedDomains: [...viewMemory.selectedDomains].sort(),
    showClusters: viewMemory.showClusters,
    showGaps: viewMemory.showGaps,
    showNetwork: viewMemory.showNetwork,
    spotlight: viewMemory.spotlight,
    showSystem: viewMemory.showSystem,
  }
  const json = JSON.stringify(prefs)
  if (json === lastSavedPrefs) return
  lastSavedPrefs = json
  try {
    localStorage.setItem(VIEW_PREFS_KEY, json)
  } catch {
    // Storage unavailable (private mode) - the prefs still hold for this session.
  }
}

/** An existing wikilink flagged as possibly incidental (see the graph-health memo). */
interface SuspiciousEdge {
  from: GraphNode
  to: GraphNode
}

/**
 * Deterministic connectivity findings over the FULL graph (filters don't change whether a
 * page is isolated). Feeds the explorer panel's "Repair" action:
 *  - isolated: knowledge pages with no edge to another knowledge page - invisible to graph
 *    exploration (their only neighbors, if any, are system pages like lint reports).
 *  - suspicious: the SINGLE edge between two domains that share no other link. One lone
 *    wire between e.g. cooking and finance is almost always an incidental aside, not
 *    knowledge (the real case: a recipe source name-dropping an investment PDF as "the
 *    vault's earlier German source").
 */
interface GraphHealth {
  isolated: ReadonlySet<string>
  /** Suspicious edges keyed by BOTH endpoint paths, for per-page lookup in the panel. */
  suspiciousByPage: ReadonlyMap<string, readonly SuspiciousEdge[]>
}

function computeGraphHealth(graph: VaultGraph): GraphHealth {
  const nodes = graph.nodes
  const kn = nodes.map(isKnowledge)
  const knDeg = new Array<number>(nodes.length).fill(0)
  // A domain only counts as a "side" when it is a real subject: meta/unassigned/absent
  // domains produce no meaningful cross-domain signal.
  const realDomain = (d: string | null): string | null => (d !== null && d !== 'meta' && d !== 'unassigned' ? d : null)
  const pairCount = new Map<string, number>()
  const cross: Array<[number, number, string]> = []
  for (const [a, b] of graph.edges) {
    if (!kn[a] || !kn[b]) continue
    knDeg[a]!++
    knDeg[b]!++
    const da = realDomain(nodes[a]!.domain)
    const db = realDomain(nodes[b]!.domain)
    if (da !== null && db !== null && da !== db) {
      const key = da < db ? `${da}|${db}` : `${db}|${da}`
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
      cross.push([a, b, key])
    }
  }
  const isolated = new Set<string>()
  nodes.forEach((n, i) => {
    if (kn[i] && knDeg[i] === 0) isolated.add(n.path)
  })
  const suspiciousByPage = new Map<string, SuspiciousEdge[]>()
  for (const [a, b, key] of cross) {
    if (pairCount.get(key) !== 1) continue
    const edge: SuspiciousEdge = { from: nodes[a]!, to: nodes[b]! }
    for (const p of [edge.from.path, edge.to.path]) {
      const list = suspiciousByPage.get(p) ?? suspiciousByPage.set(p, []).get(p)!
      list.push(edge)
    }
  }
  return { isolated, suspiciousByPage }
}

/** Search settle delay: long enough to swallow a burst of keystrokes, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 220

/** `value`, but only after it has stopped changing for `delay` ms. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return settled
}

function GraphView({
  graph,
  focusPath,
  selectPath = null,
  openGaps,
  hideLabels = false,
  domainParam = null,
  clearFilters = false,
  active = true,
}: {
  graph: VaultGraph
  focusPath: string | null
  /** A page to select in the whole graph, consumed on arrival; null when nothing is asked. */
  selectPath?: string | null
  openGaps: boolean
  /** `?labels=off` - render the graph without any text (screenshot mode). */
  hideLabels?: boolean
  /** `?domain=<key>` - a shelf click in the Library selects that domain once (TASKS-A4 D10). */
  domainParam?: string | null
  /** A one-shot command like `?gaps=1`: drop every filter, show the whole graph. */
  clearFilters?: boolean
  /** Whether this screen is the one on show; false while another tab has the viewport. */
  active?: boolean
}): React.ReactElement {
  // `input` is what the field shows; `query` is what the graph reacts to. Without the delay
  // every keystroke re-filtered the subgraph, re-ran Louvain and refit the camera - typing a
  // six-letter word moved the view six times.
  const [input, setInput] = useState(viewMemory.query)
  const query = useDebounced(input, SEARCH_DEBOUNCE_MS)
  /**
   * Type filter, SOLO-select like the domains (was a hide-set): clicking "concepts" means
   * "show me concepts", so an empty set = every type visible and a non-empty set = only those
   * types. Same inclusion semantics on both axes - a checked box now means "shown", not "not
   * hidden" (the old double negative).
   */
  const [selectedTypes, setSelectedTypes] = useState<ReadonlySet<string>>(viewMemory.selectedTypes)
  /**
   * Domain chips are SOLO-selects, not hide-toggles: clicking "finance" means "show me
   * finance", so an empty set = everything visible and a non-empty set = only those
   * domains. (The old hide-semantics did the exact opposite of what a click intends.)
   */
  const [selectedDomains, setSelectedDomains] = useState<ReadonlySet<string>>(viewMemory.selectedDomains)
  useEffect(() => {
    if (domainParam !== null && domainParam !== '') setSelectedDomains(new Set([domainParam]))
  }, [domainParam])

  /*
   * Coming back to this screen re-fits the camera.
   *
   * The canvas keeps pan and zoom past its own unmount, under this screen's own key since
   * 2026-09-10 - a look inside a department no longer moves this screen's camera. What is
   * left is the ordinary case: a graph left half-zoomed weeks ago, returned to, is better
   * met in frame than wherever it was parked. Counting activations puts it there.
   */
  const [visits, setVisits] = useState(0)
  useEffect(() => {
    if (active) setVisits((n) => n + 1)
  }, [active])
  // The color lens. Domain is the default - the meta-categories are the axis the user
  // actually thinks in; type + the metric lenses (authority/orphans/stubs/recency) live in
  // the lens dropdown.
  const [lens, setLens] = useState<Lens>(viewMemory.lens)
  const [localDepth, setLocalDepth] = useState<1 | 2 | 0>(focusPath ? 2 : 0) // 0 = whole graph
  // Cluster hulls: auto-detected communities as tinted, tag-labelled blobs. Off by default.
  const [showClusters, setShowClusters] = useState(viewMemory.showClusters)
  // Gaps view: overlays the unresolved link targets as ghost nodes (SPEC §12.4). Off by
  // default - it is an exploration mode, not the resting state of the graph.
  const [showGaps, setShowGaps] = useState(viewMemory.showGaps)
  // Network lens: lift the connection lines out of the point-cloud read (intra-cluster edges
  // brighten, cross-cluster bridges get a directional gradient). Off by default. Reuses the
  // community detection, so turning it on computes clusters even when the hull tint is off.
  const [showNetwork, setShowNetwork] = useState(viewMemory.showNetwork)
  // Spotlight: hovering a node highlights its whole community (falling back to direct
  // neighbors when it has none) and dims the rest; clicking isolates the community. Off by
  // default (easier to click). Lives in the viewbar overlays; passed down to the canvas.
  const [spotlight, setSpotlight] = useState(viewMemory.spotlight)
  // The stack of isolated communities: each spotlight click pushes one level (the clicked
  // node's community, re-detected on the isolated subgraph), Esc pops one, the clusterbar
  // jumps to any level. Empty = the full graph. The spotlight stays live inside a focus -
  // it highlights the SUB-communities of the current level; when a level doesn't subdivide
  // any further, the canvas falls back to the 1-hop neighborhood and clicks select normally
  // (the drill-down ends exactly where there is nothing left to subdivide).
  const [clusterStack, setClusterStack] = useState<readonly ClusterFocus[]>(viewMemory.clusterStack)
  const clusterFocus = clusterStack.length > 0 ? clusterStack[clusterStack.length - 1]! : null
  /**
   * System pages (structural hubs + maintenance artifacts, node `kind` ≠ knowledge) are
   * hidden by default: the heavily-linked index/hot/log hubs are cross-domain bridges that
   * visually dominate the graph and distort clustering, and reports/session logs aren't
   * knowledge at all. The toggle brings them back; the choice persists across sessions.
   */
  const [showSystem, setShowSystem] = useState(viewMemory.showSystem)
  /**
   * The explorer selection, keyed stably (path for a page, title for a gap) so it survives
   * the index churn a filter change causes. Clicking a node opens the panel instead of
   * navigating; "Open page" inside the panel is the explicit navigation - or a double-click
   * right on the node.
   */
  const [selection, setSelection] = useState<Selection>(viewMemory.selection)
  /** Breadcrumb of visited PAGES (not gaps) - every hop is a chip you can jump back to. */
  const [trail, setTrail] = useState<string[]>(viewMemory.trail)
  /**
   * Fullscreen: the graph on its own, with only the controls that belong to the drawing.
   * Deliberately NOT persisted - it is a posture for one look, not a preference, and
   * restoring a session into a chromeless screen is disorienting.
   */
  const [fullscreen, setFullscreen] = useState(false)
  /**
   * A tag pressed in the explorer's head. `around` is the page that was selected at the time,
   * which turns the filter from "every page with this tag" into "the ones that touch this
   * page" - the question you are actually asking when you press a tag while reading a page.
   */
  const [tagFilter, setTagFilter] = useState<{ tag: string; around: string | null } | null>(null)
  /** Whether the search box is out. Collapsed it is a magnifier; the slot keeps its width either way. */
  const [searchOpen, setSearchOpen] = useState(false)
  /**
   * "Fit graph", as a number. The canvas already re-frames whenever `fitKey` changes and
   * clears the panned-away flag while it does - which is exactly what the button has to do -
   * so asking for a fit is bumping this rather than reaching into the canvas for its method.
   */
  const [fitNonce, setFitNonce] = useState(0)

  /**
   * `?gaps=1` (Home's Gaps card) lands here with the gaps overlay on. It is a one-shot
   * COMMAND, not view state, so the param is consumed and dropped from the URL right away.
   * That matters twice: the screens stay mounted behind [hidden], so seeding useState would
   * only ever fire on the app's first visit to the graph - and without dropping the param,
   * a second click from Home would pass the identical path string, this effect would not
   * re-run, and the toggle would stay wherever the user last left it.
   */
  /*
   * `?all=1` is consumed the same way: the filters a visit left behind are dropped, the depth
   * goes to the whole graph, and the param is taken off the URL so a second click can fire it
   * again. Drawing preferences - lens, clusters, system pages - are not filters and stay.
   */
  useEffect(() => {
    if (!clearFilters) return
    setSelectedDomains(new Set())
    setSelectedTypes(new Set())
    setClusterStack([])
    setInput('')
    setLocalDepth(0)
    navigate(focusPath === null ? '/graph' : `/graph?focus=${encodeURIComponent(focusPath)}`, { replace: true })
  }, [clearFilters, focusPath])

  useEffect(() => {
    if (!openGaps) return
    setShowGaps(true)
    navigate(focusPath === null ? '/graph' : `/graph?focus=${encodeURIComponent(focusPath)}`, {
      replace: true,
    })
  }, [openGaps, focusPath])


  // Write-through into the module-scope memory: every committed render snapshots the view
  // state, so the next mount (returning from an article) restores exactly this view.
  useEffect(() => {
    Object.assign(viewMemory, {
      // The raw input, not the debounced value: a view round trip must restore what the
      // field showed, including a query the user had not finished typing.
      query: input,
      selectedTypes,
      selectedDomains,
      lens,
      showClusters,
      showGaps,
      showNetwork,
      spotlight,
      clusterStack,
      showSystem,
      selection,
      trail,
    })
    saveViewPrefs()
  })

  const selectPage = (path: string): void => {
    setSelection({ kind: 'page', path })
    setTrail((prev) => stepTrail(prev, path, TRAIL_MAX))
  }
  const selectGap = (title: string): void => setSelection({ kind: 'gap', title })
  const closeExplorer = (): void => {
    setSelection(null)
    setTrail([])
  }

  /*
   * A visit starts clean (2026-09-16). `viewMemory` exists so that a graph → article → Escape
   * round trip comes back to what it left - that trip UNMOUNTS this screen, which is the case
   * it was written for. Walking to another TAB is a different journey: the screen only goes
   * inactive, and coming back to somebody else's half-finished exploration - a node still
   * ringed, a trail along the bottom, a tag still narrowing the drawing - is the screen
   * keeping a train of thought that is no longer yours.
   *
   * What is dropped is the EXPLORATION: selection, trail, tag filter, search, cluster
   * drill-down and focus depth. What stays is the set of view PREFERENCES - lens, overlays,
   * domain and type filters - which persist across reloads on purpose; clearing them on a tab
   * switch while a reload restores them would be two rules disagreeing.
   */
  useEffect(() => {
    if (active) return
    closeExplorer()
    setTagFilter(null)
    setInput('')
    setSearchOpen(false)
    setClusterStack([])
    setLocalDepth(0)
  }, [active])

  const focusIndexFull = useMemo(
    () => (focusPath ? graph.nodes.findIndex((n) => n.path === focusPath) : -1),
    [graph, focusPath],
  )

  // Type/domain lists reflect the system filter: with system pages hidden, the meta/root
  // buckets and the `meta` domain would be dead entries - chips that filter nothing.
  const types = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of graph.nodes) {
      if (!showSystem && !isKnowledge(n)) continue
      counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [graph, showSystem])

  // Meta-categories from frontmatter `domain:`. Pages without one gather under NO_DOMAIN -
  // deliberately a visible bucket, not a blind spot: it shows how much of the vault is still
  // uncategorized (the evidence base for the domain-registry backfill, SPEC §12.4).
  const domains = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of graph.nodes) {
      if (!showSystem && !isKnowledge(n)) continue
      const d = n.domain ?? NO_DOMAIN
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => (a[0] === NO_DOMAIN ? 1 : b[0] === NO_DOMAIN ? -1 : b[1] - a[1]))
  }, [graph, showSystem])
  const hasDomains = domains.some(([d]) => d !== NO_DOMAIN)
  /** The flat list's order: alphabetical, the no-domain bucket last. */
  const domainRows = useMemo(() => [...domains].sort(([a], [b]) => (a === NO_DOMAIN ? 1 : b === NO_DOMAIN ? -1 : a.localeCompare(b))), [domains])
  /*
   * The Library's rooms, for the domain section's wing mode: the same placement the
   * Library draws, so the two never disagree about where a domain stands. Without the
   * Library (agents off) there is no scene and no wing mode.
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
  /** The room on show (by wing is the default, remembered per screen), or null for the flat list; the room is a filter on the graph. */
  const wingMode = useWingMode('vault.domainMode.graph', wings)
  const wing = wingMode.wing
  const wingScope = useMemo(() => (wing === null ? null : new Set(wings.find((g) => g.id === wing)?.domains ?? [])), [wing, wings])
  /** Turning the page drops any selection outside it: the room is the filter now. */
  const pickWing = useCallback(
    (id: string): void => {
      wingMode.setWing(id)
      const inside = new Set(wings.find((g) => g.id === id)?.domains ?? [])
      setSelectedDomains((s) => (s.size === 0 ? s : new Set([...s].filter((d) => inside.has(d)))))
    },
    [wings, wingMode],
  )
  // A selection made elsewhere (Home's domain bars, the search) lands in its own room: when
  // the room on show holds none of it, the page turns to the first selected domain's room.
  useEffect(() => {
    if (wing === null || selectedDomains.size === 0) return
    const here = new Set(wings.find((g) => g.id === wing)?.domains ?? [])
    if ([...selectedDomains].some((d) => here.has(d))) return
    const target = [...selectedDomains].map((d) => wingOf(wings, d)).find((id): id is string => id !== undefined)
    if (target !== undefined) wingMode.setWing(target)
  }, [selectedDomains, wing, wings, wingMode])

  /*
   * `?select=`: the page is selected - the explorer opens on it, the canvas marks it - and
   * nothing is narrowed. The two doors that say "graph" (a record's "Graph view", the
   * Catalog's "In graph") used to land in focus mode, which is the neighbourhood view and
   * not what they promised. Whatever would hide the node steps aside: the domain and type
   * filters, a cluster drill-down, the wing on show (it turns to the node's room, or to the
   * flat list when the room is not known yet), and the system-page switch for a system page.
   * The param is consumed, so the same button works twice in a row.
   */
  useEffect(() => {
    if (selectPath === null || selectPath === undefined) return
    navigate('/graph', { replace: true })
    const node = graph.nodes.find((n) => n.path === selectPath)
    if (node === undefined) return
    setSelectedDomains(new Set())
    setSelectedTypes(new Set())
    setClusterStack([])
    setLocalDepth(0)
    setInput('')
    if (!isKnowledge(node)) setShowSystem(true)
    if (wing !== null) {
      const room = wingOf(wings, node.domain ?? NO_DOMAIN)
      if (room !== undefined) wingMode.setWing(room)
      else wingMode.setMode('all')
    }
    selectPage(node.path)
    // The param is gone by the next render, so a later change of the rooms cannot replay this.
  }, [selectPath, graph.nodes, wing, wingMode, wings])
  // With no domains assigned, the domain lens falls back to type-coloring; the legend must
  // follow the SAME resolution so it explains what's actually drawn.
  const effectiveLens: Lens = hasDomains ? lens : lens === 'domain' ? 'type' : lens

  // Displayed subgraph: type + domain filters first, then (optionally) the BFS neighborhood
  // of the focused page. Indices are remapped so the canvas gets a dense, self-contained
  // graph - that is also what keeps the force layout small in local mode on a huge vault.
  // When the gaps view is on, the unresolved targets are appended as synthetic ghost nodes.
  const { nodes, edges, focusIndex, ghostIndices, realCount, matches } = useMemo(() => {
    let keep: boolean[] = graph.nodes.map(
      (n) =>
        (showSystem || isKnowledge(n)) &&
        (selectedTypes.size === 0 || selectedTypes.has(n.type)) &&
        (selectedDomains.size > 0 ? selectedDomains.has(n.domain ?? NO_DOMAIN) : wingScope === null || wingScope.has(n.domain ?? NO_DOMAIN)) &&
        (clusterFocus === null || clusterFocus.paths.has(n.path)),
    )

    if (localDepth > 0 && focusIndexFull >= 0) {
      const adj = new Map<number, number[]>()
      for (const [a, b] of graph.edges) {
        if (!adj.has(a)) adj.set(a, [])
        if (!adj.has(b)) adj.set(b, [])
        adj.get(a)!.push(b)
        adj.get(b)!.push(a)
      }
      const within = new Set<number>([focusIndexFull])
      let frontier = [focusIndexFull]
      for (let d = 0; d < localDepth; d++) {
        const next: number[] = []
        for (const i of frontier) {
          for (const j of adj.get(i) ?? []) {
            if (!within.has(j)) {
              within.add(j)
              next.push(j)
            }
          }
        }
        frontier = next
      }
      keep = keep.map((k, i) => k && within.has(i))
      keep[focusIndexFull] = true // the focus survives its own type/domain filter
    }

    /*
     * A TAG is a set, not a search (2026-09-16). Typing narrows to what matches plus each
     * match's neighbours, because a hit alone in the white is a dot without a statement. A
     * tag has no such problem: the tagged pages ARE the answer, and pulling their neighbours
     * in tripled the drawing and buried it in labels.
     *
     * And a tag pressed while a page is selected is a question about THAT page - "which of
     * these touch what I am looking at" - so it keeps the selection and the tagged pages that
     * link to or from it, and drops the rest of the tag. That is why this is its own filter
     * and not text in the search box: a query cannot know what is selected.
     */
    if (tagFilter !== null) {
      const around = tagFilter.around === null ? -1 : graph.nodes.findIndex((n) => n.path === tagFilter.around)
      const touching = new Set<number>()
      if (around >= 0) {
        touching.add(around)
        for (const [a, b] of graph.edges) {
          if (a === around) touching.add(b)
          if (b === around) touching.add(a)
        }
      }
      keep = keep.map((k, i) => {
        if (!k) return false
        if (around >= 0 && !touching.has(i)) return false
        // The page the question is about stays, whatever it is tagged with: dropping it would
        // answer "which of these touch it" with a picture that no longer contains it.
        if (i === around) return true
        return graph.nodes[i]!.tags.some((t) => t.toLowerCase() === tagFilter.tag.toLowerCase())
      })
    }

    // Search NARROWS the graph, it does not merely highlight (the old behaviour): with a
    // query present, keep only the pages related to it - the ones that match, plus their
    // direct neighbours so a match keeps its context - intersected with the filters already
    // applied above. Emptying the query restores the full (filtered) graph. Multi-word
    // queries are AND: every term must hit the title, a tag, or the domain.
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (n: GraphNode): boolean =>
      terms.every(
        (t) =>
          n.title.toLowerCase().includes(t) ||
          // The page's own title and aliases, not just its file name. The two differ
          // whenever the filesystem refused a character, so typing the title the dashboard
          // shows elsewhere used to find nothing.
          (n.names?.some((name) => name.toLowerCase().includes(t)) ?? false) ||
          n.tags.some((tag) => tag.toLowerCase().includes(t)) ||
          (n.domain?.toLowerCase().includes(t) ?? false),
      )
    const matchFull = new Set<number>()
    if (terms.length > 0) {
      graph.nodes.forEach((n, i) => {
        if (keep[i] && hit(n)) matchFull.add(i)
      })
      const related = new Set<number>(matchFull)
      for (const [a, b] of graph.edges) {
        if (matchFull.has(a) && keep[b]) related.add(b)
        if (matchFull.has(b) && keep[a]) related.add(a)
      }
      keep = keep.map((k, i) => k && related.has(i))
    }

    const remap = new Map<number, number>()
    const nodes: GraphNode[] = []
    graph.nodes.forEach((n, i) => {
      if (keep[i]) {
        remap.set(i, nodes.length)
        nodes.push(n)
      }
    })
    const edges: Array<[number, number]> = []
    for (const [a, b] of graph.edges) {
      const ra = remap.get(a)
      const rb = remap.get(b)
      if (ra !== undefined && rb !== undefined) edges.push([ra, rb])
    }

    const realCount = nodes.length
    const ghostIndices = new Set<number>()
    if (showGaps) {
      for (const gap of graph.gaps) {
        // Only wire the ghost to referencing pages that survived the current filters; a gap
        // whose referrers are all hidden would otherwise float edgeless and meaningless.
        const visibleRefs = gap.refBy.map((fi) => remap.get(fi)).filter((r): r is number => r !== undefined)
        if (visibleRefs.length === 0) continue
        const ghostIdx = nodes.length
        ghostIndices.add(ghostIdx)
        nodes.push({
          path: `${GAP_PATH_PREFIX}${gap.title}`,
          title: gap.title,
          type: 'gap',
          tags: [],
          domain: null,
          // `in` = true reference count (drives node size); edges only to visible referrers.
          in: gap.refBy.length,
          out: 0,
        })
        for (const r of visibleRefs) edges.push([r, ghostIdx])
      }
    }

    // The exact matches, in SUBGRAPH indices, for the ring highlight and the results list.
    // Neighbours pulled in for context are deliberately NOT matches - they render as plain
    // context around the ringed hits.
    const matches = new Set<number>()
    for (const f of matchFull) {
      const r = remap.get(f)
      if (r !== undefined) matches.add(r)
    }

    return { nodes, edges, focusIndex: remap.get(focusIndexFull) ?? null, ghostIndices, realCount, matches }
  }, [graph, selectedTypes, selectedDomains, wingScope, clusterFocus, showSystem, localDepth, focusIndexFull, showGaps, query, tagFilter])

  // Subgraph index of the explorer selection, for the canvas ring + spotlight. Null when the
  // selected page/gap is currently filtered out of view (the panel still shows regardless).
  const selectedIndex = useMemo(() => {
    if (selection === null) return null
    const wantPath = selection.kind === 'page' ? selection.path : `${GAP_PATH_PREFIX}${selection.title}`
    const i = nodes.findIndex((n) => n.path === wantPath)
    return i >= 0 ? i : null
  }, [nodes, selection])

  // Community detection (Louvain) over the currently-visible page graph. Computed when the
  // hulls OR the network lens OR the spotlight are on - the network lens classifies edges as
  // intra-cluster vs bridge and so needs the ids even when no hull is drawn, and the spotlight
  // highlights (and isolates on click) whole communities. Ghost nodes are excluded (id -1) - a
  // missing page has no community. Small clusters (< MIN_CLUSTER) are dropped so the canvas
  // isn't peppered with singleton blobs. Each surviving cluster is labelled by its tags.
  const { clusterIds, clusterLabels, clusterDomains } = useMemo(() => {
    if (!showClusters && !showNetwork && !spotlight)
      return { clusterIds: null as number[] | null, clusterLabels: new Map<number, string>(), clusterDomains: new Map<number, string>() }
    return detectClusters(nodes, edges, realCount)
  }, [showClusters, showNetwork, spotlight, nodes, edges, realCount])

  // The clickable result list under the search box - the rings in the graph show WHERE the
  // matches are, this shows WHAT they are. Every match is listed (the dropdown scrolls);
  // capping it forced the user to hunt the rest in the graph, which is the exact friction
  // a result list should remove. Title matches first (they read as more direct than
  // tag-only hits), then alphabetical so the order is stable as you scroll.
  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const list = [...matches].map((i) => nodes[i]!)
    list.sort((a, b) => {
      if (terms.length > 0) {
        const ta = terms.some((t) => a.title.toLowerCase().includes(t)) ? 0 : 1
        const tb = terms.some((t) => b.title.toLowerCase().includes(t)) ? 0 : 1
        if (ta !== tb) return ta - tb
      }
      return a.title.localeCompare(b.title)
    })
    return list
  }, [matches, nodes, query])

  // Known domains matching the query - surfaced ABOVE the page hits so "carbon" offers the
  // carbon-fiber domain as its first result; picking one solo-selects that domain filter.
  const domainResults = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return [] as Array<[string, number]>
    return domains.filter(([d]) => d !== NO_DOMAIN && terms.every((t) => d.toLowerCase().includes(t)))
  }, [domains, query])

  // Solo-select, mirroring toggleDomain: empty = all types; a click adds/removes a type, and
  // deselecting the last one falls back to "all".
  const toggleType = (t: string): void => {
    const next = new Set(selectedTypes)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    setSelectedTypes(next)
  }

  // Persisted with the rest of the view prefs by the snapshot effect - no standalone key.
  const toggleSystem = (): void => setShowSystem((v) => !v)

  // Solo-select semantics: empty = all; a click adds/removes a domain from the selection,
  // and deselecting the last one falls back to "all".
  const toggleDomain = (d: string): void => {
    const next = new Set(selectedDomains)
    if (next.has(d)) next.delete(d)
    else next.add(d)
    setSelectedDomains(next)
  }

  /** What the "System pages" toggle would add - the number it shows has to be that. */
  const systemCount = useMemo(() => graph.nodes.filter((n) => !isKnowledge(n)).length, [graph])
  /*
   * What "of N" counts. The scaffolding is only part of the vault while the switch that draws
   * it is on: with it off those pages are not drawn, not searched and not in any list here, so
   * counting them in the denominator made the graph disagree with the Catalog about how big the
   * same vault is - and left a remainder that could never be reached by turning a filter off.
   */
  const pagePool = showSystem ? graph.nodes.length : graph.nodes.length - systemCount

  /**
   * The bar's middle: which domain the drawing shows, said once and prominently, with the
   * domain's own colour ahead of it (2026-09-11). It replaced a tail on the count sentence
   * that listed every narrowing in words ("- the x domain, 32 system pages hidden · 3
   * gaps"); the chips in the panel say the rest, and the gaps have their toggle there.
   * One domain names it; more than one is a count; nothing picked is the wing in front
   * while the domains are listed by wing, and "all domains" otherwise.
   */
  const scopeMid = useMemo(
    () =>
      scopeHeading(
        selectedDomains,
        wing === null ? null : (wings.find((g) => g.id === wing)?.name ?? 'one wing'),
        tagFilter === null
          ? null
          : { name: tagFilter.tag, around: tagFilter.around === null ? null : (graph.nodes.find((n) => n.path === tagFilter.around)?.title ?? null) },
      ),
    [selectedDomains, wing, wings, tagFilter, graph],
  )

  const focusNode = focusIndexFull >= 0 ? graph.nodes[focusIndexFull] : undefined

  const health = useMemo(() => computeGraphHealth(graph), [graph])

  /**
   * Reset every VIEW control to its default so the whole vault is shown again (the double-Esc
   * escape hatch out of a deep filter/drill state). Clears filters, lens, overlays, cluster
   * drill-down, focus depth, search and selection. `showSystem` is deliberately kept - it is a
   * persistent preference (localStorage), not a filter the user is trying to escape.
   */
  const resetView = (): void => {
    setFullscreen(false)
    setInput('')
    setTagFilter(null)
    setSelectedTypes(new Set())
    setSelectedDomains(new Set())
    wingMode.setMode('all')
    setLens('domain')
    setShowClusters(false)
    setShowGaps(false)
    setShowNetwork(false)
    setSpotlight(false)
    setClusterStack([])
    setLocalDepth(0)
    closeExplorer() // selection + trail
    if (focusPath !== null) navigate('/graph')
  }

  // ---- keyboard layer. Window-level (the canvas isn't focusable), via the same stable-
  // listener ref pattern the canvas uses for wheel/zoom keys; gated on this view being the
  // VISIBLE tab - tabs stay mounted but hidden (App.tsx), and hidden = no offsetParent.
  // Escape peels back one UI layer per press: search → explorer panel → cluster focus →
  // gaps list → focus; a DOUBLE Escape (two presses within DOUBLE_ESC_MS) resets the whole
  // view at once.
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  /*
   * The result list is open while the field is being used and closes on a click anywhere
   * else - the FILTER stays. Search narrows the graph, and the point of narrowing it is to
   * explore what is left; a list that stayed open over the canvas until the text was cleared
   * made the two exclusive. Focusing or typing opens it again.
   */
  const searchBoxRef = useRef<HTMLDivElement>(null)
  const [resultsOpen, setResultsOpen] = useState(false)
  useEffect(() => {
    if (!resultsOpen) return
    const onDown = (e: PointerEvent): void => {
      if (searchBoxRef.current?.contains(e.target as Node) !== true) setResultsOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [resultsOpen])
  const lastEscRef = useRef(0)
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // "Is this screen actually on screen?" - the shell keeps every screen mounted and
    // hides it with [hidden], so a key must not act on a graph nobody can see. Measured
    // by box size, NOT by offsetParent: a position:fixed element (which is exactly what
    // fullscreen makes this) reports offsetParent === null, and that swallowed Escape in
    // the one state where it is the only way out.
    const root = rootRef.current
    if (root === null || (root.offsetWidth === 0 && root.offsetHeight === 0)) return
    const el = e.target as HTMLElement
    const typing =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable
    if (e.key === 'Escape') {
      if (typing) return // inputs own their Escape (the search clears/blurs itself)
      e.preventDefault()
      const now = performance.now()
      const doublePress = now - lastEscRef.current < DOUBLE_ESC_MS
      lastEscRef.current = now
      if (doublePress) {
        resetView() // second quick press: back to the full vault in one go
        return
      }
      // Fullscreen is the outermost posture: leave it first, and only it - a press that
      // also cleared a filter underneath would undo two things at once.
      if (fullscreen) {
        setFullscreen(false)
        return
      }
      if (input !== '') setInput('')
      /*
       * The trail is its own rung, ahead of the panel (2026-09-16). It is the thing running
       * along the bottom of the drawing, and stepping out of a walk should drop the walk
       * before it drops the page you walked to - one press to forget the way you came, a
       * second to close what you arrived at.
       */
      else if (tagFilter !== null) setTagFilter(null)
      else if (trail.length > 1) setTrail(selection?.kind === 'page' ? [selection.path] : [])
      else if (selection !== null) closeExplorer()
      else if (clusterStack.length > 0) setClusterStack((prev) => prev.slice(0, -1)) // pop one level
      else if (showGaps) setShowGaps(false)
      else if (focusPath !== null) navigate('/graph')
      return
    }
    if (typing) return
    if (e.key === 'Enter' && selection?.kind === 'page') {
      navigate(pageRoute(selection.path))
    } else if (e.key === '/') {
      e.preventDefault()
      setSearchOpen(true)
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => keyRef.current(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // The search sits in the canvas bar with Fit and the view actions: it acts on the
  // canvas, and a second floating box was claiming the same corner as the bar.
  const resultsShown = resultsOpen && query.trim() !== '' && (results.length > 0 || domainResults.length > 0)
  const searchOverlay = (
    /*
     * A slot of the box's own width, whatever is standing in it (2026-09-16). Collapsed, the
     * bar shows a magnifier at the right edge; open, the box fills the slot. The slot is why
     * the heading in the middle does not slide sideways when it opens - the alternative, a
     * button that grows into a field, moves everything left of it by 260 pixels.
     */
    <div className={`graph-search-slot${searchOpen ? ' open' : ''}`}>
      {searchOpen && (
    <div className="graph-search graph-search-inbar" ref={searchBoxRef}>
      <input
        ref={searchRef}
        type="search"
        placeholder="Search pages or tags…"
        value={input}
        onChange={(e) => {
          setInput(e.target.value)
          setResultsOpen(true)
        }}
        onFocus={() => setResultsOpen(true)}
        onKeyDown={(e) => {
          // Enter on an unambiguous match opens the page.
          if (e.key === 'Enter' && matches.size === 1) {
            const only = nodes[[...matches][0]!]
            if (only) navigate(pageRoute(only.path))
          }
          // Escape: first press restores the full graph, on an empty box it leaves the
          // field - so the next press reaches the window-level Escape ladder.
          if (e.key === 'Escape') {
            e.preventDefault()
            // Text first, then the box itself, then the window's own ladder: one step out per
            // press, the same shape Escape has everywhere else on this screen.
            if (input !== '') setInput('')
            else {
              e.currentTarget.blur()
              setSearchOpen(false)
            }
          }
        }}
        aria-label="Search the graph for a page or tag"
      />
      {input && <span className="graph-matches">{matches.size} match{matches.size === 1 ? '' : 'es'}</span>}
      {resultsShown && (
        <ul className="graph-search-results">
          {domainResults.map(([d, count]) => (
            <li key={`dom-${d}`}>
              <button
                className="dom-hit"
                // REPLACES the domain selection, deliberately diverging from the accumulating
                // chips/panel: search is a refocus - whoever had cooking soloed and then
                // searches carbon fiber has moved on; the old selection lost its relevance
                // the moment they typed. The tooltip says so.
                onClick={() => {
                  setSelectedDomains(new Set([d]))
                  setInput('')
                }}
                title={`Show only the ${d} domain (replaces the current domain filter)`}
              >
                <span className="bucket">Domain</span>
                <span className="dom-dot" style={{ background: domainColor(d) }} aria-hidden />
                {d}
                <span className="dom-count">{count}</span>
              </button>
            </li>
          ))}
          {results.map((n) => (
            <li key={n.path}>
              <button
                onClick={() => {
                  setInput('')
                  navigate(pageRoute(n.path))
                }}
              >
                <span className="bucket">{TYPE_LABELS[n.type] ?? n.type}</span>
                {n.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
      )}
      {/*
        * One magnifier, always at the right edge, open or closed: it is the same control in
        * both states, so it does not move between them. Closing clears the text - a query
        * still narrowing the graph from behind a folded-away box is a filter you cannot see
        * and therefore cannot undo.
        */}
      <button
        className="canvas-corner search-open"
        aria-expanded={searchOpen}
        onClick={() => {
          if (searchOpen) {
            setInput('')
            setSearchOpen(false)
            return
          }
          setSearchOpen(true)
          // Focus after the field exists; without the frame the ref is still null.
          requestAnimationFrame(() => searchRef.current?.focus())
        }}
        aria-label={searchOpen ? 'Close the search' : 'Search the graph'}
        title={searchOpen ? 'Close the search · Esc' : 'Search pages or tags · /'}
      >
        <Icon name="search" />
      </button>
    </div>
  )

  return (
    <div className={`vault-graph${fullscreen ? ' fullscreen' : ''}`} ref={rootRef}>
      <StaleLinksBanner />
      <div className="workspace graph-workspace">
        {(clusterFocus !== null || focusNode) && (
          <div className="ws-bar">
      {/* The isolated community as its own row (the spotlight-click result), mirroring the
          focusbar: what is isolated, how big it is, and the one way back. The domain dot and
          the "· domain" suffix make the cluster ≠ domain distinction visible - one domain
          usually splits into several communities, and this row names exactly one of them. */}
      {clusterFocus !== null && (
        <div className="clusterbar" role="status">
          {clusterFocus.domain !== null && (
            <span className="cb-dot" style={{ background: domainColor(clusterFocus.domain) }} aria-hidden />
          )}
          <span>Cluster:</span>
          {/* One crumb per drill-down level; clicking an earlier level pops back to it. */}
          {clusterStack.map((cf, i) => {
            const label = cf.label !== '' ? cf.label : 'unlabeled community'
            const isTop = i === clusterStack.length - 1
            return (
              <span key={`${i}-${cf.anchor}`} className="cb-level">
                {i > 0 && <span className="cb-arrow" aria-hidden>→</span>}
                {isTop ? (
                  <strong>{label}</strong>
                ) : (
                  <button
                    className="linkish"
                    onClick={() => setClusterStack((prev) => prev.slice(0, i + 1))}
                    title={`Back to this level (${cf.paths.size} pages)`}
                  >
                    {label}
                  </button>
                )}
              </span>
            )
          })}
          <span className="cb-meta">
            {clusterFocus.paths.size} pages
            {clusterFocus.domain !== null ? ` · ${clusterFocus.domain}` : ''}
          </span>
          <button
            className="btn ghost cb-exit"
            onClick={() => setClusterStack([])}
            title="Back to the full graph (Esc backs out one level at a time)"
          >
            <Icon name="x" /> Full graph
          </button>
        </div>
      )}

      {/* Focus mode as its own row: the neighborhood depth is ONE state, so it reads as one
          segmented control (1 · 2 · whole graph), not four loose chips. */}
      {focusNode && (
        <div className="focusbar">
          <span>
            Focus: <strong>{focusNode.title}</strong>
          </span>
          <span className="seg" role="group" aria-label="Neighborhood depth">
            {([1, 2] as const).map((d) => (
              <button key={d} className={localDepth === d ? 'active' : ''} onClick={() => setLocalDepth(d)}>
                Depth {d}
              </button>
            ))}
            <button className={localDepth === 0 ? 'active' : ''} onClick={() => setLocalDepth(0)}>
              Whole graph
            </button>
          </span>
          <button className="btn ghost" onClick={() => navigate('/graph')} title="Clear focus">
            <Icon name="x" /> Clear
          </button>
        </div>
      )}

          </div>
        )}
        <GraphPanel
          lens={lens}
          onLens={setLens}
          hasDomains={hasDomains}
          types={types}
          selectedTypes={selectedTypes}
          onToggleType={toggleType}
          domains={domainRows}
          selectedDomains={selectedDomains}
          onToggleDomain={toggleDomain}
          onClearDomains={() => setSelectedDomains(new Set())}
          wings={wings}
          wingMode={wingMode.mode}
          onWingMode={wingMode.setMode}
          wing={wing}
          onWing={pickWing}
          active={active}
          showClusters={showClusters}
          onClusters={() => setShowClusters((v) => !v)}
          showNetwork={showNetwork}
          onNetwork={() => setShowNetwork((v) => !v)}
          spotlight={spotlight}
          onSpotlight={() => setSpotlight((v) => !v)}
          showSystem={showSystem}
          onSystem={toggleSystem}
          systemCount={systemCount}
          showGaps={showGaps}
          onGaps={() => {
            const next = !showGaps
            setShowGaps(next)
            if (!next && selection?.kind === 'gap') closeExplorer()
          }}
          gapCount={graph.gaps.length}
          onReset={resetView}
          onFit={() => setFitNonce((n) => n + 1)}
        />
        <div className="graph-main">
      {/* While the search's list is open it has the corner: the minimap steps out of sight. */}
      <div className={`graph-stage${resultsShown ? ' search-open' : ''}`}>
        <GraphCanvas
          view="graph"
          nodes={nodes}
          edges={edges}
          focusIndex={focusIndex}
          selectedIndex={selectedIndex}
          ghostIndices={ghostIndices}
          matches={matches}
          lens={effectiveLens}
          clusters={clusterIds}
          clusterLabels={clusterLabels}
          clusterDomains={clusterDomains}
          showHulls={showClusters}
          network={showNetwork}
          spotlight={spotlight}
          showLabels={!hideLabels}
          // Every filter/depth/gaps change re-frames the graph; SSE live updates don't touch this key.
          // Fullscreen rides along: entering or leaving changes the canvas width by ~40%,
          // and re-fitting through the fitKey also clears `userMoved` - so a graph the user
          // had panned is re-framed too, instead of staying parked off-screen.
          // The tag filter belongs here for the sharpest version of the same reason: it cuts a
          // thousand pages down to a handful, and without a re-fit those few keep the scale the
          // whole vault had and sit in one corner as a speck of their own drawing.
          showFit={false}
          fitKey={`${wing ?? ''}|${[...selectedDomains].sort().join(',')}|${[...selectedTypes].sort().join(',')}|${localDepth}|${focusPath ?? ''}|${showGaps}|${showSystem}|${query.trim()}|${tagFilter?.tag ?? ''}:${tagFilter?.around ?? ''}|${clusterStack.length}:${clusterFocus?.anchor ?? ''}|${fullscreen}|v${visits}|f${fitNonce}`}
          barLeft={
            <span className="scopeline">
              Showing{' '}
              <strong>
                {realCount} of {pagePool}
              </strong>{' '}
              pages
              {/*
                * What the two numbers mean, when they disagree (2026-09-16). A search keeps the
                * pages that MATCH plus their direct neighbours, so a hit is never a dot on its
                * own - and the drawing then holds several times what the result list counts.
                * Reading "3 matches" over nineteen labelled nodes invites exactly one question,
                * and this is the answer to it, in the place the question is asked.
                *
                * `realCount` excludes the ghosts (they are appended after it is taken) and
                * `matches` only ever holds real pages, so the subtraction is sound.
                */}
              {/* The tag itself now stands in the MIDDLE of the bar, where the scope belongs:
                  the left slot is the count, and the two together did not fit on one line. */}
              {matches.size > 0 && realCount > matches.size && (
                <span className="scope-why">
                  {' · '}
                  {matches.size} match{matches.size === 1 ? '' : 'es'} + {realCount - matches.size} neighbour
                  {realCount - matches.size === 1 ? '' : 's'}
                </span>
              )}
            </span>
          }
          barMid={<ScopeMid heading={scopeMid} />}
          barRight={
            /* Search is the control you come back to, and its result list drops out of the
               field - at the end of the bar it has room to. */
            searchOverlay
          }
          onSelect={(n) =>
            n.path.startsWith(GAP_PATH_PREFIX) ? selectGap(n.title) : selectPage(n.path)
          }
          // The spotlight click, on a member node or anywhere in the community's hull: it
          // isolates the community (the hover previews exactly this set) - recursively:
          // inside a focus the ids come from re-detection on the isolated subgraph, so the
          // click drills into a sub-community. It deliberately does NOT open the explorer
          // panel - the click means "zoom in", not "inspect". The canvas only fires this
          // for isolatable communities (spotlight on, proper subset of the visible real
          // nodes) - a level that doesn't subdivide, and any unclustered node, falls back
          // to the plain select above; the subset guard here is belt-and-braces.
          onClusterClick={(cid) => {
            if (clusterIds === null) return
            const paths = new Set<string>()
            let anchor = ''
            nodes.forEach((m, j) => {
              if (clusterIds[j] === cid) {
                if (anchor === '') anchor = m.path
                paths.add(m.path)
              }
            })
            if (paths.size === 0 || paths.size >= realCount) return
            const level: ClusterFocus = {
              paths,
              label: clusterLabels.get(cid) ?? '',
              domain: clusterDomains.get(cid) ?? null,
              anchor,
            }
            setClusterStack((prev) => [...prev, level])
          }}
          // Double-click goes straight to the article; a gap has no page to open, but
          // its explorer panel is already up from the first click of the pair.
          onOpen={(n) => {
            if (!n.path.startsWith(GAP_PATH_PREFIX)) navigate(pageRoute(n.path))
          }}
          // Click on empty canvas: drop the selection (an accidental node tap is undone
          // with one click). Deliberately keeps the trail - only the panel's ✕ resets it.
          onClear={() => setSelection(null)}
          overlay={
            <>
              {query.trim() !== '' && realCount === 0 && (
                <div className="graph-empty" role="status">
                  No pages match “{query.trim()}”.
                  <button className="linkish" onClick={() => setInput('')}>
                    Clear search
                  </button>
                </div>
              )}
              <LensLegend lens={effectiveLens} types={types} />
              {/*
                * Both in the bottom RIGHT corner, side by side: these two are about the canvas
                * rather than about what it shows, and the bottom left belongs to the trail,
                * which walks out from under the panel as you follow links and would sit on top
                * of anything standing there.
                */}
              <div className="canvas-corners">
                <Shortcuts rows={GRAPH_SHORTCUTS} corner />
                <button
                  className="canvas-corner"
                  onClick={() => setFullscreen((v) => !v)}
                  title={fullscreen ? 'Back to the full view (Esc)' : 'Show the graph on its own - Esc returns'}
                >
                  <Icon name={fullscreen ? 'shrink' : 'expand'} /> {fullscreen ? 'Exit' : 'Fullscreen'}
                </button>
              </div>
              {trail.length > 1 && (
                <div className="graph-trail" role="navigation" aria-label="Exploration trail">
                  {trail.map((p, i) => {
                    const n = graph.nodes.find((g) => g.path === p)
                    if (!n) return null
                    const cur = selection?.kind === 'page' && selection.path === p
                    return (
                      <span key={p}>
                        {i > 0 && <span className="trail-arrow" aria-hidden>→</span>}
                        <button className={`crumb${cur ? ' cur' : ''}`} onClick={() => selectPage(p)} title={n.title}>
                          {n.title.length > 22 ? `${n.title.slice(0, 20)}…` : n.title}
                        </button>
                      </span>
                    )
                  })}
                </div>
              )}
            </>
          }
        />
        <GraphExplorer
          graph={graph}
          selection={selection}
          gaps={showGaps ? graph.gaps : []}
          health={health}
          onSelectPage={selectPage}
          onSelectGap={selectGap}
          onTag={(t) => {
            // The path FIRST: closing the explorer clears the selection this reads.
            const around = selection?.kind === 'page' ? selection.path : null
            setTagFilter({ tag: t, around })
            /* And out of the way. The filter answers a question about that page, the answer is
               a handful of nodes, and the panel is a third of the width they would be drawn in
               - the fit that follows should have the room. The page is named in the heading,
               so closing the panel does not lose track of what this is about. */
            closeExplorer()
          }}
          showSystem={showSystem}
          onClose={closeExplorer}
        />
          </div>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------- explorer side panel

/**
 * The node explorer: click a page or a knowledge gap in the graph and browse it as lists.
 * Backlinks, outgoing links and tag-siblings are computed from the FULL graph (not the
 * filtered subgraph), so the panel is complete even when filters hide neighbors. Clicking a
 * link re-selects that page in place - you browse without leaving the graph; "Open page"
 * is the explicit navigation.
 */
function GraphExplorer({
  graph,
  selection,
  gaps,
  health,
  onSelectPage,
  onSelectGap,
  onTag,
  showSystem,
  onClose,
}: {
  graph: VaultGraph
  selection: Selection
  gaps: VaultGraph['gaps']
  health: GraphHealth
  onSelectPage: (path: string) => void
  onSelectGap: (title: string) => void
  onTag: (tag: string) => void
  showSystem: boolean
  onClose: () => void
}): React.ReactElement | null {
  // A ranked gaps list shows when the gaps view is on but nothing specific is selected.
  const showGapList = selection === null && gaps.length > 0
  const open = selection !== null || showGapList
  if (!open) return null

  return (
    <aside className="graph-explorer" role="complementary" aria-label="Graph explorer">
      <button className="gx-close" onClick={onClose} aria-label="Close explorer">
        <Icon name="x" />
      </button>
      {selection?.kind === 'page' ? (
        <PageExplorer graph={graph} path={selection.path} health={health} onSelectPage={onSelectPage} onTag={onTag} showSystem={showSystem} />
      ) : selection?.kind === 'gap' ? (
        <GapExplorer graph={graph} title={selection.title} onSelectPage={onSelectPage} />
      ) : (
        <GapList gaps={gaps} onSelectGap={onSelectGap} />
      )}
    </aside>
  )
}

function PageExplorer({
  graph,
  path,
  health,
  onSelectPage,
  onTag,
  showSystem,
}: {
  graph: VaultGraph
  path: string
  health: GraphHealth
  onSelectPage: (path: string) => void
  /** The overlay's own switch: the lists show what the drawing shows, and nothing else. */
  showSystem: boolean
  /** A tag in the head, pressed: the screen turns it into the search that narrows the graph. */
  onTag: (tag: string) => void
}): React.ReactElement {
  const idx = useMemo(() => graph.nodes.findIndex((n) => n.path === path), [graph, path])
  const node = idx >= 0 ? graph.nodes[idx] : undefined
  /*
   * The link lists follow "Include system pages" (2026-09-16). They used to list every edge
   * whatever the overlay said, so a panel opened over a graph with the system pages hidden
   * still offered `_index`, `index` and `log` at the top of both lists - three rows that are
   * in every page's neighbourhood, that the drawing behind them does not contain, and that
   * push the pages you came for below the fold.
   */
  const visible = (n: GraphNode): boolean => showSystem || isKnowledge(n)
  const backlinks = useMemo(
    () =>
      idx < 0
        ? []
        : graph.edges.filter(([, to]) => to === idx).map(([from]) => graph.nodes[from]!).filter(visible).sort(byTitle),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, idx, showSystem],
  )
  const outgoing = useMemo(
    () =>
      idx < 0
        ? []
        : graph.edges.filter(([from]) => from === idx).map(([, to]) => graph.nodes[to]!).filter(visible).sort(byTitle),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, idx, showSystem],
  )
  // Tag rarity across the vault: a tag on half the pages is near-worthless as a "related"
  // signal, one on three pages is a strong one. IDF weight = log(N / df); a tag on every page
  // scores 0 and drops out on its own, so no fixed denylist has to keep pace with the vault.
  const tagIdf = useMemo(() => {
    const df = new Map<string, number>()
    let n = 0
    for (const nd of graph.nodes) {
      if (!isKnowledge(nd)) continue
      n++
      for (const t of new Set(nd.tags.filter(isThematicTag))) df.set(t, (df.get(t) ?? 0) + 1)
    }
    const idf = new Map<string, number>()
    for (const [t, count] of df) idf.set(t, Math.log(n / count))
    return idf
  }, [graph])

  // Related by shared tag, excluding pages already linked either way - the tag axis surfaces
  // neighbors the wikilinks don't. Structural tags (`#source`, …) carry no subject and are
  // dropped; candidates are ranked by summed IDF of the shared thematic tags so the closest
  // neighbors win, not the alphabetically-first ones. Capped so the panel stays a summary.
  const related = useMemo(() => {
    if (!node) return []
    const own = node.tags.filter(isThematicTag)
    if (own.length === 0) return []
    const weight = new Map(own.map((t) => [t, tagIdf.get(t) ?? 0]))
    const linked = new Set([path, ...backlinks.map((n) => n.path), ...outgoing.map((n) => n.path)])
    return graph.nodes
      // The same overlay as the two lists above it. It sits in the same panel and answers the
      // same kind of question, so hiding system pages in two of three lists would be the
      // arbitrary half of a rule.
      .filter((n) => !linked.has(n.path) && visible(n))
      .map((n) => {
        let score = 0
        for (const t of new Set(n.tags)) score += weight.get(t) ?? 0
        return { node: n, score }
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || byTitle(a.node, b.node))
      .slice(0, 6)
      .map((c) => c.node)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, node, path, backlinks, outgoing, tagIdf, showSystem])

  // ---- graph repair (deterministic findings for THIS page → one bounded agent run) ----
  const qc = useQueryClient()
  const isolated = health.isolated.has(path)
  const suspicious = health.suspiciousByPage.get(path) ?? []
  const [repairId, setRepairId] = useState<string | null>(null)
  useEffect(() => setRepairId(null), [path])
  const startRepair = useMutation({
    mutationFn: (tasks: RepairTask[]) => api.graphRepair(tasks),
    onSuccess: (run) => setRepairId(run.id),
  })
  const repairQ = useQuery({
    queryKey: ['maintenance-run', repairId],
    queryFn: () => api.maintenanceRun(repairId!),
    enabled: repairId !== null,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'running' ? false : 2000),
  })
  const repairRun = repairQ.data
  const repairRunning = repairId !== null && (repairRun === undefined || repairRun.status === 'running')
  useEffect(() => {
    if (repairRun?.status === 'done') {
      // The run edited pages and committed - refresh everything derived from the vault.
      void qc.invalidateQueries({ queryKey: ['graph'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    }
  }, [repairRun?.status, qc])
  const repairTasks = (): RepairTask[] => {
    const tasks: RepairTask[] = []
    if (isolated) {
      tasks.push({ kind: 'connect', path, reason: 'isolated: no links to or from any knowledge page' })
    }
    for (const e of suspicious) {
      tasks.push({
        kind: 'edge',
        from: e.from.path,
        to: e.to.path,
        reason: `the only link between the domains "${e.from.domain ?? '?'}" and "${e.to.domain ?? '?'}"`,
      })
    }
    return tasks.slice(0, 10)
  }

  if (!node) return <div className="gx-empty">This page is no longer in the graph.</div>

  return (
    <>
      <div className="gx-head">
        <div className="gx-kicker">{TYPE_LABELS[node.type] ?? node.type}</div>
        <h2 className="gx-title">{node.title}</h2>
        <div className="gx-tags">
          {node.domain && (
            <span className="gx-tag dom" style={{ borderColor: domainColor(node.domain), color: domainColor(node.domain) }}>
              {node.domain}
            </span>
          )}
          {/*
            * A tag is a filter you can press (2026-09-16). The search already matches tags -
            * it always has - so a click is the query for that tag and nothing new has to be
            * taught to the graph: the drawing narrows to the pages carrying it, with their
            * direct neighbours for context, the same as typing it would.
            */}
          {node.tags.map((t) => (
            <button key={t} className="gx-tag pressable" onClick={() => onTag(t)} title={`Show the pages tagged #${t}`}>
              #{t}
            </button>
          ))}
        </div>
      </div>
      <div className="gx-metrics">
        <div className="gx-metric"><span className="v">{node.in}</span><span className="l">backlinks</span></div>
        <div className="gx-metric"><span className="v">{node.out}</span><span className="l">links out</span></div>
      </div>
      {(isolated || suspicious.length > 0) && (
        <div className="gx-health" role="status">
          <div className="gx-health-head">Graph health</div>
          {isolated && (
            <p>
              Isolated: no knowledge page links here or is linked from here - the page is
              invisible to graph exploration.
            </p>
          )}
          {suspicious.map((e) => (
            <p key={`${e.from.path}→${e.to.path}`}>
              <button className="gx-link inline" onClick={() => onSelectPage(e.from.path)}>{e.from.title}</button>
              {' → '}
              <button className="gx-link inline" onClick={() => onSelectPage(e.to.path)}>{e.to.title}</button>
              {' is the only link between '}
              <strong>{e.from.domain}</strong> and <strong>{e.to.domain}</strong> - possibly an
              incidental aside rather than knowledge.
            </p>
          ))}
          {repairId === null && (
            <div className="gx-health-act">
              <button
                className="btn"
                disabled={startRepair.isPending}
                onClick={() => startRepair.mutate(repairTasks())}
                title="A bounded agent run: weaves an isolated page into the graph and/or reviews the flagged link. Edits only the pages involved - one revertable commit."
              >
                {startRepair.isPending ? 'Starting…' : 'Repair (agent run)'}
              </button>
              {startRepair.isError && (
                <span className="gx-health-err">{(startRepair.error as Error).message}</span>
              )}
            </div>
          )}
          {repairRunning && <p className="dim">Repair is running - the agent edits only the pages involved…</p>}
          {repairRun?.status === 'done' && (
            <p>
              Repair finished: {repairRun.result?.pages.length ?? 0} page
              {(repairRun.result?.pages.length ?? 0) === 1 ? '' : 's'} changed (one revertable commit).
            </p>
          )}
          {repairRun?.status === 'error' && (
            <div className="gx-health-act">
              <span className="gx-health-err">Repair failed: {repairRun.error ?? 'unknown error'}</span>
              <button className="btn" onClick={() => setRepairId(null)}>Retry</button>
            </div>
          )}
        </div>
      )}
      {/*
        * Equal shares, each scrolling on its own (2026-09-16). One scroll over all three meant
        * a page with forty backlinks pushed "Links to" and "Related by tag" out of the panel
        * entirely - you could not tell whether they were empty or merely below. The modifier
        * is on this body alone: the gap explorer's has one list and the gap list is a list.
        */}
      <div className="gx-body thirds">
        <LinkSection title="Backlinks" list={backlinks} onSelect={onSelectPage} />
        <LinkSection title="Links to" list={outgoing} onSelect={onSelectPage} />
        <LinkSection title="Related by tag" list={related} onSelect={onSelectPage} />
      </div>
      <div className="gx-actions">
        <button className="btn" onClick={() => navigate(`/graph?focus=${encodeURIComponent(node.path)}`)}>
          Focus neighborhood
        </button>
        {/*
          * No link glyph. It always opened the page IN the dashboard - the same route a
          * double-click on the node takes - but the outbound arrow read as "this leaves for
          * Obsidian", which is a promise about somewhere else entirely.
          */}
        <button className="btn primary" onClick={() => navigate(pageRoute(node.path))}>
          Open page
        </button>
      </div>
    </>
  )
}

function GapExplorer({
  graph,
  title,
  onSelectPage,
}: {
  graph: VaultGraph
  title: string
  onSelectPage: (path: string) => void
}): React.ReactElement {
  const gap = graph.gaps.find((g) => g.title === title)
  const refPages = useMemo(
    () => (gap ? gap.refBy.map((i) => graph.nodes[i]!).sort(byTitle) : []),
    [graph, gap],
  )
  if (!gap) return <div className="gx-empty">This link is resolved now.</div>
  // A CLEAN topic (just the page name): the research pipeline pins its synthesis-page title
  // to `Research: <topic><lens suffix>`, so instruction prose here would end up IN the title.
  const prefill = gap.title
  return (
    <>
      <div className="gx-head">
        <div className="gx-kicker gap">Knowledge gap · missing page</div>
        <h2 className="gx-title">{gap.title}</h2>
        <div className="gx-tags">
          <span className="gx-tag">
            {gap.refBy.length} unresolved link{gap.refBy.length === 1 ? '' : 's'} point here
          </span>
        </div>
      </div>
      <div className="gx-note">
        No page named <strong>“{gap.title}”</strong> exists yet, but {gap.refBy.length} page
        {gap.refBy.length === 1 ? '' : 's'} already link to it - the vault telling you what to write next.
      </div>
      <div className="gx-body">
        <LinkSection title="Referenced by" list={refPages} onSelect={onSelectPage} />
      </div>
      <div className="gx-actions">
        <button
          className="btn primary"
          onClick={() => navigate(`/research?prefill=${encodeURIComponent(prefill)}`)}
        >
          Start research on this <Icon name="link" />
        </button>
      </div>
    </>
  )
}

function GapList({
  gaps,
  onSelectGap,
}: {
  gaps: VaultGraph['gaps']
  onSelectGap: (title: string) => void
}): React.ReactElement {
  // The second way out of a gap: pick it for unlinking (moved here from Home, 2026-09-11).
  const cleanup = useGapCleanup(gaps)
  const total = gaps.reduce((s, g) => s + g.refBy.length, 0)
  // Server ranks by knowledge referrers first, so the top row need not have the most links.
  const max = gaps.reduce((m, g) => Math.max(m, g.refBy.length), 1)
  return (
    <>
      <div className="gx-head">
        <div className="gx-kicker gap">Knowledge gaps</div>
        <h2 className="gx-title">Most-wanted missing pages</h2>
        <div className="gx-tags">
          <span className="gx-tag">
            {total} unresolved link{total === 1 ? '' : 's'} · {gaps.length} distinct target{gaps.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <div className="gx-note">
        Every dashed node is a page other pages link to but that doesn’t exist yet - ranked by how
        many content pages are waiting. A ready-made research backlog.
      </div>
      <div className="gx-body">
        <GapCleanupBar c={cleanup} />
        <ol className="gx-gaplist">
          {gaps.map((g, i) => {
            const on = cleanup.live.includes(g.title)
            return (
              <li key={g.title} className={on ? 'picked' : ''}>
                <button className="gx-gaprow" onClick={() => onSelectGap(g.title)}>
                  <span className="rank">{i + 1}</span>
                  <span className="gtitle">{g.title}</span>
                  <span className="meter" aria-hidden>
                    <i style={{ width: `${Math.round((g.refBy.length / max) * 100)}%` }} />
                  </span>
                  <span className="gn">{g.refBy.length}</span>
                </button>
                {/* Shown on hover, focus, or once picked - a row of idle controls would say
                    "delete things" louder than the list means to. */}
                <button
                  className={`gx-gappick${on ? ' on' : ''}`}
                  aria-pressed={on}
                  aria-label={on ? `Unpick ${g.title}` : `Pick ${g.title} for unlinking`}
                  title={on ? 'Picked for unlinking' : 'Pick: this should not become a page, unlink it instead'}
                  disabled={cleanup.running}
                  onClick={() => cleanup.toggle(g.title)}
                >
                  <Icon name={on ? 'check' : 'x'} />
                </button>
              </li>
            )
          })}
        </ol>
      </div>
    </>
  )
}

const byTitle = (a: GraphNode, b: GraphNode): number => a.title.localeCompare(b.title)

/** One titled list of pages in the explorer; nothing renders when the list is empty. */
function LinkSection({
  title,
  list,
  onSelect,
}: {
  title: string
  list: GraphNode[]
  onSelect: (path: string) => void
}): React.ReactElement | null {
  if (list.length === 0) return null
  return (
    <div className="gx-sec">
      <h3>
        {title} <span className="c">{list.length}</span>
      </h3>
      <ul>
        {list.map((n) => (
          <li key={n.path}>
            <button className="gx-link" onClick={() => onSelect(n.path)} title={n.path}>
              <span className="bullet" style={{ background: n.domain ? domainColor(n.domain) : 'var(--muted)' }} />
              {n.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The graph's VIEW PANEL - the structural half of the graph rework (2026-08-24).
 *
 * It replaces four stacked control rows above the canvas (the view bar, the domain band,
 * and the two dropdowns inside them) with one standing column beside it. Three reasons:
 *
 *  1 The canvas gets its height back. Four rows of chrome, plus the cluster and focus bars
 *    when they appear, pushed the drawing into the lower half of the screen.
 *  2 Every parameter is visible at once. The colour lens - the control that decides which
 *    question the graph answers - used to sit inside a dropdown, while the four overlay
 *    toggles sat permanently open. That is the priority upside down.
 *  3 A column grows downward, so the domain list (the one control that grows with the
 *    vault) can take the leftover height and scroll on its own, instead of forcing the
 *    whole toolbar to reflow.
 *
 * What still folds: the diagnostic lenses and the two include-toggles. Both say what is on
 * inside them when collapsed - a fold that hides the state in force is worse than no fold.
 */
function GraphPanel({
  lens,
  onLens,
  hasDomains,
  types,
  selectedTypes,
  onToggleType,
  domains,
  selectedDomains,
  onToggleDomain,
  onClearDomains,
  wings,
  wingMode,
  onWingMode,
  wing,
  onWing,
  active,
  showClusters,
  onClusters,
  showNetwork,
  onNetwork,
  spotlight,
  onSpotlight,
  showSystem,
  onSystem,
  systemCount,
  showGaps,
  onGaps,
  gapCount,
  onReset,
  onFit,
}: {
  lens: Lens
  onLens: (l: Lens) => void
  hasDomains: boolean
  types: Array<[string, number]>
  selectedTypes: ReadonlySet<string>
  onToggleType: (t: string) => void
  /** In the flat list's order. */
  domains: ReadonlyArray<readonly [string, number]>
  selectedDomains: ReadonlySet<string>
  onToggleDomain: (d: string) => void
  onClearDomains: () => void
  wings: readonly WingGroup[]
  wingMode: WingListMode
  onWingMode: (mode: WingListMode) => void
  wing: string | null
  onWing: (id: string) => void
  active: boolean
  showClusters: boolean
  onClusters: () => void
  showNetwork: boolean
  onNetwork: () => void
  spotlight: boolean
  onSpotlight: () => void
  showSystem: boolean
  onSystem: () => void
  systemCount: number
  showGaps: boolean
  onGaps: () => void
  gapCount: number
  onReset: () => void
  /** Re-frame the drawing. The action, not a state - the strip flashes rather than latches. */
  onFit: () => void
}): React.ReactElement {
  const includeOn = (showSystem ? 1 : 0) + (showGaps ? 1 : 0)
  /** Hovering a pill previews its meaning; leaving falls back to the one in force. */
  const [lensPreview, setLensPreview] = useState<Lens | null>(null)
  const shownLens = LENSES.find((l) => l.key === (lensPreview ?? lens)) ?? LENSES[0]!

  /*
   * The action strip's acknowledgement. An action has no state to show, so the half lights for
   * a moment and goes out - long enough to read as "that one", short enough that nobody reads
   * it as "that one is on". The timer is cleared on the next press and on unmount, so a quick
   * double press cannot leave a half lit behind it.
   */
  const [flash, setFlash] = useState<'reset' | 'fit' | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (flashTimer.current !== null) clearTimeout(flashTimer.current) }, [])
  const blink = (which: 'reset' | 'fit'): void => {
    if (flashTimer.current !== null) clearTimeout(flashTimer.current)
    setFlash(which)
    flashTimer.current = setTimeout(() => setFlash(null), 260)
  }

  const label = (d: string): string => (d === NO_DOMAIN ? 'no domain' : d)

  return (
    <aside className="gpanel" aria-label="Graph view controls">
      {/*
        * The panel's two ACTIONS, above everything that is a setting (2026-09-16). They wear
        * the lens strip's shape because they stand in the same column and a second shape for
        * two buttons would be a second vocabulary - but they are not a choice, so neither half
        * latches. A press flashes and lets go, which is the whole difference between "this is
        * how the graph is drawn" and "do this to the graph now".
        */}
      <div className="gp-sec gp-sec-actions">
        <div className="lib-strip gp-lens gp-actions">
          <button
            className={`rp${flash === 'reset' ? ' on' : ''}`}
            onClick={() => {
              onReset()
              blink('reset')
            }}
            title="Back to the whole vault, coloured by domain: filters, lens, overlays, drill-down and search"
          >
            Reset filters
          </button>
          <button
            className={`rp${flash === 'fit' ? ' on' : ''}`}
            onClick={() => {
              onFit()
              blink('fit')
            }}
            title="Frame the drawing to what it is showing · f"
          >
            Fit graph
          </button>
        </div>
      </div>

      <div className="gp-sec">
        <div className="gp-head">
          <span className="gp-eyebrow">Overlays</span>
        </div>
        <div className="gp-toggles">
          <RowToggle
            on={showClusters}
            onToggle={onClusters}
            name="Areas"
            desc="tinted hull per community"
            title="Outline each auto-detected community as a tinted, tag-labelled hull - which pages group together."
          />
          <RowToggle
            on={showNetwork}
            onToggle={onNetwork}
            name="Bridges"
            desc="brighten links between communities"
            title="Brighten the connections. Intra-community links lift into view; cross-community bridges show link direction as a colour gradient with an arrowhead."
          />
          <RowToggle
            on={spotlight}
            onToggle={onSpotlight}
            name="Spotlight"
            desc="hover isolates one community"
            title="Hovering highlights a whole community and dims the rest. Click inside a cluster's area to isolate it (and keep drilling into sub-communities); click a node to open its page. Esc backs out one level."
          />
        </div>
        <Fold label="Include" state={includeOn === 0 ? 'none' : `${includeOn} on`} lit={includeOn > 0} openWhen={includeOn > 0}>
          <div className="gp-toggles">
            <RowToggle
              on={showSystem}
              onToggle={onSystem}
              name="System pages"
              desc="index hubs, MOCs, reports"
              count={systemCount}
              title="Index hubs, MOCs and the domain registry, plus maintenance artifacts (lint/release reports, session logs). Hidden by default - they organize or document the vault rather than hold knowledge."
            />
            <RowToggle
              on={showGaps}
              onToggle={onGaps}
              name="Gaps"
              desc="unwritten link targets, as ghosts"
              count={gapCount}
              title="Show unresolved links as ghost nodes - the pages your vault still wants written."
            />
          </div>
        </Fold>
      </div>

      <div className="gp-sec">
        <div className="gp-head">
          <span className="gp-eyebrow">View</span>
        </div>
        {/*
          * Three strips instead of six pills (2026-09-16). The six were a radio group already -
          * exactly one lens colours the graph - but read as six independent switches, and six
          * of anything in a column reads as a list to work through rather than a choice to make.
          * Paired, each strip is one question: by what kind, by what measure, by what is wrong.
          *
          * The radio stays the radio: picking either half of any strip turns the other five off,
          * so the two strips that are not carrying the lens show both halves plain. That is
          * honest - nothing in them is active - and it is what the intake's own strip does
          * before the first choice.
          */}
        <div className="gp-lenses" role="radiogroup" aria-label="Colour by">
          {LENS_PAIRS.map(([a, b]) => (
            <div className="lib-strip gp-lens" key={a}>
              {[a, b].map((key) => {
                const l = LENSES.find((x) => x.key === key)!
                return (
                  <button
                    key={key}
                    className={`rp${lens === key ? ' on' : ''}`}
                    role="radio"
                    aria-checked={lens === key}
                    disabled={key === 'domain' && !hasDomains}
                    title={l.desc}
                    onClick={() => onLens(key)}
                    onMouseEnter={() => setLensPreview(key)}
                    onMouseLeave={() => setLensPreview(null)}
                    onFocus={() => setLensPreview(key)}
                    onBlur={() => setLensPreview(null)}
                  >
                    {l.label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <div className="pillhint">{shownLens.desc}</div>
      </div>

      <div className="gp-sec">
        <div className="gp-head">
          <span className="gp-eyebrow">Page types</span>
          <span className="spacer" />
          <span className="gp-state">{selectedTypes.size === 0 ? 'all' : `${selectedTypes.size} of ${types.length}`}</span>
        </div>
        {/* One type per row (2026-09-14). Wrapped, the labels broke into a ragged block whose
            height changed with the type mix, and the counts ended wherever each label
            happened to stop; as rows they read as the list they are. Same shape the panel's
            stacked pills already use elsewhere. */}
        <div className="typechips stacked">
          {types.map(([t, count]) => {
            const active = selectedTypes.has(t)
            return (
              <button
                key={t}
                className={`chip${active ? ' active' : ''}${selectedTypes.size > 0 && !active ? ' dimmed' : ''}`}
                aria-pressed={active}
                onClick={() => onToggleType(t)}
                title={active ? `Remove ${TYPE_LABELS[t] ?? t}` : selectedTypes.size === 0 ? 'Show only this type' : `Add ${TYPE_LABELS[t] ?? t}`}
              >
                <span className="chip-dot" style={{ background: `var(${TYPE_VARS[t] ?? '--type-meta'})` }} aria-hidden />
                {TYPE_LABELS[t] ?? t} <span className="chip-n">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* The list is for FINDING a domain, so it comes alphabetical (the old band ordered by
          size, which is right for a legend and wrong for a lookup), or one wing at a time. */}
      {hasDomains && (
        <DomainSection
          domains={domains}
          label={label}
          color={(d) => (d === NO_DOMAIN ? 'var(--muted)' : domainColor(d))}
          selected={selectedDomains}
          onToggle={onToggleDomain}
          onClear={onClearDomains}
          groups={wings}
          mode={wingMode}
          onMode={onWingMode}
          wing={wing}
          onWing={onWing}
          active={active}
          rowTitle={(d, on) =>
            on
              ? selectedDomains.size === 1
                ? 'Deselect - back to all domains'
                : `Remove ${label(d)} from the filter`
              : selectedDomains.size === 0
                ? 'Show only this domain'
                : `Add ${label(d)} to the current selection`
          }
        />
      )}
    </aside>
  )
}

/** A binary view option as a switch row: name, one line of why, optional count. */
function RowToggle({
  on,
  onToggle,
  name,
  desc,
  count,
  title,
}: {
  on: boolean
  onToggle: () => void
  name: string
  desc: string
  count?: number
  title: string
}): React.ReactElement {
  return (
    <button className="rowtoggle" aria-pressed={on} onClick={onToggle} title={title}>
      <span className="sw" aria-hidden />
      <span className="rt-text">
        <span className="tname">{name}</span>
        <span className="tdesc">{desc}</span>
      </span>
      {count !== undefined && <span className="tn">{count}</span>}
    </button>
  )
}

/**
 * A disclosure for controls that are reached for rather than browsed. `state` is shown on
 * the closed summary and `lit` colours it, so a collapsed fold can never hide the fact that
 * something inside it is switched on. `openWhen` forces it open when that happens.
 */
function Fold({
  label,
  state,
  lit,
  openWhen,
  children,
}: {
  label: string
  state: string
  lit: boolean
  openWhen: boolean
  children: React.ReactNode
}): React.ReactElement {
  const [open, setOpen] = useState(openWhen)
  // Something inside became active (via reset, restore or a keyboard path) - show it.
  useEffect(() => {
    if (openWhen) setOpen(true)
  }, [openWhen])
  return (
    <div className={`fold${open ? ' open' : ''}`}>
      <button className="fold-summary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="caret" aria-hidden />
        {label}
        <span className={`fold-state${lit ? ' lit' : ''}`}>{state}</span>
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  )
}

/**
 * The colour lenses, as pills. Each description says what the COLOUR means, in the same
 * grammar and - load-bearing - on ONE line: the hint sits above the rest of the panel, so
 * a description that wraps for some lenses and not others makes everything below it jump
 * as the pointer crosses the row. The pill carries the name, so the hint never repeats it.
 */
/**
 * The six, two at a time, in the order the panel offers them: by what kind of thing a page is,
 * by what measure it carries, by what is wrong with it. The pairing is the panel's, not the
 * model's - the lens is still one of six and the radio still spans all three strips.
 */
const LENS_PAIRS: ReadonlyArray<readonly [Lens, Lens]> = [
  ['domain', 'type'],
  ['authority', 'recency'],
  ['orphans', 'stubs'],
]

const LENSES: Array<{ key: Lens; label: string; desc: string }> = [
  { key: 'domain', label: 'Domain', desc: 'one colour per field of knowledge' },
  { key: 'authority', label: 'Authority', desc: 'brighter = more pages link here' },
  { key: 'recency', label: 'Recency', desc: 'green = edited recently' },
  { key: 'type', label: 'Page type', desc: 'a colour per wiki bucket' },
  { key: 'orphans', label: 'Orphans', desc: 'red = nothing links here' },
  { key: 'stubs', label: 'Stubs', desc: 'amber = thin page, under 1 KB' },
]

/**
 * A small canvas-corner legend (bottom-right). The metric lenses each get a one-line key; the
 * `type` lens gets a swatch per page-type color present. The `domain` lens has no legend here -
 * the domain filter chips at the top ARE its legend. `types` is the [type, count] list of what
 * is currently visible, so the legend lists only colors actually on screen.
 */
function LensLegend({
  lens,
  types,
}: {
  lens: Lens
  types: Array<[string, number]>
}): React.ReactElement | null {
  let body: React.ReactNode = null
  if (lens === 'type') {
    // Distinct color buckets present, in a stable order; everything without its own color
    // (meta, references, comparisons, folds, …) collapses to one muted "Meta / other" row -
    // mirroring colorFor(), which paints exactly those buckets muted.
    const present = new Set(types.map(([t]) => t))
    const colored = Object.entries(TYPE_VARS).filter(([, v]) => v !== '--muted')
    const rows = colored
      .filter(([t]) => present.has(t))
      .map(([t, cssVar]) => ({ label: TYPE_LABELS[t] ?? t, cssVar }))
    const coloredKeys = new Set(colored.map(([t]) => t))
    if (types.some(([t]) => !coloredKeys.has(t))) rows.push({ label: 'Meta / other', cssVar: '--muted' })
    body =
      rows.length > 0 ? (
        <>
          <span className="ll-title">Page type</span>
          {rows.map((r) => (
            <span className="ll-row" key={r.label}>
              <i className="ll-sw" style={{ background: `var(${r.cssVar})` }} /> {r.label}
            </span>
          ))}
        </>
      ) : null
  } else if (lens === 'authority')
    body = (
      <>
        <span className="ll-title">Authority</span>
        <span className="ll-row"><i className="ll-grad ll-authority" /> few → many backlinks</span>
      </>
    )
  else if (lens === 'orphans')
    body = (
      <>
        <span className="ll-title">Orphans</span>
        <span className="ll-row"><i className="ll-sw" style={{ background: 'var(--err)' }} /> no backlinks (unreachable)</span>
      </>
    )
  else if (lens === 'stubs')
    body = (
      <>
        <span className="ll-title">Stubs</span>
        <span className="ll-row"><i className="ll-sw" style={{ background: 'var(--warn)' }} /> thin page (&lt; 1 KB)</span>
      </>
    )
  else if (lens === 'recency')
    body = (
      <>
        <span className="ll-title">Recency</span>
        <span className="ll-row"><i className="ll-grad ll-recency" /> older → edited recently</span>
      </>
    )
  if (body === null) return null
  return <div className="lens-legend">{body}</div>
}

// ---------------------------------------------------------------------------- page view

function PageView({ graph, path }: { graph: VaultGraph; path: string }): React.ReactElement {
  const qc = useQueryClient()
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'
  const pageQ = useQuery({ queryKey: ['page-full', path], queryFn: () => api.pageFull(path), staleTime: 30_000 })

  // ---- editing (SPEC.md §12.4 as amended: every dashboard mutation is one git commit) ----
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (deleteTimer.current) clearTimeout(deleteTimer.current)
  }, [])

  // Advisory findings the server's post-edit validation returned for THIS page (the edit
  // itself has landed either way). Cleared when navigating to another page.
  const [saveFindings, setSaveFindings] = useState<ValidationFinding[]>([])
  useEffect(() => setSaveFindings([]), [path])

  /**
   * The optimistic lock's reference point, taken WITH the draft and never refreshed on its own.
   *
   * It used to be read from the live query at save time (`pageQ.data?.mtime`), which made it
   * follow the very thing it locks against: any refetch between opening the editor and saving
   * moved it past the change it exists to catch, and the save then overwrote that change in
   * silence. `useEvents.ts` closes one of those doors deliberately (no `page-full`
   * invalidation on a vault event) - but a reference point that can move at all leaves the
   * rest of them open. Measured 2026-09-16: one such save dropped four marks the service had
   * written into the reading list, and a Fellow was told the same thing twice two nights later.
   */
  const [baseMtime, setBaseMtime] = useState<string | null>(null)

  const save = useMutation({
    /*
     * `force` is the informed overwrite after a conflict: it takes a FRESH lock rather than no
     * lock, so a third change landing between the reload and the save still conflicts.
     *
     * Fetched straight from the API and NOT through the query cache: `fetchQuery` honours
     * `staleTime`, so within 30 seconds it hands back the very mtime that just lost the
     * conflict and the overwrite 409s against itself. Measured, the first time this path was
     * run end to end.
     */
    mutationFn: async (opts: { force?: boolean } = {}) => {
      const lock = opts.force === true ? (await api.pageFull(path)).mtime : baseMtime
      // No lock is not a fallback. A page whose mtime never arrived is a page this editor
      // cannot safely write, and saying so beats writing blind.
      if (lock === null || lock === undefined) throw new Error('this page was not fully loaded - reopen it before saving')
      return api.savePage(path, draft, lock)
    },
    onSuccess: (res) => {
      setEditing(false)
      setBaseMtime(null)
      setSaveFindings(res.validation ?? [])
      void qc.invalidateQueries({ queryKey: ['page-full', path] })
      void qc.invalidateQueries({ queryKey: ['page', path] }) // the citation-preview cache
      void qc.invalidateQueries({ queryKey: ['graph'] }) // links may have changed
      void qc.invalidateQueries({ queryKey: ['stats'] }) // a commit landed
    },
  })
  const saveConflict = save.isError && (save.error as Error).message.startsWith('409')

  const del = useMutation({
    mutationFn: () => api.deletePage(path),
    onSuccess: (res) => {
      // Feed the lint-guidance banner: these backlinks just went dangling.
      staleLinks.add(res.staleLinks, pageQ.data?.title ?? path)
      void qc.invalidateQueries({ queryKey: ['graph'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
      navigate('/graph')
    },
  })

  const startEdit = (): void => {
    // Both halves of the edit come from the same load: the text, and the mtime that dates it.
    const loaded = pageQ.data
    if (loaded === undefined) return
    setDraft(loaded.markdown)
    setBaseMtime(loaded.mtime ?? null)
    save.reset()
    setEditing(true)
  }

  /**
   * Unsaved-draft guard. Every way out of the editor used to drop the draft silently: the
   * back button, "In graph", the sidebar, browser back, Cancel. `dirty` drives a visible
   * badge, an armed Cancel and a beforeunload prompt; `leaveEditor` is what every in-app
   * exit path asks first.
   */
  const dirty = editing && draft !== (pageQ.data?.markdown ?? '')
  const [confirmLeave, setConfirmLeave] = useState(false)
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
  useEffect(() => {
    if (!confirmLeave) return
    const t = setTimeout(() => setConfirmLeave(false), 4000)
    return () => clearTimeout(t)
  }, [confirmLeave])
  /** Returns true when the caller may proceed; otherwise it armed the confirm. */
  const leaveEditor = (): boolean => {
    if (!dirty) {
      setEditing(false)
      return true
    }
    if (!confirmLeave) {
      setConfirmLeave(true)
      return false
    }
    setConfirmLeave(false)
    setEditing(false)
    return true
  }
  const requestDelete = (): void => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      deleteTimer.current = setTimeout(() => setConfirmDelete(false), 4000)
      return
    }
    if (deleteTimer.current) clearTimeout(deleteTimer.current)
    setMenuOpen(false)
    del.mutate()
  }

  // The ⋯ overflow menu: destructive/rare actions live here, not as bare icons in the
  // head row (the old delete-✕ sat directly beside Edit).
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])
  const [copiedPath, setCopiedPath] = useState(false)

  // Escape leaves the page for the screen it was opened from (library, graph, wherever) -
  // `originPath()` tracks the last non-page route. After a chain of wikilink hops one press
  // still means "out to that screen", not one step back per hop. The back BUTTON does
  // exactly the same thing, so the two gestures can't disagree (they used to: the button
  // ran history.back and could leave the screen entirely). Inert while editing - Escape
  // must never cost a draft - and while typing or a menu is open; gated on this screen
  // being visible (screens stay mounted, hidden via [hidden]).
  const rootRef = useRef<HTMLDivElement>(null)
  const escRef = useRef<(e: KeyboardEvent) => void>(() => {})
  escRef.current = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (rootRef.current === null || rootRef.current.offsetParent === null) return
    if (editing) return
    const el = e.target as HTMLElement
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable) return
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    e.preventDefault()
    navigate(originPath())
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => escRef.current(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Title → path map for resolving clicked wikilinks - same first-wins, case-insensitive
  // rule as the server, so the viewer and the graph can never disagree.
  const byTitle = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of graph.nodes) {
      const key = n.title.toLowerCase()
      if (!m.has(key)) m.set(key, n.path)
    }
    return m
  }, [graph])

  const nodeIndex = useMemo(() => graph.nodes.findIndex((n) => n.path === path), [graph, path])
  /** Which of the two link lists the sidebar shows; the toggle above it switches them. */
  const [side, setSide] = useState<'backlinks' | 'outgoing'>('backlinks')
  const backlinks = useMemo(() => {
    if (nodeIndex < 0) return []
    return graph.edges
      .filter(([, to]) => to === nodeIndex)
      .map(([from]) => graph.nodes[from]!)
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [graph, nodeIndex])
  const outgoing = useMemo(() => {
    if (nodeIndex < 0) return []
    return graph.edges
      .filter(([from]) => from === nodeIndex)
      .map(([, to]) => graph.nodes[to]!)
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [graph, nodeIndex])

  const node = nodeIndex >= 0 ? graph.nodes[nodeIndex] : undefined
  /** Renders one wikilink target as an in-app link, or plain text when it resolves to nothing. */
  const linkTo = (target: string, label: string, key: string): React.ReactNode => {
    const resolved = byTitle.get(target.toLowerCase())
    return resolved !== undefined ? (
      <a
        key={key}
        className="wikilink"
        href={pageRoute(resolved)}
        onClick={(e) => {
          e.preventDefault()
          navigate(pageRoute(resolved))
        }}
      >
        {label}
      </a>
    ) : (
      <span key={key} className="wikilink unresolved" title="This page doesn't exist (yet)">
        {label}
      </span>
    )
  }
  const parsed = useMemo(
    () => (pageQ.data ? frontmatter(pageQ.data.markdown) : { fields: [], body: '' }),
    [pageQ.data],
  )

  // What the back gesture is called: it names the screen this page was opened from, so the
  // hint can never promise a destination the key does not go to.
  const origin = originPath().split('?')[0]!
  const backLabel = origin.startsWith('/catalog')
    ? 'library'
    : origin.startsWith('/research')
      ? 'research'
      : origin.startsWith('/system')
        ? 'system'
        : origin === '/'
          ? 'home'
          : 'graph'

  return (
    <div className="vault-page" ref={rootRef}>
      <div className="page-head">
        <button
          className="btn ghost"
          onClick={() => {
            if (editing && !leaveEditor()) return
            navigate(originPath())
          }}
          title={`Back to the ${backLabel} (same as Esc)`}
        >
          <Icon name="back" />
        </button>
        {/* Two lines at most, then an ellipsis; the whole title is on hover. The buttons
            keep their place whatever the title's length. */}
        <h1 title={pageQ.data?.title ?? node?.title ?? path.split('/').pop()?.replace(/\.md$/, '')}>
          {pageQ.data?.title ?? node?.title ?? path.split('/').pop()?.replace(/\.md$/, '')}
        </h1>
        {node && <span className="bucket">{TYPE_LABELS[node.type] ?? node.type}</span>}
        {dirty && (
          <span className="dirty-badge" role="status">
            <Icon name="edit" /> Unsaved changes
          </span>
        )}
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => {
            if (editing && !leaveEditor()) return
            navigate(`/graph?focus=${encodeURIComponent(path)}`)
          }}
          title="Focus this page in the graph"
        >
          <Icon name="graph" /> In graph
        </button>
        <button
          className="btn"
          onClick={() => {
            if (editing && !leaveEditor()) return
            navigate(catalogPageRoute(path))
          }}
          title="Read this page in the Catalog"
        >
          <Icon name="book" /> In catalog
        </button>
        {!editing && pageQ.data && (
          <button className="btn" onClick={startEdit} disabled={pageQ.data === undefined} title="Edit page (every change becomes a git commit)">
            <Icon name="edit" /> Edit
          </button>
        )}
        {!editing && pageQ.data && (
          <span className="overflow-wrap" ref={menuRef}>
            <button
              className="btn"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More actions"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="omenu" role="menu">
                {/* Obsidian stood in the head; it is the rarer door, so it lives here now. */}
                <button role="menuitem" onClick={() => window.location.assign(obsidianUri(vaultName, path))} title="Open in Obsidian">
                  <Icon name="link" /> Open in Obsidian
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    void navigator.clipboard?.writeText(path).then(() => {
                      setCopiedPath(true)
                      setTimeout(() => setCopiedPath(false), 1500)
                    })
                  }}
                >
                  <Icon name="copy" /> {copiedPath ? 'Copied' : 'Copy vault path'}
                </button>
                <div className="omenu-sep" />
                {confirmDelete && backlinks.length > 0 && (
                  <div className="omenu-note" role="note">
                    {backlinks.length} page{backlinks.length === 1 ? '' : 's'} link here (
                    {backlinks
                      .slice(0, 3)
                      .map((b) => b.title)
                      .join(', ')}
                    {backlinks.length > 3 ? ', …' : ''}) - deleting leaves dangling links.
                  </div>
                )}
                <button
                  role="menuitem"
                  className="danger"
                  disabled={del.isPending}
                  onClick={requestDelete}
                  title="Deleted as a git commit - recoverable"
                >
                  <Icon name="x" />{' '}
                  {del.isPending ? 'Deleting…' : confirmDelete ? 'Really delete?' : 'Delete page…'}
                </button>
              </div>
            )}
          </span>
        )}
      </div>

      <StaleLinksBanner />
      {del.isError && <div className="toast err">Delete failed: {(del.error as Error).message}</div>}

      {saveFindings.length > 0 && (
        <div className="stale-banner" role="status">
          <Icon name="graph" />
          <span>
            Saved, but the page checks found {saveFindings.length} issue{saveFindings.length === 1 ? '' : 's'}:{' '}
            {saveFindings.map((f) => `${f.rule}: ${f.message}`).join(' · ')}
          </span>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setSaveFindings([])} title="Dismiss" aria-label="Dismiss findings">
            <Icon name="x" />
          </button>
        </div>
      )}

      {editing ? (
        <div className="page-editor">
          {/* Markdown left, live rendering right - wikilinks and frontmatter are visible
              while typing instead of only after saving. Stacks on small screens. */}
          <div className="editor-split">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              aria-label="Page content (markdown)"
            />
            <EditorPreview draft={draft} linkTo={linkTo} />
          </div>
          <div className="editor-actions">
            <button className="btn primary" onClick={() => save.mutate({})} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save (commit)'}
            </button>
            <button
              className={`btn${confirmLeave ? ' armed' : ''}`}
              onClick={() => leaveEditor()}
              disabled={save.isPending}
              title={dirty ? 'Discard the unsaved draft' : 'Close the editor'}
            >
              {confirmLeave ? 'Discard draft?' : 'Cancel'}
            </button>
            {saveConflict && (
              /*
               * The draft survives the conflict. A working lock is only half the fix: the
               * banner used to offer one action and that action threw the edit away, which
               * trades a silent loss in the vault for a visible loss of your work. Now the
               * choice is yours and both sides of it are named.
               */
              <span className="toast err">
                The page changed since you opened it - an agent run, or another tab. Your draft is still here.{' '}
                <button
                  className="btn ghost"
                  onClick={() => save.mutate({ force: true })}
                  disabled={save.isPending}
                  title="Replace what landed in the meantime with your draft. It is one commit, so it stays revertable."
                >
                  Save anyway
                </button>{' '}
                <button
                  className="btn ghost"
                  onClick={() => {
                    save.reset()
                    setEditing(false)
                    setBaseMtime(null)
                    void qc.invalidateQueries({ queryKey: ['page-full', path] })
                  }}
                  title="Throw your draft away and load what is on disk"
                >
                  Discard mine and reload
                </button>
              </span>
            )}
            {save.isError && !saveConflict && (
              <span className="toast err">Save failed: {(save.error as Error).message}</span>
            )}
          </div>
        </div>
      ) : (
      <div className="page-columns">
        <article className="page-body">
          {pageQ.isLoading && <div className="empty">Loading page…</div>}
          {pageQ.isError && (
            <div className="empty">Failed to load the page: {(pageQ.error as Error)?.message}</div>
          )}
          {parsed.fields.length > 0 && (
            <dl className="page-meta">
              {parsed.fields.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  {/* Frontmatter carries wikilinks too (`related: [[index]]`) - make them
                      navigable rather than showing the raw brackets. */}
                  <dd>{renderMetaValue(v, linkTo)}</dd>
                </div>
              ))}
            </dl>
          )}
          {pageQ.data && (
            <Markdown source={parsed.body} renderWikilink={linkTo} />
          )}
          {pageQ.data?.mtime && <div className="page-mtime">Last changed {timeAgo(pageQ.data.mtime)}</div>}
        </article>

        <aside className="page-side">
          {/*
            One list at a time, chosen by the same pill toggle the rest of the shell uses.
            Both lists stacked made the column longer than the article on a well-linked page,
            which is what set the two scrolling against each other; and which of the two you
            want is a question you answer once, not a thing to scroll past.
          */}
          <div className="seg page-side-seg" role="radiogroup" aria-label="Links">
            <button
              type="button"
              role="radio"
              aria-checked={side === 'backlinks'}
              className={side === 'backlinks' ? 'active' : ''}
              onClick={() => setSide('backlinks')}
            >
              Backlinks {backlinks.length}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={side === 'outgoing'}
              className={side === 'outgoing' ? 'active' : ''}
              onClick={() => setSide('outgoing')}
            >
              Outgoing {outgoing.length}
            </button>
          </div>
          <div className="page-side-body">
            {(side === 'backlinks' ? backlinks : outgoing).length === 0 ? (
              <p className="dim">{side === 'backlinks' ? 'No page links here.' : 'No outgoing links.'}</p>
            ) : (
              <ul className="linklist">
                {(side === 'backlinks' ? backlinks : outgoing).map((n) => (
                  <li key={n.path}>
                    <a
                      href={pageRoute(n.path)}
                      onClick={(e) => {
                        e.preventDefault()
                        navigate(pageRoute(n.path))
                      }}
                    >
                      {n.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
      )}
    </div>
  )
}

/** Live rendering of the editor draft - frontmatter as properties, wikilinks clickable. */
function EditorPreview({
  draft,
  linkTo,
}: {
  draft: string
  linkTo: (target: string, label: string, key: string) => React.ReactNode
}): React.ReactElement {
  const parsed = useMemo(() => frontmatter(draft), [draft])
  return (
    <div className="editor-preview">
      {parsed.fields.length > 0 && (
        <dl className="page-meta">
          {parsed.fields.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{renderMetaValue(v, linkTo)}</dd>
            </div>
          ))}
        </dl>
      )}
      <Markdown source={parsed.body} renderWikilink={linkTo} />
    </div>
  )
}

/**
 * Banner shown after manual deletions: N backlinks now point at nothing. Primary action is
 * the bounded reference-cleanup agent run (maintenance kind `cleanup`) - one click instead
 * of leaving the dangling references to be discovered weeks later by a lint. The banner
 * tracks the run inline (poll every 2 s) so the user never has to leave the tab.
 */
function StaleLinksBanner(): React.ReactElement | null {
  const state = useStaleLinks()
  const qc = useQueryClient()
  const [runId, setRunId] = useState<string | null>(null)
  const start = useMutation({
    mutationFn: () => api.cleanupReferences(state.pages),
    onSuccess: (run) => setRunId(run.id),
  })
  const runQ = useQuery({
    queryKey: ['maintenance-run', runId],
    queryFn: () => api.maintenanceRun(runId!),
    enabled: runId !== null,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'running' ? false : 2000),
  })
  const run = runQ.data
  const settled = run !== undefined && run.status !== 'running'
  useEffect(() => {
    if (run?.status === 'done') {
      // The run edited pages and committed - refresh everything derived from the vault.
      void qc.invalidateQueries({ queryKey: ['graph'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    }
  }, [run?.status, qc])

  if (state.count === 0) return null
  const dismiss = (): void => {
    staleLinks.clear()
    setRunId(null)
    start.reset()
  }
  const pages = state.pages.join(', ')

  let body: React.ReactElement
  if (runId !== null && !settled) {
    body = (
      <span>
        Reference cleanup is running - removing dangling links to <strong>{pages}</strong>…
      </span>
    )
  } else if (run?.status === 'done') {
    const touched = run.result?.pages.length ?? 0
    body = (
      <span>
        Reference cleanup finished: {touched} page{touched === 1 ? '' : 's'} updated (one revertable commit).
      </span>
    )
  } else if (run?.status === 'error' || start.isError) {
    body = (
      <span>
        Reference cleanup failed: {run?.error ?? (start.error as Error | undefined)?.message ?? 'unknown error'}
      </span>
    )
  } else {
    body = (
      <span>
        Deleting <strong>{pages}</strong> left <strong>{state.count}</strong> link
        {state.count === 1 ? '' : 's'} dangling.
      </span>
    )
  }

  return (
    <div className="stale-banner" role="status">
      <Icon name="graph" />
      {body}
      <span className="spacer" />
      {runId === null && state.pages.length > 0 && (
        <button className="btn primary" onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending ? 'Starting…' : 'Clean up references'}
        </button>
      )}
      {run?.status === 'error' && (
        <button className="btn" onClick={() => { setRunId(null); start.reset() }}>
          Retry
        </button>
      )}
      <button
        className="btn ghost"
        onClick={dismiss}
        disabled={runId !== null && !settled}
        title="Dismiss"
        aria-label="Dismiss banner"
      >
        <Icon name="x" />
      </button>
    </div>
  )
}
