---
type: concept
title: "Dual-Payload Antibody-Drug Conjugate"
domain: oncology
created: 2026-09-15
updated: 2026-09-15
tags:
  - concept
  - oncology
  - adc
  - payload
status: developing
related:
  - "[[Bispecific Antibody-Drug Conjugate]]"
  - "[[Multidrug Branched Linker]]"
sources:
  - "[[Dual-Payload Antibody Drug Conjugates (patent)]]"
  - "[[Multidrug Linker and Antibody-Drug Conjugate (patent)]]"
  - "[[Dual-Payload Bispecific ADC with Trifunctional Linker (research article)]]"
  - "[[Cancer Antibody Conjugates Patent Landscape 2025 (industry report)]]"
---
# Dual-Payload Antibody-Drug Conjugate

An antibody-drug conjugate (ADC) carrying two chemically distinct cytotoxic payloads on a single antibody, rather than one payload species conjugated many times over. Distinct from a [[Bispecific Antibody-Drug Conjugate]], which targets two antigens - a dual-payload construct can sit on a monospecific or a bispecific antibody, and a bispecific antibody can carry only one payload species (the first-approved bispecific ADC, izalontamab brengitecan, does exactly that). The two axes - how many targets, how many payloads - are independent design choices, and patent claims treat them separately.

## Why it matters

Single-payload ADCs lose efficacy when a tumor subpopulation is resistant to that payload's mechanism, or when the antibody target is heterogeneously expressed across the tumor. A dual-payload construct delivers two independent kill mechanisms through one internalisation event, so a cell resistant to one payload can still be killed by the other. The patent filings gathered here treat this as the load-bearing rationale, not just an efficacy add-on: [[Dual-Payload Antibody Drug Conjugates (patent)]] (Sutro Biopharma, WO2025080711A1) frames its topoisomerase-I-inhibitor-plus-DDR-inhibitor combination explicitly around synthetic lethality - the DNA-damage-response inhibitor disables the repair pathway that would otherwise let the cell survive topoisomerase poisoning.

## Detail

Two engineering strategies show up in the 2025 filings for getting two payloads onto one antibody:

**Two independent linkers, one on each of two conjugation handles.** [[Dual-Payload Antibody Drug Conjugates (patent)]] attaches a topoisomerase I inhibitor (camptothecin-derivative class: irinotecan, SN-38, topotecan, exatecan) via one linker and a DNA-damage-response inhibitor (PARP, CHK1/CHK2, or ATR inhibitor class) via a second, independently cleavable linker. The academic proof-of-concept behind [[Dual-Payload Bispecific ADC with Trifunctional Linker (research article)]] (Tavotek-funded, published August 2025) takes the same two-linker idea further with a single trifunctional linker core (maleimide + propargyl + ketone handles) carrying MMAF via a non-cleavable oxime-ligated arm and SN-38 via a cleavable Val-Cit-PABC arm attached by copper-catalyzed azide-alkyne cycloaddition - one linker molecule, two independently releasable payloads with different release triggers.

**A branched linker with multiple drug-attachment arms off a single coupling group.** [[Multidrug Linker and Antibody-Drug Conjugate (patent)]] (Shanghai Huao, WO2025031307A1) claims a linker architecture (its Formulas I-III) with one antibody-coupling group and two or three drug-attachment spacers branching from it, distinct from the two-separate-linkers approach above. See [[Multidrug Branched Linker]] for the linker-chemistry side of this.

Beyond these two specific filings, the [[Cancer Antibody Conjugates Patent Landscape 2025 (industry report)]] and the PatSnap Eureka linker-chemistry landscape both name WuXi XDC's January 2025 WO filing and PinotBio's 2025 AU/EP filings (camptothecin-based, "super-toxin", and antiapoptotic-inhibitor payloads combined on one antibody) as further multi-payload filings, though this run could not pull the underlying claim text for either - see [[WuXi XDC]] for what its own platform material says about the strategy.

## In practice

- Check whether a "dual-payload" claim is actually dual-payload or dual-target with one payload before treating it as evidence of this trend - the terminology in press coverage is not consistent, and the two are patented separately.
- A dual-payload claim's real novelty usually sits in how the two payloads are kept from interfering with each other's release chemistry (independent linkers, orthogonal cleavage triggers) or from causing the conjugate to aggregate (see [[Multidrug Branched Linker]]) - not in the payload combination itself, which is often two already-known drug classes.
- As of this pass, no dual-payload ADC has reached approval; izalontamab brengitecan (approved) is dual-target, single-payload.
