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
import { CASE_D, CASE_W, DOOR, FAV_I, MID_J, ROOM, WALL_H, WALL_J, breakSign, signText, wingSlotPositions } from '../../lib/library/room.ts'
import type { Actor } from '../../lib/library/scene.ts'

const FONT = '"Instrument Sans", system-ui, sans-serif'
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace'

const SHELF = {
  day: { top: '#8a6448', left: '#6f4d36', right: '#5a3c29', band: '#4a3122', sign: '#f3e6d6' },
  night: { top: '#4a3324', left: '#3a281c', right: '#2e1f16', band: '#241811', sign: '#e0cdb8' },
}
const FLOOR = {
  day: { base: '#cfd6e3', tones: ['#e9ecf3', '#e2e6ef'] },
  night: { base: '#131928', tones: ['#1d2536', '#1a2131'] },
}
const WALL = {
  day: { left: '#f3f5fa', right: '#eef1f7', base: '#d9dfeb', line: '#d4dae8' },
  night: { left: '#141b2c', right: '#111828', base: '#0c101b', line: '#22304a' },
}
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
  const a = CASE_W
  const b = CASE_D
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shelf?.domain, shelf?.books, shelf?.volumes, night, TW, i0, j0])
  return (
    <g className={`lib-case${selected ? ' selected' : ''}`}>
      <Box P={P} i0={i0} j0={j0} a={a} b={b} h={h} c={c} />
      {spare === undefined && (
        <>
          {[0.3, 0.62].map((f) => (
            <polyline key={f} points={pts([P(i0, j0 + b * f, h), P(i0 + a, j0 + b * f, h)])} fill="none" stroke={c.right} strokeOpacity={0.45} strokeWidth={0.8} />
          ))}
        </>
      )}
      <polygon points={pts(bandPoly)} fill={c.band} />
      {spare !== undefined
        ? faceText(P, i0 + 0.12, j0 + b, rowsTop + 1, spare, mix(c0.sign, c.band, 0.45), a - 0.2, 'free')
        : shelf && faceText(P, i0 + 0.12, j0 + b, rowsTop + 1, label ?? signText(shelf.domain), c.sign, a - 0.2, 'sign')}
      {spines.map((s, k) => (
        <polygon key={k} points={s.points} fill={s.fill} />
      ))}
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
        <rect x={-12} y={-34} width={24} height={26} rx={5} fill={night ? '#30405f' : '#c3cde0'} />
        <rect x={-9} y={-22} width={18} height={14} rx={4} fill={shirt} />
        <circle cx={1} cy={-26} r={6} fill={skin} />
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
      {!seated && (
        <>
          <rect x={-5} y={-14} width={4} height={13} rx={1.5} fill={pants} />
          <rect x={1} y={-14} width={4} height={13} rx={1.5} fill={pants} />
        </>
      )}
      <rect x={-7} y={bodyY} width={14} height={seated ? 14 : 18} rx={4} fill={shirt} />
      <circle cx={0} cy={bodyY - 6} r={6} fill={skin} />
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

function Tag({ text, kind, night, y }: { text: string; kind: Actor['tag']; night: boolean; y: number }): React.ReactElement {
  const w = text.length * 6.4 + 18
  const fills = {
    fellow: [night ? '#1b2947' : TOK.accentSoft, night ? '#7fa7ff' : TOK.accent, night ? '#30405f' : '#c5d3f4'],
    visitor: [night ? '#232a3a' : TOK.mutedBg, night ? '#9aa7c2' : TOK.muted, night ? '#30405f' : '#d1d7e2'],
    asleep: [night ? '#1a2233' : TOK.elev2, night ? '#78859f' : TOK.faint, night ? '#30405f' : TOK.border],
    warn: [night ? '#33270f' : TOK.warnBg, night ? '#e2a64d' : TOK.warn, night ? '#5a4a1a' : '#e8d3a0'],
  }[kind]
  return (
    <g>
      <rect x={-w / 2} y={y - 9} width={w} height={18} rx={9} fill={fills[0]} stroke={fills[2]} />
      <text x={0} y={y + 3.6} textAnchor="middle" fontFamily={FONT} fontSize={10.5} fontWeight={600} fill={fills[1]}>
        {text}
      </text>
    </g>
  )
}

function Label({ P, i, j, text, night, size = 11, tone = 'dim' }: { P: Proj; i: number; j: number; text: string; night: boolean; size?: number; tone?: 'dim' | 'faint' }): React.ReactElement {
  const [x, y] = P(i, j, 0)
  const fill = night ? (tone === 'dim' ? '#9aa7c2' : '#78859f') : tone === 'dim' ? TOK.dim : TOK.faint
  return (
    <text x={x.toFixed(1)} y={(y + 4).toFixed(1)} textAnchor="middle" fontFamily={FONT} fontSize={size} fontWeight={500} fill={fill} paintOrder="stroke" stroke={night ? '#0f1524' : '#ffffff'} strokeWidth={3} strokeLinejoin="round">
      {text}
    </text>
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
  readonly idp?: string
}

export function RoomSvg(props: RoomSvgProps): React.ReactElement {
  const { room, night, actors, width: W, height: H } = props
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
  const panel = (fill: string, key: string): React.ReactElement => (
    <pattern key={key} id={`${idp}-${key}`} patternUnits="userSpaceOnUse" width={56} height={wallH} patternTransform={`matrix(${key.endsWith('R') ? -k : k} ${kv} 0 1 ${ox} ${oy - wallH})`}>
      <rect width={56} height={wallH} fill={fill} />
      <line x1={0} y1={wallH - 66} x2={56} y2={wallH - 66} stroke={w.line} strokeWidth={2} />
      <rect x={7} y={wallH - 58} width={42} height={44} fill="none" stroke={w.line} strokeWidth={1.5} />
      <rect x={11} y={wallH - 54} width={34} height={36} fill="none" stroke={w.line} strokeWidth={0.8} />
    </pattern>
  )

  // Walls as one-tile segments so figures behind them sort correctly; the door is a gap with a lintel.
  for (let kk = 0; kk < ROOM.NI; kk++) {
    if (kk >= DOOR.from && kk < DOOR.to) continue
    add(kk + 0.5 - 0.45, `wl${kk}`, (
      <g>
        <polygon points={pts([P(kk, 0, 0), P(kk + 1, 0, 0), P(kk + 1, 0, wallH), P(kk, 0, wallH)])} fill={`url(#${idp}-wallL)`} />
        <polygon points={pts([P(kk, 0, 0), P(kk + 1, 0, 0), P(kk + 1, 0, 5), P(kk, 0, 5)])} fill={w.base} />
        <polygon points={pts([P(kk, 0, wallH - 4), P(kk + 1, 0, wallH - 4), P(kk + 1, 0, wallH), P(kk, 0, wallH)])} fill={w.base} />
      </g>
    ))
  }
  add((DOOR.from + DOOR.to) / 2 - 0.45, 'door', (
    <g>
      <polygon points={pts([P(DOOR.from, 0, wallH * 0.62), P(DOOR.to, 0, wallH * 0.62), P(DOOR.to, 0, wallH), P(DOOR.from, 0, wallH)])} fill={`url(#${idp}-wallL)`} />
      <polygon points={pts([P(DOOR.from, 0, wallH - 4), P(DOOR.to, 0, wallH - 4), P(DOOR.to, 0, wallH), P(DOOR.from, 0, wallH)])} fill={w.base} />
      <polygon points={pts([P(DOOR.from, 0, wallH * 0.62), P(DOOR.to, 0, wallH * 0.62), P(DOOR.to, 0, wallH * 0.62 + 4), P(DOOR.from, 0, wallH * 0.62 + 4)])} fill={w.base} />
    </g>
  ))
  for (let kk = 0; kk < ROOM.NJ; kk++) {
    add(kk + 0.5 - 0.45, `wr${kk}`, (
      <g>
        <polygon points={pts([P(0, kk, 0), P(0, kk + 1, 0), P(0, kk + 1, wallH), P(0, kk, wallH)])} fill={`url(#${idp}-wallR)`} />
        <polygon points={pts([P(0, kk, 0), P(0, kk + 1, 0), P(0, kk + 1, 5), P(0, kk, 5)])} fill={w.base} />
        <polygon points={pts([P(0, kk, wallH - 4), P(0, kk + 1, wallH - 4), P(0, kk + 1, wallH), P(0, kk, wallH)])} fill={w.base} />
      </g>
    ))
  }

  const caseDepth = (i: number, j: number): number => i + CASE_W + j + CASE_D
  const shelfAt = (slot: number): SceneShelf | null => room.shelves.find((s) => s.slot === slot) ?? null
  const placeCase = (i: number, j: number, slot: number, spareLabel: string): void => {
    const shelf = shelfAt(slot)
    const dragging = props.draggingDomain !== null && props.draggingDomain !== undefined && shelf?.domain === props.draggingDomain
    const isDrop = props.dropSlot === slot
    add(caseDepth(i, j), `case${slot}`, (
      <g
        className={`lib-slot${shelf ? ' filled' : ' free'}${isDrop ? ' drop' : ''}`}
        onClick={shelf && props.onShelfClick ? () => props.onShelfClick!(shelf.domain) : undefined}
        onPointerDown={shelf && props.onShelfPointerDown ? (e) => props.onShelfPointerDown!(shelf.domain, e) : undefined}
        onPointerEnter={props.onSlotPointerEnter ? () => props.onSlotPointerEnter!(slot) : undefined}
        style={{ cursor: shelf ? 'grab' : 'default', opacity: dragging ? 0.35 : 1 }}
      >
        <title>{shelf ? `${signText(shelf.domain)}: ${shelf.books} books, ${shelf.volumes} sources${shelf.stubs > 0 ? `, ${shelf.stubs} stubs` : ''}. Click to open in the graph, drag to move.` : `free slot ${slot + 1}`}</title>
        {isDrop && <polygon points={pts([P(i - 0.15, j - 0.15), P(i + CASE_W + 0.15, j - 0.15), P(i + CASE_W + 0.15, j + CASE_D + 0.15), P(i - 0.15, j + CASE_D + 0.15)])} fill={TOK.accentSoft} stroke={TOK.accent} strokeWidth={1.5} strokeDasharray="5 4" />}
        {shelf ? <Bookcase P={P} i0={i} j0={j} shelf={shelf} night={night} /> : <Bookcase P={P} i0={i} j0={j} shelf={null} night={night} spare={spareLabel} />}
      </g>
    ))
  }

  const sc = SHELF[mode]
  const wood = { top: sc.top, left: sc.left, right: sc.right }
  const stone = night ? { top: '#4a4a52', left: '#3a3a42', right: '#2e2e36' } : { top: '#cfc9c0', left: '#b8b0a4', right: '#a39a8d' }
  const chairC = night ? { top: '#3a4a6c', left: '#2a3550', right: '#22304a' } : { top: '#c9b8a2', left: '#b39f86', right: '#9c876e' }

  if (room.kind === 'main') {
    FAV_I.forEach((fi, n) => placeCase(fi, WALL_J, n, 'favorite'))
    // notice board on the short wall
    add(6.6 + 0.001, 'board', (
      <g>
        <polygon points={pts([P(0, 4.4, 60), P(0, 6.6, 60), P(0, 6.6, 110), P(0, 4.4, 110)])} fill={night ? '#2a2414' : '#f5ecd7'} stroke={night ? '#5a4a1a' : '#e0cfa2'} />
        {[0, 1, 2, 3].map((q) => {
          const z = 100 - q * 10
          return <polygon key={q} points={pts([P(0, 4.8, z), P(0, 6.2 - (q % 2) * 0.4, z), P(0, 6.2 - (q % 2) * 0.4, z + 4), P(0, 4.8, z + 4)])} fill={night ? '#5a4a1a' : '#d9c58f'} />
        })}
      </g>
    ))
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
      if (night && (n === 1 || n === 2)) {
        const [lx, ly] = P(di + 1.2, dj - 0.2, 0)
        add(d + 0.03, `lamp${n}`, (
          <g>
            <ellipse cx={lx} cy={ly - 8} rx={70} ry={38} fill={`url(#${idp}-glow)`} />
            <rect x={lx - 1} y={ly - 44} width={2} height={36} fill="#78859f" />
            <path d={`M${lx - 9} ${ly - 44} h18 l-4 -8 h-10 z`} fill="#e2b45c" />
          </g>
        ))
      }
    })
    // front desk with a parcel, the intake cart, the catalog
    add(13.5 + 2.4 + 2.6 + 0.8, 'frontdesk', (
      <g>
        <Box P={P} i0={13.5} j0={2.6} a={2.4} b={0.8} h={30} c={wood} />
        <Box P={P} i0={13.8} j0={2.7} a={0.5} b={0.4} h={12} z0={30} c={night ? { top: '#6b5735', left: '#5c4a2c', right: '#4a3b22' } : { top: '#e6cfa6', left: '#d9b98a', right: '#c9a672' }} />
      </g>
    ))
    top.push(<Label key="l-front" P={P} i={14.7} j={4.1} text="front desk" night={night} />)
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
    top.push(<Label key="l-intake" P={P} i={16.9} j={4.5} text="intake" night={night} />)
    add(8.4 + 0.8 + 3.6 + 0.8, 'catalog', (
      <g>
        <Box P={P} i0={8.4} j0={3.6} a={0.8} b={0.8} h={42} c={wood} />
        {[0, 1, 2].map((q) => (
          <polygon key={q} points={pts([P(8.5, 4.4, 6 + q * 12), P(9.1, 4.4, 6 + q * 12), P(9.1, 4.4, 12 + q * 12), P(8.5, 4.4, 12 + q * 12)])} fill={night ? '#5a4630' : '#e6d6bf'} stroke={night ? '#33261a' : '#b8976a'} />
        ))}
      </g>
    ))
    top.push(<Label key="l-catalog" P={P} i={8.8} j={5.2} text="catalog" night={night} />)
    top.push(<Label key="l-door" P={P} i={11.5} j={2.2} text="to the wings" night={night} size={10.5} tone="faint" />)
    top.push(<Label key="l-board" P={P} i={1.1} j={7.2} text="what's new" night={night} size={10.5} tone="faint" />)
  } else {
    wingSlotPositions().forEach((p, idx) => placeCase(p.i, p.j, idx, 'free'))
    top.push(<Label key="l-passage" P={P} i={11.4} j={MID_J + 1.0} text="passage" night={night} size={10.5} tone="faint" />)
    top.push(<Label key="l-next" P={P} i={11.5} j={2.2} text="to the next wing" night={night} size={10.5} tone="faint" />)
  }

  // Figures: each in a translated group with a transition; tags ride in the top layer.
  for (const a of actors) {
    if (a.room !== room.id) continue
    const [x, y] = P(a.i, a.j, 0)
    const selected = props.selectedAgentId !== undefined && props.selectedAgentId !== null && a.agentId === props.selectedAgentId
    add(depthOf(a.i, a.j) + 0.05, `actor-${a.id}`, (
      <g className={`lib-figure${a.exiting ? ' exiting' : ''}${selected ? ' selected' : ''}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} onClick={props.onActorClick ? (e) => props.onActorClick!(a, e) : undefined} style={{ cursor: a.agentId ? 'pointer' : 'default' }}>
        <title>{a.caption}</title>
        <Figure a={a} night={night} />
      </g>
    ))
    if (a.name !== 'parcel') {
      const ty = a.pose === 'sleep' || a.pose === 'sit' ? -52 : a.pose === 'desk' ? -46 : -50
      top.push(
        <g key={`tag-${a.id}`} className={`lib-figure${a.exiting ? ' exiting' : ''}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} onClick={props.onActorClick ? (e) => props.onActorClick!(a, e) : undefined} style={{ cursor: a.agentId ? 'pointer' : 'default' }}>
          <Tag text={a.caption} kind={a.tag} night={night} y={ty} />
        </g>,
      )
    }
  }
  items.sort((p, q) => p.d - q.d)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" className={`lib-svg${night ? ' night' : ''}`} style={{ display: 'block' }}>
      <defs>
        <pattern id={`${idp}-floor`} patternUnits="userSpaceOnUse" width={56} height={56} patternTransform={`matrix(${k} ${kv} ${-k} ${kv} ${ox} ${oy})`}>
          <rect width={56} height={56} fill={f.base} />
          <rect x={0.9} y={0.9} width={26.2} height={26.2} fill={f.tones[0]} />
          <rect x={28.9} y={0.9} width={26.2} height={26.2} fill={f.tones[1]} />
          <rect x={0.9} y={28.9} width={26.2} height={26.2} fill={f.tones[1]} />
          <rect x={28.9} y={28.9} width={26.2} height={26.2} fill={f.tones[0]} />
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
