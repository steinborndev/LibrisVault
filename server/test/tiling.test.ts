import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runTilingCheck, parseTilingReport, pairsTouching, hasTilingCheck } from '../src/pipeline/tiling.js'

/**
 * The vault's own duplicate detector (A5), which had never run once in 764 vault commits while
 * the vault filled with one-document-one-page islands.
 *
 * Everything here is about the SKIP paths, because that is what decides whether wiring this in
 * is safe: a machine without ollama, a vault below v1.7, a crash, a report in a shape we do not
 * recognise. A duplicate check that can fail an ingest is worse than no duplicate check.
 */
let vault: string

const REPORT = [
  '# Semantic Tiling Report',
  '',
  '- model: nomic-embed-text',
  '- calibrated: false (using uncalibrated defaults)',
  '- pages scanned: 1247; embedded: 1210; skipped: 37',
  '- cache hits: 0; recomputed: 1210; orphans pruned: 0',
  '',
  '## Errors (similarity >= 0.9)',
  '',
  '- `0.9421` wiki/concepts/Alpha.md -- wiki/concepts/Alpha Revisited.md',
  '',
  '## Review (0.8 <= similarity < 0.9)',
  '',
  '- `0.8312` wiki/entities/Someone.md -- wiki/entities/Someone Else.md',
  '- `0.8011` wiki/sources/A.md -- wiki/sources/B.md',
  '',
].join('\n')

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'tiling-'))
  fs.mkdirSync(path.join(vault, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(vault, 'scripts/tiling-check.py'), '#!/usr/bin/env python3\n', { mode: 0o755 })
})
afterEach(() => fs.rmSync(vault, { recursive: true, force: true }))

describe('parseTilingReport', () => {
  it('reads both bands and keeps the similarity', () => {
    const { pairs } = parseTilingReport(REPORT)
    expect(pairs).toHaveLength(3)
    expect(pairs[0]).toEqual({
      similarity: 0.9421,
      a: 'wiki/concepts/Alpha.md',
      b: 'wiki/concepts/Alpha Revisited.md',
      band: 'error',
    })
    expect(pairs[1]?.band).toBe('review')
  })

  it('keeps the counts for the job log', () => {
    expect(parseTilingReport(REPORT).summary).toContain('pages scanned: 1247')
  })

  it('reads a clean report as no pairs rather than as a failure', () => {
    const clean = REPORT.replace(/^- `.*$/gm, '- none')
    expect(parseTilingReport(clean).pairs).toEqual([])
  })

  it('yields nothing for a shape it does not recognise', () => {
    // The report is a text contract like the other four, so a drifted format has to degrade to
    // "no findings" rather than to an exception inside a job's validation step.
    expect(parseTilingReport('{"pairs": []}').pairs).toEqual([])
    expect(parseTilingReport('').pairs).toEqual([])
  })
})

describe('runTilingCheck', () => {
  it('skips a vault that has no such script, and says why', async () => {
    fs.rmSync(path.join(vault, 'scripts/tiling-check.py'))
    expect(hasTilingCheck(vault)).toBe(false)
    const res = await runTilingCheck(vault)
    expect(res.pairs).toEqual([])
    expect(res.skipped).toContain('no scripts/tiling-check.py')
  })

  it('skips without ollama and without the model, on the script\'s own exit codes', async () => {
    const noOllama = await runTilingCheck(vault, { run: async () => ({ stdout: '', code: 10 }) })
    expect(noOllama.skipped).toContain('no local ollama')
    const noModel = await runTilingCheck(vault, { run: async () => ({ stdout: '', code: 11 }) })
    expect(noModel.skipped).toContain('embedding model is not pulled')
  })

  it('skips on any other non-zero exit, naming it', async () => {
    const res = await runTilingCheck(vault, { run: async () => ({ stdout: '', code: 4 }) })
    expect(res.skipped).toContain('exited 4')
  })

  it('skips on a crash rather than throwing into the caller', async () => {
    const res = await runTilingCheck(vault, {
      run: async () => {
        throw new Error('python3: not found')
      },
    })
    expect(res.pairs).toEqual([])
    expect(res.skipped).toContain('python3: not found')
  })

  it('returns the pairs when it ran', async () => {
    const res = await runTilingCheck(vault, { run: async () => ({ stdout: REPORT, code: 0 }) })
    expect(res.skipped).toBeUndefined()
    expect(res.pairs).toHaveLength(3)
  })
})

describe('pairsTouching', () => {
  const { pairs } = parseTilingReport(REPORT)

  it('keeps only the pairs naming a page this run touched', () => {
    // An ingest should hear about the duplicates IT created, not about every pair in a vault
    // of 1200 pages - that is a standing list, and it belongs on the System screen.
    expect(pairsTouching(pairs, ['wiki/concepts/Alpha Revisited.md'])).toHaveLength(1)
    expect(pairsTouching(pairs, ['wiki/concepts/Nothing.md'])).toEqual([])
  })

  it('reports everything when no scope is given, which is what a sweep wants', () => {
    expect(pairsTouching(pairs, [])).toHaveLength(3)
  })
})

describe('which band reaches a job', () => {
  it('separates the two, because only one of them is a per-run finding', () => {
    // Measured against the live vault with the thresholds it ships: 215 pairs at or above
    // 0.90 and 3218 between 0.80 and 0.90. The shipped bands say of themselves that they are
    // uncalibrated; a review band that size is a standing list, not a finding on one job.
    const { pairs } = parseTilingReport(REPORT)
    expect(pairs.filter((p) => p.band === 'error')).toHaveLength(1)
    expect(pairs.filter((p) => p.band === 'review')).toHaveLength(2)
  })
})
