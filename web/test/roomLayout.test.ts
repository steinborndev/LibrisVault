/**
 * How a wing is laid out (web/src/lib/library/room.ts, 2026-09-14): a row has seven positions
 * and six shelves, so one position is always the way through - the doorway in the back row,
 * the aisle in the front. Moving it is what lets a wing be three and three, one and five, or
 * six in a row with the passage at an end.
 */

import { describe, expect, it } from 'vitest'
import { ANCHORS, CASE_W, DEFAULT_AISLES, DESK, DESK_COUNT, DOOR, ROOM, SLOTS, deskPositions, deskStand, doorAt, rowSlots, shelfStand, slotPosition, wingSlotPositions } from '../src/lib/library/room.ts'

describe('the gap a row leaves', () => {
  it('leaves out exactly the position it stands in, wherever that is', () => {
    expect(rowSlots(3)).toEqual([0, 1, 2, 4, 5, 6])
    expect(rowSlots(0)).toEqual([1, 2, 3, 4, 5, 6])
    expect(rowSlots(6)).toEqual([0, 1, 2, 3, 4, 5])
    for (const at of [0, 1, 2, 3, 4, 5, 6]) {
      expect(rowSlots(at)).toHaveLength(6)
      expect(rowSlots(at)).not.toContain(at)
    }
  })

  it('offers every arrangement the room can take', () => {
    // Read as "shelves before the gap, gap, shelves after": 0+6 through 6+0.
    const shape = (at: number): [number, number] => [rowSlots(at).filter((k) => k < at).length, rowSlots(at).filter((k) => k > at).length]
    expect([0, 1, 2, 3, 4, 5, 6].map(shape)).toEqual([
      [0, 6],
      [1, 5],
      [2, 4],
      [3, 3],
      [4, 2],
      [5, 1],
      [6, 0],
    ])
  })
})

describe('where the twelve shelves stand', () => {
  it('defaults to the arrangement every wing had before', () => {
    const before = wingSlotPositions()
    expect(before).toHaveLength(12)
    expect(before.slice(0, 6).map((p) => p.i)).toEqual([SLOTS[0], SLOTS[1], SLOTS[2], SLOTS[4], SLOTS[5], SLOTS[6]])
    expect(wingSlotPositions(DEFAULT_AISLES)).toEqual(before)
  })

  it('keeps the slot numbers and moves the row, so no department is re-placed', () => {
    /*
     * The point of the whole mechanism: a gap that moves does not hand a shelf to another
     * slot. Slot 6 is the first of the front row whatever the aisle does - it simply stands
     * one position further left or right.
     */
    const middle = wingSlotPositions({ wall: 3, mid: 3 })
    const outer = wingSlotPositions({ wall: 3, mid: 0 })
    expect(middle).toHaveLength(outer.length)
    expect(outer[6]!.i).toBe(SLOTS[1])
    expect(middle[6]!.i).toBe(SLOTS[0])
    // The back row is untouched by the front row's gap.
    expect(outer.slice(0, 6)).toEqual(middle.slice(0, 6))
  })

  it('lets each row move on its own', () => {
    const p = wingSlotPositions({ wall: 6, mid: 0 })
    expect(p.slice(0, 6).map((t) => t.i)).toEqual([SLOTS[0], SLOTS[1], SLOTS[2], SLOTS[3], SLOTS[4], SLOTS[5]])
    expect(p.slice(6).map((t) => t.i)).toEqual([SLOTS[1], SLOTS[2], SLOTS[3], SLOTS[4], SLOTS[5], SLOTS[6]])
  })

  it('stands a figure in front of the shelf as the room is arranged now', () => {
    const moved = shelfStand('wing', 6, { wall: 3, mid: 0 })!
    expect(moved.i).toBeCloseTo(SLOTS[1]! + CASE_W / 2 - 0.3, 6)
    // The main room ignores the argument: its four favorites have their own positions.
    expect(shelfStand('main', 0, { wall: 0, mid: 0 })).toEqual(shelfStand('main', 0))
  })

  it('gives a slot outside the room no position', () => {
    expect(slotPosition('wing', 12)).toBeUndefined()
    expect(slotPosition('main', 4)).toBeUndefined()
  })
})

describe('the doorway follows the back row', () => {
  it('sits where it always did when the gap is in the middle', () => {
    expect(doorAt(3)).toEqual({ from: DOOR.from, to: DOOR.to })
  })

  it('moves with the gap and keeps its width', () => {
    const width = DOOR.to - DOOR.from
    for (const at of [0, 1, 2, 3, 4, 5, 6]) {
      const d = doorAt(at)
      expect(d.from).toBe(SLOTS[at])
      expect(d.to - d.from).toBe(width)
    }
  })
})

/**
 * The desks (2026-09-17): ten in two rows of five, one per Fellow, and a figure stands in
 * FRONT of its desk - the monitor faces it from the back edge.
 */
describe('the desks', () => {
  it('stand in two rows of five, clear of the right edge, with a figure in front of each', () => {
    const desks = deskPositions()
    expect(desks).toHaveLength(DESK_COUNT)
    expect(desks.slice(0, 5).every((d) => d.j === DESK.ROWS[0])).toBe(true)
    expect(desks.slice(5).every((d) => d.j === DESK.ROWS[1])).toBe(true)
    expect(desks[1]!.i - desks[0]!.i).toBeCloseTo(DESK.PITCH, 6)
    expect(desks[4]!.i + DESK.W).toBeLessThan(ROOM.NI - 1)
    const stand = deskStand(3)
    expect(stand.j).toBeGreaterThan(desks[3]!.j + DESK.D)
    expect(stand.i).toBeGreaterThan(desks[3]!.i)
    expect(stand.i).toBeLessThan(desks[3]!.i + DESK.W)
    expect(ANCHORS.desks[3]).toEqual(stand)
    expect(ANCHORS.desks).toHaveLength(DESK_COUNT)
  })

  it('stands the cart a tile and a half from the rug and towards the door, and the easel in front of it, apart', () => {
    const rugLeft = DESK.I0 - 0.6
    expect(rugLeft - (ANCHORS.cart.i + 1.55)).toBeCloseTo(1.65, 6)
    expect(ANCHORS.cart.j + 0.36 + 2.6).toBeCloseTo((DESK.ROWS[0] + DESK.ROWS[1] + DESK.D) / 2, 6)
    // The easel: nearer the rug than the cart, left of it, and a clear stretch of floor between the two.
    expect(rugLeft - ANCHORS.easel.i).toBeCloseTo(2.25, 6)
    expect(ANCHORS.easel.j - (ANCHORS.cart.j + 0.72)).toBeGreaterThan(2.5)
  })
})
