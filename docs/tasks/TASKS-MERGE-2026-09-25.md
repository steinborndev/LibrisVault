# TASKS-MERGE-2026-09-25 - Merge preparation, third round

Goal: everything Curious has built since the vault-layer merge (LibrisVault#16) becomes part of
LibrisVault without a private page, a local path or an undocumented behaviour going with it. Same
acceptance and procedure as `TASKS-MERGE-2026-09-21.md`, which repeats TASKS-A6 section 0:
`npm test`, `npm run typecheck`, `npm run lint` green AND exit 0; `permprobe` reports
`canary outside vault: blocked`; `SPEC.md`, `CLAUDE.md`, `README.md`, `docs/API.md` and
`CHANGELOG.md` describe what shipped; every screenshot comes from the synthetic vault; the
private-content audit over the final merge diff is clean. **The merge into the public repo itself
waits for the user's explicit go.**

## 0. Scope as measured 2026-09-25

`git merge-base main upstream/main` is `b452337`; upstream's head `3068ac3` is the merge commit of
#16 and adds no content of its own (`git diff b452337 upstream/main` is empty). So, as last time,
nothing to rebase and no conflict to resolve.

| | |
|---|---|
| Commits above upstream | 187 (152 without merges) |
| Files / lines | 146 files, +24,970 / -2,151 before this preparation |
| New runtime dependencies | **zero**, in either workspace. The manifests differ by npm scripts only (`splitprobe`, `graphprobe`, `backfill-quote-evidence`) |
| Work streams | the path out of the standing defect list (`TASKS-DEFECT-PATHS.md`), splitting an oversized domain (`TASKS-DOMAIN-SPLIT.md`), the Landmarks overlay (`TASKS-LANDMARKS.md`), and a UI round on the Graph and System screens plus test and queue fixes that no task file records (sections 3 and 6 below) |
| New routes | 20, all but one documented by their own work stream |
| Removed routes | none |

## 1. Gates

- [x] **Green on the prepared tree** (section 7 records the numbers as committed).
- [x] **CI green on Curious** through `ef0650d`. It was red once on 2026-09-25 (`43bc3ba`), a
      teardown racing a detached `git gc` rather than a failing assertion; fixed in `72cf6cf`
      together with two more flaky tests the stress loop found (section 6).

## 2. Probes

- [x] **`permprobe` - DONE 2026-09-25, run with authorisation because it is billable. PASS.**
      Due because `permissions.ts` gained 54 lines and `agent-runner.ts` 11 (`fc6e90d`, a defect
      fix bound to the pages of its findings). `canary outside vault: blocked`, `canary in
      skills/: blocked`, and again by two DIFFERENT mechanisms: `/tmp` came back `Read-only file
      system` (the OS sandbox), the `skills/` write was refused by the tool policy in-process. The
      expand probe's five checks all ok, three denials in its throwaway vault. The vault's git
      state was clean before and after, at the same head; no canary remained.
      **What the probe does not cover, stated rather than implied:** it has no case for the NEW
      policy. That policy is a branch of the same `PreToolUse` guard the expand checks just showed
      the SDK consulting, and its logic is exercised through that guard in
      `server/test/defect-fix.test.ts`; the live bound runs of `TASKS-DEFECT-PATHS.md` phase 4
      ran under it. A live defect-fix case in `permprobe` would close the gap and is left as a
      follow-up, because it costs a run for a branch whose wiring the probe already proves.
- [x] **`vaultprobe` - DONE 2026-09-25, PASS.** All four text contracts hold; the vault's git state
      was clean before and after.
- [x] **`preprocprobe` - DONE 2026-09-25, PASS, 14 checks.** Not strictly due (the converters are
      untouched), run for the reason A6 gave: the jail is a property of the host as well.

## 3. Documentation

- [x] **`README.md`.** The Graph section describes the four overlays (Landmarks, Areas,
      Spotlight, Bridges), the lock and the per-mode Shortcuts card, and the reading view's link
      lists; two new screenshots stand under it. The System section describes the map
      (Overview, Maintenance, Insight, Settings, Instance). Nine `System → ...` references named
      sections that no longer exist (Integrations, Service, Service & config, Checks, Vault
      stats for the index) and point at the new ones. The defect bullet no longer says findings are
      "never a rewrite": each rule now has a repair, a bound run or an accept. The domains bullet
      names the split.
- [x] **`docs/API.md`.** Every route in `server/src/api/routes/` diffed against the file, 115 of
      them. The one new route missing was `DELETE /maintenance/state/:runId`. Carried-forward gaps,
      closed as last time: `/proposals/:id/{approve,veto}` did not exist (the routes are `decide`
      and `run`), and `GET`/`DELETE /agents/:id`, `/agents/:id/candidates`,
      `/agents/:id/proposals`, `POST /wings` and `DELETE /wings/:id` were undocumented.
- [x] **`SPEC.md`.** Three amendments: §3.1, the queue runs in insertion order; §6, a correction
      for the System screen's new shape; §12.4, the four overlays and the Landmarks mode, with the
      rules a reader of the code would otherwise have to reverse-engineer (the landmark share, the
      reading-order walk, the cross-domain weight, which tags may caption an area, the keep-out
      boxes, the related-by-tag rule). The domain split (§12.4 stage 4) and the defect paths
      (§12.16) came with their own work streams.
- [x] **`CHANGELOG.md`.** An entry for the work after the domain split; the defect paths and the
      split already had theirs.
- [x] **`CLAUDE.md`.** The writer table already carries the split writer and both defect-repair
      halves. Added: the note on `.git/info/exclude` that the 2026-09-21 merge left to write, naming
      the mechanism and not the paths.

## 4. Private-content audit (hard rule 7)

- [x] **`vault-name-scan --diff upstream/main`: 3 matches, all accepted.** `Anthropic` and `Cursor`
      are product vocabulary (accepted since A6); "six months on." is a plain English phrase that
      also ends one research-question title.
- [x] **Commit messages: 1 match**, `Anthropic` in the co-author lines.
- [x] **Read by hand, the part a scanner cannot do.** The four new task files, the three new
      scripts and every added comment, string literal and fixture in `web/` and `server/` were read
      against the vault's titles, tags, domain keys and Fellow names. Found and fixed:
      - a domain key of this vault that is not public, in a CSS comment (`styles.css`, the width of
        the Areas ring's name slot); now "a thirty-character key";
      - a test fixture naming a page and domain that mirror this vault's structure under a British
        spelling the scanner does not match (`scopeHeading.test.ts`); now synthetic;
      - a quotation of this vault's registry description in a code comment and in the domain-split
        task file; both reworded to state the finding without quoting.
      **Measured, not assumed:** the generic domain keys the task files use (biomedicine, cooking,
      finance, machine-learning and six more) were already public in LibrisVault before this merge.
- [x] **The history carries the CSS comment's first wording.** The merge keeps the commits as they
      are (A6 D4), and Curious is public already, so the key has been readable there since
      2026-09-24. Fixed at the tip, as A6 fixed the already-public fixtures, rather than by
      rewriting a public history.
- [ ] **The PR body, scanned in its exact posted form** (section 8).

## 5. Screenshots

- [x] **Re-shot 2026-09-25 against a freshly generated demo vault**, service on port 8422 with
      `TELEGRAM_BOT_TOKEN=` empty, all 16. Every one looked at: nothing names a real page, domain
      or person; the pharma vocabulary on the pinboard and the result page is the four captured
      `demo-research` runs A6 accepted.
- [x] **Two new shots**: `graph-landmarks.png` (the Landmarks overlay on the demo's deepest domain,
      in the page-type view) and `graph-areas.png` (Areas over the same domain, captioned).
- [x] **The script states each graph shot's view.** It drives one browser tab, and the graph keeps
      its view in `localStorage`, so a Landmarks shot left every later graph shot - and the next run -
      in Landmarks. A shot's `prefs` field now writes its view before it loads.

## 6. Work no task file records

For the reader of this merge who asks where the rest came from, from the commit bodies:

- **System screen** (`8f9162b`, `3cc26cd`, `89ac87a`, `cdb9189`, `1464346`): the map of section 3.
- **Graph, Spotlight and Areas** (`8875216` to `3d454f9`): one hull geometry for the spotlight's
  drawing, pointer and click; captions in the display face; the Areas stepper; hulls that hold
  every member; tags that name a kind of page taken out of captions and "related by tag"
  (measured: 30 % of related entries came from another domain, 1,623 of them over one shared tag);
  the cross-domain weight 0.25 to 0.1 (mixed communities 9 to 4 of 35); a zoom over a whole vault
  with Areas on from 780 ms to 17 ms a frame.
- **Landmarks after its task file closed** (`312de41` to `87a945d`): recorded in that file's
  later paragraphs.
- **Tests and the queue** (`72cf6cf`, `569a17c`): git housekeeping off in every test run, flushed
  Fellow work, a monotonic clock in the Fellow tests (the WSL clock stepped back up to 1.2 s), and
  the queue in insertion order. 75 stressed runs of the git-heavy suites without a failure,
  against 3 in 90 before.

## 7. As prepared (2026-09-25, `7f73dfb`)

| Gate | Result |
|---|---|
| `npm test` | exit 0, **2,890 tests** (server 2,090 / 124 files, web 800 / 75) |
| `npm run typecheck` / `lint` | exit 0, both workspaces |
| CI on Curious | **green** on `7f73dfb`, build included |
| Scope | 189 commits above upstream (153 without merges), 161 files, +25,385 / -2,192 |
| `vaultprobe` / `preprocprobe` | PASS / PASS |
| `permprobe` | PASS, both canaries blocked, by two different mechanisms (section 2) |
| Private-content audit | added lines 3 matches, commit messages 1, PR draft 0, all accepted |

## 8. The pull request

- [x] **Merge approved by the user 2026-09-25, after the permission probe.** `main` pushed to
      LibrisVault as `repairs-splits-landmarks`; the PR opened from the drafted body with the
      numbers filled in, and the exact title and body files `gh pr create` was given were scanned
      first: nothing matched, no dashes.
- [x] **Merged as a merge commit** once both CI runs of the four gates passed (4m13s, 4m16s).
- [x] **Tagged `repairs-splits-landmarks-2026-09-25` on both remotes**, branch deleted.

## 9. As delivered (2026-09-25)

**Merged as [steinborndev/LibrisVault#17](https://github.com/steinborndev/LibrisVault/pull/17)**,
merge commit `c52e997`, 191 commits, 161 files, +25.4k / -2.2k. `upstream/main` carries everything:
0 commits remain above it, and its tree equals Curious `main`.

| Gate | As merged |
|---|---|
| `npm test` | exit 0, 2,890 tests (server 2,090 / 124 files, web 800 / 75) |
| `npm run typecheck` / `lint` / `build` | exit 0, both workspaces |
| CI on the pull request | **green**, both runs of the four gates |
| `permprobe` | PASS, both canaries blocked, by two different mechanisms; expand lock intact |
| `preprocprobe` | PASS, 14 checks |
| `vaultprobe` | PASS, all four text contracts hold |
| Private-content audit | added lines 3 matches, commit messages 1, PR title and body 0, all accepted; three wordings generalised by hand |

**Delivered beyond the plan**, found by running the finished machinery rather than reading it: a
screenshot script that carried one shot's graph overlay into the next and into the next run; three
flaky tests and the git housekeeping behind the red CI run; a queue that could run a later drop
first when the clock stepped back; and seven API routes documented wrongly or not at all.

**Left open:** a live `permprobe` case for the defect-fix policy (section 2).
