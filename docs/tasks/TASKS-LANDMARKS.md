# Tasks: Landmarks, an entry point into a large domain (2026-09-21, built 2026-09-22)

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

**Status: built.** All five chunks below are done, each measured against its own criterion. The
day's corrections - a dozen of them, several to decisions this file had already taken - are
folded into the decisions themselves; what is worth keeping of the reasoning behind them is
under **Findings** at the end.

## What the vault measured (2026-09-21, live vault: 1323 knowledge pages, 12300 links)

The design questions were settled against numbers rather than guesses. The script is
throwaway; the numbers are the record.

| Measured | Result | What it decided |
|---|---|---|
| Domain sizes | biomedicine 535, ai-tooling 152, ML 150, cooking 82, finance 78, materials 68, then 16 domains at 40 or fewer | Only one domain is genuinely hard, and half of them are small enough to read whole |
| Global top-k over everything | the top 2 % touches 5 of 22 domains | A global ranking is the biomedicine ranking; the mode is scoped to one domain |
| Top 40 of biomedicine, by links inside the domain | 3 components (36 + 3 + 1), weakest member still has 13 backlinks | The set is almost connected on its own, and the islands are real |
| Pages needed to join the chapters, under the rule "The connectors" states | biomedicine 2, cooking 1, materials-science 1, battery-technology 1, the rest 0; finance stays in two pieces | Connectors are worth drawing and there are very few of them; where they do not help, that is a finding |
| Chapter shape of the set, per eligible domain | biomedicine 36 + 3 + 1, cooking 3 + 7, finance 7 + 2, materials-science 4 + 2 + 2, battery-technology 7 + 1, the other five one chapter | Chapters are a mid-size phenomenon, half the eligible domains simply get a list, and the first chapter is not always the biggest |
| Spine plus one hop, globally | 423 of 535 pages | A global "+1 hop" step is not a step, it is almost everything; expansion has to be per node |
| Neighbours of a landmark, inside the domain against over the whole vault | biomedicine median 22, p90 39, max 129 inside; 26, 47, 136 over the vault | How big a view one click opens. It was the case for a cap until the click began to re-frame; see **Expansion** |
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

**The connectors.** The non-landmark pages that join two chapters. In the reading order's own
picture they are drawn dim and unlabelled, carry no rank and are not list entries - they are the
glue, not the entry points. Inside one open neighbourhood a connector is a neighbour like any
other and is drawn as one: the roles belong to the view that has roles. The rule, stated so the
count is reproducible and the test can assert it: repeatedly take the non-landmark knowledge
page of the domain that touches the most chapters still separate from one another, break ties by
domain-internal backlinks and then by path, merge the chapters it touches, and stop when no
remaining page touches two. The loop needs no cap: each step merges at least two chapters, so it
cannot run longer than one step short of the chapter count, and biomedicine's three chapters
close with two pages.

Where nothing joins anything, nothing is added and the chapters stand apart, which is true of
the domain rather than of the drawing: finance's two chapters are joined by no page in the
domain, however long the loop runs.

**Expansion.** A click on a landmark shows its neighbours inside the domain, ordered by
domain-internal backlinks with the same tie-break as the list. All of them, and the camera goes
round them. Inside the domain is not a choice but the reach the screen has: the domain filter is
a real filter upstream of this mask, so a page of another domain is not in the drawing at all
and cannot be revealed by brightening it.

There is no cap, because the click RE-FRAMES. A cap existed while the click left the camera
where it was: one press would otherwise have put a page's whole neighbourhood back into a domain
with forty landmarks in it, which undoes the mode. Framing the picture onto the neighbourhood
answers that instead - what it puts up is a VIEW OF ONE PAGE rather than a domain with a crowd
in the middle of it - and against that a cap only withholds part of an answer the reader has
just asked for in full.

**An open neighbourhood takes the screen.** While one is open it is what the screen is about,
and the three surfaces say so together:

- the LIST is that neighbourhood - the landmark at its head, and under it every page it links
  to or from inside the domain. The list and the picture hold the same set;
- the PICTURE is that neighbourhood and nothing else: every other landmark and connector is off
  the drawing, not dimmed. Remains of the other view inside a frame drawn around one page are a
  second picture the reader has to look past, and a dimmed label is still a label. The selected
  page wears the LIBRARY'S RIM - its warm light at its own 1.6px, the same edge the room puts
  along whatever is being pointed at - because an accent ring is blue on a blue-black canvas and
  reads as one more circle among forty of the same colour. A darker halo goes under it for the
  light theme, where a warm white edge would otherwise vanish, which is what the label pass
  already does for text;
- the HEADING names it after the domain, in the form `<domain> - <the page>`. That slot is the
  screen's general answer to "what am I looking at": Spotlight puts its own name there, and a
  cluster drill-down puts nothing there at all, because it stands in the scope line at the top
  of the drawing and a thing said twice is a thing the reader has to check against itself.

All three come back on one press of Escape, which is why that press is the FIRST rung of the
ladder rather than the fourth: an open neighbourhood is the innermost thing this screen can
hold, and behind the trail its Escape was eaten by crumbs the reader had not looked at.

**What the camera frames.** The mode frames what it paints: the landmarks when it comes on, one
neighbourhood while one is open, the landmarks again when Escape closes it, and the whole domain
when the mode goes off. An open neighbourhood puts its own page in the MIDDLE of that frame, so
the thing the click was about is where the eye already is; the span is then measured from it in
every direction, which costs a little zoom and buys a picture that reads as being about one
page. One rule rather than four cases, and it is what makes an uncapped expansion readable - a
hundred neighbours framed is a picture of a page, where a hundred neighbours inside the domain's
own extent is a crowd.

This moves the CAMERA and nothing else, which is the line **Positions** draws: the node list,
the edge list and the grouping are untouched, so no layout is posted and no node changes place
in the world.

**A click reads.** With a neighbourhood open, every node on screen and every row in the list is
one of its pages, so a click opens that page - the anchor excepted, which closes the
neighbourhood it heads. With none open, a landmark opens its own neighbourhood and a connector
opens its page. There is no page detail in this column; the column is the list, in one of its
two forms.

What a click does NOT do inside a neighbourhood is move the selection. The anchor keeps it, so
Escape out of an article comes back to the landmark the reader left from, lit and centred, with
its neighbourhood still open.

A second click on the landmark drops the neighbourhood: one at a time. An expansion adds nothing
to the graph the canvas lays out - those neighbours were always in it and merely unpainted - so
they appear where they stand instead of arriving out of a re-settling layout, and the camera
moving to them is a different thing from the picture re-settling under them.

**Positions.** Unchanged, and the mechanism is the decision, because the obvious implementation
does not deliver it. The mask does **not** narrow the `keep`/`pool` pipeline. Every page of the
domain stays in the node and edge arrays the canvas is handed, and what the mask decides is
where the ink goes. What that buys is the canvas's own structural-identity check: an unchanged
node list, edge list and domain grouping make the layout effect return before it posts anything,
so switching the overlay on or off posts no layout at all and costs one redraw.

A `keep` mask would post one, and the result would not be subtle. The worker reheats at alpha
0.3 with `forceX(0)`, `forceY(0)` and `forceGroupSlot`, and the slots themselves are computed
from the group sizes, so dropping biomedicine from 535 drawn pages to 40 would pull the
survivors to a newly computed, much smaller slot and settle them there. The picture would
re-deal on every press of the switch and again on every expansion. "The same shape with most of
it taken away" is a sentence only a paint mask makes true.

The cost was named in advance and paid in chunk 2: roughly a dozen places in `GraphCanvas.tsx`
had to learn the difference between drawn and painted - the label budget and `labelReps`, the
label pass, hit-testing (an unpainted node is not clickable, so a click on its position is a
click on the background), the overview, the hulls. The fallback named there, a `keep` mask with
the picture re-settling, was never needed.

**Positions, amended (2026-09-24, user decision): the overview is drawn spread out.** Measured
on biomedicine, the forty landmarks sat where the 535-page layout had put them: four clumps
with most of the drawing empty between them, and the label pass - the general one, which cuts a
title at 30 characters and drops any caption that would touch another - left about a quarter of
them nameless and cut half of the rest. Naming the pages is what the overview is for.

So the overview now DRAWS its points apart, and only draws them so (`lib/landmarkLayout.ts`):
each axis is blended toward its rank, which opens the clumps while left stays left and top stays
top; the result is laid out over the whole drawing area in screen pixels, where the captions
are measured; and a relaxation pushes apart any two dots whose dot-plus-caption rectangles
overlap, along whichever axis costs less of the room there is. The layout is untouched - no post,
no worker frame, the positions memory keeps the real positions - and everything that draws,
hit-tests, frames or leashes reads the display positions while they exist. They are recomputed
when the mask, the drawing or the drawing area changes (the list column opening beside it takes
340px), and they are gone the moment a neighbourhood opens: an open neighbourhood is drawn where
its pages really stand, as the paragraph above requires.

Every landmark is named in that view: the whole title in up to four lines of at most 160px,
placed at the first free spot around its dot (below, above, sides, diagonals; a spot outside
the frame is the last resort), and its place in the reading order is written inside the dot, so
the picture and the list can be read against each other. The six longest titles of biomedicine
still end in an ellipsis on the fourth line; the tooltip carries them whole.

Chosen among three variants rendered from the real canvas: as it was, the captions alone (which
still collided in the dense middle, because the dots themselves stood too close), and both.

**The same for an open neighbourhood (2026-09-24, user decision).** A bloom was drawn where its
pages really stand, and a page's neighbours stand close around it, so twelve to twenty dots sat
in one knot with their titles cut and on top of each other. The spread and the full titles now
cover the bloom too, with one difference: the expanded landmark is held in the MIDDLE of the
area and never pushed, which is the "page in the middle of that frame" rule above kept by the
spread instead of by the camera alone.

**A neighbourhood is numbered, and opens from the list (2026-09-24, user decision).** Its rows
now carry 1 to n in the neighbourhood's own order - domain-internal backlinks, the reading
order's measure - and each dot carries its row's number, so the picture and the list read
against each other the way the overview's do. Finding 4 stands: the heading says what the
numbers count ("16 neighbours by backlink count · #2 of 37"), so they cannot be taken for places
in the domain's order. A row's NUMBER opens the landmark's neighbourhood - the same bloom a click
on its dot opens, for a landmark whose dot is hard to find - and its title opens the page. (A
separate bloom button at the row's end came first and was replaced the same day: the number is
the control the eye already goes to.) The number is a ring, filled with its dot's colour in the
page-type view; on the fill it takes `--accent-ink`, measured at a contrast of 5.3 to 5.7 on the
light theme's six type colours and 6.4 to 9.5 on the dark theme's, where white would fall to 2
to 3. The numbers inside the dots choose their ink by the same measure.

**The list follows the filters (2026-09-24, user decision).** The list used to stay "about the
domain": a landmark the page-type chips took out of the picture stayed in the list. It now shows
what the drawing shows. The SET is still computed over the domain, as the decision on it above
requires - which pages are landmarks and their order do not move when a chip is pressed - and
every row keeps its number, its place in that order and the number in its dot, so a filtered
list has gaps in its numbering (1, 2, 3, 4, 6, 11 … with Concepts only) rather than a second
count that disagrees with the picture. A chapter rule stands only before a chapter that still
has a row, and counts what is shown.

**When the condition falls away.** A second domain picked, the chips cleared, a room turned:
the mode goes off, the neighbourhood with it, and the list is gone. Not latent, not remembered.
It already turns the other overlays off when it comes on, so it must not be the one that lives
on invisibly; and the way back is one press of a switch standing where it was.

The mode also yields in the other direction: switching on any of the things it excludes turns it
off, which the "turning it on turns them off" rule only covers in one order. That is not
politeness. The lock's record makes the exclusion a parse invariant, so a picture holding both
would be written and then refused on the way back.

**The list.** Right-hand column, where the explorer sits today. Up and down walk it; Enter needs
no binding of its own, because the list's selection IS the screen's selection, synced both ways
with the canvas, and Enter already opens that. The left and right keys stay with the domains.

A row is a number and a title, and nothing else. The number runs 1 to k unbroken across the
chapter rules, because the chapters are breaks in one list and not sections of several; and it
is there for the reading pass the lock describes, where you leave for a page and come back and
want to know where you were. No backlink count beside it: the rank is already stated by the
order, and a second number for the same thing is the mistake the size ramp is kept out of this
for. The selected row is marked, unless the lock has cleared the selection.

While a neighbourhood is open the list is that neighbourhood instead: the landmark at its head
and the neighbours under it, unnumbered, because a neighbour has a place in this page's
neighbourhood and none in the domain's reading order.

**A number says what it counts, or it does not appear.** The head of a neighbourhood carries two
figures on one quiet line - "25 neighbours · #13 of 40" - rather than the rank alone in a number
column. In the reading order that column is unambiguous because forty of them run down it; at
the head of a neighbourhood it is the only number on screen, and the only other thing a number
can mean over a list is how long the list is.

**The column has one heading, in two forms.** The reading order names its measure - "key
articles by backlink count" - and an open neighbourhood names the page it is around. Same slot,
same rule, same weight, and both stay put while the rows scroll under them: forty entries move,
and a heading that left with them would take its own answer along. The single-line form's rule
lines up with the one under the canvas bar beside it, so the two boxes read as one row; the page
form carries a second, quieter line for its two figures and is that much taller.

The expanded page is a HEADING rather than a marked first row. It is not a member of the list
under it, and the ring and fill that mark a selected row would say it was - it keeps the weight
and loses the box.

**The chapters in the list.** From the second chapter on, a thin rule with a caption that says
what the break means ("not linked to anything above · 3 pages"). The first gets nothing,
because it is simply the list. Deliberately not headings: biomedicine breaks into 36 + 3 + 1,
and a heading would give one left-over page the weight of thirty-six connected ones.

A domain whose set were nearly all single-page chapters would be a list of rules, and nothing
here guards against that. The worst measured case is finance: 9 entries, 3 chapters, 2 rules,
which reads fine. A threshold for a case nobody has seen is untested machinery in the name of a
guess, and it gets built when a domain shows it.

**No trail.** The breadcrumb along the bottom of the drawing is not drawn in this mode, and not
kept either: the list IS where the reader stands, a second line of crumbs says the same thing
worse, and a trail kept out of sight would go on eating an Escape press for a walk nobody could
see. It comes back with the mode off.

**The reading view's own panel.** Opening an article from this mode lands in the same link panel
the graph's explorer shows - what points at the page, what it points at, each list an equal
share of the column with its own scroll - rather than the one-list-behind-a-toggle the reading
view used to carry. One shape for "what is around this page", wherever the reader meets it,
computed by one function so the two panels cannot drift apart about what counts as related.

Inside the overlay the tag list goes and the two link lists take a half each. This mode is about
how the pages of one domain LINK; a list of pages that merely share a word with this one is a
different question asked in the same column.

**Every count follows what is on screen.** "Showing 42 of 1320 pages" while the mode is on, 26
while one neighbourhood is open, 535 again when it goes off - and the page-type chips beside it
move with the same set, so they read 22 concepts and 4 sources over one neighbourhood rather
than the domain's 279 and 154. The mask keeps every page of the domain in the arrays the canvas
is handed, which is what leaves the layout alone, but that is a fact about the machinery and the
reader counts what they can see.

The chips count the SET rather than the drawing, because the drawing has already been through
the type filter and counting there would make every other chip read 0 - the trap the panel's
`pool` exists to avoid. The page count's second number stays the vault, so the sentence goes on
saying how much of the whole is in front of them. All of it is the same set the camera frames,
on purpose: a count answering a different question from the picture beside it is one more thing
to reconcile, and this mode already asks the reader to hold a list, a drawing and a heading
together.

**No overview.** The minimap is a map of where the picture sits inside the whole layout, and
this mode frames what it paints - so the frame is always around the dots and the map always says
"here, on all of it". Shrinking its bounds to the painted set instead would make it a second,
differently-scaled picture rather than an answer. It comes back with the mode off.

**The heading does not move.** The bar's middle block keeps its width when the neighbourhood's
name is appended: the lead, the dot and the first letter stay exactly where they were, nothing
else in the bar shifts, and the tail runs PAST the block's own right edge into the empty stretch
before the search rather than shortening the domain in front of it. Both parts stop shrinking
for that, and only the tail is ever cut, with the whole of it on hover. Measured across the
three states: the first letter sits at the same x and the same y in all of them, and the bar
keeps its height.

**The switch.** The FIRST row of the Overlays block, above Areas, Spotlight and Bridges: it is
the only one of the four that changes what the picture is ABOUT rather than how the same picture
is coloured, and it turns the other three off when it comes on. Disabled with its reason when no
single domain is on show or the domain is under 25 knowledge pages - in the default view it is
therefore usually grey, since 10 of 22 domains clear the bar at all. That is the accepted cost
of a switch that lives where its siblings live, and the reason text has to carry it.

Each state says its piece in ONE line and keeps the sentence behind it in the row's tooltip. The
row sits in a block whose other lines are four words, and one that wrapped to three to explain
itself would be the loudest thing in a column of switches that are all off.

| State | the line | the sentence behind it |
|---|---|---|
| available | "key articles of the domain" | what the overlay does, in full |
| nothing or several domains on show | "Select a domain first" | "Filter to one domain to see where it begins." |
| the unfiled pile on show | "Not a domain" | "Pages without a domain are not one: they share no subject, so 'what is this built around' has no answer here." |
| a domain under the bar | "Only 19 pages here" | "Only 19 pages here, small enough to read whole." |

The line names what the overlay DRAWS rather than how it chooses - the choosing is the list's
business, and the list is right there. The count in the last one is the domain's own, so the
line can be checked against the panel.

**Against the other modes.** Turning it on turns off the cluster drill-down, the local focus and
all three of the other overlays. The first two are ways of making the graph smaller, and three
of those at once is two too many. The other three are about COMMUNITIES, and this one draws
about a tenth of each.

That measurement is Areas's and it carries the other two. Over the largest domain: of the
fourteen communities its 535 pages fall into, six have three or more painted members and so
would be drawn at all, and those six hold 8 to 14 per cent of their community. A convex hull
over nine of eighty-seven points, placed by a layout that knew all eighty-seven, is a figure
over a handful of scattered points that swallows whatever lies between them. Bridges tells an
intra-community link from a bridge, and with a tenth of each community drawn most of both kinds
are not on screen to be told apart. Spotlight lights a whole community, and most of what it
would light is not there either.

So the three go grey together while the mode is on, in the same four words - "needs a whole
community" - because it is the same reason; each keeps its own sentence in its tooltip, where
there is room for the difference. The block's order puts Spotlight third, between the two that
draw and the one that lights. And a search leaves the mode.

**The lock.** The picture on screen, held (`graphFreeze.ts`, 2026-09-17). The two mechanisms
collide before they combine: while the lock is closed the right-hand column is not rendered at
all and one click on a node opens its page. Landmarks wants that column for its list, and it is
the one configuration on this screen whose whole value is the order - a locked Landmarks picture
unable to show its list would be the worst thing here rather than the best.

The list is exempt from "the panel stays away", by the rule's own reason rather than by its
letter. `toggleFreeze` clears the selection because "a picture held as a reading list has no
page selected in it, and a ring left on one node would say otherwise", and that aims at the
SELECTION: the explorer is the detail of a selection, the list is part of the picture. Locking
therefore clears the ring and the list's highlight and leaves the list standing. A neighbourhood
that was open when the lock closed stays open and stays painted: closing it would be the lock
altering the very picture it claims to hold. A click in the list opens the page, locked or not -
one rule governs the canvas and the list alike, and there is no page detail in that column for
it to diverge over.

**What the lock holds, and what it follows.** It holds which nodes are drawn and where they sit:
the filters, the room, the drill-down, the focus, the search and the tag stay as they were, and
the next Escape returns to them from any excursion. It FOLLOWS the switches that say how that
same set is coloured - the lens and the four overlays, the gaps and the system pages - because a
reader who turns one off after locking is changing the held picture rather than leaving it. This
mode rides along: switched off under a closed lock, it stays off.

What the record holds is the computed order, not merely the switch. `graphFreeze.ts` calls
itself a snapshot of "everything that decides which nodes are drawn and how", and in this mode
the SET is what decides it. `clusterStack` is the precedent: it stores a community's members as
paths although they are derived, because re-deriving them would put the reader somewhere else,
and a ranking is the same case and a more fragile one. Without it the **Live** decision below -
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
no overlay" is a picture that reads. The same invariant is re-imposed wherever the record is
updated rather than trusted to the effect that enforces it, which lands one render later.

The neighbouring rule, settled here so it does not get settled twice somewhere else: on a tab
away with the lock open, the mode stays and the open neighbourhood goes. The switch is a row in
the Overlays block, and the tab-away reset keeps the overlays and the filters while it drops
selection, trail, tag, search, drill-down and depth; the mode belongs to the first list with its
siblings, the neighbourhood to the second with the trail. Locked, neither applies - the return
re-applies the record.

**The lens.** With the mode on, the authority lens counts backlinks inside the DOMAIN rather
than over the whole vault. Two scoping choices, one reason each.

Scoped to the mode, because "it would be more honest in every filtered view" is word for word
the argument this file rejects below for the size ramp, and a document that keeps a discipline
in one paragraph and drops it in the next is not worth reading twice. Counted over the domain
rather than over what is painted, because the ramp is built from the drawn nodes' counts: if an
expansion changed that set, every click would recolour the whole picture under the reader's
hand.

What this costs in code is smaller than it sounds. `authoritySorted` in the canvas already
restricts the ramp's domain to the drawn nodes, and with a paint mask the drawn nodes are the
domain, so the domain needs nothing. What changes is the VALUE: `n.in`, counted over the vault,
becomes the domain-internal count handed in from the screen. The authority legend is built from
the same numbers in `Vault.tsx` and moves in the same step, through the same accessor, or the
legend states a range the colours do not have.

**Node size says the role, not the degree.** In the reading order's picture a landmark is one
size and a connector smallest, and in an open neighbourhood a neighbour sits between them (about
10, 6.5 and 4.5 px against the ordinary 3 to 12 px scale), through the canvas's own `radius()`
so hit targets and label anchors follow. The reason is measured: `3 + min(9, sqrt(degree) *
1.1)` saturates at degree 67, so the top 40 of biomedicine all sit between 8.4 and 12.0 px with
five of them pinned at the cap. Size is a flat scale exactly where importance matters most, and
the rank it would carry is already stated, in order, by the list beside it. Role is the thing
the picture cannot say otherwise.

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
the reader. An open neighbourhood stays open even if its node leaves the set; it closes on the
next click.

**The name.** "Landmarks", one plain noun like its three siblings. "Spine" is taken by the book
spines of the Library room, and the word was carrying a skeleton metaphor that the per-node
expansion turns into a map anyway.

## Where it touches the code

- `web/src/lib/landmarks.ts`, new and pure: the availability rule with its four states, the set,
  the walk with its chapters, the connectors, the tie-break, and `heldLandmarkSet` for reading a
  locked order back against the graph as it stands. Unit-tested on its own like `communities.ts`
  and `graphReveal.ts`.
- `web/src/tabs/Vault.tsx`: the toggle at the top of the Overlays block with its reasons, the
  mode state and the open neighbourhood, the sole-domain test over `selectedDomains` and
  `wingScope`, the paint mask in subgraph indices, the right-hand list, the Escape rungs,
  `resetView`, the page count and the type chips over the painted set, the domain-internal
  in-degrees handed to the canvas, and the `authority` legend read through the canvas's own
  accessor. For the lock: `snapshotFreeze` and `applyFreeze` carrying the nested field,
  `applyFreeze` re-testing availability and dropping only that field when it fails, the effect
  that keeps the record following the how-switches, and the right-hand column's render condition
  (the list whenever the mode is on, locked or not). **Not** the `keep`/`pool` pipeline. The
  `fitKey` IS carried: it frames the landmarks, then one neighbourhood, then the landmarks
  again, then the domain, through the canvas's `fitSubset` and `fitCenter`. That moves the
  camera and posts no layout, which is the half of the Positions decision that was ever
  load-bearing.
- `web/src/components/GraphCanvas.tsx`: the `LandmarkMask` prop and the `painted` rule built on
  it; nodes outside it not drawn at all and kept out of the label budget, `labelReps`, the
  overview and hit-testing; connectors dim and unlabelled outside an expansion; the role-sized
  radius; the Library rim on the selection; the authority ramp reading the handed-in in-degrees
  through the exported `authorityValue`; and `fitSubset`/`fitCenter` on the fit.
- `web/src/lib/graphFreeze.ts`: the one nested `landmarks` field, `v` bumped to 2 so an older
  frozen picture is dropped whole rather than half-applied, the nested object validated field
  by field as this module validates everything else, and the exclusion invariant enforced in
  the parse. `web/test/graphFreeze.test.ts` covers the round trip, a record dropped for the
  invariant, and a dropped `v: 1`.
- `web/test/authorityRamp.test.ts`: the lens has a second source for its value now, and a count
  of zero is a count rather than an absence.
- `GRAPH_SHORTCUTS` in `Vault.tsx`: the list is documentation, and its Escape row names the two
  new rungs. An open neighbourhood is the FIRST of them, ahead of the trail and the tag, because
  it is the innermost thing this screen can hold; the mode itself sits immediately before the
  cluster stack, and every rung below it is inert while it is on.
- The view prefs in `Vault.tsx` (`ViewPrefs`, `loadViewPrefs`, `saveViewPrefs`, `viewMemory`)
  plus `web/test/viewPrefs.test.ts`: the mode is an overlay and persists like its siblings, as
  the DOMAIN it is on for rather than as a boolean, because it is scoped to one. No version
  bump - that loader validates field by field and a missing field already degrades to its
  default. The open neighbourhood does NOT go in: it is exploration, and the prefs hold
  preferences.
- `web/src/styles.css`: the list column, the numbered rows, the chapter rules and their
  captions, the two forms of the heading.

Three changes to the base product came out of this work and are not the overlay's own:

- **the scope line.** The cluster drill-down and the focus used to open a box above the
  workspace, which pushed the panel and the canvas down by 60px apiece at the moment a reader
  had just drilled in. Both are now a line of text at the top of the drawing, with the crumbs
  pressable and an exit at the end; the focus depth moved into the panel, where the controls
  live. The deletion banner went with them, by request.
- **the reading view's link panel**, which is now the explorer's, computed by one shared
  function - and that panel's rows no longer carry three indents where one will do, which is
  37 % more usable width and a quarter less to scroll past.
- **a community caption** that does not fit in the frame is dropped rather than drawn across
  the edge (`placeRegionLabels` takes the visible rectangle).

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
- **"Focus neighborhood" without a depth.** The page detail's own action sets `?focus=` and
  narrows nothing until a depth is chosen, so it shows a control rather than doing the thing
  its name promises - measured, outside this mode as much as inside it. One line would fix it
  (set the depth with the focus, as arriving by URL already does), and it belongs to the focus
  rather than to this overlay.
- **Depth 2 on a vault with hubs.** Its breadth-first walk runs over every edge, including the
  index and log pages, which connect almost everything in two hops: measured here, depth 1
  draws 7 pages and depth 2 draws all 1320. Also the focus's, not this overlay's.

## Chunks

All five are done. No chunk counted as done until `npm test`, `npm run typecheck` and
`npm run lint` all passed and exited 0 - all three, because `tsconfig.build.json` excludes
`test/` and vitest does not typecheck, so a green suite is not a green repo.

1. **`lib/landmarks.ts` and its tests.** The availability rule, the set, the walk, the
   chapters, the connectors, as pure functions over nodes and edges. Fixtures small enough to
   reason about by hand, plus one that reproduces the finance case: chapters that no connector
   joins. **Done:** the fixtures pass, ties are shown to be broken deterministically, and a run
   over the live vault reproduced the measurement table exactly - 40 landmarks for biomedicine
   in 36 + 3 + 1 closed by 2 connectors, finance 9 in 7 + 2 that no page joins, five of the ten
   eligible domains a single chapter.
2. **Canvas.** The painted set, connector rendering, the expansion set, the role-sized radius,
   and the authority ramp over handed-in in-degrees. **Done:** in the running app the switch
   draws the landmarks and their connectors alone, labels nothing else, shows three
   distinguishable sizes, and moves nothing - read off the worker rather than off the eye, with
   a temporary counter in `postMessage` and `onmessage` staying flat across a switch and across
   an expansion.
3. **Screen.** The toggle with its reasons, the paint mask, the mode exclusions, the Escape
   rungs, `Reset filters`, the freeze fields. **Done:** each state of the toggle says why;
   turning the mode on turns the others off; a second domain turns the mode off; Escape peels
   the neighbourhood and then the mode; `Reset filters` clears both; a freeze taken in the mode
   comes back in the mode with the same order and the same open neighbourhood; a record pairing
   the mode with Spotlight, a drill-down, a depth or a query is dropped whole; a record whose
   domain has since fallen under the bar comes back with everything but the overlay; a `v: 1`
   record is dropped whole.
4. **The list.** Right column, the rules and their captions from the second chapter on, up and
   down, selection synced both ways with the canvas. **Done:** up and down walk the chapter
   order across the rules, the existing Enter opens the selected page without a new binding, a
   click on the canvas moves the list's highlight and the reverse. Locked: the list is still
   there with no highlight on it, a click on an entry or on a landmark opens the page, an
   expansion that was open when the lock closed is still painted, and Escape from the page
   comes back to all of it.
5. **Measure it.** Photographed against the live vault (biomedicine, finance, cooking); the
   numbers are below. The pictures were taken with `?labels=off` and kept under `docs/local/`,
   because this repo is public and the vault is not (hard rule 7) and this repo's own
   convention is that everything under `docs/img/` comes from the synthetic vault.

## What the running app measured (2026-09-22, chunk 5)

Against the live vault, through the real screen, `?labels=off`.

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

The layout was asked for nothing throughout: 5 posts and 170 frames before the switch, the same
after it, and the same again after four expansions.

## Findings

**1. A landmark's neighbours include other landmarks.** The expansion was capped at 12 "ordered
by domain-internal backlinks", and the landmarks are by construction the highest-ranked pages of
the domain, so they crowd the front of every neighbour list and a cap taken off the top of it is
spent on pages already on screen.

| Measured | Result |
|---|---|
| Which population the recorded neighbour numbers count | all domain-internal neighbours, landmarks included: that reading gives median 22 and max 129 exactly, and is the only one under which "all 40 above a cap of 12" holds. Excluding landmarks gives median 17, max 109, and seven of the forty at or below 12 |
| Of a biomedicine landmark's top 12 neighbours, how many are themselves landmarks | 5.1 on average, leaving 6.9 pages a click actually reveals |
| The worst case, and where it fell | the FIRST entry of the list - the strongest page, the one a reader clicks first - had all 12 of its top neighbours already painted. That click changed nothing on screen |

Resolved twice: first by capping what the expansion ADDS, then by dropping the cap altogether
once the click began to re-frame. What survives is the measurement, and the rule it taught -
that a set defined over "the domain" and a set defined over "what is on screen" are different
sets, and a number stated about one of them has to say which.

**2. The list was right and the picture was not.** Reported as "the sidebar shows articles that
are not part of the expansion". Audited rather than argued: for every landmark of the three
domains this file measures, the entries the sidebar listed were compared against the neighbours
the graph payload itself gives, computed a second time and independently of the module.

| Domain | landmarks | lists disagreeing with the payload | entries that are not a direct link |
|---|---|---|---|
| biomedicine | 40 | 0 | 0 |
| cooking | 10 | 0 | 0 |
| finance | 9 | 0 | 0 |

The list named nothing it should not have. What was wrong was the PICTURE: while an open
neighbourhood only dimmed its surroundings, the set it lit left out the neighbours that happen
to be landmarks or connectors in the other view - they stayed drawn in their own role and were
greyed down with everything else. The list named them, the drawing greyed them, and the reader
is right to read that as the list naming something outside the expansion. Both halves are one
set now: 27 painted nodes against 26 list rows, the one extra being the selection ring.

**3. A node's SCREEN position moves when the list opens, and the mask is not what moves it.**
Chunk 5 asked for "a node in the same screen position before and after the switch". Measured
against the live vault it is not, in any of the three domains: 0 of 42, 0 of 9 and 0 of 11
painted nodes land within half a pixel, with medians of 12, 62 and 29 px.

The layout is not what moved them. Across every one of those switches the layout worker was
asked for nothing and answered nothing - posts 5 → 5, frames 170 → 170 - which is the observable
form of the **Positions** decision and the thing that decision actually turns on. What moved is
the CANVAS: the list opens in the right-hand column and takes 340 px of the drawing's width, so
the canvas re-frames to the room it has left. Isolated by opening that column first: with a page
already selected, the same switch moves 26 of 43 painted nodes by nothing at all and the worst
by 1.70 px, which is the node's own radius changing under a centroid.

So the criterion holds of the mechanism and not of the pixels, and the difference is one the
screen already has: clicking any node opens that same column and re-frames that same way.

**4. The rank at the head of a neighbourhood was read as a count.** The head row carried the
landmark's place in the reading order in the same number column the full list uses - "37" over a
list of 21 entries - and it was read as "37 entries", which is the only other thing a number
over a list can mean. Nothing was wrong with the figure; the column was carrying a meaning it
could no longer imply, because the forty rows that made it a rank were not on screen. The rule
it leaves behind outlasts the fix: in this list a number stands bare only where the column
itself says what it counts.

**5. `vault-name-scan --diff` reads commits, not the working tree.** It runs
`git diff --text <base>...HEAD`, which is correct for its documented purpose - what a merge
would add, checked before a PR - and worthless as a pre-commit check: it reports "nothing
matched" while a real page title sits uncommitted in the working tree. Two of them reached a
code comment and this file that way, both removed. Before a commit, build the pending lines by
hand (`git diff HEAD | grep '^+' | grep -v '^+++' > pending.diff`) and scan them with `--file`;
after it, `--diff main` for the branch. Neither sees what CLAUDE.md hard rule 7 already names as
the structural gap: a subject that lives only in the database carries no page title.
