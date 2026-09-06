import { describe, expect, it } from 'vitest'
import { makeProj, boxFaces, depthOf, fitRoom, mix, seeded } from '../src/lib/library/iso.ts'
import { ROOM, WALL_H, wingSlotPositions, mainSlotPositions, shelfStand, breakSign, signText, ANCHORS, SLOTS } from '../src/lib/library/room.ts'
import { toolFamily, poseForFamily, buildActors, floorLine, EXIT_MS, type AdapterInput } from '../src/lib/library/scene.ts'
import type { LibraryScene, SceneFellow } from '../src/api/types.ts'

describe('isometric projection', () => {
  it('projects the grid with tiles twice as wide as high and sorts by depth', () => {
    const P = makeProj(100, 50, 40)
    expect(P(0, 0)).toEqual([100, 50])
    expect(P(1, 0)).toEqual([120, 60])
    expect(P(0, 1)).toEqual([80, 60])
    expect(P(1, 1, 10)).toEqual([100, 60])
    expect(depthOf(3, 4)).toBe(7)
    const f = boxFaces(P, 0, 0, 1, 1, 10)
    expect(f.top[0]).toEqual([100, 40])
    expect(f.left).toHaveLength(4)
    const fit = fitRoom(ROOM.NI, ROOM.NJ, 1128, 700, WALL_H)
    expect(fit.TW).toBeGreaterThanOrEqual(12)
    expect(fit.TW % 2).toBe(0)
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    const rnd = seeded(42)
    const a = rnd()
    expect(seeded(42)()).toBe(a)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(1)
  })
})

describe('room model', () => {
  it('has twelve wing slots (six on the wall, six in the middle, the door in the middle slot) and four favorites', () => {
    const wing = wingSlotPositions()
    expect(wing).toHaveLength(12)
    expect(wing.slice(0, 6).every((p) => p.j === 0.3)).toBe(true)
    expect(wing.slice(6).every((p) => p.j === 6.4)).toBe(true)
    expect(wing.map((p) => p.i)).not.toContain(SLOTS[3])
    expect(mainSlotPositions()).toHaveLength(4)
    expect(shelfStand('wing', 0)).toEqual({ i: 1.0 + 2.8 / 2 - 0.3, j: 0.3 + 1.55 })
    expect(shelfStand('main', 9)).toBeUndefined()
    expect(ANCHORS.desks).toHaveLength(4)
  })

  it('breaks long signs at the hyphen and reads hyphens as spaces', () => {
    expect(breakSign('astronomy', () => true)).toEqual(['astronomy'])
    expect(breakSign('climate-science', (t) => t.length <= 10)).toEqual(['climate-', 'science'])
    expect(breakSign('knowledge management', (t) => t.length <= 12)).toEqual(['knowledge', 'management'])
    expect(breakSign('abcdefghijklmnop', () => false)).toEqual(['abcdefghijklmnop'])
    expect(signText('climate-science')).toBe('climate science')
  })
})

const fellow = (over: Partial<SceneFellow>): SceneFellow => ({ agentId: 'a1', name: 'Ada', homeDomain: 'astronomy', model: 'sonnet-5', state: 'sleeping', sleepCode: 'idle', sleepReason: 'nothing planned', skipUntil: null, run: null, next: null, lastActive: null, ...over })

const scene = (over: Partial<LibraryScene> = {}): LibraryScene => ({
  generatedAt: 'g',
  night: false,
  window: { start: '01:00', end: '06:00' },
  rooms: [
    { id: 'main', name: 'Main room', kind: 'main', position: -1, capacity: 4, shelves: [{ slot: 1, domain: 'computing', books: 10, volumes: 2, stubs: 0, placedBy: 'user' }] },
    { id: 'w1', name: 'Wing A', kind: 'wing', position: 0, capacity: 12, shelves: [{ slot: 2, domain: 'astronomy', books: 30, volumes: 5, stubs: 1, placedBy: 'auto' }] },
  ],
  departments: [
    { domain: 'computing', books: 10, volumes: 2, stubs: 0, room: 'main', slot: 1 },
    { domain: 'astronomy', books: 30, volumes: 5, stubs: 1, room: 'w1', slot: 2 },
  ],
  unfiled: 3,
  gaps: 4,
  fellows: [],
  runs: [],
  jobs: [],
  concurrency: 2,
  ...over,
})

const input = (s: LibraryScene, lines: Record<string, string | null> = {}, exits: AdapterInput['exits'] = []): AdapterInput => ({ scene: s, lastLine: (ch) => lines[ch] ?? null, exits, now: 1_000_000 })

describe('scene adapter', () => {
  it('reads the tool family off a log line and maps it to a pose', () => {
    expect(toolFamily('→ Read({"file_path":"wiki/x.md"})')).toBe('read')
    expect(toolFamily('-> WebFetch({"url":"x"})')).toBe('read')
    expect(toolFamily('→ Write({"file_path":"wiki/x.md"})')).toBe('write')
    expect(toolFamily('→ Edit({})')).toBe('write')
    expect(toolFamily('committed 8431766 (6 page(s))')).toBe('commit')
    expect(toolFamily('maintenance: research started')).toBe('none')
    expect(toolFamily(null)).toBe('none')
    expect(poseForFamily('read')).toBe('shelf')
    expect(poseForFamily('write')).toBe('desk')
    expect(poseForFamily('commit')).toBe('shelve')
    expect(poseForFamily('none')).toBe('think')
  })

  it('renders the existing runs with zero Fellows: researcher at the shelf, clerks by job state, inspector, caretaker', () => {
    const s = scene({
      runs: [
        { id: 'r1', kind: 'research', channel: 'maintenance:research', label: 'Topic', startedAt: 's' },
        { id: 'r2', kind: 'lint', channel: 'maintenance:lint', label: null, startedAt: 's' },
        { id: 'r3', kind: 'hot-cache', channel: 'maintenance:hot-cache', label: null, startedAt: 's' },
        { id: 'r4', kind: 'retrieve-index', channel: 'maintenance:retrieve-index', label: null, startedAt: 's' },
      ],
      jobs: [
        { id: 'j1', status: 'queued', name: 'a.pdf', source: 'upload', batchId: null },
        { id: 'j2', status: 'preprocessing', name: 'b.pdf', source: 'upload', batchId: null },
        { id: 'j3', status: 'ingesting', name: 'c.pdf', source: 'telegram', batchId: null },
      ],
    })
    const actors = buildActors(input(s, { 'maintenance:research': '→ WebFetch({})', j3: '→ Write({})' }))
    const byId = Object.fromEntries(actors.map((a) => [a.id, a]))
    // The researcher reads at the main room's first favorite shelf (no Fellow, no home domain).
    expect(byId['run:r1']).toMatchObject({ role: 'researcher', pose: 'shelf', room: 'main', tag: 'visitor' })
    expect(byId['run:r2']).toMatchObject({ role: 'inspector', pose: 'clipboard' })
    expect(byId['run:r3']).toMatchObject({ role: 'caretaker', pose: 'stand', i: ANCHORS.noticeBoard.i })
    expect(byId['run:r4']).toBeUndefined()
    expect(byId['parcel:j1']).toMatchObject({ name: 'parcel', pose: 'wait' })
    expect(byId['job:j2']).toMatchObject({ role: 'clerk', pose: 'carry' })
    expect(byId['job:j3']).toMatchObject({ role: 'clerk', pose: 'desk' })
    expect(floorLine(actors)).toBe('5 visitors')
  })

  it('places Fellows by state and pose: shelf in the home domain\'s room, desk in the main room, armchairs when resting', () => {
    const s = scene({
      fellows: [
        fellow({ agentId: 'a1', name: 'Ada', state: 'active', run: { id: 'r1', kind: 'research-step', channel: 'maintenance:research-step', label: 'T', startedAt: 's' } }),
        fellow({ agentId: 'a2', name: 'Bo', state: 'active', run: { id: 'r2', kind: 'plan', channel: 'maintenance:plan', label: 'planning', startedAt: 's' } }),
        fellow({ agentId: 'a3', name: 'Cy', state: 'sleeping', sleepCode: 'quota' }),
        fellow({ agentId: 'a4', name: 'Di', state: 'waiting', next: { topic: 'X', kind: 'research-step', estCostUsd: 2, status: 'proposed' } }),
        fellow({ agentId: 'a5', name: 'Ed', state: 'blocked' }),
        fellow({ agentId: 'a6', name: 'Fay', state: 'retired' }),
        fellow({ agentId: 'a7', name: 'Gus', state: 'proposed' }),
      ],
    })
    const actors = buildActors(input(s, { 'maintenance:research-step': '→ Grep({})' }))
    const byName = Object.fromEntries(actors.map((a) => [a.name, a]))
    expect(byName['Ada']).toMatchObject({ role: 'fellow', pose: 'shelf', room: 'w1', tag: 'fellow', book: expect.stringContaining('hsl(') })
    expect(byName['Bo']).toMatchObject({ pose: 'think', room: 'main', caption: 'Bo (planning)' })
    expect(byName['Cy']).toMatchObject({ pose: 'sleep', tag: 'warn', caption: 'Cy (quota)' })
    expect(byName['Di']).toMatchObject({ pose: 'sit', tag: 'fellow', caption: 'Di (ready)' })
    expect(byName['Ed']).toMatchObject({ pose: 'wait', tag: 'warn' })
    expect(byName['Fay']).toBeUndefined()
    expect(byName['Gus']).toMatchObject({ pose: 'wait', caption: 'Gus (new)' })
    // A writing Fellow sits at a desk in the main room.
    const writing = buildActors(input(s, { 'maintenance:research-step': '→ Edit({})' }))
    expect(writing.find((a) => a.name === 'Ada')).toMatchObject({ pose: 'desk', room: 'main' })
    expect(floorLine(actors)).toBe('2 Fellows at work')
  })

  it('shows exits for a few seconds and never beside a live twin', () => {
    const s = scene({ runs: [{ id: 'r1', kind: 'research', channel: 'c', label: null, startedAt: 's' }] })
    const exits: AdapterInput['exits'] = [
      { id: 'r0', kind: 'run', ok: true, name: 'researcher', role: 'researcher', at: 1_000_000 - 1000 },
      { id: 'r1', kind: 'run', ok: true, name: 'researcher', role: 'researcher', at: 1_000_000 - 1000 },
      { id: 'j9', kind: 'job', ok: false, name: 'bad.pdf', role: 'clerk', at: 1_000_000 - 1000 },
      { id: 'old', kind: 'run', ok: true, name: 'old', role: 'researcher', at: 1_000_000 - EXIT_MS - 1 },
    ]
    const actors = buildActors(input(s, {}, exits))
    const ids = actors.map((a) => a.id)
    expect(ids).toContain('exit:run:r0')
    expect(ids).not.toContain('exit:run:r1')
    expect(ids).toContain('exit:job:j9')
    expect(ids).not.toContain('exit:run:old')
    expect(actors.find((a) => a.id === 'exit:run:r0')).toMatchObject({ exiting: true, pose: 'shelve', caption: 'researcher · done, shelving' })
    expect(actors.find((a) => a.id === 'exit:job:j9')).toMatchObject({ exiting: true, pose: 'wait', tag: 'warn' })
  })
})
