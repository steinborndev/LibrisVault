---
type: concept
title: "Bispecific Antibody-Drug Conjugate"
domain: oncology
created: 2026-09-15
updated: 2026-09-15
tags:
  - concept
  - oncology
  - adc
  - bispecific
status: developing
related:
  - "[[Dual-Payload Antibody-Drug Conjugate]]"
sources:
  - "[[Binding Molecule and Antibody-Drug Conjugate (patent)]]"
  - "[[Dual-Payload Bispecific ADC with Trifunctional Linker (research article)]]"
---
# Bispecific Antibody-Drug Conjugate

An ADC built on an antibody that binds two distinct antigens (or two distinct epitopes on the same antigen), rather than the single-target antibody a conventional ADC uses. The bispecificity is a targeting-side design choice, independent of how many payload species the conjugate carries - see [[Dual-Payload Antibody-Drug Conjugate]] for that separate axis. A bispecific ADC can carry one payload (the approved case) or two (the emerging, patent-stage case); patent claims and press coverage often blur this distinction, so it is worth checking explicitly which axis a given filing addresses.

## Why it matters

Dual-antigen targeting addresses two problems single-target ADCs cannot: tumor heterogeneity (cells expressing only one of the two antigens are still bound and killed) and the requirement for cooperative binding to trigger internalisation, which can improve tumor-selectivity over healthy tissue expressing only one antigen at low levels. Izalontamab brengitecan (BL-B01D1, "iza-bren"), developed by [[SystImmune]] and partnered with Bristol Myers Squibb outside China, is the first bispecific ADC to reach approval worldwide (met its primary endpoint in a global Phase III trial reported 2025-07-03, for recurrent/metastatic nasopharyngeal carcinoma). It targets EGFR and HER3 with a tetravalent IgG1 backbone, conjugated via a cathepsin-B-cleavable linker to Ed-04, a camptothecin-derivative topoisomerase I inhibitor, at DAR 8 - one payload species, dual target.

## Detail

The 2025 patent filings gathered in this pass point to bispecificity being engineered at the antibody-fragment level as much as the classical dual-Fab IgG level. [[Binding Molecule and Antibody-Drug Conjugate (patent)]] (Velavigo Shanghai / Velavigo Bio, WO2025108427A1, priority 2023-11-23, pending) claims immunoglobulin single variable domains (ISVDs - nanobody-format binders) directed at EGFR and/or cMet, combined into a conjugate designed for better tumor-tissue penetration than a full-size bispecific IgG, with bi-epitope cMet binding claimed specifically to enhance receptor-mediated endocytosis (and hence payload internalisation) rather than for affinity alone. That is a smaller, more penetrant binding format claiming the same EGFR/cMet-axis rationale as larger bispecific IgGs.

The academic proof-of-concept in [[Dual-Payload Bispecific ADC with Trifunctional Linker (research article)]] combines both axes explicitly: an EGFR x cMET bispecific antibody carrying two payloads (MMAF and SN-38) via a trifunctional linker, reporting better tumor growth inhibition in vivo than either a single-payload bispecific or a dual-payload monospecific comparator - evidence (preclinical, not yet a granted composition-of-matter claim found in this pass) that the two axes combine additively rather than substituting for one another.

## In practice

- Before citing a filing as evidence of "bispecific ADC" progress, check whether it claims dual-target, dual-payload, or both - conflating them overstates how novel a given filing actually is.
- ISVD/nanobody-format bispecifics (Velavigo) and full IgG-format bispecifics (SystImmune/BL-B01D1) are pursuing the same biology through different binding-format claims; neither format has displaced the other as of this pass.
- BL-B01D1 is the reference point for "approved and dual-target" - useful as a baseline when judging how far a pending dual-payload-plus-bispecific filing still has to go.
