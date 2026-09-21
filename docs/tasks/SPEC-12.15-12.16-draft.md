# Drafts for root SPEC.md §12.15 and §12.16

**APPLIED 2026-09-21** to `SPEC.md` as §12.15 and §12.16, after §12.14, which was the last
section. Kept as the record of what was proposed and agreed, the way `PR-A6-draft.md` is kept.
`SPEC.md` carries "do not edit without being asked", so this was drafted and asked first (A6
section 2). Records behind it: `docs/tasks/TASKS-QUESTIONS.md`, `TASKS-VAULT-LAYER.md` phase 5.

Applied together with one code fix the drafting turned up: `api/routes/validation.ts:2` cited
"SPEC.md §12.12" for the standing defect list, which is the hub layer. It cites §12.16 now.

---

### 12.15 The form of an open question (added 2026-09-21)

A bullet under `## Open questions` is read away from its page: off the pinboard, or as a research
run's whole brief. Measured 2026-09-20 over **355 bullets on 86 of 1,269 pages**: 29 ended in a
question mark, 153 opened by reporting what a run could not establish, 173 were other declaratives,
and 152 carried a back-reference ("in this pass", "either source", "above") that means nothing off
the page.

**Base product, not behind `AGENTS_ENABLED`** (hard rule 8): an ingest writes the section too. The
flag-gated half is only the display.

| Layer | Where | Gated |
|---|---|---|
| Prompt rule `OPEN_QUESTION_FORM` | `queue.ts:1289` (ingest), `:1879` (research), `maintenance.ts:1463` | no |
| Classifiers (3 forms, 14 deixis phrases) | `pipeline/question-form.ts`, pure and import-free | no |
| Reformulation | `POST /api/v1/maintenance/research/topic` | no |
| Validator rule `open-question-form` | `validator.ts` | no |
| Board, archive | `GET /questions`, `POST /questions/archive`, pinboard | **yes** |

**Prompt rule**, carried by `systemPromptExtra` (hard rule 5, the template stays the vault's):
end with a question mark; no reference to this run or document; names in full; one question per
bullet; the reason it stayed open in brackets *before* the question mark.

**It works for one half only, and the spec records that rather than the intent.** Over eight runs:
asks something **45 of 45** (from 8 %); still deictic **25 of 45**, and 9 of 10 in the two runs
that saw the sharpened wording. The vault contains that phrase **380 times**, so a run is copying
the house style of the place it writes for. **Do not sharpen the wording a third time.**

**Reformulation is what removes it** (0 of 30 in its own eval), and it sits where the defect does
harm: as a brief, not on its own page. `reformulate()` takes the bullet plus a bounded excerpt of
its origin page. Three contracts the callers depend on: it **never throws** (failure, schema
violation or timeout returns null, caller keeps the raw text), it is **read-only**
(`profile: 'query'`, no vault write path, no web), and the excerpt is bounded rather than a read
tool. Caps are derived, not chosen: `TOPIC_MAX_CHARS = FIELD_CAPS.topic`, and the title budget is
what `TITLE_MAX_CHARS` leaves after the `Research - ` prefix and the longest lens suffix. Without
this step the raw bullet became the topic, the title and the page name: **95 % would have named a
page with a sentence cut mid-clause**.

**Validator**, per page, over unarchived bullets: counts those that ask nothing and those that are
deictic, emits one finding naming both. Advisory (§12.16). It never says the section should go,
which is why `## Open questions` stays off the run-protocol heading list.

**Not retroactive.** The 355 standing bullets are repaired one at a time by the reformulation and
by the user's strike-through. Pipeline code does not rewrite vault content (hard rule 1).

---

### 12.16 The standing defect list (added 2026-09-21)

The validator wrote **406 warnings into job logs** and nothing acted on one: dead-link 211,
stale-counter 77, address-map 58, single-source-entity 11, dates 10, frontmatter 3, every row
labelled "advisory only", and **one dead-link class accounting for 109** of them.

**A finding has an identity**: `hash(rule, path, normalised message)`. `validation_findings`
(migration 32) holds one row per defect with `count`, `first_seen`, `last_seen`, `last_job_id`,
`resolved_at`; a repeat updates the row. `jobs.validation` is unchanged and keeps its quote
summary: what one job saw is a different question from what stands in the vault.
`GET /api/v1/validation` (`?rule=`, `?limit=` 1-200 default 50, `?offset=`) returns findings,
per-rule counts and a total. Registered unconditionally: base product (hard rule 8). Findings stay
**advisory** - repair is an agent run's job or the user's, never pipeline code's (hard rule 1).

**Clearing is the hard half.** A finding clears when a run reads its page again and no longer
reports it. Two of the three constraints on that are the arguments of one call,
`ValidationStore.resolveMissing(paths, findings, { checked, fullyChecked })`:

1. `fullyChecked: VAULT_WIDE_RULES` - **a whole-vault rule cannot be cleared per page.** Most
   rules answer about the page they are handed; `address-map`, the hub counters and
   `hot-cache-size` read their file whole on every call and re-report everything. The page such a
   finding names is rarely one a run writes, so per-page clearing raises them and never lowers
   them. Measured both ways: address-map went 7 to **75** in one run, and narrowing the rule an
   hour later took the vault from 72 real findings to **4** while the list stayed at 75, 68 of
   them describing a defect the rule no longer believed. The set is kept honest by a test that
   calls the validator with no paths and asserts every rule still producing a finding is in it.
2. `checked: VALIDATOR_RULES` - **a check may only clear what it could look for**, and the field
   is **required, not optional**: a caller that omits it is the bug. Two rules are unraisable
   from a path list, since a quote is compared against the artifact the job read and a
   near-duplicate against the pre-run commit. A maintenance run touching a page with a quote
   finding would otherwise clear it having compared no quote.
3. `pipeline/standing-recheck.ts` - **a page no run touches is never re-read**, so a notebook or
   dated recap keeps repaired findings indefinitely: **11 of 66** named a defect fixed hours
   earlier. Each run re-reads the pages the list still names as a separate bounded pass, claiming
   only what reading a page answers. Folding it into the run's own check would let an ingest
   clear quote findings for pages its job fetched nothing for.

**Every rule sits on exactly one list**, mechanical or judgement, enforced by an exhaustive type
and a test. A rule on neither reaches no fix run: `open-question-form` (§12.15) was in that state
from the day it shipped, 15 findings' worth, with five others.
