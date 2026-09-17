# API

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
POST   /agents                   spawn one (409 `full` once every desk in the room is taken);
                                 PATCH /agents/:id edits tasks, quota, autonomy, model,
                                 effort, step and priority
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
GET    /library/scene            the room as the dashboard draws it: figures, shelves, desks
GET    /wings                    the rooms and which domain sits on which shelf
GET    /usage/plan               plan utilization, the research share and what is left
GET    /reading-list             publications a run could not read, with open copies found
POST   /reading-list/ingest      file one of them; /open-access looks for a copy right now;
                                 /archive puts one out of sight, or brings it back
GET    /questions                every open question on every page, with what the Fellows
                                 make of it (planned tonight, being researched)
POST   /questions/archive        {page, text, archived} strikes a question through on its
                                 page, vetoing the proposal planned from it; false restores
```

Every vault-mutating agent run is asynchronous: the POST returns a run id immediately and streams
its live log over SSE, then you poll `/maintenance/runs/:id`. A long run can never wedge the request.

`GET /pages` is deliberately narrow: the path comes from agent-produced citations, so it is confined
to `VAULT_ROOT/wiki`, must end in `.md`, and is re-checked after `realpath` so a symlink cannot
become a read primitive.

`GET /graph` derives everything from the filesystem and caches parses per file on (mtime, size),
returning the previous graph unchanged when nothing moved - a repeat request on a real vault costs
about 2 ms.
