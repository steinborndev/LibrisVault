# TASKS-A6 - Merge preparation (2026-09-15)

Goal: everything the `research-agents` fork has built since the public base becomes part of
LibrisVault without a private page, a local path or an undocumented subsystem going with it.
**Acceptance (docs/agents/SPEC.md section 15, corrected in D1): with `AGENTS_ENABLED` unset
LibrisVault behaves as it does today and a test asserts it; the root `SPEC.md`, `CLAUDE.md`,
`README.md` and `SECURITY.md` describe both new subsystems; every screenshot comes from the
synthetic vault; `npm test`, `npm run typecheck`, `npm run lint` green AND exit 0;
`permprobe` reports `canary outside vault: blocked`; `preprocprobe` passes; the
private-content audit over the final merge diff is clean.**

Extension milestone in the Curious fork (branch `research-agents`), everything server-side
behind `AGENTS_ENABLED=1`. Findings recorded here, spec first when the code disagrees. The
root `SPEC.md` carries "do not edit without being asked", so section 2 is drafted and then
asked, not written and announced.

Scale of the merge, measured 2026-09-15: shared base `156660f1` (2026-09-06), 280 commits
above it, LibrisVault one commit ahead (`70b55fa7`, a dependency patch).

**Review pass 2026-09-15 (F-A6-1 to F-A6-32 in section 10).** Every claim in this file was
checked against both repos. Most held. Three substantive ones did not - the `npm test`
diagnosis, the `health.fellows` contract, and the size of the private-content finding - and
several smaller ones were off by a line number or a date. All of them are corrected in place
and marked `[corrected]`; what the file did not have at all is marked `[added]`, including
two new decisions (D5, D6). The gate status as measured is at the top of section 8.

**Decision round 2026-09-15 (F-A6-31, F-A6-32).** The four open decisions were taken and
applied. The package name follows the product; `permprobe` was run with authorisation and
passes; the already-public fixtures are generalised at the tip rather than by rewriting a public
history; the one quoted run in the task folder is redacted in brackets rather than rewritten; the
other clone's stray private file is deleted. Section 4's last half is done too: the README read
against the RUNNING app, which found six things a code read structurally cannot.
**Five items remain, and every one of them happens during the merge itself** (section 9, plus
the audit over the final merge diff in section 7).

**CI pass 2026-09-15 (F-A6-30).** CI's first run was red, on two tests that pass on this machine
and cannot pass on a runner. Neither was a product bug; both were assertions about the
environment written as assertions about the code. Fixed, and green since. The runner is
reproducible locally: `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null INVOCATION_ID=x
npm test`.

**CI and sweep pass 2026-09-15 (F-A6-29).** The repo has CI. The task files are swept. The
hook's structural limit has a tool beside it rather than only a warning.

**Screenshot pass 2026-09-15 (F-A6-28).** Section 5 is complete. Thirteen images, seven of
screens nobody had shot, and four real research runs standing behind them.

**Demo seed pass 2026-09-15 (F-A6-27).** The synthetic vault has Fellows, so the screens the
extension adds can be shot without pointing a camera at a real vault. What remains of section 5
is the shooting itself.

**README and SECURITY pass 2026-09-15 (F-A6-26).** Section 4 done but for reading the README
against a running app. The security page gained a threat chain the agents opened and nobody had
written down.

**CLAUDE.md pass 2026-09-15 (F-A6-25).** Section 3 is done, and checking the screen list
turned up a base-product tab renamed by the extension work and behind no flag.

**Root spec pass 2026-09-15 (F-A6-24).** Section 2 is complete: both summarising sections
written and applied, and four corrections with them. One of those corrections was needed in two
places rather than the one this file had found.

**Decision round 2026-09-15 (F-A6-23).** D1 to D5 are settled and section 0 carries each
answer with its reasoning. Four went as proposed; D1 needed a third branch for what the flag
review had turned up, and that branch is implemented. Sections 2, 3 and 4 are unblocked.

**Sixth pass 2026-09-15 (F-A6-22).** Section 1 is closed except for the half that waits on
the root spec: the flag surfaces and the background work are confirmed gated, the containment
probe is run and its count reconciled, and the web check turned up two base-product screens
requesting a route only the extension registers.

**Fifth pass 2026-09-15 (F-A6-21), before the branch went to the private remote.** Five
passes over the 41 unpushed commits: messages, file list, secrets, absolute paths, and the
added lines against every bucket. Clean. It also settled what D4 weighs: the tree holds no
home path, the history holds one in three places.

**Fourth pass 2026-09-15 (F-A6-20).** The commit-msg guard reads title fragments and every
telling bucket now, which found two fixtures the earlier method could not. Its remaining limit
is in its own header rather than implied.

**Third pass 2026-09-15 (F-A6-18, F-A6-19).** The flag-off acceptance test is written, the
four repo-hygiene items of section 6 are done, and the open question about the reading list is
answered: it writes to the vault with the flag off, and the ingest prompt asks it to, which
makes it D1's subject rather than a footnote.

**Second pass 2026-09-15, from the A7 review (F-A6-15, F-A6-16).** Three items closed: the
`npm test` exit (section 6, and it was a service bug as well as a test bug), the fork's own
detail spec, which described a component deleted the same day (section 2), and D6, which
turned out to rest on a list of A7's open items that was wrong in both directions. All three
gates now exit 0. One item was opened: F-A6-17, the audit's blind spot for quoted run output.

## 0. Decisions before the work starts

- [x] **D1 - DECIDED 2026-09-15. Name the two halves separately, and move the reading list
      out of the unflagged half (implemented, F-A6-23).** The acceptance criterion becomes
      two sentences rather than one: *the FELLOWS are behind `AGENTS_ENABLED` and the flag off
      leaves the base product exactly as it was, network requests included; SOURCE INTEGRITY
      is not behind a flag, because it is a correctness fix to the existing ingest pipeline
      and flagging it would ship the known-weaker path as the default.*
      **What the decision had to settle beyond the original proposal.** F-A6-19 found a third
      thing that was neither: the reading list wrote a vault page with the flag off, through
      the ingest prompt and the attribution pass, while the route that displays it was gated.
      That is not a correctness fix - it is a Fellows feature writing where nobody can look.
      It is behind the flag now, the append-only rule moved into the block it points at, and
      the test pins both sides. So the seam this item asked to be named explicitly is:
      **the fence, PDF URL handling, quote integrity and the expand lock are unflagged; the
      reading list and its sweep are the extension; open-access recovery is unflagged and
      documented as service egress (D5).**
      **[added 2026-09-15, F-A6-25] One more thing is unflagged and was not counted:** the
      tabular view was renamed Library to Catalog by A4, and the name went to the new room
      screen. A base-product install that upgrades finds a tab renamed. Nothing behaves
      differently and the name went where it fits, but it is a visible change and belongs in
      the release notes rather than in a surprise.
      The original text and its correction, kept as the record: section 15
      promises "LibrisVault unchanged with the flag off". That holds for the Fellows and
      not for the rest: the source-integrity work (`docs/sources/SPEC.md`, TASKS-SOURCES,
      55 tasks) is behind no flag at all and changes ingest behaviour with `AGENTS_ENABLED`
      unset - the untrusted fence, PDF URL handling, open-access recovery, quote integrity
      in the validator, the expand lock. Proposal: name the two halves separately rather
      than flag the second one, because it is a correctness fix to the existing pipeline
      and putting it behind a flag would ship the known-weaker path as the default. Record
      the decision here and amend section 15.
      **[corrected] Verified in code (F-A6-3), with one exception:** `fenceWithWarnings` is
      wired unconditionally into all four preprocessing plugins (`office.ts`, `pdf.ts`,
      `text.ts`, `web.ts`) and `DEFAULT_OA_RECOVERY = true`, so the unflagged half is real.
      But the **reading-list sweep is already behind the flag** - it lives inside
      `NightShift` (`main.ts:370`, the `openCopies` hook), which only exists when
      `fellows !== undefined`. So the split is not "Fellows flagged, source integrity
      unflagged": the sweep is source-integrity work running on the Fellows' schedule.
      D1 has to name that seam explicitly, and section 1's background-work bullet must
      stop demanding the opposite.
- [x] **D2 - DECIDED 2026-09-15: as proposed.** 12.10 Fellows and 12.11 Source integrity in
      the root spec, detail specs where they are, no second top-level spec. One qualifier from
      F-A6-16: "unchanged" means not RESTRUCTURED, not untouched - `docs/agents/SPEC.md` was
      wrong in four places and has been corrected. The proposal, unchanged:
      **D2 - one spec or two: follow the established pattern.** Root `SPEC.md` gets a
      summarising `12.x` per subsystem and the detail lives in `docs/<area>/SPEC.md`, the
      way 12.6 (retrieval), 12.7 (vault check), 12.8 (demo mode) and 12.9 (dedupe) already
      do. So: **12.10 Fellows**, **12.11 Source integrity**, with `docs/agents/SPEC.md` and
      `docs/sources/SPEC.md` unchanged as the detail specs. Not a second top-level spec.
      Note that the pattern was already broken once: source integrity shipped without a
      root section, which is why 12.11 is part of this milestone and not of TASKS-SOURCES.
- [x] **D3 - DECIDED 2026-09-15: keep the name, explain it once.** One sentence in the root
      spec's 12.10 saying that "Curious" was the private fork this work was built in, and the
      13 occurrences stay. The reason is the same one this repo follows elsewhere: these are
      DATED RECORDS, and rewriting them so that another name was never used is the quiet kind
      of revision that A7 deliberately avoids when it keeps its superseded sections standing.
      A reader who meets the name once with an explanation is not confused by it again.
      The original item: **D3 - what happens to the fork's name.** "Curious" names the private branch in 10
      tracked documents, 13 occurrences (`docs/agents/SPEC.md` 3, `docs/agents/ideas.md` 2,
      `docs/sources/SPEC.md` 1, `docs/tasks/TASKS-A0..A5,A7` 1 each). Decide once: keep it
      as the historical name of the work and say so in one place, or rewrite to "the
      `research-agents` branch" throughout. Do not leave both readings in the repo.
- [x] **D4 - DECIDED 2026-09-15: merge the history as it stands.** The commit messages of
      this project explain mechanisms and the reasoning behind them; that is the most valuable
      part of the record and it has been audited twice (F-A6-7 over all of it, F-A6-21 over
      the last 41). The home-directory path in three commits is weighed and accepted: it is a
      username and a config path, not a secret and not vault content, and rewriting 290 hashes
      to remove it would cost a force-push and every commit's identity for a very small gain.
      The original item: **D4 - how much of the A-series history the public repo gets.** The 290 commits carry
      the full design record. Decide: merge the history as it stands (preferred, the commit
      messages are the record and the audit in section 7 found them clean - confirmed
      independently, F-A6-7 and again over the last 41 in F-A6-21), or squash. If squashed,
      the design rounds in `docs/agents/ideas.md` become the only record and that has to be a
      deliberate choice, not a side effect.
      **[added 2026-09-15] The one concrete thing that argues the other way, and it is small.**
      The commit messages are clean and so is the tree, but the history holds a home-directory
      path at three points that the tree no longer has: `d22be54` introduced it with the
      timelapse drivers, `b5aabf7` removed it from them, and in between `db8dec7` added this
      very file carrying the path as a QUOTE of the hygiene item below, which `7f26199` then
      generalised. So two commits of this file, and a stretch of the drivers, name a username
      and a config path. It is not a secret and it is not vault content; it is the kind of
      thing a squash erases for free and a merge carries forever. Weigh it against the record,
      do not let it decide alone - and note that a third option exists if the record is what
      matters: merge the history and accept the path, or squash and keep the design rounds in
      `ideas.md` and these task files, which are merged as files either way.
- [x] **D5 - DECIDED 2026-09-15: document it, leave it on.** In 12.11 and in the README's
      security model, written the way SPEC section 9 already writes the Telegram paragraph -
      service egress, not agent egress - and naming the three hosts. Hard rule 4 is untouched:
      "no web egress in ingest runs" is about AGENT runs and stands. Not defaulted off for
      upgrades, because the three are non-commercial scholarly infrastructure and a DOI lookup
      is what the recovery IS; an install that wants none of it turns the setting off.
      **This one must not be merged undocumented** - that half of the item is binding.
      The original item: **D5 [added] - open-access recovery is on by default and makes outbound requests
      during ingest.** `DEFAULT_OA_RECOVERY = true` (`server/src/db/settings.ts:168`), and
      the recovery path contacts `api.openalex.org`, `api.core.ac.uk` and
      `www.ebi.ac.uk` (Europe PMC). Every existing LibrisVault install gets that silently
      on upgrade: an ingest that used to touch only the material now asks three third
      parties about a DOI. This is *service* egress, not agent egress, so hard rule 4 is
      untouched - but it is a new network behaviour in the default path and nothing in the
      public docs says so. Decide: document it in 12.11 and the README security model (SPEC
      section 9 already has the exact precedent, the Telegram "service egress, not agent
      egress" paragraph), or default it off for installs that upgrade. Do not merge it
      undocumented either way.
- [x] **D6 [added] - A7 is open while A6 runs. Settled 2026-09-15 (F-A6-15): merge it as a
      stated roadmap, with the open items rewritten as design questions.** A7 is updated and
      its section 9 is the list this decision rests on.

      **The four items this decision was first written against were the wrong four.** The file
      said 1 (deepen without a planning run), 1b (intra-domain handoff), 3.5 (what a drag on
      the night bar orders) and 5 (a log channel per run). Checked at the source on 2026-09-15:
      **3.5 was decided AND built** in A7 stage B (the `shelf_order` table,
      `byShelfThenPriority`, `PUT /api/v1/agents/shelf-order`) and was only still listed
      because its heading kept the words "Decision needed"; and the list **missed** splitting
      an overgrown page (A7 section 7), which the agents spec already points at as open. So
      the count was right by accident and wrong in both directions.

      What is actually open is four DESIGN QUESTIONS - 1, 1b, 5 and 7 - each with the property
      that makes merging them defensible: none is a half-built feature, each changes behaviour
      rather than finishing it, and each has its unsettled points written out. A7 section 9
      carries them as a table, alongside what had to be fixed before the milestone could be
      called done (the `npm test` exit, section 6; the agents spec, section 2) and two small
      gaps in the window itself.

      The working agreement's concern is answered on its own terms: A7's acceptance IS met.
      Its goal was one window that manages the Fellows so the docked card can be retired, and
      `FellowCard.tsx` was deleted on 2026-09-15.

**Four more decisions were taken later, during the work, and they are recorded where they
apply rather than here** - this section is the set that had to be settled BEFORE anything could
be written, and backdating the others into it would make the file lie about its own order. They
are: the package name (section 6), what happens to the names that were already public
(section 7), the one quoted run in the task folder (section 7, under the sweep item), and the
other clone's stray private file (section 7). Each is marked **DECIDED 2026-09-15** at its item,
in the same form as D1 to D6.


## 1. Feature flag review

- [x] **Done. Confirmed 2026-09-15 (F-A6-6): every line reference below matches.**
      Enumerate every surface `AGENTS_ENABLED` gates and check each one for a path that
      still runs with the flag off: routes `agents.ts`, `library.ts`, `reading-list.ts`,
      `recaps.ts`, `usage.ts`; `api/server.ts:105`; `main.ts:245` (night shift), `:284`
      and `:289` (Fellows), `:507` (reading list); `config.ts:102`, `:327`, `:352`, `:389`.
      (Every line reference verified 2026-09-15.) Note the shape while you are there: the
      routes are gated by **presence of the injected service** (`server.ts:180-207`,
      `if (ctx.fellows !== undefined) ...`), not by reading the flag, and `main.ts` is what
      turns the flag into presence. That is fine, but it means a test may construct a server
      with Fellows present and the flag false; only `main.ts` ties the two together.
- [x] **Done 2026-09-15. Three of the four are gated; the fourth is F-A6-19.**
      `shift` and `recaps` are constructed only when `fellows !== undefined` and started only
      when they exist and the service is not passive (`main.ts:557-558`); the `UsageMonitor`
      is built behind the flag AND has no timer at all - it samples on demand, so there is
      nothing to start. The one that is not gated is the reading list, below.
      Assert the background work does not start with the flag off: the night shift, the
      usage monitor and its sampling, the recap scheduler.
      **[corrected]** The reading-list **sweep** was in this list and does not belong here:
      it is inside `NightShift` and therefore already gated (see D1). What is NOT gated is
      the `ReadingListService` itself - it is constructed unconditionally at `main.ts:152`
      and handed to the maintenance runner at `:185`. Check what that costs with the flag
      off: a service that only holds state is fine, a service that writes during ingest is
      the unflagged behaviour change D1 is about. A timer that starts and finds nothing to
      do is still a behaviour change.
      **Answered 2026-09-15 (F-A6-19), and the answer is the second one: it writes, and the
      prompt asks it to.** Two independent halves, neither behind the flag:
      the `<reading_list>` block is in the system prompt of EVERY ingest run
      (`queue.ts:1121` and `:1453`, unconditional in `systemPromptExtra`), telling the run to
      append an entry to `wiki/meta/reading-list.md` for every publication worth having in the
      original; and `attributeRun` runs after the ingest and rewrites that page's `by:` lines
      for the entries the run added (`reading-list.ts`, `fs.writeFileSync`). So a LibrisVault
      user who upgrades and sets no flag gets a new vault page that their ingests fill in.
      That is a vault-visible behaviour change in the default path, which makes it D1's
      subject rather than a footnote to it, and it is a bigger one than the OA egress of D5,
      because this one writes to the vault. D1 has to name it; decide whether the block and
      the attribution move behind the flag, or whether the reading list is declared part of
      the base product and documented as such.
- [x] **Done 2026-09-15.** Both halves. The confirming half was F-A6-6 (29 migrations, gated
      by `PRAGMA user_version`, none steps down); the writing half is the paragraph "The tables
      exist either way, and the migration is one-way" in root `SPEC.md` 12.10, which states both
      the harmless part (a vault with no Fellows still has a `fellows` table - schema, not
      behaviour) and the part that costs the user something (a downgrade cannot run the old
      binary against the same database; keep a copy of `jobs.db` before upgrading).
      **[corrected] That paragraph said 30 migrations and there are 29**, which is the hazard of
      writing a count into prose: it was right when written and wrong one migration later. It
      names the file to re-check now instead of asking to be believed.
- [x] **Done 2026-09-15 (F-A6-22), and the second half was false until it was.**
      Web: with the flag off no Fellow surface may render and no request to a gated route
      may be issued. Check `client.ts:401`, `:431` and the Library screen.
      **Rendering was already right**: the Library tab is filtered out of `TABS` on
      `fellowsOn`, and Home and System guard every Fellow query with `enabled`. **The network
      was not**: `Vault.tsx` and `Catalog.tsx` - two BASE PRODUCT screens - queried
      `/api/v1/library/scene` unguarded on every mount, so the flag off meant one 404 apiece
      per mount. Both carried `retry: false`, which is the same request made quietly. Fixed by
      the guard the comment above each already described. `wingGroups` has always returned an
      empty list for an absent scene, so nothing downstream moves.
      Left as a known, click-gated remnant: `DeepenDialog` queries `agents` without a guard,
      and the Catalog can open it. It costs one 404 after a deliberate click on a button that
      cannot do anything with the flag off, which is a smaller wrong than a mount-time request
      - but it is the same class, and the Deepen entry point itself should probably be gated.
      **[corrected] The contract is a boolean, not the string this file used to name.**
      `health.fellows` is `ctx.fellows !== undefined`
      (`server/src/api/routes/health.ts:21`), typed `fellows?: boolean` in
      `web/src/api/types.ts`, and read as `health.data?.fellows === true`
      (`App.tsx:215`, `Home.tsx:161`, `System.tsx:309`). The `'on'` / `'off'` strings at
      `config.ts:389` are the **startup log banner**, a different object. A test written
      against `health.fellows === 'off'` would assert a contract that does not exist.
- [x] **The test that is missing entirely. Written 2026-09-15 (F-A6-18):**
      `server/test/agents-flag-off.test.ts`, four tests. Every route the extension registers
      answers 404 with its service absent (seven of them, one per registrar, `/api/v1/wings`
      included because it rides along in the library registrar); the base product's own routes
      still answer 200; `health.fellows` is asserted as a falsy BOOLEAN and as a boolean type,
      against the banner-string trap this file records below; and a counter-test wires one
      gated service and sees its route appear, without which the other three would pass
      against a deleted registrar or a typo in a path.
      **It covers the second of the two gating steps, and says so in its own header.**
      `main.ts` turns the FLAG into the presence of a service, `buildServer` turns PRESENCE
      into routes; this is the second. Booting the first means `startService`, which opens the
      database at `defaultDbPath()`, reads the real credential file and starts a watcher - one
      environment variable away from writing into the developer's own vault, which is not a
      thing a unit test may be able to do. The flag-off smoke run in section 8 is what covers
      that half, and it is the reason that line stays open.
      The original finding: no test file mentioned `AGENTS_ENABLED` today
      (confirmed: the only test occurrences are of the config field `agentsEnabled`, and of
      those only `commit-dismissals.test.ts:67` sets it false, incidentally and without
      asserting anything about it), so the milestone's own acceptance criterion has no
      automated check. Add one: boot the server with the flag unset, assert the gated routes
      404, `health.fellows` is falsy (see the correction above), no scheduler registered, no
      usage sampling, and the dashboard renders without a Fellow surface.

## 2. Root SPEC.md (draft, then ask)

- [x] **Done 2026-09-15 (F-A6-24).** Written and applied after review. **New 12.10 "Research agents (Fellows)"**: what a Fellow is, the notebook page in the
      vault, the four task arts, planning from vault-internal candidates, the veto window,
      the night shift and its quota in plan-utilization points, the recap, the Library
      screen, and `AGENTS_ENABLED` as the gate with its default. Pointer to
      `docs/agents/SPEC.md` for the detail. Include the one-way migration note (section 1).
- [x] **Done 2026-09-15 (F-A6-24).** Written and applied after review, and it says plainly that this half is NOT flagged. **New 12.11 "Source integrity"**: PDF URLs, the untrusted-content fence,
      open-access recovery, the reading-list sweep, quote integrity in the validator, the
      expand lock. Say plainly that this one is NOT behind a flag (D1), and name the one
      part of it that IS (the sweep, which runs inside the night shift). Say what OA
      recovery talks to over the network and that it defaults on (D5). Pointer to
      `docs/sources/SPEC.md`.
- [x] **Done 2026-09-15 (F-A6-24).** Corrected: the plugin-chain sentence keeps its place and gains the converter containment and the fence. **Section 5 still describes the preprocessing chain as it was** (a plugin chain of
      external tools, no word about what contains them), which `docs/agents/ideas.md` has
      recorded as A6 work since 2026-09-08. Add one paragraph beside the tool table:
      converters run through `runConverter`, not `runTool`; the jail is bubblewrap with no
      network, no `$HOME`, a read-only `/usr` and `/etc`, the input file and one writable
      output directory; the tool's own prefix is bound when it lives outside `/usr`, never
      a home directory; `yt-dlp` is the documented exception; a missing bubblewrap fails
      the conversion unless `PREPROCESS_SANDBOX=off`; and `preprocprobe` is to this what
      `permprobe` is to section 7.
- [x] **Done 2026-09-15 (F-A6-24).** Corrected, in the format that section already uses for its 2026-08-27 correction. Section 6: the dashboard description predates the Library screen's Fellow surfaces.
      Bring the screen list and the tab descriptions up to what is built.
- [x] **Done 2026-09-15 (F-A6-24).** Corrected, and both probes named where a reader of the boundary will look. Section 9 (security): add the preprocessing containment and both probes, so the
      security section names every boundary the code actually has.
- [x] **Done 2026-09-15 (F-A6-24).** Corrected, and it was in TWO places: section 4 said the same wrong thing as section 9. **[added] Section 9 also contradicts CLAUDE.md hard rule 4 and has to be corrected,
      not only extended.** It still says agent runs get "bash on a script allowlist". Hard
      rule 4 says the opposite in as many words ("NOT a `scripts/*.sh` whitelist", with the
      M0 measurement behind it: 14 of 68 bash calls in the validated run were
      `find`/`ls`/`cat`/`python3`). A public reviewer reading the spec would take the
      allowlist as the boundary and miss that the sandbox is. Fix the sentence to say what
      the code does: the sandbox is the boundary, the denylist is defense in depth.
- [x] **Done 2026-09-15 (F-A6-24).** Written into 12.11, in the shape section 9 already uses for the bot. **[added] Section 9 is also missing the OA egress** (D5). Write it the way the
      Telegram paragraph in the same section is written: service egress, not agent egress,
      naming the hosts and saying the rule "no web egress in ingest runs" is about agent
      runs and stands unchanged.
- [x] **Done 2026-09-15 (F-A6-24).** Corrected: a note below the table places the A-series on top of a finished M5. Section 10 / milestones: reconcile the M0-M5 table with the A-series, so a reader can
      see that the A work sits on top of a finished M5 rather than inside it.
- [x] **[added] `docs/agents/SPEC.md` was not "unchanged" as D2 assumed - it described a
      component that had been deleted. Fixed 2026-09-15 (F-A6-16).** Section 10.5 "Fellow
      card" and the "Open card (switches to full mode with the docked card)" action in 10.6
      were the docked sidebar A7 removed the same day, and the command centre - the whole of
      A7 - had no section at all, one line in 8.6a being its only mention. Corrected in
      place, following this spec's own pattern (a design-era section kept, an "(as built)"
      section beside it): 10.5 and 10.6 carry a superseded/corrected note pointing forward,
      **new 10.12 "The Fellow command centre (as built, 2026-09-15)"** describes what exists,
      and three more claims that had the same single cause were corrected with it - 10.11's
      "one task a night, in turn" (`sweep` is the default since A7 stage B, `rotate` is the
      setting that keeps the old behaviour) and its task-state labels, 8.6a's comparison to
      "the Fellow card's quota override" (a two-step that is now one button in the dossier),
      10.8's level-of-detail example naming "the docked-card view", and 10.10's deepen entry
      points (the shelf window, not the card). D2's sentence about the detail specs being
      unchanged should be read as "no restructuring", not "no edits".

## 3. CLAUDE.md

- [x] **Done 2026-09-15 (F-A6-25).** Both added in one paragraph each, with their specs and which is flagged. "What this project is" describes neither subsystem. Add both, in the register of the
      existing text: what they are, where their specs live, which one is flagged.
- [x] **Done 2026-09-15 (F-A6-25).** Added as rule EIGHT, not inserted: over 100 places in this repo name a hard rule by number, so inserting one would have broken every reference to 5 through 7. Rule 4 also corrected on who reaches the web. Hard rules: state `AGENTS_ENABLED` as the extension gate and that the Fellows are the
      only agents with web access (today only hard rule 4 says web is autoresearch-only,
      which the Fellows have since widened).
- [x] **Done 2026-09-15 (F-A6-25).** The three limits are in the rule now, two of them closed the same day and the structural one stated. Hard rule 7 says "This repo is PUBLIC". True again after the merge, so the wording
      stands, but the rule needs the findings from section 7: the `commit-msg` hook matches
      **whole page-title stems** and therefore misses a title's substring, it reads only
      `wiki/entities/` and `wiki/sources/` and therefore knows nothing of the page types the
      Fellows write, and it scans **commit messages only** and therefore cannot see a name
      that leaks in file content or in PR text.
- [x] **Done 2026-09-15 (F-A6-25).** The plugin-chain sentence gains the containment and the fence; the test line names typecheck and lint beside the suite, with the reason. The lifecycle list needed nothing, as this item already said. Conventions: the job lifecycle list, the plugin-chain sentence and the test paragraph
      predate the A-series. Check each against what the code does now.
      (Checked 2026-09-15: the **job lifecycle list is still exact** - `JobStatus` in
      `server/src/db/jobs.ts:20-28` is the same eight states in the same order. The other
      two still need the pass.)

## 4. README and SECURITY.md

- [x] **Done 2026-09-15 (F-A6-26).** Written for someone deciding whether to turn it on. **New section "Research agents"**: what a Fellow does, the night shift, the recap, the
      quota, how to turn it on (`AGENTS_ENABLED=1`), and that it is off by default. It is
      the single largest undocumented feature in the repo. (Measured: the README has **zero**
      occurrences of `AGENTS_ENABLED`, "Fellow", "night shift", "recap" and "reading list".)
- [x] **Done 2026-09-15 (F-A6-26).** Written, with the reason it is not behind a flag. **New section "Source integrity"**: the fence, quote checking, open-access recovery.
      This is the subsystem a reviewer arriving from a provenance question will look for,
      and today the README does not mention it (zero occurrences of "source integrity",
      "fence", "open-access", "expand lock").
- [x] **Done 2026-09-15 (F-A6-26).** Corrected, including the Library/Catalog rename the list had missed. "The dashboard" (line 210): the Library screen's Fellow surfaces, the reading list,
      the recap inbox.
- [x] **Done 2026-09-15 (F-A6-26).** All three variables documented, plus the research settings. "Configuration" (line 377): `AGENTS_ENABLED` and every setting the A-series added
      (research shares, reserves, plan USD, runs-per-day quota). While there: `DEMO_MODE`
      and `PREPROCESS_SANDBOX` are also undocumented, the second one although CLAUDE.md
      hard rule 6 tells the reader to use it.
- [x] **Done 2026-09-15 (F-A6-26).** Converter jail added as item 6, with the probe. "Security model" (line 487): the preprocessing sandbox and `preprocprobe`, beside the
      agent-run sandbox and `permprobe` that are already there.
- [x] **Done 2026-09-15 (F-A6-26).** Brought to the hard rule: four write paths, each one commit behind the mutex. **[added] "Security model" item 1 is stale and says something no longer true**: "The
      service writes to the vault only through agent runs and git commits". CLAUDE.md hard
      rule 1 has carried the corrections since 2026-07-18 and 2026-07-23: user-initiated
      page edits and deletes via `PUT`/`DELETE /api/v1/pages`, the retrieval-index scripts,
      and `discardUntrackedDir` for a duplicate job's own staging directory. Bring the item
      to the hard rule, not the other way round.
- [x] **Done 2026-09-15 (F-A6-26).** All four written, plus one the item did not ask for: the chain from a poisoned page to a run that reaches the web. **[added] `SECURITY.md` is untouched by this milestone and needs both subsystems.**
      The README points at it for "the full threat model - including what a malicious
      *document* can and cannot make the ingest agent do". That is precisely what the
      A-series built, and the file mentions none of it: zero occurrences of "fence",
      "runConverter", "preprocprobe", "open-access", "Fellow" and `AGENTS_ENABLED`, and one
      of "bubblewrap". At minimum: the untrusted-content fence as the prompt-injection
      boundary, the preprocessing sandbox as the parser boundary with `preprocprobe` as its
      probe, the Fellows' web access as a widening of the agent-egress rule, and the OA
      egress from D5. This is the file a security reviewer opens first.
- [x] **Done 2026-09-15 (F-A6-26).** Says that M0 to M5 are finished and the A-series sits on top. "Status & license" (line 789): bring the status paragraph up to the merged state.
- [x] **Done 2026-09-15 (F-A6-32).** Read against the CODE first, which found three stale
      things (screens, configuration, API list), then against the RUNNING app, which found six
      more that a code read cannot reach because they are about what the screen actually shows:
      the **screen order** (the Library sits directly after Research, before the two screens it
      contains - the README had it fifth, among the browse screens); **`System → Research`**,
      a section that does not exist (those keys are in Service & config, and the per-Fellow ones
      are in the Library); the **runtime-settable list**, given twice in the README, incomplete
      both times and not even agreeing with itself; the **Catalog's controls** (a whole
      source-type filter unmentioned, two sort keys missing, the domain list grouped by wing);
      the **`src/tabs/` listing**, which named five files of which two no longer exist and
      omitted three; and the **demo vault's own figures**, which grew when the four real research
      runs were added (~850 pages over 17 domains became ~900 over 18).
      **And one the read reproduced rather than found**: the dashboard came up blank, because
      running the four gates rebuilds `web/dist` under a service that registered the old asset
      names at startup. The troubleshooting entry for it was right but too narrow - it named
      `npm run build:web`, and the thing everybody actually runs is `npm run build`. It says so
      now, including that it blanks every service serving that directory.

## 5. Demo vault and screenshots

- [x] **Done 2026-09-15 (F-A6-27).** Four Fellows covering the range (an observer sweeping, a custom mix, a researcher on auto that rotates, a librarian asleep on `covered`), nine runs, five proposals in three states, a week of nights, three recaps, the shelf order, and as vault pages: a notebook each, three recap pages and a reading list. Defined once above the page generation, so the pages and the rows cannot disagree. **`scripts/demo-vault.mjs` seeds zero Fellows** (`grep -ci fellow` returns 0, and so
      do recap, notebook, shift and proposal; it seeds jobs, agent runs, sessions and
      messages), so the Library screen with Fellows cannot be shot synthetically today. Seed
      the demo DB: agents with home domains, notebook pages in the demo vault, past runs
      with costs and durations, a night's shift history, proposals awaiting a veto, recap
      pages, a few reading-list entries. Invented throughout, like the rest of the generator.
- [x] **Read and followed 2026-09-15.** The seed writes rows; it starts nothing. Note for whoever wires this: Fellows never run in demo mode (`main.ts:289` requires
      `!config.demoMode`), and the screenshot procedure does not use demo mode - it runs a
      normal service against the demo vault and a demo DB. Seeding the DB is the path;
      turning demo mode on is not.
- [x] **Done 2026-09-15 (F-A6-28).** Thirteen shots now. Seven new ones (the room, a wing, the command centre, a dossier, the recap, Home in night view, the reading list) plus the one that matters most - a synthesis page as it is read, which no ledger screenshot can stand in for. Two mechanisms came with it: an optional click before the shutter, for surfaces no URL reaches, and clicking by `[role="tab"]` alone, since a wider selector finds Home's OTHER "Night shift" button and returns a picture of the view it meant to leave. `scripts/shoot-screens.mjs` knows five screens and none of the new Fellow surfaces.
      Add them: the Fellow command centre, the recap, the night view, the reading list.
- [x] **Done 2026-09-15 (F-A6-28).** All five re-shot against the demo vault. One had changed hands: what the script shot as the Library is the Catalog now, so the route and caption follow the rename while the file name stays and keeps the README link alive. Re-shoot every existing image. **[corrected] They are older than "dated 2026-09-05"
      suggests** - that is the working-tree mtime from a checkout, not the content. By
      commit date `home.png`, `graph.png`, `research.png`, `library.png` and `system.png`
      are from **2026-08-27** (`f77548d`, the redesign merge) and `social-preview.png` from
      **2026-07-19** (`b52c19e`). So `library.png` predates everything now in the Library
      screen, and the re-shoot is a bigger job than a refresh.
- [x] **Done 2026-09-15 (F-A6-28).** Every one looked at, which is the only check that works on a PNG - and it earned its keep three times: a red 206% budget banner (right figure, demo configured too tight), placeholders mixed into the reading list, and a research run's pages filed under an ingest commit in the activity stream. Check every image before committing: no real page title, no real domain name, nothing
      from `~/vault`. The generator invents its subject matter, but the screenshot is taken
      against whatever `VAULT_ROOT` points at, and pointing it at the wrong vault is one
      environment variable away. (The current images were checked byte-wise for the terms
      the audit found and carry none of them, but a PNG cannot be grepped for what it
      *shows* - the only reliable check is looking at each one.)

## 6. Repo hygiene

- [x] **Done 2026-09-15.** `.claude/settings.local.json` is **tracked** although `.gitignore:39` lists it
      **[corrected: the file said `.gitignore:21`]** (it was committed before the rule, and
      an ignore rule does not reach a tracked file). It carries a local path
      (a home-directory path). `git rm --cached`'d; the file itself is untouched on disk.
- [x] **Done 2026-09-15.** `scripts/timelapse/frames.cjs` and `video.cjs` held a hardcoded
      home-directory path. (Both were a `require()` of a playwright inside an npx cache
      directory, so they were broken for anyone else anyway, not merely leaky.) Resolved at
      run time now by a shared `playwright.cjs`: an ordinary `require('playwright')` or
      `PLAYWRIGHT_MODULE`, with a message naming both ways when it finds neither. Playwright
      stays OUT of the dependency list deliberately - these drivers are a promo tool run by
      hand a few times a year, and a browser download in everyone's `npm ci` is a steep price
      for that; the README says so.
      **[added] Both files were also commented and logging in German**, the only files in the
      repo still doing so (checked repo-wide). Translated with the same content. Worth a line
      here because the merge audit looks for vault names and would not have looked for this.
- [x] **Decided and done 2026-09-15: the package name follows the product.** Root
      `librisvault`, workspaces `@librisvault/server` and `@librisvault/web`, lockfile
      regenerated - only the two workspace link entries move in it, no dependency version
      changes. Nothing outside those three `name` fields referenced the scope, so the rename
      is three lines and a lockfile.
      **What deliberately did NOT follow**, because it is not a label: `~/.config/vault-service/env`,
      `~/.local/share/vault-service/`, the systemd unit, and the `user.name=vault-service` the
      service commits under. Those are an installed path and a recorded identity. Renaming the
      config directory would strand the credential file of every existing install, and renaming
      the git author would make past commits claim a writer that did not exist when they were
      written. The package name is what a reader of the repo sees; the rest is what a machine
      already has on disk.
- [x] **`npm test` exits 1 although all 1819 tests pass**: an unhandled rejection in
      teardown, "TypeError: The database connection is not open".
      **Fixed 2026-09-15 (F-A6-15). `npm test` now exits 0, 1819 tests, no errors.**
      **[corrected] This IS A-series fallout, contrary to what this file said.** The earlier
      "reproduces with the branch stashed" reading was a stash of the four modified working
      -tree files, not of the 280 commits. Proven 2026-09-15 (F-A6-1): the failing frame is
      `FellowService.planAfterFirst` (`server/src/pipeline/fellows.ts:773`) calling
      `SqliteAgentStore.get` (`server/src/db/agents.ts:364`), raised from
      `server/test/collaboration.test.ts`; **none of those three files exists at the base
      commit** (`collaboration.test.ts` arrived with `85bd9e7`, A3), and the LibrisVault
      baseline suite exits **0** with 1027 tests. The handle that outlives its close is the
      fire-and-forget at `fellows.ts:747`, `this.enqueue(this.planAfterFirst(...))`: the
      chained planning run resolves after the test has closed its database. Fix it at the
      source (await or cancel the enqueued work on shutdown), not by silencing the reporter.

      **How it was fixed, and why "await on shutdown" is only half of it.** Two changes, and
      the reporter was not touched. (a) `collaboration.test.ts` awaits `service.flush()` in
      its `afterEach` before closing the database - the service already had `flush` for
      exactly this, the suite just never called it, so the chained plan finishes against an
      open handle. (b) `FellowService.enqueue` now catches and logs, which is what `track`
      already did inside its own handler; everything routed through `enqueue` is work the
      caller returned without ("a courtesy and not a promise" is the code's own wording for
      the chained plan).

      (b) is not belt-and-braces, it closes the same hole in the SERVICE. `main.ts`'s `stop()`
      calls `db.close()` and never flushes, there is no `process.on('unhandledRejection')`
      anywhere in `server/src`, and Node's default has been to end the process on one since
      v15. So a Fellow spawned shortly before a restart could take the shutdown down with it.
      And awaiting on shutdown, which this entry proposed, would be the wrong half: the
      chained work awaits `settled(runId)` on a RESEARCH run, so a `stop()` that waited for it
      would hang for minutes. The enqueued work is meant to be lost on shutdown; it just must
      not be lost loudly.
- [x] **[added] `npm run typecheck` was red**, four errors, all in server test files, all
      stale fixtures against types that moved. **Fixed 2026-09-15**, each one by following
      the type rather than widening it:
      `collaboration.test.ts:172` `runsLeftToday` -> `runsLeftTonight` (the quota counts the
      night, not the calendar day, since 2026-09-14);
      `library.test.ts:181` and `:267` `runsToday` -> `runsTonight`, and the two fields
      `FellowSummary` has gained since the fixture was written (`queue`, `skipsTonight`)
      added to both;
      `shift.test.ts:188` the reading stub now returns `held`, derived honestly as
      `e.filed !== null` - an entry that was filed is one whose document the vault holds,
      which is what `locate()` decides in the real service.
      Note why nothing else caught these: `tsconfig.build.json` excludes `test/`, so the
      build stayed green, and vitest does not typecheck, so the suite stayed green.
      `npm run typecheck` now exits 0 for both workspaces.
- [x] **[added] Done 2026-09-15. `npm run lint` at the root never linted `web`.** Root was
      `"lint": "npm run lint --workspace server"`, while `web/package.json` does carry
      `"lint": "eslint ."` and the A-series added the whole eslint toolchain to that
      workspace (the only dependency change on the web side). It passes when run by hand,
      but the acceptance gate in section 8 did not cover it. The root script runs both now,
      and both are clean.
- [x] **Done 2026-09-15.** `preprocprobe` had no npm script although CLAUDE.md hard rule 6
      mandates running it after any change to the converter wiring: a rule that names a file
      path and gives no way to run it invites the path to go stale. All seven that had none
      are now beside `permprobe` in the server workspace (`preprocprobe`, `quoteprobe`,
      `usageprobe`, `oasweep`, `readingsweep`, `backfill-sources`, `graph-timelapse`), and the
      two probes a hard rule names are also reachable from the repo ROOT, which is where
      someone reads the rule.
- [x] **Done 2026-09-15.** D3 was "keep the name, explain it once", so applying it is one
      sentence and not thirteen edits: root `SPEC.md` 12.10 says the work was built in a
      private fork called *Curious*, which is why that name appears in the design records
      under `docs/tasks/`. The 13 occurrences stay where they are, as dated records.

## 7. Private-content audit (hard rule 7)

- [x] **Done 2026-09-15 (F-A6-29).** The two cheap ones were closed in F-A6-20; the third is structural and is now stated in the hook header AND answered by a tool rather than by a hope: `scripts/vault-name-scan.mjs` does the half a commit-msg hook cannot, over tracked files, over a merge diff (`--diff <base>`), or over one file - which is how the PR body gets checked before it is posted. It takes the WIDER list than the hook (concepts included), because a false positive costs a glance here and a blocked commit there. **The hook has three blind spots, not one, and content has already gone through all
      of them.** **[corrected and widened from the original single finding.]**
      1. It builds its denylist from **whole page-title stems**, so a fixture naming a
         substring of a title passes: the vault page's title ends in a parenthesised
         publisher, and the fixture wrote that parenthetical on its own, which is a stem of
         nothing.
      2. It reads only `wiki/entities/` and `wiki/sources/`. The A-series made the Fellows
         write `wiki/questions/`, `wiki/comparisons/`, `wiki/folds/` and
         `wiki/references/` - **none of them on the denylist**, and the single most verbatim
         leak found below is exactly a `questions/` title.
      3. It scans **commit messages only**. Every finding below is in *file content*, which
         the hook structurally cannot see, and `gh pr create` text is not a commit message
         either, so the PR body - which section 9 correctly calls the likeliest leak - is
         unguarded.
      **Done 2026-09-15 (F-A6-20) for the two cheap ones; the third is now written down.**
      Fragments: a title is split on parentheses, colons, dashes and commas, and each part
      joins the list at two words or more. Single-word fragments are dropped deliberately -
      that is where the false positives live, and a distinctive single word is usually the
      whole title, which is on the list anyway. Buckets: `questions/`, `comparisons/` and
      `folds/` join `entities/` and `sources/`. Three stay off with the reason in the header:
      `concepts/` would false-positive against ordinary technical wording at 585 entries (and
      the header admits what that costs, since a concept title HAS leaked), `references/` is
      upstream and public already, `meta/` holds journals named after product vocabulary.
      The third blind spot cannot be fixed in a commit-msg hook and is stated in the header
      instead, together with the two limits beside it: it reads the message and never file
      content, PR text is not a commit message, and it only knows page TITLES, so a subject
      that lives in SQLite and was quoted into a document names something no title carried.
      Calibrated before it was committed: eleven shaped cases against an invented vault, both
      documented blind spots among them, all eleven as intended; over 290 real commit messages
      it blocks exactly one, and that one is closer to right than wrong. 551 terms to 1283,
      and it runs in under a fifth of a second.
      **A file-content check before the PR is still the part that actually protects this
      merge**, and section 8's re-run is where it belongs.
- [x] **Generalise the names the A-series would newly add. Done 2026-09-15 (F-A6-13).**
      Found by matching title fragments (parenthetical parts, the part before the
      parenthesis, comma-separated parts, handles) from **every** vault bucket against the
      files this merge adds. Seven sites, two of them production code, two of them found
      only on the second pass:
      - `web/src/components/library/SpawnForm.tsx` - **both placeholders**, not one. The
        deepen example named a real vault research subject; the watch example was the
        opening words of a real `wiki/questions/` page title, verbatim. These ship to every
        user.
      - `server/src/pipeline/deepen-rank.ts:9` - production comment, same subject.
      - `server/test/tasks.test.ts` - the same subject as scope-score and ranking fixtures.
      - `server/test/dedupe-judge.test.ts` - a near-verbatim `wiki/questions/` title as the
        judge's first pair. Missed by the first pass because the real title is long and
        comma-separated; caught once the fragmenter split on commas too.
      - `web/test/markdown.test.tsx` - a real concept page title verbatim, with a comment
        that said "Found in the wild", which marked its own provenance.
      - `server/test/fellows.test.ts` - a real source page title, four times as a run label.
      - `server/test/command-model.test.ts` - already generalised in the working tree before
        this pass; kept.
      **The replacement vocabulary, so the next fixture follows it rather than inventing a
      third convention:** an invented materials-engineering register (sintering shrinkage,
      ceramic electrolytes, weld porosity, creep resistance, adaptive mesh refinement), each
      term checked to appear **zero** times anywhere under `~/vault/wiki` before use. Where a
      fixture needed a specific shape it was preserved: the markdown test still carries a
      parenthesised abbreviation inside a bold wikilink, because that shape is the bug it
      pins; the dedupe-judge pair is still one formal phrasing against one colloquial
      paraphrase. Domain keys moved from a real registry key to a neutral one where the key
      itself carried the subject. All 1819 tests still pass and both lints are clean.
- [x] **Swept 2026-09-15 (F-A6-29).** All 22 task files against 2034 terms: every hit is product vocabulary (Anthropic, hot cache, cursor, system prompt, one deliberately generic fixture). And the shape this item asked for - quoted RUN OUTPUT, which no title list can catch - was searched by hand: four blockquotes across the whole folder, of which exactly ONE is a quoted run, the known one in A7 6.4. So the sweep is complete and the decision it leaves is a single one, not a class. **[added] The audit covered code and fixtures; the TASK FILES were not swept, and at
      least one carries a verbatim quote naming two real research subjects.**
      `docs/tasks/TASKS-A7.md` 6.4 quotes a planning run against the production vault, and the
      quote names the two standing tasks of one Fellow. That quote is the EVIDENCE for the
      finding it sits under (the planner said out loud why it had nothing to propose), so
      generalising it costs something real and it is a decision, not a scrub: rewrite it with
      the F-A6-13 vocabulary, or keep it deliberately.
      **DECIDED 2026-09-15: redact the two subjects in place, and say so under the quote.**
      They read `[subject of task one]` and `[subject of task two]` now; nothing else in the
      quotation marks was touched. The third option - editing invented subjects into the quote -
      was refused on principle: a quotation with substituted content is not a generalised
      quotation, it is a fabricated one, and this file's whole value is that its findings are
      dated records of what actually happened. The evidence survives the redaction intact:
      nine candidates, all traced to the same wrong task, and a planner saying so in its own
      words.
      **Why nothing caught it, which is the part worth generalising** (F-A6-17): the term list
      of F-A6-7 is built from vault PAGE TITLES, and a standing task's subject is not one - the
      task lives in SQLite, and the pages a watch produces are named for their findings, not
      for the watch. So the audit is blind to exactly the material the A-series generates most
      of: run output quoted into a design record. Sweep the other task files for the same
      shape - a quoted run, recap or planner answer - rather than for names.
      **Partly done 2026-09-15 (F-A6-20):** the widened list was run over all 478 tracked
      files, which found two fixtures the first pass structurally could not (both quote a page
      title in the shape the FILE SYSTEM forced on it, so no whole stem matched) and no quoted
      run output beyond the one in A7 6.4 already recorded below. Both fixtures are
      generalised. What remains of this item is the decision about that quote.
      **This file was the first one swept, 2026-09-15.** It quoted, as evidence for its own
      findings, two of the very strings section 7 had just removed from the code: a vault
      entity name illustrating the hook's stem matching, and the opening words of a
      `wiki/questions/` title, twice. All three now describe the SHAPE of what was found
      instead of reproducing it, and none of the findings lost anything - the hook's blind
      spot is that a parenthetical is a stem of nothing, not which publisher it named.
      Which is the argument for doing the same to the rest: an audit record that quotes its
      own findings is a leak with a footnote.
      **Not a finding: the Fellow names.** 6.3 and 6.4 name two Fellows, and both names come
      from `web/src/lib/fellowNames.ts`, the product's own suggestion list. They ship in this
      repo already and say nothing about anyone's vault. Only the subjects matter.
- [x] **Finish the generalisation already in the working tree. Done 2026-09-15.**
      `validator.test.ts` had the handle replaced but still carried two concept pages from
      the same private subject (lines 301 and 302); both are now invented names. A partial
      rename reads as done and is not.
- [x] **DECIDED 2026-09-15: generalise at the tip, do not rewrite history. Done.** The
      already-public names were more than the two X handles this file assumed
      **[corrected]**, and more than the corrected list too. What was actually there, measured
      against the vault rather than against the earlier note:
      **five** patent numbers in `web/test/linkify.test.ts`, not three, each of which the vault
      carries (two in the index and the log, one in a concept page and an entity page, one in a
      source page, one in an entity page); **one whole concept page title** in
      `server/test/graph.test.ts` plus a word lifted out of a real source page's title;
      a **fragment** of a concept page title in `web/test/homeArticle.test.ts`, which is why
      the earlier pass walked past it - it was looking for whole titles; a page title in
      `web/test/researchRuns.test.ts` that the vault has since **reverted**; and the domain
      registry seed page, which shipped one person's actual shelves, descriptions and tag list
      to every installer.
      All replaced with invented equivalents that keep every property the tests exercise (the
      patent numbers still cover a 7-digit grant, a DE application, grouping commas, a US and a
      WO publication and a kind code). The four gates pass unchanged.
      **Why the tip and not the history.** These are subject names, not credentials. Rewriting
      a public repo's history force-pushes over every existing clone to remove something that
      has already been readable for months, and the A-series merge would have to be rebased
      onto the rewritten branch. Generalising the tip costs one commit, breaks no hash, and
      means every future reader and every future clone sees clean fixtures. The history keeps
      what it recorded, which is the same principle D4 and A7's superseded sections follow.
      **The seed page got more than a rename**, because a leak and a product defect were the
      same line: a registry that describes somebody else's reading is worse than none, since
      every ingest then files against it. It now says the list is a starting example, and it
      keeps `meta` as the one key every vault wants.
      **What the scan says afterwards** (`node scripts/vault-name-scan.mjs`, 2032 terms over
      559 files): nothing but product vocabulary that happens to be a page title (`Cursor`,
      `Anthropic`, `Assessment Report`, `Reinforcement Learning`), the author's own name in the
      README, and the four captured research runs under `scripts/demo-research/`. Those last
      are deliberate: they are real runs commissioned for a demo vault that is meant to be
      published, and they overlap the vault's subjects because the topics were chosen to.
      **[kept from the original item]** Note that these files were NOT part of the fix made
      earlier on 2026-09-15: that pass deliberately touched only what this merge would newly
      publish, because generalising an already-public fixture pre-empts this decision.
- [x] **Done 2026-09-17, after upstream's patch set was merged in (the diff against
      `upstream/main` is now exactly what the PR adds).** Added lines: 13 matches, every one
      either product vocabulary that is also a page title (`Anthropic`, `Cursor`, `Assessment
      Report`, `Reinforcement Learning`) or the four captured research runs under
      `scripts/demo-research/`, accepted above. Commit messages (391, 8,870 lines): two matches,
      `Anthropic` and one domain name quoted as a browser observation in a settled commit - a
      registry key, the generic category F-A6-21 already accepted. `docs/img/`: 14 files on the
      branch, all shot from the synthetic vault (section 5), the room ones re-shot on
      2026-09-17. The original item, kept as the record:
      Re-run the audit over the final merge diff, both commit messages and added lines, and
      over `docs/img/`. **The method is written down and rehearsed: F-A6-21 ran exactly this
      over the 41 pre-push commits, five passes, and it is the shape to repeat against the
      merge diff.** Record the method and the result under Findings so the next merge
      can repeat it rather than reinvent it. (Method and first result: F-A6-7.)
- [x] **Done 2026-09-15, and the mechanism is worth knowing (F-A6-22).** Both hold files (4
      and 2) and neither has a tracked file, so nothing of them is in the history. But they are
      excluded by **`.git/info/exclude`, not `.gitignore`** - which is the right choice for
      something that must not be named in a public file, and which **does not survive a
      clone**. A fresh clone of this repo on another machine, or a reset of that file, and the
      next `git add -A` sweeps both in. Nothing to fix before the merge; worth a line in the
      setup script's neighbourhood so it is not rediscovered by accident.
      The original item: confirm `docs/local/` and a second local directory are still excluded and still hold nothing
      that belongs in the public repo. **[corrected] They are excluded by
      `.git/info/exclude`, not by `.gitignore`** - a local, per-clone mechanism that travels
      with nothing and that no reviewer can see. Say so wherever this is relied on.
- [x] **DECIDED 2026-09-15: delete it. Done - that clone is clean (`git status` empty).**
      It was untracked and matched by **no** ignore rule (`.git/info/exclude` there is empty),
      sitting in a directory that is otherwise fully tracked, so one `git add -A` in that clone
      would have committed it into the public repo. Deleting rather than ignoring, because the
      copy in this repo under `docs/local/` is **byte-identical** (same md5): nothing is lost,
      and the hazard is gone rather than managed. Ignoring it would have left a private file in
      the middle of a tracked directory, protected only by a mechanism no clone inherits and no
      reviewer can see (F-A6-22).

## 8. Tests and gates

Status as measured 2026-09-15, on the working tree:

| Gate | Result |
|---|---|
| `npm test` | exit 0, 1825 tests pass (server 1252/83 files, web 573/52) (was exit 1; fixed 2026-09-15, F-A6-15) |
| `npm run typecheck` | exit 0 for both workspaces (was exit 2; fixed 2026-09-15, F-A6-2) |
| `npm run lint` | exit 0 for both workspaces (the root script covered only `server` until 2026-09-15, F-A6-9) |
| `npm run build` | exit 0 |
| CI | **green**, `.github/workflows/ci.yml` runs all four on every push and pull request (added 2026-09-15; its first run was red on two environment-dependent tests, F-A6-30) |
| `preprocprobe` | **PASS**, "the jail holds", 14 checks (F-A6-5, re-run 2026-09-15) |
| `permprobe` | **PASS**, run 2026-09-15 with authorisation: both canaries blocked, the expand lock's five checks ok |

- [x] `npm test`, `npm run typecheck`, `npm run lint` green **and exit 0** (section 6). All
      three measured 2026-09-15 after F-A6-15, F-A6-2 and F-A6-9; `lint` covers both
      workspaces now, so the gate is met by intent and not only by the letter of the script.
      Test count is 1825 (server 1252 / 83 files, web 573 / 52), and CI runs all four on
      every push, so this line is now measured by something other than memory.
- [x] **Done 2026-09-15, run with authorisation because it is billable.** `canary outside
      vault: blocked`, `canary in skills/: blocked`, 1 tool denial, and the expand probe's
      five checks all ok in its own throwaway vault. **PASS - confinement and the expand lock.**
      Worth reading rather than just ticking: the two canaries were refused by two DIFFERENT
      mechanisms, which is what hard rules 4 and 5 claim and what only a live run can show.
      `/tmp` came back "Read-only file system" - the OS-level sandbox, not the bash denylist,
      which is the distinction hard rule 4 spends a paragraph on. The `skills/` write was
      refused by the upstream guard's own message, in-process, on a path the sandbox would
      have allowed. A probe that only reported "blocked" twice would hide that they are not
      the same boundary.
- [x] **Done 2026-09-15.** `preprocprobe` run through its new npm script: **14 ok lines,
      "PASS - the jail holds"**. The discrepancy is reconciled in `docs/agents/ideas.md`
      rather than left as a puzzle: the note said 13 because it predated `53a9339`, which made
      the JATS conversion a check of its own.
- [x] **Done 2026-09-15 (F-A6-18):** the flag-off test from section 1,
      `server/test/agents-flag-off.test.ts`, covering routes-from-presence. The
      presence-from-flag half is the clean-clone/smoke item below.
- [x] **Done 2026-09-15.** A fresh single-branch clone, `npm ci`, then test, typecheck, lint and build in order: all four pass. Done as the verification for the CI workflow, which is the same procedure by definition. A build from a clean clone: `npm ci && npm run build` on a machine that has never seen
      this repo, so the README's quick start is verified rather than remembered.
- [x] **Done 2026-09-15 (F-A6-29, F-A6-30).** `.github/workflows/ci.yml`: the four gates as four steps on push and pull request, `npm ci` from the lockfile, Node pinned to the engines floor. Both probes stay out and the file says why - one is billable, the other needs bubblewrap and a vault, and both are what a hand-run pre-merge pass is for. **Its first run was red**, on two tests that pass here and cannot pass on a runner (F-A6-30); fixed, and green on the second. **[added] Neither repo has any CI** (no `.github/` at all in either). Every gate above
      is caught only by whoever remembers to run it, which is how a red `npm test` and a red
      `npm run typecheck` both survived into merge preparation. A minimal workflow running
      test, typecheck, lint and build on push is the cheap way to make section 8 hold after
      the merge rather than only during it.

## 9. The pull request

- [x] **Done 2026-09-17 as a merge rather than a rebase** (`a98f6cb`): 391 commits with a
      twice-audited history are not rewritten for one dependency commit. The ranges were taken
      as upstream set them and the lockfile re-resolved from ours on top, so the web lint tooling
      stays in it; fastify 5.12.3, qs 6.16.0, vitest 4.1.11 and postcss 8.5.28 match upstream,
      browserslist and electron-to-chromium came out two data releases newer. All three gates
      green under vitest 4.1.11. The original item, kept as the record:
      Rebase onto LibrisVault `main`, which is one commit ahead (`70b55fa7`, dependencies).
      **[added] The conflict is known and carries a security regression risk.** That commit
      touches exactly `package-lock.json` and `server/package.json`, and those are the only
      two files both sides changed. It is a security patch set: fastify 5.12.3, qs 6.16.0,
      vitest 4.1.11 (mocker path traversal in the dev server), postcss, browserslist. This
      branch still runs **vitest 4.1.10**. Resolving the conflict in favour of our lockfile
      would silently revert all of it. Take upstream's versions and re-resolve on top; then
      re-run the gates, because the vitest bump crosses a patch version under 82 test files.
- [x] **Stated in `PR-A6-draft.md`** (2026-09-17), verified against `upstream/main`: the server
      manifest differs by the package name and the probe scripts only. The original item:
      **[added] Worth stating in the PR body, because it is the strongest thing about this
      merge:** the A-series added **zero new server dependencies**. The web workspace gained
      only lint tooling (`eslint`, `eslint-plugin-react-hooks`,
      `eslint-plugin-react-refresh`, `typescript-eslint`, `globals`, `@eslint/js`). 303
      files and 61k added lines, no new runtime supply chain.
- [x] **Drafted in `PR-A6-draft.md` and scanned with `--file` on 2026-09-17: nothing matched.**
      Paste it rather than paraphrasing at the last minute. The original item:
      PR title and description describe the change by its mechanism, never by a vault
      subject (hard rule 7). This is the text most likely to leak, because it is the one
      written last and in a hurry - **and the `commit-msg` hook does not see it at all**
      (section 7). Read it once against the audit term list before opening the PR.
- [ ] After the merge: tag it, and update `docs/agents/SPEC.md` section 15 to what was
      actually delivered, with every deviation recorded below.

## 10. Findings

- **F-A6-32 (2026-09-15) - reading a README against the running app finds a different class of
  error than reading it against the code.** The code pass found three stale statements and felt
  thorough. The app pass found six more, and every one of them is a claim the code would have
  confirmed if you read the right file: the tab array really does list six screens, the settings
  editor really does render those keys, `Catalog.tsx` really does have those filters. What the
  code cannot tell you is the ORDER a person meets them in, which section a key ends up under,
  or that a control exists at all if you were not looking for it. The README was written from
  the inside out; a reader meets it from the outside in.
  The sharpest of the six: the README sent people to `System → Research` for the research
  settings. There is no such section and never was - the keys live in Service & config, and
  everything belonging to one Fellow is set in the Library. That sentence would have survived
  any number of code reads, because nothing in the code contradicts a section name that does not
  appear in it.
  **And the pass reproduced the bug it was reading about.** Running the four gates rebuilt
  `web/dist` under a service that had registered the old asset names at startup, and the
  dashboard came up blank - styled, because the CSS name happened to survive, and empty, because
  the JS 404'd. The README already documented this, but only for `npm run build:web`. The
  command everyone actually runs is `npm run build`, which is to say: running the gates next to
  a running service blanks it, and blanks every other service serving the same `web/dist` too.

- **F-A6-31 (2026-09-15) - a name scan built from page titles cannot see a page the vault
  deleted.** Generalising the already-public fixtures turned up a limit worth more than the
  fix. `web/test/researchRuns.test.ts` named a real concept page; the vault reverted that page
  later; so `vault-name-scan.mjs`, which builds its terms from the titles that exist RIGHT NOW,
  passes the fixture clean. The fixture still says what the vault once held. A leak does not
  expire when the page does.
  There is no way to enumerate this - a deleted page leaves no title to build a term from - so
  the only check is `git -C $VAULT_ROOT log -S "<term>"` for a term already under suspicion.
  The tool's header says so now, beside the two limits it already admitted.
  The same pass found the other two shapes the earlier audit walked past, and both are about
  what a list of whole titles cannot match: a **fragment** of a title (`homeArticle.test.ts`
  named the readable half of a long concept page), and a word lifted OUT of a title
  (`graph.test.ts` used a common scientific term that is one word of a real source page's
  name). The first is a genuine miss. The second is the false-positive side of the same coin,
  and the reason the fix replaced it anyway: deciding case by case whether a textbook word is
  "really" a vault name costs more judgement than replacing it.
  And the count was wrong in the safe direction, which is the direction to be wrong in: the
  note said three patent numbers, there were five.

- **F-A6-30 (2026-09-15) - CI failed on its first run, and neither failure was a product bug.**
  Two tests were green on this machine and red on a runner, which is the entire argument for
  having CI stated in one run. Both are the same bug class: an assertion about the ENVIRONMENT
  written as an assertion about the code.
  **`queue-integration.test.ts`**: step 8 reverts an ingest commit, and `git revert` needs an
  author identity. The file already knew that - its seed commit passes `-c user.name=t` - and
  the revert did not. Every other git-using test here sets a repo-local identity right after
  `git init`; this was the single outlier, and a developer machine can never catch it, because
  a global git identity is the first thing anybody configures.
  **`api.test.ts`**: two tests asserted `restart: 'manual'`, which `POST /settings/credential`
  and `POST /settings/telegram` answer when `INVOCATION_ID` is unset. A GitHub runner is itself
  a systemd unit and its children inherit that variable, so the honest answer there is `'auto'`.
  The two tests that expect `'auto'` set the variable deliberately; the two that expected
  `'manual'` were reading the developer's environment and calling it a result. Both now say it,
  through a `withoutSystemd()` helper that clears and restores.
  **The runner is reproducible locally**, and this is the part worth keeping:
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null INVOCATION_ID=x npm test` brings back
  both failures in one command, and the whole suite (1825 tests) passes under it now. Run it
  before trusting a green local suite to mean a green CI.
  A green suite is a claim about the machine it ran on. CI is the second machine.

- **F-A6-29 (2026-09-15) - CI, and the task-file sweep that came back almost empty.**
  Three items closed and one narrowed. **CI**: four gates, four steps, on push and pull request,
  verified by doing what it does - a fresh clone, `npm ci`, each gate in order - which also
  settles the clean-clone item. Both probes are deliberately absent and the workflow says so:
  one is billable, the other needs bubblewrap and a vault.
  **The task-file sweep** found nothing but product vocabulary across 22 files and 2034 terms.
  More useful is what it found by NOT using the list: the shape this milestone actually worries
  about is quoted run output, which carries no page title, so it was searched by hand as a
  shape - four blockquotes in the whole folder, exactly one of them a quoted run. The decision
  this leaves is therefore a single sentence in A7 6.4 and not a category of work.
  **The hook's third blind spot** cannot be closed in a commit-msg hook and is now answered by
  `scripts/vault-name-scan.mjs` instead: the same term-building, over file content rather than
  a message, with a `--diff <base>` mode for exactly the merge audit section 7 still owes and a
  `--file` mode for the PR body, which is the one text that reaches the public repo without
  passing any hook at all. It takes the wider list (concepts included) because the trade runs
  the other way here: a false positive costs a glance, not a blocked commit.
  Its header says what it cannot see, in the same words the hook's does, because the way this
  audit went wrong the first time was trusting a title-based list to be a content check.
- **F-A6-28 (2026-09-15) - the screenshots, and the three data errors only a picture showed.**
  Section 5 is done: thirteen shots, four real research runs behind them, and the README carries
  all but the repo card. The finding worth keeping is what the looking-at caught, since each of
  the three passed every automated check the repo has.
  (a) The command centre reported the research budget at **206%** in red. The figure was right -
  four Fellows at their quotas is 49 runs a week, and at the real prices the captured runs
  established that is about $196 against a default share of $100. The demo was configured too
  tight, and a standing red warning reads as a broken screen rather than as a guard working.
  (b) The reading list mixed real publications with `example.invalid` placeholders, side by side.
  (c) A research run's pages were swept into an ingest's commit, so the activity stream filed a
  patent synthesis under "ingest: some-file.pdf" - and a commit message is exactly how that
  stream says which kind of work produced a page.
  None of these is visible in the data. All three are obvious in a picture. **That is the
  argument for the "look at every image" line in section 5 being a real gate and not a
  courtesy**, and it is worth carrying into the re-run before the PR.
  One more, from the same pass: the first click selector matched Home's OTHER "Night shift"
  button, the one in the intake box, and returned a screenshot of the activity view it was
  meant to leave. The script reports a missed click, which is why that was caught; without that
  line it would have shipped as a second picture of a screen already in the README.
- **F-A6-27 (2026-09-15) - the demo seed, and the field that would have looked right.**
  `scripts/demo-vault.mjs` seeds the Fellows now (section 5). Worth recording is how it was
  checked: not by reading the SQL back, but by opening the generated database with the REAL
  stores - `SqliteAgentStore`, `SqliteProposalStore`, `SqliteRecapStore` - and printing what
  they parsed. That caught the one error that would have survived any amount of staring at the
  insert statements: `provenance.task` carries the task's TEXT, not its id, because that is what
  `planner.ts` writes and what the night's schedule groups a Fellow's standing proposals by
  (`waiting.get(t.text)` in `lib/command/model.ts`). Seeded with ids, every proposal would have
  piled onto the first task of its Fellow and the schedule would have drawn a plausible lie.
  The method generalises to the rest of section 5: **a fixture is right when the code that reads
  it in production parses it, not when it looks like the table.**
- **F-A6-26 (2026-09-15) - the security page did not know a chain that the agents opened.**
  Section 4 is done except for reading the README against a RUNNING app, which is owed together
  with the screenshots. Writing `SECURITY.md` turned up the one thing on this list that nobody
  had asked for and that matters most: **a research agent reaches the web by design and reads
  pages an earlier ingest wrote**, so a hostile document can poison a page and reach, at a
  remove, a run with network access. The ingest sandbox does not close it, because the two runs
  are separate; what limits it is that a Fellow reads its own domains, that its planning run has
  no web access and is what chooses, that every run is one revertable commit, and that the recap
  shows it in the morning. All of that is now written beside the chain rather than assumed.
  A sentence there was also narrower than it read: "ingest runs have no web egress, so a hijacked
  run cannot exfiltrate" is true of the run that reads your document and of no other kind. It
  says so now. **The general shape, for the rest of this milestone: a guarantee written before a
  subsystem existed does not become false, it becomes NARROW, and a narrow guarantee read as a
  broad one is the most comfortable kind of wrong.**
  The stale item this section already knew about turned out to be stale by fourteen months of
  drift: "the service writes to the vault only through agent runs and git commits" is now four
  paths, and the property that actually holds across all four is that each is one immediate
  commit behind the shared mutex. That is what the item says now.
- **F-A6-25 (2026-09-15) - a base-product tab was renamed by the extension work, and nobody
  had noticed.** Checking CLAUDE.md's screen list against the code for section 3 found it
  naming five screens with the tabular view called **Library**. That view has been called
  **Catalog** since `9cd92eb` (A4, 2026-09-06), and the name Library went to the new room
  screen on the same route. **The rename is not behind `AGENTS_ENABLED`**, so it is the one
  visible change an upgrading base-product install takes from the A-series: five screens
  either way, one of them renamed. It is defensible on its own terms - a catalog of pages is
  what that view is - but it belongs in D1's inventory, which had not counted it, and in the
  release notes, because a renamed tab is the kind of thing a user writes in to ask about.
  Two documents said it wrong, including the spec section written an hour earlier in this same
  milestone; both are corrected. The general shape is the same as F-A6-24: a fact that is
  wrong in one place is usually wrong in two, because the second copy was made from the first.
  **Also recorded from this pass:** the new hard rule went in as number EIGHT rather than as
  five, where it fits by subject. Over a hundred places in this repo name a hard rule by
  number; inserting one would have silently redirected every reference to rules 5 through 7.
  Numbered rules are an append-only list, and that is worth knowing before the next one.
- **F-A6-24 (2026-09-15) - the root spec is told, and the worst thing in it was said twice.**
  Section 2 is done: 12.10 (Fellows) and 12.11 (source integrity) written in the pattern 12.6
  to 12.9 set, drafted first and applied after review, as this file's own rule for the root
  spec requires. The four corrections went with them. The one worth recording as a finding is
  the bash-allowlist sentence: it appeared in section 4 AND in section 9, saying in both places
  that an agent run gets "bash on a script allowlist restricted to `scripts/*.sh`" - the exact
  opposite of what the M0 measurement established and what hard rule 4 has said since. This
  file had caught the section 9 copy and not the section 4 one, which is the general lesson: a
  wrong sentence in a spec propagates by being quoted, so a correction has to grep for the
  CLAIM rather than fix the line that was reported.
  Both now describe the sandbox as the boundary and the denylist as defense in depth, with the
  number that settles it (14 of 68 bash calls in the validated run were ordinary file tools),
  and both name the probe that proves it.
- **F-A6-23 (2026-09-15, DECIDED and implemented) - the decision round, and the one thing it
  had to settle that was not on its own list.** D1 to D5 were taken together; four went as
  proposed and D1 grew a third branch. As written, D1 split the world into "Fellows, flagged"
  and "source integrity, unflagged, because it is a correctness fix". F-A6-19 had found
  something in neither category: the reading list WROTE A VAULT PAGE with the flag off, driven
  by the ingest prompt and finished by the attribution pass, while the route that shows that
  page was gated. A feature writing where its own interface cannot look is not a correctness
  fix, so it moved behind the flag - the service hands the list to the queue and the
  maintenance runner only when the flag is on, and both build their prompt from whether they
  were handed one. The append-only rule went with it: it had been sitting in the page-hygiene
  checklist that every run carries, telling the run to add entries "in the shape the
  <reading_list> block gives" while that block could be absent. It now lives inside the block,
  so the rule and the shape it refers to travel together or not at all.
  The seam D1 asked to have named, named: fence, PDF URL handling, quote integrity and the
  expand lock are unflagged; the reading list and its sweep are the extension; open-access
  recovery is unflagged and documented as service egress.
- **F-A6-22 (2026-09-15, FIXED same day) - the base product asked for something only the
  extension owns.** Checking section 1's web item found its first half true and its second
  half false. Rendering is gated properly: the Library tab is filtered out of `TABS` on
  `fellowsOn`, and Home and System put `enabled` on every Fellow query. But `Vault.tsx:581`
  and `Catalog.tsx:229` - the Graph and the Catalog, both BASE PRODUCT screens - queried
  `/api/v1/library/scene` with no guard at all, so with the flag off each mount fired a
  request that could only 404. Both carried `retry: false`, which is the same request made
  quietly, and the comment directly above each already stated the intended behaviour
  ("without the Library there is no scene and no wing mode") while the line under it did the
  opposite. Fixed with the guard the comment described; `wingGroups` has always returned an
  empty list for an absent scene, so nothing downstream moves. Worth generalising: "no Fellow
  surface renders" was checked and passed for years, and the network half of the same sentence
  had never been checked at all.
  Also from this pass, recorded in section 7: `docs/local/` and a second local directory are excluded by
  `.git/info/exclude`, which does not survive a clone.
- **F-A6-21 (2026-09-15) - a pre-push audit over 41 commits, and the method to reuse for the
  merge diff.** The fork's own branch was pushed to the PRIVATE remote, and reviewed first on
  the grounds that a private push still fixes what a later merge will carry. Method, five
  passes over `origin/research-agents..HEAD`: (1) every commit message through the widened
  commit-msg guard, 0 of 41 blocked; (2) the added/deleted file list read by hand, 7 added and
  2 deleted, nothing of a sensitive shape; (3) the 5216 added lines for secrets - no
  `sk-ant-`, no token assignment, no bot token, no private key - where the only hit was a line
  of this file *describing* that check; (4) the same lines for absolute paths, none; (5) the
  same lines against a denylist of 2253 terms built from ALL SIX buckets, `concepts/`
  included, with fragments. **A pre-push review takes the wider list on purpose**, unlike the
  commit hook: here a false positive costs a glance and a miss costs a leak, so the trade runs
  the other way. Seven terms matched, each checked in place: three `cursor` (two of them CSS),
  and six occurrences inside this file's own sentences REPORTING the audit - product
  vocabulary, not vault subjects. Result: clean.
  What it turned up that the diff could not show is in D4: the tree carries no home path, the
  history does, in three places and partly by this file's own doing.
- **F-A6-20 (2026-09-15, hook FIXED same day) - widening the guard found two leaks the
  method could not have found, and showed what the guard costs off its own ground.** The
  commit-msg hook now reads title FRAGMENTS and three more buckets (F-A6-8's three blind
  spots, the two cheap ones). Run over the tracked tree rather than over messages, the wider
  list turns up two test fixtures that quote a `wiki/questions/` title in the shape the file
  system forced on it - a slash become an underscore, a trailing `?` dropped - so neither ever
  matched a whole stem, which is exactly the gap fragments close. Both generalised, each
  keeping the shape its test pins.
  The cost, measured so nobody mistakes one number for the other: over 290 commit messages the
  wider list blocks ONE, and that one quotes a field of study back out of a browser check,
  which is subject rather than mechanism. Over 478 tracked files it lights up 88, nearly all
  from two single-word entity titles that are also ordinary technical words, plus the author's
  name in the licence. A commit message is a paragraph and a source tree is a corpus; the list
  was built for the paragraph, and the tree scan is a lead list, never a leak count.
  One class of noise was the guard's own doing and is fixed: every synthesis page carries a
  lens name as a title suffix, so splitting on the dash put all three lens names on the list
  once per page, and a commit discussing a lens would have been blocked by vocabulary this
  repo ships. They are on the stop list now.
- **F-A6-19 (2026-09-15) - the reading list is unflagged behaviour that WRITES TO THE VAULT,
  and the prompt is half of it.** Section 1 asked what the unconditionally constructed
  `ReadingListService` costs with the flag off, and guessed the answer might be "it only holds
  state". It is the other one, through two independent paths, neither behind the flag.
  (a) `renderReadingList(INGEST_ACTOR, ...)` sits in `systemPromptExtra` of every ingest run,
  unconditionally (`queue.ts:1121`, `:1453`): the run is TOLD to append an entry to
  `wiki/meta/reading-list.md` for every publication worth having in the original, full text or
  not. (b) `attributeRun` runs after the ingest and rewrites that page's `by:` lines for the
  entries the run added (`reading-list.ts`, `fs.writeFileSync`). So a LibrisVault user who
  upgrades and sets nothing gets a new vault page their ingests fill in. This outranks D5 as
  D1's subject: the OA recovery makes third-party requests, this one writes to the vault.
- **F-A6-18 (2026-09-15) - the flag-off acceptance now has a test, covering one of its two
  halves on purpose.** `server/test/agents-flag-off.test.ts`: seven gated routes answer 404
  with their services absent, the base routes answer 200, `health.fellows` is a falsy boolean
  (asserted as a type too, because the same idea is spelled `'on'`/`'off'` in the startup
  banner and `'off'` is truthy), and one counter-test wires a gated service to watch its route
  appear. The half it does not cover is flag-to-presence, which lives in `main.ts` and would
  need `startService` - and that opens the database at `defaultDbPath()`, reads the real
  credential file and starts a watcher. A unit test that can reach the developer's own vault
  on a bad environment variable is not worth the coverage; the smoke run in section 8 is.
- **F-A6-17 (2026-09-15) - the private-content audit is blind to quoted run output, which is
  what the A-series produces most of.** F-A6-7 built its 2325 terms from vault page titles in
  every bucket. A Fellow's standing task is not a page title: it lives in `agents.tasks` in
  SQLite, and the pages a watch task produces are named for what they found, not for the watch.
  So a design record that quotes a planning run verbatim - which is the most persuasive kind of
  evidence in these task files, and the reason several findings are believable at all - passes
  the audit untouched. `docs/tasks/TASKS-A7.md` 6.4 is one such quote, naming two real research
  subjects. The generalisation: sweep the task files for quoted RUN OUTPUT (planner answers,
  recap text, log lines), not for names, and add the term source the audit cannot see -
  `agents.tasks`, `agents.intent`, `agents.scope` out of the operational database.
- **F-A6-15 (2026-09-15, FIXED same day) - the `npm test` exit is closed, and it was a
  service bug as well as a test bug.** F-A6-1 identified the frame; this is the fix. The test
  half: `collaboration.test.ts` never called `FellowService.flush`, which exists for this, so
  its `afterEach` closed the database under a spawn's chained planning run (the spawn happens
  through the recap answer path `spawn u1 <name>`, where `runFirstStep` is not set and
  therefore defaults to on - which is why the tests that pass `runFirstStep: false`
  explicitly, and the test named in the reporter, were all innocent). The service half:
  `enqueue` pushed unguarded promises, `main.ts`'s `stop()` closes the database without
  flushing, and nothing in `server/src` handles `unhandledRejection` - so the same frame ends
  the PROCESS if a Fellow is spawned shortly before a restart. `enqueue` now catches and logs,
  the way `track` already did one level down. Awaiting the work on shutdown instead would hang
  `stop()` for minutes, because the chained plan awaits a research run's `settled`.
  Verified: `npm test` exits 0 (server 82 files / 1246 tests, web 52 / 573), `npm run
  typecheck` exits 0 for both workspaces.
- **F-A6-16 (2026-09-15, FIXED same day) - the fork's own detail spec described a deleted
  component, and D2 assumed it would need no edits.** `docs/agents/SPEC.md` 10.5 "Fellow card"
  and 10.6's "Open card (switches to full mode with the docked card)" were the sidebar that
  `FellowCard.tsx` deletion removed the same day; the Fellow command centre, which is the
  entire A7 milestone, had no section of its own (one line in 8.6a). Three further claims
  shared the single cause and were corrected with it: 10.11 still specified "one task a night,
  in turn" as built behaviour although `nightly` defaults to `sweep` since A7 stage B, 8.6a
  compared its two-step grant to a quota override on the card that is now one button in the
  dossier, 10.8 illustrated a tile size with "the docked-card view", and 10.10 named the card
  as a deepen entry point (it is the shelf window). Method: the pattern the spec already uses,
  a design-era section kept with a dated superseded note and an "(as built)" section beside
  it; new 10.12. Worth stating because of what it implies for the merge: **a spec section that
  says "(as built)" ages exactly like code and nothing checks it** - 10.11 was written
  2026-09-07 and was wrong by 2026-09-09, two days later, with no test able to notice.
- **F-A6-1 (2026-09-15) - the `npm test` exit 1 is A-series fallout, not pre-existing.**
  Frame: `FellowService.planAfterFirst` (`server/src/pipeline/fellows.ts:773`) ->
  `SqliteAgentStore.get` (`server/src/db/agents.ts:364`), raised from
  `server/test/collaboration.test.ts` ("a question for a domain nobody covers is unclaimed at
  once"). Method: `git cat-file -e 156660f1:<path>` for all three files - none exists at the
  base; `collaboration.test.ts` was added by `85bd9e7` (A3, 2026-09-06). Counter-check: the
  LibrisVault clone at `156660f1` runs `npm test` to **exit 0**, 1027 tests (server 747/53
  files, web 280/25). Cause: `fellows.ts:747` enqueues `planAfterFirst` fire-and-forget; the
  chained plan resolves after the test closes its database. The earlier "pre-existing"
  reading came from stashing the four modified files rather than the 280 commits.
- **F-A6-2 (2026-09-15, FIXED same day) - `npm run typecheck` exited 2.** Four errors, all
  stale test fixtures: `PlannerInput` renamed `runsLeftToday` to `runsLeftTonight`,
  `FellowSummary` renamed `runsToday` to `runsTonight` and gained `queue` and `skipsTonight`
  (twice), `ReadingEntry` gained a required `held`. Fixed by following the types, not by
  widening them or casting. Invisible to build (tests excluded from `tsconfig.build.json`)
  and to vitest (no typecheck), which is why they survived: **a green suite is not a green
  typecheck in this repo**, and the milestone gate has to run both.
- **F-A6-3 (2026-09-15) - D1's split is real but has a seam.** The fence is wired
  unconditionally into `preprocess/plugins/office.ts:65,84`, `pdf.ts:148`, `text.ts:93` and
  `preprocess/web.ts:519`; `DEFAULT_OA_RECOVERY = true` (`db/settings.ts:168`). But the
  reading-list sweep runs inside `NightShift` (`main.ts:370`) and is therefore behind the
  flag, so it is source-integrity work on the Fellows' schedule. Section 1 demanded the
  opposite of D1 on this point; both are corrected above.
- **F-A6-4 (2026-09-15) - `health.fellows` is a boolean.** `routes/health.ts:21` sends
  `ctx.fellows !== undefined`; `web/src/api/types.ts` types it `fellows?: boolean`; three
  call sites read `=== true`. The `'on'`/`'off'` at `config.ts:389` belongs to the startup
  log banner. A flag-off test must assert falsy, not `'off'`.
- **F-A6-5 (2026-09-15) - `preprocprobe` passes, 14 ok lines.** bubblewrap available;
  credential file, vault and `$HOME` blocked; the service API and the internet blocked; a
  write outside the output directory allowed *and* verified not to reach the host; pandoc,
  pandoc-JATS, pdftotext, python3 packages and defuddle all run. "PASS - the jail holds."
  `docs/agents/ideas.md:829` records 13 from an earlier run.
- **F-A6-6 (2026-09-15) - the flag surfaces in this file are all accurate.** Every line
  reference in section 1 was checked and every one matches. Route registration is by injected
  presence (`server.ts:180-207`), with `main.ts` turning the flag into presence. The agent
  tables are created by migrations regardless of the flag; there are 29, gated by
  `PRAGMA user_version`, and none steps down.
- **F-A6-7 (2026-09-15) - private-content audit, method and result.** Method: build a term
  list from every `wiki/*` bucket (not only entities and sources) as page-title stems **plus
  fragments** - the part before a parenthesis, each parenthetical part, the part before a
  colon or dash - plus `@handle` and `0x_` handles found in page bodies; drop terms under
  five characters and terms that are entirely generic vocabulary; match case-insensitively
  with word boundaries against (a) all 280 commit messages, (b) the added lines of
  `git diff 156660f1...HEAD`, (c) the full tracked tree. 2325 terms.
  Result: **commit messages clean** - the only matches were attribution trailers
  ("Claude", "Anthropic"), "hot cache" and "Claude Code", all legitimate product or
  attribution vocabulary. **No secrets anywhere**: no `sk-ant-`, no token assignment, no
  bot token, no chat id. **File content not clean**: five places the A-series would newly
  publish, listed in section 7, of which two are production code rather than tests; plus a
  wider set already public in LibrisVault, also listed there. Re-run this with the same
  method over the final diff before opening the PR.
- **F-A6-8 (2026-09-15) - the `commit-msg` hook cannot catch any of F-A6-7.** It scans the
  message only, builds its list from `wiki/entities/` and `wiki/sources/` only, and matches
  whole stems only. Each of the three limits is independently sufficient to miss the findings
  above. The vault currently holds 35 `questions/`, 3 `comparisons/`, 1 `folds/` and 2
  `references/` pages, all written by A-series runs, all invisible to the hook.
- **F-A6-13 (2026-09-15) - the fix pass, and the two sites the first audit missed.** Seven
  sites generalised in files this merge adds; the full list and the replacement vocabulary
  are in section 7. Two were found only on the second pass and both matter for how the next
  audit is run: `SpawnForm.tsx`'s **watch** placeholder (the first pass reported only the
  deepen one, because the phrase reads as ordinary vocabulary of its field until you grep the
  vault and find 21 files and a `questions/` page opening with exactly those words), and `server/test/dedupe-judge.test.ts` (missed because the real page title is long
  and comma-separated, so no fragment of it matched until the fragmenter split on commas).
  **Lesson for the re-run in section 7: a generic-sounding phrase is not evidence of
  anything - grep the vault for it before dismissing it, and split title fragments on commas
  as well as on parentheses, colons and dashes.** After the pass, a re-scan of all 187 added
  files against 2509 title fragments returns five matches, all product vocabulary: "hot
  cache" (a documented LibrisVault feature), "Claude Code", "AI assistant" in a
  prompt-injection fixture, "assessment report" in a deliberately generic fixture, and one
  parenthetical fragment matching ordinary prose. Tests stayed at 1819 passing, both lints
  clean, typecheck 0.
- **F-A6-14 (2026-09-15) - a shell trap that corrupted the first classification, recorded so
  the re-run does not repeat it.** Under zsh, `git cat-file -e $B:server/test/x.ts` does
  **not** mean what it reads as: `:s` and `:w` are history modifiers, so the parameter
  expansion is mangled and the command reports a file as absent from the base commit
  whatever the truth is. The first pass used that form to decide "new in the A-series" vs
  "already public" and got answers that happened to be right, which is worse than being
  wrong. **Use `git diff --name-status <base>...HEAD | awk '$1=="A"'` as the authority on
  what a merge adds**, or quote the argument (`"$B:$f"`). Re-verified with the name-status
  list: all seven fixed sites are genuinely added by this merge, and
  `web/test/homeArticle.test.ts`, `web/test/researchRuns.test.ts`, `web/test/linkify.test.ts`
  and `server/test/validator.test.ts` are genuinely already in LibrisVault.
- **F-A6-9 (2026-09-15) - the root lint gate skips the web workspace.** `web` has its own
  `lint` script and its own eslint toolchain; the root script names only `server`. Web lints
  clean today, so this is a gap in the gate rather than a defect.
- **F-A6-10 (2026-09-15) - OA recovery is default-on and talks to three external services**
  during ingest: `api.openalex.org`, `api.core.ac.uk`, `www.ebi.ac.uk`. Service egress, not
  agent egress, so hard rule 4 stands - but it is undocumented and reaches every install
  that upgrades. See D5.
- **F-A6-11 (2026-09-15) - the screenshots are from 2026-08-27, not 2026-09-05.** The later
  date is the working-tree mtime; by commit the five screens are `f77548d` (2026-08-27) and
  `social-preview.png` is `b52c19e` (2026-07-19).
- **F-A6-12 (2026-09-15) - no CI in either repo, and the LibrisVault clone holds an
  un-ignored private task file** at `docs/tasks/TASKS-BIOAGENTKG.md`. See sections 8 and 7.

## 11. The Library's main room, refurnished (2026-09-17)

Done during the merge preparation, because the room as first built was going public with
furniture that had no function: the fireplace and armchairs, the front desk, the intake cart
and the card catalog. What replaced them is recorded as built in `docs/agents/SPEC.md` 10.13;
this section lists what the merge carries because of it.

- [x] Ten desks in two rows on a rug, one per Fellow, the Fellow standing in front of its own
      desk in every state; screen and lamp lit only at a busy desk. The desk is a column
      (`agents.desk`, migration v31, backfilled in spawn order for the Fellows already there),
      given at spawn and freed at retirement; the eleventh spawn is refused (`409`, `full`).
      The migration runs like every other one; the column is read only by the Fellow service
      and the scene, which exist only behind the flag.
- [x] The book cart as the one station for maintenance runs and ingests, a click into System;
      a fern where the cart stood; chalkboards on the short wall; a glazed double door in every
      passage; open cases with the books as boxes, in the main room and the wings.
- [x] A desk under the pointer lights its top round the edge, hides every bubble and names
      its Fellow's shelf (or offers a spawn); the click opens the night shift on that shelf, or
      on the night for a desk without a Fellow. Shirts in the shelf's colour, boards framed all
      round under the pointer, stiles full height with the sign let in, a lighter back panel.
- [x] Tests: `web/test/library.test.ts` (the desk from the record, guest desks, busy desks),
      `web/test/roomLayout.test.ts` (the rows, the cart's place), `server/test/fellows.test.ts`
      (seating, the cap). All three gates green and exit 0 on 2026-09-17.
- [x] The pinboard of open questions, as a prototype (SPEC 10.13): `server/src/pipeline/questions.ts`
      (every page's open questions, the strike-through as the archive, the veto of a planned
      proposal), `GET/POST /api/v1/questions[/archive]`, the easel in the room, the board window
      on the reading list's model, Start research into `/research?prefill=`. Behind the flag
      with the room it hangs in. Tests: `server/test/questions.test.ts`, `web/test/questions.test.ts`.
      Not yet: wikilinks in a question rendered as links; the `unassigned` domain treated as none;
      a README screenshot of the board.
- [x] README restructured on 2026-09-17 (881 lines to about half): Install and Run in place of
      four setup sections, the Library section rewritten for the refurnished room and the
      pinboard, the endpoint list moved to `docs/API.md` and the screenshot recipe to
      `docs/screenshots.md`. Every image re-shot that shows the room, plus `library-pinboard`.
- [x] End-to-end check of the session's Fellow and pinboard changes on 2026-09-17, over the API
      and the browser against a throwaway copy of the demo vault: desks 0..9, the eleventh spawn
      refused, a retirement's desk taken again, the strike and its commit, the veto of a planted
      proposal, restore, the room's hover and click paths, the Research prefill - 46 checks, all
      green, the production vault's HEAD and working tree identical before and after. The script
      is session tooling, not part of the repo.
- [x] Points raised in the merge review of 2026-09-17, all worked through the same evening:
      upstream's patch set merged (section 9), the pinboard's write path named in CLAUDE.md
      hard rule 1 and `SPEC.md` 12.4/12.10, the audit over the final diff (section 7), the PR
      text drafted and scanned, and the prototype's loose ends: wikilinks in a question render
      as links, `unassigned` and `meta` are no domain on the pinboard, the artboards say what
      they show.
- [x] **Found in production on 2026-09-17 and fixed on the branch (`0fa4b3b`):** the revert of
      an expand run whose validator had found a rewritten body line failed, because the one
      listing in `git.ts` that read a commit's paths as lines rather than NUL-separated
      records handed git's quoted, byte-escaped spelling of a page name with a non-ASCII
      character back to git as a pathspec. The run's commit stayed in the vault with the run
      marked failed - the state the revert exists to prevent. Every other listing already
      asked for `-z`; this one does now, with a test that names a page with a dash and expects
      the restore to bring it back. The vault the failure happened in held that commit for a
      few hours: the same day the fixed function reverted it as a new commit on top (the
      Fellow's notebook commit after it stays as it was), and the live service was restarted
      on the fix. The Fellow's recorded sleep reason still quotes the failed revert until the
      next night shift rewrites it; that text is a record of the last run, not a live state.
- [ ] Observed while running the gates on 2026-09-17: `server/test/queue.test.ts`, the
      concurrency check, failed twice in the full suite under machine load and passed alone and
      on the next full run. Its window is a 10 ms ingest against real preprocessing, which is
      tight when vitest's workers compete. Not changed; worth widening when it bites again.
- [x] Screenshots of the room re-shot from the synthetic vault (section 5's rule): `library-room`
      and `library-wing`. The command centre and the dossier were shot too and came out byte for
      byte the same: their windows cover the room.
- [ ] Not done, said so in 10.13: the design artboards under `docs/agents/design/library-screen/`
      still show the first room and are kept as the design record.
- [x] **The graph's lock (2026-09-17).** A padlock in the canvas's bottom left corner holds the
      picture on screen: the snapshot of everything that decides which nodes are drawn and how
      (filters, room, focus and depth, gaps and system pages, the search, a tag, the drill-down,
      lens and overlays) goes to sessionStorage, and while it is closed the explorer panel stays
      away, one click on a node opens its page, and Escape brings the picture back from a page,
      a filter change, a tab away or a reload. A reset, a search or a shelf click elsewhere are
      excursions the next Escape returns from; the lock opens only by its own button. The record
      is read back field by field (`web/src/lib/graphFreeze.ts`, tested), so a stale payload is
      dropped whole. The canvas's hover hint now says "click to open" wherever one click does,
      which the Library's department window had been mislabelling as a double-click. Walked
      through with a browser script: filter change and Escape, the article round trip, a tab
      away and back, a reload, unlock - 20 checks.
- [x] **The Research ledgers' search folds behind a magnifier (2026-09-17),** the graph's and
      the Catalog's mechanic: the slot at the head's right edge keeps the box's width in both
      states, `/` opens it, Escape clears and then folds it, folding clears the text, and
      switching modes starts the other ledger folded. Seven browser checks. The convention is
      written down in `web/DESIGN.md`.
- [x] **The third UI sweep (2026-09-17)**, recorded in `TASKS-SWEEP-2026-09.md`: the Catalog
      column in the graph's shape, Home without its lead facts and with the folded search, one
      bucket label map for three screens, and the lock's three design parameters as decided.
- [x] **Hygiene pass before the merge (2026-09-17, late).** A sweep over the tracked tree found
      five points, all cleared: the fork's name on two configuration surfaces (the open-access
      contact address is `OA_CONTACT_EMAIL` now, the dev instance's data directory variable is
      `DEV_INSTANCE_DATA` with a neutral default; neither was set anywhere), with the open-access
      credentials added to the README's table; 25 em dashes in strings and comments the branch
      adds, replaced with regular punctuation (the one en dash in `quotes.ts` that is itself the
      datum stays; the dashes upstream's own files carry are not this merge's); `web/DESIGN.md`
      opened on the sidebar shell of August and describes the tab row now; three whitespace
      slips; and the second untracked directory is no longer named in this file. Checked and
      left as they are: the author's name and the repository URLs only where upstream already
      has them, the vault-name scan over the whole diff at the audit's thirteen accepted
      matches, no drift from upstream/main, and 7 MB of README images.
