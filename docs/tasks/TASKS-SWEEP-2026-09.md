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

- `SPEC.md` section 8 still lists the job lifecycle without the `hold` column (v24) and
  the `night_released_at` timestamp beside it (v26); a line saying that a held job is a
  queued job waiting for the night shift, and that a released one keeps its place in the
  night's queue until its commit is made, belongs there, once the spec is opened for edits.
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
- [x] Follow-up (2026-09-11). In an opened record's foot, Revert ingest stands before Remove
      from history, and both wear the foot's one button shape (measured: same border,
      ground and height as the two doors). Reading the log, the pane is a column and the log
      takes what is left of it (344px of a 386px pane), scrolling inside itself, instead of a
      320px box over empty space.
- [x] Follow-up (2026-09-11). `/graph?select=<path>` is the graph's second door: the page
      is selected in the whole graph (the explorer opens on it, nothing is narrowed, and
      whatever would hide the node steps aside), the param is consumed. A record's "Graph
      view" and the Catalog's "In graph" use it; they used to land in focus mode. The
      record's Article | Log toggle wears the headline's grey, and the Catalog's article
      takes the pane's width. Measured: both doors arrive at `/graph` with no focus bar and
      the page's title in the explorer; the article body is 1251px of a 1306px pane.
- [x] Follow-up (2026-09-11). The night shift's subtitle leads with the hours ("23:00 to
      02:00"), then the ingest queue and the rest, in slots of their own widths. An address
      a page cites without its scheme (`publisher.example/posts/…`, the way a source page
      lists its further reading) links as https wherever text is linkified (the article view, the
      log); a dotted name without a path stays text, so file names never link. Measured:
      the four cited addresses of a source page are links in the record's article, and a
      315-line log gains no false link.
- [x] Follow-up (2026-09-11). The Graph's and the Catalog's bar say the domain in the
      middle: a dot in the domain's colour and its name, prominent, at the bar's true centre
      (left and right groups share the rest in equal halves, the headline's rule). The text
      starts flush left in a block of one width behind a fixed lead, so switching domains
      makes the heading longer or shorter and never moves its start; a long name runs right
      and is cut. One domain is named, several are a count ("2 domains"), nothing picked
      names the wing in front while the list is by wing (the view IS narrowed to it) and
      says "all domains" otherwise, with a hollow ring where no one colour applies. The
      count sentence lost its tail (the narrowing in words, the hidden system pages, the
      gaps door - the panel says all of it): the Graph says "Showing N of M pages and L
      links", the Catalog "Showing 4 of 529 concepts". The Shortcuts button left the bar
      for the drawing's bottom-right corner, a pill like the trail's crumbs, its panel
      opening upward; the legend and the layout status step up above it. Its rows match the
      handlers again (click selects, Enter also takes the search's one match, the Escape
      ladder in order, the wing keys, a plain wheel zooms). The Library's Graph | Catalog
      toggle wears the ink grey. Measured: the name starts at x=889 in every state of both
      tabs (a wing, one domain, two domains, all domains, a 24-character name), the dot at
      872, the search at 1275 in both; the corner button sits 12px and 10px from the edges,
      its panel 8px above it inside the drawing with 11 rows, the legend 8px above the
      button; the toggle's selected half has the same ground as Focus | Full.
- [x] Follow-up (2026-09-11). In the Catalog, up and down walk the table's rows, the
      Research ledger's mechanic: the rows are already the focusable, Enter-openable things,
      so the keys only move focus between them (from anywhere on the screen the first press
      lands on the first or last row, the walk wraps at both ends, the row scrolls into
      view), scoped to the Catalog's own table and off while a page is open or the caret is
      in a field. The foot says so ("↑ ↓ walk the rows"), and "← → step the wing" stands
      there only while the domains are listed by wing, since only then are the keys bound.
      Measured: three presses land on rows 0, 1 and 703 of 704 with the ring on the row,
      Enter opens the row's article and Escape returns, an arrow in the search field stays
      there; the foot shows four hints by wing and three with "show all".
- [x] Follow-up (2026-09-11). The domain section's head (Graph and Catalog) is 222px, and
      "× Clear" beside the 148px toggle came to 291px once a domain was picked: the toggle
      gave way and its two halves drew over each other. The clear action is now the × alone,
      square in the head's height, beside the label it clears (tooltip and accessible name
      "Clear the domain filter"), and the toggle is 122px at the head's right edge with no
      spacer element (one would cost a gap of its own). Measured: with and without a
      selection, in both tabs, the toggle is 122px with 57px halves, neither label clipped,
      its right edge at the head's right edge, the × 24px, nothing overflowing.
- [x] Follow-up (2026-09-11). Home, four things. Up and down walk the stream's rows while
      the list shows (the Catalog's mechanic: focus moves between the rows, the first press
      lands on the first or last row, the walk wraps), and still step the records while one
      is open; the foot says "↑ ↓ walk the rows" and "Enter opens a row" in place of the Tab
      hint (Tab still walks them). The stock band leads with the picture: the graph first at
      the half it had, the figures in the middle at their 244px, the domains where they
      were; the figures are set apart by one fine line each, the padding in place of the gap
      so the line stands halfway between two rows. A record's facts are set apart by lines
      (they are default-size facts in a lead strip, and the strip's line was on the lead
      size only), and a sixth fact carries the commit hash; the foot says only when the
      record finished. Measured: three presses land on rows 0, 1 and 8 of 9; the zone is
      531 / 244 / 531 with a line on each side of the figures and on five of six rows; the
      foot's five hints are 593px in a 1306px foot with no overflow; six facts of 218px with
      a 1px line after each but the last.
- [x] Follow-up (2026-09-11). In the stream, a job held for the night wears a crescent
      where the other rows wear the status dot: the amber dot said "waiting", and a night
      job waits for something the row should name. The glyph keeps the dot's 8px slot (so
      the names stay in one column), is drawn at 13px and solid so it reads at row size, and
      wears the tonight chip's quiet tone. Measured against an injected held job beside a
      plain queued one: both markers occupy an 8px slot at the same x, the crescent is a 13px
      filled glyph with no stroke, and both names start at the same x.
- [x] Follow-up (2026-09-12). The night's ingest queue in the Library empties one job at a
      time, not all at once when the shift begins. Releasing a held job used to clear its
      hold and leave no trace, so every row vanished the moment phase 0 started, though none
      had run. Now `release` stamps `night_released_at` (schema v26), the scene carries every
      stamped job whatever its status (with `night: true`, one row per id), and the queue
      clears the stamp when a worker is through with the job - which is after the commit
      step, since `done` is written before the commit is made. A job queued again by a
      transient failure or a usage-limit pause, or waiting on a preprocess retry, keeps its
      place; a permanent failure, a deferral, a duplicate and a cancel (the store, at the
      transition) end it. The rows say where each job stands (released and waiting its turn,
      running now, run finished and committing), and only a job still waiting can be
      removed - a running one is left to finish, as the row says. Covered by tests on the
      store (release stamps, cancel clears, done keeps), the scene (stamped rows stay
      through done, an unstamped done row is history), the queue (through after the commit,
      kept across a retry, dropped when it gives up) and the schedule model (phases).
- [x] Follow-up (2026-09-12). One of the night's five ingests failed on the fetch: the
      publisher answers automated requests with HTTP 403 (bot protection in front of a
      public post). The user saved the page from the browser and dropped the `.htm`, which
      ran to a good source page - but the file passed through as text, so the agent ran
      defuddle by hand, could not read its own scratch output, and wrote the extraction into
      the vault root to read it back (removed before the commit). Two changes: a saved page
      (`.html`, `.htm`) now takes the fetched page's extraction in preprocessing (defuddle,
      else the built-in fallback; a junk extraction falls back to the passthrough rather
      than failing the user's own file), with the page's own address (canonical link, else
      Open Graph URL) as the manifest's `url` and a "Saved from:" line; and a 401/403 fetch
      fails with a line that says what to do (save the page from the browser and drop the
      file). Spec: SPEC.md section 5 lists text as passthrough and the web row's extractor;
      a saved page is the web row's material, so this reads as the same rule, not a new one.
      Observed, not changed: the shift counted "4 of 5 done" although all five ended done -
      the count is taken when the queue first turns idle, and one job was between attempts.

## Third sweep (2026-09-17)

The round after the main room was refurnished (`TASKS-A6.md` section 11): two graph and research
mechanics asked for by name, and a sweep over Home and the Catalog with the Library and the
graph as the measure - harmonise, remove what repeats, tighten the guidance; no rebuild. Mockups
were the real app over the Vite dev server against the synthetic vault, shot through the headless
browser, and the two Home variants and the Catalog column were decided from those sheets.

- [x] **The graph's lock.** A padlock in the canvas's bottom left corner holds the picture on
      screen (`web/src/lib/graphFreeze.ts`, `Vault.tsx`). Three parameters were put as choices
      and decided: the filter panel stays usable while the lock is closed and every change is
      an excursion the next Escape returns from (not greyed, not hidden); the lock lasts for the
      browser tab (sessionStorage: a reload keeps it, a new tab starts open); Escape re-fits the
      held nodes rather than restoring the exact pan and zoom. While closed, the explorer panel
      stays away and one click on a node opens its page. The record is read back field by
      field, tested; twenty browser checks walk filter change, article round trip, tab away,
      reload and unlock.
- [x] **The Research ledgers' search folds behind a magnifier**, the graph's and the Catalog's
      slot: `/` opens, Escape clears and then folds, folding clears the text, a mode switch
      starts the other ledger folded. Written down in `web/DESIGN.md` as the rule for every
      search a bar or a head carries.
- [x] **Catalog column, in the graph's shape.** The type filter is one row per type with the
      type's colour dot and the count at the right edge, exactly the graph's page types, and
      without the "All" chip (a picked row again is every type; the head says `all`). Sort by is
      three paired strips, the graph's View section, with the direction arrow in the lit half:
      by when or by name, by what kind or what field, by weight or by where it came from. The
      reset moved from the headline into the head of the first filtering section, Home's rule,
      and shows only while something narrows the list, so the count sentence never moves. Two
      hint lines went (the sort's and the source types', both restating the picked pill); the
      subset's stays, since orphans and stubs need their words.
- [x] **Home.** The search folds behind the magnifier like everywhere else. The six lead facts
      under the headline are gone (variant B of the sheet, chosen over keeping them): what they
      said lives where it already lived - the count in the foot, running and failed in the state
      chips, spend and due checks in the System tab and its badge. Only the seven-day ingest
      figure has no place afterwards, and that was accepted. The legend under the constellation
      said `questions` where the Catalog and the graph say `Research`: the three label maps are
      one now (`web/src/lib/buckets.ts`). The foot no longer repeats the headline's date.
- [x] **Kept, on purpose.** The day's arrows in Home's headline (the strip's arrows went for the
      pills, but a date has no pills); the subset hint; the graph's own "Reset filters | Fit
      graph" strip at the top of its column, which resets more than filters and pairs with an
      action the Catalog has no counterpart to.
- [x] README's Home and Catalog images re-shot from the synthetic vault; the Home shot's settle
      condition now waits on the band's figures rather than on the facts that are no longer
      there.
