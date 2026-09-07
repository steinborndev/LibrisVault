# Curious - Specification: Autonomous Research Agents in a Virtual Library

**Status:** v0.2, 2026-09-05. Condensed from the design sessions of 2026-09-05 and closed
by the review round of the same day: every open item is decided (section 17). Changes to
a decision go through this document first.

**Relation to LibrisVault:** this is an extension of the vault-service (LibrisVault). It is
developed and tested in this private repo, a fork of LibrisVault with a `research-agents`
branch, and merged into LibrisVault later by pull request. The document is written so
that it can become a section of LibrisVault's `SPEC.md` (a new section 12.10) at merge
time. Everything in LibrisVault's `SPEC.md` and `CLAUDE.md` stays authoritative; where
this document is silent, LibrisVault's rules apply.

**Naming.** The product name for a spawned agent is **Fellow**. Code, tables and API keep
the word `agent` (`agents` table, `agent_runs`, `/agents`); UI strings, the recap and this
document's user-facing sections say Fellow. The isometric room is the **Library** screen;
the tabular page view that carries that name today becomes **Catalog**.

---

## 1. Overview and goals

LibrisVault ingests material into a claude-obsidian vault and runs headless Claude Agent
SDK sessions in a sandbox: ingest jobs, maintenance runs, and web research runs that a user
starts by hand. Curious adds **Fellows**: resident research agents. The user spawns a
Fellow with an intent, and the Fellow drives that research question forward over many
runs. It reads the vault, proposes the next steps, executes what the user did not veto,
persists its own notebook in the vault, and stays within a configurable share of the
user's Claude plan.

A **virtual library** makes this visible. Every Fellow is a figure in an isometric
library: at the shelf while researching, at a desk while writing, shelving finished
articles as books into the department of their domain, asleep when idle. The runs that
LibrisVault already has (manual research, maintenance, ingest) are rendered in the same
room with the same animations, so the Library is a second renderer over the service's
activity stream, not a separate system.

**Goals**

1. Continuous value: a vault that keeps growing along the user's questions without the
   user driving every run, and a daily recap that makes the growth legible and steerable.
2. Bounded cost: every autonomous run is inside a quota the user set, expressed in the
   plan's own unit (percent of the 5-hour and 7-day windows) or USD in API-key mode.
3. Legibility: every decision a Fellow makes is a proposal the user saw, with provenance,
   and every run stays one revertable git commit.
4. Reuse: Fellows are ordinary research runs with a persistent identity. No new
   permission model, no new vault mechanisms beyond page conventions.

**Non-goals (v1)**

- No hosted or multi-user operation. Single local user, BYOK, PolyForm Noncommercial.
- No agent-to-agent chat and no concurrent vault writers. Collaboration goes through the
  vault and through service-side routing.
- No changes to the cloned claude-obsidian vault internals (LibrisVault hard rule 5).
- No mobile layout. The dashboard is desktop-only.

**Glossary.** *Fellow*: a spawned, resident agent. *Visitor*: the figure of a run without
a Fellow (manual research, ingest, maintenance). *Proposal*: one candidate next step a
Fellow wrote. *Plan*: the proposals that will run in the next night shift. *Step*: one run
of a Fellow. *Night shift*: the daily execution window. *Veto window*: the time between
recap and night shift in which the user can veto or adjust. *Recap*: the daily report.
*Department*: a domain of the domain registry, drawn as a section of the Library.
*Shelf*: where a department's books stand. *Book*: a wiki page. *Card*: the Fellow
summary panel.

---

## 2. Decisions

From the design sessions (2026-09-05):

1. Curious is a private fork of LibrisVault with a `research-agents` branch, behind the
   feature flag `AGENTS_ENABLED`, rebased on the public `main` regularly and merged by PR.
   Commit hygiene follows LibrisVault hard rule 7 from the first commit, because the
   history becomes public on merge.
2. Autonomy model is **propose-then-run with a veto window**. Nothing runs that the user
   did not see as a proposal; a zero-length veto window is the "auto" special case.
3. Fellow memory is a **page in the vault** (notebook), not an SDK session resumed across
   days. Operational state lives in SQLite.
4. **Step size and model are configurable per Fellow**, including Fable for a complex
   problem. The spawn dialog shows the cost factor.
5. A **daily recap** reports what the Fellows did, carries their proposals in
   multiple-choice form, and lets the user adjust.
6. **Library screen**: Fellows stand at the shelf while researching, write at a desk, and
   shelve finished articles as books into their department. Domains are departments. A
   click on a shelf opens that domain in the graph.
7. The **existing runs are rendered too**: a manual research run is a visiting researcher
   with the same animations, a maintenance run is a caretaker (clearing old books, for
   example), an ingest job reads the source as a book.
8. **Every Fellow is clickable** and opens its card: name, what it works on, when it was
   last active, which articles it wrote, what it plans to do.

From the review round (2026-09-05), the full list is in section 17. The ones that shape
the architecture: a Fellow's model and effort apply to all of its runs including
planning; the recap is always written on the default model; the night shift is 01:00 to
06:00 local; the veto window lasts until the next night shift; spawning starts the first
full run immediately unless deselected; manual research runs are not limited by the
Fellows' research share; the recap is English everywhere; Telegram answers are coded
text replies; the room is Library and the table view becomes Catalog.

---

## 3. Constraints inherited from LibrisVault and the vault

**LibrisVault hard rules (CLAUDE.md).** (1) Vault integrity first: the vault is written
only through agent runs, git commits, and user page edits; every mutation is one commit
behind the shared commit mutex; SQLite holds operational state only. (2) Localhost guard.
(3) Credentials only in the service environment. (4) Agent-run permissions are enforced by
the SDK sandbox (bubblewrap) plus a `PreToolUse` hook; `canUseTool` is not the enforcement
point; run `permprobe` after any SDK or permission change. (5) No modification of the
cloned vault internals; extensions only through the system-prompt extension or a thin
wrapper skill. (6) Incoming files are never executed. (7) No vault content in anything
committed to a public repo, including commit messages.

**Concurrency.** Maintenance runs (research included) are serialized by the maintenance
`runMutex`; ingest jobs run up to `concurrency` in parallel through their own queue; all
commits share one `commitMutex`. Consequence: **at most one Fellow works at a time**, and
Fellows are executed sequentially inside the night shift.

**Existing research mechanics that Fellows reuse unchanged.** `startResearch(topic,
profileKey)`: lens profiles are a closed set (`broad`, `sota`, `patents`, `startups`), the
service pins the synthesis title per lens, overlap steering injects the pages the vault
already has on the topic, and the synthesis mandate defines "done". Research runs use the
`research` permission profile (vault writes plus web egress with the skill's hygiene rules).
Read-only runs use the `query` profile. Every run is recorded in `agent_runs` with lens,
tokens, cost and commit.

**Vault conventions.** All wiki content in English. Page hygiene, entity notability and
tag hygiene blocks are injected into every writing run. Domains come from the vault's
domain registry page (`type: meta`); an ingest may only pick a listed key or `unassigned`.
Pages of `type: meta` are excluded from the lint's tiling scan and need no address; every
other page created after 2026-04-23 needs an allocated address. The lint requires the
frontmatter fields `type, status, created, updated, tags`. The autoresearch skill's
`program.md` caps a run at 3 rounds, 5 sources per round and 15 pages; the synthesis page
carries an `Open Questions` section, and the skill's own principle says those questions
feed the next cycle. The registry's own wording: "a domain is a shelf, not a book".

**Plan and SDK facts (verified 2026-09-05).** Agent SDK usage counts against the Claude
subscription limits; the separate SDK credit announced for June 2026 was paused. The plan
has a rolling 5-hour window, a 7-day window across all models, and per-model 7-day buckets
(Sonnet, Opus, model-scoped such as Fable); there is no daily window. Anthropic publishes
no token or dollar size for any window. SDK 0.3.212 exposes the windows as percentages
through an experimental `usage()` method on the query object; `rate_limit_event` messages
carry `utilization` only near thresholds; the raw `api/oauth/usage` endpoint is
undocumented and rate limited. `maxBudgetUsd`, `model` and `effort` are query options.
`total_cost_usd` is a client-side list-price estimate. Weekly limits are temporarily +50 %
until 2026-09-13 and permanently +25 % from 2026-09-14 (net -17 % against today).

---

## 4. Architecture

### 4.1 Components

| Component | Where | Role |
|---|---|---|
| Fellow registry | server, SQLite | agents, proposals, handoffs, recaps, usage samples, value events |
| Planner | server, read-only run | turns candidates into ranked proposals with provenance |
| Scheduler | server | night shift, veto window, quota gate, wake-ups |
| Run kinds | server, maintenance runner | `research`, `research-step`, `research-expand`, `plan`, `recap` |
| Usage monitor | server | samples plan utilization before and after runs, learns points per USD |
| Recap builder | server | assembles the daily recap, writes the vault page, delivers |
| Notebook writer | inside runs | the run reads and appends the Fellow's notebook page |
| Library renderer | web | isometric scene over the activity stream plus Fellow state |
| Fellow card | web | the summary panel, reachable from every screen |

Everything server-side is behind the feature flag `AGENTS_ENABLED` (default off), so the
merged LibrisVault behaves exactly as before until the flag is set. The Library screen
ships with the same flag but renders the existing runs with zero Fellows.

### 4.2 The daily cycle

1. **Night shift**, 01:00 to 06:00 local, one 5-hour window of the plan. The scheduler
   executes the plan sequentially: for each Fellow with quota left, the approved proposal
   or, in veto mode, the top undecided one. After the executions, each active Fellow gets
   a planning run against the fresh vault state and writes new proposals for the next
   night.
2. **Recap** at 07:00. The recap builder collects the night's runs, costs, pages, failures
   and the new proposals, writes `wiki/meta/recaps/<date>.md`, and delivers to the
   dashboard inbox and Telegram. On a quiet day (no runs, no new proposals) it sends a
   one-line note to dashboard and Telegram and writes no vault page.
3. **Veto window**, the day until the next night shift. The user approves, vetoes,
   reorders or adjusts proposals in the dashboard, in Telegram, or not at all. Undecided
   proposals run at night in veto mode, never in manual mode.
4. **Wake-ups** outside the cycle: a new ingest in a Fellow's home domain adds a candidate
   for the next planning run; the manual "run next step" on the card runs now, subject to
   the same quota gate; spawning runs the first step now (section 5.1).

### 4.3 Data flow of one step

Proposal (SQLite) to run prompt (topic, lens, step constraints, notebook excerpt, overlap
block, synthesis mandate) to sandboxed run (research profile) to one commit to run record
(pages created and updated, cost, plan-percent delta) to notebook append (inside the run)
to recap line (next morning) to card (any time).

---

## 5. Fellows

### 5.1 Fellow record

| Field | Meaning |
|---|---|
| `name`, `slug` | display name; slug names the notebook page |
| `intent` | the research question, free text, the scope anchor |
| `scope` | optional exclusions and emphases, free text |
| `home_domain` | registry key; `extra_domains` optional list |
| `lens` | research profile key, default `broad` |
| `model` | `sonnet-5` (default), `opus-5`, `fable-5-1`; applies to every run of the Fellow, planning included |
| `effort` | SDK effort level, default `high`; applies like `model` |
| `step` | the largest step the planner may propose: `small`, `standard` (default), `deep` |
| `quota_runs_per_day` | hard cap on steps per day, default 1 |
| `quota_week_pct` | optional per-Fellow share of the weekly window; null inherits the global research share |
| `autonomy` | `manual` (approve each), `veto` (default), `auto` (veto window zero) |
| `priority` | ordering inside the night shift, default equal |
| `state` | see 5.2 |
| `notebook_path` | `wiki/meta/agents/<slug>.md` |

**Spawn.** The dialog shows the projected cost per month in USD and, once calibrated, in
percent of the week, computed from the model factor and the step size. Spawning starts
the **first full research run on the intent immediately** (a checkbox, on by default,
subject to the quota gate); the first planning run follows in the next night shift. With
the checkbox off, the Fellow's first activity is that planning run, and its first step
appears in the next recap.

### 5.2 States

`proposed` (created, no run yet) - `active` - `waiting` (plan awaits the veto window or
approval) - `sleeping` (nothing to do or quota exhausted, with `sleep_reason`) - `paused`
(by the user) - `blocked` (last run failed, needs attention) - `retired`.

Transitions are logged. Retirement keeps every page the Fellow wrote; the notebook gets
`status: retired`, pending proposals expire, pending handoffs to it become unclaimed, and
the figure leaves the Library.

### 5.3 Stop criteria and wake-ups

A Fellow goes to sleep when one of these holds: **two consecutive runs with outcome
`no-changes`**; no open questions and no candidates in its domain; the planner reports the
intent as covered; the quota is exhausted (wakes at the window reset). It wakes on: a new
ingest in its home domain, a user answer in the recap, a manual step, or an edit of its
intent.

### 5.4 Notebook page

Path `wiki/meta/agents/<slug>.md`, frontmatter `type: meta`, `status: active|retired`,
`created`, `updated`, `tags: [meta, agent]`, plus `agent_id`, `home_domain`, `model`.
Sections in this order: `Intent`, `Scope`, `Plan` (rendered from SQLite), `Log` (one line
per run: date, kind, topic, pages, cost), `Open Questions` (the Fellow's running list),
`Notes` (free, user-editable). The service **reads back only `Intent` and `Scope`**; every
other section is rendered from SQLite and re-written by the service after each run, so the
page can never become a second source of truth. Runs append to `Log` and `Open Questions`
through the ordinary run commit; the service rewrites `Plan` in its own commit. **Fellows
never write another Fellow's notebook**; handoffs are service-side records (section 6.6).

---

## 6. Planning and proposals

### 6.1 Candidate sources

Deterministic, computed by the service before the planning run, all vault-internal:

1. `Open Questions` sections of the Fellow's own synthesis pages and notebook.
2. Graph gaps (unresolved wikilinks) whose referrers are the Fellow's pages or pages in its
   home domain, ranked as the existing "Worth a run" backlog ranks them.
3. Stubs in the home domain.
4. Sources ingested into the home domain since the Fellow's last run.
5. Handoffs from other Fellows (section 6.6).

Fetched web content never becomes a candidate directly; it reaches the planner only after
a run filed it as a vault page under the skill's sanitization rules.

### 6.2 Planning run

Kind `plan`, profile `query` (read-only, no web), **on the Fellow's model and effort**
(default Sonnet 5, about 0.4 USD; Opus and Fable scale by their factors), timeout 5
minutes, `maxBudgetUsd` 1 on Sonnet 5 and scaled by the model factor otherwise. Input:
intent, scope, candidates with their source pages, the notebook's last log lines, the
Fellow's remaining quota and its maximum step. Output: structured (JSON schema) list of at
most three proposals plus an explicit "nothing worth a run" option with a reason. **The
planner chooses the smallest run kind that fits each candidate** (`research-step` for a
single question, `research-expand` for deepening listed pages, `research` for a sweep),
never above the Fellow's `step`.

**The three layers state the same limits** (topic 500 characters, rationale and reason 2000,
handoff reason 1000, at most 20 pages and 3 proposals): the JSON schema that binds the model,
the prompt in words, and the parser. They did not agree once - the schema said nothing about
length while the parser refused a topic over its cap - and one long topic threw away a whole
night's plan, three proposals and eight handoffs with it.

**What the service does with an answer it cannot use**: a field over its cap is cut to the
cap, a single proposal or handoff that still does not parse is dropped on its own with a line
in the run log, and only an answer that is no answer at all (no object, no proposal list, no
verdict) counts as failed. Such a failure is **retried once inside the same cycle**, with the
reason appended to the prompt, because waiting for the next night shift costs the Fellow a
day. If the retry fails too, the Fellow sleeps with `plan-failed`, which the night shift plans
again like `idle` but the library draws as a warning rather than a resting figure.

### 6.3 Proposal schema

`kind` (`research`, `research-step`, `research-expand`), `topic`, `lens`, `rationale`
(one paragraph against the intent), `provenance` (the candidate and its source pages),
`page_set` (for expand: the pages it may touch), `est_cost_usd`, `est_plan_pct` (once
calibrated), `scope_score` (0 to 1, section 6.4), `rank`.

### 6.4 Scope anchor and drift

Every proposal is scored against the intent by the service (token overlap between topic
plus rationale and intent plus scope, the same tokenizer the overlap steering uses). Below
a threshold the proposal is flagged "drift" in the recap and never runs undecided; in
`auto` mode it is dropped. The planner also has to name the candidate it came from, and
a proposal without provenance is rejected by the service.

### 6.5 Veto window and approval

- `manual`: a proposal runs only after the user approved it.
- `veto` (default): the top-ranked undecided proposal runs at the next night shift unless
  vetoed; the user may pick a different one, reorder, or edit the topic text. The window
  is the time until the next night shift; there is no separate timer.
- `auto`: the planning run and the execution happen in the same night.

A proposal not executed within two cycles expires and is superseded by the next planning
run. Decisions record the channel (`dashboard`, `telegram`, `auto`).

### 6.6 Collaboration

- **Home domains.** Each Fellow owns its home domain for routing purposes; two Fellows may
  share a domain.
- **Routing.** An open question outside the Fellow's domains becomes a handoff to the
  Fellow whose home domain matches (a candidate for that Fellow's next planning run). With
  no match it becomes an **unclaimed request** in the recap, offered as a spawn proposal
  that opens the spawn dialog prefilled with intent, domain and provenance. As built (A3):
  the planner names the domain of a candidate it judges foreign (the registry rides in
  its prompt); the service picks the target Fellow (home or extra domain, highest priority,
  never the source) or leaves the request unclaimed; the recap codes requests `u1`, `u2`
  and the dashboard's Recap view carries the prefilled spawn form.
- **Dedupe.** Before the night shift the scheduler compares all pending topics with the
  overlap tokenizer and against existing synthesis pages; near-duplicates are merged into
  one proposal for one Fellow and noted in the recap. As built (A3): undecided topics with
  an overlap coefficient of at least 0.6 across Fellows lose to the earlier Fellow in shift
  order (approved ones never lose) and are superseded with a note; a topic within 0.7 of an
  existing synthesis page title is noted, not dropped.
- **Notebooks are private.** Handoffs live in the `handoffs` table, never in another
  Fellow's page.

---

## 7. Run kinds

| Kind | Profile | Writes | Bound | Cost class on Sonnet 5 |
|---|---|---|---|---|
| `research` | research | new pages plus overlap-steered updates, as today | skill caps (3 rounds, 15 pages) | about 6 USD |
| `research-step` | research | as `research` with tightened caps | 1 round, 5 sources, 5 pages | about 2 USD (estimate) |
| `research-expand` | research | append-only edits to a listed page set, plus at most K new pages | page set from the proposal | about 2 to 4 USD (estimate) |
| `plan` | query | nothing in the vault | 5 minutes, 1 USD | about 0.4 USD |
| `recap` | query | the recap page (through the service, not the agent) | 3 minutes, 1 USD | about 0.3 USD |

**The hot cache is a cache, in every run** (as built, 2026-09-07). `wiki/hot.md` is loaded at
the start of every run, and the wiki skill sizes it at about 500 words, rewritten each time.
The autoresearch skill's filing step only says "update wiki/hot.md with the research summary",
though, and a Fellow following that literally adds to it on every run: one vault's copy grew
from 401 to 826 words over eight runs, with no refresh in between, because the refresh run is
the only one that ever said "rewrite from scratch" and it had never been started. So the
research prompt states the rule itself (rewrite, keep it under the budget, never append below
an earlier run), and a run whose post-run validation reports `hot-cache-size` queues one
refresh behind itself - once a day at most, and never from a refresh. The maintenance card
dates the refresh from the last `hot-cache` run rather than from the file's mtime, which every
research run touches, and shows the cache's length beside its budget.

**Step sizes.** `small` = `research-step`; `standard` = `research`; `deep` = `research`
with `effort` raised and timeout 45 minutes. The Fellow's `step` is the maximum the
planner may propose; the first run on the intent is `standard`. The tightened caps are
injected as a block that explicitly overrides the skill's `program.md` caps for this run,
because the service must not edit the vault's program file (hard rule 5).

**Model and effort.** A Fellow's `model` and `effort` apply to **all of its runs**,
planning included, so a Fable Fellow plans and researches on Fable; the cost factors are
Opus 5 about 2.5 times Sonnet 5 and Fable about 2 times Opus. The `recap` run is service
work and always runs on the default model (Sonnet 5).

**`research-expand` rules (the deferred "Achse B").** The proposal lists the pages the run
may edit: the Fellow's own synthesis page, its notebook, and at most N existing pages. The
prompt states: append-only, dated `## Update <date>` sections, never rewrite or delete
body text, frontmatter `updated`, `related` and `tags` may change. After the commit the
service validates with `git diff --numstat` against the commit's parent: any modified page
outside the set, or any deleted body line inside the set, fails the run; the service
**reverts the commit with a new commit** (never a history rewrite) and marks the run
`failed` with the finding. New pages obey the normal hygiene and address rules. As built
(A3, docs/tasks/TASKS-A3.md D1 to D3): the page set is the planner's listed pages that
exist (at most 4) plus the Fellow's synthesis pages and notebook; "deleted body line" is
checked as the old body surviving line by line in order (insertions allowed); at most 3
new pages; the revert restores the commit's paths from its parent in a new commit; the
Fellow sleeps `idle` with the finding rather than going `blocked`, so the planner carries on.

**Caps on every run.** Timeout per kind, `maxBudgetUsd` per kind scaled by the model
factor, the `research` profile's web hygiene, and the existing zero-token guard.

---

## 8. Scheduling and quota

### 8.1 Units

The plan speaks percent. Quota is therefore expressed in **utilization points** of the
plan windows when the service runs on a subscription, and in **USD** when it runs on an
API key (the existing daily budget's unit rule).

### 8.2 Global knobs (settings)

| Setting | Default | Meaning |
|---|---|---|
| `researchShareWeekPct` | 10 | points of the 7-day window all Fellows together may consume |
| `researchShare5hPct` | 15 | points of any 5-hour window Fellows may consume |
| `reserve5hPct` | 60 | no Fellow run starts when the 5-hour window is above this |
| `reserveWeekPct` | 80 | no Fellow run starts when the 7-day window is above this |
| `nightWindow` | 01:00 to 06:00 local | the execution window |
| `recapTime` | 07:00 local | when the recap is built |
| `researchModelDefault` | `sonnet-5` | default model for new Fellows |

Settings keys as implemented: `nightWindowStart`, `nightWindowEnd` (local `HH:MM`),
`researchModelDefault` (A1), `recapTime` (A2, default 07:00), and since A5 the shares and
reserves above plus `planWeekUsd` (default 1000) and `plan5hUsd` (default 80): the section
16 reference sizes of the two windows in USD list price, which turn the percent shares into
USD budgets while no plan data is measured (8.3). All six are settings-API keys; the
dashboard shows them in the System's Plan panel and does not edit them yet.

The global daily budget of LibrisVault (jobs per day or USD per day) stays the outer
ceiling; Fellow runs count against it like any other run. **Manual research runs are not
limited by the research share or the reserves**: they are the user's own decision and run
as today, bounded only by the daily budget and the plan windows themselves. The recap
header shows total consumption, manual runs included.

### 8.3 Measurement

Before and after every Fellow run the usage monitor samples all windows through the SDK's
`usage()` method (experimental; the call is wrapped so that its absence only disables
plan-percent accounting). The delta per window is stored on the run. From the deltas and
the run's `cost_usd` the service learns **points per USD** per model as a running median,
which prices proposals in plan percent and lets the scheduler compute how many steps fit
into the research share. Fallbacks: `rate_limit_event` utilization when present, then the
raw usage endpoint (cached 3 minutes), then USD-only accounting. Interactive use during a
run adds noise; night runs and the median absorb it.

As built (A5, docs/tasks/TASKS-A5.md): the SDK's usage data comes from the API's
rate-limit headers, so the sample taken before a session's first request carries no
windows and the session is gone with the result message. The runner therefore samples on
assistant messages: the first one is the "before", later ones every 30 seconds and always
on a text-only message (the final answer), and the last of them is the "after". Every
sample lands in `usage_samples` (window, utilization, reset, phase, source, run); the
per-window delta lands on the run row (`agent_runs.plan_pct_delta`), diffed against the
newest sample from at most three minutes before the run when there is one (the previous
run's "after" in a shift, an endpoint tick) and against the run's own "before" otherwise,
so the first request of a session is not lost in a shift. Utilization comes as
integer percent, so single-run deltas are coarse and the median over runs is what
calibrates; three measured runs per model make a calibration. The `rate_limit_event`
messages seen so far carry the window and its reset time but no utilization; the monitor
keeps the reset times from them, so the consumption windows and the refusals know when a
window turns even before a utilization sample exists. The raw usage endpoint refuses a
setup token without the `user:profile` scope (`permission_error`); the monitor reports the
refusal as the reason and accounts in USD-equivalent until a sample arrives. Without
calibration the shares gate in USD-equivalent (8.2); once calibrated for a model, points
take over per window. The reserves need a measured utilization and stay off without one.

### 8.4 Gate and exhaustion

A step starts only if: the Fellow has runs-per-day left; the research shares (week,
5-hour) have room for the estimated delta; both reserves are respected; the daily budget
is not exceeded; the queue is not rate-limit paused. Otherwise the Fellow sleeps with the
reason, visible on the card and in the Library, and wakes at the relevant `resets_at`.

As built (A5): the gate prices every Fellow run by its kind and model (section 16 sizes,
in points once calibrated) and holds planning runs as well, because they spend plan points
too and the reserves protect the user's own use of the plan; only the runs-per-day quota
skips planning. The refusal codes are `reserve` and `share`, each naming the window and,
when known, its reset; the shift turns them into the sleep code `plan`. Manual steps from
the card or the API get the same refusal (409) and leave the Fellow's state alone.

**The one limit a manual run may pass is runs per day.** It is a limit on the autopilot,
not on the user: the user set it so the night shift would stop, and a deliberate click has
already made that decision again. So `POST /agents/:id/step` and `POST /proposals/:id/run`
take `override: true`, which skips **only** the runs-per-day check. Everything else holds
for a manual run exactly as for the shift - the shares, the reserves, the daily budget and
the rate-limit pause guard the user's own capacity, and a click must not spend it silently.
The run counts in the ledger like any other. The night shift never sends the flag.

The card asks before the click rather than answering with a 409 after it: once the quota is
spent the button reads "Run a step anyway · 1 of 1 today", and only the confirming click
carries the override, next to a line saying which limits still apply. Every refusal reply
carries its `code` beside the message, so the screen can tell an overridable quota from a
share or a reserve. The card also carries **"Plan again now"** for `POST /agents/:id/plan`,
the planning run the quota never gated in the first place.

### 8.5 Ordering inside the night shift

Fellows run in a round-robin by priority (user-set, default equal), one step each, then a
second round if quota and window remain. Runs are sequential (mutex) and each run has its
timeout, so a five-hour night fits roughly ten to twenty full runs. The scheduler prefers
to start right after a 5-hour `resets_at` inside the window.

As built (A5): when a round makes no progress and a plan refusal named a reset that lies
inside the window and at most four hours ahead, the shift waits for it once (plus half a
minute), wakes the Fellows sleeping on `plan`, and runs another round. The monitor's
endpoint sample is refreshed before every round.

---

## 9. Daily recap

### 9.1 Content

Header: date, the night's window, plan utilization now (5-hour, week, per model),
research share consumed this week, total consumption including manual runs, failures,
unclaimed requests, dedupe notes, and the value line (section 9.6).
Per Fellow: what ran (kind, topic, pages created and updated with links, commit, cost in
USD and points), what it found (three lines), open questions, and the proposals for the
next night as a multiple-choice block: `A`, `B`, `C`, `skip tonight`, `pause Fellow`, and a
free-text line. Every proposal shows rationale, provenance and estimated cost.

### 9.2 Generation

Deterministic skeleton from SQLite and the run records; the three "what it found" lines
per Fellow are written by **Sonnet 5** from the run's result text (about 0.3 USD per
recap), never by the Fellow's own model. The page is written by the service through the
ordinary page write path (one commit), never by an agent. Quiet day: one line to dashboard
and Telegram ("nothing ran, N Fellows sleeping, reasons"), no vault page.

**Two shelf lives in one recap** (as built, 2026-09-07). What ran last night is history and
stays exactly as recorded. The proposals, the Fellow's state and its remaining quota are a
decision the reader has yet to make, and they go stale the moment a planning run finishes or
an answer lands: a plan once arrived 28 minutes after the build, and "proposals for tonight"
stayed empty until the next morning. So **the decision half of the NEWEST recap is re-read on
every request** - from the store, with no agent run and no page rewrite - and its codes are
re-issued from the live list, with answers resolving against that same refreshed model so a
code always names what the reader sees. An answer returns the recap read back the same way, so
an approved proposal shows as approved. Older recaps are the record of their day and are never
refreshed. The stored row is never rewritten by any of this; what only a full rebuild would
add - runs the snapshot does not know about and their summary lines - is counted in
`sinceBuilt` and said in one line above the recap, next to the button that costs the agent
run.

### 9.3 Channels

- Dashboard: Home's flow box and a "Recap" view (`/recap`, `/recap/<date>`) with the
  multiple-choice blocks as buttons; the card links back. As built (2026-09-06): Home's
  flow zone is one box with two views, switched in its head and holding one height, so the
  screen never jumps. **Daily recaps** leads and is what the screen opens on: the newest
  recap is open and answerable straight away, the earlier ones follow under it in one
  scroll region, and the day in view drives the five lead figures. Its rail carries the
  Fellows as pills (name and home domain, five slots, an empty one deep-links to the
  Library's spawn form at `/library?spawn=1`) and one calendar week of days, newest first,
  with arrows stepping a week at a time. Picking a Fellow dims the nights it did not work
  and those days still open with the reason, taken from the shift's skip note, the sleeping
  note, or the Fellow's own state; picking a day shows that day alone. **Activity** is the
  stream that was there before, one click away. In every recap a Fellow's proposals come
  first and the night's work reads as context under them, on Home and on the Recap screen
  alike.
- Vault: `wiki/meta/recaps/Recap <date>.md`, `type: meta`, readable in Obsidian. Rendering
  only in v1: edits made in Obsidian are not read back (a later upgrade). (The file carries
  the `Recap` prefix because the vault's `.gitignore` ignores bare date names; A2.)
- Telegram: the same text, proposals coded `1a`, `1b`, `2a`; the user answers with codes
  (`1b 2a`, `veto 3`, `pause 2`) on the existing minimal bot client. Inline keyboards are a
  later upgrade. As built (A2): plain text, one message for the header and one per Fellow,
  to every allowlisted user; the bot applies an answer before its note-ingest path.

### 9.4 Adjusting

Allowed answers: pick a proposal, veto, reorder, edit the topic text, change step size or
model for the next step, pause or resume a Fellow, spawn a new Fellow from an unclaimed
request (opens the spawn dialog prefilled), free text that becomes a note on the notebook
and a candidate for the next planning run. "Skip tonight" is a Fellow field (`skip_until`,
A2): the next shift runs nothing for the Fellow and still plans; approvals survive.

### 9.5 Language

English everywhere: the recap is a vault page (vault language rule), and one text feeds
all channels.

### 9.6 Value signal (minimal, v1)

The service counts, locally and without any external tracking, two events: a Fellow page
opened in the dashboard, and a recap link clicked. Both are attributed to the Fellow whose
page it is. The card shows "opened N times this month", the recap header shows the totals.
Richer signals (chat citations, hot.md mentions) are a later upgrade.

---

## 10. Library screen

### 10.1 Purpose and principles

The screen shows the vault as a library and the service's activity as people working in
it. It is a **renderer, not a system**: everything it draws comes from data the service
already has (activity stream, run logs, vault stats, Fellow state). It costs no tokens.
The ledgers and tables remain the record; the Library is the ambient view. It works with
zero Fellows, rendering the existing runs.

### 10.2 Scene adapter

Every activity becomes an actor with identity, pose, props and exit:

- **Identity.** Residents are Fellows (named figure). Visitors are runs without a Fellow,
  by kind: an **anonymous visiting researcher** (manual research), reader (vault research
  chat), acquisition clerk (ingest), inspector (read-only maintenance), caretaker (writing
  maintenance).
- **Pose rule.** The pose follows the tool family the run has been in **recently**, not the
  single newest line: `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` = at the shelf;
  `Write`, `Edit` = at the desk; commit = shelving; nothing in the window = thinking. Job
  states override (queued = at the front desk, preprocessing = unpacking). Research keeps
  its finer phase bar.
  Read off the newest line alone the figure flickered: an agent logs `→ Write(…)` and
  `← tool ok` 20 ms apart, and the confirmation is not idleness. So lines that carry no tool
  are skipped, and of the rest inside a 30 s window the family with the most lines wins - a
  tie keeps the earlier one, so a new family has to outweigh the old before the figure
  moves. A commit is a moment, not a phase: it takes the pose for 8 s and then counts for
  nothing. This matters beyond the pose, because reading sends a Fellow to the shelf of its
  home department - often in another wing, where the main room simply does not draw it.
  A Fellow that is `active` between two steps keeps its desk instead of jumping to the door,
  and a figure entering a room fades in rather than appearing hard on the floor.
- **Props** carry the differences: book = page, parcel = raw file, notice board = hot.md,
  card catalog = index, clipboard = inspection, cart = re-sorting, label = tag fix.
- **Exit.** Done = shelves and leaves (visitor) or sits down and sleeps (Fellow);
  failed = leaves the book on the desk with a marker; duplicate = returns cart;
  cancelled = parcel taken away; deferred = parcel waits at the front desk.

### 10.3 Scene catalogue

| Activity | Figure | Scene | Signal |
|---|---|---|---|
| manual research | visiting researcher | shelf, desk, shelves the synthesis, leaves | research phases, commit |
| Fellow step | resident | same poses, then sleeps in the reading room | run plus Fellow state |
| vault research (chat) | reader | at a table with books, writes nothing | query profile |
| ingest job | acquisition clerk | parcel at the front desk, unpacking, reading the source as a thin volume, shelving new books by domain | job states, commit, page domains |
| duplicate, deferred, failed, cancelled | acquisition clerk | returns cart, waiting parcel, marked book, parcel removed | job state |
| Telegram drop | parcel | arrives through the mail slot | drop channel |
| lint, domain-review | inspector | walks the shelves with a clipboard | read-only kinds |
| lint-fix, repair, cleanup, tag-fix | caretaker | clears old books, relabels, removes dead references | writing kinds |
| user delete, revert | caretaker | takes a book off the shelf | edit events |
| domain-backfill | caretaker with cart | moves books between departments | kind plus page list |
| hot-cache | caretaker | renews the notice board at the entrance | kind |
| retrieve-index | none | the card catalog re-sorts itself | deterministic kind |

The maintenance mutex is drawn literally: one researcher or caretaker at a time, the
others wait at the front desk; ingest clerks run in parallel up to `concurrency`.

### 10.4 Rooms, departments, shelves and books

The library is a **sequence of rooms on one shared grid**, and the screen shows **one room
at a time**, filling the canvas. Every room is 23 by 11 tiles with seven shelf slots along
the long back wall, and every shelf has the same width, so the camera never changes between
rooms and nothing ever gets small, however many wings there are. Each room has **one door**
in the middle slot of its long back wall, in line with the passage of the middle row: in
the main room it leads to the wings, in a wing to the next wing.

**The main room** is the hub the user furnishes: four **favorite slots** along the long
wall, a pair on each side of the door, each pair centred in its wall section with equal
space on both sides; the fireplace in the front left with four armchairs where Fellows
rest between steps; four desks with computers in the front right where Fellows write; the
notice board (hot.md) centred on the short wall; and beside the path from the door the
front desk with the parcels of the ingest queue, the **intake cart** with the unfiled
books, and the card catalog (the index). Walls carry no windows. Tall furniture stands only in the back half or free with nothing important
behind it; low furniture stands in front.

**A wing** holds **12 shelves in two rows**: three, the door, three along the long back
wall, and three plus a passage plus three in a middle row parallel to it, the passage in
line with the door. All shelves stand parallel to the long wall with their open side toward the viewer,
so every sign reads in the same direction; there are no shelves along the short wall. Free
slots are drawn as light shelf silhouettes, so capacity is visible.

Departments come from the domain registry. A department's shelf stands in a wing or in a
favorite slot of the main room, never in both. Every bookcase carries its department name
as a sign on the top band of its face, one text size per view, two lines for long names.
Textures: the **Archive** preset, a stone floor, panelled walls and walnut shelves, day
and night.

### 10.5 Fellow card

Opened by clicking a Fellow, by the Fellow list in the control column (the accessible
path), from the research ledger's Fellow chip, and from the recap. Deep link
`/library?agent=<id>`. Docked beside the canvas per DESIGN.md (the canvas shrinks, no
overlay on a control corner). **Fellow management lives here**: the control column holds
the Fellow list, the spawn button and filters; runs stay in the research ledger with a
Fellow chip.

Fields: name, intent, home domain, model, step, state and sleep reason; **the current run
live** (topic, phase bar, log tail over the existing SSE channel); last active; **pages
created and pages updated as two lists**; plan (approved and pending proposals); runs and
points this week, quota left; the value line; link to the notebook and "Open in Obsidian".
Actions: run next step now, pause or resume, veto the next plan, open notebook, filter the
research ledger by this Fellow, retire.

### 10.6 Focus mode

A toggle in the canvas header, `Full | Focus`, reduces the screen to the room: the control
column, the box head, the legend and the ledgers recede, the tabs stay for navigation
(Fullscreen additionally hides those, as on the graph). What remains on the canvas: the
toggle and a search button top right, the now chip bottom left, the department signs.
Clicking a Fellow in focus mode opens a **popover** anchored to the figure: kicker (role,
domain, state), name, what it works on now with step and phase, what runs tonight with the
estimated cost, and two actions, "Open card" (switches to full mode with the docked card)
and "Pause". The popover is the only chrome that appears in focus mode; everything else
waits in full mode.

### 10.7 Rendering and assets

2D canvas with pre-rendered isometric sprites, no engine. A pose vocabulary of six to
eight poses (stand, walk, read at shelf, write at desk, shelve, sleep, wait, think) shared
by all roles; props differentiate roles. **Assets are decided after a sprite test**: one
figure with three poses in two styles (generated pixel art against a purchased isometric
pack), judged on consistency and on a license that allows redistribution in the public
repo. Controls live on the canvas as on the graph screen. The screen follows DESIGN.md
(fonts, color roles, 1180 px lane or the wide lane, desktop-only, no raw hex).

### 10.8 Rooms, navigation, growth

- **One room per view.** The mouse wheel, the arrow keys, a **room strip** on the canvas
  (pills with the room names, shelf counts and an activity dot) and the Rooms list in the
  control column all page between rooms; the next room slides in. Main room first, then the
  wings in the user's order. Fit and zoom act within the room. Focus mode pages to the room
  where the active Fellow works.
- **Wings are the user's.** Create a wing (it is appended to the sequence), rename it,
  reorder wings, and move shelves by **drag and drop**: onto a room in the strip or the
  Rooms list to move a shelf into that room's first free slot, onto the main room into the
  next free favorite slot, onto another shelf in the same room to swap the two. A shelf
  keeps its slot until the user moves it.
- **Automatic placement, only where undecided.** A new domain takes the first free slot of
  the newest wing; when no slot is left, a new wing opens, named after its letter until
  renamed. A department that outgrows its shelf gets a second shelf of the same width in
  the next free slot. Spines saturate on a logarithmic curve, so a thousand-page department
  looks full, not larger.
- **Perspective rules the renderer enforces.** Shelves only parallel to the long wall, open
  side toward the viewer; tall objects only in the back half or free-standing; one tile
  free in front of every shelf; wall decoration only where the frame always shows it, with
  a drawing depth behind nothing that overlaps it.
- **Level of detail.** Below a tile size of about 34 px the signs leave the shelves (the
  docked-card view, thumbnails); below about 18 px only colored blocks remain.

### 10.9 Navigation and naming

The room takes the route `/library`; the tabular page view moves to `/catalog` and is
renamed **Catalog** in the header. Because the old path is reused, no alias can keep old
Catalog bookmarks working; the Catalog screen gets a one-time hint after the rename.

---


### 10.5 Fittings and the two windows (as built, 2026-09-06)

The main room is furnished, not sketched: oak parquet in panel blocks, sage walls over a
walnut wainscot with a rail, a skirting and a cornice in the wainscot's own colour. The
labels that used to stand free on the floor (catalog, front desk, intake, to the wings,
passage, to the next wing) are gone - the furniture reads as itself, and the shelf signs
carry the only text in the room.

Two boards hang on the short wall, in the look the old notice board had, each under a
wooden title band: **Hot cache** and **Daily recap**. Clicking one opens it as a window
covering the room canvas exactly, inside the same box, so nothing on the screen moves;
`Esc` or the button in its head brings the room back. The hot cache window renders
`wiki/hot.md`, the recap window is the same feed Home opens on.

The passage in the back wall has a wooden frame (two posts and a lintel) and is the way
on: clicking it shows the next room, wrapping from the last wing back to the main room.
Every wing has the same frame around its own passage.

The two boards sit centred in their half of the short wall, and every desk carries a lamp
that lights up through the night shift.

**A shelf opens its department.** Clicking one used to leave for the Graph screen with a
domain filter applied. It opens a third window instead, over the room, with two views of
the department and nothing else:

- **Graph**: its pages and only the links that run between them, on the shared canvas, with
  a legend by page type. A click on a node opens the page. **The legend is the filter**: a
  click on one type narrows the canvas to those pages and the links that stay inside them,
  and the catalog to the same rows, so the two views never disagree about what is showing.
  Clicking it again, the type chip in the filter bar, or "show all" widens back.
- **Catalog**: the same pages as rows, in the table the Catalog screen renders, minus the
  domain column that would repeat the heading. It carries the **source column**: the
  document each page was written from, opening the stored file for an ingest and the live
  URL for a web source (a web ingest never links its stored HTML, section 12.6). A filter
  bar above it narrows by title, by page type, and to the pages that have a source at all.

While the window is open the control column belongs to the department, not to the room:
the department list on top switches which one the window shows, and under it stand the
department's own figures (pages, stubs, gaps, how many pages came from a document), its
three most recently changed pages, the Fellows whose home domain it is, the runs that last
wrote into it, and the documents it was written from, each opening the file. The wheel and
the arrow keys belong to the window too - the graph zooms and the table scrolls where the
room used to page - and the graph opens fitted every time rather than where the last look
left it.

A page opens as a third level inside the same window: a node on the canvas, a row in
the table, or one of the recently changed pages in the column. It renders the vault's
markdown in place. Escape steps back one level at a time - the page to the view it came
from, the view to the room, the room out of focus mode.

The headline carries the room navigation itself and stays put in focus mode, so the Full
and Focus toggle is reachable while a window is open. The scope sentence and the Catalog
button are gone: the room strip says which room this is, and the Catalog is a tab.

While a window is open the headline belongs to it: the room strip steps aside for the
**department's name in the middle** with its size beside it, and the controls the window
needs move up into that one row - the Graph and Catalog toggle, and the way back (`Back to
the room · Esc`, and while a page is open `Back to the graph · Esc` or `Back to the catalog
· Esc` in front of it). Nothing in the window's own body repeats them.

Deep links: `/library?shelf=<domain>` opens the window, `&pane=catalog` on its second view,
`&page=<vault path>` on a page inside it, and `?board=hot|recap|reading` opens a board.
`?agent=<id>` opens that Fellow's card; like a shelf it needs the column, so it opens in full
even though focus is the resting state. The tab row puts the Library between Research and the
two screens it now contains.

### 10.6 The reading list (as built, 2026-09-06)

A research step reads sources over the web and writes prose about them; nothing of the
document itself reaches the vault, which is why a Fellow's pages show no source in the
catalog. Letting the agent download would step around every check the ingest path makes -
the SSRF guard with its pinned redirects, the size cap, the magic-byte refusal of
executables, the dedupe and the job log - and a research run reads pages written by
strangers, so what it is told to save is not always what the user wants saved. The
`/sources/raw` route hands PDFs to the browser inline, which is the other end of that risk.

So the agent writes the entry and the service does the fetching. The third board on the
wall, **Reading list**, is that page: every research step appends what it read and thought
worth having in the original to `wiki/meta/reading-list.md`, one entry per publication, in
a fixed field shape (`title`, `url`, `ref`, `domain`, `why`, `found`). Append only, no
duplicates, and never the document itself - the prompt says so in those words.

The board reads the page back, matches each url against the job log, and offers the ingest
as one click: `POST /api/v1/reading-list/ingest` takes a url that must already stand in the
list (the route is not an open fetch proxy) and enqueues it as an ordinary web job. From
there it is a normal ingest: checked, deduped, filed under `.raw/<job-id>/`, and from then
on the pages it produced carry it in the catalog's source column. A row shows its state -
queued, ingesting, done with a page count, or a retry after a failure.

A later step could let the shift ingest a capped number of entries by itself (only from an
allow-list of hosts, inside the plan share); even then the service does the downloading,
not the agent.

**What the list holds** (as built, 2026-09-07). It used to hold only what a run had actually
read, written only by a research STEP. Both cut out the entries worth the most:

- **Every writing Fellow run** carries the rule now, not the step alone, so a sweep and an
  expand leave their finds behind too.
- **A publication a run could NOT get belongs on the list**, with `access` (`open`,
  `paywalled`, `unreachable`) and `blocked` (the reason in a few words). Those are exactly the
  ones the user's own access can reach and the agent's cannot.
- **The planner contributes without writing.** Its run is read-only with no web, so it names
  publications under `reading` in its structured answer - the ones the source pages mention
  and the ones an earlier run failed to fetch - and the **service** appends them, as one
  commit behind the shared mutex like the notebook and the recap page. Urls already on the
  page are skipped, and the Fellow's name and the cycle date are filled in by the service.
- **The board hides what it cannot fetch, behind "Show paywalled".** A paywalled row's Ingest
  would fail the same way the run did, so it offers a link instead, with the note to open it
  with your own access and drop the file into the vault. `access` from the Fellow decides;
  without one the host does, and only for hosts that serve full text unconditionally - the
  rest stay `unknown` and keep their Ingest button, because calling a readable paper
  paywalled would hide it.
- Entries carry `by` and `at` instead of one free-text `found` line (the old line is still
  read and split), and the ingest route matches urls the way the list dedupes them, so a
  trailing slash or a tracking parameter is still the same entry.

**Closing the loop** (as built, 2026-09-07). A url is not an identity. The most useful way to
get a paywalled paper is for the user to fetch it and drop the PDF in, and that ingest has no
url the list could ever match - so the entry kept offering "Ingest" for a document already in
the vault, and the Fellow that asked for it never learned it had arrived.

- **Identity is the DOI or the arXiv id**, taken from the entry's `ref` or out of its url. The
  queue's dedupe index (one instance, shared) now reads arXiv ids beside DOIs off the `url`,
  `doi` and `source_url` frontmatter of every source page, and answers `byRef`. An entry is
  matched three ways, in order of certainty: it says `filed` itself, its identifier is on a
  source page, or an ingest ran for its url. The row links that page.
- **The night shift reconciles first.** Entries whose publication has arrived get `filed` and
  `filedAt` written into them - the link the row shows and the record that the Fellow has been
  told, so the note goes out once. The Fellow that asked gets one line in its notebook: the
  title, the page, and its own reason for wanting it.
- **An expand run may write it too.** The reading list joins the Fellow's own pages in an
  expand's page set, next to the notebook and the synthesis pages - IN the set rather than
  exempt from the check, so the append-only rule still holds it. Left out, the first real
  expand run was reverted whole for noting a single publication, which is what every writing
  run is now told to do.
- **The planner sees it as a candidate**, of kind `reading` and above every other weight: the
  question is already written down, the document is here, and reading it beats another search
  round. The proposal it becomes points at the source page.
- **The recap names them once**, so both sides see the same thing: what came in from the
  reading list in this window, with who asked for it.

### 10.7 Working in the room (as built, 2026-09-06)

Focus is the screen's resting state and sits first in the toggle: the room fills the width
and the control column is out of the way. Opening a department brings the column back (it
becomes the department's, section 10.5); closing it returns to the room in focus. The
headline carries the mode toggle, the room strip and, in focus, the spawn button, which
opens the column with the form.

The room strip lost its arrows - the pills are the navigation and the wheel pages through
the rooms - and gained a plus that opens another wing.

A **wing wears its name on a banner** in the green field above the wainscot, and a click on
it renames the wing where it hangs. A floor lamp stands beside it and lights up through the
night shift, like the desk lamps in the main room.

An **empty shelf starts a department**: a click opens the same three steps the System screen
offers, in the room where the shelf stands. The key and its description go into the vault's
domain registry, an optional read-only review run checks the key against the registry and
the pages it would claim, and an optional backfill files the pages that carry no domain into
the new one. The vault's own candidates are offered as one-click fills.

The column's department rows lost their move dropdown and their drag hint: a row is still a
drag handle onto a room, and a plain click jumps to the room that department stands in.

Two drawing rules the room needs to stay readable: a figure sorts in FRONT of the furniture
on its own tile (a Fellow half-hidden behind an armchair loses the subject of the picture),
and its bubble names it in one word - `Ada (planning)`, `Cy (quota)` - because a sentence
hanging in an isometric room covers what is behind it.

A bookcase sorts by its front edge but by the MIDDLE of its width (2026-09-07). Claiming its
full width put it in front of the very figure standing at it, since that figure stands centred
on the case, 1.55 tiles out: a Fellow reading at a shelf was drawn behind the shelf. Nothing
ever stands between a case and the wall, so the narrower claim costs nothing.

**One headline, three zones, one control height** (as built, 2026-09-07). The review that
produced it found the same job done in different places: the room strip stood taller than the
toggles beside it, the spawn button had a shape of its own, the type filter was a floating
legend in the graph and a row on top of the catalog, and two buttons repeated what Escape
does. Now:

- **Left** is the Focus/Full toggle, in every state, at the same size as everything else in
  the row. **Middle** says where you are: the room strip in the room, the board's name or the
  department's name and size in a window, and while a page is read the path, whose department
  is a link back. **Right** is the one thing this state offers: Spawn a Fellow in the room,
  the Graph/Catalog toggle in a department, nothing else.
- **No button repeats a key.** Escape steps back a level as before; the arrow keys switch a
  department's two views, because they are two sides of one thing and reaching for the toggle
  to compare them costs more than the comparison. Arrows inside a text field still move text.
- **The filter band has one place**, directly under the headline, identical in both views, and
  carries the colour the legend used to carry. `Fit` sits after the count, so the count does
  not move when the view does. A board's window keeps no head of its own.
- **The column** puts a rule and real space between wings, names its section "In this
  department" (the department is already named in the headline), drops "Recent work", and
  makes each Fellow a button that opens its card.
- **In the room the column holds two lists**, departments first and Fellows under them. Each
  wing's heading keeps real space above it: the groups sit in their own wrappers, so a
  `:first-child` reset had been flattening the gap in front of every heading but the first. The
  room list is gone - it repeated the strip in the headline - and so is the second spawn
  button, which the headline already carries. **The wing actions moved into the strip**, which
  is where a wing is a thing you can point at: the pills show the wings in their order, so
  dragging one along the strip reorders them, and the pill of the room you are standing in
  offers to delete it while it is an empty wing. Renaming stays on the banner in the wing.
- **The headline carries a `Decisions` count** beside the spawn button: the proposals the
  newest recap is still waiting on, summed over every Fellow in it, quiet at zero and in the
  warning colour above it. A click opens the daily recap board, which is where they are made.
- **A picked filter chip looks picked.** `aria-pressed` was set from the first version but
  nothing was styled off it, so the band gave no sign of which type was filtering.

**Leaving the tab closes the room's windows** (2026-09-07). The screen stays mounted while
another tab shows, because it polls the scene, so a board or a department window left open was
still open on the way back and the Library reopened on whatever stood in front of the room.
Coming back is now always the resting state: main room, focus mode, nothing over it.

**Focus follows the Fellow once per move, not on every render.** The mode exists to show the
room where something happens, but re-applied continuously it also pulled the reader BACK:
walking to the main room while a Fellow stood at a shelf in a wing was undone by the next
render, and the wing held you until the step ended. The screen now remembers the room it last
followed into; while that has not changed, your own navigation stands.

The graph inside a department window fits on every mount, not only when its fit key changes:
positions and the camera are module state shared with the Graph screen, so a canvas mounting
on an already-placed subgraph would otherwise inherit a camera pointing somewhere else. The
fit waits one frame, for the canvas to be measured. The states this covers were walked
through with a browser script (open, catalog and back, switching departments from the
column, reading a page and returning, reopening a department, focus and full).
## 11. Data model (SQLite, operational state only)

- `agents`: id, user_id, name, slug, intent, scope, home_domain, extra_domains (json),
  lens, model, effort, step, quota_runs_per_day, quota_week_pct, autonomy, priority,
  state, sleep_reason, sleep_code (added in A1: `idle`, `quota`, `budget`, `no-candidates`,
  `covered`, `stalled`; the night shift's wake evaluator reads it), notebook_path,
  created_at, updated_at, retired_at.
- `agent_shifts` (added in A1): cycle_date, trigger (`timer`, `manual`), started_at,
  finished_at, summary (json: executed, planned, skipped, cost). One row per cycle date, so
  a restart inside or after the window never runs a second shift the same night; the recap
  reads the summary.
- `agent_proposals`: id, agent_id, created_at, cycle_date, kind, topic, lens, rationale,
  provenance (json), page_set (json), est_cost_usd, est_plan_pct, scope_score, rank,
  status (`proposed`, `approved`, `vetoed`, `executed`, `expired`, `superseded`),
  decided_at, decided_via, user_note, run_id.
- `agent_runs` (existing): add agent_id, proposal_id, model, pages_created (json),
  pages_updated (json), plan_pct_delta (json per window).
- `recaps`: cycle_date, generated_at, path (null on a quiet day), model (json, the rendered
  recap with the code-to-proposal mapping; A2 named it `model` rather than `summary`),
  delivered (json), answered_at.
- `agents.skip_until` (A2): "skip tonight", the cycle date the next shift skips for the
  Fellow. `agent_runs.answer` (A2): the run's result text, capped, for the recap's summary.
- `usage_samples`: id, ts, window, utilization, resets_at, run_id, phase (`before`,
  `after`, `tick`).
- `handoffs`: id, from_agent_id, to_agent_id (nullable = unclaimed), question, source_page,
  domain, reason, created_at, cycle_date, status (`pending`, `proposed`, `unclaimed`,
  `expired`), proposal_id, updated_at (as built in A3).
- `wings`: id, name, position (order in the room sequence), created_at.
- `library_layout`: domain, room (`main` or a wing id), slot (0 to 11 in a wing, 0 to 3 in
  the main room), placed_by (`user` or `auto`), updated_at.
- `value_events`: id, ts, kind (`page_open`, `recap_link`), agent_id, page.
- Settings: the keys of section 8.2 plus `agentsEnabled`.

Losing the database loses the Fellows' operational state, never vault content; notebooks
and recaps survive in the vault and let the user re-create Fellows by hand.

---

## 12. API (draft, all under `/api/v1`, behind the existing auth middleware)

- `GET/POST /agents` (POST carries `runFirstStep`, default true);
  `GET/PATCH/DELETE /agents/:id`; `POST /agents/:id/pause|resume|retire|step`.
- `GET /agents/:id/proposals`; `POST /proposals/:id/decide` with status, note, edits
  (topic text, rank); `POST /proposals/:id/run` executes a pending proposal now, gated.
- `POST /agents/:id/plan` (plan now; 200 with the reason when there was nothing to plan
  from); `GET /agents/shift` (window, cycle, next start, recent shifts) and
  `POST /agents/shift` (run the shift now, ignoring the window). Added in A1 so the user
  and the tests can drive a cycle without waiting for 01:00.
- `GET /recaps` (with the schedule); `GET /recaps/:date`; `POST /recaps/:date/answers`
  (structured answers, or a text in the code grammar `1b`, `veto 1b`, `skip 1`, `pause 1`,
  `resume 1`, `note 1: ...`, `model 1 opus-5`, `step 1 small`, `topic 1a: ...`);
  `POST /recaps/build` (build now, `force` rebuilds). Added in A2.
- `GET /handoffs` (routed and unclaimed); `POST /handoffs/:id/spawn` (spawn a Fellow from
  an unclaimed request, prefilled with intent, domain and provenance; the body may override
  name, model, step, autonomy and `runFirstStep`). The recap answer `spawn u1 <name>` does
  the same. Added in A3.
- `GET /usage/plan` (windows, calibration, shares); `GET /usage/samples`.
- `GET /library/scene` (snapshot: departments, shelves, actors); live updates reuse the
  existing SSE bus (`job`, `log`, `vault`, `stats`) plus a new `agent` event kind.
- `POST /value-events` (the dashboard reports page opens and recap link clicks).
- `GET /usage/plan` (availability and source, the windows and their resets, calibration,
  consumption, the shares in their unit, the gate's answer for a standard step on the
  default model), `GET /usage/samples?limit=` (newest samples). Added in A5.
- `GET/POST /wings`; `PATCH /wings/:id` (rename); `DELETE /wings/:id` (only when empty);
  `POST /library/move` with domain, target room and optional slot (drag and drop lands here);
  `PATCH /wings/order` (reorder).
- Existing endpoints stay: `POST /maintenance/research` gains an optional `agentId`.

---

## 13. Security and safety

- Run profiles are unchanged: `research` for writing steps, `query` for planning and
  recap. The sandbox and the `PreToolUse` hook stay the enforcement points; `permprobe`
  runs after every SDK upgrade.
- **Injection boundary.** Topics and proposals derive only from vault-internal text; the
  planner's output is schema-bound; every proposal carries provenance and is shown to the
  user before it runs (except `auto`, where the drift threshold blocks).
- **Scope anchor** (6.4) against topic drift.
- **Append-only guarantee** for expand runs, validated on the commit and reverted by a
  new commit on violation.
- Fellows never write each other's notebooks; the service owns handoffs.
- Per-run caps: timeout, `maxBudgetUsd`, fetch caps from the profile.
- Credentials and the localhost guard are untouched.
- **Commit hygiene from day one**: no vault entities, topics or handles in commits, PRs
  or docs of this repo (hard rule 7), because the history is merged into a public repo.

---

## 14. Development and test environment

- **Repo.** Private fork of LibrisVault with a `research-agents` branch, rebased on the
  public `main` regularly, everything behind `AGENTS_ENABLED`, merged by PR when ready.
- **Second instance** beside the live service: `PORT=8421`, `XDG_DATA_HOME` pointing to
  its own data directory (the DB path derives from it), `VAULT_ROOT` on a separate vault
  clone (the synthetic demo vault from `scripts/demo-vault.mjs`, about 850 pages, is the
  default), `WATCH_FOLDER` on an empty directory, `TELEGRAM_BOT_TOKEN` empty (Telegram
  allows one poller per token), the shared credential file.
- **Tests.** Planner, scheduler, quota gate, scope scoring, expand validation and recap
  assembly get unit tests with mocked runs, as the pipeline does today. Real runs only
  against the demo vault with `maxBudgetUsd` set. Web: scene adapter and card derive from
  fixtures (`web/src/lib` pure functions, as `activity.ts` and `researchProgress.ts`).
- **Screenshots** from the demo vault only.

---

## 15. Milestones

| # | Milestone | Content | Acceptance |
|---|---|---|---|
| A0 | Foundation | agents table and API, notebook page, `research-step` kind, agent id on runs, spawn with immediate first run, "run next step", card data endpoint | spawn a Fellow, the first run and one manual step show up in notebook and ledger; tests green |
| A1 | Plan and shift | candidates, planning run on the Fellow's model, proposals with smallest fitting kind, veto window, night shift 01:00 to 06:00, runs-per-day quota, USD accounting | proposals appear after the night, the undecided top one runs the next night, the quota stops the second |
| A2 | Recap | recap page, quiet-day one-liner, dashboard inbox and view, Telegram text and coded answers, adjust actions, value events | a morning recap with choices; answering changes the night's plan |
| A3 | Expand and collaboration | `research-expand` with validation and revert, routing, dedupe, unclaimed requests with prefilled spawn | a violating expand run is reverted; a cross-domain question reaches the other Fellow |
| A4 | Library | sprite test and asset decision, Catalog rename, scene adapter for existing runs, then Fellows, card with live run, departments and books, graph domain link, day and night | existing runs animate with zero Fellows; the card opens by click and deep link |
| A5 | Plan-percent quota | usage sampling, calibration, shares and reserves, proposal pricing in points | a step is refused when the share is used up; the recap shows points per run |
| A6 | Merge prep | feature flag review, docs, screenshots, SPEC section 12.10, PR into LibrisVault | LibrisVault unchanged with the flag off; review passed |

A0 to A3 are server-first and usable without the Library screen; A4 can start in
parallel after A0 because it depends only on existing signals.

---

## 16. Cost and capacity reference (measured and estimated, 2026-09-05)

| Item | Value |
|---|---|
| Full research run, Sonnet 5 (6 real runs) | about 6 USD list price, 12 to 13 min, about 16 pages |
| Planning run, Sonnet 5 | about 0.4 USD |
| Small step | about 2 USD (estimate) |
| Max 5x, 5-hour window | about 80 USD equivalent (estimate, range 50 to 135) |
| Max 5x, week, today | about 1000 USD equivalent (estimate, range 700 to 2000); times 0.83 from 2026-09-14 |
| One full run | about 7.5 % of a 5-hour window, about 0.6 % of the week (estimates) |
| Research share 10 % of the week | about 16 full runs or about 50 small steps per week |
| Fellows that fit the default share at one step per day | about two on full runs, four to five with the planner's smallest-fitting-kind rule |
| Model factors against the plan | Opus 5 about 2.5 times Sonnet 5; Fable about 2 times Opus |

All plan-percent numbers are estimates until the usage monitor has measured deltas on the
user's own account.

---

## 17. Decisions from the review round (2026-09-05)

| Id | Question | Decision |
|---|---|---|
| OPEN-1 | Repo relation | private fork of LibrisVault with a `research-agents` branch |
| OPEN-2 | Figure of a manual run | anonymous visiting researcher |
| OPEN-3 | "Articles written" on the card | created and updated pages, two lists |
| OPEN-4 | Card shows the live run | yes, phase bar and log tail |
| OPEN-5 | Recap language | English everywhere |
| OPEN-6 | Read back Obsidian checkbox edits | later; v1 recap page is rendering only |
| OPEN-7 | Telegram answers | coded text replies in v1; inline keyboards later |
| OPEN-8 | Model and effort per kind | the Fellow's model applies to all of its runs, planning included |
| OPEN-8b | Recap model | always the default model (Sonnet 5) |
| OPEN-9 | Naming | Fellows; room is Library; table view becomes Catalog |
| OPEN-10 | Veto window default | until the next night shift |
| OPEN-11 | Night window default | 01:00 to 06:00 local |
| OPEN-12 | Quota defaults | 10 % week, 15 % per 5-hour window, reserves 60/80 |
| OPEN-13 | Recap narrative | deterministic skeleton plus three lines per Fellow on Sonnet 5 |
| OPEN-14 | What is a book | knowledge pages are books, sources thin volumes, meta invisible |
| OPEN-15 | Assets | style A, flat vector figures drawn from the dashboard tokens (decided 2026-09-05 after the sprite test) |
| OPEN-16 | Cross-Fellow notebook writes | never; handoffs are service-side |
| OPEN-17 | Planning model | the Fellow's model, default Sonnet 5 |
| OPEN-18 | Value signal | minimal in v1: recap link clicks and page opens, local only |
| OPEN-19 | Spawn from unclaimed request | prefilled spawn dialog |
| OPEN-20 | Day and night in the scene | real clock |
| OPEN-21 | Home of Fellow management | Library control column plus the card |
| OPEN-22 | Stop thresholds | two consecutive no-changes runs |
| NEW-1 | Behaviour right after spawn | first full run on the intent immediately, deselectable |
| NEW-2 | Quiet day | one-liner to dashboard and Telegram, no vault page |
| NEW-3 | Manual runs and the research share | manual runs are not limited by share or reserves |
| NEW-4 | Default step and kind choice | `standard` as maximum; the planner picks the smallest fitting kind |
| OPEN-23 | Textures for floor, walls, shelves | Archive preset: stone floor, panelled walls, walnut shelves (decided 2026-09-06) |
| NEW-5 | Shelf signs | one text size per view, never per shelf; a name that does not fit breaks into two lines at its hyphen (decided 2026-09-06) |
| NEW-6 | Faces | figures have no faces; hair stays as the silhouette cue (decided 2026-09-06) |
| NEW-7 | Growth model | bays, first-fit in birth order, two spare cases, wings; see 10.8 (decided 2026-09-06) |
| NEW-8 | Library topology | a central main room (fireplace, desks with computers, four favorite slots, notice board, front desk, catalog) with four doors; wings hang off the doors and chain onward; the user creates, renames and fills wings by drag and drop; start = main room plus Wing A (decided 2026-09-06) |
| NEW-9 | One room per view | shared 27 by 11 grid, shelves 3 tiles wide, one door per room at the right end of the long wall; a wing holds 7 shelves on the wall and 3 + passage + 3 in the middle; rooms page by wheel, keys, strip and list; intake cart instead of an unfiled shelf; free slots as silhouettes (decided 2026-09-06) |
| NEW-10 | Door position | the door takes the middle of the seven wall slots, in line with the middle row's passage; six wall shelves plus six middle shelves per wing, room 23 by 11 (decided 2026-09-06) |
