---
type: concept
title: "STING Agonist Payload (ADC)"
domain: oncology
created: 2026-09-15
updated: 2026-09-15
tags:
  - concept
  - oncology
  - adc
  - immunotherapy
status: developing
related:
  - "[[Dual-Payload Antibody-Drug Conjugate]]"
sources:
  - "[[Quaternary Ammonium Salt-Linked STING Agonist ADC (research article)]]"
---
# STING Agonist Payload (ADC)

An ADC payload class that activates the STING (Stimulator of Interferon Genes) innate-immune pathway inside the target cell, rather than killing it directly with a cytotoxin. The antibody delivers the STING agonist selectively into the tumor microenvironment; activation there triggers type-I interferon signalling and recruits killer T-cells, producing an anti-tumor immune response instead of - or alongside - direct cytotoxicity. Conjugates in this class are sometimes called immune-stimulating antibody conjugates (ISACs) rather than ADCs, to mark the mechanistic difference from a cytotoxin-payload conjugate.

## Why it matters

Conventional cytotoxic-payload ADCs are bounded by the therapeutic window between killing tumor cells and killing healthy cells that express low levels of the target antigen - the dose-limiting toxicity problem. A STING-agonist payload reframes the ADC as a targeted immune-activation tool: the antibody's job is to concentrate the agonist in the tumor rather than to deliver a lethal dose per se, which in principle widens the therapeutic window. In practice the class has already shown that this reframing does not remove the toxicity problem so much as relocate it: XMT-2056 (a non-cyclic-dinucleotide STING agonist, XMT-1616, conjugated to trastuzumab via a cleavable ester linker) showed strong preclinical antitumor activity, but its linker proved unstable enough in the clinic to contribute to severe adverse events and patient deaths in a Phase I trial - a linker-stability failure, not a payload-mechanism failure, but one that stalled the specific construct.

## Detail

[[Quaternary Ammonium Salt-Linked STING Agonist ADC (research article)]] (Long et al., *Advanced Science*, 2025) responds directly to that linker-stability problem: a quaternary-ammonium-salt-linked conjugation chemistry reported to give high potency, improved stability, enhanced aqueous solubility, and reduced off-target toxicity relative to the ester-linked precursor approach. The design logic is the same one seen elsewhere in this pass's linker filings ([[Multidrug Branched Linker]]) - hydrophilic, more stable linkage chemistry as the actual site of claimed novelty, with the payload class itself (STING agonism) already established as a viable mechanism.

Other STING-ADC constructs named in the same literature sweep: TAK-500 (the cyclic-dinucleotide STING agonist dazostinag conjugated to a CCR2-targeting antibody, from Takeda) and the original XMT-2056 program. None of these are patent filings this pass pulled claim text from directly; they are named here as the clinical/mechanistic context the quaternary-ammonium-salt filing is responding to.

## In practice

- Treat "STING agonist ADC" reports as belonging to the payload-class axis of this landscape, orthogonal to the dual-payload and bispecific axes covered by [[Dual-Payload Antibody-Drug Conjugate]] and [[Bispecific Antibody-Drug Conjugate]] - nothing found in this pass combines STING-agonist payloads with either of those.
- Linker stability is the recurring failure mode named for this payload class specifically (XMT-2056's clinical deaths were attributed to the linker, not the STING mechanism) - when evaluating a new STING-ADC filing, the linker claim matters at least as much as the payload claim.
