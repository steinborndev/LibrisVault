---
type: source
title: "Anthropic Contextual Retrieval (technical note)"
domain: machine-learning
created: 2026-09-15
updated: 2026-09-15
tags:
  - source
  - retrieval
status: reference
related:
  - "[[Retrieval-Augmented Generation]]"
  - "[[Contextual Retrieval]]"
---
# Anthropic Contextual Retrieval (technical note)

Anthropic, "Introducing Contextual Retrieval", September 2024 (anthropic.com/news/contextual-retrieval).

## Summary

A production-system writeup of a specific RAG failure mode: chunking a document for embedding strips the surrounding context a chunk needs to be findable (a sentence reading "revenue grew 3%" is useless as a retrieval target once separated from which company and which quarter it describes). The proposed fix prepends a short (50-100 token) LLM-generated context blurb to each chunk before both embedding and BM25 indexing, then adds a reranking pass over the results. Reports retrieval-failure-rate reductions measured against a 5.7% baseline: contextual embeddings alone bring it to 3.7% (35% relative reduction), adding contextual BM25 reaches a 49% relative reduction, and adding reranking on top of both reaches 1.9% (67% relative reduction). States explicitly that for knowledge bases under roughly 200,000 tokens, simply including the whole knowledge base in the prompt (using prompt caching to control repeated cost) is often the more practical option, and that contextual retrieval earns its complexity once a knowledge base outgrows a practical prompt.

## Extracted claims

- Supports [[Retrieval-Augmented Generation]]: chunk-level context loss, not context-window size, was the dominant retrieval failure mode in this production system.
- Supports [[Contextual Retrieval]]: a concrete, numerically-measured production analogue of the wiki's own contextual-retrieval pattern, applied to document chunking rather than to a page graph - see that page's "Not to be confused with" note.

## Caveats

- Figures come from Anthropic's own evaluation set and their own embedding/reranking/BM25 stack; a vendor technical note rather than a peer-reviewed, third-party-benchmarked result.
