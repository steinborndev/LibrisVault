/**
 * The four places where this service parses text the VAULT writes, checked against the vault
 * as it stands (A6).
 *
 * Every one of them is a contract with no schema behind it: a skill writes prose in a shape,
 * and we read that shape back. Unit tests can only prove that our parser still parses the
 * string our fixture carries. They cannot notice that the vault was upgraded and now writes a
 * different string - which is the whole failure mode, and the same reason `permprobe` and
 * `preprocprobe` exist beside their unit tests.
 *
 * The four:
 *
 *   1. completion-marker  - `queue.ts` decides whether a crashed ingest finished by searching
 *                           `wiki/log.md` for the job's `.raw` directory. If the skill stops
 *                           naming the source path in its log entry, every interrupted job is
 *                           silently classified as unfinished and retried.
 *   2. lint-report        - `lint-report.ts` parses the wiki-lint skill's markdown into the
 *                           maintenance view. Renamed headings yield an empty report, which
 *                           looks exactly like a clean vault.
 *   3. autoresearch-flow  - `maintenance.ts` names two vault paths by hand in the research
 *                           prompt and relies on the skill's filing step keeping the hot cache
 *                           current. A moved file makes the run read nothing and say nothing.
 *   4. address-rules      - `validator.ts` mirrors the DragonScale address rules: the allocator
 *                           script, the counter, the rollout baseline and the `c-NNNNNN` shape.
 *                           A changed shape turns every page into an address finding.
 *
 * Nothing here writes, and nothing here needs an agent run: each check reads the vault's own
 * files and asks whether they still speak the language the corresponding parser expects.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseLintReport } from './lint-report.js'

export type ContractId = 'completion-marker' | 'lint-report' | 'autoresearch-flow' | 'address-rules'

export interface ContractCheck {
  readonly contract: ContractId
  readonly ok: boolean
  /** What held, or what drifted - one line, naming the file it was read from. */
  readonly detail: string
  /** Each assertion that ran, with its verdict, so a pass is inspectable and not just green. */
  readonly evidence: ReadonlyArray<{ ok: boolean; what: string }>
}

const read = (root: string, rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8')
  } catch {
    return null
  }
}

const exists = (root: string, rel: string): boolean => fs.existsSync(path.join(root, rel))

/**
 * `.raw/<job-id>` in a log entry is the marker `queue.ts` keys on, and the skill's own template
 * is what produces it. Both are asserted: the template because it is what a FUTURE run follows,
 * the live file because a template can be right while the runs never reached it.
 *
 * Phase 2.4 moves this marker to `.vault-meta/runs/<job-id>.done` and this check gains the new
 * shape beside the old one; the old one stays while the fallback in `queue.ts` does.
 */
function checkCompletionMarker(root: string): ContractCheck {
  const log = read(root, 'wiki/log.md')
  const skill = read(root, 'skills/wiki-ingest/SKILL.md')
  const entryNamesSource = log !== null && /^\s*-\s*Source:\s*`?\.raw\//m.test(log)
  const anyRawReference = log !== null && /\.raw\/[^\s`)]+/.test(log)
  const templateAppendsLog = skill !== null && /wiki\/log\.md/.test(skill)
  const templateNamesSource = skill !== null && /-\s*Source:\s*`\.raw\//.test(skill)

  const evidence = [
    { ok: log !== null, what: 'wiki/log.md is readable' },
    { ok: entryNamesSource, what: 'a log entry carries a `- Source: `.raw/...`` line' },
    { ok: anyRawReference, what: 'the file mentions a .raw path at all (the substring the queue searches)' },
    { ok: templateAppendsLog, what: 'the ingest skill still appends to wiki/log.md' },
    { ok: templateNamesSource, what: "the skill's log template still names the .raw source" },
  ]
  const ok = evidence.every((e) => e.ok)
  return {
    contract: 'completion-marker',
    ok,
    detail: ok
      ? 'crash recovery can still tell a finished ingest from an interrupted one'
      : 'the log entry no longer carries the .raw path that decides a crashed job’s status',
    evidence,
  }
}

/** Newest lint report first: an older one can predate a drift the newest would show. */
function newestLintReport(root: string): { rel: string; text: string } | null {
  let names: string[]
  try {
    names = fs.readdirSync(path.join(root, 'wiki', 'meta'))
  } catch {
    return null
  }
  const reports = names.filter((n) => /^lint-report-.*\.md$/.test(n)).sort()
  const newest = reports[reports.length - 1]
  if (newest === undefined) return null
  const text = read(root, path.posix.join('wiki/meta', newest))
  return text === null ? null : { rel: `wiki/meta/${newest}`, text }
}

/**
 * The report is parsed with the REAL parser, not a copy of its rules: the question is whether
 * `lint-report.ts` still produces a populated report from what the vault writes today.
 */
function checkLintReport(root: string): ContractCheck {
  const skill = read(root, 'skills/wiki-lint/SKILL.md')
  const templateHasSummary = skill !== null && /^##\s+Summary\s*$/m.test(skill)
  const templateHasSections =
    skill !== null && ['Orphan Pages', 'Dead Links', 'Frontmatter Gaps'].every((h) => new RegExp(`^##\\s+${h}\\s*$`, 'm').test(skill))

  const report = newestLintReport(root)
  const evidence: Array<{ ok: boolean; what: string }> = [
    { ok: skill !== null, what: 'skills/wiki-lint/SKILL.md is readable' },
    { ok: templateHasSummary, what: "the skill's report template still carries a `## Summary` block" },
    { ok: templateHasSections, what: 'the template still carries the per-check sections the parser groups on' },
  ]

  if (report === null) {
    // A vault that has never been linted is not a drifted vault. Say so rather than failing,
    // and let the template assertions above carry the check.
    evidence.push({ ok: true, what: 'no lint report in wiki/meta yet - template checked instead' })
  } else {
    const parsed = parseLintReport(report.text, (label) => ({ label, path: null }))
    evidence.push(
      { ok: parsed.date !== null, what: `${report.rel}: the report heading still carries its date` },
      { ok: Object.keys(parsed.summary).length > 0, what: `${report.rel}: the summary counts parse into numbers` },
      { ok: parsed.sections.length > 0, what: `${report.rel}: at least one per-check section parses` },
      { ok: parsed.totalFindings > 0, what: `${report.rel}: the sections carry findings rather than parsing empty` },
    )
  }
  const ok = evidence.every((e) => e.ok)
  return {
    contract: 'lint-report',
    ok,
    detail: ok ? 'a lint report still parses into populated sections' : 'the report shape drifted from what the parser reads',
    evidence,
  }
}

/**
 * The research prompt reads `skills/autoresearch/references/program.md` by hard path and tells
 * the run to use the autoresearch skill, whose filing step keeps `wiki/hot.md` current. All
 * three are vault files we name from our side, so all three are assertable from here.
 */
function checkAutoresearchFlow(root: string): ContractCheck {
  const skill = read(root, 'skills/autoresearch/SKILL.md')
  const evidence = [
    { ok: exists(root, 'skills/autoresearch/references/program.md'), what: 'skills/autoresearch/references/program.md exists (the prompt reads it by path)' },
    { ok: exists(root, 'commands/autoresearch.md'), what: 'commands/autoresearch.md exists' },
    { ok: skill !== null, what: 'skills/autoresearch/SKILL.md is readable' },
    { ok: skill !== null && /wiki\/hot\.md/.test(skill), what: "the skill's filing step still names wiki/hot.md" },
  ]
  const ok = evidence.every((e) => e.ok)
  return {
    contract: 'autoresearch-flow',
    ok,
    detail: ok ? 'the paths the research prompt names are all present' : 'the research prompt names a path the vault no longer has',
    evidence,
  }
}

/**
 * The address rules the validator mirrors, read from the vault rather than from our copy of
 * them: the allocator, the counter it maintains, the rollout baseline that decides which pages
 * must carry an address, and the `c-NNNNNN` shape `ADDRESS_RE` matches.
 */
function checkAddressRules(root: string): ContractCheck {
  const allocator = read(root, 'scripts/allocate-address.sh')
  const counter = read(root, '.vault-meta/address-counter.txt')
  const legacy = read(root, '.vault-meta/legacy-pages.txt')
  const rollout = legacy !== null && /^#\s*rollout:\s*\d{4}-\d{2}-\d{2}/m.test(legacy)
  let executable = false
  try {
    fs.accessSync(path.join(root, 'scripts/allocate-address.sh'), fs.constants.X_OK)
    executable = true
  } catch {
    /* not executable - reported below, not thrown */
  }

  const evidence = [
    { ok: allocator !== null, what: 'scripts/allocate-address.sh exists' },
    { ok: executable, what: 'the allocator is executable (an agent run calls it directly)' },
    { ok: allocator !== null && /c-%06d/.test(allocator), what: "the allocator still mints the c-NNNNNN shape the validator matches" },
    { ok: counter !== null && /^\d+\s*$/.test(counter), what: '.vault-meta/address-counter.txt holds a plain number' },
    { ok: legacy !== null, what: '.vault-meta/legacy-pages.txt is readable' },
    { ok: rollout, what: 'the legacy manifest carries a readable `# rollout: YYYY-MM-DD` line' },
  ]
  const ok = evidence.every((e) => e.ok)
  return {
    contract: 'address-rules',
    ok,
    detail: ok ? 'the address rules the validator mirrors still hold' : 'the address rules drifted from what the validator asserts',
    evidence,
  }
}

/** All four contracts, in the order they appear in CLAUDE.md's reasoning. Never throws. */
export function checkVaultContracts(vaultRoot: string): ContractCheck[] {
  return [checkCompletionMarker(vaultRoot), checkLintReport(vaultRoot), checkAutoresearchFlow(vaultRoot), checkAddressRules(vaultRoot)]
}
