---
type: question
title: "Research: ADC Patent and IP Filings Since 2025 for New Payload, Linker and Bispecific-Dual-Payload Platforms — Patent Landscape"
domain: oncology
created: 2026-09-15
updated: 2026-09-15
tags:
  - question
  - research
  - oncology
  - patents
status: developing
related:
  - "[[Dual-Payload Antibody-Drug Conjugate]]"
  - "[[Bispecific Antibody-Drug Conjugate]]"
  - "[[Multidrug Branched Linker]]"
  - "[[Site-Specific DAR Engineering]]"
  - "[[STING Agonist Payload (ADC)]]"
sources:
  - "[[Dual-Payload Antibody Drug Conjugates (patent)]]"
  - "[[Multidrug Linker and Antibody-Drug Conjugate (patent)]]"
  - "[[Antibody-Drug Conjugates Having a Tailor-Made Drug-to-Antibody Ratio (patent)]]"
  - "[[Binding Molecule and Antibody-Drug Conjugate (patent)]]"
  - "[[Cancer Antibody Conjugates Patent Landscape 2025 (industry report)]]"
  - "[[ADC Linker Chemistry Technology Landscape 2026 (industry report)]]"
  - "[[Dual-Payload Bispecific ADC with Trifunctional Linker (research article)]]"
  - "[[Quaternary Ammonium Salt-Linked STING Agonist ADC (research article)]]"
---

# Research: ADC Patent and IP Filings Since 2025 for New Payload, Linker and Bispecific-Dual-Payload Platforms — Patent Landscape

## Question

What has been filed since 2025 on new ADC payload classes, new linker chemistries, and bispecific/dual-payload platforms - and by whom, with what claim scope, pending or granted?

## Method

Searched through the patents lens (Google Patents, USPTO, EPO Espacenet preferred; reached primarily via Google Patents records and two patent-analytics vendor reports for aggregate landscape figures). Pulled and read four individual 2025 WO filings directly from Google Patents (assignee, priority/filing/publication dates, claim summary), and two 2025 peer-reviewed preclinical papers as feasibility evidence alongside the patent record. Two vendor landscape reports (Knowmade/GlobeNewswire; PatSnap Eureka) supplied aggregate filing-count context and named several additional 2025 filings (WuXi XDC, PinotBio, CSPC Megalith, Otsuka) whose underlying claim text could not be independently pulled in this pass - those are flagged as vendor-report-only below, not verified firsthand.

## Findings

### 1. "New platform" filings split cleanly along three independent axes, and 2025's filings mostly improve one axis at a time

The task framing - new payloads, new linkers, bispecific-dual-payload platforms - turns out to describe three genuinely separate patent-claim axes, not one converging trend: **how many antigens the antibody targets** ([[Bispecific Antibody-Drug Conjugate]]), **how many payload species are conjugated** ([[Dual-Payload Antibody-Drug Conjugate]]), and **what chemistry gets them onto the antibody** ([[Multidrug Branched Linker]], [[Site-Specific DAR Engineering]]). Every 2025 filing read directly in this pass claims an advance on exactly one of these axes: [[Dual-Payload Antibody Drug Conjugates (patent)]] (Sutro Biopharma, WO2025080711A1) and [[Multidrug Linker and Antibody-Drug Conjugate (patent)]] (Shanghai Huao, WO2025031307A1) both claim dual-payload delivery but via different linker architectures; [[Antibody-Drug Conjugates Having a Tailor-Made Drug-to-Antibody Ratio (patent)]] (BioNTech, WO2025093562A1) claims DAR control through antibody-hinge engineering, orthogonal to payload count; [[Binding Molecule and Antibody-Drug Conjugate (patent)]] (Velavigo, WO2025108427A1) claims a bispecific *binding format* (ISVD/nanobody) without a multi-payload claim attached. The only construct found that combines two axes at once - dual-target and dual-payload together - is [[Dual-Payload Bispecific ADC with Trifunctional Linker (research article)]], and that is a preclinical paper, not a patent claim this pass could verify. Press and vendor-report language ("next-generation ADC," "beyond single payload") tends to blur these axes together; the patent claims themselves do not.

### 2. Where the actual 2025 novelty concentrates: hydrophilic/branched linker chemistry for aggregation control, not the payload molecules themselves

Across every multi-payload filing read in this pass, the payload molecules are already-known drug classes (camptothecin-derivative topoisomerase I inhibitors, PARP/CHK/ATR inhibitors, MMAE/MMAF-class tubulin inhibitors) - the claimed novelty sits in how multiple payloads are attached without the conjugate aggregating or losing solubility. [[Multidrug Linker and Antibody-Drug Conjugate (patent)]]'s independent claim requires hydrophilic substitution (polysarcosine, PEG, or cyclodextrin) on at least one branch position specifically to solve an aggregation problem the filing names explicitly. [[ADC Linker Chemistry Technology Landscape 2026 (industry report)]] corroborates this as a broader 2025 pattern beyond this one filing: it names CSPC Megalith's 2025 AU filings and Otsuka's 2025 IN/EP filings as both leading with hydrophilic-linker claims (COOH/SO3H/PO3H2-bearing linkers, in Otsuka's case), and reads this as hydrophilicity moving from a differentiating claim to a baseline expectation industry-wide - though this pass could not pull the WuXi XDC, PinotBio, CSPC Megalith, or Otsuka filing numbers to verify their claim text directly; those four are vendor-report-only in this synthesis.

### 3. Dual-payload and dual-target claims are advancing on separate legal tracks, with no filing found in this pass that claims both at once

[[Bispecific Antibody-Drug Conjugate]] is not, on the patent evidence gathered, converging with [[Dual-Payload Antibody-Drug Conjugate]] into one combined claim type. The one approved bispecific ADC, izalontamab brengitecan (BL-B01D1, [[SystImmune]]), is dual-target and single-payload. The one 2025 bispecific-binding-format filing read directly, [[Binding Molecule and Antibody-Drug Conjugate (patent)]] (Velavigo), claims an ISVD-based EGFR/cMet binder with no multi-payload claim attached. The only evidence of the two axes combined - [[Dual-Payload Bispecific ADC with Trifunctional Linker (research article)]], an EGFR x cMET bispecific carrying both MMAF and SN-38 via a trifunctional linker - is a peer-reviewed preclinical paper (Tavotek-funded), not a verified patent claim; no patent filing covering that specific combined construct was found or confirmed in this pass. Read narrowly: the "bispecific-dual-payload platform" named in this research task's own title is, as of this pass, a demonstrated biological result without a confirmed corresponding IP filing - an open question, not a settled finding.

### 4. A new payload class outside cytotoxins is advancing on its own linker-stability problem, independent of the other three axes

[[STING Agonist Payload (ADC)]] represents a genuinely new payload *mechanism* (innate-immune activation rather than direct cytotoxicity) rather than a new molecule within an existing mechanism class. [[Quaternary Ammonium Salt-Linked STING Agonist ADC (research article)]] (2025) is explicit that the field's actual engineering bottleneck is linker stability, not the STING-agonism mechanism itself: the precedent construct (XMT-2056, ester-linked) showed strong preclinical activity but an unstable linker that contributed to fatal Phase I adverse events, and the 2025 advance targets that specific failure mode with a different linkage chemistry. This sits entirely outside the payload/linker/bispecific-dual-payload nexus the other three findings describe - no filing or paper found in this pass combines a STING-agonist payload with either dual-payload or bispecific-targeting claims.

## What this changes about the vault

This is the vault's first oncology-domain content. It establishes the domain's initial concept set along the three axes the task named - [[Dual-Payload Antibody-Drug Conjugate]], [[Bispecific Antibody-Drug Conjugate]], [[Multidrug Branched Linker]], [[Site-Specific DAR Engineering]], [[STING Agonist Payload (ADC)]] - explicitly separated from one another because the patent evidence itself treats them as separate claim types, not stages of one converging platform.

## Open questions

- Does any 2025-filed patent (as opposed to the one preclinical paper found) actually claim a combined bispecific-plus-dual-payload construct? This pass could not confirm one exists.
- What are the actual WO/publication numbers behind the WuXi XDC, PinotBio, CSPC Megalith, and Otsuka filings named only in the two vendor landscape reports? Without them, findings 2 and the multi-payload-filer count in [[Dual-Payload Antibody-Drug Conjugate]] rest on secondary paraphrase, not verified claim text.
- Is there a composition-of-matter patent for BL-B01D1 (izalontamab brengitecan) itself, and what does it claim? Not found in this pass - see [[SystImmune]].
- None of the four directly-read WO filings has yet been granted; all are pending as of the dates checked in this pass (mid-September 2026). Worth a follow-up pass to check grant status once more time has passed.

## Pages this rests on

- [[Dual-Payload Antibody-Drug Conjugate]]
- [[Bispecific Antibody-Drug Conjugate]]
- [[Multidrug Branched Linker]]
- [[Site-Specific DAR Engineering]]
- [[STING Agonist Payload (ADC)]]
- [[WuXi XDC]]
- [[SystImmune]]
