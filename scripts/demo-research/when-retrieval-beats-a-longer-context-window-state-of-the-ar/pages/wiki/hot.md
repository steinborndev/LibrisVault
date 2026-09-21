---
type: meta
title: "hot"
domain: meta
created: 2026-08-27
updated: 2026-09-15
tags:
  - meta
  - hot-cache
status: evergreen
---
# Hot Cache

A digest of the vault, refreshed after ingests.

Last Updated: 2026-09-15, after an autoresearch pass on "when retrieval beats a longer
context window" (state-of-the-art lens, weighted to 2024-2026 sources).

Currently 890 pages across 18 domains. One subject is far deeper than the others; the long
tail is one-afternoon detours.

## Key facts from this pass

- Across recent benchmarks (LaRA, "Long Context vs RAG", the Self-Route study), there is no
  fixed winner between RAG and long-context LLMs: long context tends to win when evidence is
  spread evenly across a document, RAG tends to win on narrow/dialogue-style queries with an
  accurate retriever, and the two differ sharply on cost even when long context wins on
  quality (self-attention is quadratic in input length).
- Two independent 2024-2025 papers (OP-RAG; Anthropic's Contextual Retrieval note) converge
  on the same root cause for most reported RAG failures: chunk-level context loss and poor
  chunk count/ordering, not context-window size. Anthropic reports cutting retrieval
  failures 67% (5.7% to 1.9%) by fixing that, without touching the underlying model.
- Anthropic's own practical threshold: below roughly 200K tokens of knowledge base, just
  prompting the whole thing (with caching) is often simpler than building retrieval.

## Recent changes

- New: [[Research - When retrieval beats a longer context window - State of the Art]]
  (required synthesis page for this pass).
- New concept: [[Self-Route]] - the "let the model decide per query" routing pattern.
- New sources: [[LaRA (benchmark paper)]], [[RAG vs Long-Context LLMs (comprehensive study)]],
  [[OP-RAG (paper)]], [[Long Context vs RAG (evaluation and revisits)]],
  [[Anthropic Contextual Retrieval (technical note)]].
- Extended rather than replaced: [[Retrieval-Augmented Generation]] and [[Context Window]]
  each gained a real "State of the art (2026)" section; [[Contextual Retrieval]]
  (knowledge-management - the wiki's own pattern, unrelated to Anthropic's technique despite
  the shared name) gained a disambiguation note.

## Active threads / open questions

- No source found gives a verified apples-to-apples cost figure (dollars/seconds per query)
  for RAG vs. long context at a fixed quality bar - only raw attention-cost figures, which
  aren't the same thing.
- Whether the per-model context-length ceilings reported in "Long Context vs RAG" (e.g.
  Qwen2.5/GLM-4-Plus degrading past 32K, GPT-4o still improving at 128K) are still true of
  2026-era model releases is unchecked.
- No paper was found that holds retriever quality fixed and varies only RAG-vs-long-context
  architecture - so how much of the "long context wins" result is really "the RAG baseline
  was under-engineered" is still open.

related: [[Retrieval-Augmented Generation]], [[Context Window]], [[Self-Route]],
[[Contextual Retrieval]]
