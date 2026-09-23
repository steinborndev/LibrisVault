# Analysis: splitting an oversized domain (2026-09-22, reviewed 2026-09-23)

**The implementation plan built from this analysis is `docs/tasks/TASKS-DOMAIN-SPLIT.md`.** It
states the decisions below as final (with the Review's recommendations adopted), and its phases
replace the chunks sketched here. This file stays as the record of the measurements and the
reasoning.

The registry (SPEC.md §12.4, stages 2 and 3) knows one direction of change: a domain is BORN
from pages that fit nothing, by a human appending a section to `wiki/meta/domains.md`. It knows
nothing about a domain that has grown past being a shelf. On the live vault the largest domain
now holds 537 of 1322 knowledge pages, 41 % of everything the vault knows, against 152 for the
second largest. Filtering the Graph or the Catalog by it narrows nothing, its Library shelf
stands for two fifths of the building, and a Fellow homed there has no scope worth the name.

**This document is analysis and design. Nothing here is built.** It says what the vault
measured, what the codebase already gives, and what the feature would be if it were built.

**Reviewed end to end on 2026-09-23; read the Review at the end before the decisions.** Plain
errors of fact are corrected where they stood. The design decisions are left as first proposed,
and where the review recommends replacing one, it says which and why. Two of its findings are
contradictions inside this design and need a decision before anything is built.

The related work is `docs/tasks/TASKS-LANDMARKS.md`, which answered the neighbouring question
(where do I START in a domain this big) with a paint mask and no write. This one asks whether
the domain should be that big at all, and it cannot avoid a write.


## What the vault measured (2026-09-22, live vault: 1370 pages, 1322 knowledge, 13541 links)

Measured against the live graph payload (`GET /api/v1/graph`) with a throwaway script. The
script is throwaway; the numbers are the record, and four of them decide the design.

| Measured | Result | What it decides |
|---|---|---|
| Domain sizes | 537, then 152, 150, 82, 78, 68, then 16 domains at 47 or fewer | One domain is the problem; a feature for "domains in general" would have one user |
| The domain's own subgraph | 537 pages, 3473 links inside, 2374 leaving | Dense enough that link structure is real evidence, not noise |
| Louvain over that subgraph, resolution sweep 1.5 to 0.25 | k falls 20 → 7, modularity 0.752 → 0.676, links cut 17.4 % → 6.0 % | There is no single right k; the sweep IS the proposal |
| Stable cores (same cluster at EVERY resolution in the sweep) | 20 cores covering 494 of 537; 43 pages move around. Measured with ONE node order per rung, which conflates resolution with ordering luck; the Review re-measures it as a consensus | The structure is real, and the tool can say which pages are borderline |
| The partition at γ = 0.4 | 10 clusters: 169, 70, 67, 51, 46, 44, 34, 28, 14, 14; 8.0 % of internal links cut | A split costs the vault 277 of 3473 links crossing a boundary |
| **The production clustering already in the browser, restricted to this domain** | **Identical partition (Rand 1.000), but only when run over every page including the system pages, a view the Graph never draws.** Default view (knowledge pages only): ARI 0.942. Graph filtered to the domain: ARI 0.625, 14 hulls | **The recommendation engine exists and is shipped; what it shows on screen depends on the view** |
| Clusters of 25 pages or more | 8, covering 509 of 537 | Eight plausible shelves, not two and not fifty |
| Leave-one-out prediction of a page's cluster from its TAGS alone | 398 of 497 = 80 %; 12 pages carry no usable tag | A fifth of the domain has tags that point at the wrong sibling |
| The tag-centric finder (`domain-candidates.ts`) pointed at the domain | 22 tags at 5 or more pages, and after its Jaccard 0.6 merge still 20 OVERLAPPING groups, top pair 0.89 | It cannot be reused: it returns a lattice where a split needs a partition |
| Naming each proposed shelf after its own dominant tag | 311 pages would then carry a tag equal to their own `domain:` | The validator's `tag-mirroring` rule (B6) would book 311 new findings and the mechanical repair would strip the evidence |
| Promoting the k largest clusters and leaving the rest in the parent | k=1: 41 % → 28 %. k=3: → 17 %. k=4: → 14 %, 357 pages moved, parent keeps 180 | Four is the knee; past it the parent is a rump and the gain is zero |


## What the codebase already gives

| Part | Where | What it covers of this feature |
|---|---|---|
| Deterministic multi-level Louvain, cross-domain edges down-weighted, clusters labelled by their most DISTINCTIVE tags | `web/src/lib/communities.ts` (236 lines, unit-tested) | The whole recommendation engine, including the labelling. Its partition of the domain depends on what else is in the input (see the Rand row above) |
| The registry: parse, validate a key, append a section, build the agent's system-prompt block | `server/src/pipeline/domains.ts` | Creating each new domain, unchanged |
| `POST /api/v1/domains`: append one section, one commit, exact pathspec, inside the commit mutex, under the vault's per-file lock | `server/src/api/routes/domains.ts` | The registry half of the write, unchanged. It would be called k times |
| Deterministic first-draft description from key plus member tags | `web/src/lib/domainDraft.ts` | The description floor, unchanged |
| Optional read-only agent judgement, parsed from the final message, no file written | `domain-review.ts` plus the `domain-review` run kind | The naming and description pass, with a different prompt |
| Plan / diff / apply / skip-if-busy, filtered to named pages, approval carries a content hash | `pipeline/repair.ts` plus `pipeline/defect-repair.ts` | The shape of the re-file write, almost exactly |
| Surgical frontmatter edit that changes one field and stamps `updated:` without `content_updated:` | `pipeline/page-dates.ts`, used by every repair pass | The edit itself |
| Per-domain authority ranking and reading order | `web/src/lib/landmarks.ts` | The evidence panel: what each proposed shelf is built around |
| Status model with what / why now / cost and three urgencies | `web/src/lib/maintenanceStatus.ts` | Where "one domain holds 41 % of the vault" becomes a due item |
| Dismissal memory, migration v5 | `db/domain-dismissals.ts` | Not reusable as is (it is keyed by candidate tag), but the pattern is |
| Room placement: a new domain auto-places into the last wing, a new wing when full (capacity 12) | `db/library.ts` `autoPlace` | Four new shelves place themselves; no work, but the room changes shape |

**What nothing gives.** There is no writer that changes `domain:` on a named set of pages, no
registry operation other than append (no rename, no merge, no retire), and no memory of a
decision about a cluster. Those three are the feature.


## Three findings that decide the design

**1. The recommendation engine already exists.** `detectClusters` runs at γ = 1 with
cross-domain edges at weight 0.25 over whatever node set the Graph screen currently shows, and
draws its hulls whenever the cluster toggle is on. Run over every page of the vault, system
pages included, it produces 9 clusters covering 523 of the domain's 537 pages, 8 of them at
96 % purity or better, and its partition of that domain is IDENTICAL (Rand 1.000) to a
domain-local Louvain at γ = 0.4. So the feature does not need a new algorithm or an embedding.
**It is, however, not on screen as first claimed here** (corrected 2026-09-23): the Graph hides
system pages by default, and there the partition already differs (ARI 0.942); filtered to the
domain, which is how anyone would look at it, the screen draws 14 hulls against the proposal's
10 (ARI 0.625). The engine is reusable; its input has to be fixed by the proposal, not by the
view, and the proposal screen has to draw its own partition.

**2. The existing candidate finder cannot be pointed at a domain.** It was built for a pool of
pages that have no home, where the answer is one theme at a time and overlap between themes is
harmless. Inside a domain the answer has to be a PARTITION: every page goes to exactly one
shelf. Pointed at the domain it returns 20 groups after its own merge step, with the top pair
overlapping at 0.89 and several groups nested inside others. That is the right answer to its own
question and the wrong shape for this one. It stays where it is and is not extended.

**3. Naming a shelf after its dominant tag manufactures 311 defects.** The cluster labeller
returns the most distinctive tags, and the obvious move is to use the first of them as the
registry key. Validator rule `tag-mirroring` (B6) flags a tag that repeats the page's own `domain:`, and
`tag-mirror` is one of the four passes the dashboard can now apply mechanically. Naming the
eight proposed shelves after their own top tags would put 311 pages in that state at once, and
the repair would then strip exactly the tags the cluster was recognised by. Worse, two of the
eight top tags are not distinctive at all outside their cluster (one appears 97 times elsewhere
in the vault against 27 inside). So the key is COINED, never copied, and the proposal screen
must show, per candidate key, how many pages in the shelf and how many elsewhere carry it as a
tag.


## The design

Three surfaces, in the order a user meets them.

### 1. The proposal: `GET /api/v1/domains/:key/split`

Deterministic, free, read-only, recomputed on every call, and available for any domain (a small
one simply returns "not worth splitting" with its reason). It:

- takes the domain's knowledge pages and the links among them from `graph.build()`;
- runs the Louvain sweep over that subgraph at a fixed ladder of resolutions and returns the
  LEVEL whose cluster count lands in the shelf range, plus the neighbouring levels so the user
  can go coarser or finer without another round trip;
- drops clusters under the shelf minimum; their pages stay with the parent and are reported as
  such, not silently swallowed;
- labels each surviving cluster with `topDistinct`, exactly as the hulls do;
- computes per cluster: page count, types breakdown, conductance (share of its links that leave
  it), stability (in how many levels of the sweep this cluster survives essentially unchanged),
  its landmark pages (the top backlinked pages inside it, which is what a description gets
  written from), the tag-mirror cost of each candidate key, and how many members the same
  community holds OUTSIDE this domain;
- computes for the whole proposal: pages moved, pages the parent keeps, links that would turn
  cross-domain, and the vault's largest-domain share before and after;
- computes the confusion pairs: for each pair of proposed shelves, how often a page of one is
  predicted into the other from tags alone. Those pairs are where the two descriptions have to
  draw the line, because that prompt is all a later ingest gets.

### 2. The decision: a wizard step, not a card

It belongs in the guided maintenance run (SPEC.md §12.7) as a decision step, beside the domain
decisions that already live there, because it has the same shape: the system proposes, the user
curates, nothing runs without a click. Per proposed shelf the user does one of three things:
**promote** (gets a key, a description and tags, and becomes a registry row), **leave** (stays
with the parent, remembered so the next proposal does not ask again), or **defer**.

Promoting asks for the one thing the machine cannot do well: the key and the description. The
draft is filled deterministically (`draftDomainDescription`, plus the landmark pages as the
evidence beside the field) and an optional read-only agent pass, a second prompt for the
existing `domain-review` run kind, replaces the draft with something better and proposes a key
that is NOT one of the shelf's own frequent tags. The agent never writes anything here, for the
reason stage 3 already gives: new keys come from humans.

The step refuses to promote a shelf whose key collides with a frequent tag without the user
seeing that number, and refuses a proposal that would leave the parent below the shelf minimum
without saying so. Neither is a block; both are a sentence the user reads before clicking.

### 3. The write: two commits, both deterministic

**Commit one, per promoted shelf: the registry row.** `POST /api/v1/domains`, unchanged, as it
stands today. k promotions are k commits, each independently revertable, exactly as one domain
creation is today.

**Commit two: the re-file.** A new deterministic pass in the existing plan/apply shape. It takes
a list of `{ path, domain }` pairs, changes the `domain:` field of those pages and nothing else,
stamps `updated:` and NOT `content_updated:` (§12.13: the file changed, the page says the same
thing), takes the vault's per-file locks for the pages it writes, and commits once behind the
shared mutex with an exact pathspec. Skips a page whose lock is held rather than waiting, and
reports the skip. Approval carries a hash of the assignment it was shown, the same carry-forward
`defect-repair.ts` uses, so a proposal the user approved cannot be applied against a vault that
has moved on. One commit for the whole re-file, because it is one decision, and the diff is
one line per page.

It does NOT go through an agent run, and this is a decision with a reason. A `domain-backfill`
IS the agent path and it exists, but it re-derives every page's domain by reading it, which on
537 pages is a long expensive run whose output nobody can check line by line, and it would be
asked to reproduce a decision that has already been made deterministically. The assignment is
already computed and already displayed; sending it to an agent to be guessed at again would
replace a verifiable write with an unverifiable one. This is the same argument
`cli/vaultrepair.ts` and `defect-repair.ts` already won for the repair passes.

**It adds a row to hard rule 1's writer table** before it ships, as every writer must:
pipeline code, one field of the named pages, its own lock, its own commit.


## Decisions, with the reasoning

**The clustering moves to the server; the browser keeps its copy.** The proposal has to be
recomputed server-side at apply time, for the reason stage 3 already states about candidates: a
stale browser tab must not be able to start a write against a vault that has changed. But the
hull lens is a client-side toggle with no round trip and must stay one. So `louvainCommunities`
is ported to `server/src/pipeline/communities.ts`, both copies are pinned by one shared graph
fixture asserted in both test suites, and the duplication is documented rather than hidden. The
repo already hand-mirrors the API types with the same trade-off written down in
`web/src/api/types.ts`.

**The sweep, not one resolution.** Modularity peaks near γ = 1 and the peak is flat (0.758 at
γ = 1, 0.750 at 0.8, 0.729 at 0.6), so optimising it picks 14 shelves where a human wants four.
The ladder is fixed, the default level is the one whose cluster count lands in range, and the
user can step coarser or finer. Stability across the ladder is reported per cluster, because a
cluster that survives the whole sweep is a shelf and one that appears at a single rung is an
artifact: 20 cores survive the whole sweep here, covering 494 of 537 pages.

**The shelf minimum is 25 pages**, the same number the Landmarks switch already uses for "a
domain this small is read whole". A candidate below it is not offered; its pages stay with the
parent. Using the same threshold for both keeps one number meaning one thing.

**The parent always survives, and a split promotes rather than partitions.** The operation is
"take these pages OUT of this domain", not "replace this domain with these". That keeps every
Fellow homed there still homed somewhere, keeps the parent's Library shelf standing, keeps the
registry append-only (which is the only registry operation that exists), and lets the user split
once, live with it, and split again. The measured knee is at four: the largest domain goes
41 % → 14 %, 357 pages move, 180 stay. Past four the parent becomes a rump for no further gain.

**A cluster is proposed, never applied, and a rejection is remembered.** The dismissal table is
keyed by candidate tag today, which cannot address a cluster. A cluster needs an identity stable
across rebuilds: its member set is not, but its top landmark pages are, so a rejected proposal is
remembered by the paths of its strongest pages plus its size band, and comes back only when the
cluster has genuinely changed. Without this the next maintenance run proposes the same four
shelves the user just said no to, which is exactly the loop stage 3 built dismissals for.

**Cross-domain members are shown, never moved.** One proposed shelf here shares its community
with 79 pages of other domains, another with 8. A split may only ever move pages that currently
carry the domain being split. Moving a page out of a domain the user did not open the screen for
would make a split an unbounded rewrite, and the number is worth showing precisely because it
is the honest warning that this shelf is not really a sub-shelf of this domain.

**The backfill still runs afterwards, and for one reason only**: pages carrying `unassigned`
may now fit a new domain. The re-file has already filed the pages the split names; the backfill
must not be sold as the mechanism that does the split, which is the mistake the current domain
card almost invites.

**Merge, rename and retire stay out of scope.** They are the inverse operations and each needs
its own registry mechanism (the registry has only append), its own handling of a key that pages
still carry, and its own answer for Fellows homed on a vanishing key. A split feature that
quietly introduced a registry rewrite would be two features in one commit.

**Not behind `AGENTS_ENABLED`.** It corrects the base product's own registry loop, and the
Library room reads domains rather than owning them. The flag-off behaviour must be identical
except that no room shelf appears, which it already is.


## What it costs, and what it risks

**Cost.** The proposal is free and deterministic. The optional naming pass is one read-only
agent run of the `domain-review` kind. The live run ledger holds one run of that kind at
$0.38, against a mean of $1.06 ($0.83 to $1.19) for three backfills (corrected 2026-09-23: the
first draft read another data directory), so the naming pass is the cheap half and the agent
backfill this design avoids is the expensive one. The write is k+1 commits and no
agent run at all.

**The risks, in the order they would bite.**

1. **A fifth of the domain has tags that point at the wrong sibling** (80 % leave-one-out
   accuracy). The ingest agent reads the whole page, not just its tags, so 80 % is a floor and
   not a prediction, but it is the right order of magnitude for how often a new page will be
   filed into a sibling shelf. The mitigation is the confusion-pair report: the pairs that
   confuse are known BEFORE the descriptions are written, and the descriptions are the only
   thing a later ingest gets.
2. **The registry prompt grows.** Every writing run carries the full registry in its system
   prompt. Measured 2026-09-23: 5941 characters for 21 entries, about 231 per entry, so four
   more domains add roughly 920 characters to every writing run. That is small; the first
   draft overstated it as a reason to prefer four shelves over eight.
3. **Eight sibling shelves in one subject are a classification problem the user then owns.**
   Every subsequent ingest has to be filed among them. This is the argument for the knee rather
   than the full partition, and it is why the residue staying with the parent is a feature: a
   page that fits none of the promoted shelves has an honest home.
4. **`shelf_order`, Fellow home domains, and room placement all key on the domain string.** None
   breaks (the parent key survives), but four new shelves auto-place into the last wing and may
   open a new one, and a Fellow homed on the parent silently loses two thirds of its scope
   without anything telling it so. The split screen should say which Fellows are homed on the
   domain and what each would keep. On the live vault no active Fellow is homed there today
   (two retired ones were), so this bites on a revival rather than on the split itself.
5. **A split is only revertable one commit at a time.** The re-file is one commit and reverts
   cleanly; the registry rows are k more. There is no "undo the split" button and there should
   not be one, but the summary has to name the commits in the order they would be reverted.


## If it were built: chunks

1. **The engine.** Port Louvain to the server, add the per-domain sweep, the cluster metrics
   (conductance, stability, landmarks, tag-mirror cost, foreign members), and the proposal
   totals. Pure functions, no route. Criterion: on the committed graph fixture, the server's
   partition equals the browser's, and the sweep's default level lands in the shelf range.
2. **The route.** `GET /api/v1/domains/:key/split`, recomputed per call, with the "not worth
   splitting" answer for a small domain. Criterion: the live oversized domain returns the eight
   clusters and the totals above; a 40-page domain returns the refusal with its reason.
3. **The proposal screen.** The decision step: cluster cards with evidence, the promote / leave /
   defer control, the key-collision and confusion-pair warnings, the before-and-after figures.
   Criterion: the screen draws the proposal's own partition, handed to `GraphCanvas` through its
   `clusters` and `clusterLabels` props, and every number on a card matches the route's. (The
   first draft asked it to match the Graph's hulls, which differ by view; see finding 1.)
4. **The re-file pass.** The deterministic writer, plan / diff / apply, hash-carried approval,
   per-file locks, one commit, `content_updated:` untouched. Criterion: a dry run over the real
   assignment changes exactly one line per page, and hard rule 1's table has its new row.
5. **The memory and the status item.** Rejection memory keyed on landmark paths, and the status
   model's new item ("one domain holds N % of the vault"). Criterion: a rejected proposal does
   not come back on the next maintenance run.

Measurement before and after, as every vault-layer change gets: `node scripts/vault-audit.mjs`,
diffed against the run taken immediately before the first re-file.


## Open questions

1. **Is four the right answer for this vault, or is one?** (Superseded by the Review, R10: the
   knee was measured in size order over single-run clusters.) The knee says four. Promoting only
   the largest cluster already takes the domain from 41 % to 28 % and moves 169 pages instead of
   357. A smaller first split is cheaper to judge and leaves the rest of the evidence intact for
   a second pass. This is a user decision the numbers inform but do not make.
2. **Should the proposal be offered for every domain or only past a size?** Offering it
   everywhere invites splitting a 40-page domain, which the registry's own conventions call a
   tag rather than a domain. The Landmarks switch answers the same question with a threshold and
   a reason text, which is probably the precedent to follow.
3. **Does the re-file belong to the `repair` pass family or beside it?** It shares the whole
   mechanism (plan, diff, apply, lock, skip, hash) and shares nothing of the trigger: a repair
   fixes a defect the validator found, a re-file executes a decision the user made. Putting it
   in `RULE_PASSES` would make it reachable from the standing defect list, which it must not be.


## Review, 2026-09-23

Re-measured against the same live graph (1370 pages, 13541 links, unchanged since the first
measurement) and read against the code paths the write would touch. Thirteen findings, in the
order they would hurt. R1 and R2 are contradictions inside the design above; R3 to R9 are gaps
that would make the built feature fail in use; R10 to R13 improve it. The scripts are throwaway
again; the numbers are the record.

### What the re-measurement found

| Measured | Result | What it changes |
|---|---|---|
| Same vault, same γ, only the NODE ORDER shuffled (20 runs) | Median 4.8 % of pages on another shelf, worst 24 %; 9 to 11 clusters | "Deterministic" in `communities.ts` means same input order, same output. It does not mean stable |
| The vault three days earlier (33 pages fewer), one run each | 4.6 % of the pages both have on another shelf; k 10 → 9 | A proposal approved on Monday is a different proposal on Thursday |
| **Consensus: 40 seeded orders at γ = 0.4, pages together in 90 % of runs or more** | **8 shelves (161, 66, 59, 49, 44, 34, 30, 28), 66 pages with the parent. Another seed: 0.2 % move. Three days earlier: 0.2 % move** | **The engine to build** |
| The 66 pages the consensus leaves with the parent | 43 of them link into no shelf at all: they are the coherent clusters under 25 pages. 18 are entities, 21 % of the domain's entities | The residue is principled, not a leftover |
| The parent's own registry row | Its description's examples are the largest shelf's subject; 5 of the 8 shelves have a defining tag the parent's tag hints still claim (the largest: 3 of its top 4) | Children appended beside an unchanged parent compete with it for every new page |
| Adjacent rungs of the resolution ladder | 1 to 4 clusters per step do not sit inside one coarser cluster; 14 to 27 pages move sideways | A γ stepper does not just merge, it reshuffles |
| Per-shelf quality, consensus shelves | Conductance 0.04 to 0.12. Tag precision (how rarely OTHER shelves' pages look like this one) 43 to 100 % | Size is the wrong order to promote in |
| `wiki/index.md` | Grouped by domain (`hubs.ts`); regenerated by agent runs and by `cli/vaultrepair.ts`, NOT by the dashboard's repair path | A re-file alone leaves 300 or more index lines under the wrong heading |
| Pages of the domain created or rewritten in three days | 33 of 537 (6 %) | A per-page content hash would void about 6 % of a two-day-old approval |
| `address:` coverage in the domain | 537 of 537 | Approval and memory can key on addresses and survive renames |
| Who can write while a split applies | `RunRegistry` counts ingest AND maintenance runs; the maintenance `runMutex` is private to maintenance and does not cover ingests | "Take the run mutex" is not available as an answer |

### Contradictions inside the design

**R1. The parent must be narrowed in the same write, or the split undoes itself.** The design
keeps the parent's registry row as it is and declares the registry append-only. But that row's
description and tag hints still claim what five of the eight shelves are about, and the ingest
prompt lists domains in registry order, so every new page on those subjects would meet the broad
parent first and the specific child twenty entries later. The parent would re-grow and the new
shelves would starve. **Recommendation:** the split rewrites the parent's section (a description
that says what the children took, tag hints minus the moved tags) and inserts the children
directly after it, so siblings stand together in the prompt. That needs the registry operation
the first draft ruled out: a `replaceDomainSection` beside `appendDomainSection`, pure and tested
the same way. "The registry stays append-only" is withdrawn for this writer. Merge, rename and
retire stay out of scope; narrowing is not one of them.

**R2. The registry's own altitude rule forbids the result as designed.** The registry conventions
say keys sit at a comparable altitude and "if one key would sit inside another, it is a tag, not
a domain". With the parent surviving unchanged, every child sits inside it. There are two
consistent answers and the user has to pick one:

- **(a) Flat, with the convention amended.** R1 narrows the parent until it is a PEER of its
  children, and the conventions gain one sentence: altitude is judged against the vault's
  volume, and a domain that outgrows a shelf is split into peers. Nothing in code changes for
  this; the registry page's text and the seed do.
- **(b) Nested.** A second level (child sections under a parent, or a `parent:` line), pages
  keep `domain:` and gain a child key. Every consumer of `domain:` has to learn it: the graph,
  the Catalog, the Library, the Fellows, the hubs, the validator, and the ingest and backfill
  prompts. Nothing in the measured problem (a filter that narrows nothing, a shelf that is two
  fifths of the room, a Fellow without a scope) needs two levels.

**Recommendation: (a).** This is the decision to take before anything else is built.

### Gaps that would make the built feature fail in use

**R3. Consensus, not one run.** One Louvain run moves a median 5 % of pages on node order alone,
so the proposal flickers, the rejection memory cannot recognise a cluster it saw last week, and
an approval would not survive the next ingest. Run it N times over seeded permutations of the
node order and keep the pages that land together in 90 % of runs or more; the connected pieces
of that relation are the shelves. Forty runs over 537 pages cost milliseconds. Stability becomes
0.2 %, and the borderline pages get a principled home: the parent. The first draft's "20 stable
cores" figure is replaced by this.

**R4. Draw the proposal; do not point at the hulls.** Finding 1 is corrected above: the Graph's
hulls follow the view, and filtered to the domain they show 14 clusters against the proposal's
8 shelves. The proposal screen hands the consensus partition to `GraphCanvas`, whose `clusters`
and `clusterLabels` props already take any partition. Chunk 3's criterion is corrected above.

**R5. One commit for the whole split.** The design writes k registry commits and one re-file
commit, "each independently revertable". That independence is the defect: reverting one registry
row leaves every page carrying a key the ingest prompt no longer lists, reverting the re-file
alone leaves empty domains, and a crash between commits leaves half a split. A split is one
decision: the registry edit (R1), every re-filed page and the index (R6) go into ONE commit, and
one revert undoes it completely. `POST /api/v1/domains` stays exactly as it is for creating a
single domain.

**R6. Regenerate the index inside that commit.** The dashboard's repair path never regenerates
the hubs, which is harmless for a dropped tag and wrong for a moved domain. The split calls
`renderIndex` inside its commit, as `cli/vaultrepair.ts` already does, and takes the index's lock
together with the pages' locks, outside the commit mutex. The hub writer's row in hard rule 1's
table gains a caller.

**R7. Approve pages, not a recomputation, and check the field, not the content.** The first draft
recomputes the proposal at apply time and carries a hash of the assignment; after any ingest the
recomputation differs and the approval is void. Instead the approval IS the list the user saw,
as `{ address, from, to }`. The apply re-clusters nothing: per page it checks that the address
still resolves and that `domain:` still equals the parent key, which is exactly what the user
approved. `defect-repair.ts`'s per-page content hash is the wrong precondition for this writer:
the diff is one line, and about 6 % of the domain's pages change in three days for reasons that
do not touch it.

**R8. Refuse while an agent run is in flight, and read back afterwards.** The vault's per-file
lock covers a write, not an agent's read-modify-write across a session: an ingest that read a
page before the split and writes it after puts the parent key back, silently. The maintenance
`runMutex` does not cover ingests, so it is no answer. `RunRegistry` counts every writing run;
the apply refuses while that count is above zero (the wizard offers to retry), and after its
commit it reads every re-filed page back and reports any that lost the new key.

**R9. A remainder path.** Pages skipped because they were busy, changed or overwritten stay in
the parent, and the backfill will never move them, because its prompt keeps any page that already
has a real domain. The proposal screen therefore shows, per promoted shelf, how many of its pages
are still in the parent, and offers to re-file exactly those.

### Improvements

**R10. Rank the shelves by separability; withdraw the knee.** Per consensus shelf, conductance
runs from 0.04 to 0.12 and tag precision from 43 to 100 %. The 34-page shelf is the clearest
warning: other shelves' pages resemble it by their tags more often than its own do, which makes
it a misfiling magnet for every later ingest. The 59-page shelf is the clearest case for
promotion (0.04, 100 %). The screen ranks by a stated composite of self-containment and
separability, shows both numbers, and puts size third. "The knee is at four" was measured in size
order over single-run clusters and is withdrawn.

**R11. Replace the resolution stepper with a merge.** Adjacent rungs of the ladder are not nested,
so stepping coarser moves 14 to 27 pages sideways, which reads as noise. A "merge these two
shelves" control over consensus shelves is nested by construction and answers the same wish. The
ladder stays inside the engine.

**R12. Keep entity-shaped tags out of the proposed tag hints.** `topDistinct` relies on
ubiquity to push structural tags down, and in the shelf that is half entities (14 of 28) an
entity-shaped tag ranks among its four most distinctive. The registry forbids classifying by those.
Export `STRUCTURAL_TAGS` from `domain-candidates.ts` and filter with it.

**R13. Ship the proposal as a view before the write.** Chunks 1 to 3 without the apply give a
read-only sub-filter: the Graph and the Catalog can narrow to a proposed shelf. That delivers most
of the navigation benefit (a filter that narrows, a subgraph small enough to read) with no vault
write, and a week of using the shelves is the best test of whether their descriptions will hold
before 300 or more pages move. The write becomes the second milestone, not the fourth chunk of
the first.

### What stands

The deterministic re-file over an agent backfill; the key coined, never copied (311 findings
otherwise); the parent survives; members outside the domain shown and never moved; not behind
`AGENTS_ENABLED`; the decision as a step in the guided maintenance run.

### Side finding, not this feature

The Graph's hull lens has the same order sensitivity, so a page's hull can change after an
unrelated ingest. There it is cosmetic, and a consensus would multiply the browser's cost per
recompute. Noted, not recommended.

### Open questions after the review

1. **R2: flat with the convention amended, or nested?** Recommendation: flat.
2. **Which shelves first?** The ranking of R10 puts the 59-page shelf first; the 161-page shelf
   is the one that changes the vault's balance most (41 % → 28 % on its own, 376 pages left). One of them, or
   both, for the first split?
3. **Is the view (R13) enough for a while?** If the sub-filter answers the everyday complaint,
   the write can wait until an ingest actually misfiles.
