# Curious - idea ledger

Running notes for the LibrisVault extension "autonomous research agents in a virtual
library". Collected during design sessions; condensed into a spec later. Decisions are
dated; open items move to the spec review.

## Decisions (2026-09-05)

- Curious is a private repo and the home for now. Build and test here; merge into
  LibrisVault (public) later. Commit hygiene as in LibrisVault hard rule 7 from day one,
  because the history becomes public on merge.
- Autonomy model: propose-then-run with a veto window. Agents never execute an unreviewed
  plan; "full auto" is the special case of a zero-length veto window.
- Agent memory lives in the vault as a page (notebook), not in an SDK session.
- Step size and model are configurable per agent. Spawning a Fable agent for a complex
  problem must be possible; the spawn dialog shows the cost factor.
- A daily recap of the autonomous agents' activity is written for the user. It carries the
  agents' proposals for next steps in multiple-choice form and lets the user adjust.
- Library screen: an agent stands at the bookshelf while researching, writes at a desk while
  filing wiki pages, and shelves finished articles as books in the matching shelf. Domains
  are departments of the library. Clicking a shelf opens that domain in the graph.
- The library renders the runs that exist today as well, not only the new agents: a manual
  research run is a visiting researcher with the same animations, a maintenance run is a
  caretaker (for example clearing old books), an ingest job reads the source as a book.
  Consequence: the library screen is a second renderer over the existing activity stream
  (ingest, research, maintenance, edit), zero extra token cost.
- Every spawned agent is clickable in the library and opens its summary: name, what it is
  working on, when it was last active, which articles it wrote, what it plans to do.

## Facts that constrain the design (from the LibrisVault code base and the vault)

- All vault writers are serialized by the maintenance run mutex; agents never run at once.
- Vault pages of `type: meta` are excluded from lint tiling and need no address; the domain
  registry itself is `type: meta`. Candidate home for notebooks and recaps: `wiki/meta/`.
- Lint requires frontmatter `type, status, created, updated, tags`.
- Graph URL knows `focus`, `gaps=1`, `labels=off`; the domain filter is a saved preference,
  not a URL parameter (a `?domain=` parameter is new work).
- Telegram bot is a minimal client (getUpdates, sendMessage, getFile); commands `/status`,
  `/jobs`, `/research`, `/help`. No inline keyboards yet.
- Runner options carry no `model`, `effort` or `maxBudgetUsd` yet; the SDK supports all three.
- SDK 0.3.212 exposes plan utilization (5h, 7d, per-model buckets) through an experimental
  `usage()` method. Measured: a Sonnet 5 research run is about 6 USD list price, roughly
  7.5 % of a Max 5x 5h window and 0.6 % of the week (estimate, to be calibrated).- Signals already available for a scene adapter: `web/src/lib/activity.ts` unifies
  ingest/research/maintenance/edit with states running/queued/done/failed/deferred/
  duplicate/cancelled; job states queued/preprocessing/ingesting; maintenance kinds lint,
  lint-fix, research, hot-cache, save, domain-backfill, domain-review, cleanup, repair,
  tag-fix, retrieve-index; log lines carry tool names ("-> Read(...)"), so a pose can follow
  the tool family; commits carry the page list and graph nodes carry each page's domain.
- The maintenance mutex means at most one researcher or caretaker works at a time; ingest
  jobs run up to `concurrency` in parallel.
- "Library" is already the name of the tabular page view (candidate rename: "Catalog").

## Open items

See the design session notes; each item below gets a decision in the spec review.

- Repo relation to LibrisVault (private fork with a feature branch vs. separate package).
- Dev instance: own port, own DB path, own vault clone, no Telegram token.
- Data model: agents, proposals, recaps, usage samples; what is source of truth where.
- Notebook page: path, frontmatter, sections, which parts the service reads back.
- Daily cycle: night shift window, recap time, veto window length, week reset alignment.
- Quota: per-agent runs/day plus plan-percent shares (5h, week) and a reserve floor;
  API-key mode in USD; measurement via SDK usage deltas.
- Agent lifecycle: spawn fields, states, stop criteria, retirement, editing, cloning.
- Planning: candidate sources, planning run (read-only, cheap model), proposal format,
  scope anchor, provenance of topics (vault-internal only).
- Run kinds: full research, small follow-up, research-expand (append-only, bounded page
  set, git-diff validation), planning, recap.
- Collaboration: home domains, routing of open questions, plan dedupe across agents,
  unclaimed requests as spawn proposals.
- Recap: content, who writes it, language, channels (dashboard, vault page, Telegram),
  answer mechanism for the multiple-choice proposals, what "adjust" allows.
- Library screen: state machine and poses, department layout, what a book is, initial
  render from an existing vault, growth animation, day/night, sleeping agents, front desk,
  rendering approach and assets, accessibility fallback (the ledger stays the record).
- Safety: sandbox profile per run kind, injection boundary, notebook write rights between
  agents, commit hygiene.
- Scene catalogue per activity kind (visitors vs residents, caretaker roles, ingest as
  parcel/reading/shelving, duplicates and failures), a universal pose rule from tool
  families, and a props model (book = page, parcel = raw file, notice board = hot.md, card
  catalog = index). Snapshot plus replay when the screen opens.
- Agent summary panel: field sources (agent record, run history, run page lists split into
  created vs updated, approved plan vs pending proposals), docked panel beside the canvas
  per DESIGN.md, deep link `?agent=`, the same card reachable from the ledgers and the
  recap, an accessible agent list in the rail as the non-sprite path, and which actions
  the panel offers (pause, veto, open notebook, open in Obsidian, filter ledger).
- Naming: agents, the screen, the run kinds.
- Value signal: how to tell the library is worth its cost (may be deferred).

## Review decisions (2026-09-05, block 1)

- OPEN-1: private fork of LibrisVault with a `research-agents` branch, feature flag, PR later.
- OPEN-9: agents are called **Fellows**; the isometric room is **Library**; the tabular page
  view is renamed **Catalog** (route alias for the old path).
- OPEN-5: the recap is English everywhere (one text for vault page, dashboard, Telegram).

## Review decisions (2026-09-05, block 2)

- OPEN-8: a Fellow's model and effort apply to ALL of its runs, planning included. Open
  follow-up (OPEN-8b): which model writes the global recap.
- OPEN-17: Sonnet 5 is the default Fellow model, hence the default planning model.
- OPEN-22: sleep after two consecutive no-changes runs (plus no candidates, or planner
  verdict "intent covered"); wake on ingest, recap answer, manual step, intent edit.
- OPEN-16: Fellows never write other notebooks; handoffs are service-side records.

## Review decisions (2026-09-05, block 3)

- OPEN-8b: the recap is always written on the default model (Sonnet 5); it is service work.
- OPEN-10: the veto window lasts until the next night shift; no separate timer.
- OPEN-11: night shift 01:00 to 06:00 local, one 5-hour window.
- OPEN-12: defaults 10 % of the week, 15 % per 5-hour window, reserves 60 % (5h) and 80 % (week).

## Review decisions (2026-09-05, block 4)

- OPEN-13: recap = deterministic skeleton plus a three-line narrative per Fellow on Sonnet 5.
- OPEN-7: Telegram answers as coded text replies in v1; inline keyboards later.
- OPEN-6: Obsidian checkbox read-back later; v1 recap page is rendering only.
- OPEN-19: unclaimed request opens a prefilled spawn dialog.

## Review decisions (2026-09-05, block 5)

- OPEN-2: a manual research run is an anonymous visiting researcher.
- OPEN-14: concepts, entities and syntheses are books; sources are thin volumes; meta pages invisible.
- OPEN-15: sprite test first (one figure, three poses, generated vs purchased), then decide.
- OPEN-20: day and night follow the real clock.

## Review decisions (2026-09-05, block 6)

- OPEN-3: the card lists created and updated pages separately.
- OPEN-4: the card shows the live run with phase bar and log tail.
- OPEN-18: minimal value signal in v1 (recap link clicks, Fellow page opens, local only).
- OPEN-21: Fellow management lives in the Library screen's control column plus the card.

## Review decisions (2026-09-05, block 7, gaps found during the review)

- NEW-1: spawning starts the first full run on the intent immediately (checkbox, on by
  default, quota gate applies); planning follows in the next night shift.
- NEW-2: quiet day = one-liner to dashboard and Telegram, no vault page.
- NEW-3: manual research runs are not limited by the Fellows' research share or reserves;
  the recap header still shows total consumption.
- NEW-4: `step` is the Fellow's maximum (default `standard`); the planner proposes the
  smallest fitting kind per candidate.

## Status

SPEC.md v0.2 (2026-09-05) integrates every decision above. The review round is closed;
new ideas go here first and reach the spec through a dated decision.

Build status: A0 done 2026-09-06 (docs/tasks/TASKS-A0.md); A1 done 2026-09-06
(docs/tasks/TASKS-A1.md: candidates, planner, proposals, veto window, night shift, quota,
USD accounting); A2 done 2026-09-06 (docs/tasks/TASKS-A2.md: recap page, quiet day,
dashboard inbox and Recap view, Telegram text and coded answers, adjust actions, value
events); A3 done 2026-09-06 (docs/tasks/TASKS-A3.md: research-expand with validation and
revert, routing of foreign questions to the Fellow of the domain or to unclaimed requests
with a prefilled spawn, dedupe before the shift); A4 done 2026-09-06 (docs/tasks/TASKS-A4.md:
the Library screen with one room per view, the existing runs and the Fellows as figures,
the docked card, wings and drag and drop, Catalog rename); A5 done 2026-09-06
(docs/tasks/TASKS-A5.md: usage monitor with SDK samples inside runs, deltas on the run row,
median calibration, USD-equivalent shares until calibrated, the plan gate with the sleep
code `plan`, the shift's reset wait, points in recap and card, the System Plan panel).
Next: A6. Home's flow zone was rebuilt on 2026-09-06 (SPEC section 9.3): the recap banner
and the activity box became one box with two views, recaps leading, with a week-and-Fellow
rail beside the feed.

Follow-ups noted during A1, not yet decided:

- Candidate dedupe is exact-text only; the notebook and a synthesis page often carry the
  same question in slightly different words, so the planner sees both (it is told to merge
  them). A token-overlap dedupe, as the shift's cross-Fellow dedupe in A3 will need anyway,
  would trim the list.
- The synthetic demo vault cross-links domains at random, so "gaps wanted by the Fellow's
  domain" include titles from other fields. Real vaults link by meaning; the planner reads
  the source pages and discards them, at a token cost.

## Fork and dev instance (2026-09-05)

- This repo is the private fork: `upstream` is the public LibrisVault repo, `main` tracks
  `upstream/main`, work happens on `research-agents`. The commit-msg hook is installed
  (`scripts/install-git-hooks.sh`) because the history is merged into the public repo later.
- `scripts/dev-instance.sh` starts the second instance: port 8421, vault `~/vault-curious`
  (claude-obsidian v1.9.2 plus the synthetic demo set: 899 pages, 17 domains, 145 backdated
  commits), database and inbox under `~/.local/share/curious/`, no Telegram token, the
  shared credential file. `scripts/dev-instance.sh npm run start:prod` runs the built JS.

## Design round 1 (2026-09-05)

- Library screen canvas with four artboards (day, night shift, Fellow card docked, sprite
  test): https://claude.ai/code/artifact/379c5aa8-9b7d-40e8-9bd9-3a9e7eb59ace
  Working files under `docs/agents/design/library-screen/`. Shell, tokens and controls are
  lifted from the dashboard's light theme; the room follows SPEC section 10 (departments
  from the registry, books by page count, front desk, reading room, notice board = hot.md,
  catalog = index, mutex drawn as waiting at the front desk).
- Open from this round: style A or B for the figures (OPEN-15), whether figures need faces
  at this size, how many departments to draw when a vault has more than fit on one floor.

## Design round 2 (2026-09-05)

- OPEN-15 decided: style A, flat vector figures. The sprite board now shows the pose
  vocabulary (shelf, desk, shelving, asleep, waiting, carrying, inspecting, re-sorting).
- New: **Focus mode** toggle (`Full | Focus`) that reduces the screen to the room; a click on
  a Fellow opens a popover (state, now, tonight, Open card, Pause). Spec section 10.6.
- New: department **signs on the shelves**, in perspective on the top band of the long face.
- New: **Textures** board with three options each for floor (tile grid, parquet, stone), walls
  (plaster, panels, whitewashed brick) and shelves (neutral, oak, walnut) plus three presets
  (Studio, Reading room, Archive). Decision pending: OPEN-23.

## Design round 3 (2026-09-06)

- OPEN-23 decided: Archive preset (stone, panels, walnut). No faces on the figures.
- Shelf signs: one size per view, two lines for long names (band height constant).
- Growth model written into SPEC 10.8: bays, first-fit in birth order, case length by page
  count with floor and cap, second case instead of a longer one, two spare cases always,
  wings through a doorway when the last spare is taken, level of detail by tile size.
  The Growth artboard shows today, the wing opening, and a filled wing.

## Design round 4 (2026-09-06)

- New topology (NEW-8): a central **main room** with the fireplace and armchairs for resting
  Fellows, desks with computers, four favorite slots, notice board, front desk, catalog and
  the unfiled case; four doors, one per side. Start = main room plus Wing A with the
  current departments; three doors drawn as slots. Wings are created, renamed and filled by
  drag and drop; a fifth wing chains behind an existing one. Spec 10.4 and 10.8, data model
  (`wings`, `library_layout`) and API (`/wings`, `/library/move`) updated.
- Render note: walls carry a cornice so the top edge reads against a floor behind them; the
  panel wall and the stone floor share a tone otherwise.

## Design round 5 (2026-09-06)

- NEW-9: one room per view on a shared 27 by 11 grid, shelves 3 tiles wide, one door per
  room at the right end of the long wall. Wing = 7 shelves on the wall + 3, passage, 3 in
  the middle, all facing the viewer. Rooms page by wheel, keys, the room strip and the Rooms
  list; wings are created, renamed, reordered and filled by drag and drop; free slots are
  light silhouettes; the unfiled shelf became an intake cart by the front desk.
- Render lessons: wall decoration needs the drawing depth of its end point, or a later wall
  segment paints over it; a middle shelf row needs about 6 tiles of distance to the wall row
  or its top covers the lowest books behind it; tall furniture within 3 tiles in front of a
  shelf hides the shelf's lower part.

## Design round 6 (2026-09-06)

- NEW-10: the door moves to the middle slot of the long wall, in line with the passage of
  the middle row; a wing holds 12 shelves (3 + door + 3 on the wall, 3 + passage + 3 in
  the middle), the room is 23 by 11 tiles. Main room: two favorites on each side of the
  door, notice board at the wall's left end, fireplace front left, desks front right, front
  desk, intake cart and catalog beside the path from the door.

## Design round 7 (2026-09-06), last details before A0

- No windows on any wall. The notice board sits centred on the short wall. In the main
  room each favorite pair is centred in its wall section (2.1 tiles of space on both sides
  of a 5.8-tile pair in a 10-tile section). Design rounds closed; next is milestone A0.

## Open after the end-to-end tests (2026-09-07)

Two questions to take up once the five tests against the demo vault are through, before the
service is pointed at the real vault.

**Is `research-expand` reachable at all?** The kind exists end to end - the planner may propose
it, the gate prices it, the page set is validated and a violation reverts the commit - but the
UI never names it. The scene adapter knows the word ("deepening pages") and that is all: the
Fellow card starts a step, the spawn form has no kind, and nothing offers "deepen these pages".
Today an expand can only appear if the PLANNER chooses it for a candidate, which makes the one
run kind that touches existing pages the one the user cannot ask for. Questions: does the card
get a "deepen" action with a page picker; can a Fellow be spawned whose work is deepening a
named set rather than answering a question; and should the page set come from a domain, a tag
or a hand-picked list.

**Should a Fellow carry several standing tasks?** It has one `intent` today, one sentence that
every planning run is judged against, plus optional free-text `scope`. The scope score is
computed against intent plus scope as one bag of words, so a broad intent both invites drift
and makes the drift score meaningless. A worked example of what a user actually wants: a
biomedicine Fellow that (1) finds newly approved biologics, (2) identifies new high-impact
studies in the field, and (3) deepens what the vault already holds on endosomal escape and LNP
formulation - three tasks of three different KINDS (a watch, a survey, an expand), each with
its own natural run kind and cadence. Questions: does `intent` become a list of tasks with a
kind and a weight each; does the planner then propose per task and round-robin between them;
is the scope score computed per task, which would make it sharp again; and what happens to a
task that is answered - does it retire while the others go on. This is the difference between a
Fellow that wanders and one that keeps a beat, and it decides how much of the autoresearch is
steerable at all.

**Can the inspector show a lint run's progress?** Measured on a live run (2026-09-07): a lint
run does NOT walk the vault domain by domain. The skill's ten checks are the order - orphans,
dead links, stale claims, missing pages, cross-references, frontmatter, empty sections, index
entries, addresses, semantic tiling - and each check sweeps the whole vault at once, mostly
through Bash globs over `wiki/concepts/*.md wiki/entities/*.md wiki/sources/*.md` together. In
90 seconds of log, 72 lines carried 6 concrete page paths; the rest were patterns over
everything. So walking the shelves in order would draw a sequence the run does not have.

Two honest options instead, both small:

- **Stand where the run is reading.** The adapter already reads the log lines and
  `shelfPlace(scene, domain)` already takes a domain; the missing step is mapping the page path
  in a `Read`/`Edit` line to its domain through the graph. That works for EVERY run, not just
  lint - a Fellow at the shelf of the department it is actually reading, rather than at its
  home shelf. It needs the same steadying the pose got (the dominant domain inside a window),
  or the figure hops between wings on every line.
- **Say which check is running.** Lint's real progress is its check list, so the inspector's
  bubble could carry it (`inspector (dead links)`) the way research carries its phase bar. The
  line is in the log already; it is a matter of recognising the ten headings.

The first is the more valuable one and the more work, because it touches every figure; the
second is nearly free and only helps lint and lint-fix.

**A percentage in every bubble.** The ask: `Ada (writing 60%)` instead of `Ada (writing)`, for
Fellows and visitors alike. There is no progress signal in an agent run - the SDK reports tool
calls, not a fraction of the work - so any number is an estimate, and the question is which
estimate is honest enough to show.

Measured over this vault's own run log (2026-09-07), duration per kind is far more predictable
than it feels:

| kind | runs | avg | min | max |
|---|---|---|---|---|
| research | 7 | 749 s | 601 | 875 |
| research-expand | 2 | 590 s | 527 | 653 |
| research-step | 3 | 392 s | 358 | 451 |
| plan | 6 | 127 s | 84 | 177 |
| lint | 1 | 512 s | - | - |
| hot-cache | 1 | 21 s | - | - |

Spread inside a kind is roughly ±20 %, which is good enough for a bubble and useless for a
progress bar - so show it as a coarse number, in steps of ten, never as a precise one.

The build, in three parts, none of them large:

1. **Elapsed against the median of the same kind and model.** `agent_runs` already holds
   `started_at`/`finished_at` per kind, so the median is a query; the scene already carries
   `run.startedAt`. The server would add one field per running run (`typicalMs`) and the
   adapter would compute `min(95, elapsed / typical)`. A fresh vault with no history falls back
   to the sizes in SPEC section 16.
2. **Anchored on the phase, so it cannot lie badly.** The pose already knows what the run is
   doing from its log lines. Reading caps the number below ~50 %, writing below ~85 %, and a
   commit line pins it at 95 % whatever the clock says. That turns a pure stopwatch into
   something that tracks the work: a run that finishes early jumps forward instead of sitting
   at 40 % while it commits.
3. **Never go backwards, never reach 100.** Keep the last value per run in the adapter and
   take the maximum; a run at 95 % that is still going says 95 % until it settles, because a
   bubble that hits 100 and keeps talking is worse than one that says 90.

An optional fourth part, if the estimate is not good enough: ask the run to log its own
progress (`progress: 2/5 sources fetched`), which the research skill's rounds and the lint
skill's ten checks would make natural. That is the only source of a REAL fraction, but it
depends on the model obeying, so it would layer on top of the estimate rather than replace it.

## Decision: deepening is something you can ask for (2026-09-07)

Answers to the first of the four questions parked after the end-to-end tests. `research-expand`
is complete on the server - `POST /agents/:id/step` already takes `kind` and `pageSet`, the page
set is validated append-only and a violation reverts - and invisible in the UI, so the one run
kind that touches existing pages is the one the user cannot ask for. It gets two entry points.

**It is called "Deepen".** Not "expand", which in a UI reads as "more pages" while the run does
the opposite, and not the internal kind name.

**Two ways in, one dialog.** From the Fellow card, next to "Run next step now", with the
Fellow's home domain already chosen. From the Catalog, in the header of a domain-filtered list,
where the domain is already the unit of the view. Both open the same dialog, so there is one
thing to keep consistent rather than two.

**You pick a domain, the service picks the pages.** Ranked by demand against substance: many
incoming links, little text - the pages the vault points at and that do not pay off. `in` and
`size` are already on every graph node, so the ranking is a pure function in the web and needs
no server work. Recency and isolation are other real kinds of gap and deliberately not this one.
The dialog shows the proposal and lets you replace a row two ways: an `x` takes the next
candidate off the ranking, and a search field takes a page you already have in mind.

**Bounded by the Fellow's own ground.** Only pages in the Fellow's home domain or its
extraDomains; a Fellow is not offered for a domain that is not his. The alternative - quietly
adding the domain to the Fellow - would let one grow past its subject without anyone deciding
that, which is the drift the scope score exists to catch.

**A domain with no Fellow is a beginning, not a dead end.** The action stays live and leads into
the spawn form, prefilled with the domain and the four pages, and the new Fellow's first step IS
that deepening rather than the usual first research run. It reuses the prefilled spawn built for
unclaimed handoffs. A Fellow that starts by consolidating what is there before adding to it is
also the better first run.

**Up to eight pages, with the price attached.** The planner keeps its cap of four; a hand start
may go to eight, and budget and timeout follow: 6 USD and the current timeout cover four, each
further page adds 1 USD and 25 % time. Not linear, because a run orients itself in the vault
once - the eighth page is cheaper than the first. Eight pages therefore cost 10 USD, and the
dialog says so before it starts.

**A direction is optional.** One free-text field, "what to look for". Empty means the pages bound
the run and the Fellow's intent steers it, which is what `step()` already does when no topic is
given (`opts.topic ?? agent.intent`) - so the field costs nothing on the server. Filled, it is
the run's topic.

**The quota behaves as it does for a step.** 409 with "x of y today", and the dialog asks once
before overriding - the mechanism built for "Run next step now". One rule, one explanation.

Deliberately NOT decided here: a Fellow whose standing work is deepening a set. That is the
second parked question (several standing tasks per Fellow), where it belongs as one task kind
among several rather than as a special case bolted to the spawn form.

What this needs, in order: the ranking as a pure function with tests; a page-set cap and a
domain guard on the step route, since a hand-started expand is capped and bounded by nothing
today; budget and timeout as functions of the page count instead of flat per kind; the shared
dialog; the two entry points; the spawn prefill.

## Decision: a Fellow keeps a beat, not a subject (2026-09-07)

Answers to the second of the four questions parked after the end-to-end tests. A Fellow has one
`intent` today, one sentence every planning run is judged against, and the scope score is
computed against intent plus `scope` as one bag of words. A broad intent therefore does two bad
things at once: it invites the Fellow to wander, and it makes the measurement of that wandering
meaningless - the tests showed a drift score of 0.00 for exactly that reason.

**Tasks replace the intent.** A Fellow carries one to three of them. An existing Fellow's intent
becomes its first task, which is the whole migration.

**A task is a sentence and an ART.** Three: *watch* (look for what is new), *explore* (pursue an
open question), *deepen* (build out what the vault already holds). The worked example is one of
each - newly approved biologics, new high-impact studies, endosomal escape and LNP formulation -
and they are three different kinds of work, not three phrasings of one. The art picks the run
kind, instead of the planner guessing it from a sentence every night.

**Three at most.** With the default of one run a day, three tasks means each comes up every
third night, about twice a week. A fourth subject is a second Fellow, not a longer list: a list
long enough to starve its own tail is worse than the single intent it replaced.

**One task a night, in turn.** The planner sees the whole candidate pool - the notebook's open
questions, the gaps, the handoffs, the reading list - but only tonight's task as the yardstick.
That keeps the prompt sharp and makes the scope score mean something, and it keeps the pool
whole, so a good question belonging to another task is recognised rather than lost.

**Only an explore task can be finished.** Watch and deepen run as long as there is anything new;
`intent_covered` becomes per-task and applies to explore alone. A standing assignment that
declares itself complete is a bug, and today's whole-Fellow version is exactly that. When every
task rests, the Fellow sleeps.

**A deepen task names a theme, not pages.** Its page set is ranked afresh each run, the same
demand-against-substance ranking the Deepen dialog uses, so what has already been built out
falls to the back on its own. A fixed set would run dry after two nights.

**The task decides the run, the step size only sizes it.** `kindsForStep` currently forbids
anything but `research-step` to a `small` Fellow, which would make a deepen task unrunnable on
it. The step size was never meant as a prohibition: it says how big an explore run may get.

**Drift is still only marked.** The score gets sharper - one task instead of a subject plus
notes - and the consequence stays what it is: the proposal reaches the recap with the mark, and
the user decides. Turning a newly sharpened measure straight into a veto would pay for its first
misreading in lost work, and the score is token overlap, which a well-put question in other
words can fail.

**Visible where decisions are made.** The Fellow card lists the tasks and their state (up next /
waiting / resting), and a recap proposal names the task it came from. Not in the bubble over the
figure: that says what the Fellow is DOING, which is a different question.

Carried over unchanged unless it proves wrong: the Fellow-level `scope` note stays as it is, a
qualifier on all tasks ("English sources only"), since nothing about it was the problem.

What this needs, in order: the task list on the agent record with the migration; the round-robin
cursor and the per-task `covered`; the planner prompt and the scope score against one task; the
run kind from the art, and the step size demoted to sizing; the deepen ranking reused from the
dialog; the card and the spawn form; the recap line.

## Proposal: the preprocessing chain has no sandbox (2026-09-07, built 2026-09-08)

Found while weighing `microsoft/markitdown` (rejected, see below). The agent runs are contained
at the OS level - bubblewrap, writes confined to the vault, no web outside the research profile,
a `PreToolUse` hook, and `permprobe` to prove it still holds. **The preprocessing chain that runs
before them is contained by nothing.**

Every ingest hands an attacker-chosen file to a parser running as the service:

| Tool | Reads | Written in |
|---|---|---|
| `pdftotext`, `pdfinfo`, `ocrmypdf` | the PDF | C / C++ |
| `pandoc` | docx, odt, epub, rtf | Haskell |
| `python3 scripts/extract-office.py` | pptx, xlsx, ods | Python + C extensions |
| `exiftool` | any image | Perl |
| `tesseract` | any image | C++ |
| `defuddle` | fetched HTML | JS |
| `yt-dlp` (+ `deno`) | a YouTube page | Python + JS |

`runTool` gives each a timeout and an output cap. That is a liveness guard, not a boundary: a
parser bug does not time out, it executes. And the process it executes in can read
`~/.config/vault-service/env` (0600, same user - the mode stops other users, not this process),
the SQLite database, the whole vault, and the unauthenticated API on 127.0.0.1.

The asymmetry is the point: a document reaches the parsers BEFORE any agent sees it, so the
weakest link runs first. Hard rule 4 protects the agent stage; nothing protects this one.

### What to build

The same shape the agent runner already proves works, applied one stage earlier.

1. **A sandboxed `runTool`.** One helper that runs a converter under bubblewrap: no network, a
   read-only bind of the single input file, a writable bind of one output directory, `--die-with-parent`,
   a new PID and IPC namespace, and no access to `$HOME`. Everything else stays - the timeout,
   the output cap, the argument array (never a shell string).
2. **A probe that proves it**, `preprocprobe`, beside `permprobe`: a crafted input that tries to
   read the credential file and to reach 127.0.0.1, run through the real chain. Expect both
   blocked. Re-run it after any change to the tool wiring, for the same reason permprobe exists -
   unit tests cannot see whether the containment is actually applied.
3. **Fail closed where it matters, open where it does not.** Without bubblewrap the agent runner
   refuses to start (`failIfUnavailable`). Preprocessing should refuse the same way, but a
   setting may allow the old behaviour for a machine that cannot provide it - stated in the log,
   not silently.
4. **Then, and only then, new converters are cheap.** A sandboxed subprocess is a boundary a
   tool cannot argue with, whatever it is written in. `markitdown` would fit behind it as a CLI
   in its own virtualenv, never as a library import, never given a URL.

### As built (2026-09-08)

All four points, in `server/src/pipeline/preprocess/sandbox.ts`.

`runConverter(bin, args, { reads, writes, timeoutMs, maxBuffer })` replaced the bare `runTool` at
every converter call site: `pdfinfo`, `pdftotext`, `ocrmypdf`, `pandoc`, the Python office
extractor, `exiftool`, `defuddle`. The jail is `--unshare-net` plus user, PID, IPC, UTS and cgroup
namespaces, `--clearenv`, `--die-with-parent`, `--new-session`, a tmpfs `/tmp` that is also `HOME`,
a read-only `/usr` and `/etc`, the input file, and one writable output directory. No vault, no
database, no credential file, no loopback.

`yt-dlp` is the documented exception and stays uncontained: it is a fetcher, its job is the
network, and containing it is a separate piece of work with a different shape.

Three things the build taught, all of them non-obvious:

- **Bind the prefix, not the home.** `defuddle` is an npm global under `.nvm` and `python3` is a
  pyenv shim; binding `$HOME` to reach them would hand back everything the jail exists to remove.
  `toolPrefix()` binds the directory holding the tool's `bin/` - and the prefixes of BOTH the
  invoked path and its realpath, because an npm global is a symlink whose target lives elsewhere
  and binding only one end leaves the jail unable to find the binary at all.
- **Hand bubblewrap the resolved path.** A bare name resolves against the JAIL's PATH, where
  `python3` is the system interpreter without the packages the extractor imports.
- **The jail's PATH needs those prefixes' `bin/`.** A `#!/usr/bin/env node` shebang otherwise looks
  its runtime up in the system PATH, which is exactly where an nvm node is not.

`PREPROCESS_SANDBOX=off` restores the old behaviour for a machine that cannot provide bubblewrap;
by default a missing `bwrap` fails the conversion with that sentence in the error, rather than
quietly converting uncontained.

`server/src/cli/preprocprobe.ts` runs the real tools against real canaries - the credential file,
the vault, the service API, the open internet - and checks both directions: that the four are
unreachable, that nothing written escapes to the host, and that pandoc, pdftotext, defuddle and a
python3 with its packages still work in there. Last run: 13 checks, all as expected. The unit
tests read the argument list and prove the policy; only the probe proves it is applied.

### Why markitdown itself is not worth it

- It is a converter, not a fetcher past a block. Its own README: "Like `open()` or
  `requests.get()`, it will access resources the process can access." The two blocked entries on
  this vault's reading list are both `subscription`; nothing here helps with those.
- Its coverage over the existing chain is `.msg` and audio. EPub and RTF were a set entry away
  (done, 2026-09-07) - `pandoc --list-input-formats` had them all along. ZIP is refused by hard
  rule 6 on purpose. Azure Document Intelligence would send vault documents to a third party.
- As a LIBRARY it would move untrusted-document parsing INTO the service process, together with
  its dependency tree - the opposite direction from everything above. As a sandboxed CLI it is
  fine, and then it is also unnecessary.
