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

## 2026-09-15 - Research: When retrieval beats a longer context window

State-of-the-art lens, weighted to 2024-2026 sources. Created the required synthesis page
[[Research - When retrieval beats a longer context window - State of the Art]], one new
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
