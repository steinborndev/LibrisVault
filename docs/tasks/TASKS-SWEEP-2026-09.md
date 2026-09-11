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
