---
type: meta
title: "log"
domain: meta
created: 2026-09-15
updated: 2026-09-15
tags:
  - meta
  - log
status: evergreen
---
# Log

Append-only record of research/ingest runs, most recent first. Did not exist before this run; created here because the run's instructions called for it and no equivalent file was found (the vault's other activity record, `wiki/meta/recaps/`, tracks a separate nightly multi-agent scheduler and was left alone rather than repurposed - see the entry below).

## 2026-09-15 - Research: ADC patent and IP filings since 2025 for new payload, linker and bispecific-dual-payload platforms

Ran the patents lens (Google Patents preferred; two patent-analytics vendor reports for aggregate landscape figures) against "ADC Patent and IP Filings Since 2025 for New Payload, Linker and Bispecific-Dual-Payload Platforms." This is the vault's first oncology-domain content. Created 16 pages: [[Dual-Payload Antibody-Drug Conjugate]], [[Bispecific Antibody-Drug Conjugate]], [[Multidrug Branched Linker]], [[Site-Specific DAR Engineering]], [[STING Agonist Payload (ADC)]] (concepts); [[Dual-Payload Antibody Drug Conjugates (patent)]], [[Multidrug Linker and Antibody-Drug Conjugate (patent)]], [[Antibody-Drug Conjugates Having a Tailor-Made Drug-to-Antibody Ratio (patent)]], [[Binding Molecule and Antibody-Drug Conjugate (patent)]], [[Cancer Antibody Conjugates Patent Landscape 2025 (industry report)]], [[ADC Linker Chemistry Technology Landscape 2026 (industry report)]], [[Dual-Payload Bispecific ADC with Trifunctional Linker (research article)]], [[Quaternary Ammonium Salt-Linked STING Agonist ADC (research article)]] (sources); [[WuXi XDC]], [[SystImmune]] (entities); and the synthesis page [[Research - ADC Patent and IP Filings Since 2025 for New Payload, Linker and Bispecific-Dual-Payload Platforms - Patent Landscape]]. Added `oncology` to the domain list in [[index]].

**Automated decisions** (no human was available to ask mid-run):
- The task named an "autoresearch" skill and a `skills/autoresearch/references/program.md` file to load research constraints from, the same as the prior run's setup. Neither exists inside this vault's sandbox (only `skills/ingest/` is present here); confirmed again that reads outside the sandbox boundary are refused. Proceeded with a direct WebSearch/WebFetch research loop instead, following the page-hygiene, domain-registry, entity-notability, untrusted-content, language and reading-list rules given inline in the task prompt.
- The task listed four "existing pages related to this topic" - [[Annotation Platform]] (a machine-learning entity) and three astronomy pages about adaptive optics patents. None has any real connection to ADC/oncology patent filings; left all four untouched. By the same token, the listed "overlapping" synthesis page ([[Research - Recent patents on adaptive optics - Patent Landscape]]) is about an unrelated domain (astronomy, adaptive-optics patents), so this run filed a new synthesis page under the exact required title rather than folding into it.
- Entity pages were created only for [[WuXi XDC]] and [[SystImmune]], the two organisations that met the notability bar (subject of a source, or referenced by multiple independent sources in this pass). Sutro Biopharma, Shanghai Huao, BioNTech, Velavigo, PinotBio, CSPC Megalith, and Otsuka are each named only inline on the relevant concept/source pages - each is an incidental single-filing assignee in this pass, not a subject.
- Four of the eight source pages (the two vendor landscape reports) name additional 2025 filings - WuXi XDC's January WO filing, PinotBio's AU/EP filings, CSPC Megalith's AU filings, Otsuka's IN/EP filings - whose WO/publication numbers were not given by the vendor summaries and could not be located independently in this pass. These are flagged as vendor-report-only (not independently verified) in both the relevant source-page caveats and the synthesis page's open questions, rather than presented as directly-confirmed claim text.
- No publication met the reading-list's bar (a paper, standard, or dataset note reachable by title/DOI but not fully read) distinctly from what's already logged above - the two peer-reviewed articles used ([[Dual-Payload Bispecific ADC with Trifunctional Linker (research article)]], [[Quaternary Ammonium Salt-Linked STING Agonist ADC (research article)]]) were both read in full via WebFetch, so neither needed a reading-list entry.

## 2026-09-15 - Research: wavefront sensing and predictive control in adaptive optics

Ran the patents lens (Google Patents, USPTO, EPO Espacenet, plus a patent-analytics vendor report for aggregate figures) against "Wavefront sensing and predictive control in adaptive optics." Created 5 pages: [[Wavefront Sensing]], [[Predictive Control (Adaptive Optics)]] (concepts); [[Wavefront Sensor with Inner Detector and Outer Detector (patent)]], [[Adaptive Optics Dynamic Modeling and Control (patent)]], [[Adaptive Optics Patent Landscape (industry report)]] (sources). Extended [[Adaptive Optics]] and [[Adaptive Optics Testbed]] rather than duplicating them. Folded findings into the existing [[Research - Recent patents on adaptive optics - Patent Landscape]] page instead of filing a second synthesis page, per instruction; two of its three prior findings were rewritten because they could not be corroborated on direct inspection of filings, and its related/sources links (which had pointed at unrelated transit-photometry pages) were corrected.

**Automated decisions** (no human was available to ask mid-run):
- The task named an "autoresearch" skill and a `skills/autoresearch/references/program.md` file to load research constraints from. Neither exists inside this vault's sandbox (only `skills/ingest/` is present here; an `autoresearch` skill exists in a sibling vault outside the sandbox boundary and could not be read). Proceeded with a direct WebSearch/WebFetch research loop instead, following the page-hygiene, domain-registry, entity-notability, untrusted-content and reading-list rules given inline in the task prompt.
- The task listed [[Crystallisation Control]] and [[Multiversion Concurrency Control]] (cooking and computing domain pages) as "existing pages related to this topic." Neither has any real connection to wavefront sensing, predictive control, or adaptive-optics patents; left both untouched rather than forcing a link.
- No entity pages were created for the patents' assignees (Southwest Jiaotong University, SA Photonics / CACI Photonics). Neither is the subject of a source in the entity-notability sense - both are incidental assignees on a single patent record each - so they're named inline on the relevant source pages instead.
- This file (`wiki/log.md`) did not exist; created it fresh rather than writing into `wiki/meta/recaps/`, which is a differently-shaped log for a nightly multi-agent scheduler (named Fellows, standing watches, a cost ledger) that this run is not part of.
