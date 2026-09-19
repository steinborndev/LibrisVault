import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkVaultContracts, type ContractId } from '../src/pipeline/vault-contracts.js'

/**
 * The four negative cases. A probe that only ever runs against a healthy vault proves nothing:
 * it has to be shown naming the RIGHT contract when one of them drifts, or a green line means
 * "the check ran" rather than "the contract holds".
 *
 * Each case copies the fixture vault, breaks exactly one contract the way a vault upgrade
 * plausibly would (a renamed heading, a moved file, a changed template), and asserts that this
 * contract fails and the other three do not.
 */
const FIXTURE = path.resolve(fileURLToPath(new URL('./fixtures/contract-vault', import.meta.url)))

describe('checkVaultContracts', () => {
  let vault: string

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-'))
    fs.cpSync(FIXTURE, vault, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true })
  })

  const verdicts = (): Record<string, boolean> =>
    Object.fromEntries(checkVaultContracts(vault).map((c) => [c.contract, c.ok]))

  const onlyFailing = (id: ContractId): void => {
    const v = verdicts()
    expect(v[id]).toBe(false)
    for (const [contract, ok] of Object.entries(v)) {
      if (contract !== id) expect([contract, ok]).toEqual([contract, true])
    }
  }

  it('passes against a vault that still speaks all four', () => {
    expect(Object.values(verdicts()).every(Boolean)).toBe(true)
  })

  it('names completion-marker when the log entry stops carrying its source path', () => {
    // The plausible drift: the skill keeps logging, but drops the line naming the .raw dir.
    const log = path.join(vault, 'wiki/log.md')
    fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace(/^- Source:.*$/m, '- Origin: an uploaded file'))
    fs.writeFileSync(
      path.join(vault, 'skills/wiki-ingest/SKILL.md'),
      fs.readFileSync(path.join(vault, 'skills/wiki-ingest/SKILL.md'), 'utf8').replace(/- Source: `\.raw[^\n]*/, '- Origin: where it came from'),
    )
    onlyFailing('completion-marker')
  })

  it('names lint-report when the report headings are renamed', () => {
    const report = path.join(vault, 'wiki/meta/lint-report-2026-01-02.md')
    fs.writeFileSync(report, fs.readFileSync(report, 'utf8').replace('## Summary', '## Overview').replace('## Orphan Pages', '### Orphan Pages'))
    fs.writeFileSync(
      path.join(vault, 'skills/wiki-lint/SKILL.md'),
      fs.readFileSync(path.join(vault, 'skills/wiki-lint/SKILL.md'), 'utf8').replace('## Summary', '## Overview'),
    )
    onlyFailing('lint-report')
  })

  it('names autoresearch-flow when the path the prompt hardcodes moves', () => {
    fs.rmSync(path.join(vault, 'skills/autoresearch/references/program.md'))
    onlyFailing('autoresearch-flow')
  })

  it('names address-rules when the allocator stops minting the shape the validator matches', () => {
    const allocator = path.join(vault, 'scripts/allocate-address.sh')
    fs.writeFileSync(allocator, fs.readFileSync(allocator, 'utf8').replace("printf 'c-%06d\\n'", "printf 'addr-%d\\n'"))
    onlyFailing('address-rules')
  })

  it('says which assertion failed, not just that something did', () => {
    fs.rmSync(path.join(vault, 'commands/autoresearch.md'))
    const check = checkVaultContracts(vault).find((c) => c.contract === 'autoresearch-flow')
    expect(check?.evidence.filter((e) => !e.ok).map((e) => e.what)).toEqual(['commands/autoresearch.md exists'])
  })

  it('treats a vault that has never been linted as undrifted rather than broken', () => {
    fs.rmSync(path.join(vault, 'wiki/meta/lint-report-2026-01-02.md'))
    const check = checkVaultContracts(vault).find((c) => c.contract === 'lint-report')
    expect(check?.ok).toBe(true)
    expect(check?.evidence.some((e) => e.what.includes('no lint report'))).toBe(true)
  })

  it('reports rather than throws when the vault is not there at all', () => {
    const checks = checkVaultContracts(path.join(os.tmpdir(), 'no-such-vault-probe'))
    expect(checks).toHaveLength(4)
    expect(checks.every((c) => !c.ok)).toBe(true)
  })
})
