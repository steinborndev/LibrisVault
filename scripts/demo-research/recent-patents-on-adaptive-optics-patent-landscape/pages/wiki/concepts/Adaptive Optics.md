---
type: concept
title: "Adaptive Optics"
domain: astronomy
created: 2026-07-28
updated: 2026-09-15
tags:
  - concept
  - astronomy
  - exoplanet
  - spectroscopy
status: evergreen
related:
  - "[[Coronagraph]]"
  - "[[Starshade]]"
  - "[[Wavefront Sensing]]"
  - "[[Predictive Control (Adaptive Optics)]]"
sources:
  - "[[Thermal Inversion (retrospective)]]"
  - "[[Adaptive Optics Patent Landscape (industry report)]]"
---
# Adaptive Optics

Most treatments of exoplanets, the instruments that find them, and the stars they orbit reach for Adaptive Optics at the point where the simple model stops predicting the data.

## Why it matters

It sits directly under [[Detector Persistence]] and [[Charge Transfer Inefficiency]], which is why it turns up
whenever exoplanets, the instruments that find them, and the stars they orbit is discussed at any depth.

## Detail

The practical consequence is a trade-off rather than a rule. Push one side and the neighbouring effect starts to dominate; push the other and the measurement stops being sensitive to what you wanted to know.
It is cheap to state and expensive to satisfy. Most working practice sits at a compromise point and says so explicitly; the write-ups that do not are the ones later reanalyses disagree with.

## In practice

- Record the configuration alongside the result - it is the part nobody can reconstruct later.
- Prefer a stated range over a single number with an implied precision.
- Re-derive at least one known value before trusting a new pipeline.

## Instrumentation and control

The loop has two halves that fail differently: [[Wavefront Sensing]] measures the distortion, and a control law decides what to do about it. A 2026-09-15 research pass through the patent lens (see [[Research: Recent patents on adaptive optics — Patent Landscape]]) found that recent IP activity sits almost entirely on the measurement and control-law side rather than the deformable mirror itself, and that most of the filing volume in "adaptive optics" as a patent classification comes from consumer AR/VR and defense optics, not astronomy - astronomical AO is a downstream beneficiary of that IP, not the field driving it. The control-law side has its own two-way split, covered in [[Predictive Control (Adaptive Optics)]]: predict the future wavefront and hand it to a classical controller, or learn the correction policy directly.

## See also

- [[Coronagraph]]
- [[Starshade]]
- [[Wavefront Sensing]]
- [[Predictive Control (Adaptive Optics)]]
