# Specification: Automated Second-Brain Vault with Ingestion Dashboard

**Version:** 0.1 (draft) · **Date:** 2026-07-17 · **Status:** guides the implementation

**Language note (2026-09-05):** English since this date, translated from the German original. Section numbers are unchanged, so every `SPEC.md §…` reference in code and docs still resolves. Examples that had named the private vault's actual subjects were generalized in the same pass; this repository is public and the vault is not (CLAUDE.md hard rule 7).

---

## 1. Overview and goals

The project extends a [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) vault (v1.9.2, MIT) with a fully automatic ingestion layer and a local web dashboard. The repo's own workflow is manual: the user opens Claude Code in the vault folder and types `ingest file.pdf`. This project replaces that manual trigger with two automatic intake channels, a drag-and-drop area in the dashboard and a watched folder in the file system, and makes the vault's state (statistics, queue, history, health) visible and controllable through a dashboard with four tabs. Questions to the vault ("what do you know about X?") become possible through the dashboard as well.

**Core goals:**

1. Material from drag-and-drop and the watch folder is analyzed, linked and filed into the vault without further action (entities, concepts, source pages, index, log and hot-cache updates according to the claude-obsidian conventions).
2. The vault remains 100 % an ordinary claude-obsidian vault: plain Markdown, usable in Obsidian, directly operable with Claude Code. The dashboard is a layer *on top of* the vault, not a replacement data store.
3. The whole stack runs locally (WSL2 on Windows); no data leaves the machine except the calls to the Anthropic API during agent runs.

**Not in v1, but planned mid-term and accounted for in the architecture:** multi-user operation, access across devices (sync) and mobile use. v1 does not implement these features but makes every decision so that they can be added without re-architecture; the concrete provisions and the extension path are in section 12. Also deferred: audio/video transcription (the preprocessing plugin interface is prepared in v1).

---

## 2. Framing decisions

| Question | Decision | Rationale |
|---|---|---|
| Dashboard form | Local web app (browser + local server) | Flexible, no Obsidian plugin sandboxing, and a server is needed for watcher and queue anyway |
| Ingestion mode | Fully automatic, immediate filing | No review step; errors land visibly in the Ingestion tab |
| Analysis engine | Claude Agent SDK (headless) + claude-obsidian skills | The repo's ingestion logic lives in skills and scripts; the SDK can run them programmatically |
| Operating system | Windows 11, execution in **WSL2** | claude-obsidian is bash-heavy (setup, `wiki-lock.sh`, hooks); WSL2 runs it unchanged |
| Organization mode | **Generic** (standard wiki structure) | Heterogeneous subject matter across unrelated fields; domain separation via sub-indexes, switchable later |
| Anthropic auth | **Claude subscription** (OAuth token via `claude setup-token`), API key as an equivalent configuration path | Subscription available; policy situation in flux (see 7.1), hence both paths supported |
| Vault language | **English** for all wiki content (page names, concepts, index, summaries) | Mixed source languages (de/en); one target language prevents duplicate concepts in the graph. Verbatim quotes keep their source language |
| Transcription | v1: not supported | Audio/video files are recognized, parked in `.raw/deferred/` and marked "waiting for transcription" in the dashboard |

---

## 3. System architecture

All components run inside WSL2 (recommended: Ubuntu 24.04). The browser on Windows connects via `localhost` (WSL2 forwards localhost automatically).

```
Windows 11
├── Browser  ──────────────────────────► http://localhost:8420  (dashboard)
├── Watch folder (e.g. C:\inbox)  ────► visible in WSL as /mnt/c/inbox
└── WSL2 (Ubuntu)
    ├── Vault folder  ~/vault/           (claude-obsidian, git-initialized)
    │   ├── wiki/  (index.md, hot.md, log.md, concepts/, entities/, sources/, meta/)
    │   ├── .raw/  (source documents, filled by the pipeline)
    │   └── .obsidian/, skills/, scripts/, agents/ …
    ├── Backend service  (Node.js, TypeScript)
    │   ├── HTTP API + static frontend (port 8420, bind 127.0.0.1)
    │   ├── SSE channel for live updates (queue status, log tail)
    │   ├── Watcher (chokidar on the watch folder)
    │   ├── Ingestion queue (SQLite, better-sqlite3)
    │   ├── Preprocessing worker (format normalization)
    │   └── Agent runner (@anthropic-ai/claude-agent-sdk)
    └── Obsidian for Windows opens the vault via \\wsl$\Ubuntu\home\<user>\vault
```

**Note on Obsidian + WSL (corrected after the M0 finding):** The vault lives in the WSL file system (performance, locking semantics). **Obsidian on Windows cannot open a WSL vault via `\\wsl$`**: it fails at startup with `EISDIR … watch` (the file watcher cannot watch directories over the 9p share; classified as won't-fix by Obsidian). Not merely "sluggish", but non-functional. **Chosen solution: Obsidian runs as a Linux app *inside* WSL via WSLg** and opens `~/vault` as a local path; the vault stays on ext4, the service keeps full speed. (Rejected alternative: vault on `/mnt/c/vault` with the native Windows Obsidian, which would burden every agent run and git commit with the 20-65x drvfs penalty. The earlier worry about `wiki-lock.sh` on drvfs is unfounded: all locking tests pass there.) WSLg limitation: the graph view stutters (software rendering, no `/dev/dri`); typing and opening notes stay fluid. Details in section 11.

### 3.1 Components

**Backend service (one process):** Fastify or Express server in TypeScript. Serves the frontend, provides the REST API and an SSE endpoint, hosts watcher, queue worker and agent runner. Started as a systemd user service in WSL (`systemctl --user enable vault-service`) so the service comes up with WSL.

**Watcher:** `chokidar` observes the configured watch folder recursively. New or changed files are picked up only after a stability check (`awaitWriteFinish`, 2 s of unchanged size) to avoid half-copied files. After pickup the file is **moved** into the vault's `.raw/` (watch folder = inbox, gets emptied; prevents double processing after a restart).

**Ingestion queue:** SQLite table `jobs` as the single source of truth for all processing. Jobs move through the states `queued → preprocessing → ingesting → done | failed | deferred`. A worker pool drains the queue; **default concurrency for agent runs: 1** (configurable, corrected 2026-09-19). The vault's own ingest skill states the constraint it was built under: "Single-writer only ... Do not run parallel ingests from multiple Claude sessions or sub-agents that assign addresses. The `flock` in the helper prevents counter corruption but does not serialize page writes themselves." This paragraph previously said 2 and claimed claude-obsidian's per-file locking (`scripts/wiki-lock.sh`) protected the vault level as well; both halves were wrong. Measured 2026-09-19: at the old default, **13 of 31 finished jobs overlapped another job in time**, and the lock's staleness window (60 s by default, since widened to 600 s) was shorter than **9.6 % of real lock holds** - a lock that outlives its window is reaped and both writers proceed. What the lock does protect is a page one writer holds RIGHT NOW against another writer that asks for it in the same window, which is the manual-Obsidian-session case, not the two-ingests case. Raising the default back to 2 needs the service-owned hub layer shipped (it removes the long holds, which are all on the hub files) and a measured run of the new write path; the deviation gets written down either way.

**Preprocessing worker:** Normalizes incoming material into a format suitable for ingestion (details in section 5), stores original + normalized form under `.raw/<job-id>/` and writes a `manifest.json` (source, type, hashes, timestamps).

**Agent runner:** Runs one headless run per job through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, TypeScript). Configuration:

- `cwd` = vault root. Two loading paths that do **not** do the same thing (corrected after the M0 finding): `settingSources: ['project']` loads the vault's `CLAUDE.md` but **not** its skills; the claude-obsidian vault is a Claude Code *plugin* (`.claude-plugin/plugin.json`), and the CLI does not scan its `skills/` folder on its own. To activate the skills (`wiki-ingest` etc.) additionally set `plugins: [{ type: 'local', path: <vault root> }]` and `skills: 'all'`. Without this plugin loading path the agent falls back to reading `SKILL.md` manually and improvises (measured in M0: with the plugin path 143 to 55 turns, 12.7 to 5.4 million input tokens, 13 to 15 pages).
- Prompt per job: `ingest .raw/<job-id>/<file>` (or, for a batch, `ingest all of these` with the file list), extended by a fixed system-prompt extension that enforces full automation: ask no questions, take the documented default decision on ambiguity and note it in the log. Additional language rule: all wiki content (page names, concept names, summaries, index entries) is written in English regardless of the source language; verbatim quotes keep their original language with a language note. Before creating new concept pages, existing English names are checked (prevents de/en duplicates such as a German concept name filed next to its English equivalent).
- **Containment, corrected 2026-09-15 from the M0 measurement.** Two guarantees are load-bearing and both are enforced at the OS level by the SDK's `sandbox` (bubblewrap on Linux): writes are confined to the vault root plus the sandbox's default temp allowlist, and an ingest run has no web egress at all (web only in the autoresearch flow). Tool-level policy runs through a `PreToolUse` hook, NOT through `canUseTool`, which this SDK was measured to invoke zero times. The bash denylist under it is defense in depth and explicitly **not** a `scripts/*.sh` whitelist: of 68 bash calls in the validated M0 ingest, 14 were `find`, `ls`, `cat` and `python3`, so a scripts-only whitelist would block a real ingest. Deciding what an arbitrary shell string writes is not tractable; the sandbox is what protects the vault, and `server/src/cli/permprobe.ts` is the only check that catches an SDK that stops consulting the guard.
- The SDK's streaming messages are persisted as the job log in SQLite and handed to the dashboard live via SSE.
- Timeout per job (default 30 min; a batch is ONE combined agent run and the budget has to carry the whole batch: 15 min was not enough for multi-PDF batches, corrected 2026-07-24), at most 2 automatic retries on transient errors (API errors, timeout); then `failed` with error details.
- After every successful job: git auto-commit (unless Obsidian Git commits anyway; only one of the two, configurable, default: the service commits with the message `ingest: <source>`). A separate hot-cache refresh pass is dropped (corrected after the M0 finding): the ingest skill maintains `wiki/hot.md` itself; a manual refresh stays available in the Maintenance tab (§6.4).

**Query runner:** Like the agent runner but read-only (`permissionMode` restrictive, read tools + `wiki-retrieve` only), fed from the Query/Chat tab. Sessions are held through the SDK's session management so follow-up questions keep their context.

### 3.2 Ingestion data flow (happy path)

1. A file arrives via drop (HTTP upload) or in the watch folder.
2. The service computes its SHA-256 and asks whether an earlier attempt **still stands for this content** - a hash in `jobs` on a job that reached the vault or is still on its way there, **or a `.raw/<job-id>/manifest.json` of the vault whose run is known to have written pages** (amended 2026-09-16, see 12.9). If so, the job is marked as a duplicate and skipped (visible in the history, with a reference to the original job). After preprocessing a second, content-level stage follows via the DOI (12.9, added 2026-09-05). A link is checked at enqueue against the canonical addresses the source pages declare, before anything is fetched (12.9, added 2026-09-18).
3. Job `queued` → preprocessing (normalization, `.raw/<job-id>/`) → `ingesting` (agent run) → `done`.
4. The agent creates/updates wiki pages, index, log, hot cache; the service commits; the dashboard refreshes statistics via SSE.

---

## 4. Intake channels

### 4.1 Drag-and-drop (dashboard, Ingestion tab)

- The dropzone accepts files (multi-drop) **and** text/URLs (dropping or pasting a URL starts a URL job).
- Upload via `multipart/form-data` to `POST /api/jobs`; limit 200 MB per file (configurable).
- Several files dropped at once are grouped as a **batch**: first each is preprocessed individually, then one combined `ingest all of these` run so the agent can cross-reference (the repo's behaviour for batch ingestion).
- Since the redesign there are two drop surfaces (the dropzone in the control column and the whole window). A drop on the dropzone is handled by the dropzone **only**; the window-level handler leaves it alone (`data-drop-target`). Until 2026-09-05 both accepted the same drop, and every file reached the server twice, the second one as a "duplicate" of the first.

### 4.2 Watch folder

- Configurable path (default `/mnt/c/inbox`; corrected after the M0 finding: the default has to name a drive that actually exists on the target machine, which the earlier default did not. Changeable in the dashboard; several folders conceivable in v1.1).
- Behaviour as in 4.1, plus: files that arrive together within 60 s are bundled into one batch (typical case: the user copies a bunch of files).
- Special case: `.md` files from the Obsidian Web Clipper are treated as web sources (the frontmatter URL is evaluated).
- Unsupported types (v1: audio/video, archives): moved to `.raw/deferred/`, job status `deferred`, visible marker in the dashboard. Archives (`.zip`) are **not** unpacked automatically (v1 security decision). **Disguised executables** (magic-byte finding contradicts the extension) are a security finding, not "waiting for a feature": job status `failed` with a clear error message, no move to deferred (decision 2026-07-18, replaces the earlier classification under deferred).

### 4.3 Telegram bot (added 2026-07-20)

Third intake channel plus status channel, primarily for the phone ("queue a PDF from the phone"). A deliberate complement to the §12.5 path (tailnet + PWA share target): the bot covers *only* status + ingest, but without any network infrastructure and platform-independently (including iOS, where the web share target does not exist); the PWA share target remains the more private full-access path.

- **Opt-in via configuration:** `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USER_IDS` (comma-separated numeric Telegram user ids) in the service env file. Without a token: bot off, behaviour as before. A token **without** an allowlist means the service refuses to start with a clear error (fail-closed, like the double-credential guard in §7.1): a bot that answers everyone must never come into existence by forgetting something.
- **Transport: long polling** (`getUpdates`, outgoing HTTPS connection to `api.telegram.org`), **no webhook**. No port is opened, no bind changed; the localhost guard (§9) is untouched. The client is a minimal bot-API client of our own (`getUpdates`, `sendMessage`, `getFile` + download), no framework. `getUpdates` allows exactly one consumer per token; if the API answers `409 Conflict` (a second instance, e.g. dev next to systemd), the bot stops polling with a clear log line instead of competing; the service itself keeps running.
- **Interaction:** `/status` (setup mode, queue/job counters, budget: the data of health/stats), `/jobs` (latest jobs with status). Sent documents/photos are downloaded via `getFile`, staged like a dashboard upload and enqueued in the regular queue with `source: 'telegram'`; sent URLs/texts become URL/text jobs. Albums (Telegram `media_group_id`) are bundled into **one batch** (the analogue of the multi-drop in §4.1). The bot confirms the enqueue immediately with the job id.
- **Limit:** The bot API only lets bots download up to **20 MB** (users may send up to 2 GB; `getFile` then refuses). Larger files get an immediate answer pointing to dropzone/watch folder, no job.
- **Completion message:** When a Telegram job reaches `done`/`failed`/`deferred`/`duplicate`, the bot reports it to the originating chat; for `done` with the titles of the created pages, **without content excerpts** (§9). The chat assignment is persisted on the job as `notify_channel` (§8) so it survives a service restart.
- **Setup mode (§7.1):** The bot also starts without an Anthropic credential, reports setup mode on `/status` and declines ingest attempts with a hint, mirroring the upload route's `503`.
- Messages from senders outside the allowlist are **dropped without a reply**; the first attempt per sender id is noted in the service log (added 2026-07-20, details in §9).
- **Configuration through the dashboard (added 2026-07-20, user decision):** Token and allowlist can be entered under Maintenance → Settings. `POST /api/v1/settings/telegram` writes **both variables together** into the service env file (the fail-closed guard above must not be producible through this path), `DELETE` removes both (bot off). The same rules apply as for the credential endpoint in §7.1: values are never returned or logged (the settings view shows only the status "on/off + allowlist size"), activation by restart (self-restart under systemd), `409` for values coming from the process environment (the file would be shadowed) or while agent runs are active (the restart would abort them).

---

## 5. Material types and preprocessing

| Type | Detection | Normalization | Tool |
|---|---|---|---|
| PDF | Extension + magic bytes | Text extraction; below 100 characters of text per page: rasterize pages + OCR | `pdftotext` (poppler), fallback `ocrmypdf`/tesseract (deu+eng) |
| Office (docx, pptx, xlsx) | Extension | Conversion to Markdown/plain text | `pandoc` (docx), `python-pptx`/`openpyxl`-based extractors from WSL |
| Web page/URL | URL job | Fetch + boilerplate removal following the repo's egress hygiene rules (no `file://`, no RFC1918, DNS pinning against rebinding, size limit); then a **sanity gate**: minimum length + pattern detection for login walls, JS shells and anti-bot pages. If the gate trips, the job ends `failed` with a reason before any agent run (no junk in the vault) | `defuddle-cli` (the extractor the repo intends), fallback: built-in HTML-to-text extractor (readability as a possible later upgrade) |
| X/Twitter post | URL job (domain handler) | Public posts via the FxTwitter JSON API (`api.fxtwitter.com`, no login) instead of an HTML fetch; X serves only a login shell as HTML. Private/deleted posts end `failed` with a clear message | built-in handler (`url-handlers.ts`), fetch through the SSRF-protected pipeline |
| YouTube video | URL job (domain handler) | Metadata + subtitles/auto captions (de, en) instead of the content-free watch page; without subtitles: metadata + description with a note | `yt-dlp` (optional tool; if missing, the job ends `failed` with an installation hint) |
| Image (png, jpg, webp) | Extension + magic bytes | No local OCR needed: the image is handed to the agent run directly as an attachment (Claude reads image content and screenshot text itself); EXIF metadata additionally in `manifest.json` | Agent SDK (image input), `exiftool` |
| Markdown/text/code | Extension | Pass through | none |
| Audio/video | Extension | v1: `deferred` (see 4.2) | later: faster-whisper or a cloud API, interface: preprocessing plugin |

Preprocessing is implemented as a plugin chain (`detect → normalize → manifest`) so that transcription can later click in as another plugin without rebuilding the pipeline.

**Every converter runs contained (added 2026-09-08).** `pdftotext`, `pdfinfo`, `ocrmypdf`, `pandoc`, the Python office extractor, `exiftool` and `defuddle` all go through `runConverter`, which is bubblewrap with no network, no `$HOME`, a read-only `/usr` and `/etc`, the input file, and one writable output directory. This is the reasoning of the agent sandbox one stage earlier: a document reaches these parsers BEFORE any agent sees it, and a timeout is a liveness guard, not a boundary. `yt-dlp` is the one documented exception, being a fetcher. A missing bubblewrap fails the conversion unless `PREPROCESS_SANDBOX=off`, and `server/src/cli/preprocprobe.ts` is what proves the policy is applied rather than merely written.

**What a converter produces is fenced as data** before any agent reads it, and a URL that serves a PDF is read as one rather than as HTML. See section 12.11. URL jobs analogously have a **domain-handler registry** (`url-handlers.ts`): domains whose HTML cannot be ingested (X/Twitter, YouTube) each get a handler that obtains the content through a better channel; new domains are added as handlers, never as special cases in `preprocessUrl`. Handler HTTP goes through the same SSRF-protected fetch; `yt-dlp` is the deliberate exception (an external tool with its own egress, only for YouTube hosts).

---

## 6. Dashboard

Single-page app (React + Vite + TypeScript), served by the backend service, bound to `127.0.0.1:8420`. Four tabs:

**Correction 2026-08-27 (as-built state recorded): the shell has five screens, not four tabs.** The structure was rebuilt in three passes (2026-08-23 sidebar shell; 2026-08-25 second pass: navigation as browser-style tabs in the header row, Inbox merged into Home, Health and Settings merged into System; 2026-08-26 third pass: Home split into two zones, Research switched to two ledgers). The redesign branch was merged into `main` on 2026-08-27; the table below describes the state that ships. Subsections 6.1 to 6.5 stay as they are: they are the state that was built against, code comments reference their numbers, and each ends with a line saying where its content lives today.

| Screen | Route | Content | Comes from |
|---|---|---|---|
| **Home** | `/` | Two zones. Above, the **stock**: the page count as the headline figure, the countable facts beside it (links, median degree, domains, unfiled pages, pages linked but never written), the wikilink graph as a picture, and the domain panel with its three views (Domains, This week, Gaps). Below, the **flow**: the operational figures (in flight, failures 7 d, ingests 7 d, spend today, checks due) as a strip on top of **one** activity stream over jobs, agent runs and vault commits of the last 30 days. On the left the control column: intake (dropzone + URL/note), below it the filters by kind, time range, state and channel. A row opens the full record (log, commit, created pages, retry, revert). | 6.1 + 6.2 |
| **Research** | `/research` | On top the composer with two modes: *Web Research* (web egress, writes pages, one commit) and *Vault Research* (read-only, answers with page citations), plus the plan line (lens, target page, fetch budget, commits) and the phase bar of the running run. Below, **two ledgers of the same shape**, web runs and vault conversations, which share the height and scroll independently; an object appears exactly once, and opening one replaces both ledgers with the detail view and a way back. On the left the control column: lens profiles as a standing control, a filter over the web ledger, the running totals and the queue footer. At the bottom the "Worth a run" backlog from the open graph gaps. | 6.3 + autoresearch from 6.4 |
| **Graph** | `/graph`, `/page/<path>` | The vault viewer: graph canvas and page view, two routes, one screen. | 12.4 |
| **Library** | `/library` | The tabular view over all pages: filters by type, domain and subset (orphans, stubs, system), sorting, and per row the provenance as a link to the ingested raw document. | new (2026-08) |
| **System** | `/system` | Five sections in the control column: *Status & checks* (the guided cadence from 12.7, including hot-cache content and refresh), *Usage & cost*, *Vault stats* (including commit history), *Service & config*, *Integrations* (credential, Telegram, Obsidian). | 6.4 |

Two things that belong to no subsection:

- **The service status lives in the header row**, no longer in the overview: three chips (Watcher, Telegram, Connection), each a status dot plus a noun, details on hover. The Live chip additionally opens queue, daily budget and the last commit.
- **Old routes are normalized**, not broken: `/inbox`, `/ingestion`, `/vault`, `/chat`, `/wartung`, `/maintenance`, `/health` and `/settings` are rewritten to the current ones via `replaceState`; suffixes (page paths, `?filter=`) are preserved.

**Correction 2026-09-15 (the Fellows surfaces, and one rename that is not theirs).** The name **Library** changed owner in 2026-09-06: the tabular view this table describes under `/library` is now called **Catalog** and sits at `/catalog`, and `/library` carries a new screen of that name. The rename is **not** behind the feature flag, so it is the one visible change the base product takes from the A-series: an install that upgrades and sets nothing finds its Library tab renamed. The view itself is unchanged, and the name went where it fits - a catalog of pages is what it is, and a library is what the new screen draws.

That new screen is the sixth, and it IS behind the flag: an isometric room view where a Fellow is a figure, a domain is a shelf, and one window manages the Fellows completely - tonight's schedule priced from measured run durations, a dossier per Fellow with its notebook, recap slice, run ledger and settings, the open decisions, and spawning. The wall board beside it carries the hot cache, the daily recap and the reading list. Home gains the night's own strip and the plan-usage corner; System gains the research share and its reserves. With the flag unset none of this renders and the tab is not offered, which is what `health.fellows` is for (section 12.10). So the shell is five screens without the extension (Home, Research, Graph, Catalog, System) and six with it.

### 6.1 Tab "Overview"

Vault statistics and recent activity at a glance: page counts per type (concepts, entities, sources; counted from the file system and cached), growth over time (from git history), most recently created/changed pages (clickable with an `obsidian://open?vault=…&file=…` deep link), content of the hot cache (`wiki/hot.md` rendered), figures of the last 7 days (ingests, failures, processed sources), service status (watcher active, queue length, latest git commits).

**As built 2026-08-26:** Figures, growth and page counts per type live in **System → Vault stats**, the activity in **Home**, the service status in the header row, the hot-cache content in **System → Status & checks**. Not built: `recentPages` ("most recently created/changed pages") is delivered by the `/stats` endpoint but rendered by no view; the Library sorted by *Changed* takes that role.

### 6.2 Tab "Ingestion"

The heart of the operation. On top the dropzone (files + URLs), below it three areas: **Active** (running jobs with a live log stream from the agent run), **Queue** (order changeable, jobs cancellable) and **History** (filterable by status/type/time range; per job: source, created/updated wiki pages with links, duration, token/cost estimate from the SDK usage data). Failed jobs show the error message and offer "Retry". `deferred` jobs (audio/video) are visible as their own category.

**As built 2026-08-26:** The tab has merged into **Home**. Dropzone and URL field sit in the control column, and the three areas (Active / Queue / History) have fused into **one** stream in which the state is a filter dimension rather than its own area; jobs, agent runs and vault commits stand side by side in it, because from the reader's point of view they are the same thing: what happened to the vault. Not built: the queue is **not** reorderable (no endpoint, no control); cancel, retry and revert exist.

**Added 2026-09-05:** Single rows of the stream can be removed from the history (row action in the table and in the detail view, two-step confirm): settled jobs via `DELETE /api/v1/jobs/:id`, persisted agent runs via `DELETE /api/v1/maintenance/history/:id`. Both delete operational rows only; vault, pages and commits stay. Vault commits without a row of their own (reconstructed events) have no delete action. A `done` job whose run wrote no content page (the vault's meta pages - index, log, hot cache, overview, folder indexes - do not count) carries the outcome `no changes` as a badge and an explanation line; duplicates show their explanation as a line under the name - which job already ingested this content, or which one is still ingesting it (12.9).

### 6.3 Tab "Query/Chat"

Chat surface against the query runner. Answers contain the page citations delivered by the wiki-query skill; cited pages are rendered as clickable chips (Obsidian deep link + inline preview of the page content). Several chat sessions in parallel, sessions nameable.

**A chat answer never becomes vault content (decided 2026-09-19, and this replaces the sentence that used to end this paragraph).** Until then a "Save session to vault" button started a write-enabled agent run that resumed the chat's SDK session and ran the vault's own `/save` flow; the button, the route `POST /api/v1/sessions/:id/save` and the runner behind it are all removed, and a test asserts the route 404s so the older wording here cannot bring it back.

The reason is what a chat answer IS. It is assembled from pages the vault already holds and it cites them; filing it writes a third statement of what two pages already say, under a title nobody will look for again. That is the island-making this vault was measured to suffer from: 73 % of its concept pages cite exactly one source, and 61 % were written by exactly one commit and never revisited (SPEC.md §12.12's measurements). A mechanism that adds pages nothing links to makes that worse, and the work that could have made it better - folding an answer back into the pages it cited - is a different mechanism with a different cost, deliberately not built.

**The chat is read-only, all the way down**, and that is now a property rather than a default: the query runner has no write profile, and there is no route by which a conversation reaches the vault.

**As built 2026-08-26:** Lives in **Research**, together with the autoresearch from 6.4 (see the correction there). Both modes share one console; sessions can be renamed and deleted.

### 6.4 Tab "Maintenance"

- **Lint:** A button starts `lint the wiki` as an agent run; the result is shown structured (orphans, dead links, stale claims, missing cross-links, `[!contradiction]` findings), each with a link to the page. Optional: weekly auto-lint (cron in the service), result lands as a report in the tab. Absorbed into the check cadence of 12.7 (stage c).
- **Autoresearch:** An input field for a topic with explicitly enabled web egress; progress (rounds, sources found) live in the log; result pages linked. **Correction 2026-07-24 (as-built state recorded):** Autoresearch does not live in the Maintenance tab but in the Query/Chat composer (6.3); it is an everyday function, not maintenance. The originally planned slash invocation `/autoresearch <topic>` was dropped in favour of an explicit prompt (the namespaced plugin command could not be triggered reliably headless).
- **Further development:** The tab grows from a collection of cards into a guided maintenance workflow; concept, rationale and staged plan in **12.7**.
- **Hot cache:** manual refresh button + display of the last refresh time.
- **Settings:** watch folder path, concurrency, file limits, git commit behaviour, API key status (the key itself is never shown). **Added 2026-07-19:** this is also where the first-run credential entry lives (subscription token vs. API key to choose from, each with instructions); expanded in setup mode and linked from an app-wide banner, hidden behind "Replace credential…" once a credential is configured. Still only the status is shown, never the value.

**As built 2026-08-26:** Lives in **System**, split into five sections (see the table at the start of 6). The maintenance workflow itself is 12.7 stage (c) and sits in *Status & checks*.

### 6.5 API (excerpt)

All endpoints are versioned under `/api/v1/` from v1 on and pass through an auth middleware which, in v1's "local-single-user" mode, lets everything through (see section 12.1); the later auth build-out is therefore a configuration question, not a rebuild.

```
POST   /api/v1/jobs                 create a file upload or URL job
GET    /api/v1/jobs?status=&type=   job list (paginated)
POST   /api/v1/jobs/:id/retry       retry
DELETE /api/v1/jobs/:id             cancel (queued) or remove from the history (settled; added 2026-09-05)
GET    /api/v1/stats                overview figures
POST   /api/v1/query                question to the query runner (session id optional)
POST   /api/v1/maintenance/lint     start a lint run
POST   /api/v1/maintenance/research start autoresearch
GET    /api/v1/events               SSE: job updates, log streams, stats invalidation (at most 8 concurrent streams per client address, 429 beyond that; behind a loopback reverse proxy the client address comes from X-Forwarded-For)
GET/PUT /api/v1/settings            configuration
POST   /api/v1/settings/credential  accept the first-run credential (7.1);
                                    writes the service env file, never returns the value
```

**Added 2026-08-26 (as-built state recorded).** The excerpt above is the M4 state; these families
have been added since. Still an excerpt, not the list: `server/src/api/routes/` is authoritative.

```
GET    /api/v1/graph                wikilink graph: nodes, edges, open gaps (12.4)
GET    /api/v1/pages?path=[&full=1] read one wiki page (citation preview or the whole page)
PUT    /api/v1/pages                edit a page: one immediate commit (12.4)
DELETE /api/v1/pages?path=          delete a page: likewise
GET    /api/v1/sources              page → ingested document, read from `.raw/`
GET    /api/v1/sources/raw?path=    the document itself; only an allowlisted format is
                                    served inline, everything else as a download (§9)
GET    /api/v1/domains              domain registry; …/candidates + …/dismiss (12.4 stage 3)
POST   /api/v1/maintenance/…        the maintenance runs: lint, lint-fix, hot-cache, repair,
                                    tag-fix, domain-backfill, domain-review, retrieve-index
GET    /api/v1/maintenance/state    cadence status per area (12.7 stage b)
GET    /api/v1/maintenance/history  persistent run history (schema v12)
DELETE /api/v1/maintenance/history/:id  remove one run from the history (added 2026-09-05)
GET    /api/v1/sessions[/:id]       chat sessions (read-only: no route files one into the vault, 6.3)
GET    /api/v1/settings/telegram    bot status + rejected senders (4.3); PUT/DELETE
                                    write or remove token and allowlist together
POST   /api/v1/jobs/:id/revert      undo one ingest (revert of its commit)
```

---

## 7. Tech stack

| Layer | Choice | Note |
|---|---|---|
| Runtime | Node.js ≥ 20 LTS in WSL2 (Ubuntu 24.04) | |
| Backend | TypeScript, Fastify, better-sqlite3, chokidar, zod | one process, systemd user service |
| Agent | `@anthropic-ai/claude-agent-sdk` (TypeScript) | headless runs, `settingSources: ['project']` **+ `plugins`/`skills`** (load the vault as a local plugin so the skills are available, see 3.1), bundles the Claude Code binary; a separate Claude Code installation for manual use in the vault remains possible |
| Frontend | React + Vite + TypeScript, TanStack Query, SSE | responsive from the start (mobile viewports), built PWA-capable (manifest + installable), no UI framework mandated |
| Vault | claude-obsidian v1.9.2, Generic mode | via `git clone` + `bash bin/setup-vault.sh` in WSL |
| Preprocessing | poppler-utils, ocrmypdf/tesseract (deu+eng), pandoc, defuddle-cli, exiftool | apt/npm/pip in WSL |
| Versioning | git auto-commit by the service | keep the Obsidian Git plugin disabled then (one party responsible for commits) |

### 7.1 Anthropic authentication and usage limits

**Primary path (v1): Claude subscription.** The service authenticates with a long-lived OAuth token, created via `claude setup-token` (Claude Code CLI) and stored as `CLAUDE_CODE_OAUTH_TOKEN` in the systemd service environment. Important: `ANTHROPIC_API_KEY` must not be set then, because it would shadow the token; the service checks this at startup and aborts on a double configuration with a clear error message.

**Consequences of the subscription model:**

1. **Shared limits:** Agent SDK usage currently (as of June/July 2026) counts against the subscription's usage limits, so automatic ingestion competes with interactive Claude and Claude Code use of the same account. A large watch-folder batch can exhaust the quota.
2. **Limit handling instead of a cost limit:** When the SDK reports a reached usage limit, the queue pauses automatically (status "rate-limited" in the dashboard, including the expected release time where available) and resumes work on its own. The daily limit mentioned in section 11 is interpreted as a **job budget per day** (number of ingests) in subscription mode, not as a dollar amount.
3. **Display:** The dashboard shows token usage per job and aggregated (from the SDK usage data); in subscription mode the `cost_usd` column is filled with the computed equivalent at API prices and labelled "estimate (subscription)", useful for evaluating a switch to API-key operation.

**Secondary path: API key.** Switching is pure configuration (set `ANTHROPIC_API_KEY` instead of the token); pay-per-use with real cost per job, and the daily limit then applies as a dollar amount.

**First run without a credential: setup mode (added 2026-07-19).** If *no* credential is configured, the service **no longer** aborts at startup but runs in **setup mode**: dashboard, vault viewer and read-only endpoints are available, but everything that would start an agent run is switched off; the queue claims no jobs, the watch folder is not watched, and upload/query/session-save/maintenance answer `503` with a hint. Reason for deviating from the earlier startup abort: without a running service there is no surface where a first-time user could enter the key; the abort made the first run necessarily a terminal procedure. The startup abort on a **doubly** configured credential stays unchanged.

The credential is accepted via `POST /api/v1/settings/credential` (kind `oauth` | `api-key` plus value) and written into the service env file `~/.config/vault-service/env` (mode 0600, write-then-rename, existing non-credential entries are preserved, the respective other credential is removed). This file *is* the service environment in the sense of section 9: the value reaches neither SQLite nor logs, frontend or API responses, and is never served again after being written. The endpoint validates the token form per kind (prefix `sk-ant-oat…` vs. `sk-ant-api…`), rejects with `409` when the credential comes from the process environment (it would shadow the file there) or while runs are active. Activation happens by restart, because the credential is bound at all call sites at startup: under systemd the service restarts itself for this (`Restart=on-failure`), otherwise the UI asks for a manual restart.

**Policy caveat:** Anthropic's rules for Agent SDK use with subscriptions are in motion (Feb 2026: OAuth prohibited for the SDK; June 2026: a separate monthly SDK allowance announced, whose introduction was paused on June 15; at present SDK usage still counts against the subscription limits according to the official support page). The spec therefore treats auth as a replaceable module; should Anthropic restrict subscription use for the SDK or activate the allowance model, only the environment configuration and possibly the limit display need adjusting. Before M0 implementation starts, the then-current state on support.claude.com is to be verified.

---

## 8. Data model (SQLite)

```sql
jobs(
  id TEXT PRIMARY KEY,            -- ulid
  user_id TEXT DEFAULT 'local',   -- multi-user preparation (section 12.1)
  batch_id TEXT,                  -- shared batches
  source TEXT NOT NULL,           -- 'drop' | 'watch' | 'url' | 'telegram' (4.3)
  type TEXT NOT NULL,             -- 'pdf' | 'office' | 'web' | 'image' | 'text' | 'av' | 'other'
  original_name TEXT, url TEXT,
  sha256 TEXT,                    -- dedupe; NOT unique since migration v30 (12.9)
  status TEXT NOT NULL,           -- queued|preprocessing|ingesting|done|failed|deferred|duplicate|cancelled
  raw_path TEXT,                  -- .raw/<job-id>/
  created_pages TEXT,             -- JSON list of created/updated wiki pages
  notify_channel TEXT,            -- e.g. 'telegram:<chat_id>': completion message to the intake channel (4.3; migration v7)
  commit_hash TEXT,               -- the commit of this ingest, the basis of the revert (§9; migration v9)
  reverted_at TEXT,               -- set when the ingest was reverted; the status stays unchanged (§9; migration v9)
  duplicate_of TEXT,              -- for status='duplicate' the job this one duplicates (migration v11); also a job whose
                                  -- row is gone, when the vault still knows it under .raw/<job-id>/ (12.9)
  outcome TEXT,                   -- 'no-changes' when a done run wrote no wiki page; otherwise NULL (12.9; migration v14)
  error TEXT, attempts INTEGER DEFAULT 0,   -- for duplicates, error carries the explanation, not only for failures
  tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
  created_at TEXT, started_at TEXT, finished_at TEXT
);
job_logs(id INTEGER PRIMARY KEY, job_id, ts, level, message);  -- agent stream + pipeline events
sessions(id, user_id DEFAULT 'local', title, created_at,   -- query chat
  sdk_session_id,                 -- SDK session of the last query run, so a follow-up question can resume it (§5; migration v2)
  updated_at);                    -- sort key of the session list, moves with every new message (migration v2)
messages(id INTEGER PRIMARY KEY, session_id, role, content, citations, ts,
  tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL);   -- cost per answer; NULL on user/system rows (migration v6)
settings(key PRIMARY KEY, value);
users(id PRIMARY KEY, name, token_hash, role, created_at); -- in v1 only the seed entry 'local'
telegram_drops(user_id, sender_id, username, first_at, last_at, count); -- rejected bot senders, aggregated (4.3/§9; migration v8)
agent_runs(                       -- one row per settled agent run (migration v12)
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'local',
  kind TEXT NOT NULL,             -- 'research' | 'lint' | 'hot-cache' | 'tag-fix' | 'domain-backfill' | 'retrieve-index' | …
  label TEXT,                     -- topic of a research run; NULL where the kind already says everything
  profile_key TEXT,               -- lens under which a research run ran (12.7)
  ok INTEGER NOT NULL,
  pages TEXT,                     -- JSON list of the wiki pages written
  tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
  error TEXT,
  commit_hash TEXT,               -- the commit of this run; NULL = nothing committed (migration v13)
  started_at TEXT, finished_at TEXT
);
maintenance_state(user_id, kind, run_id, ok, pages INTEGER, error, finished_at); -- one row per run kind, "last done" (12.7; migration v10)
domain_dismissals(user_id, key, dismissed_at);     -- dismissed domain candidates, PK (user_id, key) (12.4; migration v5)
```

The vault itself remains the only truth for knowledge; SQLite holds operational state only. Losing the DB must not damage the vault (the statistics can be rebuilt from file system + git).

`agent_runs` and `maintenance_state` answer different questions and therefore exist side by side: one is the history (one row per run, `pages` as a JSON list), the other the state per area (one row per kind, upserted on settle, `pages` only as a count). With `commit_hash` (added 2026-08-27, migration v13) **every** vault-writing operation knows its commit, ingest job and agent run alike; before, the dashboard had to guess the assignment from timestamps and therefore showed settled agent runs as "nothing committed". NULL remains the right answer where a run committed nothing: a failure before the commit step, `retrieve-index` (writes only derived artifacts outside the vault history, 12.6), and rows from before v13.

---

## 9. Security

- In v1 the server binds exclusively to `127.0.0.1`; the auth middleware runs in "local-single-user" mode (everything allowed). The guard is anchored in code: bind ≠ localhost means startup abort as long as no auth mode with a token/password is active. Remote access (sections 12.2/12.3) is thereby a configuration step with enforced auth, not an unprotected accident.
- Agent runs: write access only below the vault path and no web egress in an ingest run, both enforced by the SDK sandbox (bubblewrap) rather than by tool policy; a `PreToolUse` hook carries tool-level policy, and its bash denylist is defense in depth, not a script whitelist (see section 4). Web egress only in the autoresearch flow, there with the repo's hygiene rules (URL validation, sanitization, 50 KB fetch cap). Verified by `permprobe`, which expects `canary outside vault: blocked`.
- Incoming files are never executed; magic-byte check against disguised executables; archives not auto-extracted.
- Credentials (OAuth token or API key) only in the service environment, never in the frontend, never in logs, never in the repo. The env file `~/.config/vault-service/env` (0600) counts as that environment; the credential endpoint of section 7.1 may write it, but it is never read back and returned. Without a configured credential the service runs in setup mode (also 7.1) instead of terminating.
- **Protection against drive-by access from the browser (added 2026-07-19):** State-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`) with a foreign `Origin` header are rejected with `403`. The "local-single-user" mode knows no credential, and a multipart upload is a CORS "simple request" without preflight; without this check any visited web page could trigger uploads, and with them paid agent runs, against `127.0.0.1`. Loopback origins (any port, for the Vite dev proxy) and requests without `Origin` (curl, systemd probe) pass.
- **Telegram bot (added 2026-07-20, section 4.3):** The bot token is a secret of the same class as the Anthropic credential: only in the service env file, never in logs, frontend, SQLite or API responses; redacted in configuration output. Authorization exclusively via the user-id allowlist, fail-closed: a token without an allowlist aborts startup; messages from unlisted senders are dropped without any reply (a reply would confirm the bot's existence; bot usernames are enumerable, and every accepted command can trigger a paid agent run, the same threat class as the origin check above). The event still stays visible to the operator (added 2026-07-20, user decision): the **first** attempt per sender id is written to the service log as a warning, id and username if any, never the message content; further attempts from the same id are not logged (flood protection for the journal). In addition the table `telegram_drops` (§8, migration v8) counts **every** attempt aggregated per sender; the settings card shows this list ("Rejected senders", also the way to spot one's own mistyped id), served via `GET /api/v1/settings/telegram`, again without contents and without the token. The outgoing HTTPS traffic to `api.telegram.org` is **service egress, not agent egress**; the rule "no web egress in ingest runs" concerns agent runs and applies unchanged. Files from Telegram pass through the same pipeline as all intake (basename reduction, magic-byte check, no execution, no auto-extraction). Completion messages name page titles only, never content excerpts; vault content should not sit in the Telegram cloud (the sent file itself is there anyway; that is the user's deliberate decision when sending).
- **File names from uploads are reduced to the bare basename** before they are stored under `.raw/<job-id>/`; a name containing `../` from the multipart header could otherwise write *outside* `VAULT_ROOT`, past the sandbox, which wraps only agent runs, not the HTTP path.
- Git history as the undo mechanism: every ingest is a commit, faulty runs can be recovered via `git revert`. **Implemented 2026-07-23** as the "Revert" action in the history (`POST /api/v1/jobs/:id/revert`): the job remembers its commit (migration v9, `jobs.commit_hash`), the revert runs behind the same commit mutex as ingest and maintenance commits and is **all or nothing**: it refuses on a dirty working tree (a run could still be writing) and aborts cleanly on conflicts instead of leaving conflict markers in wiki pages. The undo is itself a commit, so it stays versioned and reversible; the job status does not change (the state set of section 8 stays closed), instead `jobs.reverted_at` records the event. Batch members share one commit, so a revert undoes the whole batch, which the UI points out beforehand.

---

## 10. Milestones

| # | Milestone | Content | Acceptance criterion |
|---|---|---|---|
| M0 | Foundation | WSL2 setup, vault cloned + `setup-vault.sh`, Obsidian opens the vault, Agent SDK runs a manually triggered `ingest` successfully | One PDF is filed correctly via a CLI call of the service (pages + index + hot cache) |
| M1 | Pipeline | Queue, preprocessing (PDF, Office, text, image, URL), agent runner with retry/timeout, dedupe, git commits | 10 mixed files in `.raw` all reach `done`, no vault corruption at concurrency 2 |
| M2 | Intake channels | Watch folder (stability check, batching), upload endpoint | Files dropped into the Windows inbox folder appear in the vault without interaction |
| M3 | Dashboard core | Tabs Overview + Ingestion, SSE live updates, dropzone | Drop in the browser → live log → result links work in Obsidian |
| M4 | Query + maintenance | Chat tab with citations and sessions; lint, autoresearch and hot-cache controls | A question yields cited, clickable vault pages; the lint report is structured |
| M5 | Hardening | systemd autostart, error paths, cost display, settings UI, docs | The service survives a WSL restart; failed jobs are diagnosable and retryable |

**The A-series sits on top of a finished M5 (added 2026-09-15).** M0 to M5 describe the base product and are complete. The research agents were built afterwards as their own milestone series, A0 to A7, in a private fork, behind `AGENTS_ENABLED` and with their own specification (`docs/agents/SPEC.md`, summarised in 12.10); the source-integrity work of 12.11 was built alongside them and is not behind a flag. Their task files live in `docs/tasks/` beside M0 to M5 and are kept as the dated record of what was decided and why, including the items still open. Reading order for someone new: this file, then 12.10 and 12.11, then the detail spec of whichever subsystem is in question.

---

## 11. Risks and open points

1. **Obsidian via `\\wsl$`: RESOLVED in M0 (the finding corrects the original assumption).** 9p *sluggishness* was expected; in fact **Obsidian for Windows does not open the WSL vault at all** (`EISDIR … watch`, won't-fix). Chosen solution: **Obsidian in WSLg** (Linux app in WSL, vault stays on ext4). Remaining limitation: the graph view stutters (WSLg software rendering), typing and opening are fluid; not a file-system problem, verified with a 249-note test. The drvfs fallback worry about `wiki-lock.sh` is settled: locking passes all tests there.
2. **Skill determinism under full automation:** The ingest skill is designed for interactive use and may ask questions. Mitigation: system-prompt extension "no questions, document defaults"; validate against real sources in M1 and, if needed, add a thin auto-ingest wrapper skill to the vault repo.
3. **Usage limits/cost:** In subscription mode the automation competes with interactive use for the same limits; in API-key mode real cost arises. Mitigation: rate-limit pause with auto-resume (7.1), token usage visible per job, configurable daily budget (jobs/day in subscription mode, USD in API mode; the queue pauses when exceeded).
4. **Repo evolution:** claude-obsidian evolves quickly (v1.7 to v1.9 within months). Mitigation: vault as a fork pinned to a tested version; upgrades deliberately.
5. **Concurrent manual use:** The user works with Claude Code in the vault while the pipeline runs. The repo's advisory locking addresses this; still test explicitly in M1.
6. **Open:** Several watch folders with different target domains? Daily limit size? Model choice per job type (a small model for simple texts, a large one for complex papers)? Decide after the first operating experience (M5).

---

## 12. Mid-term extensions: multi-user, sync, mobile

These three requirements are architecturally connected and are therefore thought through together. The guiding decision: **server-centric instead of file sync.** The service on the main machine remains the only writer of the vault; other users and devices reach the same server through the HTTP API instead of synchronizing vault copies. Rationale: claude-obsidian's advisory locking (`wiki-lock.sh`) works only within one machine; if several devices each wrote a vault copy via file sync (Syncthing, Obsidian Sync) *and* ran their own ingestion pipelines there, merge conflicts in index, log and hot cache would be unavoidable. A central server with a queue serializes all writes by nature; the v1 architecture (API-first, queue as single writer) is already the right shape for that.

### 12.1 Multi-user

**v1 provisions (already in place):** auth middleware in front of all endpoints ("local-single-user" mode), `user_id` columns in `jobs` and `sessions` (default `'local'`), `users` table with a seed entry, versioned API.

**Build-out stage:** activation of the auth mode (token/password per user, Argon2 hash in `users.token_hash`), login screen in the frontend, roles `admin` (settings, maintenance, all jobs) and `member` (own jobs, query, ingestion). Chat sessions are private per user; the vault itself stays **shared** in the first multi-user stage (one common second brain, which is the point of a shared vault). Should separate knowledge spaces become necessary later, the extension "several vaults per server" (vault registry table, `vault_id` on jobs/sessions) is the clean way; v1 therefore avoids hard-coded single-vault assumptions in the path logic (vault root as a configuration value, passed through everywhere instead of a global constant).

**One assumption that IS hard-coded, and that this work inherits (measured 2026-09-19).** The
vault root is a configuration value, but the BUCKET STRUCTURE under it is not. claude-obsidian
has four methodology modes and `scripts/wiki-mode.py route` returns a materially different path
for each: a concept is `wiki/concepts/X.md` under Generic, `wiki/notes/X.md` under LYT,
`wiki/resources/concepts/X.md` under PARA, and `wiki/<timestamp>-X.md` under **Zettelkasten,
which has no buckets at all**.

The cost is not in the write path, which is where it looks like it should be. The service
barely writes content paths; it **classifies** them, by prefix, in about twenty places:
`startsWith('wiki/questions/')` is how `candidates.ts`, `recap.ts`, `related-pages.ts` and
`research-profiles.ts` recognise a synthesis page, `startsWith('wiki/sources/')` is how
`reading-list.ts` finds a source page, and `hubs.ts` decides what counts as a content page by
its bucket before it reads `type:` from frontmatter. Under Zettelkasten every one of those
prefixes matches nothing, silently: no error, just a service that finds no synthesis pages and
an index that lists nothing.

**So the constraint for a second vault is: it must be in Generic mode, or the classification has
to move to frontmatter `type:` first.** Routing writes through `wiki-mode.py` would not help -
it fixes the half that is not broken. The registry work should treat "classify by `type:`, never
by path" as part of its own scope, and `hubs.ts` shows the shape: it already reads `type:` and
only needs to stop gating on the bucket first.

### 12.2 Access across devices ("sync")

**Model:** No vault sync between devices, but remote access to the one server. The simplest secure way is an overlay network (Tailscale/WireGuard): the service is additionally bound to the tailnet address (with auth then enforced, see the guard in section 9) and reachable from all of one's own devices without opening a port to the internet. Alternative for public access: a reverse proxy (Caddy) with TLS + auth.

**Read access to the notes themselves** (Obsidian on a second device) remains possible via git; the service commits every ingest anyway. A `git remote` (private repo or self-hosted via Gitea) plus a pull on the second device yields a read-only or carefully-writing copy. Rule the spec fixes: **automated writers exist only on the server.** Manual edits from second devices go through git push and are pulled by the server before the next ingest (a pipeline step "pull before ingest" is added in this build-out stage; a conflict pauses the queue and reports in the dashboard).

**Prerequisite:** The main machine has to be reachable when other devices access it. Mid-term, moving the service from WSL2 to a small always-on host (home server, NUC, VPS) is therefore the natural step; the stack's container capability (pure Linux userland, no Windows dependencies in the service itself) is the v1 provision for that: a Dockerfile belongs to the repo from M5 on, even if it is not needed under WSL2.

### 12.3 Mobile use

**v1 provisions (already in place):** frontend responsive for narrow viewports, PWA manifest (installable on the home screen), SSE instead of WebSockets (more robust across proxies and mobile networks).

**Build-out stage:** Once the server is reachable via the tailnet (12.2), the dashboard works on the smartphone without further code. Mobile-specific additions after that: a share target in the PWA manifest so "Share → Vault" creates a URL or file job from any app (the mobile counterpart of the watch folder); camera upload in the dropzone (photo of a document → image ingest); optionally push notifications for failed jobs (Web Push). A native app is not planned; the PWA covers the requirements.

**Partial coverage by the Telegram bot (2026-07-20):** The bot added in section 4.3 already covers the mobile ingest and status use case without a tailnet, including the completion message as a substitute for Web Push, on every platform (iOS does not support the web share target). The build-out stage above remains the more private path (content does not leave one's own devices) and the only one with full dashboard access (chat, graph, maintenance); the two complement each other. For 12.2 the preferred variant has since been `tailscale serve` (TLS termination at the MagicDNS name, proxy to `127.0.0.1:8420`): the service stays loopback-bound, the guard from section 9 is not touched at all, HTTPS for PWA installation and share target comes for free, and the frontend needs no token handling (access control = tailnet membership; the token mode remains as a hardening option).

### 12.4 In-dashboard vault viewer (pages + graph)

**Motivation (from M3 operation):** The vault is the source of truth (Obsidian-flavored Markdown + wikilinks + git, the "backend format"); Obsidian-the-**app** is only *one* viewer and deliberately optional. Two points of friction point in the same direction: (a) the Windows Obsidian does not open the WSL vault via `\\wsl$` at all (`EISDIR … watch`, sections 3/11), and (b) the graph view of the WSLg Linux Obsidian stutters for lack of a GPU. A **read-only vault viewer in the dashboard** avoids both and makes the Obsidian app dispensable for everyday use; the vault remains the storage format, unchanged.

**Build-out stage:** An additional area (or an extension of the overview) that renders the wiki pages directly: Markdown with resolved `[[wikilinks]]` as clickable in-app navigation, a backlinks panel, and a **graph view** from the wikilink graph (the links are fully parseable; a new read-only endpoint `GET /api/v1/graph` delivers nodes/edges, `GET /api/v1/page/*` the rendered page content). Stays strictly read-only; write access to the vault continues to exist only through agent runs (hard rule 1). obsidian:// deep links and the copy-path fallback remain as a bridge as long as Obsidian is used in parallel.

**Status: IMPLEMENTED (2026-07-18, after M5).** Realized as a fifth tab "Vault" with two
deep-linkable routes (`/vault` = graph, `/vault/page/<path>` = page), strictly read-only:

- **Server:** `GET /api/v1/graph` (nodes per wiki page, typed by wiki directory; directed edges
  as index pairs; a counter for unresolved links) and `GET /api/v1/pages?path=…&full=1` (full
  text + title/type/mtime). The graph builder caches parses per file keyed on (mtime, size) and
  returns the same object for an unchanged vault; measured on a real vault: 111 pages / 802
  edges, 35 ms cold, 2 ms cached, 19 KB JSON.
- **Frontend:** Canvas-2D rendering (no DOM node per page), a d3-force simulation in a Web
  Worker that cools down and stops; label level-of-detail by zoom and node degree, viewport
  culling, pan/zoom/touch, neighbourhood highlighting. Search, type filters and a local graph
  mode (BFS depth 1/2 around a focused page) keep the view manageable even for a large vault.
  **Zoom mechanic "anchor and leash" (added 2026-09-05, `web/src/lib/graphZoom.ts`, tested):**
  When zooming in, the wheel aims at the center of mass of the community within reach (160 px,
  or inside its hull) instead of at the pointer, as long as that community fills less than
  about 35 % of the shorter picture side; beyond that the zoom obeys the pointer again. After
  every zoom and drag a leash keeps the graph's box and the picture overlapping by at least
  60 % per axis, so the picture can never be empty. Wheel deltas are normalized to pixels and
  capped at 120 px per event (1.10x per 100 px instead of 1.16x), and the step animates
  briefly (immediately under `prefers-reduced-motion`). Top right a minimap (visible only while
  the graph is not fully in view; a click moves the picture), and when no node is in view, a
  centered button "Go to nearest cluster". Before, the zoom only held the point under the
  pointer fixed: zooming in beside a cluster, the picture was empty after five notches. Page
  view with backlinks/outgoing panel, frontmatter as a properties panel and clickable
  `[[wikilinks]]` (same resolution rule as on the server).
- **Scaling** is a deliberate design criterion: the vault keeps growing, and the stuttering
  Obsidian graph view (sections 3/11) is exactly what must not be reproduced here. The Vault
  tab is code-split as its own chunk.

The `obsidian://` deep link remains as a bridge but has been the **secondary action** since
2026-07-18: all page links in the dashboard (overview, ingestion history, chat citations,
maintenance) primarily open the in-app viewer, which makes the dashboard fully usable from a
**Windows browser** (Windows Obsidian cannot open the WSL vault via `\\wsl$`, sections 3/11).

**Edit/delete (extension 2026-07-18, user decision):** The viewer is no longer purely read-only.
`PUT /api/v1/pages` (edit, with optimistic locking via `baseMtime`, 409 on an intervening
change) and `DELETE /api/v1/pages` (delete with a two-step confirm).

**Archive a question (extension 2026-09-17, user decision):** `POST /api/v1/questions/archive`
strikes one bullet of a page's `## Open questions` section through (`~~…~~`) or takes the strike
off. It is a user-initiated page edit of the same kind as the two above - one commit behind the
shared mutex, under the vault's per-file lock, confined to the bullet's own lines - and the
strike is the convention the vault's own runs use to close a question, so the Fellows' planner
skips it without any state beside the page. Offered by the Library's pinboard, so it exists only
with `AGENTS_ENABLED` (`docs/agents/SPEC.md` 10.13).

**Two locks, because one page has two kinds of writer (corrected 2026-09-16).** `baseMtime` is
the OPTIONAL optimistic lock and answers "has this page moved since you loaded it": the client
sends the mtime it read, the server compares and refuses with 409. It is optional by contract -
a request without it is accepted and logged as an overwrite nobody checked - and the client
takes it together with the draft, never re-reads it, because a reference point that follows the
thing it locks against is not a lock. Beside it the service now takes the VAULT's own per-file
lock, `scripts/wiki-lock.sh`, which claude-obsidian makes mandatory for every wiki page write
from v1.7 on and which our agent runs already obeyed through its skills. It answers the other
question - "is somebody writing this page right now" - which no timestamp can, because an
agent's write lands between the stat and the write without having moved anything that was
looked at. A held lock answers 409 with `busy: true`. The vault's lock is always taken OUTSIDE
the service's own commit mutex, and a vault that does not carry the script (below v1.7) is
written unlocked rather than refused. Hard rule 1 stays intact
in spirit and was made precise: **every dashboard mutation is exactly one git commit**
(`edit: <page>` / `delete: <page>`), executed behind the same commit mutex as ingest and
maintenance commits and strictly path-limited (no `git add -A` fallback), so half-finished
pages of a concurrently running agent run never end up in a user commit. New pages still come
only from ingestion/agent runs; the dashboard edits and deletes existing ones. After a
deletion the dashboard shows a banner with the number of backlinks orphaned by it and leads
the user to the lint run (the vault's own cleanup mechanism for dangling references).

**Live graph (extension 2026-07-19, user decision):** The graph updates live while an ingest
runs; one sees new pages and connections appear, as in the Obsidian graph view before. On the
server a second chokidar watcher observes `VAULT_ROOT/wiki` (pure notification, reads and
writes no page content; hard rule 1 untouched) and publishes, debounced (1 s), a payload-less
SSE event `vault`, on which the frontend refetches the graph. So that this does not endanger
the fluid rendering: node positions are keyed by path rather than index (the node list is
sorted by path; a single newcomer shifts all following indices), the layout worker is
long-lived and interruptible (generation protocol, timer instead of a blocking loop) and is
reheated at low alpha on small diffs instead of restarted; only above 20 % new nodes is the
layout redone cold. New pages appear at the center of mass of their already placed neighbours
and flash briefly; the camera never moves on live updates (auto-fit only on the very first
layout). Side effect: filter and focus changes now also keep the positions instead of
re-rolling the simulation.

**Meta categories, stage 1 (2026-07-19, user decision):** The graph now knows the thematic axis
in addition to the structural one: the graph builder parses the frontmatter in the same read
pass (`tags:` as a block or inline list, `domain:`) and puts both on every node. The Vault tab
gets a second filter row by domain; pages without `domain:` deliberately form a visible "no
domain" bucket (the evidence for the planned backfill, not a blind spot), a toggle "colour by
domain" (deterministic hash colours per domain name; the filter chips carry the same colour dot
and are thereby the legend), and the search matches titles **and** tags.

**Meta categories, stage 2 (2026-07-19, user decision):** The domains are now a closed, guarded
list instead of a freely writable field.

- **Registry as a vault page** (`wiki/meta/domains.md`): lists the allowed domains with
  description and tag hints. It deliberately lives in the vault and not in the DB:
  git-versioned together with the content it describes, maintainable in the dashboard page
  editor, and readable by agent runs without extra wiring. The seed lives in the repo
  (`scripts/vault-extensions/domains.md`, installed by `scripts/install-domain-registry.sh`,
  non-destructive); from installation on, the vault's copy is the source of truth and the
  service only reads it (hard rule 1). Initial cut: a small starter set of domains as defined
  in the seed page, plus the sentinel `unassigned`.
- **Agent instruction:** Every writing run (ingest, backfill, lint, autoresearch) receives the
  registry through the system-prompt extension (`RunAgentOptions.systemPromptExtra`, the
  extension path sanctioned by hard rule 5) as a closed list: set exactly one key from it,
  otherwise `unassigned`; **never invent a new key**. New domains come into being exclusively by
  a human editing the registry page. The list is read fresh per run, so a registry change takes
  effect without a restart. Without an installed registry the extension is empty and everything
  behaves as before.
- **Backfill** as a maintenance action (`POST /api/v1/maintenance/domain-backfill`, kind
  `domain-backfill`): an agent run that re-sorts existing pages; values that predate the
  registry (finer-grained topic slugs from before the closed list) are moved to the valid
  domain. Explicitly only the frontmatter field; page contents, other fields and the registry
  itself stay untouched, and no new pages arise. Without a registry the route answers `409`
  instead of letting the agent improvise. Cheap side note: the vault's semantic-tiling cache
  hashes page **bodies**, so a pure frontmatter backfill does not invalidate it.
- **Visibility:** `GET /api/v1/domains` reports whether a registry is installed and what it
  contains; the maintenance card shows the domains and the number of pages without a domain,
  exactly the number that tells whether a backfill is due.

**Meta categories, stage 3 (2026-07-19, user decision):** The governance loop that **proposes**
new domains from evidence; the decision remains the user's.

- **Candidate finding, deterministic and free** (`pipeline/domain-candidates.ts`): tag-centred
  instead of generic community detection, because the result has to become a registry row and
  that consists of `key + description + tags`; a tag on N `unassigned` pages *is* the proposal,
  and "five unassigned pages share a tag no domain covers" can be checked at a glance. Threshold
  ≥ 5 pages. Tags already claimed by an existing domain drop out (that is a misfiling for the
  backfill, not a missing field); so do structural tags (`person`, `organization`, …), which say
  what a page *is* rather than what it is about. Tags with strongly overlapping page sets are
  merged. The wikilink graph supplies a **cohesion measure** (do the pages also link among
  themselves?) but is explicitly not the clustering engine. Only explicit `unassigned` is
  counted; pages with no `domain:` field at all are reported separately, because they mean
  "never classified" rather than "nothing fits" and would dilute the analysis.
- **Agent assessment, optional and switchable** (`domain-review`): a toggle in the UI decides
  whether an agent run additionally judges the candidates: `new-domain` (with a name proposal),
  `existing` (belongs to an existing domain) or `not-a-domain`. The run is **read-only**: it
  gives an opinion and touches no file, since new keys come from humans by definition. Its
  result is the answer itself, parsed (`pipeline/domain-review.ts`), deliberately without a
  report file in the vault, because a proposal is transient and would otherwise leave junk
  behind on every "no". Candidates are recomputed on the server so a stale browser tab cannot
  trigger a run on topics that have disappeared.
- **Deciding:** `POST /api/v1/domains` creates a domain by appending a section to the registry
  page, as **one** git commit (`domains: add <key>`) behind the same commit mutex and with an
  exact pathspec like a user page edit. Read-modify-write sits inside the mutex so two parallel
  creations cannot overwrite each other. A dismissed candidate is remembered in SQLite
  (`domain_dismissals`, migration v5); without this memory the loop would propose the same
  topic endlessly. Dismissals can be restored individually.
- **Self-healing:** After creation a candidate disappears anyway because its tags now belong to
  a domain; the dismissal is only the additional safeguard for the time until the next backfill.

**Resolving gaps instead of filling them (added 2026-09-05).** The Gaps view of the Home panel
("Worth a run") used to offer only one way out of a gap: research. Many gaps never deserve a
page (single mentions, image captions, callout titles an ingest linked by reflex). Every card
therefore carries a pick control; the selection (max. 20) starts, with a two-step confirm,
**one** maintenance run of kind `cleanup` in mode `gap` (`POST /api/v1/maintenance/cleanup`
with `mode: 'gap'`): the agent turns every wikilink to these titles into running text, removes
pure reference entries from index/overview pages, creates no page and deletes none, and leaves
`log.md`, `hot.md` and `.raw/.manifest.json` untouched; one commit, revertable from the
activity stream. On the server every title has to be an open gap of the **live graph**; one
unknown title rejects the whole request (the same principle as the repair run). Deliberately no
deterministic regex unlinking from pipeline code (hard rule 1), and deliberately no memory of
resolved titles: the notability rules in the system prompt are meant to prevent recurrences;
if a gap comes back anyway, that is a finding about the ingest. For this to work, `wiki/log.md`
(the ingest skill's append-only journal) and `wiki/hot.md` (a cache) nominate **no** gaps: a link
there is a record or a cache, not a claim that a page is missing. Before, six of seven unlinked
titles stayed in the list because the journal kept naming them, and the same held for every
page the user had deleted. Those links still count as `unresolved`, just not as gaps.

### 12.5 Order

Recommended build-out path after v1 stabilization: (1) tailnet access + auth activation (smallest step, immediate mobile benefit), (2) PWA share target, (3) multi-user roles, (4) move to an always-on host via Docker, (5) git-remote workflow for second-device edits. ~~(6) in-dashboard vault viewer~~: **pulled forward and implemented on 2026-07-18** (12.4); the Obsidian app is thereby optional in everyday use.

### 12.6 Hybrid retrieval at chunk level (added 2026-07-23)

**Motivation:** The query path so far reads at page granularity (`hot.md` → `index.md` → 3-5 whole pages) and loses whenever the answer sits in a single passage of an inconspicuously titled page. Since v1.7 the vault ships the opt-in skill `wiki-retrieve` (chunking + context prefix + BM25 + cosine rerank following Anthropic's contextual-retrieval method), including feature detection in `wiki-query` and `autoresearch`: as soon as the index exists, the skills use it on their own and fall back cleanly to the old path when it does not. The service takes over provisioning and freshness of the index; nothing changes in the chat UI.

**Build-out in three stages, each accepted individually (task list: `docs/tasks/TASKS-RETRIEVE.md`):**

1. **BM25 only (no new dependencies):** synthetic chunk prefixes (`contextual-prefix.py` without `--allow-egress`), BM25 index, queries with `--no-rerank`. At query time there are only reads; the read-only sandbox profile stays unchanged.
2. **Rerank (local), built but OFF by default (as of 2026-07-23):** cosine rerank via ollama (`nomic-embed-text`, `127.0.0.1:11434`). **Correction of the original plan:** A localhost network exception and a write exception in the query profile's sandbox were foreseen. Both were **not** built and shall not be built. Instead the retrieval runs **in the service process** (`retrieveCandidates`) before the agent starts; the agent only receives the ranked pages along with the question. The read-only profile thus stays strictly unchanged, which matters especially because the local ollama API is unauthenticated and can pull models from the internet via `/api/pull`; a loopback hole would have created an indirect egress channel. Side effect: retrieval becomes deterministic instead of depending on whether the model calls it on its own. **The rerank itself is disabled by default**, because a measurement over 35 labelled cases showed no benefit (BM25 alone 97 % top-5 versus 94 % with rerank; top-1 69 % versus 54 %); details in `docs/tasks/TASKS-RETRIEVE.md` F-R13. **ollama is therefore not a prerequisite of the service**, only needed for repeat comparison measurements; it deliberately appears in no setup script and no requirements list.
3. **Real context prefixes (egress, opt-in): NOT PLANNED (as of 2026-07-23).** Originally foreseen was prefix generation through the service credential behind a default-off setting. The stage 2 measurement settled it: at 97 % top-5 with BM25 alone, the entire remaining headroom is about one case in 35, too little for running cost and for the only egress path in the whole retrieval design. Should the vault grow considerably and a repeat measurement show a falling hit rate, this is decided anew.

**Index build as a deterministic pipeline step (a refinement of hard rule 1):** The vault's index scripts write exclusively derived, always re-creatable artifacts under `.vault-meta/` (`chunks/`, `bm25/`, `embed-cache.json`). Pipeline code may execute these writes directly (a child process of the vault's own scripts, no LLM); an agent run for a mechanical index rebuild would be waste. Wiki content stays reserved for agent runs, unchanged. The artifacts are **not** versioned: they are excluded via the vault clone's `.git/info/exclude` (repo-local, no change to tracked files of the cloned repo, hard rule 5). The exclusion is at the same time the precondition for the `BOOKKEEPING_PATHS` staging rule (`.vault-meta` rides along with every commit) not to flush the artifacts into ingest commits.

**Freshness:** The index does not update itself. A maintenance run of kind `retrieve-index` (deterministic, no agent, no credential needed, hence allowed in setup mode too) runs debounced after completed ingests (one rebuild per quiet window, default 5 min) and can be triggered manually via `POST /api/v1/maintenance/retrieve-index`; `GET` on the same path delivers provisioning status, chunk count and index age for the maintenance card.

### 12.7 Maintenance as a guided workflow ("vault check", added 2026-07-24)

**Motivation (deep-review finding):** Through the stages 12.4/12.6 the Maintenance tab had grown into a collection of equally ranked cards. The dependency chain between the actions exists in code but was only visible scattered (a disabled button here, a hint text there), and the cards showed findings instead of recommendations. Two symptoms stood at the start: (1) When creating a proposed domain without an agent review, only the key was prefilled, the description empty and the proposed tag identical to the key; the user had to do the most demanding task (an extensibly phrased description) alone. (2) The tag report demanded a judgement per row whose basis (the heuristic thresholds) was invisible, and two thirds of its area were non-actionable observations in the same layout as the repairable findings.

**Target picture: three layers over the same backend actions:**

1. **Status layer ("what is due"):** A deterministic, free check (graph, `undomainedCount`, candidate list, tag report, age of lint report/hot cache/index) produces a prioritized list of items. Each item carries three fields, *what* (one sentence), *why now* (one sentence with the concrete number), *cost* (agent run vs. deterministic), and one of three urgencies with tab-wide colour semantics: **due** (blocks something else or lowers quality), **recommended**, **info/healthy**. "All healthy" is an explicit state, not an empty screen.
2. **Guided run:** A button works through the due items as a sequence. Two step types: **automatic steps** (backfill, lint, lint-fix, hot cache, index) run one after another without questions (a queue in front of the existing `runMutex`; every step remains its own revertable commit); **decision steps** stop with exactly one question per screen and finished recommendations (domain creation with key + description draft + tags; tag repairs preselected). The user curates (accept / edit / skip) instead of configuring; skipped items come back on the next run. Order = dependency chain: backfill → domain decisions (including a read-only review over all open candidates as a fixed part) → follow-up backfill for new domains (closes the previously silent gap that `POST /domains` writes only the registry) → tag repairs → lint + safe fixes → hot cache. The retrieval index stays out (it updates itself, debounced, 12.6). At the end a summary: steps run, commits created (individually revertable), open manual items.
3. **Expert view:** The existing cards remain as a second view (every action individually, same endpoints), unified to one heading scale, one empty-state style, one result area and the severity chips of the status layer.

**Design principles:** Recommendations are preselected where the direction is unambiguous (deselect instead of tick); every recommendation carries a plain-language rationale instead of invisible thresholds; non-actionable findings (implied tags, single-use tags) are collapsed as "observations" and leave the decision path; cross-references are wired instead of described (an `unassigned` echo in the tag report *is* a domain candidate and appears there, not as a tag problem).

**Persistence (stage b):** A SQLite table `maintenance_state` (migration v10; one row per run kind, upserted on settle: ok/pages/error/finished_at; purely operational, hard rule 1 untouched) makes "last done" and the "N items due" badge in the overview tab restart-proof; the runner's own run history deliberately stays a bounded in-memory map. `GET /api/v1/maintenance/state` delivers the state; areas with vault facts (lint report file, hot.md mtime, index artifacts) keep those as the primary source, the table fills the gaps (tag-fix, backfill) and records failures. The optional weekly lint from 6.4 is absorbed here: a scheduler only runs the check (and optionally the lint) and puts items on the list, never decision steps unasked.

**Staged plan (each stage shippable on its own):**

- **Stage (a), quick wins in the existing cards, implemented 2026-07-24:** tag report with preselected conflict-free repairs and a plain-language rationale per row; implied + single-use tags demoted to collapsed "observations"; agent review of domain candidates active by default; deterministic description draft so the description field never starts empty (the agent's proposal wins when present); explicit backfill prompt in the card after domain creation.
- **Stage (b), status model, implemented 2026-07-25:** deterministic derivation (`web/src/lib/maintenanceStatus.ts`, a pure function over data the dashboard loads anyway: graph/tag report, candidates, report/cache/index age; thresholds: lint 14 days, hot cache 7 days) → a "What's due" head above the cards with severity chips (due/soon/healthy), what/why-now/cost per item and a jump to the respective card; healthy areas collapsed, "all healthy" as an explicit state. The expert cards have since really been the SECOND view: collapsed by default behind an "Expert tools" toggle (a click on a status item opens them and jumps to the card; setup mode opens them automatically because the credential entry lives in Settings), and the page lists of the domain candidates are folded behind "Show N pages". `maintenance_state` (see above) supplies the restart-proof "last run" facts for areas without a vault file; a badge in the overview status strip ("Maintenance: N due") links into the tab and stays silent when nothing is due.
- **Stage (c), guided run, implemented 2026-07-25:** "Start maintenance run" in the status head (visible as soon as something is due). The plan is built deterministically from the status model (`buildRunPlan`: only due/recommended steps, in dependency order; never the index, which updates itself). The sequencing is **client-driven** over the existing endpoints instead of a server queue; the `runMutex` serializes the vault writers anyway, every step remains its own revertable commit, and a closed tab costs only the wizard position, never work. Automatic steps (backfill, follow-up backfill, lint chained to safe fixes, hot cache) start themselves, stream their log and advance on settle (on error: retry/skip); decision steps embed THE SAME components the expert cards use (one implementation per decision surface): domain decisions with an automatically started read-only review, tag repairs with preselection. The follow-up backfill skips itself when nothing was created. At the end a summary (done/skipped/failed per step). **Still open:** the optional check cadence (a scheduler that periodically runs only the check and puts items on the list). `contextual-prefix.py --all` works incrementally (changed pages only); the BM25 rebuild is pure Python and cheap.

### 12.8 Demo mode (added 2026-09-01)

An operating mode for a publicly hosted, strictly read-only instance (`DEMO_MODE=1`): visitors can browse a vault completely (Home, Graph, Library, page view, search) but change nothing and start nothing that spawns an agent or creates cost.

**Guarantees, in layers:**

1. **One central request guard** in `buildServer`: every non-read request (`!GET`/`!HEAD`, regardless of path) is rejected before any route handler with `403 { error: "demo_read_only" }`. New mutating endpoints are thereby covered automatically; the guard is the boundary, not the individual route (the same principle as the sandbox in hard rule 4). The guard deliberately checks only the verb: an earlier version additionally required the prefix `/api/` in the raw URL, and a percent-encoded path such as `/%61pi/v1/pages` got past it, because the router decodes the path before matching while the hook saw it undecoded. Nothing outside the API accepts writes, so the path condition gained nothing and cost the guarantee.
2. **Passive start-up formation** in `startService`, as defense in depth below the guard: ingest queue, inbox watcher, Telegram bot, retrieval-index scheduler and vault reconciler (a vault WRITER) are not started at all in demo mode. The vault watcher (read-only SSE signal) keeps running.
3. **No credential needed or expected:** The demo instance deliberately runs without an Anthropic credential; the setup-mode hint is dropped (demo wins over setup: that is the instance's normal state, not an onboarding gap).

**Surface:** `GET /api/v1/health` reports `demoMode: true`. The dashboard shows a read-only notice instead of the setup banner; System remains visible as a tab but renders an explanation surface (the feature exists, is switched off in the hosted demo, pointer to local operation); Research renders read-only (since 2026-09-18, it used to show the same explanation surface): the saved conversations with their citations and the finished research runs can be browsed, the composer is disabled with a hint, and nothing can be started from it; intake surfaces (dropzone, global drag-and-drop) are gone. In demo mode `GET /api/v1/settings` names neither vault path nor watch folder nor bind address; a public instance has no reason to reveal its file-system layout.

**Delimitation:** Demo mode changes nothing about hard rule 2 (bind policy); a public demo sits behind a reverse proxy, the service itself keeps binding `127.0.0.1`. It is orthogonal to setup mode and to `HTTP_AUTH_MODE`.

**Fellows in demo mode (added 2026-09-18).** With `AGENTS_ENABLED` set, a demo instance constructs the Fellow services too (Fellow service, night shift, recap service, usage monitor, library, pinboard), so the Library, the recaps, the reading list and the pinboard can be browsed from a seeded database, and `health.fellows` is `true`. Nothing of it runs: the shift and the recap scheduler are never started (the passive start-up formation above), and every write - a spawn, a decision, a recap answer, a shelf move, a value event - is refused by the guard before a handler runs. The dashboard reacts to that refusal once, in the shell, with a notice; the buttons stay, which is how a visitor sees what the full app offers, and the value event a page open would send is not sent at all on such an instance. The start-up write to the vault's `.git/info/exclude` tolerates a vault mounted read-only for the process, which is how a hosted instance should mount it. The synthetic vault and database from `scripts/demo-vault.mjs` are the intended seed; their dates are relative to the build, so a hosted instance rebuilds them on a schedule, which is the host's job and not the service's. Demo mode without the flag stays what it was: no Fellow surface at all.

---

### 12.9 Dedupe in three stages and the outcome "no changes" (added 2026-09-05, links added 2026-09-18)

Trigger: an already ingested paper was dropped again and still went through a full agent run, which after eleven turns concluded on its own that there was nothing to do. Two independent gaps: the `jobs` row of the first ingestion had been deleted by "Clear history" (and the hash with it), and the freshly downloaded PDF had different bytes anyway, because the publisher embeds a download watermark with a date. A byte hash cannot recognize this class in principle.

**Stage 1: the hash, remembered in the vault.** On enqueue the SHA-256 is checked not only against `jobs.sha256` but also against the `sha256` fields of all `.raw/<job-id>/manifest.json`, which the service itself writes during preprocessing. A hit creates the `duplicate` row exactly like a hit in `jobs`, with `duplicate_of` = directory name (the job id). Dedupe thereby survives clearing the history and even losing the DB (hard rule 1, §8). If the `jobs` row still exists, it wins as the reference, because the dashboard can open it. Read-only, no vault writes; the index reads only what changed since the last call.

**Amendment 2026-09-16 - a hit has to have produced something.** Both halves of stage 1 answered "have I seen these bytes", and neither asked whether anything came of it. A run interrupted a second after it started - a crash, a restart, a failed agent call - therefore claimed its document for good: the `jobs` row kept the hash (`failed` and `deferred` were excluded from v29's release, which only covered `cancelled`), and the job dir's manifest is written by PREPROCESSING, so it existed before an agent had read a word. Re-dropping the file came back as a duplicate of a run that wrote nothing, and tidying the failed row out of the history made it worse rather than better: the vault-side half then answered "already in the vault", which was false, and with no row left there was no retry either. The document could not be ingested again through any door.

The rule is now what an earlier job **still stands for**. In `jobs`, a row blocks while its content reached the vault (`done`) or is still on its way there without anyone lifting a finger (`queued`, `preprocessing`, `ingesting`), plus `deferred` - a job set aside with its original staged, which a re-drop would only duplicate. `failed`, `cancelled` and `duplicate` own no bytes (`SOLE_OWNERS` in `db/jobs.ts`). Because a lookup that skips a row cannot live under a UNIQUE column - skipping only moves the collision to the insert - **migration v30 drops the UNIQUE on `jobs.sha256`** and replaces it with a plain index; a failed attempt and the retry that follows it legitimately carry the same hash, and v29's clearing of the hash on cancellation is no longer needed. The vault-side half backs its claim before making it: the job history answers first and exactly, and where history no longer knows the job, the skill's delta tracker `.raw/.manifest.json` says whether that job dir was credited with pages. The deliberate cost sits at the other end: a document old enough that neither the history nor the tracker remembers it can be taken in a second time, which is one agent run that the ingest skill itself tends to recognise - against a document that could never be taken in at all, that is the right way round.

**Stage 2: the DOI, after preprocessing, before the run.** From the normalized text the DOI by which the document identifies itself is determined (candidates from the head of the whitespace-collapsed text; among several, the most frequent one in the document, because publisher watermarks repeat the paper's own DOI on every page, while reference lists lie outside the head). If a source page under `wiki/sources/` declares this DOI in its frontmatter (`url:`/`doi:`), the job goes `preprocessing → duplicate` (the new and only transition into `duplicate`), `error` carries the explanation with page and DOI, and `duplicate_of` the job from `.raw/.manifest.json` when the skill's delta tracker attributes the page to a raw path. Protection against self-recognition: a page this job created itself, or one younger than the job, does not count as a predecessor - **and, since 2026-09-16, no page left behind by an attempt that failed or was cancelled.** A run interrupted after it wrote the source page and before it was through leaves exactly the evidence this stage looks for, and because a second download of a paper differs in its bytes, stage 1 waves it past and this stage is the one that stops it - which made the DOI the reason a paper could not be retried. A fragment is not an ingest. Batches: the duplicate drops out of the combined run, the remaining members run. The never-committed staging copy `.raw/<job-id>/` is removed, but only when git knows nothing under it (sanctioned exception in CLAUDE.md hard rule 1); a versioned original stays untouched. Telegram reports a late duplicate to the chat like a completion. The page body is deliberately **not** searched: a review cites dozens of other DOIs. **Escape hatch** for a wrong match: switch the setting `doiDedupe` off (default on, live, System → Service) and drop the file again.

**Stage 2 for links: the canonical address, at enqueue (added 2026-09-18).** Trigger: a post re-shared from the X app (the share link carries `?s=…&t=…`) went through a full agent run although the same post had been ingested eight days earlier; the agent recognised it after twelve turns and wrote only its log entry. A URL job carries no hash, and a page fetched twice rarely hashes the same anyway (counters, ads, timestamps); what stays stable is the address once the noise a share button appends is stripped. `canonicalUrl` (`server/src/pipeline/url-identity.ts`) lowercases the host, drops `www.`, the fragment, the trailing slash, default ports and a fixed list of click-tracking parameters (`utm_*`, `fbclid`, `gclid`, `si`, …), sorts the remaining query, and identifies X posts by their status id and YouTube videos by their video id regardless of host, handle or share tag. The same canonical form is the reading list's url identity (`urlKey`, 12.10), so the whole service has one notion of the same address. If a source page under `wiki/sources/` declares the same canonical address in its frontmatter (`url:`/`source_url:`), the row is created as `duplicate` exactly like a remembered hash in stage 1: no transition, nothing fetched, no staging dir, no run. `error` carries page and canonical URL, `duplicate_of` the job the delta tracker attributes the page to, or stays null when it names none. A source page is the only evidence accepted: a failed earlier job leaves no page, so resubmitting its link is a retry, not a duplicate. Unknown query parameters are deliberately kept (`?id=`, `?p=` carry identity): a wrong match costs a source, a missed one costs a run. Batches: a duplicate link drops out of the combined run. Telegram answers an enqueue-time duplicate immediately; the jobs API, watcher and CLI report it. **Escape hatch** for a page that changed since its ingest: switch the setting `urlDedupe` off (default on, live, System → Service) and submit the link again.

**Stage 3: the outcome "no changes".** A `done` run whose own commit landed and carried no content page, and for which the recovery pass (`recoverPageRecord`) finds no content page either, receives `outcome = 'no-changes'` (migration v14) plus a warning line in the log. Content page means any page under `wiki/` except the meta pages every ingest touches: `index.md`, `log.md`, `hot.md`, `overview.md`, `dashboard.md`, `Wiki Map.md`, `getting-started.md` and any folder's `_index.md` (`server/src/pipeline/wiki-meta.ts`, the list the ingest skill itself exempts from addresses; the Telegram title filter uses the same one). Until 2026-09-18 the log entry the skill appends for a source it recognised as already ingested counted as a page, and such a run passed as `done` with "1 page". `created_pages` keeps the full committed list either way. The dashboard shows it as a badge and explanation line; the Telegram message says it too. The commit stays (it carries the staged original and the skill's manifest note) so the run remains traceable. A skipped or failed commit says nothing about the run and marks nothing.

**Compatibility with claude-obsidian:** All three stages are read-only towards the vault content. They use exclusively artifacts the repo provides anyway (source frontmatter with `url:`, the `wiki-ingest` skill's delta tracker `.raw/.manifest.json`) or that the service writes itself (`.raw/<job-id>/manifest.json`). The skill's own manifest check (path + hash) stays unchanged; it never fires for service ingests, because every job gets a new raw path, which is why the service takes over the check before the run.

**Delimitation:** URL jobs carry no hash and are recognised by their canonical address only (since 2026-09-18), so a page resubmitted under a genuinely different address (a mirror, an unresolved shortener) is fetched again; text notes are deduplicated via the hash of the text. A content-level dedupe without a DOI or URL (title similarity, whitespace-normalized text hash) is deliberately not built: too fragile for the price of a wrong match.

---

### 12.10 Research agents ("Fellows", added 2026-09-15, behind `AGENTS_ENABLED`)

A **Fellow** is a standing research agent that works a subject on its own schedule, at night, and leaves a record the user reads in the morning. It is not a chat and not a one-off run: it has a home domain, one to three standing tasks, a notebook page in the vault, a budget, and a degree of autonomy the user sets. The whole subsystem is off unless `AGENTS_ENABLED=1` is set; with the flag unset the service behaves exactly as it did before, network requests included. Detail specification: `docs/agents/SPEC.md`. The work was built in a private fork called *Curious*, which is why that name appears in the design records under `docs/tasks/`.

**Standing work, in three arts.** A task is a sentence plus an art: `watch` (look for what is new on a subject), `explore` (pursue an open question until the vault has it covered), `deepen` (build out pages the library points at more than they pay off). At most three per Fellow, because at one run a day a longer list starves its own tail; a fourth subject is a second Fellow. A Fellow is spawned as one of four shapes - one of the three arts, or `custom` for any mix - and the service holds it to that shape for life, so an observer cannot later be handed a deepening. Only an explore task can ever be finished; watch and deepen are standing work, and standing work that declares itself done is a bug.

**Planning reads the vault, never the web.** Once a night a planning run looks at what the vault itself says is unanswered - the open questions on the Fellow's own pages, link targets nobody has written, stub pages, what recent ingests brought in, and questions another Fellow handed over - and proposes concrete runs against exactly one of the standing tasks. The proposal carries its rationale, its provenance (which candidate it came from and on which page that was read), a scope score against the task's own wording, an estimated cost and a page set. The planning run has no web access at all: it runs on the query profile, which is the same read-only profile the dashboard's own chat uses.

**Autonomy is a veto, not an approval queue.** In `veto` - the middle of three modes - a proposal that nobody decided on RUNS; approving it only sorts it first. `manual` runs nothing without a click, `auto` decides nothing. Only four things hold a run back: manual mode, an explicit veto, a scope score under the drift threshold, and a Fellow asleep because its subject is covered or because it stopped making progress. A sleeping Fellow wakes when something is filed into its domains.

**The night is one queue.** Runs are serialized on the run mutex, so the night window (01:00 to 06:00 by default, a setting) is a queue rather than a pool, and every Fellow shares it. Each works every standing task by default, one planning run per task; the alternative is a rotation of one task a night. The order the night walks the shelves is a stored per-domain order, with per-Fellow priority keeping its meaning inside a domain.

**The budget is a share of the subscription, not a sum of money.** Runs are priced in plan-utilization points measured against this vault's own settled runs rather than against constants, and a Fellow is stopped by its runs-per-day quota, by the daily budget, or by the research share of the five-hour and weekly windows - whichever binds first. The shares are settings with reserves under them, so the user's own interactive work cannot be spent by the autopilot.

**The record is three things.** The **notebook** is one vault page per Fellow under `wiki/meta/agents/`, written as `type: meta` so the vault's own tiling and address rules leave it alone; it carries the run log, the plan and the Fellow's running list of open questions. The **recap** is a daily page summarising what the night did, per Fellow, with the decisions the user can answer. The **Library screen** is the dashboard's room view: a Fellow is a figure in it standing at a desk of its own - the room seats ten, the desk is a column of the record given at spawn and freed at retirement, and the eleventh spawn is refused - its shelf is its domain, and one window manages every Fellow completely - tonight's schedule drawn from measured run durations, the dossier, the open decisions, and spawning. A pinboard in the room lists every open question the vault's pages left behind, hands one to the Research tab, or strikes it through on its page (12.4); details in `docs/agents/SPEC.md` 10.13.

**What the flag gates, precisely.** With `AGENTS_ENABLED` unset, no Fellow service, night shift, recap service, usage monitor or library service is constructed; the routes they own are therefore not registered and answer 404 (the pinboard's `/api/v1/questions` among them); `GET /api/v1/health` reports `fellows: false` and the dashboard hides the Library tab and asks for nothing the extension owns. The **reading list** belongs to this subsystem too: an ingest is told about it, and writes to it, only when the flag is on, because the list exists so that a publication nobody could read becomes a request a Fellow answers.

**The tables exist either way, and the migration is one-way.** The agent tables are created by the schema migrations regardless of the flag, so a vault with no Fellows still has a `fellows` table; that is schema, not behaviour. But there are 31 migrations gated by `PRAGMA user_version` (the highest `version` in `server/src/db/migrations.ts`, which is the number to re-check rather than repeat) and none of them steps back down: a user who upgrades, decides the Fellows are not for them and wants the previous release cannot run the old binary against the same database. Keep a copy of `jobs.db` before upgrading if that matters.

**Delimitation.** Fellows never run in demo mode, whatever the flag says; with the flag set they are constructed and SHOWN there, read-only, from whatever the database holds (§12.8). They write to the vault only through agent runs behind the shared commit mutex, like every other run, so hard rule 1 is untouched; losing the database loses the schedule and the proposals, never the vault. A Fellow's own runs reach the web; its planning run does not.

---

### 12.11 Source integrity (added 2026-09-15, not behind a flag)

Six mechanisms that harden how the service acquires and reads sources, and how a deepening run may touch a page. Unlike 12.10 these are **not** behind a feature flag, and that is deliberate: each corrects the existing ingest pipeline rather than adding a subsystem beside it, and putting a correctness fix behind a flag ships the known-weaker path as the default. Detail specification: `docs/sources/SPEC.md`.

**A URL that serves a PDF is read as one.** Detection is by response, not by the address: a URL whose content type or first bytes say PDF goes down the PDF lane with the PDF plugin, instead of being parsed as HTML and yielding a page of navigation furniture.

**Everything a converter produces is fenced as data.** Text that reaches an agent from a document is wrapped in an explicit boundary that says it is material to be read and never instructions to be followed, and text inside it that addresses an assistant is reported to the operator rather than silently passed on. This is the prompt-injection boundary at the one place every ingest crosses.

**A blocked or abstract-thin page is rescued from a legal open copy.** When a URL job lands on a paywall or on an abstract, and the page names a DOI, the service asks three open scholarly indexes whether a legal open-access copy exists, fetches it if so, and discloses on the resulting page which copy the text came from. **This is service egress, not agent egress**, the same distinction SPEC section 9 already draws for the Telegram bot: hard rule 4's "no web egress in ingest runs" is about the AGENT and stands unchanged. The hosts contacted are `api.openalex.org`, `api.core.ac.uk` and `www.ebi.ac.uk` (Europe PMC), and what is sent is the DOI of the document being ingested. It is **on by default** (`oaRecovery`, System → Service), so an install that upgrades gets it without asking; an install that wants no third-party lookups turns it off there.

**Quotes are checked against the text the run actually read.** A quotation an ingest writes into a page is compared verbatim against the job's own source text, and the record says how many held. A quote that cannot be found is reported, not removed: the run may have quoted a figure caption or a table the extraction dropped, and a validator that deletes is worse than one that flags.

**A deepening is confined at tool time.** A `research-expand` run may touch only the pages it was given, may only insert, and may create at most a few new pages; the PreToolUse hook refuses the rest while the run is still happening, and the commit check and automatic revert stay underneath as the backstop. The additive rule is what makes a deepening safe to run unattended.

**The one part of this that IS behind the flag** is the **reading-list sweep**: entries a Fellow could not read are re-checked for an open copy each night and marked, so the user can ingest the copy with one click. It lives inside the night shift and therefore exists only with `AGENTS_ENABLED`. It is source-integrity work running on the Fellows' schedule, and the seam is named here because it is the one place the two subsystems are not cleanly separable.

**Delimitation.** Scholarly discovery - searching open indexes as a research tool rather than as a rescue for one blocked document - is deliberately out of scope and recorded as an extension axis. The fence bounds what an agent is told about a document; it is not a claim that a document cannot influence a run at all, which no boundary of this kind can promise.


### 12.12 The hub layer is service-owned (added 2026-09-19)

`wiki/index.md` and the `wiki/log.md` entry are written by the SERVICE after every run that
wrote a page, deterministically, inside that run's own commit. `wiki/hot.md` deliberately stays
with the agent: it is a semantic summary of what matters right now, no generator can produce it,
and a lost update there costs a cache rather than knowledge.

**Why.** The prompt used to tell every ingest to link its new pages from the index. Measured on
the working vault before the change: the index had grown to 514 kB against the ~1000 tokens the
vault's own skill budgets for reading it; **83 % of the wiki's entire git history** was six hub
files being rewritten whole (roughly 570 kB of permanent history per ingest, for bookkeeping);
the long per-file lock holds that made §3.1's race real were all on these files; and the
hand-maintained header counters accounted for 77 of 406 validator findings.

**What makes it hold.** Not the write guard - **regeneration**. The index is derived from page
frontmatter, so an agent write to it is overwritten by the next run rather than having to be
prevented. Two renders of an unchanged vault are byte-identical, which is what keeps an
unchanged index out of a commit; nothing in the render reads the clock.

**Mechanism.** The vault's own per-file lock on the hubs is taken OUTSIDE the commit mutex and
the write and commit happen inside it (foreign-then-ours, CLAUDE.md hard rule 1). A run that
wrote no content page writes no log entry and does not regenerate the index. A hub write that
fails is loud and non-fatal: the run stays `done`, a warning lands on the job, and the next run
regenerates the index anyway - the safety net a derived file gives that a maintained one never
did. Links in the index are written from the FILE NAME with the title as display text, because a
title the file name cannot carry is this vault's largest dead-link class.

**Undo.** Because every commit now carries the hubs, every later commit touches them too, so
`git revert` of a whole older commit would conflict on the hub files rather than on anything the
run wrote. `revertCommit` therefore reverts the commit's own paths and leaves the hubs alone,
which is also what reverting means here: the index is regenerated from the pages that remain, and
the log is a record of something that really did happen.


### 12.13 Page freshness: `updated:` and `content_updated:` (added 2026-09-19)

A page carries two date fields where it used to carry one.

`updated:` keeps exactly its old meaning: the day anything about the FILE changed. The vault's
own skills read it and repurposing it would change their behaviour, which is not ours to change
(hard rule 5).

`content_updated:` is new and means the day a human or a run changed what the page SAYS.

**Why.** Every mass pass bumped `updated:`: a tag normalisation, a link repair, a counter
refresh, a frontmatter backfill. Measured on the working vault before this change: **1231 of
1247 pages (99 %) claimed an update within thirty days**, which is another way of saying the
field answered nothing. "What changed recently" cannot be asked of a vault where everything
changed recently.

**The rule for a writer, and it is a judgement the writer makes rather than a diff.** A user's
page edit, a run writing a page, a question struck through: content changed. A link joined back
onto one line, a tag dropped, an em-dash replaced, a heading moved, a counter refreshed: the
file changed and the page still says the same thing. `stampDates({ content })` takes that
judgement as its argument; `bodyChanged` is available where a writer wants a diff to decide.

**Who writes it, and why not the agent.** The field is set by the SERVICE, in the post-run step
that rides inside the run's own commit, on every content page the run wrote. That is deliberate:
an ingest's pages are written by the AGENT from the vault's own frontmatter template, which has
no such field, so for the first day the field existed the one path that produces most of the
vault's pages was the one path not filling it - measured on the first real ingest after it
shipped, four of five new pages had `updated:` and no `content_updated:`. A prompt rule would
have held only as long as every run remembered it, and the whole point of the field is that a
later reader can trust it.

The hubs are excluded, and so is `hot.md` and the bucket `_index` MOCs: a run adding a line to
an index has not said anything new about a subject. The pages' own per-file locks are taken
alongside the hubs' and OUTSIDE the commit mutex, which is hard rule 1's order.

**Reading it.** `freshnessDate` prefers `content_updated:` and falls back to **`created:`**,
deliberately not to `updated:`. On the pages that predate the field `updated:` is the date of
the last mass pass, and sorting by it is what made every page look equally fresh. The one-off repair of §12.14 was mechanical, so it stamped none of the 819 pages it touched;
the field fills from the next real write onwards.

### 12.14 What `.raw/` puts into vault git (added 2026-09-19)

The vault repo had grown to **1.4 GB carrying 16 MB of knowledge**. Two classes were
responsible and both are now excluded, the same mechanism and the same category as the
retrieval-index artifacts in §12.6: repo-local `.git/info/exclude`, never a change to a tracked
file of the cloned repo (hard rule 5).

**Derived payloads.** `ocr.pdf` is written beside the original when a textless PDF has to be
OCR'd. It is rebuildable from the file lying next to it and it was **627 MB in 16 blobs**, three
of them over 150 MB. Derived and rebuildable is exactly the category the exclude list exists
for.

**Oversized originals.** A payload over `RAW_PAYLOAD_MAX_BYTES` (default 25 MB) stays on disk
and out of git. It is not deleted and not hidden: the job's manifest names it under `localOnly`
with its size, so provenance still points at a real file on this machine and a reader can tell
"not versioned" from "not there".

**What this does not do.** It does not shrink the existing 1.4 GB. Rewriting the vault's history
was considered and rejected: a rewrite invalidates every commit hash the service has recorded
against a job, and the wiki content is 232 MB of that history and would have to survive
untouched. The size is prevented from growing, and the existing history stays exactly as
written.
