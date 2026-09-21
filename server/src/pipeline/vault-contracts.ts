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
 * Contract 1, in two halves while the transition lasts (2.4).
 *
 * THE MARKER (current). A run's last action is to touch `.vault-meta/runs/<job-id>.done`, and
 * crash recovery reads that one file. What the vault has to hold up its end of: the state
 * directory has to exist and be writable, and the marker directory has to be excluded from the
 * vault's git history - a marker that got committed would be vault content, and the next
 * `git clean` or a stale commit could answer the question wrongly.
 *
 * THE LOG ENTRY (legacy). Kept while `queue.ts` still falls back to it for jobs that were
 * already `ingesting` when this version started. Both are asserted; the legacy half goes when
 * the fallback does.
 */
function checkCompletionMarker(root: string): ContractCheck {
  const log = read(root, 'wiki/log.md')
  const skill = read(root, 'skills/wiki-ingest/SKILL.md')
  const stateDir = path.join(root, '.vault-meta')
  let stateWritable = false
  try {
    fs.accessSync(stateDir, fs.constants.W_OK)
    stateWritable = true
  } catch {
    /* reported below, not thrown - a read-only vault is a legitimate deployment */
  }
  const excludes = read(root, '.git/info/exclude') ?? ''

  const evidence = [
    { ok: fs.existsSync(stateDir), what: '.vault-meta/ exists (where a run leaves its completion marker)' },
    { ok: stateWritable, what: '.vault-meta/ is writable by this process' },
    {
      ok: !fs.existsSync(path.join(root, '.git')) || /^\.vault-meta\/runs\/?$/m.test(excludes),
      what: '.vault-meta/runs/ is excluded from the vault\'s git history',
    },
    { ok: log !== null, what: 'wiki/log.md is readable (the legacy completion check reads it)' },
    {
      ok: log !== null && /\.raw\/[^\s`)]+/.test(log),
      what: 'the log still mentions a .raw path (the substring the legacy fallback searches)',
    },
    { ok: skill !== null, what: 'skills/wiki-ingest/SKILL.md is readable' },
  ]
  const ok = evidence.every((e) => e.ok)
  return {
    contract: 'completion-marker',
    ok,
    detail: ok
      ? 'crash recovery can still tell a finished ingest from an interrupted one'
      : 'the marker a finished run leaves behind cannot be written or cannot be read back',
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
    /*
     * Counted from the FILE, with a deliberately dumber pattern than the parser's, because a
     * probe that reuses the parser's own rules only ever asks whether it agrees with itself.
     *
     * "> 0" was what this asked until 2026-09-20, and it passed a report whose totals the
     * parser was reading two of eleven from: the vault's view showed 4 dead links where the
     * report said 101, 3 frontmatter gaps where it said 29, and no dash violations where it
     * said 155. Nothing was renamed - the skill had simply started qualifying its numbers
     * ("101 (78 distinct targets)") and writing prose where it used to write one bullet per
     * defect. A report that parses to a tenth of itself looks exactly like a healthy vault,
     * which is the failure this contract exists to catch.
     */
    const summaryBlock = /^##\s+Summary\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(report.text)
    const statedTotals = (summaryBlock?.[1]?.match(/^[ \t]*[-*][ \t]+[^\n:]+:[ \t]*\d/gm) ?? []).length
    const parsedTotals = Object.keys(parsed.summary).length
    /* A section that opens by stating its own count, e.g. "101 unresolved wikilink targets". */
    const statedSections = [...report.text.matchAll(/^##\s+(.+?)\s*$\n+\s*(\d+)\s+\S/gm)].map((m) => ({
      title: m[1]!.trim(),
      stated: Number(m[2]),
    }))
    const misread = statedSections.filter((sec) => {
      const got = parsed.sections.find((s) => s.title === sec.title)
      return got !== undefined && got.count !== sec.stated
    })
    evidence.push(
      { ok: parsed.date !== null, what: `${report.rel}: the report heading still carries its date` },
      { ok: parsed.sections.length > 0, what: `${report.rel}: at least one per-check section parses` },
      { ok: parsed.totalFindings > 0, what: `${report.rel}: the sections carry findings rather than parsing empty` },
      {
        ok: statedTotals === 0 || parsedTotals >= statedTotals,
        what: `${report.rel}: every summary total the report states is read back (${parsedTotals} of ${statedTotals})`,
      },
      {
        ok: misread.length === 0,
        what:
          misread.length === 0
            ? `${report.rel}: each section's count matches the number it states (${statedSections.length} checked)`
            : `${report.rel}: ${misread.length} section(s) read back a different count than they state - ${misread
                .map((m) => `${m.title} states ${m.stated}`)
                .join(', ')}`,
      },
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
