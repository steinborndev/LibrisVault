# Tasks: the hosted demo shows the Fellows (2026-09-18)

The public demo of this project runs in demo mode (SPEC.md §12.8) on a build from before the
research agents were merged, against a sanitized export with an empty database. Bringing it up to
date is mostly an operations job that lives with the host, outside this repository: the unit, the
refresh timer, the reverse proxy block. What belongs here is the part that is a property of the
product: a read-only instance must be able to SHOW the Fellows without ever running one, and it
must start on a vault it cannot write.

## Decisions (2026-09-18)

1. **Content:** the synthetic vault from `scripts/demo-vault.mjs`, with the four real research runs
   it restores, rather than the sanitized export. It is the only seed that carries Fellows, runs,
   recaps and nights, and it is what the README's screenshots show. Its page bodies are templates;
   the research pages are the real thing.
2. **The Fellows are shown in demo mode, read-only, never run.** SPEC.md §12.8 and §12.10 say so;
   the flag off still changes nothing (hard rule 8).
3. **Freshness:** the seed dates everything relative to its build time, so a hosted vault is rebuilt
   nightly by a timer on the host.
4. **Host-specific files** (unit, timer, refresh script, proxy block) live with the host, not here.
5. **The demo host is not crawlable**; answered at the proxy, since the app answers every unknown
   path with its shell (`notFoundKind` in `server/src/api/server.ts`, on purpose).

## Tasks

- [x] `main.ts`: the Fellow services are constructed under `AGENTS_ENABLED` whatever `DEMO_MODE`
      says; nothing starts (`passive` gates the shift and the recap scheduler as before); the guard
      refuses every write; `health.fellows` is `true`; the start-up banner says so.
- [x] `demo-mode.test.ts`: a block with the Fellows wired. Every read the Library, the recaps, the
      reading list and the pinboard need answers 200; every write on those routes is refused with
      `demo_read_only` before a handler runs; health carries both booleans.
- [x] `ensureVaultExcludes` reports a vault it cannot write (`unwritable`) instead of failing the
      start-up; the banner logs the result and warns once. Test in `vault-excludes.test.ts`.
- [x] Web: one notice for every refused write, raised by the API client and shown by the shell
      (`client.ts`, `App.tsx`); the wing delete goes through the same reader; the page-open value
      event is not sent on a read-only instance.
- [x] Research in demo mode (2026-09-18, asked while viewing the demo): the screen renders
      instead of the notice, with the seed's saved conversations and finished research runs; the
      composer is disabled with a hint and `send` returns early, and the guard refuses a query or
      a run anyway. System keeps its notice: it is the machine room. (Reversed 2026-09-25, see the
      second round below: System renders read-only.)
- [x] The banner names the data (2026-09-18, asked while viewing the demo): centred, with
      "Synthetic demo data" as a badge ahead of the read-only note, so nobody takes the pages, the
      Fellows or their nights for real notes. Checked in light, dark and at phone width.
- [x] Two favorites in the main room (same round): the seed places astronomy and climate-science
      side by side in the pair left of the wing door, `placed_by = 'user'`, as only the user fills
      those; the wings are auto-placed on the first scene build as before (Wing A 12, Wing B 4).
      With all four empty the room read as nobody's. The pair had to differ in colour, and a
      domain's colour is a hash of its name: the first pick, astronomy and machine-learning, sat
      on the same hue. The README's `library-room.png` was shot before this and shows four
      silhouettes; re-shoot it with the next screenshot round, not for this.
- [x] Docs: SPEC.md §12.8 and §12.10, README (`DEMO_MODE` row, "Hosting a read-only demo"),
      `docs/API.md`, the header of `agents-flag-off.test.ts`.
- [x] Verification (2026-09-18): a fresh seed (917 pages, 4 Fellows, 4 recaps), served from source
      with `DEMO_MODE=1 AGENTS_ENABLED=1`, empty credential variables and the vault directory
      stripped of write permission; the dashboard through a Vite dev server so nothing was built
      next to the running instances. Health said `demoMode: true, fellows: true`; every Fellow read
      route answered 200; a spawn and a value event by hand, an approval from the night-shift
      window's decisions and a history delete from Home all came back 403 `demo_read_only`, and
      the last two showed the shell's notice. The log carried the one expected warning
      (`vaultExcludes: unwritable`) and no error.
- [x] Gates: `npm test` (1288 + 615), `npm run typecheck`, `npm run lint`, all exit 0; the build
      runs in CI.

## Findings

- **F1: nothing in demo mode touches the vault, measured.** With the vault unwritable for the
  process, start-up, every screen and four refused writes produced no `EROFS`. The only writer
  that ran was the start-up exclude write, and that one now reports instead of throwing.
- **F2: the probe's "blank" for the Library is the probe, not the screen.** `probe-screens.mjs`
  reads text from `.box-body`; the Library draws an SVG room with no text there, so it reports
  0 chars while the room strip, the shelves and a sleeping Fellow are in the DOM. Judged by hand.
- **F3: one refusal, one notice, whatever the screen.** Both writes tried from the UI went through
  the client's shared reader, so the notice needed no change in the Library or in Home. The one
  call that bypassed the reader (`deleteWing`) now goes through it too.
- **F4: the demo guard's body shape.** It names the reason in `error` and the text in `message`,
  the opposite of the `code`/`error` convention the other endpoints use. The client recognises it
  by status and reason rather than changing the server contract §12.8 documents.

## Delivered

- Merged as pull request #14, squashed to one commit (`ee4f09f`), on 2026-09-18.
- The hosted demo was cut over the same day: the build from that merge, the synthetic seed with
  its Fellows, `DEMO_MODE=1` with `AGENTS_ENABLED=1`, the vault mounted read-only for the service,
  a reseed every morning after the seeded night window, and `robots.txt` and `security.txt`
  answered by the reverse proxy in front. Checked from outside and in a browser: health says demo
  and Fellows, a write is refused with the notice, the main room shows its two favorites and the
  four Fellows, and Research shows the seed's runs and conversations with the composer disabled.
  The service log carried the one expected warning and no error.
- Still open here: re-shoot the README's room screenshot with the next screenshot round.

## Second round (2026-09-25): a demo vault shaped like a real one, and System on the demo

Asked for together with bringing the hosted demo up to the build of LibrisVault#17: the demo vault
should be about as large and as tangled as a real one, so the graph's filters show what they are
for. Then, looking at the result: System should be browsable on the demo with its actions
disabled, the way Research already is, so the new maintenance surfaces are seen rather than hidden
behind a notice. Measured first, numbers only, against the author's vault (knowledge pages, the
graph API, the same analysis the dashboard runs):

| | real vault | demo before | demo after |
|---|---|---|---|
| knowledge pages / domains | 1,352 / 25 | 899 / 19 | 1,420 / 26 |
| links per page | 5.7 | 5.0 | 5.3 |
| most inbound links on one page | 131 | 15 | 123 |
| links crossing a domain | 7.2 % | 0.7 % | 5.5 % |
| Areas over the whole vault (distinct captions) | 40 (40) | 21 (20) | 42 (42) |
| Areas in the deepest domain (distinct captions) | 14 (14) | 9 (4) | 14 (14) |
| pages under the stub size | 14 | 269 | 32 |
| validator findings over the knowledge pages | not measured | 5,096 | 229 |

(26 domains in the last column counts `unassigned`, where one real research run files its pages.)

What was wrong was the shape, not the size: every page linked to its next few neighbours in the
topic list, so all pages had the same handful of links. No page stood out for the authority lens
or the Landmarks overlay to rank, no sub-area existed for Areas to find (one community per domain,
captioned by the same template tags), and almost nothing crossed a domain for Bridges to draw.

And, found only by running the vault's own validator over it, the generated pages broke the vault's
conventions nearly everywhere: tags repeating the page's type and domain, required headings
missing, statuses outside the vocabulary, question titles with a character their file names
cannot carry, 218 pages nothing linked to. It never showed, because nothing ever validated the demo.

- [x] **Topics in areas.** `scripts/demo-vault-topics.mjs` cuts each domain into areas; an area's
      first concept is its hub, the first area's hub is the domain's. Every existing title kept;
      seven new domains (ecology, epidemiology, geology, beekeeping, horology, glassmaking,
      bookbinding), about 120 new concepts and 135 new entities, each entity with a kind. Six
      existing entity titles that named or closely mirrored a real mission, programme, product or
      catalogue were replaced by generic ones.
- [x] **The link model.** A seeded generator; links to the area hub, preferentially to an area's
      early pages, laterally within the area, into sibling areas, to the domain hub, and into
      neighbouring domains along `NEIGHBOURS`. Probabilities in `P`, tuned against the table
      above. Every source, entity, question and comparison is linked from at least one page; two
      orphans on purpose.
- [x] **Sources in forms.** Paper, preprint, lecture, video, podcast, trade press, blog, report,
      each as a tag. Most are the kind of tag the graph keeps out of captions
      (`web/src/lib/tagSignal.ts`), so the demo now shows that rule working. The documents the real
      research runs name (captured against the old generator) are generated too, so their pages
      keep resolving.
- [x] **The vault's conventions.** No type or domain tags, statuses from the vault's vocabulary,
      the required headings per type, question titles without a `?`, a tag of its own on about one
      concept in eighty instead of one in seven.
- [x] **Time.** Five months instead of 74 days, and an area is read in a stretch around a time of
      its own, so the recency colours differ between the areas of one domain.
- [x] **Stubs.** Source and entity pages get one more rotating paragraph; they were under the
      1 KB stub size almost all. One entity in 25 stays short on purpose.
- [x] **Seeded records name their pages.** The Fellow runs, the recaps and the saved
      conversations used to cite whatever concepts came next in build order (a climate Fellow's
      run listed spectrograph pages); they now name their pages by title, and a missing title fails
      the build. The captured runs' ids moved from 900 to 950: two of them shared an id with the
      failed and the duplicate job, which the usage table reported as a React key clash.
- [x] **Standing defects in the seed.** A dozen defects planted on purpose, one or two per rule
      (em-dash, tag mirroring, page schema, frontmatter, dates, status, wrapped link, title), and
      the seed runs the real validator over the knowledge pages and records what it finds, once
      six days ago and once yesterday, with one orphan accepted. 229 rows: the planted ones, the
      gaps as dead links, and about 170 on the pages of the four real research runs, which were
      written before the rules and break them for real.
- [x] **The first start, done by the seed.** It writes the vault's git excludes and the
      auto-commit flag the service would write on its first start. The hosted demo mounts the
      vault read-only for the process, so the service could not, and it then reported the vault
      plugin as committing too and logged two warnings every morning. It now starts without one.
- [x] **System on the demo, read-only.** Rendered instead of the notice (`DemoNotice` removed):
      one line under the head says why the actions are greyed; every action in the maintenance
      cards is disabled through `useReadOnly()` (`web/src/lib/readOnly.ts`), the settings forms and
      the credential and bot cards through a disabled fieldset; the credential card says the demo
      needs none instead of reporting it missing, and the Instance row loses its "set up" flag.
      Reading stays: rows open, filters work, the split proposal changes domain. Swept on every
      section with the enabled controls listed: what is left enabled only reads.
- [x] **`/stats` named the watch folder on the demo**, where `/settings` already hid it. Now hidden
      too, with a test beside the settings one in `demo-mode.test.ts`.
- [x] **Screenshots**: all sixteen re-shot from the new vault on 8422 and looked at.
- [x] **Checked in demo mode**, read-only vault, `DEMO_MODE=1 AGENTS_ENABLED=1`: start-up without a
      warning; every screen and every System section without a failed request or a console error;
      Landmarks, Areas, Recency and Authority on the new vault; the new write routes refused by the
      guard.
- [x] **Private-content check**: `vault-name-scan` over the topics file finds the same four
      textbook terms as over the previous, public version; every new title read by hand.
- [x] Gates on the final tree: `npm test` (2,093 + 800), `npm run typecheck`, `npm run lint`, all
      exit 0.
- [x] **Security review before the deploy** (2026-09-25): the branch's diff read against the hard
      rules, every GET route probed against a read-only demo instance (paths, traversal, the
      write guard across eleven methods, cost per route), and the host's configuration read. No
      high finding: nothing leaked a path or a person, traversal ended in 400 or 404 everywhere,
      every write was refused. Fixed here:
      - the address-map check under Standing defects sent a POST on the demo and hung on
        "Reading the map"; it now says the check is switched off there and shows a failure when
        one happens;
      - `/settings` hid the watch folder in its two views and not in the raw `overrides`; now in
        all three, with a test;
      - the reads that re-read the vault per call (questions, reading list, a Fellow's
        candidates, domain candidates: 40 to 63 ms each) are answered from a 60-second cache on
        a demo instance only, where nothing changes until the host rebuilds and restarts;
      - `/stats` ran one git scan per request arriving while its cache was cold; now one scan,
        awaited by all of them;
      - the generator loads everything it takes from `server/dist` before deleting anything,
        rejects a captured run's page path that is not a plain `wiki/` path, and keeps the
        host's git hooks, signing and identity out of the demo's history.
      The host's side (refresh no longer as root, unit hardening, Caddy, sandboxed build) lives
      in the host's notes, tested on the box beside the running demo.
- [x] **Delivered 2026-09-25.** Merged as LibrisVault#18 (merge commit `81db6b0`, tag
      `demo-system-and-vault-2026-09-25` on both remotes), both CI runs green. The hosted demo
      was updated the same afternoon to that commit, built in a sandbox, reseeded by the new
      refresh unit, and hardened on the host side (the host's notes record it); checked from
      outside and in a browser. `systemd-analyze security` for the demo unit went from 7.9 to
      1.3. The case study on the author's site carries this build's numbers.
