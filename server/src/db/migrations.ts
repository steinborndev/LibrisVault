/**
 * Schema migrations for the operational database (SPEC.md §8).
 *
 * SQLite holds ONLY operational state. The vault is the single source of truth for
 * knowledge; losing this DB must never damage the vault, and the statistics it holds
 * are rebuildable from the filesystem + git (SPEC.md §8, hard rule 1). That is why
 * nothing here mirrors vault content — only jobs, logs, chat sessions and settings.
 *
 * Migrations are applied in order and gated by `PRAGMA user_version`, so re-opening an
 * existing DB is a no-op. Never edit a shipped migration's SQL — add a new one. The
 * only exception is pre-release (version 1 has not been deployed anywhere yet).
 */

export interface Migration {
  readonly version: number
  readonly up: string
}

/**
 * v1 — the full M1 schema. CHECK constraints encode the closed vocabularies from
 * SPEC.md §8 (job states, source/type enums) so a bad transition fails at the DB
 * boundary rather than silently persisting. Every table that the multi-user work
 * (SPEC.md §12.1) will scope carries `user_id` now, defaulting to the seeded 'local'.
 */
const V1 = `
CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  token_hash TEXT,
  role       TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL
);

-- The v1 single-user seed. All operational rows reference this until multi-user lands.
INSERT INTO users (id, name, role, created_at)
VALUES ('local', 'local', 'owner', '1970-01-01T00:00:00.000Z');

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,                 -- ulid
  user_id       TEXT NOT NULL DEFAULT 'local' REFERENCES users(id),
  batch_id      TEXT,                             -- shared batches (SPEC.md §4.1)
  source        TEXT NOT NULL CHECK (source IN ('drop','watch','url')),
  type          TEXT NOT NULL CHECK (type IN ('pdf','office','web','image','text','av','other')),
  original_name TEXT,
  url           TEXT,
  sha256        TEXT UNIQUE,                      -- dedupe (SPEC.md §3.2)
  status        TEXT NOT NULL CHECK (status IN (
                  'queued','preprocessing','ingesting','done',
                  'failed','deferred','duplicate','cancelled')),
  raw_path      TEXT,                             -- .raw/<job-id>/
  created_pages TEXT,                             -- JSON array of wiki pages created/updated
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);

CREATE INDEX idx_jobs_status   ON jobs(status);
CREATE INDEX idx_jobs_batch    ON jobs(batch_id);
CREATE INDEX idx_jobs_created  ON jobs(created_at);

CREATE TABLE job_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts      TEXT NOT NULL,
  level   TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message TEXT NOT NULL
);

CREATE INDEX idx_job_logs_job ON job_logs(job_id, id);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT 'local' REFERENCES users(id),
  title      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content    TEXT NOT NULL,
  citations  TEXT,                                -- JSON array of vault-page citations
  ts         TEXT NOT NULL
);

CREATE INDEX idx_messages_session ON messages(session_id, id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

/**
 * v2 — chat (M4). The `sessions`/`messages` tables from v1 are the store; a chat session
 * additionally remembers the SDK session id of its last query run so a follow-up can
 * `resume` it and keep context (SPEC.md §5). `updated_at` gives the session list a sort key
 * that moves when a new message lands. Both columns are nullable/defaulted, so v1 rows and
 * the seeded data migrate without backfill.
 */
const V2 = `
ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT;
ALTER TABLE sessions ADD COLUMN updated_at TEXT;
`

/**
 * v3 — backfill `finished_at` for jobs that stopped running but never got one (finding F2 in
 * TASKS-M5). `failed`/`deferred` were excluded from the finished-stamping set, so every
 * `finished_at`-filtered query skipped them and the Overview's 7-day "Fehler"/"deferred" KPIs
 * read 0 even with failures present. The code fix is FINISHED_STATES in db/jobs.ts; this
 * repairs the rows already written under the old behaviour so historical KPIs are correct too.
 *
 * `started_at` is the honest stamp (when the run began) and always exists for a job that
 * reached these states; `created_at` is a last-resort fallback so the column is never left null.
 */
const V3 = `
UPDATE jobs
   SET finished_at = COALESCE(started_at, created_at)
 WHERE status IN ('failed', 'deferred')
   AND finished_at IS NULL;
`

/**
 * v4 — index for the `finished_at`-filtered aggregates (`usageSince`, `countsSince`). The
 * budget check runs `usageSince` on every queue pump, so this is a hot path; without an index
 * `countsSince` scans the table.
 */
const V4 = `
CREATE INDEX idx_jobs_finished ON jobs(finished_at);
`

/**
 * v5 — dismissed domain candidates (SPEC.md §12.4 Stufe 3). The governance loop re-derives its
 * candidates from the vault on every request, so without remembering rejections it would
 * propose the same theme forever and become noise. Keyed by the candidate key (the dominant
 * tag), which the finder keeps stable across rebuilds precisely so this table stays valid.
 *
 * Operational state only: losing it costs nothing but a re-proposal (hard rule 1, SPEC.md §8).
 */
const V5 = `
CREATE TABLE domain_dismissals (
  user_id      TEXT NOT NULL DEFAULT 'local',
  key          TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`

/**
 * v6 — per-message usage (tokens/cost) on assistant messages. The chat UI shows what each
 * answer cost; before this only the LAST answer's usage was visible (returned transiently on
 * the POST /query response) and vanished on session switch/reload. Nullable — user/system
 * rows and pre-v6 history simply carry no usage.
 */
const V6 = `
ALTER TABLE messages ADD COLUMN tokens_in INTEGER;
ALTER TABLE messages ADD COLUMN tokens_out INTEGER;
ALTER TABLE messages ADD COLUMN cost_usd REAL;
`

/**
 * v7 — Telegram channel (SPEC.md §4.3): `source` gains 'telegram', and `notify_channel`
 * ('telegram:<chat_id>') records where to send the completion message, restart-safe.
 *
 * A full table rebuild, not ALTER ADD COLUMN: `source`'s CHECK constraint lists the
 * allowed values and SQLite cannot modify a CHECK in place. The rebuild follows the
 * documented procedure (create new, copy, drop old, rename) and RELIES on foreign keys
 * being OFF while migrations run (see openDb): with FK enforcement on, DROP TABLE jobs
 * would cascade-delete every job_logs row, and the RENAME would rewrite job_logs' FK to
 * point at the doomed old table. The indexes die with the old table — recreate all four.
 */
const V7 = `
CREATE TABLE jobs_v7 (
  id            TEXT PRIMARY KEY,                 -- ulid
  user_id       TEXT NOT NULL DEFAULT 'local' REFERENCES users(id),
  batch_id      TEXT,                             -- shared batches (SPEC.md §4.1)
  source        TEXT NOT NULL CHECK (source IN ('drop','watch','url','telegram')),
  type          TEXT NOT NULL CHECK (type IN ('pdf','office','web','image','text','av','other')),
  original_name TEXT,
  url           TEXT,
  sha256        TEXT UNIQUE,                      -- dedupe (SPEC.md §3.2)
  status        TEXT NOT NULL CHECK (status IN (
                  'queued','preprocessing','ingesting','done',
                  'failed','deferred','duplicate','cancelled')),
  raw_path      TEXT,                             -- .raw/<job-id>/
  created_pages TEXT,                             -- JSON array of wiki pages created/updated
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  notify_channel TEXT                             -- e.g. 'telegram:<chat_id>' (SPEC.md §4.3)
);

INSERT INTO jobs_v7
  (id, user_id, batch_id, source, type, original_name, url, sha256, status,
   raw_path, created_pages, error, attempts, tokens_in, tokens_out, cost_usd,
   created_at, started_at, finished_at)
SELECT
   id, user_id, batch_id, source, type, original_name, url, sha256, status,
   raw_path, created_pages, error, attempts, tokens_in, tokens_out, cost_usd,
   created_at, started_at, finished_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v7 RENAME TO jobs;

CREATE INDEX idx_jobs_status   ON jobs(status);
CREATE INDEX idx_jobs_batch    ON jobs(batch_id);
CREATE INDEX idx_jobs_created  ON jobs(created_at);
CREATE INDEX idx_jobs_finished ON jobs(finished_at);
`

/**
 * v8 — non-allowlisted Telegram senders, aggregated per sender id (SPEC.md §4.3/§9). The
 * journal logs only the FIRST attempt per sender (flood guard); this table keeps the live
 * count so the dashboard can show the full picture, surviving the restarts that a settings
 * change routinely triggers. Operational state only (hard rule 1) — losing it costs nothing
 * but the counters.
 */
const V8 = `
CREATE TABLE telegram_drops (
  user_id   TEXT NOT NULL DEFAULT 'local',
  sender_id INTEGER NOT NULL,
  username  TEXT,
  first_at  TEXT NOT NULL,
  last_at   TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, sender_id)
);
`

/**
 * v9 — the link from a job to the ONE vault commit it produced, so "revert this ingest" (SPEC.md
 * §9's undo mechanism) is a button rather than manual git archaeology. The hash was previously
 * only ever written into the job's log TEXT; parsing that back out would be exactly the kind of
 * fragile log-scraping that has bitten this pipeline before.
 *
 * `reverted_at` records that the undo already happened, so the UI can offer the action once and
 * report it afterwards WITHOUT inventing a new job status — the lifecycle set in SPEC.md §8 is
 * closed, and a reverted ingest is still a `done` ingest that ran.
 *
 * Both nullable and appended: a plain ADD COLUMN, not a table rebuild (contrast v7, where a CHECK
 * constraint forced the full rebuild and cascade-deleted job_logs on the first attempt).
 * Batch members deliberately SHARE one hash — one commit covers the batch, so reverting via any
 * member undoes all of them; the UI has to say so.
 */
const V9 = `
ALTER TABLE jobs ADD COLUMN commit_hash TEXT;
ALTER TABLE jobs ADD COLUMN reverted_at TEXT;
`

/**
 * v10 — per-area maintenance state (SPEC.md §12.7 Stufe b). The runner's run history is a
 * bounded in-memory map that dies with the process, so "when did the last backfill/tag-fix
 * run, and did it work" was gone after every restart — exactly the facts the "what's due"
 * status layer needs. One row per (user, kind), upserted when a run settles.
 *
 * Operational state only (hard rule 1): losing it costs nothing but a "never ran" display
 * until the next run; runs whose outcome lives in the vault (lint report file, hot.md
 * mtime, index artifacts) keep those vault facts as the primary source.
 */
const V10 = `
CREATE TABLE maintenance_state (
  user_id     TEXT NOT NULL DEFAULT 'local',
  kind        TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  pages       INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  finished_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);
`

/**
 * v11: persist which job a duplicate duplicates. `duplicateOf` was only ever in the enqueue
 * RESPONSE, so a duplicate in the history could never answer "duplicate of what?" - the
 * dashboard's job drawer links the original now. Additive and nullable: existing duplicate
 * rows simply keep no link.
 */
const V11 = `
ALTER TABLE jobs ADD COLUMN duplicate_of TEXT;
`

/**
 * v12 — a persistent record per agent run (research, lint, hot cache, tag-fix, …).
 *
 * The runner's own history is a bounded in-memory map, and `maintenance_state` (v10) keeps
 * exactly one row per KIND, so a research run's topic, lens, cost and duration survived only
 * until the next run of the same kind or the next restart, whichever came first. The
 * Research screen had to reconstruct its history from the synthesis pages in the vault,
 * which carry topic and date but no cost, no duration, and no trace of a run that failed
 * before writing anything.
 *
 * One row per run, written when it settles. Operational state only (hard rule 1): losing it
 * costs history, never vault content - the pages themselves are in git either way.
 */
const V12 = `
CREATE TABLE agent_runs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL DEFAULT 'local',
  kind        TEXT NOT NULL,
  label       TEXT,
  profile_key TEXT,
  ok          INTEGER NOT NULL,
  pages       TEXT NOT NULL DEFAULT '[]',
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  cost_usd    REAL,
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE INDEX idx_agent_runs_kind ON agent_runs (user_id, kind, finished_at DESC);
CREATE INDEX idx_agent_runs_finished ON agent_runs (user_id, finished_at DESC);
`

/**
 * v13 - the commit each agent run produced.
 *
 * v12 recorded everything about a run except where its writing LANDED. The dashboard had to
 * infer that: a run event carried no hash, so the activity feed matched runs to commits by
 * time proximity and, having matched, dropped the commit event with its hash. The run detail
 * then read "nothing was committed" for every research, lint and tag-fix run that had in fact
 * committed cleanly. Time proximity is also ambiguous on its face - two runs settling inside
 * the same 90 s window cannot be told apart by it.
 *
 * The runner has held the hash all along (`CommitResult.hash`); it simply had nowhere to put
 * it. Additive and nullable: rows written before this migration keep no hash, and the UI
 * falls back to the time-proximity join for them.
 */
const V13 = `
ALTER TABLE agent_runs ADD COLUMN commit_hash TEXT;
`

/**
 * v14 - how a `done` run ended, when "done" would mislead (SPEC.md §12.9).
 *
 * A run that finishes cleanly but writes no wiki page - the agent found the source already
 * ingested and stopped - was indistinguishable from a successful ingest except by a "-" in
 * the pages column. `outcome = 'no-changes'` names it. Additive and nullable: every ordinary
 * run keeps NULL, and rows from before this migration are simply not classified.
 */
const V14 = `
ALTER TABLE jobs ADD COLUMN outcome TEXT;
`

/**
 * v15 - resident research agents ("Fellows", docs/agents/SPEC.md sections 5 and 11).
 *
 * `agents` is the Fellow record: identity, intent, home domain, model, step size, quota and
 * state. Operational state only (hard rule 1): the notebook page in the vault carries the
 * user-facing text, and losing this table loses the Fellows' settings, never vault content.
 * `agent_runs` learns which Fellow a run belonged to and which model it ran on, so the run
 * log can be filtered per Fellow and the quota gate can count a Fellow's runs.
 */
const V15 = `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  intent TEXT NOT NULL,
  scope TEXT,
  home_domain TEXT NOT NULL,
  extra_domains TEXT NOT NULL DEFAULT '[]',
  lens TEXT NOT NULL DEFAULT 'broad',
  model TEXT NOT NULL DEFAULT 'sonnet-5',
  effort TEXT NOT NULL DEFAULT 'high',
  step TEXT NOT NULL DEFAULT 'standard',
  quota_runs_per_day INTEGER NOT NULL DEFAULT 1,
  quota_week_pct REAL,
  autonomy TEXT NOT NULL DEFAULT 'veto',
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'proposed',
  sleep_reason TEXT,
  notebook_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE (user_id, slug)
);
ALTER TABLE agent_runs ADD COLUMN agent_id TEXT;
ALTER TABLE agent_runs ADD COLUMN model TEXT;
CREATE INDEX agent_runs_agent ON agent_runs (agent_id, started_at);
`

/**
 * v16 - planning and the night shift (docs/agents/SPEC.md sections 6 and 8, milestone A1).
 *
 * `agent_proposals` is what a Fellow's planning run leaves behind and what the user decides
 * on in the veto window; `agent_shifts` is one row per cycle date so a restart never runs
 * the night twice; `agents.sleep_code` says WHY a Fellow sleeps (the wake evaluator reads
 * it); `agent_runs.proposal_id` ties a run to the proposal it executed. Operational state
 * only (hard rule 1): the notebook's Plan section is rendered from these rows, never read.
 */
const V16 = `
CREATE TABLE agent_proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cycle_date TEXT NOT NULL,
  kind TEXT NOT NULL,
  topic TEXT NOT NULL,
  lens TEXT NOT NULL DEFAULT 'broad',
  rationale TEXT NOT NULL DEFAULT '',
  provenance TEXT NOT NULL DEFAULT '{}',
  page_set TEXT NOT NULL DEFAULT '[]',
  est_cost_usd REAL,
  est_plan_pct REAL,
  scope_score REAL NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'proposed',
  decided_at TEXT,
  decided_via TEXT,
  user_note TEXT,
  run_id TEXT
);
CREATE INDEX agent_proposals_agent ON agent_proposals (agent_id, status, rank);
CREATE TABLE agent_shifts (
  cycle_date TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'local',
  trigger TEXT NOT NULL DEFAULT 'timer',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, cycle_date)
);
ALTER TABLE agents ADD COLUMN sleep_code TEXT;
ALTER TABLE agent_runs ADD COLUMN proposal_id TEXT;
`

/**
 * v17 - the daily recap and the value signal (docs/agents/SPEC.md sections 9 and 11,
 * milestone A2, docs/tasks/TASKS-A2.md).
 *
 * `recaps` is one row per cycle date with the rendered model (the page is rendering only,
 * never read back); `value_events` counts page opens and recap link clicks locally;
 * `agent_runs.answer` keeps a run's result text for the recap's "what it found" lines;
 * `agents.skip_until` is "skip tonight". Operational state only (hard rule 1).
 */
const V17 = `
CREATE TABLE recaps (
  cycle_date TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'local',
  generated_at TEXT NOT NULL,
  path TEXT,
  quiet INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '{}',
  delivered TEXT NOT NULL DEFAULT '{}',
  answered_at TEXT,
  PRIMARY KEY (user_id, cycle_date)
);
CREATE TABLE value_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'local',
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT,
  page TEXT
);
CREATE INDEX value_events_agent ON value_events (agent_id, ts);
ALTER TABLE agent_runs ADD COLUMN answer TEXT;
ALTER TABLE agents ADD COLUMN skip_until TEXT;
`

/**
 * v18 - handoffs between Fellows (docs/agents/SPEC.md section 6.6, milestone A3,
 * docs/tasks/TASKS-A3.md D4 and D5): an open question routed to the Fellow whose domain
 * it is, or left unclaimed for the recap's spawn offer. Service-side only: notebooks stay
 * private to their Fellow.
 */
const V18 = `
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT,
  question TEXT NOT NULL,
  source_page TEXT,
  domain TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  cycle_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  proposal_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX handoffs_target ON handoffs (to_agent_id, status);
`

/**
 * v19 - the Library screen's rooms (docs/agents/SPEC.md sections 10.4 and 10.8, milestone
 * A4): the user's wings and where each department's shelf stands. Operational state only:
 * losing it costs the arrangement, the scene builder places every department again.
 */
const V19 = `
CREATE TABLE wings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE library_layout (
  domain TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'local',
  room TEXT NOT NULL,
  slot INTEGER NOT NULL,
  placed_by TEXT NOT NULL DEFAULT 'auto',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, domain)
);
`

/**
 * v20 - plan-percent accounting (docs/agents/SPEC.md sections 8.3 and 11, milestone A5):
 * utilization samples of the plan windows, and the per-window delta a Fellow run consumed.
 */
const V20 = `
CREATE TABLE usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'local',
  ts TEXT NOT NULL,
  window TEXT NOT NULL,
  utilization REAL NOT NULL,
  resets_at TEXT,
  run_id TEXT,
  phase TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'sdk'
);
CREATE INDEX usage_samples_window ON usage_samples (window, ts);
ALTER TABLE agent_runs ADD COLUMN plan_pct_delta TEXT;
`

/*
 * A Fellow's standing work becomes a LIST (docs/agents/ideas.md, decision 2026-09-07).
 *
 * One intent made a broad subject both likely and unmeasurable: the scope score is computed
 * against it, so widening the sentence widens what counts as on topic. Tasks are one to three
 * sentences, each with an art - watch, explore, deepen - taken one a night in turn.
 *
 * `intent` stays on the table and stays the first task's sentence: every existing Fellow, every
 * notebook page and every recap already refers to it, and a column dropped is a rollback that
 * cannot happen. `tasks` is JSON, like `extra_domains` beside it, and the migration writes the
 * intent into it so no Fellow wakes up without work.
 */
const V21 = `
ALTER TABLE agents ADD COLUMN tasks TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN task_cursor INTEGER NOT NULL DEFAULT 0;
UPDATE agents SET tasks = json_array(json_object('id', 't1', 'text', intent, 'kind', 'explore', 'state', 'active'));
`

/*
 * Releasing the rest of a five-hour window to the Fellows (SPEC section 8.6).
 *
 * A finished afternoon often leaves plan budget standing that nothing will use before the
 * window resets. One grant lifts both five-hour bounds for THAT window only.
 *
 * A table rather than a settings key, for two reasons. It expires - a setting does not, and a
 * limit that quietly stays raised is the thing this must never become. And every grant is a
 * row, so the record of who raised what and until when is the same object that raises it.
 */
const V22 = `
CREATE TABLE plan_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'local',
  window TEXT NOT NULL,
  pct REAL NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_plan_overrides_window ON plan_overrides (user_id, window, expires_at);
`

/**
 * A Fellow's art and how much of a night it works, and the order the night walks the shelves
 * (docs/tasks/TASKS-A7.md 3.3).
 *
 * `art` is what a Fellow MAY hold, not what it holds: an existing Fellow keeps `custom`, which
 * is the truthful answer for a mixed task list and permissive for a pure one. `nightly`
 * defaults to `sweep` because that is the decision (A7 D8) - a Fellow works every standing
 * task each night, so every night delivers a result - and a migration that left the two
 * existing Fellows on the old behaviour would have meant flipping the switch by hand to get
 * what was designed.
 *
 * `shelf_order` is a rank per domain, the night's PRIMARY sort key; `agents.priority` keeps its
 * meaning inside a shelf (A7 3.5). The two live at different levels and cannot contradict.
 */
const V23 = `
ALTER TABLE agents ADD COLUMN art TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE agents ADD COLUMN nightly TEXT NOT NULL DEFAULT 'sweep';
CREATE TABLE shelf_order (
  user_id TEXT NOT NULL DEFAULT 'local',
  domain TEXT NOT NULL,
  rank INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, domain)
);
`

/**
 * v24 - a job held for the night shift (docs/tasks/TASKS-SWEEP-2026-09.md, chunk 6).
 *
 * `hold = 'night'` on a `queued` job means the queue must not claim it until the shift
 * releases it at its start, ahead of every Fellow run. A column, not a status: the
 * lifecycle stays the eight states SPEC.md section 8 names, and a held job is a queued job
 * waiting for a particular moment. NULL for every ordinary job.
 */
const V24 = `
ALTER TABLE jobs ADD COLUMN hold TEXT;
`

/**
 * v25 - commits taken off the Activity stream (docs/tasks/TASKS-SWEEP-2026-09.md, second
 * sweep, chunk 1). The stream's commit rows come straight out of `git log` on every request,
 * so a row the user removed came back on the next poll; the trash needs somewhere to keep
 * the hash. Same shape as the domain dismissals. Operational state only: losing it costs
 * nothing but a row reappearing, and the vault's history is never touched.
 */
const V25 = `
CREATE TABLE commit_dismissals (
  user_id      TEXT NOT NULL DEFAULT 'local',
  hash         TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, hash)
);
`

/**
 * v26 - a job's place in tonight's ingest queue after the shift released it
 * (docs/tasks/TASKS-SWEEP-2026-09.md, follow-up of 2026-09-12). Releasing left no trace: the
 * moment the shift began, every held job dropped out of the queue the Library draws, though
 * none had run yet. The timestamp stays until the job is through - its commit made, or its
 * run ended with nothing left to run tonight - and is NULL again from then on.
 */
const V26 = `
ALTER TABLE jobs ADD COLUMN night_released_at TEXT;
`

/**
 * v27 - what a run's own text was checked against, and what was asked about a DOI
 * (docs/sources/SPEC.md sections 5.5 and 7.4).
 *
 * `jobs.validation` holds the post-run validation summary as JSON - today the quote counts,
 * later whatever else the validator can summarise per job. A column rather than a table: it is
 * one small object per job, read with the job and never queried across jobs.
 *
 * `oa_lookups` records what the open-access resolvers answered for a DOI, so the same question
 * is not asked of three APIs twice: a negative answer is respected for a week, a positive one
 * is reused at once (which is what lets the reading list's nightly sweep hand a find straight
 * to an ingest). Operational state only - losing the table costs a lookup.
 */
const V27 = `
ALTER TABLE jobs ADD COLUMN validation TEXT;
CREATE TABLE oa_lookups (
  doi        TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  found      INTEGER NOT NULL,
  result     TEXT NOT NULL
);
`

/**
 * v28 - where a wing's passage stands (docs/agents/SPEC.md section 10.4).
 *
 * A wing is two rows of shelves with one gap in each: the gap in the back row is the doorway,
 * the one in the front row is the aisle you walk through. Both sat at the middle of seven
 * positions, which fixed every wing at three shelves, passage, three. They are now a column
 * each, holding the position index 0 to 6, so a wing can be laid out one and five, two and
 * four, or six in a row with the way through at either end. Default 3, which is what every
 * wing looked like before.
 */
const V28 = `
ALTER TABLE wings ADD COLUMN wall_aisle INTEGER NOT NULL DEFAULT 3;
ALTER TABLE wings ADD COLUMN mid_aisle INTEGER NOT NULL DEFAULT 3;
`

/**
 * v29 - a cancelled job gives up its content hash (SPEC.md section 3.2).
 *
 * The hash is what dedupe looks up, so whoever holds it owns that content. A cancelled job
 * owns nothing: it wrote nothing and, being terminal, will write nothing. Holding on to it
 * meant a file queued for the night shift, taken out again and then dropped in with Add now
 * came back as a duplicate of the job that had just been cancelled. New cancellations release
 * it as they happen; this frees the ones already in the history.
 */
const V29 = `
UPDATE jobs SET sha256 = NULL WHERE status = 'cancelled' AND sha256 IS NOT NULL;
`

/**
 * v30 - the content hash stops being UNIQUE, so dedupe can ask a better question.
 *
 * The hash was the whole answer to "have I seen this before", and the column being UNIQUE
 * made that answer binding: whoever held the hash owned those bytes forever. v29 loosened it
 * for cancelled jobs by clearing the hash, which is a workaround for the constraint rather
 * than a rule - and it could not be extended to FAILED jobs, because a failed job is one
 * retry away from a run and must keep its identity.
 *
 * The rule belongs in the lookup ("does an earlier row still stand for this content?"), and a
 * lookup that skips a row cannot live under a UNIQUE column: skipping the row only moves the
 * collision to the insert. So the constraint goes and `create` filters by status instead.
 * Nothing else about the column changes; a plain index keeps the lookup fast.
 *
 * A full table rebuild, the documented SQLite procedure (create new, copy, drop old, rename),
 * for the same reason V7 needed one: a column constraint cannot be altered in place. It RELIES
 * on foreign keys being OFF while migrations run (see openDb) - with enforcement on, DROP
 * TABLE jobs would cascade-delete every job_logs row. The indexes die with the old table, so
 * all four are recreated. Every column of the live table is carried over by name.
 */
const V30 = `
CREATE TABLE jobs_v30 (
  id            TEXT PRIMARY KEY,                 -- ulid
  user_id       TEXT NOT NULL DEFAULT 'local' REFERENCES users(id),
  batch_id      TEXT,                             -- shared batches (SPEC.md §4.1)
  source        TEXT NOT NULL CHECK (source IN ('drop','watch','url','telegram')),
  type          TEXT NOT NULL CHECK (type IN ('pdf','office','web','image','text','av','other')),
  original_name TEXT,
  url           TEXT,
  sha256        TEXT,                             -- dedupe (SPEC.md §3.2); NOT unique, see v30
  status        TEXT NOT NULL CHECK (status IN (
                  'queued','preprocessing','ingesting','done',
                  'failed','deferred','duplicate','cancelled')),
  raw_path      TEXT,                             -- .raw/<job-id>/
  created_pages TEXT,                             -- JSON array of wiki pages created/updated
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  notify_channel TEXT,                            -- e.g. 'telegram:<chat_id>' (SPEC.md §4.3)
  commit_hash   TEXT,
  reverted_at   TEXT,
  duplicate_of  TEXT,
  outcome       TEXT,
  hold          TEXT,
  night_released_at TEXT,
  validation    TEXT
);

INSERT INTO jobs_v30
  (id, user_id, batch_id, source, type, original_name, url, sha256, status, raw_path,
   created_pages, error, attempts, tokens_in, tokens_out, cost_usd, created_at, started_at,
   finished_at, notify_channel, commit_hash, reverted_at, duplicate_of, outcome, hold,
   night_released_at, validation)
SELECT
   id, user_id, batch_id, source, type, original_name, url, sha256, status, raw_path,
   created_pages, error, attempts, tokens_in, tokens_out, cost_usd, created_at, started_at,
   finished_at, notify_channel, commit_hash, reverted_at, duplicate_of, outcome, hold,
   night_released_at, validation
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v30 RENAME TO jobs;

CREATE INDEX idx_jobs_status   ON jobs(status);
CREATE INDEX idx_jobs_batch    ON jobs(batch_id);
CREATE INDEX idx_jobs_created  ON jobs(created_at);
CREATE INDEX idx_jobs_finished ON jobs(finished_at);
CREATE INDEX idx_jobs_sha256   ON jobs(sha256);
`

/*
 * A Fellow's desk (docs/agents/SPEC.md 10.13, 2026-09-17). The Library's main room has ten
 * desks and every Fellow keeps one: given at spawn as the lowest free number, freed at
 * retirement. It is a column rather than a position in a list, because a list moves every
 * Fellow behind a retired one over by a desk, and a place that moves is not a place. The
 * Fellows already there take desks in the order they were spawned, retired ones none.
 */
const V31 = `
ALTER TABLE agents ADD COLUMN desk INTEGER;
UPDATE agents SET desk = (
  SELECT seats.n FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at, id) - 1 AS n
    FROM agents WHERE state != 'retired'
  ) AS seats WHERE seats.id = agents.id
) WHERE state != 'retired';
`


/*
 * Standing validation findings (A9, 2026-09-19).
 *
 * The validator reported 406 warnings into job logs and nothing ever acted on one: the same
 * dead link was reported 109 times, the same counter drift 58 times, every one labelled
 * "advisory only". A finding that repeats 109 times is not a finding, it is a log line.
 *
 * So a finding gets an identity - rule, path and a NORMALISED message, hashed - and one row
 * that counts how often it has been seen and when it was first and last seen. Repeats update
 * a row instead of writing another line, which is what makes a standing defect list possible
 * and what lets a fix show up as a row that stops being seen.
 *
 * `jobs.validation` stays as it is (the quote summary) and gains nothing: a job's own view of
 * its run is not the same question as "what is standing in this vault".
 */
const V32 = `
CREATE TABLE validation_findings (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL DEFAULT 'local',
  rule        TEXT NOT NULL,
  path        TEXT NOT NULL,
  message     TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  /** The job or run that last reported it, for "where did this come from". */
  last_job_id TEXT,
  /** Set when the finding stops being reported, so a fix is visible rather than silent. */
  resolved_at TEXT
);
CREATE INDEX idx_validation_rule ON validation_findings(rule);
CREATE INDEX idx_validation_last ON validation_findings(last_seen);
`


/*
 * The float artifact in the stored plan samples (A7, 2026-09-19).
 *
 * `parseRateLimitEvent` rounded only the branch where the SDK sent a FRACTION, and passed a
 * reading that already arrived as a percentage through untouched. The raw float then reached
 * the database and a recap page: 12 of 748 samples hold `7.000000000000001`, and a committed
 * page printed `57.99999999999999%`.
 *
 * The parser is fixed, which stops new ones. This normalises what is already stored, to the
 * same two decimals, so the dashboard's history does not keep showing a number that no longer
 * arises - and so nothing has to wonder later whether the fix worked.
 */
const V33 = `
UPDATE usage_samples SET utilization = ROUND(utilization, 2)
WHERE utilization IS NOT NULL AND utilization != ROUND(utilization, 2);
`

/*
 * What a finding is based on, written down when it is made (2026-09-21, TASKS-DEFECT-PATHS 1.3).
 *
 * A row on the standing list says what is wrong and never shows it. For most rules that is
 * recoverable - re-read the page and the offending lines are there. For `quote` it is not:
 * the check compares a quotation against the artifact the JOB read, normalised to a lowercase
 * word stream, and neither the quotation in full nor how much of it does stand in the source
 * survives into the message (it carries the first 80 characters and a length).
 *
 * So the producer writes it down while it still has the source in memory. NULL for every rule
 * whose evidence the page itself still holds; `record()` never overwrites a value with NULL,
 * because a later run that has no evidence must not erase what an earlier one had.
 */
const V34 = `
ALTER TABLE validation_findings ADD COLUMN evidence TEXT;
`

/*
 * Accepting a defect, with a reason (2026-09-21, TASKS-DEFECT-PATHS 2.1).
 *
 * SEPARATE FROM `resolved_at`, because the two say different things. Resolved means the defect
 * is GONE - a run read the page again and no longer found it. Accepted means it may STAY: this
 * tag really does name one page and that is fine, these two pages really are different. A row
 * can be accepted and later resolved (somebody fixed it anyway); the accept is what keeps it
 * off the list in the meantime.
 *
 * The reason is required by the route and stored verbatim. A snooze would only postpone the
 * reading, and an accept without a reason is indistinguishable from neglect six months on.
 */
const V35 = `
ALTER TABLE validation_findings ADD COLUMN accepted_at TEXT;
ALTER TABLE validation_findings ADD COLUMN accepted_reason TEXT;
CREATE INDEX idx_validation_accepted ON validation_findings(accepted_at);
`

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: V1 },
  { version: 2, up: V2 },
  { version: 3, up: V3 },
  { version: 4, up: V4 },
  { version: 5, up: V5 },
  { version: 6, up: V6 },
  { version: 7, up: V7 },
  { version: 8, up: V8 },
  { version: 9, up: V9 },
  { version: 10, up: V10 },
  { version: 11, up: V11 },
  { version: 12, up: V12 },
  { version: 13, up: V13 },
  { version: 14, up: V14 },
  { version: 15, up: V15 },
  { version: 16, up: V16 },
  { version: 17, up: V17 },
  { version: 18, up: V18 },
  { version: 19, up: V19 },
  { version: 20, up: V20 },
  { version: 21, up: V21 },
  { version: 22, up: V22 },
  { version: 23, up: V23 },
  { version: 24, up: V24 },
  { version: 25, up: V25 },
  { version: 26, up: V26 },
  { version: 27, up: V27 },
  { version: 28, up: V28 },
  { version: 29, up: V29 },
  { version: 30, up: V30 },
  { version: 31, up: V31 },
  { version: 32, up: V32 },
  { version: 33, up: V33 },
  { version: 34, up: V34 },
  { version: 35, up: V35 },
]
