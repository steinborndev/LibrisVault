---
type: meta
title: "hot"
domain: meta
created: 2026-08-27
updated: 2026-09-15
tags:
  - meta
  - hot-cache
status: evergreen
related:
  - "[[Adaptive Optics]]"
  - "[[Wavefront Sensing]]"
  - "[[Predictive Control (Adaptive Optics)]]"
  - "[[Research - Recent patents on adaptive optics - Patent Landscape]]"
---
# Hot Cache

Last updated: 2026-09-15, after a patents-lens research pass on wavefront sensing and predictive control in adaptive optics.

Currently 877 pages across 19 domain values (17 subject domains plus `meta` and `unassigned`). Astronomy is the deepest domain at 233 pages; the long tail (typography, mycology, cartography) is still one-afternoon-detour depth.

## What's current

- [[Adaptive Optics]] now separates the sensing half of the loop from the control half: [[Wavefront Sensing]] (new concept) and [[Predictive Control (Adaptive Optics)]] (new concept).
- The patents-lens landscape data (see [[Adaptive Optics Patent Landscape (industry report)]]) says "adaptive optics" as a patent classification is led by Texas Instruments and Magic Leap (AR/VR optics) and Raytheon, not by astronomy - astronomical AO looks like a downstream consumer of that IP, not its driver. This is a vendor blog's aggregate figures, not primary-source counts; hold it loosely.
- Predictive control in AO splits into two non-competing patent mechanisms: predict-the-wavefront-then-control (Kalman/LQG, EOF) vs. learn-the-policy directly (reinforcement learning on a learned world model). The concrete example of the second is CN 121480603 A (Southwest Jiaotong University, filed 2025-10-31, **pending, not granted**) - see [[Adaptive Optics Dynamic Modeling and Control (patent)]].
- [[Research - Recent patents on adaptive optics - Patent Landscape]] was updated in place rather than duplicated. Two of its three prior findings did not survive a direct check against real filings and were rewritten or dropped; treat anything from before 2026-09-15 attributed to that page with caution if you're recalling it from an older summary.

## Active threads / open questions

- No Western (US/EP) filing was found that makes an equally explicit "predictive control via a trained RL policy" claim to compare against the Chinese filing above - genuinely unresolved, not just unsearched thoroughly.
- Whether a real, repeated "ground-layer-only correction" claiming pattern exists in AO patents is now an open question rather than a stated finding - the earlier version of this claim could not be corroborated.
- Whether any Texas Instruments / Magic Leap filings actually read on astronomical wavefront correction, or whether the "adaptive optics" classification bucket is simply too broad for that comparison to mean anything, is untested.

## Not touched this run

[[Crystallisation Control]] and [[Multiversion Concurrency Control]] were flagged as "related" by the run's setup but have no real connection to this topic - left alone. `wiki/meta/recaps/` (the nightly multi-agent scheduler's log) is a separate mechanism from this run and wasn't used; a new `wiki/log.md` holds this run's own record instead.
