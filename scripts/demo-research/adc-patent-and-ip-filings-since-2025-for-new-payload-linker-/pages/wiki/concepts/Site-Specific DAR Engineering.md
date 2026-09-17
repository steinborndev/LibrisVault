---
type: concept
title: "Site-Specific DAR Engineering"
domain: oncology
created: 2026-09-15
updated: 2026-09-15
tags:
  - concept
  - oncology
  - adc
  - conjugation
status: developing
related:
  - "[[Multidrug Branched Linker]]"
sources:
  - "[[Antibody-Drug Conjugates Having a Tailor-Made Drug-to-Antibody Ratio (patent)]]"
---
# Site-Specific DAR Engineering

Controlling drug-to-antibody ratio (DAR) - how many payload molecules end up on each antibody - by engineering the antibody's own structure at a specific site, rather than by controlling the conjugation chemistry or reaction conditions after the fact. Distinct from [[Multidrug Branched Linker]], which fixes the payload-carrying capacity of the *linker*; this fixes the number and location of attachment points on the *antibody*.

## Why it matters

Conventional cysteine-conjugation ADCs get their DAR from whatever native or engineered cysteines happen to be reduced and available, which tends to produce a heterogeneous mixture of species at different DAR values - a manufacturing and characterisation burden, and a source of batch-to-batch variability in potency and clearance. A method that fixes DAR by construction, rather than by downstream reaction control, claims to sidestep that heterogeneity at the design stage.

## Detail

[[Antibody-Drug Conjugates Having a Tailor-Made Drug-to-Antibody Ratio (patent)]] (BioNTech SE, WO2025093562A1, priority 2023-10-30, pending) claims an engineered IgG hinge region containing a predetermined number of cysteine residues, using heterologous hinge-Fc pairings (mismatched immunoglobulin isotypes) to place conjugation sites independently of the antibody's natural structure. Because the claim ties DAR directly to cysteine count in the engineered hinge (DAR equals roughly twice the cysteine count per hinge region, spanning DAR ~2 to ~22 across the claimed range), the conjugate's payload loading becomes a property chosen at the antibody-engineering stage rather than tuned during conjugation. The claim also specifies that all hinge cysteines form stable inter-chain disulfide bonds before conjugation, and that the approach avoids inserting cysteines into conserved regions - an explicit design choice to limit immunogenicity risk from the engineering itself.

## In practice

- This is an antibody-engineering claim, not a linker or payload claim - it composes with either [[Multidrug Branched Linker]] or a conventional single-payload linker, since it only fixes where and how many conjugation sites exist, not what gets attached to them.
- DAR 4-8 is called out as the homogeneous-product target range in the claim, even though the underlying method is claimed across a much wider DAR 2-22 span - worth checking which figure a secondary summary is citing before comparing it to another company's DAR claims.
