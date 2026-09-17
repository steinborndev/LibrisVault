---
type: meta
title: "log"
domain: meta
created: 2026-09-15
updated: 2026-09-15
tags:
  - meta
status: evergreen
---
# Log

A running record of ingest and research runs. Nightly agent-fleet activity is recorded
separately in `wiki/meta/recaps/`; this file covers ad-hoc runs (autoresearch, manual
ingests) not already captured there.

## 2026-09-15 - Research: Who is funding precision fermentation, and against what substrate

"Startups & funding" lens: company-level rounds, backers and traction rather than the
underlying microbiology. Created the required synthesis page
[[Research: Who is funding precision fermentation, and against what substrate - Startup Landscape]],
two new concepts ([[Precision Fermentation]], [[Fermentation Feedstock Economics]]), seven new
entities meeting the notability bar as subjects of dedicated, fact-rich sources
([[Standing Ovation]], [[Verley]], [[Fermeate]], [[Perfect Day]], [[The Every Company]],
[[Solar Foods]], [[Arkeon]]), and ten new source pages covering 2025-2026 funding rounds, a
sector-wide GFI funding-trend report, an investor cost-parity framework, and a feedstock
survey.

Automated decisions:
- No domain in the closed registry (`wiki/meta/domains.md`) covers industrial precision
  fermentation biotechnology or startup funding: `cooking` is explicitly culinary
  technique/recipes, not industrial biomanufacturing, and `economics` is explicitly macro
  markets/monetary policy, not venture funding. Filed all new pages under `domain: unassigned`
  rather than stretching either existing key, per the domain registry's explicit allowance
  that unassigned is "a correct, expected outcome, not a failure."
- The six vault pages flagged as "already related to this topic"
  ([[Bulk Fermentation]], [[Photometric Precision]], [[Precision and Recall]],
  [[Sourdough Fermentation]], [[Substrate Colonisation]],
  [[Fermentation Culture Collection]]) were read in full and found to share only vocabulary
  with this topic (baking technique, ML evaluation metrics, astronomical photometry, mushroom
  substrate identification), not subject matter - none discusses fermentation as
  biotechnology or its funding. None was extended; a note distinguishing the two senses of
  "fermentation" was added to [[Precision Fermentation]] instead of retrofitting the unrelated
  pages.
- Investors that recur across rounds (Bpifrance, Synthesis Capital, Ajinomoto Group Ventures,
  McWin Capital Partners, Danone Ventures, etc.) were kept as inline attribution on the
  relevant entity/source pages rather than given entity pages of their own: each appears only
  as a funding-round participant, never as the subject of a source, per the entity-notability
  rule and the lens's own guidance.
- The GFI 2026 State of the Industry (Fermentation) report was read only via a secondary
  AgFunderNews summary, not fetched directly; added to [[Reading list]] rather than treating
  its figures as fully confirmed. A second secondary source cited a different 2024 total
  ($651M vs. $632M) for the same report; both are noted rather than silently resolved.
- The required synthesis title uses a hyphen in place of the prompt's em dash, per the
  standing no-em-dash writing rule (consistent with the same substitution made in the prior
  research run below).

## 2026-09-15 - Research: When retrieval beats a longer context window

State-of-the-art lens, weighted to 2024-2026 sources. Created the required synthesis page
[[Research: When retrieval beats a longer context window - State of the Art]], one new
concept ([[Self-Route]]), five new source pages (LaRA, the Self-Route/RAG-vs-LC study,
OP-RAG, the "Long Context vs RAG" re-evaluation, Anthropic's Contextual Retrieval technical
note), and extended [[Retrieval-Augmented Generation]], [[Context Window]] and
[[Contextual Retrieval]] with real findings instead of creating competing pages.

Automated decisions:
- No `scripts/allocate-address.sh` exists in this vault, so new pages carry no `address:`
  field - address allocation was skipped rather than invented.
- One specific cost figure surfaced by search (seconds-per-token at 1M-token context,
  attributed to a retrieval-acceleration paper) could not be confirmed against that paper's
  own abstract and was left out of every page rather than reported unverified.
- `wiki/concepts/Contextual Retrieval.md` (knowledge-management domain) already used this
  exact title for an unrelated concept - added a "Not to be confused with" note there and
  named the new source page distinctly ("Anthropic Contextual Retrieval (technical note)")
  instead of overwriting or renaming the existing page.
- The task's required synthesis title used an em dash; replaced with a hyphen per the
  standing no-em-dash writing rule, keeping the wording otherwise identical.
