---
type: source
title: "Adaptive Optics Dynamic Modeling and Control (patent)"
domain: astronomy
created: 2026-09-15
updated: 2026-09-15
tags:
  - source
  - astronomy
  - instrumentation
status: reference
related:
  - "[[Predictive Control (Adaptive Optics)]]"
---
# Adaptive Optics Dynamic Modeling and Control (patent)

CN 121480603 A, "A model-based adaptive optics dynamic modeling and control method and device." Filed by Southwest Jiaotong University, priority and filing date 2025-10-31, published (laid open) 2026-02-06. Status: pending - this is a published application, not a granted patent, and the claims may still narrow before grant.

## Summary

Independent claim 1 (method) and claim 10 (device, mirroring the method as a processor-plus-memory implementation) cover a four-stage pipeline for adaptive-optics control:

1. Encode state data from multiple observation types while preserving the temporal variation characteristics of the vector observations.
2. Fuse the heterogeneous sensor streams with a cross-attention mechanism.
3. Build a recurrent-neural-network "world model" that keeps a hidden state and infers a latent state to predict how the system will evolve.
4. Train a reinforcement-learning agent on trajectories imagined from that world model, and use it to output real-time AO control parameters (gain, sampling frequency, exposure time) without manual tuning.

This frames predictive AO control as a policy-learning problem: the claim covers training and running a learned controller, not a specific estimator of the future wavefront. That is the structural difference from the academic EOF/Kalman-filter lineage of predictive control (see [[Predictive Control (Adaptive Optics)]]), which frames prediction as state estimation feeding an existing control law. The two approaches converge on the same outcome - anticipatory rather than reactive correction - by different, non-overlapping mechanisms.

## Extracted claims

- Supports [[Predictive Control (Adaptive Optics)]]: a concrete, dated example of predictive AO control claimed as a trained RL policy rather than a linear estimator.

## Caveats

- Original document is in Chinese; read via the English rendering on Google Patents, not the original-language text. No verbatim claim language is quoted here, only paraphrase, per the vault's language rule.
- Pending application only - not yet examined or granted. Claim scope commonly narrows during prosecution, so treat the four-stage description above as a snapshot, not a final claim.
- Could not find a granted or pending Western (US/EP) filing making an equivalent explicit "predictive control via a trained RL policy" claim in the time available for this research pass; logged as an open question on the synthesis page rather than assumed absent.
