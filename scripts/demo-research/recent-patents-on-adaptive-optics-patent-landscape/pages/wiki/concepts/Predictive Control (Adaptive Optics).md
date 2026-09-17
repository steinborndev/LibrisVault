---
type: concept
title: "Predictive Control (Adaptive Optics)"
domain: astronomy
created: 2026-09-15
updated: 2026-09-15
tags:
  - concept
  - astronomy
  - instrumentation
status: evergreen
related:
  - "[[Adaptive Optics]]"
  - "[[Wavefront Sensing]]"
sources:
  - "[[Adaptive Optics Dynamic Modeling and Control (patent)]]"
  - "[[Adaptive Optics Patent Landscape (industry report)]]"
---
# Predictive Control (Adaptive Optics)

A response to servo lag: by the time [[Wavefront Sensing]] has measured a distortion, the control computer has processed it, and the deformable mirror has moved, the atmosphere has already changed. A classical integrator corrects last frame's error; predictive control tries to correct where the error will be, not where it was.

## Why it matters

It sits directly under [[Adaptive Optics]] and depends entirely on [[Wavefront Sensing]] for the time series it predicts from. The field splits cleanly into two lineages that solve the same problem by different means, and the patent record makes that split legible in a way the academic literature alone does not.

## Detail

The older lineage treats prediction as **state estimation**: assume a model of how turbulence evolves (frozen-flow, an autoregressive process, empirical orthogonal functions fit to past data) and use it to estimate the wavefront a few milliseconds ahead, then hand that estimate to an otherwise-ordinary control law. Kalman-filter-based Linear Quadratic Gaussian (LQG) control and Empirical Orthogonal Function (EOF) prediction both belong here; both have been demonstrated on real instruments (EOF-based prediction has run on Subaru/SCExAO and the Keck II near-infrared pyramid wavefront sensor).

The newer lineage treats prediction as a **control/policy-learning problem**: train a model - typically a neural network - to map recent sensor history directly to the next correction, without an explicit intermediate wavefront estimate. Closed-loop predictive control with convolutional neural networks, reinforcement-learning approaches that learn a world model of the turbulence and train a policy against imagined trajectories from it (demonstrated on-sky as PO4AO on the 1.52 m PAPYRUS telescope at Observatoire de Haute-Provence), and hybrid supervised-plus-reinforcement-learning schemes paired with an unmodulated pyramid wavefront sensor are all recent examples of this lineage.

The patent-landscape lens found a concrete, dated instance of the second lineage: [[Adaptive Optics Dynamic Modeling and Control (patent)]] (CN 121480603 A, Southwest Jiaotong University, priority 2025-10-31, pending) claims fusing multi-sensor state data via cross-attention, building a recurrent-network world model, and training a reinforcement-learning agent on trajectories imagined from that world model to output AO control parameters in real time. Framed as a claim, this covers the *mechanism* of a trained policy, not the *outcome* of anticipatory correction as such. That distinction matters: the vault previously carried an open question asking whether two independent predictive-control filings actually conflict. On the evidence gathered here, a state-estimation claim (predict the wavefront, then control) and a policy-learning claim (learn the control directly) do not obviously read on each other even when both achieve anticipatory correction - they claim different mechanisms for the same outcome, which is exactly the situation patent claims are drafted to keep separate. Whether a Western assignee holds a comparably explicit policy-learning claim to compare against is still open; none was found in this pass.

## In practice

- Ask "does this predict the wavefront, or does it predict the correction?" before comparing two predictive-control claims or papers - it is the fastest way to tell the two lineages apart.
- EOF/Kalman approaches need an explicit turbulence model and are easier to certify and explain; RL/world-model approaches need training data or simulation and are easier to adapt to a new instrument without re-deriving a model by hand. Neither has displaced the other as of this research pass.
- A patent claiming "predictive adaptive optics control" without specifying which lineage it belongs to has probably not been read carefully enough yet.

## See also

- [[Adaptive Optics]]
- [[Wavefront Sensing]]
