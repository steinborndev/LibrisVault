---
type: source
title: "Wavefront Sensor with Inner Detector and Outer Detector (patent)"
domain: astronomy
created: 2026-09-15
updated: 2026-09-15
tags:
  - source
  - astronomy
  - instrumentation
status: reference
related:
  - "[[Wavefront Sensing]]"
---
# Wavefront Sensor with Inner Detector and Outer Detector (patent)

US Patent 11,909,439 B2, published as application US2022/0345221A1 on 2022-10-27 and granted on 2024-02-20. Priority date 2021-04-23, filed 2022-04-21. Originally assigned to SA Photonics, Inc.; now held by CACI Photonics, LLC after CACI International's acquisition of SA Photonics. Inventors Greg G. Mitchell and William C. Dickson. Status: granted, active.

## Summary

Claims a wavefront/alignment sensor built from two concentric detector rings in a single plane: a set of larger "outer" detection surfaces surrounding a set of smaller "inner" ones. The outer ring picks up large pointing errors during initial beam acquisition between free-space optical (FSO) communication terminals; the inner ring hands off to fine tracking once the link is established. It is a sensing-geometry patent, not a correction or control-law patent - there is no deformable mirror or predictive element in the independent claim, only the detector layout and the acquisition-to-tracking handoff it enables.

The application is laser communications, not astronomical imaging, but the underlying problem - measuring wavefront/pointing error fast enough to keep a correction loop closed against atmospheric turbulence - is the same one astronomical adaptive optics solves, and the assignee history (SA Photonics folded into a larger defense contractor) is itself a data point about where sensor R&D money in this space currently sits.

## Extracted claims

- Supports [[Wavefront Sensing]]: filed as a case of the "sensor, not corrector" pattern in wavefront-sensing filing activity - novelty is in detector geometry and acquisition/tracking handoff, not in wavefront reconstruction or correction.

## Caveats

- Read via the Google Patents record and a rendered summary of the USPTO PDF, not the full granted specification text - claim language above is paraphrased, not quoted.
- Domain is filed as astronomy to sit alongside the vault's existing [[Adaptive Optics]] cluster, even though the patent's own application is free-space optical communications, not telescope instrumentation.
