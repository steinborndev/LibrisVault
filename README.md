# LibrisVault

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

Drop a PDF into a folder - a few minutes later it is a set of linked, cited wiki pages in your
personal knowledge vault.

LibrisVault is a local ingestion service and web dashboard on top of a
[claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) vault (v1.9.2, Generic mode).
It watches a folder, accepts drag-and-drop uploads and files sent to a Telegram bot, preprocesses
the material (PDF, Office, web, images, text), and runs headless Claude Agent SDK sessions that
execute the vault's `ingest` skill automatically. The dashboard covers intake and status, web and
vault research with citations, an interactive graph and page viewer, a browsable catalog, and the
machine room behind it.

Everything runs on your machine: the service binds `127.0.0.1`, the vault stays a plain git
repository on disk, and the only outbound traffic is the agent's to Anthropic - plus, if you
enable them, the Telegram bot's polling and open-access lookups.

![Home: the vault as a shape, the domain panel, and one activity stream](docs/img/home.png)

<sub>Every screenshot comes from a **synthetic** vault: textbook subject matter, generic document
titles, no real notes, people or sources. See [Screenshots](#screenshots).</sub>

---

## Contents

**Get it running** · [Quick start](#quick-start) · [Requirements](#requirements) ·
[Setup, step by step](#setup-step-by-step) · [Running it](#running-it) · [Docker](#docker)

**What it does** · [The dashboard](#the-dashboard) · [Research agents](#research-agents) ·
[Source integrity](#source-integrity) · [Telegram bot](#telegram-bot) ·
[Hybrid retrieval](#hybrid-retrieval)

**Reference** · [Configuration](#configuration) · [Security model](#security-model) ·
[API](#api) · [Development](#development) · [Troubleshooting](#troubleshooting) ·
[Status & license](#status--license)

> **`SPEC.md` is the authoritative specification.** When code and spec disagree, the spec wins.
> `CLAUDE.md` holds the hard rules that constrain any change. Per-milestone task lists and
> engineering findings live in `docs/tasks/`.

---

## Quick start

**One command** (Linux, or Windows + WSL2 with Ubuntu):

```bash
git clone https://github.com/steinborndev/LibrisVault.git && cd LibrisVault
bash scripts/setup-all.sh
```

Installs Node via nvm, the sandbox and preprocessing toolchain, the vault and the systemd user
unit, then starts the dashboard at <http://localhost:8420>. It deliberately does not ask for your
Anthropic credential: the service starts in **setup mode** and the dashboard walks you through
that under System → Integrations. Re-running it is safe; every step checks before it acts.

**Windows without WSL:** download the repo as a ZIP (Code → Download ZIP, no git needed) and run
`scripts\install.ps1` in PowerShell. It installs WSL2 + Ubuntu, runs the setup inside it, and puts
a shortcut on your desktop.

**Manually instead:**

```bash
# 1. The service. It lives NEXT TO the vault, never inside it.
git clone https://github.com/steinborndev/LibrisVault.git && cd LibrisVault

# 2. The vault it writes into: a separate repo, outside this one, pinned to the tested tag.
#    Push is disabled because the vault fills with private content and origin is public.
git clone https://github.com/steinborndev/claude-obsidian ~/vault
(cd ~/vault && git checkout -B vault-main v1.9.2 \
  && git remote set-url --push origin PUSH_DISABLED_vault_is_private \
  && bash bin/setup-vault.sh)

# 3. Sandbox + preprocessing toolchain
sudo apt-get install -y bubblewrap socat
./scripts/install-preprocessing-tools.sh

# 4. Build and run, then open http://127.0.0.1:8420
npm ci && npm run build
VAULT_ROOT=~/vault npm start
```

---

## Requirements

`setup-all.sh` installs every row except the OS. `git` and `curl` are assumed; both ship with the
stock Ubuntu WSL image.

| | |
|---|---|
| OS | Debian/Ubuntu-family Linux, or Windows + WSL2 (built and e2e-tested on Ubuntu 24.04) |
| Node | ≥ 20 LTS. Manual: `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh \| bash`, then `nvm install 20`. Already-open shells: `. ~/.nvm/nvm.sh` |
| Vault | a claude-obsidian clone, **tested against v1.9.2**, by default `~/vault`. Cloned from [our fork](https://github.com/steinborndev/claude-obsidian) and pinned, so upstream changes cannot break a fresh install |
| Credential | a Claude subscription token **or** an Anthropic API key, exactly one. Entered in the dashboard on first run; not needed to start |
| Claude Code CLI | subscription path only, to run `claude setup-token` once: `npm install -g @anthropic-ai/claude-code` |
| Sandbox | `bubblewrap` + `socat`. **Required** - agent runs fail without them |
| Preprocessing | poppler-utils, ocrmypdf, tesseract, pandoc, exiftool, defuddle, yt-dlp + deno (yt-dlp needs a JS runtime for YouTube's bot check) |

---

## Setup, step by step

### 1. The vault

Lives **outside** this repo; its path is a configuration value and nothing hardcodes it.

```bash
git clone https://github.com/steinborndev/claude-obsidian ~/vault
cd ~/vault && git checkout -B vault-main v1.9.2
git remote set-url --push origin PUSH_DISABLED_vault_is_private
bash bin/setup-vault.sh
```

The service checks at startup that `VAULT_ROOT` holds `wiki/` and `skills/`, so a wrong path fails
immediately rather than at the first agent run.

### 2. Toolchain

```bash
sudo apt-get install -y bubblewrap socat        # sandbox, not optional
./scripts/install-preprocessing-tools.sh        # poppler, ocrmypdf, tesseract, pandoc, …
```

### 3. Credential

**None needed up front.** Without one the service starts in setup mode and the dashboard collects
it under System → Integrations, writes the env file and restarts itself (under systemd). Exactly
one may be configured: with both set the service refuses to start, because `ANTHROPIC_API_KEY`
silently overrides the OAuth token and you would not know which was billed.

The manual equivalent:

```bash
npm install -g @anthropic-ai/claude-code
mkdir -p ~/.config/vault-service
claude setup-token
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "<token>" > ~/.config/vault-service/env
chmod 600 ~/.config/vault-service/env
```

The credential is read from that file or the process environment, and is never written to the
repo, the database, the logs or the API.

### 4. Build

```bash
. ~/.nvm/nvm.sh          # skip if node >= 20 is already on PATH
npm ci
npm run build            # web/dist (SPA) + server/dist (runnable JS)
```

---

## Running it

```bash
VAULT_ROOT=~/vault npm start                    # from source (tsx), the everyday dev command
npm run dev:web                                 # hot reload: Vite dev server, proxies /api
VAULT_ROOT=~/vault npm run dev:server           #   …in a second terminal
npm run build && VAULT_ROOT=~/vault npm run start:prod   # built JS, what systemd runs
```

Then open <http://127.0.0.1:8420>. `VAULT_ROOT` is deliberately not in the credential file; pass
it explicitly.

### Autostart with systemd

```bash
./scripts/install-systemd.sh ~/vault    # writes + enables the user unit
loginctl enable-linger "$USER"          # so it runs without an active login
systemctl --user start vault-service

systemctl --user status vault-service
curl -s http://127.0.0.1:8420/api/v1/health
journalctl --user -u vault-service -f
```

The unit runs the **built JS as a single `node` process**, not `tsx` or `npm`, so systemd's main
PID is the server itself; a wrapper would leave an orphaned node child holding port 8420 after a
stop. `KillMode=control-group` reaps an in-flight agent run's descendants with the service. After
changing code: `npm run build && systemctl --user restart vault-service`.

**Surviving a reboot:** run `wsl --shutdown` in Windows, reopen WSL, then curl the health endpoint
- it must answer without a manual start. `queued` jobs resume; jobs that were mid-flight are marked
`failed` with an "interrupted by a service restart" reason and are one-click retryable. They are
deliberately not replayed: an interrupted ingest may have partially written the vault.

---

## The dashboard

Five screens as tabs, all live over SSE, plus a sixth with the research agents on. The order
follows the day: what arrived, what you go and find out, then what is there, then the machine room.

### Home - intake and everything in flight

The left rail is the control column: the dropzone (files, URLs, a pasted note) over the filters
that narrow the stream by kind, age, state and channel. The workspace answers two questions: **the
stock** on top (pages, links, domains, unwritten pages) with the wikilink graph beside it and the
domain split as bars; **the flow** underneath, as operational figures over the activity stream.

One stream, not one per channel: ingests, research runs, maintenance runs and vault edits are rows
in the same table, each showing the pages it produced, what it took and what it cost. A row opens
in place with the full record - log, commit, pages, and the retry or revert action. A finished
ingest is exactly one vault commit, so **reverting** it is one click, and the undo is itself a
commit. It refuses rather than guessing if the vault is dirty or the revert would conflict.

### Research - going and finding something out

| | reads | writes | cost |
|---|---|---|---|
| **Web research** | the web | files pages, one commit | fetches |
| **Vault research** | only what the vault holds | nothing | tokens only |

Both appear as ledgers of the same shape. A **lens** shapes a web run - four profiles (broad sweep,
state of the art, recent patents, startups & funding) deciding how it searches and what it files -
and the composer shows the plan before it starts: the page it will file under, the fetch budget,
the step rail. Answers stream in as they are written and cite vault pages as chips that deep-link
into Obsidian and expand inline. Conversations are named, resumable and savable into the vault.
Underneath, the vault's own **knowledge gaps** sit as a backlog: pages other pages link to that
nobody has written, each one a run you can start with a click.

![Research: two ledgers of one shape, with the vault's own gaps as a backlog](docs/img/research.png)

A run files one synthesis page, and that page is the point of the screen. This one is real: it was
produced by the run in the ledger's first row, and every filing it names was read on the web.

![A synthesis page a research run filed, with its findings, its sources and the limits it names](docs/img/research-result.png)

### Library - the vault as a room

*Only with `AGENTS_ENABLED`; see [Research agents](#research-agents).* Domains are shelves, Fellows
are figures, and what each is doing is in the bubble over its head. One window manages the Fellows
completely: tonight's schedule priced from the runs this vault has actually made, a dossier per
Fellow (notebook, recap slice, run ledger, settings), the decisions waiting for you, and the spawn
form. The wall board carries the hot cache, the daily recap and the reading list.

![The Library: domains as shelves, Fellows as figures, and what each is doing in the bubble over its head](docs/img/library-room.png)

The main room holds the Fellows and the boards; the domains stand in wings off it. A shelf is one
domain, its colour is the domain's, and how full it is is how many pages that domain holds.

![A wing: one shelf per domain, filled to the page count it holds](docs/img/library-wing.png)

![The command centre: tonight as one queue, priced from the runs this vault has actually made](docs/img/command-centre.png)

### Graph - the wikilink structure

On a canvas, with the force layout in a web worker so it stays smooth as the vault grows.
**Colour lenses** recolour the same graph to answer different questions: by `domain:` (the default),
by page type, or by a metric (authority, recency, orphans, stubs). **Overlays** add community areas,
brightened bridges and a spotlight that isolates one community on hover. Page-type chips and a
domain list filter what is shown, and each section counts what the other filters leave.
**Search narrows** rather than highlights. Structural scaffolding and maintenance artifacts are
hidden by default; one toggle brings them back.

Keys: double-click opens a page, `/` searches, `f` fits, `←` `→` step the domains or the wings,
`Esc` steps back one layer, `Esc Esc` resets. The Shortcuts pill lists them all.

The **page view** behind it has rendered markdown, clickable `[[wikilinks]]`, a frontmatter panel
and backlink/outgoing panels. Pages can be **edited and deleted here** - every mutation is one git
commit, serialized behind the same mutex as agent commits, with an optimistic lock (409 if an agent
changed the page since you loaded it). After a delete, a banner counts the backlinks that just went
dangling and offers a cleanup run. `/graph` and `/page/<path>` survive a reload and back/forward.

![The wikilink graph, one colour per domain, with the gaps overlay one click away](docs/img/graph.png)

### Catalog - one table over every page

The browse path a graph cannot give you, fed by the same graph query the canvas uses. Filter by
page type, domain (grouped by wing once there are enough), health (with a source, orphans, stubs,
system pages) or origin (PDF, web, text); sort by recency, title, type, domain, backlinks or source
type. Each row carries the domain, in/out link counts, when it changed, and a **source** column
that opens the document the page came from - read from the vault's own `.raw/` manifests rather
than from SQLite, because losing operational state must never lose provenance.

![Catalog: one table over every page, filtered by type, domain and health](docs/img/library.png)

*Called Library until September 2026. The name moved to the room view; a catalog of pages is what
this one is.*

### System - the machine room

- **Status & checks** - lint (a structured report) plus a "fix safe findings" run that automates
  only the mechanical categories and leaves judgment alone; the hot-cache refresh; the domain
  registry and its backfill; the governance loop.
- **Usage & cost** - tokens, spend today and over 7 days, the daily budget as a meter, spend per
  channel, every priced run with the dearest first.
- **Vault stats** - pages, links, orphans, stubs, gaps and unfiled pages; growth over 30 days;
  pages by type; the vault's commit history; the retrieval index and its rebuild; a check that
  every page under `wiki/` reached git.
- **Service & config** - watch folder, concurrency, upload limit, git auto-commit, open-access
  rescue, DOI dedupe, the daily budget, and with the agents on the research shares and reserves.
- **Integrations** - the Anthropic credential, the Telegram bot, the Obsidian vault name.

![System: vault stats - size, shape, growth and what is still unfiled](docs/img/system.png)

### Across the screens

Page links open the in-app viewer first; `obsidian://` is the secondary action. That keeps the
dashboard usable from a **Windows** browser, which cannot open a WSL vault over `\\wsl$`.

The graph updates **live**: while an ingest writes pages a debounced SSE event refreshes it, new
nodes surface at their neighbours' centroid, existing nodes keep their positions, the camera never
jumps.

**Domains** are the vault's meta-categories, the axis the graph filters and colours by. The allowed
list lives in the vault as the editable page `wiki/meta/domains.md` (seed it with
`scripts/install-domain-registry.sh`). Every vault-writing run gets that list as a **closed** set:
one key per page, `unassigned` when nothing fits, never a new key. Humans create domains, by editing
the page or accepting a candidate under System → Status & checks; five or more coherent
`unassigned` pages is the rule of thumb. The backfill files existing pages retroactively
(frontmatter only).

The **governance loop** continuously and for free looks for themes among the `unassigned` pages
worth a domain and shows them with their page list and a link-cohesion score. Accepting one appends
it to the registry as a commit; rejecting one is remembered. An optional agent pass judges each
candidate and pre-fills the proposal; it is read-only, and only you create domains.

Every write is followed by a deterministic, read-only check of the pages it touched: missing
frontmatter, dead links, orphans, stale counters, an overgrown hot cache. Findings are **advisory**,
never an automatic rewrite.

### Hybrid retrieval

The read-only query path normally reads the hot cache, the page index, then a few whole pages it
guesses are relevant. That loses to **chunk-level** retrieval whenever the answer sits in one
passage of a page whose title does not match the question. The vault ships an opt-in
`wiki-retrieve` skill (contextual chunk prefixes + BM25, following
[Anthropic's contextual-retrieval method](https://www.anthropic.com/news/contextual-retrieval)),
and the service provisions and maintains its index.

- **Build it once** from System → Vault stats → Retrieval index (or `POST
  /api/v1/maintenance/retrieve-index`). It chunks every wiki page into a BM25 index under
  `.vault-meta/` - derived data, kept out of vault git, rebuildable. Deterministic, no agent run,
  no credential, nothing leaves the machine. It also prunes what the chunker leaves behind.
- **The service runs retrieval**, not the agent: before each question it hands the agent five
  distinct pages, best first. An unbuilt or pre-v1.7 vault silently keeps the classic read order.
- **It rebuilds itself** after ingests, debounced.

**Local reranking is built but off by default**, and that is a measurement rather than an opinion.
Over a 35-question labeled set, BM25 alone put the right page in the top 5 in 97% of cases against
94% with an ollama (`nomic-embed-text`) rerank, and top-1 fell from 69% to 54%. A re-run at roughly
twice the vault size held that within one case. Since the model reads all five pages anyway,
reordering inside the set bought nothing. **ollama is therefore not a requirement** - you only need
it to re-run the comparison (`npm run retrieval-eval --workspace server -- --data <set.jsonl>`).

Retrieval runs in the service because the read-only query sandbox has no network and no write
access, and reranking needs both. Rather than punching two holes in that sandbox, the service does
the retrieval and passes a ranked list - which also makes it deterministic instead of dependent on
the model choosing to run it.

---

## Configuration

Two layers, one precedence rule:

```
env / ~/.config/vault-service/env   →  start-time BASELINE
settings table (System → Service)   →  runtime OVERRIDES
effective value                     =  override ?? baseline
```

Clearing an override falls back to the baseline. Overrides live in SQLite and survive a restart.

| Variable | Default | Notes |
|---|---|---|
| `VAULT_ROOT` | - | **required**; validated at startup |
| `HOST` | `127.0.0.1` | see the bind rule in the security model |
| `PORT` | `8420` | |
| `WATCH_FOLDER` | `/mnt/c/inbox` | targets a Windows mount; on plain Linux point it elsewhere. Runtime-settable, restart required |
| `MAX_UPLOAD_BYTES` | 200 MB | runtime-settable, restart required |
| `HTTP_AUTH_MODE` | `local-single-user` | `token` enables bearer auth |
| `HTTP_AUTH_TOKEN` | - | required for a non-loopback bind |
| `WATCH_POLLING` | auto | forced on for `/mnt/*` (no inotify on Windows mounts) |
| `OBSIDIAN_VAULT_NAME` | vault dir name | for `obsidian://` deep links |
| `TELEGRAM_BOT_TOKEN` | - | enables the bot; a secret, handled like the credential |
| `TELEGRAM_ALLOWED_USER_IDS` | - | comma-separated numeric ids; **required** once the token is set |
| `DB_PATH` | `~/.local/share/vault-service/jobs.db` | kept **outside** the vault |
| `AGENTS_ENABLED` | off | `1` turns on the research agents; off changes nothing, network included |
| `DEMO_MODE` | off | `1` serves the vault strictly read-only for a public instance |
| `PREPROCESS_SANDBOX` | on | `off` runs the converters without their bubblewrap jail. Only for a machine that cannot install bubblewrap |

Runtime-settable under System → Service & config: watch folder, concurrency, upload limit, the
research shares and reserves, the plan name, the five-hour release, the duplicate judge, git
auto-commit, open-access rescue, DOI dedupe, the daily budget. All apply live except the watch
folder and the upload limit, which are bound at startup and flagged "Restart required".

The bind address is **not** settable through the UI, by design. The credential is, but only through
the guarded endpoint that writes the env file, never through the settings table, and it is never
displayed or stored elsewhere.

**Daily budget (optional).** The unit follows the auth mode, because the two constrain different
things. Subscription: a **job count per day** - there is no per-run charge and runs compete with
your interactive usage. API key: a **USD amount per day**. When the budget is reached the queue
stops claiming new work (in-flight runs finish) and resumes at the next local midnight. In
subscription mode every `cost_usd` in the UI is labelled "estimate (subscription)": an API-price
equivalent, not money charged.

---

## Research agents

*Optional, off by default.*

A **Fellow** is a standing research agent. You give it a subject, one to three standing tasks and a
budget; it works at night on its own and leaves a record you read in the morning. It keeps a
notebook page in the vault, plans from what the vault itself says is unanswered, and comes back to
the same subject night after night.

```bash
echo 'AGENTS_ENABLED=1' >> ~/.config/vault-service/env
# then restart the service
```

With the flag unset none of it exists: no schedule, no routes, no Library tab, and no request to
any of it.

**A night.** Once the window opens (01:00 to 06:00 by default) a planning run reads what the vault
holds - open questions on its own pages, unwritten link targets, stub pages, what your recent
ingests brought in - and proposes concrete runs against one standing task. Each proposal carries
its reasoning, where the idea came from, a score for how close to the task it stays, and an
estimated cost. Then the runs: read the sources, write or extend pages, update the notebook.

**A task has an art.** `watch` looks for what is new, `explore` pursues an open question until the
vault has it covered, `deepen` builds out pages the library points at more than they pay off. Three
per Fellow at most: at one run a day a longer list starves its own tail, and a fourth subject is a
second Fellow.

**You decide how much say you want.** `manual`: nothing runs without your click. `veto` (the
default): a proposal you did not decide on **runs** - deciding is how you stop something, not how
you permit it. `auto`: you are not asked. The morning **recap** is where the decisions are, per day
and per Fellow, answerable in the dashboard or by Telegram reply.

**The budget is a share of your subscription, not a pile of money.** Runs are priced in plan
utilization measured against the runs this vault has actually made, and a Fellow stops at whichever
binds first: its runs-per-day quota, the daily budget, or the research share of the five-hour and
weekly windows. The shares have reserves under them, so the autopilot cannot spend the capacity you
want for your own work.

![The morning recap: what each Fellow did last night, what it found, and what it wants to do next](docs/img/recap.png)

The same night reads two ways: the wall board keeps the whole of it, a dossier keeps everything
about one Fellow.

![One Fellow's dossier: its night, what it found, the questions it raised, and whether you used any of it](docs/img/fellow-dossier.png)

And the same recap appears on Home, which is where a morning actually starts.

![Home in night-shift view: the Fellows down the left, the night's figures across the top, and the decisions in the feed](docs/img/home-night.png)

**Where the work lands.** In the vault as ordinary pages, written by ordinary runs behind the same
commit mutex as an ingest, so `git revert` undoes a night like anything else. In the dashboard as
the Library screen. And in one notebook page per Fellow under `wiki/meta/agents/`.

Details: [`docs/agents/SPEC.md`](docs/agents/SPEC.md), summarised in SPEC.md section 12.10.

---

## Source integrity

Five mechanisms that harden how material is acquired and read, plus one that limits what a research
run may do to an existing page. Unlike the research agents these are **not** optional and not behind
a flag: each corrects the pipeline rather than adding something beside it, and a correctness fix
behind a flag ships the weaker path as the default.

- **A URL that serves a PDF is read as one.** Detection is by what comes back, not by what the
  address looks like.
- **Everything a converter produces is fenced as data.** Extracted text reaches the agent inside an
  explicit boundary saying it is material to read, never instructions to follow; text inside it that
  addresses an assistant is reported to you rather than passed on quietly. This is the
  prompt-injection boundary, at the one place every ingest crosses.
- **A blocked or abstract-thin page is rescued from a legal open copy.** When a URL lands on a
  paywall and names a DOI, the service asks three open scholarly indexes for a legal open-access
  copy, fetches it if there is one, and records on the page which copy the text came from. This
  makes outbound requests of its own; see the security model.
- **Quotes are checked against the text the run actually read**, verbatim, and the record says how
  many held. A quote that cannot be found is flagged, not deleted: the run may have quoted a caption
  the extraction dropped, and a checker that deletes is worse than one that reports.
- **A deepening run is confined while it runs** (the *expand lock*): it may only touch the pages it
  was given and may only insert, enforced at tool time rather than only at the commit.

One part rides along with the research agents and needs the flag: the nightly **reading-list sweep**,
which re-checks publications nobody could read for an open copy and marks them for one-click ingest.

![The reading list: what the Fellows could not read, with the open copies the sweep found](docs/img/reading-list.png)

Details: [`docs/sources/SPEC.md`](docs/sources/SPEC.md), summarised in SPEC.md section 12.11.

---

## Telegram bot

*Optional.* Send the bot a PDF, a photo, a URL or a note and it lands in the regular queue; when the
ingest finishes the bot reports the created page titles. `/status` answers with queue, job and
budget state, `/jobs` lists recent jobs, `/research <topic>` starts a web research run.

The transport is **outbound long polling**: the service calls `api.telegram.org`, nothing calls the
service. No port is opened, the localhost bind is untouched, and it works from anywhere your phone
has internet.

**Setup.** Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) for the token, get
your numeric id from a bot like `@userinfobot` (usernames are mutable and spoofable), then either
use System → Integrations → "Set up Telegram bot…" or edit `~/.config/vault-service/env`:

```bash
TELEGRAM_BOT_TOKEN=123456789:AAF...
TELEGRAM_ALLOWED_USER_IDS=111111111        # comma-separated for several people
```

Restart afterwards (the dashboard path does it for you under systemd), then send `/status`.

**Behaviour and limits:**

- **Allowlist, fail-closed.** A token without `TELEGRAM_ALLOWED_USER_IDS` refuses startup. Messages
  from ids outside the list get **no answer at all**: a reply would confirm the bot exists, and
  every accepted message can start a paid run. The journal records the first attempt per sender id
  (id and username, never content), so probing and your own mistyped id are visible.
- **Files up to 20 MB** - Telegram's bot download limit. Larger files get a hint.
- **`/research` is the one bot action that reaches the web.** Everything else ingests material you
  send and stays confined like a normal ingest.
- **Albums become one batch**, like a multi-file drop.
- **Notifications carry titles only.** Vault content does not transit Telegram's cloud. The file you
  *send* does, like any Telegram upload.
- **Exactly one poller per token.** A second instance polling the same token makes the bot log the
  conflict and stop; the service keeps running.
- **Setup mode:** `/status` answers and says so; ingests are refused with guidance.
- **Disabling:** System → Integrations → "Disable" removes both variables. The token is never
  displayed after saving; revoke it in BotFather if it may have leaked.

---

## Security model

Six constraints are essential. They are documented in full in `CLAUDE.md`; do not weaken them.
`SECURITY.md` has the threat model, including what a malicious *document* can and cannot make the
ingest agent do, and the reporting channel.

1. **Vault integrity.** Everything the service writes is one immediate git commit behind a shared
   mutex, so it is versioned, revertable and can never interleave with an agent's own commit. A page
   write additionally takes the **vault's own per-file lock** (`scripts/wiki-lock.sh`, mandatory in
   claude-obsidian from v1.7), which is what an agent run reads too, so an edit arriving while a run
   writes the same page is refused rather than layered on top. Four paths write and only these four:
   an agent run; a page you edit or delete in the dashboard; the vault's own deterministic
   retrieval-index scripts, which produce only rebuildable artifacts outside git history; and the
   removal of a never-committed staging directory when a job turns out to be a duplicate. SQLite
   holds operational state only - losing it must never damage the vault.
2. **Localhost guard.** The server binds `127.0.0.1`. If the bind is not loopback and no auth mode
   with a token is active, it **refuses to start**. State-changing requests carrying a foreign
   browser `Origin` are rejected, so a website cannot fire drive-by requests at the loopback port.
3. **Credentials** live only in the service environment - never in the repo, logs, frontend or
   database. Both credential variables set at once is a startup error.
4. **Agent confinement is enforced by the OS sandbox**, not by application-level callbacks. Runs
   execute under bubblewrap with writes confined to `VAULT_ROOT`, and an **ingest** run has no web
   egress at all. Tool policy additionally runs through a `PreToolUse` hook; `canUseTool` was
   measured to be invoked *zero* times by this SDK and is not the enforcement point. What may reach
   the web: the autoresearch flow and a research agent's own runs. What never does: an ingest, and a
   Fellow's planning run.
5. **Plugin internals stay read-only.** The vault is a clone of claude-obsidian, so its own machinery
   sits inside the sandbox's writable area. A `PreToolUse` write guard confines agent writes to the
   knowledge areas (`wiki/`, `.raw/`, …) and refuses edits to plugin files, so an ingest can extend
   the vault but never rewrite the tool it runs on.
6. **The converters are jailed one stage earlier.** `pdftotext`, `pdfinfo`, `ocrmypdf`, `pandoc`, the
   Office extractors, `exiftool` and `defuddle` each run under bubblewrap with no network, no
   `$HOME`, a read-only system, the one input file and one writable output directory. A hostile
   document reaches a parser *before* any agent sees it, and a parser with a memory-safety bug is a
   more likely way in than a prompt. `yt-dlp` is the documented exception, because fetching is its
   job.

Because the sandbox is the real boundary it is configured with `failIfUnavailable: true`: if
bubblewrap is missing or cannot start, a run **fails loudly** instead of silently running unconfined.
That is why `bubblewrap` and `socat` are hard requirements.

A stuck run cannot outlive its timeout either: the runner owns the CLI spawn, puts it in its own
process group and escalates a timeout to a group `SIGKILL` - otherwise an aborted run leaves its
`bash`/`python3` descendants running.

Both guarantees rest on SDK behaviour unit tests structurally cannot observe, so each has a live
probe. Re-run them after any change to the permission or spawn wiring, or an SDK upgrade:

```bash
# Is our guard still consulted? Expects both canaries blocked (constraints 4 and 5).
VAULT_ROOT=~/vault npm run permprobe --workspace server

# Does a stuck tool die with the run? Expects: PASS … descendants were reaped.
# Point this at a THROWAWAY vault - it runs write-enabled.
VAULT_ROOT=/tmp/throwaway-vault npm run killprobe --workspace server

# Does the converter jail hold? Expects 14 ok lines and "PASS - the jail holds".
# Read-only; safe against the real vault.
npm run preprocprobe
```

**Outbound requests the SERVICE makes**, as opposed to an agent - worth knowing, because "no web
egress in an ingest run" is a statement about the agent. Two: the Telegram bot, if you configure
one; and open-access recovery, which asks `api.openalex.org`, `api.core.ac.uk` and `www.ebi.ac.uk`
whether a legal copy of a paywalled paper exists, sending the DOI of the document you are ingesting.
That one is **on by default**; turn it off under System → Service.

---

## Docker

The image exists so the service can move to an always-on Linux host later (SPEC.md §12.2); under WSL
the systemd unit is the day-to-day path.

```bash
docker build -t librisvault .
docker run --rm \
  -v ~/vault:/vault -v librisvault-data:/data -v ~/inbox:/inbox \
  -e CLAUDE_CODE_OAUTH_TOKEN=... \
  --security-opt seccomp=unconfined \
  -p 127.0.0.1:8420:8420 \
  -e HOST=0.0.0.0 -e HTTP_AUTH_MODE=token -e HTTP_AUTH_TOKEN=<secret> \
  librisvault
```

Verified on Docker Desktop 4.52 / Engine 29.0.1 (linux/amd64): the image builds, ships bubblewrap +
socat and the full preprocessing toolchain, `better-sqlite3` loads across the stage boundary, and
the service starts as PID 1 serving both the API and the SPA.

- **Publishing the port requires a token.** The localhost guard is not relaxed inside a container:
  `HOST=0.0.0.0` **and** `HTTP_AUTH_MODE=token` + `HTTP_AUTH_TOKEN`, or the service refuses to start.
- **Pass the credential as an environment variable.** The first-run setup flow needs browser access,
  which token mode denies. Same for the Telegram variables; the settings endpoints deliberately
  refuse with `409` when these come from the process environment.
- **In token mode the browser UI is not reachable, only the API.** The auth middleware protects
  everything except `/api/v1/health`, including the SPA, so a browser gets a `401` before it can load
  the page that would ask for a token. A login screen is future work (SPEC.md §12.1); until then use
  the container for headless operation and systemd for browser use.
- **bubblewrap needs unprivileged user namespaces.** Depending on the host you may need
  `--security-opt seccomp=unconfined` or `--cap-add SYS_ADMIN`. If the sandbox cannot start, runs
  fail with a clear error by design.

**Bind-mounting your real vault:** the container runs as uid 10001, so a host directory owned by you
is readable but not writable. Pass `--user "$(id -u):$(id -g)"` when it needs to write.

---

## Development

```bash
npm test                 # server + web unit tests (vitest); agent runs are mocked
npm run typecheck        # server + web
npm run lint             # server + web (eslint)
```

```
server/   Fastify backend, TypeScript ESM
  src/api/        routes under /api/v1, auth middleware
  src/pipeline/   watcher, queue, preprocessing plugins, agent runner, permissions
  src/telegram/   bot api client, long-poll loop, update router, message formatting
  src/db/         better-sqlite3 schema + migrations
web/      React + Vite frontend (responsive, PWA-ready)
  src/tabs/       one file per screen, under the names they were built with rather than the
                  ones the header shows: Home, Chat (= Research), Vault (= Graph), Catalog,
                  LibraryScreen, System, plus Maintenance and Recap
  src/components/ shared vocabulary: cards, tables, status, charts, the graph canvas
scripts/  setup helpers, systemd unit template, demo vault + screenshot tooling
docs/     per-milestone task lists and findings
```

TypeScript strict, ESM, conventional commits. Pipeline logic (queue transitions, dedupe,
preprocessing, guards) gets unit tests; agent runs are mocked. New source types are preprocessing
plugins, never special cases in the pipeline core. `npm test` must pass before a milestone is done.

A green `tsc` + `vite build` + test run says nothing about whether a screen actually *renders* - a
shared component that always returned an element once blanked all five screens while every check
stayed green. `scripts/probe-screens.mjs` opens every screen in a headless browser and reports what
came up:

```bash
~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome --headless --disable-gpu --no-sandbox \
  --remote-debugging-port=9333 --user-data-dir=/tmp/probe-profile about:blank &
node --experimental-websocket scripts/probe-screens.mjs
```

### Screenshots

Shot from a **synthetic vault**, so nothing private is published and the set can be re-shot whenever
the UI changes:

```bash
# 1. Build a throwaway vault (~900 pages over 18 domains, backdated git history)
node scripts/demo-vault.mjs

# 2. Serve it on a spare port. TELEGRAM_BOT_TOKEN= is REQUIRED: without it this process picks the
#    real token out of the env file and knocks the real bot off it (one poller per token).
#    WATCH_FOLDER matters too: the default is the real inbox, and two services watching one folder
#    race for whatever lands in it. AGENTS_ENABLED=1 because half the screens are the Fellows'.
cd server && VAULT_ROOT=~/.local/share/vault-service/demo-vault \
  DB_PATH=~/.local/share/vault-service/demo-jobs.db PORT=8422 \
  AGENTS_ENABLED=1 WATCH_FOLDER=/tmp/demo-inbox \
  CLAUDE_CODE_OAUTH_TOKEN=demo-not-a-real-token TELEGRAM_BOT_TOKEN= \
  node dist/main.js &

# 3. Shoot the screens at 2x into docs/img/ (thirteen; BASE_URL must match the port).
#    ONLY=home.png re-shoots a single one.
BASE_URL=http://127.0.0.1:8422 node --experimental-websocket scripts/shoot-screens.mjs
```

Each shot waits on a `settle` condition in the page rather than on the network, because the
dashboard holds an SSE connection open forever. Those conditions name CSS classes, so they rot when
the markup moves: if a shot warns that it never settled, check the selector before reaching for a
longer hold.

The generator invents everything it writes, with **one deliberate exception**: the research runs are
real. Four were run against this demo vault, cost real money and searched the actual web, and
`scripts/capture-research-run.mjs` froze each into `scripts/demo-research/` so the generator can
restore it. A synthesis page is what the research function produces, and an invented one shows a
shape where the real one shows an argument. Those pages name real papers, patents and companies, all
public, none from anyone's private notes.

The vault is deliberately neither small nor tidy: ~900 pages, ~4,500 links, one domain far deeper
than the rest, stubs and gaps left in, pages dated in reading order rather than build order. Subject
matter lives in `scripts/demo-vault-topics.mjs`. Stop the demo process by PID when you are done - a
`pkill` on the binary name would take the real service with it.

---

## API

All endpoints are under `/api/v1` and behind the auth middleware (v1 mode `local-single-user` is
pass-through). `GET /api/v1/health` is public so a supervisor can probe it. State-changing requests
carrying a foreign browser `Origin` are rejected with `403`. In **setup mode** everything that would
start an agent run answers `503`.

```
POST   /jobs                     upload / URL / pasted text (multi → batch)
GET    /jobs, /jobs/:id          list + detail
POST   /jobs/:id/retry           retry a failed or deferred job
POST   /jobs/:id/revert          undo one ingest: reverts its vault commit as a new commit
                                 (409 on a dirty tree, on conflict, or if already reverted;
                                 a batch shares one commit, so this undoes the batch)
DELETE /jobs/:id, /jobs          cancel a queued job / remove a settled one; clear history
GET    /events                   SSE: job updates, log streams, stats + vault invalidation
GET    /stats                    dashboard numbers, usage totals, budget
POST   /query                    read-only question against the vault (+ citations)
GET/POST/PATCH/DELETE /sessions  chat sessions
POST   /sessions/:id/save        save a chat session into the vault (async run)
GET    /pages?path=…[&full=1]    one wiki page's markdown - truncated preview, or the full
                                 page + title/type/mtime with full=1
PUT    /pages                    user edit {path, markdown, baseMtime} → write + git commit
                                 (409 when the page changed since baseMtime); returns advisory
                                 validation findings
DELETE /pages?path=…             user delete → unlink + git commit; returns staleLinks
GET    /graph                    the vault's wikilink graph: typed nodes + directed edges
GET    /domains                  the domain registry (installed? + parsed entries)
POST   /domains                  create a domain: append to the registry page, one commit
GET    /domains/candidates       themes among `unassigned` pages worth a domain (free)
POST   /domains/candidates/:key/dismiss     stop proposing this theme (DELETE undoes it)
POST   /maintenance/{lint,lint-fix,research,hot-cache,domain-backfill,domain-review,cleanup,repair}
                                 starts an async run → { id, channel }; lint-fix 409s without a
                                 report, backfill 409s without a registry, review 409s with no
                                 candidates; repair validates its task paths against the live graph
GET    /maintenance/retrieve-index   index status (provisioned?, chunk count, built-at)
POST   /maintenance/retrieve-index   (re)build it - deterministic, no credential, 409 pre-v1.7
POST   /maintenance/tag-fix      bounded tag repair from user-picked actions; one invalid
                                 action rejects the whole request
POST   /maintenance/lint-report  re-render the report from the current findings without
                                 repeating the expensive half (409 with nothing newer)
POST   /maintenance/rejoin-links rejoin links a rename split; mechanical, costs nothing and
                                 cannot invent anything (`?dry=1` reports without writing)
GET    /maintenance/research/profiles   the closed lens list + its default
GET    /maintenance/runs         runs the process still holds - "what is happening now"
GET    /maintenance/runs/:id     poll one run's result
GET    /maintenance/history      the persistent run log, newest first (`?kind=`, `?limit=`)
DELETE /maintenance/history/:id  remove one settled run from the history
GET    /maintenance/state        per-kind last-settle state behind the status head
GET    /sources                  page → the document it came from (from `.raw/` manifests)
GET    /sources/raw?path=…       one ingested document; an allow-list of formats the browser
                                 cannot execute is served inline, everything else downloads
GET    /usage/samples            the newest usage samples (`?limit=`)
GET/PUT /settings                runtime configuration
POST   /settings/credential      {kind: oauth|api-key, value} → writes the env file (0600) and
                                 restarts; never echoes the value, 409 if it comes from the
                                 process env or runs are in flight
GET    /settings/telegram        bot status + rejected senders (ids/counts, never content)
POST   /settings/telegram        {botToken, allowedUserIds} → writes BOTH and restarts
DELETE /settings/telegram        disables the bot: removes both env vars, restarts

                                 --- only with AGENTS_ENABLED; 404 without it ---
GET    /agents                   the Fellows, with tonight's schedule inputs
POST   /agents                   spawn one; PATCH /agents/:id edits tasks, quota, autonomy,
                                 model, effort, step and priority
POST   /agents/:id/{step,pause,resume,retire,plan}   act on one Fellow by hand
PUT    /agents/shelf-order       the order the night walks the shelves - one serial queue,
                                 so it is a setting and not a view preference
GET    /handoffs                 routed and unclaimed handoffs between Fellows
POST   /handoffs/:id/spawn       spawn a Fellow from an unclaimed request, prefilled
GET    /agents/:id/card          one Fellow's dossier: runs, pages, notebook path, plan
POST   /proposals/:id/{approve,veto}   decide one proposal before the night uses it
GET    /recaps, /recaps/:date    the daily record; POST /recaps/:date/answers replies to it,
                                 POST /recaps/build builds today's now
POST   /value-events             records that you opened a page or followed a recap link -
                                 what "value this month" counts
GET    /library/scene            the room as the dashboard draws it: figures, shelves, poses
GET    /wings                    the rooms and which domain sits on which shelf
GET    /usage/plan               plan utilization, the research share and what is left
GET    /reading-list             publications a run could not read, with open copies found
POST   /reading-list/ingest      file one of them; /open-access looks for a copy right now;
                                 /archive puts one out of sight, or brings it back
```

Every vault-mutating agent run is asynchronous: the POST returns a run id immediately and streams
its live log over SSE, then you poll `/maintenance/runs/:id`. A long run can never wedge the request.

`GET /pages` is deliberately narrow: the path comes from agent-produced citations, so it is confined
to `VAULT_ROOT/wiki`, must end in `.md`, and is re-checked after `realpath` so a symlink cannot
become a read primitive.

`GET /graph` derives everything from the filesystem and caches parses per file on (mtime, size),
returning the previous graph unchanged when nothing moved - a repeat request on a real vault costs
about 2 ms.

---

## Troubleshooting

**Frontend changes don't show up, or the dashboard comes up blank.** Static file routes are
registered at startup (`@fastify/static`, `wildcard: false`), so a running service keeps serving the
old asset names while the new hashed files fall through to the SPA shell: the CSS resolves, the JS
`404`s, and you get a styled empty page. Restart the service. This is not only `npm run build:web` -
**`npm run build` does it too**, which makes running the gates next to a running service enough to
blank it, and it blanks every service serving that `web/dist`, the demo instance included.

**Port 8420 already in use.** Usually an orphaned process from a killed `tsx`/`npm` wrapper:
`ss -ltnp | grep 8420`, then kill the PID. The systemd unit avoids this by running the built JS.

**Agent runs fail with a sandbox error.** `bubblewrap` or `socat` is missing, or user namespaces are
unavailable (common in containers). Install the packages rather than disabling the sandbox.

**Runs fail with "zero tokens" / "Not logged in".** The credential did not reach the subprocess.
Check `~/.config/vault-service/env` and that only one credential variable is set.

**Everything answers 503 with a "Set up now" banner.** That is setup mode. Add the credential under
System → Integrations; the service restarts itself and picks up queued work.

**The watch folder never fires.** Windows mounts deliver no inotify events; the watcher switches to
polling automatically. Force it with `WATCH_POLLING=true`.

**A page the agent wrote is missing from the commit.** The commit pathspec comes from the agent's
`Write`/`Edit` calls. A page created or renamed with `Bash` is invisible to that; the run sweeps such
pages in automatically, but only while it can prove it was the sole vault writer. Commit it by hand;
nothing is lost.

**The Telegram bot went silent.** `getUpdates conflict (409)` in the log means a second process
polled the same token (usually a dev instance next to the systemd service) and the bot stops until a
restart; `401 Unauthorized` means the token is wrong or revoked. Both stop only the bot. Remember the
fail-closed rule: a token without `TELEGRAM_ALLOWED_USER_IDS` refuses startup, and senders outside
the allowlist never get a reply - that silence is the guard working.

**Obsidian cannot open the vault over `\\wsl$`.** It can't; it fails with `EISDIR … watch`. Run
Obsidian inside WSL via WSLg. The Graph and Catalog screens exist precisely so everyday reading does
not need Obsidian at all.

---

## Status & license

A personal project (v0.1) built milestone by milestone with Claude Code. M0 to M5 built the base
product and are finished; the research agents and the source-integrity work were built on top
afterwards, as their own series (A0 to A7) with their own specifications. The engineering journals
in `docs/tasks/` are left in as-is - findings, dead ends, measurements and all - and record what is
still open as plainly as what is done. Issues and PRs are welcome, with the caveat that `SPEC.md` and
the hard rules in `CLAUDE.md` define what this is and is not.

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE) © Benjamin Steinborn. Any
noncommercial purpose is permitted: personal use, study, hobby projects, and use by charities,
schools, public research organizations and government institutions. Commercial use needs a separate
license, so open an issue if you want one.

The vault this service drives is a separate project,
[claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) by AgriciDaniel, under the MIT
license. No part of it lives in this repository: the service reads and drives a vault it never
vendors, and its license is unaffected by the one above.
