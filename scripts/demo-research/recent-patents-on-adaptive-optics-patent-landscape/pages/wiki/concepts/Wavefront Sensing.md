---
type: concept
title: "Wavefront Sensing"
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
  - "[[Predictive Control (Adaptive Optics)]]"
  - "[[Adaptive Optics Testbed]]"
sources:
  - "[[Wavefront Sensor with Inner Detector and Outer Detector (patent)]]"
  - "[[Adaptive Optics Patent Landscape (industry report)]]"
---
# Wavefront Sensing

Measuring how a distorted incoming wavefront differs from a flat one, fast enough and precisely enough that a deformable mirror can be commanded to cancel the difference before the atmosphere (or the optical path) has moved on. [[Adaptive Optics]] cannot correct what it has not measured, so the sensor sets the hard floor on what the rest of the loop can do.

## Why it matters

It sits directly under [[Adaptive Optics]] and feeds [[Predictive Control (Adaptive Optics)]]: prediction only has something to predict from because a sensor produced a time series of measurements in the first place. Two sensor families dominate the practical designs. The Shack-Hartmann sensor splits the incoming beam with a microlens array and infers local wavefront slope from how far each lenslet's focal spot shifts; it is the oldest and most mature approach, and the patent record shows it - filings such as US6563572B1, US7525076 and US7617060 are all incremental improvements (correlation tracking, curvature variants, higher-order extraction from a scene rather than a point source) on a geometry that was already settled decades ago. The pyramid wavefront sensor, proposed by Ragazzoni in 1996, splits the beam with a refractive or reflective pyramid instead of a lenslet array and trades a harder reconstruction problem for higher sensitivity at small aberrations; it is the sensor of choice for most recent predictive-control demonstrations because its non-linear response rewards being paired with a learned reconstructor rather than a fixed linear one.

## Detail

The patent-landscape lens on this topic turned up a pattern worth stating plainly: recent filing activity concentrates on the sensor stage, not the corrector. Deformable mirrors are a mature, incrementally-claimed technology. Sensors keep attracting new geometries and readout schemes, but almost none of the recent activity is astronomy-specific. [[Wavefront Sensor with Inner Detector and Outer Detector (patent)]] (US 11,909,439 B2, SA Photonics / now CACI Photonics) claims a dual-ring detector layout for free-space optical communication terminal acquisition and tracking - a wavefront/pointing sensor built for laser comms, not telescopes. Zoomed out further, [[Adaptive Optics Patent Landscape (industry report)]] shows the broader "adaptive optics" patent classification is led by Texas Instruments and Magic Leap (beam-steering and AR/VR optics) and Raytheon (defense), with astronomy nowhere near the top of the assignee list. Astronomical wavefront sensing is a downstream consumer of sensor and detector IP developed for consumer and defense optics, not the market driving the filings.

## In practice

- When a page or filing says "wavefront sensor" without naming a family, assume Shack-Hartmann unless the context is high-contrast imaging or extreme AO, where pyramid sensors are now standard.
- A sensor patent's application area (FSO comms, ophthalmology, AR/VR, astronomy) usually predicts its claim scope better than its stated field of use does - the same detector geometry gets re-claimed narrowly for each market.
- Treat "who leads AO patents" and "who leads astronomical AO" as different questions with different answers; conflating them overstates astronomy's role in the IP landscape.

## See also

- [[Adaptive Optics]]
- [[Predictive Control (Adaptive Optics)]]
