/**
 * The graph's lock (2026-09-17): the picture on screen, held as a snapshot of everything that
 * decides which nodes are drawn and how - the filters, the room, the focus and its depth, the
 * gaps and the system pages, the search, a tag, the drill-down, the lens and the overlays.
 *
 * The screen keeps the record in sessionStorage: a reload keeps the picture, closing the
 * browser tab lets it go, because it is a bookmark for one sitting and not a preference. This
 * module is the shape of that record and the reading of it back - field by field, so a stale
 * or foreign payload is dropped whole rather than half-applied, the rule the view prefs follow.
 */

import type { Lens } from '../components/GraphCanvas.tsx'

export const GRAPH_FREEZE_KEY = 'vault.graphFreeze'

/** One level of the cluster drill-down, by path - the screen's `ClusterFocus` with its set as a list. */
export interface FrozenCluster {
  paths: string[]
  label: string
  domain: string | null
  anchor: string
}

export interface GraphFreeze {
  v: 1
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
  if (o.v !== 1) return null
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
    v: 1,
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
  }
}

export function serializeGraphFreeze(f: GraphFreeze): string {
  return JSON.stringify(f)
}
