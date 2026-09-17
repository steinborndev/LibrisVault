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
      a run anyway. System keeps its notice: it is the machine room.
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
