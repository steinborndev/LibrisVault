# Tasks: source integrity (2026-09-13)

Implementation of `docs/sources/SPEC.md`: six chunks that harden how the service acquires and
reads a source, and how a deepening run may touch the vault. The spec's decision table (D1 to
D16) was settled with the user before the first line of code and is not reopened here; this
file records what was built, what was measured, and what is left open.

Order, one commit per chunk (spec section 11):

1. PDF URLs (spec section 3)
2. Untrusted fence and injection warning (spec section 4)
3. Open-access recovery inside a URL job (spec section 5, schema v27, setting `oaRecovery`)
4. Reading-list sweep and board (spec section 6)
5. Quote integrity in the validator (spec section 7, with calibration)
6. Expand lock (spec section 8)

Measurement rules for every chunk (spec section 2.6, and the working agreement for this
task): scratch runs of `preprocessUrl` / `preprocess` in a directory OUTSIDE the vault, a
Playwright probe against the dev server with injected data for the UI, and the two live
probes (`preprocprobe`, `permprobe`) for the boundaries. No jobs are created in the running
instance, nothing is written to the vault, no agent run is started except the two probes.

## Chunk 1: PDF URLs

- [x] Unit tests: `pdfUrlFor` (arXiv abs with and without a version, `.pdf`, `/pdf/`, a DOI
      link), content sniffing (`%PDF-` bytes against a `text/html` content type and the
      reverse)
- [x] Pipeline test with a stubbed fetch: PDF bytes on a URL job yield `type: 'pdf'`, the
      manifest carries the URL, the plugin's notes ride along; missing tools fail it the way a
      dropped PDF fails
- [x] Measurement: scratch `preprocessUrl` against one arXiv abstract address
- [x] Checks green in both workspaces (`tsc`, `eslint`, `vitest`)
- [x] Doc line below, with "Measured:"
- [x] Commit

## Chunk 2: untrusted fence and injection warning

- [x] Unit tests: fencing with forged tags in three spellings, URL escaping, a passthrough
      file left alone, the PDF and office outputs fenced
- [x] Unit tests: the injection pattern list on positive and negative samples, including a
      page that discusses prompt injection as its topic
- [x] `UNTRUSTED_CONTENT_RULES` on every writing run
- [x] Measurement: scratch `preprocessUrl` and a scratch saved-page run show the fence; a
      crafted sample produces the warning line
- [x] Checks green in both workspaces
- [x] Doc line below, with "Measured:"
- [x] Commit

## Chunk 3: open-access recovery inside a URL job

- [x] Test first: every resolver address passes `validateUrl` and the byte caps (written
      before the resolver exists) - `test/oa-guard.test.ts`, written and failing before
      `preprocess/oa.ts` had a body
- [x] Unit tests: DOI extraction from URL and meta tags, candidate ordering, the two
      acceptance bars, banner and prompt block, `oa_lookups` freshness
- [x] Pipeline tests with stubbed HTTP: rescue from a PDF candidate, substitute from JATS,
      all-thinner candidates keep the thin text, no DOI fails as before, the retracted flag
      reaches manifest and banner
- [x] Schema v27 (`jobs.validation`, `oa_lookups`), setting `oaRecovery` in the System tab
- [x] `preprocprobe` PASS after the JATS converter case was added
- [x] Measurement: scratch `preprocessUrl` against one paywalled DOI link with a known open
      copy (named generically here)
- [x] Checks green in both workspaces
- [x] Doc line below, with "Measured:"
- [x] Commit, push, deploy (server build plus restart when nothing is in flight)
- [x] Review stop: report the commit and the riskiest files (resolver, SSRF path, migration)

## Chunk 4: reading-list sweep and board

- [ ] Unit tests: candidate selection (reach, identity, archive, filed, freshness), the
      three-line block edit on a fixture page, the item's `oa` field
- [ ] Playwright with injected data: the mark and the button text under the paywalled reach,
      a click issues the existing ingest call
- [ ] Measurement: `--dry-run` of the sweep over the live list, nothing written
- [ ] Checks green in both workspaces
- [ ] Doc line below, with "Measured:"
- [ ] Commit, push, deploy (web build only with the restart right after)

## Chunk 5: quote integrity in the validator

- [ ] Unit tests: extraction across the four typographies and the callout, exclusions,
      normalization cases, ellipsis segments, the five-word floor
- [ ] Queue test: one held and one invented quote yield one finding, the summary and the log
      line
- [ ] Calibration: `quoteprobe` over the last twenty done ingests with artifacts, rate
      recorded below; the check ships only with that record
- [ ] Facts row and stream chip in the web app
- [ ] Checks green in both workspaces
- [ ] Doc line below, with "Measured:" and the calibration rate
- [ ] Commit, push, deploy (web build plus restart)
- [ ] Review stop: report the commit and the riskiest files (normalization, validator rule,
      calibration)

## Chunk 6: expand lock

- [ ] Probe first: the four expand cases in `server/src/cli/permprobe.ts`
- [ ] Unit tests on `decidePermission` for every rule, including the frontmatter exception
      and `MultiEdit`
- [ ] Implementation in `permissions.ts` and the runner
- [ ] `permprobe` PASS (expect `canary outside vault: blocked`)
- [ ] Checks green in both workspaces
- [ ] Doc line below, with "Measured:"
- [ ] Commit, push, deploy (server build plus restart)
- [ ] Review stop: report the commit and the riskiest files (`permissions.ts`,
      `agent-runner.ts`, probe)

## Done

- [x] **Chunk 1, PDF URLs** (2026-09-13). `pinnedRequest` answers with a `Buffer` and the
      content type; `fetchBytes` is the lane under it and `fetchCapped` decodes for HTML.
      `pdfUrlFor` rewrites an arXiv abstract to its PDF (keeping a version suffix, because
      `/abs/x v1` names that revision and the latest is a different document), and takes a
      `.pdf` path or a `/pdf/` segment; `isPdfAnswer` sniffs every answer, magic bytes beating
      the content type in both directions, so a paper served as `text/html` still ingests and a
      login page behind a `.pdf` address reaches the junk gate. The lane writes `raw.pdf` and
      hands it to the ordinary file chain, so every PDF rule (pdfinfo, pdftotext, OCR, the
      deferral beyond its limits) applies unchanged; the chain core gained `notePrefix` and
      `extraNotes` so the manifest says which lane produced a note without the core learning a
      type's name. The HTML helpers the text plugin shares moved to `preprocess/html.ts`
      (`web.ts` re-exports them): the PDF lane needs the chain, the chain needs the text
      plugin, and the text plugin needed `web.ts` - a cycle no one wants to debug later.
      Measured: a scratch `preprocessUrl` over one arXiv abstract address, outside the vault,
      reports `type: pdf`, `manifest.url` the address given, notes naming the rewritten
      address, 4,551,203 bytes fetched and 107,403 characters extracted by the real pdftotext
      inside its jail. `preprocprobe`: PASS (13 checks). Server 1,114 tests, web 475, `tsc`
      and `eslint` clean in both.

- [x] **Chunk 2, the untrusted fence and the injection warning** (2026-09-13).
      `preprocess/fence.ts` wraps every artifact the pipeline writes - a fetched page, a page
      saved from a browser, a PDF extraction, an office conversion - in an `<untrusted-source
      url kind>` tag with the four-line notice, under a heading and below any banner; a forged
      opening or closing tag inside the document, in any case or spacing, becomes
      `untrusted-source-inner` and stays visible, so a page can neither close the fence early
      nor open a second one and speak as the service. `documentTextOf` takes the wrapper back
      off, which is what the thin-page bar (chunk 3) and the quote check (chunk 5) read.
      Passthrough originals are untouched and say `passthrough, unfenced` (D7). The fence is
      the LAST thing written, so the junk gate still measures the document.
      `preprocess/injection.ts` is the tripwire: four shapes (overriding earlier instructions,
      a role asserted at an assistant, a request to keep something from the user, a command
      about the system prompt) in English and German, each firing once with its offset,
      recorded as a manifest note, in `manifest.warnings`, and logged by the queue at level
      `warn` - the job runs on (D8). `UNTRUSTED_CONTENT_RULES` rides on every writing run
      (single ingest, batch ingest, and every maintenance or Fellow run).
      Measured, scratch runs outside the vault: a fetched encyclopedia article on prompt
      injection produced one warning (`"Ignore the above directions"` at offset 1901) and
      ingested normally, the fence costing 488 of 22,898 artifact characters; the same bytes
      dropped as a saved page fenced as `kind="saved-page"` with `Saved from:` intact; a
      crafted sample tripped three of the four rules and had one forged closing tag defused.
      Server 1,134 tests (20 new), web 475, `tsc` and `eslint` clean in both.

- [x] **Chunk 3, open-access recovery in the URL job** (2026-09-13). `preprocess/oa.ts` holds
      the three resolvers (OpenAlex, then Europe PMC, then CORE only with a key), the candidate
      order (version of record first, document before landing page), the two acceptance bars
      (longer than what is in hand AND at least 6,000 characters) and the disclosure. It runs
      for a URL job only, with the setting on, with a DOI, and never for an arXiv address: on a
      refused fetch (401/403), on a junk-gate verdict, when the PDF lane declined the document,
      or on a page under the bar. A rescued PDF becomes a `pdf` job through the ordinary plugin;
      a rescued page or JATS full text stays `web`. Every copy is disclosed four times over: the
      manifest's `oa` block, the banner as the artifact's first lines, `renderOaNotice` on the
      run's prompt (with `url:` kept as the REQUESTED address), and the three `oa_*` lines the
      reconcile step writes into a reading-list entry. `oa_lookups` (v27) keeps a round: a find
      is reused at once, a blank for seven days, and a 429 is never recorded as "nothing found".
      Two structural moves came first: `preprocess/fetch.ts` now holds the SSRF guard, the pin
      and the caps (the resolver needs the same gate and must not import the URL lane), and the
      DOI pattern moved into `pipeline/identifiers.ts` beside `arxivIdFromUrl`, with `doiFromUrl`
      and `doiFromHtml` - the latter reads citation meta tags and a canonical DOI link, never a
      DOI out of running text, which is most often a work the page cites.
      Measured, scratch run outside the vault: one paywalled publisher DOI link (a 2021 journal
      article with a green copy) served a JavaScript shell of 0 extractable characters, the
      rescue asked OpenAlex, took the repository landing page it named, and extracted 87,408
      characters in 4 seconds, `kind: rescued`, `submittedVersion`; the job log names the reason
      it looked and the copy it took. A second DOI with no open location anywhere failed exactly
      as its fetch failed, with `no open copy cleared the bar (tried 0)` appended. `preprocprobe`
      with the new JATS case: PASS (14 checks). Server 1,154 tests (36 new), web 475, `tsc` and
      `eslint` clean in both.

- [x] **Chunk 3, review fixes** (2026-09-13, separate review after the chunk commit). Seven
      findings, six of them worth a behaviour change:
      1. The negative cache never applied once candidates had been tried: `lookupIsFresh`
         called such a round fresh, the early return demanded an empty candidate list, so every
         job and every nightly sweep asked all three APIs again. A round without an ACCEPTED
         candidate is now the negative answer that stands for seven days.
      2. A rejected candidate left its raw file in `.raw/<job-id>/`, which is committed with the
         job - a record page could ride into the vault beside the document, and two rejected
         formats could leave two `oa-copy.*` behind. `readCandidate` keeps bytes in memory,
         converts in a scratch directory outside the vault, and only the accepted candidate is
         written; pandoc reads JATS on stdout, so there is no intermediate file at all.
      3. CORE copies were labelled `acceptedVersion` although CORE states no version
         (`documentType` is "research" or "thesis"): the run would have marked a quote from the
         version of record as an accepted manuscript, D14 pointed the wrong way. Now `null`.
      4. The contact address travelled in the OpenAlex query and so into every error line this
         module writes (D15 says never logged). It goes as the `User-Agent` header OpenAlex
         documents for the polite pool, host-bound and dropped on a redirect.
      5. Five test gaps, all on paths the chunk claimed: the header dropped on a cross-host
         redirect, the 429 path through to `rateLimited`, the rescue after the PDF lane declined,
         the three `oa_*` lines of the reconcile step, and finding 1 itself.
      6. One new em dash in `oa.ts`, now a hyphen.
      7. Small ones: an unknown version leaves the `oa_version` LINE out rather than writing
         "version not stated" into a field the parser reads back; the 429 check is a status, not
         a regex over the message; a Europe PMC preprint is recognised by `source: 'PPR'`, not by
         `pubType`. And a find of its own: after a rescue that followed a deferral, the PDF
         lane's reason was lost with the manifest it replaced - its notes come along now.
      Measured (the review's eighth point, the PDF-candidate path through the real jail rather
      than a mocked converter): one paywalled publisher DOI link whose best open location is a
      repository PDF - the publisher page was a shell of 0 extractable characters, the copy was
      fetched (1,681,760 bytes) and `pdftotext` inside bubblewrap extracted 192,745 characters
      in 3 seconds; `type: pdf`, `original: oa-copy.pdf`, and the job directory holds exactly
      `manifest.json`, `normalized.txt`, `oa-copy.pdf` and `raw.html` with no scratch directory
      left anywhere. Server 1,163 tests (9 new), web 475, `tsc` and `eslint` clean in both.

## Deviations from the spec

- **`ReadingItem.oa` is `{ url, version, at }`, not `{ url, version, source }`** (spec 6.2).
  The page carries `oa_url`, `oa_version` and `oa_at`, so the date is what can be read back;
  the resolver's own name stays in the job's manifest, which is the record of what that job
  did. A `source` field on the item would have had to be invented on every read.
- **CORE's inline `fullText` is not used; only its `downloadUrl`** (spec 5.2). Every candidate
  is an ADDRESS, which is what lets it pass `validateUrl` and the caps like any other fetch and
  be reused from `oa_lookups` later. Text pasted into a resolver's JSON answer would be the one
  document that reaches an agent without going through the fetch layer, and it cannot be cached
  by address. CORE is the third resolver and only runs with a key, so no copy is lost today.

## Left open
