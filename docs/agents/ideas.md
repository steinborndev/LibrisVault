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

## Fork and dev instance (2026-09-05)

- This repo is the private fork: `upstream` is the public LibrisVault repo, `main` tracks
  `upstream/main`, work happens on `research-agents`. The commit-msg hook is installed
  (`scripts/install-git-hooks.sh`) because the history is merged into the public repo later.
- `scripts/dev-instance.sh` starts the second instance: port 8421, vault `~/vault-curious`
  (claude-obsidian v1.9.2 plus the synthetic demo set: 899 pages, 17 domains, 145 backdated
  commits), database and inbox under `~/.local/share/curious/`, no Telegram token, the
  shared credential file. `scripts/dev-instance.sh npm run start:prod` runs the built JS.
