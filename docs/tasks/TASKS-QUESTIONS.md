# Tasks: open questions, from a page to a run (2026-09-20)

The pinboard (`docs/agents/SPEC.md` 10.13) collects every bullet under an `## Open questions`
heading and offers two actions on each: hand it to a research run, or archive it. The collecting
works. What a question IS by the time it gets there does not: the bullets a run leaves are
mostly notes about what that run could not finish, written to be read next to the page they
stand on, and one of the two handoff paths passes such a note to a research run verbatim, where
it also becomes the name of the page the run files.

This file covers five changes, in six phases, each with its own definition of done and its own
tests. Phase 6 is the user's own acceptance pass and nothing ships before it.

**Read first:** `SPEC.md`, `CLAUDE.md` (hard rules 1, 5, 7, 8), `docs/agents/SPEC.md` sections
6.1 to 6.4 (the planner and its candidates) and 10.13 (the pinboard as decided). Where this file
and a spec disagree, the spec wins; say so and ask before deviating.

**Public repo (hard rule 7).** Everything below describes mechanism, never subject. No page
title, person, organisation or handle from the vault appears here, and none may appear in a
commit message or PR body produced from this file. Every example question in this file is
invented. Run `scripts/vault-name-scan.mjs --diff <base>` over the added lines and `--file` over
any PR body before posting.

---

## 0. The measurement

Taken 2026-09-20 against `~/vault` (1269 wiki pages), with the service's own parser
(`parseQuestionBullets`, `pipeline/questions.ts`) so the numbers describe exactly what the
pinboard shows.

| What | Value |
|---|---|
| Open questions on the board | **355**, on 86 pages |
| Archived (struck through) | **0** |
| Ending in a question mark | **29 (8 %)** |
| Explicit limitation notes ("no source in this pass ...", "was not searched") | 153 |
| Other declarative sentences | 173 |
| Carrying pass-relative deixis ("in this pass", "in this step", "either source") | **152 (43 %)** |
| Longer than `TITLE_MAX_CHARS` (120) | **339 (95 %)** |
| Longer than the planner's topic cap (500) | 9 |
| Length in characters | min 77, median 247, p90 394, max 863 |
| Near-duplicate clusters (overlap >= 0.7) | **43, covering 90 questions**, 42 of them spanning more than one page; 308 distinct questions remain |
| By bucket | `questions` 149, `meta` 90, `concepts` 81, `sources` 33, `entities` 2 |

The duplicate shape is always the same: one run writes the same open item onto its notebook,
onto its synthesis page and onto the concept page it touched, in three slightly different
wordings. Three rows on the board, one question.

Which phrase carries the deixis, since phase 3 should name the ones that occur rather than a
plausible-looking list: `this pass` 112, `above` 19, `this run` 12, `in this vault` 12,
`this step` 4, `either source` 4, `this session` 3, and single figures for the rest. One phrase
carries three quarters of the class.

*Method note on the cluster row.* An exploratory first pass reported 32 clusters over 67
questions. It used an ad-hoc tokenizer over a slightly different bullet set; the row above is the
harness of task 0.1, which clusters with `scopeScore` over `tokenize` - the measure the planner
already judges topics with - over the parser the board reads with. The shape is the same and the
second figure is the one later runs compare against.

Reproducing these numbers is task 0.1, and every later definition of done compares against them.

---

## 1. What is actually broken

Three separate mechanisms, which is why this is five changes and not one.

**1. Nothing anywhere states what an open question should look like.** The only template that
exists is the vault's own, in `skills/autoresearch/SKILL.md`, and it asks for a limitation note
by construction: `- [Question that research didn't fully answer]` / `- [Gap that needs more
sources]`. Our own prompts say where the bullets go and never what shape they take:
`renderFellowBlock` (`fellow-prompts.ts:44`) says "append the questions this run left open as
bullet lines", and `expand.ts:99` says "leave a bullet in your notebook's Open Questions
instead". So every run decides for itself, and what it decides is a sentence that reads well
directly under the findings it belongs to.

**2. The two handoff paths are not equally robust.**

- *Through the planner* the question is only a **candidate**. The planner reads it, may read its
  source pages, and writes its own "precise topic sentence a research run can act on (at most
  500 characters - one sentence, not a paragraph)" (`planner.ts:263`). There is a reformulation
  step, and it works.
- *Through the board's "Start research"* there is none.
  `QuestionBoard.tsx:29` puts the raw text in a `prefill` query parameter, `Chat` drops it into
  the composer as the draft, and on send it becomes the run's `topic` unchanged. That string then
  does three jobs: it is quoted into the prompt ("research this topic: ..."), it is token-matched
  against page titles by `findRelatedPages` (where words like "source", "pass" and "data" are
  pure noise), and `researchTargetTitle` pins it as the synthesis page's NAME, cut at 120
  characters (`research-profiles.ts:206`). For 95 % of the board that name is a sentence chopped
  mid-clause.

  The same path is used by the base product: the graph's gap backlog navigates to
  `/research?prefill=...` too (`Vault.tsx:2035`), with a page title rather than a sentence. It
  has the mirror-image problem - too little text, no context at all.

**3. The source page does not travel.** Even a well-written question loses "in this pass" the
moment it leaves the page, because `startResearch` receives a string and nothing else. The
planner is allowed to read the candidate's `sourcePages`; the manual path has no equivalent.

Add to this that nothing ever closes a question (10.13, decided 2026-09-17: "nothing done to the
question by a started run, which does not necessarily answer it" - correct, and it means the
board only grows), and 355 with 0 archived is the expected state rather than a surprise.

---

## 2. Decisions taken before any code

Settled from the analysis above. A task that seems to need a different answer stops and asks.

**D1. Fix the handoff first, the authoring second.** Phases 1 and 2 make the 355 questions that
already exist usable without touching a single vault page; phase 3 improves what gets written
from here on. That order is deliberate: a prompt rule only pays off over future runs, and there
is no mechanism by which it repairs the standing board.

**D2. The existing questions are never rewritten by the service.** Rewriting vault prose from
pipeline code is not one of hard rule 1's sanctioned writers, and these bullets are page content
that reads in context. Everything here either carries a question OUT of the vault (phases 1, 2,
4) or changes what a future run writes INTO it (phases 3, 5). The only existing write path that
stays is the one 10.13 already has: the user's own strike-through.

**D3. The reformulation is a suggestion, never an automatic substitution.** The reformulated
topic lands in the composer as an editable draft and the user presses send, exactly as the raw
prefill does today. A failed or slow reformulation falls back to the raw text rather than
blocking the action. This keeps the property 10.13 relies on: the user chooses the lens and
starts the run.

**D4. The reformulation endpoint is NOT behind `AGENTS_ENABLED`** (hard rule 8). The pinboard is
(`QuestionsService` is only constructed when `fellows !== undefined`, `main.ts:461`), but the
gap backlog on the Graph screen is base product and uses the same prefill path. An endpoint the
base product calls must exist when the flag is off, or it is one 404 per click - the exact rot
hard rule 8 names. Conversely, nothing in phases 1 to 5 may make a Fellow-only route reachable
from a base-product screen.

**D5. The synthesis page title stays deterministic and stays pinned before the run.** It is what
`isSynthesisPath` and the post-run "no synthesis filed" warning agree on
(`research-profiles.ts:219`), and letting a run choose its own name would break both. So the
reformulation returns TWO fields, a topic sentence and a short title, and the title is pinned the
same way it is today - just from a better string.

---

## 3. Invariants

Check these before calling any phase done.

1. **Hard rule 1.** No new vault writer. Phases 1 to 5 add none: the only vault write in this
   area remains `questions.ts`'s strike-through, which already takes the per-file lock and
   commits behind the shared mutex.
2. **Hard rule 5.** `skills/autoresearch/SKILL.md` is the vault's and is not edited. The form
   rule of phase 3 reaches a run through `systemPromptExtra` only.
3. **Hard rule 7.** No vault subject in any committed line, comment, fixture, UI string, test
   name or PR body. Phase 0's baseline is committed only in redacted form (counts, no text).
   The eval fixtures in phase 2 are invented questions, not copied ones.
4. **Hard rule 8.** `AGENTS_ENABLED` off changes nothing. See D4.
   `server/test/agents-flag-off.test.ts` stays green, and phase 2 adds the new endpoint to it.
5. **`npm test`, `npm run typecheck` and `npm run lint` all pass and exit 0** before a phase is
   called done. A green suite is not a green repo.
6. **No phase runs against the live vault without a current backup**, and no phase starts an
   agent run while the systemd service is up: the dev instance and the live service share
   `~/vault` and hold separate in-process commit mutexes. Phase 6 says where this matters.
7. **Every reformulation is a metered SDK call.** It is a `query`-profile run: read-only, no web,
   no vault write path. Keep it that way, and keep it small - phase 2.6 fixes the budget.

---

## Phase 0: the measurement harness

Nothing here changes behaviour. It exists so phases 3 and 5 have a number to be judged by rather
than an impression.

### 0.1 `server/src/cli/questionaudit.ts` plus `npm run questionaudit` - DONE 2026-09-20

- [x] A read-only CLI that takes a vault path and reproduces **every number in section 0**:
      totals, archived share, question-mark share, limitation share, deixis share, the length
      distribution, the share over `TITLE_MAX_CHARS` and over the planner's topic cap, the
      near-duplicate clusters with their page spread, and the bucket breakdown.
- [x] It imports `parseQuestionBullets` from `pipeline/questions.ts` rather than reimplementing
      it, so the audit and the board can never disagree about what a question is. A third parser
      is exactly the drift `vaultprobe` exists to catch elsewhere.
- [x] Clustering reuses `tokenize` from `pipeline/related-pages.ts` and the overlap coefficient
      from `scopeScore` in `pipeline/planner.ts`. No new similarity measure.
- [x] `--json` for diffing two runs, `--redact` that drops every question text and page path and
      leaves counts only. `--redact` output is the only form that may be committed.
- [x] `--samples N` prints example bullets per form and the largest clusters. Not in the original
      list; added because phase 3 cannot write a form rule without reading what the runs write.
      Local output only, never committed (hard rule 7).
- [x] The defect vocabulary lives in `pipeline/question-form.ts`, pure and import-free, which is
      the constant task 5.1 asks for. It carries NO length threshold: the two caps a question can
      actually collide with already exist and are owned elsewhere (`TITLE_MAX_CHARS`,
      `FIELD_CAPS.topic`), so the audit imports those rather than inventing a third number.
- [x] Writes nothing, anywhere.
- **Tests** (`server/test/question-audit.test.ts`, 21 tests): over a fixture vault under
  `server/test/fixtures/questions-vault/` carrying one planted instance of every class - a real
  question, a limitation note, a deixis-carrying bullet, an over-long one, a struck-through one,
  an `(answered)` one, a `(none yet)` placeholder, a wrapped multi-line bullet, and one question
  planted on three pages in three wordings. Assert each classifier and the cluster count.
- **DoD:** `npm run questionaudit -- ~/vault` reproduces section 0's table, runs in under 30 s,
  writes nothing, and its `--redact --json` output is committed once as
  `docs/tasks/question-audit-baseline-2026-09-20.json`. `scripts/vault-name-scan.mjs --file` over
  that JSON matches nothing.

**Result.** `npm run questionaudit -- ~/vault` runs in **1.1 s** (budget 30 s) and reproduces
section 0 exactly: 1269 pages scanned, 86 carrying questions, 355 bullets with 0 archived, 29
asking / 153 limitation / 173 statement, 152 carrying deixis, lengths 77 / 247 / 394 / 863, 339
over the title cap and 9 over the topic cap, buckets 149 / 90 / 81 / 33 / 2. The cluster row is
the corrected one (43 / 90 / 42 / 308, see the method note in section 0). The redacted baseline
is committed at 1.1 kB and `vault-name-scan --file` matches nothing in it.

21 tests over `server/test/fixtures/questions-vault/`, a five-page vault with one planted
instance of each class: a real question, a limitation note, two deixis phrases, a bullet wrapped
over three lines, one over the title cap, a struck-through one, an `(answered)` one, a
`(none yet)` placeholder, one page with no section at all as the control, and one question
written on three pages in three wordings next to a narrower follow-up that must NOT merge with
it. The read-only claim is asserted rather than stated: the test snapshots every file's size and
mtime around a full audit.

Two things the work settled that the later phases inherit:

- **The audit walks files; the board walks the graph.** The CLI reads every `.md` under `wiki/`,
  while the board shows graph knowledge pages plus the notebooks of living Fellows. The file set
  is the superset and is the stable thing to measure - it does not move when a Fellow retires or
  the flag goes off. Expect the board's own count at or below these numbers.
- **Phase 4 cannot import this clustering.** It runs on the client and `scopeScore` lives in
  server code. Task 4.1 therefore reimplements the same measure in `web/src/lib/questions.ts`
  and its test must pin it against the figures here, or the two drift.

**One number worth carrying into phase 2.** A run costs roughly a dollar; a reformulation is a
short `query` call. The board has 355 questions and the audit says 308 of them are distinct, so
even reformulating every distinct one once is small against a single night's research. Task 2.6
still measures it.

---

## Phase 1: the source page travels with the question

The cheapest change with a real effect: a run that can read the page the question stands on can
resolve "in this pass" by itself, whatever the wording.

### 1.1 `from` through the URL, the API and the prompt - DONE 2026-09-20

- [x] `researchRoute(text, page?)` in `QuestionBoard.tsx` appends `&from=<page>`; the board
      passes `e.page`. The gap backlog in `Vault.tsx` passes nothing (a gap has no source page)
      and keeps working unchanged.
- [x] The KEYBOARD path too, which the original list missed: `LibraryScreen.tsx` hands the
      selected row to Research on Enter, and it only had the text. `onRows` now reports rows
      (`QuestionRow`, question plus page) rather than bare strings, so Enter does exactly what
      the row's own button does. Without this the two paths would have disagreed silently.
- [x] `App.tsx` reads `from` next to `prefill` and hands both to `Chat`; `Chat` keeps it in
      `fromRef` beside `topicRef` and sends it with the run. The clearing rule came out
      STRUCTURAL rather than conditional: one `setTopic(text, from?)` is the only way the box
      gets a research topic, so a keystroke, the backlog's "Research" and the clear after a send
      each drop the origin by construction, and editing back to the original text does not
      resurrect it. The single `setDraft` left outside is the ask branch's error path, which
      only fires when the box is empty, and an empty box has no origin to go stale.
- [x] `POST /api/v1/maintenance/research` accepts an optional `from`. The route checks the TYPE
      only; containment and existence moved into `startResearch`, so every caller of it gets one
      answer rather than only the ones that come through HTTP. An invalid or missing path is
      ignored rather than rejected, because it is an optimisation and not the request.
- [x] The guard itself is now shared: `pipeline/vault-paths.ts` (`isWikiPagePath`,
      `resolveWikiPage`), and `questions.ts:setArchived` reads it too. This is the factoring
      task 2.2 asked for on phase 1's landing, done here. It is slightly stricter than the
      inline version it replaces: a backslash and a NUL are rejected as well.
- [x] `startResearch` takes it and `researchPrompt` renders one block from it, before the overlap
      block: the page path, one sentence saying the question was left open on that page, and an
      instruction to read it first because it says what is already known and what the wording
      refers to. The block also says what the page is NOT - a source to summarise, or necessarily
      the page to extend - so it cannot be read as overriding the overlap rules below it.
- [x] The block is rendered by its own exported function (`renderQuestionOrigin`) so
      `prompt-style.test.ts` picks it up automatically. It lives in `related-pages.ts` beside
      `renderOverlapBlock`: the two answer the same kind of question for a research prompt
      (which pages of this vault bear on this run) and should not drift apart in tone.
- **Tests:**
  - `server/test/prompt-style.test.ts`: the new block is added to `promptText()` and inherits the
    no-dash assertion.
  - `server/test/maintenance-*.test.ts` (or a new `research-origin.test.ts`): the block appears
    when `from` is given, is absent when it is not, and the prompt is otherwise byte-identical to
    today's in the absent case. That last assertion is the one that proves this change is additive.
  - `server/test/api.test.ts`: `from` with `..`, with an absolute path, with a non-`wiki/` path
    and with a path that does not exist all start the run anyway, without the block.
  - `web/test/researchRoute.test.ts`: both halves survive encoding (a page name holds spaces and
    ampersands, a question holds question marks and quotes), and no `from` is emitted without a
    page. **Not** the planned test over the composer's ref handling: the web suite has no DOM
    and calls components directly, and `Chat` cannot be rendered that way. The rule is
    structural instead (one `setTopic`), and the acceptance pass checks it by hand.
- **DoD:** starting a run from a board row sends the page; starting one from the gap backlog or
  by typing sends nothing; the prompt for a run without `from` is unchanged character for
  character.

**Result.** 13 new tests: `server/test/research-origin.test.ts` (7), the route case in
`api.test.ts`, and `web/test/researchRoute.test.ts` (3), plus the new block in the house-style
assertion and the guard's own cases. Full suite 168 files / 2398 tests, typecheck and lint, all
exit 0.

The byte-identity assertion is the load-bearing one and it is exercised over every way a path
can fail: outside the wiki, escaping it, absolute, absent, wrong type, empty. In each case the
prompt equals the no-origin baseline character for character, so this change cannot have moved
anything for a run that does not use it. A second test pins the ORDER - origin before the
overlap rules, synthesis mandate still last - because that ordering is an argument about what a
run reads first, not a formatting detail.

One thing phase 2 inherits: the origin page now reaches the run, but the TOPIC is still the raw
bullet, and it is still what the synthesis title is cut from. Phase 1 fixes what the run can
understand, not what it is called.

---

## Phase 2: the reformulation step

The planner's reformulation, given to the manual path. New module, same shape as
`pipeline/dedupe-judge.ts` - a pure prompt builder, a zod schema, a JSON schema, and one thin
`runAgent` call - so everything except the call itself is unit-testable.

### 2.1 `server/src/pipeline/question-topic.ts`: prompt, schema, parser - DONE 2026-09-20

- [x] `renderTopicPrompt({ text, page?, pageExcerpt? })`: states that the input is a note a
      research run left on a vault page, and asks for a research topic that stands on its own.
      The rules it states, each one traceable to a number in section 0: one sentence; no
      "this pass", "this step", "either source" or any other reference to the run that wrote it;
      every name spelled out rather than referred to; phrased as what is to be found out; and a
      separate short title suitable for a page name.
- [x] `topicSchema()` and a zod `answerSchema` with exactly two fields: `topic` (<= 500, the
      planner's `FIELD_CAPS.topic`, imported rather than re-stated) and `title` (<= 100, leaving
      room under `TITLE_MAX_CHARS` for the `Research - ` prefix and the lens suffix, likewise
      imported and computed rather than hardcoded).
- [x] `reformulate(input, opts)`: one `runAgent` call with `profile: 'query'`, structured output,
      a short timeout. On a failed run, a schema violation, or a timeout it returns `null` - the
      caller falls back to the raw text (D3). It never throws into a request handler.
- [x] The excerpt: when `page` is given, the service reads the page and passes a bounded slice
      (the frontmatter title plus the first N characters, plus the `## Open questions` section)
      rather than letting the run open the file. Reason: this run has the `query` profile and no
      reason to hold a read tool loop for one sentence, and a bounded excerpt keeps the cost
      fixed. Cap it in one named constant.
- **Tests** (`server/test/question-topic.test.ts`): the prompt contains the rules and the input;
  the schema binds both caps; a well-formed answer parses; an over-long topic, a missing field
  and a non-JSON answer each return `null`; a failed run returns `null`; the excerpt is bounded
  and includes the page's own title. `runAgent` is mocked throughout.

### 2.2 The endpoint - DONE 2026-09-20

- [x] `POST /api/v1/maintenance/research/topic`, guarded by `credentialMissing` like its
      neighbour, body `{ text, from? }`, answering `{ topic, title }` or `{ topic: null }` when
      the reformulation did not succeed.
- [x] Registered unconditionally, NOT behind `AGENTS_ENABLED` (D4).
- [x] `from` validated by the same helper phase 1 introduces. Factor that validation into one
      exported function when phase 1 lands, so the two endpoints cannot drift.
- **Tests:** `server/test/api.test.ts` for the happy path, the null path, the missing-credential
  path and path validation; `server/test/agents-flag-off.test.ts` gains an assertion that this
  route answers with the flag OFF (the inverse of every other assertion in that file, and the
  point of D4).

### 2.3 The composer takes the suggestion - DONE 2026-09-20

- [x] Clicking "Start research" on a board row navigates as today, and the Research screen then
      asks for the reformulation before the user sends. While it is in flight the composer shows
      the raw text with a visible, non-blocking state ("preparing the topic"); when it returns,
      the draft is replaced and the user can edit it or send it.
- [x] If the user has already typed into the composer when the answer arrives, the answer is
      discarded. Their edit wins.
- [x] A null answer leaves the raw text in place, with no error toast: the action still works,
      it just did not improve.
- [x] The title rides along in a ref and is sent with the run (2.4). An edited draft drops it,
      the same rule as `from` in 1.2.
- **Tests:** `web/test/questionSuggestion.test.ts` over `acceptsSuggestion`, the rule all three
  orderings reduce to. NOT component tests: the web suite has no DOM (the same wall phase 1 hit),
  so the decision was pulled OUT of the component into a pure function instead, which is the
  part worth pinning anyway. That nothing is auto-sent is structural - `send()` is only ever
  called from the composer's own button and Enter key - and is walked by hand in phase 6.

### 2.4 The title, decoupled but still pinned - DONE 2026-09-20

- [x] `POST /api/v1/maintenance/research` accepts an optional `title`, capped and passed through
      `titleSafe` exactly as a topic-derived title is today.
- [x] `researchTargetTitle(profile, topic, title?)` uses it when given and falls back to the
      shortened topic when not, so every existing caller is unchanged.
- [x] The post-run synthesis check and `isSynthesisPath` keep agreeing. **The premise here was
      wrong and the test is better for it:** the post-run check does not compare titles at all,
      it asks whether ANY committed page is a synthesis, and `isSynthesisPath` answers that from
      the `Research - ` prefix. So the pair D5 protects is prefix-shaped, and the test asserts
      the real invariant - for every lens and every shape of title (safe, unsafe, over-long,
      degenerate, absent), the name the prompt pins is one `isSynthesisPath` recognises, and the
      mandate pins exactly that name rather than computing a second one.
- **Tests:** `server/test/research-profiles.test.ts` (or wherever `researchTargetTitle` is
  covered today): with and without an explicit title; an unsafe title is made safe; a title over
  the cap is shortened on a word boundary; the prompt's pinned title and the post-run check's
  expected title are equal in all four cases.

### 2.5 `npm run questiontopic-eval`: measuring it before trusting it - DONE 2026-09-20

Same reasoning as `dedupe-eval` - a reformulation nobody measured is a second guess in front of
the first one.

- [x] A CLI that reads the real board (via `QuestionsService.list()` against a vault path),
      samples N questions, reformulates each, and prints input against output with the checks
      from section 0 applied to the output: question-mark share, deixis share, length, share over
      the title cap.
- [x] `--dry` prints the prompts and makes no calls, so the prompt can be reviewed without
      spending anything.
- [x] Output is local only. It quotes vault content, so it is never committed and never pasted
      into a commit message or PR body (hard rule 7).
- **DoD:** on a 30-question sample of the live board, **at least 90 % of outputs end in a
  question mark, none carries pass-relative deixis, none exceeds the title cap after
  `titleSafe`, and none is longer than one sentence.** Anything below that is a prompt problem to
  fix in 2.1 before phase 2 is called done, not a threshold to lower.

### 2.6 Cost - DONE 2026-09-20

- [x] Measure the real per-call cost over the 2.5 sample and record it here.
- **DoD:** a reformulation costs a small fraction of the run it precedes, and the number is
  written into this file. If it does not, the excerpt in 2.1 is too large.

**Result.** Measured over the 30-question sample: **0.146 USD per call**, 4.38 USD for the whole
sample, against roughly 2 to 5 USD for the research run one reformulation precedes. That is 3 to
7 %, which is the small fraction the DoD asks for, so this ships as it stands.

The interesting half is WHERE it goes: **56,933 tokens in, 809 out, per call.** The excerpt is
about a thousand of those and the prompt a few hundred; the rest is the vault context the SDK
loads because the run's working directory IS the vault (CLAUDE.md, the skill descriptions, the
tool surface). So the excerpt is not the knob, and shrinking it would buy almost nothing.

The knob, if this ever needs one, is the working directory: a `query` run that writes nothing
and reads its material from the prompt does not need to start inside the vault at all. That
touches the runner's permission wiring, which is hard rule 4 territory and needs `permprobe`
re-run, so it is written down here rather than done on the way past.

**Result for phase 2 as a whole.** 30 new tests across `question-topic.test.ts` (17),
`research-profiles.test.ts` (4 on the decoupled title), `api.test.ts` (4 on the endpoint),
`agents-flag-off.test.ts` (1, the inverse assertion D4 exists for) and
`web/test/questionSuggestion.test.ts` (4). Full suite 170 files / 2428 tests, typecheck and
lint, all exit 0.

**The measured run, in full.** 30 questions sampled from the live board, seed 11:

| | First run | After the prompt fix |
|---|---|---|
| asks a question | 20/30 (67 %) | **30/30 (100 %)**, target 90 % |
| carries pass-relative deixis | 0 | **0**, target 0 |
| page name over the cap | 0 | **0**, target 0 |
| more than one sentence | 1 | **0**, target 0 |

Two things the first run taught, both of them about this file rather than about the model:

- **Two of my own rules fought each other.** The prompt asked for the reason a question stayed
  open "in brackets at the END of the sentence", and the measurement asked for a sentence ending
  in a question mark. Seven of the ten failures were proper questions with a bracket after the
  question mark. The prompt now puts the bracket BEFORE it, and says outright that "Determine
  whether ..." and "Find the ..." are not questions - which was the other three.
- **The one multi-sentence failure was a measurement bug.** A name's middle initial reads as a
  sentence end to a naive splitter. `sentenceCount` no longer splits after a single capital, and
  the case is a unit test with an invented name.

The second run's numbers are the ones above; the multi-sentence column is that same run
re-scored with the corrected heuristic rather than a third paid run, since the correction
changed the counting and not the output.

What phase 3 inherits: this fixes questions on their way OUT of the vault, one at a time, for a
metered call each. It does nothing for the 355 already standing, and nothing for the next 355.

---

## Phase 3: the form rule in the prompt

Prevention. It cannot repair the standing 355 (D2), and it is what stops the next 355 looking
the same.

### 3.1 `OPEN_QUESTION_FORM` in `system-prompt.ts` - DONE 2026-09-20

- [x] A short block in the shape of `PAGE_HYGIENE_CHECKLIST`: every item a defect measured in
      section 0, stated as the behaviour wanted. A question stands on its own, understandable
      without the page under it; no "in this pass", "in this step", "either source" or any other
      reference to the run that wrote it; names spelled out; one question per bullet, one
      sentence; it asks something rather than reporting what was missing; and it is not copied
      onto three pages.
- [x] **Two corrections to this task, both earned in phase 2.** The reason a question stayed
      open goes in brackets just BEFORE the question mark, not at the end: the opposite rule cost
      7 of 10 otherwise perfect questions their question mark. And there is **no character
      limit**, because the measurement says length is not the defect - phase 2's reformulated
      questions came out LONGER than the notes they replaced (median 351 against 247), since
      spelling a name out and keeping the reason costs characters. Task 5.1 inherits both.
- [x] It carries an example of the transformation, invented, in the file and in the prompt:
      a note of the shape "no source in this pass gave independent figures for X's Y, which would
      need a dedicated technical pass" becomes "What independent figures exist for X's Y?
      (not found in trade coverage; needs technical sources)".
- [x] It goes into the blocks **every vault-writing run carries**, not into `renderFellowBlock`
      alone. The `## Open questions` section is written by ingest and by manual research runs
      too, and those exist with `AGENTS_ENABLED` off. This is not a Fellow feature, so it is not
      behind the flag (invariant 4).
- [x] It is appended after the vault's own skill template is loaded, which is where the service's
      other corrections already sit and why they hold ("a run follows the instruction in front of
      it", `maintenance.ts`).
- **Tests:** `prompt-style.test.ts` gains the block (no dashes, by the existing assertion); a test
  asserts it is present in an ingest prompt, in a manual research prompt and in a Fellow run
  prompt, and that it does not depend on `AGENTS_ENABLED`.
- **DoD:** all three prompt kinds carry it; the block itself obeys the rule it states (no
  em-dash, and its worked example passes `classifyQuestion` / `hasPassDeixis`); `npm run
  vaultprobe` still green. Note the block necessarily QUOTES the deixis it forbids, so
  "contains no deixis" is not the test - "does not drift from the shared list" is.

**Result.** 7 tests in `server/test/open-question-form.test.ts`, plus the block in the
house-style assertion. Full suite 171 files / 2435 tests, typecheck, lint and `vaultprobe` all
green.

Three of the seven are the wiring, because the rule reaching only some runs would be worse than
useless: an ingest run, a batch ingest and a research run each get the block, built with no
Fellow anywhere in the picture, and each still carries the blocks it always had rather than
having one swapped out. The other four read the block's content back and check it against the
functions the audit and the validator use: its "before" example classifies as a limitation
carrying deixis, its "after" example asks a question and carries none. A rule whose own example
fails the check is worse than no rule.

Two things the tests found rather than confirmed:

- The quoted phrases were **broken across lines** by the block's own wrapping, so "either
  source" was not a contiguous string. Harmless to a model reading prose, but it meant the
  block could drift from `PASS_DEIXIS` without any test noticing. The phrases now sit on one
  line and the test matches them by phrase.
- A near-miss in the wiring: the first patch inserted the block **twice** in the maintenance
  list, because a replacement keyed on an eight-space indent also matched inside a ten-space
  one. Caught by reading the diff, not by a test - no test would have failed on a prompt that
  says the same thing twice.

### 3.2 The duplicate-writing problem, stated but not fixed here - DONE 2026-09-20

The 32 clusters come from one run writing the same item to its notebook, its synthesis page and
the concept page. The obvious rule ("write it once, on the page whose subject it is") collides
with the planner, which reads candidates from the notebook and from synthesis pages only
(`computeCandidates`, sources 1) - a question written only to a concept page would become
invisible to the Fellow that wrote it.

- [x] Do NOT add a placement rule in this phase. Write the collision down here, measure the
      cluster count again after phase 3 has been live for a while (0.1 gives the number), and
      decide then, with the planner's candidate sources on the table. Phase 4 handles the
      symptom in the meantime.
- [x] The block does say the softer half of it - "do not copy the same question onto several
      pages, leave it on the page whose subject it is" - which asks for the right thing without
      naming a placement the planner then cannot read. If the cluster count does not move, the
      structural fix is the one that has to be decided.

---

## Phase 4: one question, one row

The board shows 355 rows for roughly 294 distinct questions. Independent of phases 1 to 3.

### 4.1 Clustering, as a pure function - DONE 2026-09-20

- [x] `clusterQuestions(entries)` in `web/src/lib/questions.ts`, beside `questionView`: groups by
      token overlap over the same measure phase 0 uses, returns one representative per group plus
      the members. Representative = the longest text of the group (it carries the most context),
      tie broken by page path so the choice is stable across renders.
- [x] The threshold is a named exported constant with the measured basis in its doc comment
      (0.7 gives 32 clusters over 67 questions with no false merge found by hand on this vault).
- [x] Clustering happens on the client. The server route stays as it is; the archive action
      already takes a page and a text, and the client knows every member of the group.
- **Tests** (`web/src/lib/questions.test.ts` or the existing questions test): three wordings of
  one item on three pages cluster to one row; two genuinely different questions on one page do
  not merge; a narrower follow-up on the same subject does not merge (the expensive error, the
  same one `dedupe-judge.ts` is written around); the representative choice is stable.

### 4.2 The row says where it stands - DONE 2026-09-20

- [x] A clustered row shows "also on N other page(s)" with the pages reachable (title attribute
      at minimum, `PageLink`s preferred).
- [x] The view counts (`total`, `planned`, `researching`) are counted over clusters, so the lede
      and the board agree.
- [x] `planned` and `researching` on a cluster are true when they are true for ANY member: a
      Fellow planning one wording has claimed the question.
- **Tests:** the counts over a clustered fixture; a cluster where one member is planned shows as
  planned.

### 4.3 Archiving a cluster archives its members - DONE 2026-09-20

- [x] The archive button on a clustered row issues one `POST /questions/archive` per member,
      sequentially (each one is a vault commit behind the shared mutex; parallel requests would
      queue on that mutex anyway and make failures harder to report).
- [x] Partial failure is reported and the list is invalidated, so the board shows what actually
      happened rather than an optimistic state.
- [x] Restoring from the archived tab does the same in reverse.
- **Tests:** a three-member cluster issues three calls; a failure on the second reports and does
  not silently claim success.
- **DoD:** on the live board, the row count drops by the measured cluster surplus (355 to roughly
  294) and no two rows show the same question.

**Result.** **355 rows become 308**, which is the audit's own figure for how many distinct
questions the vault holds. 26 new tests (15 in `web/test/questionClusters.test.ts`, the view test
rewritten around clusters, plus the archive cases). Full suite 172 files / 2450 tests, typecheck
and lint, all exit 0.

**The mirror was verified against the real thing, not argued for.** The measure lives twice by
necessity - `scopeScore` over `tokenize` on the server, reimplemented in `web/src/lib/questions.ts`
because a browser bundle cannot import the audit CLI - and two implementations of one measure
drift unless something pins them. So both were run over the same 355 questions of the live vault
and compared group by group: **43 clusters, 90 questions covered, identical grouping.** The
throwaway script is not committed (it reads the live vault); what is committed is that both
suites run the SAME cases, which is what catches a drift from here on.

Four decisions this phase had to make that the task did not name:

- **Clustering happens per TAB.** A cluster never mixes an archived wording with an open one.
  Archiving one wording and leaving another is a state a user can produce, and a row that is
  half struck through has nothing useful to say.
- **The lead is the longest wording**, tie broken by page path. These wordings differ by how
  much context they carry, and the one that says the most is the one worth reading and worth
  handing to a run. The path tie-break keeps a row from reshuffling under the pointer between
  two polls.
- **A cluster stands in every domain one of its members stands in**, rather than only its
  lead's. Otherwise grouping would quietly hide a question from a shelf it belongs to.
- **The room's own count is clustered too.** The easel says how many questions there are and
  opens the board that lists them; the two disagreeing by 47 would be a bug report waiting to
  happen.

Clustering is quadratic, so it runs once per tab inside a `useMemo` and the domain cut is a
filter over the result. That also stops the same questions being regrouped differently depending
on which shelf you are standing at.

---

## Phase 5: the validator learns the form

The deterministic backstop for phase 3, and the instrument that says whether phase 3 worked.

### 5.1 The `open-question-form` rule - DONE 2026-09-20

- [x] A new `ValidationRule` in `pipeline/validator.ts`. Note the existing comment at line 133:
      `## Open Questions` is deliberately not checked *for existence*, because the agents plan
      from it. A **form** check does not conflict with that, and the comment gets one sentence
      saying so.
- [x] It fires on a page whose open questions carry the defects phases 0 to 3 named. **Two
      departures from this task, both forced by what was measured since it was written:**
      - **No length check.** Phase 2's reformulated questions came out LONGER than the notes
        they replaced (median 351 against 247), because spelling a name out and keeping the
        reason costs characters. Length is not the defect; a sentence that cannot be read on
        its own is. So the rule checks two things: does the bullet ask anything, and does it
        point back at the run that wrote it.
      - **One finding per PAGE, not per bullet.** The 355 bullets already standing will not be
        rewritten (D2), so a per-bullet rule would report several hundred findings nobody is
        allowed to act on, and would bury every other class in the report. A count per page
        says the one thing worth knowing - is this section usable - and it moves when phase 3
        works.
- [x] Advisory like every other finding, and read-only like the whole module (hard rule 1).
- [x] The thresholds and the deixis list come from `pipeline/question-form.ts`, which phase 0
      created for exactly this: the audit, the prompt rule and this rule read one vocabulary, so
      the three cannot drift apart. The module is import-free on purpose - the validator must not
      drag a planning module in behind it.
- **Tests** (`server/test/validator.test.ts`): one page with one bullet of each defect class and
  one clean bullet; assert exactly three findings and their rules; assert a struck-through bullet
  and an `(answered)` bullet produce none (they are closed, and re-litigating them is noise).
- **DoD:** run against the current vault it reports on the order of the numbers in section 0;
  against a page whose bullets follow phase 3's rule it reports none.

**Result.** Against the live vault: **86 of 86 pages carrying open questions are flagged, none
is clean**, covering all 355 bullets. That is the expected shape rather than a surprise - 29 of
355 ask anything, spread thinly over the pages - and it is the baseline 5.2 measures against.

Worth saying plainly: until phase 3 has run for a while, this rule fires on every page with the
section, so it tells an operator nothing they can act on today. That is what it is for. It is
advisory like every other finding, it writes nothing, and the six tests pin the two halves
separately, both halves together in ONE finding, and silence for a section whose questions stand
on their own or whose bullets are already closed (struck through, "(answered ...)", or the
placeholder).

The comment at the top of `validator.ts` that says `## Open Questions` is deliberately not
checked now carries a sentence saying why this does not contradict it: the rule never says the
section should go, only that a bullet in it should be readable away from the page.

### 5.2 The number that closes the loop

- [x] **Measured over six runs (2026-09-20).** One run plus a batch of five, sequential, on ML
      topics the vault does not hold, against the clone. 46 minutes for the five, 20.17 USD for
      all six, one commit each, 44 pages written or extended, **35 open questions** written.

      | | Standing board | These six runs |
      |---|---|---|
      | ask a question | 29 of 355 (**8 %**) | **35 of 35 (100 %)** |
      | carry pass-relative deixis | 152 of 355 (**43 %**) | 16 of 35 (**46 %**) |
      | length, median | 247 | 339 |

      **The first line is the result and it is unambiguous**: every question a run wrote under
      the rule asks something, where four in five did not before. The validator says the same
      from the other side - of the eight new pages carrying a questions list, all eight are
      flagged and **not one is flagged for "does not ask anything"**. That half of the rule is
      simply done.

      **The second line did not move, and the breakdown says exactly why.** All 16 hits are the
      single phrase "in this pass", and every one of them sits inside the bracket the rule
      itself asks for: "(not extractable from the abstract in this pass - the full PDF was
      fetched but not read)". The rule repaired the question and left the parenthesis alone,
      because the parenthesis is where it invited a sentence about the run.

      The whole-vault shares barely move (29 of 355 asking becomes 33 of 359) and will not until
      many runs have written under the rule. The incremental number is the one to read.

      **Then the sharpened wording was tested, and it did not work.** The first six runs predated
      it (committed 14:02, instance started 13:48, and the prompt is loaded once), so the
      instance was restarted and two more runs went through it. Result: 10 questions, **10 of 10
      asking**, and **9 of 10 carrying "in this pass"** - worse than the 46 % before it, on a
      small sample, but certainly not better. Two phrasings of the rule, no movement.

      **Why, and it is not the wording.** The vault says "in this pass" **380 times**. A run
      reads the vault; the phrase is the documented house style of the place it is writing for.
      One line of prompt is arguing against 380 worked examples, and losing.

      **Totals over all eight runs: 45 questions, 45 of 45 ask something, 25 of 45 carry the
      phrase.**

      **What follows, and why the design still holds.** The deixis half is repaired where it
      does damage rather than where it is written: phase 2's reformulation removed it from
      **30 of 30** questions on their way into a run. On the page itself the phrase is nearly
      harmless, because the page is the context it refers to. So the recommendation is to stop
      sharpening this half of the rule - two attempts, no movement, and the cause is the
      standing corpus rather than the sentence - and to let the validator keep counting it. The
      share will fall as the corpus dilutes, and the number to watch is the one measured per
      batch of runs, not the whole-vault total.
- **DoD:** the question-mark share and the deixis share have moved in the right direction on
  questions written after phase 3 shipped. If they have not, phase 3's block is in the wrong
  place or is being overridden, and that is a finding to write down here rather than a phase to
  call done.

---

## Phase 6: local acceptance

Nothing is merged before this. The tasks above are done when this pass has run and its notes are
written into this file.

### The harness, and why it is a clone (2026-09-20)

Everything below ran against a **`git clone --local` of the live vault** plus a copy of the
service database, with two instances built from the working tree: **8430 with `AGENTS_ENABLED=1`**
and **8431 without**, both with `TELEGRAM_BOT_TOKEN` cleared so the live bot keeps its polling
slot, and both on their own database and watch folder. Vite dev servers on **5199** (to 8430) and
**5200** (to 8431).

The systemd instance (`curious.service`, port 8421, built `dist/`) was left alone: it runs on the
real `~/vault`, and two services sharing one vault hold separate commit mutexes, which is the one
arrangement that can actually damage it. The clone means the archive and restore steps below
committed for real, to a vault nobody depends on.

### Done, on the API surface

- [x] **Flag off, the route the base product calls (D4).** `POST /maintenance/research/topic`
      answers **400** on 8431 (registered, guarding an empty note) and **400** on 8430: the same
      route, present either way. `GET /questions`, `/agents` and `/reading` are **404** on 8431.
      That is the inverse pair D4 exists for, confirmed from both sides.
- [x] **The reformulation, end to end, on a real question.** A limitation-shaped bullet from the
      live board, one that carries a wikilink and a "formally equivalent to" clause, came back in
      **6.5 s** (cap 60 s) as a question that ends in a question mark, spells the abbreviation
      out, drops the wikilink, and carries no deixis. Title 47 characters against a budget of 89.
- [x] **The prompt a run would receive**, built through the real `startResearch` with the real
      origin and title, stopped before the model: the `<question_origin>` block names the page,
      sits before the overlap rules, and the pinned page name is
      `Research - <the short title>` instead of the topic sentence cut at 120 characters.
- [x] **Archiving a row strikes every wording.** The three-page group the user's screenshot
      showed: three 200s, **three commits, one per page, each naming its page**, and the board
      moved 270/0 to 267/3. One line changed per page.
- [x] **Restore puts them back**: 270/0 again, three more commits.
- [x] **Clustering on real board data**: 270 entries become **256 rows**, 13 grouped rows over 27
      entries, largest group 3. The lead of each group is its longest wording.

### Done, in a browser - and the two bugs it found

Chromium was fetched through the Playwright downloader (no sudo, a cache directory, nothing
installed system-wide) and driven over CDP. **Both bugs below were invisible to 2450 passing
tests and would have shipped.** Neither is reachable without a rendered page: one is an effect
lifecycle, the other an ordering between a ref and a state update.

**Bug 1: the effect cancelled its own request.** The prefill effect calls `navigate` to strip
the query params, which changes that same effect's dependencies - so the cleanup function that
invalidated the in-flight suggestion was run by the effect's own navigation, a moment after
firing it. Every suggestion was fetched, paid for and thrown away, and the composer kept the raw
question. React's development double-mount made it worse: **two requests per question, both
discarded.** The guard is now a ref keyed on the QUESTION, so a re-run for the same question
finds it in flight and does not ask again, and an answer is dropped only when a newer question
supersedes it.

**Bug 2: sending cleared the origin before reading it.** `setTopic('')` empties the box and with
it the composer's `from` and `title` refs; `useMaintenanceRun` reads its starter after that. So
the Start button sent `{topic, profileKey}` and nothing else - **the whole point of phases 1 and
2, dropped at the last step.** Caught by reading the actual POST body of a real click. Fixed by
capturing both into send-scoped refs first, exactly as `topicRef` has always captured the text.

Both shapes are now pinned in `web/test/composerOrigin.test.ts` as rules over the same state,
since the component still cannot be rendered in this suite.

- [x] **The raw question arrives first**, with the composer saying "Preparing the topic from the
      question…" beside the box, not blocking it.
- [x] **The suggestion replaces it** and the hint goes back to what the mode does.
- [x] **Exactly one request** goes out per question (it was two).
- [x] **Nothing is auto-sent**: after the suggestion lands, the only POST made is the
      reformulation itself.
- [x] **The edit wins**: typing over the box immediately, then waiting past the answer, leaves
      the typed text in place.
- [x] **The origin never outlives its text**, checked by intercepting the run request and
      reading what the Start button would send: unchanged from a board row carries `from` and
      `title`; typed over completely carries neither; from a gap (no origin in the URL) carries
      neither.
- [x] **The board**: the lede says 256 and 256 rows are drawn, 13 of them saying "also on" with
      the other page as a link.

### The real research run, and the first evidence that phase 3 works

One run, started from the composer by clicking Start, on a topic the vault did not hold. **4.7
minutes, one commit, 5 new pages**: a concept page, four source pages for the papers it read, and
the synthesis. It also extended the origin page the question came from, which is the origin block
of phase 1 doing its work.

- [x] **The page name is the pinned one.** The synthesis was filed under the name phase 2 pins:
      **78 characters**, the whole of it, exactly what the prompt asked for. Without phase 2 the
      name would have been the topic SENTENCE instead, cut at the 120-character cap partway
      through a word.
      **The name itself is deliberately not written down here, and neither is the subject**
      (decided 2026-09-21). Both are a page of the working vault, and this file is public once
      the merge lands (hard rule 7). Nothing of the finding is lost with them: what it rests on
      is the length, and that the filed name agreed with the pinned one rather than with the
      sentence the run started from. Redacting the name in place was the other candidate, the
      way TASKS-A7 6.4 redacted a quoted planning run - it was not needed here, because this is
      a statement about a name and not a quotation of one.
- [x] **Phase 3, measured on the only run that has ever written under it.** Four open questions,
      and **all four end in a question mark** against a baseline of 8 %. All four name their
      sources in full rather than referring to them. One of the four carries "in this pass",
      and it carries it *inside the bracket* that the rule itself asks for - the bracket invites
      a sentence about the run, and the run is the one thing the next reader cannot see. The
      block now says the no-deixis rule holds inside the brackets too, with the example.
- [x] **Task 5.2, first data point.** The validator over the 8 pages the run touched flags
      exactly **one**, and says "of 4 open question(s) on this page, 1 refer(s) to the run that
      wrote it". The "does not ask" half does not fire at all. Against the standing board, where
      86 of 86 pages are flagged, that is the rule starting to discriminate - which is what it
      was built for. The whole-vault shares barely move (29 of 355 asking becomes 33 of 359),
      and they will not until many runs have written under the rule; the incremental number is
      the one to read.

### Not done, and why

- [ ] **A partial archive failure**, which needs a failure to engineer.
- [x] **The sharpened bracket wording** was measured over two further runs and made no
      difference. See task 5.2.

**Before anything:** a fresh vault backup, and know which service is up. The dev instance and the
live service share `~/vault` and hold separate commit mutexes, so an agent run started from one
while the other is live is the one thing that can actually damage the vault. `AGENTS_ENABLED`
must be exercised both ways (invariant 4, D4).

- [ ] **Flag off.** Start with `AGENTS_ENABLED` unset. The Library screen and the pinboard are
      gone as before. Open the Graph screen's gap backlog, click "Research" on a gap: the
      composer fills, the reformulation endpoint answers (check the network tab for a 200, not a
      404 - this is D4), and no request goes to a Fellow-only route.
- [ ] **Flag on, board to composer.** Open the pinboard, pick a limitation-shaped row, click
      "Start research". Watch the composer: raw text first, then the reformulated topic. Read
      both. Does the reformulation say what you would have typed?
- [ ] **Edit wins.** Click "Start research", type into the composer immediately, confirm the
      arriving answer does not overwrite you.
- [ ] **The origin never outlives its text** (phase 1, not unit-testable without a DOM). From a
      board row, type over the question completely and send: the run's prompt must carry NO
      `<question_origin>` block. Then from a board row, send unchanged: it must carry one. Then
      from a board row, click a gap in the backlog instead and send: no block.
- [ ] **The run itself.** Send one. Confirm in the run's prompt (job log) that the origin block
      names the page the question stood on, and that the pinned synthesis title is the short one
      and not a chopped sentence. Confirm the page the run files carries that title.
- [ ] **Fallback.** Stop the service's credential or otherwise force a null reformulation, and
      confirm the raw text stays and the run still starts.
- [ ] **Nothing is auto-sent** (phase 2, structural, not unit-testable here). From a board row,
      wait for the reformulation to land in the box and confirm no run has started: the box holds
      a draft and the Start button is still yours to press.
- [ ] **Clusters.** On the board, confirm the triple-written items now show as one row naming
      the other pages, and that archiving one strikes all three (check `git log` in the vault:
      three commits, one per page, each naming its page). Expect the easel in the room to say the
      same number as the board. **The numbers to expect are the BOARD's, not the audit's**: the
      audit walks every file and counts 355 on 86 pages, the board shows graph knowledge pages
      plus living Fellows' notebooks and returns **270 on 81 pages, which cluster to 256 rows**
      (13 grouped rows over 27 entries). Measured 2026-09-20 against a clone of the live vault.
- [ ] **A partial archive failure reads correctly.** Hard to force by hand; if it happens, the
      toast should say how many pages were done before which one failed, and the board should
      already show the real state rather than an optimistic one.
- [ ] **Restore.** Restore one from the archived tab and confirm the strikes come off.
- [ ] **The counts.** `npm run questionaudit -- ~/vault` before and after the acceptance pass;
      the archived count should be non-zero for the first time.
- [ ] Write what you found here, under a "Result" heading per phase, in the style the other tasks
      files use.

**A note on the web build** (from the deployment notes): do not build `web/dist` while the
service must keep running. Asset hashes are registered at startup and a new build 404s until a
restart.

---

## What is deliberately not in this file

- **Rewriting the 355 existing bullets.** D2. Not a sanctioned vault writer, and they are page
  content that reads in context.
- **Editing `skills/autoresearch/SKILL.md`** so its template asks for a question instead of a
  gap. Hard rule 5. Phase 3 reaches the same run through the mechanism that is allowed.
- **A placement rule that stops the triple-write.** Phase 3.2: it collides with the planner's
  candidate sources and needs that decision made first.
- **Closing a question when a run about it finishes.** 10.13 decided against it on 2026-09-17,
  and a started run genuinely does not always answer the question it came from. If the board
  still grows unmanageably after phase 4, the thing to reconsider is a staleness cue on old
  questions, not an automatic close.
