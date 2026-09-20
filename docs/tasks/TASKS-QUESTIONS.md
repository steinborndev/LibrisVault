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

### 1.1 `from` through the URL, the API and the prompt

- [ ] `researchRoute(text, page?)` in `QuestionBoard.tsx` appends `&from=<page>`; the board
      passes `e.page`. The gap backlog in `Vault.tsx` passes nothing (a gap has no source page)
      and keeps working unchanged.
- [ ] `App.tsx` reads `from` next to `prefill` and hands both to `Chat`; `Chat` keeps it in a ref
      beside `topicRef`, clears it whenever the user edits the draft to something that is no
      longer the prefill, and sends it with the run. Rationale: a `from` that survives an edit
      into an unrelated topic points the run at a page that has nothing to do with it.
- [ ] `POST /api/v1/maintenance/research` accepts an optional `from`: a vault-relative path,
      validated exactly as `questions.ts:setArchived` validates one (no `..`, starts with
      `wiki/`, ends with `.md`) and required to exist on disk. An invalid or missing path is
      ignored rather than rejected, because it is an optimisation and not the request.
- [ ] `startResearch` takes it and `researchPrompt` renders one block from it, before the overlap
      block: the page path, one sentence saying the question was left open on that page, and an
      instruction to read it first because it says what is already known and what the wording
      refers to.
- [ ] The block is rendered by its own exported function (`renderQuestionOrigin`) so
      `prompt-style.test.ts` picks it up automatically.
- **Tests:**
  - `server/test/prompt-style.test.ts`: the new block is added to `promptText()` and inherits the
    no-dash assertion.
  - `server/test/maintenance-*.test.ts` (or a new `research-origin.test.ts`): the block appears
    when `from` is given, is absent when it is not, and the prompt is otherwise byte-identical to
    today's in the absent case. That last assertion is the one that proves this change is additive.
  - `server/test/api.test.ts`: `from` with `..`, with an absolute path, with a non-`wiki/` path
    and with a path that does not exist all start the run anyway, without the block.
  - `web` unit test over the composer's ref handling: editing the draft away from the prefill
    drops `from`; editing it back does not resurrect it (simplest correct rule).
- **DoD:** starting a run from a board row sends the page; starting one from the gap backlog or
  by typing sends nothing; the prompt for a run without `from` is unchanged character for
  character.

---

## Phase 2: the reformulation step

The planner's reformulation, given to the manual path. New module, same shape as
`pipeline/dedupe-judge.ts` - a pure prompt builder, a zod schema, a JSON schema, and one thin
`runAgent` call - so everything except the call itself is unit-testable.

### 2.1 `server/src/pipeline/question-topic.ts`: prompt, schema, parser

- [ ] `renderTopicPrompt({ text, page?, pageExcerpt? })`: states that the input is a note a
      research run left on a vault page, and asks for a research topic that stands on its own.
      The rules it states, each one traceable to a number in section 0: one sentence; no
      "this pass", "this step", "either source" or any other reference to the run that wrote it;
      every name spelled out rather than referred to; phrased as what is to be found out; and a
      separate short title suitable for a page name.
- [ ] `topicSchema()` and a zod `answerSchema` with exactly two fields: `topic` (<= 500, the
      planner's `FIELD_CAPS.topic`, imported rather than re-stated) and `title` (<= 100, leaving
      room under `TITLE_MAX_CHARS` for the `Research - ` prefix and the lens suffix, likewise
      imported and computed rather than hardcoded).
- [ ] `reformulate(input, opts)`: one `runAgent` call with `profile: 'query'`, structured output,
      a short timeout. On a failed run, a schema violation, or a timeout it returns `null` - the
      caller falls back to the raw text (D3). It never throws into a request handler.
- [ ] The excerpt: when `page` is given, the service reads the page and passes a bounded slice
      (the frontmatter title plus the first N characters, plus the `## Open questions` section)
      rather than letting the run open the file. Reason: this run has the `query` profile and no
      reason to hold a read tool loop for one sentence, and a bounded excerpt keeps the cost
      fixed. Cap it in one named constant.
- **Tests** (`server/test/question-topic.test.ts`): the prompt contains the rules and the input;
  the schema binds both caps; a well-formed answer parses; an over-long topic, a missing field
  and a non-JSON answer each return `null`; a failed run returns `null`; the excerpt is bounded
  and includes the page's own title. `runAgent` is mocked throughout.

### 2.2 The endpoint

- [ ] `POST /api/v1/maintenance/research/topic`, guarded by `credentialMissing` like its
      neighbour, body `{ text, from? }`, answering `{ topic, title }` or `{ topic: null }` when
      the reformulation did not succeed.
- [ ] Registered unconditionally, NOT behind `AGENTS_ENABLED` (D4).
- [ ] `from` validated by the same helper phase 1 introduces. Factor that validation into one
      exported function when phase 1 lands, so the two endpoints cannot drift.
- **Tests:** `server/test/api.test.ts` for the happy path, the null path, the missing-credential
  path and path validation; `server/test/agents-flag-off.test.ts` gains an assertion that this
  route answers with the flag OFF (the inverse of every other assertion in that file, and the
  point of D4).

### 2.3 The composer takes the suggestion

- [ ] Clicking "Start research" on a board row navigates as today, and the Research screen then
      asks for the reformulation before the user sends. While it is in flight the composer shows
      the raw text with a visible, non-blocking state ("preparing the topic"); when it returns,
      the draft is replaced and the user can edit it or send it.
- [ ] If the user has already typed into the composer when the answer arrives, the answer is
      discarded. Their edit wins.
- [ ] A null answer leaves the raw text in place, with no error toast: the action still works,
      it just did not improve.
- [ ] The title rides along in a ref and is sent with the run (2.4). An edited draft drops it,
      the same rule as `from` in 1.2.
- **Tests:** component tests over the three orderings - answer before edit, edit before answer,
  no answer at all - plus one asserting nothing is auto-sent (D3).

### 2.4 The title, decoupled but still pinned

- [ ] `POST /api/v1/maintenance/research` accepts an optional `title`, capped and passed through
      `titleSafe` exactly as a topic-derived title is today.
- [ ] `researchTargetTitle(profile, topic, title?)` uses it when given and falls back to the
      shortened topic when not, so every existing caller is unchanged.
- [ ] The post-run synthesis check and `isSynthesisPath` keep agreeing: the check compares
      against the same computed title the prompt pinned. Assert that in a test rather than by
      reading the code - this is the pair D5 exists to protect.
- **Tests:** `server/test/research-profiles.test.ts` (or wherever `researchTargetTitle` is
  covered today): with and without an explicit title; an unsafe title is made safe; a title over
  the cap is shortened on a word boundary; the prompt's pinned title and the post-run check's
  expected title are equal in all four cases.

### 2.5 `npm run questiontopic-eval`: measuring it before trusting it

Same reasoning as `dedupe-eval` - a reformulation nobody measured is a second guess in front of
the first one.

- [ ] A CLI that reads the real board (via `QuestionsService.list()` against a vault path),
      samples N questions, reformulates each, and prints input against output with the checks
      from section 0 applied to the output: question-mark share, deixis share, length, share over
      the title cap.
- [ ] `--dry` prints the prompts and makes no calls, so the prompt can be reviewed without
      spending anything.
- [ ] Output is local only. It quotes vault content, so it is never committed and never pasted
      into a commit message or PR body (hard rule 7).
- **DoD:** on a 30-question sample of the live board, **at least 90 % of outputs end in a
  question mark, none carries pass-relative deixis, none exceeds the title cap after
  `titleSafe`, and none is longer than one sentence.** Anything below that is a prompt problem to
  fix in 2.1 before phase 2 is called done, not a threshold to lower.

### 2.6 Cost

- [ ] Measure the real per-call cost over the 2.5 sample and record it here.
- **DoD:** a reformulation costs a small fraction of the run it precedes, and the number is
  written into this file. If it does not, the excerpt in 2.1 is too large.

---

## Phase 3: the form rule in the prompt

Prevention. It cannot repair the standing 355 (D2), and it is what stops the next 355 looking
the same.

### 3.1 `OPEN_QUESTION_FORM` in `system-prompt.ts`

- [ ] A short block in the shape of `PAGE_HYGIENE_CHECKLIST`: every item a defect measured in
      section 0, stated as the behaviour wanted. At minimum: a question stands on its own,
      understandable without the page under it; no "in this pass", "in this step", "either
      source" or any other reference to the run that wrote it; names spelled out; one sentence
      under a stated length; it asks something rather than reporting what was missing - and the
      reason it stayed open goes in brackets at the END, where it keeps its value without
      becoming the question.
- [ ] It carries an example of the transformation, invented, in the file and in the prompt:
      a note of the shape "no source in this pass gave independent figures for X's Y, which would
      need a dedicated technical pass" becomes "What independent figures exist for X's Y?
      (not found in trade coverage; needs technical sources)".
- [ ] It goes into the blocks **every vault-writing run carries**, not into `renderFellowBlock`
      alone. The `## Open questions` section is written by ingest and by manual research runs
      too, and those exist with `AGENTS_ENABLED` off. This is not a Fellow feature, so it is not
      behind the flag (invariant 4).
- [ ] It is appended after the vault's own skill template is loaded, which is where the service's
      other corrections already sit and why they hold ("a run follows the instruction in front of
      it", `maintenance.ts`).
- **Tests:** `prompt-style.test.ts` gains the block (no dashes, by the existing assertion); a test
  asserts it is present in an ingest prompt, in a manual research prompt and in a Fellow run
  prompt, and that it does not depend on `AGENTS_ENABLED`.
- **DoD:** all three prompt kinds carry it; the block itself obeys the rule it states (it contains
  no em-dash and no deixis); `npm run vaultprobe` still green.

### 3.2 The duplicate-writing problem, stated but not fixed here

The 32 clusters come from one run writing the same item to its notebook, its synthesis page and
the concept page. The obvious rule ("write it once, on the page whose subject it is") collides
with the planner, which reads candidates from the notebook and from synthesis pages only
(`computeCandidates`, sources 1) - a question written only to a concept page would become
invisible to the Fellow that wrote it.

- [ ] Do NOT add a placement rule in this phase. Write the collision down here, measure the
      cluster count again after phase 3 has been live for a while (0.1 gives the number), and
      decide then, with the planner's candidate sources on the table. Phase 4 handles the
      symptom in the meantime.

---

## Phase 4: one question, one row

The board shows 355 rows for roughly 294 distinct questions. Independent of phases 1 to 3.

### 4.1 Clustering, as a pure function

- [ ] `clusterQuestions(entries)` in `web/src/lib/questions.ts`, beside `questionView`: groups by
      token overlap over the same measure phase 0 uses, returns one representative per group plus
      the members. Representative = the longest text of the group (it carries the most context),
      tie broken by page path so the choice is stable across renders.
- [ ] The threshold is a named exported constant with the measured basis in its doc comment
      (0.7 gives 32 clusters over 67 questions with no false merge found by hand on this vault).
- [ ] Clustering happens on the client. The server route stays as it is; the archive action
      already takes a page and a text, and the client knows every member of the group.
- **Tests** (`web/src/lib/questions.test.ts` or the existing questions test): three wordings of
  one item on three pages cluster to one row; two genuinely different questions on one page do
  not merge; a narrower follow-up on the same subject does not merge (the expensive error, the
  same one `dedupe-judge.ts` is written around); the representative choice is stable.

### 4.2 The row says where it stands

- [ ] A clustered row shows "also on N other page(s)" with the pages reachable (title attribute
      at minimum, `PageLink`s preferred).
- [ ] The view counts (`total`, `planned`, `researching`) are counted over clusters, so the lede
      and the board agree.
- [ ] `planned` and `researching` on a cluster are true when they are true for ANY member: a
      Fellow planning one wording has claimed the question.
- **Tests:** the counts over a clustered fixture; a cluster where one member is planned shows as
  planned.

### 4.3 Archiving a cluster archives its members

- [ ] The archive button on a clustered row issues one `POST /questions/archive` per member,
      sequentially (each one is a vault commit behind the shared mutex; parallel requests would
      queue on that mutex anyway and make failures harder to report).
- [ ] Partial failure is reported and the list is invalidated, so the board shows what actually
      happened rather than an optimistic state.
- [ ] Restoring from the archived tab does the same in reverse.
- **Tests:** a three-member cluster issues three calls; a failure on the second reports and does
  not silently claim success.
- **DoD:** on the live board, the row count drops by the measured cluster surplus (355 to roughly
  294) and no two rows show the same question.

---

## Phase 5: the validator learns the form

The deterministic backstop for phase 3, and the instrument that says whether phase 3 worked.

### 5.1 The `open-question-form` rule

- [ ] A new `ValidationRule` in `pipeline/validator.ts`. Note the existing comment at line 133:
      `## Open Questions` is deliberately not checked *for existence*, because the agents plan
      from it. A **form** check does not conflict with that, and the comment gets one sentence
      saying so.
- [ ] It fires on a bullet that is over a stated length, that carries pass-relative deixis, or
      that opens with a limitation clause ("no source", "neither", "this pass did not"). One
      finding per bullet, naming which of the three.
- [ ] Advisory like every other finding, and read-only like the whole module (hard rule 1).
- [ ] The thresholds and the deixis list come from `pipeline/question-form.ts`, which phase 0
      created for exactly this: the audit, the prompt rule and this rule read one vocabulary, so
      the three cannot drift apart. The module is import-free on purpose - the validator must not
      drag a planning module in behind it.
- **Tests** (`server/test/validator.test.ts`): one page with one bullet of each defect class and
  one clean bullet; assert exactly three findings and their rules; assert a struck-through bullet
  and an `(answered)` bullet produce none (they are closed, and re-litigating them is noise).
- **DoD:** run against the current vault it reports on the order of the numbers in section 0
  (roughly 300 of 355 flagged); against a page whose bullets follow phase 3's rule it reports
  none.

### 5.2 The number that closes the loop

- [ ] After phase 3 has been live across a batch of real runs, re-run `npm run questionaudit` and
      record the new shares in this file next to the section 0 baseline.
- **DoD:** the question-mark share and the deixis share have moved in the right direction on
  questions written after phase 3 shipped. If they have not, phase 3's block is in the wrong
  place or is being overridden, and that is a finding to write down here rather than a phase to
  call done.

---

## Phase 6: local acceptance

Nothing is merged before this. The user drives it; the tasks above are done when this pass has
run and its notes are written into this file.

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
- [ ] **The run itself.** Send one. Confirm in the run's prompt (job log) that the origin block
      names the page the question stood on, and that the pinned synthesis title is the short one
      and not a chopped sentence. Confirm the page the run files carries that title.
- [ ] **Fallback.** Stop the service's credential or otherwise force a null reformulation, and
      confirm the raw text stays and the run still starts.
- [ ] **Clusters.** On the board, confirm the triple-written items now show as one row with
      "also on 2 other pages", and that archiving one strikes all three (check `git log` in the
      vault: three commits, one per page, each naming its page).
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
