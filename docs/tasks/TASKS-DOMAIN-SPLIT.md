# Tasks: splitting an oversized domain (implementation plan, 2026-09-23)

The domain registry (SPEC.md §12.4, stages 1 to 3) can grow a domain out of the unassigned pool,
and knows nothing about a domain that has outgrown being a shelf. On the live vault one domain
holds 537 of 1322 knowledge pages (41 %). This file builds the other direction: a deterministic
proposal of the shelves such a domain falls into, a read-only view of them, and a user-approved
write that turns chosen shelves into registry domains and re-files their pages in ONE commit
that one revert undoes.

The measurements and the reasoning behind every decision below are in
`docs/tasks/DOMAIN-SPLIT-ANALYSIS.md` (the analysis of 2026-09-22 and its review of 2026-09-23).
This file does not repeat the argument. It states the decisions, the phases, what each phase
has to prove, and the final end-to-end test.

**Two milestones, one merge** (changed 2026-09-23, after milestone A was built). Milestone A
(phases 1 to 3) is the proposal as a view and writes nothing; milestone B (phases 4 to 6) adds
the write. Both live on one branch, `feat/domain-split`, and it merges ONCE, after phase 8, like
the phases of `TASKS-DEFECT-PATHS.md`. Gate A stays as the checkpoint at which milestone A was
measured on its own. The first version of this plan merged A alone and then asked for a week of
use before B; the user dropped both on 2026-09-23, for two reasons. The safety that week was to
buy already lives in B: a preview before any write, one commit, one revert, and phase 7 on a
throwaway copy. And A alone on `main` would have shown a status item recommending a split that
nobody could perform. The questions the week was to answer are asked at the first real split
instead (see the usage gate below). Phase 7 is the final end-to-end test against a throwaway
copy of the vault; phase 8 is acceptance.

**Decision R2: (a), flat, with the registry convention amended** (the user, 2026-09-23, with
the go-ahead for milestone B). The analysis left one decision open: split into peers (a), or
introduce a second level of domains (b). Milestone B builds (a).

**Read first:** SPEC.md §12.4 (all three stages), §12.7 (the guided maintenance run), §12.12 (the
hubs are service-owned), §12.13 (`updated:` and `content_updated:`); CLAUDE.md hard rules 1, 4,
5, 7 and 8; `docs/tasks/DOMAIN-SPLIT-ANALYSIS.md`. Where this file and SPEC.md disagree, the spec
wins; say so and ask before deviating.

**Public repo (hard rule 7).** Mechanism, never subject. Test fixtures are synthetic (generated
graphs, titles like `Page A07`). Results recorded in this file are counts, hashes and PASS or
FAIL, never a page title, a tag of the vault or a line of its text. Screenshots of the E2E
instance show real vault names and never enter the repo. Run `scripts/vault-name-scan.mjs
--diff <base>` over the added lines and `--file` over every PR body before posting.

**The live system is off limits to this work.** `~/vault` is never written: no apply, no run, no
commit. Read-only probes against it are allowed. The live instance (`curious.service`, port
8421) is neither rebuilt nor restarted, and `web/dist` in the main working tree is never built
while it runs, because a build there breaks its UI until a restart. `vault-service.service`
(port 8420, another checkout, same vault) is never started. Everything that runs new code runs in
the E2E environment of phase 7.

---

## 0. The decisions this plan implements

| # | Decision | From |
|---|---|---|
| D1 | Flat. A split turns shelves into peer domains; the old key survives as a narrowed peer holding what the shelves did not take | R2 (a) |
| D2 | The engine is a CONSENSUS of seeded Louvain runs, not one run: one run moves a median 4.8 % of pages (worst 24 %) on node order alone, the consensus 0.2 % | R3 |
| D3 | Its input is fixed by the proposal: the domain's knowledge pages and the links among them, never the node set the Graph happens to show | R4 |
| D4 | A domain under 50 knowledge pages is not offered a split. A domain whose largest reliable group holds 90 % or more of it "holds together" and gets no shelves | analysis, open question 2 |
| D5 | Shelves are ranked by separability, `precision × (1 − conductance)`; size breaks ties only | R10 |
| D6 | "Coarser" means MERGING two proposed shelves; there is no resolution stepper, because the resolution ladder is not nested (14 to 27 pages move sideways per step) | R11 |
| D7 | A key is coined, never copied from a tag: naming each shelf after its top tag would book 311 `tag-mirroring` findings. The collision cost of every key is shown; entity-shaped tags never appear in proposed tags | finding 3, R12 |
| D8 | The parent's registry section is narrowed IN THE SAME WRITE, and the new sections are inserted directly after it: the parent's current entry claims what five of the eight shelves are about | R1 |
| D9 | One split, one commit: the registry, the re-filed pages and `wiki/index.md` together, because the index groups by domain | R5, R6 |
| D10 | The approval is the explicit page list, by `address:`. The apply re-clusters nothing; per page it checks only that `domain:` still equals the parent key | R7 |
| D11 | The apply refuses while any agent run writes the vault, refuses when the service's git auto-commit is off, registers itself with `RunRegistry` while it writes, and reads back what it wrote | R8 |
| D12 | Pages that did not move, or were moved back later, are a visible REMAINDER with its own re-file | R9 |
| D13 | A re-file stamps `updated:` and never `content_updated:` | SPEC §12.13 |
| D14 | The naming pass is optional and read-only BY CONSTRUCTION: the `query` profile through the read-only run path, not a prompt asking the agent to behave | review of `domain-review`, which runs write-capable |
| D15 | A "leave" or "defer" is remembered per shelf fingerprint: its top three landmark addresses plus its size band | analysis |
| D16 | Base product, not behind `AGENTS_ENABLED`. Fellow impact is shown only when `health.fellows` is true, through the existing Fellow route | hard rule 8 |
| D17 | A revert reverts the split's own commits newest first, and refuses while any page outside them carries one of its keys | new, see below |
| D18 | Out of scope: merging, renaming and retiring domains; moving single pages between shelves inside the proposal (the page editor does that afterwards) | analysis |

**D17 is new.** The analysis never asked what a revert does to a page an ingest filed into a
child domain after the split. Reverting the registry section would leave that page carrying a
key the registry no longer lists, which is the orphaning R5 argues against. So the revert
refuses and names the pages; the user re-files or reverts them first.

## 1. Constants

One module owns them (`server/src/pipeline/domain-split.ts`); the web mirrors only what it
displays. Every value was measured on the live vault on 2026-09-23, vault HEAD `dd0fe9a2`.

| Constant | Value | Why this value |
|---|---|---|
| `SHELF_MIN_PAGES` | 25 | The same number as `LANDMARK_MIN_PAGES` (`web/src/lib/landmarks.ts`): below it a group is read whole. One number, one meaning |
| `SPLIT_MIN_PAGES` | 50 | Two shelves' worth. A smaller domain is closer to a tag, by the registry's own conventions |
| `HOLDS_TOGETHER_SHARE` | 0.9 | A "shelf" of 90 % of the domain is a rename, not a split |
| `CONSENSUS_RUNS` | 40 | 96 ms for all 40 runs over 537 pages and 3473 links |
| `CONSENSUS_GAMMA` | 0.4 | The resolution at which the domain-local partition equals the whole-vault partition exactly, and at which eight groups of 25 or more exist |
| `CONSENSUS_AGREE` | 0.9 | A link is stable when its two ends share a cluster in 90 % of the runs or more |
| `CONSENSUS_SEED` | fixed | Reproducibility only: another seed moves 0.2 % of pages |
| `OVERSIZE_SHARE` | 0.25 | The status item appears when one department domain holds a quarter of the knowledge pages |
| `SHELF_LANDMARKS`, `FINGERPRINT_LANDMARKS` | 5, 3 | Five to show, three to recognise a shelf by |
| `SHELF_TAGS` | 4 | Proposed tag hints per shelf |
| `MISFILE_PRECISION` | 0.6 | Under it a shelf carries a misfiling warning. Measured without the rest as a class: one of eight shelves (0.43); phase 1 re-measures with it |

**The consensus is computed over LINKS, not over all page pairs.** A link is stable when its two
ends agree in `CONSENSUS_AGREE` of the runs; the shelves are the connected components of the
stable links. Measured: the same shelves as the all-pairs version (0 of 143 916 page pairs
disagree), in 2 ms instead of 29. **And the pages are sorted by path before the first
permutation**, so the order in which the graph builder happens to list them never matters.

---

# Milestone A: the proposal, as a view

## Phase 1: the engine

Pure functions. No route, no UI, no disk access except in the probe.

- [x] **1.1 `server/src/pipeline/communities.ts`**: a port of `louvainCommunities` from
      `web/src/lib/communities.ts`, with one addition, an optional resolution `gamma` (default 1,
      which is the web's behaviour). The web copy is not changed. Both are pinned by the parity
      test below, and both file headers say so: the same trade-off `web/src/api/types.ts` states
      for the hand-mirrored API types.
      **Done.** The parity fixture is `planted([12, 10, 8, 6], 0.5, 0.04, seed 7)`, 85 links;
      its labels are deliberately not the blocks (four communities, two pages placed across),
      which makes the array sensitive to a change in either copy.
- [x] **1.2 `consensusShelves(pages, links, opts)`** in `server/src/pipeline/domain-split.ts`:
      sort by path, `CONSENSUS_RUNS` seeded permutations, one Louvain run each at
      `CONSENSUS_GAMMA`, stable links, union-find, components of `SHELF_MIN_PAGES` or more are the
      shelves, everything else stays with the parent. Self-links are ignored. A component of
      `HOLDS_TOGETHER_SHARE` or more of the domain yields no shelves and the reason.
      **Done.** Louvain is fed the DIRECTED links, as the graph builder records them and the web's
      hull lens feeds them (a reciprocal pair weighs two); agreement is measured on the distinct
      undirected pairs. A domain with no stable group of 25 that does not hold together either
      answers "no stable group" as its reason.
- [x] **1.3 The evidence per shelf**, all deterministic:
  - `size`, `types` (pages per top-level bucket), `entities`;
  - `conductance`: the share of the shelf's link ends inside the domain that leave the shelf;
  - `stability`: the mean agreement over the shelf's internal links;
  - `landmarks`: the `SHELF_LANDMARKS` pages with most backlinks from inside the shelf, ties by
    backlinks inside the domain, then over the vault, then path (the tie rule of `landmarks.ts`);
  - `tags`: the `SHELF_TAGS` most distinctive tags by `topDistinct`'s score, with
    `STRUCTURAL_TAGS` excluded. Export that set from `domain-candidates.ts`; do not copy it;
  - `precision` and `recall` from tags alone, leave-one-out, with the pages that stay with the
    parent as a class of their own (a residue page predicted into a shelf counts against it).
    The score of a page for a class: the sum over its non-structural tags of (the tag's count in
    the class minus the page itself) divided by (the class size minus the page itself), times
    `ln(N / df)`. A page without a usable tag is counted as such, not guessed;
  - `confusedWith`: the shelves (and the rest) that receive 10 % or more of this shelf's pages
    from tags alone, or give it 10 % or more of theirs;
  - `outsideNeighbours`: knowledge pages of OTHER domains with three or more links into the
    shelf. It replaces the analysis's "members of the same community elsewhere", which needed a
    whole-vault run with its own order sensitivity;
  - `rank` by D5; `misfile` when `precision < MISFILE_PRECISION`;
  - `fingerprint`: the first `FINGERPRINT_LANDMARKS` landmark addresses, sorted, plus
    `floor(log2(size))`.
- [x] **1.4 The totals:** pages in shelves, pages left with the parent, the link matrix between
      the shelves and the rest (from which the client computes the cross-domain cost of any
      selection or merge), and the largest department domain's share now and after promoting
      every shelf.
      **Done, and one reading fixed here.** "The knowledge pages" is the denominator of the
      share: every knowledge page of the vault (`kind: knowledge`, not `upstream-demo`), not
      only those of department domains. The matrix is DIRECTED (rows from, columns to); the
      client sums both directions for a cost.
- [x] **1.5 `keyCollision(graph, shelfPaths, key)`**: the pages inside the shelf and the pages
      elsewhere in the vault that carry `key` as a tag. Used by the proposal for each shelf's
      top tag and by phase 6 for a key being typed.
      **Done.** Case-insensitive, over every page of the vault (any kind), because
      `tag-mirroring` reads every page that carries a `domain:`.
- [x] **1.6 `proposeSplit(graph, domain, addresses)`** composes the above into `SplitProposal`.
      Addresses come in from the caller (`readAddresses` in `hubs.ts`); the engine never reads a
      file.
      **Done.** Two notes on the plan's wording. `topDistinct` is a closure inside the web's
      `detectClusters` and has no server counterpart: `domain-split.ts` carries the same score
      (`c / size - (df - c) / (N - size)`, floor 0.05, fallback to raw order), computed with the
      DOMAIN as the population. And `isDepartmentDomain` lives in `pipeline/library.ts`, not in
      `domains.ts`; it is imported from there, as `questions.ts` already does (a pure function,
      so the import constructs nothing of the Fellow subsystem, hard rule 8).
- [x] **1.7 `server/src/cli/splitprobe.ts`**, `npm run splitprobe -- <domain> [--stability]`,
      read-only like `vaultprobe`: prints the proposal for a domain of the vault at `VAULT_ROOT`.
      `--stability` adds five other seeds and "the vault N days ago" for N = 3, 14 and 30 (pages
      whose freshness date is newer are left out) and prints, per case, the share of the common
      pages that land on another shelf. It replaces the analysis's throwaway scripts and is safe
      against the live vault: it reads files and writes nothing. Wired like `vaultprobe`:
      `tsx src/cli/splitprobe.ts` in `server/package.json`, a forwarding script in the root one.
      **Done.** Its default output is counts, shares and fingerprint hashes only, so it can be
      quoted here; `--names` adds landmark titles and tags for the terminal. `--vault <path>`
      points it at another vault than `VAULT_ROOT`.

**Tests** (`server/test/communities.test.ts`, `server/test/domain-split-engine.test.ts`,
`web/test/communities-parity.test.ts`), all on graphs from one seeded planted-partition generator
(blocks of given sizes, one link probability inside a block, one between blocks):

- parity: the generator and its seed are duplicated in the server test and the web test, and
  both assert the SAME hard-coded label array at γ = 1, so either copy drifting fails its own
  suite;
- `gamma`: 1 reproduces the web function; a lower γ never yields more clusters on the fixture;
- recovery: four blocks of 40 and one of 12 give four shelves equal to the blocks, and the 12
  stay with the parent;
- canonical order: the same pages and links in shuffled input order give a deep-equal proposal;
- stability: 5 % of the pages removed at random leave at least 98 % of the rest on their shelf;
- boundaries: one dense block of 60 holds together (no shelves, reason given); 49 pages are not
  eligible, 50 are;
- evidence: conductance on a hand-built two-block graph equals its hand count; landmarks and
  their tie rule; no structural tag in `tags`; a shelf whose tags are a subset of another's gets
  the lower precision and a `confusedWith` entry; the link matrix sums to the domain's internal
  links; the fingerprint is stable under a page added to a shelf's periphery;
- determinism: two calls on one graph object return deep-equal results.

**DoD:** `npm test`, `npm run typecheck` and `npm run lint` green and exit 0.
`npm run splitprobe -- <largest domain> --stability` against the LIVE vault (read-only) prints,
at vault HEAD `dd0fe9a2`: 8 shelves (161, 66, 59, 49, 44, 34, 30, 28) and 66 pages with the
parent; another seed and three days back each move at most 1 %. If the vault has moved on, the
new HEAD and numbers are recorded here and the stability bounds still hold. The time of one
proposal for the largest domain is recorded.

**Phase 1 measured (2026-09-23, vault HEAD `dd0fe9a2`, unchanged since the analysis).**
`npm test` 120 + 67 files, 2031 + 712 tests; `npm run typecheck` and `npm run lint` exit 0.
The new suites: `communities.test.ts` 4, `domain-split-engine.test.ts` 19,
`communities-parity.test.ts` 1.

`npm run splitprobe -- <largest domain> --stability` against `~/vault`, read-only:

| Measured | Result | Against the plan |
|---|---|---|
| Pages, links in the domain | 537, 3473 | as measured |
| Shelves | 8: 161, **67**, 59, 49, 44, 34, 30, 28 | one page differs: 67 against 66 |
| With the parent | **65** | 66 in the plan |
| One proposal | 120 ms | 96 ms in the analysis's script |
| Another seed, five of them | 0, 0, 1, 0, 3 of 537 pages move (0.0 to 0.6 %); one seed yields a ninth shelf out of the rest, moving no page off its shelf | at most 1 %: PASS |
| Three days back | 517 pages, 4 of them move (0.8 %), 9 shelves | at most 1 %: PASS |
| 14 and 30 days back | 16.5 % and 30.4 % move, 6 and 4 shelves | not bounded; the domain grew by 106 and 202 pages in those windows |
| Misfiling warning | on one shelf of eight (rank 8, precision 0.40); the next lowest is 0.67 | the analysis measured 0.43 without the rest as a class |
| Precision, conductance | 0.40 to 0.95; 0.04 to 0.12 | the analysis: 43 to 100 %; 0.04 to 0.12 |
| Pages the tags cannot place | 13 | 12 in the analysis |
| Largest domain share | 40.6 % now, 12.2 % after promoting all eight | |

**The one-page difference is the seed, not a defect.** The analysis's consensus used its own
permutation stream; this one uses `CONSENSUS_SEED` through mulberry32, and the plan itself
measures another seed at 0.2 % (one page of 537). The five other seeds above move 0 to 3 pages.
From here on the numbers above are the reference for E3, not the analysis's.

## Phase 2: the route

- [x] **2.1 `GET /api/v1/domains/:key/split`** in `api/routes/domains.ts`. 404 for a key the
      registry does not list; 400 for `meta` and `unassigned` (`isDepartmentDomain`); otherwise
      200 with the proposal, including `eligible: false` and its reason for a small domain and
      `shelves: []` and its reason for one that holds together. Both are answers, not errors.
      **Done.** The 400 is checked before the registry, so `meta` and `unassigned` answer 400
      whether or not a registry lists them.
- [x] **2.2 Memoised per graph object and key.** The graph builder returns the same object for
      an unchanged vault, so an unchanged vault costs one computation per domain.
      **Done** as `splitProposals(vaultRoot)` in the route module: a WeakMap from graph object to
      a per-key map, so an old graph and its proposals are collected together.
- [x] **2.3 Addresses** through `readAddresses` for the domain's pages. A page without an
      address is listed as unaddressed and can never be approved (phase 5 needs it). Today all
      537 pages of the largest domain have one.
- [x] **2.4 Types** hand-mirrored in `web/src/api/types.ts`, as that file's header prescribes,
      and one client function.
      **Done, with one field the plan did not name**: `totals.largestOther`, the largest
      department domain OTHER than the one split. Without it the client cannot compute "the
      largest share after" for a selection that promotes only some shelves (3.1), because the
      second-largest domain is not in the proposal.
- [x] **2.5 Flag-off:** base product; the route joins the `UNGATED` group of
      `server/test/agents-flag-off.test.ts`.
      **Done.** The flag-off fixture vault gained a one-domain registry, because the control
      group asserts a flat 200 and an unlisted key is a 404 by design.

**Tests** (`server/test/domain-split-route.test.ts`): a fixture vault built in a temp directory
(a registry, three planted blocks of synthetic pages with addresses) through the real route: 200
and three shelves; the 404, the 400, `eligible: false` and "holds together"; the response checked
against a zod schema kept in the test; a second call returns the memoised object; a page added
to the vault changes the graph object and the answer.

**DoD:** the three commands green; on the E2E instance (stage E3) the route returns the shelves
`splitprobe` printed for the same vault HEAD.

**Phase 2 measured.** `domain-split-route.test.ts` 6 tests, the flag-off suite 7, all green; the
three commands exit 0. The E3 half is stronger than written: the script compares the route's
body with `splitprobe --json` for the same copy BYTE FOR BYTE, not only the shelf sizes. Result
under **E2E results**.

## Phase 3: the view

- [x] **3.1 `web/src/lib/splitShelves.ts`**, pure: proposal to `clusterIds` and `clusterLabels`
      for the current node array (matched by path); the mask for one shelf; and the selection
      arithmetic the decision UI of phase 6 reuses (pages moved, parent keeps, the largest share
      after, links turning cross-domain from the link matrix) for any set of promoted shelves and
      merges.
      **Done**, plus `shelfState` (the enabling rule, 3.2), `shelfChips` and `largestDepartment`
      (the status input, 3.5). A new domain in a selection is named `shelf:<ids>` until it has a
      key.
- [x] **3.2 Graph screen, a "Shelves" overlay**, available under exactly the condition Landmarks
      uses (one domain on show, `inDomainScope`), disabled under `SPLIT_MIN_PAGES` with the
      reason, and saying "holds together" when there are no shelves. While it is on, the hulls
      are the proposed shelves, handed to `GraphCanvas` through its `clusters` and
      `clusterLabels` props in place of `detectClusters`' output, with a chip per shelf and one
      for the rest. A chip NARROWS the view through `narrow()`, like the tag filter, so the type
      chips go on counting what the other filters leave. The cluster toggle and the overlay
      exclude each other, because both draw hulls.
      **Done, with the exclusion drawn wider than written:** the overlay also turns Landmarks
      and Spotlight off and yields to either, like Landmarks yields. Landmarks paints a tenth
      of each shelf; a Spotlight click re-detects communities over the drawing, which is the
      partition this overlay replaces. Bridges stays allowed and colours the links between
      shelves. The overlay is session memory, not a saved preference: it shows a proposal.
      The hulls take a per-shelf hue (no domain map), and the chips wear the same hue. `NO_DOMAIN`,
      `meta` and `unassigned` answer "Not a domain", because the route answers them 400.
      The canvas now states the number of hulls it drew as `data-hulls`, which is what lets E3
      count them without scanning pixels.
      **Removed 2026-09-23, after the merge, at the user's request** (see 8.7): the overlay, its
      switch and chips, `shelfClusters`, the `gs-shelves` style and `data-hulls` are gone; the
      Graph screen is as it was before this branch. The Catalog chips (3.3) and the System panel
      stay.
- [x] **3.3 Catalog:** the same chips when exactly one domain is selected; a chip filters the
      rows.
      **Done** as a "Shelves" section of the panel, shown when the one selected domain passes
      the overlay's condition and has shelves; the proposal is asked only then.
- [x] **3.4 The proposal panel**, in System, in the Domains card of the expert tools
      (`card-domains`): a domain picker defaulting to the largest, the shelf cards in rank order
      (size, types, conductance, stability, precision and recall, the misfiling warning,
      landmarks as page links, tags, confused-with, outside neighbours), and the totals for
      "promote all". Read-only: no control in it writes anything until phase 6.
      **Done** as `components/SplitProposalPanel.tsx`, mounted in `tabs/Maintenance.tsx` under
      the domain candidates (the Domains card lives there; System renders it). The picker lists
      every department domain with its size; a small one shows its reason.
- [x] **3.5 The status model** (`web/src/lib/maintenanceStatus.ts`): a new area `split`,
      `recommended` when the largest department domain holds `OVERSIZE_SHARE` or more of the
      knowledge pages and at least `SPLIT_MIN_PAGES`, never `due` (a large domain blocks nothing).
      Cost "none, deterministic", jump to the panel. Derived from the graph the dashboard already
      loads; no new request.
      **Done.** Below the share the item is absent rather than healthy.
- [x] **3.6 Hard rule 8:** nothing in this phase requests a Fellow route. The Fellow line of the
      panel arrives in phase 6, behind `health.fellows`.
      **Checked by hand and by E10**: the three new queries ask only the split route.

**Tests:** `web/test/splitShelves.test.ts` (matching by path, pages absent from the proposal get
−1, the mask, the selection arithmetic including a merge, each against a hand count);
`web/test/maintenanceStatus.test.ts` (the item at 25 %, absent at 24 %, never `due`); the
overlay's enabling rule as a pure function beside the Landmarks one, with the same cases.

**DoD:** the three commands green; stage E3's UI walk passes on the E2E instance.

**Phase 3 measured.** `splitShelves.test.ts` 13 tests, `maintenanceStatus.test.ts` 30 (3 new);
the three commands exit 0. D7 re-measured on the copy: 0 of the 32 proposed tag hints of the
largest domain equal the name of an entity page (slugged title or alias), so the structural
filter alone keeps entity-shaped tags out on this vault. The UI walk ran first against a
development loop (tsx instance on the copy, Vite with a proxy): 17 PASS, 0 FAIL. The gate run is
under **E2E results**.

## Gate A: the checkpoint after milestone A

- [x] **A.1** `npm test`, `npm run typecheck`, `npm run lint`: green and exit 0, with the file
      and test counts recorded.
      **2026-09-23, branch at the gate:** server 121 files, 2037 tests; web 68 files, 728 tests;
      all three exit 0. New on the branch: 3 server files (`communities`, `domain-split-engine`,
      `domain-split-route`) and 2 web files (`communities-parity`, `splitShelves`), plus tests
      added to `agents-flag-off` and `maintenanceStatus`.
- [x] **A.2** Phase 7's `[A]` stages (E0 to E3, the `[A]` half of E10, E11, E12), with the `[A]`
      half of `scripts/e2e-domain-split.mjs` (7.1), which is written in this milestone. Results
      recorded under **E2E results**.
- [x] **A.3** `scripts/vault-name-scan.mjs --diff main` over the branch and `--file` over the PR
      body; UI strings and fixtures read by eye.
      **Clean.** `--diff main`: nothing matched over 2336 terms. `--file` over a drafted merge
      text: nothing matched. By hand, because the scan knows titles only: the added lines checked
      against 90 terms it cannot know (every domain key of the vault, the 32 proposed tag hints,
      the 40 landmark titles of the largest domain): 0 hits. Fixtures are synthetic (`alpha`,
      `Page B0-001`); the UI strings name mechanisms.
- [x] **A.4** Docs owed: `docs/API.md` (the GET route), `CHANGELOG.md`, SPEC.md §12.4 stage 4
      part one (appendix A), the last applied only on the user's word.
      **`docs/API.md` and `CHANGELOG.md` written** (the changelog entry is dated `2026-09-xx`
      until the merge). Appendix A part one is ready as it stands and matches what was built;
      SPEC.md is untouched until the user's word. **The SPEC part moved to 8.5 (2026-09-23)**,
      where both parts land together.
- [x] **A.5** ~~Merge.~~ **Dropped 2026-09-23:** milestone A does not merge on its own; the
      branch merges once, after phase 8 (see the intro).

## The usage gate (dropped 2026-09-23)

It asked for a week of use between the milestones, recorded here: whether the shelves read right,
which ones the user would promote, whether the misfiling warning agrees with their own sense of
the subject, and whether the view alone answers the complaint. The last question was answered by
the go-ahead for milestone B. The other three are asked where they decide something: in the
decision surface of phase 6, in front of the first real split (8.7).

---

# Milestone B: the write

Started 2026-09-23 on the user's word, on the same branch.

## Phase 4: registry operations

In `server/src/pipeline/domains.ts`, pure, beside `appendDomainSection`.

- [x] **4.1 `replaceDomainSection(markdown, key, entry)`**: replaces exactly the section of
      `key`, from its `## key` heading to the next `## ` heading or the end, and preserves every
      other byte. Null when the key is missing.
      **Done.** The whitespace that separated the section from the next one is kept as it was, so
      "every other byte" includes the blank lines around it.
- [x] **4.2 `insertDomainSectionsAfter(markdown, afterKey, entries)`**: inserts the sections
      directly after `afterKey`'s, in the given order and in the shape `appendDomainSection`
      writes. Null when `afterKey` is missing or any key exists already.
- [x] **4.3 `applyRegistrySplit(markdown, { parent, children })`** composes the two and returns
      the new text or a typed refusal: `unknown-parent`, `duplicate-key`, `invalid-key`,
      `reserved-key` (`meta`, `unassigned`).
      **Done**, with `parentEntry` beside `parent` and `children` in its argument: the narrowed
      entry is part of the same write (D8).
- [x] **4.4 The deterministic parent draft**, the floor under the naming pass: the parent's old
      description with one sentence appended that names what now has its own domain ("Pages on
      `a`, `b` and `c` have their own domains."), and its tag hints minus every tag a promoted
      child lists. Shown as a diff and editable in phase 6.
      **Done** as `draftParentEntry` in `domains.ts`, hand-mirrored in `web/src/lib/domainDraft.ts`
      (the decision surface shows it before any request) and pinned by the same cases in both
      suites. A promoted group without a key yet stays out of the sentence, and its tags leave the
      parent all the same.
- [x] **4.5 The seed's conventions** (`scripts/vault-extensions/domains.md`) gain D1's sentence:
      altitude is judged against the vault's volume; a domain that outgrows a shelf is split into
      peers, and the part that stays keeps the old key with a narrowed description. The installed
      copy belongs to the user and is amended by hand (8.6).

**Tests** (`server/test/domains.test.ts`, additions): the text before and after the replaced
section is identical; after `applyRegistrySplit`, `parseDomainRegistry` lists the parent with
its new description and tags and the children directly after it, in order; every refusal; a
registry whose last section is the parent; the conventions above `## Domains` untouched; the
parent draft never keeps a tag a child lists.

**DoD:** tests green; `applyRegistrySplit` over the E2E copy's registry (stage E5) changes only
the parent section and adds only the new ones.

**Phase 4 measured.** `domains.test.ts` 29 tests, 11 of them new; the three commands exit 0. On the
E2E copy: the plan's registry diff removes 5 lines, all of them the parent's, and adds the three
new sections in order (E5); after the apply every other section of the real registry is
byte-identical and the children stand directly after the parent (E6).

## Phase 5: the writer

`server/src/pipeline/domain-split-write.ts`. Hard rule 1's order throughout: the vault's per-file
locks OUTSIDE the commit mutex; the writes and the commit inside it.

- [x] **5.1 The request:** `{ parent, parentEntry: { description, tags }, children: [{ key,
      description, tags, pages: [{ address, path }] }] }`. A merged shelf is simply one child
      with the union of the pages; the server knows nothing about merges. Validated before
      anything else: keys valid, new and not reserved; at least one child; every address listed
      once.
      **Done** as `parseSplitRequest`. "New" is asked of the registry by the plan and the apply,
      not by the parser, so it cannot go stale between the two; a child with no pages, or with the
      parent's own key, is refused as well.
- [x] **5.2 `planSplit`**, read-only: the registry diff; one line pair per page (`domain:
      <parent>` to `domain: <child>`); what `wiki/index.md` will show per heading; and a verdict
      per page: `ok`, `gone` (the address resolves to no page), `moved` (its `domain:` is no
      longer the parent), `unaddressed`. Warnings: the parent keeps fewer than `SHELF_MIN_PAGES`;
      a child key collides with a tag (both counts, from `keyCollision`); a child carries the
      misfiling warning.
      **Done.** A child carries the misfiling warning when it is mostly made of a shelf that
      does: a merge inherits it.
- [x] **5.3 Refusals before any lock**, typed errors answered with 409 at the route: while
      `RunRegistry.activeRuns > 0` ("a run is writing the vault"); while the service's git
      auto-commit setting is off ("a split is only offered with commits on, because its undo is
      a revert"). Demo mode refuses every non-GET already (403), the plan included.
      **Done, and one name differs:** `RunRegistry` was not reachable from a route. `main.ts`
      built one and handed it to the queue and the maintenance runner only; it now reaches the
      routes as `ctx.runRegistry`, the same instance. The check and the registration run with no
      `await` between them, so no run can start in the gap.
- [x] **5.4 `applySplit`**, in this order:
  1. `runRegistry.begin()` for the whole apply, so no run that starts meanwhile can count itself
     the sole writer and sweep the split's files as its own leftovers (the F4 discipline
     `run-registry.ts` describes);
  2. resolve addresses to CURRENT paths (`readAddresses`), so a page renamed since the plan is
     still found;
  3. `withWikiLocks` over the registry, `wiki/index.md` and every page. A busy page is skipped as
     `busy`. A busy registry or index refuses the whole apply, because a split without its
     registry change is not a split;
  4. inside the commit mutex: per held page, re-read it, check that `domain:` still equals the
     parent (else `moved`), replace that one line keeping its quoting, `stampDates({ content:
     false })`, write. Then the registry through `applyRegistrySplit`, then `renderIndex`, then
     ONE `commitPaths` with the exact pathspec and the subject `domains: split <parent> into <k>
     (<n> pages)`: keys and counts, never a title;
  5. read every written page back and report any whose `domain:` is not its child key;
  6. record the split (5.6) and return `{ commit, written, skipped: [{ address, reason }],
     verified }`.

  **Done**, with two additions. Everything is computed inside the mutex before the first byte is
  written, and a commit that fails puts every file back and unstages it: the apply is all or
  nothing. And the route checks the written pages afterwards under `tag-mirroring` and `dates`
  only, the two rules that read what a split writes. Under every rule, on the copy, one split
  booked 158 findings on its 218 pages (`page-schema` 95, `open-question-form` 34, `title-name`
  24 and four more), all of them there before the split and unseen only because nothing had
  re-read those pages since their rule arrived; booked by a split, they would read as its doing.
  **Measured: 68.8 s for 311 pages on the server.** The time is the vault's lock script, about
  0.1 s per call and two calls per page; the lock module is shared and was not changed for
  this. The preview says so ("a few hundred pages take about a minute").
- [x] **5.5 `applyRemainder(splitId)`**: the same writer over the pages of an applied split whose
      `domain:` is still, or again, the parent. The registry is untouched (its sections exist);
      one commit, subject `domains: re-file <n> pages after the split of <parent>`, added to the
      split's record.
- [x] **5.6 Migration 37:** `domain_splits (id, user_id DEFAULT 'local', parent, children JSON
      [{ key, addresses }], commits JSON, created_at, reverted_at)`. Operational state only:
      losing it loses the remainder and revert conveniences and nothing of the vault, because the
      split commit names every page it moved (SPEC §8).
      **Done**, with 6.3's table in the same migration. Store: `server/src/db/domain-splits.ts`.
- [x] **5.7 Routes:** `POST /api/v1/domains/:key/split/plan`, `POST
      /api/v1/domains/:key/split/apply`, `GET /api/v1/domains/splits` (applied splits, each with
      its commits and live remainder count), `POST /api/v1/domains/splits/:id/remainder`. All base
      product, all in the flag-off test's `UNGATED` group.
- [x] **5.8 Hard rule 1:** the writer's row in CLAUDE.md's writer table (appendix B) BEFORE the
      branch merges, and a note on the hubs row that it has a new caller.
      **In CLAUDE.md** since 2026-09-23, on the user's word: the row, the hubs note and the
      sentence on the registry's two writers, as drafted in appendix B.

**Tests** (`server/test/domain-split-write.test.ts`, against real git in a temp fixture vault, the
way `reconcile.test.ts` and the revert tests work):

- one apply is ONE commit containing exactly the registry, the index and the written pages;
- every page diff is exactly two changed lines, `domain:` and `updated:`; `content_updated:` is
  never touched;
- the plan writes nothing: HEAD and the tree unchanged;
- `moved`, `gone`, `unaddressed` and `busy` (the fake lock executor of the existing lock tests)
  are skipped with their reasons and not written;
- a busy registry lock refuses the whole apply and writes nothing;
- `activeRuns > 0` refuses; auto-commit off refuses; demo mode answers 403 (through the route);
- `RunRegistry` counts the apply while it runs and not afterwards;
- a page renamed between plan and apply is found by its address and written at its new path;
- the index after the commit lists the moved pages under the children's headings;
- the read-back reports a page whose `domain:` a test hook sets back between commit and check;
- the remainder: a page set back to the parent AFTER the split appears in the remainder, and one
  `applyRemainder` moves exactly it;
- migration 37 applies on a copy of a real database (v36 to v37), every table's row count is
  preserved, `foreign_key_check` is clean.

**DoD:** the three commands green; stage E6 on the E2E copy, with the duration of the apply
recorded.

**Phase 5 measured.** `domain-split-write.test.ts` 22 tests against real git (the list above,
plus the request parser, the line change keeping its quoting, and a failed commit leaving the
tree clean), `domain-split-route.test.ts` 5 more for the write routes (demo 403, the 409s, the
leave and defer memory, the naming pass on the read-only path, an apply through the route);
`agents-flag-off.test.ts` asserts every write route registered with the flag off. The three
commands exit 0. E6 on the copy: under **E2E results**, milestone B; the apply took 68.8 s.

**Two findings on the way, neither touching D1 to D18.**

1. **The batch lock called a refused path busy, for good.** `withWikiLocks` reported every
   non-zero acquire as `busy`; the single form has always written such a page unlocked. The
   vault's script refuses a path containing `..` with exit 4, and two pages of the largest
   domain carry one (a title ending in a full stop). In a development run they were skipped as
   `busy` by the split and would have been by every remainder re-file after it. Fixed in the
   shared module as its own commit (`fix(wiki-lock): …`), with a test.
2. **The post-write validation** described under 5.4.

## Phase 6: the decision surface

- [x] **6.1 Decisions per shelf** in the phase-3 panel, now with controls: promote, leave, defer,
      and "merge with" another shelf. A promoted shelf gets a key field (checked while typing:
      `isValidDomainKey`, not an existing key, and the two collision counts of `keyCollision`), a
      description (drafted by `draftDomainDescription`, with the landmarks beside it as the
      evidence) and tags (the shelf's, editable). Below them the parent section as a diff against
      its current entry (4.4's draft), and the before-and-after figures from `splitShelves.ts`,
      recomputed on every change. The decision state is a pure reducer in `web/src/lib/`.
      **Done** as `web/src/lib/splitDecisions.ts`. A field shows the user's edit, then the naming
      pass's answer, then the draft; a key is never drafted, because the obvious draft is the top
      tag D7 forbids.
      **Relabelled 2026-09-23, after the merge, at the user's request:** a shelf is named "Shelf
      N" until it has a key; its top tags stand beside it as "tagged #a #b", its top tag's cost is
      phrased as "would make a poor key", and a promoted shelf says above its key field what the
      key is. The old label, "1 · #a #b", read as the name the new domain would get. The collision counts are computed in the browser from the graph it already
      holds (`keyCollisionOf`, the server's `keyCollision` mirrored), so they move as the key is
      typed.
- [x] **6.2 The naming pass**, optional: `POST /api/v1/domains/:key/split/naming` starts the
      maintenance kind `split-naming` through the read-only run path (`runReadOnly`, `query`
      profile: no writer registration, no sweep, no commit) with the chosen shelves' landmarks,
      sizes and tags, the other registry keys, and the parent's entry. It answers per shelf a
      key, a description and tags, and for the parent a narrowed description and tags, in a fixed
      block format parsed leniently like `parseDomainReview`. Its answers fill the fields; the
      user's own edits win.
      **Done** (`pipeline/split-naming.ts`). The body names GROUPS of shelf ids, a merge being a
      group of two; the route reads their landmarks, sizes and tags from the proposal itself, so
      the prompt carries what the proposal says and nothing a client made up. The read-only path
      now says in the run's own log that it is one, which is what E4 reads.
- [x] **6.3 Memory, migration 38:** `domain_split_decisions (user_id, parent, fingerprint,
      decision 'leave' | 'defer', decided_at, PRIMARY KEY (user_id, parent, fingerprint))`. A left
      shelf is not proposed again while its fingerprint holds; a deferred one comes back at the
      next maintenance run; both can be restored. (Folded into migration 37 if both land in one
      branch.)
      **Done, folded into 37.** What "comes back at the next maintenance run" means, since the
      plan did not say: a left shelf is listed under the cards as left, with restore; a deferred
      one stays a card, marked deferred and starting at "defer" in the panel, and starts open
      again in the guided run, which is the next maintenance run. Leave and defer are stored the
      moment they are clicked, not at an apply. The decisions ride beside the proposal in the GET
      route's answer as `decisions`, never in the memoised proposal, so E3's byte comparison with
      `splitprobe` drops that one field.
- [x] **6.4 Plan, then apply:** "Preview" shows the plan (registry diff, pages per child, skipped
      pages with their reasons, warnings); "Apply" is the two-step confirm every other vault
      write of the dashboard uses. The summary names the commit, the written count, the skipped
      pages and the remainder.
- [x] **6.5 Applied splits** under the panel, each with its commits, its live remainder and
      "re-file the remainder".
- [x] **6.6 Revert (D17):** `POST /api/v1/domains/splits/:id/revert` reverts the split's commits
      newest first through `revertCommit` (clean tree, conflict abort, behind the commit mutex).
      It refuses, naming the pages, while any page outside those commits carries one of the
      split's child keys. On success the record is marked reverted.
      **Done, with two consequences of `revertCommit` the plan did not state.** It leaves the hubs
      and the address counter alone on purpose, so the split's revert re-renders
      `wiki/index.md` in a commit of its own afterwards; and its subject was fixed at `revert
      ingest …`, so it takes the caller's (`domains: revert <hash>, part of the split of
      <parent>`). A conflict on a later commit resets HEAD to where this call found it, undoing the
      reverts it had already made. E9's "diff prints nothing" is therefore asked with the same
      paths left out that `revertCommit` documents (the hubs, the counter), and after the hand
      move of E6 is reverted by hand too.
- [x] **6.7 The guided maintenance run** (SPEC §12.7) gains the split as a decision step that
      embeds THE SAME component as the panel: one implementation per decision surface.
- [x] **6.8 Fellows (hard rule 8):** when `health.fellows` is true, the panel lists the Fellows
      whose home domain is the parent and what each would keep, from the existing `GET
      /api/v1/agents`. With the flag off the line is not rendered and the request is not made.
- [x] **6.9 Leave and defer routes:** `POST /api/v1/domains/:key/split/decisions` and `DELETE
      /api/v1/domains/:key/split/decisions/:fingerprint`, in the `UNGATED` group.

**Tests:** the naming prompt (it carries the shelves and the existing keys and asks for no edit)
and its parser (well-formed, drifted, partial); the run starts with the `query` profile through
the read-only path (runner mock); the decision reducer (promote, leave, defer, merge, un-merge,
and the plan request it produces); the memory (a left fingerprint is suppressed, a changed one is
not, restore works); revert against real git (success restores the pre-split tree, the refusal
names the orphaned pages, a conflict aborts and leaves the tree byte-identical); the flag-off test
proves no Fellow request.

**DoD:** the three commands green; stages E4 to E9 on the E2E copy.

**Phase 6 measured.** `split-naming.test.ts` 5 tests (prompt, parser well-formed, drifted,
partial, prose); `splitDecisions.test.ts` 15 (the reducer, the memory, the fields, the plan
request, the web mirror of the parent draft, the key collision); `maintenanceStatus.test.ts` 2
more for the guided run's split step. The naming pass's `query` profile is asserted through the
route with a runner mock, the revert against real git in `domain-split-write.test.ts`. That the
Fellow line asks nothing with the flag off is read from E10's network log, not from a unit test:
the web suite renders no components. The three commands exit 0. E4 to E9: under **E2E results**.

**One finding on D15, and no change proposed.** The fingerprint holds for the shelf that was
left (28 pages before and after, the same three landmarks) and does NOT hold for the one that
was deferred: once its neighbours were promoted, 15 of its 67 pages fell back to the rest, its
size band went from 6 to 5 and one of its three landmarks changed. So it came back open, not
marked deferred. That is D15 as written ("while its fingerprint holds"), and for a defer it
costs nothing, since a defer is meant to come back. For a LEAVE it would mean a left shelf is
asked about again after a split of its siblings changes it; whether that is right is a question
for the first real split (8.7), not a defect.

---

## Phase 7: the final end-to-end test against a throwaway copy of the vault

**What it proves that no unit test can:** the proposal on the real vault is what `splitprobe`
says; the view draws exactly it; a real split of the real registry and several hundred real pages
is one commit that one revert undoes; the narrowed parent actually changes where a REAL ingest
files a new page; and the live system is untouched afterwards.

**The environment.** Everything lives under `E=$HOME/e2e-split`: `vault/` (the copy), `app/` (a
git worktree of the branch, built there, so the main tree's `web/dist` is never touched), `data/`
(a snapshot of the live database, the log, an inbox, screenshots). The instance listens on port
8435. All of it is deleted at the end. **The final run takes every stage, E0 to E12, from a fresh
E0**, the `[A]` stages again too, because the branch has changed under them since Gate A.
Whatever environment came before (a development loop's, or the one Gate A left behind) is
removed first.

- [x] **7.1 `scripts/e2e-domain-split.mjs`**, the scripted half. It REFUSES to start unless the
      process listening on `--port` has, in its `/proc/<pid>/environ`, a `VAULT_ROOT` equal to
      `--vault`, and that path is not `~/vault` by realpath. Each check prints PASS or FAIL with
      its numbers; the run ends with a summary and a non-zero exit on any FAIL. It records the
      copy's HEAD before and after every stage, so every commit a stage produced is listed and any
      foreign one (a recap written in the background, say) is explained rather than miscounted.
      The `[A]` stages are written with milestone A, the `[B]` stages with milestone B.
      **[A] written.** E0 is the one stage that cannot pass the identity check, because it runs
      before the instance exists: it asserts the port is FREE instead. E1 and E11 read files and
      the live instance only. E12 stops the instance by the rule written below and leaves the
      worktree and the copy to be removed by hand.
      **[B] written.** E4, E5 and E6 run in ONE browser page (`--stage E4,E5,E6`), because the
      decisions live in the page. `--naming` runs the paid pass, `--keys` types three keys by hand
      for a free development run; `--doc`/`--url` feed E8, and `--job` re-reads a job that already
      ran instead of paying for a second upload. Four things the runbook left open, decided in the
      script: E4 restores decisions a development loop left behind before it decides; the walk
      expects no card for a shelf stored as left; E6's "the deferred one is proposed" counts a
      shelf holding most of its pages, whether or not its fingerprint held (phase 6, the finding
      on D15); and E9 reverts the hand move of E6 by hand before it compares, and leaves out of the
      comparison exactly what `revertCommit` leaves alone (the hubs, the address counter).

### E0: preconditions `[A]`

- The live instance idle: `/api/v1/health` shows `queue.inFlight` 0, no maintenance run is in
  flight, and `git -C ~/vault status --short` is empty. The copy of E1 is taken from this state.
- Outside the night window (01:00 to 06:00), so no scheduled work runs on the copy.
- Port 8435 free: `ss -ltnp | grep ':8435 '` prints nothing.
- At least 10 GB free; the copy is 2.9 GB.
- The branch green: the three commands exit 0.
- Recorded: `git -C ~/vault rev-parse HEAD` and the live job counts.

### E1: setup `[A]`

```bash
E=$HOME/e2e-split
mkdir -p "$E/data/inbox" "$E/shots"
cp -a ~/vault "$E/vault"                                   # .git, .raw and .vault-meta included
find "$E/vault/.vault-meta/locks" -mindepth 1 ! -name .gitkeep -delete   # never inherit a held lock
git -C "$E/vault" remote -v                                # every push URL reads PUSH_DISABLED_...
git -C "$E/vault" fsck --no-progress                       # exit 0
sqlite3 ~/.local/share/librisvault-dev/jobs.db ".backup $E/data/jobs.db"
git -C ~/dev/Curious worktree add --detach "$E/app" <branch>
cp -al ~/dev/Curious/node_modules "$E/app/node_modules"    # hardlinks: vite resolves symlinks away
cp -al ~/dev/Curious/web/node_modules "$E/app/web/node_modules"
cp -al ~/dev/Curious/server/node_modules "$E/app/server/node_modules"
(cd "$E/app" && npm run build)                             # built in the worktree, never in the main tree
```

Checks: the copy's HEAD equals E0's live HEAD; `git -C "$E/vault" status --short` is empty; the
snapshot's `PRAGMA user_version` equals the live one (the instance migrates it on start, which is
itself part of the test).

**Three corrections to the block above, found running it (2026-09-23).** `rm -rf` of the locks
directory deleted its tracked `.gitkeep`, so the copy was never clean; only the lock files are
removed now. `git worktree add` refuses a branch that is checked out in the main tree, which it
is while the branch is worked on; the worktree is detached at the branch tip. And
`server/node_modules` exists beside the other two and is hardlinked as well.

### E2: the instance `[A]`

```bash
cd "$E/app"
PORT=8435 VAULT_ROOT="$E/vault" DB_PATH="$E/data/jobs.db" WATCH_FOLDER="$E/data/inbox" \
DEV_INSTANCE_DATA="$E/data" TELEGRAM_BOT_TOKEN="" AGENTS_ENABLED=1 \
setsid nohup "$E/app/scripts/dev-instance.sh" npm run start:prod --workspace server \
  >> "$E/data/service.log" 2>&1 < /dev/null &
```

- `TELEGRAM_BOT_TOKEN=""` is load-bearing: the real environment wins over the credential file
  (`loadConfig` in `config.ts`), and Telegram allows one poller per token, so without it the copy
  would take the live bot's messages.
- Identity, not merely HTTP 200 (the lesson of `TASKS-E2E-SETUP.md`): the pid on 8435 has
  `VAULT_ROOT` pointing at the copy in its environment, the log's first line names the copy,
  `/api/v1/health` shows the snapshot's job counts, and the startup log shows the bot off.
- The database migrated: `user_version` is the new one, `PRAGMA quick_check` says ok.
  Milestone A adds no migration, so for `[A]` the version stays 36.

### E3: the proposal and the view `[A]`

`PARENT` is the largest department domain in `GET /api/v1/graph` on 8435.

- `GET /api/v1/domains/$PARENT/split`: at vault HEAD `dd0fe9a2`, 8 shelves (161, 66, 59, 49, 44,
  34, 30, 28) and 66 pages with the parent; at a later HEAD, the shelves `splitprobe` prints for
  that HEAD. Two calls return deep-equal bodies.
- `npm run splitprobe -- $PARENT --stability` against the copy: another seed and three days back
  each move at most 1 %.
- The misfiling warning is on every shelf with precision under `MISFILE_PRECISION` and on no
  other.
- The UI, driven over CDP the way `scripts/shoot-screens.mjs` does it (wait on a selector, never
  on `networkidle`, which the SSE stream keeps open; clear `localStorage` before each domain
  change, because the domain selection survives a reload):
  - (removed with the overlay, 2026-09-23) the Graph filtered to `$PARENT` with the Shelves overlay on: one hull and one chip per shelf
    plus the rest, each chip's count equal to the route's size;
  - a chip narrows the Graph to exactly that many pages (the screen's own "N of M" line);
  - the Catalog with the same chip shows the same number of rows;
  - the System panel shows the shelves in the route's rank order and with the route's numbers;
  - the status item is `recommended` and names the share.
- Screenshots go to `$E/shots` only.

### E4: the naming pass `[B]`, paid, about $0.40

Asked of the user before it runs.

- In the panel, the E2E decision set: the two top-ranked shelves promoted; two further shelves
  MERGED and promoted as one; one shelf left; one deferred. Then the naming pass.
- The run log shows the `query` profile; HEAD is unmoved and `git status` clean afterwards. The
  read-only path kept it read-only, not the prompt.
- None of its keys is a tag carried by more than a handful of pages (the collision counts are
  shown); its parent description differs from the old one.

### E5: the plan `[B]`

- `POST /api/v1/domains/$PARENT/split/plan` with the decision set: the registry diff touches the
  parent's section and adds exactly the new ones directly after it; every page line pair is
  `domain:` from the parent to a child; the warnings are the expected ones.
- Nothing written: HEAD unmoved, status clean.

### E6: the apply, with its edge cases `[B]`

Prepared just before the apply, each on a page of a promoted shelf:

- **busy:** `bash "$E/vault/scripts/wiki-lock.sh" acquire <page>` less than ten minutes before
  the apply (the service treats a lock as held for 600 s, `WIKI_LOCK_STALE_SEC`);
- **moved:** another page's `domain:` changed by hand to another existing domain, committed in
  the copy. Record `PRE_APPLY=$(git -C "$E/vault" rev-parse HEAD)` after this commit.

Then apply. Expected:

- exactly ONE new commit; `git show --stat` lists the registry, `wiki/index.md` and the written
  pages, and nothing else;
- per page exactly two changed lines, `domain:` and `updated:`; `git show | grep content_updated`
  prints nothing;
- skipped: the busy page as `busy`, the hand-moved page as `moved`; verified: every written page;
- `GET /api/v1/domains` lists the children directly after the parent; the index shows their
  headings with the right counts;
- the standing defect list before and after: no new `tag-mirroring` finding, any other change
  explained;
- `git -C "$E/vault" fsck` exits 0;
- the Graph, the Catalog and (flag on) the Library room show the new domains, and the room places
  the new shelves without an error;
- the proposal for `$PARENT` afterwards: the promoted shelves are gone from it, the left one is
  not proposed, the deferred one is.

### E7: the remainder `[B]`

- `bash "$E/vault/scripts/wiki-lock.sh" release <page>`. The applied split shows a remainder of 1:
  the busy page. The hand-moved page is not remainder; it lives elsewhere by the user's hand.
- Re-file the remainder: one commit with exactly that page and the index; the remainder is 0.

### E8: a real ingest after the split `[B]`, paid, about $1 to $2

The user picks ONE new document on the subject of the largest promoted shelf, one the vault does
not already hold (the dedupe verdict says so before the agent runs).

- Upload it to 8435 (`POST /api/v1/jobs`). While it runs, `POST
  /api/v1/domains/splits/<id>/remainder` answers 409 "a run is writing the vault": D11's refusal,
  seen with a real run.
- The job ends `done` and every page it created carries the CHILD key. **This is the one check
  that proves the narrowed parent (D8) works.** If a created page carries the parent key, the
  finding is written here, and 4.4's parent draft is not good enough.
- Optional, a second document on a subject no shelf took: its pages carry the parent key.

### E9: revert `[B]`

- Revert the split through the API: 409, naming the pages the E8 ingest filed into a child (D17).
- Revert the E8 job (`POST /api/v1/jobs/:id/revert`), then the split: its commits are reverted
  newest first, and `git -C "$E/vault" diff $PRE_APPLY HEAD` prints nothing.
- The split record is marked reverted, and the proposal for `$PARENT` is E3's again.

### E10: the flag-off and demo walks `[A]` and `[B]`

- Restart 8435 with `AGENTS_ENABLED=0`: `health.fellows` is the BOOLEAN `false`; the Graph
  overlay, the Catalog chips and the panel work; the walk's network log shows no request to a
  Fellow route and no 404.
- Restart with `DEMO_MODE=1`: the GET route and the view work; `[B]`: every split write surface
  is DISABLED rather than hidden, and every split POST answers 403 `demo_read_only`.

### E11: the live system untouched `[A]` and `[B]`

- `git -C ~/vault rev-parse HEAD` equals E0's value and `git -C ~/vault status --short` is empty.
- The live `/api/v1/health` answers with E0's job counts plus whatever the user did meanwhile,
  and the live UI loads: the asset hashes of its own `index.html` answer 200 on 8421.

### E12: teardown `[A]` and `[B]`

- Stop 8435: the pid by `/proc/<pid>/environ` containing `PORT=8435` and `/proc/<pid>/comm`
  equal to `node`; SIGTERM, up to 30 s, then SIGKILL.
- `git -C ~/dev/Curious worktree remove "$E/app"`.
- `rm -rf "$E"` ONLY after the results below are recorded and the user agrees. The copy holds the
  private vault; deleting it is part of the test, not a courtesy.

## E2E results

Counts, hashes and PASS or FAIL only: no titles, no tags, no vault text.

### Milestone A, 2026-09-23 (Gate A)

Live vault HEAD `dd0fe9a2` throughout; the copy taken at 09:57, the worktree detached at the
branch tip and built there. Every stage run by `scripts/e2e-domain-split.mjs`; screenshots under
`$E/shots` only.

| Stage | Result | Numbers |
|---|---|---|
| E0 | 10 PASS | live `inFlight` 0, no maintenance run, live vault clean, hour 9, port free, 959 GB free, the three commands exit 0; live jobs `done` 46, `cancelled` 1 |
| E1 | 4 PASS | the copy's HEAD equals the live one, clean, both push URLs disabled, `user_version` 36 on both |
| E2 | 7 PASS | pid on 8435 with the copy's `VAULT_ROOT`, bot token empty, the log names the copy and `telegram: off`, health shows the snapshot's 46 + 1 jobs, `user_version` 36, `quick_check` ok |
| E3 | 18 PASS | 537 pages, 8 shelves 161, 67, 59, 49, 44, 34, 30, 28, 65 with the parent; two calls deep-equal; the route's body byte-identical to `splitprobe --json` on the copy; another seed 0 of 537, three days back 4 of 517 (0.8 %); misfiling on 1 shelf, exactly the one under 0.6; 9 chips with the route's sizes, 8 hulls, 9 of 9 chips narrow the Graph to their size and the Catalog to as many rows; the status item names 41 %; 8 panel cards in rank order with the route's conductance; 0 of 136 API responses 404 |
| E10, flag off | 14 PASS | `health.fellows` the boolean `false`; the same walk passes; 0 of 124 responses 404; 0 requests to a Fellow route |
| E10, demo | 10 PASS | `demoMode` true; the GET route and the Graph and Catalog walk pass; System stays switched off, the panel with it; 0 of 138 responses 404 |
| E11 | 4 PASS | the live vault's HEAD equals E0's and is clean; the live jobs equal E0's; the live UI's 2 assets answer 200; `curious.service` still the process started at 08:53 |
| E12 | PASS | the instance stopped by pid (environ `PORT=8435`, comm `node`); the worktree and the copy stay until the user agrees |

The copy's HEAD did not move in any stage: no background commit on the copy.

**Two findings on the way, neither touching D1 to D18.**

1. **The first flag-off walk FAILED (2 of 14): the Research screen asked `/api/v1/usage/plan`
   without an `enabled` guard**, 4 requests and 4 404s in one walk, because the screen is mounted
   behind `[hidden]` on every visit. Pre-existing on main (`e98712a`), not this feature's code,
   and exactly the class hard rule 8 names. Fixed on this branch as its own commit
   (`fix(research): …`), so it can be taken out if it should land separately; the rerun is the
   one recorded above.
2. **The first demo walk FAILED (4 of 13) on the System checks**, because the hosted demo
   switches the whole System screen off by design. The script was wrong, not the product: in
   the demo it now checks that System stays off. The Graph and Catalog halves passed as they were.

A development loop ran before the gate (tsx instance on an earlier copy, Vite with a proxy):
17 PASS there; that copy was deleted before the gate's fresh E0.

### Milestone B, 2026-09-23 (the final run, E0 to E12 fresh)

Gate A's environment removed first (the instance stopped, the worktree unregistered, the copy
deleted). Live vault HEAD `dd0fe9a2` throughout; the copy taken at 11:17 in 8.4 s, the worktree
detached at the branch tip `08608e8` and built there; the main tree's `web/dist` untouched (its
`index.html` still dated 2026-09-22). Every stage run by `scripts/e2e-domain-split.mjs`;
screenshots under `$E/shots` only.

| Stage | Result | Numbers |
|---|---|---|
| E0 | 10 PASS | live `inFlight` 0, no maintenance run, live vault clean, hour 11, port free, 959 GB free, the three commands exit 0; live jobs `done` 46, `cancelled` 1 |
| E1 | 4 PASS | the copy's HEAD equals the live one, clean, both push URLs disabled, `user_version` 36 on both; `fsck` exit 0 |
| E2 | 7 PASS | pid on 8435 with the copy's `VAULT_ROOT`, bot token empty, the log names the copy and `telegram: off`, health shows 46 + 1 jobs, **`user_version` 37**, `quick_check` ok. Migration 37 on the real snapshot: 24 tables, 17 281 rows, 0 tables with another count than the live file, `foreign_key_check` empty |
| E3 | 18 PASS | the Gate A numbers again: 537 pages, 8 shelves 161, 67, 59, 49, 44, 34, 30, 28, 65 with the parent; the route byte-identical to `splitprobe --json` (without `decisions`); another seed 0 of 537, three days back 4 of 517; 9 chips, 8 hulls, 9 of 9 narrow Graph and Catalog; the status item names 41 %; 8 cards in rank order; [B] a promote opens the decision surface; 0 of 132 responses 404 |
| E4 | 15 PASS | the decision set by clicks: ranks 1 and 2 promoted, ranks 3 and 4 merged, rank 5 left, rank 6 deferred; both remembered on the server. The naming pass: 202, settled `done`, 3 of 3 shelves named, **$0.45**; its log says `query` profile; HEAD unmoved, copy clean, no commit. Pages carrying each coined key as a tag: 0, 0, 0; the parent's description differs from the old one |
| E5 | 8 PASS | 3 children, 313 pages; every line pair parent to child; the registry diff removes 5 lines, all the parent's, and adds the 3 sections in order; warnings: none (no promoted shelf is the misfiling one); nothing written |
| E6 | 19 PASS | **68.8 s on the server** for 311 pages; ONE commit (`3a5a444`) of 313 files: registry, index, 311 pages; 1244 changed lines, every one `domain:` or `updated:`; `content_updated:` untouched; the locked page skipped `busy`, the hand-moved one `moved`; all 311 read back; the children directly after the parent, every other registry section byte-identical; the index states and lists 58, 160, 93; tag-mirroring 0 to 0, the standing list otherwise unchanged; `fsck` 0; Graph 58, 160, 93; the Library places 3 of 3; the Catalog lists 58 rows. The proposal afterwards: 4 shelves over 225 pages, none holding a moved page; the left shelf's fingerprint holds and it has no card (3 cards); the deferred shelf returns as a shelf of 52 holding 52 of its 67 pages, fingerprint changed |
| E7 | 5 PASS | remainder 1 (the busy page); re-filed through the panel: one commit (`04a9606`) of exactly that page and the index; remainder 0, the split holds both commits; the hand-moved page not remainder |
| E8 | 3 PASS, 1 FAIL, then 2 PASS | the upload accepted, no duplicate; **during the run the remainder re-file answered 409 `run-active`**; the job `done`, **$3.58**. The FAIL was the script's (below); re-read with `--job`: the commit (`9a12c49`) has 15 files and creates **2 knowledge pages, both carrying the CHILD key** of the largest promoted shelf, 0 the parent's. No existing page's `domain:` changed |
| E9 | 9 PASS | the revert refused with 409 `orphans`, naming exactly the 2 pages of E8; the E8 job reverted; then the split: its 2 commits newest first, then the index; the record marked reverted; after the hand move's own revert, `git diff` against the tree before E6 is empty outside the 5 files left alone by design (index, log, overview, hot cache, address counter); the proposal is E3's again, sizes and fingerprints |
| E10, flag off | 15 PASS | `health.fellows` the boolean `false`; the walk passes with 7 cards and 1 left (E4's leave); a promote opens the surface; 0 of 116 responses 404; 0 requests to a Fellow route |
| E10, demo | 11 PASS | `demoMode` true; 7 of 7 split writes answer 403 `demo_read_only`; the Graph and Catalog walk pass; System stays switched off, and with it every split control, so "disabled rather than hidden" has nothing to show in the demo; 0 of 125 responses 404 |
| E11 | 4 PASS | the live vault's HEAD equals E0's and is clean; the live jobs equal E0's; the live UI's 2 assets answer 200; `curious.service` still the process started at 08:53 |
| E12 | PASS | the instance stopped by pid (environ `PORT=8435`, comm `node`); the worktree removed after these results were recorded; the copy stays until the user agrees |

`npm run permprobe` against the COPY (8.3), not the live vault: `canary outside vault: blocked`,
`canary in skills/: blocked`, the expand probe PASS; the copy's HEAD unmoved and clean after it.

The copy's HEAD moved only by the stages' own commits: E6 the hand move and the split, E7 the
re-file, E8 the ingest, E9 two reverts, the index re-render, the job's revert and the hand move's.

**Three findings, none touching D1 to D18.**

1. **E8's first read was the script's race, not the product's.** A job reads `done` a moment
   before the queue commits and stores its hash; the script read it in that moment and saw no
   pages. It now waits for the hash; the job was re-read with `--job`, not paid for twice.
2. **E8 cost $3.58**, against the plan's estimate of $1 to $2 (49 turns for one PDF).
3. **An apply takes about a minute per 300 pages**, spent in the vault's lock script (phase 5).

A development loop ran before this (tsx instance on the Gate A copy, Vite with a proxy, keys typed
by hand, no paid stage). It found the lock and validation findings of phase 5 and the D15 finding
of phase 6, and the script corrections above; that copy was deleted before this run's fresh E0.

---

## Phase 8: acceptance and documentation

Nothing of this branch merges before this: phase 8 is the gate of the one merge.

- [x] **8.1** `npm test`, `npm run typecheck`, `npm run lint`: green and exit 0, the file and test
      counts recorded.
      **2026-09-23, branch tip:** server 123 files, 2082 tests; web 69 files, 745 tests; all three
      exit 0. New since Gate A: 2 server files (`domain-split-write`, `split-naming`) and 1 web
      file (`splitDecisions`), plus tests added to `domains`, `domain-split-route`,
      `agents-flag-off`, `wiki-lock` and `maintenanceStatus`.
- [x] **8.2** Phase 7 complete: every stage PASS, or its failure written up above with the fix.
      **Complete.** One FAIL (E8's first read), the script's, written up with its fix; every other
      check PASS.
- [x] **8.3** `npm run permprobe`: the naming pass adds a run kind on existing permission wiring
      (the `query` profile), so this is a check rather than a fix. Expect `canary outside vault:
      blocked`.
      **`canary outside vault: blocked`**, run against the E2E copy (the probe runs a real agent
      and aims a canary at the vault it is given; `~/vault` is written by nothing in this work).
- [x] **8.4** `scripts/vault-name-scan.mjs --diff main` over the branch and `--file` over the PR
      body; strings and fixtures read by eye.
      **Clean.** `--diff main`: nothing matched over 2336 terms; `--file` over the task file,
      `docs/API.md`, `CHANGELOG.md` and a drafted merge text: nothing matched. By hand, against
      147 terms the scan cannot know (every registry key of the copy, its tag hints, the three
      coined keys, the original proposal's tags and landmark titles): the one real hit was the new
      split cases in `domains.test.ts` and `splitDecisions.test.ts`, which named children and tags
      a real vault carries; they were made synthetic (`test: synthetic names …`). What remains are
      two keys of the registry fixture already on `main`, in that same file, because the cases run
      against it.
- [x] **8.5** Docs owed: `docs/API.md` (every new route), `CHANGELOG.md` (the milestone-A entry
      grows into the feature's one entry), SPEC.md §12.4 stage 4 with both parts (appendix A),
      CLAUDE.md's writer table (appendix B), the seed's conventions (4.5). SPEC.md and CLAUDE.md
      only on the user's word.
      **Written:** `docs/API.md` (every new route), `CHANGELOG.md` (one entry for the feature,
      still dated `2026-09-xx`), the seed's conventions (4.5). **Ready, waiting for the user's
      word:** SPEC.md §12.4 stage 4, both parts (appendix A, part two aligned with what was built:
      the revert re-renders the index; leave and defer), and the CLAUDE.md writer row with the note
      on the hubs row (appendix B). **Applied 2026-09-23 on the user's word**, both appendices as
      they stand, with the merge; SPEC.md's route listing names the new routes too.
- [ ] **8.6** The user amends the installed registry's conventions by hand in the page editor:
      the one sentence of 4.5.
- [ ] **8.7** Not part of this work, and written down so it is not mistaken for it: the first real
      split of `~/vault` is the user's own act, after the merge and after the live instance has
      been rebuilt and restarted by its documented procedure. Before it, `node
      scripts/vault-audit.mjs ~/vault --json` is saved; after it, the same is diffed against it,
      and the commit hash is recorded here. After that split the Shelves overlay (3.2) is
      re-evaluated, as decided on 2026-09-23: kept as a lens for large domains that were not
      split, or removed. It keeps no stored state, so removing it is cheap. The decision is
      written here.
      **Decided 2026-09-23, before the first real split: removed.** The user looked at it on the
      live instance and does not need it; the convex hulls of shelves interleaved in the layout
      read as overlapping shelves, which they never are. What stays of the view is the Catalog's
      shelf chips and the System panel.

---

## Appendix A: SPEC.md §12.4, stage 4 (draft)

Applied only on the user's word (CLAUDE.md: SPEC.md is not edited without being asked). Both
parts land together, with the one merge.

> **Meta categories, stage 4: splitting a domain (added 2026-09-xx).** Stages 2 and 3 grow a
> domain out of the unassigned pool. Stage 4 is the other direction: a domain that has outgrown
> being a shelf is split into peers.
>
> *Part one, the proposal.* `GET /api/v1/domains/:key/split` computes, deterministically and for
> free, the shelves a domain falls into: a consensus of 40 seeded Louvain runs (resolution 0.4)
> over the domain's knowledge pages and the links among them, in which a link is stable when its
> two ends share a cluster in 90 % of the runs, and the shelves are the connected groups of stable
> links with 25 pages or more. Smaller groups stay with the domain. Each shelf carries its evidence
> (size, conductance, stability, tag precision and recall, landmarks, distinctive tags without the
> entity-shaped ones, the tag-collision cost of a key) and is ranked by separability. A domain
> under 50 knowledge pages is not offered a split. The Catalog narrows to a proposed shelf,
> System shows the proposal, and the status model recommends it when
> one domain holds a quarter of the knowledge pages. Nothing is written.
>
> *Part two, the write.* The user promotes, merges, leaves or defers shelves and names each
> promoted one; a key is coined, never copied from a frequent tag. An optional read-only agent
> pass (`split-naming`, `query` profile) drafts names and descriptions. The apply writes ONE
> commit: the parent's registry section, narrowed so it no longer claims what left it; the new
> sections, directly after it; the `domain:` field of exactly the approved pages, identified by
> address and each only while it still carries the parent key; and `wiki/index.md`. It stamps
> `updated:`, never `content_updated:`. It refuses while an agent run writes and while auto-commit
> is off. Pages that did not move form a visible remainder with its own re-file. A revert reverts
> the split's own commits newest first, re-renders the index, and refuses while other pages carry
> its keys. A left shelf is remembered by its fingerprint and not proposed again while that holds;
> a deferred one comes back at the next guided maintenance run. The registry conventions
> gain one sentence: altitude is judged against the vault's volume, and a domain that outgrows a
> shelf is split into peers, the part that stays keeping the old key with a narrowed description.

## Appendix B: the writer table row (draft for CLAUDE.md, hard rule 1)

| Writer | What it writes | Lock | Since |
|---|---|---|---|
| `pipeline/domain-split-write.ts` | a domain split: the parent's registry section and the new sections inserted after it, the `domain:` field of exactly the approved pages, and `wiki/index.md`, in ONE commit (`POST /api/v1/domains/:key/split/apply`); the remainder re-file is the same write over the pages still in the parent (`POST /api/v1/domains/splits/:id/remainder`) | itself (`withWikiLocks`), registered with `RunRegistry` while it writes | at the merge |

With one sentence under the table: the registry now has two writers, `api/routes/domains.ts`
(append) and the split writer (narrow and insert), both under the registry's own per-file lock.

And the note on the hubs row (5.8), appended to its "What it writes" cell:

> Since the domain split, `renderIndex` has a caller that is not a run: the split writer renders
> `wiki/index.md` into its own commit, under the index's per-file lock, which it takes itself -
> the one place the index is written by a user action rather than a run's commit. A split's
> revert re-renders it once more in a commit of its own, because `revertCommit` leaves the hubs
> alone.

Measured facts for the row, from phase 7: one apply of 311 pages is one commit of 313 files and
takes about 69 s, almost all of it the vault's lock script run twice per page.

## Appendix C: the API

```
GET    /api/v1/domains/:key/split                          the proposal, read-only, memoised per graph
POST   /api/v1/domains/:key/split/naming                   start the read-only naming pass
POST   /api/v1/domains/:key/split/plan                     dry run of a decision set, writes nothing
POST   /api/v1/domains/:key/split/apply                    the one-commit split
POST   /api/v1/domains/:key/split/decisions                leave or defer a shelf, by fingerprint
DELETE /api/v1/domains/:key/split/decisions/:fingerprint   restore it
GET    /api/v1/domains/splits                              applied splits, commits, live remainder
POST   /api/v1/domains/splits/:id/remainder                re-file what did not move
POST   /api/v1/domains/splits/:id/revert                   revert the split's commits, newest first
```

All of it ships with the one merge. Every route is base product and joins the
`UNGATED` group of `server/test/agents-flag-off.test.ts`; every POST and DELETE is refused in demo
mode by the existing hook.
