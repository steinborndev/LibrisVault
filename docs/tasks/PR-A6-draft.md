# Pull request draft (TASKS-A6 section 9)

The text below is what the merge into LibrisVault opens with. It describes mechanisms, never a
vault subject (hard rule 7), and was read against the vault-name scan before it was written
down here. Paste it; do not paraphrase from memory at the last minute.

**Opened and merged on 2026-09-17** as steinborndev/LibrisVault#13, merge commit `d3c393e`, tag
`research-agents-2026-09-17`. The text below is what was pasted.

---

**Title:** Research agents behind a flag, source integrity in the pipeline, and the Library as a room

**Body:**

This merge brings the work of the `research-agents` series (A0 to A7) into the base product. It
is large by line count and small by surface: two subsystems, each with its own specification,
one of them behind a flag.

**Research agents ("Fellows"), behind `AGENTS_ENABLED`.** A Fellow is a standing research agent
with a home domain, one to three standing tasks, a notebook page in the vault and a budget. It
plans from what the vault itself says is unanswered, works at night on a serial queue, and leaves
a daily recap. With the flag unset none of it exists: no service is constructed, no route is
registered, `health.fellows` is `false`, and the dashboard neither renders a Fellow surface nor
requests a route only they own - `server/test/agents-flag-off.test.ts` pins the route half of
that. Detail: `docs/agents/SPEC.md`, summarised in `SPEC.md` 12.10.

**Source integrity, not behind a flag.** Five corrections to how material is fetched and read -
a URL that serves a PDF is read as one, converter output is fenced as data before any agent sees
it, a paywalled DOI is rescued from a legal open copy, quotes are checked against the text the
run read, and a deepening run may only insert into the pages it was given. Each corrects the
existing pipeline, and a correctness fix behind a flag would ship the weaker path as the default.
Detail: `docs/sources/SPEC.md`, summarised in `SPEC.md` 12.11.

**The Library screen.** The vault as a room: domains as shelves, Fellows as figures at desks of
their own, three boards on the wall, a book cart that opens System, and a pinboard of every open
question the vault's pages left behind, from which a question is handed to the Research tab or
struck through on its own page. The tabular view that used to be called Library is now
**Catalog**; nothing behaves differently, but the tab is renamed, and that belongs in the
release notes.

**The graph, and the screens around it.** The graph gained a lock: a padlock in the canvas's
corner holds the picture on screen, one click on a node then opens its page, and Escape brings
the held picture back from a page, a filter change, another tab or a reload (sessionStorage,
one sitting). Every search a bar or a head carries now folds behind a magnifier with one
mechanic - on the graph, in the Catalog, in the Research ledgers and on Home: `/` opens it,
Escape clears the text and then folds it, folding clears the text. The Catalog's control column
took the graph's shape (type rows in the type's colour, sort as paired strips, the reset in the
column), Home lost the six lead facts under its headline, and the three screens share one
bucket label map. `web/DESIGN.md` records the rules.

**What a reviewer should know first.**

- **Network.** Open-access recovery makes outbound requests of the service's own to
  `api.openalex.org`, `api.core.ac.uk` and `www.ebi.ac.uk`, sending the DOI of the document
  being ingested, and it is on by default; a setting turns it off. This is service egress, not
  agent egress: "no web egress in an ingest run" stands. The Fellows' own runs reach the web; a
  planning run never does.
- **Vault writes.** Hard rule 1 gains one user-initiated write path beside the page editor: the
  pinboard's strike-through of an open question (`POST /api/v1/questions/archive`), one commit
  behind the shared mutex under the vault's per-file lock, confined to the bullet's own lines.
  Every service writer of a wiki page now takes that per-file lock first.
- **Schema.** The migrations are one-way. A vault that upgrades and later wants the previous
  release cannot run the old binary against the same database; keep a copy of `jobs.db`.
- **Dependencies.** The series adds **no server dependency**: `server/package.json` differs from
  `main` only by the package name and new probe scripts. The web workspace gains lint tooling
  only (`eslint`, `typescript-eslint`, the React hooks and refresh plugins, `globals`,
  `@eslint/js`). Upstream's dependency patch set (fastify 5.12.3, qs 6.16.0, vitest 4.1.11, the
  PostCSS tooling) is merged in and the lockfile re-resolved on top of it.
- **Gates.** `npm test`, `npm run typecheck` and `npm run lint` are green and exit 0 under
  vitest 4.1.11; CI runs all three plus the build. The permission probe was re-run after the
  sandbox wiring was last touched and reports the canary outside the vault blocked; the
  preprocessing probe passes.
- **Screenshots** come from a synthetic vault (`docs/screenshots.md`); the four captured research
  runs under `scripts/demo-research/` are real runs against that vault, on public subjects
  chosen for it.

**Size.** 401 commits, 436 files, about 74k lines added and 4k removed. The commit messages are
the design record and were audited twice for private content; the engineering journals in
`docs/tasks/` are merged as they are, findings and dead ends included.

**Not in this merge.** The multi-vault work stays a planned extension (`SPEC.md` 12.1). The
design artboards under `docs/agents/design/` show the room as first designed and are kept as
that record.
