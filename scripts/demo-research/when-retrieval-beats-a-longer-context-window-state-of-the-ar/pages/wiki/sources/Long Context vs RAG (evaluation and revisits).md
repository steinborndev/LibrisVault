---
type: source
title: "Long Context vs RAG (evaluation and revisits)"
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
# Long Context vs RAG (evaluation and revisits)

"Long Context vs. RAG for LLMs: An Evaluation and Revisits" (arXiv:2501.01880).

## Summary

Re-runs the RAG-vs-long-context comparison after filtering out questions a model can already answer without any external context (a confound the authors argue inflated earlier long-context scores), and after separating retrieval methods by type. Long context generally wins on question-answering benchmarks, especially Wikipedia-style questions where the answer is assembled from evidence spread across the source; summarization-based retrieval closes most of that gap, while plain chunk-based retrieval lags behind both. RAG keeps an edge on dialogue-based and general queries. The behaviour is model-size-dependent: citing prior work, it reports RAG improving 70B-class models across all tested context lengths, GPT-4o's RAG performance still improving at 128K input, but Qwen2.5 and GLM-4-Plus degrading in RAG performance beyond 32K input.

## Extracted claims

- Supports [[Retrieval-Augmented Generation]]: retrieval method matters as much as the RAG-vs-long-context choice itself - summarization-based and chunk-based retrieval are not interchangeable.
- Supports [[Context Window]]: the point at which more context stops helping a given model is architecture-specific, observed anywhere from roughly 32K to beyond 128K tokens across the models surveyed.

## Caveats

- The model-specific context-length ceilings (32K for Qwen2.5/GLM-4-Plus, still improving at 128K for GPT-4o) describe specific model releases cited within the paper, not a property of "open-source" or "closed" models as categories.
