# Tasks: the September sweep (2026-09-11)

A list of changes across Home, Research, Library, Graph and Catalog, split into seven chunks
that are each testable on their own (server tests, web tests, Playwright measurement of the
rendered app). The design questions were settled up front; the answers are recorded here so
the chunks can be built without reopening them.

## Chunks

1. **CSS and labels.** The Research tab's mode toggle clipped its buttons (a 28px pill with
   3px padding holding 26px buttons); the Library's Focus/Full toggle wore the research
   violet; "Manage Fellows" becomes "Night shift" with a tooltip that says what is behind it,
   and the window it opens is called that too; the Home headline writes the year in full;
   the reading list's "Show paywalled" chip becomes a three-way toggle.
2. **Plan usage.** The card never disappears once a window was measured: the last sample is
   shown with its age and the reason no newer one exists. Back in Library and Research, new
   as the fourth section of the Home column.
3. **Home navigation.** The Days section leaves the column. Left and right step one day in
   both views (days that have something in the view in front; always exactly one day, today
   first); PageUp and PageDown step seven days; up and down keep walking records only; the
   view is switched by its toggle, not by a key.
4. **Domains by wing.** One domain section for Graph and Catalog. "showing all" becomes a
   switch between "show all" and "by wing"; in wing mode the wing is the filter (graph and
   catalog show its domains, a domain click narrows further), small arrows and the left and
   right keys step through the wings, and the section's search runs across all wings and
   jumps to the wing of a hit. A wing is a Library room, main room first, then the wings in
   the user's order; unplaced domains form a last group.
5. **Graph search.** The result list takes precedence over the minimap (the minimap hides
   while the list is open); a click outside collapses the list and keeps the filter.
6. **Night shift ingests, server.** A hold flag on the job (status stays `queued`; no new
   lifecycle state; the whole job waits, preprocessing included). Phase 0 of the shift
   releases the held jobs and waits for the queue to drain; the Fellows get what is left of
   the window (a run with no room is skipped with its reason, as today). A manual shift start
   takes them along; a job added after phase 0 waits for the next night. The Fellows' budget
   counts agent runs only, so ingests do not touch it. The estimated duration is the median
   per job type from the job history once three finished, else a default per type.
7. **Night shift ingests, web.** "Add to night shift" as the second Home column section (a
   copy of the add box); "Ingest queue: N" as the first fact of the window's subtitle, always;
   grey blocks (width = estimate) at the start of the active-hours bar and ahead of the
   Fellow bands in every domain view; an "Ingest queue" section with one row per job and a
   Remove button (rows are tab stops, Delete removes, a block click marks its row); removing
   cancels the job through the existing route; held jobs show in the Activity stream as
   queued with a "tonight" chip.

## Finding: plan usage is not a layout regression

The card's markup never left the Library or the Research tab. `planCorner` returns null when
the plan is not `available`, and since the usage endpoint stopped being polled with a
long-lived token (2026-09-07, "stop knocking at a locked door") the only samples come from
Fellow runs, and a sample counts as available for a day. No Fellow ran after 2026-09-10 in
the morning, so the card was gone by the next morning. Chunk 2 changes what the card does
with an old sample, not where it is.

## Done

- [x] Chunk 1 (2026-09-11). The Research toggle's buttons are 22px inside a 28px pill with
      2px padding; `.seg.ink` is the shared grey selected state (Library headline, reading
      list); the reading list toggle is `open source | paywalled | both` in equal thirds,
      `open source` = open access plus unknown hosts, `paywalled` = paywalled plus what a run
      could not reach, an entry's side never changes because it was fetched by hand; the
      headline date reads `06 Sep 2026`; "Night shift" with its tooltip, and the window's
      overview carries the same name.
- [x] Chunk 2 (2026-09-11). `planCorner` returns a reading whenever a window was ever
      measured; the age reads in minutes, hours or days, and an unavailable sample carries the
      service's reason as the tooltip. The card is one component (`PlanCard`) in the Library's
      corner, the Research rail and, new, the last section of the Home column.
- [x] Chunk 3 (2026-09-11). Home's time axis is one day: the Days section and the week label
      left the column, the headline names the day, left and right step to the nearest day the
      view in front has something on (today is always a stop, the future never), PageUp and
      PageDown land on the nearest stop at least a week away or the far end, up and down keep
      walking records, a day step closes an open record, Escape no longer clears the day. The
      view is switched by its toggle only. Measured in the browser: the headline slot stays at
      one position across every step; a `?filter=` jump lands on the day of its newest match.
- [x] Chunk 4 (2026-09-11). One `DomainSection` for the Graph and the Catalog, over
      `lib/wings.ts` (main room, the wings in order, then what is not shelved; shelf order
      inside; a room with none of the screen's domains is skipped). "showing all" is the
      switch to "by wing"; the wing narrows the graph and the table until a domain is picked,
      the arrows and the left and right keys walk the rooms (only on the screen in front,
      never over a field), turning the page drops a pick outside it, the search runs over
      every room and turns the page to the first hit. Measured in the browser: the graph's
      scope sentence names the room and its page count follows the walk; the catalog's table
      does the same.
- [x] Chunk 5 (2026-09-11). The graph search's result list is open while the field is in
      use and closes on a click anywhere else; the filter stays, and focusing or typing opens
      the list again. While it is open the minimap steps out of sight, and the canvas bar
      stacks above the minimap in any case. Measured in the browser: after the outside click
      the field still holds the text and the scope sentence still says "matching".
- [x] Chunk 6 (2026-09-11). Schema v24 adds `jobs.hold`; a job created with `hold =
      'night'` stays `queued` but is never claimed, does not keep the queue awake, and a held
      batch is not a pending unit until its release rebuilds it from the rows. `POST
      /api/v1/jobs?when=night` holds any of the three inputs. The shift's phase 0 releases the
      held jobs right after the reading-list reconcile, waits for the queue to drain, and
      records `summary.ingests = { released, done }`; a manual shift takes them along, and a
      job held after phase 0 waits for the next night. The scene's jobs carry `hold` and
      `typicalMs` (the median of finished ingests of the type once three exist, else a
      reference size per type read off the first vault's history).
- [x] Chunk 7 (2026-09-11). Home's column has four sections: "Add now", "Add to night
      shift" (the same box, posting with `?when=night`), the Fellows and the plan. A held job
      shows in the Activity stream as queued with a "tonight" chip and the row's own Cancel.
      The night shift window leads its subtitle with "Ingest queue: N" in both views, draws
      one grey block per held ingest at the window's start in the active-hours bar (above
      the window's tint, below its handles) and ahead of every band in a shelf's queue,
      which the Fellows' schedule now starts after, and lists them in an "Ingest queue"
      section with the type, the estimate, when they were added, their start and a Remove
      button; the rows are tab stops, Delete removes, a click on a block marks its row, and
      removing cancels the job through the existing route. Checked in the browser against
      injected held jobs: the facts, the block positions, the band order and both removal
      paths.

- [x] Follow-up (2026-09-11). Home's foot says how to move in both views (the recap foot
      used to say when the next build is; that moved into the Build now tooltip), Build now
      wears the accent's ring, the headline date has an arrow on each side that steps the day
      like the keys do (disabled at the ends), and the two add boxes explain themselves on
      hover. The view toggle's tooltips no longer promise the left and right keys.

## Left open

- `SPEC.md` section 8 still lists the job lifecycle without the `hold` column; a line
  saying that a held job is a queued job waiting for the night shift belongs there, once
  the spec is opened for edits.
- The reading list's three-way toggle treats an entry's side as its access alone; a
  paywalled paper the user fetched by hand stands under "paywalled" with its vault link.

## Second sweep (2026-09-11, evening)

A second list, split the same way and settled up front:

1. **Home stream.** A trash at the right edge of every row, always visible (the hover-only
   x is gone): it cancels a queued job, removes a settled job or run, takes a commit off the
   stream through a server-side list of dismissed hashes (schema v25; the vault keeps the
   commit), and is disabled with a reason on a run or ingest in flight and on the per-kind
   settle records the service keeps for itself. First click arms it, the second acts. Rows
   share one height. An ingest row's chips count the same pages the record lists (index
   hubs left out). Log lines link their addresses. Both foots stand in three zones: what is
   shown, the keys (bars between them), the one action, and Build now and Clear history are
   one width, with a short armed label.
2. **Opened entry and the graph article.** "Graph view" and "Catalog view" pills; an article
   view inside the Catalog tab (`/catalog/page/<path>`); "In catalog" beside "In graph",
   Obsidian in the ⋯ menu, a title of at most two lines, no Esc hint; the Library answers
   Escape without a click first.
3. **Domain section v2.** No filter box; a "by wing | show all" toggle of equal halves in
   place of the switch word; by wing by default; the choice and the wing remembered per tab.
4. **Catalog.** TITLE and TYPE columns, a "Type" section, a headline like the graph's:
   "Showing N of M" on the left behind a slot as wide as the graph's Fit button (the Reset
   button stands there when a filter is set), the search on the right at the graph's x.
5. **Research tab.** One column for both modes with the lens greyed and explained under
   Vault Research; a blue Start run / Ask; a search box in the ledger's head with the count
   in its placeholder; the trash instead of the hover x.
6. **Night shift, spawn, reading list.** The night's estimate counts the held ingests and
   says when only the Fellows are held by the reserve; a Fellow spawned from a shelf keeps
   that domain; the lens dropdown reads "lens - what it reaches for" from a short line the
   server carries per lens; the reading list's lede is one line.

### Done

- [x] Chunk 1 (2026-09-11). Measured in the browser: every row carries the trash (two
      disabled with their reason on a busy day), plain settled rows are 42.5px each, the
      keys line is centred on the foot in both views (same x), Build now and Clear history
      are 118px at the same x, an overflow row's count equals the record's list, and the
      commit trash arms and posts the dismissal.
- [x] Chunk 2 (2026-09-11). Measured in the browser: the opened entry's foot offers "Graph
      view" and "Catalog view"; the Catalog reads a page at `/catalog/page/<path>` (its rows
      open there too, wikilinks stay in the tab, Escape returns to the list); the graph's
      article head has "In catalog" beside "In graph", Obsidian in the ⋯ menu, no Esc hint,
      and its buttons stand at the same x under a 4-character and a 218-character title
      (the title takes two lines and an ellipsis); the Library closes a shelf on Escape
      straight after arriving from Home, with nothing focused.
- [x] Chunk 3 (2026-09-11). The domain section's filter box is gone; a "by wing | show all"
      toggle of two equal halves stands in its head, by wing is the default, and the choice
      and the wing are remembered per tab (localStorage). A domain picked elsewhere turns the
      page to its room. On the way, the Catalog's consumed `?domain=` sent the address bar to
      `/library`, a stale target from before the tab moved; it goes to `/catalog` now.
      Measured in the browser: a fresh load opens on the first room in both tabs, the walked
      room and the mode survive a reload, and a domain of the last room lands on that room
      with its row marked and the table narrowed.
- [x] Chunk 4 (2026-09-11). The Catalog's box wears the graph's bar: a first slot of one
      width on both screens (Fit there, Reset or an empty stand-in here), "Showing N of M
      pages" or "N of M concepts" with the narrowing in words, and the search at the right
      edge; the Find section left the column. The table's first column is headed "Type" over
      the badges and "Title" over the names; the column's section is "Type". The foot keeps
      the keys and the Deepen button. Measured: the bar, the slot, "Showing" and the search
      box stand at the same x and width in both tabs; the two headings sit exactly over the
      badges and the names.
- [x] Chunk 5 (2026-09-11). The Research column is the same three sections in both modes,
      measured at the same heights; under Vault Research the lens section is greyed, its
      buttons disabled and its head explains why on hover; "gaps worth a run" stands in both
      modes and turns a vault question to web research first. Start run and Ask are the
      accent blue with white letters at the console's unchanged size. The ledger heads carry
      a search with the count in its placeholder and "N of M" while narrowing; a miss says
      so in the empty state. The run rows carry Home's trash; the session rows carry it
      beside the hover pencil.
- [x] Chunk 6 (2026-09-11). The night shift's estimate counts the held ingests with the
      Fellows' tasks, says "nothing to run" only when both are empty, and names the reserve
      as holding the Fellows alone when ingests still run. A Fellow spawned for a shelf keeps
      that domain as a fixed field with the reason on hover; the lens dropdown reads "lens -
      what it reaches for" from a short line each lens carries on the server (under 45
      characters, served with the profiles), with the form's own list as the fallback while
      it loads. The reading list's lede lost its measure and stands on one line. Measured:
      the night line says "57 min estimated" over 4 tasks and 3 held ingests, the spawn form
      from a shelf shows the domain fixed and four one-line lens options, the lede is one
      line at 913px.
- [x] Follow-up (2026-09-11). The When column is right-aligned by its class, not by its
      position: a live row spans two columns with one cell, so its sixth cell was the trash
      and its When text sat left. A waiting job keeps a Cancel of its own in the cost cell,
      at the trash's height, so the row stays as tall as the rest; the trash cancels it too.
