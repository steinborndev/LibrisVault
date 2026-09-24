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
  fitTransform,
  type FitItem,
  type Viewport,
} from '../lib/graphZoom.ts'
import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react'
import type { GraphNode } from '../api/types.ts'
import { domainGroups, reseedPlan } from '../lib/graphForces.ts'
import {
  HULL_PAD,
  SPOT_IDLE,
  buildSpotGeoms,
  placeSpotLabel,
  pointInPolygon,
  resolveAreaCid,
  spotAlpha,
  spotBusy,
  tickSpot,
  wantSpot,
  type SpotGeom,
  type SpotState,
} from '../lib/spotlightHover.ts'
import { measureSpotLabel, paintRegionLabel, paintSpotLabel, regionFont } from '../lib/spotLabel.ts'
import { placeAround, spreadPoints, wrapTitle, type Box as LBox } from '../lib/landmarkLayout.ts'
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

/**
 * The closest a FIT will frame (2026-09-24). A drilled-in community of a dozen pages fits at
 * the zoom ceiling, where a node is a 50px disc and a hull's padding 200px of screen; a fit is
 * for seeing a group, and three times is plenty for that. The wheel still reaches ZOOM_MAX.
 */
const FIT_ZOOM_MAX = 3

/** Screen height of the spotlight hull's label box; the glyphs are 82 % of it (about 13px). */
const SPOT_LABEL_PX = 16

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
   * A node the fit puts in the MIDDLE of the picture rather than wherever the framed set's box
   * happens to put it. The span is then measured from it in every direction, so the set still
   * fits whole - at a wider zoom than a plain box fit, which is what centring costs.
   */
  fitCenter?: number | null
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
  /** Draw only these nodes, on the layout of all of them (the Areas stepper's one community). */
  onlyNodes?: ReadonlySet<number> | null
  /**
   * A click in an AREA (Areas on, Spotlight off): the community whose tint was clicked, among
   * `areaIds`. The Areas stepper shows it alone. With Spotlight on the area click isolates
   * instead (`onClusterClick`), as it always did.
   */
  onAreaClick?: ((cid: number) => void) | undefined
  areaIds?: ReadonlySet<number>
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
  /** Place in the reading order (1-based) per landmark index - the number the list shows. */
  rank?: ReadonlyMap<number, number>
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
export function clusterHue(id: number): number {
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
/**
 * The pages the landmark mode names in full (wrapped titles, placed around the dot): the
 * landmarks in the overview, the expanded landmark and its whole neighbourhood in a bloom.
 */
function namedInFull(mask: LandmarkMask, i: number): boolean {
  return mask.bloomAnchor === null ? mask.landmarks.has(i) : i === mask.bloomAnchor || mask.bloom.has(i)
}

function painted(mask: LandmarkMask | null, i: number, only: ReadonlySet<number> | null = null): boolean {
  // The Areas stepper (2026-09-24) shows one community at a time on the same layout: the
  // rest of the graph is not drawn, not hit and not framed, exactly like the landmark mask.
  if (only !== null && !only.has(i)) return false
  if (mask === null) return true
  if (mask.bloomAnchor !== null) return i === mask.bloomAnchor || mask.bloom.has(i)
  return mask.landmarks.has(i) || mask.connectors.has(i)
}

/**
 * The Library's rim, as the room draws it: `#fff4e2` at 1.6 wide, along the edge of whatever is
 * being pointed at (`bc-rim` in RoomSvg). The graph borrows both, so one gesture looks the same
 * in both places.
 */
const RIM_LIGHT = '#fff4e2'
const RIM_WIDTH = 1.6
/** How far outside the node's own edge the rim sits, in screen pixels. */
const RIM_OUT = 3

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
/**
 * The domain each path had in the last layout, shared like the positions: what `reseedPlan`
 * compares against to tell a domain change (a split, a re-file) from a filter toggle.
 */
const domainByPathRef = { current: new Map<string, string | null>() }

export function GraphCanvas({ nodes, edges, focusIndex, selectedIndex = null, ghostIndices, matches, lens = 'type', clusters = null, clusterLabels, clusterDomains, showHulls = false, network = false, spotlight = false, showLabels = true, openOnClick = false, fitOnMount = false, fitKey, showFit = true, fitSubset = null, fitCenter = null, view, barLeft, barMid, barRight, onSelect, onClusterClick, onOpen, onClear, overlay, landmarkMask = null, onlyNodes = null, onAreaClick, areaIds }: GraphCanvasProps): React.ReactElement {
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
  const [hover, setHoverState] = useState<number | null>(null)
  const hoverRef = useRef<number | null>(null)
  /*
   * The ref is written HERE, not from the render: the draw that follows a hover change runs
   * on the next animation frame, which can come before React has rendered the new state - and
   * a draw reading a ref set at render time then paints the PREVIOUS hover's labels. That was
   * half of a label flicker (2026-09-24): the same pointer position drew different titles.
   */
  const setHover = useCallback((next: number | null): void => {
    hoverRef.current = next
    setHoverState(next)
  }, [])
  // Hovered community HULL (spotlight only): the pointer is inside a cluster's tinted area
  // without touching a node. Keeps the community highlight from flickering off between
  // member nodes and makes the whole hull one clickable isolate-surface. Only ever holds an
  // ISOLATABLE cid (the hit-test applies the proper-subset guard before setting it).
  const [hullHover, setHullHover] = useState<number | null>(null)
  const hullHoverRef = useRef<number | null>(null)
  hullHoverRef.current = hullHover
  /**
   * The SHOWN spotlight community, separate from what the pointer resolved: it appears after a
   * short delay on an area hover, lingers briefly when the pointer leaves, and fades both ways
   * (lib/spotlightHover.ts). What the pointer resolved changes on every pixel; what is shown
   * changes only when the pointer means it.
   */
  const spotRef = useRef<SpotState>(SPOT_IDLE)
  const spotTimerRef = useRef<number | null>(null)
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
  /** The community ids a fit must leave room for (a hull may be drawn around them), or null. */
  const hullFitRef = useRef<ArrayLike<number> | null>(null)
  hullFitRef.current = clusters !== null && (spotlight || showHulls) ? clusters : null
  /*
   * The mask, in a ref as well as in the props. `radius` reads it from here so its identity
   * stays keyed on the node list alone: it is a dependency of `fitToView`, which is a
   * dependency of the worker session, and a mask toggle that tore the worker down and built it
   * again would be a strange way to spend a redraw. The draw pass reads the prop directly.
   */
  const maskRef = useRef(landmarkMask)
  maskRef.current = landmarkMask
  const onlyRef = useRef(onlyNodes)
  onlyRef.current = onlyNodes
  /**
   * Display-only positions for the landmarks overview (2026-09-24): the layout's own
   * positions with the painted dots moved apart. Everything that DRAWS, hits, frames or leashes
   * reads `displayRef.current ?? positionsRef.current`; the layout, its worker and the positions memory keep the real ones.
   */
  const displayRef = useRef<Float32Array | null>(null)
  /** What the next fit frames; a ref, so `fitToView` keeps its identity across a change of it. */
  const fitSubsetRef = useRef(fitSubset)
  fitSubsetRef.current = fitSubset
  const fitCenterRef = useRef(fitCenter)
  fitCenterRef.current = fitCenter
  /** Whether titles are drawn at all; a fit makes room for them only then. */
  const showLabelsRef = useRef(showLabels)
  showLabelsRef.current = showLabels
  /** Whether the mask puts ink on this node. Everything is painted while the mode is off. */
  const isPainted = useCallback((i: number): boolean => painted(maskRef.current, i, onlyRef.current), [])

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
    const paints = (i: number): boolean => painted(landmarkMask, i, onlyNodes)
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
  }, [nodes, edges, landmarkMask, onlyNodes])

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
    const pos = (displayRef.current ?? positionsRef.current)
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
    const paints = (i: number): boolean => painted(mask, i, onlyNodes)
    // The landmark mode's own label pass, in the overview and in an open neighbourhood alike.
    const landmarkOverview = mask !== null

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
    // The community on show comes from the spot state, not from the raw hover: it was
    // resolved from a member node or from the area (the same geometry drawn below), and it
    // carries a fade. Only an isolatable community ever gets into it (see `wantCid`).
    const nowSpot = performance.now()
    const spot = spotRef.current
    const spotA = hoverSpotlightRef.current && clusters !== null ? spotAlpha(spot, nowSpot) : 0
    const spotCid = spotA > 0 ? spot.cid : -1
    if (spotBusy(spot, nowSpot)) scheduleDrawRef.current?.()
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
    // A community on show dims by its fade: at alpha 0 nothing is dimmed, at 1 fully.
    const transientSpot = spotHover !== null || spotCid >= 0
    const fadeA = spotCid >= 0 ? spotA : 1
    const dimBy = (full: number, lit: number): number => lit + (full - lit) * fadeA
    const dimNode = dimBy(transientSpot ? 0.18 : 0.45, 1)
    const dimEdge = transientSpot ? 0.08 : 0.18
    const dimLabel = dimBy(transientSpot ? 0.15 : 0.4, 0.95)

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
    let spotLabel: { text: string; box: Box; hue: number; alpha: number } | null = null
    const areaLabels: Array<{ text: string; cx: number; top: number; world: number; hue: number }> = []
    // With hulls off, the spotlight still traces the HOVERED community's hull (and its label,
    // via the shared `members` map below) - the preview of what a click would isolate.
    if (clusters !== null && (showHulls || spotCid >= 0)) {
      // The one geometry (lib/spotlightHover.ts): the pointer, the cursor and the click test
      // the smoothed outline of exactly these padded hulls.
      const geoms = buildSpotGeoms(clusters, pos, nodes.length, paints, showHulls ? null : spotCid)
      const members = new Map<number, Pt[]>()
      ctx.lineWidth = 1.4 / t.k
      const paddedHulls = new Map<number, Pt[]>()
      for (const g of geoms) {
        members.set(g.id, g.members as Pt[])
        if (g.parts.length === 0) continue // fewer than 3 members make no area worth tinting
        // Labels are placed against the DRAWN outline of the largest part (the smoothed curve,
        // not the padded polygon it rounds off), where most of the community stands.
        paddedHulls.set(g.id, g.hull as Pt[])
        // The hull on show fades with the spotlight; hulls drawn for the overlay stay put.
        const a = g.id === spotCid && !showHulls ? spotA : 1
        // Tint by the cluster's dominant domain so the color means something; fall back to a
        // per-id hue only for a community with no domain at all.
        const dom = clusterDomains?.get(g.id)
        const hue = dom !== undefined ? domainHue(dom) : clusterHue(g.id)
        ctx.fillStyle = `hsl(${hue} 60% 55% / ${0.09 * a})`
        ctx.strokeStyle = `hsl(${hue} 60% 60% / ${0.4 * a})`
        // One area, drawn as the islands the layout keeps it in: every member inside a part.
        for (const part of g.parts) {
          ctx.beginPath()
          traceSmooth(ctx, part.padded)
          ctx.fill()
          ctx.stroke()
        }
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
      // The spotlight's own hull (Areas off) is transient - it comes and goes with the
      // pointer, so the reason for world-sized labels (a label that stays put at every zoom)
      // does not apply to it. It gets a fixed SCREEN size instead: in a drilled-in group the
      // world size bottomed out at LABEL_H_MIN, a 36px box at 3x, set that far above the hull.
      const labelH = showHulls ? Math.min(LABEL_H_MAX, Math.max(LABEL_H_MIN, span * LABEL_H_OF_SPAN)) : SPOT_LABEL_PX / t.k
      const fontWorld = labelH * 0.82
      ctx.font = regionFont(fontWorld)
      const labelInputs: RegionLabelInput[] = []
      // `?labels=off`: an empty input list keeps the whole region-label pass inert. The
      // spotlight's own label has a placement of its own (below), so it stays out of this one,
      // and so does a single area on show: the scope line over the drawing already names it.
      if (showLabels && showHulls && onlyNodes === null) {
        for (const [cid, pts] of members) {
          const label = clusterLabels?.get(cid)
          if (label === undefined || !paddedHulls.has(cid)) continue
          labelInputs.push({ key: cid, width: ctx.measureText(label).width, weight: pts.length })
        }
      }
      // Captions keep off the dots as well as off the tints and each other (2026-09-24).
      let nodesUnder: ((box: Box) => number) | null = null
      if (labelInputs.length > 0) {
        const discs: Array<{ x: number; y: number; r: number }> = []
        for (let i = 0; i < nodes.length; i++) {
          if (!paints(i)) continue
          const x = pos[i * 2]!
          const y = pos[i * 2 + 1]!
          if (Number.isNaN(x) || !visible(x, y)) continue
          discs.push({ x, y, r: radius(i) })
        }
        nodesUnder = discCounter(discs, 40)
      }
      const placedLabels = placeRegionLabels(
        labelInputs,
        paddedHulls,
        labelH,
        labelH * 0.45,
        [minX + margin, minY + margin, maxX - margin, maxY - margin],
        nodesUnder,
      )
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
        // Painted after the nodes (below), so no dot sits on a caption.
        areaLabels.push({ text: clusterLabels!.get(p.key)!, cx: bcx, top: bcy - hh, world: Math.min(drawnWorld, LABEL_MAX_SCREEN_PX / t.k), hue })
        regionLabelBoxes.push(drawnBox)
      }
      // The spotlight's label (lib/spotLabel.ts): measured in SCREEN pixels, placed clear of the
      // outline AND of the member nodes, reserved here so page titles keep off it, and
      // painted last - above the nodes - so nothing is ever drawn over it.
      const spotText = !showHulls && spotCid >= 0 && showLabels ? clusterLabels?.get(spotCid) : undefined
      const spotHull = spotText !== undefined ? paddedHulls.get(spotCid) : undefined
      if (spotText !== undefined && spotHull !== undefined) {
        const size = measureSpotLabel(ctx, spotText)
        const discs: Array<{ x: number; y: number; r: number }> = []
        for (let i = 0; i < nodes.length; i++) {
          if (clusters[i] !== spotCid || !paints(i)) continue
          const x = pos[i * 2]!
          if (Number.isNaN(x)) continue
          discs.push({ x, y: pos[i * 2 + 1]!, r: radius(i) })
        }
        const box = placeSpotLabel(spotHull, discs, size.w / t.k, size.h / t.k, 8 / t.k, [
          minX + margin,
          minY + margin,
          maxX - margin,
          maxY - margin,
        ])
        if (box !== null) {
          const dom = clusterDomains?.get(spotCid)
          spotLabel = { text: spotText, box, hue: dom !== undefined ? domainHue(dom) : clusterHue(spotCid), alpha: spotA }
          regionLabelBoxes.push(box)
        }
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
      const base = isBridge ? 0.85 : netOn ? 0.5 : toGhost ? 0.45 : 0.35
      if (highlight !== null) alpha = lit ? base + (0.9 - base) * fadeA : base + (dimEdge - base) * fadeA
      else alpha = base

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
      /*
       * The selected node, inside the mode, wears the LIBRARY'S RIM (2026-09-22, user decision):
       * the same warm light and the same 1.6px edge the room puts along the thing being pointed
       * at. An accent ring was the obvious choice and the wrong one - blue on a blue-black
       * canvas is one more circle among forty of the same colour, which is what it looked like.
       *
       * A darker halo goes under it, one stroke wider. On this canvas the background can be
       * near-white, where a warm white edge would vanish; the halo is what the label pass
       * already does for text, for the same reason.
       */
      if (mask !== null && i === selectedIndex) {
        ctx.globalAlpha = nodeRev
        ctx.strokeStyle = mixColor(cssVar('--bg', '#0d1117'), cssVar('--text', '#fff'), darkSurface ? 0.1 : 0.55)
        ctx.lineWidth = 3.4 / t.k
        ctx.beginPath()
        ctx.arc(x, y, r + RIM_OUT / t.k, 0, Math.PI * 2)
        ctx.stroke()
        ctx.strokeStyle = RIM_LIGHT
        ctx.lineWidth = RIM_WIDTH / t.k
        ctx.beginPath()
        ctx.arc(x, y, r + RIM_OUT / t.k, 0, Math.PI * 2)
        ctx.stroke()
      } else if (i === focusIndex || i === selectedIndex || matches.has(i)) {
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
        // The overview's landmarks get their own pass below: every one named, wrapped, placed
        // around its dot (2026-09-24).
        if (landmarkOverview && namedInFull(mask, i)) continue
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
    /*
     * The RESTING labels are placed without the interactive ones (2026-09-24). They used to
     * share one greedy pass with the hovered title at its head, so every hover re-dealt the
     * whole collision cascade: a borderline title far from the pointer appeared or vanished
     * with each node the pointer crossed, measured on one hub title as shown for 107 of 126
     * hover targets and hidden at rest. Now the resting set is the same whatever is hovered,
     * and the interactive titles are laid on top, hiding only the resting titles they cover.
     */
    const prio = (i: number): number =>
      highlight !== null && highlight.has(i) ? 3
      : ghostIndices !== undefined && ghostIndices.has(i) ? 2
      : labelReps.has(i) ? 1
      : 0
    const resting = candidates.filter((i) => !interactive(i))
    const onTop = candidates.filter(interactive)
    resting.sort((a, b) => {
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
    type Label = { i: number; text: string; x: number; y: number; box: [number, number, number, number]; ghost: boolean }
    const layOut = (i: number, full: boolean): Label => {
      const n = nodes[i]!
      const ghost = ghostIndices !== undefined && ghostIndices.has(i)
      // Long titles are the main space hogs - truncate unless the node is the one the
      // user is interacting with (the tooltip carries the full title regardless).
      const text = !full && n.title.length > 30 ? `${n.title.slice(0, 28)}…` : n.title
      ctx.font = `${ghost ? 'italic ' : ''}${11 / t.k}px system-ui, sans-serif`
      const w = ctx.measureText(text).width
      const x = pos[i * 2]!
      const y = pos[i * 2 + 1]! + radius(i) + 3 / t.k
      return { i, text, x, y, box: [x - w / 2 - padX, y, x + w / 2 + padX, y + labelH], ghost }
    }
    const overlaps = (a: Label['box'], b: Label['box']): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
    const restingLabels: Label[] = []
    let examined = 0
    // Labels are last in. The collision solver has nothing stable to place against while
    // nodes are still arriving, and forty titles appearing mid-reveal is its own flicker.
    if (labelIn > 0.004) {
      for (const i of resting) {
        if (restingLabels.length >= MAX_LABELS || examined >= MAX_EXAMINED) break
        examined++
        const l = layOut(i, false)
        if (placed.some((p) => overlaps(l.box, p))) continue
        placed.push(l.box)
        restingLabels.push(l)
      }
    }
    // Interactive labels skip the cull - "what am I pointing at" must always answer - and
    // hide only the resting titles they sit on.
    const topLabels = labelIn > 0.004 ? onTop.map((i) => layOut(i, true)) : []
    const shown = [...restingLabels.filter((l) => !topLabels.some((tl) => overlaps(l.box, tl.box))), ...topLabels]
    for (const l of shown) {
      ctx.font = `${l.ghost ? 'italic ' : ''}${11 / t.k}px system-ui, sans-serif`
      ctx.globalAlpha = (highlight !== null && !highlight.has(l.i) ? dimLabel : 0.95) * labelIn
      // A halo in the background color keeps text legible across edges and foreign nodes.
      ctx.lineWidth = 3 / t.k
      ctx.strokeStyle = halo
      ctx.strokeText(l.text, l.x, l.y)
      ctx.fillStyle = l.ghost ? cssVar('--text-faint', '#6b7791') : textColor
      ctx.fillText(l.text, l.x, l.y)
    }
    if (landmarkOverview && showLabels && labelIn > 0.004) {
      // Every landmark named, in reading order: the whole title in up to four lines, placed at
      // the first free spot around its dot (the resting labels and the other dots are what it
      // keeps off), and its place in the list inside the dot.
      const lineH = 13 / t.k
      const discs: Array<{ x: number; y: number; r: number }> = []
      for (let i = 0; i < nodes.length; i++) {
        if (!paints(i)) continue
        const x = pos[i * 2]!
        if (Number.isNaN(x)) continue
        discs.push({ x, y: pos[i * 2 + 1]!, r: radius(i) })
      }
      ctx.font = `${11 / t.k}px system-ui, sans-serif`
      // The overview in reading order; a neighbourhood with its landmark first, then as it is
      // listed (the list's own order is the domain rank, which is also node order here).
      const order =
        mask.bloomAnchor === null
          ? [...mask.landmarks].sort((a, b) => (mask.rank?.get(a) ?? 1e9) - (mask.rank?.get(b) ?? 1e9))
          : [mask.bloomAnchor, ...mask.bloom]
      const lmLabels: Array<{ i: number; lines: string[]; box: LBox }> = []
      for (const i of order) {
        const x = pos[i * 2]!
        if (Number.isNaN(x) || !paints(i)) continue
        const y = pos[i * 2 + 1]!
        const lines = wrapTitle(nodes[i]!.title, 160 / t.k, 4, (str) => ctx.measureText(str).width)
        const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 2 * padX
        // Under its own dot first, always: the spread is laid out to leave that room. Only where
        // the room is not there (a neighbourhood of forty-odd pages on one screen) does a caption
        // take another side rather than sit on a neighbour.
        const box = placeAround(x, y, radius(i), w, lines.length * lineH, 3 / t.k, placed, discs, [minX + margin, minY + margin, maxX - margin, maxY - margin])
        placed.push(box)
        lmLabels.push({ i, lines, box })
      }
      for (const l of lmLabels) {
        ctx.globalAlpha = (highlight !== null && !highlight.has(l.i) ? dimLabel : 0.95) * labelIn
        ctx.lineWidth = 3 / t.k
        ctx.strokeStyle = halo
        const cx = (l.box[0] + l.box[2]) / 2
        l.lines.forEach((line, j) => {
          ctx.strokeText(line, cx, l.box[1] + j * lineH)
          ctx.fillStyle = textColor
          ctx.fillText(line, cx, l.box[1] + j * lineH)
        })
        // The number its row carries in the list beside it (the anchor of a bloom has none).
        const rank = mask.rank?.get(l.i)
        const rs = radius(l.i) * t.k
        if (rank !== undefined && rs >= 6) {
          ctx.globalAlpha = labelIn
          ctx.font = `600 ${Math.min(11, rs * 1.1) / t.k}px system-ui, sans-serif`
          ctx.textBaseline = 'middle'
          // White on a dark fill, the ground colour on a light one: the dark theme's type and
          // domain colours are light, and white on them fell to a contrast of 2 to 3.
          ctx.fillStyle = inkOn(ctx, nodeColor(l.i), cssVar('--bg', '#0c101b'))
          ctx.fillText(String(rank), pos[l.i * 2]!, pos[l.i * 2 + 1]! + 0.5 / t.k)
          ctx.textBaseline = 'top'
          ctx.font = `${11 / t.k}px system-ui, sans-serif`
        }
      }
    }
    ctx.globalAlpha = 1
    if (areaLabels.length > 0) {
      ctx.save()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const colors = { dark: darkSurface, bg: cssVar('--bg-elev', '#ffffff'), text: cssVar('--text', '#1a2333') }
      const toSx = (x: number): number => w / 2 + t.x + x * t.k
      const toSy = (y: number): number => h / 2 + t.y + y * t.k
      // The Areas captions in the spotlight label's voice (lib/spotLabel.ts), at their zoom size.
      for (const l of areaLabels) paintRegionLabel(ctx, l.text, toSx(l.cx), toSy(l.top), l.world * t.k, { ...colors, hue: l.hue })
      ctx.restore()
    }
    if (spotLabel !== null) {
      // Screen space for the paint: the style is defined in pixels, and crisp type wants them.
      const sl = spotLabel
      ctx.save()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalAlpha = sl.alpha
      const sx = w / 2 + t.x + sl.box[0] * t.k
      const sy = h / 2 + t.y + sl.box[1] * t.k
      paintSpotLabel(ctx, sl.text, sx, sy, {
        hue: sl.hue,
        dark: darkSurface,
        bg: cssVar('--bg-elev', '#ffffff'),
        text: cssVar('--text', '#1a2333'),
      })
      ctx.restore()
    }
    paintedRef.current = true

    // Keep animating while any arrival flash is fading, or the entrance is still building
    // in (rAF-coalesced, self-terminating).
    if (flashActive || revealing) scheduleDrawRef.current?.()
  }, [nodes, edges, focusIndex, selectedIndex, ghostIndices, matches, lens, clusters, clusterSets, clusterLabels, clusterDomains, showHulls, showLabels, network, neighbors, labelReps, radius, authorityT, authorityOf, landmarkMask, onlyNodes, positionsRef, transformRef])

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
    const pos = (displayRef.current ?? positionsRef.current)
    const t = transformRef.current
    const vis = visibleNodes(t, vp, pos)
    const lost = vis.placed > 0 && vis.inView === 0
    if (lost !== offMapRef.current) {
      offMapRef.current = lost
      setOffMap(lost)
    }
    const mini = miniRef.current
    if (mini === null) return
    /*
     * No overview in the Landmarks mode. It is a map of where the picture sits inside the whole
     * layout, and this mode frames what it paints - so the frame is always around the dots, the
     * map always says "you are here, on all of it", and there is nothing left for it to help
     * anybody navigate to. Its bounds are the layout's, so shrinking it to the painted set
     * would be a second, differently-scaled picture rather than an answer.
     */
    if (maskRef.current !== null) {
      if (!mini.hidden) mini.hidden = true
      return
    }
    drawMinimap(mini, t, vp, pos, dpr, isPainted)
  }, [positionsRef, transformRef, isPainted, maskRef])
  const scheduleDraw = useRafDraw(() => {
    draw()
    overlayPass()
  })
  const scheduleDrawRef = useRef<(() => void) | null>(null)
  scheduleDrawRef.current = scheduleDraw

  /** Centers and scales the transform so the whole layout fits with a small margin. */
  const fitToView = useCallback((): void => {
    const canvas = canvasRef.current
    const pos = (displayRef.current ?? positionsRef.current)
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
     * A node is not its centre (fixed 2026-09-16, and again 2026-09-24). Each framed node
     * brings its radius, which is world-space and grows with the zoom, and the title drawn
     * under it, which is screen-space (11px type) and does not; `fitTransform` finds the zoom
     * at which all of them fit. The title is measured as the resting pass draws it, truncated,
     * and a node the draw leaves nameless (a connector outside a bloom) brings none.
     */
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.save()
    ctx.font = '11px system-ui, sans-serif'
    const mask = maskRef.current
    const items: FitItem[] = []
    for (let i = 0; i < pos.length; i += 2) {
      const x = pos[i]!
      const y = pos[i + 1]!
      if (Number.isNaN(x)) continue
      if (!framed(i / 2)) continue
      if (x < minX || x > maxX || y < minY || y > maxY) continue // a straggler the core fit leaves out
      const title = nodes[i / 2]?.title ?? ''
      const named = showLabelsRef.current && !(mask !== null && mask.connectors.has(i / 2) && mask.bloomAnchor === null)
      const text = title.length > 30 ? `${title.slice(0, 28)}…` : title
      // A node a hull can wrap reaches as far as the hull's padding (HULL_PAD, world units,
      // like the radius): the tinted area is part of the picture and was cut off before.
      const hulled = hullFitRef.current?.[i / 2] ?? -1
      const r = hulled >= 0 ? Math.max(radius(i / 2), HULL_PAD) : radius(i / 2)
      // A landmark in the overview brings its WRAPPED title: all of it,
      // up to four lines, which is what the label pass will draw.
      if (mask !== null && namedInFull(mask, i / 2)) {
        const lines = wrapTitle(title, 160, 4, (str) => ctx.measureText(str).width)
        items.push({ x, y, r, labelHalf: Math.max(...lines.map((l) => ctx.measureText(l).width)) / 2 + 2, labelLines: lines.length })
        continue
      }
      items.push({ x, y, r, labelHalf: named ? ctx.measureText(text).width / 2 + 2 : 0 })
    }
    ctx.restore()
    // Whatever the host lays over the top of the drawing (the scope line: "Cluster: …") is not
    // drawing area; the fit starts below it.
    let top = 18
    const rect = canvas.getBoundingClientRect()
    canvas.parentElement?.querySelectorAll<HTMLElement>('[data-fit-avoid]').forEach((el) => {
      top = Math.max(top, el.getBoundingClientRect().bottom - rect.top + 10)
    })
    const mid = fitCenterRef.current
    const centre: [number, number] | null =
      mid !== null && !Number.isNaN(pos[mid * 2] ?? NaN) ? [pos[mid * 2]!, pos[mid * 2 + 1]!] : null
    const next = fitTransform(items, { w, h }, { x: 16, top, bottom: 24 }, centre, FIT_ZOOM_MAX)
    if (next === null) return
    transformRef.current = next
    scheduleDraw()
  }, [scheduleDraw, positionsRef, transformRef, radius, nodes])

  /**
   * The landmark mode's display spread (lib/landmarkLayout.ts): recomputed when the mask or
   * the drawing changes and when the layout settles, cleared outside the mode. It covers the
   * overview and, since 2026-09-24, an open neighbourhood too, with its landmark held in the
   * middle of the picture.
   */
  const computeSpread = useCallback((): boolean => {
    const m = maskRef.current
    const pos = positionsRef.current
    const canvas = canvasRef.current
    if (m === null || canvas === null || pos.length < nodes.length * 2) {
      const had = displayRef.current !== null
      displayRef.current = null
      return had
    }
    const ctx = canvas.getContext('2d')
    if (ctx === null) return false
    const dpr = window.devicePixelRatio || 1
    const vp = { w: canvas.width / dpr, h: canvas.height / dpr }
    if (vp.w === 0 || vp.h === 0) return false
    const pts: Array<{ i: number; x: number; y: number; r: number }> = []
    for (let i = 0; i < nodes.length; i++) {
      if (!painted(m, i, onlyRef.current)) continue
      const x = pos[i * 2]!
      if (Number.isNaN(x)) continue
      pts.push({ i, x, y: pos[i * 2 + 1]!, r: radius(i) })
    }
    ctx.save()
    ctx.font = '11px system-ui, sans-serif'
    const widths = new Map<number, { w: number; lines: number }>()
    for (const p of pts) {
      if (!namedInFull(m, p.i)) continue
      const lines = wrapTitle(nodes[p.i]!.title, 160, 4, (str) => ctx.measureText(str).width)
      widths.set(p.i, { w: Math.max(...lines.map((l) => ctx.measureText(l).width)) + 4, lines: lines.length })
    }
    ctx.restore()
    const moved = spreadPoints(
      pts,
      (i) => {
        const c = widths.get(i)
        return c === undefined ? { w: 0, h: 0 } : { w: c.w, h: c.lines * 13 }
      },
      vp,
      // The bottom keeps clear of the controls standing in the drawing's lower corners.
      { x: 16, top: 18, bottom: 44 },
      // An open neighbourhood keeps its landmark in the middle of the picture.
      m.bloomAnchor,
      FIT_ZOOM_MAX,
    )
    const out = pos.slice()
    for (const [i, [x, y]] of moved) {
      out[i * 2] = x
      out[i * 2 + 1] = y
    }
    displayRef.current = out
    return true
  }, [nodes, radius, positionsRef])
  const computeSpreadRef = useRef(computeSpread)
  computeSpreadRef.current = computeSpread
  useEffect(() => {
    if (computeSpread()) {
      if (!userMovedRef.current) fitToView()
      scheduleDraw()
    }
  }, [computeSpread, landmarkMask, onlyNodes, fitToView, scheduleDraw, userMovedRef])

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
        computeSpreadRef.current()
        setLayouting(false)
        // Frame the FIRST finished layout once, so a graph of any size lands filling the
        // viewport instead of as a speck, and build it in from there. Later layouts (live
        // updates, filter toggles) leave the camera alone and never re-run the entrance -
        // nothing yanks the user away, and nothing flashes, mid-look.
        if (fitPendingRef.current) beginEntranceRef.current()
      }
      // Nodes just moved under a possibly stationary cursor - re-resolve the hover, or a
      // node that drifted away from the pointer keeps its neighborhood highlight stuck.
      refreshHoverRef.current(true)
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

    /*
     * Pages that changed domain since the last layout (graphForces.ts, `reseedPlan`). A split
     * reached this effect as a gentle reheat from the old positions, which cannot carry the
     * moved pages across the map to their new slot: the domains stayed interleaved until a
     * reload. A few moved pages are re-seeded into their slot; a domain that appeared (a
     * split) or a large move deals the layout afresh, framed anew, as a reload would.
     */
    const plan = reseedPlan(
      nodes.map((n) => n.path),
      nodes.map((n) => n.domain),
      domainByPathRef.current,
    )
    const redeal = !firstLayout && plan.mode === 'full'
    if (redeal) seed.fill(NaN)
    else if (plan.mode === 'partial') for (const i of plan.drop) seed.fill(NaN, i * 2, i * 2 + 2)
    for (const n of nodes) domainByPathRef.current.set(n.path, n.domain)

    // Cold start when nothing is placed yet, when the domains were re-dealt, or when the view
    // changed shape substantially (unhiding a whole bucket); gentle reheat for everything
    // else - that is what keeps a live update a "reorientation" instead of a re-deal.
    const cold = firstLayout || redeal || newPaths.length > nodes.length * COLD_RESTART_SHARE
    if (firstLayout) {
      fitPendingRef.current = true
      armEntranceRef.current()
    }
    if (redeal) {
      // Dealt afresh: framed and built in like a first layout, rather than showing the whole
      // map reshuffle node by node under the reader.
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
      // The overview's spread is laid out for the area it is shown in: the list column opening
      // beside it takes 340px of width, and a spread for the wider box then framed smaller.
      computeSpreadRef.current()
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
  }, [matches, focusIndex, selectedIndex, ghostIndices, lens, clusters, clusterLabels, spotlight, landmarkMask, onlyNodes, scheduleDraw])

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
      const pos = (displayRef.current ?? positionsRef.current)
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
  const clusterGeomRef = useRef<{ epoch: number; geoms: SpotGeom[] }>({ epoch: -1, geoms: [] })
  /**
   * Every community's geometry - the SAME one the draw traces (lib/spotlightHover.ts: world
   * padding, painted members only, the smoothed outline). The hull hit-test, the cursor, the
   * area click and the zoom magnet (graphZoom.ts) all read it. Rebuilt when the world changed
   * (the draw epoch), never per query.
   */
  const clusterGeoms = useCallback((): SpotGeom[] => {
    if (clusters === null) return []
    const pos = (displayRef.current ?? positionsRef.current)
    if (pos.length < nodes.length * 2) return []
    const cache = clusterGeomRef.current
    if (cache.epoch === drawEpochRef.current) return cache.geoms
    cache.epoch = drawEpochRef.current
    cache.geoms = buildSpotGeoms(clusters, pos, nodes.length, isPainted)
    return cache.geoms
  }, [clusters, nodes.length, positionsRef, isPainted])

  /** A community a click could isolate: a proper subset of the visible real pages. */
  const isolatable = useCallback(
    (cid: number): boolean => {
      if (cid < 0 || clusterSets === null) return false
      const set = clusterSets.get(cid)
      return set !== undefined && set.size < nodes.length - (ghostIndices?.size ?? 0)
    },
    [clusterSets, nodes.length, ghostIndices],
  )

  /**
   * The community under the pointer's AREA (screen coords → cid, or -1). Sticky to the one
   * already on show and otherwise the smallest containing hull (resolveAreaCid) - so an
   * overlap no longer flips between communities along lines nobody can see.
   */
  const hitCluster = useCallback(
    (sx: number, sy: number): number => {
      // An area answers the pointer for the spotlight, or for the Areas click when the host
      // takes one - and then only the areas it offers.
      const areaMode = !spotlight && showHulls && onAreaClick !== undefined
      if ((!spotlight && !areaMode) || clusters === null || clusterSets === null) return -1
      const geoms = clusterGeoms()
      if (geoms.length === 0) return -1
      const { x, y } = toWorld(sx, sy)
      const shown = spotRef.current.cid >= 0 && spotRef.current.fadeIn ? spotRef.current.cid : null
      const ok = areaMode ? (cid: number): boolean => isolatable(cid) && (areaIds?.has(cid) ?? true) : isolatable
      return resolveAreaCid(x, y, geoms, ok, hullHoverRef.current ?? shown)
    },
    [spotlight, showHulls, onAreaClick, areaIds, clusters, clusterSets, toWorld, clusterGeoms, isolatable],
  )

  /**
   * Feeds what the pointer resolved into the shown-spotlight state machine: a member node
   * shows its community at once, an area waits a beat, losing both lingers a beat. A pending
   * change gets one timer; the draw keeps itself going while a fade runs.
   */
  const wantCid = useCallback(
    (cid: number, fromNode: boolean): void => {
      const now = performance.now()
      const next = wantSpot(spotRef.current, isolatable(cid) ? cid : -1, fromNode, now)
      if (next === spotRef.current) return
      spotRef.current = next
      if (spotTimerRef.current !== null) {
        clearTimeout(spotTimerRef.current)
        spotTimerRef.current = null
      }
      if (next.pending !== null) {
        spotTimerRef.current = window.setTimeout(() => {
          spotTimerRef.current = null
          spotRef.current = tickSpot(spotRef.current, performance.now())
          scheduleDraw()
        }, Math.max(0, next.pending.at - now))
      }
      scheduleDraw()
    },
    [isolatable, scheduleDraw],
  )
  useEffect(
    () => () => {
      if (spotTimerRef.current !== null) clearTimeout(spotTimerRef.current)
    },
    [],
  )
  // New communities (a drill-in re-detects them, a filter changes them): the ids on show
  // belong to the old partition and would light up an unrelated group. Start from nothing.
  useEffect(() => {
    spotRef.current = SPOT_IDLE
    hullHoverRef.current = null
    setHullHover(null)
  }, [clusters])

  // ---- hover refresh: the hover is only correct at the moment of a pointer event, but the
  // world also moves WITHOUT one - layout ticks drift nodes under a stationary cursor, a pan
  // ends with the world shifted, and a node-set change (filter/SSE) reuses the stale INDEX
  // for a different page. One mechanism covers all three: remember where the pointer is and
  // re-hit-test there whenever the world changed.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  const refreshHover = useCallback(
    (fromLayout = false): void => {
      const at = lastPointerRef.current
      const next = at === null ? null : hitTest(at.x, at.y)
      if (next !== hoverRef.current) {
        setHover(next)
        scheduleDraw()
      }
      // A cooling layout moves nodes under a still pointer every frame; the AREA answer is
      // left alone until it settles, or the hull would swap under a hand that did not move.
      if (fromLayout && !settledRef.current && next === null) return
      const hcid = at === null || next !== null ? -1 : hitCluster(at.x, at.y)
      const nextHull = hcid >= 0 ? hcid : null
      if (nextHull !== hullHoverRef.current) {
        hullHoverRef.current = nextHull
        setHullHover(nextHull)
        scheduleDraw()
      }
      if (next !== null) wantCid(clusters?.[next] ?? -1, true)
      else wantCid(hcid, false)
    },
    [hitTest, hitCluster, scheduleDraw, setHover, settledRef, wantCid, clusters],
  )
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
      spotRef.current = SPOT_IDLE
      scheduleDraw()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [scheduleDraw, setHover])

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
    leash(transformRef.current, vp, worldBounds((displayRef.current ?? positionsRef.current)))
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
          : localAnchor(transformRef.current, vp, cx, cy, (displayRef.current ?? positionsRef.current))
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
    const target = nearestMass(transformRef.current, { w: rect.width, h: rect.height }, clusterGeoms(), (displayRef.current ?? positionsRef.current))
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
    const bounds = worldBounds((displayRef.current ?? positionsRef.current))
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
      leash(transformRef.current, { w: rect.width, h: rect.height }, worldBounds((displayRef.current ?? positionsRef.current)))
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
      hullHoverRef.current = nextHull
      setHullHover(nextHull)
      scheduleDraw()
    }
    // One source for what is shown: the node's own community on a node, the area's otherwise.
    if (hit !== null) wantCid(clusters?.[hit] ?? -1, true)
    else wantCid(hcid, false)
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
          const cid = hitCluster(e.clientX, e.clientY)
          if (cid >= 0 && spotlight && onClusterClick !== undefined) onClusterClick(cid)
          else if (cid >= 0 && !spotlight && onAreaClick !== undefined) onAreaClick(cid)
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
  const hoverAreaDrills = hover === null && hullHover !== null && (spotlight ? onClusterClick : onAreaClick) !== undefined
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
              hullHoverRef.current = null
              setHullHover(null)
              scheduleDraw()
            }
            wantCid(-1, false)
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
              {spotlight && onClusterClick !== undefined ? ' · click to isolate' : !spotlight && onAreaClick !== undefined ? ' · click to show it alone' : ''}
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
/** 12, not the 10 it was: the display face (2026-09-24) reads smaller than the system face did. */
const LABEL_MIN_SCREEN_PX = 12


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
/**
 * Per node disc a caption would sit on (up to three): a dot drawn under a caption hides it.
 * Small next to the distance penalty on purpose - staying by its own area matters more than a
 * perfectly clear spot, or captions wander off to wherever the graph happens to be empty.
 */
const PENALTY_NODE = 0.5
/** Per unit of distance beyond the hull edge, relative to the hull radius - keeps labels near. */
const PENALTY_DISTANCE = 4
/**
 * A caption that does not fit in the picture (2026-09-22). It used to be placed in world space
 * with no idea where the frame was, so zooming in cut captions in half at the edges - measured
 * on the whole vault six notches in. The penalty is above every other one put together, so a
 * spot inside the frame always beats a better-looking spot outside it; a caption with nowhere
 * inside to go is dropped rather than drawn across the edge.
 */
const PENALTY_OFFSCREEN = 100

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
  /** The visible world rectangle, when the caller has one: captions stay inside the frame. */
  view: Box | null = null,
  /** How many node discs a candidate box would cover - a caption under dots is not read. */
  nodesUnder: ((box: Box) => number) | null = null,
): PlacedRegionLabel[] {
  const inFrame = (b: Box): boolean =>
    view === null || (b[0] >= view[0] && b[1] >= view[1] && b[2] <= view[2] && b[3] <= view[3])
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
        if (!inFrame(box)) penalty += PENALTY_OFFSCREEN
        for (const [cid, poly] of hulls) {
          if (!boxIntersectsPolygon(box, poly)) continue
          penalty += cid === label.key ? PENALTY_OWN_HULL : PENALTY_FOREIGN_HULL
        }
        if (nodesUnder !== null) penalty += Math.min(3, nodesUnder(box)) * PENALTY_NODE
        if (best === null || penalty < best.penalty - 1e-9) {
          best = { x: centerX, y: top, box, penalty }
          if (penalty === 0) break // nothing can beat a clean spot at this distance
        }
      }
      if (best !== null && best.penalty === 0) break
    }

    // Every candidate collided with an already-placed label: drop this one rather than
    // stack two unreadable labels. Weight order keeps the labels that matter most. A caption
    // that only fits outside the frame is dropped the same way - half a word at the edge names
    // nothing, and the hull it belongs to is on screen to be hovered.
    if (best === null || !inFrame(best.box)) continue
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

// The hull helpers moved to lib/spotlightHover.ts; re-exported for the region-label tests.
export { pointInPolygon } from '../lib/spotlightHover.ts'

/**
 * Counts the node discs a box touches, through a uniform grid - the placement asks this for
 * every candidate of every caption, several thousand times a frame, against a thousand nodes.
 */
export function discCounter(discs: ReadonlyArray<{ x: number; y: number; r: number }>, cell: number): (box: Box) => number {
  const grid = new Map<string, number[]>()
  const key = (gx: number, gy: number): string => `${gx}:${gy}`
  discs.forEach((d, i) => {
    const x0 = Math.floor((d.x - d.r) / cell)
    const x1 = Math.floor((d.x + d.r) / cell)
    const y0 = Math.floor((d.y - d.r) / cell)
    const y1 = Math.floor((d.y + d.r) / cell)
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++) (grid.get(key(gx, gy)) ?? grid.set(key(gx, gy), []).get(key(gx, gy))!).push(i)
  })
  return (box: Box): number => {
    const seen = new Set<number>()
    for (let gx = Math.floor(box[0] / cell); gx <= Math.floor(box[2] / cell); gx++)
      for (let gy = Math.floor(box[1] / cell); gy <= Math.floor(box[3] / cell); gy++)
        for (const i of grid.get(key(gx, gy)) ?? []) {
          if (seen.has(i)) continue
          const d = discs[i]!
          const nx = Math.max(box[0], Math.min(d.x, box[2]))
          const ny = Math.max(box[1], Math.min(d.y, box[3]))
          if ((nx - d.x) ** 2 + (ny - d.y) ** 2 < d.r * d.r) seen.add(i)
        }
    return seen.size
  }
}

/** Relative luminance of a colour the canvas can parse (hex, rgb(), hsl()), 0..1. */
function luminance(ctx: CanvasRenderingContext2D, color: string): number {
  const prev = ctx.fillStyle
  ctx.fillStyle = '#000000'
  ctx.fillStyle = color
  const norm = String(ctx.fillStyle)
  ctx.fillStyle = prev
  let rgb: number[]
  if (norm.startsWith('#')) rgb = [1, 3, 5].map((k) => parseInt(norm.slice(k, k + 2), 16))
  else rgb = (norm.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** White or the ground colour on `fill`, whichever reads better (WCAG contrast ratio). */
function inkOn(ctx: CanvasRenderingContext2D, fill: string, ground: string): string {
  const lf = luminance(ctx, fill)
  const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  return ratio(lf, 1) >= ratio(lf, luminance(ctx, ground)) ? '#ffffff' : ground
}
