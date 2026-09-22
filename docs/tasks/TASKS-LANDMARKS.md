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
| Neighbours of a landmark, inside the domain against over the whole vault | biomedicine median 22, p90 39, max 129 inside; 26, 47, 136 over the vault; all 40 above the cap of 12 either way | A bloom needs a cap, or one click undoes the mode - **overtaken 2026-09-22**: the click re-frames onto the neighbourhood, so there is no cap and these are the sizes of the views it opens |
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

**Expansion.** A click on a landmark shows its neighbours inside the domain, ordered by
domain-internal backlinks with the same tie-break as the list. All of them, and the camera goes
round them. Inside the domain is not a choice but the reach the screen has: the domain filter is
a real filter upstream of this mask, so a page of another domain is not in the drawing at all
and cannot be revealed by brightening it.

**No cap, because the click RE-FRAMES** (corrected 2026-09-22, user decision; it was 12, then
12 of what the bloom adds, and the reasoning for both is in finding 1 below). The cap existed so
one click could not undo the mode by putting a page's whole neighbourhood back into a domain
with forty landmarks in it. The click no longer does that: it frames the picture onto the
neighbourhood, so what it puts up is a VIEW OF ONE PAGE rather than a domain with a crowd in the
middle of it. Against that, a cap only withholds part of an answer the reader has just asked for
in full, and the handle line that offered the rest - "17 of 22 shown, show all" - is a step
between the question and the answer with nothing left to justify it. Both are gone.

**An open neighbourhood takes the screen** (added 2026-09-22, user decision). While one is
open it is what the screen is about, and the three surfaces say so together rather than leaving
the reader to find twelve new dots in a field of forty:

- the LIST is that neighbourhood - the landmark at its head, and under it every page it links
  to or from inside the domain. The list and the picture hold the same set, which is what
  finding 4 below is about;
- the PICTURE is that neighbourhood and nothing else (corrected 2026-09-22, user decision, was
  half-transparent): every other landmark and connector is off the drawing. Remains of the
  other view inside a frame drawn around one page are a second picture the reader has to look
  past, and a dimmed label is still a label;
- the HEADING names it after the domain, in the form `<domain> - <the page>`, because the
  middle of the bar is where a reader looks to find out what they are looking at. That slot has
  since become the screen's general answer to "what am I looking at" (2026-09-22): Spotlight
  puts its own name there, and a cluster drill-down puts nothing there at all, because it
  stands in the scope line at the top of the drawing and a thing said twice is a thing the
  reader has to check against itself.

All three come back on one press of Escape, which is why that press had to become the FIRST rung
rather than the fourth: it was behind the trail, and walking two landmarks builds one, so the
press meant to close the expansion silently dropped the crumbs and left the picture as it was.

**What the camera frames** (added 2026-09-22, user decision). The mode frames what it paints:
the landmarks when it comes on, one neighbourhood while one is open, the landmarks again when
Escape closes it, and the whole domain when the mode goes off. One rule rather than four cases,
and it is what makes an uncapped expansion readable - a hundred neighbours framed is a picture
of a page, where a hundred neighbours inside the domain's own extent is a crowd.

This moves the CAMERA and nothing else, which is the line **Positions** draws: the node list,
the edge list and the grouping are untouched, so no layout is posted and no node changes place
in the world. Measured over a switch, an expansion, an Escape and a switch back: the layout
worker was asked for nothing and answered nothing.

A second click on the landmark drops the bloom: one neighbourhood at a
time. Only a landmark expands; a click on a connector or on a neighbour that is already out
selects and opens it exactly as anywhere else on this screen. A bloom adds nothing to the graph the canvas
lays out - those neighbours were always in it and merely unpainted - so they appear where they
stand instead of arriving out of a re-settling layout, and the camera moving to them is a
different thing from the picture re-settling under them. What a click does while the picture
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

**The column has one heading, in two forms** (added 2026-09-22, user wording and decision). The
reading order names its measure - "key articles by backlink count" - and an open neighbourhood
names the page it is around. Same slot, same rule, same weight, and both stay put while the
rows scroll under them: forty entries move, and a heading that left with them would take its
own answer along. The single-line form's rule lines up with the one under the canvas bar beside
it, so the two boxes read as one row; the page form carries a second, quieter line for its two
figures and is that much taller.

The expanded page is a HEADING rather than a marked first row. It is not a member of the list
under it, and the ring and fill that mark a selected row would say it was - it keeps the weight
and loses the box.

**No trail** (added 2026-09-22, user decision). The breadcrumb along the bottom of the drawing
is not drawn in this mode, and not kept either: the list IS where the reader stands, a second
line of crumbs says the same thing worse, and a trail kept out of sight would go on eating an
Escape press for a walk nobody could see. It comes back with the mode off.

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
for. The selected row is marked, unless the lock has cleared the selection. While a
neighbourhood is open the list is that neighbourhood instead (see **Expansion**): the landmark
at its head and the neighbours under it, unnumbered, because a neighbour has a place in this
page's neighbourhood and none in the domain's reading order.

**A number says what it counts, or it does not appear** (corrected 2026-09-22, finding 5). The
head of a neighbourhood carries two figures on one quiet line - "25 neighbours · #13 of 40" -
rather than the rank alone in the number column. In the reading order that column is
unambiguous because forty of them run down it; at the head of a neighbourhood it is the only
number on screen, and the only other thing a number can mean over a list is how long the list
is. It was read that way, which is the reading the layout invited.

**The chapters in the list.** From the second chapter on, a thin rule with a caption that says
what the break means ("not linked to anything above · 3 pages"). The first gets nothing,
because it is simply the list. Deliberately not headings: biomedicine breaks into 36 + 3 + 1,
and a heading would give one left-over page the weight of thirty-six connected ones.

A domain whose set were nearly all single-page chapters would be a list of rules, and nothing
here guards against that. The worst measured case is finance: 9 entries, 3 chapters, 2 rules,
which reads fine. A threshold for a case nobody has seen is untested machinery in the name of a
guess, and it gets built when a domain shows it.

**Every count follows what is on screen** (added 2026-09-22, user decision). "Showing 42 of
1320 pages" while the mode is on, 26 while one neighbourhood is open, 535 again when it goes
off - and the page-type chips beside it move with the same set, so they read 22 concepts and 4
sources over one neighbourhood rather than the domain's 279 and 154. The mask keeps every page
of the domain in the arrays the canvas is handed, which is what leaves the layout alone, but
that is a fact about the machinery and the reader counts what they can see.

The chips count the SET rather than the drawing, because the drawing has already been through
the type filter and counting there would make every other chip read 0 - the trap the panel's
`pool` exists to avoid. The page count's second number stays the vault, so the sentence goes on
saying how much of the whole is in front of them. All of it is the same set the camera frames,
on purpose: a count answering a different question from the picture beside it is one more thing
to reconcile, and this mode already asks the reader to hold a list, a drawing and a heading
together.

**No overview** (added 2026-09-22, user decision). The minimap is a map of where the picture
sits inside the whole layout, and this mode frames what it paints - so the frame is always
around the dots and the map always says "here, on all of it". Shrinking its bounds to the
painted set instead would make it a second, differently-scaled picture rather than an answer.
It comes back with the mode off.

**The heading does not move** (added 2026-09-22, user decision). The bar's middle block keeps
its width when the neighbourhood's name is appended: the lead, the dot and the first letter stay
exactly where they were, nothing else in the bar shifts, and the tail runs PAST the block's own
right edge into the empty stretch before the search rather than shortening the domain in front
of it. Both parts stop shrinking for that, and only the tail is ever cut, with the whole of it
on hover. Measured across the three states: the first letter sits at the same x and the same y
in all of them, and the bar keeps its height.

**The switch.** The FIRST row of the Overlays block, above Areas, Bridges and Spotlight
(moved there 2026-09-22, user decision: it is the only one of the four that changes what the
picture is ABOUT rather than how the same picture is coloured, and it turns the other three off
when it comes on),
disabled with its reason when no single domain is on show or the domain is under 25 knowledge
pages. In the default view it is therefore usually grey - 10 of 22 domains clear the bar at
all. That is the accepted cost of a switch that lives where its three siblings live, and the
reason text has to carry it, so the four states are written here rather than invented at the
keyboard:

Each state says its piece in ONE line and keeps the sentence behind it in the row's tooltip
(2026-09-22, user wording). The row sits in a block whose other lines are four words, and one
that wrapped to three to explain itself would be the loudest thing in a column of switches that
are all off.

| State | the line | the sentence behind it |
|---|---|---|
| available | "key articles of the domain" | what the overlay does, in full |
| nothing or several domains on show | "Select a domain first" | "Filter to one domain to see where it begins." |
| the unfiled pile on show | "Not a domain" | "Pages without a domain are not one: they share no subject, so 'what is this built around' has no answer here." |
| a domain under the bar | "Only 19 pages here" | "Only 19 pages here, small enough to read whole." |

The line names what the overlay DRAWS rather than how it chooses - the choosing is the list's
business, and the list is right there. The count in the last one is the domain's own, so the
line can be checked against the panel.

**Against the other modes.** Turning it on turns off Spotlight, the cluster drill-down and the
local focus: three ways of making the graph smaller is two too many at once.

**And so do Areas and Bridges** (corrected 2026-09-22, user report and decision; both were
allowed here on the ground that they colour rather than reduce). All three of the other
overlays are about COMMUNITIES, and this one draws about a tenth of each.

The measurement is Areas's, and it carries the other two. Over the largest domain: of the
fourteen communities its 535 pages fall into, six have three or more painted members and so
would be drawn at all, and those six hold 8 to 14 per cent of their community. A convex hull
over nine of eighty-seven points, placed by a layout that knew all eighty-seven, is a figure
over a handful of scattered points that swallows whatever lies between them - which is what it
looked like. Bridges tells an intra-community link from a bridge, and with a tenth of each
community drawn most of both kinds are not on screen to be told apart. Spotlight lights a whole
community, and most of what it would light is not there either.

So the three go grey together while the mode is on, in the same four words - "needs a whole
community" - because it is the same reason; each keeps its own sentence in its tooltip, where
there is room for the difference. And the block's order puts Spotlight third, between the two
that draw and the one that lights. A search leaves the mode.

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
  clearing the selection while leaving the mode and the open bloom where they are. **Not** the `keep`/`pool` pipeline. The `fitKey` **is** carried (corrected
  2026-09-22): it frames the landmarks, then one neighbourhood, then the landmarks again, then
  the domain, through the canvas's new `fitSubset`. That moves the camera and posts no layout,
  which is the half of the Positions decision that was ever load-bearing.
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
  expanding. **Corrected 2026-09-22:** the bloom is the FIRST rung, ahead of the trail and the
  tag, not the one before the panel - an open neighbourhood is the innermost thing this screen
  can hold, and behind the trail its Escape was being eaten by crumbs the reader had not looked
  at.
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

## Findings

**1. A landmark's neighbours include other landmarks, and the cap did not say what that
means (2026-09-22, found building chunk 1, resolved as (b) and then OVERTAKEN the same day:
there is no cap at all now, because the click re-frames onto the neighbourhood. The measurement
below is kept because it is what made the overlap visible in the first place).**

The **Expansion** decision caps a bloom at 12 neighbours "ordered by domain-internal backlinks
with the same tie-break as the list", and the list is the highest-ranked pages of the domain.
So the landmarks crowd the front of every neighbour list, and a cap taken off the top of it is
spent on pages that are already painted.

Measured over the live graph, under the rules as built:

| Measured | Result |
|---|---|
| Which population the recorded neighbour numbers count | all domain-internal neighbours, landmarks included: that reading gives median 22 and max 129 exactly, and is the only one under which "all 40 above the cap of 12" holds. Excluding landmarks gives median 17, max 109, and seven of the forty at or below 12 |
| Of a biomedicine landmark's top 12 neighbours, how many are themselves landmarks | 5.1 on average, leaving 6.9 pages a click actually reveals |
| The worst case, and where it falls | the FIRST entry of the list - the strongest page, the one a reader clicks first - has all 12 of its top neighbours already painted. That click changes nothing on screen. Three more of the forty reveal one or two pages |
| The same in the mid-size domains | finance and cooking reveal at least 6 on every landmark; this is a biomedicine phenomenon |

Neither the count nor the cap is wrong on its own; the two were decided against a neighbourhood
nobody had split into "already on screen" and "not". Two ways out, each giving up one sentence:

- **(a) Cap the whole list**, which is what the file literally says. The bloom set is the top 12
  of all 22, a neighbour that is already a landmark stays landmark-sized, and "12 of 22 shown"
  is literally true. The cost is the gesture: one landmark in forty blooms to nothing, and it is
  the one standing at the top of the list. "show all" is the way out and the handle already
  carries it.
- **(b) Cap what the bloom ADDS.** Order the neighbours by the same rank, skip the ones already
  painted, paint the first 12 of the rest. Every click reveals twelve pages, which is what the
  cap's own reasoning asks for ("a bloom needs a cap, or one click undoes the mode"). The cost
  is the handle's arithmetic: with 22 neighbours of which 5 are landmarks, 17 of them are on
  screen once the bloom is open, so the line has to read "17 of 22 shown, show all" and the
  number in it is no longer the cap.

**Proposed resolution: (b), with the handle stating what is on screen rather than the cap.** The
cap exists to bound how much one click grows the picture, and under (b) it does that exactly;
under (a) it also bounds how much a click can grow it to nothing. The number the reader wants
from that line is how much of this page's neighbourhood they are looking at, which "17 of 22"
answers and "12 of 22" only answers when the two sets happen not to overlap.

Nothing else in the file moves either way: the set, the order, the chapters, the connectors and
the recorded neighbour counts are unaffected, and the canvas takes the bloom as a set of nodes
to paint whichever rule builds it.

**2. What a click on a LANDMARK does to the column (2026-09-22, found building chunk 4,
resolved by reading).**

**The list** says "clicking an entry or a node replaces it with the page detail and a way back
to the list". Taken to include a landmark, three other sentences of this file stop being
reachable: the selected row is marked, the bloomed landmark's row carries its handle line
underneath, and a click on the canvas moves the list's highlight - none of which can be seen
if every click puts a page detail over the list. The handle would be the worst of the three,
because it was put in the list precisely so it would already be on screen when it is wanted.

There is one reading under which every sentence holds, and it is **Expansion**'s own: "Only a
landmark expands; a click on a connector or on a neighbour that is already out selects and
opens it exactly as anywhere else on this screen." A landmark has its own rule and is not the
"node" of the list's sentence. So:

- a landmark, on the canvas: expands, marks its row, and the list stands - that is where the
  handle is;
- a connector or a neighbour already out: the page detail, which is what "exactly as anywhere
  else on this screen" means where the explorer is what stands in that column;
- an entry in the list: the page detail, with the way back;
- locked, any of them: the page, because exploration is what was left behind when the lock
  closed.

Built that way. Named here because it is a reading rather than a decision, and a one-line
change if it is the wrong one.

**3. A node's SCREEN position moves when the list opens, and the mask is not what moves it
(2026-09-22, found measuring chunk 5, resolved by measurement).**

Chunk 5 asks for "a node in the same screen position before and after the switch". Measured
against the live vault it is not, in any of the three domains: 0 of 42, 0 of 9 and 0 of 11
painted nodes land within half a pixel of where they stood, with medians of 12, 62 and 29 px.

The layout is not what moved them. Across every one of those switches the layout worker was
asked for nothing and answered nothing - posts 5 → 5, frames 170 → 170 - which is the
observable form of the **Positions** decision and the thing that decision actually turns on.
What moved is the CANVAS: the list opens in the right-hand column and takes 340 px of the
drawing's width, the canvas re-frames to the room it has left (which is what it does for any
resize it has not been panned away from), and the picture lands smaller and shifted.

Isolated by opening that column first: with a page already selected, so the column is standing
and the canvas keeps its 956 px, the same switch moves 26 of 43 painted nodes by nothing at all
and the worst by 1.70 px - which is the node's own radius changing under a centroid, not a
position changing.

So the criterion holds of the mechanism and not of the pixels, and the difference is one the
screen already has: clicking any node today opens that same column and re-frames that same way.
Nothing to fix - the alternative is a canvas cropped by 340 px with a third of the drawing
behind the list.

## What the running app measured (2026-09-22, chunk 5)

Against the live vault, through the real screen, `?labels=off`. Pictures under
`docs/local/landmarks-2026-09-22/` - this repo is public and that vault is not, and this repo's
own convention is that everything under `docs/img/` comes from the synthetic vault
(`docs/screenshots.md`), which these do not.

| Domain | drawn | painted | list | the breaks it drew | node sizes on screen |
|---|---|---|---|---|---|
| biomedicine | 535 | 42 | 40 rows | "· 3 pages", "· 1 page" | 40 at 7.7-7.8 px, 2 at 2.0-2.3 px |
| finance | 78 | 9 | 9 rows | "· 2 pages" | 9 at 16.1-16.2 px |
| cooking | 82 | 11 | 10 rows | "· 7 pages" | 10 at 16.7 px, 1 at 3.3 px |

Every row of the chunk-1 table, read off the drawing rather than off the module: 40 landmarks
in 36 + 3 + 1 closed by 2 connectors, 9 in 7 + 2 that no page joins, 10 in 3 + 7 with the one
connector visibly bridging them, and the first chapter smaller than the second where the table
says it is. Connectors appear in exactly the two domains that have them.

One expansion at a time, by painted count: 42 → 55 open → 43 on a second click of the same
landmark → 55 → 54 on another one. Two at once would be 67.

Three distinguishable sizes, with one expansion open: 41 at 7.1-7.8 px, 12 at 5.0-5.1 px, 2 at
2.0-2.3 px.

The layout was asked for nothing throughout: 5 posts and 170 frames before the switch, the
same after it, and the same again after four expansions.

**4. The list was right and the picture was not (2026-09-22, reported as "the sidebar seems to
show articles that are not part of the bloom", resolved).**

Audited rather than argued: for every landmark of the three domains this file measures, the
entries the sidebar lists were compared against the neighbours the graph payload itself gives,
computed a second time and independently of the module.

| Domain | landmarks | lists disagreeing with the payload | entries that are not a direct link | list length |
|---|---|---|---|---|
| biomedicine | 40 | 0 | 0 | min 14, median 22, max 129 |
| cooking | 10 | 0 | 0 | min 11, median 14, max 22 |
| finance | 9 | 0 | 0 | min 9, median 10, max 19 |

So the list named nothing it should not have. What was wrong was the PICTURE: while an open
neighbourhood only dimmed its surroundings, the set it lit left out the neighbours that happen
to be landmarks or connectors in the other view - they stayed drawn in their own role and were
greyed down with everything else. The list named them, the drawing greyed them, and the reader
is right to read that as the list naming something that is not part of the expansion.

Both halves are one set now: every page the landmark links to or from inside the domain is in
the neighbourhood, is on screen, and is in the list. Measured in the running app: 27 painted
blobs against 26 list rows, the one extra being the selection ring.

**5. The rank at the head of a neighbourhood was read as a count (2026-09-22, reported, fixed).**

The head row carried the landmark's place in the reading order in the same number column the
full list uses - "37" over a list of 21 entries - and it was read as "37 entries", which is the
only other thing a number over a list can mean. Nothing was wrong with the figure; the column
was carrying a meaning it could no longer imply, because the forty rows that made it a rank
were not on screen.

Two ways out were on the table: drop the rank (Escape marks the row and scrolls to it, so the
place is one press away) or label both figures. The second was taken, because the rank does
work while reading - "thirteen of forty, a third of the way in" - and because a line under the
head was free, the "show all" handle having gone the same day.

The rule it leaves behind is worth more than the fix: in this list a number stands bare only
where the column itself says what it counts.
