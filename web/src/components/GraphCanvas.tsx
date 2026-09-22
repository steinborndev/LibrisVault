/**
 * Canvas renderer for the vault graph (SPEC.md §12.4). Canvas 2D, not SVG - an SVG DOM node
 * per page is exactly what makes graph views fall over as a vault grows; a single canvas
 * draws tens of thousands of nodes without breaking a sweat. Layout comes from the d3-force
 * web worker (lib/graphLayout.worker.ts), so the UI thread only ever draws.
 *
 * Scale-mindedness, deliberately built in from the start (the vault will keep growing):
 *   - label level-of-detail: at low zoom only hub labels draw, zooming in reveals the rest
 *   - viewport culling: off-screen nodes/labels are skipped
 *   - the simulation cools and stops; re-layout only when the node set actually changes
 *   - hover/click hit-testing is O(n) over a typed array - fine far beyond 10k nodes
 *
 * Live updates (SPEC.md §12.4): positions are keyed by page PATH, not by array index - the
 * server sorts nodes by path, so one new page shifts every index after it. When the node set
 * changes (vault SSE event mid-ingest, filter toggle, local mode), known pages keep their
 * place and the simulation re-heats gently instead of being thrown away; brand-new pages
 * appear at their neighbors' centroid and flash briefly. The camera NEVER moves on a live
 * update - auto-fit happens only on the very first layout.
 */

import {
  centerOn,
  clampK,
  fullyInView,
  leash,
  localAnchor,
  magnetAnchor,
  nearestMass,
  normalizeWheel,
  toWorld as worldOf,
  visibleNodes,
  wheelFactor,
  worldBounds,
  zoomAt as zoomTransform,
  LEASH_PAD_WORLD,
  type ClusterGeom,
  type Viewport,
} from '../lib/graphZoom.ts'
import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react'
import type { GraphNode } from '../api/types.ts'
import { domainGroups } from '../lib/graphForces.ts'
import {
  REVEAL_MS,
  REVEAL_HOLD_MAX_MS,
  revealAlpha,
  revealLabelAlpha,
  revealOrder,
  revealPop,
} from '../lib/graphReveal.ts'

/**
 * Smallest connected component that earns a guaranteed label (see `labelReps`). Below this a
 * blob is an orphan or a stray pair, not a cluster worth reserving a label slot for - and the
 * graph carries hundreds of gap nodes we must not each force onto the canvas.
 */
const MIN_LABELED_CLUSTER = 3

export interface GraphCanvasProps {
  nodes: GraphNode[]
  /** Directed [from, to] index pairs into `nodes`. */
  edges: Array<[number, number]>
  /** Index of the focused node (URL ?focus=), or null. Drives the local-neighborhood mode. */
  focusIndex: number | null
  /**
   * Index of the node picked in the explorer panel, or null. Like a hover that persists: it
   * spotlights the node's neighborhood and draws a selection ring, but is driven by clicks
   * rather than the pointer. Independent of `focusIndex` (which is the URL-level focus).
   */
  selectedIndex?: number | null
  /**
   * Indices that are knowledge-gap ghost nodes (missing pages other pages link to), rendered
   * hollow/dashed. Their `in` count is how many pages reference them; `out` is 0.
   */
  ghostIndices?: ReadonlySet<number>
  /** Indices matching the current search, highlighted. */
  matches: ReadonlySet<number>
  /**
   * The color lens - how nodes are tinted (SPEC §12.4). `domain`/`type` are categorical
   * axes; `authority`/`orphans`/`stubs`/`recency` re-encode a metric so the same graph
   * answers a different question ("where are the hubs / dead ends / thin pages / new pages").
   */
  lens?: Lens
  /**
   * Cluster id per node index (auto-detected communities), or null for no clustering. Nodes
   * sharing an id get a tinted convex hull behind them; -1 means "unclustered" (no hull).
   */
  clusters?: readonly number[] | null
  /** Cluster id → short label (its dominant shared tags), drawn at the hull centroid. */
  clusterLabels?: ReadonlyMap<number, string>
  /**
   * Cluster id → its dominant `domain:` (the domain most of its pages carry), when the
   * cluster has one. The hull is tinted in that domain's color instead of an arbitrary
   * per-id hue, so a hull's color carries real meaning - and a domain-mixed community (a
   * bridge node gluing two domains) no longer hides behind a neutral tint.
   */
  clusterDomains?: ReadonlyMap<number, string>
  /**
   * Draw the tinted cluster hulls + region labels. Split from `clusters` because the network
   * lens needs the cluster ids to classify edges (intra vs bridge) WITHOUT drawing hulls - so
   * `clusters` may be present while hulls stay off.
   */
  showHulls?: boolean
  /**
   * Network lens (SPEC §12.4): lift the connection lines out of the point-cloud read. Intra-
   * cluster edges brighten subtly; cross-cluster BRIDGES render in a from→to node-color
   * gradient with a direction arrowhead. Needs `clusters` to classify; a no-op without it.
   */
  network?: boolean
  /**
   * When on, hovering a node spotlights its whole community (from `clusters`, falling back
   * to its direct neighbors when it has none) and dims the rest - previewing exactly the set
   * a click would isolate (the caller handles that via onSelect). Controlled from the viewbar
   * (the toggle used to live inside the canvas); off by default - easier to click.
   */
  spotlight?: boolean
  /**
   * Draw the region and node label passes (default). `false` is the screenshot mode behind
   * the graph URL's `?labels=off`: same structure, colors, and hulls, but no readable text
   * on the canvas - so a capture of a real vault leaks no page titles.
   */
  showLabels?: boolean
  /**
   * Changes whenever the CALLER changes the visible subgraph (domain/type filters, local
   * depth) - each change re-fits the view so the filtered graph fills the canvas again.
   * Live SSE updates leave this key alone, so mid-ingest arrivals still never move the camera.
   */
  fitKey?: string
  /** The bar's own Fit button. Off where the screen offers the action somewhere better. */
  showFit?: boolean
  /**
   * Which nodes a fit frames, or null for all of them. It changes no layout and hides nothing:
   * the camera is simply put around a part of the picture, which is how the Landmarks overlay
   * lands a click on a readable view of one page's neighbourhood instead of on twelve more dots
   * somewhere in a field of forty. Read at the moment of the fit, so it always pairs with the
   * `fitKey` that asked for one.
   */
  fitSubset?: ReadonlySet<number> | null
  /**
   * Which graph this canvas is - the key its camera and its laid-out positions are kept
   * under. Two canvases are mounted at once (every screen stays in the DOM behind `hidden`),
   * and a positions array belongs to exactly one node list, so they must not share a slot.
   * Stable for the life of a view: the Graph screen is one, a department window is one per
   * department, so each opens where it was left.
   */
  view: string
  /**
   * The canvas bar's three groups (2026-09-11): what follows Fit on the left (the scope
   * line), the middle block (the domain heading, at the bar's true centre whatever stands
   * left and right of it), and the right group (fullscreen, the search). The Catalog draws
   * the same bar by hand; the groups keep the two in step.
   */
  barLeft?: React.ReactNode
  barMid?: React.ReactNode
  barRight?: React.ReactNode
  /** Single click/tap on a node (when the click doesn't isolate - see onClusterClick). */
  onSelect: (node: GraphNode) => void
  /**
   * A single click opens instead of selecting. The Library's department window reads pages
   * in place, where selecting a node has nothing to open a panel with.
   */
  openOnClick?: boolean
  /**
   * Fit once on mount, whatever the fit key says. The camera outlives the component, so a
   * canvas that mounts on an already-placed subgraph inherits the pan and zoom that view
   * was left at - right for a view continuing, wrong for one being opened again. Hosts that
   * open and close (the Library's department window) set it.
   */
  fitOnMount?: boolean
  /**
   * Spotlight click on an isolatable community - on one of its member nodes OR anywhere
   * inside its hull (the hull is one clickable surface; demanding a precise node hit made
   * the isolation gesture fiddly). The canvas guarantees the cid is isolatable (spotlight
   * on, id ≥ 0, proper subset of the visible real nodes); the caller does the isolating.
   */
  onClusterClick?: (cid: number) => void
  /**
   * Double-click / double-tap on a node. The click-vs-open split mirrors every file
   * manager: single opens the explorer panel, double navigates to the page itself.
   */
  onOpen?: (node: GraphNode) => void
  /**
   * Click/tap on EMPTY canvas. Standard canvas convention: clicking the background clears
   * the selection - without this, an accidental node tap leaves its spotlight stuck until
   * the user finds the panel's ✕ or Esc.
   */
  onClear?: () => void
  /** Extra UI rendered inside the canvas wrap (e.g. the search box, top-right). */
  overlay?: React.ReactNode
  /**
   * The Landmarks overlay's paint mask (docs/tasks/TASKS-LANDMARKS.md), or null when the mode
   * is off. It PAINTS, it does not filter: every page of the domain stays in `nodes` and
   * `edges`, and what this changes is which of them the canvas puts ink on. That is the whole
   * reason the mode costs no layout - the node list, the edge list and the domain grouping are
   * untouched, so the layout effect's structural-identity check returns before it posts, and
   * the positions stand still across a switch and across a bloom.
   */
  landmarkMask?: LandmarkMask | null
}

/**
 * Which nodes the Landmarks overlay paints, and how. Everything outside the three sets is drawn
 * at no alpha, carries no label and cannot be clicked - a click on its position is a click on
 * the background.
 */
export interface LandmarkMask {
  /** The pages the domain is built around: full size, labelled, the subject of the picture. */
  landmarks: ReadonlySet<number>
  /** The glue between chapters: smallest and unlabelled, because they are not entry points. */
  connectors: ReadonlySet<number>
  /**
   * The open neighbourhood: every page the expanded landmark links to or from inside the
   * domain, whatever it is in the other view. Empty while none is expanded.
   */
  bloom: ReadonlySet<number>
  /**
   * The expanded landmark itself, or null while none is. It and its neighbourhood are then the
   * WHOLE picture - see `painted` - because the click re-frames onto them and remains of the
   * other view inside that frame are a second picture the reader has to look past.
   */
  bloomAnchor: number | null
  /**
   * Backlinks counted inside the DOMAIN, per node index - the value the authority lens reads
   * while the mode is on. Over the vault an index hub lends every page it lists the same link,
   * which is not a statement about the domain. Computed over the domain rather than over what
   * is painted, so a bloom cannot recolour the picture under the reader's hand.
   */
  inDomain: readonly number[]
}

// Domain colors, the page-kind color map and the stub threshold live in lib/domains.ts (the
// library, and now Home's constellation, share them and must not pull this d3-carrying
// module into the main bundle). Re-exported for callers.
import { domainColor, domainHue, STUB_BYTES, TYPE_VARS } from '../lib/domains.ts'
export { domainColor, domainHue, STUB_BYTES, TYPE_VARS }

/**
 * What the authority lens counts for one node: the DOMAIN-internal backlinks while the Landmarks
 * mask hands them in, the vault-wide count otherwise.
 *
 * Only the value moves. Which nodes make up the ramp's domain is unchanged - with a paint mask
 * the drawn nodes are the domain - because a ramp rebuilt from what is painted would recolour
 * the whole picture on every bloom, under the reader's hand.
 *
 * A count of zero is a count: the fallback is on a MISSING entry, never on a falsy one, which is
 * the difference between "this page has no backlinks inside its domain" and "nobody said".
 */
export function authorityValue(mask: LandmarkMask | null, nodes: readonly GraphNode[], i: number): number {
  return mask?.inDomain[i] ?? nodes[i]?.in ?? 0
}

/** The available color lenses. `domain`/`type` are categorical; the rest re-encode a metric. */
export type Lens = 'domain' | 'type' | 'authority' | 'orphans' | 'stubs' | 'recency'
/**
 * Full green in the "recency" lens for pages changed within this window; older fades to neutral.
 *
 * 21 days, kept deliberately when the lens moved off the file mtime (2026-09-20): against real
 * content dates it puts about a third of this vault in green with a readable gradient behind
 * it, and the question it then answers - what has been added or rewritten in the last three
 * weeks - is the useful one. Against mtimes it answered nothing at all, because a mass pass
 * touches every file and 1326 of 1332 were inside the window.
 */
const RECENCY_WINDOW_MS = 21 * 24 * 3600_000

/** Parses `#rgb` / `#rrggbb` / `rgb(...)` to [r,g,b]; null for anything else (e.g. hsl()). */
function parseRgb(color: string): [number, number, number] | null {
  const s = color.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (hex) {
    const h = hex[1]!
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    const n = parseInt(full, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  // The domain palette is generated as `hsl(<hue> 62% 52%)`, so anything that wants to do
  // arithmetic on a domain colour has to be able to read one (2026-09-16).
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i.exec(s)
  if (!hsl) return null
  const h = Number(hsl[1]) / 360
  const sat = Number(hsl[2]) / 100
  const li = Number(hsl[3]) / 100
  const q = li < 0.5 ? li * (1 + sat) : li + sat - li * sat
  const base = 2 * li - q
  const channel = (t: number): number => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    if (x < 1 / 6) return base + (q - base) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return base + (q - base) * (2 / 3 - x) * 6
    return base
  }
  return [Math.round(channel(h + 1 / 3) * 255), Math.round(channel(h) * 255), Math.round(channel(h - 1 / 3) * 255)]
}

/** Linear RGB interpolation between two CSS colors; falls back to `b` if either can't parse. */
/**
 * OKLab, for the one thing this file does that needs a perceptual colour space: the authority
 * ramp. Mixing two colours channel-by-channel in sRGB (what `mixColor` does, and what the
 * ramp used to do) bunches its steps - the middle sags into a muddy low-chroma stretch while
 * the ends barely move - so pages a few backlinks apart came out the same colour.
 */
function srgbToLinear(u: number): number {
  const v = u / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
function linearToSrgb(v: number): number {
  const u = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(u * 255)))
}
function rgbToOklab(rgb: readonly number[]): [number, number, number] {
  const r = srgbToLinear(rgb[0] ?? 0)
  const g = srgbToLinear(rgb[1] ?? 0)
  const b = srgbToLinear(rgb[2] ?? 0)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
function oklabToCss(L: number, a: number, b: number): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const r8 = linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
  const g8 = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
  const b8 = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  return `rgb(${r8}, ${g8}, ${b8})`
}

/** Whether the tokens currently in force are the dark set - asked of the colour, not of the
 *  media query, so it follows the theme however the theme is decided. */
export function isDarkSurface(bg: string): boolean {
  const rgb = parseRgb(bg)
  return rgb === null ? true : rgbToOklab(rgb)[0] < 0.5
}

/**
 * A page's authority as a colour: `t` (0 = least linked, 1 = most) on a ramp built around one
 * hue, which is the page's own DOMAIN (2026-09-16). Two facts in one channel - where a page
 * belongs, and how much of the vault leans on it.
 *
 * LIGHTNESS carries the metric, and it carries it across the whole usable range. The old ramp
 * mixed a grey toward the accent and spanned 26 of 100 L*, which is a quarter of the axis a
 * six-pixel dot is read by: at that size the eye resolves lightness long before hue or chroma,
 * so the lens showed a field of one colour with a few bright dots. This spans about 70, and
 * chroma rises with it so the top of the ramp is the domain's colour at full strength.
 *
 * The low end is deliberately close to the background. That is the cost of the range, and it
 * is the right way round: a page nothing links to should be the one that recedes.
 */
export function authorityRamp(base: string, t: number, dark: boolean): string {
  const [, a, b] = rgbToOklab(parseRgb(base) ?? [90, 140, 240])
  const chroma = Math.hypot(a, b) || 0.001
  const L = dark ? 0.34 + 0.54 * t : 0.9 - 0.52 * t
  // Scaled by the base's own chroma, so a muted domain colour stays muted and a vivid one
  // reaches its full strength at the top of the ramp rather than being flattened to a norm.
  const C = (dark ? 0.02 + 0.1 * t : 0.015 + 0.13 * t) * Math.min(1.6, 0.5 + chroma * 6)
  return oklabToCss(L, (a / chroma) * C, (b / chroma) * C)
}

/** The same ramp as a CSS gradient, for the legend that has to explain it. */
export function authorityGradient(base: string, dark: boolean): string {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => `${authorityRamp(base, t, dark)} ${t * 100}%`)
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

function mixColor(a: string, b: string, t: number): string {
  const pa = parseRgb(a)
  const pb = parseRgb(b)
  if (!pa || !pb) return b
  const c = pa.map((v, i) => Math.round(v + (pb[i]! - v) * t))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

/** Distinct, theme-agnostic hue per cluster id for the community hulls. */
function clusterHue(id: number): number {
  return (id * 47) % 360
}

/** Two taps on the SAME node within this window are a double-tap (opens the page). */
/**
 * The three role radii of the Landmarks overlay, against the ordinary 3-to-12px degree scale.
 * Inside the mode size says the ROLE, not the degree: `3 + min(9, sqrt(degree) * 1.1)` saturates
 * at degree 67, so the top 40 pages of the largest domain here all sit between 8.4 and 12.0px
 * with five pinned at the cap - a flat scale exactly where importance matters most. The rank it
 * would carry is already stated, in order, by the list beside the drawing.
 */
/**
 * Whether the Landmarks mask puts ink on node `i`.
 *
 * With a neighbourhood open, ONLY that neighbourhood is on screen - the landmark and every page
 * it links to or from inside the domain. The rest is not dimmed but gone: the click re-frames
 * the picture onto one page, and half-transparent remains of the other view inside that frame
 * are a second picture the reader has to look past.
 */
function painted(mask: LandmarkMask | null, i: number): boolean {
  if (mask === null) return true
  if (mask.bloomAnchor !== null) return i === mask.bloomAnchor || mask.bloom.has(i)
  return mask.landmarks.has(i) || mask.connectors.has(i)
}

const LANDMARK_R = 10
const BLOOM_R = 6.5
const CONNECTOR_R = 4.5

const DOUBLE_TAP_MS = 350

/** A layout with at least this share of never-placed nodes restarts cold instead of reheating. */
const COLD_RESTART_SHARE = 0.2
/** How long a newly appeared node flashes, ms. */
const FLASH_MS = 1600

interface Transform {
  x: number
  y: number
  k: number
}

interface WorkerFrame {
  gen: number
  type: 'tick' | 'done'
  positions: Float32Array
}

interface LayoutMsg {
  paths: string[]
  degrees: Array<{ degree: number }>
  edges: Array<[number, number]>
  /** Domain group id per node (-1 = uncategorized) - the worker's domain-aware forces. */
  groups: Int32Array
  seed: Float32Array
  alpha: number
}

/**
 * Camera + layout memory that OUTLIVES the component: the canvas unmounts on every
 * graph ↔ page-view switch, and refs die with it - which used to reset the user's zoom
 * and re-run the whole force layout each time.
 *
 * ONE SLOT PER VIEW (2026-09-10). This was a single module-level object, on the reasoning
 * that the app has exactly one graph view. It has two: the Graph screen and the Library's
 * department window, and every screen stays mounted behind `hidden`, so both canvases are
 * live at once. `positions` is index-aligned with the node list it was laid out for, and a
 * department holds a fraction of the pages the whole graph does - so opening a department
 * graph left the Graph screen holding an array too short for its own nodes, and its draw,
 * which bails on exactly that, painted nothing at all. Nothing re-ran the layout either:
 * the screen's nodes had not changed, so the effect that rebuilds the array never fired,
 * and the canvas stayed blank until the vault next updated.
 *
 * A slot per view also makes the camera per view, which is what a reader expects: the Graph
 * screen keeps the pan and zoom it had while you look at a department, rather than adopting
 * the department's frame and needing the re-fit-on-return that used to paper over it.
 */
interface ViewMemory {
  /** Positions aligned with the CURRENT `nodes` prop, [x0, y0, x1, y1, …]; NaN = unplaced. */
  positions: { current: Float32Array }
  transform: { current: Transform }
  /** Set once the user pans/zooms, so an automatic re-fit never yanks the view away. */
  userMoved: { current: boolean }
  fitted: { current: boolean }
  /** The last posted layout, re-postable (remounts and StrictMode re-create the worker). */
  lastMsg: { current: LayoutMsg | null }
  /** True once the posted layout finished cooling - a remount then skips the replay. */
  settled: { current: boolean }
}

const views = new Map<string, ViewMemory>()

function viewMemory(view: string): ViewMemory {
  let mem = views.get(view)
  if (mem === undefined) {
    mem = {
      positions: { current: new Float32Array(0) },
      transform: { current: { x: 0, y: 0, k: 1 } },
      userMoved: { current: false },
      fitted: { current: false },
      lastMsg: { current: null },
      settled: { current: true },
    }
    views.set(view, mem)
  }
  return mem
}

/**
 * Where every view's nodes are, keyed by page path - and SHARED on purpose, unlike the rest.
 * A path is a path in any view, so a page opened in the whole graph and then in its
 * department starts where the reader last saw it instead of flying in from d3's spiral.
 */
const posByPathRef = { current: new Map<string, { x: number; y: number }>() }

export function GraphCanvas({ nodes, edges, focusIndex, selectedIndex = null, ghostIndices, matches, lens = 'type', clusters = null, clusterLabels, clusterDomains, showHulls = false, network = false, spotlight = false, showLabels = true, openOnClick = false, fitOnMount = false, fitKey, showFit = true, fitSubset = null, view, barLeft, barMid, barRight, onSelect, onClusterClick, onOpen, onClear, overlay, landmarkMask = null }: GraphCanvasProps): React.ReactElement {
  /*
   * This view's slot. Stable per `view`, so the callbacks below can hold the ref objects
   * across renders exactly as they did when there was one module-level set of them.
   */
  const mem = useMemo(() => viewMemory(view), [view])
  const positionsRef = mem.positions
  const transformRef = mem.transform
  const fittedRef = mem.fitted
  const userMovedRef = mem.userMoved
  const lastMsgRef = mem.lastMsg
  const settledRef = mem.settled
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** Paths recently added to the view → timestamp, for the arrival flash. */
  const flashRef = useRef<Map<string, number>>(new Map())
  const [hover, setHover] = useState<number | null>(null)
  const hoverRef = useRef<number | null>(null)
  hoverRef.current = hover
  // Hovered community HULL (spotlight only): the pointer is inside a cluster's tinted area
  // without touching a node. Keeps the community highlight from flickering off between
  // member nodes and makes the whole hull one clickable isolate-surface. Only ever holds an
  // ISOLATABLE cid (the hit-test applies the proper-subset guard before setting it).
  const [hullHover, setHullHover] = useState<number | null>(null)
  const hullHoverRef = useRef<number | null>(null)
  hullHoverRef.current = hullHover
  const [layouting, setLayouting] = useState(false)
  /** No placed node is on screen: zoom and pan left the picture empty (graphZoom.ts). */
  const [offMap, setOffMap] = useState(false)
  const offMapRef = useRef(false)
  /**
   * Did the last pass paint a graph? The overlays describe one - the overview frames it, and
   * "go to nearest cluster" says where it went - so on a canvas that drew nothing they have
   * nothing to say. The entrance holds the canvas blank on purpose while the first layout
   * cools (lib/graphReveal.ts), and the overview used to appear over that emptiness and then
   * vanish as the fit landed, which reads as a glitch rather than as an entrance.
   */
  const paintedRef = useRef(false)
  const miniRef = useRef<HTMLCanvasElement>(null)
  // Hover-driven neighborhood spotlight, OFF by default: it dims the rest of the graph and
  // drops their labels, which makes precise clicking hard as it flickers under the pointer.
  // A click selection (selectedIndex) still spotlights; this toggle only gates the HOVER one.
  // Controlled by the viewbar toggle; a ref so the draw closure reads the latest without redeps.
  const hoverSpotlightRef = useRef(spotlight)
  hoverSpotlightRef.current = spotlight
  /*
   * The mask, in a ref as well as in the props. `radius` reads it from here so its identity
   * stays keyed on the node list alone: it is a dependency of `fitToView`, which is a
   * dependency of the worker session, and a mask toggle that tore the worker down and built it
   * again would be a strange way to spend a redraw. The draw pass reads the prop directly.
   */
  const maskRef = useRef(landmarkMask)
  maskRef.current = landmarkMask
  /** What the next fit frames; a ref, so `fitToView` keeps its identity across a change of it. */
  const fitSubsetRef = useRef(fitSubset)
  fitSubsetRef.current = fitSubset
  /** Whether the mask puts ink on this node. Everything is painted while the mode is off. */
  const isPainted = useCallback((i: number): boolean => painted(maskRef.current, i), [])

  // Neighbor sets for hover highlighting (undirected view of the directed edges).
  const neighbors = useMemo(() => {
    const map = new Map<number, Set<number>>()
    for (const [a, b] of edges) {
      if (!map.has(a)) map.set(a, new Set())
      if (!map.has(b)) map.set(b, new Set())
      map.get(a)!.add(b)
      map.get(b)!.add(a)
    }
    return map
  }, [edges])

  // Community membership sets, cluster id → member indices, for the cluster-wide spotlight:
  // hovering previews the exact set a click would isolate. Rebuilt only when the ids change,
  // never per frame.
  const clusterSets = useMemo(() => {
    if (clusters === null) return null
    const map = new Map<number, Set<number>>()
    clusters.forEach((cid, i) => {
      if (cid < 0) return
      ;(map.get(cid) ?? map.set(cid, new Set<number>()).get(cid)!).add(i)
    })
    return map
  }, [clusters])

  // One guaranteed label per domain-region of every connected component big enough to read as
  // a cluster. Without this, the label loop's global degree sort + fixed budget fill every slot
  // from the densest regions, leaving small detached clusters (a small domain, the unassigned bucket)
  // anonymous - their local hubs never reach the global cutoff. Grouping by (component, domain)
  // rather than component alone means a domain bridged into a larger component still keeps its
  // own label, and a domain split across two blobs gets one in each. Union-find over the edges;
  // memoised on the node/edge set, not per frame.
  const labelReps = useMemo(() => {
    // Inside the mode the representatives are chosen among the PAINTED nodes: a tier that
    // guaranteed a label to a node drawn at no alpha would guarantee nothing.
    const paints = (i: number): boolean => painted(landmarkMask, i)
    const parent = new Int32Array(nodes.length)
    for (let i = 0; i < nodes.length; i++) parent[i] = i
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]!
        x = parent[x]!
      }
      return x
    }
    for (const [a, b] of edges) {
      if (!paints(a) || !paints(b)) continue
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent[ra] = rb
    }
    const compSize = new Map<number, number>()
    for (let i = 0; i < nodes.length; i++) {
      if (!paints(i)) continue
      const r = find(i)
      compSize.set(r, (compSize.get(r) ?? 0) + 1)
    }
    // Highest-degree node per (component root, domain); skip components too small to be a cluster
    // so orphans and pairs don't each force a label (the graph has hundreds of gap nodes).
    const best = new Map<string, number>()
    for (let i = 0; i < nodes.length; i++) {
      if (!paints(i)) continue
      const r = find(i)
      if ((compSize.get(r) ?? 0) < MIN_LABELED_CLUSTER) continue
      const key = `${r}\u0000${nodes[i]!.domain ?? ''}`
      const cur = best.get(key)
      if (cur === undefined || nodes[i]!.in + nodes[i]!.out > nodes[cur]!.in + nodes[cur]!.out) best.set(key, i)
    }
    return new Set(best.values())
  }, [nodes, edges, landmarkMask])

  const radius = useCallback(
    (i: number): number => {
      const n = nodes[i]
      if (!n) return 3
      const m = maskRef.current
      if (m !== null) {
        // Role, in the order roles override one another. The screen never puts a landmark or a
        // connector in a bloom (a bloom is what a click ADDS to the picture), so the ordering
        // is belt and braces rather than a rule anyone has to hold in their head. An unpainted
        // node keeps the ordinary radius: it is not drawn, but the fit still reads its extent.
        if (m.landmarks.has(i)) return LANDMARK_R
        if (m.bloom.has(i)) return BLOOM_R
        if (m.connectors.has(i)) return CONNECTOR_R
      }
      return 3 + Math.min(9, Math.sqrt(n.in + n.out) * 1.1)
    },
    [nodes],
  )

  /**
   * Backlink counts of the real pages, sorted - the domain of the authority ramp (see
   * `authorityT`). Ghost nodes (unresolved link targets) are left out on purpose: they
   * are not pages, and letting them into the domain would shift every page's colour the
   * moment the gaps view is toggled.
   */
  const authorityOf = useCallback((i: number): number => authorityValue(landmarkMask, nodes, i), [landmarkMask, nodes])

  const authoritySorted = useMemo(() => {
    if (lens !== 'authority') return null
    const counts: number[] = []
    for (let i = 0; i < nodes.length; i++) {
      if (ghostIndices?.has(i) === true) continue
      counts.push(authorityOf(i))
    }
    if (counts.length < 2) return null
    counts.sort((a, b) => a - b)
    return counts
  }, [nodes, ghostIndices, lens, authorityOf])

  /**
   * Backlink count → position on the authority ramp (0 = least linked, 1 = most).
   *
   * Not `in / max`, which is what this used to be: backlink counts do not spread out. They
   * bunch in a narrow band (in this vault: p10 = 6, median = 9, p90 = 15) under a thin tail
   * of hubs (max 83), so dividing by the tail put ~90% of the vault below a fifth of the
   * ramp - a grey field with a handful of bright dots, which is what the lens looked like.
   *
   * Two thirds RANK (the share of pages with fewer backlinks) and one third log MAGNITUDE.
   * The rank term spreads the crowded middle so neighbouring pages actually differ; the
   * magnitude term keeps the tail apart, which a pure rank scale flattens - by rank alone a
   * page with 20 backlinks and one with 83 are both simply "top". Ties share a value, so
   * equally-linked pages read as equally bright, and the mapping stays monotone: more
   * backlinks is never darker.
   */
  const authorityT = useCallback(
    (count: number): number => {
      const sorted = authoritySorted
      if (sorted === null) return 0
      // Number of pages with strictly fewer backlinks (binary search, ties land on the
      // start of their run) → the rank term.
      let lo = 0
      let hi = sorted.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (sorted[mid]! < count) lo = mid + 1
        else hi = mid
      }
      const rank = lo / (sorted.length - 1)
      const magnitude = Math.log1p(Math.max(0, count)) / Math.log1p(Math.max(1, sorted[sorted.length - 1]!))
      return Math.min(1, 0.65 * rank + 0.35 * magnitude)
    },
    [authoritySorted],
  )

  /** One draw pass. Reads CSS variables live, so light/dark theme switches just work. */
  const draw = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Anything worth redrawing may have moved the world - invalidate the hull hit cache.
    drawEpochRef.current++
    // Cleared up front, set at the end: every early return below leaves an empty canvas.
    paintedRef.current = false
    const pos = positionsRef.current
    const t = transformRef.current
    const dpr = window.devicePixelRatio || 1
    const w = canvas.width / dpr
    const h = canvas.height / dpr

    const styles = getComputedStyle(document.documentElement)
    const cssVar = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
    const muted = cssVar('--muted', '#888')
    // Neutral floor for the metric-gradient lenses (a dim, low-contrast base the metric lifts from).
    const dimBase = mixColor(cssVar('--bg-elev-2', '#1f2637'), muted, 0.55)
    const nowMs = Date.now()
    const darkSurface = isDarkSurface(cssVar('--bg-elev', '#131928'))
    const colorFor = (i: number): string => {
      const n = nodes[i]!
      switch (lens) {
        case 'domain':
          return n.domain !== null ? domainColor(n.domain) : muted
        case 'type':
          return cssVar(TYPE_VARS[n.type] ?? '--muted', '#888')
        case 'authority':
          // On the page's own domain hue, with the accent standing in for a page that has no
          // domain - see `authorityRamp` for why lightness carries the metric.
          return authorityRamp(n.domain !== null ? domainColor(n.domain) : cssVar('--accent', '#5b8def'), authorityT(authorityOf(i)), darkSurface)
        case 'orphans':
          // No backlinks = unreachable except by search. Everything else recedes.
          return n.in === 0 ? cssVar('--err', '#e0645b') : dimBase
        case 'stubs':
          return n.size !== undefined && n.size < STUB_BYTES ? cssVar('--warn', '#e0a43b') : dimBase
        case 'recency': {
          /*
           * `freshMs` is what the page SAYS about itself (`content_updated:`, else `created:`),
           * and the mtime is only the fallback for a page that states neither. The other way
           * round is what made this lens useless: a repair pass rewrites every file, so every
           * mtime lands in the window and the whole graph goes green.
           */
          const changed = n.freshMs ?? n.mtimeMs
          if (changed === undefined) return dimBase
          const t = Math.max(0, 1 - (nowMs - changed) / RECENCY_WINDOW_MS)
          return mixColor(dimBase, cssVar('--ok', '#3fb984'), t)
        }
      }
    }
    const edgeColor = cssVar('--border', '#444')
    const textColor = cssVar('--text-dim', '#aaa')
    /**
     * A node's colour, computed once per frame. The edge pass asks for it twice per bridge
     * and the node pass asks again, and for the metric lenses `colorFor` mixes two colours
     * to get there.
     */
    const nodeColors = new Array<string | undefined>(nodes.length)
    const nodeColor = (i: number): string => (nodeColors[i] ??= colorFor(i))

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.translate(w / 2 + t.x, h / 2 + t.y)
    ctx.scale(t.k, t.k)

    if (pos.length < nodes.length * 2) return

    // The entrance (lib/graphReveal.ts). While the first layout is still cooling the canvas
    // stays empty on purpose: the alternative is a quarter of the graph at 1:1, oversized
    // and moving, followed by a hard cut to the fitted frame. The status chip says so.
    if (holdRef.current) return

    /*
     * The mask. `paints` is the whole of what the overlay does to the drawing: an unpainted
     * node is skipped by the node pass, by the edges that would reach it, by the hulls, by the
     * label candidates, by the overview and by the hit test - which is what makes "the same
     * shape with most of it taken away" true without narrowing anything the layout can see.
     */
    const mask = landmarkMask
    const paints = (i: number): boolean => painted(mask, i)

    const revealStart = revealStartRef.current
    let revealing = false
    let revealT = 1
    if (revealStart !== null) {
      revealT = (performance.now() - revealStart) / REVEAL_MS
      if (revealT >= 1) revealStartRef.current = null
      else revealing = true
    }
    // Hubs land first and the tail fills in behind them; a link needs both its ends, so it
    // follows whichever of the two is later. Off the reveal these are all 1 and cost nothing.
    const revealRank = revealRankRef.current
    const nodeIn = revealing ? (i: number): number => revealAlpha(revealT, revealRank[i] ?? 0) : (): number => 1
    const edgeIn = revealing ? (a: number, b: number): number => Math.min(nodeIn(a), nodeIn(b)) : (): number => 1
    const labelIn = revealing ? revealLabelAlpha(revealT) : 1

    // Spotlight source, in priority order: the transient hover, then the persistent explorer
    // selection, then the URL-level focus. Whichever is active dims everything outside its
    // neighborhood so the local structure reads out of a dense cluster.
    //
    // Hover only counts while a pointer is actually over the canvas - a hover index that
    // outlived its pointer (capture edge cases, focus loss) must never keep the graph dimmed.
    const hovered = lastPointerRef.current === null ? null : hoverRef.current
    // Hover only spotlights when the toggle is on; a click selection always does. The hovered
    // node still keeps its own label + tooltip (via `interactive` below) so pointing still
    // tells you what a node is - only the neighborhood dimming is gated.
    const spotHover = hoverSpotlightRef.current ? hovered : null
    // The hovered COMMUNITY, from either source: a hovered member node, or the pointer
    // resting inside the community's hull between nodes (hullHover) - one highlight, no
    // flicker across the gap. It previews the exact set a click would isolate (Vault.tsx
    // handles the click). Community-less nodes (id -1) fall back to the 1-hop neighborhood,
    // and so do the persistent selection/focus spotlights - those answer "what does THIS
    // page link to", not "what belongs together". A community spanning every visible real
    // node subdivides nothing (an isolated cluster Louvain can't split further) - treated
    // as absent, mirroring the click guard, so the spotlight degrades to 1-hop instead of
    // lighting everything up.
    const rawSpotCid =
      clusters === null ? -1
      : spotHover !== null ? clusters[spotHover] ?? -1
      : hoverSpotlightRef.current && lastPointerRef.current !== null ? hullHoverRef.current ?? -1
      : -1
    const realNodeCount = nodes.length - (ghostIndices?.size ?? 0)
    const spotCid =
      rawSpotCid >= 0 && (clusterSets?.get(rawSpotCid)?.size ?? 0) < realNodeCount ? rawSpotCid : -1
    const active = spotHover ?? selectedIndex ?? focusIndex
    /*
     * Inside the mode a selection marks its node and dims nothing. The list's highlight IS the
     * canvas's selection, so the ordinary neighbourhood spotlight would dim thirty-nine
     * landmarks because one row is marked - and an open neighbourhood needs no dimming either,
     * because everything outside it is off the picture entirely.
     */
    const highlight =
      mask !== null ? null
      : spotCid >= 0 ? clusterSets!.get(spotCid)!
      : active !== null ? new Set([active, ...(neighbors.get(active) ?? [])])
      : null
    // A transient hover (node or hull) may dim hard; a selection/focus spotlight is long-
    // lived, so it dims gently enough that the rest of the graph stays readable underneath.
    const transientSpot = spotHover !== null || spotCid >= 0
    const dimNode = transientSpot ? 0.18 : 0.45
    const dimEdge = transientSpot ? 0.08 : 0.18
    const dimLabel = transientSpot ? 0.15 : 0.4

    // Visible world-rect for culling (small margin for radii/labels).
    const margin = 40 / t.k
    const minX = (-w / 2 - t.x) / t.k - margin
    const maxX = (w / 2 - t.x) / t.k + margin
    const minY = (-h / 2 - t.y) / t.k - margin
    const maxY = (h / 2 - t.y) / t.k + margin
    const visible = (x: number, y: number): boolean => x >= minX && x <= maxX && y >= minY && y <= maxY

    // Cluster hulls, drawn FIRST so everything else sits on top. Each community becomes a
    // tinted, tag-labelled convex blob - making the graph's implicit structure explicit.
    //
    // Region labels are placed in a SECOND pass (placeRegionLabels): each label used to draw
    // above its OWN hull top with no collision test, so overlapping communities (the central
    // biomedical stack) buried each other's labels. Now labels are anchored OUTSIDE every
    // tinted blob and cleared against one another; their boxes then seed the node-label
    // collision list below so a page title can't overwrite a group label either.
    const regionLabelBoxes: Array<[number, number, number, number]> = []
    // With hulls off, the spotlight still traces the HOVERED community's hull (and its label,
    // via the shared `members` map below) - the preview of what a click would isolate.
    if (clusters !== null && (showHulls || spotCid >= 0)) {
      const members = new Map<number, Array<[number, number]>>()
      for (let i = 0; i < nodes.length; i++) {
        const cid = clusters[i]
        if (cid === undefined || cid < 0) continue
        if (!paints(i)) continue // a hull drawn around invisible nodes outlines nothing
        if (!showHulls && cid !== spotCid) continue
        const x = pos[i * 2]!
        const y = pos[i * 2 + 1]!
        if (Number.isNaN(x)) continue
        ;(members.get(cid) ?? members.set(cid, []).get(cid)!).push([x, y])
      }
      ctx.lineWidth = 1.4 / t.k
      const paddedHulls = new Map<number, Pt[]>()
      for (const [cid, pts] of members) {
        if (pts.length < 3) continue // 2 points make no area worth tinting
        const body = hullBody(pts)
        const hull = convexHull(body)
        const cx = body.reduce((s, p) => s + p[0], 0) / body.length
        const cy = body.reduce((s, p) => s + p[1], 0) / body.length
        // Padding in WORLD units, not screen units: a hull whose shape changed with the zoom
        // moved the label anchors with it, which is half of why labels jumped on zoom.
        const padded = expandHull(hull, cx, cy, HULL_PAD)
        paddedHulls.set(cid, padded)
        ctx.beginPath()
        traceSmooth(ctx, padded)
        // Tint by the cluster's dominant domain so the color means something; fall back to a
        // per-id hue only for a community with no domain at all.
        const dom = clusterDomains?.get(cid)
        const hue = dom !== undefined ? domainHue(dom) : clusterHue(cid)
        ctx.fillStyle = `hsl(${hue} 60% 55% / 0.09)`
        ctx.strokeStyle = `hsl(${hue} 60% 60% / 0.4)`
        ctx.fill()
        ctx.stroke()
      }
      // Second pass: measure widths (needs the canvas), place, then draw. Everything here is
      // in WORLD units at a size derived from the graph's extent - never from the live zoom.
      // Mixing the two was the bug behind labels jumping and drifting: the box grew as you
      // zoomed out, nothing near the hull fit any more, and the label was flung across the
      // graph (measured: median 411 world units from its centroid at k=0.35 against 108 at
      // k=4; now identical at every zoom).
      let sMinX = Infinity
      let sMinY = Infinity
      let sMaxX = -Infinity
      let sMaxY = -Infinity
      for (const poly of paddedHulls.values()) {
        for (const [px, py] of poly) {
          if (px < sMinX) sMinX = px
          if (py < sMinY) sMinY = py
          if (px > sMaxX) sMaxX = px
          if (py > sMaxY) sMaxY = py
        }
      }
      const span = Number.isFinite(sMinX) ? Math.hypot(sMaxX - sMinX, sMaxY - sMinY) : 0
      const labelH = Math.min(LABEL_H_MAX, Math.max(LABEL_H_MIN, span * LABEL_H_OF_SPAN))
      const fontWorld = labelH * 0.82
      ctx.font = `600 ${fontWorld}px system-ui, sans-serif`
      const labelInputs: RegionLabelInput[] = []
      // `?labels=off`: an empty input list keeps the whole region-label pass inert.
      if (showLabels) {
        for (const [cid, pts] of members) {
          const label = clusterLabels?.get(cid)
          if (label === undefined || !paddedHulls.has(cid)) continue
          labelInputs.push({ key: cid, width: ctx.measureText(label).width, weight: pts.length })
        }
      }
      const placedLabels = placeRegionLabels(labelInputs, paddedHulls, labelH, labelH * 0.45)
      // Keep the glyphs legible without ever moving them: clamp the on-screen size, then
      // grow each reserved box by the same factor. Shrinking (zoomed in) always fits;
      // growing (zoomed out) may not, and those labels are dropped rather than displaced.
      const drawnWorld = Math.min(
        Math.max(fontWorld, LABEL_MIN_SCREEN_PX / t.k),
        Math.max(fontWorld, LABEL_MAX_SCREEN_PX / t.k),
      )
      const grow = Math.max(1, drawnWorld / fontWorld)
      ctx.font = `600 ${Math.min(drawnWorld, LABEL_MAX_SCREEN_PX / t.k)}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (const p of placedLabels) {
        // Box grown around its own centre, so the anchor - and thus which cluster the label
        // reads as belonging to - is identical at every zoom.
        const bcx = (p.box[0] + p.box[2]) / 2
        const bcy = (p.box[1] + p.box[3]) / 2
        const hw = ((p.box[2] - p.box[0]) / 2) * grow
        const hh = ((p.box[3] - p.box[1]) / 2) * grow
        const drawnBox: Box = [bcx - hw, bcy - hh, bcx + hw, bcy + hh]
        if (grow > 1 && regionLabelBoxes.some((b) => boxesOverlap(drawnBox, b))) continue
        const dom = clusterDomains?.get(p.key)
        const hue = dom !== undefined ? domainHue(dom) : clusterHue(p.key)
        ctx.fillStyle = `hsl(${hue} 55% 62%)`
        ctx.fillText(clusterLabels!.get(p.key)!, bcx, bcy - hh)
        regionLabelBoxes.push(drawnBox)
      }
    }

    // Edges first, faint; highlighted edges stronger. NaN endpoints (a node the worker
    // hasn't placed yet, mid live-update) simply don't draw this frame.
    //
    // Network lens: same 1px thickness (deliberately - brightness/colour carry the emphasis,
    // not weight). Intra-cluster edges lift from 0.35 to 0.5 so the mesh reads; cross-cluster
    // BRIDGES render in a from→to node-colour gradient with a direction arrowhead, turning the
    // point-cloud into a legible network. Classification needs cluster ids and is skipped for
    // ghost links (those keep their dashed "points at a missing page" treatment).
    ctx.lineWidth = 1 / t.k
    /*
     * The context's state is set only where it CHANGES (2026-09-10). Every edge used to
     * assign the dash pattern, the stroke and the alpha before its own stroke() - counted on
     * a vault of a thousand pages that was 5933 setLineDash calls a frame, almost all of them
     * setting an empty dash to an empty dash, and as many redundant style assignments.
     *
     * Batching the segments into one path per look was tried first and is NOT what this is:
     * measured here it HALVED the frame rate, because stroking one path of thousands of
     * segments makes the rasteriser resolve the overlaps analytically, where thousands of
     * one-segment strokes each take a fast path. Kept as a note so it is not tried twice.
     */
    let curDash = false
    let curStroke = ''
    let curAlpha = -1
    const dash = [3 / t.k, 3 / t.k]
    const setDash = (on: boolean): void => {
      if (on === curDash) return
      ctx.setLineDash(on ? dash : [])
      curDash = on
    }
    const setStroke = (color: string): void => {
      if (color === curStroke) return
      ctx.strokeStyle = color
      curStroke = color
    }
    const setAlpha = (a: number): void => {
      if (a === curAlpha) return
      ctx.globalAlpha = a
      curAlpha = a
    }
    ctx.setLineDash([])
    for (const [a, b] of edges) {
      const x1 = pos[a * 2]!
      const y1 = pos[a * 2 + 1]!
      const x2 = pos[b * 2]!
      const y2 = pos[b * 2 + 1]!
      if (Number.isNaN(x1) || Number.isNaN(x2)) continue
      if (!paints(a) || !paints(b)) continue
      if (!visible(x1, y1) && !visible(x2, y2)) continue
      const edgeRev = edgeIn(a, b)
      if (edgeRev <= 0.004) continue
      const lit = highlight !== null && highlight.has(a) && highlight.has(b)
      // Links into a gap are drawn dashed - they point at a page that isn't there yet.
      const toGhost = ghostIndices !== undefined && (ghostIndices.has(a) || ghostIndices.has(b))
      const netOn = network && clusters !== null && !toGhost
      const ca = clusters?.[a] ?? -1
      const cb = clusters?.[b] ?? -1
      const isBridge = netOn && ca >= 0 && cb >= 0 && ca !== cb

      let alpha: number
      if (highlight !== null) alpha = lit ? 0.9 : dimEdge
      else if (isBridge) alpha = 0.85
      else if (netOn) alpha = 0.5 // intra-cluster mesh, subtly more present than the 0.35 default
      else alpha = toGhost ? 0.45 : 0.35

      setDash(toGhost)
      setAlpha(alpha * edgeRev)
      if (isBridge) {
        /*
         * A bridge reads from→to in the two node colours. That was a two-stop linear gradient
         * built per edge per frame - an allocation, and a slower rasterisation than a flat
         * colour. Two solid halves say the same thing at one pixel wide.
         */
        const mx = (x1 + x2) / 2
        const my = (y1 + y2) / 2
        setStroke(nodeColor(a))
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(mx, my)
        ctx.stroke()
        setStroke(nodeColor(b))
        ctx.beginPath()
        ctx.moveTo(mx, my)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      } else {
        setStroke(edgeColor)
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }

      // Direction arrowhead on bridges only (few, so cheap), suppressed when the spotlight
      // dims this edge. Points at the link TARGET, wearing the target node's colour.
      if (isBridge && !(highlight !== null && !lit)) {
        const ang = Math.atan2(y2 - y1, x2 - x1)
        const tx = x1 + (x2 - x1) * 0.62
        const ty = y1 + (y2 - y1) * 0.62
        const ah = 6 / t.k
        setDash(false)
        ctx.fillStyle = nodeColor(b)
        setAlpha(0.9 * edgeRev)
        ctx.beginPath()
        ctx.moveTo(tx + Math.cos(ang) * ah, ty + Math.sin(ang) * ah)
        ctx.lineTo(tx + Math.cos(ang + 2.5) * ah, ty + Math.sin(ang + 2.5) * ah)
        ctx.lineTo(tx + Math.cos(ang - 2.5) * ah, ty + Math.sin(ang - 2.5) * ah)
        ctx.closePath()
        ctx.fill()
      }
    }
    setDash(false)
    ctx.globalAlpha = 1

    // Nodes.
    const now = performance.now()
    let flashActive = false
    for (let i = 0; i < nodes.length; i++) {
      const x = pos[i * 2]!
      const y = pos[i * 2 + 1]!
      if (Number.isNaN(x)) continue
      if (!paints(i)) continue
      if (!visible(x, y)) continue
      const nodeRev = nodeIn(i)
      if (nodeRev <= 0.004) continue
      // A node lands slightly oversized and settles. The pop scales the DRAWN circle only -
      // the hit target and the label anchor keep their radius, so nothing under the pointer
      // moves while the entrance runs.
      const r = radius(i) * (revealing ? revealPop(nodeRev) : 1)
      const dimmed = highlight !== null && !highlight.has(i)
      const isGhost = ghostIndices !== undefined && ghostIndices.has(i)
      // A connector is drawn dim as well as small: it is the glue between chapters, and the
      // landmarks are what the picture is about. Inside one neighbourhood it is not glue but a
      // neighbour like any other, and the list names it, so it is drawn like one.
      const roleAlpha = mask !== null && mask.bloomAnchor === null && mask.connectors.has(i) ? 0.45 : 1
      ctx.globalAlpha = (dimmed ? dimNode : roleAlpha) * nodeRev
      if (isGhost) {
        // Hollow, dashed ring in a faint neutral: present enough to click and count, but
        // visibly not a real page. A tiny fill keeps it hit-testable at its center.
        ctx.fillStyle = cssVar('--muted-bg', '#232a3a')
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.setLineDash([2.5 / t.k, 2.5 / t.k])
        ctx.strokeStyle = cssVar('--text-faint', '#6b7791')
        ctx.lineWidth = 1.4 / t.k
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      } else {
        ctx.fillStyle = nodeColor(i)
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      }
      if (i === focusIndex || i === selectedIndex || matches.has(i)) {
        ctx.globalAlpha = nodeRev
        ctx.strokeStyle = i === selectedIndex ? cssVar('--accent', '#5b8def') : cssVar('--text', '#fff')
        ctx.lineWidth = (i === selectedIndex ? 2.2 : 1.6) / t.k
        ctx.beginPath()
        ctx.arc(x, y, r + 2.5 / t.k, 0, Math.PI * 2)
        ctx.stroke()
      }
      // Arrival flash: an expanding, fading ring on nodes that just appeared (live ingest).
      const born = flashRef.current.get(nodes[i]!.path)
      if (born !== undefined) {
        const age = now - born
        if (age < FLASH_MS) {
          flashActive = true
          const p = age / FLASH_MS
          ctx.globalAlpha = (1 - p) * 0.9 * nodeRev
          ctx.strokeStyle = nodeColor(i)
          ctx.lineWidth = 2 / t.k
          ctx.beginPath()
          ctx.arc(x, y, r + (3 + p * 14) / t.k, 0, Math.PI * 2)
          ctx.stroke()
        } else {
          flashRef.current.delete(nodes[i]!.path)
        }
      }
    }

    // Labels: every visible node is a candidate - no global hub threshold. The old
    // top-8%-by-degree gate concentrated all low-zoom labels in the densest domains
    // (where they overlapped) and left small clusters entirely anonymous, because their
    // local hubs never reached a global cutoff. Candidates draw in priority order
    // (interactive state, spotlight membership, ghosts, cluster representatives, then
    // degree) and a label that would overlap an already-placed one is skipped. The
    // representative tier (labelReps) is the guarantee that every readable cluster keeps
    // at least its strongest label: without it the fixed budget below still fills from the
    // densest regions first, so a detached blob whose best node ranks past the cutoff went
    // unlabeled. Dense regions then show only their local hubs, sparse clusters always get
    // their best labels, and zooming in frees space so culled labels reappear on their own.
    // The order is deterministic (priority, degree, then index), so nothing flickers.
    const candidates: number[] = []
    // `?labels=off`: no candidates, no node-label pass - not even for the hovered node, so
    // the capture stays free of text no matter where the pointer rests.
    if (showLabels) {
      for (let i = 0; i < nodes.length; i++) {
        const x = pos[i * 2]!
        if (Number.isNaN(x)) continue
        if (!paints(i)) continue
        // Connectors stay nameless. They are the glue rather than the entry points, and there
        // are very few of them - naming them would offer a way in where the mode says there
        // is none. A bloom IS named: a click asking to see twelve pages is not answered by
        // twelve anonymous dots.
        if (mask !== null && mask.connectors.has(i) && mask.bloomAnchor === null) continue
        if (!visible(x, pos[i * 2 + 1]!)) continue
        candidates.push(i)
      }
    }
    /*
     * A handful of matches belong in the top tier with hover and selection: you searched for
     * them, and three labels among a hundred nodes is the answer. Eighty of them is not - the
     * tier has no collision budget of its own, so every match then fights every other match
     * for the same space and the drawing reads as a word cloud (measured 2026-09-16 on a tag
     * search). Past the threshold they fall back into the ordinary ranking, where degree and
     * the collision check decide, and the picture labels its hubs again.
     */
    const MATCH_LABEL_LIMIT = 8
    const matchesLead = matches.size <= MATCH_LABEL_LIMIT
    const interactive = (i: number): boolean =>
      i === hovered || i === selectedIndex || i === focusIndex || (matchesLead && matches.has(i))
    const prio = (i: number): number =>
      interactive(i) ? 4
      : highlight !== null && highlight.has(i) ? 3
      : ghostIndices !== undefined && ghostIndices.has(i) ? 2
      : labelReps.has(i) ? 1
      : 0
    candidates.sort((a, b) => {
      const pd = prio(b) - prio(a)
      if (pd !== 0) return pd
      const dd = nodes[b]!.in + nodes[b]!.out - (nodes[a]!.in + nodes[a]!.out)
      return dd !== 0 ? dd : a - b
    })
    // More labels never fit collision-free on one screen anyway; the examined cap bounds
    // the measureText work when a huge vault fills the viewport.
    const MAX_LABELS = 60
    const MAX_EXAMINED = 400
    const labelH = 13 / t.k
    const padX = 2 / t.k
    const halo = cssVar('--bg', '#0d1117')
    // Seeded with the region labels so a node title never overwrites a group label.
    const placed: Array<[number, number, number, number]> = [...regionLabelBoxes]
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    let drawn = 0
    // Labels are last in. The collision solver has nothing stable to place against while
    // nodes are still arriving, and forty titles appearing mid-reveal is its own flicker.
    let examined = 0
    for (const i of candidates) {
      if (labelIn <= 0.004) break
      if (drawn >= MAX_LABELS || examined >= MAX_EXAMINED) break
      examined++
      const n = nodes[i]!
      const isGhost = ghostIndices !== undefined && ghostIndices.has(i)
      const full = interactive(i)
      // Long titles are the main space hogs - truncate unless the node is the one the
      // user is interacting with (the tooltip carries the full title regardless).
      const text = !full && n.title.length > 30 ? `${n.title.slice(0, 28)}…` : n.title
      ctx.font = `${isGhost ? 'italic ' : ''}${11 / t.k}px system-ui, sans-serif`
      const w = ctx.measureText(text).width
      const x = pos[i * 2]!
      const y = pos[i * 2 + 1]! + radius(i) + 3 / t.k
      const box: [number, number, number, number] = [x - w / 2 - padX, y, x + w / 2 + padX, y + labelH]
      // Interactive labels skip the cull - "what am I pointing at" must always answer.
      if (!full && placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) {
        continue
      }
      placed.push(box)
      drawn++
      ctx.globalAlpha = (highlight !== null && !highlight.has(i) ? dimLabel : 0.95) * labelIn
      // A halo in the background color keeps text legible across edges and foreign nodes.
      ctx.lineWidth = 3 / t.k
      ctx.strokeStyle = halo
      ctx.strokeText(text, x, y)
      ctx.fillStyle = isGhost ? cssVar('--text-faint', '#6b7791') : textColor
      ctx.fillText(text, x, y)
    }
    ctx.globalAlpha = 1
    paintedRef.current = true

    // Keep animating while any arrival flash is fading, or the entrance is still building
    // in (rAF-coalesced, self-terminating).
    if (flashActive || revealing) scheduleDrawRef.current?.()
  }, [nodes, edges, focusIndex, selectedIndex, ghostIndices, matches, lens, clusters, clusterSets, clusterLabels, clusterDomains, showHulls, showLabels, network, neighbors, labelReps, radius, authorityT, authorityOf, landmarkMask, positionsRef, transformRef])

  /**
   * After every frame: is anything on screen at all, and where is the rest of the graph?
   * Both read the same refs the draw just used, so they can never disagree with the picture.
   */
  const overlayPass = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!paintedRef.current) {
      const blank = miniRef.current
      if (blank !== null && !blank.hidden) blank.hidden = true
      if (offMapRef.current) {
        offMapRef.current = false
        setOffMap(false)
      }
      return
    }
    const dpr = window.devicePixelRatio || 1
    const vp: Viewport = { w: canvas.width / dpr, h: canvas.height / dpr }
    const pos = positionsRef.current
    const t = transformRef.current
    const vis = visibleNodes(t, vp, pos)
    const lost = vis.placed > 0 && vis.inView === 0
    if (lost !== offMapRef.current) {
      offMapRef.current = lost
      setOffMap(lost)
    }
    const mini = miniRef.current
    /*
     * The overview shows what is painted; its BOUNDS stay the whole layout's, because that is
     * what the camera relates to and the mask moves no camera. So the frame keeps meaning what
     * it meant and the dots inside it are the picture.
     */
    if (mini) drawMinimap(mini, t, vp, pos, dpr, isPainted)
  }, [positionsRef, transformRef, isPainted])
  const scheduleDraw = useRafDraw(() => {
    draw()
    overlayPass()
  })
  const scheduleDrawRef = useRef<(() => void) | null>(null)
  scheduleDrawRef.current = scheduleDraw

  /** Centers and scales the transform so the whole layout fits with a small margin. */
  const fitToView = useCallback((): void => {
    const canvas = canvasRef.current
    const pos = positionsRef.current
    if (!canvas || pos.length < 2) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.width / dpr
    const h = canvas.height / dpr
    // Fit the FULL extent by default - cropping to an inner percentile leaves real nodes
    // outside the initial frame ("the graph doesn't fit"). Only when a few stragglers blow
    // the extent far beyond the body of the graph (full span > 3× the 5-95 core) does the
    // fit fall back to the core; those outliers stay reachable by panning.
    // A fit may be asked to frame PART of the picture (`fitSubset`); nothing else about the
    // drawing changes, and a subset that turns out to hold no placed node frames nothing rather
    // than everything.
    const only = fitSubsetRef.current
    const framed = (i: number): boolean => only === null || only.has(i)
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < pos.length; i += 2) {
      if (Number.isNaN(pos[i]!)) continue // unplaced mid-update nodes have no extent yet
      if (!framed(i / 2)) continue
      xs.push(pos[i]!)
      ys.push(pos[i + 1]!)
    }
    if (xs.length === 0) return
    xs.sort((a, b) => a - b)
    ys.sort((a, b) => a - b)
    const bounds = (arr: number[]): [number, number] => {
      const full: [number, number] = [arr[0]!, arr[arr.length - 1]!]
      const core: [number, number] = [
        arr[Math.floor(arr.length * 0.05)]!,
        arr[Math.min(arr.length - 1, Math.ceil(arr.length * 0.95))]!,
      ]
      return full[1] - full[0] > Math.max(1, core[1] - core[0]) * 3 ? core : full
    }
    const [minX, maxX] = bounds(xs)
    const [minY, maxY] = bounds(ys)
    /*
     * A node is not its centre (fixed 2026-09-16). The extent above was the centres alone, and
     * the frame then cut the outermost circles in half and their labels off entirely - worst
     * on a small subgraph, where a handful of nodes zooms in far enough that a 12-unit radius
     * is most of a hundred screen pixels. Two corrections, in the two spaces they belong to:
     *
     *   the RADIUS is world-space, so it widens the span;
     *   the LABEL is screen-space (11px text, 13px line, 3px gap, whatever the zoom), so it
     *   is a pad - and it hangs BELOW its node, which is why the pads are asymmetric.
     */
    let rMax = 0
    for (let i = 0; i < pos.length; i += 2) {
      if (Number.isNaN(pos[i]!)) continue
      if (!framed(i / 2)) continue
      rMax = Math.max(rMax, radius(i / 2))
    }
    const spanX = Math.max(1, maxX - minX + 2 * rMax)
    const spanY = Math.max(1, maxY - minY + 2 * rMax)
    // Sideways the labels are centred on their nodes and reach further than any radius does;
    // this is the old flat pad, kept, because a title's width is not worth measuring here.
    const padX = 110
    const padTop = 18
    const padBottom = 40 // the label's own line, plus the gap above it and air below
    const k = Math.min(8, Math.max(0.15, Math.min((w - padX) / spanX, (h - padTop - padBottom) / spanY)))
    transformRef.current = {
      k,
      x: -((minX + maxX) / 2) * k,
      // The usable box sits above the viewport's middle by half the difference of the pads,
      // so the content has to move with it or the room made at the bottom is spent at the top.
      y: -((minY + maxY) / 2) * k - (padBottom - padTop) / 2,
    }
    scheduleDraw()
  }, [scheduleDraw, positionsRef, transformRef, radius])

  // ---------------------------------------------------------------- layout worker session
  //
  // ONE worker for the whole mount; each node/edge change posts a new layout generation.
  // The worker interrupts whatever it was cooling and frames tagged with an old generation
  // are dropped here - so a burst of live updates can never interleave stale positions.

  const workerRef = useRef<Worker | null>(null)
  /** The generation counter and the path list the in-flight layout was posted with. */
  const layoutRef = useRef<{ gen: number; paths: string[] }>({
    gen: 0,
    // A remount picks up the persisted layout's paths so replayed worker frames land
    // in the right posByPath slots.
    paths: mem.lastMsg.current?.paths ?? [],
  })
  const fitPendingRef = useRef(false)

  /**
   * The entrance (lib/graphReveal.ts). `hold` is true from the first posted layout until
   * there is a settled frame - nothing is drawn while it is, because what a cooling layout
   * looks like at the identity transform is a quarter of the graph, oversized and moving.
   * `revealStart` is the timestamp the build-in began, or null when nothing is revealing.
   */
  const holdRef = useRef(false)
  const revealStartRef = useRef<number | null>(null)
  /** Reveal order for the CURRENT node order, hubs at 0. Rebuilt with every armed entrance. */
  const revealRankRef = useRef<Float32Array>(new Float32Array(0))
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Blank the canvas and queue the build-in for when the layout settles. Armed by the first
   * layout, and by any view change that re-lays the graph out (a filter cleared, a domain
   * hidden): those re-fit too, and a fit applied to a still-cooling layout is exactly the
   * oversized, moving frame the entrance exists to skip - it was on screen for the second or
   * so of cooling and then cut to the build-in, so the graph appeared twice.
   *
   * Not armed by live vault updates: they keep the camera and reheat gently, and blanking the
   * whole graph because one page arrived would be a far worse flicker than the one this fixes.
   */
  const armEntrance = useCallback((): void => {
    // An empty graph has nothing to hold back and nothing to reveal - and the canvas is
    // where its "nothing matches" state is drawn.
    if (nodes.length === 0) return
    holdRef.current = true
    // Fix the order while the node order is right here - it changes between layouts.
    revealRankRef.current = revealOrder(nodes.map((n) => n.in + n.out))
    if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current)
    holdTimerRef.current = setTimeout(() => beginEntranceRef.current(), REVEAL_HOLD_MAX_MS)
    scheduleDrawRef.current?.()
  }, [nodes])
  // Held in a ref so the effects can arm the entrance without taking `nodes` as a dependency
  // (the layout effect already has it; the fit effect must stay keyed on the view alone).
  const armEntranceRef = useRef(armEntrance)
  armEntranceRef.current = armEntrance

  /**
   * Release the hold and start the build-in. Called when the first layout settles, and by
   * the hold's own timeout - a canvas that draws nothing needs a way out even if the worker
   * never reports a settled frame.
   */
  const beginEntrance = useCallback((): void => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    holdRef.current = false
    // Guarded on the FIT being owed, not on the hold: the empty-graph path releases the hold
    // on its own, and guarding on that would let a graph that emptied and refilled mid-layout
    // skip its first framing entirely.
    if (!fitPendingRef.current) return
    fitPendingRef.current = false
    fittedRef.current = true
    fitToView()
    // Reduced motion still gets the fix - the hold and the fit are the correctness half.
    // What it does not get is the animation, so the fitted graph is simply there.
    revealStartRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? null
      : performance.now()
    scheduleDrawRef.current?.()
  }, [fitToView, fittedRef])
  const beginEntranceRef = useRef(beginEntrance)
  beginEntranceRef.current = beginEntrance
  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current)
    },
    [],
  )

  const postLayout = useCallback((): void => {
    const msg = lastMsgRef.current
    const worker = workerRef.current
    if (!msg || !worker) return
    // The seed buffer is transferred, so every post ships a fresh copy. `groups` is cloned,
    // not transferred - the message must stay re-postable.
    const seed = msg.seed.slice()
    worker.postMessage(
      { gen: layoutRef.current.gen, nodes: msg.degrees, edges: msg.edges, groups: msg.groups, seed, alpha: msg.alpha },
      { transfer: [seed.buffer] },
    )
  }, [lastMsgRef])

  useEffect(() => {
    const worker = new Worker(new URL('../lib/graphLayout.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (ev: MessageEvent<WorkerFrame>) => {
      const { gen, type, positions } = ev.data
      if (gen !== layoutRef.current.gen) return // superseded layout - drop the frame
      positionsRef.current = positions
      const byPath = posByPathRef.current
      const paths = layoutRef.current.paths
      for (let i = 0; i < paths.length; i++) {
        byPath.set(paths[i]!, { x: positions[i * 2]!, y: positions[i * 2 + 1]! })
      }
      if (type === 'done') {
        settledRef.current = true
        setLayouting(false)
        // Frame the FIRST finished layout once, so a graph of any size lands filling the
        // viewport instead of as a speck, and build it in from there. Later layouts (live
        // updates, filter toggles) leave the camera alone and never re-run the entrance -
        // nothing yanks the user away, and nothing flashes, mid-look.
        if (fitPendingRef.current) beginEntranceRef.current()
      }
      // Nodes just moved under a possibly stationary cursor - re-resolve the hover, or a
      // node that drifted away from the pointer keeps its neighborhood highlight stuck.
      refreshHoverRef.current()
      scheduleDrawRef.current?.()
    }
    // A recreated worker (remount, dev StrictMode double-mount) starts empty. Replay only
    // when the last layout was still cooling - a settled layout's positions are already
    // persisted, and re-posting would make the graph jiggle on every return to this view.
    if (!settledRef.current) postLayout()
    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [fitToView, postLayout, positionsRef, settledRef])

  useEffect(() => {
    if (nodes.length === 0) {
      layoutRef.current = { gen: layoutRef.current.gen + 1, paths: [] } // orphan in-flight frames
      lastMsgRef.current = null
      positionsRef.current = new Float32Array(0)
      // Nothing to wait for and nothing to reveal - a hold left armed here would blank the
      // canvas for the empty-state message that belongs on it.
      holdRef.current = false
      revealStartRef.current = null
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current)
        holdTimerRef.current = null
      }
      setLayouting(false)
      scheduleDraw()
      return
    }

    // The layout's domain grouping (graphForces.ts). Deterministic from node order, so two
    // builds over identical node lists yield identical arrays - comparable in the skip check.
    const groups = domainGroups(nodes.map((n) => n.domain))

    // Structurally identical to the last posted layout (a refetch where only mtimes moved,
    // or StrictMode's second effect pass)? Then there is nothing to re-settle - skip. A
    // changed domain (governance reassignment) counts as structural: the grouping forces
    // depend on it, so it must reheat the layout even with paths and edges unchanged.
    const prev = lastMsgRef.current
    if (
      prev !== null &&
      prev.paths.length === nodes.length &&
      prev.edges.length === edges.length &&
      nodes.every((n, i) => n.path === prev.paths[i]) &&
      edges.every((e, i) => e[0] === prev.edges[i]![0] && e[1] === prev.edges[i]![1]) &&
      groups.every((g, i) => g === prev.groups[i])
    ) {
      return
    }

    const byPath = posByPathRef.current
    const firstLayout = byPath.size === 0
    const newPaths: number[] = []
    const seed = new Float32Array(nodes.length * 2)
    for (let i = 0; i < nodes.length; i++) {
      const known = byPath.get(nodes[i]!.path)
      if (known) {
        seed[i * 2] = known.x
        seed[i * 2 + 1] = known.y
      } else {
        seed[i * 2] = NaN
        seed[i * 2 + 1] = NaN
        newPaths.push(i)
      }
    }

    // New nodes start at their placed neighbors' centroid (plus a small golden-angle offset
    // so siblings don't stack) - a page appearing mid-ingest surfaces where it belongs
    // instead of flying across the view from d3's default spiral.
    if (!firstLayout && newPaths.length > 0) {
      const adj = new Map<number, number[]>()
      for (const [a, b] of edges) {
        if (!adj.has(a)) adj.set(a, [])
        if (!adj.has(b)) adj.set(b, [])
        adj.get(a)!.push(b)
        adj.get(b)!.push(a)
      }
      for (const i of newPaths) {
        let sx = 0
        let sy = 0
        let count = 0
        for (const nb of adj.get(i) ?? []) {
          const x = seed[nb * 2]!
          if (Number.isNaN(x)) continue
          sx += x
          sy += seed[nb * 2 + 1]!
          count++
        }
        if (count > 0) {
          const angle = i * 2.399963 // golden angle: deterministic spread for co-arriving pages
          seed[i * 2] = sx / count + Math.cos(angle) * 12
          seed[i * 2 + 1] = sy / count + Math.sin(angle) * 12
        }
        flashRef.current.set(nodes[i]!.path, performance.now())
      }
    }

    // Cold start when nothing is placed yet or the view changed shape substantially
    // (unhiding a whole bucket); gentle reheat for everything else - that is what keeps a
    // live update a "reorientation" instead of a re-deal.
    const cold = firstLayout || newPaths.length > nodes.length * COLD_RESTART_SHARE
    if (firstLayout) {
      fitPendingRef.current = true
      armEntranceRef.current()
    }
    if (cold) setLayouting(true)

    // Align the drawn positions with the new node order IMMEDIATELY (indices shift when the
    // sorted node list changes) - known nodes render in place this very frame, before the
    // worker's first tick arrives; unplaced ones are NaN and skip drawing.
    positionsRef.current = seed.slice()
    scheduleDraw()

    const paths = nodes.map((n) => n.path)
    layoutRef.current = { gen: layoutRef.current.gen + 1, paths }
    lastMsgRef.current = {
      paths,
      degrees: nodes.map((n) => ({ degree: n.in + n.out })),
      edges,
      groups,
      seed,
      alpha: cold ? 1 : 0.3,
    }
    settledRef.current = false
    postLayout()
  }, [nodes, edges, scheduleDraw, postLayout, lastMsgRef, positionsRef, settledRef])

  // A changed fitKey = the user changed the visible subgraph (filter/depth toggle) - re-fit
  // so the remaining graph fills the canvas. Runs AFTER the layout effect above, so
  // `settledRef` already reflects whether that change posted a re-layout: when one is
  // cooling the canvas goes blank and the entrance frames and builds it in on settle, and
  // when none is (a view change that only re-frames) the fit here is the whole job. First
  // mount keeps the first-layout fit path.
  // `undefined` when the host wants a fit on mount: the first run of the effect below then
  // sees a changed key and frames the graph, instead of trusting a camera from another view.
  const prevFitKeyRef = useRef<string | undefined>(fitOnMount ? undefined : fitKey)
  useEffect(() => {
    if (prevFitKeyRef.current === fitKey) return
    const first = prevFitKeyRef.current === undefined
    prevFitKeyRef.current = fitKey
    userMovedRef.current = false // an explicit view change wins over an old pan/zoom
    if (!settledRef.current) {
      // A re-layout is cooling: blank the canvas and let the entrance do the framing when it
      // settles. The fit below still runs, on positions nothing is drawing - what the reader
      // used to see instead was that half-cooled frame, fitted, until the build-in cut it.
      fitPendingRef.current = true
      armEntranceRef.current()
    }
    // A mount fit has to wait for the canvas to be measured: the sizing effect runs after
    // this one, and fitting a zero-sized canvas leaves the camera anywhere but on the graph.
    if (first) {
      const raf = requestAnimationFrame(() => fitToView())
      return () => cancelAnimationFrame(raf)
    }
    fitToView()
    return undefined
  }, [fitKey, fitToView, settledRef, userMovedRef])

  // Canvas sizing (device-pixel aware) + redraw on resize and theme change.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement!
    const resize = (): void => {
      // Hidden (a display:none tab panel) → 0×0; sizing the canvas to that would wipe it.
      // Skip; the observer fires again with the real size when the panel re-shows.
      if (parent.clientWidth === 0 || parent.clientHeight === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = parent.clientWidth * dpr
      canvas.height = parent.clientHeight * dpr
      canvas.style.width = `${parent.clientWidth}px`
      canvas.style.height = `${parent.clientHeight}px`
      // Re-frame on resize (including the first layout pass, which lands before the
      // element has its final size) - but never fight a user who has panned or zoomed.
      if (fittedRef.current && !userMovedRef.current) fitToView()
      else scheduleDraw()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(parent)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = (): void => scheduleDraw()
    mq.addEventListener('change', onTheme)
    return () => {
      ro.disconnect()
      mq.removeEventListener('change', onTheme)
    }
  }, [scheduleDraw, fitToView, fittedRef, userMovedRef])

  // Repaint when pure-presentation props change (search rings, focus, selection, color axis)
  // - these must not depend on a pointer move or a layout tick happening to come along.
  useEffect(() => {
    scheduleDraw()
  }, [matches, focusIndex, selectedIndex, ghostIndices, lens, clusters, clusterLabels, spotlight, landmarkMask, scheduleDraw])

  /** Screen → world coordinates under the current transform. */
  const toWorld = useCallback((sx: number, sy: number): { x: number; y: number } => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current
    return {
      x: (sx - rect.left - rect.width / 2 - t.x) / t.k,
      y: (sy - rect.top - rect.height / 2 - t.y) / t.k,
    }
  }, [transformRef])

  const hitTest = useCallback(
    (sx: number, sy: number): number | null => {
      const pos = positionsRef.current
      if (pos.length < nodes.length * 2) return null
      const { x, y } = toWorld(sx, sy)
      const slop = 6 / transformRef.current.k
      let best: number | null = null
      let bestD = Infinity
      for (let i = 0; i < nodes.length; i++) {
        // Unpainted is unclickable: a click on where it stands is a click on the background.
        if (!isPainted(i)) continue
        const dx = pos[i * 2]! - x
        const dy = pos[i * 2 + 1]! - y
        const d = dx * dx + dy * dy // NaN for unplaced nodes → both comparisons false
        const r = radius(i) + slop
        if (d < r * r && d < bestD) {
          best = i
          bestD = d
        }
      }
      return best
    },
    [nodes, radius, isPainted, toWorld, positionsRef, transformRef],
  )

  /**
   * Community-hull hit-test for the spotlight (screen coords → isolatable cid, or -1): the
   * whole tinted hull is one hover/click surface, so the highlight doesn't flicker off
   * between member nodes and isolating doesn't demand a precise node hit. Padded hulls are
   * rebuilt lazily, at most once per DRAWN frame - positions drift while the layout cools,
   * and the draw epoch is the cheapest "world changed" signal there is. Overlapping hulls
   * (a dense domain's sub-communities interleave) resolve to the nearest member's community.
   * Spanning communities (nothing to isolate) are skipped, mirroring isolatableCidOf.
   */
  const drawEpochRef = useRef(0)
  const clusterGeomRef = useRef<{ epoch: number; geoms: ClusterGeom[] }>({ epoch: -1, geoms: [] })
  /**
   * Every community's members, padded hull, center and extent - the one geometry the hull
   * hit-test and the zoom magnet (graphZoom.ts) both read. Rebuilt when the world changed
   * (the draw epoch), never per query.
   */
  const clusterGeoms = useCallback((): ClusterGeom[] => {
    if (clusters === null) return []
    const pos = positionsRef.current
    if (pos.length < nodes.length * 2) return []
    const cache = clusterGeomRef.current
    if (cache.epoch === drawEpochRef.current) return cache.geoms
    cache.epoch = drawEpochRef.current
    const members = new Map<number, Pt[]>()
    for (let i = 0; i < nodes.length; i++) {
      const cid = clusters[i] ?? -1
      if (cid < 0) continue
      const x = pos[i * 2]!
      if (Number.isNaN(x)) continue
      ;(members.get(cid) ?? members.set(cid, []).get(cid)!).push([x, pos[i * 2 + 1]!])
    }
    const pad = 26 / transformRef.current.k
    const geoms: ClusterGeom[] = []
    for (const [cid, pts] of members) {
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const [px, py] of pts) {
        if (px < x0) x0 = px
        if (px > x1) x1 = px
        if (py < y0) y0 = py
        if (py > y1) y1 = py
      }
      // Same trimmed body as the drawn hull, so the clickable surface matches the tint
      // and doesn't reach into empty space along a cross-domain member's tongue.
      const body = pts.length >= 3 ? hullBody(pts) : pts
      const cx = body.reduce((s, p) => s + p[0], 0) / body.length
      const cy = body.reduce((s, p) => s + p[1], 0) / body.length
      const hull = pts.length >= 3 ? expandHull(convexHull(body), cx, cy, pad) : []
      geoms.push({ id: cid, members: pts, hull, cx, cy, extent: Math.max(x1 - x0, y1 - y0) })
    }
    cache.geoms = geoms
    return geoms
  }, [clusters, nodes.length, positionsRef, transformRef])

  const hitCluster = useCallback(
    (sx: number, sy: number): number => {
      if (!spotlight || clusters === null || clusterSets === null) return -1
      const geoms = clusterGeoms()
      if (geoms.length === 0) return -1
      const pos = positionsRef.current
      const { x, y } = toWorld(sx, sy)
      const realN = nodes.length - (ghostIndices?.size ?? 0)
      let best = -1
      let bestD = Infinity
      for (const g of geoms) {
        if (g.hull.length < 3 || !pointInPolygon(x, y, g.hull)) continue
        const set = clusterSets.get(g.id)
        if (set === undefined || set.size >= realN) continue
        for (const i of set) {
          const dx = pos[i * 2]! - x
          const dy = pos[i * 2 + 1]! - y
          const d = dx * dx + dy * dy
          if (d < bestD) {
            bestD = d
            best = g.id
          }
        }
      }
      return best
    },
    [spotlight, clusters, clusterSets, nodes.length, ghostIndices, toWorld, clusterGeoms, positionsRef],
  )

  // ---- hover refresh: the hover is only correct at the moment of a pointer event, but the
  // world also moves WITHOUT one - layout ticks drift nodes under a stationary cursor, a pan
  // ends with the world shifted, and a node-set change (filter/SSE) reuses the stale INDEX
  // for a different page. One mechanism covers all three: remember where the pointer is and
  // re-hit-test there whenever the world changed.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  const refreshHover = useCallback((): void => {
    const at = lastPointerRef.current
    const next = at === null ? null : hitTest(at.x, at.y)
    if (next !== hoverRef.current) {
      setHover(next)
      scheduleDraw()
    }
    const hcid = at === null || next !== null ? -1 : hitCluster(at.x, at.y)
    const nextHull = hcid >= 0 ? hcid : null
    if (nextHull !== hullHoverRef.current) {
      setHullHover(nextHull)
      scheduleDraw()
    }
  }, [hitTest, hitCluster, scheduleDraw])
  const refreshHoverRef = useRef(refreshHover)
  refreshHoverRef.current = refreshHover

  // A changed node set means the old hover index labels a DIFFERENT page now - re-resolve
  // it from the cursor position (or clear it when the pointer is off-canvas).
  useEffect(() => {
    refreshHover()
  }, [nodes, refreshHover])

  // Losing window focus (alt-tab, devtools) fires no pointerleave - drop the hover there
  // too, or the spotlight would greet the user dimmed when they come back.
  useEffect(() => {
    const onBlur = (): void => {
      lastPointerRef.current = null
      if (hoverRef.current !== null) setHover(null)
      if (hullHoverRef.current !== null) setHullHover(null)
      scheduleDraw()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [scheduleDraw])

  /**
   * The tooltip follows the pointer, clamped inside the wrap - its old fixed bottom-left
   * slot is the trail's, and the two overlapped on every hover once a trail existed (the
   * trail's CSS even claimed otherwise). Positioned by direct style writes, not state: a
   * React re-render per pointermove would be pure waste when only the transform changes.
   * Near the right/bottom edges it flips to the other side of the pointer.
   */
  const tooltipRef = useRef<HTMLDivElement>(null)
  const positionTooltip = useCallback((clientX: number, clientY: number): void => {
    const tip = tooltipRef.current
    const wrap = canvasRef.current?.parentElement
    if (tip === null || !wrap) return
    const rect = wrap.getBoundingClientRect()
    const pad = 8
    let x = clientX - rect.left + 14
    let y = clientY - rect.top + 18
    if (x + tip.offsetWidth + pad > rect.width) x = clientX - rect.left - tip.offsetWidth - 12
    if (y + tip.offsetHeight + pad > rect.height) y = clientY - rect.top - tip.offsetHeight - 14
    tip.style.transform = `translate(${Math.max(pad, x)}px, ${Math.max(pad, y)}px)`
  }, [])
  // The div mounts one commit AFTER the hover begins - place it before that first paint,
  // or it would flash at the wrap's origin.
  useLayoutEffect(() => {
    const at = lastPointerRef.current
    if ((hover !== null || hullHover !== null) && at !== null) positionTooltip(at.x, at.y)
  }, [hover, hullHover, positionTooltip])

  /**
   * Zoom to `next`, keeping the world point under client coords (sx, sy) fixed, then leash
   * the result (graphZoom.ts): the graph's box and the picture keep overlapping, so no zoom
   * can end on an empty canvas.
   */
  const zoomAt = useCallback((sx: number, sy: number, next: number): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const vp: Viewport = { w: rect.width, h: rect.height }
    zoomTransform(transformRef.current, vp, sx - rect.left, sy - rect.top, next)
    leash(transformRef.current, vp, worldBounds(positionsRef.current))
    userMovedRef.current = true
  }, [positionsRef, transformRef, userMovedRef])

  /** Button zoom: around the canvas center. */
  const zoomBy = (factor: number): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, clampK(transformRef.current.k * factor))
    scheduleDraw()
  }

  /**
   * Where a zoom-in from client coords (sx, sy) aims: the magnet of graphZoom.ts - the
   * community within reach while it is small on screen, the cursor once it fills the
   * picture. Without communities, the nodes within reach stand in for a cluster.
   */
  const anchorFor = useCallback(
    (sx: number, sy: number): { x: number; y: number } => {
      const canvas = canvasRef.current
      if (!canvas) return { x: sx, y: sy }
      const rect = canvas.getBoundingClientRect()
      const vp: Viewport = { w: rect.width, h: rect.height }
      const cx = sx - rect.left
      const cy = sy - rect.top
      const geoms = clusterGeoms()
      const a =
        geoms.length > 0
          ? magnetAnchor(transformRef.current, vp, cx, cy, geoms)
          : localAnchor(transformRef.current, vp, cx, cy, positionsRef.current)
      return { x: a.x + rect.left, y: a.y + rect.top }
    },
    [clusterGeoms, positionsRef, transformRef],
  )

  // Smooth zoom and the way-back pan: the wheel (or the button) writes a target, one rAF
  // loop approaches it. A fixed anchor per gesture is what keeps the approach smooth: every
  // frame re-applies zoomAt around the same point. Reduced motion skips the loop entirely.
  const zoomAnimRef = useRef<{ k: number; ax: number; ay: number } | null>(null)
  const panAnimRef = useRef<{ x: number; y: number } | null>(null)
  const animRunningRef = useRef(false)
  const runAnim = useCallback((): void => {
    if (animRunningRef.current) return
    animRunningRef.current = true
    const step = (): void => {
      let more = false
      const z = zoomAnimRef.current
      if (z !== null) {
        const t = transformRef.current
        let next = t.k + (z.k - t.k) * 0.32
        if (Math.abs(z.k - next) < 0.003) {
          next = z.k
          zoomAnimRef.current = null
        } else more = true
        zoomAt(z.ax, z.ay, next)
      }
      const p = panAnimRef.current
      if (p !== null) {
        const t = transformRef.current
        t.x += (p.x - t.x) * 0.22
        t.y += (p.y - t.y) * 0.22
        if (Math.hypot(p.x - t.x, p.y - t.y) < 0.5) {
          t.x = p.x
          t.y = p.y
          panAnimRef.current = null
        } else more = true
      }
      refreshHoverRef.current()
      scheduleDraw()
      if (more) requestAnimationFrame(step)
      else animRunningRef.current = false
    }
    requestAnimationFrame(step)
  }, [zoomAt, scheduleDraw, transformRef])

  /** The way back when nothing is on screen: center the nearest community (or node), animated. */
  const goToNearest = (): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const target = nearestMass(transformRef.current, { w: rect.width, h: rect.height }, clusterGeoms(), positionsRef.current)
    if (target === null) return
    const to = centerOn(transformRef.current, target.x, target.y)
    userMovedRef.current = true
    if (REDUCED_MOTION) {
      transformRef.current.x = to.x
      transformRef.current.y = to.y
      refreshHover()
      scheduleDraw()
      return
    }
    panAnimRef.current = to
    runAnim()
  }

  /** A click on the overview centers the picture there (graphZoom.ts minimap projection). */
  const onMiniPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.stopPropagation()
    const canvas = canvasRef.current
    const bounds = worldBounds(positionsRef.current)
    if (!canvas || bounds === null) return
    const rect = e.currentTarget.getBoundingClientRect()
    const m = miniProjection(bounds)
    const wx = (e.clientX - rect.left - m.ox) / m.s
    const wy = (e.clientY - rect.top - m.oy) / m.s
    const t = transformRef.current
    Object.assign(t, centerOn(t, wx, wy))
    const c = canvas.getBoundingClientRect()
    leash(t, { w: c.width, h: c.height }, bounds)
    userMovedRef.current = true
    panAnimRef.current = null
    refreshHover()
    scheduleDraw()
  }

  // Pointer events cover mouse AND touch: drag to pan, wheel or two-finger pinch to zoom,
  // click/tap to select. All active pointers are tracked so a second touch turns the pan
  // into a pinch.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const pinch = useRef<{ dist: number; k: number } | null>(null)
  /** True from pinch start until the last finger lifts - suppresses the tap-select. */
  const pinchedRef = useRef(false)
  /**
   * The previous tap, for double-tap detection. Hand-rolled (not onDoubleClick) because it
   * must work for touch too, and keyed by PATH, not index - a live update between the two
   * taps shifts indices, and opening the wrong page would be worse than missing the gesture.
   */
  const lastTapRef = useRef<{ time: number; path: string } | null>(null)

  const onPointerDown = (e: React.PointerEvent): void => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: transformRef.current.k }
      pinchedRef.current = true
      drag.current = null
    } else {
      drag.current = { x: e.clientX, y: e.clientY, moved: false }
    }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    lastPointerRef.current = { x: e.clientX, y: e.clientY }
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (dist > 0 && pinch.current.dist > 0) {
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, clampK((pinch.current.k * dist) / pinch.current.dist))
        scheduleDraw()
      }
      return
    }
    if (drag.current) {
      const dx = e.clientX - drag.current.x
      const dy = e.clientY - drag.current.y
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true
      transformRef.current.x += dx
      transformRef.current.y += dy
      // The leash holds a drag the same way it holds a zoom: the graph never leaves the picture.
      const rect = e.currentTarget.getBoundingClientRect()
      leash(transformRef.current, { w: rect.width, h: rect.height }, worldBounds(positionsRef.current))
      userMovedRef.current = true
      drag.current.x = e.clientX
      drag.current.y = e.clientY
      scheduleDraw()
      return
    }
    const hit = hitTest(e.clientX, e.clientY)
    if (hit !== hoverRef.current) {
      setHover(hit)
      scheduleDraw()
    }
    // Between member nodes the pointer is still INSIDE the community's hull - keep the
    // cluster highlight up via the hull hit-test instead of letting it flicker off.
    const hcid = hit === null ? hitCluster(e.clientX, e.clientY) : -1
    const nextHull = hcid >= 0 ? hcid : null
    if (nextHull !== hullHoverRef.current) {
      setHullHover(nextHull)
      scheduleDraw()
    }
    positionTooltip(e.clientX, e.clientY)
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    const wasDrag = drag.current?.moved ?? false
    drag.current = null
    if (pointers.current.size === 0) {
      const wasPinch = pinchedRef.current
      pinchedRef.current = false
      if (!wasDrag && !wasPinch) {
        const hit = hitTest(e.clientX, e.clientY)
        if (hit !== null) {
          const node = nodes[hit]!
          const isGhost = ghostIndices?.has(hit) ?? false
          if ((spotlight || openOnClick) && onOpen !== undefined && !isGhost) {
            // Spotlight/drill mode: a click ON a node opens its article directly. Isolating
            // the community is the AREA click (below), so an article is reachable at any
            // drill level without first bottoming out the cluster hierarchy.
            lastTapRef.current = null
            onOpen(node)
          } else {
            // Normal mode: single click selects (opens the panel), double click opens.
            const last = lastTapRef.current
            const now = performance.now()
            if (onOpen !== undefined && last !== null && last.path === node.path && now - last.time < DOUBLE_TAP_MS) {
              lastTapRef.current = null
              onOpen(node)
            } else {
              lastTapRef.current = { time: now, path: node.path }
              onSelect(node)
            }
          }
        } else {
          lastTapRef.current = null
          // No node under the pointer - inside a community's hull the spotlight click drills
          // into (isolates) that community; the hull is the clickable surface, not just its dots.
          const cid = spotlight && onClusterClick !== undefined ? hitCluster(e.clientX, e.clientY) : -1
          if (cid >= 0) onClusterClick!(cid)
          else onClear?.()
        }
      }
      // A pan/pinch moved the world under the cursor while hover updates were suppressed -
      // re-resolve now instead of leaving whatever was highlighted when the drag began.
      if (wasDrag || wasPinch) refreshHover()
    }
  }
  const onPointerCancel = (e: React.PointerEvent): void => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) pinchedRef.current = false
    drag.current = null
  }

  // Wheel zoom is a NATIVE non-passive listener: React's synthetic wheel event can't
  // preventDefault (browsers register it passive), so the page would scroll along with
  // every zoom. And because zooming moves the world under a stationary pointer, the hover
  // must be re-hit-tested - otherwise a node grazed on the way out stays "hovered" and its
  // neighborhood highlight keeps the rest of the graph dimmed.
  const onWheelRef = useRef<(e: WheelEvent) => void>(() => {})
  // The mechanic itself (2026-09-05, "anchor and leash", graphZoom.ts): the delta is
  // normalized and capped, zooming IN aims at the community within reach rather than at the
  // cursor, the result is leashed inside zoomAt, and the step is animated so the eye can
  // follow. Zooming OUT keeps the cursor as its anchor - it is heading home anyway.
  onWheelRef.current = (e: WheelEvent): void => {
    e.preventDefault()
    lastPointerRef.current = { x: e.clientX, y: e.clientY }
    const canvas = canvasRef.current
    if (!canvas) return
    const dy = normalizeWheel(e.deltaY, e.deltaMode, canvas.getBoundingClientRect().height)
    const factor = wheelFactor(dy)
    const base = zoomAnimRef.current?.k ?? transformRef.current.k
    const next = clampK(base * factor)
    const a = factor > 1 ? anchorFor(e.clientX, e.clientY) : { x: e.clientX, y: e.clientY }
    if (REDUCED_MOTION) {
      zoomAt(a.x, a.y, next)
      refreshHover()
      scheduleDraw()
      return
    }
    zoomAnimRef.current = { k: next, ax: a.x, ay: a.y }
    runAnim()
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (e: WheelEvent): void => onWheelRef.current(e)
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [])

  // View shortcuts: f = fit, +/− = zoom. Window-level because the canvas isn't focusable
  // (role="img"); the ref indirection keeps one stable listener (same pattern as the wheel).
  // Guarded against typing contexts and against firing while another tab is shown - tabs
  // stay MOUNTED but hidden (App.tsx), and a hidden element has no offsetParent.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  onKeyRef.current = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const el = e.target as HTMLElement
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable) return
    const canvas = canvasRef.current
    if (canvas === null || canvas.offsetParent === null) return
    if (e.key === 'f') {
      userMovedRef.current = false
      fitToView()
    } else if (e.key === '+' || e.key === '=') {
      zoomBy(1.4)
    } else if (e.key === '-') {
      zoomBy(1 / 1.4)
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => onKeyRef.current(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Pointer affordances under the spotlight (drill mode): a click in the hull AREA drills
  // into (isolates) the community - zoom-in cursor; a click ON a node opens its article -
  // pointer cursor. The two are mutually exclusive (hullHover is only set when no node is hit).
  const hoveredIsGhost = hover !== null && (ghostIndices?.has(hover) ?? false)
  const hoverAreaDrills = hover === null && hullHover !== null && onClusterClick !== undefined
  const hoverNodeOpens = hover !== null && (spotlight || openOnClick) && onOpen !== undefined && !hoveredIsGhost

  return (
    <div className="graph-canvas-wrap">
      {/* The canvas bar: Fit and the scope line on the left, the domain heading in the
          middle, fullscreen and the search on the right. The −/+ buttons are gone - the
          wheel and the +/- keys do the same job without spending bar width on it.
          It is the panel's HEADER ROW, not a floating box (2026-08-26): a second bordered
          box inset inside the first read as a box in a box, and the graph kept drawing
          underneath it, so whatever the layout put up there was hidden behind the bar. */}
      <div className="graph-controls scope-bar">
        <span className="bar-l">
          {/* The first slot has one width in every bar that copies this one (the
              Catalog's), so "Showing" starts at the same x on both screens.
              Off where the screen has a control panel of its own: the graph screen moved Fit
              into it on 2026-09-16, beside Reset, because the two are one pair of actions and
              a bar is for saying what is drawn. The shelf window has no panel and keeps it. */}
          {showFit && (
            <button
              className="btn ghost head-slot"
              onClick={() => {
                userMovedRef.current = false
                fitToView()
              }}
              title="Fit the view to the graph (f)"
            >
              Fit
            </button>
          )}
          {barLeft}
        </span>
        {barMid}
        <span className="bar-r">{barRight}</span>
      </div>
      {/* Everything positioned against the drawing - the overlays, the tooltip, and the
          canvas sizing itself (the canvas measures its PARENT) - hangs off this box, so
          the bar above is outside the graph's coordinate space rather than over it. */}
      <div className="graph-canvas-area">
        <canvas
          ref={canvasRef}
          className="graph-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => {
            // Off-canvas: no position to re-resolve against - later refreshes must clear, not stick.
            lastPointerRef.current = null
            if (hoverRef.current !== null) {
              setHover(null)
              scheduleDraw()
            }
            if (hullHoverRef.current !== null) {
              setHullHover(null)
              scheduleDraw()
            }
          }}
          role="img"
          aria-label={`Wikilink graph with ${nodes.length} pages`}
          style={{
            // zoom-in on the hull area (a click drills into the community); pointer on a node
            // (a click opens it, or selects it in normal mode); grab on empty canvas.
            cursor: hoverAreaDrills ? 'zoom-in' : hover !== null ? 'pointer' : drag.current ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
        />
        {overlay}
        {/* The overview (top-right, the corner the in-bar search freed): the whole graph with
            the picture as a frame, hidden while everything is on screen anyway. */}
        <canvas
          ref={miniRef}
          className="graph-minimap"
          width={MINI_W}
          height={MINI_H}
          role="img"
          aria-label="Overview of the whole graph - click to move the view there"
          onPointerDown={onMiniPointerDown}
          hidden
        />
        {/* The way back: exists only while no node is on screen, sits dead center where the
            eye already is, and says the one thing that helps. */}
        {offMap && (
          <button className="btn graph-offmap" onClick={goToNearest}>
            Go to nearest cluster
          </button>
        )}
        {layouting && <div className="graph-status">Laying out…</div>}
        {hover !== null && nodes[hover] && (
          <div className="graph-tooltip" ref={tooltipRef}>
            <strong>{nodes[hover]!.title}</strong>
            {ghostIndices?.has(hover) ? (
              <span>
                missing page · {nodes[hover]!.in} page{nodes[hover]!.in === 1 ? '' : 's'} link here
              </span>
            ) : (
              <>
                <span>
                  {nodes[hover]!.path}
                  {nodes[hover]!.domain ? ` · ${nodes[hover]!.domain}` : ''} · {nodes[hover]!.in} in /{' '}
                  {nodes[hover]!.out} out
                </span>
                {hoverNodeOpens ? (
                  <span className="tt-hint">click to open the page</span>
                ) : (
                  onOpen !== undefined && <span className="tt-hint">double-click to open the page</span>
                )}
              </>
            )}
          </div>
        )}
        {/* Hull hover (inside a community's tinted area, between nodes): name the community
            the click would isolate - same pointer-following tooltip, node variant wins. */}
        {hover === null && hullHover !== null && (
          <div className="graph-tooltip" ref={tooltipRef}>
            <strong>{clusterLabels?.get(hullHover) ?? 'community'}</strong>
            <span>
              {clusterSets?.get(hullHover)?.size ?? 0} pages
              {onClusterClick !== undefined ? ' · click to isolate' : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

type Pt = [number, number]

/** Read once: the zoom and the way-back pan skip their animation frames under reduced motion. */
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The overview's CSS size; the element's box in styles.css must agree. */
const MINI_W = 150
const MINI_H = 96
const MINI_INSET = 6

/** World → overview pixels: the padded graph box fitted into the overview, centered. */
function miniProjection(bounds: { x0: number; y0: number; x1: number; y1: number }): { s: number; ox: number; oy: number } {
  const bw = bounds.x1 - bounds.x0 + 2 * LEASH_PAD_WORLD
  const bh = bounds.y1 - bounds.y0 + 2 * LEASH_PAD_WORLD
  const s = Math.min((MINI_W - 2 * MINI_INSET) / Math.max(1, bw), (MINI_H - 2 * MINI_INSET) / Math.max(1, bh))
  return { s, ox: MINI_W / 2 - ((bounds.x0 + bounds.x1) / 2) * s, oy: MINI_H / 2 - ((bounds.y0 + bounds.y1) / 2) * s }
}

/**
 * The overview: every placed node as a dot in one quiet ink (the overview is about shape,
 * not lens), the picture's frame in the accent. Hidden whenever the whole graph is already
 * on screen - then there is nothing it could add.
 */
function drawMinimap(
  mini: HTMLCanvasElement,
  t: { x: number; y: number; k: number },
  vp: Viewport,
  pos: Float32Array,
  dpr: number,
  painted: (i: number) => boolean = () => true,
): void {
  const bounds = worldBounds(pos)
  const hide = fullyInView(t, vp, bounds)
  if (mini.hidden !== hide) mini.hidden = hide
  if (hide || bounds === null) return
  const pw = Math.round(MINI_W * dpr)
  if (mini.width !== pw) {
    mini.width = pw
    mini.height = Math.round(MINI_H * dpr)
  }
  const ctx = mini.getContext('2d')
  if (!ctx) return
  const styles = getComputedStyle(mini)
  const ink = styles.getPropertyValue('--text-faint').trim() || '#888'
  const accent = styles.getPropertyValue('--accent').trim() || '#5b8def'
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, MINI_W, MINI_H)
  const m = miniProjection(bounds)
  ctx.fillStyle = ink
  ctx.globalAlpha = 0.7
  for (let i = 0; i + 1 < pos.length; i += 2) {
    const x = pos[i]!
    if (Number.isNaN(x)) continue
    if (!painted(i / 2)) continue
    ctx.fillRect(m.ox + x * m.s - 0.6, m.oy + pos[i + 1]! * m.s - 0.6, 1.2, 1.2)
  }
  ctx.globalAlpha = 1
  const a = worldOf(t, vp, 0, 0)
  const b = worldOf(t, vp, vp.w, vp.h)
  const vx = m.ox + a.x * m.s
  const vy = m.oy + a.y * m.s
  const vw = Math.max(2, (b.x - a.x) * m.s)
  const vh = Math.max(2, (b.y - a.y) * m.s)
  ctx.fillStyle = accent
  ctx.globalAlpha = 0.14
  ctx.fillRect(vx, vy, vw, vh)
  ctx.globalAlpha = 1
  ctx.strokeStyle = accent
  ctx.lineWidth = 1
  ctx.strokeRect(Math.round(vx) + 0.5, Math.round(vy) + 0.5, Math.round(vw), Math.round(vh))
}

/** Andrew's monotone-chain convex hull. Returns the hull points counter-clockwise. */
function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** A member sitting farther than this multiple of the cluster's MEDIAN member distance is a
 *  spatial outlier - the force layout dragged it toward its cross-cluster links, not its
 *  community. Excluding it from the hull stops the tinted blob reaching as a tongue into empty
 *  space where no cluster node sits (a cross-domain entity is the usual culprit). */
const HULL_OUTLIER_FACTOR = 2.5

/**
 * Hull padding and region-label metrics, all in WORLD units and deliberately independent of
 * the zoom factor: the label anchors have to be the same wherever the camera is, or the same
 * cluster gets a differently-placed label at every scale. Only the GLYPHS are drawn at a
 * constant screen size (font / k at paint time).
 */
const HULL_PAD = 26
/**
 * Region labels are sized in WORLD units, as a fraction of the graph's own extent - like the
 * region names on a map, which belong to the territory rather than to the viewport. That is
 * what lets the placement be computed once and stay put at every zoom: geometry and glyphs
 * finally speak the same unit, so a label can never outgrow the box that was reserved for it.
 * Scaling with the extent (instead of a fixed number) keeps them readable at the fit zoom
 * whatever size the vault has grown to.
 */
const LABEL_H_OF_SPAN = 0.011
const LABEL_H_MIN = 12
const LABEL_H_MAX = 60
/** Cap on the ON-SCREEN size when zoomed in. Clamping DOWN only ever shrinks the drawn text
 *  inside its reserved box, so it cannot reintroduce overlap. */
const LABEL_MAX_SCREEN_PX = 20
/**
 * Floor on the on-screen size when zoomed OUT. Unlike the cap this makes the drawn text
 * bigger than the box reserved for it, so it is paired with a draw-time declutter: a label
 * whose enlarged box would cover one already drawn is HIDDEN, never moved. Positions stay
 * fixed at every zoom; only how many labels are shown changes, the way a map drops minor
 * place names as you zoom out.
 */
const LABEL_MIN_SCREEN_PX = 10

/**
 * The subset of member points the tinted hull should enclose: the cluster BODY, with spatial
 * outliers trimmed. Distances are measured from the component-wise MEDIAN point (robust - one
 * flung-out member doesn't drag the center toward itself the way a mean would), and a member
 * past HULL_OUTLIER_FACTOR × the median distance is dropped. Only clusters with enough members
 * to still leave a body are trimmed (< 5 keeps all - too few to tell a body from a corner);
 * never trims below 3, the minimum for an area. The node itself still draws; it just isn't
 * wrapped by the hull.
 */
export function hullBody(points: Pt[]): Pt[] {
  if (points.length < 5) return points
  const xs = points.map((p) => p[0]).sort((a, b) => a - b)
  const ys = points.map((p) => p[1]).sort((a, b) => a - b)
  const mid = points.length >> 1
  const mx = xs[mid]!
  const my = ys[mid]!
  const dists = points.map(([x, y]) => Math.hypot(x - mx, y - my))
  const medDist = [...dists].sort((a, b) => a - b)[mid]!
  if (medDist <= 1e-6) return points
  const threshold = medDist * HULL_OUTLIER_FACTOR
  const body = points.filter((_, i) => dists[i]! <= threshold)
  return body.length >= 3 ? body : points
}

/** Pushes each hull point outward from the centroid by `pad` world units - breathing room. */
function expandHull(hull: Pt[], cx: number, cy: number, pad: number): Pt[] {
  return hull.map(([x, y]) => {
    const dx = x - cx
    const dy = y - cy
    const d = Math.hypot(dx, dy) || 1
    return [x + (dx / d) * pad, y + (dy / d) * pad] as Pt
  })
}

/** Axis-aligned label/hull box: [minX, minY, maxX, maxY]. */
type Box = [number, number, number, number]

/** Bounds [minX, minY, maxX, maxY] of a polygon. */
function polygonBounds(poly: Pt[]): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of poly) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}

const boxesOverlap = (a: Box, b: Box): boolean =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

/** Ray-casting point-in-polygon test (polygon is a closed vertex ring). */
export function pointInPolygon(x: number, y: number, poly: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]![0]
    const yi = poly[i]![1]
    const xj = poly[j]![0]
    const yj = poly[j]![1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * True if a label box overlaps the (convex) hull polygon. Cheap and adequate for small labels
 * against much larger hulls: a box corner inside the hull, or a hull vertex inside the box,
 * catches every case where a label sitting outside its OWN region would intrude on another.
 */
export function boxIntersectsPolygon(box: Box, poly: Pt[]): boolean {
  const corners: Pt[] = [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]],
  ]
  for (const [x, y] of corners) if (pointInPolygon(x, y, poly)) return true
  for (const [x, y] of poly) if (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) return true
  return false
}

/** Average of a polygon's vertices - inside any convex polygon, so a ray from it exits once. */
function vertexCentroid(poly: Pt[]): Pt {
  let sx = 0
  let sy = 0
  for (const [x, y] of poly) {
    sx += x
    sy += y
  }
  return [sx / poly.length, sy / poly.length]
}

/**
 * Distance from an interior point to the polygon boundary along unit direction (ux, uy).
 * A ray from inside a convex polygon crosses the boundary exactly once; this returns that
 * crossing distance, so a label can be anchored to the actual hull EDGE in each direction
 * instead of to the bounding box (which for a round or diagonal hull sits well outside it).
 * Falls back to the bounding half-extent along the direction if no crossing is found.
 */
function rayPolygonExit(cx: number, cy: number, ux: number, uy: number, poly: Pt[]): number {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[j]!
    const [x2, y2] = poly[i]!
    const ex = x2 - x1
    const ey = y2 - y1
    const denom = ux * ey - uy * ex
    if (Math.abs(denom) < 1e-9) continue // ray parallel to this edge
    // Solve center + t*dir = edge_start + s*edge, for t (ray) and s (edge param in [0,1]).
    const dx = x1 - cx
    const dy = y1 - cy
    const t = (dx * ey - dy * ex) / denom
    const s = (dx * uy - dy * ux) / denom
    if (t > 1e-6 && s >= -1e-9 && s <= 1 + 1e-9 && t < best) best = t
  }
  if (best !== Infinity) return best
  const [minX, minY, maxX, maxY] = polygonBounds(poly)
  return Math.abs(ux) * ((maxX - minX) / 2) + Math.abs(uy) * ((maxY - minY) / 2)
}

/** A cluster label to place: its hull is `hulls.get(key)`; wider clusters place first. */
export interface RegionLabelInput {
  readonly key: number
  /** Rendered label width in world units. */
  readonly width: number
  /** Larger clusters place first (more important, and likelier to find room). */
  readonly weight: number
}

export interface PlacedRegionLabel {
  readonly key: number
  /** fillText anchor, for textAlign 'center' + textBaseline 'top'. */
  readonly x: number
  readonly y: number
  readonly box: Box
  /** The spot overlaps a tint (its own or a neighbour's) - the least-bad option here. */
  readonly fallback: boolean
}


/** Angular resolution of the escape search. 16 directions ≈ every 22.5°, up first. */
const LABEL_ANGLES = 16
/** Radial tiers between "hugging the hull" and the travel cap. */
const LABEL_TIERS = 6
/**
 * How far a label may stray beyond its own hull, as a fraction of that hull's radius. The
 * search used to walk out in tiers of (span of ALL hulls)/40 with no cap at all, so a label
 * that found no free spot nearby drifted across the whole graph and read as belonging to
 * whatever cluster it landed near. A label that cannot be placed cleanly is far less
 * confusing when it stays put and slightly overlaps than when it emigrates.
 */
const LABEL_MAX_TRAVEL = 0.55

/** Penalty weights: what we would rather sacrifice when nothing is perfectly free. */
const PENALTY_FOREIGN_HULL = 3
const PENALTY_OWN_HULL = 2
/** Per unit of distance beyond the hull edge, relative to the hull radius - keeps labels near. */
const PENALTY_DISTANCE = 4

/**
 * Places region (cluster) labels next to their hulls, legibly and - above all - close enough
 * that the association stays obvious.
 *
 * Deterministic, largest cluster first (weight desc, then key). For each label the search
 * walks a bounded ring around its OWN hull (`LABEL_MAX_TRAVEL` × hull radius, so the span
 * scales with the cluster rather than with the viewport) and scores every candidate:
 *
 *  - overlapping an already-placed LABEL is disqualifying, never merely expensive: two
 *    labels on top of each other are unreadable, and no amount of proximity buys that back.
 *    A label with no such candidate is DROPPED (weight order means the biggest clusters keep
 *    theirs), which is also what declutters the zoomed-out view.
 *  - overlapping a foreign hull, or its own, is a penalty, not a veto. This is the trade the
 *    old all-or-nothing test got wrong: it would rather fling a label 700 units away than let
 *    it touch a tint.
 *  - distance from the hull edge is itself a penalty, so the winner is the closest good spot.
 *
 * Zoom independence is a property of the CALLER: pass `labelH`, `margin` and the label widths
 * in world units that do not change with the zoom factor, or the same cluster will be labelled
 * differently at every scale (measured before this change: the median label sat 411 world
 * units from its centroid at k=0.35 but 108 at k=4).
 *
 * Pure geometry: widths are measured by the caller and passed in.
 */
export function placeRegionLabels(
  labels: readonly RegionLabelInput[],
  hulls: ReadonlyMap<number, Pt[]>,
  labelH: number,
  margin: number,
): PlacedRegionLabel[] {
  const order = [...labels].sort((a, b) => b.weight - a.weight || a.key - b.key)
  const placedBoxes: Box[] = []
  const out: PlacedRegionLabel[] = []

  for (const label of order) {
    const own = hulls.get(label.key)
    if (own === undefined || own.length < 3) continue
    const [cx, cy] = vertexCentroid(own)
    // The hull's own size sets the search span - not the bounds of every hull together,
    // which made the step size depend on how far apart unrelated clusters happened to sit.
    let radius = 0
    for (const [px, py] of own) radius = Math.max(radius, Math.hypot(px - cx, py - cy))
    const travel = Math.max(radius * LABEL_MAX_TRAVEL, labelH * 2)
    const halfW = label.width / 2

    let best: { x: number; y: number; box: Box; penalty: number } | null = null
    for (let tier = 0; tier <= LABEL_TIERS; tier++) {
      const out_ = (tier / LABEL_TIERS) * travel
      for (let a = 0; a < LABEL_ANGLES; a++) {
        // Start at "up" and alternate outward, so ties resolve toward the top of the hull.
        const step = Math.ceil(a / 2) * (a % 2 === 1 ? 1 : -1)
        const angle = -Math.PI / 2 + (step * 2 * Math.PI) / LABEL_ANGLES
        const ux = Math.cos(angle)
        const uy = Math.sin(angle)
        const edge = rayPolygonExit(cx, cy, ux, uy, own)
        const dist = edge + margin + Math.abs(ux) * halfW + Math.abs(uy) * (labelH / 2) + out_
        const centerX = cx + ux * dist
        const top = cy + uy * dist - labelH / 2
        const box: Box = [centerX - halfW, top, centerX + halfW, top + labelH]

        // Hard constraint: never sit on another label.
        if (placedBoxes.some((p) => boxesOverlap(box, p))) continue

        let penalty = (out_ / Math.max(radius, 1)) * PENALTY_DISTANCE
        for (const [cid, poly] of hulls) {
          if (!boxIntersectsPolygon(box, poly)) continue
          penalty += cid === label.key ? PENALTY_OWN_HULL : PENALTY_FOREIGN_HULL
        }
        if (best === null || penalty < best.penalty - 1e-9) {
          best = { x: centerX, y: top, box, penalty }
          if (penalty === 0) break // nothing can beat a clean spot at this distance
        }
      }
      if (best !== null && best.penalty === 0) break
    }

    // Every candidate collided with an already-placed label: drop this one rather than
    // stack two unreadable labels. Weight order keeps the labels that matter most.
    if (best === null) continue
    out.push({ key: label.key, x: best.x, y: best.y, box: best.box, fallback: best.penalty > 0 })
    placedBoxes.push(best.box)
  }
  return out
}

/** Traces a closed, rounded blob through the points using midpoint quadratic curves. */
function traceSmooth(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  if (pts.length < 3) return
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const prev = pts[pts.length - 1]!
  const start = mid(prev, pts[0]!)
  ctx.moveTo(start[0], start[1])
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i]!
    const next = pts[(i + 1) % pts.length]!
    const m = mid(cur, next)
    ctx.quadraticCurveTo(cur[0], cur[1], m[0], m[1])
  }
  ctx.closePath()
}

/** Coalesces draw requests into one per animation frame. */
function useRafDraw(draw: () => void): () => void {
  const pending = useRef(false)
  const drawRef = useRef(draw)
  drawRef.current = draw
  return useCallback((): void => {
    if (pending.current) return
    pending.current = true
    requestAnimationFrame(() => {
      pending.current = false
      drawRef.current()
    })
  }, [])
}
