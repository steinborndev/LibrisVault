# Tasks: Landmarks, an entry point into a large domain (2026-09-21)

A fourth overlay for the Graph screen (SPEC.md §12.4). Filtered to one large domain, the
graph is a field of several hundred points with no stated place to begin. Landmarks draws
only the pages that domain is built around, together with what connects them, and puts a
reading order beside the picture. Everything else comes back one page at a time, on a click.

Nothing here is a new subsystem, and nothing here is a filter either: it is a PAINT mask over
the subgraph the screen already draws, computed in the browser. No route, no server change, no
vault write, not behind `AGENTS_ENABLED`. Painting rather than filtering is the load-bearing
choice and it has a decision of its own below; the first draft of this file assumed a filter
and promised what only a paint mask delivers, and half the decisions here lean on which of the
two it is.

## What the vault measured (2026-09-21, live vault: 1323 knowledge pages, 12300 links)

The design questions were settled against numbers rather than guesses. The script is
throwaway; the numbers are the record.

| Measured | Result | What it decided |
|---|---|---|
| Domain sizes | biomedicine 535, ai-tooling 152, ML 150, cooking 82, finance 78, materials 68, then 16 domains at 40 or fewer | Only one domain is genuinely hard, and half of them are small enough to read whole |
| Global top-k over everything | the top 2 % touches 5 of 22 domains | A global ranking is the biomedicine ranking; the mode is scoped to one domain |
| Top 40 of biomedicine, by links inside the domain | 3 components (36 + 3 + 1), weakest member still has 13 backlinks | The set is almost connected on its own, and the islands are real |
| Pages needed to join the chapters, under the rule "The islands" states | biomedicine 2, cooking 1, materials-science 1, battery-technology 1, the rest 0; finance stays in two pieces | Connectors are worth drawing and there are very few of them; where they do not help, that is a finding |
| Chapter shape of the set, per eligible domain | biomedicine 36 + 3 + 1, cooking 3 + 7, finance 7 + 2, materials-science 4 + 2 + 2, battery-technology 7 + 1, the other five one chapter | Chapters are a mid-size phenomenon, half the eligible domains simply get a list, and the first chapter is not always the biggest |
| Spine plus one hop, globally | 423 of 535 pages | A global "+1 hop" step is not a step, it is almost everything; expansion has to be per node |
| Neighbours of a landmark, inside the domain against over the whole vault | biomedicine median 22, p90 39, max 129 inside; 26, 47, 136 over the vault; all 40 above the cap of 12 either way | A bloom needs a cap, or one click undoes the mode - and the cap is the ordinary case, not an edge |
| Domains with 25 or more knowledge pages | 10 of 22 | The switch is unavailable in more than half the vault, which is what its reason text has to carry |
| In-degree counted inside the domain vs over the whole vault | biomedicine 38/40 identical, but small domains gain YouTube channels and, in machine-learning, an entity with 0 links inside the domain and 13 outside | Authority is counted inside the domain |
| Rank order vs a connected walk | 5 of 40 entries unconnected to anything read so far, against 2 of 40 | The list follows the walk |
| Node radius over the 40 landmarks of biomedicine | 8.4 to 12.0 px, five of them pinned at the cap; counting inside the domain instead moves a node by at most 0.6 px | Size is flat where it matters, and re-sourcing the number would not show, so inside the mode size says the role instead |

Re-measured 2026-09-22 against the live graph payload, under exactly the rules stated below,
and two rows moved. The connectors are 2 in biomedicine rather than 15: the old number counted
every page that touches two islands, while the rule below takes the fewest that join them, and
that count can never exceed one less than the number of chapters. And the neighbour spread is
wider than first recorded, in both of the two ways it can be counted. The rows about domain
sizes, the global top-k, the spine-plus-one-hop and the radius are unchanged.

## Decisions

**The set.** Only with exactly one domain on show. That is either one domain picked in the
chips or a room whose domain list holds exactly one page-group, which are `inDomainScope`'s two
ways of saying the same thing and are equally true on screen: a switch that told a reader to
filter to one domain while one domain is what they are looking at would not be followable. The
"no domain" pile is never it. It is the absence of a domain rather than one, its pages share no
subject, and "what is this built around" has no answer there to rank.

Size `clamp(round(n * 0.12), 8, 40)` over the domain's knowledge pages, ranked by backlinks
**from inside the same domain**. That is 40 for biomedicine, 18 for ai-tooling and
machine-learning, 10 for cooking, 9 for finance, 8 for everything smaller. Below 25 knowledge
pages in the domain the toggle is disabled and says why: a domain that small is read whole.

**What the set is computed over: the domain, not the drawing.** A type chip, a tag, the
system-page switch and the gaps overlay change what is on screen and change neither the set nor
its order; a search leaves the mode outright. The reason is that the list is a reading ORDER,
and an order that rearranged itself because somebody pressed a type chip would not be one.

It also leaves the type chips' own contract alone for free. The `keep`/`pool` pipeline's rule
is that every narrowing goes through `narrow()`, so a mask that went through it would make the
chips count landmarks instead of counting what the other filters leave. This mask does not go
through that pipeline at all, which is the subject of **Positions** below. Gap ghosts and
system pages therefore need no exclusion rule either: they are simply among the things the mode
paints out, and only knowledge pages of the domain are ever landmarks or connectors.

**Ties.** The rank and the walk break ties identically: domain-internal backlinks, then
backlinks over the whole vault, then the page's path. The middle term is a real signal and
costs nothing; the path makes the order total. Two builds over the same vault produce the same
list, which is what `communities.ts` and `graphReveal.ts` already promise and what chunk 1's
fixtures rest on.

**The order.** Strongest page first, then always the strongest page not yet listed that links
to or from something already listed, ties as above. Where nothing links any more, a new chapter
begins. Biomedicine comes out as 36 + 3 + 1, and the chapters are exactly the components of the
set, which is the honest name for what they are. The walk does **not** travel through connector
pages, although they are on screen: routing through them would hide the very split the chapters
report.

**The islands.** The non-landmark pages that join two chapters are drawn dim and unlabelled.
They are not list entries and carry no rank. The rule, stated so the count is reproducible and
the test can assert it: repeatedly take the non-landmark knowledge page of the domain that
touches the most chapters still separate from one another, break ties by domain-internal
backlinks and then by path, merge the chapters it touches, and stop when no remaining page
touches two. The loop needs no cap: each step merges at least two chapters, so it cannot run
longer than one step short of the chapter count, and biomedicine's three chapters close with
two pages. That is the whole set of connectors in the largest domain the vault has, which is
what makes drawing them dim and unlabelled right rather than wasteful - they are the glue, not
the entry points, and there are two of them.

Where nothing joins anything, nothing is added and the chapters stand apart, which is true of
the domain rather than of the drawing: finance's two chapters are joined by no page in the
domain, however long the loop runs.

**Expansion.** A click on a landmark shows its neighbours inside the domain, at most 12,
ordered by domain-internal backlinks with the same tie-break as the list. Inside the domain is
not a choice but the reach the screen has: the domain filter is a real filter upstream of this
mask, so a page of another domain is not in the drawing at all and cannot be revealed by
brightening it. The cap is the ordinary case and not an edge - every one of biomedicine's 40
landmarks has more than 12 neighbours in its own domain, median 22 - which is why the rest of
them needs a handle rather than a footnote.

That handle is a line in the list, not a control on the canvas: the bloomed landmark's entry
reads "12 of 22 shown, show all", and pressing it lifts the cap for that one bloom. The canvas
has no vocabulary for a control and would need a widget, a hit target and a place to put them;
the list is already the mode's text surface, and "12 of 22" is a number, which is the kind of
thing the list exists to say.

A second click on the landmark drops the bloom, lifted cap and all: one neighbourhood at a
time. Only a landmark expands; a click on a connector or on a neighbour that is already out
selects and opens it exactly as anywhere else on this screen. A bloom adds nothing to the graph the canvas
lays out - those neighbours were always in it and merely unpainted - so they appear where they
stand instead of arriving out of a re-settling layout. What a click does while the picture
is held is under **The lock** below.

**Positions.** Unchanged, and the mechanism is the decision, because the obvious implementation
does not deliver it. The mask does **not** narrow the `keep`/`pool` pipeline. Every page of the
domain stays in the node and edge arrays the canvas is handed; the non-landmarks are painted
with no alpha and the connectors dim. What that buys is the canvas's own structural-identity
check: an unchanged node list, edge list and domain grouping make the layout effect return
before it posts anything, so switching the overlay on or off posts no layout at all and costs
one redraw. It is also cheaper to draw than the view it replaces, because most nodes are
skipped early.

A `keep` mask would post one, and the result would not be subtle. The worker reheats at alpha
0.3 with `forceX(0)`, `forceY(0)` and `forceGroupSlot`, and the slots themselves are computed
from the group sizes, so dropping biomedicine from 535 drawn pages to 40 would pull the
survivors to a newly computed, much smaller slot and settle them there. The picture would
re-deal on every press of the switch and again on every bloom. "The same shape with most of it
taken away" is a sentence only a paint mask makes true.

Cost, named. The mode becomes a canvas concept rather than a filter, and roughly a dozen places
in `GraphCanvas.tsx` have to learn the difference between drawn and painted: the label budget
and `labelReps`, the label pass, hit-testing (an unpainted node is not clickable, so a click on
its position is a click on the background), the minimap, the hulls. That is local work in chunk
2 against a central promise this file would otherwise have to withdraw. If the difference fans
out further than chunk 2 can carry, the fallback is the `keep` mask and this decision is
rewritten to say the picture re-settles - it is a thing to decide, not to discover halfway.

**When the condition falls away.** A second domain picked, the chips cleared, a room turned:
the mode goes off, the bloom with it, and the list is gone. Not latent, not remembered. It
already turns three other modes off when it comes on, so it must not be the one that lives on
invisibly; and the way back is one press of a switch standing where it was.

**The list.** Right-hand column, where the explorer sits today. Clicking an entry or a node
replaces it with the page detail and a way back to the list, the pattern the Research screen
already uses for its ledgers. Up and down walk it; Enter needs no binding of its own, because
the list's selection IS the screen's selection, synced both ways with the canvas, and Enter
already opens that. The left and right keys stay with the domains.

A row is a number and a title, and nothing else. The number runs 1 to k unbroken across the
chapter rules, because the chapters are breaks in one list and not sections of several; and it
is there for the reading pass the lock describes, where you leave for a page and come back and
want to know where you were. No backlink count beside it: the rank is already stated by the
order, and a second number for the same thing is the mistake the size ramp is kept out of this
for. The bloomed landmark's row carries its handle line underneath, and the selected row is
marked, unless the lock has cleared the selection.

**The chapters in the list.** From the second chapter on, a thin rule with a caption that says
what the break means ("not linked to anything above · 3 pages"). The first gets nothing,
because it is simply the list. Deliberately not headings: biomedicine breaks into 36 + 3 + 1,
and a heading would give one left-over page the weight of thirty-six connected ones.

A domain whose set were nearly all single-page chapters would be a list of rules, and nothing
here guards against that. The worst measured case is finance: 9 entries, 3 chapters, 2 rules,
which reads fine. A threshold for a case nobody has seen is untested machinery in the name of a
guess, and it gets built when a domain shows it.

**The switch.** A fourth row in the Overlays block, beside Areas, Bridges and Spotlight,
disabled with its reason when no single domain is on show or the domain is under 25 knowledge
pages. In the default view it is therefore usually grey - 10 of 22 domains clear the bar at
all. That is the accepted cost of a switch that lives where its three siblings live, and the
reason text has to carry it, so the four states are written here rather than invented at the
keyboard:

- available: no reason, the switch is simply live
- nothing or several domains on show: "Filter to one domain to see where it begins."
- the unfiled pile on show: "Pages without a domain are not one."
- a domain under the bar: "Only 19 pages here, small enough to read whole." (the count is the
  domain's own)

**Against the other modes.** Turning it on turns off Spotlight, the cluster drill-down and the
local focus: three ways of making the graph smaller is two too many at once. Areas and Bridges
stay allowed, because they colour rather than reduce. A search leaves the mode.

**The lock.** The picture on screen, held (`graphFreeze.ts`, 2026-09-17). The two mechanisms
collide before they combine: while the lock is closed the right-hand column is not rendered at
all and one click on a node opens its page. Landmarks wants that column for its list and that
click for the bloom, and it is the one configuration on this screen whose whole value is the
order - a locked Landmarks picture unable to show its list would be the worst thing here rather
than the best.

The list is exempt from "the panel stays away", by the rule's own reason rather than by its
letter. `toggleFreeze` clears the selection because "a picture held as a reading list has no
page selected in it, and a ring left on one node would say otherwise", and that aims at the
SELECTION: the explorer is the detail of a selection, the list is part of the picture. Locking
therefore clears the ring and the list's highlight and leaves the list standing.

The click goes to the lock. With the picture held, every click opens a page, a landmark's
included: the bloom is an exploration gesture, and exploration is what was left behind when the
lock closed. Nothing new has to be written for the rest of it, because the expansion rule
already delegates - a connector or an already-bloomed neighbour "opens exactly as anywhere else
on this screen", and under the lock that is what anywhere else does. A bloom that was open when
the lock closed stays open and stays painted: closing it would be the lock altering the very
picture it claims to hold.

A click in the LIST opens the page too, rather than replacing the column with the page detail.
Unlocked, the detail and its way back are browsing; locked, leaving for the page and returning
to the held picture is a reading pass, and one rule then governs the canvas and the list alike.

What the record holds is the computed order, not merely the switch. `graphFreeze.ts` calls
itself a snapshot of "everything that decides which nodes are drawn and how", and in this mode
the SET is what decides it. `clusterStack` is the precedent: it stores a community's members as
paths although they are derived, because re-deriving them would put the reader somewhere else,
and a ranking is the same case and a more fragile one. Without it the **Live** decision above -
an ingest can reorder the list under the reader - would go on applying to the held picture,
which is the one thing the lock exists to prevent. A held landmark whose page is gone is simply
not painted and drops out of the list, the way a `clusterStack` path already behaves.

```
landmarks: {
  domain: string          // needed even so: with a single-domain room filtering, selectedDomains is empty
  order: string[]         // the landmark paths in reading order
  chapters: number[]      // start offsets into order; biomedicine is [0, 36, 39]
  connectors: string[]
  bloom: string | null    // a path, never an index - indices shift on every graph change
} | null
```

One nested field, `v` bumped to 2. The mode's exclusions become a parse invariant: a record
carrying `landmarks` beside `spotlight`, a non-empty `clusterStack`, `localDepth > 0` or a
non-empty `query` is one the interface cannot produce, so it is foreign and is dropped whole,
which is the rule that module already follows. What the parser cannot check locally the screen
checks on apply - the domain still exists, still holds 25 knowledge pages, is still the only
one on show - and there only the `landmarks` field is dropped, because "biomedicine filtered,
no overlay" is a picture that reads.

The neighbouring rule, settled here so it does not get settled twice somewhere else: on a tab
away with the lock open, the mode stays and the bloom goes. The switch is a row in the Overlays
block, and the tab-away reset keeps the overlays and the filters while it drops selection,
trail, tag, search, drill-down and depth; the mode belongs to the first list with its three
siblings, the bloom to the second with the trail. Locked, neither applies - the return
re-applies the record.

**The lens.** With the mode on, the authority lens counts backlinks inside the DOMAIN rather
than over the whole vault. Two scoping choices, one reason each.

Scoped to the mode, because "it would be more honest in every filtered view" is word for word
the argument this file rejects below for the size ramp, and a document that keeps a discipline
in one paragraph and drops it in the next is not worth reading twice. Counted over the domain
rather than over what is painted, because the ramp is built from the drawn nodes' counts: if a
bloom changed that set, every expansion would recolour the whole picture under the reader's
hand.

What this costs in code is smaller than it sounds. `authoritySorted` in the canvas already
restricts the ramp's domain to the drawn nodes, and with a paint mask the drawn nodes are the
domain, so the domain needs nothing. What changes is the VALUE: `n.in`, counted over the vault,
becomes the domain-internal count handed in from the screen. The authority legend is built from
the same `n.in` values in `Vault.tsx` and has to move in the same step, or the legend states a
range the colours do not have.

**Node size says the role, not the degree.** Inside the mode a landmark is one size, a bloomed
neighbour smaller, a connector smallest (about 10, 6.5 and 4.5 px against the ordinary 3 to
12 px scale), through the canvas's own `radius()` so hit targets and label anchors follow. The
reason is measured: `3 + min(9, sqrt(degree) * 1.1)` saturates at degree 67, so the top 40 of
biomedicine all sit between 8.4 and 12.0 px with five of them pinned at the cap. Size is a flat
scale exactly where importance matters most, and the rank it would carry is already stated, in
order, by the list beside it. Role is the thing the picture cannot say otherwise.

The same measurement closes the question of counting the degree inside the domain instead of
over the vault, which is what the lens now does: it moves a node by at most 0.6 px and changes
nothing anybody can see, so the radius keeps reading the global degree outside the mode.
Recorded here so it does not get reopened.

The resize is immediate, for everybody. There is no reduced-motion read in this canvas today
and the entrance animation has none either, so an easing added for one radius tween would be
both inconsistent and untested; and a mask that faded in would claim more of an event than
takes place. A mode switch is allowed to snap.

**Live.** The set and the order are recomputed on every graph change, like every other filter
here. The consequence, named rather than discovered later: an ingest can reorder the list under
the reader. A bloom already open stays open even if its node leaves the set; it closes on the
next click.

**The name.** "Landmarks", one plain noun like its three siblings. "Spine" is taken by the book
spines of the Library room, and the word was carrying a skeleton metaphor that the per-node
expansion turns into a map anyway.

## Where it touches the code

- `web/src/lib/landmarks.ts`, new and pure: the availability rule, the set, the walk with its
  chapters, the connectors, the tie-break. Unit-tested on its own like `communities.ts` and
  `graphReveal.ts`.
- `web/src/tabs/Vault.tsx`: the toggle in the Overlays block with its disabled reasons, the
  mode state and the open bloom, the sole-domain test over `selectedDomains` and `wingScope`,
  the right-hand list with its way back, the Escape rungs, `resetView`, the domain-internal
  in-degrees handed to the canvas, and the `authority` legend object rebuilt from those same
  numbers. For the lock: `snapshotFreeze` and `applyFreeze` carrying the nested field,
  `applyFreeze` re-testing availability and dropping only that field when it fails, the
  right-hand column's render condition (today a flat `frozen === null`, now the explorer while
  the lock is open and the list whenever the mode is on), `openOnClick` and the early return in
  `onSelect` taught that a landmark under the lock opens rather than blooms, and `toggleFreeze`
  clearing the selection while leaving the mode and the open bloom where they are. **Not** the `keep`/`pool` pipeline, and
  **not** the `fitKey`: nothing about the drawn set changes, so there is nothing to re-frame,
  and a re-frame would undo the stillness the Positions decision exists to buy.
- `web/src/components/GraphCanvas.tsx`: the painted set and the connector set as props; nodes
  outside them drawn at no alpha and kept out of the label budget, `labelReps` and hit-testing;
  connectors dim and unlabelled; the bloom set; the role-sized radius; the authority ramp
  reading the handed-in in-degrees when they are present.
- `web/src/lib/graphFreeze.ts`: the one nested `landmarks` field, `v` bumped to 2 so an older
  frozen picture is dropped whole rather than half-applied, the nested object validated field
  by field as this module validates everything else, and the exclusion invariant enforced in
  the parse. `web/test/graphFreeze.test.ts` covers the round trip, a record dropped for the
  invariant, and a dropped `v: 1`.
- `web/test/authorityRamp.test.ts`: the lens has a second source for its value now.
- `GRAPH_SHORTCUTS` in `Vault.tsx`: the list is documentation, and its Escape row is one long
  string that has to name the two new rungs. They sit innermost first, as the ladder does: the
  bloom immediately before the panel, the mode immediately before the cluster stack. The
  placement costs nothing to reason about, because the mode turns the drill-down and the local
  focus off, so every rung below it is inert while it is on. The click rows need a word too:
  "one click while the picture is locked" now also means that a landmark opens instead of
  expanding.
- The view prefs in `Vault.tsx` (`ViewPrefs`, `loadViewPrefs`, `saveViewPrefs`, `viewMemory`)
  plus `web/test/viewPrefs.test.ts`: the mode is an overlay and persists like its three
  siblings. No version bump - that loader validates field by field and a missing field already
  degrades to its default, and the bump there is reserved for a field whose meaning flipped.
  The bloom does NOT go in: it is exploration, and the prefs hold preferences.
- `web/src/styles.css`: the list column, the numbered rows, the handle line, the chapter rules
  and their captions.

## Deliberately not in this

- **The flat size ramp itself.** Widening `3 + min(9, sqrt(degree) * 1.1)` so the strongest
  pages come apart again would help every view, not only this mode, and it would change the
  look of a screen nobody asked to have changed. It is a separate change with its own
  before-and-after measurement, not a part of Landmarks.
- **The honest lens outside the mode.** Counting backlinks inside what is drawn would be more
  truthful in every filtered view, and the contradiction it fixes - the brightest node not
  first in the list - is there wherever a filter is on. It is a change to a lens, with its own
  before-and-after over the views that already use it. Named here because an earlier draft of
  this file carried it, and the argument against is the one directly above.
- **Reaching the mode from elsewhere.** A shelf in the Library or a domain row in the Catalog
  could plausibly offer "start here" and land on the graph with the overlay on. The route
  already exists (`/graph?domain=<key>`), so it is a later addition and not a redesign; it is
  left out to keep this one screen's worth of behaviour testable on its own.

## Chunks

No chunk is done until `npm test`, `npm run typecheck` and `npm run lint` all pass and exit 0 -
all three, because `tsconfig.build.json` excludes `test/` and vitest does not typecheck, so a
green suite is not a green repo.

1. **`lib/landmarks.ts` and its tests.** The availability rule, the set, the walk, the
   chapters, the connectors, as pure functions over nodes and edges. Fixtures small enough to
   reason about by hand, plus one that reproduces the finance case: chapters that no connector
   joins. Done when the fixtures pass, ties are shown to be broken deterministically, and a run
   over the live vault reproduces the measurement table: 40 landmarks for biomedicine in
   chapters of 36 + 3 + 1 closed by 2 connectors, finance 9 in 7 + 2 that no page joins, and
   five of the ten eligible domains coming out as a single chapter.
2. **Canvas.** The painted set, connector rendering, the bloom set, the role-sized radius, and
   the authority ramp over handed-in in-degrees. Done when, in the real app, switching the
   overlay draws the landmarks and their connectors alone, labels nothing else, shows three
   distinguishable sizes, and moves nothing. "Moves nothing" is read off the worker rather than
   off the eye: a temporary counter in `worker.onmessage` stays at zero across a switch and
   across a bloom. That is the observable form of the Positions decision and the thing to check
   first, because the fallback named there depends on it.
3. **Screen.** The toggle with its disabled reasons, the paint mask, the mode exclusions, the
   Escape rungs, `Reset filters`, the freeze fields. Done when the toggle's three states
   (available, no single domain, domain too small) each say why; turning the mode on turns the
   other three off; a second domain turns the mode off; Escape peels the bloom and then the
   mode; `Reset filters` clears both; a freeze taken in the mode comes back in the mode with
   the same order and the same open bloom; a record pairing the mode with Spotlight, a drill-
   down, a depth or a query is dropped whole; a record whose domain has since fallen under the
   bar comes back with everything but the overlay; and a `v: 1` record is dropped whole.
4. **The list.** Right column, the rules and their captions from the second chapter on, up and
   down, the way back from a page detail, selection synced both ways with the canvas. Done when
   up and down walk the chapter order across the rules, the existing Enter opens the selected
   page without a new binding, a click on the canvas moves the list's highlight and the
   reverse, and the way back lands on the entry it left from. Locked: the list is still there
   with no highlight on it, a click on an entry or on a landmark opens the page instead of
   blooming or selecting, a bloom that was open when the lock closed is still painted, and
   Escape from the page comes back to all of it.
5. **Measure it.** Photograph the real app against the live vault (biomedicine, finance,
   cooking) and check that the drawing says what this file claims: the landmark count and
   chapter shape from chunk 1, connectors only where the domain has them, one open bloom at a
   time, three distinguishable node sizes, and a node in the same screen position before and
   after the switch. The pictures are taken with `?labels=off`; any that needs the titles to
   make its point stays under `docs/local/`, because this repo is public and the vault is not
   (hard rule 7). Before the PR: `node scripts/vault-name-scan.mjs --diff main` over what the
   merge would add, and `--file` over the PR body before it is posted.
