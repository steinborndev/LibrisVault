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

- [x] Unit tests: candidate selection (reach, identity, archive, filed, freshness), the
      three-line block edit on a fixture page, the item's `oa` field
- [x] Playwright with injected data: the mark and the button text under the paywalled reach,
      a click issues the existing ingest call
- [x] Measurement: dry run of the sweep over the live list, nothing written
- [x] Checks green in both workspaces
- [x] Doc line below, with "Measured:"
- [x] Commit, push, deploy (web build only with the restart right after)

## Chunk 5: quote integrity in the validator

- [x] Unit tests: extraction across the four typographies and the callout, exclusions,
      normalization cases, ellipsis segments, the five-word floor
- [x] Queue test: one held and one invented quote yield one finding, the summary and the log
      line
- [x] Calibration: `quoteprobe` over the last twenty done ingests with artifacts, rate
      recorded below; the check ships only with that record
- [x] Facts row and stream chip in the web app
- [x] Checks green in both workspaces
- [x] Doc line below, with "Measured:" and the calibration rate
- [x] Commit, push, deploy (web build plus restart)
- [x] Review stop: report the commit and the riskiest files (normalization, validator rule,
      calibration)

## The calibration record (spec 7.6)

`server/src/cli/quoteprobe.ts` over the last 19 finished ingests that still have their artifacts
AND their commit. Two sessions: four rounds on 2026-09-14 before the check shipped, and four more
the same day after a review read the residue and found the classification wrong.

| What was checked | Quotes | Unverified | Rate |
|---|---|---|---|
| Every quote on every page the job touched | 2,971 | 2,921 | 98.3 % |
| Only the quotes the job ADDED (its commit against its parent) | 476 | 427 | 89.7 % |
| ...and not on the vault's journals, indexes and `wiki/meta/` | 154 | 111 | 72.1 % |
| ...and punctuation at a quotation's edge ignored | 154 | 100 | 64.9 % |
| ...and WORDS compared rather than characters | 154 | 98 | 63.6 % |
| ...and the document's own title in the corpus | 154 | 98 | 63.6 % |
| ...and a second PDF extraction in reading order in the corpus | 154 | 90 | **58.4 %** |

Each row was measured on its own, by taking the later additions back out. The title row moves
nothing HERE and is kept all the same: these nineteen jobs were preprocessed before the manifest
carried a title, so there is none to read for them. It will count for what is ingested from now
on, and the class it fixes was found in this sample by hand.

What each round says:

1. **A page is written by many runs.** The journal, the indexes and a Fellow's synthesis page
   carry every earlier run's quotations, and one job's document cannot possibly contain them.
   So the check compares what stands on a page now against what stood there before the run's
   commit; without a commit to compare against it checks nothing and says so.
2. **A run narrates in quotation marks on the bookkeeping pages** - the next step it plans, the
   user's own question, a source's title. 292 of those 476 quotes stood on such a page, 288 of
   them unverified. Those pages are out of scope, the same set the link checks and the expand
   rules already exempt.
3. **The comma inside the quotation marks is the quoting page's, not the source's.**
4. **A quotation differs from its source in punctuation constantly and in words almost never.**
   The source puts one word of the sentence in typographic quotes and the page quotes the
   sentence without them; the page writes a comma where the source has a dash. Both sides are
   reduced to their WORDS now (runs of letters and digits), and the comparison is over those.
5. **The document's own title is not in the artifact.** A fetched page's artifact opens with its
   ADDRESS and defuddle drops the `<h1>`; a PDF's title page lands wherever the layout had it. A
   run quoting the title - an ordinary thing to do - was reported as inventing it. The title now
   travels in the manifest (`<title>`, Open Graph, `citation_title`, `pdfinfo`) and joins the
   corpus.
6. **`pdftotext -layout` interleaves the columns of a two-column paper**, so a sentence that runs
   across the column break comes out with the neighbouring column's words inside it. The check
   adds a second extraction in reading order (no `-layout`, contained, into a scratch directory
   outside the vault) to the corpus. It roughly doubles a PDF corpus - one job went from 51,867
   to 97,853 words of index - and it is the corpus only: the agent's artifact is untouched.

**A method error in the first record, corrected.** It claimed 80 of the 100 failures had "fewer
than three consecutive words in the document". That number came from measuring the leading PREFIX
of each quote, which is a different question: a quote whose first word is wrong and which is
verbatim after it scores zero on a prefix and nearly everything on the real measure. The review
of 2026-09-14 measured the longest RUN of a quote's own words instead and found a quarter of the
residue was normalization rather than invention - which rounds 4 to 6 above then removed. The
probe prints the distribution itself now, so the record below is one command away:

| How much of a failing quote IS in the document, in one run of words | Count | Share |
|---|---|---|
| All of it (a verbatim quote the check still refused) | 0 | 0 % |
| 60 % up to all of it | 16 | 17.8 % |
| 30 % up to 60 % | 21 | 23.3 % |
| Under 30 % | 53 | 58.9 % |
| (of all of them: fewer than three words in a row) | 60 | 66.7 % |

So: **no verbatim quotation is refused any more**, and the failures divide into two kinds the
finding now names in its own text ("longest match 7 of 10 words"):

- **16 misquotes**, most of them one word out - a pronoun, a tense, a figure written `1 million`
  where the source writes it another way, a word dropped mid-sentence. Read individually: real
  differences between what the page attributes and what the document says, not extraction noise.
- **60 with fewer than three words in a row**, which is a sentence nobody wrote: a paraphrase in
  quotation marks (the same source quoted verbatim on one page and condensed on another, which is
  how it was recognised), a slogan the run coined out of the material, and one job of 17 quotes
  that read a German source and quoted it in English - against the vault's own language rule,
  which says a verbatim quotation keeps its language with a note. Verified by hand against that
  job's artifact: the sentence exists in the document only in German.

That is the rate the check ships with. It is a measurement of these runs' habits, not of the
check: the prevention side went in with chunk 2 (every writing run is told to keep a quote
verbatim, attributed and marked), and the same command measures the next twenty ingests against
this record. One class is left open and noted below: a compound written `non-linearity` in the
source and `nonlinearity` on the page is two words against one, and joining hyphenated tokens
would fix it at the price of turning `10-20` into one number.

## Chunk 6: expand lock

- [x] Probe first: the four expand cases in `server/src/cli/permprobe.ts`
- [x] Unit tests on `decidePermission` for every rule, including the frontmatter exception
      and `MultiEdit`
- [x] Implementation in `permissions.ts` and the runner
- [x] `permprobe` PASS (expect `canary outside vault: blocked`)
- [x] Checks green in both workspaces
- [x] Doc line below, with "Measured:"
- [x] Commit, push, deploy (server build plus restart)
- [x] Review stop: report the commit and the riskiest files (`permissions.ts`,
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

- [x] **Chunk 4, the reading-list sweep and the board** (2026-09-14). `lookupOpenAccess` asks
      the resolvers and fetches NO document, which is what twenty lookups a night can afford;
      `openCopyCandidates` picks the entries worth asking about (current, not filed, not already
      marked, reach `paywalled` or `unreachable` or a `blocked` reason, and carrying a DOI or an
      arXiv id - which is a find by itself), and `ReadingListService.markOpenCopies` writes the
      three lines into each find's own block, one commit for the night behind the shared mutex,
      with `dryRun` for the CLI. The shift runs it before phase 0 and logs what it checked. On
      the board, a paywalled row with a copy reads `paywalled · HTTP 403 · open copy · accepted
      manuscript` and its action becomes "Ingest via the open copy", which posts the entry's OWN
      url to the existing route: the job meets the same wall the Fellow did and is rescued from
      the cached lookup, so there is no second door and the disclosure is the one from chunk 3.
      An entry with a copy stays on the paywalled side of the toggle - it is still one the user
      could not read.
      One hazard found while measuring: a fresh lookup row that NAMES a copy would have made the
      sweep skip that DOI for a week, so a dry run - or an ingest that failed after looking -
      would have kept the mark off the board. Only a round that named nothing at all now stops
      the sweep asking (`lookupSaysNothing`); a round that named one is read from the row and
      marked without touching an API.
      Measured: the UI probe (the Chromium in the Playwright cache, driven over CDP, the
      reading-list answer and the ingest POST intercepted, no service and no job involved) shows
      0 rows on the open side, then the two injected paywalled rows with exactly the label and
      the button above, and the click posts `{"url":"https://publisher.example/articles/one"}` -
      the entry's address, not the copy's. Dry run over the live list: 21 entries, 3 asked (the
      paywalled ones with a DOI that nobody had answered), 1 with an open copy at a PMC mirror,
      2 with none; the page was untouched afterwards (no `oa_url` line, clean `git status`) and
      the three rounds are in `oa_lookups`, so tonight's sweep marks that find without asking
      OpenAlex again. Server 1,168 tests (5 new), web 478 (3 new), `tsc` and `eslint` clean.

- [x] **Chunk 5, quote integrity** (2026-09-14). `pipeline/quotes.ts` extracts a page's
      quotations (four typographies, the `> [!quote]` callout, five words or more, no
      frontmatter, code fence, inline code or callout header), normalizes both sides (NFKC,
      hyphenation at a line end, soft hyphens, dashes, typographic quotes, citation markers,
      whitespace) and looks each one up in the text the job read - the artifact in
      `.raw/<job-id>/` with the fence and the banner taken off, the union over a batch, markup
      stripped from an HTML passthrough. An ellipsis splits a quote into segments that must
      occur in order. The queue runs it after the commit, logs one finding per unverified quote
      at `warn`, and writes `{ quotes: { checked, unverified } }` into `jobs.validation`
      (v27). The record shows `Quotes: 12 checked · 1 unverified` and a stream row with an
      unverified quote wears a `1 quote` chip in the warning tone. Nothing is written to the
      vault: advisory, like every other validator rule.
      Measured: the calibration above (four rounds, 2,971 to 154 quotes checked, final rate
      64.9 %, with the residue read line by line and one class verified by hand against its
      German source). UI probe (Chromium over CDP, injected jobs): the chip reads `1 quote`
      with its tooltip on the job that has one and is absent on the two that do not, and the
      opened record's facts read `QUOTES 12 checked · 1 unverified`. Server 1,183 tests (15
      new), web 482 (4 new), `tsc` and `eslint` clean in both.

- [x] **Review fixes for chunks 4 and 5** (2026-09-14, second separate review). Hygiene first
      (hard rule 7): the task file quoted a sentence from an ingested source verbatim in two
      languages, a real paper title stood in two comments, and a real vault domain in a test
      fixture - all three replaced by generic examples or by a description of the class.
      Chunk 4, three findings:
      1. The sweep marked `candidates[0]` without reading `tried`, so a copy an ingest had already
         fetched and thrown away as a record page was still offered. `bestUntriedCandidate` is now
         the one way to pick, in the shift and in the CLI; no untried copy means no mark.
      2. An entry marked from an arXiv id has no DOI, so the board's click - which posts the
         ENTRY's publisher address, by design - had nothing to resolve and failed on the same wall
         the Fellow met. The entry's `oa_url` now travels to the job as a hint and is tried as the
         FIRST candidate, through the same SSRF gate, the same caps and the same two bars; the
         resolvers still run when it does not work out, and the recovery no longer needs a DOI at
         all to try what is already known.
      3. A mark was never revised: after an ingest that tried every copy and failed, the row kept
         offering the click and the sweep skipped the entry for good. The board now reads the
         lookup row - `lookupExhausted` - and says `copy named, not readable` with no button. The
         mark itself stays true: a copy does exist at that address, it is just not the paper.
      And `oasweep --write` is gone: marking belongs to the night shift behind the service's own
      commit mutex, and a CLI with a second mutex could interleave a commit with it.
      Chunk 5: the review reproduced the calibration, measured the residue by the longest RUN of a
      quote's words rather than by its leading prefix, and found a quarter of it was normalization
      rather than invention - my own classification was wrong, and the record above now says so
      and carries the corrected method. Four changes followed (rounds 4 to 6 of the table, plus
      the finding's wording): words are compared rather than characters, the document's own title
      joins the corpus, a second PDF extraction in reading order joins it too, and every finding
      names how much of the quote IS there ("longest match 7 of 10 words"). One scan over all four
      typographies replaced one pass per typography, because `„…“` closes with the character
      `“…”` opens with and a German quotation could pair with an English one across a page.
      Measured: 154 quotes checked, 90 unverified (58.4 %, from 64.9 %), and NO verbatim quotation
      refused any more (the review found three). `preprocprobe` PASS after the corpus gained a
      `pdftotext` call. Server 1,192 tests (14 new), web 483 (1 new), `tsc` and `eslint` clean.

- [x] **Chunk 6, the expand lock** (2026-09-14). `PermissionContext.expand` carries the page set,
      the cap, the run's own set of created pages and an `exists` predicate;
      `RunAgentOptions.expand` builds it per run, and the maintenance runner passes it for
      `research-expand` only - which is why an ordinary ingest may still rewrite a page.
      `decidePermission` applies the rules after the confinement and the upstream guard: a
      bookkeeping path is exempt as before, a listed page takes `Edit` (additive) and refuses
      `Write` and `NotebookEdit`, a page outside the set refuses everything unless it does not
      exist yet and the run has created fewer than three, and additivity is `isSubsequence` over
      trimmed non-empty lines - the same function the commit check uses, so the hook cannot be
      stricter or laxer than the check that reverts a run. `replace_all` is refused; an edit that
      only changes `updated`, `related` or `tags` inside the frontmatter is allowed; a `MultiEdit`
      is refused whole when one of its edits fails. The commit check and the revert are unchanged:
      they remain the backstop for a page written through Bash, which no hook can see.
      Written probe-first and test-first, as asked: the four cases went into `permprobe` and
      fifteen cases into `test/permissions.test.ts` before `permissions.ts` had a rule.
      Measured, `permprobe` on 2026-09-14: `canary outside vault: blocked`, `canary in skills/:
      blocked`, and the expand run (a throwaway vault of its own, so an ALLOWED insertion can be
      shown without writing into the real vault, which the reconciler would commit) reports
      `Write over a page outside the set: the page is untouched`, `Edit that drops a line: the
      line survived`, `Edit that inserts a line: the insertion landed`, `at most three new pages:
      3 new page(s)` - three tool denials in the run. PASS. Server 1,206 tests (14 new), web 483,
      `tsc` and `eslint` clean in both.
      One correction from the probe itself: the first version expected a Write to a page outside
      the set to be denied outright, and it was allowed - correctly, because the page did not
      exist and rule 3 lets a deepening create up to three. The case now seeds a page that DOES
      exist, which is what `outside-set` means.

## Deviations from the spec

- **`ReadingItem.oa` is `{ url, version, at }`, not `{ url, version, source }`** (spec 6.2).
  The page carries `oa_url`, `oa_version` and `oa_at`, so the date is what can be read back;
  the resolver's own name stays in the job's manifest, which is the record of what that job
  did. A `source` field on the item would have had to be invented on every read.
- **A quotation is compared word by word, not character by character** (spec 7.3 lists the
  normalizations). Same intent, one step further: both sides are reduced to runs of letters and
  digits, so a mark the source puts around one word of the sentence, a comma where the source has
  a dash, or a bracket the page adds cannot fail a quotation that is verbatim. Measured in the
  second calibration round. Left open there: a compound the source hyphenates and the page does
  not is still two words against one.
- **A finding says how much of the quote was found** ("longest match 7 of 10 words") beyond the
  wording spec 7.4 fixes, because "not found in the source" describes a one-word misquote badly.
- **The quote check reads the quotes a run ADDED, not every quote on a page it touched**
  (spec 7.1), and it needs the run's commit to know the difference; without one it checks
  nothing and the record says so. Forced by the calibration: the spec's own wording reported
  98.3 % of 2,971 quotes as unverified, nearly all of it about text the job never wrote (spec
  7.6 exists to catch exactly this). The vault's journals, indexes and `wiki/meta/` pages are
  out of scope for the same reason, measured in the record above.
- **CORE's inline `fullText` is not used; only its `downloadUrl`** (spec 5.2). Every candidate
  is an ADDRESS, which is what lets it pass `validateUrl` and the caps like any other fetch and
  be reused from `oa_lookups` later. Text pasted into a resolver's JSON answer would be the one
  document that reaches an agent without going through the fetch layer, and it cannot be cached
  by address. CORE is the third resolver and only runs with a key, so no copy is lost today.

## Left open

From the spec's own section 12, untouched here by design: numeric consistency (numbers on a page
traceable to the source), a standalone nightly retraction sweep over every source page with a DOI
(the OpenAlex flag already reaches the manifest), quote integrity for research runs (which needs
their fetched sources kept - a decision about storing third-party text in a run's job directory),
and scholarly discovery as a tool for Fellows (`docs/agents/ideas.md`).

Found while building, and left where it was found:

- **A compound the source hyphenates and the page does not** (`non-linearity` against
  `nonlinearity`) is two words against one, and the quote check reports it. Joining hyphenated
  tokens would fix it and would turn `10-20` into one number; neither is obviously right.
- **The agent reads the `-layout` extraction of a two-column PDF**, with the columns interleaved.
  The quote check works around it with a second extraction in reading order; whether the PLUGIN
  should hand the agent reading order instead is a question about every ingest, not about this
  check, and it belongs with whoever measures what the agent actually misreads.
- **The recap does not name the night's open-copy finds.** Spec 6.3 calls that optional and not
  part of the first delivery; the log line and the board carry it today.
- **The root `SPEC.md` has not been told.** Spec section 1 leaves its section 5 pointer to merge
  preparation (`docs/agents/ideas.md`, "Still open: the root spec has not been told"), and this
  work did not touch the root spec.
- **The quote rate is a measurement of these runs' habits, not a target.** 58.4 % of the
  quotations the last nineteen ingests added are not verbatim in the text they read. The
  prevention side shipped with chunk 2; the second reading of the same twenty jobs, some nights
  from now, is what says whether it moved.
