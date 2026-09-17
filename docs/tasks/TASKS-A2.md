# TASKS-A2 - Recap (2026-09-06)

Goal: every morning the user gets one recap of what the Fellows did at night and what they
propose for the next night, as a vault page, in the dashboard and on Telegram, with the
proposals as choices; answering changes the night's plan. **Acceptance (docs/agents/SPEC.md
section 15): a morning recap with choices; answering changes the night's plan; `npm test`
green on both sides.**
**Status 2026-09-06: done.** 802 server and 283 web tests green; the scheduler built the
first real recap, an answer through the API changed the plan and ran, the rebuilt recap
carries Sonnet 5 summary lines (section 6).

Extension milestone in the Curious fork (branch `research-agents`), everything behind
`AGENTS_ENABLED=1`. Findings recorded here, spec first when the code disagrees.

## 0. Decisions while wiring A2

- **D1 - what a recap covers.** The recap for cycle date D (the morning) covers the Fellow
  runs started after the previous recap was generated (24 hours back when there is none),
  the shift row of D if the night ran, and the pending proposals as they stand when the
  recap is built. A manual step during the day therefore appears in the next morning's
  recap, like the spec's "the night's runs".
- **D2 - quiet day** (NEW-2): no Fellow run since the last recap and no proposal created
  since then: one line to dashboard and Telegram ("nothing ran; N Fellows sleeping, reasons"),
  no vault page, a recap row with `path` null so the day still exists in the list.
- **D3 - "what it found".** One `recap` run per recap on the default model (Sonnet 5),
  read-only `query` profile, 3 minutes, 1 USD cap, schema-bound: three lines per Fellow
  from the label and the result text of its successful runs. The result text is now kept on
  the run row (`agent_runs.answer`, v17, capped at 6000 characters), because the in-memory
  registry evicts runs and a restart loses them. A failed recap run does not stop the recap:
  the page says the summary is unavailable and everything deterministic still ships.
- **D4 - codes.** Fellows are numbered in the recap's order (the shift's order: priority,
  then age; retired Fellows are left out), proposals lettered `a`, `b`, `c` by rank among
  the pending ones. The recap stores the mapping code to proposal id, so an answer resolves
  against what the user read, not against a plan that may have changed since. Answers:
  `1b` (run it), `veto 1b`, `veto 1` (every pending one), `skip 1` (tonight), `pause 1`,
  `resume 1`, `note 1: text`, `model 1 opus-5`, `step 1 small`, `topic 1b: new text`.
  Several answers may share one message, separated by whitespace or commas; `note` and
  `topic` take the rest of their line. Reordering rides on approval: an approved proposal
  runs before any undecided one (section 6.5), and the dashboard's decide endpoint keeps
  `rank` for the explicit case.
- **D5 - "skip tonight"** is a Fellow field, `agents.skip_until` (the cycle date of the
  next shift, v17). The shift skips that Fellow's executions that night and still plans for
  it; approved proposals survive to the night after. A veto would have told the planner
  never to propose the topic again, which is not what "not tonight" means.
- **D6 - free text** becomes a bullet under the notebook's Notes section ("Recap note
  <date>: ...") through the notebook writer, and the candidate computation reads such
  bullets as candidates of kind `note` (weight 3) for the next planning run.
- **D7 - timing.** `recapTime` joins the settings (local `HH:MM`, default 07:00). The recap
  scheduler ticks once a minute and builds when the time has passed and no recap exists for
  today's cycle date; a service started later in the day builds its recap on the first tick.
  `POST /recaps/build` builds now (`force` rebuilds an existing day).
- **D8 - channels.** Dashboard: the recaps list and the Recap view (`/recap`,
  `/recap/<date>`) with the proposals as buttons, plus an inbox entry on Home while the
  latest recap has undecided proposals. Vault: `wiki/meta/recaps/Recap <date>.md`, `type: meta`,
  written through the service page write path in one commit, rendering only (OPEN-6).
  Telegram: plain text (no MarkdownV2, the topics are free text), one message for the
  header and one per Fellow, to every allowlisted user (a private chat id equals the user
  id); the bot parses answers before the note-ingest path, only while a recap exists and
  the text matches the grammar, and replies with what each answer did.
- **D9 - value events** (OPEN-18): `POST /value-events` with kind `page_open` or
  `recap_link` and the page; the server attributes the page to the Fellow whose run
  committed it. The card shows opens this month; the recap header shows the month's totals.
  The dashboard posts `page_open` when a wiki page opens (only while Fellows are on) and
  `recap_link` when a link on the Recap view is followed. Local only, nothing leaves.
- **D10 - deferred to A3:** unclaimed requests and the prefilled spawn (they need handoffs);
  dedupe notes in the header.
- **D11 - `GET /health` says whether Fellows are on** (`fellows`), so the dashboard shows the
  recap surfaces only on an instance that has them.

Findings from the real runs (section 6):

- **F1 - the vault ignores bare date file names.** The first real recap was written to
  `wiki/meta/recaps/2026-09-06.md` and `git add` refused it: the vault's own `.gitignore`
  carries `????-??-??.md` (its daily-note rule). Hard rule 5 leaves that file alone, so the
  page is `Recap <date>.md` now; the spec's path is amended.
- **F2 - runs before v17 carry no result text.** The recap built over today's earlier runs
  had no "found" lines and skipped the summary run (nothing to summarise, no cost); the
  run started after the migration stored its text and the rebuilt recap summarised it. As
  designed (D3), noted so an empty Found section on the first morning is read right.
- **F3 - a forced rebuild replaces the row**, `answeredAt` included; the decisions it
  recorded stay applied in the proposals. Fine for a manual rebuild, noted for the recap
  history a later milestone may want.

## 1. Schema, stores, settings

- [x] Migration v17: `recaps`, `value_events`, `agent_runs.answer`, `agents.skip_until`.
- [x] `db/recaps.ts`, `db/value-events.ts`; `skipUntil` on the agent record; `answer` on
      the run record (persisted from the settle, capped); `recapTime` setting.

## 2. Runner, git, candidates, notebook

- [x] `MaintenanceKind` gains `recap`; `startRecap(prompt, schema)` on the default model.
- [x] `git.ts`: file status of one commit (created versus updated pages for the recap).
- [x] `candidates.ts`: recap notes from the notebook's Notes section as `note` candidates.
- [x] `notebook.ts`: append a note to Notes on write.
- [x] `clock.ts`: local date, day arithmetic and the night window shared by shift and recap.

## 3. Recap service

- [x] `pipeline/recap.ts`: the model (header, per Fellow: runs with created and updated
      pages, found lines, open questions, coded proposals, sleeping Fellows, value totals),
      the page markdown, the Telegram text, the answer grammar, applying answers through the
      Fellow service, the scheduler, delivery to Telegram through a late-bound sink.
- [x] `fellows.ts`: skip tonight, notes, value counts on the card; `shift.ts` honours
      `skip_until`.

## 4. API, Telegram, wiring

- [x] Routes: `GET /recaps`, `GET /recaps/:date`, `POST /recaps/build`,
      `POST /recaps/:date/answers` (structured answers or a text), `POST /value-events`;
      `fellows` on `/health`.
- [x] Telegram: `broadcast` on the bot; the answer hook ahead of the note-ingest path.
- [x] `main.ts`: recap service and scheduler behind the flag; the scheduler starts with the
      shift and stops with it.

## 5. Dashboard

- [x] API client and types for recaps, answers, value events and Fellows.
- [x] Recap screen (`/recap`, `/recap/<date>`): dates in the control column, the recap with
      approve, veto, skip, pause and note per Fellow, links to pages and notebooks.
- [x] Home: inbox entry for the latest recap while it has undecided proposals.
- [x] `page_open` value events when a wiki page opens.

## 6. Tests and validation

- [x] Unit tests: model from fixtures (a night with runs, a quiet day), markdown and Telegram
      rendering, the grammar, applying every answer kind against the Fellow service, the
      scheduler's tick, the routes, the bot's answer path, value attribution; web: the recap
      helpers.
- [x] Real validation in the dev instance: a recap built over today's runs (Sonnet 5), the
      page in the vault, the dashboard view, one answer through the API that changes the
      plan (an approved proposal becomes the night's pick); results recorded here.
      - Scheduler path (2026-09-06 10:53 UTC): the service started after the recap time and
        the first one-minute tick built the recap for 2026-09-06 over the last 24 hours:
        3 Fellow runs, 10 pages, 6.73 USD; the shift row, the skipped line ("used today's
        quota"), 5 open questions, 3 coded proposals `1a` to `1c`. No summary run (F2), no
        Telegram (no bot on the dev instance), page written but not committed (F1).
      - Answer through the API: `POST /recaps/2026-09-06/answers` with text `1b` approved
        the rank-2 proposal; `next` on the Fellow moved to it (approved beats rank), and
        `POST /proposals/:id/run` executed it: research-step, 5.6 min, 2.20 USD, 7 pages in
        commit c8691c22, the proposal row `executed` with the run id, the result text on
        the run row.
      - Forced rebuild on the fixed build (11:01 UTC): page `wiki/meta/recaps/Recap
        2026-09-06.md`, committed as `recap: 2026-09-06` (2c07297), 4 runs, 14 pages,
        8.93 USD in the totals; the summary run on Sonnet 5 took 0.30 USD and wrote three
        lines for Ada that read as a faithful digest of the last run (scaling of homogeneous
        pooling with N, what it means for the intent, what stays open). Acceptance met.
