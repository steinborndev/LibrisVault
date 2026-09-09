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
]
