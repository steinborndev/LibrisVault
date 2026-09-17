---
type: source
title: "LaRA (benchmark paper)"
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
# LaRA (benchmark paper)

Li et al., "LaRA: Benchmarking Retrieval-Augmented Generation and Long-Context LLMs - No Silver Bullet for LC or RAG Routing", ICML 2025 (arXiv:2502.09977).

## Summary

Addresses the inconsistency between earlier RAG-vs-long-context comparisons by building a single controlled benchmark: 2,326 test cases across four QA task categories and three types of naturally-occurring long document, run against 11 LLMs (7 open-source, 4 proprietary). Its central finding is negative rather than a ranking: there is no configuration-independent winner. The best choice depends jointly on the model's parameter size, its long-text handling ability, the context length involved, the task type, and the characteristics of the chunks a retriever actually returns.

## Extracted claims

- Supports [[Retrieval-Augmented Generation]]: the RAG/long-context choice is task- and model-dependent, not a fixed architectural preference.
- Supports [[Context Window]]: raw context length is one input among several to the RAG-vs-long-context decision, not the deciding one by itself.

## Caveats

- A benchmark result is a statement about the 11 models and the test distribution used; the paper frames its guidelines as practitioner heuristics rather than a closed-form rule, and later model releases are not covered.
