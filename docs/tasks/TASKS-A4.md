# TASKS-A4 - Library screen (2026-09-06)

Goal: the vault as a library and the service's activity as people working in it, one room
per view on the shared grid, the existing runs animated with zero Fellows, the Fellows on
top, and the Fellow card reachable by click and deep link. A renderer over data the service
already has; it costs no tokens. **Acceptance (docs/agents/SPEC.md section 15): existing
runs animate with zero Fellows; the card opens by click and deep link; `npm test` green on
both sides.**
**Status 2026-09-06: done.** 827 server and 290 web tests green; the scene endpoint over the
demo vault places 17 departments into two wings, the rooms render with the existing runs
and the Fellows, the card opens by click and deep link (section 3).

Extension milestone in the Curious fork (branch `research-agents`). The screen ships behind
`AGENTS_ENABLED=1` like the rest (section 4.1); with the flag off the dashboard keeps its
five tabs, with it on the Library tab appears and the table view moves to Catalog.

## 0. Decisions while wiring A4

- **D1 - assets.** The sprite test's decision stands (OPEN-15): style A, flat vector figures
  drawn from the dashboard tokens, no faces (NEW-6), the pose vocabulary of the Sprites
  artboard (stand, wait, shelf, desk, shelve, carry, cart, clipboard, sit, sleep). The
  figures, bookcases, furniture and rooms are the design generator's drawing code
  (`docs/agents/design/library-screen/gen.mjs`) ported to React SVG, so the screen and the
  mockups are one drawing. No sprite files, no canvas element: one SVG per room, elements in
  painter's order by depth.
- **D2 - the scene is built in the browser.** `GET /library/scene` returns what only the
  server knows: the rooms with their placed shelves and the department counts (books and
  thin volumes from the graph), the Fellows with their current run, the runs and jobs in
  flight, and whether it is night. Poses come from the live log lines the dashboard already
  streams (section 10.2's tool families), exits from runs the screen saw settle. Nothing in
  the scene is stored.
- **D3 - placement is persisted only where decided or auto-decided.** `library_layout` rows
  hold a domain's room and slot; the scene builder places every domain without a row: the
  first free slot of the newest wing, a new wing (named after its letter) when none is free,
  written with `placed_by: auto` so a shelf never jumps. The main room's four favorite
  slots are filled only by the user. `unassigned` and `meta` are not departments.
- **D4 - moving shelves.** `POST /library/move` with a domain and a room: to a wing it takes
  the first free slot, to the main room the first free favorite slot, with a `slot` it swaps
  with the shelf there. The dashboard drags with pointer events (a shelf onto a room pill,
  a room in the list, or another shelf) and the Departments list offers the same moves as
  a menu, so the feature works without a mouse.
- **D5 - what animates.** Figures move between anchors (front desk, a shelf's slot, a desk,
  the door, the armchairs) with a CSS transition on their group; a settled run keeps its
  figure for a few seconds in its exit pose (shelving and leaving, sleeping, the marked
  book) before it disappears. The screen keeps that memory itself; nothing is persisted.
- **D6 - day and night.** The real clock (OPEN-20): night look during the night window and
  from 21:00 to 06:00 local; the now chip says which.
- **D7 - the card.** `/library?agent=<id>` docks the Fellow card beside the canvas; a click
  on a figure or a list row navigates there. The card reads `GET /agents/:id/card` and the
  run's live log channel for the phase bar and the log tail; its actions are the A0 to A3
  endpoints (step, pause, resume, veto the next plan, retire, notebook, ledger filter).
- **D8 - focus mode.** `Full | Focus` on the canvas hides the control column, the box head,
  the legend and the card; a click on a Fellow opens the popover with "Open card" and
  "Pause". Focus follows the active Fellow's room.
- **D9 - Catalog.** The table view keeps its code and route parameters and moves to
  `/catalog`; every link that meant the table now says Catalog. The palette gets both.
- **D10 - graph link.** A shelf click opens `/graph?domain=<key>`; the graph reads the
  parameter into its domain filter once.

Findings while building:

- **F1 - no browser on the build machine.** The visual check used a server-side render of
  the React SVG with the real scene snapshot plus synthetic activity, rasterized with
  ImageMagick, whose SVG renderer knows neither pattern fills nor quoted font families; a
  flat-fill copy of the SVG stood in for the floor and walls. The geometry, the painter's
  order, the signs (two lines at the hyphen), the books per department, the furniture and
  the figures with their tags all match the design mockups; the browser draws the stone
  floor and the panelled walls from the patterns.
- **F2 - the graph's domain filter had no URL form.** `/graph?domain=<key>` now seeds the
  domain chips once (D10); the graph keeps its own preference from there.
- **F3 - the old table view's deep links.** Home, Chat and System linked `/library` and
  `/library?domain=`; every one now says Catalog, and a bookmarked `/library?domain=` is
  redirected to the Catalog filter it always meant.

## 1. Server

- [x] Migration v19: `wings`, `library_layout`.
- [x] `db/library.ts`: wing and placement stores; the pure placement of D3.
- [x] `pipeline/library.ts`: the scene, wings CRUD (create, rename, reorder, delete when
      empty), move and swap.
- [x] Routes `GET /library/scene`, `GET/POST /wings`, `PATCH /wings/:id`, `PATCH /wings/order`,
      `DELETE /wings/:id`, `POST /library/move`; wiring behind the flag.

## 2. Dashboard

- [x] Catalog: rename the table view and its route; links; palette; the Library tab appears
      with `health.fellows`.
- [x] `lib/library/`: isometric projection and painter's order, the room model (grid, slots,
      anchors, favorites), the scene adapter (activities and Fellows to actors with poses,
      props and exits), the sign break.
- [x] `components/library/`: the room SVG (floor, walls, door, furniture per room kind,
      bookcases with books and spare silhouettes, figures with tags), the room strip, the
      Fellow card, the popover, the spawn form.
- [x] `tabs/LibraryScreen.tsx`: control column (Fellows, Rooms, Departments), the canvas box
      with Full/Focus, room paging by wheel, keys, strip and list, drag and drop, the docked
      card, deep links `?agent=` and `?room=`, the now chip and the legend.
- [x] Graph domain parameter.

## 3. Tests and validation

- [x] Server: placement (first free slot, new wing, favorites only by hand), wings rules,
      move and swap, the scene with zero Fellows and with runs.
- [x] Web: projection and depth order, scene adapter (poses from tool families, job states,
      exits), sign break, placement rendering helpers.
- [x] Real check in the dev instance: the scene endpoint over the demo vault, the screen
      with the existing Fellows and a running step; recorded here.
      - `GET /library/scene` over the demo vault (2026-09-06): 17 departments in registry
        order, auto-placed into Wing A (12 shelves) and Wing B (5), 857 books and volumes,
        47 gaps, 26 unfiled pages on the intake cart, both Fellows with state and next
        proposal, no run in flight (day). A wing round trip through the API: create, rename
        to "Humanities", move a department into a favorite slot (placed by the user), move
        another into the new wing, delete refused while it holds a shelf (409), allowed
        once empty (204).
      - The rooms rendered from that snapshot with a Fellow at her department's shelf in
        Wing A, a visiting researcher writing at a desk, an inspector with the clipboard,
        a queued parcel at the front desk and a clerk reading at the intake cart, by day and
        by night (lamps and the fire's glow). Pictures in the session's scratchpad, not
        committed (F1).
