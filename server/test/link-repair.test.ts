/**
 * Wikilinks broken by a line wrap (docs/agents/SPEC.md section 12.4, link-repair.ts). An agent
 * formatting prose to a width takes the brackets with it, and the link stops resolving. The
 * repair is mechanical, so it lives in code rather than in a run that costs money and, as one
 * lint-fix run showed, can write the very defect it is fixing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { findWrappedLinks, rejoinWrappedLinks, repairWrappedLinks } from '../src/pipeline/link-repair.js'
import { createValidator } from '../src/pipeline/validator.js'
import { Mutex } from '../src/util/mutex.js'

describe('finding a link broken across a line', () => {
  it('takes the brackets that span a newline and nothing else', () => {
    const md = 'See [[Ocean Carbon\nSink]] and [[Carbon Cycle]] on one line.\n'
    expect(findWrappedLinks(md).map((w) => w.target)).toEqual(['Ocean Carbon Sink'])
  })

  it('drops the block prefix a continuation line carries', () => {
    // Half of one vault's broken links sat inside callouts, where the next line starts "> ".
    const md = '> [!gap] Thin sourcing\n> inferred from [[False Positive\n> Rate]], its one neighbour.\n'
    expect(findWrappedLinks(md).map((w) => w.target)).toEqual(['False Positive Rate'])
    expect(findWrappedLinks('- [[Age-Depth\n  - Model]]').map((w) => w.target)).toEqual(['Age-Depth Model'])
  })

  it('leaves whole links, unclosed brackets and empty targets alone', () => {
    expect(findWrappedLinks('[[A Very Long Title That Runs Past The Margin]]')).toEqual([])
    expect(findWrappedLinks('an unclosed [[bracket\nacross lines')).toEqual([])
    expect(findWrappedLinks('[[\n]]')).toEqual([])
  })
})

describe('joining them back', () => {
  const exists = (t: string): boolean => ['Ocean Carbon Sink', 'Carbon Cycle'].includes(t)

  it('joins the ones that name a real page and reports them', () => {
    const md = 'A [[Ocean Carbon\nSink]] entry.\n'
    const out = rejoinWrappedLinks(md, exists)
    expect(out.text).toBe('A [[Ocean Carbon Sink]] entry.\n')
    expect(out.fixed).toEqual(['Ocean Carbon Sink'])
    expect(out.left).toEqual([])
  })

  it('leaves a broken link that would still not resolve, so a real gap stays a finding', () => {
    const md = 'A [[Page That Never\nExisted]] entry.\n'
    const out = rejoinWrappedLinks(md, exists)
    expect(out.text).toBe(md)
    expect(out.left).toEqual(['Page That Never Existed'])
    expect(out.fixed).toEqual([])
  })
})

describe('repairing a vault', () => {
  let vaultRoot: string
  const git = (...args: string[]): string => execFileSync('git', ['-C', vaultRoot, ...args], { encoding: 'utf8' })

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'concepts'), { recursive: true })
    const page = (name: string, body: string): void => fs.writeFileSync(path.join(vaultRoot, 'wiki/concepts', `${name}.md`), body)
    page('Carbon Cycle', '---\ntype: concept\ntitle: "Carbon Cycle"\n---\n# Carbon Cycle\n\nWhole.\n')
    page('Proxy Calibration', '---\ntype: concept\ntitle: "Proxy Calibration"\n---\n# Proxy Calibration\n\nIt sits under [[Carbon\nCycle]] and beside [[Nothing At\nAll]].\n')
    git('init', '-q')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed')
  })
  afterEach(() => fs.rmSync(vaultRoot, { recursive: true, force: true }))

  const read = (rel: string): string => fs.readFileSync(path.join(vaultRoot, rel), 'utf8')

  it('a dry run changes nothing and still counts', async () => {
    const out = await repairWrappedLinks(vaultRoot, { dryRun: true })
    expect(out).toMatchObject({ fixed: 1, left: 1, commit: null })
    expect(out.pages).toEqual(['wiki/concepts/Proxy Calibration.md'])
    expect(read('wiki/concepts/Proxy Calibration.md')).toContain('[[Carbon\nCycle]]')
  })

  it('writes the join as one commit and leaves the genuine gap alone', async () => {
    const out = await repairWrappedLinks(vaultRoot, { commitMutex: new Mutex(), autoCommit: () => false })
    expect(out.fixed).toBe(1)
    const text = read('wiki/concepts/Proxy Calibration.md')
    expect(text).toContain('[[Carbon Cycle]]')
    expect(text).toContain('[[Nothing At\nAll]]')
  })

  /*
   * A lint report is skipped by the DEAD-link check, because it quotes targets that do not
   * exist as its own findings. A wrapped link there is a different thing: the target exists,
   * the page meant to link it, and the repairer already fixes it. On 2026-09-21 it fixed three
   * inside a report that the fix run had just written, and nothing had reported them.
   */
  it('reports a wrapped link on a page whose dead links are deliberately not checked', () => {
    fs.mkdirSync(path.join(vaultRoot, 'wiki/meta'), { recursive: true })
    fs.writeFileSync(
      path.join(vaultRoot, 'wiki/meta/lint-report-2026-09-21.md'),
      '---\ntype: meta\ntitle: "Lint Report 2026-09-21"\n---\n# Lint Report: 2026-09-21\n\n' +
        'Rewrote the mention on [[Carbon\nCycle]]. Still missing: [[A Page That Does Not Exist]].\n',
    )
    const f = createValidator(vaultRoot)(['wiki/meta/lint-report-2026-09-21.md'])
    expect(f.filter((x) => x.rule === 'wrapped-link')).toHaveLength(1)
    // The quoted missing target stays unreported: that is what the skip is for.
    expect(f.filter((x) => x.rule === 'dead-link')).toHaveLength(0)
  })

  it('the validator names the repairable ones apart from the dead ones, and stops naming them after', async () => {
    const before = createValidator(vaultRoot)(['wiki/concepts/Proxy Calibration.md'])
    expect(before.filter((f) => f.rule === 'wrapped-link')).toHaveLength(1)
    expect(before.filter((f) => f.rule === 'dead-link')).toHaveLength(1)

    await repairWrappedLinks(vaultRoot, { commitMutex: new Mutex(), autoCommit: () => false })
    const after = createValidator(vaultRoot)(['wiki/concepts/Proxy Calibration.md'])
    expect(after.filter((f) => f.rule === 'wrapped-link')).toHaveLength(0)
    expect(after.filter((f) => f.rule === 'dead-link')).toHaveLength(1)
  })
})
