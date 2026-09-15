---
type: concept
title: "Contextual Retrieval"
domain: knowledge-management
created: 2026-08-19
updated: 2026-09-15
tags:
  - concept
  - knowledge-management
  - llm-wiki
  - method
status: stub
related:
  - "[[Domain Registry]]"
  - "[[Orphan Page]]"
sources:
  - "[[LLM Wiki Pattern (review)]]"
  - "[[Anthropic Contextual Retrieval (technical note)]]"
---
# Contextual Retrieval

Most treatments of how the wiki itself is supposed to work reach for Contextual Retrieval at the point where the simple model stops predicting the data.

## Why it matters

It sits directly under [[Page Authority]] and [[Stub Threshold]], which is why it turns up
whenever how the wiki itself is supposed to work is discussed at any depth.

## Detail

The practical consequence is a trade-off rather than a rule. Push one side and the neighbouring effect starts to dominate; push the other and the measurement stops being sensitive to what you wanted to know.
It is cheap to state and expensive to satisfy. Most working practice sits at a compromise point and says so explicitly; the write-ups that do not are the ones later reanalyses disagree with.

## In practice

- Record the configuration alongside the result - it is the part nobody can reconstruct later.
- Prefer a stated range over a single number with an implied precision.
- Re-derive at least one known value before trusting a new pipeline.

## Not to be confused with

Same name, different subject: [[Anthropic Contextual Retrieval (technical note)]] describes a production RAG technique (prepending generated context to document chunks before embedding, in the machine-learning domain) that this wiki's own pattern is only loosely analogous to. The two are unrelated other than sharing a name and a general shape - "situate the fragment before you index it."

## See also

- [[Domain Registry]]
- [[Orphan Page]]
