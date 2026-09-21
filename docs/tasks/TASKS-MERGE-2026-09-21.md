# TASKS-MERGE-2026-09-21 - Merge preparation, second round

Goal: everything Curious has built since the research-agents merge becomes part of LibrisVault
without a private page, a local path or an undocumented behaviour going with it. Same acceptance
as TASKS-A6 section 0, which is the record of how the first merge was run and the procedure this
file repeats: `npm test`, `npm run typecheck`, `npm run lint` green AND exit 0; `permprobe`
reports `canary outside vault: blocked`; the root `SPEC.md`, `CLAUDE.md`, `README.md` and
`docs/API.md` describe what shipped; every screenshot comes from the synthetic vault; the
private-content audit over the final merge diff is clean.

## 0. Scope as measured 2026-09-21

`git merge-base main upstream/main` is `e20b60f`, which IS upstream's HEAD, so the two histories
have not diverged: nothing to rebase and no conflict to resolve. This is the one thing that is
easier than last time, when a dependency commit sat above the base and carried a security patch
set with it (TASKS-A6 section 9).

| | |
|---|---|
| Commits above upstream | 87 |
| Files / lines | 179 files, +22,671 / -546 |
| New runtime dependencies | **zero**, in either workspace. The manifests differ by npm scripts only |
| Work streams | vault layer (PR #1, `docs/tasks/TASKS-VAULT-LAYER.md`), question handoff (PR #2, `docs/tasks/TASKS-QUESTIONS.md`), and 19 trailing commits documented in neither |

One behaviour is **removed**, and it is the only breaking change: `35c4bcb feat!: a chat answer
never becomes vault content`. The button, `POST /api/v1/sessions/:id/save` and the runner behind
it are gone, and a test asserts the route 404s.

## 1. Gates - all four green, measured 2026-09-21 on the working tree

| Gate | Result |
|---|---|
| `npm test` | exit 0, **2,568 tests** (server 1,913 / 114 files, web 655 / 64) |
| `npm run typecheck` | exit 0, both workspaces |
| `npm run lint` | exit 0, both workspaces |
| `npm run build` | exit 0 |
| CI on Curious | green through `f301b61` |
| Working tree | clean |

- [x] **Pushed 2026-09-21.** `f301b61..9c18ba3`, `origin/main` and local `main` now agree.

## 2. Probes - all three done, all three pass

Unit tests read a policy; only a probe proves it is applied. That is why the hard rules name
these by file path, and it is the half CI deliberately leaves out. All three were run on
2026-09-21 and all three pass; the vault's git state was clean before and after each.

- [x] **`permprobe` - DONE 2026-09-21, run with authorisation because it is billable. PASS.**
      `canary outside vault: blocked`, `canary in skills/: blocked`, 1 tool denial, and the
      expand probe's five checks all ok in its own throwaway vault (3 denials there, and the
      new-page cap held at exactly 3). Run as `VAULT_ROOT=$HOME/vault npm run permprobe`; the
      credential comes from `~/.config/vault-service/env`, `VAULT_ROOT` does not, so it has to
      be passed. Re-run was due because `server/src/pipeline/permissions.ts` gained 52 lines in
      this merge (`e2b8dda`, deny history destruction in an agent run).

      **Worth reading rather than just ticking, because it is what only a live run can show:
      the two canaries were refused by two DIFFERENT mechanisms**, which is exactly what hard
      rules 4 and 5 claim. `/tmp` came back `Read-only file system` - the OS-level sandbox, not
      the bash denylist, which is the distinction hard rule 4 spends a paragraph on. The
      `skills/` write was refused by the upstream guard's own message, in-process, on a path the
      sandbox would have allowed. A probe reporting "blocked" twice would hide that.

      **Two things checked afterwards and both clean.** The vault's git state is unchanged and
      both canaries plus the throwaway vault are gone, which matters because the live service
      (PID 129892 at the time) was running against the same vault throughout: had the `skills/`
      canary landed, its reconciler could have committed it. And the agent answered an English
      prompt in German, which is cosmetic and not a trust leak: `buildOptions` sets
      `settingSources: ['project']` with `cwd: vaultRoot`, so a run loads the VAULT's CLAUDE.md
      and never the developer's personal one, and the probe asserts SIDE EFFECTS rather than
      reply text by design.

- [x] **`vaultprobe` - DONE 2026-09-21 against the live vault. All four text contracts hold.**
      `completion-marker` ok (crash recovery can still tell a finished ingest from an
      interrupted one), `lint-report` ok (a report still parses into populated sections),
      `autoresearch-flow` ok (the paths the research prompt names are all present),
      `address-rules` ok (the rules the validator mirrors still hold). It is NEW in this merge,
      so this is its first run as merge evidence rather than a re-run. The default form reads
      files and writes nothing; the vault's git state was unchanged afterwards. `--ingest` is
      the opt-in half and was deliberately NOT run: it costs an agent run, and it proves the
      log-entry shape against a scratch vault rather than anything this merge changed.
- [x] **`preprocprobe` - DONE 2026-09-21. PASS, "the jail holds", 14 checks.** Not strictly due
      (`server/src/pipeline/preprocess/` is untouched by all 87 commits) and run anyway, as A6
      did, because a jail is a property of the HOST as much as of the code and this is a
      different machine-day than the last run. Both halves were shown, which is the point:
      the allowed side (reads its input, writes its output directory, and pandoc, the JATS
      conversion, pdftotext, the Python extractor and defuddle all run) and the blocked side
      (the credential file, the vault listing, its own home, the service API on 8421, and the
      internet). The check worth naming is `tries to write outside its directory: allowed`
      followed by `...and nothing of it reached the host: nothing appeared` - the write is
      permitted INSIDE the jail and lands nowhere real, which is a stronger statement than a
      refusal would be.

## 3. Documentation - README, API.md and both spec sections done; two items left

- [x] **`README.md` - DONE 2026-09-21.** Five corrections, each checked against the code rather
      than against memory:
      - the sentence promising a feature that no longer exists is gone. It now states the rule
        the way `SPEC.md` line 186 states it: a chat answer never becomes vault content, reading
        and writing are separate paths, and only a run writes.
      - **the pinboard paragraph** carries the three behaviours the question work added: one card
        per question however many pages carry it, with the others as *also on* links
        (`questionClusters`, overlap threshold 0.7); *Start research* reformulating the bullet
        into a topic before the handoff; and the question's own page travelling into the run as
        context. Its caption follows.
      - **the recency lens** reads what a page says about itself rather than its file mtime, which
        is the whole point of `89ada44` - after the vault repair, 1,326 of 1,332 files fell inside
        the 21-day window and every node came out green.
      - **the System screen** names the standing defect list, and the "every write is checked"
        bullet describes it properly: one row per defect with how often it has been seen and how
        long it has stood, rather than one advisory line per run in a job log.
      - Two paragraphs were reflowed to the file's ~98 column width afterwards, because inserting
        mid-paragraph leaves lines that read fine in a diff and badly in the file.
      **Not a defect after all:** the concurrency default. The README lists concurrency as
      runtime-settable and never states a number, so the 2 to 1 change left nothing to correct.
- [x] **`docs/API.md` - DONE 2026-09-21, and the audit found more than the two known gaps.**
      The two this merge adds are in (`POST /maintenance/research/topic`,
      `GET /api/v1/validation`). Then every route in `server/src/api/routes/` was diffed against
      the file, 95 of them, which turned up **five pre-existing gaps and one misfiling**:
      - undocumented: `POST`/`DELETE /stats/commits/:hash/dismiss`, `GET`/`POST /agents/shift`,
        `POST /library/move`, `PATCH /wings/order`, `POST`/`DELETE /usage/override`. All added.
      - **misfiled, and this one is a hard rule 8 matter:** `GET /usage/samples` sat ABOVE the
        `--- only with AGENTS_ENABLED ---` divider, so the file told a reader with the flag off
        that the route exists. It does not: `usage.ts` is registered behind
        `if (ctx.usage !== undefined)`, the same conditional as `/usage/plan`, which sits BELOW
        the divider and which `server/test/agents-flag-off.test.ts` asserts 404s. Moved down
        beside it. This is the quiet-rot shape hard rule 8 warns about, one layer out from the
        dashboard query it names.
      None of the six came from this merge; they are carried-forward gaps that a public repo's
      API document should not carry further.

- [x] **Two base-product behaviours of this merge had no spec entry. Both DRAFTED and APPLIED
      2026-09-21** as `SPEC.md` §12.15 and §12.16, after §12.14 which was the last section.
      Drafted and asked first, per A6 section 2; the draft stays under
      `docs/tasks/SPEC-12.15-12.16-draft.md` as the record.
      **Where they belong was decided by measuring the flag boundary, not by preference.** The
      question work spans it, and the code draws the line in adjacent lines: `queue.ts:1289` puts
      `OPEN_QUESTION_FORM` in every ingest's prompt unconditionally, while `queue.ts:1294` right
      below it carries `renderReadingList` behind `this.reading === undefined` with the comment
      "only behind the flag". Base product: the prompt rule in all three writing runs
      (`queue.ts:1289`, `:1879`, `maintenance.ts:1463`), the validator rule, the shared
      classifiers in `question-form.ts`, `POST /maintenance/research/topic` (registered
      unconditionally), and both CLIs. Behind the flag: only `GET /questions`,
      `POST /questions/archive` and the pinboard that displays them. So it is the
      source-integrity shape - it corrects the existing pipeline rather than adding a subsystem
      beside it - and `docs/agents/SPEC.md` would be wrong, because that is by definition the
      document of what exists only with the flag set.
      **A section each rather than a new `docs/` subtree**, because the root spec's two patterns
      are calibrated by size: a ~19-line summary plus its own document when the subsystem is
      large (§12.11 to `docs/sources/SPEC.md` at 553 lines, §12.10 to `docs/agents/SPEC.md` at
      2,058), and a self-contained 20 to 40 line subsection for a mechanism (§12.12 at 34,
      §12.13 at 40, §12.14 at 22). Both of these are mechanisms.
      - **§12.15, the form of an open question.** Includes the honest half of the measurement,
        which is the part worth keeping: the prompt rule took "asks something" from 8 % to 45 of
        45, and did NOT remove the back-references (25 of 45 still say "in this pass") because
        the vault carries that phrase 380 times and one line of prompt argues against 380 worked
        examples. The reformulation in front of a run is what removes them (0 of 30). The draft
        says not to sharpen the wording a third time.
      - **§12.16, the standing defect list.** Found while drafting §12.15: `GET /api/v1/validation`
        is a new base-product surface with no spec entry either. Covers the identity of a finding,
        and the three ways clearing one went wrong (a whole-vault rule cannot be cleared per page;
        a check may only clear what it was able to look for; a page no run touches is never
        re-read).
- [x] **Stale cross-reference in the code, found while drafting, FIXED 2026-09-21:**
      `api/routes/validation.ts:2` cited "SPEC.md §12.12" for the standing defect list. §12.12 is
      the hub layer, and the defect list had no section at all. It cites §12.16 now. The other
      ten §12.12 citations in `server/src` were checked and are all correctly about the hubs.
- [x] **CLAUDE.md hard rule 1 - DONE 2026-09-21.** The table and its completeness grep came out
      uneven in both directions, because they enumerate two different things: the table lists who
      WRITES, the grep finds who takes the LOCK, and those coincide only for the self-contained
      writers. Two changes, and the third option (a compiler- or test-enforced list, the idiom
      `VALIDATOR_RULES` and `MECHANICAL_RULES` already use) was deliberately left out for now - it
      couples a markdown table to code and is a separate decision.
      - **A `Lock` column**, so the divergence is an entry rather than a puzzle: "itself" on eight
        rows, "**its caller**" on `pipeline/hubs.ts`, "**none, writes no page**" on
        `pipeline/manifest-sync.ts`.
      - **A row for `cli/vaultrepair.ts`**, the one genuine gap: a full vault writer shipped by
        this merge (takes `withWikiLocks`, commits through `commitPaths`) that appeared in no
        table, in `SPEC.md` or in `CLAUDE.md`. Put in the same table rather than a second list,
        because a second list is a second thing to forget, and marked for what it is: hand-run,
        dry-run by default, `--apply` the only way past it.
      - **The grep sentence corrected.** It claimed to prove the list complete. It now says what
        it does: it finds the lock-takers, additionally returns `wiki-lock.ts` (the lock's own
        definition) plus `queue.ts` and `maintenance.ts` (the agent-run path of row one, and
        where the two riders get their lock), and structurally never returns the riders. A new
        writer belongs in the table whichever side of that it falls on.
      **Verified mechanically rather than by eye:** grep yields 11 files, the table 11 rows, and
      the three-extra / two-missing sets are exactly what the corrected paragraph names.
- [x] **DONE 2026-09-21: the 19 trailing commits are recorded**, as a closing section in
      `docs/tasks/TASKS-VAULT-LAYER.md` ("After the phases: what the live vault turned up") and
      not in this file. They continue that work rather than belonging to the merge: six are the
      standing list and its rules, two the lint-report parser, three the manifest writer that
      hard rule 1 gained, four the file names a system can open, and four singles.
      **Written from the commit bodies, not the subject lines**, because the bodies are where
      the measurement is: 20 of 44 findings already repaired on disk, address-map 7 to 75 then
      72 to 4, a report stating 358 where the view showed 20, 73 of 1274 pages missing from the
      address map, 39 file names Windows cannot open, 1,326 of 1,332 nodes inside a 21-day
      window. A record without those numbers would be a changelog, which git already is.
      Scanned: the added lines match nothing.

## 4. Private-content audit (hard rule 7)

`node scripts/vault-name-scan.mjs --diff upstream/main`, 2,323 terms, **6 matches, and 5 of them
are accepted**: three archive log page names of the `log-YYYY-MM` shape, which the vault-layer
file already records as expected false positives, and one date hedge that is also a title
fragment. The sixth is below. What the scan **cannot** see was checked by hand as well: the two
new task files hold **zero** blockquotes and name exactly one vault path, and that one is a
placeholder shape. The three committed audit JSONs are aggregate numbers and structural paths
only, with no page titles in them.

- [x] **DECIDED 2026-09-21: reformulate the line, do not redact it.** The verbatim
      `wiki/questions/` page title in `docs/tasks/TASKS-QUESTIONS.md` is gone, and so is the
      subject in the prose above it, which the scanner never flagged because it was lowercase
      and no whole title stem. Removing only the title would have read as done without being
      done, which A6 already names as a failure mode.
      **Why reformulating rather than redacting**, which was the A7 6.4 precedent: that entry
      redacted a QUOTATION, where substituting invented content would have fabricated a record.
      This one is a statement ABOUT a name, not a quotation of one, so the sentence can simply
      say what it found. Nothing of the finding is lost: it rests on the length, 78 characters,
      and on the filed name agreeing with the pinned one rather than with the topic sentence the
      run started from. The line now says the omission is deliberate and why.
      **Verified: the file scans clean**, and the title appears nowhere else in the repo.

- [x] **NOT A LEAK, and not a dead route either. Retracted 2026-09-21, both halves were wrong.**
      The `wiki/questions/` page the deep-link shot names IS one of the four captured research
      runs under `scripts/demo-research/`, which A6 accepted deliberately: real runs commissioned
      for a demo vault meant to be published, overlapping this vault's subjects because the
      topics were chosen to. And the route is not stale: the shot runs against the DEMO vault,
      seeded from those fixtures, whose file name matches the route byte for byte. **What misled
      me** was checking the name against `~/vault`, where this merge's own title cleaning did
      rename the colon - a different vault from the one being photographed.
- [x] **DONE 2026-09-21: the four Windows-hostile fixture names are gone, renamed to what today's
      service files.** All four were `demo-research` synthesis pages filed `Research: ...`; two
      also carried an em-dash before the lens suffix. `git clone` of the PUBLIC repo failed on
      them under Windows. `research-profiles.ts` has been colon-free since 2026-09-19 (`f4ce7b9`,
      B3: `Research: ` "was the machine that minted the worst of this vault's dead links") and
      its `titleSuffix` values use a plain hyphen, so the rename follows the code rather than
      taste: `Research - <topic> - <lens>`.
      **What was renamed and what deliberately was not.** The four files, plus every reference to
      their exact titles: wikilinks in six concept pages, four `hot.md`, four `log.md`, the
      pages' own `title:` frontmatter, four `run.json`, and the percent-encoded deep-link route
      in `shoot-screens.mjs`. **Untouched: the six historical log headings** of the form
      `## <date> - Research: <topic>`. Those are RUN LABELS, not page names, and the fixtures'
      `log.md` predates the service-owned hub layer entirely (§12.12 renders
      `## [<date>] <kind> | <title>` today), so rewriting them would fabricate a record rather
      than correct one.
      **Verified, not assumed:** 0 tracked names Windows cannot create, 0 dangling `Research`
      wikilinks anywhere in the fixtures, the shot route decodes to a file that exists, and the
      six run labels still read `Research: `.
      **One bug of my own, caught by that verification:** the first pass missed
      `shoot-screens.mjs` entirely, because the file carries the title percent-encoded
      (`Research%3A`) and the grep that built the target list looked for the plain text. The
      check for "does the route resolve" is what found it.
- [x] **DONE 2026-09-21: `scripts/capture-research-run.mjs` accepts both prefixes.** It hardcoded
      `wiki/questions/Research: ` in two places, so after `f4ce7b9` it would have failed to find
      the synthesis page of any new run - and failed it LOUDLY and wrongly, with a message
      saying the run filed no synthesis and was therefore not a result. It now picks whichever
      prefix the run's pages carry and slices the slug from that.

- [x] **Blind spot CLOSED 2026-09-21, not merely recorded.** `vault-name-scan.mjs` decodes runs
      of `%XX` and scans the decoded copy as well; a malformed run is left standing rather than
      thrown over. Verified on the case that exposed it: a `--file` scan of `shoot-screens.mjs`
      went from clean to naming the page. The header's three structural limits stay, and the
      fourth is now marked closed there rather than listed as a hazard.
      **The reason this went first: it could have moved the priorities, and it did not.** A full
      scan with decoding on gives 142 matches over 681 files, and every one is in the set A6
      already accepted - `Anthropic` (60) and `Cursor` (27) as product vocabulary, the author's
      own name, a handful of generic titles, the `log-YYYY-MM` archives, and the pharma
      vocabulary of the four captured runs, which was checked file by file and is confined to
      `scripts/demo-research/` plus the one route that points into it. The single hit outside
      that set is the quote in `TASKS-QUESTIONS.md:807`, already its own decision below.
- [x] **Done, on the exact text that was posted.** Drafted in
      `docs/tasks/PR-MERGE-2026-09-21-draft.md`, then the title and body were cut out of it into
      the files `gh pr create` was actually given, and THOSE were scanned: nothing matched. The
      draft is scanned too, but the draft is not what gets posted, and the gap between them is
      exactly where a last-minute paraphrase would live.
- [x] **Confirmed 2026-09-21, and the answer is clean.** Both directories exist (9 files and 2),
      **0 files tracked, 0 commits in the whole history across all branches**, both matched by
      `.git/info/exclude` lines 7 and 8. Nothing of either is or ever was in this repo.
      The wider check is the one that matters and it also passes: `git add -A` right now would
      take only the two new task files, and every other ignored path in the tree is ignored by
      **`.gitignore`** - these two are the only ones relying on the local-only mechanism.
      **The hazard A6 named is unchanged and is not a this-clone problem.** `.git/info/exclude`
      does not travel: on a fresh clone elsewhere neither directory is ignored at all, and one
      `git add -A` after copying private content there commits it.
      **A6's follow-up was never written** (checked: the only `info/exclude` mention in
      `CLAUDE.md` is about the VAULT's exclude file, for `.vault-meta/` artifacts). A note
      belongs near the setup script, and it has to name the MECHANISM rather than the two
      paths - naming them in a tracked file is exactly what choosing `.git/info/exclude` over
      `.gitignore` was avoiding, and one of them would disclose an unshipped subsystem.

## 5. Screenshots

- [x] **Re-shot 2026-09-21 against the demo vault, all 14, service on port 8422.**
      **The port matters and the script's own recipe was wrong:** its header said `PORT=8421`,
      which is where the LIVE service runs against the production vault. Following that recipe
      today either fails on a bound port or photographs the real vault, which is exactly the
      "one environment variable away" mechanism section 5 of TASKS-A6 warns about. Shot on 8422
      with `BASE_URL` set to match; `TELEGRAM_BOT_TOKEN=` stays mandatory, or the demo process
      takes the real bot off its own token.
- [x] **The pinboard now shows the clustering, because the demo vault was taught to produce it.**
      The generator wrote questions per domain, so no two pages carried the same one and the
      `also on` half of the board was invisible. `demo-vault.mjs` now leaves one open item on
      three pages in three wordings - the shape the code's own comment describes, a run writing
      the same gap onto its notebook, its synthesis page and the concept page it touched. The
      wordings were checked against the board's rule rather than eyeballed: `questionOverlap`
      puts both variants at **1.00** against the notebook's wording, where `CLUSTER_THRESHOLD`
      is 0.7. A missing target page throws rather than silently producing a board without the
      feature. Verified in the shot: one card, `also on` two pages, and the header reads 21
      questions where the API returns 23 bullets - three merged into one.
- [x] **All 14 looked at, 2026-09-21, and it earned its keep twice** (the F-A6-28 experience
      repeating). Nothing in any of them names a real page, domain or person; the pharma
      vocabulary visible on the pinboard, the reading list and the result page is the four
      captured `demo-research` runs A6 accepted as deliberate.
- [x] **Defect found by looking: `home-night.png` was not the night view.** It showed the
      Activity tab, near-identical to `home.png`, which a size check cannot catch (503 KB, an
      entirely plausible number) and only an eye or the log could. The cause was the shot's
      SETTLE condition, not its click: `[role="tab"], .seg button` also matches the Research
      screen's segmented control, which the SPA keeps mounted, so the condition went true
      before Home's own tab strip existed and `act` clicked nothing. It now waits for the
      button it is about to click. Re-shot with `ONLY=`, verified by eye.
- [x] **Three warnings added to the script header, each from a failure of this session.** The
      recipe said `PORT=8421`, which is the LIVE service against the real vault: following it
      photographs the wrong vault, the "one environment variable away" mechanism that caused the
      original leak. A build invalidates every running service, because asset routes are
      registered at startup, and `pkill -f "PORT=8422"` matches nothing since env prefixes are
      not in `ps args`. And "Wrote 14 screenshots" means written, not correct: a missed click
      says so on its own line, and a page that rendered no JavaScript comes out near 19 KB
      against 200 KB to 1 MB for a real one.

### What went wrong here, because the next person will hit it too

**14 good screenshots were overwritten with 14 blank ones and had to be restored from git.**
The chain: a `npm run build` changed the bundle hash; the demo service was NOT restarted,
because the kill matched no process; it kept serving an asset list that no longer existed; every
page rendered without JavaScript; all 14 shots came out at 19 KB; and the run reported "Wrote 14
screenshots" and exited 0. Three checks would each have caught it alone - restart by PID and
verify, curl one asset before shooting, read the size column - and none was done. The same build
also left the LIVE service 404ing its own JavaScript until it was restarted.

### What looking at a screenshot found that reading the code had not

- [x] **BUG, fixed 2026-09-21: the whole web frontend was still on the legacy research prefix.**
      `research.png` previewed `FILES AS Research: your topic`, and the server has filed
      `Research - ` since `f4ce7b9` in this very merge. `web/src/lib/researchRuns.ts` and
      `homeArticle.ts` each kept their own `RESEARCH_PREFIX = 'Research: '`, and it is not
      cosmetic - it is five semantic call sites: `splitResearchTitle` returns **null** for a
      current title, `isSynthesisPath` does not recognise a current synthesis page,
      `mainArticle` cannot find one, `Chat.tsx` leaves the prefix in the heading, and
      `targetTitle` predicts a name the run will not use. `researchRuns.ts` warns about this
      exact failure in its own docstring ("shown here as one name and filed under another").
      Fixed by mirroring the server: build with `RESEARCH_PREFIX`, recognise both it and
      `LEGACY_RESEARCH_PREFIX` everywhere, including the last-resort name lookup in
      `synthesisPage` - predicting only the current spelling there would have lost exactly the
      older runs that fallback exists for.
      **Why the suite was green through all of it:** all 34 prefix cases in
      `web/test/researchRuns.test.ts` fed the LEGACY spelling, so nothing ever asked whether
      recognition still matched what the server writes. A case for the current prefix is added;
      the legacy cases stay, because those pages do not rename themselves.
      **This is F-A6-32 repeating exactly.** Reading the README against the running app found a
      class of error that reading it against the code did not - and so did reading a screenshot.
      I had read `research-profiles.ts`, seen the prefix change, and never thought to ask what
      the other workspace believed.

## 6. The pull request

- [x] **Done as a merge commit.** The histories have not diverged, so this is
      simpler than last time. A6's reasoning for the merge commit holds: the messages ARE the
      design record.
- [x] **Stated, and re-measured on the committed state.** Measured: the three
      manifests differ from upstream by npm scripts only. It was the strongest line in the last
      PR and it is true again.
- [x] **Done, and the posted body was scanned in its exact final form** (hard rule 7). Draft it
      in a file, scan that file, then paste it.
- [x] **Done 2026-09-21.** Tagged on both remotes, and the record is section 7 below rather than
      a spec section: the two behaviours this round added went into `SPEC.md` itself (12.15 and
      12.16), so there is no separate subsystem document to carry an "as delivered" note.

## 7. As delivered (2026-09-21)

**Merged as [steinborndev/LibrisVault#16](https://github.com/steinborndev/LibrisVault/pull/16)**,
merge commit `3068ac3`, 98 commits, 222 files, +23.5k / -0.6k. A merge commit rather than a
squash, because the messages are the design record. Tagged `vault-layer-2026-09-21` on both
remotes; the `vault-layer` branch was deleted after the merge, as the previous round's was.
`upstream/main` carries everything now: 0 commits remain above it.

| Gate | As merged |
|---|---|
| `npm test` | exit 0, 2,569 tests (server 1,913 / 114 files, web 656 / 64) |
| `npm run typecheck` / `lint` / `build` | exit 0, both workspaces |
| CI on the pull request | **green**, both runs of the four gates |
| `permprobe` | PASS, both canaries blocked, by two different mechanisms |
| `preprocprobe` | PASS, 14 checks, "the jail holds" |
| `vaultprobe` | PASS, all four text contracts hold (first run: it is new here) |
| Private-content audit | added lines 9 matches, commit messages 1, PR body 0, all accepted |

**Delivered beyond the plan this file opened with**, all of it found by running the finished
machinery rather than by reading it:

- a frontend bug shipped by this merge's own prefix change, invisible to a green suite because
  every test case fed the legacy spelling (section 5);
- four tracked files that made a Windows clone fail, found by retracting a wrong leak finding;
- a scanner blind spot that had been hiding a page name in plain sight, closed rather than
  recorded (section 4);
- six undocumented API routes and one misfiled behind the feature-flag divider (section 3);
- a completeness grep in hard rule 1 that proved less than it claimed, in both directions.

**Decided rather than fixed:** the passage naming a vault page in full was reformulated to state
its finding instead of quoting it, and the note about the local-only exclude mechanism was left
to write, with the constraint that it must name the mechanism and not the two paths.

**What this round did NOT do.** No version bump and no release: the packages are private, nothing
reads the version, and the install is a clone of `main`. A `CHANGELOG.md` was started instead,
with an entry for the previous merge as well, so the record does not begin in the middle.
