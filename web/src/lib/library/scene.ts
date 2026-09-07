/**
 * The scene adapter (docs/agents/SPEC.md sections 10.2 and 10.3): every activity the
 * service reports becomes an actor with an identity, a pose, a place and an exit. Fellows
 * are residents (named figures), runs without a Fellow are visitors by kind, jobs are the
 * acquisition clerk. The pose follows the tool family the run has been in RECENTLY, not the
 * single newest line: an agent logs `→ Write(…)` and `← tool ok` 20 ms apart, and a pose read
 * off the last line alone made the figure flicker between two poses - and, when reading sent
 * it to a shelf in another wing, vanish from the room for those milliseconds. Job states
 * override; a settled activity keeps its figure for a few seconds in its exit pose.
 * Pure: the tests feed it snapshots and log lines.
 */

import type { LibraryScene, SceneFellow, SceneJob, SceneRun } from '../../api/types.ts'
import { domainColor } from '../domains.ts'
import { ANCHORS, shelfStand, type Tile } from './room.ts'

export type Pose = 'stand' | 'wait' | 'shelf' | 'desk' | 'shelve' | 'carry' | 'cart' | 'clipboard' | 'sit' | 'sleep' | 'think'
export type Role = 'fellow' | 'researcher' | 'reader' | 'clerk' | 'inspector' | 'caretaker'
export type TagKind = 'fellow' | 'visitor' | 'asleep' | 'warn'

export interface Actor {
  readonly id: string
  readonly role: Role
  readonly name: string
  /** What the tag says: `Ada · at the shelf`. */
  readonly caption: string
  readonly pose: Pose
  /** The room the figure stands in (`main` or a wing id). */
  readonly room: string
  readonly i: number
  readonly j: number
  readonly color: string
  /** The book in hand for the shelf poses: the department's color. */
  readonly book?: string
  readonly tag: TagKind
  readonly agentId?: string
  readonly runId?: string
  readonly jobId?: string
  readonly channel?: string
  readonly exiting?: boolean
}

export type ToolFamily = 'read' | 'write' | 'commit' | 'none'

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'LS', 'Bash']
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

/** The tool family of one formatted log line (`→ Read({...})`, `committed abc123`). */
export function toolFamily(message: string | null): ToolFamily {
  if (message === null) return 'none'
  if (/\bcommitted\b|\bcommit\b.*\bpage/i.test(message)) return 'commit'
  const m = /(?:→|->)\s*([A-Za-z]+)\(/.exec(message)
  if (!m) return 'none'
  const tool = m[1]!
  if (WRITE_TOOLS.includes(tool)) return 'write'
  if (READ_TOOLS.includes(tool)) return 'read'
  return 'none'
}

export function poseForFamily(family: ToolFamily): Pose {
  switch (family) {
    case 'read':
      return 'shelf'
    case 'write':
      return 'desk'
    case 'commit':
      return 'shelve'
    default:
      return 'think'
  }
}

/** A log line as the adapter reads it: when it arrived and what it said. */
export interface LogLine {
  readonly ts: string
  readonly message: string
}

/** How far back a figure's pose looks. Long enough that one stray tool call cannot move it. */
export const POSE_WINDOW_MS = 30_000
/** A commit closes a run; while it is this fresh it takes the pose whatever else happened. */
export const COMMIT_HOLD_MS = 8_000

const FAMILIES = ['read', 'write'] as const

/**
 * What a run has been doing lately, as one family. The lines that carry no tool at all -
 * the model's prose, `← tool ok`, the usage notes - say nothing about the pose and are
 * skipped rather than read as idleness. Of what is left inside the window the family with
 * the most lines wins, so a phase of writing is not broken by a single lookup in between,
 * and a tie keeps the one that started earlier: a new family has to outweigh the old one
 * before the figure moves, which is what stops it hopping between rooms. A fresh commit
 * outranks all of it - it is the closing act of a run, and rare enough to stay calm.
 */
export function steadyFamily(lines: readonly LogLine[], now: number): ToolFamily {
  const counts: Record<'read' | 'write', number> = { read: 0, write: 0 }
  const first: Record<'read' | 'write', number> = { read: Infinity, write: Infinity }
  let commit = false
  // The buffer holds up to a couple of thousand lines per channel and this runs on every one
  // of them, so walk back from the newest and stop at the edge of the window.
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k]!
    const at = Date.parse(line.ts)
    if (Number.isNaN(at)) continue
    if (now - at > POSE_WINDOW_MS) break
    const family = toolFamily(line.message)
    if (family === 'none') continue
    // A commit is a moment, not a phase: it holds the pose while it is fresh and counts for
    // nothing once it is old, so the run's next line takes over instead of a stale shelving.
    if (family === 'commit') {
      if (now - at <= COMMIT_HOLD_MS) commit = true
      continue
    }
    counts[family]++
    first[family] = Math.min(first[family], at)
  }
  if (commit) return 'commit'
  const top = Math.max(counts.read, counts.write)
  if (top === 0) return 'none'
  return FAMILIES.filter((f) => counts[f] === top).reduce((a, b) => (first[b] < first[a] ? b : a))
}

/** A settled activity the screen still shows in its exit pose. */
export interface Exit {
  readonly id: string
  readonly kind: 'run' | 'job'
  readonly ok: boolean
  readonly name: string
  readonly role: Role
  readonly at: number
  readonly agentId?: string
}

export const EXIT_MS = 6000

export interface AdapterInput {
  readonly scene: LibraryScene
  /** The log lines of a channel, oldest first; the pose reads the recent ones (see {@link steadyFamily}). */
  readonly lines: (channel: string) => readonly LogLine[]
  readonly exits: readonly Exit[]
  readonly now: number
}

const VISITOR = '#8a95ad'

const fellowColor = (agentId: string): string => {
  let h = 0
  for (let k = 0; k < agentId.length; k++) h = (h * 31 + agentId.charCodeAt(k)) >>> 0
  return `hsl(${h % 360} 48% 46%)`
}

function shelfOf(scene: LibraryScene, domain: string): { room: string; kind: 'main' | 'wing'; slot: number } | null {
  const d = scene.departments.find((x) => x.domain === domain)
  if (!d || d.room === null || d.slot === null) return null
  return { room: d.room, kind: d.room === 'main' ? 'main' : 'wing', slot: d.slot }
}

/** A place at a shelf in the department's room, or the main room's first favorite, or the catalog. */
function shelfPlace(scene: LibraryScene, domain: string | null): { room: string; tile: Tile } {
  const s = domain !== null ? shelfOf(scene, domain) : null
  if (s) {
    const tile = shelfStand(s.kind, s.slot)
    if (tile) return { room: s.room, tile }
  }
  const main = scene.rooms.find((r) => r.kind === 'main')
  const first = main?.shelves[0]
  if (first) {
    const tile = shelfStand('main', first.slot)
    if (tile) return { room: 'main', tile }
  }
  return { room: 'main', tile: ANCHORS.catalog }
}

const roleOfRun = (kind: string): Role | null => {
  switch (kind) {
    case 'research':
    case 'research-step':
    case 'research-expand':
      return 'researcher'
    case 'save':
      return 'reader'
    case 'lint':
    case 'domain-review':
      return 'inspector'
    case 'lint-fix':
    case 'repair':
    case 'cleanup':
    case 'tag-fix':
    case 'domain-backfill':
    case 'hot-cache':
      return 'caretaker'
    default:
      return null
  }
}

const RUN_CAPTION: Record<string, string> = {
  research: 'researching',
  'research-step': 'a research step',
  'research-expand': 'deepening pages',
  save: 'saving a conversation',
  lint: 'inspecting the shelves',
  'domain-review': 'reviewing departments',
  'lint-fix': 'fixing what the inspection found',
  repair: 'repairing the graph',
  cleanup: 'removing dead references',
  'tag-fix': 'relabelling',
  'domain-backfill': 'moving books between departments',
  'hot-cache': 'renewing the notice board',
}

/**
 * What the bubble over a figure says, in one word: it hangs in the drawing, where a
 * sentence covers the furniture behind it. `Ada (planning)` reads at a glance.
 */
const POSE_CAPTION: Record<Pose, string> = {
  stand: 'here',
  wait: 'waiting',
  shelf: 'reading',
  desk: 'writing',
  shelve: 'shelving',
  carry: 'unpacking',
  cart: 'sorting',
  clipboard: 'checking',
  sit: 'resting',
  sleep: 'asleep',
  think: 'thinking',
}

function fellowActor(scene: LibraryScene, f: SceneFellow, index: number, input: AdapterInput): Actor | null {
  if (f.state === 'retired') return null
  const color = fellowColor(f.agentId)
  const base = { id: `fellow:${f.agentId}`, role: 'fellow' as const, name: f.name, color, agentId: f.agentId }
  if (f.run) {
    const family = steadyFamily(input.lines(f.run.channel), input.now)
    const planning = f.run.kind === 'plan'
    const pose: Pose = planning ? 'think' : poseForFamily(family)
    const caption = `${f.name} (${planning ? 'planning' : POSE_CAPTION[pose]})`
    if (pose === 'shelf' || pose === 'shelve') {
      const place = shelfPlace(scene, f.homeDomain)
      return { ...base, caption, pose, room: place.room, i: place.tile.i, j: place.tile.j, book: domainColor(f.homeDomain), tag: 'fellow', runId: f.run.id, channel: f.run.channel }
    }
    const desk = ANCHORS.desks[index % ANCHORS.desks.length]!
    return { ...base, caption, pose, room: 'main', i: desk.i, j: desk.j, tag: 'fellow', runId: f.run.id, channel: f.run.channel }
  }
  const chair = ANCHORS.armchairs[index % ANCHORS.armchairs.length]!
  const overflow = Math.floor(index / ANCHORS.armchairs.length)
  const seat: Tile = { i: chair.i + overflow * 0.6, j: chair.j + overflow * 0.4 }
  switch (f.state) {
    case 'sleeping': {
      // A failed planner is a fault, not a quiet night: it reads as a warning like quota does.
      const warn = f.sleepCode === 'quota' || f.sleepCode === 'budget' || f.sleepCode === 'plan-failed'
      const reason =
        f.sleepCode === 'quota'
          ? 'quota'
          : f.sleepCode === 'budget'
            ? 'budget'
            : f.sleepCode === 'plan-failed'
              ? 'failed'
              : f.sleepCode === 'covered'
                ? 'covered'
                : f.sleepCode === 'stalled'
                  ? 'stalled'
                  : f.sleepCode === 'no-candidates'
                    ? 'idle'
                    : 'asleep'
      return { ...base, caption: `${f.name} (${reason})`, pose: 'sleep', room: 'main', i: seat.i, j: seat.j, tag: warn ? 'warn' : 'asleep' }
    }
    case 'waiting':
      return { ...base, caption: `${f.name} (${f.next ? 'ready' : 'waiting'})`, pose: 'sit', room: 'main', i: seat.i, j: seat.j, tag: 'fellow' }
    case 'paused':
      return { ...base, caption: `${f.name} (paused)`, pose: 'sit', room: 'main', i: seat.i, j: seat.j, tag: 'asleep' }
    case 'blocked': {
      const desk = ANCHORS.desks[index % ANCHORS.desks.length]!
      return { ...base, caption: `${f.name} (blocked)`, pose: 'wait', room: 'main', i: desk.i, j: desk.j, tag: 'warn' }
    }
    case 'proposed': {
      const q = ANCHORS.frontDeskQueue[index % ANCHORS.frontDeskQueue.length]!
      return { ...base, caption: `${f.name} (new)`, pose: 'wait', room: 'main', i: q.i, j: q.j, tag: 'fellow' }
    }
    case 'active': {
      // Between two steps of a shift the run is gone for a moment. The Fellow stays at its
      // desk and thinks; sending it to the door and back would be a jump across the room.
      const desk = ANCHORS.desks[index % ANCHORS.desks.length]!
      return { ...base, caption: `${f.name} (thinking)`, pose: 'think', room: 'main', i: desk.i, j: desk.j, tag: 'fellow' }
    }
    default:
      return { ...base, caption: `${f.name} (${f.state})`, pose: 'stand', room: 'main', i: ANCHORS.door.i, j: ANCHORS.door.j, tag: 'fellow' }
  }
}

function runActor(scene: LibraryScene, r: SceneRun, index: number, input: AdapterInput): Actor | null {
  const role = roleOfRun(r.kind)
  if (role === null) return null
  const family = steadyFamily(input.lines(r.channel), input.now)
  const base = { id: `run:${r.id}`, role, color: VISITOR, tag: 'visitor' as const, runId: r.id, channel: r.channel, room: 'main' }
  const what = RUN_CAPTION[r.kind] ?? r.kind
  if (role === 'researcher') {
    const pose = poseForFamily(family)
    if (pose === 'shelf' || pose === 'shelve') {
      const place = shelfPlace(scene, null)
      return { ...base, name: 'visiting researcher', caption: `researcher · ${POSE_CAPTION[pose]}`, pose, room: place.room, i: place.tile.i, j: place.tile.j, book: '#2f62c9' }
    }
    const desk = ANCHORS.desks[(3 - index + ANCHORS.desks.length) % ANCHORS.desks.length]!
    return { ...base, name: 'visiting researcher', caption: `researcher · ${POSE_CAPTION[pose]}`, pose, i: desk.i, j: desk.j }
  }
  if (role === 'reader') return { ...base, name: 'reader', caption: `reader · ${what}`, pose: 'sit', i: ANCHORS.readingTable.i, j: ANCHORS.readingTable.j }
  if (role === 'inspector') {
    const place = shelfPlace(scene, null)
    return { ...base, name: 'inspector', caption: `inspector · ${what}`, pose: 'clipboard', room: place.room, i: place.tile.i + 0.9, j: place.tile.j + 0.2 }
  }
  if (r.kind === 'hot-cache') return { ...base, name: 'caretaker', caption: `caretaker · ${what}`, pose: 'stand', i: ANCHORS.noticeBoard.i, j: ANCHORS.noticeBoard.j }
  return { ...base, name: 'caretaker', caption: `caretaker · ${what}`, pose: 'cart', i: ANCHORS.intake.i - 0.6, j: ANCHORS.intake.j + 0.5 }
}

function jobActor(scene: LibraryScene, job: SceneJob, index: number, queued: number, input: AdapterInput): Actor | null {
  const base = { id: `job:${job.id}`, role: 'clerk' as const, name: 'clerk', color: VISITOR, tag: 'visitor' as const, jobId: job.id, room: 'main' }
  if (job.status === 'queued') {
    if (queued >= ANCHORS.frontDeskQueue.length) return null
    const q = ANCHORS.frontDeskQueue[queued]!
    return { ...base, id: `parcel:${job.id}`, name: 'parcel', caption: `${job.name} · queued`, pose: 'wait', i: q.i, j: q.j }
  }
  if (job.status === 'preprocessing') return { ...base, caption: `clerk · unpacking ${job.name}`, pose: 'carry', i: ANCHORS.frontDesk.i + 0.6, j: ANCHORS.frontDesk.j + 0.6 + index * 0.5 }
  const family = steadyFamily(input.lines(job.id), input.now)
  if (family === 'write') {
    const desk = ANCHORS.desks[(2 - index + ANCHORS.desks.length) % ANCHORS.desks.length]!
    return { ...base, caption: `clerk · writing pages for ${job.name}`, pose: 'desk', i: desk.i, j: desk.j }
  }
  if (family === 'commit') {
    const place = shelfPlace(scene, null)
    return { ...base, caption: `clerk · shelving ${job.name}`, pose: 'shelve', room: place.room, i: place.tile.i, j: place.tile.j, book: '#b8892c' }
  }
  return { ...base, caption: `clerk · reading ${job.name}`, pose: 'shelf', i: ANCHORS.intake.i + 0.4, j: ANCHORS.intake.j + 0.9 + index * 0.5, book: '#b8892c' }
}

function exitActor(scene: LibraryScene, e: Exit): Actor | null {
  if (e.at + EXIT_MS < Date.now() && false) return null
  const base = { id: `exit:${e.kind}:${e.id}`, exiting: true, color: e.role === 'fellow' ? fellowColor(e.agentId ?? e.id) : VISITOR, tag: e.ok ? ('visitor' as const) : ('warn' as const), room: 'main' }
  if (!e.ok) {
    const desk = ANCHORS.desks[0]!
    return { ...base, role: e.role, name: e.name, caption: `${e.name} · failed, book left on the desk`, pose: 'wait', i: desk.i, j: desk.j }
  }
  const place = shelfPlace(scene, null)
  return { ...base, role: e.role, name: e.name, caption: `${e.name} · done, shelving`, pose: 'shelve', room: place.room, i: place.tile.i + 0.5, j: place.tile.j, book: '#2f62c9' }
}

/** Every figure on the floor right now, every room included. */
export function buildActors(input: AdapterInput): Actor[] {
  const { scene } = input
  const out: Actor[] = []
  const fellows = [...scene.fellows].filter((f) => f.state !== 'retired')
  fellows.forEach((f, idx) => {
    const a = fellowActor(scene, f, idx, input)
    if (a) out.push(a)
  })
  scene.runs.forEach((r, idx) => {
    const a = runActor(scene, r, idx, input)
    if (a) out.push(a)
  })
  let queued = 0
  let working = 0
  for (const job of scene.jobs) {
    const a = jobActor(scene, job, working, queued, input)
    if (!a) continue
    if (job.status === 'queued') queued++
    else working++
    if (job.status !== 'queued' && working > scene.concurrency + 1) continue
    out.push(a)
  }
  const live = new Set(out.map((a) => a.runId ?? a.jobId).filter((x): x is string => x !== undefined))
  for (const e of input.exits) {
    if (input.now - e.at > EXIT_MS || live.has(e.id)) continue
    const a = exitActor(scene, e)
    if (a) out.push(a)
  }
  return out
}

/** One line for the now chip: who is on the floor. */
export function floorLine(actors: readonly Actor[]): string {
  const fellowsAtWork = actors.filter((a) => a.role === 'fellow' && !a.exiting && (a.pose === 'shelf' || a.pose === 'desk' || a.pose === 'shelve' || a.pose === 'think')).length
  const visitors = actors.filter((a) => a.role !== 'fellow' && !a.exiting && a.name !== 'parcel').length
  const parts: string[] = []
  if (fellowsAtWork > 0) parts.push(`${fellowsAtWork} Fellow${fellowsAtWork === 1 ? '' : 's'} at work`)
  if (visitors > 0) parts.push(`${visitors} visitor${visitors === 1 ? '' : 's'}`)
  return parts.length > 0 ? parts.join(', ') : 'quiet'
}
