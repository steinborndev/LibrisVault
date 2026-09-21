---
type: question
title: "Research: Recent patents on adaptive optics — Patent Landscape"
domain: astronomy
created: 2026-08-27
updated: 2026-09-15
tags:
  - question
  - research
  - astronomy
  - patents
status: developing
related:
  - "[[Adaptive Optics]]"
  - "[[Wavefront Sensing]]"
  - "[[Predictive Control (Adaptive Optics)]]"
  - "[[Adaptive Optics Testbed]]"
sources:
  - "[[Wavefront Sensor with Inner Detector and Outer Detector (patent)]]"
  - "[[Adaptive Optics Dynamic Modeling and Control (patent)]]"
  - "[[Adaptive Optics Patent Landscape (industry report)]]"
---

# Research: Recent patents on adaptive optics — Patent Landscape

## Question

What has been filed on wavefront sensing and predictive control, and by whom?

## Method

Searched through the patents lens (Google Patents, USPTO, EPO Espacenet, plus a patent-analytics vendor report for aggregate landscape figures), read what was reachable in full or as a verified Google Patents / USPTO record, and checked each claim against the pages the vault already held. This run superseded the previous pass: two of the three findings below have been rewritten because the earlier version could not be corroborated once actual filings were checked, and the "related"/"sources" links (which had drifted onto unrelated transit-photometry pages) have been corrected.

## Findings

### 1. Filing activity concentrates on the sensor and the control law, not the deformable mirror - and most of it isn't astronomy

The deformable mirror is mature, incrementally-claimed technology. Sensor and control-law patents keep appearing, but landscape data from [[Adaptive Optics Patent Landscape (industry report)]] shows the "adaptive optics" classification (4,083 patent families) is led by Texas Instruments (652 records, beam-steering/spatial light modulation) and Magic Leap (447, AR/VR optics), with Raytheon third (397) and Hamamatsu and Olympus behind that - astronomy-specific assignees are nowhere near the top. A concrete example of the sensor side: [[Wavefront Sensor with Inner Detector and Outer Detector (patent)]] (US 11,909,439 B2), a dual-ring detector geometry claimed by SA Photonics and now held by CACI Photonics after CACI's acquisition of SA Photonics, built for free-space optical communication terminal acquisition and tracking rather than telescope instrumentation. Astronomical wavefront sensing looks like a downstream consumer of IP developed for consumer optics, telecom and defense, not the field generating the filings.

### 2. Predictive control splits into two non-competing patent lineages: predict-then-control vs. learn-the-policy

[[Adaptive Optics Dynamic Modeling and Control (patent)]] (CN 121480603 A, Southwest Jiaotong University, priority 2025-10-31, pending) claims a reinforcement-learning policy trained on a learned world model of the sensor data, outputting AO control parameters directly. That is a different mechanism from the older estimate-the-wavefront-then-apply-a-control-law lineage (Kalman/LQG, empirical orthogonal functions) that the academic literature has used for years. Read as patent claims, these do not obviously conflict even where they achieve the same anticipatory-correction outcome, because they claim different mechanisms for getting there. Full reasoning is on [[Predictive Control (Adaptive Optics)]].

### 3. No corroborated evidence for a ground-layer-only claiming pattern

The previous pass claimed ground-layer-only correction was "claimed more often than full correction" for commercial reasons. This search could not corroborate that: ground-layer adaptive optics (GLAO) turned up as an active astronomical technique (e.g. the New Vacuum Solar Telescope, a Keck GLAO feasibility study) but not as a distinct, repeated claiming pattern in the patents actually checked. Rather than carry an uncorroborated finding forward, it is dropped and replaced with an open question below - the earlier finding may have been an artifact of the previous pass's method, not a real pattern.

## What this changes about the vault

[[Adaptive Optics]] previously described correction as roughly one undifferentiated technique. It now separates the sensing half ([[Wavefront Sensing]]) from the control half ([[Predictive Control (Adaptive Optics)]]), and the patent evidence says the two halves have different economics and different assignee populations - sensing IP is dominated by non-astronomy markets, while the reinforcement-learning predictive-control claim found here comes from a Chinese university rather than an established defense or instrumentation vendor.

## Open questions

- Does a granted or pending Western (US/EP) filing make an equivalent explicit "predictive control via a trained RL policy" claim, to compare against CN 121480603 A - or is this currently a China-only filing pattern?
- Is there a real, repeated ground-layer-only claiming pattern, and if so, in which jurisdiction's filings does it actually show up? (Superseded finding 3, above, could not confirm or deny this.)
- Texas Instruments and Magic Leap lead the broader "adaptive optics" classification by a wide margin - do any of their filings actually read on astronomical wavefront correction, or is the classification bucket simply too broad for that comparison to mean anything?

## Pages this rests on

- [[Adaptive Optics]]
- [[Wavefront Sensing]]
- [[Predictive Control (Adaptive Optics)]]
- [[Adaptive Optics Testbed]]
