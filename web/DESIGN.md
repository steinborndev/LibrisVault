# LibrisVault dashboard - design conventions

The goal: moving between areas must feel like moving inside ONE application. These
conventions are what every screen follows; new UI goes through this list before it ships.

Rewritten for the 2026-08 redesign; the shell became a tab row on 2026-08-27 and this file
follows the tabs since 2026-09-17. The findings that motivated the redesign are in the frontend
deep review; the task list is `docs/tasks/TASKS-REDESIGN.md`.

## Shell and navigation

- **One tab row, in the order of a day:** Home (what arrived and what is in flight), Research
  (what you go and find out), Library (the room, only with the research agents on), Graph and
  Catalog (what is there, as a picture and as a table), System (the machine room: queue,
  maintenance, integrations, settings). A new screen has to earn a place in that order, or it
  belongs inside one of the six.
- **The row's right end carries state, not navigation:** the Watcher and Telegram chips and
  the live pill, whose popover is the one home for watcher / queue / budget / vault / last
  commit. Screens never re-invent their own service-status corner.
- **Tab badges own attention, one thing at a time:** Home counts everything in flight
  (ingests and runs, pulsing while something runs), Research its own runs, System a
  maintenance run in flight or else what is due. A badge stays silent when there is nothing
  to say.
- **Ctrl+K reaches everything:** pages (from the shared graph query), navigation, and a
  research handoff for the typed topic. Anything that spends money keeps its own consent
  surface and stays out of the palette.
- **Routes:** `/`, `/research`, `/library`, `/graph`, `/page/<path>`, `/catalog`,
  `/catalog/page/<path>`, `/system?section=…`. Every view is deep-linkable; a retired route
  keeps a prefix alias that normalizes via `replaceState` (`/vault` → `/graph`, `/inbox` and
  `/ingestion` → `/`, `/health`, `/maintenance` and `/settings` → `/system`, `/chat` →
  `/research`, and `/library?domain=` → the Catalog's filter).
- **Screens stay mounted** behind `[hidden]` once visited, so a tab switch keeps the graph's
  camera, the chat session, filters and scroll positions (see State survival).
- **Desktop-only for now.** Below ~1000px the shell scrolls horizontally rather than
  degrading into a mobile layout.

## Layout

- **Content lane:** screens live in a centered 1180px lane; the graph widens to 1620px
  (`.lane.wide`). The Research thread keeps an 860px reading lane inside its screen.
- **Each screen owns its scroll** (`.screen` is the scroll container), so switching areas
  never resets where you were.
- **Vertical rhythm:** sections stack with 20px gaps (`.section`); cards use
  `.card.card-pad` (16/18px padding). No ad-hoc margins between siblings.
- **One row, one height.** Controls sitting side by side (topbar pills, toolbar buttons,
  search triggers) take their height from `--control-h`, not from padding, and their row
  centers them. Padding-derived heights drift apart as soon as one control carries
  different content (a `<kbd>`, an icon, another font size).
- **Canvas-like areas** (the graph) carry their controls ON the canvas: overview (minimap)
  top-right, legend bottom-right, the lock and then the trail bottom-left; zoom and search
  live in the bar above the canvas since 2026-08-26. The way-back button ("Go to nearest
  cluster") sits dead center and exists only while no node is on screen. Panels beside a
  canvas **dock** (the canvas shrinks) - they never overlay a corner that holds a control.
  The lock (2026-09-17) holds the picture: while it is closed the explorer panel stays away,
  one click on a node opens its page, and Escape brings the held picture back from wherever
  you went - a page, a filter, another tab, a reload. It lives in sessionStorage, for one
  sitting; it opens only by its own button.
- **A search folds behind a magnifier** wherever a bar or a head carries one (graph, Catalog,
  the Research ledgers since 2026-09-17): the slot keeps the box's width in both states so
  nothing beside it moves, `/` opens the box, Escape clears the text and then folds it, and
  folding clears the text - a filter you cannot see is one you cannot undo.

## Type and color

- **Faces:** Bricolage Grotesque for display landmarks (brand, screen title, stat values),
  Instrument Sans for the UI, IBM Plex Mono for data (logs, hashes, paths). All self-hosted
  via `@fontsource` - no CDN, the PWA stays offline-capable.
- **Body text is 14px.** Section labels are the 11px uppercase micro-label; anything below
  11px is a bug, not a density choice.
- **Colors come exclusively from the CSS variables** in `styles.css`, never raw hex in a
  component. Token names are stable so components keep working when the palette moves.
- **Three separate color roles, never mixed:**
  - *Status* (`--ok/--warn/--err/--busy` + their `-bg` pairs): health, outcome, urgency.
  - *Categorical* (`--type-*` for page buckets, `domainColor()` for domains): identity, no
    judgement. A source is not a warning.
  - *Brand* (`--gold`): the mark, the Home "now" edge. Never a status.
- **`--research` (violet) is a risk signal:** the mode that reaches the web and writes vault
  pages wears it across composer border, plan line and send button. It must never look like
  a harmless filter.
- **`--accent-ink`** is the text color on accent fills - the dark theme's accent is light, so
  white-on-accent would wash out.

## Interaction language

- **Chips** are the filter/selection vocabulary. `active` (accent) = visible/selected. Facet
  chips are **solo-selects**: clicking one shows *only* it; clicks accumulate; empty
  selection = everything. Rarely-needed filter sets fold into a `.dropdown` with checkboxes.
- **Segmented controls** (`.seg`) hold mutually exclusive values (sort order, focus depth).
  Rectangular = view control, round = filter: the shape difference is the distinction.
- **Buttons:** exactly one `.btn.primary` per view - the main action. Secondary actions are
  `.btn`, tertiary/icon actions `.btn.ghost`.
- **Destructive actions** are a two-step confirm on the button itself (arm → 3-4s window →
  confirm). Never `window.confirm`. The armed state is unmistakable: `.btn.armed` (red fill)
  with a visible countdown, and it names **exactly what it will delete** - not what happens
  to be on screen.
- **Unsaved work is never dropped silently.** The page editor shows a dirty badge, arms its
  Cancel, guards `beforeunload`, and every in-app exit asks first.
- **Composer pattern:** input areas are one bordered card (`:focus-within` accent) that
  contains its mode switches and its submit button. Consent detail that must stay visible
  while typing collapses to ONE line (the research plan: lens, target title, fetch cap, one
  commit); the picker behind it opens as a popover.
- **Tables are for scanning, drawers for depth.** A list row carries what you compare on;
  everything else (hashes, exact times, full log, destructive actions) lives in the drawer
  the row opens.
- **Every reference is a link.** A cross-reference described in prose ("see the Domains
  card") is a bug: wire it.
- **Wheel zoom on a canvas** is "anchor and leash" (`lib/graphZoom.ts`, 2026-09-05):
  zooming in aims at the cluster within reach until it fills the picture, the graph's box
  and the picture always keep overlapping, wheel deltas are normalized and capped, and the
  step is animated. Zooming out anchors on the cursor. Never a bare cursor-anchored zoom
  with unbounded pan - that is how a picture ends up empty.

## Explanations and tooltips

- Explanatory text goes through the `<Tip>` component (ⓘ icon; hover, focus AND tap) at the
  section/tool title - never a native `title=` attribute for meaning (invisible on touch,
  unreachable by keyboard). `title=` remains fine for pure redundancy (an icon button that
  also has a visible label elsewhere, absolute timestamps behind relative ones).
- Tool cards (Health) share one anatomy: `.section-head` with title + `<Tip>`, action button
  top-right, then a meta line carrying durable facts (last run, last report, registry link)
  that survive screen switches and restarts.
- **Evidence before consent:** a button that mutates on the basis of a stored artifact shows
  that artifact where the click happens (the lint report under "Fix safe findings").

## Feedback and state

- Empty/loading/error states use `.empty` (centered, faint) and always offer the next step
  (retry button, "ingest your first file"). **A failed query offers a retry** - never an
  indefinite "Checking…".
- Outcomes render as `.toast.ok/.warn/.err` directly below the triggering control. Success
  toasts that are pure FYI dismiss themselves; errors stay.
- Long-running agent runs stream into `.log` (JobLog) next to the button that started them.
- Times are relative (`timeAgo`), with the absolute timestamp in `title` or in the drawer.
  Costs always go through `<Cost>` so the subscription-estimate marking can't be forgotten,
  and **every run that costs money shows what it cost**.
- Numbers must be honest about their source: a windowed count says so next to the all-time
  count rather than quietly capping.

## State survival

- Screens stay mounted (`[hidden]`), so in-screen state (graph camera, active session,
  filters, scroll) survives switching. Anything that must survive a full unmount (the graph
  camera across graph ↔ page view) persists at module level.
- Expensive reactions are debounced, not run per keystroke (graph search: 220ms before the
  subgraph, community detection and camera refit react).
- Client-driven sequences (the guided run) refresh the data their next step derives from
  when a step settles - dependency order has to hold at the data layer, not just in the UI.

## Language

- **UI language is English only** - strings, aria-labels, tooltips, locales (`en-US`).
- **Regular hyphens, never em or en dashes**, in UI strings, comments and docs alike.
