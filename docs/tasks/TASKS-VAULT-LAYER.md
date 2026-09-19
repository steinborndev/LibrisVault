# Tasks: the vault layer (2026-09-19)

Remediation of every finding in the vault-layer review (`docs/local/REVIEW-vault-layer-2026-09-19.md`,
local only, not committed: it quotes vault content). This file is the working document for a
fresh session. It carries the verification, the corrections, the new findings, the four
decisions that were settled with the user before any code was written, the phase order and the
definition of done for every task.

**Read first:** `SPEC.md`, `CLAUDE.md` (hard rules 1, 4, 5, 7, 8), and the two subsystem specs
(`docs/agents/SPEC.md`, `docs/sources/SPEC.md`). Where this file and the spec disagree, the
spec wins; say so and ask before deviating.

**Public repo (hard rule 7).** Everything below describes mechanism, never subject. No page
title, person, organisation or handle from the vault appears here, and none may appear in a
commit message or PR body produced from this file. Run `scripts/vault-name-scan.mjs --diff`
over the added lines and `--file` over any PR body before posting.

---

## 0. Status of the review: what was verified, and how

Every finding was re-measured against the repo at `e20b60f` and the vault at `~/vault`
(claude-obsidian v1.9.2, Generic mode, 1247 wiki pages, 764 vault commits). **All twenty
findings hold.** Numbers that differ from the review differ by measurement method, never by
substance; both values are given so a later re-run can tell drift from method.

| ID | Verdict | Re-measured |
|---|---|---|
| A0 | confirmed | skill really runs (32 log rows name the namespaced ingest skill); both sides take the lock; 36 raw provenance links, 35 resolve; 1174 of 1247 pages carry an address, **0 duplicates**, counter 1189 against max address 1188 |
| A1 | confirmed | `.vault-meta/auto-commit.disabled` is created by `scripts/dev-instance.sh:64` and nothing else. `setup-all.sh` never touches it, no code path in `server/src` reads it. The file on the live vault is dated 2026-07-17 and has survived by luck |
| A2 | confirmed | 136 paired acquire/release spans: median 23 s, p75 34 s, p90 59 s, max 108 s, **9.6 % over the 60 s window** (review: 7 % over 51 spans; both methods agree on the shape). The long holds are all on `index.md`, `hot.md` and `log.md` |
| A3 | confirmed | `queue.ts:347` defaults to 2; **13 overlapping job pairs** of 31 finished jobs. The skill's rule is verbatim at `skills/wiki-ingest/SKILL.md:336`. SPEC.md §3.1 (line 69) not only fails to record the deviation, it claims the lock covers it |
| A4 | confirmed | 93 `wiki: auto-commit` commits, newest 2026-05-18 (upstream, pre-service). 5 repair commits in history. `git commit` is not denied for an ingest run |
| A5 | confirmed | `wiki-fold`, `tiling-check.py`, `agents/verifier.md`, `wiki-mode.py`: **zero** references in `server/src` or `scripts`. `save` skill likewise. `detect-transport.sh` is bypassed by an mtime bump. **Correction:** the transport pin is not currently wrong; it carries `manual_override: true` and is right for this host. Latent, not live |
| A6 | confirmed | all four contracts located: `queue.ts:571-578` (log format decides job status), `lint-report.ts:44` (report headings), `maintenance.ts:657-676` (autoresearch flow in prose plus a hard path into the skill's references), `validator.ts:60,134-140` (address rules and rollout baseline) |
| A7 | confirmed | 7 recap pages, 5 Fellow notebooks, 1 reading list, all under `wiki/meta/`. Float artifact reproduced and **root-caused**: `usage-monitor.ts:288` rounds only the `u <= 1` branch and passes the raw float through above it; the DB holds `7.000000000000001` from source `sdk`, and `recap.ts:675` interpolates it unformatted |
| A8 | confirmed | the ingest prompt is `ingest <artifact>` plus five system-prompt rule blocks and provenance. No retrieval block, no overlap block. The two working mechanisms (`retrieveCandidates` for chat, `findRelatedPages` + `renderOverlapBlock` for research) are both absent from the one run type whose job is "create or update" |
| A9 | confirmed | 406 warn rows; by rule: dead-link 211, stale-counter 77, address-map 58, single-source-entity 11, dates 10, frontmatter 3. One dead-link class accounts for 109 occurrences (28+28+28+25 across two hub files). **Extra:** `jobs.validation` is NULL on all 37 jobs; `setValidation` stores only the quote summary, so there is no structured record to dedupe against |
| A10 | confirmed | hard rule 1 names four writers; the real set adds `notebook.ts`, `recap.ts`, `reading-list.ts`, `link-repair.ts`, `routes/domains.ts`. All correctly locked and committed |
| B1 | confirmed | `index.md` 514 kB / 1562 lines / longest line 13,345 chars / 105 `##` sections of which **94 are dated ingest events**; `log.md` 777 kB / 258 entries (review measured 757 kB, it has grown since); `concepts/_index.md` 154 kB; `sources/_index.md` 123 kB; `overview.md` 91 kB with a 25 kB line and the shipped demo text still at the top. The skill's own economics (`skills/wiki/SKILL.md:188`): "Index costs ~1000 tokens". It now costs roughly 128k |
| B2 | confirmed | concept pages: 604 total, **443 cite exactly one source (73 %)**, 92 cite none, 69 cite two or more. Entities: 107 of 225 cite one, 74 cite none. Git: of 1194 content pages with history, **149 (12 %) were written by two or more knowledge-adding commits, 727 (61 %) by exactly one**; concepts 17 %, entities 15 %, sources 4 %, questions 0 % |
| B3 | confirmed | 231 dead wikilink occurrences over 96 distinct targets out of 25,712 links. Colon-in-title 56, slash 65, trailing backslash 13 (exact match with the review), rest missing by design (lint reports, log). **Two pages account for 43 occurrences**, both the same mechanism: the colon survives in `title:`, the filer replaces it in the file name, every link written from the title dies. Both pages are also among the four reachable from no hub at all, so the class costs reachability as well as links. The hygiene rule at `system-prompt.ts:74-81` covers `/` and `\` and not `:` |
| B4 | confirmed | 604 concept pages carry **2243 distinct `##` headings**; best-shared is "Connections" at 41 %. Sources: 635 distinct, best-shared "Why This Source Matters" at 41 %. Entities: 194 distinct, "Connections" 36 % |
| B5 | confirmed | **352 of 1210 content pages (29 %)** carry at least one run-protocol section, 302 kB in total. Open Questions 86, Editorial Note 59, Provenance 56, Assessment 55, Status of This Page 44, Relation-to-this-vault 33, Vault context 18, Entity Notability Note 9, Automated Decisions 7. Three pages describe the service's own untrusted-content fence inside an encyclopedia article |
| B6 | confirmed | **646 distinct tags over 4131 assignments, 320 (50 %) used exactly once**. Type mirroring by creation month: 96 % (Jul), 82 % (Aug), 84 % (Sep). Domain mirroring over the same months: 1 %, 0 %, 2 %. The difference is in the wording: the domain rule is absolute, the type rule says "beyond the structural ones the vault prescribes", which reads as permission |
| B7 | confirmed | `updated:` by month 781 (Aug) and 450 (Sep) against creation months 409/438/353; **1231 of 1247 pages (99 %) claim an update within 30 days**. `status:` 786 developing, 244 seed, 150 mature, plus **nine further values** in ones and twos (drift on top of the loss of signal) |
| B8 | confirmed | 47 pages created 2026-04 to 2026-06, 17 carrying the upstream community footer, under domains `meta`, `ai-tooling` and `knowledge-management` |
| B9 | confirmed | **10,257 em-dashes across 819 pages, exact match.** 4 alias collisions (one of them a duplicate alias inside a single file, so 3 real; none shadows a page title). 27 unresolved contradiction callouts. 67 pages with an "as of <date>" hedge. 51 content pages linked from no `index.md` entry, 4 in no hub at all. Language rule holds |

### Two corrections to the review

**C-1. `wiki-fold` does not shrink `log.md`.** The skill is explicitly additive: "child log
entries and their referenced pages are never modified, moved, or deleted"
(`skills/wiki-fold/SKILL.md`). The vault's single fold page is from 2026-04-24 and `log.md`
still begins at 2026-04-07. So the review's step 3 ("fold `log.md` with the vault's own
`wiki-fold`") produces a fold page beside an unchanged 777 kB file. Shrinking `log.md` is a
separate, deliberate act - **and it breaks A6 contract 1, because `ingestLoggedCompletion`
decides whether a crashed job finished by searching `log.md` for the job's raw directory.**
Order is therefore forced: the completion marker has to leave `log.md` (task 2.4) before
anything truncates it (task 8.8). This dependency is the single most important line in this
file.

**C-2. A5's transport pin is latent, not live.** `.vault-meta/transport.json` carries
`manual_override: true`, pins `filesystem`, and is correct for this host (no `obsidian-cli`
present). The mtime bump is still a workaround rather than a detection and still means a wrong
pin could never self-correct, but nothing is wrong today.

### Five new failure modes, all measured

| ID | Finding | Measurement |
|---|---|---|
| **N1** | `.raw/.manifest.json`'s `address_map` is **23 % incomplete, and no check looks**. `validator.ts:489-511` walks the map and asks whether each entry still resolves; nothing walks the pages and asks whether each has an entry. Two further gaps in the same file: **20 of 226 `.raw/` job directories are named nowhere in `sources`**, so `buildSourceIndex` and `dedupe.jobForPage` are blind to what those documents produced, and 7 `pages_created` entries point at pages that no longer exist | 900 map entries against 1174 pages carrying an `address:`; 274 missing |
| **N2** | **The vault repo is 1.4 GB carrying 16 MB of knowledge.** History by class: `.raw` originals 786 MB in 641 blobs, **`.raw` OCR derivatives 627 MB in 16 blobs**, wiki 232 MB, other 28 MB. `ocr.pdf` is written by `preprocess/plugins/pdf.ts:125` into the tracked job directory. It is rebuildable from the original PDF lying beside it, which is exactly the category `vault-excludes.ts` was written to keep out. Three single blobs exceed 150 MB | `git rev-list --objects --all` with `cat-file --batch-check` |
| **N3** | **83 % of the wiki's git history is six hub files being rewritten whole.** `log.md` 89 MB over 257 versions, `index.md` 53 MB over 241, `hot.md` 24 MB over 271, `_index.md` hubs 24 MB over 484, `overview.md` 2.8 MB over 89. All 1194 real knowledge pages together: 39 MB over 5188 versions. Every ingest costs roughly 570 kB of permanent history for hub bookkeeping alone | same method, grouped by path |
| **N4** | **The retrieval index is refreshed by ingests only.** `startRetrieveIndexScheduler` (`retrieve-index.ts:365-382`) subscribes to `kind: 'job'` events with status `done`. Research runs, the night shift, Fellow runs, lint-fix, `PUT /pages`, `POST /questions/archive`, recap and notebook writes all create or change pages through `agent_runs` and direct writers, and none of them resets the timer. Second defect in the same function: a 5-minute debounce with no maximum wait, so a continuous stream of finishing jobs postpones the rebuild indefinitely | code reading, confirmed against the event producers (`db/jobs.ts:506,552,760` are the only `kind: 'job'` publishers) |
| **N5** | **Destructive git is not in the bash denylist.** All four deny patterns were run against nine candidate commands: `git reset --hard`, `git clean -fdx`, `git checkout -- wiki/`, `git filter-branch`, `rm -rf wiki/concepts`, `truncate`, a python one-liner and `find -delete` are all **allowed**. The sandbox permits writes under `VAULT_ROOT` and `.git` is under `VAULT_ROOT`, so history destruction is the one class the sandbox structurally cannot contain, and it breaks hard rule 1's "versioned and revertable" irreversibly. (`git push` is harmless here: both vault remotes are set to `PUSH_DISABLED_vault_is_private`) | `permissions.ts` `BASH_DENY` evaluated against the candidates |

Smaller verified items that belong to no numbered finding:

- `.vault-meta/lint_scan.py`, `lint_scan_out.json` (472 kB) and `tag_repair_report.json`
  (90 kB) are **already tracked**. `vault-excludes.ts` says so itself: excludes only bind
  untracked files. The scratch is therefore permanent and re-committed on every change.
- `wiki-lock.sh` hashes the **raw path string** (`sha1_of "$path"`), with no normalisation.
  `wiki/x.md` and `./wiki/x.md` are two different locks on one page. Every current caller on
  both sides passes the canonical `wiki/...` spelling, so this has not bitten; it is one line
  of hardening on our side and unfixable on the agent side.
- `withWikiLocks` acquires a batch serially and holds the first lock for the whole batch. A
  repair over more than about 30 pages outlives the 60 s window on its earliest locks.
- `ingestLoggedCompletion` reads the whole 777 kB `log.md` once per stuck job, and `log.md` is
  newest-first, so only its head can ever matter.
- `index.md` and the `_index.md` hubs carry an unbounded accumulating `related:` frontmatter
  list, with duplicate entries.

### Baseline at the start of this work

`npm run typecheck` exit 0. `npm test`: 89 server files / 1313 tests, 58 web files / 615
tests, all passing, exit 0. This is the bar every phase has to return to.

---

## 1. The four decisions

Settled with the user on 2026-09-19, before any code. Not reopened here; a task that seems to
need a different answer stops and asks.

**D1. Scope: prevention plus a one-off repair of the existing content, no history rewrite.**
Code, prompts, validator and probes change so the classes stop recurring, and a set of
deliberate repair runs fixes the standing damage (hubs, dead links, address map, tags, process
sections, em-dashes, demo pages). The 1.4 GB history is **not** rewritten: `git filter-repo`
would invalidate every `jobs.commit_hash`, and with it the revert button, the job rows and
`recoverPageRecord`. Consequence for the phase order: the mass repair re-stamps `updated:` on
most of the vault, so **task 7.3 (a separate `content_updated:` field) must land before phase
8**, or the repair destroys the same signal a second time.

**D2. The service takes over the hub pages; the agent is told not to touch them.** After every
vault-writing run the service writes `wiki/index.md` and the `wiki/log.md` entry itself,
deterministically, inside the commit mutex. The prompt says so and the write guard enforces it,
but the load-bearing enforcement is **regeneration**: `index.md` is derived from page
frontmatter, so an agent write to it is simply overwritten on the next run rather than having
to be prevented. What this buys, in one move: A2's race loses its target (the three long lock
holds are all on these files), N3's 83 % history churn stops, A6 contract 1 becomes our own
format instead of a skill's prose, `log.md` becomes truncatable, and the whole `stale-counter`
class (77 findings) disappears because the counters are computed rather than maintained.
Price: **CLAUDE.md hard rule 1 gains a documented writer**, and the hub prose gets plainer.
`hot.md` stays with the agent - it is a semantic summary the service cannot generate, it is
rewritten whole rather than appended, and a lost update there costs a cache, not knowledge.

**D3. Concurrency default drops to 1.** The ingest skill's single-writer rule is followed
literally. This removes the race class outright rather than relying on D2 having removed its
target, and it holds even for runs that D2 does not cover. The cost is roughly half the
throughput on batch drops and night shifts. Raising it back to 2 later is a separate,
evidence-backed decision that requires D2 shipped and a measured run of the hub-write path; the
deviation and its reasoning get written down either way, because SPEC.md §3.1 currently asserts
the opposite of what is true.

**D4. `.raw` policy: derivatives out, plus a size cap.** `ocr.pdf` and any other derived
artifact are excluded from vault git the same way the retrieval index is. On top of that, an
original larger than a configured cap (default 25 MB) stays on disk but is not versioned, and
the manifest records that the payload is local-only. Provenance stays intact for everything
normal: the commit still captures the source beside the pages made from it. Existing large
blobs stay in history (D1).

---

## 2. Invariants: what may not break, in any phase

Check these before calling any phase done. They are the reason several obvious shortcuts below
are not taken.

1. **Hard rule 1.** Pipeline code never deletes or rewrites vault content outside the sanctioned
   exceptions. D2 adds one; it has to be written into CLAUDE.md as part of phase 2, not after.
   Every new writer takes the vault's own per-file lock first and the commit mutex inside it
   (foreign-then-ours), and commits behind the mutex.
2. **Hard rule 4.** `canUseTool` stays advisory; `PreToolUse` stays the enforcement point; the
   sandbox stays the boundary. The bash denylist stays a denylist and never becomes a
   `scripts/*.sh` whitelist. **Re-run `server/src/cli/permprobe.ts` after any change under
   `permissions.ts` or the runner's permission wiring; expect `canary outside vault: blocked`.**
3. **Hard rule 5.** No edits inside the cloned vault's own machinery. Everything this file adds
   reaches the vault through `systemPromptExtra`, through `scripts/vault-extensions/`, or
   through the service's own writers.
4. **Hard rule 6.** Every converter keeps going through `runConverter`. **Re-run
   `server/src/cli/preprocprobe.ts` after any change under `preprocess/`** (phase 6 touches
   `pdf.ts`).
5. **Hard rule 7.** No vault subject in any committed line, comment, fixture, UI string or PR
   body. `scripts/vault-name-scan.mjs --diff <base>` over the added lines before every PR, and
   `--file` over the PR body.
6. **Hard rule 8.** `AGENTS_ENABLED` off changes nothing. No base-product screen gains a query
   against a Fellow-only route; `server/test/agents-flag-off.test.ts` stays green. Source
   integrity stays outside the flag.
7. **`npm test`, `npm run typecheck` and `npm run lint` all pass and exit 0** before a phase is
   called done. A green suite is not a green repo: `tsconfig.build.json` excludes `test/` and
   vitest does not typecheck.
8. **Nothing in this work runs against the live vault without a fresh backup** (task 0.3), and
   no phase starts a live agent run while the systemd service is up. The dev instance and the
   live service share `~/vault` and hold separate in-process commit mutexes.

---

## Phase 0: the net, before anything moves

Nothing in this phase changes behaviour. It exists so every later definition of done is a
number that can be compared rather than a judgement.

### 0.1 `scripts/vault-audit.mjs`: the measurement harness - DONE 2026-09-19

- [x] One script, read-only, that reproduces **every number in section 0 of this file** from a
      vault path given as an argument. Grouped output plus `--json` for diffing two runs.
- [x] It must cover at least: page counts by type; sources per page by type; multi-commit rate
      by bucket; hub sizes, line counts, longest line, `##` section counts and how many of them
      are dated events; dead wikilinks with the cause classification (colon, slash, trailing
      backslash, other); distinct `##` headings by type with the best-shared share; run-protocol
      sections by heading with byte volume; tag counts, single-use share, type and domain
      mirroring by creation month; `updated:`/`created:` by month and the 30-day share;
      `status:` value distribution; em-dash count and page count; alias collisions;
      contradiction callouts; pages absent from `index.md` and from every hub; address
      integrity in both directions plus orphan `.raw` job directories; git history bytes by
      class and by hub file.
- [x] Unit tests over a fixture vault under `server/test/fixtures/` (not the real one) covering
      at least the dead-link classifier, the mirroring detector and the address-map both-ways
      check.
- **DoD:** `node scripts/vault-audit.mjs ~/vault` reproduces section 0's table within the
  stated method tolerance, runs in under 60 s, writes nothing, and its JSON output is committed
  once as `docs/tasks/vault-audit-baseline-2026-09-19.json` (numbers only, no titles, no page
  paths - hard rule 7; the script needs a `--redact` mode that drops every path and title from
  the JSON, and that mode is what gets committed).

**Result.** `node scripts/vault-audit.mjs ~/vault --now 2026-09-19` runs in **1.2 s** (budget
60 s), writes nothing, and the redacted JSON is committed as
`docs/tasks/vault-audit-baseline-2026-09-19.json` (9.8 kB; `vault-name-scan --file` over it
matches nothing, and the only free text left in it is hub file names and the vault HEAD hash).
28 unit tests over `server/test/fixtures/audit-vault/`, a hand-built vault carrying one planted
instance of every defect class.

Reproduced **exactly**: 1247 wiki pages; concepts 604 / entities 225 / sources 338; concepts
443 single-source (73.3 %), 92 none, 69 two-or-more; entities 107 / 74; `index.md` 105 `##` of
which 94 dated; `log.md` 258 entries; 2243 distinct concept headings at 41.1 % best-shared,
635 source headings at 40.8 %, 194 entity headings at 36.4 %; 10,257 em-dashes across 819 pages;
4 alias collisions; 1174 pages with an address, 900 map entries, 274 missing, 0 duplicates,
counter 1189 against max 1188; 226 `.raw` job dirs, 20 named in no source, 7 dangling
`pages_created`; 1231 pages (98.7 %) updated within 30 days; status 786 / 244 / 150 plus a tail
of ten one-off values; type mirroring 96 % / 82.2 % / 83.5 % by month; hub share of wiki history
83.3 %, `log.md` 257 versions, `index.md` 241, `hot.md` 271, `_index.md` 484, `overview.md` 89;
OCR derivatives **658 MB in 16 blobs**, three single blobs over 150 MB.

**Where the harness disagrees with section 0, and why.** Recorded here so a later re-run can
tell drift from method; none of these change a verdict.

| Number | Section 0 | Harness | Cause |
|---|---|---|---|
| hub and history sizes | 514 kB, 777 kB, 89 MB | 502 kB, 759 kB, 93.4 MB | section 0 is in KiB/MiB, the harness prints decimal kB/MB. The byte counts are identical |
| dead links | 231 over 96 targets | 168 over 49 | the link COUNT agrees (25,711 against 25,712), so extraction is the same; resolution is not. The harness resolves a path-shaped target as a path and falls back to its basename, which is what Obsidian does. It reports the service's stricter answer beside it (`asTheServiceResolves`, 107) |
| dead by cause | colon 56, slash 65, backslash 13 | colon 55, slash 30, backslash 5 | the colon class is stable across every method tried. The backslash class is down to 5 occurrences and **all five sit inside one lint report**, quoted as findings: `link-repair.ts` has since repaired the live ones. The slash gap is the basename fallback above |
| multi-commit | 1194 pages, 149 multi, 727 once | 1208 pages, 153 multi, 714 once | section 0 counted paths history knows including deleted pages (the harness reports that too: 1195). The harness counts pages that exist now, because a deleted page is not repairable. Bucket rates agree: concepts 16.6 %, entities 16.4 %, sources 4.4 %, questions 0 % |
| tags | 4131 / 646 / 320 | 4134 / 648 / 322 | rounding in the by-hand pass; both count every page |
| domain mirroring | 1 %, 0 %, 2 % | 0 % in every month | the harness matches a domain tag exactly or as a singular/plural variant and **refuses to guess synonyms**. A near word ("biomedical" against `biomedicine`) is not counted. Same verdict either way: the absolute clause is followed, the hedged one is not |
| run-protocol | 352 pages, 302 kB | 350 pages, 324 kB | the harness's relation-to-vault matcher is wider by 5 pages, and it counts a section's full byte span |
| contradictions | 27 | 30 sections, 24 with content | the harness separates a section that says "none" from one that carries an open contradiction |
| pages in no hub | 51 / 4 | 48 / 1 | the harness follows `related:` frontmatter as well as body links, and counts `overview.md` and `hot.md` as hubs |

### 0.2 `server/src/cli/vaultprobe.ts`: the four text contracts (A6) - DONE 2026-09-19

- [x] A probe on the same reasoning as `permprobe` and `preprocprobe`: unit tests read the
      policy, only a probe proves the vault still speaks the language we parse.
- [x] It provisions a **scratch vault** (clone or fixture copy, never `~/vault`), runs one
      minimal ingest, and asserts all four contracts:
      1. the completion marker the queue keys on exists in the shape the queue expects
         (after phase 2 this is the new marker, see 2.4; keep both assertions during the
         transition);
      2. a lint report parses into non-empty sections with the summary counts populated;
      3. the paths the autoresearch prompt names (`skills/autoresearch/references/program.md`,
         `commands/autoresearch.md`) exist and the skill's filing step still mentions the hot
         cache;
      4. the address rules the validator mirrors still hold: `scripts/allocate-address.sh`
         present, `.vault-meta/legacy-pages.txt` parseable, the `# rollout:` line readable.
- [x] `npm run vaultprobe` wired in the root `package.json` beside the other two probes.
- [x] A line in CLAUDE.md conventions: **re-run `vaultprobe` after every vault upgrade**, next
      to the existing permprobe and preprocprobe sentences.
- **DoD:** the probe passes against the current vault, and fails with a named contract when run
  against a fixture whose log format, report headings, skill paths or address rules were
  deliberately broken (four negative cases, one per contract, as tests).

**Result.** `npm run vaultprobe` reports all four contracts green against `~/vault`
(`--verbose` prints the 22 individual assertions behind them). The checks live in
`server/src/pipeline/vault-contracts.ts` so they are testable; the CLI is a thin printer.

The four negative cases are `server/test/vault-contracts.test.ts` over
`server/test/fixtures/contract-vault/`, each breaking one contract the way an upgrade
plausibly would and asserting that **this** contract fails and the other three do not: a log
entry that stops naming its `.raw` source, a report whose `## Summary` is renamed, the
hardcoded `references/program.md` moved away, and an allocator that stops minting `c-NNNNNN`.
Three further cases: the failing assertion is named rather than just the contract, a vault that
has never been linted counts as undrifted rather than broken, and a missing vault reports four
failures instead of throwing.

**One deliberate deviation from the task text, for review.** The task says the probe
"provisions a scratch vault, runs one minimal ingest". A live run needs a credential and plan
quota and takes minutes, which would keep the probe out of every routine check - and the DoD
below asks for four negative cases that are all *file shapes*, which no run is needed to
assert. So the default form is static and takes milliseconds, and the live ingest is `--ingest`:
it provisions a scratch vault from the real vault's MACHINERY only (skills, commands, scripts,
plugin manifest; never the real `wiki/`), ingests one small note, and asserts the shape of the
`wiki/log.md` entry the run actually wrote. `--ingest` has not been run yet - the systemd
service is inactive and the first live run belongs with task 2.4, which changes this very
marker. Recorded here rather than quietly skipped.

### 0.3 Backups and the working rule - DONE 2026-09-19

- [x] Full backup of `~/vault` (a git bundle plus a tar of the working tree including untracked
      files) and of `~/.local/share/vault-service/jobs.db`, into `~/dev/brainvault-backups/`
      with the date in the name.
- [x] Note in this file which commit and which DB the backup covers.
- **DoD:** the bundle restores into a scratch directory and `git log` in the restored clone ends
  at the recorded commit; `sqlite3 <db> "pragma integrity_check"` says `ok`.

**Result.** In `~/dev/brainvault-backups/`, all dated `2026-09-19`: `vault-2026-09-19.bundle`
(1.38 GB, every ref), `vault-2026-09-19.head` (the covered commit, `35556a9...`, recorded as a
hash so no vault subject lands in this repo), `vault-worktree-2026-09-19.tar` (1.54 GB, the
working tree with untracked files, `.git` left out because the bundle carries the history) and
`jobs-2026-09-19.db` (5.7 MB, taken with sqlite's own `.backup`). Verified: the bundle clones
into a scratch directory and its `git log` ends at the recorded commit with **764 commits**;
`pragma integrity_check` on the DB copy says `ok`. The service was inactive for all of it.

---

## Phase 1: immediate safeguards (A1, A2, A3, A10, N5)

Small, independent, no content change. Ship as one commit per task.

### 1.1 Assert the auto-commit opt-out from the service (A1) - DONE 2026-09-19

- [x] `server/src/pipeline/vault-guards.ts` (new, or extend `vault-excludes.ts`):
      `ensureAutoCommitDisabled(vaultRoot)` returning
      `'present' | 'created' | 'no-vault' | 'unwritable'`, idempotent, creating the flag file
      when the vault is a claude-obsidian vault and the flag is missing.
- [x] Called from startup next to `ensureVaultExcludes`, with a log line either way.
- [x] Reported in `GET /api/v1/health` as a boolean (`autoCommitDisabled`), and surfaced on the
      System screen as a red state when false.
- [x] `scripts/setup-all.sh` no longer needs to know about it (the service owns it), but add a
      comment where step 4 clones the vault saying the service asserts it at startup.
- [x] Tests: fresh vault without the flag gets it; existing flag untouched (mtime preserved);
      non-vault directory is a no-op; read-only vault reports `unwritable` instead of throwing
      (same shape as `ensureVaultExcludes`'s EROFS path, which a hosted demo relies on).
- **DoD:** delete the flag from a scratch vault, start the service against it, the flag is back
  and `/health` says `autoCommitDisabled: true`. Make the vault read-only, start again, the
  service starts and `/health` says false. Both as tests, plus one manual run.

**Result.** Both manual runs done against a scratch vault on a spare port (never `~/vault`):

- flag deleted, service started: flag back on disk, `/health` `autoCommitDisabled: true`, and
  the startup log carries `the vault was auto-committing its own writes: ... created, this
  service now owns every commit`.
- `.vault-meta` made read-only before the service ever saw it: the service **starts**,
  `/health` says `autoCommitDisabled: false`, and the log says `may auto-commit: ... is missing
  and cannot be written (expected on a read-only instance)`.

Five unit tests in `server/test/vault-guards.test.ts`, including the one that matters most: an
existing flag is not rewritten, because its mtime is the only record of when this vault stopped
auto-committing. `/health` reads the flag live rather than reporting the startup verdict - a
`git clean` in the vault removes it without restarting us - and the System screen's Service
panel shows `Commits: service only` or a red `vault commits too`.

Worth recording for later: the mechanism is the vault's `hooks/hooks.json` `PostToolUse` hook,
which runs `git add -- wiki/ .raw/ .vault-meta/` plus a commit after every Write and Edit and
exits early only when the flag file exists. That is the file this task asserts.

### 1.2 Deny history-destroying commands in an agent run (N5) - DONE 2026-09-19

- [x] Add one `BASH_DENY` entry covering git subcommands that destroy or rewrite history or
      discard uncommitted work: `reset --hard`, `clean`, `checkout --`/`restore` over a
      pathspec, `filter-branch`, `filter-repo`, `reflog expire`, `gc --prune=now`,
      `update-ref -d`, `branch -D`, `push --force`. Reason string names hard rule 1's
      "versioned and revertable".
- [x] Add a second entry for non-git bulk destruction inside the vault that the current `rm`
      pattern misses because it only guards paths *outside* the vault: `find ... -delete`,
      `find ... -exec rm`, `truncate -s 0` and `shred` against anything under `wiki/`.
- [x] Comment block above the new entries stating explicitly why this is not the whitelist
      hard rule 4 forbids: this is not an attempt to decide what an arbitrary shell string
      writes (still not tractable, still the sandbox's job), it is the one class the sandbox
      cannot contain at all, because `.git` lives inside the write-allowed root.
- [x] Tests in `permissions.test.ts`: the nine commands measured in N5, plus the legitimate git
      the ingest skill actually uses (`git add`, `git commit`, `git status`, `git log`,
      `git ls-files`, `git diff`) which must all stay allowed.
- [x] **Re-run `permprobe`.** Expect `canary outside vault: blocked`.
- **DoD:** the nine destructive shapes refuse with a named reason, the six legitimate ones pass,
  permprobe green, and a scratch agent run that does a normal ingest completes unchanged.

**Result.** Three entries, not two. The nine measured shapes all refuse, plus four more of the
same class found while writing them (`reflog expire`, `update-ref -d`, `branch -D`,
`commit --amend` - the last because an amended commit invalidates a stored `jobs.commit_hash`
exactly as a reset does). Nine legitimate git forms stay allowed, including the
`rm -rf .vault-meta/chunks/` the vault's own retrieval skill documents.

The third entry is the one the task text did not anticipate: `python3 -c "import shutil;
shutil.rmtree('wiki')"` was still allowed after the first two, because the scan stopped at the
`;` INSIDE the quoted script. It now matches named destructive calls in an inline `-c`/`-e`
script and crosses semicolons but not newlines. Deliberately narrow - a script FILE doing the
same passes, which is the sandbox's job, not this list's.

`permprobe` re-run after the change, both halves green: `canary outside vault: blocked`,
`canary in skills/: blocked`, and the expand probe's five cases all ok.

Not done: the scratch agent ingest the DoD's last clause asks for. It belongs with 0.2's
`--ingest` and with 2.4, which changes what that run has to produce; running it three times
costs three runs for one answer. Recorded rather than quietly skipped.

### 1.3 Widen the service's lock window (A2) - DONE 2026-09-19

- [x] `wiki-lock.ts`: pass `--stale-after-sec` on every `acquire`, from a constant with the
      measurement in its comment (median 23 s, p90 59 s, max 108 s). Default 600.
- [x] Configurable through the environment for a vault with different run lengths, not through
      settings (it is a safety margin, not a preference).
- [x] `withWikiLocks`: re-acquire (refresh) held locks when a batch has been running longer
      than half the window, or cap the batch size so it cannot. Whichever is chosen, state it
      in the header comment; the current behaviour lets a 30-page repair outlive its own first
      lock.
- [x] Normalise the path before it reaches the script (POSIX separators, no leading `./`, no
      duplicate slashes), so our side can never open a second lock namespace on one page.
- [x] Tests: the flag reaches the exec stub with the expected value; a normalised path is what
      the stub receives for four spellings of one page; the batch refresh fires on a stubbed
      clock.
- **DoD:** a scratch vault run holding a lock for 90 s is not reaped by a second acquire, and
  is reaped at 610 s. Assert via the real script in a temp vault, not a mock.

**Result.** Both DoD cases assert against the VAULT'S OWN `wiki-lock.sh`, copied into a temp
vault (skipped on a machine with no vault to borrow it from): a lock aged 90 s is refused with
`WikiLockBusy` where the script's own 60 s default would have reaped it, and one aged 610 s is
still reaped, because the window is a bound on how long a crashed holder can wedge a page, not
a promise never to reap. The ages are forged in the lockfile rather than waited for - the
script decides staleness from the epoch it wrote - and a third test asserts that our forged
lockfile really is the file the script reads (same SHA-1 of the same path string).

`WIKI_LOCK_STALE_SEC` defaults to 600, ten times the longest hold ever measured, and is
overridable from the environment rather than from settings.

**One thing the task text did not cover, and it is half the finding.** The threshold is applied
by the ACQUIRER. Passing `--stale-after-sec` on our own acquire only decides what WE reap; an
agent run would still reap a lock this service holds after 60 s, which is the more likely of
the two directions. Closed by exporting `STALE_AFTER_SEC` into the run's environment in
`buildAgentEnv` - the global the script's own header documents, so no vault file is modified
(hard rule 5).

**Batch: refresh, not cap.** A phase 8 repair legitimately touches hundreds of pages, and a cap
would only move the problem into every caller. Every half window the held locks are re-acquired
with a zero threshold, which reaps and re-creates a lock this process already holds and puts
its age back to zero. A refresh that does not come back 0 means the page is somebody else's
now, so it is dropped from the set instead of being released out from under them at the end -
the script's release is an unconditional `rm -f`.

Two test stubs had to learn the flag (`wiki-lock.test.ts`, `pages-write.test.ts`): both read
the page path from `$2`, which is now `--stale-after-sec`. Worth knowing for any future stub.

### 1.4 Concurrency default 1, and the deviation written down (A3) - DONE 2026-09-19

- [x] `queue.ts:347` default becomes 1. The setting stays live-applicable.
- [x] `SPEC.md` §3.1 (the "Ingestion queue" paragraph, line 69 today): correct the wording. Today it says default 2 and claims
      claude-obsidian's per-file locking "additionally protects at vault level in case Claude
      Code is used manually in the vault at the same time". Both halves are wrong as stated:
      the default changes, and the lock's 60 s window is shorter than 9.6 % of real holds, so it
      does not serialise two ingests. Replace with: default 1, the upstream single-writer rule
      quoted, the measurement, and what would have to be true to raise it again.
- [x] `CLAUDE.md`: one sentence under the conventions naming the upstream constraint and the
      fact that the service follows it.
- [x] The settings UI gains a one-line warning next to the concurrency field when it is set
      above 1, naming the skill's rule rather than inventing a policy.
- [x] Tests: default is 1 without an explicit option; an explicit 2 still works; the warning
      renders above 1 and not at 1.
- **DoD:** a fresh service reports `concurrency: 1` in `/health`, SPEC.md and CLAUDE.md agree
  with the code, and `vault-audit` on a later run shows no new overlapping job pairs.

**Result.** `/health` reports `concurrency: 1` (asserted in `api.test.ts`, which had pinned 2
in three places). The default lives in one constant, `DEFAULT_CONCURRENCY`, and the queue's own
fallback now reads it instead of carrying a second 2 of its own - that second copy is why the
setting and the queue could have disagreed.

SPEC.md §3.1 rewritten: it said default 2 AND claimed the per-file lock "additionally protects
at vault level", and both halves were wrong. It now carries the skill's rule verbatim, the two
measurements (13 of 31 jobs overlapped; 9.6 % of holds outlived the lock window), what the lock
DOES protect (a page held right now against a writer asking for it in the same window - the
manual-Obsidian case, not the two-ingests case), and what raising it again would require.
CLAUDE.md gains the one-sentence version under the conventions.

The settings warning is a pure exported function (`concurrencyWarning`) so its wording and its
threshold are testable without rendering the editor. It quotes the vault's rule rather than
inventing one of ours. Its test caught a real bug on the way in: a cleared number field arrives
as `NaN`, and `NaN <= 1` is false, so the warning fired on an empty field.

Still open, by construction: the "no new overlapping job pairs" half of the DoD needs ingests
to have run under the new default. `vault-audit` reports overlapping pairs, so it is measurable
at the next run.

### 1.5 Correct hard rule 1's writer list (A10) - DONE 2026-09-19

- [x] `CLAUDE.md` hard rule 1: the sanctioned writer list gains `notebook.ts`, `recap.ts`,
      `reading-list.ts`, `link-repair.ts` and `routes/domains.ts`, each with what it writes and
      the date it was added. Keep the existing sentence about the lock and the mutex; it already
      covers them correctly, it just did not name them.
- [x] Add the sentence that the list is the thing future changes are checked against, so a new
      writer belongs in it before it ships. (Phase 2 adds the hub writer to the same list.)
- **DoD:** every `withWikiLock` / `withWikiLocks` call site in `server/src` appears in the rule,
  verified by a grep listed in the commit message.

**Result.** `grep -rn "withWikiLock" server/src` (excluding the module itself) names seven
files: `pipeline/reading-list.ts` (6 call sites), `api/routes/pages.ts` (3), `pipeline/recap.ts`
(2), `pipeline/questions.ts` (2), `pipeline/notebook.ts` (2), `pipeline/link-repair.ts` (2),
`api/routes/domains.ts` (2). All seven are in the rule, plus agent runs, as a table with what
each writes and the date it became a writer - the dates taken from `git log --diff-filter=A`
rather than from memory, which moved four of them (the three Fellow writers are 2026-09-06, not
-15; `link-repair.ts` is 2026-09-07; `domains.ts` existed from 2026-07-19 and only became a
LOCKED writer on 2026-09-16, which is the distinction the table now makes).

`pipeline/questions.ts` was already named in the rule's prose but not as a file; it is in the
table now, so the grep and the rule can be compared mechanically.

---

## Phase 2: the service takes the hub layer (D2; A2, A6, B1, N3, and the stale-counter class)

The centre of this work. Do not start it before phase 1 is green.

The set is the one `expand.ts:isExemptPath` already names: `wiki/index.md`, `wiki/log.md`,
`wiki/overview.md`, `*/_index.md`, with `hot.md` deliberately left to the agent (D2).

### 2.1 `server/src/pipeline/hubs.ts`: the generated catalog - DONE 2026-09-19

- [x] `renderIndex(vaultRoot)`: builds `wiki/index.md` **entirely** from page frontmatter.
      Grouped by `domain:` (registry order), then by type; one deterministic line per page
      carrying the wikilink, the type and the address. Header counters computed, never
      maintained. Fixed navigation preamble. A bounded `related:` (the hubs only), not the
      unbounded accumulating list that is there today.
- [x] Idempotent by construction: running it twice without a vault change produces a
      byte-identical file. This is the property that makes an agent write harmless.
- [x] A page whose frontmatter cannot be parsed is listed under an "unfiled" section rather
      than dropped, so the generator can never silently lose a page.
- [x] Sort order is total and stable (domain, type, title, path) so two runs on two machines
      agree.
- [x] Tests: idempotence over a fixture vault; a new page appears in the right group; a page
      with a broken frontmatter lands in "unfiled"; counters match the page count; the output
      contains no dated event section; 1200-page fixture renders in under 2 s.
- **DoD:** rendering against a copy of the live vault produces a file under 200 kB (today
  514 kB) whose link set is a **superset** of the links in the current `index.md` minus the
  dead ones - assert that explicitly, so the change cannot lose reachability. The 51 pages that
  are in no `index.md` entry today are all present afterwards.

**Result, measured against the live vault read-only (nothing written):**

| | before | after |
|---|---|---|
| size | 514,303 B | **92,159 B** (18 %) |
| longest line | 13,345 | 563 |
| `##` sections | 105, of which 94 dated events | 21, of which **0 dated** |
| links | 1176 | 1211 |
| render time | - | 53 ms first, 35 ms second (budget 2 s) |

**Reachability, asserted both ways.** Not one link that resolves today is missing from the new
index (0 of 1176), and all **48** pages that no `index.md` entry reached are now listed. (48,
not the review's 51: the harness follows `related:` frontmatter as well as body links, see 0.1's
method table.)

Two design points worth keeping in view:

- **Links are written from the FILE NAME, with the title as display text** (`[[Foo - Bar|Foo:
  Bar]]`). The largest dead-link class in this vault is a title the file name cannot carry, and
  an index that links by title would regenerate that class on every run. This is also why the
  new link count is higher than the old one rather than merely different.
- **Nothing in the render reads the clock.** `updated:` is the newest date the CONTENT carries
  and `created:` is preserved from the existing file. A timestamp would make every render a
  different file, which is exactly the history churn this replaces.

### 2.2 The log entry, written by the service - DONE 2026-09-19

- [x] `renderLogEntry(...)`: one entry per run, from what the service already knows (date, run
      kind, the job's raw path, pages created and updated with their addresses, duplicate or
      skipped state) plus the run's **final answer** as the narrative paragraph. No new agent
      contract: the final answer already exists on every run.
- [x] Prepended to `wiki/log.md` (the file is newest-first).
- [x] The run-protocol sections B5 counts belong here: the prompt already asks for automated
      decisions "in the log entry", and this is what finally gives that instruction a home the
      run does not own. Phase 4.3 removes them from pages.
- [x] One entry per run, capped in length, with the cap stated in the code.
- [x] Tests: an ingest, a batch, a duplicate, a research run and a Fellow run each render their
      expected shape; prepending keeps the file parseable; two concurrent renders through the
      mutex produce two entries and lose neither.
- **DoD:** a scratch ingest produces exactly one log entry, written by the service, and the
  agent produced none. Entry size is within the cap; the current median entry is 3.0 kB.

**Result (renderer only; the scratch ingest is 2.3's DoD, once the wiring exists).**
`renderLogEntry` is pure - date in, entry out - so the five run kinds are covered as a table
rather than as five integration runs. `prependLogEntry` takes the file's content and returns
the new content; the caller writes it inside the mutex behind the vault's own lock.

The narrative cap is **1200 characters** (`LOG_NARRATIVE_CAP`), against a current median entry
of 3.0 kB. A run's final answer is a report to a human, so it arrives with headings, bullets
and sometimes a code fence; `narrativeOf` flattens those into one paragraph and cuts on a
sentence boundary with a visible `[...]`. A run that writes an essay gets the essay cut, never
the entry dropped.

The `- Source: \`.raw/...\`` line stays deliberately: crash recovery still falls back to
searching this file for it, and 2.4 is where that dependency is removed.

### 2.3 Wiring: when the hubs are written - DONE 2026-09-19

- [x] After a vault-writing run, inside the existing commit path: take the vault lock on each
      hub file (foreign-then-ours, outside the commit mutex), render, write, then commit with
      the run's own commit. One commit per run stays true.
- [x] Covers ingest, batch ingest, research, Fellow research and maintenance runs. A run that
      wrote no page writes no log entry and does not regenerate the index.
- [x] Failure is non-fatal and loud: a hub write that fails logs a warning against the job and
      leaves the run `done`, exactly as the commit failure path does today. The next run
      regenerates the index anyway, which is the safety net a generated file gives us.
- [x] `CLAUDE.md` hard rule 1 gains this writer, with the date and the reasoning (D2).
- [x] `SPEC.md` gains a subsection describing the hub layer as service-owned.
- [x] Tests: run completes, hubs written, one commit; hub write throws, job still `done` and a
      warning is logged; a no-page run leaves the hubs untouched; the lock is taken before the
      mutex in the right order (assert on the call sequence).
- **DoD:** a scratch ingest produces exactly one commit containing the new pages, the
  regenerated index and the new log entry, and `git show --stat` on it shows no other hub
  churn.

**Result.** Asserted in `server/test/hub-wiring.test.ts` against real git and the real queue:
one ingest, one `ingest:` commit, containing the page, `wiki/index.md` and `wiki/log.md` and
nothing else; the working tree clean afterwards. Six cases: the commit's shape, the `.raw`
source line crash recovery keys on, a run that wrote no page leaving both hubs byte-identical,
a hub write that FAILS leaving the job `done` with a named warning and the page still
committed, an unchanged index never reaching a second commit, and the lock order.

The lock-order case is asserted on the real call sequence - the lock script and the commit both
append to one trace file - and it was checked against a deliberately broken build: with the
lock removed, it fails. A test that only passes is not evidence.

**One real finding on the way in, worth reading before phase 8.** The M1 integration test
failed the moment the hubs landed: with the hubs in every commit, every LATER commit touches
them, so `git revert` of a whole older commit conflicts on the hub files rather than on
anything the run wrote. **That is the undo button of SPEC.md §9 breaking for every ingest
except the most recent one**, silently, the first time somebody uses it - and it would have
been just as true of the old agent-written hubs, which is presumably why nobody had reverted an
old ingest.

`revertCommit` now reverts the commit's own paths and leaves `index.md`, `log.md`,
`overview.md`, `hot.md` and the `_index.md` hubs alone. That is also what reverting MEANS here:
the index is derived, so restoring an old copy would list pages that no longer exist, and the
log is an append-only record of something that really did happen. Mechanism: `git revert`
cannot take a pathspec, so it is the commit's reverse diff applied to the commit's own paths -
all-or-nothing, so the "leaves the vault exactly as it found it" guarantee holds without an
abort path to get wrong. A failed apply is checked against its own reverse to tell
`already-reverted` from a genuine `conflict`. Four regression tests in
`revert-ingest.test.ts`.

### 2.4 Move the completion marker off `log.md` (A6 contract 1, prerequisite for 8.8) - DONE 2026-09-19

- [x] The agent's last action becomes touching `.vault-meta/runs/<job-id>.done` (derived,
      self-reaping, excluded from vault git the same way `locks/` is). The prompt asks for it
      as the run's final step, in one sentence.
- [x] `ingestLoggedCompletion` becomes `ingestCompletionMarker`: read one small file instead of
      777 kB. **Keep the `log.md` substring check as a fallback** for jobs that started before
      this change, with a comment saying when it can be deleted (once no `ingesting` job
      predates the deployment).
- [x] The reaper: markers older than a day are removed at startup, next to the excludes.
- [x] `vaultprobe` (0.2) asserts the new marker as contract 1, and keeps the old assertion
      while the fallback exists.
- [x] Tests: marker present means finished; marker absent with the legacy log entry present
      still means finished; neither means not finished; the reaper removes only old markers.
- **DoD:** `grep -n "log.md" server/src/pipeline/queue.ts` shows no remaining read of the file
  for status purposes, the probe passes on both paths, and `reconcile-interrupted.test.ts`
  still passes unchanged in behaviour.

**Result. 8.8 is unblocked.** `.vault-meta/runs/<job-id>.done`, touched by the run as its last
action (`renderCompletionMarker`, one sentence naming an exact path), read by
`ingestCompletionMarker`. Excluded from vault git next to `.vault-meta/locks/`, reaped at
startup at a day old, and the job id is shape-checked before it becomes a path.

**This was more urgent than the task file knew.** 2.3 made the SERVICE write the log entry, so
a crashed run leaves no entry at all - the old check would have classified every interrupted
job as unfinished from that commit onwards. The two tasks had to land together and did.

`grep -n "log.md" server/src/pipeline/queue.ts` leaves exactly one read for status purposes:
line 602, the legacy fallback this task's own bullet asks to keep, with the comment saying when
it goes (once no `ingesting` job predates the deployment). The other hits are comments and the
hub write.

`vaultprobe` contract 1 now asserts both halves: the state directory exists and is writable,
`.vault-meta/runs/` is excluded from vault history, and the legacy log shape still parses. It
reported the exclude MISSING on the live vault until `ensureVaultExcludes` was run against it -
which is what the service does at startup and writes only `.git/info/exclude`, never vault
content. All four contracts green afterwards.

`reconcile-interrupted.test.ts` keeps its five original cases unchanged and gains three: a run
that left a marker and no log entry recovers to `done`; a run with neither fails; and another
job's marker is not taken for this one's.

### 2.5 Tell the agent to leave the hubs alone - DONE 2026-09-19

- [x] `PAGE_HYGIENE_CHECKLIST`: replace "Link every new page from wiki/index.md ... update them
      together with the body" with the new contract - the service writes the index, the log and
      the overview after the run; report the summary as the final answer; keep `hot.md` current.
      This one paragraph is what currently makes every ingest open the 514 kB file.
- [x] `writeGuard` (the existing `upstream-guard.ts` seam) refuses Write/Edit on the
      service-owned hubs for ingest, research and maintenance profiles, with a refusal message
      that says where the work went instead, so the run adapts rather than retries.
- [x] `hot.md` stays writable and the hot-cache rules stay as they are.
- [x] Tests: the guard refuses each hub path and allows `hot.md` and content pages; the refusal
      message names the alternative; `permissions.test.ts` covers the profile matrix.
- [x] **Re-run `permprobe`.**
- **DoD:** a scratch ingest run writes no hub file, takes no lock on one, and its job log shows
  the guard was not hit (the prompt alone was enough). If the guard fires, the prompt wording
  is not clear enough yet - fix the prompt, not the test.

**Result.** The prompt's two hub bullets are replaced: do not edit the three service-owned
hubs, report what you did in the FINAL ANSWER instead (which is what the service renders into
the log entry), and link a new page from its bucket `_index.md`, which is still the agent's.
The same correction in `maintenance.ts` for the research prompt ("Afterwards update
wiki/index.md and wiki/log.md" is gone) and in the lint-fix scope ("stale index entries" now
names the bucket hubs and says the index regenerates itself).

The guard refuses Write/Edit on the three, allows `hot.md`, the `_index.md` hubs and content
pages, and its refusal NAMES the alternative - a run told only "no" retries, a run told where
the work goes adapts. Five cases in `upstream-guard.test.ts`, including the profile matrix.

**`permprobe` re-run after the guard change: `canary outside vault: blocked`, the plugin canary
blocked, and the expand probe's five cases all ok.**

The last DoD clause (a scratch ingest run) needs a live agent run and is recorded with 0.2's
`--ingest` and 2.4's first live run.

### 2.6 Rebuild `overview.md` once, then generate its counters - MECHANISM DONE 2026-09-19 (the rebuild is 8.1)

- [ ] `overview.md` loses the shipped demo text ("This is the claude-obsidian demo vault ...
      Run `/wiki` to scaffold this vault") and the appended "Current Seed Content" list that
      produced the 25 kB line.
- [x] What remains: a short hand-owned purpose section the user writes once, plus a generated
      counters block between markers, refreshed by `renderIndex`'s pass.
- [x] Tests: the counters block is replaced in place and the hand-owned text survives a
      regeneration; a file without the markers gets them added once.
- **DoD:** `overview.md` under 8 kB with no line over 500 chars, the demo sentences gone, and
  `vault-audit` reports zero `stale-counter` findings against it.

**Result (mechanism).** `renderOverviewCounters` + `updateOverview` own one block between
`<!-- vault-service:counters -->` markers; everything else on the page is hand-owned and
survives byte for byte. A page without markers gets them once under their own heading. No
clock, so two renders of an unchanged vault are identical.

**The rebuild itself is phase 8.1**, because removing the demo text and the seed list is a
vault CONTENT change. Dry run against the live vault (read-only): `overview.md` 91.4 kB to
91.8 kB - the counters block added, nothing removed. The 25 kB line and the demo sentences go
in 8.1, which is where the DoD's "under 8 kB" belongs.

### 2.7 The `_index.md` bucket hubs - MECHANISM DONE 2026-09-19 (the insertion is 8.1)

- [x] Same marker approach as 2.6 rather than full generation: these hubs carry genuinely
      curated one-line descriptions per page, which no generator can produce. The service owns
      the **page list** between markers; the agent keeps the section prose outside them.
- [x] Dated event sections ("... (new sub-area, <date>)") are not created by the generated
      region, and the prompt stops asking for them.
- [x] Tests: generation inside the markers leaves outside text byte-identical; a hub without
      markers gets them on first write with its existing content preserved below.
- **DoD:** `concepts/_index.md` and `sources/_index.md` regenerate idempotently, every content
  page of the bucket appears exactly once, and no curated description was lost (diff the
  description text before and after, assert equality).

**Result (mechanism), and one correction to the plan.** The service owns the page list between
`<!-- vault-service:pages -->` markers; the curated one-line descriptions around it are
untouched.

**A hub with no markers is left completely alone.** The dry run against the live vault showed
why: inserting a complete page list into hubs that still carry their dated event sections takes
`concepts/_index.md` from 154 kB to **188 kB** and `sources/_index.md` from 123 kB to 165 kB -
bigger, not smaller, and it would have happened automatically on the next ingest. So the
marker insertion is an explicit act of the phase 8.1 repair (`{ create: true }`), which prunes
and inserts in one reviewed pass; from then on every run keeps the region current. This is
exactly the stated contract - the service owns the region between the markers, and no markers
means no region.

Dry run after the change: all three bucket hubs unchanged, all 187 curated description lines
intact.

---

## Phase 3: show the ingest what the vault already holds (A8, B2, and A5's tiling)

This is the phase that addresses the vault's central defect rather than its symptoms. It only
works after phase 2, because the mechanism it replaces is "read the 514 kB index".

### 3.1 An overlap block for ingest runs - DONE 2026-09-19

- [x] Derive a topic for the incoming document from the preprocessing manifest (title, filename,
      the first N characters of the normalised text, the URL's own title). Put the derivation in
      its own tested function; it is the input quality that decides whether this phase works.
- [x] Feed it to the existing `findRelatedPages` + `renderOverlapBlock`, and to
      `retrieveCandidates` when the index is provisioned, and render both into the ingest
      prompt - the same two mechanisms the chat and the research paths already get.
- [x] The wording is scoped the way `renderOverlapBlock` already learned to be: prefer
      extending existing concept, entity and source pages; the source page for **this** document
      is still this run's deliverable and is required. Getting this wrong once already produced
      a research run that filed nothing (2026-09-04, see `renderSynthesisMandate`).
- [x] Batch runs get one block per member, not one merged block.
- [x] Tests: topic derivation over fixtures for PDF, office, web, image and text sources; the
      block is empty for a genuinely new topic and the prompt is then byte-identical to today's;
      the block lists existing pages for an overlapping topic; the deliverable sentence survives
      the "prefer what exists" sentence (assert the order).
- **DoD:** replay the last 20 real ingests offline (prompt construction only, no agent run) and
  record how many would have been handed a non-empty overlap block. Expected, from B2's
  numbers: a clear majority. Record the figure in this file.

### 3.2 Wire the vault's duplicate detector (A5, `tiling-check.py`) - DONE 2026-09-19

- [x] Run the vault's own `tiling-check.py` as a child process after an ingest, the same way
      the retrieval index scripts are run (deterministic, no LLM, no egress, writes only under
      `.vault-meta/`). It is the only duplicate detector in the system and it has never run.
- [x] Its findings become validation findings of a new rule (`near-duplicate`), surfaced on the
      job and fed into phase 5's standing list.
- [x] The thresholds file the vault already ships (`.vault-meta/tiling-thresholds.json`) is
      read, never written.
- [x] Tests: the runner handles a missing script (older vault) by skipping with a log line, not
      failing; output parses into findings; a crash is logged and ignored.
- **DoD:** one run over the live vault copy produces a finding list, and at least the one pair
  the review found by hand (a co-author pair at Jaccard 0.70) appears in it. If it does not, the
  thresholds need a note in this file rather than a silent pass.

**Result: it ran, for the first time in 764 vault commits.** 1247 pages scanned, 1092 embedded,
155 skipped (116 of them an ollama HTTP 500 on a long page, 3 too large, the rest meta and
folds). It found **3433 pairs**.

**The pair the review found by hand is the top hit.** The highest-scoring pair in the whole
report is two co-author entity pages at **0.9800** - the exact shape the review described. And
the largest class in the error band is `concept + source` at 87 pairs, which is the review's
other sentence: "a concept page that paraphrases its single source page 1:1".

**The thresholds need the note the DoD asked for.** The vault ships them uncalibrated and says
so in the file. Against this vault they split as:

| band | pairs | what it is good for |
|---|---|---|
| error, >= 0.90 | **215** | a per-run finding: 25 co-author entity pairs, 87 concept-paraphrases-its-source, 40 concept pairs |
| review, 0.80 to 0.90 | **3218** | a standing list, never a job finding - it would bury every run |

So the job only ever sees the error band, scoped to the pages that run touched; the review band
is counted in one line and belongs to phase 5's standing list. Calibrating the bands against
this vault (the file asks for 50 to 100 labelled pairs) stays open and is recorded here rather
than done silently.

Three derived files now leave vault git: the embedding cache, the optional report, and the run
markers. The cache is 1092 embeddings and the report was 560 kB - both would have been swept
into the next commit by the bookkeeping pathspec, which stages `.vault-meta` wholesale.

### 3.3 Measure the effect - HARNESS DONE 2026-09-19 (the after-figure needs 50 documents)

- [x] Add to `vault-audit`: sources-per-page and multi-commit rate, sliced by page creation
      date, so the before/after is visible without re-deriving it.
- **DoD:** the baseline slices are recorded here now (concepts: 73 % single-source,
  17 % multi-commit); the next 50 ingested documents after phase 3 are measured against them and
  the result is written into this file, whichever way it comes out.

**Baseline, by page creation month** (`vault-audit` prints it under "THE EFFECT"). This is the
line the next 50 documents get compared against:

| month | content pages | single-source | pages citing 2+ | multi-commit |
|---|---|---|---|---|
| 2026-04 | 25 | 40 % | 0 | 4 % |
| 2026-07 | 405 | 54.3 % | 58 | 21 % |
| 2026-08 | 437 | 54.5 % | 61 | 13 % |
| 2026-09 | 340 | **59.7 %** | 30 | **2.9 %** |

Worth reading before phase 8: the trend is the wrong way. Single-source share rose every month
and the multi-commit rate collapsed from 21 % to 2.9 % as the vault grew - which is exactly
what A8 predicts, since the bigger the index got, the less a run could see of what was already
there.

---

## Phase 4: page form, names and language (B3, B4, B5, B6, B9)

All of this is prompt and validator work. It prevents; phase 8 repairs.

### 4.1 The name rule that covers the colon (B3)

- [ ] Extend the `PAGE_HYGIENE_CHECKLIST` rule that already covers `/` and `\` to cover **`:`**
      and every other character a file name cannot carry portably (`:`, `?`, `*`, `"`, `<`, `>`,
      `|`), in the same concrete voice as the slash rule, which is the one that measurably
      worked. State the mechanism, not just the ban: the link is written from the title, so a
      title the file name cannot carry produces a dead link on every mention.
- [ ] Add the length rule: the vault holds five file names at 213 to 221 characters, which is
      within a few bytes of the 255-byte limit on every common filesystem and already over what
      some sync tools accept. Cap the title at a stated length.
- [ ] The autoresearch title template is the machine that mints the worst of these: the skill's
      `Research: [Topic]` with a whole user question as `[Topic]`. Add a service-side shortener
      that produces a bounded, colon-free synthesis title, and state it in the research prompt
      next to the synthesis mandate.
- [ ] `validator.ts` gains a rule that fires when a page's `title:` cannot be carried by its own
      file name, and when a title exceeds the cap. This is the mechanical half; it catches the
      class at write time rather than at the next lint.
- [ ] Tests: the validator rule over the six characters and over a 240-char title; the shortener
      is deterministic, bounded and collision-free for two lenses on one topic; the existing
      slash tests still pass.
- **DoD:** a scratch research run on a long question produces a title under the cap with no
  colon, and the validator flags a deliberately colon-titled fixture page.

### 4.2 A minimal page schema (B4)

- [ ] Agree the smallest useful required heading set per type and put it in the prompt: it has
      to be small enough that prose quality survives (2243 heading variants exist because runs
      were free, and the free prose is good) and fixed enough that a later run knows where to
      add. Proposal to confirm during implementation: concepts and entities require
      `## Connections`; sources require `## Why This Source Matters` and `## Connections`.
      These are already the best-shared headings (41 %, 41 %, 36 %), so this codifies what runs
      already reach for rather than inventing a template.
- [ ] `validator.ts` gains a `page-schema` rule over the required set, advisory like the rest.
- [ ] The prompt says explicitly that other sections are free, so the rule is a floor and not a
      template.
- [ ] Tests: the rule over pages with, without and with a near-miss spelling of each heading.
- **DoD:** the rule fires on the 59 % of concept pages that lack `## Connections` today, and
  the count is recorded here as phase 8.5's work item.

### 4.3 Run-protocol sections leave the article (B5)

- [ ] The prompt states where each kind of run-protocol content belongs now that the service
      owns the log entry (2.2): automated decisions, editorial notes, relation-to-this-vault,
      vault context, status-of-this-page and entity-notability notes go into the **final
      answer**, which the service renders into the log. They do not go on the page.
- [ ] `## Assessment` and `## Open Questions` stay on the page: assessment is source criticism
      and belongs to the source, and the Fellows consume open questions
      (`docs/agents/SPEC.md` 10.13, `POST /questions/archive`). Say so in the prompt, so the
      rule is not read as "no meta sections at all".
- [ ] `## Provenance` is redundant with the `sources:`/`url:` frontmatter; the prompt says to
      use the frontmatter and drop the section.
- [ ] The prompt also says not to describe the service's own mechanisms on a page: three pages
      currently note that the untrusted-content wrapper "was present as expected".
- [ ] `validator.ts` gains a `run-protocol` rule naming the headings that should not be on a
      content page.
- [ ] Tests: the rule fires on each of the seven relocated headings and stays silent on
      Assessment and Open Questions.
- **DoD:** a scratch ingest produces pages with none of the seven headings and a log entry that
  carries the same content, and the validator rule reports the 352 existing pages as phase 8.5
  work.

### 4.4 Make the type-mirroring ban as concrete as the domain ban (B6)

- [ ] Rewrite the type clause in `TAG_HYGIENE_RULES`. It currently says "no type-mirroring tags
      beyond the structural ones the vault prescribes", and the hedge is doing the damage: type
      mirroring runs at 82 to 96 % while the absolutely-worded domain clause runs at 0 to 2 %.
      The evidence that precise wording is what gets followed is right there in the same rule.
- [ ] New wording, in the domain clause's voice: never tag a page with its own `type:` value or
      a synonym of it. Name the three actual offenders by count (501, 328, 211 pages) as the
      reason, without naming pages.
- [ ] Add the reuse-before-coining measurement to the rule: 50 % of tags are used exactly once.
- [ ] `validator.ts` gains a `tag-mirroring` rule (type and domain) and a `tag-singleton` hint.
- [ ] Tests: both rules over fixtures; the `meta` exception still holds.
- **DoD:** the rules fire on the measured population, and a scratch ingest produces a page with
  no type-mirroring tag.

### 4.5 The em-dash ban reaches the prompts (B9, and the house style)

- [ ] The vault carries 10,257 em-dashes across 819 pages against a house style that bans them
      everywhere, and **no prompt has ever said so**. Add the rule to
      `PAGE_HYGIENE_CHECKLIST`: no em-dashes and no en-dashes in any page the run writes; use a
      hyphen, restructure, or use a comma, colon or parentheses.
- [ ] Clean the prompts themselves. Ten em-dashes sit inside the template literals the agent
      reads in `system-prompt.ts`, and `maintenance.ts` carries 51 across its prompt strings and
      comments. A rule the prompt breaks in its own text is not a rule.
- [ ] A lint rule or a test that fails on an em-dash inside an agent-facing template literal, so
      it cannot come back.
- [ ] `validator.ts` gains an `em-dash` rule over pages the run touched.
- [ ] Tests: the guard test catches an em-dash added to a prompt literal; the validator rule
      counts correctly.
- **DoD:** zero em-dashes in every agent-facing string in `server/src`, the guard test proves it,
  and a scratch ingest produces pages with none.

---

## Phase 5: make the validator act (A9, N1)

### 5.1 Persist findings as structured data

- [ ] `jobs.validation` currently holds only the quote summary and is NULL on all 37 rows.
      Persist the full finding list (rule, path, message, first-seen) there, and add a
      `validation_findings` table keyed by a stable finding identity (rule plus path plus a
      normalised message) so the same finding across runs is one row with a count and a
      last-seen, not 109 log lines.
- [ ] Migration with the usual shape; the existing NULL rows stay NULL.
- [ ] Tests: identity is stable across runs for the same finding and differs for a different
      one; counts increment; the migration is idempotent.
- **DoD:** the measured population (406 warn rows) collapses to its distinct classes, and the
  number of distinct standing defects is recorded here.

### 5.2 Report once, not every time

- [ ] The job log gets one line per **new** finding and a count of repeats, instead of one line
      per occurrence.
- [ ] A standing-defect list surfaces on the System screen, sorted by count, with the age of the
      oldest occurrence. This is where the 109-times dead link belongs.
- [ ] `AGENTS_ENABLED` off must not change any of this: the validator is base product. Check the
      new query has no Fellow-only dependency (hard rule 8) and extend
      `agents-flag-off.test.ts` if a route is added.
- [ ] Tests: a repeated finding logs once and counts; a new finding logs; the list endpoint
      orders and pages correctly.
- **DoD:** replaying the historical warn population produces a list of distinct defects whose
  total occurrence count equals 406.

### 5.3 Route the mechanical classes into lint-fix

- [ ] The classes that are mechanically fixable (dead links from a known title-to-filename
      drift, stale counters once phase 2 owns them, address-map divergence, wrapped links) are
      fed into the existing lint-fix maintenance run automatically rather than reported forever.
- [ ] The classes that need judgement (near-duplicate, single-source-entity, contradiction,
      stale claim) stay advisory and stay on the standing list.
- [ ] The existing lint-fix scope guard stays exactly as strict as it is today: no delete, no
      rename, no merge, no prose rewrite.
- [ ] Tests: each class routes to the expected side; the scope guard still refuses a delete.
- **DoD:** one lint-fix run over a copy of the live vault clears the mechanical classes and
  leaves the judgement classes untouched, with the before/after counts recorded here.

### 5.4 Close the manifest's blind sides (N1)

- [ ] `validator.ts` gains the missing direction: every page carrying an `address:` must have an
      `address_map` entry. 274 of 1174 do not, and nothing has ever looked.
- [ ] A second rule for the `sources` half: a `.raw/<job-id>/` directory that produced pages but
      appears nowhere in `sources` (20 of 226 today), and a `pages_created` entry pointing at a
      page that no longer exists (7 today).
- [ ] The prompt's existing manifest sentence stays; the point is that it is now checked.
- [ ] Tests: all three rules over a fixture manifest with each defect planted.
- **DoD:** running the validator over the live vault copy reports exactly 274, 20 and 7, matching
  section 0's measurement. Any other number means the rule is wrong, not the vault.

---

## Phase 6: repo and manifest hygiene (N2, D4)

### 6.1 Derived payloads leave vault git

- [ ] `vault-excludes.ts`: a new `DERIVED_RAW_ENTRIES` group covering `ocr.pdf` and any other
      derived artifact preprocessing writes into the job directory. The header comment already
      carries the reasoning for exactly this category; extend it with the measurement (627 MB in
      16 blobs, 37 % of the whole history).
- [ ] Check every preprocessing plugin for other derived files landing in the tracked job
      directory, and cover them.
- [ ] Tests: the entries are appended idempotently; a user's own additions to the exclude file
      survive; a vault without git is a no-op.
- **DoD:** a scratch OCR ingest leaves `ocr.pdf` on disk and out of `git status`, the pages
  still commit normally, and the run's provenance link still resolves.

### 6.2 The size cap for originals

- [ ] A configured cap (default 25 MB, settable) above which an original payload stays on disk
      and is excluded from the commit, with the job manifest recording that the payload is
      local-only and where it is.
- [ ] The dashboard's source view says "payload not versioned" for such a job instead of
      offering a broken link.
- [ ] The revert path is unaffected for everything under the cap; state in the code comment what
      reverting an over-cap ingest does and does not restore.
- [ ] Tests: under and over the cap; the manifest note; the UI state; revert behaviour.
- **DoD:** dropping a file over the cap produces a normal ingest whose commit contains the pages
  and the manifest note but not the payload, and `/health` or the job row says so plainly.

### 6.3 Untrack the committed agent scratch

- [ ] `.vault-meta/lint_scan.py`, `lint_scan_out.json` and `tag_repair_report.json` are tracked,
      so the excludes never bound them. `git rm --cached` them in one vault commit (content
      stays on disk), and add the missing exclude entry for the report file.
- [ ] This is a vault content change and therefore a phase 8 style operation: it goes through
      the commit mutex, it is one commit, and it is listed here rather than in phase 8 only
      because it belongs to the same mechanism.
- [ ] Add a note to `vault-excludes.ts`'s header that the exclude cannot retroactively bind an
      already-tracked file, with this as the worked example.
- **DoD:** the three files are untracked, present on disk, and `git status` in the vault is
  clean.

---

## Phase 7: operational signals (N4, A7, B7)

### 7.1 Refresh the retrieval index for every writer (N4)

- [ ] The scheduler stops keying on `kind: 'job'` alone. Introduce an explicit
      "the vault changed" signal that every writer emits: ingest, research, Fellow runs,
      maintenance, `PUT`/`DELETE /pages`, `POST /questions/archive`, recap, notebook and
      reading-list writes.
- [ ] Add a maximum wait to the debounce so a continuous stream of finishing jobs cannot
      postpone the rebuild forever: rebuild at the latest N minutes after the first unserved
      signal, whatever arrives in between.
- [ ] Tests: each writer's signal resets the timer; the maximum wait fires under a stubbed clock
      during a continuous stream; an unprovisioned index stays inert; the demo mode path stays
      inert.
- **DoD:** a scratch night-shift run that writes pages triggers a rebuild without any ingest,
  and a 30-minute synthetic stream of job completions still rebuilds once at the cap.

### 7.2 Operational numbers leave the versioned page (A7)

- [ ] The recap keeps its narrative and loses the numeric ledger: USD spend, plan-window
      percentages, proposal queues with command syntax. Those go to the dashboard's recap view,
      which is where a number that changes hourly belongs. The page keeps a link to it.
- [ ] Fix the float artifact at its source, not at the render: `usage-monitor.ts:288` rounds only
      the `u <= 1` branch and stores the raw SDK float above it, which is why the DB holds
      `7.000000000000001` and a committed page printed `57.99999999999999%`. Round on store and
      format on render; both, because the DB already holds bad values.
- [ ] A migration or a one-off pass normalising the stored samples, or an explicit decision
      recorded here not to.
- [ ] The Fellow notebooks stay in the vault: the spec wants a page the user can edit
      (`docs/agents/SPEC.md`). Only the ledger moves.
- [ ] Tests: the rounding over the `<= 1` and `> 1` branches and over the stored artifact values;
      the recap renders no percentage with more than one decimal; the ledger fields are absent
      from the page and present in the API response.
- **DoD:** a scratch recap page contains no USD figure and no raw float, the dashboard shows
  both, and `grep -rn "\.9999\|00000000" wiki/meta/recaps/` on the live vault returns nothing
  after phase 8.

### 7.3 Separate `updated:` from a mechanical touch (B7) - prerequisite for phase 8

- [ ] `updated:` has been destroyed as a signal: 99 % of pages claim an update within 30 days
      because the mass maintenance passes bumped it on nearly everything. Phase 8 is another
      such pass and would finish the job.
- [ ] Introduce `content_updated:` (the field that means a human or a run changed what the page
      says) and leave `updated:` as the mechanical mtime-like field the vault's own skills
      expect. Do not repurpose `updated:`: the vault's skills read it.
- [ ] Every service writer sets `content_updated:` only when the body changed; the prompt says
      the same for agent runs.
- [ ] The dashboard, the graph and any freshness sort read `content_updated:` with a fallback to
      `created:` for pages that predate the field.
- [ ] `status:` gains a closed vocabulary check: 786 developing, 244 seed, 150 mature, plus nine
      further values in ones and twos. Advisory rule, not an enforcement.
- [ ] Tests: a frontmatter-only edit bumps `updated:` and not `content_updated:`; a body edit
      bumps both; the fallback for pages without the field; the vocabulary rule.
- **DoD:** the field exists, the writers respect it, and phase 8's repair passes are proven (in
  a dry run over a vault copy) to leave `content_updated:` untouched.

---

## Phase 8: the one-off repair of the existing content (D1)

**Do not start before 7.3 is deployed.** Every task here is a mass pass over the live vault and
would otherwise re-destroy the field it just fixed.

Rules for every task in this phase, without exception:

- fresh backup first (0.3) and a **dry run over a copy** with a diff summary before the live run;
- one vault commit per task with a mechanism-only message (hard rule 7);
- the commit mutex and the per-file lock, the same as any other writer;
- `vault-audit` before and after, with both numbers recorded in this file;
- no task deletes a page. Merges and deletions are the user's call, not a repair run's.

### 8.1 Rebuild the hubs

- [ ] `index.md` regenerated by 2.1. 514 kB to an expected sub-200 kB catalog. The 94 dated
      event sections stop being a second changelog beside `log.md`.
- [ ] `overview.md` per 2.6.
- [ ] `_index.md` hubs per 2.7, with the curated descriptions preserved.
- **DoD:** link set is a superset of today's minus the dead ones; the 51 pages absent from
  `index.md` are present; no curated description lost.

### 8.2 Repair the dead links (B3)

- [ ] 231 occurrences over 96 targets. Fix the three mechanical classes: the colon-in-title
      mismatch (56, of which 43 come from two pages), the slash class (65), the trailing
      backslash from a line-wrap escape (13). Repair **both** ends: the link and the page's own
      `title:`, so the class does not regenerate from the title on the next mention.
- [ ] The two pages behind 43 occurrences are also two of the four pages in no hub at all;
      fixing the title fixes reachability at the same time. Assert both afterwards.
- [ ] Leave the "missing by design" references in lint reports and `log.md` alone.
- **DoD:** `vault-audit` reports zero occurrences in the three mechanical classes, the four
  hub-orphans drop to at most one (the fold page, which is legitimately unlinked), and no link
  that resolved before stops resolving.

### 8.3 Backfill the address map (N1)

- [ ] 274 missing `address_map` entries added from the pages' own frontmatter. 20 unnamed
      `.raw` job directories reconciled against their own `manifest.json` where one exists, and
      listed here where it does not. 7 stale `pages_created` entries removed.
- **DoD:** the phase 5.4 rules report zero, and `buildSourceIndex` resolves a source for every
  page that has one.

### 8.4 Normalise the tags (B6)

- [ ] Remove type-mirroring tags (the three account for 1040 assignments). Merge the obvious
      singleton variants (spelling, plural, hyphenation) where the merge is mechanical; leave
      genuine one-off topical tags alone.
- [ ] Do not invent a taxonomy in this pass. The goal is removing the mirrors and the variants,
      not curating.
- **DoD:** type mirroring at or near 0 %, single-use share materially below 50 %, both recorded.

### 8.5 Move the run-protocol sections (B5)

- [ ] 352 pages, 302 kB. The seven relocated headings are removed from pages; the content is not
      thrown away where it carries a real judgement - it goes into the page's own Assessment
      where it belongs there, and is dropped where it is pure bookkeeping
      ("Status of This Page", "Relation to this vault's existing coverage", "Vault context",
      "Automated Decisions", "Entity Notability Note").
- [ ] The three pages describing the untrusted-content fence lose that passage.
- [ ] `## Connections` added where phase 4.2's floor is missing, as part of the same pass.
- **DoD:** the 4.3 validator rule reports zero, the 4.2 rule reports zero, and a random sample of
  20 pages is read by hand to confirm nothing substantive was cut.

### 8.6 Remove the em-dashes (B9)

- [ ] 10,257 occurrences across 819 pages. Mechanical replacement is not safe in every context
      (an em-dash between numbers is a range, inside a code fence it is content), so the pass
      needs a classifier and a dry-run diff that is actually read before it is applied.
- [ ] Code fences, inline code, frontmatter values and URLs are left alone.
- **DoD:** `vault-audit` reports zero outside the excluded contexts, and the dry-run diff was
  reviewed.

### 8.7 Separate the demo seed content (B8)

- [ ] 47 pages created 2026-04 to 2026-06, 17 carrying the upstream community footer. They are
      the plugin author's release and demo material sitting in the same graph, the same BM25
      index and the same page counts as real knowledge.
- [ ] Do **not** delete them. Mark them (`origin: upstream-demo` in frontmatter, or a dedicated
      domain), exclude them from the generated hubs, from the page counters and from the
      retrieval index, and leave them readable.
- [ ] The decision on eventual deletion stays with the user and is recorded here either way.
- **DoD:** page counters drop by the marked count, the graph and the catalog no longer mix them
  in, and every marked page is still readable in Obsidian.

### 8.8 Shrink `log.md` (B1, C-1) - last, and only after 2.4

- [ ] 777 kB, 258 entries, one third of the wiki's entire git history. `wiki-fold` does not
      shrink it (C-1), so this is a deliberate archival: fold the older entries with the vault's
      own skill for the summary page, then move the folded range out of `log.md` into
      `.vault-meta/hot-archive/` or a dated archive page under `wiki/folds/`, and leave the
      recent window in place.
- [ ] Decide and record the retention window (proposal: the current quarter plus the fold pages
      for everything older).
- [ ] **Verify 2.4 first.** If any code path still decides job status from `log.md` content,
      this task breaks crash recovery silently. Grep for it and run
      `reconcile-interrupted.test.ts` before and after.
- **DoD:** `log.md` under 100 kB, every removed entry reachable through a fold or archive page,
  `vaultprobe` green, and a deliberately interrupted scratch ingest still recovers correctly.

---

## Phase 9: the unused vault mechanisms, and closing out (A5)

Each of these is a decision, not automatically a task. Wire it or record why not, in this file.

- [ ] **`wiki-fold`** - used in 8.8 for the summary pages. Decide whether it also runs on a
      schedule afterwards, given it does not shrink anything on its own.
- [ ] **`tiling-check.py`** - wired in 3.2.
- [ ] **`agents/verifier.md`** - the pre-commit review upstream added after its own audit, never
      dispatched by us. Decide: dispatch it on runs above a size threshold, or record that our
      own post-run validation plus the quote check covers the same ground and this stays unused.
- [ ] **`wiki-mode.py route`** - every service-written path is hardcoded (`wiki/meta/...`).
      Correct in Generic mode, wrong the moment a vault uses PARA, LYT or Zettelkasten, and
      multi-vault is a planned extension (SPEC.md §12.1). Decide: route through it now, or
      record the constraint in SPEC.md §12.1 so the multi-vault work inherits it.
- [ ] **`save` skill** - chat knowledge stays in SQLite and never becomes vault content. Decide
      whether a chat answer worth keeping can be filed, and how the user triggers it.
- [ ] **`detect-transport.sh`** - the mtime bump is a workaround for a GUI hang, not a
      detection. The pin is correct today (C-2). Decide: a real detection that cannot hang (run
      the script with the GUI probe disabled, or detect `obsidian-cli` ourselves), or record the
      bump as the permanent answer with its limitation stated in `transport.ts`.

### Closing out

- [ ] `vault-audit` full run, every number in section 0 re-measured and the after-column filled
      in here.
- [ ] `permprobe`, `preprocprobe`, `vaultprobe` all green, recorded with their output lines.
- [ ] `npm test`, `npm run typecheck`, `npm run lint` all exit 0 in both workspaces.
- [ ] `server/test/agents-flag-off.test.ts` green, and the flag-off path checked by hand for any
      new dashboard query added in phases 5 and 7 (hard rule 8).
- [ ] SPEC.md, CLAUDE.md and `docs/agents/SPEC.md` reflect what was built: the hub writer, the
      concurrency default, the writer list, the `content_updated:` field, the `.raw` policy.
- [ ] `scripts/vault-name-scan.mjs --diff main` over everything added, and `--file` over the PR
      body.
- [ ] The two open measurements recorded: phase 3.1's overlap-block coverage over the last 20
      ingests, and phase 3.3's before/after on the next 50 documents.

---

## Appendix: order dependencies, in one place

```
0.3 backup ─────────────────────────────────────────────► every phase that touches the vault
0.1 audit ──────────────────────────────────────────────► every DoD that states a number
0.2 vaultprobe ─────────────────────────────────────────► 2.4, 8.8

phase 1 (independent, ship first)
   1.4 concurrency 1 ───────────────────────────────────► reduces the risk of everything after

phase 2 (the hub layer)
   2.1 renderIndex ─► 2.3 wiring ─► 2.5 prompt+guard
   2.2 log entry ───► 2.3
   2.4 completion marker off log.md ────────────────────► 8.8  (HARD dependency, see C-1)
   2.6 overview, 2.7 _index hubs ──────────────────────► 8.1

phase 3 needs phase 2 (it replaces "read the 514 kB index")
phase 4 prevents what phase 8 repairs; 4.2 and 4.3 define 8.5's work
phase 5.4 defines 8.3's work and verifies it
phase 7.3 content_updated ──────────────────────────────► phase 8  (HARD dependency, see D1)
phase 8 last, task 8.8 last within it
```
