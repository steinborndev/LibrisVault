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

- [ ] Test first: every resolver address passes `validateUrl` and the byte caps (written
      before the resolver exists)
- [ ] Unit tests: DOI extraction from URL and meta tags, candidate ordering, the two
      acceptance bars, banner and prompt block, `oa_lookups` freshness
- [ ] Pipeline tests with stubbed HTTP: rescue from a PDF candidate, substitute from JATS,
      all-thinner candidates keep the thin text, no DOI fails as before, the retracted flag
      reaches manifest and banner
- [ ] Schema v27 (`jobs.validation`, `oa_lookups`), setting `oaRecovery` in the System tab
- [ ] `preprocprobe` PASS after the JATS converter case was added
- [ ] Measurement: scratch `preprocessUrl` against one paywalled DOI link with a known open
      copy (named generically here)
- [ ] Checks green in both workspaces
- [ ] Doc line below, with "Measured:"
- [ ] Commit, push, deploy (server build plus restart when nothing is in flight)
- [ ] Review stop: report the commit and the riskiest files (resolver, SSRF path, migration)

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

## Deviations from the spec

none so far.

## Left open
