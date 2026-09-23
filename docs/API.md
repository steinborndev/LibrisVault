# API

All endpoints are under `/api/v1` and behind the auth middleware (v1 mode `local-single-user` is
pass-through). `GET /api/v1/health` is public so a supervisor can probe it. State-changing requests
carrying a foreign browser `Origin` are rejected with `403`. In **setup mode** everything that would
start an agent run answers `503`. In **demo mode** (`DEMO_MODE=1`) every request that is not a
`GET` or `HEAD` answers `403 demo_read_only` before routing; the Fellow routes exist there too when
`AGENTS_ENABLED` is set, reads only.

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
POST   /stats/commits/:hash/dismiss   take one commit off the Activity stream; DELETE puts
                                 it back. The vault keeps the commit, only the stream forgets
POST   /query                    read-only question against the vault (+ citations)
GET/POST/PATCH/DELETE /sessions  chat sessions
GET    /pages?path=…[&full=1]    one wiki page's markdown - truncated preview, or the full
                                 page + title/type/mtime with full=1
PUT    /pages                    user edit {path, markdown, baseMtime} → write + git commit
                                 (409 when the page changed since baseMtime); returns advisory
                                 validation findings
DELETE /pages?path=…             user delete → unlink + git commit; returns staleLinks
GET    /validation               the standing defect list: one row per defect with how often it
                                 has been seen and how long it has stood, not one advisory line
                                 per run (`?rule=`, `?limit=`, `?offset=`; `byRule` + `total`).
                                 Each row carries where its subject is (`subject`: a page, a job
                                 by its `.raw/` directory name, or none with the reason) and
                                 `guidance` names, per rule, what the repair is and who performs
                                 it. `?accepted=1` returns the accepted rows instead
GET    /validation/:id/evidence  what one finding is based on: the column the producer filled
                                 (a quotation and the part of it that does stand in the source)
                                 or a fresh read of the page, capped and marked where cut
POST   /validation/:id/accept    {reason} → the defect may stay; the reason is required and
                                 stored verbatim (400 empty, 404 unknown, 409 already accepted).
                                 DELETE on the same path takes it back
POST   /validation/repair/plan   {rule, ids} → what a deterministic pass would change on the
                                 pages those findings name: per page the reason, the diff and a
                                 hash of the content planned against. Read-only, no credential
POST   /validation/repair/apply  {rule, ids, pages:[{rel, beforeHash}]} → plans again and writes
                                 only the pages whose content still matches the approved hash;
                                 answers written / stale / busy apart, and one commit
POST   /validation/repair/run    {rule, ids} → one bound agent run over exactly those pages, at
                                 most 10 (503 without a credential, 409 when a Fellow's notebook
                                 is not repairable right now, 400 for a rule with no run)
POST   /validation/repair/run/:id/settle   the bookkeeping a finished fix run owes: the
                                 re-check, the quote rule's own clearing path, and the veto of
                                 proposals planned from a question that was reformulated
POST   /validation/repair/revert {commit} → undoes one fix run's commit and re-records the
                                 defect it put back (409 on a dirty tree or a conflict)
POST   /validation/repair/manifest/plan   the address map's own repair; it writes the whole
                                 file rather than a selection, and reaches no finding that names
                                 a job directory no source entry mentions. `/apply` commits it
GET    /graph                    the vault's wikilink graph: typed nodes + directed edges
GET    /domains                  the domain registry (installed? + parsed entries)
POST   /domains                  create a domain: append to the registry page, one commit
GET    /domains/candidates       themes among `unassigned` pages worth a domain (free)
POST   /domains/candidates/:key/dismiss     stop proposing this theme (DELETE undoes it)
GET    /domains/:key/split       the shelves one domain falls into (free, read-only): a consensus
                                 of 40 seeded Louvain runs over its knowledge pages and their
                                 links, shelves of 25 pages or more, each with its evidence and
                                 ranked by separability; the rest stays with the domain. 404 for a
                                 key the registry does not list, 400 for meta and unassigned; a
                                 domain under 50 pages (`eligible: false`) or one that holds
                                 together (`shelves: []`) answers 200 with its `reason`. Memoised
                                 per graph, so an unchanged vault costs one computation
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
POST   /maintenance/research/topic      {text, from?} → a research topic reformulated from one
                                 open question, with its own page as context; { topic: null }
                                 when nothing better than the bullet itself can be made of it
GET    /maintenance/runs         runs the process still holds - "what is happening now"
GET    /maintenance/runs/:id     poll one run's result
GET    /maintenance/history      the persistent run log, newest first (`?kind=`, `?limit=`)
DELETE /maintenance/history/:id  remove one settled run from the history
GET    /maintenance/state        per-kind last-settle state behind the status head
GET    /sources                  page → the document it came from (from `.raw/` manifests)
GET    /sources/raw?path=…       one ingested document; an allow-list of formats the browser
                                 cannot execute is served inline, everything else downloads
GET/PUT /settings                runtime configuration
POST   /settings/credential      {kind: oauth|api-key, value} → writes the env file (0600) and
                                 restarts; never echoes the value, 409 if it comes from the
                                 process env or runs are in flight
GET    /settings/telegram        bot status + rejected senders (ids/counts, never content)
POST   /settings/telegram        {botToken, allowedUserIds} → writes BOTH and restarts
DELETE /settings/telegram        disables the bot: removes both env vars, restarts

                                 --- only with AGENTS_ENABLED; 404 without it (demo mode: reads only) ---
GET    /agents                   the Fellows, with tonight's schedule inputs
POST   /agents                   spawn one (409 `full` once every desk in the room is taken);
                                 PATCH /agents/:id edits tasks, quota, autonomy, model,
                                 effort, step and priority
POST   /agents/:id/{step,pause,resume,retire,plan}   act on one Fellow by hand
PUT    /agents/shelf-order       the order the night walks the shelves - one serial queue,
                                 so it is a setting and not a view preference
GET    /agents/shift             the night window, the cycle, the next start, recent shifts;
                                 POST runs one now, ignoring the window (202, 409 if one is
                                 already running, 503 where no shift runs on this instance)
GET    /handoffs                 routed and unclaimed handoffs between Fellows
POST   /handoffs/:id/spawn       spawn a Fellow from an unclaimed request, prefilled
GET    /agents/:id/card          one Fellow's dossier: runs, pages, notebook path, plan
POST   /proposals/:id/{approve,veto}   decide one proposal before the night uses it
GET    /recaps, /recaps/:date    the daily record; POST /recaps/:date/answers replies to it,
                                 POST /recaps/build builds today's now
POST   /value-events             records that you opened a page or followed a recap link -
                                 what "value this month" counts
GET    /library/scene            the room as the dashboard draws it: figures, shelves, desks
POST   /library/move             put one domain's shelf in a room, optionally at a slot
GET    /wings                    the rooms and which domain sits on which shelf
PATCH  /wings/order              reorder the wings ({ids}); PATCH /wings/:id renames one or
                                 moves its aisles
GET    /usage/plan               plan utilization, the research share and what is left
GET    /usage/samples            the newest usage samples (`?limit=`)
POST   /usage/override           release one plan bound for now ({window} five_hour or
                                 seven_day, defaulting to five_hour); DELETE revokes it
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
