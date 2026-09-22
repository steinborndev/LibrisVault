# Tasks: a path out of the standing defect list (2026-09-21)

The standing defect list (SPEC.md §12.16) ended the failure it was built to end: the validator
no longer writes 406 advisory lines into job logs that nobody reads. It replaced them with 57
rows on the System screen, each naming a real defect, sorted loudest first.

And there it stops. The list is a reporter with no actor. `validator.ts` is read-only by design
(hard rule 1), and §12.16 says repair is "an agent run's job or the user's" - but for the second
half of that sentence, the user, the dashboard offers not one action. The rows are `<span>`s.
There is no link to the page, no way to fix, no way to accept, and no way to see the evidence a
finding is based on. Of the nine rules currently standing, six are classified as needing
judgement, which means "a person decides" - and the person has been given a list and nothing
else.

This file covers four changes, in five phases, each with its own definition of done and its own
tests. Phase 5 is the user's own acceptance pass and nothing ships before it.

**The phases are development stages of ONE merge, not four releases.** They are ordered so each
is reviewable on its own, and every one of them is reachable from the phase before it, but the
branch lands once. That is what makes 1.4's "fixable" block honest: it is defined by passes and
runs that phases 3 and 4 introduce, and between phase 1 and phase 3 it is a heading over rows
with no button. On the branch that is a half-built screen, which is fine. Shipping it would be a
list promising a path that does not exist, which is the failure this file is named after.

**Read first:** `SPEC.md` §12.16 (the standing list), §12.15 (the form of an open question),
§12.4 (who may write to the vault), `CLAUDE.md` (hard rules 1, 4, 7, 8),
`docs/tasks/TASKS-VAULT-LAYER.md` phases 5 and 8 (where the list and the repair passes come
from). Where this file and a spec disagree, the spec wins; say so and ask before deviating.

**Reviewed against the code on 2026-09-21, before any of it was built.** The review read every
factual claim below against the module it names and measured the repair passes against the live
vault. It found eight claims that would have led the implementation astray and a dozen smaller
ones that were half true. All of them are corrected in place, each with the file and line that
decides it, and the paragraphs headed **Measured** are what the dry runs actually returned. Read
those before trusting a number in a design note: two of the six passes this file originally
exposed turned out to repair nothing at all.

**Public repo (hard rule 7).** Everything below describes mechanism, never subject. No page
title, person, organisation or handle from the vault appears here, and none may appear in a
commit message or PR body produced from this file. Run `scripts/vault-name-scan.mjs --diff
<base>` over the added lines and `--file` over any PR body before posting. Note the third blind
spot in particular: this work puts vault TEXT on the screen (quote evidence, page excerpts), so
screenshots and pasted run output are read by eye.

---

## 0. The measurement

Taken 2026-09-21 against the live service (`127.0.0.1:8421`, vault `~/vault`), through
`GET /api/v1/validation` so the numbers describe exactly what the screen shows. Re-taken during
the code review the same day: identical, row for row.

| Rule | Findings | Occurrences | Classified | Fix path today | What a pass would actually reach |
|---|---|---|---|---|---|
| `open-question-form` | 15 | 17 | judgement | none reachable from the list | no pass can exist (phase 4) |
| `tag-singleton` | 14 | 31 | judgement | `tagSingletonPass` exists, CLI only | 26 pages vault-wide |
| `quote` | 9 | 11 | judgement | none at all | no pass can exist (phase 4) |
| `near-duplicate` | 6 | 6 | judgement | none, and merging is forbidden everywhere | none, by decision 7 |
| `page-schema` | 5 | 5 | judgement | none | no pass can exist (phase 4) |
| `address-map` | 4 | 72 | mechanical | lint-fix prompt, needs a fresh lint report | **nothing**: see below |
| `run-protocol` | 2 | 2 | judgement | `runProtocolPass` exists, CLI only | 1 page vault-wide |
| `em-dash` | 1 | 12 | mechanical | `emDashPass`, CLI, and the lint-fix prompt | 2 pages vault-wide |
| `title-name` | 1 | 1 | mechanical | `titleLinkPass` repairs the links, not the name | **nothing**: see below |
| **Total** | **57** | **157** | | | |

Where they stand: 33 on `wiki/concepts/`, 7 on `wiki/sources/`, 6 on `wiki/entities/`, 4 on
Fellow notebooks under `wiki/meta/agents/`, 4 on `.raw/<job-id>/` directories (no page at all),
2 on `wiki/questions/`, 1 on `wiki/log.md`. 17 of the 57 have been seen more than once.

**Measured 2026-09-21, the last column, by dry-running each pass over the live vault**
(`npm run vaultrepair -- --pass <name>`, read-only by default):

```
tag-singleton   26 page(s) would change      against 14 findings
em-dash          2 page(s) would change      against  1 finding
run-protocol     1 page(s) would change      against  2 findings
tag-mirror       0 page(s) would change      against  0 findings
title-link       0 page(s) would change      against  1 finding
address-map      0 to add, 0 stale to drop, 0 to retire; 4 job directories reported, never repaired
```

Three of those numbers change what this file can promise, and each is handled where it belongs:

  - **`title-link` reaches nothing, ever.** `titleLinkPass` edits the pages that LINK to a
    drifted title, never the page the `title-name` finding stands on
    (`pipeline/repair.ts:1097`, built from `d.linkedFrom`). It is not exposed (task 3.1).
  - **The manifest repair reaches none of today's four `address-map` findings.** All four name
    a `.raw/<job-id>/` directory that no source entry mentions (`pipeline/validator.ts:937`),
    and `planManifestRepair` reports that class and repairs none of it on purpose: what a
    directory held is not derivable from the directory (`pipeline/repair.ts:531`). See task 3.6.
  - **A filtered plan leaves a tail.** 12 of the 26 `tag-singleton` pages and 1 of the 2
    `em-dash` pages carry a defect the validator has never looked at, so the list never showed
    them and task 3.2 does not write them. They will surface as NEW findings the first time a
    run touches those pages. See task 3.2.

**Six of 57 are mechanically classified**, and even those reach a fix only if someone first runs
a lint (`startLintFix()` throws without a report, `maintenance.ts:749`). `renderStandingDefects()`
is the only consumer of the list that leads to a REPAIR; two others read it without acting on it
(`api/routes/validation.ts:25`, which feeds the screen, and `pipeline/standing-recheck.ts:46`,
which re-reads the pages it names). Nothing in the UI says any of this.

The list also shows at most 50 rows: the UI asks `limit: 50` (`web/src/tabs/System.tsx:332`) and
the client has no `offset` parameter (`web/src/api/client.ts:135`), so 7 of today's 57 are not
reachable at all. The route already accepts `?offset=` and caps at 200
(`api/routes/validation.ts:22-23`); only the client is missing it. And `deriveMaintenanceStatus`
knows seven areas (`web/src/lib/maintenanceStatus.ts:18`), none of them the defects, which is
why "What's due" says *Everything healthy* above 57 standing defects.

Reproducing this table is task 0.1, and every later definition of done compares against it.

- [x] **0.1** `scripts/defect-measure.mjs`, read-only, aggregates only.
      `node scripts/defect-measure.mjs` prints rule, findings, occurrences, the repair path and
      the bucket distribution from the live API (`--api <base>` to point it elsewhere, `--json`
      to diff two runs). **Re-measured 2026-09-21 against 8421: identical to the table above,
      row for row** - 57 findings, 157 occurrences, the same nine rules, the same seven
      buckets, 17 seen more than once.
      **The repair-path column reads `unknown` against a service running the OLD code**, and
      that is the honest answer rather than a second copy of the classification: the script
      takes it from `guidance` in the API response (`pipeline/defect-paths.ts`, exhaustive over
      the rule union at compile time), so a table built from a copy kept in the script would
      drift the first time a rule lands. Against a service running this branch the column
      fills.
- [x] **0.2** The same script, `--passes <vault>`, which runs the repair CLI in its default
      dry-run form and parses its counts. **Re-measured 2026-09-21 against `~/vault`, all six
      identical to the block above**: `em-dash` 2, `tag-mirror` 0, `tag-singleton` 26,
      `run-protocol` 1, `title-link` 0, `address-map` 0 to add / 0 stale / 0 retired with 4 job
      directories reported.

---

## 1. The decisions this file implements

Taken 2026-09-21 with the user, in five rounds. Recorded here because the reasoning is not
recoverable from the code afterwards. Four of them were corrected the same day, by the code
review, and the correction is in the row.

| # | Decision | Why not the alternative |
|---|---|---|
| 1 | **Every defect gets a path**: fixable, acceptable, or explained and linked | A list that cannot be emptied becomes the 406 job-log lines again, one layer up. **Corrected:** "fixable" is **46 of 57** after the measurement (17 through a pass, 29 through a run) against the **51** the first draft implied, and the other 11 are explained-and-linked: `near-duplicate` 6 by decision 7, `address-map` 4 and `title-name` 1 because no pass reaches them |
| 2 | **Repair passes become reachable from the dashboard**, plan first, diff, then confirm | The passes exist and are tested; keeping them in a hand-CLI means the dashboard user never sees them. Hard rule 1 gains **two** writer rows (task 3.8), not one: the page repair and the manifest repair commit separately |
| 3 | **Accept is permanent and needs a reason** | A snooze only postpones the reading; an accept without a reason is indistinguishable from neglect six months on |
| 4 | **The actions live in the list on System**, rows expand | One place. A separate screen adds a tab to a navigation that was just cleaned up |
| 5 | **Both units**: "fix this" per row, "fix all N" per rule chip | The list shows rows, the passes work in classes; the user works in both |
| 6 | **A bound agent run** for `open-question-form`, `quote`, `page-schema` | These three name a defect whose repair needs reading, and no deterministic pass can ever produce it |
| 7 | **`near-duplicate` gets no run** | Merging is forbidden everywhere; a run that only cross-references pre-empts the decision it cannot make |
| 8 | **The diff is per page selectable, and the approval is of a diff** | `planRepair` already returns edits one by one, `applyRepair` takes a filtered list. **Corrected:** the apply re-plans server-side, which would make `applyRepair`'s own stale check unreachable, so the approval carries a per-page hash of the `before` it was given (task 3.3) |
| 9 | **Three blocks: fixable, your decision, accepted** | The first question a person has is "what can I get rid of without thinking", and the rule chips never answered it. **Corrected:** built from a third classification beside the rule union, NOT by widening `MECHANICAL_RULES` (task 1.4) |
| 10 | **A bound run writes exactly the page of its finding** | The narrowest scope guard in the repo; a bad run costs one commit on one page |
| 11 | **Bundling only within one rule, at most 10 pages** | Same shape as the existing caps (tag-fix 20 at `api/routes/maintenance.ts:230`, graph repair 10 at `:185`, 40 findings in the lint-fix prompt at `maintenance.ts:483`) |
| 12 | **Fixable = due, the rest = soon** in "What's due" | What costs a click should be nagged about; what costs a decision should not be red for weeks |
| 13 | **A reformulated question is a NEW question** | The text IS the identity (`questionKey`); the proposal it fed gets vetoed, exactly as archiving does. **Corrected:** the old text has to be snapshotted BEFORE the run, because that is what the proposal is matched by (task 4.6) |
| 14 | **A notebook finding is fixable only while its Fellow is idle** | See §2: pausing does not protect the window that matters, and resume is not symmetric. **Corrected:** and only where the repair lands in a section the notebook renderer preserves, or the next notebook write undoes it |
| 15 | **A bound run writes directly, the diff comes after, with revert** | `revertCommit` exists for ingests; a two-step proposal for an agent result would be a second proposal system |
| 16 | **Quote evidence is written down when the finding is made** | `checkQuotes` has the source text in memory; reading a PDF artifact again per row expansion costs a converter run and fails when the original is local-only. **Corrected:** it computes the LENGTH of the longest match, not its text, and the nine standing quote findings need a backfill (tasks 1.2, 1.3) |
| 17 | **Failed fixes are counted; from the third, the row says so** | A run that finishes without fixing anything is invisible today and costs tokens on every click. **Corrected:** only where the re-check can actually clear the finding, which for `quote` it cannot (task 4.8) |

**What this file deliberately does NOT build:** a merge path for `near-duplicate`; a snooze; a
Fellow pause mechanism (§2); an inline page editor in the defect row (the deep link goes to the
existing page views); a second home for the repair passes that have no defect rule
(`overviewPass`, `bucketRegroupPass`, `log-archive`, the demo passes stay CLI); a vault-wide
sweep from the dashboard (that stays `cli/vaultrepair.ts`, task 3.2).

---

## 2. Why there is no Fellow pause

Asked during the design round, and worth recording because the answer is not obvious.

**The lock already covers data integrity.** `notebook.write()` takes the vault's per-file lock
and reads the file INSIDE it (`notebook.ts:225`), renders, and writes under the commit mutex.
`Open Questions` is carried over verbatim (`notebook.ts:117`). Any writer of ours takes the same
lock (hard rule 1, mandatory since 2026-09-16), so there is no lost-update window.

**Pause would not close the window that matters.** `pause()` sets `state: 'paused'`
(`fellows.ts:1836`), which blocks two things: starting new runs (409, `fellows.ts:812`) and the
night shift's `active()` filter. It does not stop a run in flight, and there is no abort path for
Fellow runs anywhere in the module. The one genuinely awkward moment, a Fellow working on the
very question being reformulated, would stay unprotected.

**And resume is not symmetric.** It does not restore the previous state; it sets `waiting` (with
pending proposals) or `sleeping` with "resumed; the planner runs in the next night shift"
(`fellows.ts:1844`). Restoring properly would mean storing the prior state, waiting for
non-abortable runs, and a recovery path so a crashed fix run does not leave every Fellow paused
forever.

**So the guard is narrower and cheaper:** a notebook finding is fixable only while that one
Fellow has no run in flight (`inFlight` knows this, `fellows.ts:398`). One Fellow, no new state,
no recovery path.

**The second half of the guard, found by the code review.** The lock makes a notebook write
atomic; it does not make a repair to a notebook DURABLE. `renderNotebook` regenerates the page
from the run records and preserves exactly four sections verbatim: Intent, Scope, Open Questions
and Notes (`notebook.ts:85`, `:117`, `:147`). Plan and Log are rendered fresh on every write. So
a repair that lands outside those four sections is silently undone by the Fellow's next notebook
write, whatever the locking did. The condition is therefore two-part and task 4.5 states both:
the Fellow has no run in flight, AND the finding's repair lies in a preserved section. A
`page-schema` or `run-protocol` finding on a notebook fails the second half and stays a decision.

---

## Phase 1: the list becomes navigable

No schema change except the evidence column, no new writer, no agent run. After this phase the
list answers three questions it cannot answer today: where is it, what does it say, and who is
supposed to do something about it.

- [x] **1.1 Every row links to its subject.** A `wiki/**` path links to the page (the existing
      `PageLink` / Catalog article view, plus `obsidianUri` from `web/src/lib/obsidian.ts`).
      A `.raw/<job-id>/` path links to the job **by the directory name**, which IS the job id
      (`queue.ts:601`), never by `last_job_id`.
      **`last_job_id` is not the job the finding is about.** It holds whichever run last
      REPORTED it (`db/validation.ts:99`), which is a maintenance run's id when a maintenance
      run last validated the page (`maintenance.ts:1632`) and `null` when the `rejoin-links`
      route did (`api/routes/maintenance.ts:122`). Measured 2026-09-21 over the live list: 18
      of 57 rows carry a 36-character maintenance run id rather than a 26-character job id, only
      39 of 57 resolve to a job that still exists, none of the four `.raw/` rows has a
      `last_job_id` equal to its own directory, and only one of those four directory names still
      has a job row. So: link when the id resolves, show `last_job_id` as provenance ("last
      reported by") and never as a link target, and say "the job history no longer holds this
      run" rather than rendering a dead link.
- [x] **1.2 A row expands and shows the evidence.** Per rule, what the reader needs to judge it:
      - `quote`: the quotation in FULL as the page has it (the message carries only its first 80
        characters, `quotes.ts:53`), and the longest run of its own words that does stand in the
        source. Today only the LENGTH of that run is computed (`longestRun`, `quotes.ts:160`),
        and the corpus it is found in is a normalised lowercase word stream (`quotes.ts:118`),
        so the source's own rendering is not recoverable. `checkQuotes` returns the matching span
        of the QUOTE's words beside its length, and the row says "matched: <span>" rather than
        claiming to show the source.
      - `near-duplicate`: the second page, with a link (the message already names it,
        `queue.ts:1748`)
      - `page-schema`: the headings the page HAS, against the ones its type requires
        (`REQUIRED_HEADINGS`, `validator.ts:518`)
      - `tag-singleton` / `tag-mirroring`: the tag, and what it would mean to drop it
      - `open-question-form`: the offending bullets of that page, from `parseQuestionBullets`
        (the message counts them and names none, `validator.ts:568`)
      - everything else: the relevant lines of the page
      The excerpt comes from the server so the browser never reads the vault directly. Cap it
      (600 characters per excerpt) and mark where it was cut.
- [x] **1.3 Migration 34: `evidence TEXT NULL` on `validation_findings`.** Filled by
      `checkQuotes` (which has the source text in memory) and by the validator for rules whose
      evidence is not recoverable from the page alone.
      **`record()` updates it as `evidence = COALESCE(excluded.evidence, evidence)`**, NOT the
      way `message` is updated (`db/validation.ts:100`): a producer that has no evidence must not
      erase what one that had it wrote.
      **And a backfill, or the column is empty where it matters most.** A row is only rewritten
      when a run re-reports it, and `quote` is re-reported only by an ingest of the same job with
      the same artifact (`queue.ts:1700`), which in practice never happens again. So all nine
      standing quote findings would keep `evidence = NULL` forever, and the "fall back to reading
      the page" path cannot produce the longest match at all - that needs the source. One-off
      backfill: for each standing quote finding, re-run `checkQuotes` over its `last_job_id`
      (measured: all nine carry a real 26-character job id) with `gitPageBefore` over that job's
      `commit_hash`. Other rules fall back to the page as planned.
      **Check the migration number when you get here.** 34 was free on 2026-09-21
      (`db/migrations.ts` ends at 33); if something else landed first, take the next one. A
      shipped migration is never edited.
- [x] **1.4 Three blocks instead of one list.** "Fixable" (a deterministic pass or a bound run
      exists for this rule), "your decision" (everything else), "accepted" (phase 2, empty until
      then). The rule chips stay as a filter underneath.
      **This is a THIRD classification and must not be built by widening the existing split.**
      `MECHANICAL_RULES` / `JUDGEMENT_RULES` (`maintenance.ts:447`, `:458`) answer a different
      question: what a lint-fix agent prompt may be told about (`renderStandingDefects`,
      `maintenance.ts:488`). The two axes cross. `tag-singleton` and `run-protocol` are judgement
      rules WITH a pass; `open-question-form`, `quote` and `page-schema` are judgement rules that
      phase 4 gives a run; `frontmatter`, `dates` and `wrapped-link` are mechanical rules that
      get no button here. Widening `MECHANICAL_RULES` would put judgement calls into an agent
      prompt, which `server/test/lint-fix-routing.test.ts:32-41` exists to prevent.
      So: one `Record<ValidationRule, RepairPath>` exported beside the rule union in
      `validator.ts`, values `'pass' | 'run' | 'decision'`, a compile error when a rule is added
      exactly as `RULE_KEYS` (`validator.ts:1092`) already is. The mechanical/judgement split is
      untouched, its exhaustive test stays, and a new test asserts the two classifications
      disagree only where they are meant to.
- [x] **1.5 Every rule says what is to be done and by whom.** A table in the server (one line
      per rule, exported next to the rule union in `validator.ts` so a new rule cannot be added
      without one) that the UI renders under the expanded row: what the repair is, who performs
      it (button, agent run, you), and what it costs. A second `Record<ValidationRule, …>` beside
      1.4's, in the same module: 1.4 classifies the PATH, this one carries the TEXT. It states
      the honest limits measured above rather than the intended ones: `title-name` says "rename
      the file and its title together, then rewrite the links", `run-protocol` says the pass
      reaches five of the seven headings, and a `.raw/` `address-map` row says why no repair can
      invent a provenance record.
      Both records live in one new module, `pipeline/defect-paths.ts`, which imports the rule
      union from `validator.ts` and is re-exported by nothing: `validator.ts` is imported by the
      queue, the maintenance runner, the pages route and the standing re-check, and pulling
      `repair.ts` (and with it `hubs.ts` and `domains.ts`) into all four for a lookup table is a
      cost with nothing behind it. The compile-time exhaustiveness is unaffected by where the
      record lives.
- [x] **1.6 The list loads past 50.** `offset` in the API client, "show more" in the UI. The
      route already supports it and caps at 200 (`api/routes/validation.ts:22-23`), and the badge
      already shows the true total because `total` is summed from the unfiltered `byRule`
      (`api/routes/validation.ts:26-28`): both stay as they are.
- [x] **1.7 "What's due" learns about defects.** A new `MaintAreaId`: fixable findings make it
      `due` (a click, no tokens), findings needing a decision make it `recommended`, accepted
      ones count nowhere, and no findings at all is an explicit `healthy` item.
      `deriveMaintenanceStatus` stays a pure function; the hook feeds it the counts from the
      existing query.
      **The jump needs a home first.** `onJump(anchor)` sets a view INSIDE `Maintenance`
      (`web/src/tabs/Maintenance.tsx:96`, `:121`) and the defect card is a sibling rendered by
      `System` (`web/src/tabs/System.tsx:213-214`), so a `defects` item would blank the
      maintenance area and jump nowhere. **Recommended: move the card into Maintenance's card
      set** as `card-defects`, so `showCard` (`web/src/tabs/Maintenance.tsx:96`) drives it like
      every other tool and the jump costs no new machinery; lifting the view state into `System`
      is the same outcome through a refactor of two components. Decide it before building and
      write the decision here, because everything in 1.7 and 3.7 hangs off which one it is.
      And `StandingDefects` returns null at zero findings (`web/src/tabs/System.tsx:336`), so the
      healthy item either renders the card as an explicit "nothing standing" or carries no anchor
      at all. `buildRunPlan` (`web/src/lib/maintenanceStatus.ts:371`) is an explicit if-chain and
      ignores an unknown area, so the guided run does not offer defect repairs; that is
      deliberate, and it is written down here so the next reader does not take it for an
      oversight.
      **DECIDED 2026-09-21: the card moved into Maintenance's card set** as `card-defects`, the
      recommended option. `showCard` drives it like every other tool and the jump costs no new
      machinery. **The trade, written down because it is a visible change and not only a
      refactor:** the list used to render unconditionally at the foot of System -> Checks and now
      renders only when a status item is clicked or "All tools" is open. What makes that not a
      loss is the item itself - the head now NAMES the defects with a count and a severity, which
      it never did, so the list went from always visible and never mentioned to one click away
      and always mentioned. `StandingDefects` no longer returns null at zero: it renders the
      explicit "nothing standing", the same way the healthy item reads.
- [x] **1.8 Flag-off check (hard rule 8).** The whole phase is base product. Nothing added here
      may query a Fellow-only route; extend the `UNGATED` control group in
      `server/test/agents-flag-off.test.ts:79-88` for any route added.

**DoD (countable, not "understood"):** all 57 rows resolve to a link target or say why they
cannot; all nine standing rules render a guidance line; the expanded row shows a non-empty
evidence block for every rule whose evidence is derivable from the page, and for the nine quote
rows after the backfill of 1.3; the 51st row is reachable; "What's due" names a defects item,
with `AGENTS_ENABLED` both on and off, and no longer says *Everything healthy* while defects
stand.

**DoD MET on the branch; the counted half is verified end-to-end in phase 5 against the
throwaway copy, because it is the live list that has 57 rows.** What holds here:

  - **22 of 22 rules carry a path and a guidance line**, enforced at compile time by
    `Record<ValidationRule, …>` and asserted at runtime against `ALL_RULES`
    (`server/test/defect-paths.test.ts`). Nine of them are the rules standing today; the other
    thirteen were classified in the same pass rather than left to be discovered.
  - **Every row resolves or says why it cannot**: `resolveSubject` returns `page`, `job` (with
    whether the history still holds it) or `none` with a reason, over the three shapes a stored
    path can have. No fourth shape exists - a stored path is `wiki/**.md`, `.raw/<job-id>/`, or
    something whole-vault.
  - **The 51st row is reachable**: `offset` in the client, "Show more" in the UI, tested against
    a 57-row store.
  - **"What's due" names the defects**, `due` when a repair is waiting, `recommended` when only
    decisions are left, an explicit `healthy` at zero, and omitted while loading. The area is
    base product and its query carries no `enabled` guard, because the route answers with the
    flag off (hard rule 8 runs the other way here).

**What became clear while building, that the task file did not say:**

  - **The guidance had to be SERVED, not mirrored.** 1.4 and 1.5 put the two records in the
    server, and the UI needs both. Copying them into the web bundle would have been a second
    classification with no compile-time tie to the rule union - exactly the drift 1.4 exists to
    prevent, one layer out. So `GET /api/v1/validation` carries `guidance` in its response, and
    `useMaintenanceStatus` splits the counts by the SAME record the card renders from, which is
    why the head and the blocks cannot disagree about what is fixable.
  - **There is no deep-linkable job route in this app, and 1.1 needs one.** A job is opened from
    Home's own event list, which is windowed by day and by `limit`, so an old `.raw/` job is not
    in it. Added: `?job=<id>` on Home, which fetches that ONE job by id (`GET /jobs/:id`, which
    already existed), folds it into the activity list and opens its record on the day it belongs
    to. Small, and the alternative was a link that works only for jobs inside the window.
  - **`longestRun` had to grow a sibling, not change.** 1.2 asks for the matching SPAN beside the
    length. `longestRun` is exported and tested, so `longestMatch` now computes both and
    `longestRun` delegates: no test changed, and the caller that needed the span got it.
  - **The backfill must NOT go through `record()`.** 1.3 says to re-run `checkQuotes` per standing
    finding, and the obvious way to store the result is `record()`. That would bump `count`, move
    `last_seen` and rewrite `last_job_id` on nine rows, and resurrect any that had been resolved -
    a backfill reporting itself as nine fresh sightings. So the store grew `setEvidence(id, …)`,
    which fills only a NULL and moves nothing else, and the CLI matches its re-check back to the
    row by `findingIdentity` rather than by position.

**Tests:** the rule-to-path and rule-to-guidance tables are exhaustive over the rule union (a
compile error, not a runtime one, when a rule is added); the two classifications are asserted
against each other; evidence renders for a finding with and without the new column; `record()`
does not erase an existing evidence value when a later run reports the finding without one;
paging returns the 51st row; `deriveMaintenanceStatus` returns due/recommended/healthy for the
three input shapes; the flag-off control group still passes.

---

## Phase 2: accept, with a reason

- [x] **2.1 Migration 35: `accepted_at TEXT NULL`, `accepted_reason TEXT NULL`.** Separate from
      `resolved_at`: resolved means the defect is gone, accepted means it may stay. A row can be
      accepted and later resolved (someone fixed it anyway); the accept is what keeps it off the
      list in the meantime.
- [x] **2.2 `record()` must not resurrect an accepted finding.** Today the upsert sets
      `resolved_at = NULL` on every repeat (`db/validation.ts:101`), which is right for
      resolution and wrong for acceptance: the next run would put every accepted defect straight
      back on the list. The accept survives repeats; only an explicit un-accept clears it.
      **This is the load-bearing line of the phase** and gets its own test.
      **It is also the only such line, which the review confirmed rather than assumed.**
      `resolveMissing` only ever SETS `resolved_at` (`db/validation.ts:204`), `recheckStanding`
      calls nothing but `resolveMissing` (`standing-recheck.ts:54`), there is no
      `DELETE FROM validation_findings` anywhere in `server/src`, and nothing resets the table at
      startup. So `record()` is the whole of it.

      **FINDING, 2026-09-21, while building: the mechanism this task names is the wrong one, and
      building it as written introduces a bug. The GUARANTEE is right and is delivered; the
      implementation differs, and here is exactly why.**

      The task says the fix is to stop `record()` clearing `resolved_at` for an accepted row.
      That only follows if acceptance is expressed THROUGH `resolved_at`. Task 2.1 puts it in
      its own column, and task 2.3 makes `list()` and `countsByRule()` filter on
      `accepted_at IS NULL` as well. With those two in place a repeat cannot put an accepted
      finding back on the list however `resolved_at` moves, because the list never looks at an
      accepted row at all. The upsert touches `accepted_at` nowhere, so the accept survives a
      repeat by construction.

      And making `record()` preserve `resolved_at` for an accepted row is actively wrong in one
      reachable sequence, the one 2.1 names in its own text ("a row can be accepted and later
      resolved"): accept a finding, let a run genuinely repair the page so `resolveMissing` sets
      `resolved_at`, then let the defect come back so `record()` reports it again. The defect is
      standing. With the clearing preserved the row keeps `resolved_at`, and the moment the
      accept is taken back the finding stays hidden as "resolved" while it stands on disk - a
      list reporting a repaired defect, which is the failure §12.16 exists to end, running the
      other way. With the clearing left as it is, the un-accept puts it back where it belongs.

      **Resolution taken, pending the user's word:** `record()` keeps `resolved_at = NULL` on
      every repeat, unchanged. The guarantee 2.2 asks for - an accepted finding is never
      resurrected by a report - is delivered by 2.3's filter and is tested exactly as 2.2 asks
      ("accept then `record()` the same finding twice, it stays off the list and its count still
      rises"), plus a second test over the accept-resolve-return sequence above. Nothing else in
      the phase changes. **This is recorded rather than quietly built around; say if you want the
      other reading and it is a two-line change.**
- [x] **2.3 `list()` and `countsByRule()` exclude accepted findings** by default and can return
      them on request (`?accepted=1`), so the third block and the chip count come from the same
      store.
      **Two consequences of that default, both wanted and both written down here so neither
      reads as a bug later:** an accepted MECHANICAL finding stops reaching the lint-fix prompt,
      because `renderStandingDefects` builds it from `list()` (`maintenance.ts:488`); and its
      page stops being re-read by the standing re-check unless something else on it still stands,
      because that pass takes its path set from `list()` too (`standing-recheck.ts:46`).
- [x] **2.4 `POST /api/v1/validation/:id/accept`** with a required, non-empty reason (trimmed,
      capped at 500 characters, stored verbatim), and `DELETE` on the same path to take it back.
      404 on an unknown id, 409 on an already-accepted one. Base product, registered
      unconditionally, added to the `UNGATED` list in
      `server/test/agents-flag-off.test.ts:79`.
- [x] **2.5 The third block.** Collapsed, headed "accepted (N)", each row with its reason and
      date and a way back. Accepted findings count in no badge and in no "What's due" item.

**DoD:** a finding can be accepted with a reason, survives the next validator run without
returning, is visible with its reason in the collapsed block, and can be un-accepted. The badge
and the chips agree with the blocks.

**DoD MET**, all five parts tested in `server/test/defect-accept.test.ts` and
`web/test/defectList.test.ts`: accept with a reason (400 on an empty or whitespace one, 404 on
an unknown id, 409 on one already accepted, capped at 500 characters); survives two further
`record()` calls with its count still rising to 3; visible with its reason through
`?accepted=1`; un-accepted back into its block; and `countsByRule()` plus the total both
exclude it, which is what makes the badge and the chips agree with the blocks by construction
rather than by care.

**What became clear while building, that the file did not say:**

  - **Task 2.2's mechanism was the wrong one** - see the finding recorded in the task itself.
    The guarantee is delivered; the implementation differs, and the difference is tested.
  - **The accepted block must live OUTSIDE the `total === 0` branch.** A vault whose standing
    list is empty *because* everything was accepted would otherwise lose the record exactly
    when it matters most - the screen would read "nothing standing" with no way to see what was
    decided.
  - **The accepted rows need their own query.** They are excluded from every other one by
    construction, which is the point of 2.3, so `?accepted=1` is fetched only when the block is
    opened rather than riding along with the list.

**Tests:** accept then `record()` the same finding twice, it stays off the list and its count
still rises; accept then resolve, the row leaves both ways cleanly; an empty reason is a 400;
un-accept puts it back into the right block; an accepted mechanical finding is absent from
`renderStandingDefects`.

---

## Phase 3: repair from the dashboard (deterministic)

The passes already exist, are tested (`server/test/repair.test.ts`), and hold their own locks in
the CLI. This phase gives them a second caller, with the dry run kept as the default it is.

- [x] **3.1 Only the passes that belong to a defect rule AND actually repair it are exposed:**
      `em-dash`, `tag-mirror`, `tag-singleton`, `run-protocol`. The rule-to-pass table is the
      same `Record<ValidationRule, …>` as task 1.4, so a rule without a pass cannot accidentally
      render a button. Three notes the measurement forced, each rendered in the UI rather than
      only recorded here:
      - **`title-link` is NOT exposed.** `titleLinkPass` edits the pages that LINK to a drifted
        title, never the page the `title-name` finding stands on (`repair.ts:1097`, from
        `d.linkedFrom`), so the filter of 3.2 reduces it to nothing and an unfiltered run would
        write pages the list never showed. Measured: 0 pages vault-wide. `title-name` keeps its
        guidance line from 1.5 and stays a decision.
      - **`tag-mirror` is wired but renders no chip today.** The rule stands at 0 findings and
        the pass finds 0 pages vault-wide (measured 2026-09-21). It is here so the class has a
        path when it returns, not as a button to press now.
      - **`run-protocol` is a PARTIAL path and the row says so.** The rule names seven headings
        (`validator.ts:144-152`); the pass removes five (`repair.ts:312-318`), and only where the
        section is under 400 characters and cites no other page (`repair.ts:332`), because the
        other two carry judgements about the material. Measured: 1 page vault-wide against 2
        standing findings. A finding the pass cannot reach keeps its row after a successful
        apply, and that must not read as a failed fix (it feeds no attempt counter, task 4.8).
- [x] **3.2 `POST /api/v1/validation/repair/plan`** takes a rule plus a set of finding ids,
      resolves them to paths through the store (never from the request body: the client names
      ids, the server names paths), runs `planRepair` and returns per page the `why`, the diff
      from `diffOf`, and a hash of the `before` it planned against (task 3.3 needs it).
      Read-only, no credential needed, like `rejoin-links` (`api/routes/maintenance.ts:107`,
      which has no `credentialMissing` check).
      **The plan is filtered to the pages the findings name.** A pass is built vault-wide and
      will find pages the validator never checked; the dashboard must write exactly what the
      list showed and nothing more. The vault-wide run stays the CLI's job.
      **The filter is right and it has a price the list must not hide.** The validator has never
      swept the vault: it only ever sees the pages a run touched (`queue.ts:1763` `touched`,
      `maintenance.ts:1627` `[...written, ...pages]`, the edited page in the pages route) plus
      the pages the list already names (`standing-recheck.ts:46`). Measured 2026-09-21:
      `tag-singleton` would change 26 pages unfiltered against 14 findings, `em-dash` 2 against
      1. The surplus is pages nothing has ever checked (the two counts are not strictly nested,
      so treat the difference as an order of magnitude and not as a page list), and each will
      surface as a NEW finding of a rule the user believes they emptied. That is expected, not a
      regression, and the rule guidance of 1.5 says so in one line so nobody reads the return as
      a repair that did not hold.
- [x] **3.3 `POST /api/v1/validation/repair/apply`** takes the same shape plus, per selected
      page, the `beforeHash` the plan response carried. The server **plans again** and applies
      only the selection; a page whose fresh `before` no longer matches the approved hash is
      reported as `stale` and NOT written. The response says which pages were written, which were
      stale and which were skipped because a lock was held, and the UI names all three. No
      server-side plan state, nothing to expire.
      **Why the hash and not `applyRepair`'s own check.** `applyRepair` compares `current` to
      `edit.before` (`repair.ts:125-127`), and `planRepair` reads `before` off disk
      (`repair.ts:86`). Re-planning immediately before applying therefore sets `before` to the
      current content, and `stale` becomes unreachable outside a microsecond race - the test this
      task asks for could not be written against the real path. The hash is what carries the
      user's approval forward: the approval was of a diff, and a diff the page no longer has is
      not the one that was approved. `applyRepair`'s comparison stays as the last line of
      defence.
- [x] **3.4 Locks and commit, in the order hard rule 1 states:** the vault's per-file lock on
      every page the selection touches (`withWikiLocks`, `wiki-lock.ts:211`) OUTSIDE, then the
      commit mutex INSIDE, then ONE commit with a mechanism-only message. A page whose lock is
      held is skipped, not waited for.
      **Lift the CLI's `apply` into the pipeline rather than calling it.**
      `cli/vaultrepair.ts:158-175` takes the per-file locks and calls `commitPaths` directly,
      with **no commit mutex anywhere**. That is acceptable for a hand-run one-off with no
      service running, and it is a hard rule 1 violation in a service writer. It also reports
      through `console.log` instead of returning. So: move it to the pipeline as
      `applySelection(vaultRoot, plan, subject, { commitMutex })` returning
      `{ written, stale, busy, commit }`, and let the CLI call that too. The shape to copy is
      `pipeline/questions.ts:250` and `api/routes/jobs.ts:189`.
- [x] **3.5 Re-check straight after, the way `rejoin-links` does it.** A write to the vault gets
      the same check every other run gets. Three calls, in this order:
      1. `validate(written)`, then `record(findings, null)` - so a defect the repair itself
         introduced lands on the list. `recheckStanding` never calls `record()`, so this half is
         missing without it, and it is exactly the half `rejoin-links` added on 2026-09-21
         (`api/routes/maintenance.ts:120-124`).
      2. `resolveMissing(written, findings, { checked: VALIDATOR_RULES,
         fullyChecked: VAULT_WIDE_RULES })` - what this write covered and no longer finds.
      3. `recheckStanding(store, validate, { exclude: written })` for the rest of the list.
      **`recheckStanding` takes no path list.** Its signature is `(store, validate, { exclude })`
      (`standing-recheck.ts:41`) and it re-reads the pages the STANDING LIST names, capped at 200
      and filtered to `wiki/**.md` (`:45-52`). Both SPEC.md §12.16 conditions hold by
      construction: it hardcodes `checked: VALIDATOR_RULES`, so it can clear neither `quote` nor
      `near-duplicate`, and it passes no `fullyChecked`, so a whole-vault rule is never cleared
      per page.
- [x] **3.6 The manifest repair gets the same flow, and does not pretend to reach today's rows.**
      `planManifestRepair` returns a JSON change, not page edits: plan, show the JSON diff,
      confirm, one commit. Its row links to the job, not to a page. Two limits, both measured:
      - **It reaches none of the four `address-map` findings standing today.** All four name a
        `.raw/<job-id>/` directory that no source entry mentions (`validator.ts:937`), which
        `planManifestRepair` reports and repairs by design - what a directory held is not
        derivable from the directory (`repair.ts:531`, `:609-618`). Measured 2026-09-21: the plan
        is empty (`after: null`) and lists 4 unnamed directories. Those rows render as decisions
        with the reason named, never as a button.
      - **It cannot be scoped to selected findings.** It returns one whole-file `after`
        (`repair.ts:625`), so applying it fixes every drift the map has, including entries the
        list never showed. The confirmation says exactly that before the commit; this is the one
        place where "write only what the list showed" does not hold, and it is stated rather than
        hidden.
      The flow is built for the two directions the repair DOES cover (a page missing from the
      map, a `pages_created` entry whose page is gone), which stand at 0 today and will not stay
      there.
- [x] **3.7 The UI.** "Fix this" on a row, "fix all N" on a rule chip. Both open the same panel:
      one entry per page, its `why`, its diff, a checkbox, all checked by default. One button
      writes the checked ones. Afterwards: what was written, what was stale, what was skipped for
      a held lock, and the resulting commit. Every write surface reads `health.demoMode` and
      disables itself: the demo instance refuses every non-GET before a handler runs
      (`api/server.ts:169-177`), which includes the read-only `repair/plan`.
- [x] **3.8 The writer table (hard rule 1) and SPEC gain TWO new writers**, with their lock
      columns and the date they ship, before this ships:
      | Writer | What it writes | Lock |
      |---|---|---|
      | the repair route's pipeline module | wiki pages, one exposed pass, filtered to the findings' pages | **itself** (`withWikiLocks`) |
      | the same module's manifest half | `.raw/.manifest.json`, in a commit of its own | **none, writes no page** |
      The second row is NOT covered by the existing `pipeline/manifest-sync.ts` row, which says
      "inside that run's own commit": this one makes its own. Add a paragraph to SPEC.md §12.16
      describing the path and why the dry run stays mandatory. `cli/vaultrepair.ts` keeps its row
      and its wording.
- [x] **3.9 Concurrency, written down rather than discovered.** The repair takes the per-file
      locks and the commit mutex and NOT the maintenance runner's `runMutex`
      (`maintenance.ts:519`): it starts no agent, so serialising it against a night shift would
      only make it unavailable for hours. A page whose lock a run holds is skipped
      (`wiki-lock.ts:211`) and the response names it as skipped, not as stale: the two mean
      different things to the reader. `commitPaths` commits by pathspec (`git.ts:305`), so an
      agent's half-written pages cannot be swept into the repair's commit.
- [x] **3.10 Bound what a plan costs.** `planRepair` reads every wiki page synchronously
      (`repair.ts:83-86`, `readFileSync`), so one plan is a full read of ~1,270 pages on the
      Fastify event loop, and `tagSingletonPass` reads them all a second time in its factory to
      count the tags before it decides anything (`repair.ts:900-905`). The apply plans again
      (3.3), which doubles whatever the plan cost. So: one plan at a time (a single-flight guard
      keyed by rule), one cached page set per request, and the apply uses its own re-plan rather
      than planning a third time.

**DoD:** a dry run over a COPY of the live vault, per exposed rule, with the before and after
counts recorded in this file; then the same from the UI against the live vault for one rule,
with the commit hash noted. `em-dash` and `tag-singleton` are the two that touch real prose, so
their diffs are read in full before the first apply, and the fact that they were is recorded
here with the date.

**DoD MET, with one deliberate substitution: the applies ran against the COPY and not against
the live vault.** The user's own limit for this work is that `~/vault` is never written - no
apply, no run, no commit against it - and read-only dry runs are the only thing permitted there.
So the whole of the phase-3 acceptance ran on `$HOME/e2e-vault`, a full clone of the live vault
(2215 files, `.raw/.manifest.json` included) served by a second instance on port 8420 against a
snapshot of the live database, whose 57 findings are the same 57 rows. That is a strictly
stronger test than the DoD asked for, because it applied every exposed rule rather than one.

**Dry runs over the copy, 2026-09-21, identical to the live vault's numbers row for row:**

```
em-dash          2 page(s) would change      (live: 2)
tag-mirror       0 page(s) would change      (live: 0)
tag-singleton   26 page(s) would change      (live: 26)
run-protocol     1 page(s) would change      (live: 1)
```

**The diffs of the two prose-touching passes, read in full on 2026-09-21 before the first
apply.** Read mechanically as well as by eye, which is the only way to say "in full" about
38 changed lines without quoting vault text into a public repo:

  - **`em-dash`, 1 page, 16 changed line pairs.** 15 of the 16 differ from their originals in
    dash characters ALONE; the sixteenth is the `updated:` stamp, which is `stampDates` doing
    what a repair is supposed to do (`updated:` and never `content_updated:`). 36 em-dashes
    removed, 0 left, 0 of them inside an inline-code span, 0 inside a `[[wikilink]]` - the two
    places where the character is an identifier rather than punctuation, and the second of which
    broke 199 links the first time this pass was run vault-wide.
  - **`tag-singleton`, 8 pages.** Every removed line is a tag bullet; no page had anything else
    removed, and the only added line on any of them is `updated:`.

**The applies, through the API, against the copy:**

| Rule | Findings selected | Pages the filtered plan reached | Written | Commit | List before -> after |
|---|---|---|---|---|---|
| `em-dash` | 1 | 1 | 1 | `fe3687da` | 57 -> 56 |
| `tag-singleton` | 14 | 8 | 8 | `e518f92e` | 56 -> 48 |
| `run-protocol` | 2 | **0** | - | none | 48 -> 48 |

Each apply was exactly ONE commit containing exactly the pages written (1 and 8 files
respectively), with a mechanism-only subject. `git fsck` exits 0 afterwards. The findings
cleared in the SAME request cycle: the post-write sequence resolved 1 and 8 respectively and
recorded 0 new defects, so no second run was needed to see the repair.

**The stale path, verified through the real HTTP flow.** The `em-dash` commit was reverted to
put the defect back, the page was re-planned, a line was appended to it by hand, and the apply
was sent with the hash from BEFORE that edit. Result: `written: []`, `stale: ['wiki/log.md']`,
no commit, HEAD unmoved, and both the hand edit and the em-dashes still on disk. Exactly what
decision 8 asks for - the approval was of a diff, and that is no longer the diff.

**The manifest repair, planned against the copy:** `0 page(s) to record; 0 stale pages_created
to drop; 0 retired address(es) to drop; 4 job director(ies) named in no source entry`, and
`changes: false`. Identical to the live measurement, and the four rows render as decisions with
the reason named rather than as a button.

**THREE MEASUREMENTS THIS FILE DID NOT HAVE, all of which change what a row can promise:**

  1. **The filtered `tag-singleton` plan reaches 8 of its 14 findings, not 14.** The file
     measured the pass vault-wide (26 pages) against the finding count (14) and left the
     filtered number unstated. The gap is not the filter: it is the pass's own "never leave a
     page with no tags at all" rule, which returns null for a page whose every tag is a
     singleton, because the vault's own template requires `tags:` and emptying it would make 36
     frontmatter findings out of nothing (it did, once). So 6 of the 14 rows survive a
     successful apply by design. The panel says so before the apply and the row's guidance says
     so after it.
  2. **The filtered `run-protocol` plan reaches 0 of its 2 findings today.** The file called it
     a PARTIAL path on the strength of "1 page vault-wide against 2 standing findings"; the
     filtered plan shows the pass's one reachable page is not one of the two the list names. So
     today `run-protocol` is in `title-name`'s position - a button that reaches nothing - while
     remaining a real path for the class. It stays exposed (3.1's decision) and the panel says
     "the pass changes nothing on these pages, and that is not a failed fix" rather than writing
     anything.
  3. **The `near-duplicate` evidence needed a second look.** 1.2 says the message already names
     the second page, which is true; a pattern that stopped at the first space found it on none
     of the six rows, because the vault names its files after their titles and a page path
     normally CONTAINS SPACES. Fixed, with a test.

**And one measured number for 1.3's backfill:** all **9 of 9** standing quote findings
re-produced from their own job's artifact and commit, 0 with no usable job, 0 the re-check no
longer produces. After it, **53 of 57 rows render a non-empty evidence block**; the 4 that do
not are the `.raw/` directory rows, which say why in one sentence instead.

**Tests:** plan is read-only (no write on a fixture vault); apply writes only the selection; a
page whose content changed after the plan comes back as stale via the `beforeHash` and is not
written; a page whose lock is held comes back as skipped, not as stale; the locks are taken in
the documented order (the existing lock tests' shape); one commit per apply; the post-write
sequence records a newly introduced defect and clears the ones that are gone; `applySelection`
refuses to commit without a mutex.

---

## Phase 4: the bound agent run

Three rules, one page per finding, at most ten pages of the same rule per run.

**Before building: this phase changes SPEC.md §12.15 and needs that agreed first.** §12.15 says
today, in as many words, "**Not retroactive.** The 355 standing bullets are repaired one at a
time by the reformulation and by the user's strike-through." Task 4.3 rewrites them on the page
instead. Hard rule 1 permits it, because an agent run is exactly the writer allowed to do it,
but the spec says otherwise and the spec wins until it is changed (CLAUDE.md). Get the change
agreed, then amend §12.15 in the same commit as §12.16.

**AGREED 2026-09-21, by the user, both questions answered before anything in this phase was
built.**

  1. **§12.15 is amended.** "Not retroactive" was right about the mechanism and wrong about the
     limit: pipeline code still rewrites no bullet, which is what hard rule 1 forbids, and an
     agent run bound to one page is the writer hard rule 1 allows. The amendment is in §12.15
     and carries decision 13 with it, as the second way a question's identity ends.
  2. **The threshold stands at 2.** Over one run of 10 findings: every bullet asks something,
     and at most **2 of the 10 pages** still carry a deictic bullet. Fixed BEFORE the run, which
     is the whole point of agreeing it - a bar set afterwards cannot be failed. Below it, the
     rule goes back to being a decision rather than a button, and the counts are recorded here
     either way.

- [x] **4.1 A new maintenance kind `defect-fix`**, started through the existing runner so it
      appears in the run registry, the history and the activity feed like every other run. Needs
      a credential (503 without, `api/routes/maintenance.ts:53-59`, like the other agent
      actions). A run kind is registered in seven places and NONE of them is a compile error, so
      walk them by hand: `MaintenanceKind` (`maintenance.ts:96`), the mirrored union in
      `web/src/api/types.ts:441`, the three `Record<string, string>` maps in
      `web/src/lib/runLabels.ts`, and the figure and the caption in
      `web/src/lib/library/scene.ts:312-327` and `:337-349`. A missing entry is a silent
      fallback, not an error, which is why this is a task and not a detail. The route is base
      product and goes into the `UNGATED` list of `server/test/agents-flag-off.test.ts:79`.
- [x] **4.2 The request names finding ids, never paths or prompts.** The server resolves them
      through the store, rejects the whole request if any id is unknown, already accepted or of
      a rule that has no run (the same all-or-nothing validation `tag-fix` uses,
      `api/routes/maintenance.ts:230-255`: the user selected specific repairs, silently dropping
      one repairs less than they asked). Cap 10, one rule per request.
- [x] **4.3 The prompt, per rule**, built from the finding's own message and evidence:
      - `open-question-form`: rewrite the bullets of this page so each asks one thing, ends in a
        question mark, names its subjects in full, and carries no reference to the run or the
        document. `reformulate()` (`profile: 'query'`, read-only, never throws,
        `question-topic.ts:183`) is the shape to follow for the wording; the writing happens in
        the run. Do not sharpen the prompt wording a third time (SPEC.md §12.15 says why).
      - `quote`: check the quotation against the job's artifact and either correct the quotation
        or rewrite the sentence around it into a paraphrase. Never invent a quotation.
      - `page-schema`: add the missing section and fill it from what the page and the graph
        already hold. An empty heading is not a repair.
- [x] **4.4 The scope guard: exactly the pages of the findings.** No other page, no new page, no
      rename, no delete, no prose rewrite beyond what the rule names. Enforced, not asked for in
      prompt wording, and `canUseTool` is not the enforcement point (hard rule 4).
      **The guard already exists in the shape this needs, and the sandbox is not the half that
      provides it.** `ExpandPolicy.pageSet` (`permissions.ts:154-169`) is a per-run path
      whitelist enforced by the `PreToolUse` hook for every path-bearing tool
      (`permissions.ts:276`, `:295-297`), wired through the runner as `expandPageSet`
      (`maintenance.ts:1490-1491`). Reuse that mechanism with a second policy rather than
      inventing one. The SANDBOX cannot do it: its `allowWrite` is `[VAULT_ROOT]` and a page set
      is not expressible in it. The real second half is the post-commit check plus auto-revert
      that `research-expand` already has (`maintenance.ts:1592-1611`), which is also what catches
      a page written through Bash - the one write the hook structurally cannot see
      (`permissions.ts:150-152`).
      **Take three of `validateExpandCommit`'s four rules and drop the fourth.** Keep
      outside-set, no-delete and the new-page cap; DROP the additivity rule
      (`isSubsequence`, `expand.ts:183`), which requires every existing body line to survive. A
      defect fix replaces lines by definition - that is what rewriting a question or correcting a
      quotation is - so the expand check would revert exactly the run it was reused for.
- [x] **4.5 The notebook condition (decision 14), in two parts.**
      **Part one, the Fellow:** a finding on `wiki/meta/agents/` is fixable only while that
      Fellow has no run in flight. The button is disabled with the reason named, and the server
      re-checks at start (the UI's view can be seconds old). `inFlight` is private and in memory
      (`fellows.ts:398`), so the service exposes a narrow `hasRunInFlight(agentId)`, and the
      startup reconciliation (`fellows.ts:1810`) is what keeps it honest across a restart.
      **Part two, the section:** the repair must land in a section `renderNotebook` preserves -
      Intent, Scope, Open Questions, Notes (`notebook.ts:85`, `:117`). Plan and Log are
      regenerated on every write, so a repair there is undone by the Fellow's next notebook write
      whatever the lock did (§2). A notebook finding whose repair lies outside the four stays a
      decision.
      **With `AGENTS_ENABLED` off the notebooks do NOT disappear.** They are vault files - six of
      them on the live vault today - and the validator keeps reporting findings on them; four of
      today's 57 are notebook findings. What is gone is `ctx.fellows`, and with it any way to
      ask part one. So with the flag off a notebook finding renders as a decision with the reason
      named, never as a button, and no request goes to a Fellow-only route (hard rule 8).
- [x] **4.6 A reformulated question is a new question (decision 13).**
      **Snapshot `parseQuestionBullets` of the page BEFORE the run.** The proposal is matched by
      `questionKey` over the OLD text (`questions.ts:253-255`) and nothing in the finding carries
      it: the `open-question-form` message counts bullets and names none (`validator.ts:568`).
      After the commit, veto every pending proposal whose provenance key names a bullet the page
      no longer has, through `fellows.decide(id, { status: 'vetoed', via: 'dashboard',
      note: 'the question was reformulated' })` - the same call `setArchived`'s injected `veto`
      is wired to (`main.ts:480-482`). The existing note is hard-coded to the pinboard, so it
      becomes a parameter.
      **This is the one flag-dependent branch of a base-product route.** `QuestionsService` and
      the veto callback are constructed only when the Fellows are (`main.ts:465-466`), and both
      `/api/v1/questions*` routes are in the GATED list of
      `server/test/agents-flag-off.test.ts:74-75`. With `AGENTS_ENABLED` off there are no
      proposals, `ctx.fellows` is undefined, and the step is skipped without a 404 and without a
      refusal.
      The board shows the new bullet as an unplanned question. Say this in the confirmation
      dialog before the run starts, because it can discard a planned night's work. Record it in
      SPEC.md §12.15 as a second way a question's identity ends, alongside the amendment the
      phase preamble asks for.
- [x] **4.7 Diff after, revert beside it.** The run commits; the UI shows the commit's diff and
      a revert that reuses `revertCommit` (commit mutex, refuses on a dirty tree, aborts cleanly
      on conflict, `git.ts:399-435`) as `POST /api/v1/jobs/:id/revert` does
      (`api/routes/jobs.ts:189`). The route itself is not reusable, only the function: it marks
      `jobs.reverted_at` and counts the jobs sharing the hash, and a maintenance run has neither.
      Two things to say out loud:
      - **A revert refuses while anything is writing.** `revertCommit` requires a clean tree
        (`git.ts:415-423`), so during an ingest or a night shift the answer is "a run is still
        writing, retry when it settles", not an error.
      - **A revert does not un-resolve the findings the re-check cleared.** After 4.9 clears
        them, reverting the commit puts the defect back on disk and the list does not know until
        another run reads the page. So the revert also re-records: `validate(pages)` and
        `record(findings, null)` over the reverted pages, in the same request.
- [x] **4.8 Migration 36: `fix_attempts INTEGER NOT NULL DEFAULT 0`, `last_fix_at TEXT NULL`.**
      Incremented when a fix run covers this finding, whatever the outcome; the re-check that
      clears the finding is what marks success. From the third attempt the row says two runs
      have failed on it and offers accept or hand work instead of another button.
      **`quote` needs its own clearing path or the counter lies about it.** `recheckStanding`
      hardcodes `checked: VALIDATOR_RULES` (`standing-recheck.ts:54`) and `VALIDATOR_RULES`
      excludes `quote` and `near-duplicate` (`validator.ts:1130-1132`), because a quotation is
      compared against the job's artifact and only `checkQuotes` in the ingest path holds one
      (SPEC.md §12.16, constraint 2). So a successful quote repair would never clear its own
      finding, `fix_attempts` would rise on every success, and at three the row would call three
      successes two failures. A quote fix run therefore resolves its own finding from the check
      it performs itself: after the commit it re-runs `checkQuotes` for the finding's job, and
      the route calls `resolveMissing` with `checked: new Set(['quote'])` over exactly that page.
      **And a partial repair is not a failure.** `findingIdentity` normalises numbers out of the
      message (`db/validation.ts:52`), so an `open-question-form` finding that goes from three
      bad bullets to one keeps the same id and only bumps its count. The row distinguishes "still
      standing, fewer occurrences" from "unchanged" before it accuses a run of failing.
      Check the migration number when you get here, as in 1.3.
- [x] **4.9 Re-check after the run**, the same three-call sequence as 3.5, plus the `quote`
      special case of 4.8.

**DoD:** one run per supported rule against the live vault, with before and after counts and the
commit hash recorded here; one deliberate revert; one run against a notebook while its Fellow is
idle, and a refused attempt while it is not.

**DoD MET, with the same substitution phase 3 made and one part that could not be met as
written.** The runs went against the throwaway COPY, never `~/vault` (the user's own limit).
Three real runs, one revert, on 2026-09-21:

| Rule | Findings | Pages written | Commit | Cost | List before -> after | Cleared? |
|---|---|---|---|---|---|---|
| `open-question-form` | 10 | 10 + `wiki/log.md` | `b1a3c125` | 1.13 USD | 15 -> 10 | 9 of 10 |
| `quote` | 3 | 3 | `423997ae` | 1.05 USD | 9 -> 9 | 0 of 3, correctly |
| `page-schema` | 5 | 5 + `wiki/log.md` | `c6cd2823` | 1.20 USD | 5 -> 0 | 5 of 5 |
| revert of `c6cd2823` | - | 6 restored | `95f77188` | - | 39 -> 44 | 5 back on the list |

Plan usage: each run moved the five-hour window by 1 point and the seven-day window by 0. The
seven-day window stood at 78 % before the first and after the last. Total 3.38 USD of list-price
estimate for the three runs, plus one `permprobe` (two further runs, which hard rule 4 requires
after any change to the permission wiring - it reported `canary outside vault: blocked`).

**The scope guard held on every run.** All three commits contain exactly the pages of their
findings, plus `wiki/log.md` on two of them - which is the service's OWN hub write inside the
run's commit (SPEC.md §12.12) and is exempt from the check by construction, the same exemption
the expand rules carry. No run created, renamed or deleted a page, and the commit check never
fired.

**The notebook condition: the "refused while the Fellow is working" half could not be met against
the copy, and the reason is a measurement rather than a gap.** Of the six Fellows in the snapshot
five are RETIRED, and retirement is final in that module (`pause()` and `resume()` both return a
retired agent untouched) - so a retired Fellow has no next notebook write and its page is an
ordinary one. The sixth is `waiting` with no run in flight, and starting a Fellow run to create
one would have been a fourth and fifth agent run outside the agreed budget. Both halves are held
by `server/test/defect-fix.test.ts` against the real `defectFixBlock`, and the route re-checks
rather than trusting the browser. What the E2E DID show: the three notebook findings that were
blocked BEFORE this was measured, and are correctly fixable after it (see the finding below).

**THE THRESHOLD, agreed before the run and measured after it.** Over the 10 pages of the
`open-question-form` run, counted with the service's own classifiers:

```
                        before      after
bullets                     61         68
ask something               17         66
deictic bullets             24          7
pages with a deictic bullet 10 of 10    5 of 10
```

**The bar was: every bullet asks something, and at most 2 of 10 pages still deictic. It is
FAILED on both halves** - 66 of 68 ask something, and 5 of 10 pages still carry a deictic bullet.
So, as agreed in advance, **`open-question-form` goes back to being a decision rather than a
button.** The prompt stays in the repo and the route refuses the rule, so the screen and the
endpoint agree.

**And the one number that makes this worth revisiting rather than closing: 6 of the 7 remaining
deictic bullets carry ONE phrase, `in this vault`.** Only one bullet, on one page, carries true
run-deixis (`this run`). `PASS_DEIXIS` (`question-form.ts`) counts `in this vault` beside `in
this pass`, and the two are not the same kind of reference: "in this pass" means nothing away
from the page, and "in this vault" is a scope a question asked OF this vault legitimately
carries. Counted without it the run leaves **1 of 10** pages deictic, inside the bar. That is a
question about the classifier in SPEC.md §12.15, not about this run, and it is recorded here
rather than decided: changing the classifier to pass a threshold it failed is exactly the move
a bar agreed in advance exists to prevent.

**THREE FINDINGS THE RUNS PRODUCED, none of which this file had:**

  1. **A `quote` finding is one per PAGE, not one per quotation.** `findingIdentity` normalises
     quoted strings and numbers out of the message, and a quote finding's message is
     `quote not found in the source: "<text>" (longest match <n> of <n> words)` - so every
     failing quotation on one page hashes to the SAME id. Verified directly: two different bad
     quotations on one page produce one identity. This is why the quote run cleared nothing and
     why that is CORRECT: of its three pages, two still carried a second failing quotation and
     the third was a checker false positive the run correctly left alone (a PDF extraction had
     glued a reference marker onto a word). It also means the screen's "9 quote findings" is 9
     PAGES with at least one bad quotation, and the occurrence count is how often that has been
     reported.
  2. **Task 4.8's partial-repair reasoning does not hold for `open-question-form`.** It says a
     finding that goes from three bad bullets to one "keeps the same id and only bumps its
     count", because numbers are normalised out. Measured: of the 10 findings the run covered, 9
     resolved and 4 NEW ids appeared on the same pages with `fix_attempts: 0`. The message is
     built from two optional clauses (`N do(es) not ask anything`, `N refer(s) to the run`), and
     a page that loses one clause produces a structurally different message and therefore a
     different identity. The consequence runs the SAFE way - the counter under-counts rather
     than accusing a run that worked - and `occurrences_at_last_fix` only does its job for the
     rules whose message has one clause, which is `quote` and `page-schema`.
  3. **A retired Fellow's notebook was blocked and should not have been.** Three of the four
     notebook findings stand on retired Fellows' pages, and the first version of the guard
     filtered retired Fellows out of `ownerOf` - so three quarters of the class lost its path to
     protect against a write that can never happen. Fixed, with a test.

**And one wording fix the first real run produced:** the commit subject read
`repair: a bound run over 10 pages carrying a open-question-form defect`. The rule name carries
no article. It is now `…, rule <name>`.

**Plus a threshold for `open-question-form`, because 15 of 57 findings ride on it and no
evidence exists yet that a bound run helps.** SPEC.md §12.15 measured the in-page prompt rule at
"asks something 45 of 45, still deictic 25 of 45, and 9 of 10 in the two runs that saw the
sharpened wording". The 0-of-30 result in §12.15 belongs to `reformulate()` as a BRIEF, which is
a different task shape, and it does not transfer. So: over one run of 10 findings, count the
same two things §12.15 counted, and the bar is **every bullet asks something, and at most 2 of
the 10 pages still carry a deictic bullet**. The first half is where the prompt rule already
stands (45 of 45); the second is a fifth of where it stands (25 of 45), which is the whole claim
this run makes over leaving the bullets alone. **The number 2 is a proposal, not a measurement:
agree it before the run or it is unfalsifiable afterwards.** Below the bar the rule goes back to
being a decision rather than a button, and this file records the counts either way.

**Tests (runs mocked, as everywhere in this repo):** the id validation rejects an unknown, an
accepted, and a mixed-rule request; the prompt contains exactly the pages of the findings; the
scope policy refuses a write outside the set and ALLOWS an edit that removes a line; the
notebook condition refuses with a Fellow in flight, and refuses a finding outside the preserved
sections; with `AGENTS_ENABLED` off the notebook rows render as decisions and the route issues no
Fellow-only request; the veto fires after a reformulation and is skipped without error when the
Fellows are unwired; a quote finding is cleared by the run's own quote check and not by
`recheckStanding`; the attempt counter rises on a run that changed nothing and the row switches
its advice at three.

---

## Phase 5: acceptance (the user's own pass)

Nothing ships before this.

- [x] **5.1** `npm test`, `npm run typecheck`, `npm run lint`, all three green and exit 0. A
      green suite is not a green repo.
      **Done, and the warning earned its place twice**: the suite was green with the typecheck
      red on two separate occasions during this work, both times over test-file types that
      `vitest` does not check and `tsc --noEmit` does. Final: 118 server files / 2008 tests,
      65 web files / 676 tests, typecheck and lint exit 0.
- [x] **5.2** The measurement of section 0 repeated, both columns (0.1 and 0.2): the table,
      before and after, in this file.

      **AFTER, taken 2026-09-21 against the throwaway copy through the same script** (the live
      vault was never written, so its own table is unchanged - see the note under 5.3):

      | Rule | Findings | Occurrences | Path | Was |
      |---|---|---|---|---|
      | `open-question-form` | 10 | 16 | decision | 15 |
      | `quote` | 8 | 9 | run | 9 |
      | `tag-singleton` | 6 | 22 | pass | 14 |
      | `near-duplicate` | 6 | 6 | decision | 6 |
      | `page-schema` | 5 | 10 | run | 5 |
      | `address-map` | 4 | 108 | decision | 4 |
      | `run-protocol` | 2 | 4 | pass | 2 |
      | `em-dash` | 1 | 19 | pass | 1 |
      | `title-name` | 1 | 1 | decision | 1 |
      | **Total** | **43** | **195** | | **57** |

      **57 to 43, over one afternoon, without a single decision being taken for the user.** The
      page-schema five are back because its commit was deliberately reverted to test the revert;
      without that the figure is 38. `em-dash` is back for the same reason (its commit was
      reverted for the stale-path test). What actually went and stayed gone: 8 tag-singleton, 1
      quote, and 5 of the 15 open-question findings.

      **Every rule now carries a path**, which is the thing section 0 could not say: 2 rules
      reach a deterministic pass, 2 a bound run, 5 a decision with the reason written down.
- [x] **5.3** `node scripts/vault-audit.mjs ~/vault --json` before and after the first real
      apply, diffed. `--redact` for anything committed here.
      **NOT APPLICABLE AS WRITTEN, and the reason is the user's own limit on this work:
      `~/vault` is never written by it.** No apply, no run and no commit touched the live vault,
      so an audit of it before and after would be the same file twice. The measurement that
      answers the question this task exists to answer - did the vault change in a way nobody
      intended - is the per-commit check that ran instead: every apply and every run produced
      exactly ONE commit containing exactly the pages it named, `git fsck` exits 0 on the copy
      afterwards, and the scope check on the runs never fired. All of it is recorded per phase
      above.
- [x] **5.4** `scripts/vault-name-scan.mjs --diff main` over everything this branch adds, and
      `--file` over the PR body. Read the added UI strings and test fixtures by eye: this work
      puts vault text on screen, and content is where every leak of the 2026-09-15 audit was.
- [x] **5.5** A walk through the screen with `AGENTS_ENABLED` off: no Fellow surface, no request
      to a Fellow-only route, no 404 on mount. The notebook findings are visible and render as
      decisions (4.5), and `server/test/agents-flag-off.test.ts` carries every route this branch
      added in its `UNGATED` control group.
      **Walked 2026-09-21 against the copy with `AGENTS_ENABLED=0`:** `health.fellows` is the
      BOOLEAN `false`; all eight Fellow-only routes answer 404 (`/agents`, `/agents/shift`,
      `/recaps`, `/library/scene`, `/wings`, `/usage/plan`, `/reading-list`, `/questions`); the
      list answers 200 and carries its guidance; `repair/manifest/plan` answers 200 and
      `repair/plan` answers 400 for a missing field, which is an ANSWER rather than a gate. The
      3 notebook findings are visible and classified `decision`, and no row anywhere offers a
      run for a rule that has none. The suite's control group covers the new routes, with the
      two that legitimately 404 or 400 asserted separately rather than folded into a flat 200.
- [x] **5.6 The documentation this branch owes**, none of which any task above produces as a side
      effect: `docs/API.md` gains a line per new route beside the `GET /validation` entry it
      already has; `CHANGELOG.md` gains the merge entry; `SPEC.md` §12.16 gains the repair path
      and §12.15 the amendment of the phase-4 preamble; `CLAUDE.md`'s writer table gains the two
      rows of 3.8.
      **All four done.** `docs/API.md` has the eight new routes; `CHANGELOG.md` has the merge
      entry including a "known limits, measured rather than assumed" section that names the
      three things this work does NOT deliver; `SPEC.md` §12.16 carries the third
      classification, the plan-diff-confirm flow, the price of filtering a vault-wide pass and
      the accept, and §12.15 carries the amendment; `CLAUDE.md`'s writer table has both rows
      with a paragraph saying why the manifest half is not covered by the `manifest-sync.ts`
      row above it.
- [x] **5.7** A walk with `DEMO_MODE` on: every new write surface is disabled rather than
      offering a button that 403s (`api/server.ts:169-177` refuses every non-GET, the read-only
      `repair/plan` included).
      **Walked 2026-09-21 against the copy with `DEMO_MODE=1`:** `health.demoMode` is true and
      all EIGHT new non-GET surfaces answer `403 demo_read_only` before any handler runs -
      `repair/plan`, `repair/apply`, `repair/run`, `repair/revert`, `repair/manifest/plan`,
      `repair/manifest/apply`, and both verbs of `/:id/accept`. Reads still answer 200. The UI
      reads `health.demoMode` and DISABLES each surface rather than hiding it, which is the
      deliberate half: a surface that vanishes reads as a feature that does not exist, and the
      demo is meant to show what the product does.
- [ ] **5.8** The user works the list down once, by hand, and says whether the path is actually
      a path. Findings from that pass are written here before anything is called done. This one
      is deliberately not objective; it is the question the whole file exists to answer.
      **OPEN. This is the user's own pass and nothing here can stand in for it.** Everything it
      needs is in place: the branch is `feat/defect-paths`, all three commands are green and
      exit 0, both probes have run, and the throwaway instance the acceptance ran against is
      described at the top of the E2E notes above. The one thing to know before working the list
      by hand: two rules with a real repair path reach nothing on TODAY's findings -
      `run-protocol`'s pass does not reach either of its two pages, and the address map's repair
      reaches none of its four - so the first impression of "fixable" will be smaller than the
      block heading suggests. Both say so in the row.

---

## Appendix: what the code review confirmed unchanged

Listed so the implementation does not re-verify it. Checked against the code on 2026-09-21.

`record()` sets `resolved_at = NULL` on every repeat (`db/validation.ts:101`), and `list()` and
`countsByRule()` filter on `resolved_at IS NULL` (`:134`, `:149`). `startLintFix()` throws
without a report (`maintenance.ts:749`). The UI asks `limit: 50` and the client has no `offset`.
`MaintAreaId` knows seven areas and none of them is the defects. `notebook.write()` reads inside
the per-file lock and carries `Open Questions` over verbatim. `pause()` stops no run in flight,
there is no abort path anywhere in the Fellow module, and `resume()` restores no prior state.
`inFlight` answers "is this Fellow working" reliably within a process. `applyRepair` compares
against disk and reports `stale`. `revertCommit` is reusable and holds all three of its guards.
`checkQuotes` runs in the ingest path only. Migration 34 was the next free number on the day this
was written. `MECHANICAL_RULES` and `JUDGEMENT_RULES` cover the rule union completely and
disjointly, with an exhaustive test (`server/test/lint-fix-routing.test.ts:103-111`). The caps of
decision 11 are real. `reformulate()` holds its three contracts. The scripts named in phase 5
exist with the flags used here.
