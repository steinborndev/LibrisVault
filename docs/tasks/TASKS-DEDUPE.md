# TASKS-DEDUPE - duplicate detection across all intake channels (2026-09-05)

Goal: a document the vault already holds is recognised BEFORE an agent run is paid for, on every
channel (drop, watch folder, Telegram), and the recognition survives a cleared history. Plus:
the activity stream on Home lets the user remove single rows. **Acceptance: a byte-identical
re-drop after "Clear history" lands as `duplicate` pointing at the vault's job; a re-download of
an ingested paper (different bytes, same DOI) settles as `duplicate` after preprocessing with no
run; a re-shared link (tracking tag appended) settles as `duplicate` at enqueue with no fetch;
a clean run that wrote nothing beyond the meta pages shows `no changes`; one drop yields one upload; a settled
row can be removed from the stream; `npm test` green on both sides.**

Post-M5 extension; the working agreement applies (top to bottom, findings recorded here).

## 0. Findings from the analysis (what was actually wrong)

- **F1 - every drop was uploaded twice.** Since the 2026-08 redesign the Inbox dropzone and
  the window-level `GlobalDrop` both heard a drop on the dropzone (the event bubbles to
  `window`); each ran `uploadFiles`. The second request reached the server 20-170 ms after
  the first and was correctly hashed as a duplicate OF THE FIRST. Every duplicate row in the
  history since 2026-08-31 was this, none came from `watch` or `telegram`.
- **F2 - dedupe memory lived only in SQLite.** "Clear history" deletes `done` rows, and the
  UNIQUE `sha256` with them. The vault had kept the same hash all along in the per-job
  `.raw/<job-id>/manifest.json` the service writes during preprocessing.
- **F3 - a byte hash cannot recognise a re-downloaded paper.** Publishers stamp a per-download
  watermark (date, licensee) into every page; the PDF bytes and even the normalized text
  differ between two downloads of the same article. The DOI is the stable identity and the
  source page's frontmatter `url:` already carries it for about half of the vault's sources.
- **F4 - a no-op run looked like a success.** The agent found the source already ingested,
  wrote nothing, and the job ended `done` with "-" pages and a vault commit that carried only
  the staged original and the skill's manifest note. Cost of finding that out: one full run.

## 1. Fix the double upload - DONE

- [x] Dropzone marks itself `data-drop-target`; `GlobalDrop` leaves drops inside such a target
      alone (`lib/dropTarget.ts`, pure and unit-tested). The veil state still settles.

## 2. Dedupe stage 1 - the vault remembers hashes - DONE

- [x] `pipeline/dedupe.ts`: `DedupeIndex.byHash` over `.raw/*/manifest.json`, re-reading only
      changed manifests. Wired into `enqueueFile`/`enqueueBatch` (all channels share them).
- [x] `JobStore.create` accepts a caller-recognised `duplicateOf` + note; the DB row wins when
      it still exists. Every duplicate row now stores its explanation in `error`.

## 3. Dedupe stage 2 - DOI after preprocessing - DONE

- [x] `extractDoi` (head of the whitespace-collapsed text, most frequent candidate wins) and
      `DedupeIndex.byDoi` over `wiki/sources/**` frontmatter (`url:`/`doi:`), job attribution
      through `.raw/.manifest.json`.
- [x] New transition `preprocessing → duplicate`; the staged `.raw/<job-id>/` is discarded only
      when git tracks nothing under it (`discardUntrackedDir`, CLAUDE.md hard rule 1 exception).
- [x] Batch members that match drop out of the combined run. Telegram notifies late duplicates.
- [x] Escape hatch: settings `doiDedupe` (live, default on). Off + re-drop ingests anyway.
- [x] Measured against the real vault: own DOIs sit within ~5,500 collapsed chars, the first
      cited DOI of a paper without one past 12,000; head = 8,000. Index cost: ~40 ms cold,
      ~1 ms warm for the hash side; ~110 ms cold for the DOI side.

## 4. Outcome "no changes" - DONE

- [x] Migration v14 `jobs.outcome`; set when the run's own commit landed with zero wiki pages
      and no page record could be recovered. Badge + note in Home, in the detail view, and in
      the Telegram message.

## 5. Per-row removal from the activity stream - DONE

- [x] `DELETE /jobs/:id` deletes a settled row (still cancels a queued one, refuses a running
      one); `DELETE /maintenance/history/:id` drops a persisted run. Both prune operational
      rows only.
- [x] Seventh table column with a two-step control on job and run rows; "Remove from history"
      in the detail view. Commit-only rows have nothing to remove.

## 6. Docs - DONE

- [x] SPEC.md §3.2, §4.1, §6.2, §6.5, §8, new §12.9; CLAUDE.md hard rule 1; README.

## 7. Follow-up 2026-09-18 - links, meta pages, log noise, the F4 line - DONE

Trigger: a post re-shared from the X app (the share link carries `?s=…&t=…`) went through a
full agent run although the vault had ingested the same post eight days earlier. The agent
recognised it after twelve turns, wrote only its log entry, and the job ended `done` with
"1 page" (`wiki/log.md`) and no `no changes` badge. Four findings, four fixes:

- **F5 - URL jobs were outside dedupe by design.** `sha256` is NULL for every web job, so
  stage 1 cannot fire, and stage 2 knew only DOIs. Fixed: `pipeline/url-identity.ts`
  canonicalizes an address (host, `www.`, fragment, trailing slash, default ports, a fixed
  list of click-tracking parameters; X posts by status id, YouTube videos by video id) and
  `DedupeIndex.byUrl` maps the source pages' `url:` frontmatter to their page. The reading-list work (PR #13)
  had brought its own `urlKey` in the meantime; on rebase the two became one function, so dedupe
  and the reading list agree on what the same address is. The queue asks
  at enqueue (`enqueueUrl`, `enqueueBatch`): a hit is a `duplicate` row at creation - nothing
  fetched, nothing staged, no run. Only a source page counts as evidence, so a failed job's
  link can be resubmitted. Settings `urlDedupe` (live, default on) is the escape hatch for a
  page that changed. Telegram answers at once; the jobs API, watcher and CLI report it.
- **F6 - stage 3 counted `wiki/log.md` as a page.** `commitVault` reports every committed
  `wiki/**/*.md`, and the skill appends a log entry even for a recognised duplicate. Fixed:
  `pipeline/wiki-meta.ts` names the meta pages every ingest touches (the skill's own address
  exemption list plus `_index.md`); `markNoChanges` and the Telegram title filter share it.
  `created_pages` keeps the full list.
- **F7 - two noise sources made up more than half of job_logs.** The Skill tool echoes the
  whole SKILL.md as a user turn (18.5 KB per run, 47 % of all log bytes in the history), and
  SDK 0.3.212 streams `thinking_tokens` progress frames (~135 rows per run). Fixed in
  `formatMessage`: user-side text is clipped to 400 chars with the omitted length noted,
  `thinking_tokens` is dropped. Assistant text and tool lines are unchanged. Existing rows are
  left as they are (operational state, 1.4 MB).
- **F8 - the F4 line announced tool-reported pages as unreported.** `newWikiPaths` sees every
  page the run dirtied; the log line now counts only those not in `written`. The pathspec
  (the union) is unchanged, so staging behaves exactly as before.

- [x] `url-identity.ts` + tests: post forms, video forms, tracking parameters, unknown
      parameters kept, non-http rejected.
- [x] `DedupeIndex.byUrl` / `pageUrls`; `JobStore.create` accepts a note-only duplicate
      (no `duplicate_of` when the delta tracker names no job).
- [x] Queue: `vaultKnowsUrl` at enqueue for single links and batch members, `urlDedupe`
      provider; settings key + checkbox in System → Service.
- [x] `wiki-meta.ts`; `markNoChanges` decides on content pages; Telegram filter reuses it.
- [x] `formatMessage`: clip user text, drop `thinking_tokens`.
- [x] F4 line counts unreported pages only.
- [x] SPEC.md §3.2, §6.2, §12.9; README; this file.

## Open

- [ ] The no-change run's commit still carries the staged original (a second copy of a PDF the
      vault already holds). Dropping it before the commit is a separate decision. (A link
      recognised at enqueue stages nothing, so this concerns files only.)
- [ ] Content dedupe without a DOI or URL (books, reports) is deliberately not built. Web
      articles are recognised by canonical address since 2026-09-18 (section 7); a page under a
      genuinely different address (mirror, unresolved shortener) is still fetched again.
- [ ] A per-job "force" (re-ingest this link although the vault holds it) would replace the
      settings toggle as the escape hatch; not built.
