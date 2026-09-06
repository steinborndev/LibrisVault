# TASKS-A1 - Plan and shift (2026-09-06)

Goal: a Fellow plans its own next steps from vault-internal candidates, the user sees the
proposals before they run, and a night shift executes the plan under the runs-per-day quota
with USD accounting. **Acceptance (docs/agents/SPEC.md section 15): proposals appear after
the night, the undecided top one runs the next night, the quota stops the second; `npm test`
green on both sides.**
**Status 2026-09-06: done.** 787 server and 280 web tests green; one real planning run and
one real manual shift in the dev instance (section 5).

Extension milestone in the Curious fork (branch `research-agents`), everything behind
`AGENTS_ENABLED=1`. LibrisVault's working agreement applies: findings recorded here, spec first
when the code disagrees.

## 0. Decisions and findings while wiring A1

- **D1 - planner kinds in A1.** The planner may propose `research-step` and `research`;
  `research-expand` arrives with A3 (append-only rules and revert). The output schema's kind
  enum is built from the allowed list, so A3 only widens it. A proposed kind above the
  Fellow's `step` is clamped down by the service, never rejected.
- **D2 - a planning run is a `query`-profile run through the maintenance runner.** Tracked
  like every run (channel, live log, run log row with cost, attributed to the Fellow, model
  pinned), serialized on the run mutex, and with NO commit, sweep or validation: the profile
  cannot write, so there is nothing to commit. `MaintenanceRunner.start()` learns the
  `query` profile for this one kind.
- **D3 - structured output.** The SDK's `outputFormat: { type: 'json_schema' }` binds the
  model; the service validates `structured_output` again with zod, rejects proposals without
  a candidate id (spec 6.4: no provenance, no proposal) and truncates to three. A planning
  run whose output does not parse settles as a failed run with the reason.
- **D4 - the shift persists one row per cycle date** (`agent_shifts`), so a restart inside or
  after the window never runs a second shift the same night, and the recap (A2) can read
  what the night did. Spec section 11 did not list it; recorded here and in the spec.
- **D5 - cycle date.** The local calendar date of the window's END (the morning): the night
  01:00 to 06:00 on 2026-09-07 is cycle 2026-09-07. Proposals written that night carry it;
  a proposal made by a daytime "plan now" carries that day. A pending proposal expires three
  cycle dates after its own (it had the next two nights to run, spec 6.5).
- **D6 - sleep codes and lazy wake-ups.** `agents.sleep_code` (v16) says WHY a Fellow sleeps:
  `idle` (nothing planned, the planner runs tonight), `quota`, `budget`, `no-candidates`,
  `covered` (the planner found nothing worth a run or reports the intent as covered),
  `stalled` (two consecutive runs changed no knowledge page). The night shift is the wake
  evaluator: idle, quota, budget and no-candidates Fellows are planned every night (the
  cheap candidate check runs first; no candidates, no planner cost); covered and stalled
  Fellows are planned again only when a wake trigger exists, in A1 an ingest into their
  domains newer than the sleep. A manual step and an intent edit clear the sleep at once.
  No event-driven wake-up yet (spec 5.3 names the triggers; the recap answer is A2).
- **D7 - gate additions.** Besides runs-per-day (A0) a step now also refuses when the daily
  budget is reached or the ingest queue is paused on a rate limit (spec 8.4). The research
  shares and reserves need the usage monitor and stay in A5.
- **D8 - state after a settle.** Failed run: `blocked`. Successful run: `stalled` sleep when
  this and the previous research run committed no knowledge page (bookkeeping, `wiki/meta/`
  and the synthesis page under `wiki/questions/` do not count, because a "nothing new" step
  still rewrites those); otherwise `waiting` when pending proposals exist, else `idle` sleep.
- **D9 - drift.** Scope score = overlap coefficient of the overlap tokenizer's token sets
  (topic plus rationale against intent plus scope); below 0.2 a proposal is flagged as drift:
  it never runs undecided and is dropped in `auto` mode. Explicit approval overrides.
- **D10 - two endpoints beyond the spec's list.** `POST /agents/:id/plan` (plan now) and
  `GET/POST /agents/shift` (status, run the shift now) exist so the user and the tests can
  drive a cycle without waiting for 01:00. A manual shift ignores the window bounds.
- **D11 - `deep` step.** A `research` proposal of a Fellow with `step: deep` runs with the
  effort raised one level and a 45-minute timeout (spec section 7).
- **D12 - settings.** `nightWindowStart`, `nightWindowEnd` (HH:MM local, defaults 01:00 and
  06:00) and `researchModelDefault` join the settings table; `recapTime` is A2, the shares
  are A5.
- **D13 - the shift's order.** Executions first (round-robin by priority, one step per
  Fellow per round, more rounds while quota and window remain), then one planning run per
  eligible Fellow against the fresh vault, then the executions of `auto` Fellows from their
  new plans. A timer shift starts a run only while the window still has room for the kind's
  timeout; runs are awaited one after another (the runner's mutex would serialize them anyway).

Findings from the real runs (section 5):

- **F1 - the journal handed the Fellow every gap in the vault.** Gap attribution counted a
  gap as the Fellow's when one of "its pages" referred to it, and "its pages" were every
  path its runs committed, `wiki/log.md` and `wiki/index.md` included. The journal names
  every page that ever existed, so the first real planning run saw the vault's whole gap
  list as candidates C11 to C20 and spent tokens dismissing them. Fix: only knowledge
  pages count for attribution (bookkeeping, `wiki/meta/` and the synthesis page stay out).
- **F2 - question words pulled an on-topic proposal under the drift threshold.** The
  intent "How well can ... where do the systematics come from?" contributed "how", "well",
  "where" and "come" as tokens; a proposal about CMI precision on faint hosts shared
  "ground" and "transit" with it and scored 0.18, flagged as drift. The scorer now drops
  question and function words on both sides; the same proposal scores 0.29 and the second
  real plan's three proposals scored 0.29, 0.43 and 0.43.
- **F3 - runs close questions in two ways.** Besides "(answered ...)" a run struck a
  question through (`~~...~~`); the candidate parser skips both.
- **F4 - the demo vault's cross-links are random**, so a real-looking astronomy page wants
  "Aerosol Indirect Effect". The attribution is right, the vault is synthetic; the planner
  read the pages and discarded them (its reason said so). Noted in the idea ledger.

## 1. Schema and stores

- [x] Migration v16: `agent_proposals`, `agent_shifts`, `agents.sleep_code`,
      `agent_runs.proposal_id`.
- [x] `db/proposals.ts`: `ProposalRecord`, `SqliteProposalStore`, `MemoryProposalStore`
      (create, get, list by Fellow and status, update, supersede, expire).
- [x] `db/shifts.ts`: one row per cycle date with the summary.
- [x] `db/settings.ts`: night window and default model keys.

## 2. Runner

- [x] `RunAgentOptions.outputFormat` and `AgentRunResult.structuredOutput`.
- [x] `MaintenanceKind` gains `plan`; `start()` accepts the `query` profile; `startPlan()`
      with the 5-minute timeout, budget cap 1 USD times the model factor, no commit.
- [x] `proposalId` on run options, the tracked run and the run log row.

## 3. Candidates and planner

- [x] `pipeline/candidates.ts`: open questions (own synthesis pages and notebook), graph
      gaps referred to by the Fellow's pages or its domains, stubs in its domains, ingests
      into its domains since the last run; capped and ordered.
- [x] `pipeline/planner.ts`: the planning prompt, the output schema, output validation,
      scope scoring, cost estimates, the notebook Plan section.

## 4. Fellow service, shift, API

- [x] `pipeline/fellows.ts`: proposals, `plan()`, `decide()`, the runnable proposal per
      autonomy mode, execution of a proposal, the extended gate, the settle state machine of
      D8, USD totals on the card, intent edits wake.
- [x] `pipeline/shift.ts`: the night shift (window, cycle date, one row per cycle, D13).
- [x] Routes: proposals list, decide, plan now, shift status and run; `GET /agents` carries
      the shift status.
- [x] `main.ts`: wiring behind the flag; the shift starts with the service and stops with it.

## 5. Tests and validation

- [x] Unit tests: candidates from a fixture vault, scope score and drift, planner output
      validation, proposal store transitions, the shift with a fake runner and clock (veto
      Fellow: top proposal runs, quota stops the second round; manual: nothing without
      approval; auto: plan then run; window and cycle guards), routes.
- [x] Real validation in the dev instance against the demo vault: a planning run for the
      existing Fellow (Sonnet 5), then a manual shift, results recorded here.
      - Planning run (2026-09-06 07:34 UTC, `POST /agents/:id/plan`): Sonnet 5, cap 1 USD,
        20 candidates (10 open questions from the notebook and two synthesis pages, 8 gaps,
        2 stubs), 76 s, 0.46 USD, 108k tokens in. Three `research-step` proposals, each
        naming an open question of the notebook, with a paragraph of rationale against the
        intent; the answer's reason dismissed the gap and stub candidates as unrelated. The
        notebook's Plan section listed them; the Fellow went to `waiting`.
      - Manual shift (07:37 to 07:45 UTC, `POST /agents/shift`, quota raised to 3 with two
        steps already used today): phase 1 executed the rank-1 proposal as a `research-step`
        (7.3 min, 2.46 USD, 6 pages in one service commit, a new synthesis page, no
        warning; the proposal row is `executed` with the run id); the second round was
        refused with "used today's quota (3 of 3 runs)" (recorded under skipped); phase 2
        ran the planner again (0.21 USD): the two undecided proposals became `superseded`,
        three new ones arrived, the Fellow is `waiting`. Shift row: 2.67 USD. Acceptance
        met: proposals after the plan, the undecided top one ran in the shift, the quota
        stopped the second.
- [x] Web: `plan` in the run titles; a plan run counts as maintenance in the activity stream.
