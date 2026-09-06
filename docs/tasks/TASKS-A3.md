# TASKS-A3 - Expand and collaboration (2026-09-06)

Goal: a Fellow can deepen existing pages append-only under a validated page set, open
questions outside a Fellow's domains reach the Fellow whose domain it is or surface as an
unclaimed request with a prefilled spawn, and the night's plans are deduplicated across
Fellows. **Acceptance (docs/agents/SPEC.md section 15): a violating expand run is reverted;
a cross-domain question reaches the other Fellow; `npm test` green on both sides.**
**Status 2026-09-06: done.** 819 server and 283 web tests green; a real planning run routed
six foreign questions (two to a second Fellow, four unclaimed), a real expand run was
reverted by the validator and, after two validator corrections, passes offline (section 4).

Extension milestone in the Curious fork (branch `research-agents`), everything behind
`AGENTS_ENABLED=1`. Findings recorded here, spec first when the code disagrees.

## 0. Decisions while wiring A3

- **D1 - the page set.** An expand proposal names the pages it may deepen: the planner
  lists them (`pages` in its answer, from the candidate's source pages or pages it read),
  the service keeps the ones that exist, caps them at 4, and always adds the Fellow's own
  synthesis pages and its notebook. Without a single valid page the proposal is clamped to
  a `research-step`. The prompt block states the rules of section 7 verbatim: append-only,
  dated `## Update <date>` sections, never rewrite or delete body text, frontmatter
  `updated`, `related` and `tags` may change, at most 3 new pages, nothing else touched.
- **D2 - what "append-only" means to the validator.** For every page of the set the commit
  modified, the old body (after the frontmatter) must survive as a subsequence of the new
  body, line by line (blank lines and trailing whitespace ignored): insertions anywhere are
  fine, a rewritten or removed line is a violation. Frontmatter is free. Any modified or
  deleted page outside the set is a violation; bookkeeping (`wiki/index.md`, `wiki/hot.md`,
  `wiki/log.md`, `_index.md` files, `.vault-meta`) is exempt; more than 3 new pages is a
  violation. The check reads both sides from git (`git show <parent>:<path>`), so the tool
  stream and the working tree play no part in it.
- **D3 - the revert.** A violating commit is undone by a new commit that restores every
  path the commit touched to its parent's state (`git checkout <parent> -- <paths>` for
  modified and deleted files, `git rm` for added ones, one commit `revert expand <hash>`),
  inside the commit mutex. The existing `revertCommit` (the dashboard's undo) needs a clean
  tree; right after a run the tree holds the run's untracked leftovers, so the expand revert
  restores paths instead. History is never rewritten. The run settles `failed` with the
  finding; the Fellow goes to `idle` sleep with the reason rather than `blocked`, because
  the fault is in one run's output, not in the Fellow, and the planner should carry on.
- **D4 - routing is the planner's call.** The planning prompt now carries the domain
  registry (keys and descriptions) and asks the planner to name, for candidates outside the
  intent or the Fellow's domains, the registry domain they belong to (`handoffs` in its
  answer, with the candidate id and a reason). The service resolves the target: an
  unretired, unpaused Fellow whose home or extra domains carry that key (highest priority
  first, never the source Fellow); without one the handoff is `unclaimed`. A handoff with the
  same question already pending or unclaimed is not created twice.
- **D5 - handoff lifecycle.** `pending` (a candidate of kind `handoff` for the target's next
  planning run, weight 2.5), `proposed` (a proposal was built from it), `unclaimed` (no
  target; shown in the recap with a spawn offer), `expired` (older than 7 cycles). Retiring
  a Fellow turns its pending handoffs into unclaimed ones (section 5.2). Spawning from an
  unclaimed request claims it for the new Fellow (`pending` to it) and prefills name,
  intent (the question), home domain and scope (the provenance).
- **D6 - dedupe before the shift.** The shift compares the undecided proposals of all
  Fellows pairwise with the overlap tokenizer (coefficient of at least 0.6, approved ones
  never lose) and marks the later Fellow's copy `superseded` with a note; it also notes a
  proposal whose topic overlaps an existing synthesis page title (at least 0.7) without
  dropping it, because the run would update that page anyway. Both land in the shift
  summary and in the recap header.
- **D7 - recap.** The header gains the dedupe notes and the unclaimed requests, coded `u1`,
  `u2`; the dashboard shows a prefilled spawn form per request, Telegram takes
  `spawn u1 <name>` (the name is optional; the default is the domain's name plus "Fellow").
- **D8 - endpoints.** `GET /handoffs` (pending and unclaimed), `POST /handoffs/:id/spawn`
  (spawn prefilled, body may override name, model, step, autonomy, `runFirstStep`).

Findings from the real runs (section 4):

- **F1 - a manual expand step forgot the Fellow's own pages.** The planner's page set always
  carried the notebook and the synthesis pages (D1), the API's `pageSet` did not, and the
  run's mandatory open-question append to the notebook counted as an edit outside the set.
  `step()` now adds the own pages on every path.
- **F2 - the `related:` footer is frontmatter in all but position.** The vault's pages end
  with a `related: [[a]] | [[b]]` line the skill rewrites as links are added; the real run
  moved it below its update section and the validator called that a rewritten body line.
  The validator now leaves `related:` lines out of the body comparison; the rules block
  says so.
- **F3 - the revert path worked on a real commit.** The run's commit (8 files, 255 insertions,
  39 deletions, one new source page) was restored path by path in a new commit with the
  run's untracked leftovers in the tree, the run settled `failed` with both findings, and
  the Fellow went to `idle` sleep (D3). Re-checked offline against the corrected validator,
  the same commit has no finding: its three page updates were dated append-only sections.
- **F4 - a foreign gap from the demo vault's random cross-links is a useful routing test.**
  The planner named `climate-science`, `machine-learning`, `cooking` and `materials-science`
  for six gap candidates and left the Fellow's own questions alone; two reached the climate
  Fellow spawned for the test, four are unclaimed requests in the recap.

## 1. Schema, stores, planner

- [x] Migration v18: `handoffs`.
- [x] `db/handoffs.ts`: record, store (create, get, list by status and target, update,
      expire, unclaim by target).
- [x] Planner: `research-expand` as an allowed kind for `standard` and `deep`, `pages` on a
      proposal, the registry in the prompt, `handoffs` in the schema and the answer, page
      set validation and the clamp of D1.

## 2. Expand runs

- [x] `pipeline/expand.ts`: the rules block, the append-only validator over a commit reader
      (pure, tested with fixtures), the path restore revert.
- [x] Runner: `startResearchExpand`, validation after the commit, revert and `failed` on a
      violation; budget and timeout for the kind.
- [x] Fellow service: execute an expand proposal with its page set; the settle rule of D3.

## 3. Routing, dedupe, recap, spawn

- [x] Handoffs after a planning run (D4), candidates of kind `handoff` (D5), retire
      unclaims, spawn from a request claims.
- [x] Shift: dedupe before phase 1 (D6), notes in the summary.
- [x] Recap: unclaimed requests and dedupe notes in model, page, Telegram and dashboard;
      `spawn u1` answer; the dashboard's prefilled spawn form.
- [x] Routes `GET /handoffs`, `POST /handoffs/:id/spawn`; wiring.

## 4. Tests and validation

- [x] Unit tests: validator fixtures (insert ok, rewrite fails, delete fails, outside page
      fails, too many new pages fails, bookkeeping exempt), revert against a git vault with
      a fake agent that breaks the rules, planner page set and clamp, routing to a Fellow
      and to unclaimed, candidate of kind handoff, retire unclaims, spawn claims, dedupe in
      the shift, recap rendering and the spawn answer, routes; web: recap helpers.
- [x] Real validation in the dev instance: an expand run for the existing Fellow (Sonnet 5),
      validated or reverted; a second Fellow in another domain and a planning run whose
      routed question reaches it; results recorded here.
      - Routing (2026-09-06 12:14 UTC): a second Fellow "Cleo" (climate-science, no first
        run), then a planning run for the astronomy Fellow (Sonnet 5, 65 s, 0.40 USD,
        20 candidates): three research-step proposals for herself and six handoffs with
        reasons; two `pending` to Cleo, four `unclaimed` (no Fellow for those domains).
        Cleo's candidates list the two handoffs first ("... (handed off by Ada)").
      - Expand (12:16 to 12:21 UTC, `POST /agents/:id/step` with kind `research-expand` and
        three listed pages): Sonnet 5, 5.4 min, 2.34 USD, one commit with dated update
        sections on the three pages, one new source page, frontmatter links, notebook
        questions. The validator reported the notebook edit (F1) and the moved `related:`
        line (F2); the commit was reverted with `revert expand fd01ddf5` (9b28fa2), the run
        settled `failed` with both findings, the Fellow sleeps `idle` with the reason.
        Offline check of the same commit with the corrected validator: no findings.
