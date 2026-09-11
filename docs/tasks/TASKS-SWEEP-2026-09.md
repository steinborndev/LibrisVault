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

## Left open

- `SPEC.md` section 8 still lists the job lifecycle without the `hold` column; a line
  saying that a held job is a queued job waiting for the night shift belongs there, once
  the spec is opened for edits.
- The reading list's three-way toggle treats an entry's side as its access alone; a
  paywalled paper the user fetched by hand stands under "paywalled" with its vault link.
