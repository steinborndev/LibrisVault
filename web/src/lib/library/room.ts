/**
 * The room model (docs/agents/SPEC.md section 10.4, NEW-9 and NEW-10): every room is 23 by
 * 11 tiles on one shared grid, seven shelf slots along the long back wall with the door in
 * the middle one, a wing's middle row of three, passage, three, the main room's favorite
 * pairs and its furniture. The anchors are where figures stand for each pose. Pure.
 */

export const ROOM = { NI: 23, NJ: 11 } as const
export const WALL_H = 150
export const SLOTS = [1.0, 4.0, 7.0, 10.0, 13.0, 16.0, 19.0] as const
export const CASE_W = 2.8
export const CASE_D = 0.72
export const WALL_J = 0.3
export const MID_J = 6.4
/** The doorway when it stands in the middle position, which is where every room starts. */
export const DOOR = { from: 10, to: 13 } as const
/** How wide the doorway is, in tiles: one slot's position plus the reach of a case. */
const DOOR_W = DOOR.to - DOOR.from
/** Where each row's gap stands by default: the middle of seven positions. */
export const DEFAULT_AISLE = 3

/** Both gaps of one room, as the scene reports them. */
export interface Aisles {
  readonly wall: number
  readonly mid: number
}
export const DEFAULT_AISLES: Aisles = { wall: DEFAULT_AISLE, mid: DEFAULT_AISLE }

/** The six shelf positions of a row: every position but the one the gap stands in. */
export const rowSlots = (aisle: number): number[] => [0, 1, 2, 3, 4, 5, 6].filter((k) => k !== aisle)

/** Where the doorway stands when the back row's gap is at `aisle`. */
export const doorAt = (aisle: number): { from: number; to: number } => ({ from: SLOTS[aisle] ?? DOOR.from, to: (SLOTS[aisle] ?? DOOR.from) + DOOR_W })
export const WING_CAPACITY = 12
export const FAVORITE_SLOTS = 4
/** The favorite pairs, each centred in its wall section beside the door. */
export const FAV_I = [2.1, 5.1, 15.1, 18.1] as const

export interface Tile {
  readonly i: number
  readonly j: number
}

/**
 * Where the twelve shelves of a wing stand, by slot: the wall row first, then the middle row.
 *
 * The slots keep their numbers whatever the gaps do. Moving a gap therefore never re-places a
 * department - the row simply closes up behind the gap and opens where it went, and the
 * shelves between the old position and the new one step over by one.
 */
export function wingSlotPositions(aisles: Aisles = DEFAULT_AISLES): Tile[] {
  return [
    ...rowSlots(aisles.wall).map((k) => ({ i: SLOTS[k]!, j: WALL_J })),
    ...rowSlots(aisles.mid).map((k) => ({ i: SLOTS[k]!, j: MID_J })),
  ]
}

/** Where the four favorite shelves of the main room stand, by slot. */
export function mainSlotPositions(): Tile[] {
  return FAV_I.map((i) => ({ i, j: WALL_J }))
}

export function slotPosition(kind: 'main' | 'wing', slot: number, aisles: Aisles = DEFAULT_AISLES): Tile | undefined {
  return (kind === 'main' ? mainSlotPositions() : wingSlotPositions(aisles))[slot]
}

/** Where a figure stands to read at a shelf: in front of the case's middle. */
export function shelfStand(kind: 'main' | 'wing', slot: number, aisles: Aisles = DEFAULT_AISLES): Tile | undefined {
  const p = slotPosition(kind, slot, aisles)
  return p ? { i: p.i + CASE_W / 2 - 0.3, j: p.j + 1.55 } : undefined
}

/**
 * The desks (2026-09-17): ten of them in two rows of five, parallel to the long wall, and
 * every Fellow keeps one - so the room holds ten Fellows and says so by its furniture. The
 * fireplace and the armchairs that used to hold a resting Fellow are gone: a Fellow stands at
 * its own desk whatever its state, so the room never has to decide where "resting" is.
 *
 * The rows stand a tile and a half from the right edge and leave the left part of the floor,
 * in front of the boards, to the book cart. A Fellow stands in FRONT of its desk (larger j,
 * nearer the viewer), the monitor faces it from the back edge and the lamp sits on the back
 * corner.
 */
export const DESK = { W: 1.4, D: 0.8, I0: 9.3, PITCH: 2.7, ROWS: [4.9, 8.0] } as const
/** How many Fellows the room seats: one per desk. The service refuses the eleventh spawn (`DESK_COUNT` there too). */
export const DESK_COUNT = 10

/** Where the ten desks stand, by number: the back row first, left to right, then the front row. */
export function deskPositions(): Tile[] {
  const out: Tile[] = []
  for (const j of DESK.ROWS) for (let n = 0; n < DESK_COUNT / DESK.ROWS.length; n++) out.push({ i: DESK.I0 + n * DESK.PITCH, j })
  return out
}

/** Where a figure stands at desk `n`: in front of it, a little left of the middle, so the screen shows beside its head. */
export function deskStand(n: number): Tile {
  const d = deskPositions()[n % DESK_COUNT]!
  return { i: d.i + 0.45, j: d.j + 1.2 }
}

export const CART_W = 1.55
export const CART_D = 0.72

/**
 * The main room's furniture anchors, matching the drawing.
 *
 * The book cart (2026-09-17) stands in the open floor left of the desks, centred between the
 * short wall and the first desk and in line with the middle of the two rows. It is the one
 * station for everything that is not a Fellow's own work: the maintenance runs stand at it,
 * the ingest queue's parcels lie beside it, and clicking it opens System, where the
 * maintenance runs are started. The plant took the cart's old place by the last favorite shelf.
 */
const CART_I = (DESK.I0 - CART_W) / 2
const CART_J = (DESK.ROWS[0] + DESK.ROWS[1] + DESK.D) / 2 - CART_D / 2
export const ANCHORS = {
  door: { i: 11.5, j: 1.3 },
  desks: deskPositions().map((_, n) => deskStand(n)),
  noticeBoard: { i: 1.3, j: 5.6 },
  /** The cart's footprint origin; it is CART_W by CART_D, parallel to the long wall. */
  cart: { i: CART_I, j: CART_J },
  /** Where a visitor stands to work at the cart: in front of it, like a Fellow at a desk. */
  cartStand: { i: CART_I + 0.5, j: CART_J + CART_D + 0.55 },
  /** The parcels of the ingest queue, on the floor on the wall side of the cart. */
  cartQueue: [
    { i: CART_I - 0.6, j: CART_J + 0.1 },
    { i: CART_I - 0.6, j: CART_J + 0.65 },
    { i: CART_I - 0.6, j: CART_J + 1.2 },
  ],
  /** The potted plant against the long wall, right of the last favorite shelf. */
  /** Centred in the gap between the last favorite shelf (ends at 20.9) and the room's edge (23). */
  plant: { i: 20.9 + (23 - 20.9 - 0.64) / 2, j: 0.42 },
  wingDoor: { i: 11.5, j: 1.3 },
  wingPassage: { i: 11.4, j: 7.6 },
} as const

/** Breaks a shelf sign that does not fit into two lines at its hyphen or space (NEW-5). */
export function breakSign(text: string, fits: (t: string) => boolean): string[] {
  if (fits(text)) return [text]
  const mid = Math.ceil(text.length / 2) + 2
  const cut = Math.max(text.lastIndexOf('-', mid), text.lastIndexOf(' ', mid))
  if (cut <= 0) return [text]
  return [text.slice(0, cut + 1).trim(), text.slice(cut + 1).trim()]
}

/** `climate-science` reads as `climate science` on a sign. */
export const signText = (domain: string): string => domain.replace(/-/g, ' ')
