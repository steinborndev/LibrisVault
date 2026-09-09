import { describe, expect, it } from 'vitest'
import { makeProj, boxFaces, depthOf, fitRoom, mix, seeded } from '../src/lib/library/iso.ts'
import { ROOM, WALL_H, wingSlotPositions, mainSlotPositions, shelfStand, breakSign, signText, ANCHORS, SLOTS } from '../src/lib/library/room.ts'
import {
  toolFamily,
  poseForFamily,
  steadyFamily,
  furthestFamily,
  runPercent,
  buildActors,
  exitOk,
  floorLine,
  EXIT_MS,
  POSE_WINDOW_MS,
  COMMIT_HOLD_MS,
  PROGRESS_MIN,
  PROGRESS_MIN_TYPICAL_MS,
  type AdapterInput,
} from '../src/lib/library/scene.ts'
import type { LibraryScene, SceneFellow, SceneRun } from '../src/api/types.ts'

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

type SceneRunFixture = Partial<SceneRun> & Pick<SceneRun, 'id' | 'kind' | 'channel'>
const run = (over: SceneRunFixture): SceneRun => ({ label: null, startedAt: 's', waiting: false, typicalMs: null, ...over })

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

const NOW = 1_000_000
/** One recent line per channel is enough for the placement tests; the pose window is tested on its own. */
const input = (s: LibraryScene, lines: Record<string, string | null> = {}, exits: AdapterInput['exits'] = []): AdapterInput => ({
  scene: s,
  lines: (ch) => {
    const message = lines[ch]
    return message === undefined || message === null ? [] : [{ ts: new Date(NOW - 1_000).toISOString(), message }]
  },
  exits,
  now: NOW,
})

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

  it('takes the pose from the recent lines, so a confirmation between two tool calls moves nothing', () => {
    const at = (msAgo: number, message: string): { ts: string; message: string } => ({ ts: new Date(NOW - msAgo).toISOString(), message })
    // What the flicker looked like: a tool call and its `tool ok` 20 ms apart.
    const writing = [at(3_000, '→ Write({"file_path":"wiki/x.md"})'), at(2_980, '[user] ← tool ok'), at(1_000, '[assistant] Now the entity pages.')]
    expect(steadyFamily(writing, NOW)).toBe('write')
    // A single lookup does not pull a writing Fellow to a shelf in another wing.
    expect(steadyFamily([...writing, at(500, '→ Read({})')], NOW)).toBe('write')
    // A reading phase reads, even with one write in it.
    expect(steadyFamily([at(9_000, '→ WebSearch({})'), at(6_000, '→ WebFetch({})'), at(3_000, '→ Edit({})')], NOW)).toBe('read')
    // A fresh commit closes the run whatever else it did.
    expect(steadyFamily([at(9_000, '→ Write({})'), at(8_000, '→ Write({})'), at(2_000, 'committed 8431766 (6 page(s))')], NOW)).toBe('commit')
    expect(steadyFamily([at(COMMIT_HOLD_MS + 1_000, 'committed abc (1 page)'), at(1_000, '→ Write({})')], NOW)).toBe('write')
    // Nothing but prose, nothing at all, or nothing recent: the figure thinks.
    expect(steadyFamily([at(1_000, '[assistant] Let me think about this.')], NOW)).toBe('none')
    expect(steadyFamily([], NOW)).toBe('none')
    expect(steadyFamily([at(POSE_WINDOW_MS + 1_000, '→ Read({})')], NOW)).toBe('none')
    // A tie keeps the family that started earlier, so the figure stays where it is.
    expect(steadyFamily([at(5_000, '→ Read({})'), at(2_000, '→ Write({})')], NOW)).toBe('read')
    expect(steadyFamily([at(5_000, '→ Read({})'), at(2_000, '→ Write({})'), at(1_000, '→ Edit({})')], NOW)).toBe('write')
  })

  it('renders the existing runs with zero Fellows: researcher at the shelf, clerks by job state, inspector, caretaker', () => {
    const s = scene({
      runs: [
        run({ id: 'r1', kind: 'research', channel: 'maintenance:research', label: 'Topic' }),
        run({ id: 'r2', kind: 'lint', channel: 'maintenance:lint', label: null }),
        run({ id: 'r3', kind: 'hot-cache', channel: 'maintenance:hot-cache', label: null }),
        run({ id: 'r4', kind: 'retrieve-index', channel: 'maintenance:retrieve-index', label: null }),
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
        fellow({ agentId: 'a1', name: 'Ada', state: 'active', run: run({ id: 'r1', kind: 'research-step', channel: 'maintenance:research-step', label: 'T' }) }),
        fellow({ agentId: 'a2', name: 'Bo', state: 'active', run: run({ id: 'r2', kind: 'plan', channel: 'maintenance:plan', label: 'planning' }) }),
        fellow({ agentId: 'a3', name: 'Cy', state: 'sleeping', sleepCode: 'quota' }),
        fellow({ agentId: 'a4', name: 'Di', state: 'waiting', next: { topic: 'X', kind: 'research-step', estCostUsd: 2, status: 'proposed' } }),
        fellow({ agentId: 'a5', name: 'Ed', state: 'blocked' }),
        fellow({ agentId: 'a6', name: 'Fay', state: 'retired' }),
        fellow({ agentId: 'a7', name: 'Gus', state: 'proposed' }),
        fellow({ agentId: 'a8', name: 'Hal', state: 'sleeping', sleepCode: 'plan-failed' }),
      ],
    })
    const actors = buildActors(input(s, { 'maintenance:research-step': '→ Grep({})' }))
    const byName = Object.fromEntries(actors.map((a) => [a.name, a]))
    expect(byName['Ada']).toMatchObject({ role: 'fellow', pose: 'shelf', room: 'w1', tag: 'fellow', book: expect.stringContaining('hsl(') })
    expect(byName['Bo']).toMatchObject({ pose: 'think', room: 'main', caption: 'Bo (planning)' })
    expect(byName['Cy']).toMatchObject({ pose: 'sleep', tag: 'warn', caption: 'Cy (out of quota)' })
    expect(byName['Di']).toMatchObject({ pose: 'sit', tag: 'fellow', caption: 'Di (ready)' })
    expect(byName['Ed']).toMatchObject({ pose: 'wait', tag: 'warn' })
    expect(byName['Fay']).toBeUndefined()
    expect(byName['Gus']).toMatchObject({ pose: 'wait', caption: 'Gus (new)' })
    // A planner that could not be used is a fault, not a quiet night.
    expect(byName['Hal']).toMatchObject({ pose: 'sleep', tag: 'warn', caption: 'Hal (plan failed)' })
    // Active but between two steps: the desk it just left, not the door across the room.
    const between = buildActors(input(scene({ fellows: [fellow({ agentId: 'a1', name: 'Ada', state: 'active', run: null })] })))
    expect(between[0]).toMatchObject({ pose: 'think', room: 'main', caption: 'Ada (thinking)', i: ANCHORS.desks[0]!.i, j: ANCHORS.desks[0]!.j })
    // A writing Fellow sits at a desk in the main room.
    const writing = buildActors(input(s, { 'maintenance:research-step': '→ Edit({})' }))
    expect(writing.find((a) => a.name === 'Ada')).toMatchObject({ pose: 'desk', room: 'main' })
    expect(floorLine(actors)).toBe('2 Fellows at work')
  })

  it('holds a working Fellow still: the real line sequence of a run moves it once, not eight times', () => {
    // Taken off the live event stream of a research run - a tool call and its confirmation
    // land 20 ms apart, and reading the newest line alone made the figure flicker.
    const real: Array<[number, string]> = [
      [0, 'plan usage after: five_hour 8%, seven_day 46%'],
      [155, '[assistant] → Edit({"file_path":"wiki/concepts/X.md"})'],
      [175, '[user] ← tool ok'],
      [2_676, '[assistant] Now the remaining three concept pages.'],
      [18_462, '[assistant] → Write({"file_path":"wiki/concepts/Y.md"})'],
      [18_478, '[user] ← tool ok'],
      [20_000, '[assistant] → Read({"file_path":"wiki/concepts/Z.md"})'],
      [20_020, '[user] ← tool ok'],
      [24_355, '[assistant] → Write({"file_path":"wiki/concepts/Z.md"})'],
      [24_366, '[user] ← tool ok'],
      [26_957, '[assistant] All 5 concept pages done.'],
    ]
    const start = NOW - 30_000
    const s = scene({ fellows: [fellow({ agentId: 'a1', name: 'Ada', homeDomain: 'astronomy', state: 'active', run: run({ id: 'r1', kind: 'research-step', channel: 'c', label: 'T' }) })] })
    const seen = new Set<string>()
    for (let k = 1; k <= real.length; k++) {
      const lines = real.slice(0, k).map(([ms, message]) => ({ ts: new Date(start + ms).toISOString(), message }))
      const at = start + real[k - 1]![0]
      const actor = buildActors({ scene: s, lines: () => lines, exits: [], now: at }).find((a) => a.name === 'Ada')!
      seen.add(`${actor.room}/${actor.pose}`)
    }
    // Astronomy stands in Wing A, so a pose read off a single `Read` line would have taken
    // the figure out of the main room and back again mid-run.
    expect([...seen]).toEqual(['main/think', 'main/desk'])
  })

  it('shows exits for a few seconds and never beside a live twin', () => {
    const s = scene({ runs: [run({ id: 'r1', kind: 'research', channel: 'c', label: null })] })
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
    expect(actors.find((a) => a.id === 'exit:run:r0')).toMatchObject({ exiting: true, pose: 'shelve', caption: 'researcher (done)' })
    expect(actors.find((a) => a.id === 'exit:job:j9')).toMatchObject({ exiting: true, pose: 'wait', tag: 'warn' })
  })
})

/**
 * The progress figure in the bubble (docs/agents/ideas.md, "A percentage in every bubble").
 *
 * Three rules make an estimate honest, and each of them is a test here: the clock is coarse
 * and floored, the phase the run has REACHED anchors it, and it can neither fall back nor
 * reach a hundred.
 */
describe('the progress figure', () => {
  const at = (msAgo: number, message: string): { ts: string; message: string } => ({ ts: new Date(NOW - msAgo).toISOString(), message })
  const started = (msAgo: number): string => new Date(NOW - msAgo).toISOString()
  const TEN_MIN = 600_000
  const WRITING = [at(1_000, '→ Write({"file_path":"wiki/x.md"})')]
  const pct = (msAgo: number, lines = WRITING, typicalMs: number | null = TEN_MIN): number | null =>
    runPercent({ startedAt: started(msAgo), typicalMs, lines, now: NOW })

  it('reads the furthest phase the log ever showed, where the pose reads the recent one', () => {
    const lines = [at(9_000, '→ WebFetch({})'), at(6_000, '→ Write({})'), at(1_000, '→ Read({})')]
    // The figure walks back to the shelf to look something up; the number does not walk back.
    expect(steadyFamily(lines, NOW)).toBe('read')
    expect(furthestFamily(lines)).toBe('write')
    expect(furthestFamily([])).toBe('none')
    expect(furthestFamily([at(500, '[assistant] thinking about it')])).toBe('none')
    expect(furthestFamily([...lines, at(500, 'committed abc1234 (2 page(s))')])).toBe('commit')
  })

  it('is the clock against the kind, floored to ten', () => {
    expect(pct(360_000)).toBe(60)
    expect(pct(300_000)).toBe(50)
    // Floored, never rounded up: 59.8 % is not 60 %.
    expect(pct(359_000)).toBe(50)
  })

  it('never says less than ten and never reaches a hundred', () => {
    expect(pct(1_000)).toBe(PROGRESS_MIN)
    expect(pct(0)).toBe(PROGRESS_MIN)
    // Long past its median, and still short of the end: a bubble that says 100 and keeps
    // talking is worse than one that says 90. (With no phase cap in the way - the writing
    // cap holds its own runs lower still, which the next test pins.)
    expect(pct(TEN_MIN * 4, [])).toBe(90)
  })

  it('holds a reading run under half whatever the clock says', () => {
    const reading = [at(1_000, '→ WebFetch({"url":"x"})')]
    expect(pct(120_000, reading)).toBe(20)
    expect(pct(480_000, reading)).toBe(50)
    expect(pct(TEN_MIN * 3, reading)).toBe(50)
  })

  it('holds a writing run under 85, so it cannot run past the work', () => {
    expect(pct(TEN_MIN * 3)).toBe(80)
  })

  it('pins a committing run near the end, so a run that finished early jumps forward', () => {
    const committed = [at(9_000, '→ Write({})'), at(1_000, 'committed abc1234 (6 page(s))')]
    // Four minutes into a ten-minute median, but the last thing a run does has happened.
    expect(pct(240_000, committed)).toBe(90)
  })

  it('trusts the clock when the log says nothing, because a reload empties the buffer', () => {
    // Maintenance logs stream and are never persisted. Capping the unknown state at the
    // reading cap would drop a run from 80 % to 50 % on a page reload.
    expect(pct(480_000, [])).toBe(80)
  })

  it('says nothing when nothing honest can be said', () => {
    expect(pct(120_000, WRITING, null)).toBeNull()
    // A kind that is over before a number would mean anything keeps its plain caption.
    expect(pct(10_000, WRITING, PROGRESS_MIN_TYPICAL_MS - 1)).toBeNull()
    // A clock that is not a clock.
    expect(runPercent({ startedAt: 'not a date', typicalMs: TEN_MIN, lines: WRITING, now: NOW })).toBeNull()
    expect(pct(-60_000)).toBeNull()
  })

  it('reaches the bubble of a Fellow and of a visitor, and never of one that is only queued', () => {
    const s = scene({
      fellows: [
        fellow({ agentId: 'a1', name: 'Ada', state: 'active', run: { id: 'r1', kind: 'research', channel: 'ada', label: 'T', startedAt: started(360_000), waiting: false, typicalMs: TEN_MIN } }),
        fellow({ agentId: 'a2', name: 'Bo', state: 'active', run: { id: 'r2', kind: 'research', channel: 'bo', label: 'T', startedAt: started(360_000), waiting: true, typicalMs: TEN_MIN } }),
      ],
      runs: [{ id: 'r3', kind: 'research', channel: 'vis', label: null, startedAt: started(300_000), waiting: false, typicalMs: TEN_MIN }],
    })
    const actors = buildActors({
      scene: s,
      lines: (ch) => (ch === 'ada' || ch === 'vis' ? WRITING : []),
      exits: [],
      now: NOW,
    })
    const by = Object.fromEntries(actors.map((a) => [a.id, a]))
    expect(by['fellow:a1']?.caption).toBe('Ada (writing 60%)')
    expect(by['run:r3']?.caption).toBe('researcher (writing 50%)')
    // Queued behind the runner: it has not started, so there is nothing to be 10 % of.
    expect(by['fellow:a2']?.caption).toBe('Bo (waiting)')
  })
})

describe('exitOk', () => {
  it('calls a run failed only when its record says so', () => {
    expect(exitOk({ status: 'error' })).toBe(false)
    expect(exitOk({ status: 'done' })).toBe(true)
  })

  it('does not read a stale in-flight record as a failure', () => {
    /*
     * The run list is a separate poll with its own staleness, so a run that has just left
     * the scene is often still `running` there. Reading "not done" as failure put a red
     * "failed" tag on a planning run that was writing its result.
     */
    expect(exitOk({ status: 'running' })).toBe(true)
  })

  it('does not read a missing record as a failure either', () => {
    // Same evidence, same answer: nothing said is not the same as something went wrong.
    expect(exitOk(undefined)).toBe(true)
  })
})

/**
 * One run's lines out of a channel shared by every run of its kind.
 *
 * `maintenance:<kind>` is per kind, not per run, and nothing clears it. The progress cap reads
 * every line in the buffer on purpose, so without this a run inherited the furthest phase any
 * earlier run on that channel had reached - and a channel where anything ever committed made
 * every later run report its maximum from its first second.
 */
describe('a run reads only its own lines', () => {
  const line = (ts: string, message: string): { ts: string; level: 'info'; message: string } => ({ ts, level: 'info', message })
  const scene = (over: Partial<LibraryScene> = {}): LibraryScene =>
    ({
      generatedAt: '2026-09-10T00:00:00.000Z',
      night: true,
      window: { start: '23:00', end: '02:00' },
      rooms: [{ id: 'main', name: 'Main room', kind: 'main', position: 0, capacity: 8, shelves: [] }],
      departments: [],
      unfiled: 0,
      gaps: 0,
      fellows: [],
      runs: [],
      jobs: [],
      concurrency: 1,
      ...over,
    }) as LibraryScene

  const fellow = (over: Partial<SceneFellow> = {}): SceneFellow =>
    ({
      agentId: 'a1',
      name: 'Ada',
      homeDomain: 'astronomy',
      model: 'sonnet-5',
      state: 'active',
      sleepCode: null,
      sleepReason: null,
      skipUntil: null,
      next: null,
      lastActive: null,
      run: {
        id: 'r2',
        kind: 'research-step',
        channel: 'maintenance:research-step',
        label: null,
        startedAt: '2026-09-10T00:10:00.000Z',
        waiting: false,
        typicalMs: 300_000,
      },
      ...over,
    }) as SceneFellow

  it('does not inherit an earlier run\'s commit, and so does not start at its maximum', () => {
    const f = fellow()
    const actors = buildActors({
      scene: scene({ fellows: [f] }),
      // An earlier run on the same channel committed; this one has only just started reading.
      lines: () => [
        line('2026-09-10T00:05:00.000Z', 'committed 4 pages'),
        line('2026-09-10T00:10:05.000Z', '→ Read(wiki/index.md)'),
      ],
      exits: [],
      now: Date.parse('2026-09-10T00:10:30.000Z'),
    })
    const caption = actors.find((a) => a.id === 'fellow:a1')!.caption
    // 30 s of a 300 s run, read phase: 10 %, not the 95 % a stale commit would have claimed.
    expect(caption).toBe('Ada (reading 10%)')
  })

  it('still reads every line of its own run, window or not', () => {
    const f = fellow()
    const actors = buildActors({
      scene: scene({ fellows: [f] }),
      lines: () => [
        line('2026-09-10T00:09:00.000Z', '→ Write(wiki/concepts/Old.md)'),
        line('2026-09-10T00:10:01.000Z', '→ Write(wiki/concepts/New.md)'),
        line('2026-09-10T00:10:02.000Z', '→ Read(wiki/index.md)'),
      ],
      exits: [],
      now: Date.parse('2026-09-10T00:14:00.000Z'),
    })
    // The write inside this run still lifts the cap to 85; the one before it is not counted
    // twice and the one from the earlier run is not counted at all.
    expect(actors.find((a) => a.id === 'fellow:a1')!.caption).toContain('80%')
  })
})
