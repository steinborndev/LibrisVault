/**
 * The graph's lock (2026-09-17): the picture on screen, held - the filters, the room, the focus
 * and its depth, the gaps and the system pages, the search, a tag, the drill-down, the lens and
 * the overlays.
 *
 * What it HOLDS is which nodes are drawn and where they sit, so an excursion - another domain,
 * a search, a page read and come back from - returns to exactly them. What it FOLLOWS, since
 * 2026-09-22, is the switches that say how that same set is coloured: a lens, an overlay, the
 * gaps and the system pages. A reader who turns one off after locking is changing the held
 * picture rather than leaving it, and the record used to turn it back on at the next return.
 *
 * The screen keeps the record in sessionStorage: a reload keeps the picture, closing the
 * browser tab lets it go, because it is a bookmark for one sitting and not a preference. This
 * module is the shape of that record and the reading of it back - field by field, so a stale
 * or foreign payload is dropped whole rather than half-applied, the rule the view prefs follow.
 */

import type { Lens } from '../components/GraphCanvas.tsx'

export const GRAPH_FREEZE_KEY = 'vault.graphFreeze'

/**
 * The Landmarks overlay, held (docs/tasks/TASKS-LANDMARKS.md). What the record keeps is the
 * computed ORDER, not merely the switch: in this mode the SET is what decides which nodes are
 * drawn and how, and a ranking re-derived on the way back would put the reader somewhere else -
 * an ingest can reorder the list, which is the one thing the lock exists to prevent.
 * `clusterStack` is the precedent, storing a community's members as paths although they are
 * derived. A held landmark whose page is gone is simply not painted and drops out of the list,
 * the way a `clusterStack` path already behaves.
 */
export interface FrozenLandmarks {
  /** Needed even so: with a single-domain room filtering, `selectedDomains` is empty. */
  domain: string
  /** The landmark paths in reading order. */
  order: string[]
  /** Start offsets into `order`. */
  chapters: number[]
  connectors: string[]
  /** A path, never an index - indices shift on every graph change. */
  bloom: string | null
}

/** One level of the cluster drill-down, by path - the screen's `ClusterFocus` with its set as a list. */
export interface FrozenCluster {
  paths: string[]
  label: string
  domain: string | null
  anchor: string
}

export interface GraphFreeze {
  /**
   * 2 since the Landmarks overlay (2026-09-22). Bumped rather than added to: a v1 picture knows
   * nothing of the mode's exclusions, so it is dropped whole rather than half-applied.
   */
  v: 2
  selectedTypes: string[]
  selectedDomains: string[]
  wingMode: 'all' | 'wing'
  wing: string | null
  localDepth: 0 | 1 | 2
  focusPath: string | null
  showGaps: boolean
  showSystem: boolean
  query: string
  tagFilter: { tag: string; around: string | null } | null
  clusterStack: FrozenCluster[]
  lens: Lens
  showClusters: boolean
  showNetwork: boolean
  spotlight: boolean
  landmarks: FrozenLandmarks | null
}

const LENSES: ReadonlySet<string> = new Set(['domain', 'type', 'authority', 'orphans', 'stubs', 'recency'])

const strings = (x: unknown): string[] | null => (Array.isArray(x) && x.every((s) => typeof s === 'string') ? (x as string[]) : null)
const bool = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null)
/** A string or null as written; undefined says the field is something else. */
const nullable = (x: unknown): string | null | undefined => (x === null || typeof x === 'string' ? x : undefined)

/** The record read back, or null: nothing written, not JSON, another version, or a field that is not what it says. */
export function parseGraphFreeze(raw: string | null): GraphFreeze | null {
  if (raw === null) return null
  let p: unknown
  try {
    p = JSON.parse(raw)
  } catch {
    return null
  }
  if (p === null || typeof p !== 'object') return null
  const o = p as Record<string, unknown>
  if (o.v !== 2) return null
  const selectedTypes = strings(o.selectedTypes)
  const selectedDomains = strings(o.selectedDomains)
  const wingMode = o.wingMode === 'all' || o.wingMode === 'wing' ? o.wingMode : null
  const wing = nullable(o.wing)
  const localDepth = o.localDepth === 0 || o.localDepth === 1 || o.localDepth === 2 ? o.localDepth : null
  const focusPath = nullable(o.focusPath)
  const showGaps = bool(o.showGaps)
  const showSystem = bool(o.showSystem)
  const showClusters = bool(o.showClusters)
  const showNetwork = bool(o.showNetwork)
  const spotlight = bool(o.spotlight)
  const lens = typeof o.lens === 'string' && LENSES.has(o.lens) ? (o.lens as Lens) : null
  if (
    selectedTypes === null ||
    selectedDomains === null ||
    wingMode === null ||
    wing === undefined ||
    localDepth === null ||
    focusPath === undefined ||
    showGaps === null ||
    showSystem === null ||
    showClusters === null ||
    showNetwork === null ||
    spotlight === null ||
    lens === null ||
    typeof o.query !== 'string'
  )
    return null
  const landmarks = parseLandmarks(o.landmarks)
  if (landmarks === undefined) return null
  /*
   * The mode's exclusions, as a parse invariant. Turning it on turns Spotlight, the cluster
   * drill-down and the local focus off, and a search leaves it - so a record pairing it with any
   * of them is one this interface cannot produce. That makes it foreign, and a foreign record is
   * dropped whole, which is the rule this module already follows for everything else.
   */
  if (landmarks !== null && (spotlight || localDepth > 0 || o.query !== '' || (Array.isArray(o.clusterStack) && o.clusterStack.length > 0)))
    return null
  let tagFilter: GraphFreeze['tagFilter'] = null
  if (o.tagFilter !== null) {
    if (o.tagFilter === undefined || typeof o.tagFilter !== 'object') return null
    const t = o.tagFilter as Record<string, unknown>
    const around = nullable(t.around)
    if (typeof t.tag !== 'string' || around === undefined) return null
    tagFilter = { tag: t.tag, around }
  }
  if (!Array.isArray(o.clusterStack)) return null
  const clusterStack: FrozenCluster[] = []
  for (const c of o.clusterStack as unknown[]) {
    if (c === null || typeof c !== 'object') return null
    const r = c as Record<string, unknown>
    const paths = strings(r.paths)
    const domain = nullable(r.domain)
    if (paths === null || typeof r.label !== 'string' || domain === undefined || typeof r.anchor !== 'string') return null
    clusterStack.push({ paths, label: r.label, domain, anchor: r.anchor })
  }
  return {
    v: 2,
    selectedTypes,
    selectedDomains,
    wingMode,
    wing,
    localDepth,
    focusPath,
    showGaps,
    showSystem,
    query: o.query,
    tagFilter,
    clusterStack,
    lens,
    showClusters,
    showNetwork,
    spotlight,
    landmarks,
  }
}

/**
 * The nested field: the record as written, null where the mode was off, or `undefined` for a
 * payload that is not either - which the caller turns into a dropped record, field by field like
 * everything else here.
 */
function parseLandmarks(x: unknown): FrozenLandmarks | null | undefined {
  // Absent is not "off": a v2 record always carries the field, so a payload without one was
  // written by something else.
  if (x === null) return null
  if (x === undefined || typeof x !== 'object') return undefined
  const l = x as Record<string, unknown>
  const order = strings(l.order)
  const connectors = strings(l.connectors)
  const bloom = nullable(l.bloom)
  const chapters =
    Array.isArray(l.chapters) && l.chapters.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
      ? (l.chapters as number[])
      : null
  if (typeof l.domain !== 'string' || order === null || connectors === null || chapters === null || bloom === undefined)
    return undefined
  return { domain: l.domain, order, chapters, connectors, bloom }
}

export function serializeGraphFreeze(f: GraphFreeze): string {
  return JSON.stringify(f)
}
