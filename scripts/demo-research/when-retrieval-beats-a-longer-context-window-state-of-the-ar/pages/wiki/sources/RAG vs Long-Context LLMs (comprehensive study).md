---
type: source
title: "RAG vs Long-Context LLMs (comprehensive study)"
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
  - "[[Self-Route]]"
---
# RAG vs Long-Context LLMs (comprehensive study)

Li et al., "Retrieval Augmented Generation or Long-Context LLMs? A Comprehensive Study and Hybrid Approach", EMNLP 2024 Industry Track (arXiv:2407.16833).

## Summary

Benchmarks retrieval-augmented generation against directly feeding long-context LLMs (tested against Gemini-1.5 and GPT-4-class models) across public QA and summarization datasets. Finds that long context wins on average quality once the model is given enough compute, but at a cost disadvantage that grows with corpus size, because self-attention's cost is quadratic in input length. Proposes Self-Route, a query-level router that uses the model's own judgement of whether retrieved chunks suffice to decide between the cheap RAG path and the expensive full-context path, reporting quality close to pure long-context at a fraction of the cost.

## Extracted claims

- Supports [[Retrieval-Augmented Generation]]: cost, not just quality, is a deciding variable between RAG and long-context serving.
- Supports [[Context Window]]: quadratic attention cost means the price of a long-context call scales with corpus size, not only with the query.
- Supports [[Self-Route]]: originates the per-query routing pattern.

## Caveats

- Tested against a small number of specific proprietary/near-proprietary model families as of 2024; the cost-quality trade-off it reports is a property of those models' serving stacks at that time, not a law that necessarily holds for every architecture or for later, more heavily-optimized long-context serving.
- "Resourced sufficiently" for long context is doing real work in the paper's own headline finding - it does not claim long context wins under a fixed compute budget, only that it wins when given more.
