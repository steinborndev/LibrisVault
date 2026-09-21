---
type: concept
title: "Context Window"
domain: machine-learning
created: 2026-07-08
updated: 2026-09-15
tags:
  - concept
  - machine-learning
  - training
  - evaluation
status: evergreen
related:
  - "[[Prompt Sensitivity]]"
  - "[[Evaluation Harness]]"
  - "[[Retrieval-Augmented Generation]]"
sources:
  - "[[Weight Decay (survey)]]"
  - "[[RAG vs Long-Context LLMs (comprehensive study)]]"
  - "[[Long Context vs RAG (evaluation and revisits)]]"
---
# Context Window

Context Window is usually introduced as a definition and then used as a constraint. Both readings show up across how models are trained, evaluated and made to behave.

## Why it matters

It sits directly under [[Ablation Study]] and [[Scaling Law]], which is why it turns up
whenever how models are trained, evaluated and made to behave is discussed at any depth.

## Detail

Two groups reporting different values are frequently both right and simply not measuring the same thing, which is why the method section matters more than the headline figure.
Where it breaks down is well characterised, which makes it useful: the failure mode is diagnostic, so an anomaly here usually points at a specific cause rather than at noise.

## In practice

- Separate the systematic term from the statistical one before quoting an uncertainty.
- Say which correction was applied, and in which order.
- When results disagree, compare methods before comparing numbers.

## State of the art (2026): what a longer window actually costs

A bigger context window is not a free substitute for retrieval. Self-attention's cost is quadratic in input length, so a call that stuffs in the whole corpus gets proportionally more expensive as that corpus grows, on every single query - unlike [[Retrieval-Augmented Generation]], whose per-query cost tracks the size of what was retrieved, not the size of what exists. [[RAG vs Long-Context LLMs (comprehensive study)]] frames this as the actual trade-off practitioners face: long context wins on average answer quality "when resourced sufficiently," but that qualifier is doing the work - it wins by spending more, not by being intrinsically better per token spent.

Window size also has a per-model ceiling on how much of it actually helps, and that ceiling is not fixed by the advertised context length. [[Long Context vs RAG (evaluation and revisits)]] reports GPT-4o's answer quality still improving with retrieval-augmented context out to 128K tokens, while Qwen2.5 and GLM-4-Plus degrade in the same setup beyond 32K - the same nominal context length behaves differently depending on how the model was trained to use it, not just how large the window is.

See [[Research - When retrieval beats a longer context window - State of the Art]] for the full synthesis.

## See also

- [[Prompt Sensitivity]]
- [[Evaluation Harness]]
- [[Retrieval-Augmented Generation]]
