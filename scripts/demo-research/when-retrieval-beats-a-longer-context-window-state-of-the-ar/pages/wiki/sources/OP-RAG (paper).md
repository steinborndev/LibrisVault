---
type: source
title: "OP-RAG (paper)"
domain: machine-learning
created: 2026-09-15
updated: 2026-09-15
tags:
  - source
  - retrieval
  - evaluation
status: reference
related:
  - "[[Retrieval-Augmented Generation]]"
  - "[[Context Window]]"
---
# OP-RAG (paper)

Yu et al., "In Defense of RAG in the Era of Long-Context Language Models" (arXiv:2409.01666).

## Summary

Argues against the claim that long-context LLMs make RAG obsolete: feeding a model everything is not the same as feeding it the right things, and models measurably lose focus as irrelevant context accumulates. Introduces order-preserve RAG (OP-RAG): retrieved chunks are kept in their original document order instead of being resorted by similarity score before being placed in the prompt. Reports that answer quality follows an inverted-U curve as the number of retrieved chunks grows - too few misses evidence, too many reintroduces the noise problem long-context input already has - and that the sweet spot on that curve beats giving the model the entire document, while using substantially fewer tokens.

## Extracted claims

- Supports [[Retrieval-Augmented Generation]]: chunk ordering and chunk count, not just retrieval accuracy, materially change RAG output quality.
- Supports [[Context Window]]: more context is not monotonically better even within a single method - the same inverted-U pattern that hurts naive long-context stuffing also shows up inside RAG once too many chunks are retrieved.

## Caveats

- The inverted-U "sweet point" is reported as an empirical pattern found by sweeping chunk counts on the paper's own benchmarks, dataset- and retriever-specific, not a closed-form optimum guaranteed to transfer without re-tuning.
