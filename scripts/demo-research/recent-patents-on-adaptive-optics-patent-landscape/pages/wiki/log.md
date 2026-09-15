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

## 2026-09-15 - Research: wavefront sensing and predictive control in adaptive optics

Ran the patents lens (Google Patents, USPTO, EPO Espacenet, plus a patent-analytics vendor report for aggregate figures) against "Wavefront sensing and predictive control in adaptive optics." Created 5 pages: [[Wavefront Sensing]], [[Predictive Control (Adaptive Optics)]] (concepts); [[Wavefront Sensor with Inner Detector and Outer Detector (patent)]], [[Adaptive Optics Dynamic Modeling and Control (patent)]], [[Adaptive Optics Patent Landscape (industry report)]] (sources). Extended [[Adaptive Optics]] and [[Adaptive Optics Testbed]] rather than duplicating them. Folded findings into the existing [[Research: Recent patents on adaptive optics — Patent Landscape]] page instead of filing a second synthesis page, per instruction; two of its three prior findings were rewritten because they could not be corroborated on direct inspection of filings, and its related/sources links (which had pointed at unrelated transit-photometry pages) were corrected.

**Automated decisions** (no human was available to ask mid-run):
- The task named an "autoresearch" skill and a `skills/autoresearch/references/program.md` file to load research constraints from. Neither exists inside this vault's sandbox (only `skills/ingest/` is present here; an `autoresearch` skill exists in a sibling vault outside the sandbox boundary and could not be read). Proceeded with a direct WebSearch/WebFetch research loop instead, following the page-hygiene, domain-registry, entity-notability, untrusted-content and reading-list rules given inline in the task prompt.
- The task listed [[Crystallisation Control]] and [[Multiversion Concurrency Control]] (cooking and computing domain pages) as "existing pages related to this topic." Neither has any real connection to wavefront sensing, predictive control, or adaptive-optics patents; left both untouched rather than forcing a link.
- No entity pages were created for the patents' assignees (Southwest Jiaotong University, SA Photonics / CACI Photonics). Neither is the subject of a source in the entity-notability sense - both are incidental assignees on a single patent record each - so they're named inline on the relevant source pages instead.
- This file (`wiki/log.md`) did not exist; created it fresh rather than writing into `wiki/meta/recaps/`, which is a differently-shaped log for a nightly multi-agent scheduler (named Fellows, standing watches, a cost ledger) that this run is not part of.
