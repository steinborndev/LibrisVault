---
type: concept
title: "Retrieval-Augmented Generation"
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
  - "[[Context Window]]"
  - "[[Prompt Sensitivity]]"
  - "[[Self-Route]]"
sources:
  - "[[Regularisation (methods paper)]]"
  - "[[RAG vs Long-Context LLMs (comprehensive study)]]"
  - "[[LaRA (benchmark paper)]]"
  - "[[OP-RAG (paper)]]"
  - "[[Long Context vs RAG (evaluation and revisits)]]"
  - "[[Anthropic Contextual Retrieval (technical note)]]"
---
# Retrieval-Augmented Generation

The short version: Retrieval-Augmented Generation is what happens when the idealised description of how models are trained, evaluated and made to behave meets a real instrument.

## Why it matters

It sits directly under [[Benchmark Contamination]] and [[Ablation Study]], which is why it turns up
whenever how models are trained, evaluated and made to behave is discussed at any depth.

## Detail

The practical consequence is a trade-off rather than a rule. Push one side and the neighbouring effect starts to dominate; push the other and the measurement stops being sensitive to what you wanted to know.
It is cheap to state and expensive to satisfy. Most working practice sits at a compromise point and says so explicitly; the write-ups that do not are the ones later reanalyses disagree with.

## In practice

- State the assumption that makes the simple form valid, and check it holds.
- Report the quantity actually measured, not the one it is usually converted into.
- Keep the raw observable: conversions are lossy and conventions change.

## State of the art (2026): RAG versus a longer context window

The last two years of head-to-head benchmarks converge on "it depends," not on a winner. [[LaRA (benchmark paper)]] (2,326 test cases across 11 LLMs) finds no configuration-independent choice: the right call depends jointly on model size, task type, context length and how good the retrieved chunks actually are. Where a pattern does hold, it splits by evidence shape: long context tends to win when the answer requires aggregating evidence spread evenly across a document, RAG tends to win on dialogue-style and narrow single-fact queries, per [[Long Context vs RAG (evaluation and revisits)]].

Even where long context wins on quality, it does not win on cost: [[RAG vs Long-Context LLMs (comprehensive study)]] reports long context "consistently outperforms RAG in terms of average performance" when given enough compute, but that "RAG's significantly lower cost remains a distinct advantage" - self-attention's quadratic cost means a long-context call gets more expensive as the corpus grows, not just as the query does. Its proposed fix, [[Self-Route]], routes each query to the cheap or expensive path based on the model's own judgement of whether retrieval already gave it enough.

The more consistent finding across sources is that RAG's reported weaknesses are often retrieval-engineering weaknesses, not architectural ones. [[OP-RAG (paper)]] shows RAG quality follows an inverted-U as chunk count grows and beats feeding the full document once tuned. [[Anthropic Contextual Retrieval (technical note)]] reports that the dominant real-world failure was chunks losing their surrounding context, not the context window being too small - fixing that cut retrieval failures 67% (5.7% to 1.9%) without touching the underlying model.

See [[Research - When retrieval beats a longer context window - State of the Art]] for the full synthesis.

## See also

- [[Context Window]]
- [[Prompt Sensitivity]]
- [[Self-Route]]
