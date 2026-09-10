# TASKS-A7 - Fellow command centre (2026-09-09)

Goal: one window in the Library that manages the Fellows completely, so the docked Fellow
card can be retired. Opened like a shelf window, over the room, in the same frame. Design
worked out in mockup iterations v1-v7; this file carries the decisions and the open items.

Extension milestone in the Curious fork (branch `research-agents`), behind `AGENTS_ENABLED=1`.

## 0. Decisions from the design rounds

- **D1 - domain-grouped, with one stop past the end.** The rotation covers the domains that
  currently have a Fellow; one further stop lists the shelves that have nobody, sorted by
  what is unanswered there rather than by size. Without it a domain with no Fellow could
  never be staffed from inside the window.
- **D2 - Tonight first, dossier second.** The window opens on the night, not on a list.
  Selecting a Fellow opens its dossier; Escape steps back one level, like the shelf window.
- **D3 - one list of Fellows, not two.** A request is a property of a Fellow, not a
  collection of its own. The card carries a link (`3 open decisions ›`), never the request
  itself.
- **D4 - decisions get their own overlay.** A reasoned choice needs room: the rationale, the
  provenance (which candidate the idea came from and on which page it was read), the scope
  score, and several ranked options per Fellow. Arrow keys move between Fellows with open
  decisions, across domains, because the count in the header is global.
- **D5 - budget in tasks, not runs.** "A task is one piece of research: read the sources,
  write or extend a page, update the notebook."
- **D6 - the night window is a slider.** It sits above the schedule, on an 18-hour scale, and
  both ends drag. It is the same object at two resolutions, not two controls.
- **D7 - presets are worked examples, not types.** Naming a Fellow after the art of its first
  task is a category error: the art belongs to a **task**, the configuration (quota, model,
  effort, step depth, lens, week share, autonomy) belongs to the **Fellow**, and neither of
  the two Fellows in the vault is any one art. Each preset therefore ships a complete task
  list, at least one mixes arts, and the UI says they are examples to take and change.
- **D8 - full sweep is the default.** Every standing task is worked every night, so every
  night produces a result. Configurable down to round-robin (one task a night, rotating),
  which is today's behaviour and means each task comes round every third night.
- **D9 - the schedule is one night, not one domain.** Every Fellow shares one window and the
  runs are serialized on the run mutex, so a per-domain schedule would show four domains
  each fitting comfortably into a night that cannot hold their sum.

- **D10 - a Fellow appears at its `homeDomain` only.** `extraDomains` shows in the dossier as
  an aside. One appearance per Fellow, so the night's arithmetic cannot double-count, and the
  field keeps the job it already has: `targetFor` reads it when routing a handoff.
- **D11 - unclaimed handoffs live on the unstaffed-shelves screen.** An unclaimed handoff is a
  question with no Fellow responsible for it, which is the statement that screen already
  makes; the spawn button next to it is the answer.
- **D12 - the reading list stays where it is.** It is cross-domain and belongs to the user
  rather than to any Fellow - the same reasoning that keeps the recap wall board whole. The
  command centre links to it at most.
- **D13 - the representative mockup is real components behind a flag.** Built in the repo,
  reachable at a URL, fed fixture data. "A mockup must match the final render" is then true by
  construction rather than by care, and the distance to the implementation is one data source.

## 1. Open item: skip the planning run for a deepen task

**Not specified, not built. Needs its own design pass and measurement before it is written.**

`rankForDeepening` already chooses the pages deterministically - theme overlap, then
backlinks per kilobyte, capped at `EXPAND_MAX_PAGES = 4`. For a deepen task the planner
therefore does much less than for the other two arts: the `kind` enum is exactly
`['research-expand']`, the page set is handed to it, and what is left is phrasing a topic and
picking among at most four pages that are already ranked.

If that can be built deterministically, a deepen task costs one planning run less: measured
median 86 s and $0.55 of a fellow-night that runs about 20 min and $8.14 with three tasks.

**Why it is worth doing separately rather than as part of the command centre:** it changes
what a Fellow proposes, not how the user sees it, and it removes a model from a decision it
currently makes. That is a behaviour change with its own risk, and it deserves its own
before/after comparison on real themes.

**What a specification has to settle first:**

- What the topic line reads like when nobody writes it. The synthesis page title is derived
  from it (`Research: <topic><lens suffix>`), so a mechanical topic becomes a page name.
- Whether the rationale can be written deterministically at all. The decisions overlay shows
  it, and "the four thinnest pages matching this theme" may be a worse reason than one a
  planner would give - or a better one, because it is checkable.
- Whether the Fellow still gets to choose the lens for a deepening, or inherits its default.
- What happens when the ranking returns fewer than four pages, or exactly one.
- Whether a deepen task without a planning run still counts as a proposal the user decides
  on, or becomes standing work that runs unasked.

**How it would be measured:** run both paths over the same themes on the real vault, compare
the page sets, the resulting titles and what the run wrote. A saving of $0.55 is not worth a
worse choice of pages.

**Rejected on the way here (2026-09-09):** merging one planning run across all three tasks.
It looked like the cheaper version of the same saving, but `plannerSchema` enforces the
per-task constraints as JSON-Schema enums - `kind` is exactly `['research-expand']` for a
deepen task, `candidate` is the pool computed for that task, and `deepenPages` is the only
page set the prompt names. A merged run has to widen `kind` to the union, so nothing
structurally stops a `research-expand` proposal for a watch task, or a page set the theme
never ranked. `provenance.task` would become a guess. It also puts all three tasks behind one
`PLAN_ATTEMPTS = 2` budget, so one unusable answer costs the whole night. Measured saving:
2.3 min and $0.85 per fellow-night, about half a Fellow of capacity - not worth trading an
enforced constraint for a hoped-for one.

## 1b. Open item: an intra-domain handoff between the arts

**Not specified, not built.** It is the precondition for a design that was considered and set
aside on 2026-09-09: giving each Fellow a single art (a watcher holds only watch tasks, a
librarian only deepen tasks), which is cleaner in several ways - the name stops being a
category error, `kindsForTask` lifts from the task to the Fellow, one honest default lens per
Fellow, and a decision compares like with like.

It was set aside because the three arts form a supply chain **inside one subject**: a watch
task files new pages, those become `stub` and `gap` candidates, a deepen task builds them out,
and both raise the open questions an explore task answers. Today one Fellow walks that loop
with one notebook. Split across Fellows, the loop only closes through the vault, a night per
link, and two failure modes become structural:

- a Fellow holding only explore tasks sleeps for good once they are all answered - `wakeTriggers`
  filters on `c.kind === 'ingest'`, so it wakes only when someone files a document in its domains;
- a Fellow holding only deepen tasks creates nothing itself, so `nothing to deepen` is its
  normal state as soon as the theme's pages are built out.

Both are answered today by mixing a watch task in. Under pure arts they would need a channel
that does not exist: `HandoffRecord.domain` routes a question between **domains**, and nothing
routes "the watcher found something the librarian should build out" **within** one.

A specification would have to settle what the unit of handoff is (a page? a theme? a
question?), who may create one, whether the receiving Fellow's planner must take it or may
rank it against its own candidates, and how it avoids becoming a second, quieter proposal
queue the user never sees.

## 2. Measurements this design rests on (2026-09-09)

From `agent_runs`, the vault's own history:

| kind | n | median duration | max | mean cost | max |
| --- | --- | --- | --- | --- | --- |
| `research-step` | 13 | 318 s | 446 s | $2.13 | $3.07 |
| `research` | 7 | 614 s | 890 s | $4.26 | $6.45 |
| `research-expand` | 1 | 311 s | 311 s | $2.23 | - |
| `plan` | 10 | 86 s | 175 s | $0.55 | $0.81 |

Runs are serialized on the run mutex, so the window is a queue, not a pool.

A Fellow-night with three tasks and one planning run each: **20.1 min and $8.14** typical,
30.3 min conservative. In a 5-hour window that is about **10 Fellows by the clock**.

The plan is the tighter limit. On the `5x max` subscription the cleanest measurement (the
night of 2026-09-07 to 09-08, when only the shift ran) puts $15.05 of agent spend at one
percentage point of the seven-day window; other intervals put it no lower than $4. At $8 per
point a Fellow-week costs about 7 points, so with roughly 40% of the week left after the
user's own work: **about 5 Fellows with three tasks every night**.

## 3. Verification against the code (2026-09-09)

Every mechanic the design leans on, checked at the source. Three things the mockup claimed
turned out to be wrong and were corrected in it; the rest holds.

### 3.1 Confirmed

| Claim | Where |
| --- | --- |
| In `veto`, an undecided proposal RUNS - it is a veto list, not an approval queue | `fellows.ts` `runnable()` |
| Only `manual`, a veto, drift, or a Fellow asleep on `covered`/`stalled` holds a run back | same |
| Drift is scope below 0.2; in `veto` it waits for approval, in `auto` it is never created | `planner.ts` `DRIFT_THRESHOLD`, `fellows.ts:1321` |
| Three autonomy modes | `AGENT_AUTONOMIES = ['manual','veto','auto']` |
| All three arts have web egress; only the planning run does not | `maintenance.ts` starts them as `research`, `plan` as `query`; `permissions.ts` `profileAllowsWeb` |
| A deepening touches at most 4 existing concept/entity pages of the Fellow's own domains | `deepen-rank.ts`, `EXPAND_MAX_PAGES = 4` |
| Three tasks per Fellow | `MAX_TASKS = 3` |
| Run kinds are constrained per task as a JSON-Schema enum | `kindsForTask`, `plannerSchema` |
| Only an explore task can rest; watch and deepen never | `restTask`, planner prompt |
| A Fellow asleep on `covered` wakes only on an ingest into its domains | `wakeTriggers` |
| Runs are serialized - the night is a queue | run mutex, `maintenance.ts:1058` |
| Four lenses, closed set, and a lens can be set per proposal | `research-profiles.ts`, `runProposal(opts.lens)` |
| A proposal carries rationale, provenance (candidate, text, source pages), scope, cost, plan points, rank, page set | `db/proposals.ts`, `planner.ts:582` |
| The recap is already computed per Fellow | `RecapFellow` |
| The night window is a setting and is writable | `settings.ts`, `PUT /api/v1/settings` |
| `quotaRunsPerDay` limits runs, not tasks; planning runs are exempt | `fellows.ts:640` |
| Tasks, quota, autonomy, lens, model, effort, step, priority are all editable | `patchSchema` on `PATCH /api/v1/agents/:id` |
| A Fellow can be spawned with one to three tasks | `SpawnInput.tasks` |

### 3.2 Corrected in the mockup

- **Approving does not protect a proposal from expiring.** `PENDING_STATUSES` is
  `['proposed','approved']`, so `expire()` takes both. Approving sorts it first and is what
  makes it run at all in `manual`; it buys no extra time.
- **Every art reaches the web**, deepen included - it extends existing pages *with what it
  finds*. The mockup had described it as vault-only.
- **`veto` does not wait for the user.** The first mockups described a night that delivers
  nothing without a decision, and invented a "standing approval" switch that does not exist.

### 3.3 Missing - what the design needs and the code does not have

1. **Full sweep.** `taskForTonight` returns exactly one task and phase 2 plans once per
   Fellow, so "every standing task, every night" is new behaviour: a per-Fellow mode, a loop
   in the shift, and one planning run per task rather than per Fellow. This is the largest
   single item, and everything about "a result every night" rests on it.
2. **An art per Fellow.** `tasks[].kind` exists; a Fellow-level art with its own cap (the
   observer/researcher/librarian/custom split) does not. New field, new validation on
   `tasks`, and the spawn form has to enforce it.
3. **A domain order for the night.** `priority` exists but is per Fellow, and `all()` sorts
   by it. Dragging a domain block has to become either a domain-level order or a rewrite of
   the priorities of the Fellows inside it - a decision, not a detail.
4. **A duration estimate before a run.** `typicalRunMs` exists but is only surfaced for a run
   already in flight (`SceneRun.typicalMs`). The schedule needs it per proposal, from kind and
   model, before anything starts. Small: the function is there, only the exposure is missing.
5. **Per-domain counts for the unstaffed shelves.** Derivable client-side - `GraphGap.refBy`
   indexes nodes that carry a `domain` - but nothing aggregates it today.
6. **A UI name for the quiet state.** The record says `state: 'sleeping'` with
   `sleepCode: 'covered'`; the mockup's `quiet` is a label for exactly that and must map to it
   rather than become a new state.

Everything else the command centre draws already exists behind an endpoint.

## 3.4 Against the claude-obsidian architecture

Five contact points checked; no collision, one pressure point.

- **Protected upstream pages.** `PROTECTED_WIKI_SCOPES` is `['wiki/references',
  'wiki/getting-started.md']`, enforced by `createUpstreamGuard` in the agent runner - hard
  rule 5 at the tool level, for every run. A deepening cannot reach them in any case:
  `DEEPENABLE` is `concepts` and `entities` only. Two layers, neither weakened.
- **The Fellow notebook** is written as `type: meta` on purpose, "so the vault's lint tiling
  and address rules leave it alone". Nothing here changes that.
- **New Fellow fields** (art, sweep mode, domain order) belong in SQLite as operational state.
  Hard rule 1 holds: losing the database still cannot damage the vault.
- **Nothing planned touches the cloned repo internals.** Every item is service-side scheduling
  or our own dashboard; no new skill, no edit inside the plugin.
- **The pressure point: throughput - but not the one first written here.** The hot cache does
  NOT accumulate. WIKI.md section 2 is explicit: "It is a cache, not a journal. Overwrite it
  completely each time", ~500 words. Our research prompt already enforces that against the
  autoresearch skill's own looser wording ("update wiki/hot.md with the research summary" - no
  limit, no rewrite), which was measured growing the file from 401 to 826 words over eight
  runs; `refreshOversizedHotCache` then rewrites it at most once a day. And
  `HOT_CACHE_WORD_LIMIT = 750` is not an upstream limit at all - it is our own reporting
  threshold above the upstream budget of 500, with the gap there to absorb a long
  "Last Updated" line. More runs therefore do not grow the file.

  The real consequence of a full sweep is the opposite one: because every run rewrites the
  WHOLE file, three tasks in one night leave only the last one's context in it. The recency
  buffer would stop describing the night and start describing the last run, and
  `HOT_CACHE_RELATED_LIMIT = 40` has the same shape - it names "the pages of the latest pass".

  Upstream says it directly, in a passage that is NOT in our clone - the vault here is
  v1.9.2 (tag `pre-curious-2026-09-07`, 2026-05-27) and the wording below comes from a later
  version of the source repo: "Hot context is short, sanitized, and useful for the next
  session. It may include recent facts, changed pages, active threads, and unresolved
  questions. It must not contain secrets, raw transcripts, tool instructions, or claims that
  lack the same qualification found in canonical pages. Hooks may read and emit this file as
  bounded data. They do not update it."

  "Useful for the NEXT session" settles the sweep question without any analogy: a hot cache
  written after task 1 of 3 is not what the next session needs, so the sweep writes `hot.md`,
  `index.md` and `log.md` **once, after the last task of the night**, covering all of them.

  The same passage carries two rules our research prompt did not: no secrets, raw transcripts
  or tool instructions, and no claim stated with less qualification than the canonical page it
  came from. Both were added to `researchPrompt` and to the hot-cache refresh on 2026-09-09;
  the second matters most for a Fellow, whose pages are careful about exactly that distinction
  and whose summary is where the care can be lost.

  And the ownership line - hooks read, they do not update - is one we already satisfy: the
  refresh is an agent run, not a hook.

## 3.5 Decision needed: what a drag on the night bar orders

Recommended: **a stored domain order as the night's primary sort key, with `priority` keeping
its meaning inside a domain.**

Today `all()` sorts by `priority` then `createdAt` and ignores the domain entirely, so
"one contiguous band per domain" is a rendering that the execution order does not support -
Fellows of different domains would interleave. Either the bar tells the truth or the shift
changes; changing the shift is the smaller lie.

Scoping `priority` to within a domain costs nothing elsewhere: `targetFor`, the handoff
router, already filters to `homeDomain === domain || extraDomains.includes(domain)` before it
reads priority. The two orderings then live at different levels and cannot contradict each
other, and `priority` keeps the meaning its field name claims.

Rejected: making the drag rewrite the priorities of the Fellows in the dragged domain. It
clobbers any per-Fellow priority the user set, forces a domain's Fellows to occupy a
contiguous stretch of the priority space, and leaves `priority` meaning something other than
what it says.

A later second gesture falls out of this for free: dragging a Fellow **inside** a band sets
its priority - same field, no new concept.

## 4. Built (2026-09-09)

The command centre runs on the service's own data. `lib/command/model.ts` holds the arithmetic
under test - which shelves exist and what is unanswered on them, which Fellow works tonight,
how long the queue is - and the component only lays it out. The shelves come from the domain
registry and the graph, the Fellows and their proposals from the agents API, the night's hours
from the settings (and dragging them writes the setting back), and a task's length from
`typicalRunMs` over the service's own history, newly exposed on `GET /api/v1/agents` as
`durations` so a schedule can be drawn before anything starts.

Measured against the live vault on the day it was wired: 21 shelves, 2 staffed, a 300-minute
window holding 17 minutes of work - which is the diagnosis this whole milestone started from,
now stated by the window itself rather than by a query someone had to think to run.

## 4.1 Stage A: drawn but not wired

Three controls said what they were rather than pretending, because the field behind them did
not exist. All three were wired in stage B; this stays as the record of what was outstanding.

- **Whether a Fellow works all its tasks in a night.** The dossier stated the truth - one task
  a night, each of N coming round every N nights - and named the change as unbuilt (3.3.1).
- **The art a Fellow is limited to.** `artOf` derived it from the tasks, so the window could
  group and label by art; enforcing it at spawn needed the field (3.3.2), so spawning still
  went through the Library's own form.
- **The order of the shelves.** Shown as it would happen (priority, then age) and marked as
  not settable per shelf; the decision on how to store it is 3.5.

## 4.2 Stage B: the three fields, and what they turned up (2026-09-09)

Migration V23 adds `agents.art`, `agents.nightly` and the `shelf_order` table, and the three
controls now write:

- **`nightly`** (`sweep` | `rotate`, default `sweep`). `FellowService.planNight` plans every
  standing task of a sweeping Fellow, each in its own planning run, serialized on the run
  mutex; the shift's phase 2 loops over its outcomes. `taskCursor` stays where it is for a
  sweep - there is no turn to take when every task is taken.
- **`art`** (`watch` | `explore` | `deepen` | `custom`, default `custom`). `artRefusal` is the
  single check, used by both `spawn` and `update`. The spawn view offers the four shapes and
  the form fixes the art of every task behind one; the Library's own form still spawns a
  `custom` Fellow, which is what it always did.
- **`shelf_order`** with `byShelfThenPriority`: the domain gets the primary key and `priority`
  keeps its meaning inside a shelf, so the two cannot contradict each other (3.5). The queue's
  legend chips move a shelf with two arrows; the whole order is written, not the one that
  moved.

Two things the wiring turned up, both now fixed:

1. **`update` swallowed its own refusal.** An art conflict returned the unchanged record, so
   `PATCH /agents/:id` answered 200 with the old list and a dashboard would have shown "saved"
   for an edit that never happened. It now returns an outcome and the route answers 409.
2. **The daily quota caps a sweep, and the schedule did not show it.** Planning runs skip
   `quotaRunsPerDay` (`kind !== 'plan'`) and the runs they produce do not. So a Fellow that
   sweeps three tasks on a quota of one plans three and carries out one - and the window drew
   three full runs, booking about 21 minutes the shift never spends and showing two tasks as
   done. `scheduleFrom` now marks a block `runs: false` past the cap and books only its
   planning run; the band draws it hatched, and the dossier says which number to raise. This
   is the strongest argument for defaulting `quotaRunsPerDay` to the task count at spawn,
   which is not done: the field is the user's, and a silent bump is the same class of mistake.

### 4.2.1 What the sweep broke, found by reading the window's own numbers

Two more, both surfaced by a Fellow configured with three tasks and a quota of two:

3. **A sweep wiped its own plan.** `onPlanSettled` called `proposals.supersede(agentId)`,
   which moves EVERY undecided proposal of the Fellow to `superseded`. That is right for a
   night and wrong inside one: `planNight` plans task after task, so each run wiped the fresh
   proposals of the run before it and a night of three planning runs ended with one task's
   worth of work. Three planning runs were paid for, one task's plan survived. `supersede`
   now takes the task and narrows to the proposals that task asked for (`provenance.task`,
   which every proposal the current planner writes carries). It also stops a rotation from
   discarding a task's standing proposal because a different task came up, which is the same
   rule read at the other end.
4. **The counts said what was on the list, not what happens.** "3 tasks" and "3 of 3" counted
   planned tasks, and a reader takes a schedule's number at face value. Every count now leads
   with what runs: `taskCount` reads "2 of 3 tasks run" when the quota holds one back, the
   per-Fellow badge is the carried count and turns amber, and the note under the queue says
   what becomes of the rest (a proposal that stands for two nights, approvable to jump ahead).

The quota is editable in the dossier now, and a new Fellow gets one run a day per standing
task. What is still true and deliberate: raising a Fellow's task count later does NOT raise
its quota. The window says so where it matters rather than moving a number the user set.

Retiring `FellowCard` is now unblocked; A6 merge prep is the next milestone gate.

## 5. Open item: a log channel per run

`maintenanceChannel(kind)` is `maintenance:<kind>` - one channel for every run of a kind, for
every Fellow, for the life of the tab. The room reads it for two things and both were wrong
for it:

- the POSE, from `steadyFamily` over a 30-second window, so a Fellow starting a run wore the
  previous one's pose for half a minute;
- the PROGRESS CAP, from `furthestFamily`, which reads every line in the buffer on purpose (a
  run that reads again after writing should not fall back). On a channel where anything ever
  committed, `runPercent` short-circuits to its maximum - so the second and every later
  `research-step` of a session reported 95 % from its first second.

Measured on the night of 2026-09-09: three planning runs for one Fellow and one for another,
back to back, all four on `maintenance:plan`. Planning runs never commit, so the visible
symptom there was only the shared pose; the 50 % they all sat at is the read-phase cap doing
its job on a read-only run, not a stall.

Cutting each run's lines at its own `startedAt` (`since()` in `lib/library/scene.ts`) fixes
both symptoms and is what was built. The cause is the naming: a channel should carry the run
id, `maintenance:<kind>:<runId>`. That is a server change plus every SSE subscriber that
follows a kind today, so it is its own piece of work.

One number was fixed with it: the Library's "Decisions" count read the newest RECAP while the
command centre decides against the live Fellows and invalidates `agents`. Nothing invalidated
`recaps`, and with `refetchOnWindowFocus` off there was no schedule to fall back on - so the
count held its old value until an unrelated mount happened to refetch, and disagreed with the
per-shelf pill beside it the whole time. It counts `undecidedProposals` from the same payload
the pill does now: one number, one source.

## 6. What the sweep still owed, found by comparing a night to its record (2026-09-10)

Two Fellows configured for several tasks a night, one of which had planned all night and run
nothing. The record said why.

### 6.1 An auto Fellow ran once a night, whatever its quota said

Phase 1 executes in rounds and **skips auto Fellows on purpose** - their proposals do not exist
when it runs, phase 2 creates them. Phase 3 then called `executeOne` **once** per auto Fellow.
That was right while a Fellow planned ONE task a night: its top proposal WAS its night. Since
`nightly: sweep` it meant a Fellow planned three tasks and ran one, and the runs-per-day the
user set said nothing. Phase 3 runs in rounds now, the same shape as phase 1, and the same
things end it: the quota, the gate, or nothing runnable left.

A Fellow that spends its quota now ends the night `sleeping` with `sleepCode: 'quota'` rather
than `waiting` - the same as one stopped in phase 1, and it says why.

### 6.2 The night's runs could all belong to one task

`runnable()` ordered by `rank` alone. The planner ranks each task's proposals 1..3
independently, so a sweeping Fellow holds three rank-1 proposals and rank cannot tell them
apart: three runs could be three options of ONE task while the other two stood planned and
untouched. A task already run today now sorts last, so rank decides inside a task and no
longer between them.

### 6.3 Clara had planned and not run, and that was correct

Phase 1 (execute) runs before phase 2 (plan), and phase 3 executes only `auto` Fellows. A
`veto` Fellow's proposals are therefore created after the only phase that could run them, and
wait for the next night - which is what veto means and what the dossier says. Her three
approved proposals are three OPTIONS for one task, not three tasks: the top one runs.

### 6.4 Every run of a sweep was handed the FIRST task's candidates

Measured: three test Fellows, seven tasks, seven planning runs, **two** proposals. The planner
wrote the reason into its own answer:

> "Tonight's task is the watch for new non-invasive EEG decoding accuracy results. Every
> candidate offered (C1-C9) traces back to Yuri's other standing task - the invasive BCI
> clinical trial watch - which the brief explicitly excludes from tonight's proposals."

It was literally true. `plan()` built its candidate list with `this.candidates(agent.id)`, and
that method chose the task from the ROTATION - `taskForTonight(tasks, taskCursor)`. A sweep
leaves the cursor alone by design, so every planning run of a sweeping Fellow got task one's
list. That matters because exactly one candidate is task-specific: the standing sweep, whose
text IS the task, and which for a watch task is the only candidate the task can stand on by
itself. Everything else comes from the vault and belongs to whatever the Fellow has already
worked - and the prompt tells each run "do not propose against the other tasks".

So tasks two and three were offered the first task's sweep plus the first task's follow-up
questions, and forbidden to use any of it. Nothing left to propose, every night, at the cost of
a planning run each.

The list is now built for the task the run is actually for, and `candidates(id, task)` takes
the task rather than reading the cursor. The order in `plan()` changed with it: the task is
decided before the candidates, because the list depends on it.

What remains true and is worth knowing: a task's own sweep is its only self-standing candidate,
so a watch task whose subject the vault has nothing on proposes a sweep or nothing at all.

### 6.5 Open: the schedule draws shelves, the shift walks rounds

`scheduleFrom` lays one shelf's blocks end to end, then the next shelf's - the picture the
shelf order promises. Both execution phases are `for round { for agent { executeOne } }`, so a
night actually gives each Fellow one run in shelf order, then goes round again. With one task
each the two readings agree; with several they do not. Either the bar should interleave or the
shift should drain a Fellow before moving on, and that is a decision about what the shelf order
MEANS, not a detail.
### 7. A deepening writes in place, not into a dated tail (2026-09-10)

`renderExpandRules` demanded one `## Update <date>` section at the END of every page it
touched. Comparing that against the vault's own skills says it was the wrong shape:

- `wiki-ingest` steps 4 to 6 are "**create or update** entity pages ... concept pages ...
  update relevant domain pages", with "use PATCH for surgical edits" and "keep wiki pages
  short, 100 to 300 lines max; if a page grows beyond 300 lines, split it".
- A conflicting claim gets a `> [!contradiction]` callout **on both pages, at the claim** -
  "do not silently overwrite old claims. Flag and let the user decide."
- `wiki-lint` reports "stale claims: assertions on older pages that newer sources have
  contradicted or updated", i.e. it looks for the pages where that was not done.
- The style check wants declarative present tense - a page states what is known.
- Append-only exists upstream for the JOURNALS only: `wiki/log.md` and the `wiki-fold`
  rollups ("a fold is additive: child log entries and their referenced pages are never
  modified"). There is no `## Update <date>` convention anywhere in claude-obsidian.

Evidence from the six pages that carry such sections in the production vault: one update
opens "extends the <named> section above" - the fact belongs in that section and a reader of
it never sees the update. Another opens "the figures above ... now trace to a properly filed
primary source", a correction narrated because it could not be made. One page is a quarter
dated tail from a single night. Finding F2
of A3 was the same collision seen from the other side: the skill's `related:` footer had to
be excluded from the validator because the appended section displaced it.

What was actually load-bearing stays untouched: `isSubsequence` checks that every old body
line survives in order, and a run that rewrites or deletes one is reverted. It allows an
insertion ANYWHERE - the tail was forced by the prompt wording alone. The block now says
additive rather than append-only, tells the run to add to the section the fact belongs to
(in that section's voice, with the date and source in the sentence), and sanctions
`> [!contradiction]` and `> [!stale]` directly under a claim as the way to correct one.
SPEC section 7a carries the reasoning; `expand.test.ts` asserts the wording, because here
the wording IS the mechanism.

Open: **splitting an overgrown page.** The vault wants pages split past a few hundred lines,
and the additive rule cannot express that - moving a section to a new page reads to the
validator as deleted lines. A deepening can only leave a note in Open Questions. Probably a
run kind of its own rather than a loosening of this one.

**The tails already written were folded in by hand (2026-09-10).** Six pages carried one, and
that is small enough that a run kind for the cleanup would have cost more than the cleanup.
Each was read, rewritten so every fact sits in the section it belongs to, and written back
through `PUT /api/v1/pages` - the sanctioned non-agent mutation path (hard rule 1), one
revertable commit per page, the same shape `src/cli/backfill-sources.ts` uses. Two invariants
were checked per page before writing: every wikilink the page had still on it, and every
figure still present. Method notes the run had written about itself ("fetched the full text
to get…", "is now filed on X, cross-referenced against Y") were dropped where the vault
already recorded the same thing in `related:`; nothing that was a claim was dropped. One page
gained real structure it had been missing (efficacy, safety, manufacturing and regulatory
history as sections rather than one dated block), and one unverified figure became a `[!gap]`
callout on the claim, which is what the new rule asks a run to do in the first place.

### 7a. A title that carried a path separator (2026-09-10)

That cleanup turned one up: a synthesis page whose TITLE contained a slash was written to a
path that read the slash as a directory separator. The page sat one folder down, named after
the half of its title AFTER the slash, and all five wikilinks aimed at the whole title
resolved to nothing. It had been that way since the run that wrote it, which reported success.

Why nothing noticed: `renderSynthesisMandate` pins the title in the prompt and the run files
under it, and the post-run check `isSynthesisPath` asked only that the page be under
`wiki/questions/` and start with `Research: `. A nested page satisfies both.

Fixed in three places, deepest first:

- **`titleSafe`** (`research-profiles.ts`, mirrored in `web/src/lib/researchRuns.ts` so the
  composer's "files as" line cannot promise a different name than the run uses). A topic
  becomes a name exactly once, in `researchTargetTitle`, so that is where the name is made
  safe to be one: both separators become a hyphen, which is what the "A or B" shorthand meant;
  control characters and a leading dot or hyphen go, the same set the vault's own `safe_name()`
  strips; an empty result becomes `untitled` rather than a bare prefix.
- **`isSynthesisPath`** now requires the page to sit directly in the bucket, so a run that
  files one a folder down is reported as having filed none, which is the warning that was
  owed.
- **`validator.ts`** gained a `nested-page` finding over the pages of every commit, since a
  title is not the only way to end up a folder down. `wiki/meta/` is exempt: the agent and
  recap journals live in folders by design.

The page itself was renamed to the name `titleSafe` now produces, its frontmatter title
corrected, and all five wikilinks repointed, in one vault commit. The plain-text records of
what was asked (the log heading, the recap, the notebook's task list) keep the topic as it was
typed - they quote a request, they do not link a page.

**It was not one page.** Running the validator over the whole vault afterwards found 45 dead
links, and 37 of them were this same class under four different disguises: a title with a
separator in it, and a run that repaired the FILE name (a hyphen here, an underscore there,
dropping it once, a real directory once) while writing every wikilink from the TITLE. One
more was a title too long to be a file name, shortened on disk and linked in full. All 37
were repointed to the file name of the page that answers to them - matched on name,
frontmatter `title:` and `aliases:`, and only ever when exactly one page answered. The eight
that remain are ordinary gaps: pages nothing has written yet.

Which is why the third layer is a prompt rule, not code. `titleSafe` only guards the ONE
title the service pins; concept, entity and source pages are named by the run itself, and no
validator can rename a page after the fact. `PAGE_HYGIENE_CHECKLIST` now states the rule the
runs were each inventing differently: a page's name is its file name, a file name holds no
separator, write the hyphen in the title AND the file name AND every link, and do not repair
the file name alone - that is precisely what breaks the links.
