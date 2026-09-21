---
type: concept
title: "Self-Route"
domain: machine-learning
created: 2026-09-15
updated: 2026-09-15
tags:
  - concept
  - retrieval
  - evaluation
status: evergreen
related:
  - "[[Retrieval-Augmented Generation]]"
  - "[[Context Window]]"
  - "[[Prompt Sensitivity]]"
sources:
  - "[[RAG vs Long-Context LLMs (comprehensive study)]]"
---
# Self-Route

Self-Route is a routing rule for choosing, per query, whether to answer from retrieved chunks ([[Retrieval-Augmented Generation]]) or from the full document stuffed into the model's [[Context Window]] (long-context): ask the model itself whether the retrieved chunks look sufficient to answer, and only fall back to the expensive full-context path when it says they are not.

## Why it matters

Benchmarks comparing RAG and long-context LLMs largely agree that long context gets the best average answer quality when the model is given a generous compute budget, and that RAG is far cheaper per query. Self-Route treats that as a false choice between two fixed architectures: decide per query instead, using a signal the model already has - its own confidence that the chunks it was handed contain the answer.

## Detail

The mechanism is a self-reflection step, not a trained classifier. The model is first asked whether the retrieved context is sufficient to answer the query. Queries it judges sufficiently covered are answered from the retrieved chunks alone, at RAG's cost. Queries it flags as underspecified, or as needing evidence spread across the whole document, are re-run with the full document in context. Reported behaviour is that this holds average answer quality close to always using full context, while sending only a minority of queries down the expensive path - because most queries in the benchmarks it was tested on turned out to be answerable from a well-targeted retrieval.

The method inherits RAG's dependency on retrieval quality: a query wrongly judged "sufficient" from poor chunks still gets a wrong answer at the cheap path's cost, with no long-context fallback to catch it. It also inherits the general risk of self-assessment - a model's confidence that it has enough context is a different quantity from whether it actually does.

## In practice

- Log which path each query took. The router's error mode is silent, not loud, so this is the cheapest way to notice systematic misrouting.
- The threshold for "sufficient" is a knob, not a constant - tune it against a held-out set that includes queries designed to need cross-document aggregation, not just single-fact lookups.
- Treat Self-Route as a cost-control layer on top of a retrieval system that already works, not a substitute for improving chunking or reranking - see [[OP-RAG (paper)]] and [[Anthropic Contextual Retrieval (technical note)]] for what "already works" costs to build.

## See also

- [[Retrieval-Augmented Generation]]
- [[Context Window]]
- [[Research - When retrieval beats a longer context window - State of the Art]]
