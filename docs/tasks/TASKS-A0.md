# TASKS-A0 - Fellows foundation (2026-09-06)

Goal: a Fellow exists as a persistent record with a notebook page in the vault, runs as an
ordinary sandboxed research run pinned to its model, and every run is attributed to it.
**Acceptance (docs/agents/SPEC.md section 15): spawn a Fellow, the first run and one manual
step show up in the notebook and in the run ledger; `npm test` green on both sides.**
**Status 2026-09-06: done.** 758 server and 280 web tests green, two real steps in the dev
instance (section 5).

Extension milestone in the Curious fork (branch `research-agents`). LibrisVault's working
agreement applies: top to bottom, findings recorded here, spec first when the code disagrees.
Everything is behind `AGENTS_ENABLED=1` (docs/agents/SPEC.md section 4.1), so LibrisVault with
the flag off behaves exactly as before.

## 0. Findings while wiring A0

- **F1 - the runner had no per-run model.** `RunAgentOptions` carried profile, timeout and
  session, never a model; every run used the CLI default (Sonnet 5 on this account). The SDK
  takes `model`, `effort` and `maxBudgetUsd` per query, so the Fellow's model and the per-run
  budget cap are one option each.
- **F2 - the run log could not say whose run it was.** `agent_runs` had no agent column; the
  quota gate ("runs today for this Fellow") and the card ("articles written") need one.
  Schema v15 adds `agent_id` and `model`, nullable, so every existing row keeps working.
- **F3 - the notebook needs a service-side write path.** Hard rule 1 knows agent runs and
  user page edits as vault writers. The notebook is rendered by the service (Plan, Log) and
  written like a user edit: one file, one commit, behind the shared commit mutex. The
  extension spec sanctions it (section 5.4); this task file records it.
- **F5 - one pre-existing timing flake.** With the whole server suite in parallel,
  `queue-integration.test.ts` ("all reach done, every page is committed") failed once on
  "expected [] to have a length of 1"; alone it passes every time, and the full suite passed
  on the next run (758 of 758). Not touched by A0; noted so a later red run is read right.
- **F6 - the vault commits on its own unless told not to.** The plugin's PostToolUse hook
  (`hooks/hooks.json`) commits `wiki/` after every write unless `.vault-meta/auto-commit.disabled`
  exists (LibrisVault found this in M0 and the live vault carries the flag). The dev vault did
  not: the first real step filed four pages and extended five, all committed as
  "wiki: auto-commit" while the run was still going, so the service's own commit found
  "nothing to commit", the run row showed no pages and no hash, and the synthesis check
  warned although the synthesis page existed. Fix: the flag in the dev vault, and
  `scripts/dev-instance.sh` creates it when missing. The service side is unchanged: it owns
  the commit only when the vault lets it.
- **F4 - a "step" has no topic before A1.** The planner (A1) proposes topics. In A0 a step
  takes the topic from the request and defaults to the Fellow's intent; the spawn's first
  run is always the intent as a full `research` run.

## 1. Flag, schema, run log

- [x] `AGENTS_ENABLED` in config (`agentsEnabled`, optional, off by default), shown in
      `describeConfig` as `fellows: on|off`.
- [x] Migration v15: `agents` table; `agent_runs.agent_id`, `agent_runs.model`; index.
- [x] `AgentRunRecord` carries `agentId` and `model`; `list()` filters by `agentId` and `since`.
- [x] `db/agents.ts`: `AgentRecord`, `SqliteAgentStore`, `MemoryAgentStore`, `slugify`,
      the closed model set with SDK ids and plan factors.

## 2. Runner and run kinds

- [x] `RunAgentOptions.model`, `.effort`, `.maxBudgetUsd` passed to the SDK query.
- [x] `MaintenanceKind` gains `research-step`; `RunOptions` gain agent id, model, effort,
      budget and timeout; the run record and the run log carry agent id and model.
- [x] `startResearch(topic, lens, fellow?)` and `startResearchStep(topic, lens, fellow)`:
      the Fellow block (who, intent, notebook, recent log, append open questions) and the
      step caps block (1 round, 5 sources, 5 pages) as prompt blocks (`fellow-prompts.ts`).
- [x] The synthesis check applies to both research kinds.

## 3. Notebook

- [x] `pipeline/notebook.ts`: render with frontmatter (`type: meta`), sections Intent,
      Scope, Plan, Log, Open Questions, Notes; merge keeps Intent, Scope, Open Questions
      and Notes from the page; `readBackNotebook` returns user-edited intent and scope.
- [x] `NotebookWriter`: write plus one commit behind the commit mutex, honouring
      `gitAutoCommit`.

## 4. Fellow service and API

- [x] `pipeline/fellows.ts`: spawn (record, notebook, optional first run), step (quota gate:
      state, one run in flight per Fellow, runs per day; budget cap per kind scaled by the
      model factor), pause, resume, retire, card data; on settle: notebook rewrite, state
      and read-back of intent and scope.
- [x] `api/routes/agents.ts`: `GET/POST /agents`, `GET/PATCH/DELETE /agents/:id`,
      `POST /agents/:id/step|pause|resume|retire`, `GET /agents/:id/card`; validated
      bodies; 503 without a credential; registered only with the flag.
- [x] `main.ts` wiring behind the flag; `AppContext.fellows`.

## 5. Ledger and tests

- [x] Web: `research-step` counts as research in the activity stream and the research
      ledger (`activity.ts`, `researchRuns.ts`).
- [x] `server/test/fellows.test.ts`: store, notebook render and merge, service against a
      git vault with a fake agent, routes; `npm test` and `npm run typecheck` green.
- [x] One real `research-step` against the demo vault in the dev instance with the budget
      cap, result recorded here.
      - Run 1 (2026-09-06, before F6 was fixed): `research-step` on the intent, Sonnet 5,
        cap 4 USD, 6.1 min, 2.59 USD, 1 WebSearch, 5 WebFetch, 5 Write, 18 Edit. The agent
        filed a synthesis page, three source pages and extended five concept pages, and
        appended three open questions to the notebook. Attribution, model pin, budget cap,
        quota gate, notebook rewrite and the state machine all worked; the run row carried
        no pages because of F6.
      - Run 2 (after the flag): `research-step` on one of Ada's own open questions, Sonnet 5,
        cap 4 USD, 5.4 min, 1.68 USD, 3 WebSearch, 1 WebFetch, 3 Write, 16 Edit. One service
        commit (`ca179da5`, 11 pages: a new synthesis page, two source pages, three extended
        concept pages, hot, log, index, the notebook append), no warning, attributed to the
        Fellow with the model pinned. The notebook Log lists both runs; the card shows
        `2 of 2` for the day. Acceptance met.
