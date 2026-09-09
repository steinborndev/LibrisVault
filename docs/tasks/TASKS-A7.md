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

## 4. Not built yet

- The command centre itself; the mockups are in the scratchpad, not in the repo.
- Retiring `FellowCard`: everything it does has a home in the new window, but the old card
  stays until the new one is real.
