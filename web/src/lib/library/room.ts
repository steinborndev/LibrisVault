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

/** The main room's furniture anchors, matching the drawing. */
export const ANCHORS = {
  door: { i: 11.5, j: 1.3 },
  frontDesk: { i: 14.8, j: 4.0 },
  frontDeskQueue: [
    { i: 13.6, j: 4.2 },
    { i: 12.6, j: 4.4 },
    { i: 11.6, j: 4.6 },
  ],
  intake: { i: 17.3, j: 4.5 },
  catalog: { i: 9.7, j: 4.9 },
  noticeBoard: { i: 1.3, j: 5.6 },
  desks: [
    { i: 13.0, j: 8.6 },
    { i: 15.8, j: 8.6 },
    { i: 18.6, j: 8.6 },
    { i: 21.4, j: 8.6 },
  ],
  armchairs: [
    { i: 4.15, j: 6.55 },
    { i: 8.45, j: 6.55 },
    { i: 5.55, j: 9.05 },
    { i: 7.65, j: 9.05 },
  ],
  readingTable: { i: 4.55, j: 9.9 },
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
