/**
 * One room of the Library as an SVG (docs/agents/SPEC.md section 10, docs/tasks/TASKS-A4.md
 * D1): the design generator's drawing ported to React. Floor and walls first, then every
 * item in painter's order by depth, labels and tags on top. Figures sit in translated
 * groups with a CSS transition, so a pose change slides them between anchors.
 *
 * The main room's furniture is the one rebuilt on 2026-09-17 (SPEC 10.13): ten desks on a
 * rug, one per Fellow, the book cart, the plant, three chalkboards, a glazed double door,
 * and open cases with the books standing in them as boxes.
 */

import { useMemo } from 'react'
import type { SceneRoom, SceneShelf } from '../../api/types.ts'
import { domainHue } from '../../lib/domains.ts'
import { boxFaces, depthOf, fitRoom, hsl, makeProj, mix, pts, seeded, type Proj, type Pt } from '../../lib/library/iso.ts'
import { ANCHORS, CART_D, CART_W, CASE_D, CASE_W, DEFAULT_AISLE, DESK, DOOR, EASEL_W, FAV_I, MID_J, ROOM, RUG_LEFT, SLOTS, WALL_H, WALL_J, deskPositions, doorAt, layoutSign, signText, wingSlotPositions, type Aisles } from '../../lib/library/room.ts'

/** The case dimensions under the short names the geometry below reads in. */
const a = CASE_W
const b = CASE_D
/** The width of a case's two uprights, in tiles. */
const STILE = 0.08
import { busyDesks, type Actor } from '../../lib/library/scene.ts'

const FONT = '"Instrument Sans", system-ui, sans-serif'
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace'

const SHELF = {
  day: { top: '#8a6448', left: '#6f4d36', right: '#5a3c29', band: '#4a3122', sign: '#f3e6d6' },
  night: { top: '#4a3324', left: '#3a281c', right: '#2e1f16', band: '#241811', sign: '#e0cdb8' },
}
/**
 * The room's fittings (design round 8, 2026-09-06): oak parquet in panel blocks, sage walls
 * over a walnut wainscot. `seam` is the joint between the blocks, `base` the skirting and
 * the cornice - it takes the wainscot's colour, so no pale strip runs along the floor.
 */
/** The boards on the short wall, each opening as a window over the room. */
export type BoardId = 'hot' | 'recap' | 'reading' | 'questions'

/** How far a wall tile reaches into the next one, so no seam of the page shows between them. */
const SEAM = 0.02

const FLOOR = {
  day: { base: '#a87d4e', tones: ['#c8985f', '#bf8e57', '#d0a26b'], seam: '#8f6a41' },
  night: { base: '#3b2d1e', tones: ['#4c3927', '#453422', '#54402b'], seam: '#2c2116' },
}
const WALL = {
  day: { left: '#8b9c8a', right: '#82927f', base: '#6d5136', line: '#553f28', rail: '#8a6a43', panel: '#6d5136', hi: '#9c7a52', cornice: '#7b8b7a' },
  night: { left: '#2f3a34', right: '#28322d', base: '#2e241a', line: '#221a12', rail: '#4a3a26', panel: '#2e241a', hi: '#4a3a26', cornice: '#26302b' },
}
/** The wainscot's share of the wall height, and the rail on top of it. */
const WAINSCOT = 0.44
const TOK = { accent: '#2f62c9', accentSoft: '#e6eefc', muted: '#6b7890', mutedBg: '#eef1f6', faint: '#8a95ad', dim: '#5c6a85', elev2: '#f1f3f8', border: '#d9dfeb', borderStrong: '#c3cde0', warn: '#b7791f', warnBg: '#fbf1dc', text: '#1a2333' }

/**
 * The rug under the desk section (2026-09-17): sage wool with a darker border and a pale
 * line, in the wall's own family of greens. Chosen over carpet tiles, a striped weave and an
 * oriental pattern, which fought either the parquet or the shelves. Night dims it with the room.
 */
interface RugColors {
  readonly border: string
  readonly field: string
  readonly field2: string
  readonly line: string
}
const RUG: RugColors = { border: '#6f8578', field: '#8aa094', field2: '#85998e', line: '#c3cfc6' }
function rugColors(night: boolean): RugColors {
  if (!night) return RUG
  const d = (v: string): string => mix(v, '#0f1524', 0.55)
  return { border: d(RUG.border), field: d(RUG.field), field2: d(RUG.field2), line: d(RUG.line) }
}

/** hsl to `#rrggbb`, so a book's colour can be mixed for its top and its side. */
function hslHex(h: number, s: number, l: number): string {
  const hh = (((h % 360) + 360) % 360) / 360
  const ss = s / 100
  const ll = l / 100
  const f = (n: number): number => {
    const k = (n + hh * 12) % 12
    const aa = ss * Math.min(ll, 1 - ll)
    return ll - aa * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  const to = (v: number): string => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`
}

interface Item {
  readonly d: number
  readonly key: string
  readonly node: React.ReactNode
}

const signSize = (TW: number): number => (TW >= 56 ? 10.5 : TW >= 46 ? 9.5 : 8.5)
const BAND = (TW: number): number => Math.round(2 * signSize(TW) + 6)

let signCtx: CanvasRenderingContext2D | null | undefined
/**
 * The drawn width of a sign line: the canvas measures it in the sign's own face and weight,
 * plus the 0.02em letter spacing the text carries. Without a canvas the old estimate stands,
 * which errs wide, so a sign it sets still fits.
 */
function measureSign(t: string, size: number): number {
  if (signCtx === undefined) {
    try {
      signCtx = document.createElement('canvas').getContext('2d')
    } catch {
      signCtx = null
    }
  }
  if (signCtx === null) return t.length * size * 0.58
  signCtx.font = `600 ${size}px ${FONT}`
  return signCtx.measureText(t).width + t.length * size * 0.02
}

/**
 * Sign text lying on a shelf face, one size per view, two lines when the name does not fit,
 * and smaller on this sign alone when two lines do not fit either (`layoutSign`).
 */
function faceText(P: Proj, i: number, j: number, zb: number, text: string, fill: string, maxLen: number, key: string): React.ReactNode {
  const TW = P.TW
  if (TW < 34) return null
  const band = BAND(TW)
  // A pixel short of the face on each side, so a line that just fits does not touch its edge.
  const facePx = (maxLen * TW) / 2 - 2
  const { lines, size } = layoutSign(text, facePx, signSize(TW), measureSign)
  const cap = size * 0.72
  // Centred in the band: one line on its own, two as a block with a 2px gap between them.
  const block = lines.length === 1 ? cap : cap + size + 2
  const bottom = zb + (band - block) / 2
  const baselines = lines.length === 1 ? [bottom] : [bottom + size + 2, bottom]
  return lines.map((ln, k) => {
    const [x, y] = P(i, j, baselines[k]!)
    return (
      <text key={`${key}-${k}`} transform={`matrix(1 0.5 0 1 ${x.toFixed(1)} ${y.toFixed(1)})`} fontFamily={FONT} fontSize={size} fontWeight={600} letterSpacing="0.02em" fill={fill}>
        {ln}
      </text>
    )
  })
}

function Box({ P, i0, j0, a, b, h, c, z0 = 0 }: { P: Proj; i0: number; j0: number; a: number; b: number; h: number; c: { top: string; left: string; right: string }; z0?: number }): React.ReactElement {
  const f = boxFaces(P, i0, j0, a, b, h, z0)
  return (
    <>
      <polygon points={pts(f.left)} fill={c.left} />
      <polygon points={pts(f.right)} fill={c.right} />
      <polygon points={pts(f.top)} fill={c.top} />
    </>
  )
}

interface Book {
  readonly r: number
  readonly t: number
  readonly ds: number
  readonly hs: number
  readonly fill: string
}

/** A bookcase along i: frame, the sign band, rows of books. `spare` draws the silhouette of a free slot. */
function Bookcase({ P, i0, j0, shelf, night, spare, label, selected }: { P: Proj; i0: number; j0: number; shelf: SceneShelf | null; night: boolean; spare?: string; label?: string; selected?: boolean }): React.ReactElement {
  const TW = P.TW
  const scale = TW / 46
  const band = BAND(TW)
  const h = Math.round(64 * scale) + 10
  const c0 = SHELF[night ? 'night' : 'day']
  const c = spare !== undefined ? { ...c0, top: mix(c0.top, night ? '#0f1524' : '#ffffff', 0.45), left: mix(c0.left, night ? '#0f1524' : '#ffffff', 0.45), right: mix(c0.right, night ? '#0f1524' : '#ffffff', 0.45), band: mix(c0.band, night ? '#0f1524' : '#ffffff', 0.45) } : c0
  const rowsTop = h - band - 3
  const rows = 3
  const rowH = (rowsTop - 4) / rows
  const rowZ = (r: number): number => 3 + r * rowH
  const front = j0 + b
  /* The sign sits BETWEEN the stiles (2026-09-17): the two uprights run the full height of the
     case, and the band is let into the top of the front like a name plate, so nothing on the
     front changes where the sign begins. */
  const bandPoly: Pt[] = [P(i0 + STILE, front, rowsTop + 1), P(i0 + a - STILE, front, rowsTop + 1), P(i0 + a - STILE, front, h - 3), P(i0 + STILE, front, h - 3)]
  /*
   * The books as data - row, place along the case, width, height, colour - and no geometry,
   * so the memo survives a resize: the polygons themselves used to be memoised and stayed on
   * the old offset when the room moved without changing its tile width (2026-09-08). `shelf`
   * itself stays out: the scene is polled, so its identity changes every few seconds while
   * the three fields that decide what is drawn do not.
   */
  const books = useMemo((): Book[] => {
    if (!shelf) return []
    const rnd = seeded(domainHue(shelf.domain) * 7919 + shelf.books + shelf.volumes)
    const hue = domainHue(shelf.domain)
    const capacity = rows * Math.floor((a - 0.3) / 0.21)
    const n = Math.min(capacity, Math.max(shelf.books + shelf.volumes > 0 ? 4 : 0, Math.round((shelf.books + shelf.volumes * 0.5) * 0.55)))
    const out: Book[] = []
    let drawn = 0
    const volumeShare = shelf.books + shelf.volumes > 0 ? shelf.volumes / (shelf.books + shelf.volumes) : 0
    for (let r = 0; r < rows; r++) {
      let t = 0.15
      while (t < a - 0.2 && drawn < n) {
        const thin = rnd() < Math.max(0.1, volumeShare)
        const ds = thin ? 0.09 : 0.14 + rnd() * 0.1
        /* A row ends short of the right stile. The spines stand a little back from the front,
           so the projection carries them to the right, and a book allowed to reach the stile
           stood over it (2026-09-17). Short of it by its own recess and a hair. */
        if (t + ds > a - STILE - 0.16) break
        const hs = rowH - 4 - rnd() * 5
        const gap = rnd() < 0.08 ? 0.12 : 0.03
        const l = night ? 28 + rnd() * 12 : 40 + rnd() * 20
        const sat = thin ? 30 : 48 + rnd() * 16
        out.push({ r, t, ds, hs, fill: hslHex(hue + (rnd() * 16 - 8), sat, l) })
        t += ds + gap
        drawn++
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shelf?.domain, shelf?.books, shelf?.volumes, night, rowH])
  /*
   * An open case with depth, drawn the way the cart is (2026-09-17): back panel, sides, a
   * plank per row and the books as boxes standing on it, set a little back from the front
   * edge. Chosen over the flat spines the case used to wear, and over a cheaper look that gave
   * each spine a top: the books have to stand IN something, or the tops read as bulging out.
   *
   * The back panel is LIGHTER than the wood, not darker: what shows of it is a strip above
   * the top row, right under the dark sign band, and drawn dark the two were one surface.
   * The sides run the full height, so each stile reaches the top of the case in one piece and
   * the right face of the case is one face: a cap and a shorter side used to meet at the
   * sign's foot, and the seam showed as a hairline. The top board paints LAST, as a top face
   * with a lip between the stiles: a full-height side shows its inner face where it rises
   * past the shelves, and painted after the top that face swallowed the top (2026-09-17).
   * The left side paints BEFORE the back panel for the same kind of reason: its inner face
   * reaches back to the wall, and painted after the panel the sliver of it behind the panel's
   * front showed as a dark notch in the top-left corner of a sparsely filled row.
   */
  const side = STILE
  const inner = rowsTop + 1
  const interior = { top: c.top, left: mix(c.left, '#ffffff', night ? 0.16 : 0.24), right: c.right }
  const body = (
    <>
      <Box P={P} i0={i0} j0={j0} a={a} b={b} h={3} c={c} />
      <Box P={P} i0={i0} j0={j0} a={side} b={b} h={h} c={c} />
      <Box P={P} i0={i0} j0={j0} a={a} b={0.1} h={inner} c={interior} />
      {[0, 1, 2].map((r) => (
        <g key={r}>
          <Box P={P} i0={i0 + side} j0={j0 + 0.1} a={a - 2 * side} b={b - 0.1} h={2.4} z0={rowZ(r) - 2.4} c={{ top: mix(c.top, '#ffffff', 0.1), left: c.left, right: c.right }} />
          {books
            .filter((k) => k.r === r)
            .map((k, n) => (
              <Box key={n} P={P} i0={i0 + k.t} j0={j0 + 0.16} a={k.ds} b={b - 0.28} h={k.hs} z0={rowZ(r)} c={{ top: mix(k.fill, '#ffffff', 0.3), left: k.fill, right: mix(k.fill, '#000000', 0.3) }} />
            ))}
        </g>
      ))}
      <Box P={P} i0={i0 + a - side} j0={j0} a={side} b={b} h={h} c={c} />
      <polygon points={pts([P(i0 + side, front, h - 3), P(i0 + a - side, front, h - 3), P(i0 + a - side, front, h), P(i0 + side, front, h)])} fill={c.left} />
      <polygon points={pts([P(i0, j0, h), P(i0 + a, j0, h), P(i0 + a, front, h), P(i0, front, h)])} fill={c.top} />
    </>
  )
  return (
    <g className={`lib-case${selected ? ' selected' : ''}`}>
      {body}
      <polygon points={pts(bandPoly)} fill={c.band} />
      {spare !== undefined
        ? faceText(P, i0 + 0.12, front, rowsTop + 1, spare, mix(c0.sign, c.band, 0.45), a - 0.2, 'free')
        : shelf && faceText(P, i0 + 0.12, front, rowsTop + 1, label ?? signText(shelf.domain), c.sign, a - 0.2, 'sign')}
      {/*
       * The lit top edge, revealed under the pointer (2026-09-16). A shelf opens its
       * department and can be dragged to another slot, and nothing said so: the cursor turned
       * to a grab hand and the drawing did not move a pixel, so the cases read as scenery.
       *
       * Light rather than motion, and on the EDGE rather than on a face: the room is already
       * drawn as lit and shaded surfaces, so a rim along the top is the one highlight that
       * speaks its language, and it marks exactly this object without touching its material -
       * which a brightened face cannot, since every case shares the same three colours.
       *
       * It traces the front edge and the right one, the two the viewer is on the outside of.
       * Drawn for a free slot too: that one starts a department, so it is as clickable as its
       * neighbours, and a slot that stayed dead while the others lit up would teach the
       * opposite. The line is always in the tree and only its opacity moves, so hovering
       * never re-lays the room out.
       */}
      <polyline
        className="bc-rim"
        points={pts([P(i0, front, h), P(i0 + a, front, h), P(i0 + a, j0, h)])}
        fill="none"
        stroke={night ? '#ffd9a8' : '#fff4e2'}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      {selected && <polygon points={pts([P(i0 - 0.1, j0 - 0.1, 0), P(i0 + a + 0.1, j0 - 0.1, 0), P(i0 + a + 0.1, j0 + b + 0.1, 0), P(i0 - 0.1, j0 + b + 0.1, 0)])} fill="none" stroke={TOK.accent} strokeWidth={2} strokeDasharray="5 4" />}
    </g>
  )
}

/**
 * A figure at (0, 0): the pose vocabulary of the Sprites artboard, no faces (NEW-6).
 *
 * Every pose stands (2026-09-17). A Fellow is at its own desk whatever it is doing, and the
 * armchairs a seated figure used to sink into are gone with the fireplace - so `sleep` and
 * `sit` are a standing figure with a prop, and `desk` is a figure standing at its screen, legs
 * included: the seated variant had none, and standing in front of a desk it read as cut off.
 */
function Figure({ a, night }: { a: Actor; night: boolean }): React.ReactElement {
  const skin = '#e8c39e'
  const hair = '#5a3a22'
  const shirt = a.color
  const pants = night ? '#2b3550' : '#3a4763'
  const paper = night ? '#dfe4ef' : '#ffffff'
  const parcel = night ? { fill: '#5c4a2c', stroke: '#3a2f1c' } : { fill: '#d9b98a', stroke: '#b08d5a' }
  const shadow = <ellipse cx={0} cy={0} rx={10} ry={4.5} fill={night ? '#0a0d16' : '#c9d0de'} opacity={0.55} />
  const edge = night ? '#e9edf7' : '#1a2333'
  const halo = night ? <ellipse cx={0} cy={-22} rx={22} ry={24} fill="#e9edf7" opacity={0.07} /> : null
  const faint = night ? '#78859f' : TOK.faint
  if (a.name === 'parcel') {
    return (
      <g>
        {shadow}
        <rect x={-9} y={-14} width={18} height={12} rx={1.5} fill={parcel.fill} stroke={parcel.stroke} />
        <path d="M0 -14 v12" stroke={parcel.stroke} />
      </g>
    )
  }
  const bodyY = -30
  const asleep = a.pose === 'sleep'
  return (
    <g>
      {shadow}
      {halo}
      <rect x={-5} y={-14} width={4} height={13} rx={1.5} fill={pants} />
      <rect x={1} y={-14} width={4} height={13} rx={1.5} fill={pants} />
      <rect x={-7} y={bodyY} width={14} height={18} rx={4} fill={shirt} stroke={edge} strokeWidth={0.8} strokeOpacity={0.3} />
      {/* A sleeper's head tips forward a little; that and the z's are the whole difference. */}
      <g transform={asleep ? `rotate(-14 0 ${bodyY})` : undefined}>
        <circle cx={0} cy={bodyY - 6} r={6} fill={skin} stroke={edge} strokeWidth={0.8} strokeOpacity={0.3} />
        <path d={`M-6 ${bodyY - 8} q6 -7 12 0`} fill={hair} />
      </g>
      {(a.pose === 'shelf' || a.pose === 'shelve') && <rect x={5} y={bodyY - 2} width={7} height={9} rx={1} fill={a.book ?? '#2f62c9'} transform={`rotate(${a.pose === 'shelve' ? -35 : -10} 8 ${bodyY + 2})`} />}
      {a.pose === 'carry' && (
        <>
          <rect x={-8} y={bodyY + 6} width={16} height={10} rx={1.5} fill={parcel.fill} stroke={parcel.stroke} />
          <path d={`M0 ${bodyY + 6} v10`} stroke={parcel.stroke} />
        </>
      )}
      {a.pose === 'clipboard' && (
        <>
          <rect x={4} y={bodyY + 2} width={8} height={11} rx={1} fill={paper} stroke={TOK.borderStrong} />
          <path d={`M6 ${bodyY + 6} h4 M6 ${bodyY + 9} h4`} stroke={TOK.borderStrong} strokeWidth={1} />
        </>
      )}
      {a.pose === 'think' && (
        <text x={9} y={bodyY - 12} fontFamily={MONO} fontSize={9} fill={faint}>
          …
        </text>
      )}
      {asleep && (
        <>
          <text x={9} y={bodyY - 3} fontFamily={MONO} fontSize={9} fill={faint}>
            z
          </text>
          <text x={14} y={bodyY - 9} fontFamily={MONO} fontSize={8} fill={faint}>
            z
          </text>
        </>
      )}
    </g>
  )
}

/*
 * A figure's bubble. A Fellow's opens with a dot in its shelf's colour - the same dot the card
 * a click on the bubble opens carries, so the two are recognisably about one Fellow, and the
 * room says which shelf someone works for without being asked. The pill grows by exactly the
 * room the dot takes and the text keeps the rest of it, centred in what is left.
 */
function Tag({ text, kind, night, y, dot }: { text: string; kind: Actor['tag']; night: boolean; y: number; dot?: string | undefined }): React.ReactElement {
  /*
   * The pill lost its fill and its resting border (2026-09-17): a label over a drawn room is a
   * caption, and a filled lozenge behind every figure was a second row of furniture. What is
   * left is the dot, the name in the colour its state gives it, and a border that appears only
   * under the pointer.
   *
   * `fill="transparent"` rather than `"none"`, and the difference is not cosmetic: a shape
   * with no fill is hit-tested on its stroke alone, and the bubble is what you click to open a
   * Fellow's card - `none` would leave the click working only on the glyphs.
   *
   * The name is anchored to the DOT rather than centred in the pill, which is what finally
   * fixed the gap between them. The pill's width is an estimate (6.15px a character), the text
   * is usually narrower than that, and a centred block splits the whole error into two margins
   * - so the space in front of the name was mostly slack in a guess. Anchored, the gap is the
   * 3px it says it is, whatever the estimate does, and the error lands after the name where
   * there is no longer a pill edge to be unbalanced against.
   */
  const w = text.length * 6.15 + 14 + (dot !== undefined ? 9 : 0)
  /*
   * White, with one exception. The colour used to carry the actor's state - a Fellow blue, a
   * visitor grey, a sleeper fainter still - and for those three the caption already says it in
   * words ("Ada (asleep)"), which is a better way to say it than a shade nobody decodes.
   *
   * `warn` keeps its amber, because it is the one state that is an ALARM: a blocked Fellow, a
   * run that came back not ok. `tag` is read nowhere else in the app, so white across the board
   * would have left the scene computing a state that nothing renders - and taken the room's
   * only colour of alarm with it.
   */
  const ink = kind === 'warn' ? (night ? '#e2a64d' : TOK.warn) : '#ffffff'
  return (
    <g>
      <rect className="lib-tag" x={-w / 2} y={y - 9} width={w} height={18} rx={9} fill="transparent" />
      {dot !== undefined && <circle cx={-w / 2 + 10} cy={y} r={3} fill={dot} />}
      <text
        className="lib-tag-name"
        x={dot !== undefined ? -w / 2 + 16 : 0}
        y={y + 3.6}
        textAnchor={dot !== undefined ? 'start' : 'middle'}
        fontFamily={FONT}
        fontSize={10.5}
        fontWeight={600}
        fill={ink}
      >
        {text}
      </text>
    </g>
  )
}


export interface RoomSvgProps {
  readonly room: SceneRoom
  readonly night: boolean
  readonly actors: readonly Actor[]
  readonly width: number
  readonly height: number
  readonly selectedAgentId?: string | null
  readonly draggingDomain?: string | null
  readonly dropSlot?: number | null
  readonly onShelfClick?: (domain: string) => void
  readonly onShelfPointerDown?: (domain: string, e: React.PointerEvent) => void
  readonly onSlotPointerEnter?: (slot: number) => void
  readonly onActorClick?: (actor: Actor, e: React.MouseEvent) => void
  /** A board on the short wall was clicked; the screen opens it as a window. */
  readonly onBoardClick?: ((board: BoardId) => void) | undefined
  /** The book cart was clicked; the screen opens System, where the maintenance runs start. */
  readonly onCartClick?: (() => void) | undefined
  /**
   * A desk was clicked, with whoever stands at it (null for an empty one). The screen opens
   * the night shift on a Fellow's shelf, or on the night itself for a desk with no Fellow.
   */
  readonly onDeskClick?: ((desk: number, occupant: Actor | null) => void) | undefined
  /** The name over the passage: which room it leads to. Absent = no sign, one room only. */
  readonly nextRoomName?: string | undefined
  /** How many questions are open on the pinboard; the easel pins that many cards (six at most). */
  readonly openQuestions?: number | undefined
  /** The passage in the back wall was clicked; the screen shows the next room. */
  readonly onPassageClick?: (() => void) | undefined
  readonly passageTitle?: string | undefined
  /** The wing's banner was clicked; the screen offers the rename. */
  readonly onBannerClick?: (() => void) | undefined
  /** A free shelf was clicked; the screen offers a new department for that slot. */
  readonly onEmptySlotClick?: ((slot: number) => void) | undefined
  /**
   * A gap was taken hold of: which row, and where it stands now. The screen drags it along
   * the row and drops it on another position - see `aisleDrop`.
   */
  readonly onAislePointerDown?: ((row: 'wall' | 'mid', at: number, e: React.PointerEvent) => void) | undefined
  /** While a gap is being dragged: which row it belongs to, and the position under the pointer. */
  readonly draggingAisle?: { row: 'wall' | 'mid'; at: number } | null
  readonly idp?: string
}

export function RoomSvg(props: RoomSvgProps): React.ReactElement {
  const { room, night, actors, width: W, height: H } = props
  /*
   * Where this room's two gaps stand. A wing's are the user's arrangement; the main room
   * reports the middle and keeps it, its door being part of the architecture.
   */
  const aisles: Aisles = { wall: room.wallAisle ?? DEFAULT_AISLE, mid: room.midAisle ?? DEFAULT_AISLE }
  const door = room.kind === 'wing' ? doorAt(aisles.wall) : DOOR
  const idp = props.idp ?? 'lib'
  const mode = night ? 'night' : 'day'
  const { TW, ox, oy } = useMemo(() => fitRoom(ROOM.NI, ROOM.NJ, W, H, WALL_H), [W, H])
  const P = useMemo(() => makeProj(ox, oy, TW), [ox, oy, TW])
  const TH = TW / 2
  const f = FLOOR[mode]
  const w = WALL[mode]
  const rug = rugColors(night)
  const k = TW / 2 / 56
  const kv = TH / 2 / 56
  const items: Item[] = []
  const top: React.ReactNode[] = []
  const add = (d: number, key: string, node: React.ReactNode): void => {
    items.push({ d, key, node })
  }
  const diamond = (i0: number, j0: number, i1: number, j1: number): string => pts([P(i0, j0), P(i1, j0), P(i1, j1), P(i0, j1)])
  const wallH = WALL_H
  const wainH = Math.round(wallH * WAINSCOT)
  const panel = (fill: string, key: string): React.ReactElement => (
    <pattern key={key} id={`${idp}-${key}`} patternUnits="userSpaceOnUse" width={56} height={wallH} patternTransform={`matrix(${key.endsWith('R') ? -k : k} ${kv} 0 1 ${ox} ${oy - wallH})`}>
      <rect width={56} height={wallH} fill={fill} />
      <rect x={0} y={wallH - wainH} width={56} height={wainH} fill={w.panel} />
      <rect x={0} y={wallH - wainH - 5} width={56} height={5} fill={w.rail} />
      <rect x={0} y={wallH - wainH - 6} width={56} height={1.2} fill={w.hi} />
      <rect x={6} y={wallH - wainH + 8} width={44} height={wainH - 18} fill="none" stroke={w.line} strokeWidth={1.4} />
      <rect x={10} y={wallH - wainH + 12} width={36} height={wainH - 26} fill="none" stroke={w.hi} strokeWidth={0.7} />
    </pattern>
  )

  // Walls as one-tile segments so figures behind them sort correctly; the door is a gap with a lintel.
  for (let kk = 0; kk < ROOM.NI; kk++) {
    if (kk >= door.from && kk < door.to) continue
    // A hair into the next tile: without it the seams show as hairlines of the page behind.
    const wide = kk + 1 + (kk + 1 === door.from || kk + 1 >= ROOM.NI ? 0 : SEAM)
    add(kk + 0.5 - 0.45, `wl${kk}`, (
      <g>
        <polygon points={pts([P(kk, 0, 0), P(wide, 0, 0), P(wide, 0, wallH), P(kk, 0, wallH)])} fill={`url(#${idp}-wallL)`} />
        <polygon points={pts([P(kk, 0, 0), P(wide, 0, 0), P(wide, 0, 6), P(kk, 0, 6)])} fill={w.base} />
        <polygon points={pts([P(kk, 0, wallH - 4), P(wide, 0, wallH - 4), P(wide, 0, wallH), P(kk, 0, wallH)])} fill={w.cornice} />
      </g>
    ))
  }
  // The passage: a wooden frame around the opening, and the way into the next room.
  const doorZ = wallH * 0.62
  const frameC = { frame: night ? '#5b4630' : '#8a6a43', edge: night ? '#3d2f1f' : '#6f5335' }
  /*
   * The double door in the opening (2026-09-17), where a bare dark corridor used to show:
   * two leaves, a wooden panel below and a six-pane window above, brass knobs at the meeting
   * stiles. The corridor shows through the glass, so the door still says "this way through".
   * Chosen over a closed panelled pair, a pair standing open into the room, and glazed leaves
   * under a fanlight. The frame, its lit edge and the click are as they were.
   */
  const leaves = ((): React.ReactNode => {
    const lw = (door.to - door.from) / 2
    const mid = door.from + lw
    const leafC = night ? { face: '#3a2818', panel: '#2e1f12', line: '#241810', hi: '#5a4230' } : { face: '#7a5a3a', panel: '#6a4c30', line: '#4e3622', hi: '#9a7a55' }
    const knob = night ? '#8a7440' : '#c9a24a'
    const glass = night ? { fill: '#0b1220', tint: 0.75 } : { fill: '#dfe8fb', tint: 0.4 }
    const wallQuad = (i0: number, i1: number, z0: number, z1: number): string => pts([P(i0, 0, z0), P(i1, 0, z0), P(i1, 0, z1), P(i0, 0, z1)])
    const leaf = (i0: number, i1: number, key: string): React.ReactNode => (
      <g key={key}>
        <polygon points={wallQuad(i0, i1, 0, doorZ)} fill={leafC.face} stroke={leafC.line} strokeWidth={0.8} />
        <polygon points={wallQuad(i0 + 0.2, i1 - 0.2, 7, 28)} fill={leafC.panel} stroke={leafC.hi} strokeWidth={0.6} />
        <polygon points={wallQuad(i0 + 0.18, i1 - 0.18, 35, doorZ - 8)} fill={glass.fill} opacity={glass.tint} stroke={leafC.line} strokeWidth={0.8} />
        <polyline points={pts([P((i0 + i1) / 2, 0, 35), P((i0 + i1) / 2, 0, doorZ - 8)])} stroke={leafC.face} strokeWidth={1.2} />
        {[1, 2].map((q) => (
          <polyline key={q} points={pts([P(i0 + 0.18, 0, 35 + ((doorZ - 43) * q) / 3), P(i1 - 0.18, 0, 35 + ((doorZ - 43) * q) / 3)])} stroke={leafC.face} strokeWidth={1.2} />
        ))}
      </g>
    )
    return (
      <>
        {leaf(door.from, mid, 'l')}
        {leaf(mid, door.to, 'r')}
        <polyline points={pts([P(mid, 0, 0), P(mid, 0, doorZ)])} stroke={leafC.line} strokeWidth={1} />
        {[mid - 0.16, mid + 0.16].map((i, q) => {
          const [kx, ky] = P(i, 0, 42)
          return <circle key={q} cx={kx} cy={ky} r={2} fill={knob} />
        })}
      </>
    )
  })()
  add((door.from + door.to) / 2 - 0.45, 'door', (
    <g
      className="lib-passage"
      onClick={props.onPassageClick}
      style={{ cursor: props.onPassageClick ? 'pointer' : 'default' }}
    >
      <title>{props.passageTitle ?? 'the next room'}</title>
      <polygon points={pts([P(door.from - SEAM, 0, doorZ), P(door.to + SEAM, 0, doorZ), P(door.to + SEAM, 0, wallH), P(door.from - SEAM, 0, wallH)])} fill={`url(#${idp}-wallL)`} />
      <polygon points={pts([P(door.from - SEAM, 0, wallH - 4), P(door.to + SEAM, 0, wallH - 4), P(door.to + SEAM, 0, wallH), P(door.from - SEAM, 0, wallH)])} fill={w.cornice} />
      {/* the corridor behind it */}
      <polygon points={pts([P(door.from, 0, 0), P(door.to, 0, 0), P(door.to, 0, doorZ), P(door.from, 0, doorZ)])} fill={night ? '#080b12' : '#5d6474'} opacity={night ? 0.85 : 0.55} />
      {leaves}
      {/* posts and lintel */}
      <polygon points={pts([P(door.from - 0.22, 0, 0), P(door.from, 0, 0), P(door.from, 0, doorZ + 9), P(door.from - 0.22, 0, doorZ + 9)])} fill={frameC.frame} stroke={frameC.edge} strokeWidth={0.8} />
      <polygon points={pts([P(door.from - 0.22, 0, doorZ), P(door.to + 0.22, 0, doorZ), P(door.to + 0.22, 0, doorZ + 9), P(door.from - 0.22, 0, doorZ + 9)])} fill={frameC.frame} stroke={frameC.edge} strokeWidth={0.8} />
      {/* The lit edge the shelves and the boards wear, along the top of the lintel - the frame's
          own outer edge, which is where light would catch it. Not the top of the OPENING nine
          units below: a line there would run along the underside of the lintel, inside the
          frame, and read as a crack rather than as an edge.
          `bc-rim-door` because the frame is cut across two depth slots (this and the right
          post), and light stopping at a slot boundary would show the cut. The name banner
          hanging above is a sign on the wall, not part of the frame, so it wears no edge of its
          own - one doorway, one line. */}
      <polyline
        className="bc-rim bc-rim-door"
        points={pts([P(door.from - 0.22, 0, doorZ + 9), P(door.to + 0.22, 0, doorZ + 9)])}
        fill="none"
        stroke={night ? '#ffd9a8' : '#fff4e2'}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </g>
  ))
  /*
   * The name of the room the passage leads to, on a small banner above its lintel.
   *
   * A wing hangs its own name on the long wall; the doorway says where the door goes, which is
   * the question actually asked while standing in front of it. Smaller than the wall banner -
   * it names a destination, not the room you are in - and it follows the room order, so a
   * rename or a drag in the strip changes it with the next scene.
   */
  if (props.nextRoomName !== undefined && props.nextRoomName !== '') {
    /*
     * Centred in the wall between the lintel and the cornice, so a band of green shows above
     * AND below it. Hung against the door frame it read as part of the frame; the gap is what
     * makes it a sign on a wall.
     */
    const lintelTop = doorZ + 9
    const corniceZ = wallH - 4
    const sHeight = 24
    const gap = Math.max(6, (corniceZ - lintelTop - sHeight) / 2)
    const sBottom = lintelTop + gap
    const sTop = sBottom + sHeight
    const backFace = (a: number, b: number, z0: number, z1: number): string => pts([P(a, 0, z0), P(b, 0, z0), P(b, 0, z1), P(a, 0, z1)])
    const [sx, sy] = P((door.from + door.to) / 2, 0, (sTop + sBottom) / 2 - 5)
    add((door.from + door.to) / 2 - 0.44, 'passage-sign', (
      <g className="lib-passage-sign" onClick={props.onPassageClick} style={{ cursor: props.onPassageClick ? 'pointer' : 'default' }}>
        <title>{props.passageTitle ?? 'the next room'}</title>
        <polygon points={backFace(door.from + 0.08, door.to + 0.08, sBottom - 4, sBottom)} fill={night ? '#0b1610' : '#22382e'} opacity={0.35} />
        <polygon points={backFace(door.from, door.to, sBottom, sTop)} fill={night ? '#1f3329' : '#37564a'} stroke={night ? '#132119' : '#283f36'} strokeWidth={0.8} />
        <polygon points={backFace(door.from - 0.12, door.to + 0.12, sTop - 5, sTop)} fill={frameC.frame} stroke={frameC.edge} strokeWidth={0.7} />
        <text
          transform={`matrix(1 0.5 0 1 ${sx.toFixed(1)} ${sy.toFixed(1)})`}
          textAnchor="middle"
          fontFamily={FONT}
          fontSize={15}
          fontWeight={600}
          letterSpacing="0.03em"
          fill={night ? '#c9d6c8' : '#f2ede0'}
        >
          {props.nextRoomName}
        </text>
      </g>
    ))
  }

  /*
   * The right post sorts after the wall tile beside it, which would otherwise paint over it -
   * and therefore after the lintel too, over whose rim it lays its own width (measured: the
   * last tenth of the edge came back unlit). So it carries that stretch of the edge itself,
   * and takes the doorway's click while it is at it: it is the door frame, it lights like the
   * door frame, and a lit frame that answered no click would be the light telling a lie.
   */
  add(door.to + 0.6, 'doorpost-r', (
    <g
      className="lib-passage-post"
      onClick={props.onPassageClick}
      style={{ cursor: props.onPassageClick ? 'pointer' : 'default' }}
    >
      <title>{props.passageTitle ?? 'the next room'}</title>
      <polygon
        points={pts([P(door.to, 0, 0), P(door.to + 0.22, 0, 0), P(door.to + 0.22, 0, WALL_H * 0.62 + 9), P(door.to, 0, WALL_H * 0.62 + 9)])}
        fill={night ? '#5b4630' : '#8a6a43'}
        stroke={night ? '#3d2f1f' : '#6f5335'}
        strokeWidth={0.8}
      />
      <polyline
        className="bc-rim bc-rim-door"
        points={pts([P(door.to, 0, WALL_H * 0.62 + 9), P(door.to + 0.22, 0, WALL_H * 0.62 + 9)])}
        fill="none"
        stroke={night ? '#ffd9a8' : '#fff4e2'}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </g>
  ))

  for (let kk = 0; kk < ROOM.NJ; kk++) {
    const wideJ = kk + 1 + (kk + 1 >= ROOM.NJ ? 0 : SEAM)
    add(kk + 0.5 - 0.45, `wr${kk}`, (
      <g>
        <polygon points={pts([P(0, kk, 0), P(0, wideJ, 0), P(0, wideJ, wallH), P(0, kk, wallH)])} fill={`url(#${idp}-wallR)`} />
        <polygon points={pts([P(0, kk, 0), P(0, wideJ, 0), P(0, wideJ, 6), P(0, kk, 6)])} fill={w.base} />
        <polygon points={pts([P(0, kk, wallH - 4), P(0, wideJ, wallH - 4), P(0, wideJ, wallH), P(0, kk, wallH)])} fill={w.cornice} />
      </g>
    ))
  }

  /**
   * Where a bookcase sorts in painter's order. Its FRONT edge in j, but its MIDDLE in i: a
   * figure standing at the case (1.55 tiles in front of it, centred on its width) otherwise
   * came out behind it, because the case claimed its full width - 2.8 tiles - against a
   * figure that stands at the middle of that width. The case still sorts in front of
   * everything actually behind it, since nothing stands between a case and the wall.
   */
  const caseDepth = (i: number, j: number): number => i + CASE_W / 2 + j + CASE_D
  const shelfAt = (slot: number): SceneShelf | null => room.shelves.find((s) => s.slot === slot) ?? null
  const placeCase = (i: number, j: number, slot: number, spareLabel: string): void => {
    const shelf = shelfAt(slot)
    const dragging = props.draggingDomain !== null && props.draggingDomain !== undefined && shelf?.domain === props.draggingDomain
    const isDrop = props.dropSlot === slot
    add(caseDepth(i, j), `case${slot}`, (
      <g
        className={`lib-slot${shelf ? ' filled' : ' free'}${isDrop ? ' drop' : ''}`}
        data-slot={slot}
        onClick={shelf ? (props.onShelfClick ? () => props.onShelfClick!(shelf.domain) : undefined) : props.onEmptySlotClick ? () => props.onEmptySlotClick!(slot) : undefined}
        onPointerDown={shelf && props.onShelfPointerDown ? (e) => props.onShelfPointerDown!(shelf.domain, e) : undefined}
        onPointerEnter={props.onSlotPointerEnter ? () => props.onSlotPointerEnter!(slot) : undefined}
        /* The shelf under the pointer must not be the one being dragged, or every drop lands on itself. */
        style={{ cursor: shelf ? 'grab' : props.onEmptySlotClick ? 'pointer' : 'default', opacity: dragging ? 0.35 : 1, pointerEvents: dragging ? 'none' : undefined }}
      >
        <title>{shelf ? `${signText(shelf.domain)}: ${shelf.books} books, ${shelf.volumes} sources${shelf.stubs > 0 ? `, ${shelf.stubs} stubs` : ''}. Click to open the department, drag to move.` : `Free slot ${slot + 1}. Click to start a department here.`}</title>
        {isDrop && <polygon points={pts([P(i - 0.15, j - 0.15), P(i + CASE_W + 0.15, j - 0.15), P(i + CASE_W + 0.15, j + CASE_D + 0.15), P(i - 0.15, j + CASE_D + 0.15)])} fill={TOK.accentSoft} stroke={TOK.accent} strokeWidth={1.5} strokeDasharray="5 4" />}
        {shelf ? <Bookcase P={P} i0={i} j0={j} shelf={shelf} night={night} /> : <Bookcase P={P} i0={i} j0={j} shelf={null} night={night} spare={spareLabel} />}
      </g>
    ))
  }

  /**
   * The gap in a row, drawn as a patch of floor you can take hold of (2026-09-14). A row has
   * seven positions and six cases; the one without a case is the way through, and moving it is
   * what lets a wing be three and three, one and five, or six in a row with the passage at an
   * end. It is only a target while one is being dragged - the rest of the time it is floor,
   * and floor with a handle on it would read as a thing.
   */
  const placeAisle = (row: 'wall' | 'mid', at: number, j: number): void => {
    if (room.kind !== 'wing') return
    const i = SLOTS[at]!
    const held = props.draggingAisle ?? null
    const isSource = held !== null && held.row === row && held.at === at
    add(caseDepth(i, j) - 0.01, `aisle-${row}`, (
      <g
        className={`lib-aisle${isSource ? ' held' : ''}`}
        data-aisle={row}
        data-aisle-at={at}
        onPointerDown={props.onAislePointerDown ? (e) => props.onAislePointerDown!(row, at, e) : undefined}
        style={{ cursor: props.onAislePointerDown ? 'grab' : 'default', opacity: isSource ? 0.4 : 1 }}
      >
        <title>{row === 'wall' ? 'The doorway. Drag it along the wall to rearrange the shelves.' : 'The aisle. Drag it along the row to rearrange the shelves.'}</title>
        {/* The floor of the gap: hatched so it reads as something, and the depth of a case
            so the doorway and the aisle are the same size as what stands beside them. */}
        <polygon points={pts([P(i, j), P(i + CASE_W, j), P(i + CASE_W, j + CASE_D), P(i, j + CASE_D)])} fill={`url(#${idp}-aisle)`} />
        <polygon
          points={pts([P(i, j), P(i + CASE_W, j), P(i + CASE_W, j + CASE_D), P(i, j + CASE_D)])}
          fill={held !== null && held.row === row ? TOK.accentSoft : 'transparent'}
          stroke={held !== null && held.row === row ? TOK.accent : TOK.borderStrong}
          strokeWidth={held !== null && held.row === row ? 1.4 : 0.8}
          strokeDasharray="4 4"
        />
      </g>
    ))
  }

  const sc = SHELF[mode]
  const wood = { top: sc.top, left: sc.left, right: sc.right }
  // The cart is a lighter oak than the walnut of the cases, so it reads as its own thing.
  const cartC = night ? { top: '#6b5238', left: '#54402b', right: '#453420' } : { top: '#c49a6a', left: '#a67d52', right: '#8c6742' }
  const metal = night ? '#2a2f3a' : '#4d5566'
  const keysC = night ? { top: '#5b6474', left: '#3f4757', right: '#333a48', keys: '#4d5566' } : { top: '#d5dbe6', left: '#a9b3c4', right: '#8f9aae', keys: '#bfc7d4' }
  const screenC = night
    ? { bezel: { top: '#2a3040', left: '#1a2030', right: '#12161f' }, glass: '#9dc0ff', off: '#222a3a', foot: { top: '#3a4050', left: '#2a3040', right: '#20252f' } }
    : { bezel: { top: '#3a4254', left: '#2a3040', right: '#1a2333' }, glass: '#dfe8fb', off: '#3c4658', foot: { top: '#4d5566', left: '#3a4254', right: '#2a3040' } }

  if (room.kind === 'main') {
    /*
     * The rug under the desk section (2026-09-17): the ten desks stand on a floor of their
     * own, which is what makes them a section rather than furniture scattered over the
     * parquet. Drawn first, on the floor; every item paints over it.
     */
    {
      // Half a desk width further back than the desks' own centre, towards the passage: the
      // figures in front of the front row need floor, and a rug centred on the desks alone
      // read as slid towards the viewer.
      const ri0 = RUG_LEFT
      const ri1 = DESK.I0 + 4 * DESK.PITCH + DESK.W + 0.6
      const rj0 = DESK.ROWS[0] - 1.2
      const rj1 = DESK.ROWS[1] + DESK.D + 0.8
      const inset = (d: number): string => diamond(ri0 + d, rj0 + d, ri1 - d, rj1 - d)
      add(-1000, 'rug', (
        <g>
          <polygon points={inset(0)} fill={rug.border} />
          <polygon points={inset(0.2)} fill="none" stroke={rug.line} strokeWidth={1} opacity={0.9} />
          <polygon points={inset(0.36)} fill={`url(#${idp}-rug)`} />
        </g>
      ))
    }
    FAV_I.forEach((fi, n) => placeCase(fi, WALL_J, n, 'favorite'))
    // Two boards on the short wall: the hot cache and last night's report, each under a title
    // band. Clicking one opens it as a window over the room (docs/agents/SPEC.md section 10).
    const board = (j0: number, j1: number, title: string, id: BoardId): React.ReactNode => {
      // Centred on the wall: board plus title band is 70 high, so 40 of wall is left above
      // and below it. It crosses the wainscot rail, the way a framed picture would.
      const zBase = 40
      const bandTop = 110
      const face = (z0: number, z1: number, a: number, b: number): string => pts([P(0, a, z0), P(0, b, z0), P(0, b, z1), P(0, a, z1)])
      const jm = (j0 + j1) / 2
      // The wall runs towards smaller j as the screen goes right, so a title starts at j1.
      const titleAt = (z: number, fill: string, size: number, anchor: 'start' | 'middle'): React.ReactNode => {
        const [x, y] = anchor === 'start' ? P(0, j1 - 0.14, z) : P(0, jm, z)
        return (
          <text transform={`matrix(1 -0.5 0 1 ${x.toFixed(1)} ${y.toFixed(1)})`} textAnchor={anchor} fontFamily={FONT} fontSize={size} fontWeight={600} letterSpacing="0.02em" fill={fill}>
            {title}
          </text>
        )
      }
      /* The same light a shelf wears under the pointer, and for the same reason: a board opens
         a window over the room and said so with a pointer shape alone. It runs round the whole
         frame rather than along the top edge alone (2026-09-17): a board is flat against the
         wall, so it has no lit edge to speak of, and a frame that lights up all round reads as
         the thing you are about to open. */
      const rim = (
        <polygon className="bc-rim" points={face(zBase - 6, bandTop, j0 - 0.14, j1 + 0.14)} fill="none" stroke={night ? '#ffd9a8' : '#fff4e2'} strokeWidth={1.6} strokeLinejoin="round" />
      )
      /*
       * A chalkboard (2026-09-17): a dark green face in the frame's wood, the title in chalk
       * with a rule under it, four chalk lines for the text. Chosen over a cork board with
       * pinned notes and a brass-framed plaque; it is the same green as the banner over the
       * door, so the wall reads as one. The bottom bar is as wide as the sides and carries
       * the chalk tray as a lighter ledge: drawn dark it vanished against the wainscot and
       * left the board looking open below.
       */
      const ink = night ? '#c9c4b4' : '#e9e4d2'
      const body = (
        <>
          <polygon points={face(zBase - 6, bandTop, j0 - 0.14, j1 + 0.14)} fill={frameC.frame} stroke={frameC.edge} strokeWidth={1} />
          <polygon points={face(zBase, bandTop - 5, j0, j1)} fill={night ? '#1c2a23' : '#2d463a'} />
          {titleAt(bandTop - 19, ink, 11, 'start')}
          <polygon points={face(bandTop - 25, bandTop - 24, j0 + 0.14, j1 - 0.14)} fill={ink} opacity={0.5} />
          {[0, 1, 2, 3].map((q) => {
            const z = bandTop - 34 - q * 9
            return <polygon key={q} points={face(z, z + 3.2, j0 + 0.28, j1 - 0.28 - (q % 2) * 0.42)} fill={ink} opacity={0.45} />
          })}
          <polygon points={face(zBase - 6, zBase - 3.5, j0 - 0.14, j1 + 0.14)} fill={mix(frameC.frame, '#ffffff', 0.2)} />
          {rim}
        </>
      )
      return (
        <g
          key={id}
          className="lib-board"
          data-board={id}
          onClick={props.onBoardClick ? () => props.onBoardClick!(id) : undefined}
          style={{ cursor: props.onBoardClick ? 'pointer' : 'default' }}
        >
          <title>{title}</title>
          {body}
        </g>
      )
    }
    // Three boards across the short wall, with the same run of wall between and beside them:
    // 3 x 2.5 wide leaves 3.5 of the 11, split four ways.
    const bw = 2.5
    const gap = (ROOM.NJ - 3 * bw) / 4
    const at = (n: number): [number, number] => [gap + n * (bw + gap), gap + n * (bw + gap) + bw]
    add(at(0)[1] + 0.001, 'board-hot', board(at(0)[0], at(0)[1], 'Hot cache', 'hot'))
    add(at(1)[1] + 0.001, 'board-recap', board(at(1)[0], at(1)[1], 'Last night', 'recap'))
    add(at(2)[1] + 0.001, 'board-reading', board(at(2)[0], at(2)[1], 'Reading list', 'reading'))
    // Which desks are at work: the screen is on there and, at night, the lamp is lit (scene.ts).
    const busy = busyDesks(actors, room.id)
    /*
     * The ten desks, two rows of five (room.ts DESK): a top on four legs with an apron under
     * it, not a block. No chairs: a Fellow stands at its desk. The monitor stands on the back
     * edge with its screen to the front, where the figure is, and the lamp on the back corner
     * beside it - so nothing on the desk stands between the figure and what it looks at, and
     * the screen shows beside its head rather than behind it.
     *
     * A desk is a door into the night shift (2026-09-17). Under the pointer its top lights
     * round its edge like a shelf, every bubble in the room steps aside so no text collides,
     * and a label over the desk says whose it is: the Fellow's shelf, a guest's name, or "Spawn
     * a new Fellow" over an empty one. The click opens the night shift on that shelf, or on
     * the night itself for a desk without a Fellow. The label lives in the desk's own group,
     * which is safe because it hangs well above everything that paints after the desk.
     */
    const topZ = 22
    const topT = 2.6
    const legW = 0.09
    const apron = { top: wood.left, left: mix(wood.left, '#000000', 0.18), right: mix(wood.right, '#000000', 0.18) }
    deskPositions().forEach((t, n) => {
      const di = t.i
      const dj = t.j
      const d = di + DESK.W + dj + DESK.D
      const on = busy.has(n)
      const lit = night && on
      const [lx, ly] = P(di + DESK.W - 0.24, dj + 0.22, topZ)
      const mi = di + 0.34
      const mw = 0.55
      const mj = dj + 0.14
      const leg = (i: number, j: number, key: string): React.ReactNode => <Box key={key} P={P} i0={i} j0={j} a={legW} b={legW} h={topZ - topT} c={wood} />
      const occupant = actors.find((x) => x.room === room.id && x.desk === n && x.exiting !== true) ?? null
      const label = occupant === null ? 'Spawn a new Fellow' : occupant.role === 'fellow' && occupant.domain !== undefined ? signText(occupant.domain) : occupant.name
      const hint =
        occupant === null
          ? 'A free desk. Click to open the night shift and spawn a Fellow.'
          : occupant.role === 'fellow' && occupant.domain !== undefined
            ? `${occupant.name}'s desk, ${signText(occupant.domain)}. Click to open the shelf in the night shift.`
            : `${occupant.name} is working here. Click to open the night shift.`
      const [lbx, lby] = P(di + DESK.W / 2, dj + DESK.D / 2, topZ + 52)
      add(d, `desk${n}`, (
        <g className="lib-desk" data-desk={n} onClick={props.onDeskClick ? () => props.onDeskClick!(n, occupant) : undefined} style={{ cursor: props.onDeskClick ? 'pointer' : 'default' }}>
          <title>{hint}</title>
          {leg(di + 0.04, dj + 0.04, 'l0')}
          {leg(di + DESK.W - legW - 0.04, dj + 0.04, 'l1')}
          {leg(di + 0.04, dj + DESK.D - legW - 0.04, 'l2')}
          {leg(di + DESK.W - legW - 0.04, dj + DESK.D - legW - 0.04, 'l3')}
          <Box P={P} i0={di + 0.1} j0={dj + 0.1} a={DESK.W - 0.2} b={DESK.D - 0.2} h={3.5} z0={topZ - topT - 3.5} c={apron} />
          <Box P={P} i0={di} j0={dj} a={DESK.W} b={DESK.D} h={topT} z0={topZ - topT} c={wood} />
          {/* the monitor: foot, neck, bezel, and the glass inset on the front face - lit only at a busy desk */}
          <Box P={P} i0={mi + 0.17} j0={mj} a={0.22} b={0.14} h={1.5} z0={topZ} c={screenC.foot} />
          <Box P={P} i0={mi + 0.25} j0={mj + 0.04} a={0.06} b={0.06} h={4} z0={topZ + 1.5} c={screenC.foot} />
          <Box P={P} i0={mi} j0={mj} a={mw} b={0.05} h={13} z0={topZ + 5.5} c={screenC.bezel} />
          <polygon points={pts([P(mi + 0.04, mj + 0.05, topZ + 6.8), P(mi + mw - 0.04, mj + 0.05, topZ + 6.8), P(mi + mw - 0.04, mj + 0.05, topZ + 17.3), P(mi + 0.04, mj + 0.05, topZ + 17.3)])} fill={on ? screenC.glass : screenC.off} />
          {/* the keyboard, in front of the screen where the figure's hands are */}
          <Box P={P} i0={mi + 0.06} j0={dj + 0.4} a={0.44} b={0.17} h={1.3} z0={topZ} c={keysC} />
          <polygon points={pts([P(mi + 0.09, dj + 0.43, topZ + 1.3), P(mi + 0.47, dj + 0.43, topZ + 1.3), P(mi + 0.47, dj + 0.54, topZ + 1.3), P(mi + 0.09, dj + 0.54, topZ + 1.3)])} fill={keysC.keys} />
          {/* A desk lamp on every desk: an arm, a shade, and light on the desktop when it is lit. */}
          <g className={`lib-lamp${lit ? ' lit' : ''}`}>
            {lit && <ellipse cx={lx} cy={ly + 2} rx={52} ry={26} fill={`url(#${idp}-glow)`} />}
            <ellipse cx={lx} cy={ly} rx={5} ry={2.5} fill={night ? '#4a3a26' : '#8a95ad'} />
            <path d={`M${lx} ${ly - 1} l3 -13`} stroke={night ? '#6b5735' : '#8a95ad'} strokeWidth={1.6} fill="none" strokeLinecap="round" />
            <path d={`M${lx - 2} ${ly - 14} h11 l-3 -7 h-6 z`} fill={lit ? '#e2b45c' : night ? '#6b5a3a' : '#b8c0d0'} stroke={night ? '#8a6a43' : '#98a2b5'} strokeWidth={0.8} />
            {lit && <ellipse cx={lx + 3.5} cy={ly - 13.5} rx={5} ry={1.6} fill="#f6d27a" />}
          </g>
          <polygon
            className="bc-rim"
            points={pts([P(di, dj, topZ), P(di + DESK.W, dj, topZ), P(di + DESK.W, dj + DESK.D, topZ), P(di, dj + DESK.D, topZ)])}
            fill="none"
            stroke={night ? '#ffd9a8' : '#fff4e2'}
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
          <g className="lib-desk-label">
            <text className="lib-tag-name" x={lbx.toFixed(1)} y={lby.toFixed(1)} textAnchor="middle" fontFamily={FONT} fontSize={10.5} fontWeight={600} fill="#ffffff">
              {label}
            </text>
          </g>
        </g>
      ))
    })
    /*
     * The book cart (2026-09-17), in the open floor left of the desks, centred between the
     * short wall and the first desk and in line with the middle of the two rows: three tiers
     * of books on casters, with a push rail at its right end. It is the station of everything
     * that is not a Fellow's own work - the maintenance runs stand at it, the ingest queue's
     * parcels lie beside it - and clicking it opens System, where those runs are started. It
     * wears the same lit edge a shelf does under the pointer, and for the same reason: it
     * leads somewhere.
     */
    {
      const ci = ANCHORS.cart.i
      const cj = ANCHORS.cart.j
      const a = CART_W
      const b = CART_D
      const tiers = [6, 22, 38]
      const shelfH = 3
      const postH = tiers[2]! + shelfH - tiers[0]!
      const railZ = tiers[2]! + shelfH
      const post = (i: number, j: number, key: string): React.ReactNode => <Box key={key} P={P} i0={i} j0={j} a={0.08} b={0.08} h={postH} z0={tiers[0]!} c={cartC} />
      const rnd = seeded(4242)
      /* Each tier paints its plank and then its own books, so a plank covers the tops of the
         books below it the way it does in the room, and the top tier's books stand clear. */
      const tier = (z: number, k: number): React.ReactNode => {
        const books: React.ReactNode[] = []
        let t = 0.12
        const end = a - (k === 1 ? 0.55 : k === 2 ? 0.34 : 0.18)
        while (t < end) {
          const ds = 0.08 + rnd() * 0.08
          if (t + ds > end) break
          const hb = 10.5 + rnd() * 3.5
          // Muted, and mostly the warm tones of the room: a cart of new books is not a toy.
          const hue = [24, 32, 40, 205, 150, 350][Math.floor(rnd() * 6)]!
          const sat = 30 + rnd() * 12
          books.push(<Box key={`b${t.toFixed(2)}`} P={P} i0={ci + t} j0={cj + 0.12} a={ds} b={0.42} h={hb} z0={z + shelfH} c={{ top: hsl(hue, sat, night ? 30 : 56), left: hsl(hue, sat, night ? 26 : 48), right: hsl(hue, sat, night ? 20 : 40) }} />)
          t += ds + 0.02
        }
        return (
          <g key={`t${k}`}>
            <Box P={P} i0={ci} j0={cj} a={a} b={b} h={shelfH} z0={z} c={cartC} />
            {books}
          </g>
        )
      }
      const caster = (i: number, j: number, key: string): React.ReactNode => {
        const [x, y] = P(i, j, 0)
        return (
          <g key={key}>
            <path d={`M${x} ${y - 1} v-${tiers[0]! + 1}`} stroke={metal} strokeWidth={1.4} />
            <ellipse cx={x} cy={y} rx={3} ry={1.9} fill={night ? '#0a0d16' : '#2b3040'} />
          </g>
        )
      }
      const rail = pts([P(ci + a - 0.03, cj + 0.08, railZ), P(ci + a - 0.03, cj + 0.08, railZ + 15), P(ci + a - 0.03, cj + b - 0.08, railZ + 15), P(ci + a - 0.03, cj + b - 0.08, railZ)])
      add(ci + a / 2 + cj + b, 'cart', (
        <g className="lib-cart" onClick={props.onCartClick} style={{ cursor: props.onCartClick ? 'pointer' : 'default' }}>
          <title>The book cart: where the maintenance runs work. Click to open System.</title>
          {caster(ci + 0.16, cj + b - 0.08, 'w0')}
          {caster(ci + a - 0.16, cj + b - 0.08, 'w1')}
          {caster(ci + a - 0.1, cj + 0.14, 'w2')}
          {post(ci, cj, 'p0')}
          {post(ci + a - 0.08, cj, 'p1')}
          {tiers.map(tier)}
          {post(ci, cj + b - 0.08, 'p2')}
          {post(ci + a - 0.08, cj + b - 0.08, 'p3')}
          <polyline points={rail} fill="none" stroke={metal} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
          <polyline
            className="bc-rim"
            points={pts([P(ci, cj + b, railZ), P(ci + a, cj + b, railZ), P(ci + a, cj, railZ)])}
            fill="none"
            stroke={night ? '#ffd9a8' : '#fff4e2'}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </g>
      ))
    }
    /*
     * The easel with the pinboard (prototype 2026-09-17), in front of the cart with its face to
     * the desks: two front legs in the board's plane, one leaning behind, and the board itself
     * with as many pinned cards as there are open questions, six at most. It opens the pinboard
     * window like a board on the wall, and lights its frame under the pointer like one.
     */
    {
      const ei = ANCHORS.easel.i
      const ej = ANCHORS.easel.j
      const legC = night ? { top: '#5b4630', left: '#4a3826', right: '#3d2f1f' } : { top: '#a67d52', left: '#8a6a43', right: '#6f5335' }
      const boardZ = 26
      const boardH = 46
      const cork = night ? '#5a4630' : '#c9a06e'
      const facePts = (j0: number, j1: number, z0: number, z1: number): string => pts([P(ei, j0, z0), P(ei, j1, z0), P(ei, j1, z1), P(ei, j0, z1)])
      const cards = Math.max(0, Math.min(6, props.openQuestions ?? 4))
      const [bx, by] = P(ei - 0.55, ej + EASEL_W / 2, 0)
      const [tx, ty] = P(ei - 0.12, ej + EASEL_W / 2, boardZ + boardH + 8)
      add(ei + ej + EASEL_W + 0.2, 'easel', (
        <g className="lib-easel" onClick={props.onBoardClick ? () => props.onBoardClick!('questions') : undefined} style={{ cursor: props.onBoardClick ? 'pointer' : 'default' }}>
          <title>{`Open questions: ${props.openQuestions ?? 'the vault\'s'} open. Click to open the pinboard.`}</title>
          {/* the rear leg, leaning up to the top of the board */}
          <path d={`M${bx.toFixed(1)} ${by.toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)}`} stroke={legC.right} strokeWidth={2.2} strokeLinecap="round" />
          <Box P={P} i0={ei - 0.06} j0={ej + 0.02} a={0.06} b={0.06} h={boardZ + boardH + 8} c={legC} />
          <Box P={P} i0={ei - 0.06} j0={ej + EASEL_W - 0.08} a={0.06} b={0.06} h={boardZ + boardH + 8} c={legC} />
          {/* the ledge the board rests on, and the board: a frame with the cork let in */}
          <Box P={P} i0={ei - 0.06} j0={ej} a={0.16} b={EASEL_W} h={2.5} z0={boardZ - 2.5} c={legC} />
          <Box P={P} i0={ei - 0.05} j0={ej + 0.04} a={0.05} b={EASEL_W - 0.08} h={boardH} z0={boardZ} c={legC} />
          <polygon points={facePts(ej + 0.1, ej + EASEL_W - 0.14, boardZ + 3, boardZ + boardH - 3)} fill={cork} />
          {[0, 1, 2, 3, 4, 5].slice(0, cards).map((n) => {
            const col = n % 3
            const rowN = Math.floor(n / 3)
            const j0 = ej + 0.16 + col * 0.36
            const z1 = boardZ + boardH - 8 - rowN * 19
            const [px, py] = P(ei, j0 + 0.14, z1 - 1.5)
            return (
              <g key={n}>
                <polygon points={facePts(j0, j0 + 0.28, z1 - 13, z1)} fill={night ? '#cfc9bb' : '#faf6ec'} stroke={night ? '#8a8477' : '#d9d2c2'} strokeWidth={0.5} />
                <polygon points={facePts(j0 + 0.04, j0 + 0.22, z1 - 5.5, z1 - 4)} fill={night ? '#8a8477' : '#c9c1ae'} />
                <polygon points={facePts(j0 + 0.04, j0 + 0.19, z1 - 9, z1 - 7.5)} fill={night ? '#8a8477' : '#c9c1ae'} />
                <circle cx={px} cy={py} r={1.4} fill={['#d6453c', '#2f62c9', '#3f8f4f', '#d6a13c', '#8a4fc9', '#d6453c'][n]!} />
              </g>
            )
          })}
          <polygon className="bc-rim" points={facePts(ej + 0.04, ej + EASEL_W - 0.08, boardZ, boardZ + boardH)} fill="none" stroke={night ? '#ffd9a8' : '#fff4e2'} strokeWidth={1.6} strokeLinejoin="round" />
        </g>
      ))
    }
    /*
     * A large potted plant (2026-09-17) where the cart used to stand, against the long wall
     * to the right of the last favorite shelf and centred in that gap: the corner wanted
     * something green. A fern, low and bushy, chosen over a small tree, a rubber tree, a
     * monstera and a palm, which all rose past the shelf beside them and competed with it.
     */
    {
      const pi = ANCHORS.plant.i
      const pj = ANCHORS.plant.j
      const pw = 0.64
      const potH = 20
      const pot = night ? { top: '#5a3a26', left: '#4a2f1e', right: '#3d2618' } : { top: '#c98a5e', left: '#a8683f', right: '#8e5634' }
      const [cx, cy] = P(pi + pw / 2, pj + pw / 2, potH)
      const g = night
        ? { a: '#2f4a33', b: '#284029', c: '#365a3a', d: '#22371f', edge: '#1a2a1c', stem: '#3d2a18', rib: '#4a6e4d' }
        : { a: '#4f8047', b: '#3f6d3a', c: '#5f9451', d: '#39623a', edge: '#2e4a30', stem: '#5a3d24', rib: '#8fbf84' }
      const greens = [g.a, g.b, g.c, g.d]
      const at = (dx: number, dy: number, rot: number, scale: number): string => `translate(${(cx + dx).toFixed(1)} ${(cy + dy).toFixed(1)}) rotate(${rot}) scale(${scale})`
      // Many short fronds fanning out of the pot, the outer ones drooping.
      const frond = 'M0 0 C6 -12 18 -20 36 -14 C22 -14 10 -7 0 0 Z'
      const fronds: ReadonlyArray<readonly [number, number, number]> = [
        [-175, 0.9, 0], [-160, 1.0, 2], [-140, 0.95, 1], [-120, 1.05, 0], [-100, 1.0, 2], [-80, 1.05, 1], [-60, 1.0, 0], [-40, 0.95, 2], [-20, 1.0, 1], [-5, 0.9, 0], [10, 0.8, 3], [-190, 0.8, 3],
      ]
      const foliage = fronds.map(([rot, sc, ci], q) => (
        <path key={q} d={frond} fill={greens[ci]!} stroke={g.edge} strokeWidth={0.6 / sc} transform={at(0, -4, rot, sc)} />
      ))
      add(pi + pw / 2 + pj + pw, 'plant', (
        <g>
          <Box P={P} i0={pi} j0={pj} a={pw} b={pw} h={potH} c={pot} />
          <polygon points={pts([P(pi + 0.08, pj + 0.08, potH), P(pi + pw - 0.08, pj + 0.08, potH), P(pi + pw - 0.08, pj + pw - 0.08, potH), P(pi + 0.08, pj + pw - 0.08, potH)])} fill={night ? '#1e160f' : '#3a2a1c'} />
          {foliage}
        </g>
      ))
    }
  } else {
    wingSlotPositions(aisles).forEach((p, idx) => placeCase(p.i, p.j, idx, 'free'))
    /*
     * The two gaps, and - while one is in hand - every position of its row as a target, drawn
     * over the cases that stand there. Dropping on an occupied position is the ordinary case:
     * six shelves move over by one and the gap takes the place.
     */
    placeAisle('wall', aisles.wall, WALL_J)
    placeAisle('mid', aisles.mid, MID_J)
    const held = props.draggingAisle ?? null
    if (held !== null) {
      const j = held.row === 'wall' ? WALL_J : MID_J
      for (const at of [0, 1, 2, 3, 4, 5, 6]) {
        if (at === held.at) continue
        const i = SLOTS[at]!
        add(caseDepth(i, j) + 0.02, `aisle-target-${at}`, (
          <g className="lib-aisle-target" data-aisle-target={at} style={{ cursor: 'grabbing' }}>
            <polygon
              points={pts([P(i - 0.1, j - 0.1), P(i + CASE_W + 0.1, j - 0.1), P(i + CASE_W + 0.1, j + CASE_D + 0.1), P(i - 0.1, j + CASE_D + 0.1)])}
              fill={TOK.accentSoft}
              opacity={0.35}
              stroke={TOK.accent}
              strokeWidth={1.2}
              strokeDasharray="5 4"
            />
          </g>
        ))
      }
    }
    // The wing's name on a banner, on the wall the main room hangs its boards on.
    const bj0 = 1.6
    const bj1 = 9.4
    const face = (z0: number, z1: number, a: number, b: number): string => pts([P(0, a, z0), P(0, b, z0), P(0, b, z1), P(0, a, z1)])
    const bBottom = 90
    const bTop = 136
    const [nx, ny] = P(0, (bj0 + bj1) / 2, (bTop + bBottom) / 2 - 9)
    const li = 0.7
    const lj = 10.25
    const [lx, ly] = P(li, lj, 0)
    add(li + lj + 0.2, 'wing-lamp', (
      <g className={`lib-lamp${night ? ' lit' : ''}`}>
        {night && <ellipse cx={lx} cy={ly - 30} rx={96} ry={64} fill={`url(#${idp}-glow)`} />}
        <ellipse cx={lx} cy={ly} rx={9} ry={4.5} fill={night ? '#3d2f1f' : '#8a95ad'} />
        <rect x={lx - 1.4} y={ly - 76} width={2.8} height={74} fill={night ? '#6b5735' : '#98a2b5'} />
        <path d={`M${lx - 13} ${ly - 76} h26 l-6 -17 h-14 z`} fill={night ? '#e2b45c' : '#b8c0d0'} stroke={night ? '#8a6a43' : '#98a2b5'} strokeWidth={1} />
        {night && <ellipse cx={lx} cy={ly - 76} rx={12.5} ry={3.2} fill="#f6d27a" />}
      </g>
    ))
    add(bj1 + 0.001, 'wing-banner', (
      <g
        className="lib-banner"
        onClick={props.onBannerClick}
        style={{ cursor: props.onBannerClick ? 'pointer' : 'default' }}
      >
        <title>{`${room.name} - click to rename`}</title>
        <polygon points={face(bBottom - 5, bBottom, bj0 + 0.08, bj1 + 0.08)} fill={night ? '#0b1610' : '#22382e'} opacity={0.4} />
        <polygon points={face(bBottom, bTop, bj0, bj1)} fill={night ? '#1f3329' : '#37564a'} stroke={night ? '#132119' : '#283f36'} strokeWidth={1} />
        <polygon points={face(bTop - 7, bTop, bj0 - 0.16, bj1 + 0.16)} fill={frameC.frame} stroke={frameC.edge} strokeWidth={0.8} />
        <polygon points={face(bBottom, bBottom + 5, bj0, bj1)} fill={night ? '#152219' : '#2b4438'} />
        <text
          transform={`matrix(1 -0.5 0 1 ${nx.toFixed(1)} ${ny.toFixed(1)})`}
          textAnchor="middle"
          fontFamily={FONT}
          fontSize={26}
          fontWeight={600}
          letterSpacing="0.04em"
          fill={night ? '#c9d6c8' : '#f2ede0'}
        >
          {room.name}
        </text>
      </g>
    ))
  }

  // Figures: each in a translated group with a transition; tags ride in the top layer.
  for (const a of actors) {
    if (a.room !== room.id) continue
    const [x, y] = P(a.i, a.j, 0)
    const selected = props.selectedAgentId !== undefined && props.selectedAgentId !== null && a.agentId === props.selectedAgentId
    add(depthOf(a.i, a.j) + 0.55, `actor-${a.id}`, (
      <g className={`lib-figure${a.exiting ? ' exiting' : ''}${selected ? ' selected' : ''}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} onClick={props.onActorClick ? (e) => props.onActorClick!(a, e) : undefined} style={{ cursor: a.agentId ? 'pointer' : 'default' }}>
        <title>{a.caption}</title>
        <Figure a={a} night={night} />
      </g>
    ))
    if (a.name !== 'parcel') {
      const ty = -50
      top.push(
        /* `clickable` only where the click leads somewhere: the bubble is drawn for visitors
           too, and one that lit up and then did nothing would be a promise the room cannot
           keep. It is the same condition the cursor already reads. */
        <g
          key={`tag-${a.id}`}
          className={`lib-figure${a.exiting ? ' exiting' : ''}${a.agentId ? ' clickable' : ''}`}
          transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
          onClick={props.onActorClick ? (e) => props.onActorClick!(a, e) : undefined}
          style={{ cursor: a.agentId ? 'pointer' : 'default' }}
        >
          <title>{a.caption}</title>
          {/* The body as a hit area, here in the bubble's own group (2026-09-17): the figure is
              drawn in the room's layer and the bubble over everything, so no CSS could reach
              from a hovered body to its bubble. A transparent rect over head and torso, in the
              group that carries the bubble, makes the pointer on the body the pointer on the
              bubble - the outline lights, and the click is the same click. Fellows only: a
              visitor's bubble opens nothing and lights nothing. */}
          {a.agentId !== undefined && <rect className="lib-torso-hit" x={-8} y={-43} width={16} height={32} fill="transparent" />}
          <Tag text={a.caption} kind={a.tag} night={night} y={ty} dot={a.dot} />
        </g>,
      )
    }
  }
  items.sort((p, q) => p.d - q.d)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" className={`lib-svg${night ? ' night' : ''}`} style={{ display: 'block' }}>
      <defs>
        {/*
         * The hatch a gap wears: diagonal grey lines on the floor where a row has no case.
         * A gap used to be bare parquet, which reads as nothing at all - and a thing you are
         * meant to take hold of has to look like a thing. Flat rather than a pale case, because
         * a gap is not an empty shelf: nothing can be put there, it is the way through.
         */}
        <pattern id={`${idp}-aisle`} patternUnits="userSpaceOnUse" width={7} height={7} patternTransform="rotate(45)">
          <rect width={7} height={7} fill={night ? '#1a2130' : '#e9e6e0'} opacity={0.55} />
          <line x1={0} y1={0} x2={0} y2={7} stroke={night ? '#5b6577' : '#9c968c'} strokeWidth={1.6} opacity={0.7} />
        </pattern>
        {/* Oak parquet: four blocks of three staves, every other block turned a quarter. */}
        <pattern id={`${idp}-floor`} patternUnits="userSpaceOnUse" width={56} height={56} patternTransform={`matrix(${k} ${kv} ${-k} ${kv} ${ox} ${oy})`}>
          <rect width={56} height={56} fill={f.base} />
          {[
            [0.7, 0.7, true],
            [28.9, 0.7, false],
            [0.7, 28.9, false],
            [28.9, 28.9, true],
          ].map(([bx, by, horiz], b) =>
            [0, 1, 2].map((n) => (
              <rect
                key={`p${b}-${n}`}
                x={(horiz as boolean) ? (bx as number) : (bx as number) + n * 8.9}
                y={(horiz as boolean) ? (by as number) + n * 8.9 : (by as number)}
                width={(horiz as boolean) ? 26.4 : 7.9}
                height={(horiz as boolean) ? 7.9 : 26.4}
                fill={f.tones[n % f.tones.length]}
              />
            )),
          )}
          <rect x={27.6} y={0} width={0.9} height={56} fill={f.seam} />
          <rect x={0} y={27.6} width={56} height={0.9} fill={f.seam} />
        </pattern>
        {/* The rug's weave, in tile space: 56 units are one tile, laid into the floor plane like the parquet. */}
        {room.kind === 'main' && (
          <pattern id={`${idp}-rug`} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform={`matrix(${k} ${kv} ${-k} ${kv} ${ox} ${oy})`}>
            <rect width={6} height={6} fill={rug.field} />
            <rect width={3} height={3} fill={rug.field2} />
            <rect x={3} y={3} width={3} height={3} fill={rug.field2} />
          </pattern>
        )}
        {panel(w.left, 'wallL')}
        {panel(w.right, 'wallR')}
        <radialGradient id={`${idp}-glow`}>
          <stop offset="0" stopColor="#e2b45c" stopOpacity="0.32" />
          <stop offset="1" stopColor="#e2b45c" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${idp}-fire`}>
          <stop offset="0" stopColor="#f0a35b" stopOpacity="0.45" />
          <stop offset="1" stopColor="#f0a35b" stopOpacity="0" />
        </radialGradient>
      </defs>
      <polygon points={diamond(0, 0, ROOM.NI, ROOM.NJ)} fill={`url(#${idp}-floor)`} />
      {items.map((it) => (
        <g key={it.key}>{it.node}</g>
      ))}
      {/* Every bubble in one group, so the room can step them aside while a desk is under the pointer. */}
      <g className="lib-tags">{top}</g>
    </svg>
  )
}
