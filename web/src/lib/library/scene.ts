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
import { ANCHORS, DEFAULT_AISLES, shelfStand, type Aisles, type Tile } from './room.ts'

export type Pose = 'stand' | 'wait' | 'shelf' | 'desk' | 'shelve' | 'carry' | 'clipboard' | 'sleep' | 'think'
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
  /**
   * The shelf's own colour, for the dot the Fellow's bubble opens with. Set for Fellows only:
   * a clerk and a visiting run belong to no shelf, and a dot on their bubble would claim they
   * did. It is the same colour the card that a click on the bubble opens carries.
   */
  readonly dot?: string
  readonly tag: TagKind
  readonly agentId?: string
  readonly runId?: string
  readonly jobId?: string
  readonly channel?: string
  readonly exiting?: boolean
  /** The desk the figure stands at, by number, when it stands at one: the screen and the lamp follow it. */
  readonly desk?: number | undefined
  /** A Fellow's home domain: what its desk names under the pointer. */
  readonly domain?: string
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

/*
 * ── The progress figure in the bubble ──────────────────────────────────────────
 *
 * `Ada (writing 60%)`. There is no progress signal in an agent run - the SDK reports tool
 * calls, not a fraction of the work - so the number is an estimate, and three rules are what
 * make it an honest one.
 *
 * ONE, the clock against the kind's own median (server/src/pipeline/run-duration.ts). The
 * spread inside a kind is about a fifth of its middle, which is good enough for a word over
 * a figure and useless for a bar; hence steps of ten, never a precise figure.
 *
 * TWO, anchored on the phase the run has REACHED, so the clock cannot lie badly. A run still
 * reading is held under half whatever the clock says, one that has written under 85, and a
 * commit line pins it near the end. That turns a stopwatch into something that tracks the
 * work: a run that finishes early jumps forward instead of sitting at 40 while it commits.
 *
 * THREE, it never goes backwards and never reaches 100. Backwards is prevented by
 * construction rather than by remembering: the anchor is the FURTHEST family the log has
 * shown, which only ever climbs, and the clock only climbs too. 100 is prevented by the cap
 * plus the step - the highest thing this can ever say is 90, because a bubble that reaches
 * 100 and keeps talking is worse than one that says 90.
 */

/** Steps of ten: the figure is coarse on purpose, and the spread does not justify more. */
export const PROGRESS_STEP = 10

/** The lowest the figure goes. A run 20 seconds into ten minutes has still started. */
export const PROGRESS_MIN = 10

/** The ceiling before the step. With the step, the most that can ever be shown is 90. */
export const PROGRESS_MAX = 95

/**
 * Below this, a kind is over before a number would mean anything, and a figure that flashes
 * `30%` once and vanishes is noise. Those runs keep their plain caption.
 */
export const PROGRESS_MIN_TYPICAL_MS = 60_000

/**
 * How far the clock may carry the figure in each phase.
 *
 * `commit` is not in it because a commit does not cap the figure, it PINS it: the commit is
 * the last thing a run does, so it stands near the end whatever the clock says, and a run
 * that finished early jumps forward instead of sitting at 40 while it commits.
 *
 * `none` is not "nothing has happened" but "the log does not say" - maintenance run logs
 * stream and are never persisted, so a reload mid-run starts from an empty buffer. Capping
 * that state at the reading cap would drop a run from 80 to 50 on a page reload, which is
 * exactly the backwards step rule three forbids. Unknown therefore trusts the clock.
 */
export const PHASE_CAP: Record<Exclude<ToolFamily, 'commit'>, number> = { none: PROGRESS_MAX, read: 50, write: 85 }

const FAMILY_RANK: Record<ToolFamily, number> = { none: 0, read: 1, write: 2, commit: 3 }

/**
 * The furthest phase the log has EVER shown, over every line rather than a window - the
 * opposite reading from {@link steadyFamily}, which asks what the figure is doing now and
 * therefore has to forget. A run reads again after writing; the pose follows it back to the
 * shelf, the progress figure does not fall back with it.
 */
export function furthestFamily(lines: readonly LogLine[]): ToolFamily {
  let best: ToolFamily = 'none'
  for (const l of lines) {
    const f = toolFamily(l.message)
    if (FAMILY_RANK[f] > FAMILY_RANK[best]) best = f
  }
  return best
}

/**
 * The lines of ONE run out of the channel it shares with every other run of its kind.
 *
 * A channel is named `maintenance:<kind>` - per kind, not per run and not per Fellow - and
 * nothing ever clears it. So the buffer of `maintenance:plan` holds every planning run of the
 * session, and a Fellow starting one read the lines of the Fellows before it: the pose for the
 * 30 seconds of `steadyFamily`'s window, and the progress cap for good, since `furthestFamily`
 * deliberately reads every line rather than a window. On a channel where anything ever
 * committed that made each later run report its maximum from its first second.
 *
 * Cutting at the run's own start is the small half of the fix; the channel should carry the
 * run id (docs/tasks/TASKS-A7.md 5.1).
 */
function since(lines: readonly LogLine[], startedAt: string): readonly LogLine[] {
  const from = Date.parse(startedAt)
  if (!Number.isFinite(from)) return lines
  // Walk back from the newest and stop at the edge: the buffer holds up to 2000 lines.
  for (let k = lines.length - 1; k >= 0; k--) {
    const at = Date.parse(lines[k]!.ts)
    if (Number.isFinite(at) && at < from) return lines.slice(k + 1)
  }
  return lines
}

/** How far along a run in flight is, in steps of ten, or null when nothing honest can be said. */
export function runPercent(input: {
  readonly startedAt: string
  readonly typicalMs: number | null
  readonly lines: readonly LogLine[]
  readonly now: number
}): number | null {
  const typical = input.typicalMs
  if (typical === null || !Number.isFinite(typical) || typical < PROGRESS_MIN_TYPICAL_MS) return null
  const elapsed = input.now - Date.parse(input.startedAt)
  if (!Number.isFinite(elapsed) || elapsed < 0) return null
  const family = furthestFamily(input.lines)
  const raw = family === 'commit' ? PROGRESS_MAX : Math.min((elapsed / typical) * 100, PHASE_CAP[family])
  return Math.max(Math.floor(Math.min(raw, PROGRESS_MAX) / PROGRESS_STEP) * PROGRESS_STEP, PROGRESS_MIN)
}

/** `writing` plus the figure, when there is one: `writing 60%`. */
export const withPercent = (what: string, percent: number | null): string => (percent === null ? what : `${what} ${percent}%`)

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

/**
 * Whether a run that just left the room left having succeeded.
 *
 * Only a record that SAYS it failed is a failure. The run list is a separate poll with its
 * own staleness, so at the moment a run disappears from the scene its record is often still
 * the in-flight one - `status: 'running'` - and reading "not done" as failure told the room a
 * planning run had failed while it was writing its result.
 */
export function exitOk(run: { readonly status: string } | undefined): boolean {
  return run === undefined || run.status !== 'error'
}

export interface AdapterInput {
  readonly scene: LibraryScene
  /** The log lines of a channel, oldest first; the pose reads the recent ones (see {@link steadyFamily}). */
  readonly lines: (channel: string) => readonly LogLine[]
  readonly exits: readonly Exit[]
  readonly now: number
}

const VISITOR = '#8a95ad'

/** A room's two gaps, so a figure stands in front of the shelf as the room is arranged now. */
const aislesOf = (scene: LibraryScene, room: string): Aisles => {
  const r = scene.rooms.find((x) => x.id === room)
  return r === undefined ? DEFAULT_AISLES : { wall: r.wallAisle, mid: r.midAisle }
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
    const tile = shelfStand(s.kind, s.slot, aislesOf(scene, s.room))
    if (tile) return { room: s.room, tile }
  }
  const main = scene.rooms.find((r) => r.kind === 'main')
  const first = main?.shelves[0]
  if (first) {
    const tile = shelfStand('main', first.slot, aislesOf(scene, 'main'))
    if (tile) return { room: 'main', tile }
  }
  return { room: 'main', tile: ANCHORS.cartStand }
}

/** Which figure a run kind sends into the room; null = it draws nobody. */
export const roleOfRun = (kind: string): Role | null => {
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

/**
 * What a visiting run is doing, in two or three words.
 *
 * The bubble hangs in the drawing, over the furniture: every word costs a piece of the shelf
 * behind it. These used to run to half a sentence ("fixing what the inspection found"), which
 * is a caption for a report, not for a figure standing in a room.
 */
const RUN_CAPTION: Record<string, string> = {
  research: 'researching',
  'research-step': 'a short step',
  'research-expand': 'deepening pages',
  save: 'filing a chat',
  lint: 'checking shelves',
  'domain-review': 'reviewing wings',
  'lint-fix': 'fixing findings',
  repair: 'mending links',
  cleanup: 'clearing dead ends',
  'tag-fix': 'fixing labels',
  'domain-backfill': 'sorting new books',
  'hot-cache': 'renewing the board',
}

/** The noun on the figure - and the word its bubble opens with. */
export const ROLE_NAME: Record<Role, string> = {
  fellow: 'fellow',
  researcher: 'researcher',
  reader: 'reader',
  clerk: 'clerk',
  inspector: 'inspector',
  caretaker: 'caretaker',
}

/**
 * One shape for every bubble: `who (what)`. Fellows had it and visitors did not - they read
 * `researcher · reading`, a second punctuation for the same idea. One shape means one thing
 * to learn, and the parentheses keep the activity subordinate to the name.
 */
export const caption = (who: string, what: string): string => `${who} (${what})`

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
  clipboard: 'checking',
  sleep: 'asleep',
  think: 'thinking',
}

/**
 * A desk for someone who owns none: the visiting researcher, the clerk writing pages, a run
 * that failed. Counted from the far end of the rows, because the Fellows fill theirs from the
 * near end - so as long as the room is not full the two never meet, and when it is, a guest
 * shares the last Fellow's desk rather than the first's.
 */
const guestDeskNo = (n: number): number => ANCHORS.desks.length - 1 - (n % ANCHORS.desks.length)

function fellowActor(scene: LibraryScene, f: SceneFellow, index: number, input: AdapterInput): Actor | null {
  if (f.state === 'retired') return null
  /*
   * The shirt is the shelf's colour (2026-09-17), the same one the bubble's dot and the card
   * carry. It used to be a hue hashed from the id, which told the room nothing: a colour that
   * belongs to a department says whose work the figure is doing from across the room.
   */
  const color = domainColor(f.homeDomain)
  /*
   * A Fellow's own desk (2026-09-17): the same one whatever its state. It used to rest in an
   * armchair by the fire and work at whichever desk its index gave it, which moved every
   * figure across the room at every state change and put a resting Fellow nowhere in
   * particular. Now the desk IS the Fellow's place, and the pose says what it is doing there.
   *
   * The number comes from the record (given at spawn, kept until retirement), so a retirement
   * moves nobody. The index is only the fallback for a scene from a server that predates it.
   */
  const deskNo = (f.desk !== null && f.desk >= 0 ? f.desk : index) % ANCHORS.desks.length
  const seat = ANCHORS.desks[deskNo]!
  const base = { id: `fellow:${f.agentId}`, role: 'fellow' as const, name: f.name, color, agentId: f.agentId, dot: color, desk: deskNo, domain: f.homeDomain }
  if (f.run) {
    /*
     * A run exists from the moment it is requested, but one runner executes one run at a
     * time - so a Fellow whose run is still queued was drawn reading and writing at its
     * shelf while another Fellow held the runner. It waits, and now it looks like it: the
     * chair, not the shelf, and no pose read off a log that has no lines yet.
     */
    if (f.run.waiting) return { ...base, caption: caption(f.name, 'waiting'), pose: 'wait', room: 'main', i: seat.i, j: seat.j, tag: 'fellow', runId: f.run.id, channel: f.run.channel }
    const lines = since(input.lines(f.run.channel), f.run.startedAt)
    const family = steadyFamily(lines, input.now)
    const planning = f.run.kind === 'plan'
    const pose: Pose = planning ? 'think' : poseForFamily(family)
    const percent = runPercent({ startedAt: f.run.startedAt, typicalMs: f.run.typicalMs, lines, now: input.now })
    const cap = caption(f.name, withPercent(planning ? 'planning' : POSE_CAPTION[pose], percent))
    if (pose === 'shelf' || pose === 'shelve') {
      const place = shelfPlace(scene, f.homeDomain)
      // Away from the desk for the moment, so it carries no desk: the screen there goes dark.
      return { ...base, desk: undefined, caption: cap, pose, room: place.room, i: place.tile.i, j: place.tile.j, book: domainColor(f.homeDomain), tag: 'fellow', runId: f.run.id, channel: f.run.channel }
    }
    return { ...base, caption: cap, pose, room: 'main', i: seat.i, j: seat.j, tag: 'fellow', runId: f.run.id, channel: f.run.channel }
  }
  switch (f.state) {
    case 'sleeping': {
      // A failed planner is a fault, not a quiet night: it reads as a warning like quota does.
      const warn = f.sleepCode === 'quota' || f.sleepCode === 'budget' || f.sleepCode === 'plan-failed'
      /*
       * The codes used to be shown as they are: "covered" and "idle" say nothing about why a
       * Fellow is sitting down. Each is now the short sentence it stands for - still two or
       * three words, because the bubble is small, but words a reader can act on.
       */
      const reason =
        f.sleepCode === 'quota'
          ? 'out of quota'
          : f.sleepCode === 'budget'
            ? 'out of budget'
            : f.sleepCode === 'plan-failed'
              ? 'plan failed'
              : f.sleepCode === 'covered'
                ? 'topic taken'
                : f.sleepCode === 'stalled'
                  ? 'no progress'
                  : f.sleepCode === 'no-candidates'
                    ? 'nothing to plan'
                    : 'asleep'
      return { ...base, caption: caption(f.name, reason), pose: 'sleep', room: 'main', i: seat.i, j: seat.j, tag: warn ? 'warn' : 'asleep' }
    }
    case 'waiting':
      return { ...base, caption: caption(f.name, f.next ? 'ready' : 'waiting'), pose: 'stand', room: 'main', i: seat.i, j: seat.j, tag: 'fellow' }
    case 'paused':
      return { ...base, caption: caption(f.name, 'paused'), pose: 'stand', room: 'main', i: seat.i, j: seat.j, tag: 'asleep' }
    case 'blocked':
      return { ...base, caption: caption(f.name, 'blocked'), pose: 'wait', room: 'main', i: seat.i, j: seat.j, tag: 'warn' }
    case 'proposed':
      return { ...base, caption: caption(f.name, 'new'), pose: 'wait', room: 'main', i: seat.i, j: seat.j, tag: 'fellow' }
    case 'active':
      // Between two steps of a shift the run is gone for a moment. The Fellow stays at its
      // desk and thinks; sending it to the door and back would be a jump across the room.
      return { ...base, caption: caption(f.name, 'thinking'), pose: 'think', room: 'main', i: seat.i, j: seat.j, tag: 'fellow' }
    default:
      return { ...base, desk: undefined, caption: caption(f.name, f.state), pose: 'stand', room: 'main', i: ANCHORS.door.i, j: ANCHORS.door.j, tag: 'fellow' }
  }
}

function runActor(scene: LibraryScene, r: SceneRun, index: number, input: AdapterInput): Actor | null {
  const role = roleOfRun(r.kind)
  if (role === null) return null
  const lines = since(input.lines(r.channel), r.startedAt)
  const family = steadyFamily(lines, input.now)
  const base = { id: `run:${r.id}`, role, color: VISITOR, tag: 'visitor' as const, runId: r.id, channel: r.channel, room: 'main' }
  const percent = runPercent({ startedAt: r.startedAt, typicalMs: r.typicalMs, lines, now: input.now })
  const what = withPercent(RUN_CAPTION[r.kind] ?? r.kind, percent)
  if (role === 'researcher') {
    const pose = poseForFamily(family)
    const doing = withPercent(POSE_CAPTION[pose], percent)
    if (pose === 'shelf' || pose === 'shelve') {
      const place = shelfPlace(scene, null)
      return { ...base, name: 'visiting researcher', caption: caption('researcher', doing), pose, room: place.room, i: place.tile.i, j: place.tile.j, book: '#2f62c9' }
    }
    const g = guestDeskNo(index)
    const desk = ANCHORS.desks[g]!
    return { ...base, name: 'visiting researcher', caption: caption('researcher', doing), pose, i: desk.i, j: desk.j, desk: g }
  }
  /*
   * Everyone who is not a Fellow and not writing works at the book cart (2026-09-17): the
   * reader filing a chat, the inspector with its clipboard, the caretaker sorting. It is the
   * one station in the room for the maintenance runs, and clicking it opens System, where
   * they are started - so a figure standing there points at where its run came from.
   */
  if (role === 'reader') return { ...base, name: 'reader', caption: caption('reader', what), pose: 'stand', i: ANCHORS.cartStand.i + 0.55, j: ANCHORS.cartStand.j + 0.45 }
  if (role === 'inspector') return { ...base, name: 'inspector', caption: caption('inspector', what), pose: 'clipboard', i: ANCHORS.cartStand.i, j: ANCHORS.cartStand.j }
  if (r.kind === 'hot-cache') return { ...base, name: 'caretaker', caption: caption('caretaker', what), pose: 'stand', i: ANCHORS.noticeBoard.i, j: ANCHORS.noticeBoard.j }
  return { ...base, name: 'caretaker', caption: caption('caretaker', what), pose: 'shelf', i: ANCHORS.cartStand.i, j: ANCHORS.cartStand.j, book: '#b8892c' }
}

function jobActor(scene: LibraryScene, job: SceneJob, index: number, queued: number, input: AdapterInput): Actor | null {
  const base = { id: `job:${job.id}`, role: 'clerk' as const, name: 'clerk', color: VISITOR, tag: 'visitor' as const, jobId: job.id, room: 'main' }
  if (job.status === 'queued') {
    if (queued >= ANCHORS.cartQueue.length) return null
    const q = ANCHORS.cartQueue[queued]!
    return { ...base, id: `parcel:${job.id}`, name: 'parcel', caption: caption(job.name, 'queued'), pose: 'wait', i: q.i, j: q.j }
  }
  if (job.status === 'preprocessing') return { ...base, caption: caption('clerk', 'unpacking'), pose: 'carry', i: ANCHORS.cartStand.i - 0.5 - index * 0.5, j: ANCHORS.cartStand.j + 0.3 }
  const family = steadyFamily(input.lines(job.id), input.now)
  if (family === 'write') {
    // Behind the visiting researchers' guest desks, so two clerks and a researcher never share one.
    const g = guestDeskNo(2 + index)
    const desk = ANCHORS.desks[g]!
    return { ...base, caption: caption('clerk', 'writing pages'), pose: 'desk', i: desk.i, j: desk.j, desk: g }
  }
  if (family === 'commit') {
    const place = shelfPlace(scene, null)
    return { ...base, caption: caption('clerk', 'shelving'), pose: 'shelve', room: place.room, i: place.tile.i, j: place.tile.j, book: '#b8892c' }
  }
  // To the left of the cart's own stand, so a clerk and an inspector never share a tile.
  return { ...base, caption: caption('clerk', 'reading'), pose: 'shelf', i: ANCHORS.cartStand.i - 0.85 - index * 0.5, j: ANCHORS.cartStand.j + 0.35, book: '#b8892c' }
}

function exitActor(scene: LibraryScene, e: Exit): Actor | null {
  // A Fellow leaves in its shelf's colour, like it arrived; a visitor in grey.
  const owner = e.role === 'fellow' && e.agentId !== undefined ? scene.fellows.find((f) => f.agentId === e.agentId) : undefined
  const base = { id: `exit:${e.kind}:${e.id}`, exiting: true, color: owner ? domainColor(owner.homeDomain) : VISITOR, tag: e.ok ? ('visitor' as const) : ('warn' as const), room: 'main' }
  if (!e.ok) {
    const g = guestDeskNo(0)
    const desk = ANCHORS.desks[g]!
    return { ...base, role: e.role, name: e.name, caption: caption(e.name, 'failed'), pose: 'wait', i: desk.i, j: desk.j, desk: g }
  }
  const place = shelfPlace(scene, null)
  return { ...base, role: e.role, name: e.name, caption: caption(e.name, 'done'), pose: 'shelve', room: place.room, i: place.tile.i + 0.5, j: place.tile.j, book: '#2f62c9' }
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

/**
 * Which desks are at work, by number: the screen there is on and, at night, the lamp is lit.
 * A desk is at work when a figure standing at it is in a run or between two steps of one
 * (thinking), or a guest is writing there. A sleeping Fellow's desk and an empty one stay
 * dark, so the room says at a glance who is busy. An exit is over, so it lights nothing.
 */
export function busyDesks(actors: readonly Actor[], room: string): Set<number> {
  const out = new Set<number>()
  for (const a of actors) {
    if (a.room !== room || a.desk === undefined || a.exiting === true) continue
    if (a.runId !== undefined || a.pose === 'think' || a.pose === 'desk') out.add(a.desk)
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
