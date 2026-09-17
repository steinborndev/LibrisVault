/**
 * One room of the Library as an SVG (docs/agents/SPEC.md section 10, docs/tasks/TASKS-A4.md
 * D1): the design generator's drawing ported to React. Floor and walls first, then every
 * item in painter's order by depth, labels and tags on top. Figures sit in translated
 * groups with a CSS transition, so a pose change slides them between anchors.
 */

import { useMemo } from 'react'
import type { SceneRoom, SceneShelf } from '../../api/types.ts'
import { domainHue } from '../../lib/domains.ts'
import { boxFaces, depthOf, fitRoom, hsl, makeProj, mix, pts, seeded, type Proj, type Pt } from '../../lib/library/iso.ts'
import { CASE_D, CASE_W, DEFAULT_AISLE, DOOR, FAV_I, MID_J, ROOM, SLOTS, WALL_H, WALL_J, breakSign, doorAt, signText, wingSlotPositions, type Aisles } from '../../lib/library/room.ts'

/** The case dimensions under the short names the geometry below reads in. */
const a = CASE_W
const b = CASE_D
import type { Actor } from '../../lib/library/scene.ts'

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
export type BoardId = 'hot' | 'recap' | 'reading'

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

interface Item {
  readonly d: number
  readonly key: string
  readonly node: React.ReactNode
}

const signSize = (TW: number): number => (TW >= 56 ? 10.5 : TW >= 46 ? 9.5 : 8.5)
const BAND = (TW: number): number => Math.round(2 * signSize(TW) + 6)

/** Sign text lying on a shelf face, one size per view, two lines when the name does not fit. */
function faceText(P: Proj, i: number, j: number, zb: number, text: string, fill: string, maxLen: number, key: string): React.ReactNode {
  const TW = P.TW
  if (TW < 34) return null
  const size = signSize(TW)
  const band = BAND(TW)
  const facePx = (maxLen * TW) / 2
  const fits = (t: string): boolean => t.length * size * 0.58 <= facePx
  const lines = breakSign(text, fits)
  const cap = size * 0.72
  const baselines = lines.length === 1 ? [zb + (band - cap) / 2] : [zb + band - 3 - cap, zb + band - 3 - cap - (size + 2)]
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

/** A bookcase along i: frame, the sign band, rows of spines. `spare` draws the silhouette of a free slot. */
function Bookcase({ P, i0, j0, shelf, night, spare, label, selected }: { P: Proj; i0: number; j0: number; shelf: SceneShelf | null; night: boolean; spare?: string; label?: string; selected?: boolean }): React.ReactElement {
  const TW = P.TW
  const scale = TW / 46
  const band = BAND(TW)
  const h = Math.round(64 * scale) + 10
  const c0 = SHELF[night ? 'night' : 'day']
  const c = spare !== undefined ? { ...c0, top: mix(c0.top, night ? '#0f1524' : '#ffffff', 0.45), left: mix(c0.left, night ? '#0f1524' : '#ffffff', 0.45), right: mix(c0.right, night ? '#0f1524' : '#ffffff', 0.45), band: mix(c0.band, night ? '#0f1524' : '#ffffff', 0.45) } : c0
  const rowsTop = h - band - 3
  const bandPoly: Pt[] = [P(i0, j0 + b, rowsTop + 1), P(i0 + a, j0 + b, rowsTop + 1), P(i0 + a, j0 + b, h - 1), P(i0, j0 + b, h - 1)]
  const spines = useMemo(() => {
    if (!shelf) return []
    const rnd = seeded(domainHue(shelf.domain) * 7919 + shelf.books + shelf.volumes)
    const hue = domainHue(shelf.domain)
    const rows = 3
    const rowH = (rowsTop - 4) / rows
    const capacity = rows * Math.floor((a - 0.3) / 0.21)
    const n = Math.min(capacity, Math.max(shelf.books + shelf.volumes > 0 ? 4 : 0, Math.round((shelf.books + shelf.volumes * 0.5) * 0.55)))
    const out: Array<{ points: string; fill: string }> = []
    let drawn = 0
    const volumeShare = shelf.books + shelf.volumes > 0 ? shelf.volumes / (shelf.books + shelf.volumes) : 0
    for (let r = 0; r < rows; r++) {
      const z0 = 3 + r * rowH
      let t = 0.15
      while (t < a - 0.2 && drawn < n) {
        const thin = rnd() < Math.max(0.1, volumeShare)
        const ds = thin ? 0.09 : 0.14 + rnd() * 0.1
        const hs = rowH - 4 - rnd() * 5
        const gap = rnd() < 0.08 ? 0.12 : 0.03
        const l = night ? 28 + rnd() * 12 : 40 + rnd() * 20
        const s = thin ? 30 : 48 + rnd() * 16
        out.push({ points: pts([P(i0 + t, j0 + b, z0), P(i0 + t + ds, j0 + b, z0), P(i0 + t + ds, j0 + b, z0 + hs), P(i0 + t, j0 + b, z0 + hs)]), fill: hsl(hue + (rnd() * 16 - 8), s, l) })
        t += ds + gap
        drawn++
      }
    }
    return out
    /*
     * `P` rather than `TW` (2026-09-08): the projection carries the room's offset as well as
     * its tile width, and `fitRoom` quantises TW to even pixels while ox/oy stay continuous.
     * A resize that moved the room without changing the tile size therefore left these
     * polygons on the old offset while everything around them moved. `rowsTop` follows the
     * band height, which follows TW.
     *
     * `shelf` itself stays out: the scene is polled, so its object identity changes every few
     * seconds while the three fields that decide what is drawn do not.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shelf?.domain, shelf?.books, shelf?.volumes, night, P, rowsTop, i0, j0])
  return (
    <g className={`lib-case${selected ? ' selected' : ''}`}>
      <Box P={P} i0={i0} j0={j0} a={a} b={b} h={h} c={c} />
      <polygon points={pts(bandPoly)} fill={c.band} />
      {spare !== undefined
        ? faceText(P, i0 + 0.12, j0 + b, rowsTop + 1, spare, mix(c0.sign, c.band, 0.45), a - 0.2, 'free')
        : shelf && faceText(P, i0 + 0.12, j0 + b, rowsTop + 1, label ?? signText(shelf.domain), c.sign, a - 0.2, 'sign')}
      {spines.map((s, k) => (
        <polygon key={k} points={s.points} fill={s.fill} />
      ))}
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
        points={pts([P(i0, j0 + b, h), P(i0 + a, j0 + b, h), P(i0 + a, j0, h)])}
        fill="none"
        stroke={night ? '#ffd9a8' : '#fff4e2'}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      {selected && <polygon points={pts([P(i0 - 0.1, j0 - 0.1, 0), P(i0 + a + 0.1, j0 - 0.1, 0), P(i0 + a + 0.1, j0 + b + 0.1, 0), P(i0 - 0.1, j0 + b + 0.1, 0)])} fill="none" stroke={TOK.accent} strokeWidth={2} strokeDasharray="5 4" />}
    </g>
  )
}

/** A figure at (0, 0): the pose vocabulary of the Sprites artboard, no faces (NEW-6). */
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
  if (a.name === 'parcel') {
    return (
      <g>
        {shadow}
        <rect x={-9} y={-14} width={18} height={12} rx={1.5} fill={parcel.fill} stroke={parcel.stroke} />
        <path d="M0 -14 v12" stroke={parcel.stroke} />
      </g>
    )
  }
  if (a.pose === 'sleep' || a.pose === 'sit') {
    return (
      <g>
        {shadow}
        {halo}
        <rect x={-12} y={-34} width={24} height={26} rx={5} fill={night ? '#30405f' : '#c3cde0'} stroke={edge} strokeWidth={0.9} strokeOpacity={0.35} />
        <rect x={-9} y={-22} width={18} height={14} rx={4} fill={shirt} stroke={edge} strokeWidth={0.8} strokeOpacity={0.3} />
        <circle cx={1} cy={-26} r={6} fill={skin} stroke={edge} strokeWidth={0.8} strokeOpacity={0.3} />
        <path d="M-5 -30 q6 -6 12 0" fill={hair} />
        <rect x={-10} y={-12} width={20} height={6} rx={3} fill={night ? '#1a2233' : '#9aa7c2'} />
        {a.pose === 'sleep' && (
          <>
            <text x={12} y={-36} fontFamily={MONO} fontSize={9} fill={night ? '#78859f' : TOK.faint}>
              z
            </text>
            <text x={17} y={-42} fontFamily={MONO} fontSize={8} fill={night ? '#78859f' : TOK.faint}>
              z
            </text>
          </>
        )}
      </g>
    )
  }
  const seated = a.pose === 'desk'
  const bodyY = seated ? -26 : -30
  return (
    <g>
      {shadow}
      {halo}
      {!seated && (
        <>
          <rect x={-5} y={-14} width={4} height={13} rx={1.5} fill={pants} />
          <rect x={1} y={-14} width={4} height={13} rx={1.5} fill={pants} />
        </>
      )}
      <rect x={-7} y={bodyY} width={14} height={seated ? 14 : 18} rx={4} fill={shirt} stroke={edge} strokeWidth={0.8} strokeOpacity={0.3} />
      <circle cx={0} cy={bodyY - 6} r={6} fill={skin} stroke={edge} strokeWidth={0.8} strokeOpacity={0.3} />
      <path d={`M-6 ${bodyY - 8} q6 -7 12 0`} fill={hair} />
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
      {a.pose === 'desk' && <rect x={-9} y={bodyY + 8} width={8} height={5} rx={1} fill={paper} stroke={TOK.borderStrong} />}
      {a.pose === 'think' && (
        <text x={9} y={bodyY - 12} fontFamily={MONO} fontSize={9} fill={night ? '#78859f' : TOK.faint}>
          …
        </text>
      )}
      {a.pose === 'cart' && (
        <>
          <rect x={10} y={bodyY + 6} width={16} height={10} rx={1.5} fill={night ? '#3a4a6c' : '#e6eaf3'} stroke={night ? '#22304a' : '#b6c2d8'} />
          <circle cx={13} cy={bodyY + 19} r={2.5} fill={night ? '#0a0d16' : '#55627e'} />
          <circle cx={23} cy={bodyY + 19} r={2.5} fill={night ? '#0a0d16' : '#55627e'} />
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
  /** The name over the passage: which room it leads to. Absent = no sign, one room only. */
  readonly nextRoomName?: string | undefined
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
      {/* posts and lintel */}
      <polygon points={pts([P(door.from - 0.22, 0, 0), P(door.from, 0, 0), P(door.from, 0, doorZ + 9), P(door.from - 0.22, 0, doorZ + 9)])} fill={frameC.frame} stroke={frameC.edge} strokeWidth={0.8} />
      <polygon points={pts([P(door.from - 0.22, 0, doorZ), P(door.to + 0.22, 0, doorZ), P(door.to + 0.22, 0, doorZ + 9), P(door.from - 0.22, 0, doorZ + 9)])} fill={frameC.frame} stroke={frameC.edge} strokeWidth={0.8} />
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

  // The right post sorts after the wall tile beside it, which would otherwise paint over it.
  add(door.to + 0.6, 'doorpost-r', (
    <polygon
      points={pts([P(door.to, 0, 0), P(door.to + 0.22, 0, 0), P(door.to + 0.22, 0, WALL_H * 0.62 + 9), P(door.to, 0, WALL_H * 0.62 + 9)])}
      fill={night ? '#5b4630' : '#8a6a43'}
      stroke={night ? '#3d2f1f' : '#6f5335'}
      strokeWidth={0.8}
    />
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
  const stone = night ? { top: '#4a4a52', left: '#3a3a42', right: '#2e2e36' } : { top: '#cfc9c0', left: '#b8b0a4', right: '#a39a8d' }
  const chairC = night ? { top: '#3a4a6c', left: '#2a3550', right: '#22304a' } : { top: '#c9b8a2', left: '#b39f86', right: '#9c876e' }

  if (room.kind === 'main') {
    FAV_I.forEach((fi, n) => placeCase(fi, WALL_J, n, 'favorite'))
    // Two boards on the short wall: the hot cache and last night's report, each under a title
    // band. Clicking one opens it as a window over the room (docs/agents/SPEC.md section 10).
    const board = (j0: number, j1: number, title: string, id: BoardId): React.ReactNode => {
      // Centred on the wall: board plus title band is 70 high, so 40 of wall is left above
      // and below it. It crosses the wainscot rail, the way a framed picture would.
      const zBase = 40
      const zTop = 88
      const bandTop = 110
      const face = (z0: number, z1: number, a: number, b: number): string => pts([P(0, a, z0), P(0, b, z0), P(0, b, z1), P(0, a, z1)])
      // The wall runs towards smaller j as the screen goes right, so the title starts at j1.
      const [tx, ty] = P(0, j1 - 0.14, bandTop - 15)
      return (
        <g
          key={id}
          className="lib-board"
          data-board={id}
          onClick={props.onBoardClick ? () => props.onBoardClick!(id) : undefined}
          style={{ cursor: props.onBoardClick ? 'pointer' : 'default' }}
        >
          <title>{title}</title>
          <polygon points={face(bandTop - 22, bandTop, j0 - 0.12, j1 + 0.12)} fill={frameC.frame} stroke={frameC.edge} strokeWidth={1} />
          <text transform={`matrix(1 -0.5 0 1 ${tx.toFixed(1)} ${ty.toFixed(1)})`} fontFamily={FONT} fontSize={10} fontWeight={600} letterSpacing="0.02em" fill={night ? '#e6dcc6' : '#f6efe2'}>
            {title}
          </text>
          <polygon points={face(zBase, zTop, j0, j1)} fill={night ? '#2a2414' : '#f5ecd7'} stroke={night ? '#5a4a1a' : '#e0cfa2'} />
          {[0, 1, 2, 3].map((q) => {
            const z = zTop - 11 - q * 10
            return <polygon key={q} points={face(z, z + 5, j0 + 0.28, j1 - 0.28 - (q % 2) * 0.42)} fill={night ? '#5a4a1a' : '#d9c58f'} />
          })}
          {/* The same lit edge a shelf wears under the pointer, and for the same reason: a board
              opens a window over the room and said so with a pointer shape alone. One segment
              rather than two, because a board is flat against the wall and has only the one
              edge the viewer is outside of. */}
          <polyline
            className="bc-rim"
            points={pts([P(0, j0 - 0.12, bandTop), P(0, j1 + 0.12, bandTop)])}
            fill="none"
            stroke={night ? '#ffd9a8' : '#fff4e2'}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
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
    // fireplace with the hood, four armchairs
    const fi = 5.5
    const fj = 5.4
    add(fi + 2.2 + fj + 2.2, 'fire', (
      <g>
        <Box P={P} i0={fi} j0={fj} a={2.2} b={2.2} h={34} c={stone} />
        <polygon points={pts([P(fi + 0.4, fj + 2.2, 4), P(fi + 1.8, fj + 2.2, 4), P(fi + 1.8, fj + 2.2, 26), P(fi + 0.4, fj + 2.2, 26)])} fill="#1a1410" />
        <polygon points={pts([P(fi + 0.65, fj + 2.2, 5), P(fi + 1.0, fj + 2.2, 22), P(fi + 1.15, fj + 2.2, 12), P(fi + 1.35, fj + 2.2, 24), P(fi + 1.55, fj + 2.2, 5)])} fill="#f0a35b" />
        <polygon points={pts([P(fi + 0.85, fj + 2.2, 5), P(fi + 1.05, fj + 2.2, 15), P(fi + 1.25, fj + 2.2, 8), P(fi + 1.35, fj + 2.2, 5)])} fill="#f6d27a" />
        <Box P={P} i0={fi + 0.45} j0={fj + 0.45} a={1.3} b={1.3} h={76} z0={34} c={stone} />
        {night && <ellipse cx={P(fi + 1.1, fj + 2.4, 10)[0]} cy={P(fi + 1.1, fj + 2.4, 10)[1]} rx={96} ry={48} fill={`url(#${idp}-fire)`} />}
      </g>
    ))
    const chairs: Array<[number, number, 'l' | 'r' | 'f']> = [
      [fi - 1.8, fj + 0.7, 'l'],
      [fi + 2.5, fj + 0.7, 'r'],
      [fi - 0.4, fj + 3.2, 'f'],
      [fi + 1.7, fj + 3.2, 'f'],
    ]
    chairs.forEach(([ci, cj, side], n) => {
      add(ci + cj + 1.8, `chair${n}`, <Box P={P} i0={ci} j0={cj} a={0.9} b={0.9} h={12} c={chairC} />)
      if (side === 'l') add(ci + cj + 0.15, `chairb${n}`, <Box P={P} i0={ci - 0.15} j0={cj} a={0.15} b={0.9} h={26} c={chairC} />)
      if (side === 'r') add(ci + 0.9 + cj + 0.9 + 0.15, `chairb${n}`, <Box P={P} i0={ci + 0.9} j0={cj} a={0.15} b={0.9} h={26} c={chairC} />)
      if (side === 'f') add(ci + 0.9 + cj + 1.05, `chairb${n}`, <Box P={P} i0={ci} j0={cj + 0.9} a={0.9} b={0.15} h={26} c={chairC} />)
    })
    // desks with computers, chairs behind them
    ;[12.5, 15.3, 18.1, 20.9].forEach((di, n) => {
      const dj = 7.4
      const d = di + 1.4 + dj + 0.8
      add(d, `desk${n}`, (
        <g>
          <Box P={P} i0={di} j0={dj} a={1.4} b={0.8} h={22} c={wood} />
          <Box P={P} i0={di + 0.75} j0={dj + 0.15} a={0.12} b={0.5} h={13} z0={22} c={{ top: '#9aa7c2', left: night ? '#7fa7ff' : '#dfe8fb', right: '#1a2333' }} />
          <Box P={P} i0={di + 0.15} j0={dj + 0.25} a={0.3} b={0.3} h={2} z0={22} c={{ top: '#e9edf7', left: '#c3cde0', right: '#b0bcd2' }} />
        </g>
      ))
      add(di + 0.7 + dj - 0.1, `deskchair${n}`, <Box P={P} i0={di + 0.35} j0={dj - 0.85} a={0.7} b={0.7} h={12} c={chairC} />)
      // A desk lamp on every desk: an arm, a shade, and light on the desktop at night.
      const [lx, ly] = P(di + 0.22, dj + 0.62, 22)
      add(d + 0.04, `lamp${n}`, (
        <g className={`lib-lamp${night ? ' lit' : ''}`}>
          {night && <ellipse cx={lx} cy={ly + 2} rx={52} ry={26} fill={`url(#${idp}-glow)`} />}
          <ellipse cx={lx} cy={ly} rx={5} ry={2.5} fill={night ? '#4a3a26' : '#8a95ad'} />
          <path d={`M${lx} ${ly - 1} l3 -13`} stroke={night ? '#6b5735' : '#8a95ad'} strokeWidth={1.6} fill="none" strokeLinecap="round" />
          <path d={`M${lx - 2} ${ly - 14} h11 l-3 -7 h-6 z`} fill={night ? '#e2b45c' : '#b8c0d0'} stroke={night ? '#8a6a43' : '#98a2b5'} strokeWidth={0.8} />
          {night && <ellipse cx={lx + 3.5} cy={ly - 13.5} rx={5} ry={1.6} fill="#f6d27a" />}
        </g>
      ))
    })
    // front desk with a parcel, the intake cart, the catalog
    add(13.5 + 2.4 + 2.6 + 0.8, 'frontdesk', (
      <g>
        <Box P={P} i0={13.5} j0={2.6} a={2.4} b={0.8} h={30} c={wood} />
        <Box P={P} i0={13.8} j0={2.7} a={0.5} b={0.4} h={12} z0={30} c={night ? { top: '#6b5735', left: '#5c4a2c', right: '#4a3b22' } : { top: '#e6cfa6', left: '#d9b98a', right: '#c9a672' }} />
      </g>
    ))
    const cartC = night ? { top: '#3a4a6c', left: '#2a3550', right: '#22304a' } : { top: '#e6eaf3', left: '#c9d2e3', right: '#b6c2d8' }
    const [cx, cy] = P(16.4 + 0.45, 3.2 + 0.28, 0)
    add(16.4 + 0.9 + 3.2 + 0.55, 'cart', (
      <g>
        <Box P={P} i0={16.4} j0={3.2} a={0.9} b={0.55} h={18} c={cartC} />
        <circle cx={cx - 12} cy={cy + 4} r={3.5} fill={night ? '#0a0d16' : '#55627e'} />
        <circle cx={cx + 12} cy={cy + 2} r={3.5} fill={night ? '#0a0d16' : '#55627e'} />
        <polygon points={pts([P(16.55, 3.7, 18), P(16.7, 3.7, 18), P(16.7, 3.7, 30), P(16.55, 3.7, 30)])} fill={hsl(200, 50, 45)} />
        <polygon points={pts([P(16.75, 3.7, 18), P(16.88, 3.7, 18), P(16.88, 3.7, 28), P(16.75, 3.7, 28)])} fill={hsl(330, 45, 50)} />
      </g>
    ))
    add(8.4 + 0.8 + 3.6 + 0.8, 'catalog', (
      <g>
        <Box P={P} i0={8.4} j0={3.6} a={0.8} b={0.8} h={42} c={wood} />
        {[0, 1, 2].map((q) => (
          <polygon key={q} points={pts([P(8.5, 4.4, 6 + q * 12), P(9.1, 4.4, 6 + q * 12), P(9.1, 4.4, 12 + q * 12), P(8.5, 4.4, 12 + q * 12)])} fill={night ? '#5a4630' : '#e6d6bf'} stroke={night ? '#33261a' : '#b8976a'} />
        ))}
      </g>
    ))
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
      const ty = a.pose === 'sleep' || a.pose === 'sit' ? -52 : a.pose === 'desk' ? -46 : -50
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
      {top}
    </svg>
  )
}
