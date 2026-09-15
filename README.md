<p align="center">
  <img src="docs/img/logo-mark.svg" width="88" height="88" alt="">
</p>

# LibrisVault

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

Drop a PDF into a folder - a few minutes later it is a set of linked, cited wiki pages in your
personal knowledge vault.

LibrisVault is a local ingestion service and web dashboard on top of a
[claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) vault (v1.9.2, Generic mode).
It watches a folder, accepts drag-and-drop uploads and (optionally) files sent to a Telegram bot
from your phone, preprocesses the material (PDF, Office, web, images, text), and runs headless
Claude Agent SDK sessions that execute the vault's `ingest` skill fully automatically. A React
dashboard exposes intake and status, web and vault research with citations, an interactive graph
and page viewer, a browsable library of every page, and the machine room behind it all.

![Home: the vault as a shape, the domain panel, and one activity stream](docs/img/home.png)

<sub>Every screenshot on this page comes from a **synthetic** vault - textbook subject matter,
generic document titles, no real notes, people or sources. Regenerate it and re-shoot the set
with `scripts/demo-vault.mjs` + `scripts/shoot-screens.mjs` (see
[Screenshots](#screenshots)).</sub>

Everything runs on your machine: the service binds `127.0.0.1` by default, the vault stays a plain
git repository on disk, and the only thing that leaves the box is the agent's traffic to Anthropic -
plus, if you enable the Telegram bot, its outbound polling of `api.telegram.org`.

> **`SPEC.md` is the authoritative specification.** When code and spec disagree, the spec
> wins. The UI, code, and everything else are English. `CLAUDE.md` holds the hard rules that
> constrain any change. Per-milestone task lists and engineering findings live in `docs/tasks/`.

---

## Quick start (TL;DR)

**One command** (Linux, or Windows + WSL2 with Ubuntu):

```bash
git clone https://github.com/steinborndev/LibrisVault.git && cd LibrisVault
bash scripts/setup-all.sh
```

That installs everything (Node via nvm, sandbox + preprocessing toolchain, the vault,
the systemd service), starts the dashboard at <http://localhost:8420>, and leaves exactly
one step for the browser: the dashboard opens in **setup mode** and walks you through
connecting your Anthropic account (Claude subscription or API key) under
System → Integrations.

**Windows without WSL yet:** download the repo as a ZIP (GitHub: Code → Download ZIP - no
git needed on Windows), unpack it, and run `scripts\install.ps1` in PowerShell - it installs
WSL2 + Ubuntu, runs the setup above inside it, and puts a LibrisVault shortcut on your desktop.

**Manually instead:**

```bash
# 1. This repo - the service itself. It lives NEXT TO the vault, never inside it,
#    and finds the vault via VAULT_ROOT (step 4).
git clone https://github.com/steinborndev/LibrisVault.git && cd LibrisVault

# 2. The vault this service writes into (a separate repo, OUTSIDE this one).
#    Cloned from our fork, pinned to the tested version. Push is disabled:
#    the vault fills with private content, and origin is a public repo.
git clone https://github.com/steinborndev/claude-obsidian ~/vault
(cd ~/vault && git checkout -B vault-main v1.9.2 \
  && git remote set-url --push origin PUSH_DISABLED_vault_is_private \
  && bash bin/setup-vault.sh)

# 3. Sandbox + preprocessing toolchain
sudo apt-get install -y bubblewrap socat
./scripts/install-preprocessing-tools.sh

# 4. Build + run (needs Node >= 20 on PATH - see Requirements for the nvm one-liner),
#    then open http://127.0.0.1:8420 and add the credential in the UI
npm ci && npm run build
VAULT_ROOT=~/vault npm start
```

Each step is explained below; for an always-on setup see
[Autostart with systemd](#autostart-with-systemd-survives-a-wsl-restart).

---

## Requirements

What the **machine** needs - the LibrisVault repo itself is not listed because acquiring it is
step 1 of the quick start, not a prerequisite. `setup-all.sh` installs everything in this table
except the OS; the manual path below installs each row explicitly. `git` and `curl` are assumed
(both ship with the stock Ubuntu WSL image).

| | |
|---|---|
| OS | Debian/Ubuntu-family Linux (the toolchain installs via `apt`), or Windows + WSL2 (Ubuntu 24.04 is what this was built and e2e-tested on) |
| Node | ≥ 20 LTS - `setup-all.sh` installs it via [nvm](https://github.com/nvm-sh/nvm); manual: `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh \| bash`, then `nvm install 20`. Already-loaded shells: `. ~/.nvm/nvm.sh` |
| Vault | a claude-obsidian clone (**built and tested against v1.9.2**, Generic mode), by default at `~/vault`. Cloned from [our fork](https://github.com/steinborndev/claude-obsidian) and pinned to the tested tag, so upstream changes can never break a fresh install |
| Credential | a Claude subscription token **or** an Anthropic API key (exactly one) - entered in the dashboard on first run, not needed to start |
| Claude Code CLI | only for the subscription path, to run `claude setup-token` once - install with `npm install -g @anthropic-ai/claude-code` |
| Sandbox | `bubblewrap` + `socat` - **required**, agent runs fail without them |
| Preprocessing | poppler-utils, ocrmypdf, tesseract, pandoc, exiftool, defuddle, yt-dlp + deno (YouTube URLs: metadata + subtitles - yt-dlp needs a JS runtime to clear YouTube's bot check) |

### 1. The vault

The vault lives **outside this repo** and its path is a configuration value - nothing hardcodes it.

```bash
git clone https://github.com/steinborndev/claude-obsidian ~/vault
cd ~/vault && git checkout -B vault-main v1.9.2
git remote set-url --push origin PUSH_DISABLED_vault_is_private  # vault content is private; origin is public
bash bin/setup-vault.sh
```

The service checks at startup that `VAULT_ROOT` contains `wiki/` and `skills/`, so pointing it at
the wrong directory fails immediately instead of at the first agent run.

### 2. Toolchain

```bash
sudo apt-get install -y bubblewrap socat        # sandbox - not optional, see "Security model"
./scripts/install-preprocessing-tools.sh        # poppler, ocrmypdf, tesseract, pandoc, …
```

### 3. Credential

**The easy path: none needed up front.** Without a credential the service starts in **setup
mode** - the dashboard shows a "Set up now" banner and collects the key under System →
Integrations (choose Claude subscription or Anthropic API key), writes it into the service env
file, and restarts itself (under systemd). Everything below is the manual equivalent.

Exactly one credential may be configured - if both are set the service refuses to start, because
`ANTHROPIC_API_KEY` silently overrides the OAuth token and you would not know which one was billed.

```bash
npm install -g @anthropic-ai/claude-code        # once, for the setup-token command below
mkdir -p ~/.config/vault-service
claude setup-token                              # subscription path (recommended)
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "<token>" > ~/.config/vault-service/env
chmod 600 ~/.config/vault-service/env
```

The credential is read from that file (or the process environment) and is never written to the
repo, the database, the logs, or the API.

### 4. Install and build

Needs Node ≥ 20 on the PATH - see the Requirements row if you don't have it yet
(`setup-all.sh` installs it via nvm automatically).

```bash
. ~/.nvm/nvm.sh          # load nvm's node in this shell (skip if node ≥ 20 is already there)
npm ci
npm run build            # web/dist (SPA) + server/dist (runnable JS)
```

---

## Running it

```bash
VAULT_ROOT=~/vault npm start          # tsx, from source - the everyday dev command
```

Then open <http://127.0.0.1:8420>. `VAULT_ROOT` is deliberately **not** in the credential file;
pass it explicitly.

**With hot reload** (two terminals):

```bash
npm run dev:web                       # Vite dev server, proxies /api
VAULT_ROOT=~/vault npm run dev:server
```

**Production-style** (the built JS, one process - this is what systemd runs):

```bash
npm run build && VAULT_ROOT=~/vault npm run start:prod
```

### Autostart with systemd (survives a WSL restart)

```bash
./scripts/install-systemd.sh ~/vault    # writes + enables the user unit
loginctl enable-linger "$USER"          # so it runs without an active login
systemctl --user start vault-service
```

Check it, and watch the logs:

```bash
systemctl --user status vault-service
curl -s http://127.0.0.1:8420/api/v1/health
journalctl --user -u vault-service -f
```

The unit runs the **built JS as a single `node` process**, not `tsx` or `npm`, so systemd's main
PID is the server itself. A wrapper would leave an orphaned node child holding port 8420 after a
stop. `KillMode=control-group` additionally reaps any in-flight agent run's descendants with the
service. After changing code, `npm run build` and `systemctl --user restart vault-service`.

**Verifying the restart survives a reboot:** in Windows run `wsl --shutdown`, reopen WSL, then
`curl http://127.0.0.1:8420/api/v1/health` - it must answer without any manual start. On restart,
`queued` jobs resume automatically; jobs that were mid-flight when the service stopped are marked
`failed` with an "interrupted by a service restart" reason and are one-click retryable. They are
deliberately *not* replayed automatically: an interrupted ingest may have partially written the
vault, and silently replaying a mid-commit write risks vault integrity.

---

## The dashboard

**Five screens**, as tabs in the header row, all live over SSE, and a sixth when the research
agents are switched on. The order follows the day: what arrived, what you go and find out, then
what is there, then the machine room. The Library sits directly after Research and before the
two screens it contains - from a shelf you open the graph and the catalog of that one department
without leaving the room.

- **Home** - intake and everything in flight. The left rail is the control column: the dropzone
  (files, URLs, a pasted note) on top, then the filters that narrow the stream below it - by kind
  of event, by age, by state, by channel. The workspace answers two questions with two
  treatments: **the stock** on top (how many pages the wiki holds, how many links, how many
  domains, how many pages are linked but never written) with the wikilink graph beside it as a
  picture and the domain split as bars; **the flow** underneath, as a strip of operational
  figures (in flight, failures, ingests, spend today, checks due) over the activity stream they
  belong to. One stream, not one per channel: an ingest, a research run, a maintenance run and a
  vault edit are all rows in the same table, each showing the pages it produced, what it took and
  what it cost. Click a row and it opens in place with the full record - log, commit, pages, and
  the retry or revert action if it has one. A finished ingest can be **reverted** from its row:
  every ingest is exactly one vault commit, so undoing it is one click, and the undo is itself a
  commit, so it stays versioned and reversible. It refuses rather than guessing if the vault has
  uncommitted changes or the revert would conflict.

- **Research** - the screen for going and finding something out, in the two ways that means:

  | | reads | writes | cost |
  |---|---|---|---|
  | **Web research** | the web | files pages, one commit | fetches |
  | **Vault research** | only what the vault already holds | nothing | tokens only |

  Both appear as ledgers of the same shape, so a question and the record of what came back are
  one object wherever you meet them. A **lens** shapes a web run - a closed set of four profiles
  (broad sweep, state of the art, recent patents, startups & funding) that decides how it
  searches and what it files - and the composer shows the run's plan before it starts: the page
  it will file under, the fetch budget, and the step rail it will walk. Answers **stream in as
  they are written** and then settle into the finished message, citing vault pages as clickable
  chips that both deep-link into Obsidian and expand an inline preview. Conversations are named,
  resumable, and savable into the vault as a page. Underneath the ledgers, the vault's own
  **knowledge gaps** sit as a band of offers: the pages other pages link to that nobody has
  written yet, each one a research run you can start with a click.

  ![Research: two ledgers of one shape, with the vault's own gaps as a backlog](docs/img/research.png)

  A run files one synthesis page, and that page is the point of the whole screen - what the
  ledger above records is only that it happened. This one is real: it was produced by the run
  in the ledger's first row, against the demo vault, and every filing it names was read on the
  web during the run.

  ![A synthesis page a research run filed, with its findings, its sources and the limits it names](docs/img/research-result.png)

- **Library** - *only with `AGENTS_ENABLED`* (see [Research agents](#research-agents)): the
  vault drawn as a room. Domains are shelves, Fellows are figures at desks and in armchairs, and
  what each is doing right now is in the bubble over its head. One window over the room manages
  the Fellows completely: tonight's schedule as a bar priced from the runs this vault has
  actually made, a dossier per Fellow with its notebook, its slice of the recap, its run ledger
  and its settings, the decisions waiting for you, and the form that spawns a new one. The wall
  board beside it carries the hot cache, the daily recap and the reading list.

  ![The Library: domains as shelves, Fellows as figures, and what each is doing in the bubble over its head](docs/img/library-room.png)

  The main room holds the Fellows and the wall boards; the domains themselves stand in wings
  off it. A shelf is one domain, its colour is the domain's, and how full it is is how many
  pages that domain holds - so the shape of the vault is readable before a single label is.

  ![A wing: one shelf per domain, filled to the page count it holds](docs/img/library-wing.png)

  ![The command centre: tonight as one queue, priced from the runs this vault has actually made](docs/img/command-centre.png)

- **Graph** - the wikilink structure on a canvas, with the force layout in a web worker so it
  stays smooth as the vault grows (deliberately, since the WSLg Obsidian graph does not). The
  view bar carries the **colour lenses** - recolour the same graph to answer different questions:
  by `domain:` (the default, one colour per field of knowledge), by page type, or by a metric
  (authority, recency, orphans, stubs). **Overlays** add auto-detected community areas, brightened
  bridges between communities, and a spotlight that isolates one community on hover. Page-type
  pills and a domain list filter what is shown; the domain list doubles as the colour legend and
  scales to any number of domains. **Search narrows the graph** rather than just highlighting:
  a term matched over titles, tags and domains hides everything unrelated and lists every match,
  not just the first few. Structural scaffolding (index hubs, the domain registry) and maintenance
  artifacts are hidden by default so the graph shows knowledge; one toggle brings them back.
  Double-click a node to open its page, `Esc` to step back out, `/` to search, `f` to fit.

  The **page view** behind it has rendered markdown, clickable `[[wikilinks]]`, a frontmatter
  properties panel, and backlink/outgoing panels. Pages can be **edited and deleted right here** -
  every mutation is one git commit (`edit:`/`delete:`), serialized behind the same commit mutex as
  agent commits, with an optimistic lock (409 if an agent changed the page since you loaded it).
  After a delete, a banner counts the backlinks that just went dangling and offers a one-click
  reference-cleanup run. Deep-linkable: `/graph` and `/page/<path>` survive a reload and
  browser back/forward.

  ![The wikilink graph, one colour per domain, with the gaps overlay one click away](docs/img/graph.png)

- **Catalog** - the browse path a graph cannot give you: one filterable, sortable table over
  every page, fed by the same graph query the canvas uses. Filter by page type, by domain (the
  list is grouped by wing once there are enough of them), by health (with a source, orphans,
  stubs, system pages), or by what the page came from (PDF, web, text); sort by recency, title,
  type, domain, backlinks or source type. Each row
  carries the page's domain, its in/out link counts, when it changed, and a **source** column
  that opens the document the page came from - the provenance comes from the vault's own `.raw/`
  manifests rather than from the database, because losing operational state must never lose
  provenance.

  ![Catalog: one table over every page, filtered by type, domain and health](docs/img/library.png)

  *This screen was called Library until September 2026. The name moved to the room view above,
  which is what a library looks like; a catalog of pages is what this one is.*

- **System** - the machine room, in five sections:
  - **Status & checks** - what the vault needs from you right now: lint (a structured report)
    plus a separate "fix safe findings" run that automates only the report's mechanical
    categories (frontmatter gaps, stub pages, unlinked mentions, stale index entries) and leaves
    anything needing judgment alone; the hot-cache refresh; the domain registry with its backfill;
    and the governance loop below.
  - **Usage & cost** - tokens in and out, spend today and over 7 days, the daily budget as a
    meter, spend per channel, and every priced run with the dearest first.
  - **Vault stats** - pages, links, orphans, stubs, gaps and unfiled pages as figures; growth
    over 30 days; pages by type; the vault's own commit history; the retrieval index and its
    rebuild; and a check that every page under `wiki/` actually made it into git.
  - **Service & config** - watch folder, concurrency, upload limit, git auto-commit, open-access rescue, DOI dedupe, the daily budget, and (with the agents on) the research shares and reserves.
  - **Integrations** - the Anthropic credential, the Telegram bot, and the Obsidian vault name.

  ![System: vault stats - size, shape, growth and what is still unfiled](docs/img/system.png)

All page links across the dashboard open the in-app viewer first; the `obsidian://` deep link is
the secondary action on each chip. That makes the dashboard fully usable from a **Windows**
browser - Windows-Obsidian cannot open a WSL vault over `\\wsl$`, so the deep links only work
from a WSLg browser.

The graph updates **live**: while an ingest writes pages, a debounced `vault` SSE event refreshes
it, new nodes surface at their neighbours' centroid with a brief flash, existing nodes keep their
positions, and the camera never jumps.

**Domains** are the vault's meta-categories, the axis the graph filters and colours by. The
allowed list lives in the vault itself, as the editable page `wiki/meta/domains.md` - install the
seed with `scripts/install-domain-registry.sh`. Every vault-writing agent run gets that list as a
**closed** set: it files each page under one key, or under `unassigned` when nothing fits, and may
never coin a new key. New domains are created by a human editing that page (or accepting a
candidate under System → Status & checks); the rule of thumb is that five or more coherent
`unassigned` pages are what justifies one. The backfill files existing pages retroactively
(frontmatter only - it never touches page bodies).

System → Status & checks also runs the **governance loop**: it continuously (and for free) looks
for themes among the `unassigned` pages that are big enough to deserve a domain, and shows them as
candidates with their page list and a link-cohesion score. Accepting one appends it to the
registry as a single commit; rejecting one is remembered so it stops being proposed. A toggle adds
an optional agent pass that judges each candidate - new domain, belongs to an existing one, or not
a real theme - and pre-fills the proposal. That pass is read-only: only you create domains.

Every write - an ingest, a maintenance run, or a page edit - is followed by a deterministic,
read-only check of the pages it touched: missing frontmatter, dead links, orphaned pages, stale
counters, a hot cache that has outgrown its ~500-word contract. The findings are **advisory** - streamed to the run's log or shown as a banner after an
edit - never an automatic rewrite, so the vault is only ever changed by something you or the agent
did on purpose. The vault itself is never written from the browser except through those page
edits; everything else that touches it is an agent run (see the security model).

### Hybrid retrieval (optional)

The read-only chat/query path normally reads the hot cache, then the page index, then a handful
of whole pages it guesses are relevant. That loses to **chunk-level** retrieval whenever the
answer sits in one passage of a page whose title doesn't match the question. The claude-obsidian
vault ships an opt-in `wiki-retrieve` skill (contextual chunk prefixes + BM25, following
[Anthropic's contextual-retrieval method](https://www.anthropic.com/news/contextual-retrieval)),
and the service provisions and maintains its index:

- Build it once from **System → Vault stats → Retrieval index** (or `POST
  /api/v1/maintenance/retrieve-index`). It chunks every wiki page and builds a BM25 index under
  the vault's `.vault-meta/` - **derived data, kept out of vault git** and rebuildable at any
  time. The build is deterministic (no agent run, no credential needed) and stays fully
  on-machine: page bodies are chunked with a synthetic title-and-lead prefix, nothing is sent
  anywhere. It also prunes what the chunker leaves behind - chunk records of pages that shrank
  and directories of pages that were deleted - so the index never serves text the vault no
  longer contains.
- Once built, the **service** runs retrieval for each question before the agent starts and hands
  it five distinct pages, best first (chunks are over-fetched and collapsed to pages before the
  cut, and the generated root pages - index, log, hot cache, overview - take at most one of the
  five); an unbuilt (or pre-v1.7) vault silently keeps the classic read order.
- It **rebuilds itself** after ingests (a debounced maintenance run), so new pages become
  retrievable without any manual step; the card shows the chunk count and when it was last built.

**Optional local reranking - built, but off by default.** A semantic rerank can sit on top of
BM25: the question and the candidate chunks are embedded by a local [ollama](https://ollama.com)
(`nomic-embed-text`) and re-sorted by cosine similarity. It is **disabled by default**, and that
is a measurement rather than an opinion - over a 35-question labeled set BM25 alone put the right
page in the top 5 in 97% of cases against 94% with reranking, and top-1 fell from 69% to 54%.
A re-run at roughly twice the vault size held that baseline within one case (F-R14 in
`docs/tasks/TASKS-RETRIEVE.md`). Since the model reads all five returned pages anyway, reordering
inside that set bought nothing and cost a dependency. **ollama is therefore not a requirement of this service** - it appears in
no setup script and no dependency list; you only need it if you want to re-run the comparison
(`npm run retrieval-eval --workspace server -- --data <your-set.jsonl>`) on a larger vault or with
a stronger embedding model, and flip the one-line default back on if the numbers justify it.

**Why retrieval runs in the service, not in the agent.** The read-only query sandbox has no
network and no write access, and reranking needs both (reach ollama, write the embedding cache).
Rather than punching two holes in that sandbox, the service does the retrieval itself and passes
the agent a ranked list of pages to read. The agent's sandbox stays exactly as strict as it is -
and as a bonus retrieval becomes deterministic instead of depending on the model choosing to run
it. See the security model.

LLM-generated chunk prefixes (instead of the synthetic ones) are a planned follow-up; that is the
only step that would send page content off the machine, and it will stay off by default.

## Configuration

Two layers, with one deliberate precedence rule:

```
env / ~/.config/vault-service/env   →  start-time BASELINE
settings table (System → Service)   →  runtime OVERRIDES
effective value                     =  override ?? baseline
```

Clearing an override (the "Reset" button) falls back to the baseline. Overrides live in
SQLite and survive a restart.

| Variable | Default | Notes |
|---|---|---|
| `VAULT_ROOT` | - | **required**; validated at startup |
| `HOST` | `127.0.0.1` | see the bind rule below |
| `PORT` | `8420` | |
| `WATCH_FOLDER` | `/mnt/c/inbox` | the default targets a Windows mount - on plain Linux, point it at a real folder; also settable at runtime (restart required) |
| `MAX_UPLOAD_BYTES` | 200 MB | also settable at runtime (restart required) |
| `HTTP_AUTH_MODE` | `local-single-user` | `token` enables bearer auth |
| `HTTP_AUTH_TOKEN` | - | required for a non-loopback bind |
| `WATCH_POLLING` | auto | forced on for `/mnt/*` (Windows mounts have no inotify) |
| `OBSIDIAN_VAULT_NAME` | vault dir name | for `obsidian://` deep links |
| `TELEGRAM_BOT_TOKEN` | - | enables the Telegram bot (see below); a secret, same handling as the credential |
| `TELEGRAM_ALLOWED_USER_IDS` | - | comma-separated numeric Telegram user ids; **required** once the token is set |
| `DB_PATH` | `~/.local/share/vault-service/jobs.db` | kept **outside** the vault |
| `AGENTS_ENABLED` | off | `1` turns on the research agents (see below); off means the service behaves exactly as it did before |
| `DEMO_MODE` | off | `1` serves the vault strictly read-only for a public instance: every non-read request is refused, nothing that writes or spawns an agent starts, no credential needed |
| `PREPROCESS_SANDBOX` | on | `off` runs the document converters without their bubblewrap jail. Only for a machine that cannot install bubblewrap; it removes a boundary that stands between a hostile document and your files |

With the research agents on, **System → Service & config** gains their settings: the research
share of the five-hour and weekly windows with the reserves under them, the plan's name, the
optional five-hour release and the duplicate judge. The night window and everything that belongs
to one Fellow - its runs-per-day quota, model, effort level and autonomy mode - are set where
that Fellow lives, in the Library's command centre and dossier. All of these are runtime
settings like the ones below, not environment variables.

Runtime-settable under System → Service & config, in the order the screen shows them: watch
folder, concurrency, upload limit, the four research share and reserve keys, the plan name, the
five-hour release, the duplicate judge, git auto-commit, open-access rescue, DOI dedupe and the
daily budget. Everything but two applies live; the watch folder and the upload limit are bound at
startup and are flagged "Restart required" rather than pretending they took effect.

The bind address is **not** settable through the UI, by design. The credential is settable -
but only through the dedicated guarded endpoint that writes the env file (setup mode /
"Replace credential"), never through the settings table, and it is never displayed or stored
anywhere else.

### Daily budget

Optional. The unit follows the auth mode, because the two modes constrain different things:

- **Subscription (oauth):** a **job count per day**. There is no per-run charge; runs compete with
  your interactive Claude usage for the same limits.
- **API key:** a **USD amount per day**.

When the budget is reached the queue stops claiming new work (in-flight runs always finish) and
resumes at the next local midnight. In subscription mode every `cost_usd` shown in the UI is
labelled **"estimate (subscription)"** - it is an API-price equivalent, not money charged.

---

## Research agents (optional, off by default)

<a name="research-agents"></a>

A **Fellow** is a standing research agent. You give it a subject, one to three standing tasks and
a budget; it works at night on its own and leaves a record you read in the morning. It is not a
chat and not a one-off run: it keeps a notebook page in the vault, it plans from what the vault
itself says is unanswered, and it comes back to the same subject night after night.

Off unless you turn it on:

```bash
echo 'AGENTS_ENABLED=1' >> ~/.config/vault-service/env
# then restart the service
```

With the flag unset, nothing of this exists: no schedule, no routes, no Library tab, and no
request to any of it. The service behaves exactly as it did before.

**What a Fellow does with a night.** Once the night window opens (01:00 to 06:00 by default), a
planning run reads what the vault holds - the open questions on its own pages, link targets
nobody has written, stub pages, what your recent ingests brought in - and proposes concrete runs
against one of its standing tasks. Each proposal carries its reasoning, where the idea came from
and on which page you can read it, a score for how close to the task it stays, and an estimated
cost. Then the runs themselves: read the sources, write or extend pages, update the notebook.

**A task has an art.** `watch` looks for what is new on a subject, `explore` pursues an open
question until the vault has it covered, `deepen` builds out pages the library points at more
than they pay off. Three per Fellow at most: at one run a day, a longer list starves its own
tail, and a fourth subject is a second Fellow.

**You decide how much say you want.** In `manual` nothing runs without your click. In `veto` -
the default and the interesting one - a proposal you did not decide on RUNS; deciding is how you
stop something or move it to the front, not how you permit it. In `auto` you are not asked at
all. The morning **recap** is where the decisions are: a page per day, per Fellow, with what the
night did and what it wants to do next, answerable in the dashboard or by Telegram reply.

**The budget is a share of your subscription, not a pile of money.** Runs are priced in plan
utilization measured against the runs this vault has actually made, not against constants, and a
Fellow stops at whichever binds first: its runs-per-day quota, the daily budget, or the research
share of the five-hour and the weekly window. The shares have reserves under them, so the
autopilot cannot spend the capacity you want for your own work.

![The morning recap: what each Fellow did last night, what it found, and what it wants to do next](docs/img/recap.png)

The same night reads two ways. Above is the wall board, which keeps the whole of it; below is
one Fellow's dossier, which keeps everything about one - its notebook, its ledger, its settings
and the decisions it is waiting on.

![One Fellow's dossier: its night, what it found, the questions it raised, and whether you used any of it](docs/img/fellow-dossier.png)

And the same recap appears on Home, which is where a morning actually starts.

![Home in night-shift view: the Fellows down the left, the night's figures across the top, and the decisions in the feed](docs/img/home-night.png)

**Where the work shows up.** In the vault as ordinary pages, written by ordinary agent runs
behind the same commit mutex as an ingest, so `git revert` undoes a night like it undoes
anything else. In the dashboard as the **Library** screen (see above). And in one page per
Fellow under `wiki/meta/agents/`, which is the Fellow's own notebook: its log, its plan and its
running list of open questions.

Details, including the planner's candidate sources, the scheduling and the quota arithmetic:
[`docs/agents/SPEC.md`](docs/agents/SPEC.md), summarised in SPEC.md section 12.10.

---

## Source integrity

Five mechanisms that harden how material is acquired and read, and one that limits what a
research run may do to an existing page. Unlike the research agents these are **not** optional
and not behind a flag: each one corrects the pipeline rather than adding something beside it,
and a correctness fix behind a flag would ship the weaker path as the default.

- **A URL that serves a PDF is read as one.** Detection is by what comes back, not by what the
  address looks like, so a link that redirects to a PDF no longer arrives as a page of
  navigation furniture.
- **Everything a converter produces is fenced as data.** Text extracted from a document reaches
  the agent inside an explicit boundary that says it is material to read and never instructions
  to follow, and text inside it that addresses an assistant is reported to you rather than
  passed on quietly. This is the prompt-injection boundary, at the one place every ingest
  crosses.
- **A blocked or abstract-thin page is rescued from a legal open copy.** When a URL lands on a
  paywall and the page names a DOI, the service asks three open scholarly indexes whether a
  legal open-access copy exists, fetches it if so, and records on the resulting page which copy
  the text came from. This makes outbound requests of its own - see the security model.
- **Quotes are checked against the text the run actually read.** A quotation an ingest writes is
  compared verbatim against the job's own source text and the record says how many held. A quote
  that cannot be found is flagged, not deleted: the run may have quoted a caption the extraction
  dropped, and a checker that deletes is worse than one that reports.
- **A deepening run is confined while it runs** (the *expand lock*). It may only touch the pages it was given and
  may only insert, enforced at tool time rather than only at the commit, with the commit check
  and an automatic revert still underneath as the backstop.

One part of this rides along with the research agents and therefore needs the flag: the nightly
**reading-list sweep**, which re-checks publications nobody could read for an open copy and marks
them so you can ingest the copy with one click.

![The reading list: what the Fellows could not read, with the open copies the sweep found](docs/img/reading-list.png)

Details: [`docs/sources/SPEC.md`](docs/sources/SPEC.md), summarised in SPEC.md section 12.11.

---

## Telegram bot (optional)

A phone-first input channel (SPEC.md §4.3): send the bot a PDF, a photo, a URL or a plain-text
note and it lands in the regular ingestion queue; when the ingest finishes, the bot reports back
with the created page titles. `/status` answers with queue, job and budget state, `/jobs` lists
recent jobs, and `/research <topic>` starts a web research run that files the result into the
vault and reports the created pages back.

The transport is **outbound long polling** - the service calls `api.telegram.org`, nothing calls
the service. No port is opened, the localhost bind stays untouched, and it works from anywhere
your phone has internet, without Tailscale or a reverse proxy.

Setup:

1. **Create a bot:** talk to [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`,
   pick a name and username. BotFather answers with the bot token.
2. **Find your numeric user id:** message a bot like `@userinfobot`, which replies with your id.
   (Usernames don't work here - they are mutable and spoofable; the allowlist wants the number.)
3. **Configure** - either in the dashboard under **System → Integrations → "Set up Telegram
   bot…"** (writes the env file for you and restarts the service under systemd), or by editing
   `~/.config/vault-service/env` directly:

   ```bash
   TELEGRAM_BOT_TOKEN=123456789:AAF...
   TELEGRAM_ALLOWED_USER_IDS=111111111        # comma-separated for several people
   ```

4. **Restart** - the dashboard path does this itself under systemd; after hand-editing the
   file (or when running via `npm start`, where there is no supervisor to restart into) run
   `systemctl --user restart vault-service` / re-run `npm start`. Then send the bot `/status`.

Behavior and limits:

- **Allowlist, fail-closed.** A token without `TELEGRAM_ALLOWED_USER_IDS` refuses startup.
  Messages from ids outside the list get **no answer at all** - by design, a reply would
  confirm the bot exists, and every accepted message can start a paid agent run. The service
  journal still records the first attempt per sender id (id and username, never the message
  content), so probing - or your own mistyped id - is visible to you.
- **Files up to 20 MB.** Telegram lets bots download at most 20 MB (senders may attach up to
  2 GB); larger files get a hint pointing at the dropzone or the watch folder.
- **`/research` is the one bot action that reaches the web.** It runs the same web-egress
  autoresearch flow as the dashboard (the only flow allowed the web, see the security model);
  every other bot message ingests material you send and stays confined like a normal ingest.
- **Albums become one batch.** Files sent together as an album are ingested in a single
  combined run, like a multi-file drop in the dashboard.
- **Notifications carry titles only.** The completion message names the created wiki pages,
  never their content - vault content does not transit Telegram's cloud. (The file you *send*
  does, like any Telegram upload; that is your call as the sender.)
- **Exactly one poller per token.** Telegram allows a single `getUpdates` consumer; if a second
  instance polls the same token (typically a dev run next to the systemd service), the bot logs
  the conflict and stops - the service itself keeps running.
- **Setup mode:** `/status` answers (and says so); ingests are refused with guidance until a
  credential is configured.
- **Disabling:** System → Integrations → "Disable" removes both variables from the env file
  (and restarts the service under systemd); the token itself is never displayed anywhere after
  saving - revoke it via BotFather if it may have leaked.

---

## Security model

Six constraints are essential. They are documented in full in `CLAUDE.md`; do not weaken them.
`SECURITY.md` has the full threat model - including what a malicious *document* can and cannot make
the ingest agent do - and the vulnerability reporting channel.

1. **Vault integrity.** Everything the service writes to the vault is one immediate git commit
   behind a shared mutex, so it is versioned, revertable, and can never interleave with an agent's
   own commit. Four paths write, and only these four: an agent run; a page you edit or delete
   yourself in the dashboard; the vault's own deterministic retrieval-index scripts, which produce
   only rebuildable artifacts outside git history; and the removal of a never-committed staging
   directory when a job turns out to be a duplicate. Pipeline code never rewrites vault content on
   its own. SQLite holds operational state only - losing the database must never damage the vault.
2. **Localhost guard.** The server binds `127.0.0.1`. If the bind is not loopback and no auth mode
   with a token is active, it **refuses to start**. State-changing requests carrying a foreign
   browser `Origin` are rejected, so a malicious website cannot fire drive-by requests at the
   loopback port.
3. **Credentials** live only in the service environment - never in the repo, logs, frontend or
   database. Both credential variables set at once is a startup error.
4. **Agent confinement is enforced by the OS sandbox**, not by application-level callbacks. Runs
   execute under bubblewrap with writes confined to `VAULT_ROOT`, and an **ingest** run has no web
   egress at all. Tool policy additionally runs through a `PreToolUse` hook. `canUseTool` was
   measured to be invoked *zero* times by this SDK and is not the enforcement point.
   Which runs *may* reach the web: the autoresearch flow, and a research agent's own runs when
   they are enabled. Which never do: an ingest, and a Fellow's planning run, which is deliberately
   confined to what the vault already holds.
5. **Plugin internals stay read-only.** The vault is a clone of claude-obsidian, so its own
   machinery (skills, scripts, the shipped reference docs its skills consult by path) sits inside
   the sandbox's writable area. A `PreToolUse` write guard confines agent writes to the knowledge
   areas (`wiki/`, `.raw/`, …) and refuses edits to plugin files, so an ingest can extend the
   vault but never rewrite the tool it runs on.

6. **The document converters are jailed too, one stage earlier.** `pdftotext`, `pdfinfo`,
   `ocrmypdf`, `pandoc`, the Office extractors, `exiftool` and `defuddle` each run under
   bubblewrap with no network, no `$HOME`, a read-only system, the one input file and one
   writable output directory. This is the same reasoning as item 4 applied one step sooner: a
   hostile document reaches a parser *before* any agent sees it, and a parser with a
   memory-safety bug is a more likely way in than a prompt. `yt-dlp` is the documented exception,
   because fetching is its job. Verify with `npm run preprocprobe`, which runs the real tools
   against real canaries and expects 14 checks and "PASS - the jail holds".

Because the sandbox is the real boundary, it is configured with `failIfUnavailable: true`: if
bubblewrap is missing or cannot start, an agent run **fails loudly** instead of silently running
unconfined. That is why `bubblewrap` and `socat` are hard requirements.

A stuck agent run cannot outlive its timeout either: the runner owns the CLI spawn, puts it in its
own process group, and escalates a timeout to a group `SIGKILL` - otherwise an aborted run leaves
its `bash`/`python3` descendants running, which is what once made a lint outlive its 15-minute
timeout by six minutes.

Both guarantees rest on SDK behaviour that unit tests structurally cannot observe, so each has a
live probe. Re-run them after any change to the permission/spawn wiring or an SDK upgrade:

```bash
# Is our guard still consulted at all? Expects both canaries blocked -
# outside the vault, and inside the plugin's skills/ (constraints 4 and 5).
VAULT_ROOT=~/vault npm run permprobe --workspace server

# Does a stuck tool really die with the run? Expects: PASS … descendants were reaped
# Point this at a THROWAWAY vault - it runs write-enabled (see the script header).
VAULT_ROOT=/tmp/throwaway-vault npm run killprobe --workspace server

# Does the converter jail hold? Expects 14 ok lines and "PASS - the jail holds".
# Read-only and safe to run against the real vault; it only tries to reach it.
npm run preprocprobe
```

**Outbound requests the SERVICE makes, as opposed to an agent.** Two, and both are worth knowing
because "no web egress in an ingest run" is a statement about the agent and not about the
service. The Telegram bot talks to Telegram, if you configure one. And open-access recovery asks
`api.openalex.org`, `api.core.ac.uk` and `www.ebi.ac.uk` whether a legal copy of a paywalled
paper exists, sending the DOI of the document you are ingesting. That one is **on by default**;
turn it off under System → Service if you would rather no third party learn which papers you
file.

---

## Docker

The image exists so the service can move to an always-on Linux host later (SPEC.md §12.2); under
WSL the systemd unit above is the day-to-day path.

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

Verified on Docker Desktop 4.52 / Engine 29.0.1 (linux/amd64): the image builds, ships bubblewrap
+ socat and the full preprocessing toolchain, `better-sqlite3` loads across the build/runtime
stage boundary, and the service starts as PID 1 and serves both the API and the SPA.

Four things to know:

- **Publishing the port requires a token.** The localhost guard is not relaxed inside a container:
  to reach the service from outside you must set `HOST=0.0.0.0` **and** `HTTP_AUTH_MODE=token` +
  `HTTP_AUTH_TOKEN`, otherwise the service refuses to start (verified - it exits with a
  configuration error). Without them the container serves only on its own loopback.
- **Pass the credential as an environment variable here.** The dashboard's first-run setup flow
  needs browser access, which token mode (below) denies - so in a container the credential comes
  from `-e CLAUDE_CODE_OAUTH_TOKEN=…` (or `-e ANTHROPIC_API_KEY=…`), as in the example above.
  The same applies to the Telegram bot: pass `-e TELEGRAM_BOT_TOKEN=…` and
  `-e TELEGRAM_ALLOWED_USER_IDS=…` (the settings endpoints deliberately refuse with `409` when
  these come from the process environment, and the container-internal env file is not on a
  volume anyway). The bot's outbound polling works from inside the container without extra
  network configuration.
- **In token mode the browser UI is not reachable, only the API.** The auth middleware protects
  everything except `/api/v1/health`, including the SPA itself, so a browser gets a `401` before it
  can load the page that would ask for a token. `curl -H "Authorization: Bearer <token>"` works
  fine. A login screen is explicitly future work (SPEC.md §12.1, the auth "Ausbaustufe"); until it
  exists, use the container for API/headless operation and the systemd path for browser use.
  (`--network host` would sidestep this on a native Linux daemon by binding the host loopback
  directly, but under Docker Desktop the container joins the Docker VM's network namespace instead,
  so it does not help here - measured.)
- **bubblewrap needs unprivileged user namespaces.** Depending on the host and daemon configuration
  the container may need `--security-opt seccomp=unconfined` (as above) or, on restrictive hosts,
  `--cap-add SYS_ADMIN`. If the sandbox cannot start, agent runs fail with a clear error - by
  design - so a failing ingest with a sandbox message means this, not a broken vault.

**Bind-mounting your real vault:** the container runs as uid 10001, so a bind-mounted host
directory owned by your user is readable but not writable by agent runs. Pass
`--user "$(id -u):$(id -g)"` when you need the container to write into a host-mounted vault.

---

## Development

```bash
npm test                 # server + web unit tests (vitest) - agent runs are mocked
npm run typecheck        # server + web
npm run lint             # server (eslint)
```

Layout:

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

Conventions: TypeScript strict, ESM, conventional commits. Pipeline logic (queue transitions,
dedupe, preprocessing, guards) gets unit tests; agent runs are mocked. New source types are added
as preprocessing plugins, never as special cases in the pipeline core. `npm test` must pass before
a milestone is called done.

A green `tsc` + `vite build` + test run says nothing about whether a screen actually *renders*
anything - a shared component that always returned an element once blanked all five screens while
every check stayed green. `scripts/probe-screens.mjs` opens every screen in a headless browser and
reports what came up:

```bash
~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome --headless --disable-gpu --no-sandbox \
  --remote-debugging-port=9333 --user-data-dir=/tmp/probe-profile about:blank &
node --experimental-websocket scripts/probe-screens.mjs
```

### Screenshots

The images in this README are shot from a **synthetic vault**, so nothing private is ever
published and the whole set can be re-shot whenever the UI changes:

```bash
# 1. Build a throwaway vault (~900 pages over 18 domains, backdated git history)
node scripts/demo-vault.mjs

# 2. Serve it on a spare port. TELEGRAM_BOT_TOKEN= is REQUIRED: without it this process picks
#    the real token out of the service env file and knocks the real bot off it (Telegram
#    allows exactly one poller per token).
#    WATCH_FOLDER matters too: the default is the real inbox, and two services watching one
#    folder race each other for whatever lands in it. AGENTS_ENABLED=1 because half the
#    screens are the Fellows'.
cd server && VAULT_ROOT=~/.local/share/vault-service/demo-vault \
  DB_PATH=~/.local/share/vault-service/demo-jobs.db PORT=8422 \
  AGENTS_ENABLED=1 WATCH_FOLDER=/tmp/demo-inbox \
  CLAUDE_CODE_OAUTH_TOKEN=demo-not-a-real-token TELEGRAM_BOT_TOKEN= \
  node dist/main.js &

# 3. Shoot the screens at 2x into docs/img/ (thirteen of them; BASE_URL must match the port)
BASE_URL=http://127.0.0.1:8422 node --experimental-websocket scripts/shoot-screens.mjs
```

The generator invents everything it writes - textbook subject matter, document titles with no
authors, no real people or organisations - with **one deliberate exception**: the research runs
are real. Four of them were run against this demo vault, cost real money and searched the actual
web, and `scripts/capture-research-run.mjs` froze each into `scripts/demo-research/` so the
generator can restore it. A synthesis page is what the research function produces, and an
invented one shows a shape where the real one shows an argument; the difference is the whole
point of the screen, so it is not a thing to fake. Those pages name real papers, real patents and
real companies, all of them public, and none of them from anyone's private notes.

Two things the generator deliberately does NOT do: make the vault small, or make it tidy. It is sized like a real one (~900 pages, ~4,500 links, one domain far deeper
than the rest, a long tail of one-afternoon detours) because the graph, the domain filters and
the library only show what they are for at that scale; and it leaves stubs, unfiled pages and
knowledge gaps in, because a wiki without them is not a wiki anyone has actually used. Pages are
dated in reading order rather than build order - subjects interleave, the way they do when a
person reads - so "recently changed" is a mix and the growth curve has a shape.

Subject matter lives in `scripts/demo-vault-topics.mjs`; add a domain there and it flows into
every screen. Stop the demo process by PID when you are done - a `pkill` on the binary name would
take the real service with it.

## API

All endpoints are under `/api/v1` and behind the auth middleware (v1 mode `local-single-user` is
pass-through). `GET /api/v1/health` is public so a supervisor can probe it. State-changing requests
carrying a foreign browser `Origin` are rejected with a `403` - a website you visit cannot drive
the service behind your back. In **setup mode** (no credential yet) everything that would start an
agent run answers `503` until the credential is entered.

```
POST   /jobs                     upload / URL / pasted text (multi → batch)
GET    /jobs, /jobs/:id          list + detail
POST   /jobs/:id/retry           retry a failed or deferred job
POST   /jobs/:id/revert          undo one ingest: reverts its vault commit as a new commit
                                 (409 on a dirty tree, on conflict, or if already reverted;
                                 a batch shares one commit, so this undoes the batch)
DELETE /jobs/:id, /jobs          cancel a queued job / remove a settled one from history; clear history
GET    /events                   SSE: job updates, log streams, stats + vault invalidation
GET    /stats                    dashboard numbers, usage totals, budget
POST   /query                    read-only question against the vault (+ citations)
GET/POST/PATCH/DELETE /sessions  chat sessions
POST   /sessions/:id/save        save a chat session into the vault (async run)
GET    /pages?path=…[&full=1]    one wiki page's markdown - truncated preview, or the full
                                 page + title/type/mtime with full=1
PUT    /pages                    user edit {path, markdown, baseMtime} → write + git commit
                                 (409 when the page changed since baseMtime); returns advisory
                                 validation findings for the edited page
DELETE /pages?path=…             user delete → unlink + git commit; returns staleLinks
                                 (backlinks that now dangle, drives the lint banner)
GET    /graph                    the vault's wikilink graph: typed nodes + directed edges
GET    /domains                  the vault's domain registry (installed? + parsed entries)
POST   /domains                  create a domain: append to the registry page, one commit
GET    /domains/candidates       themes among `unassigned` pages worth a domain (free)
POST   /domains/candidates/:key/dismiss     stop proposing this theme (DELETE undoes it)
POST   /maintenance/{lint,lint-fix,research,hot-cache,domain-backfill,domain-review,cleanup,repair}
                                 (cleanup takes {pages, mode: 'deleted'|'gap'}: after a deletion,
                                 or to unlink open graph gaps picked on Home)
                                 starts an async run → { id, channel }; lint-fix 409s without a
                                 report, backfill 409s without a registry, review 409s with no
                                 candidates; repair validates its task paths against the live graph
GET    /maintenance/retrieve-index   retrieval index status (provisioned?, chunk count, built-at)
POST   /maintenance/retrieve-index   (re)build the retrieval index - deterministic, no
                                 credential (works in setup mode), 409 on a pre-v1.7 vault
POST   /maintenance/tag-fix      bounded tag repair from user-picked drop/merge actions;
                                 every named tag must exist in the live graph, and one
                                 invalid action rejects the whole request
GET    /maintenance/research/profiles   the closed lens list for the composer + its default
GET    /maintenance/runs         runs the process still holds - "what is happening now"
GET    /maintenance/runs/:id     poll one run's result
GET    /maintenance/history      the persistent run log, newest first - "what has happened"
DELETE /maintenance/history/:id  remove one settled run from the history
                                 (`?kind=research`, `?limit=`)
GET    /maintenance/state        per-kind last-settle state behind the status head
GET    /sources                  page → the ingested document it came from (built from the
                                 vault's `.raw/` manifests, not from SQLite)
GET    /sources/raw?path=…       one ingested document; an allow-list of formats the browser
                                 cannot execute is served inline, everything else downloads
GET/PUT /settings                runtime configuration
POST   /settings/credential      first-run onboarding: {kind: oauth|api-key, value} → writes
                                 the service env file (0600) and restarts; never echoes the
                                 value, 409 if the credential comes from the process env or
                                 runs are in flight
GET    /settings/telegram        bot status + rejected non-allowlisted senders (ids/counts,
                                 never message content, never the token)
POST   /settings/telegram        {botToken, allowedUserIds} → writes BOTH env vars together
                                 and restarts; same rules as /settings/credential
DELETE /settings/telegram        disables the bot: removes both env vars, restarts

                                 --- only with AGENTS_ENABLED; 404 without it ---
GET    /agents                   the Fellows, with tonight's schedule inputs: measured run
                                 durations and prices, the shelf order, the shift's status
POST   /agents                   spawn one; PATCH /agents/:id edits tasks, quota, autonomy,
                                 model, effort, step and priority
POST   /agents/:id/{step,pause,resume,retire,plan}   act on one Fellow by hand
GET    /agents/:id/card          one Fellow's dossier: runs, pages, notebook path, plan
POST   /proposals/:id/{approve,veto}   decide one proposal before the night uses it
GET    /recaps, /recaps/:date    the daily record; POST /recaps/:date/answers replies to it
GET    /library/scene            the room as the dashboard draws it: figures, shelves, poses
GET    /wings                    the rooms and which domain sits on which shelf
GET    /usage/plan               plan utilization, the research share and what is left of it
GET    /reading-list             publications a run could not read, with open copies found
POST   /reading-list/ingest      file one of them; /open-access looks for a copy right now
```

Every vault-mutating agent run (lint, lint-fix, autoresearch, hot-cache, reference cleanup, graph
repair, and saving a chat session) is asynchronous: the POST returns a run id immediately and
streams its live log over the SSE channel, then you poll `/maintenance/runs/:id`. A long run can
never wedge the HTTP request.

`GET /pages` is deliberately narrow: the path comes from agent-produced citations (and from
client-side routes), so it is confined to `VAULT_ROOT/wiki`, must end in `.md`, and is re-checked
after `realpath` so a symlink cannot become a read primitive.

`GET /graph` derives everything from the filesystem and caches parses per file on (mtime, size),
returning the previous graph unchanged when nothing moved - a repeat request on the real vault
costs about 2 ms.

## Troubleshooting

**Frontend changes don't show up after a rebuild - or the dashboard comes up blank.** The
static file routes are registered at startup (`@fastify/static` with `wildcard: false`), so a
running service keeps serving the old asset names while the new hashed files fall through to the
SPA shell: the CSS still resolves, the JS `404`s, and you get a styled empty page rather than an
error. Restart the service (`systemctl --user restart vault-service`). This is not only
`npm run build:web` - **`npm run build` does it too**, which makes running the four gates next to
a running service enough to blank it, and it blanks every service serving that `web/dist`, the
demo instance included.

**Port 8420 already in use.** Usually an orphaned process from a killed `tsx`/`npm` wrapper:
`ss -ltnp | grep 8420`, then kill the PID. The systemd unit avoids this by running the built JS
directly.

**Agent runs fail with a sandbox error.** `bubblewrap` or `socat` is missing, or user namespaces
are unavailable (common in containers). This is the sandbox refusing to run unconfined - install
the packages rather than disabling the sandbox.

**Runs fail with "zero tokens" / "Not logged in".** The credential did not reach the subprocess.
Check `~/.config/vault-service/env` and that only one credential variable is set.

**Everything answers 503 and a "Set up now" banner is showing.** That is setup mode: no credential
is configured, so nothing that would spawn an agent is allowed to run. Add it under
System → Integrations; the service restarts itself and picks up any queued work.

**The watch folder never fires.** Windows mounts (`/mnt/*`) deliver no inotify events; the watcher
switches to polling automatically. Force it with `WATCH_POLLING=true`.

**A page the agent wrote is missing from the commit / `git status` shows an untracked page.**
The commit pathspec is derived from the agent's `Write`/`Edit` tool calls. A page it creates or
renames with `Bash` is invisible to that; the run sweeps such pages in automatically, but only
while it can prove it was the sole vault writer - with a second run in flight the sweep is skipped
rather than risk filing the page under the wrong job. Commit it by hand; nothing is lost.

**The Telegram bot went silent.** Check the service log: `getUpdates conflict (409)` means a
second process polled the same bot token (usually a dev instance next to the systemd service) -
the bot stops permanently until a restart; `401 Unauthorized` means the token is wrong or was
revoked in BotFather. Both stop only the bot, never the service. Also remember the fail-closed
rule: a token **without** `TELEGRAM_ALLOWED_USER_IDS` refuses startup, and senders outside the
allowlist never get a reply - that silence toward the sender is the guard working, not a bug.
The journal logs the first attempt per sender id (`dropped message from non-allowlisted telegram
user …`), which is also how you spot your own mistyped id.

**Obsidian cannot open the vault over `\\wsl$`.** It can't - Obsidian for Windows fails with
`EISDIR … watch`. Run Obsidian inside WSL via WSLg instead; the vault stays on ext4. (The Graph
and Library screens exist precisely so that everyday reading and editing does not need Obsidian
at all.)

---

## Status & license

A personal project (v0.1) built milestone by milestone with Claude Code; the engineering journals
in `docs/tasks/` are left in as-is - findings, dead ends, measurements and all. M0 to M5 built the
base product and are finished; the research agents and the source-integrity work were built on
top of it afterwards, as their own series (A0 to A7) with their own specifications, and their
journals sit in the same folder. Those files record what is still open as plainly as what is
done, which is the point of keeping them. The specification
(`SPEC.md`) is English since 2026-09-05, as are code, UI, and vault content. Issues and PRs are welcome, with
the caveat that `SPEC.md` and the hard rules in `CLAUDE.md` define what this is and is not, and
that contributions are accepted under the license below.

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE) © Benjamin Steinborn. Any
noncommercial purpose is permitted: personal use, study, hobby projects, and use by charities,
schools, public research organizations and government institutions. Commercial use needs a
separate license, so open an issue if you want one.

The vault this service drives is a separate project, [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian)
by AgriciDaniel, under the MIT license. No part of it lives in this repository: the service reads
and drives a vault it never vendors, and its license is unaffected by the one above.
