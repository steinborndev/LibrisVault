import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  oversizePayloads,
  keepPayloadLocal,
  rawPayloadCap,
  DEFAULT_RAW_PAYLOAD_CAP,
} from '../src/pipeline/raw-payload.js'

/**
 * The size cap for an ingested original (D4, N2, 6.2).
 *
 * `.raw/` is tracked on purpose - the commit captures the source beside the pages made from it
 * - and that stops being a good trade at a certain size: 786 MiB of payloads in this vault's
 * history against 232 MiB for every wiki page ever written. Over the cap the file stays on
 * disk, where the provenance link points and where the agent reads it, and out of git.
 */
let vault: string
const JOB = '.raw/01JOB'

const write = (rel: string, bytes: number): void => {
  const abs = path.join(vault, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, Buffer.alloc(bytes, 1))
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-'))
  execFileSync('git', ['-C', vault, 'init', '-q'])
  fs.mkdirSync(path.join(vault, JOB), { recursive: true })
  fs.writeFileSync(path.join(vault, JOB, 'manifest.json'), JSON.stringify({ jobId: '01JOB', notes: [] }, null, 2))
})

afterEach(() => fs.rmSync(vault, { recursive: true, force: true }))

describe('rawPayloadCap', () => {
  it('defaults to 25 MB and reads the environment', () => {
    expect(rawPayloadCap({})).toBe(DEFAULT_RAW_PAYLOAD_CAP)
    expect(rawPayloadCap({ RAW_PAYLOAD_MAX_BYTES: '1048576' })).toBe(1048576)
  })

  it('ignores a value that is not a positive number', () => {
    for (const bad of ['', 'lots', '-1', '0']) {
      expect(rawPayloadCap({ RAW_PAYLOAD_MAX_BYTES: bad }), bad).toBe(DEFAULT_RAW_PAYLOAD_CAP)
    }
  })
})

describe('oversizePayloads', () => {
  it('finds the payloads over the cap, largest first', () => {
    write(`${JOB}/small.pdf`, 500)
    write(`${JOB}/big.pdf`, 4000)
    write(`${JOB}/bigger.pdf`, 9000)
    expect(oversizePayloads(vault, JOB, 1000).map((o) => o.rel)).toEqual([`${JOB}/bigger.pdf`, `${JOB}/big.pdf`])
  })

  it('never counts the manifest or the normalised text, whatever their size', () => {
    // The normalised text is what the agent read and what the quote check verifies against.
    // Keeping it in the commit is the point of keeping `.raw` tracked at all.
    write(`${JOB}/normalized.md`, 9000)
    write(`${JOB}/normalized.txt`, 9000)
    fs.writeFileSync(path.join(vault, JOB, 'manifest.json'), Buffer.alloc(9000, 1))
    expect(oversizePayloads(vault, JOB, 1000)).toEqual([])
  })

  it('is empty for a job directory that is not there', () => {
    expect(oversizePayloads(vault, '.raw/nothing', 1000)).toEqual([])
  })
})

describe('keepPayloadLocal', () => {
  it('keeps the file on disk and out of git, and says so in the manifest', () => {
    write(`${JOB}/scan.pdf`, 4000)
    write(`${JOB}/normalized.md`, 100)
    const kept = keepPayloadLocal(vault, JOB, path.join(vault, JOB, 'manifest.json'), 1000)
    expect(kept.map((k) => k.rel)).toEqual([`${JOB}/scan.pdf`])

    // On disk, exactly where the provenance link points and where the agent reads it.
    expect(fs.existsSync(path.join(vault, JOB, 'scan.pdf'))).toBe(true)
    const status = execFileSync('git', ['-C', vault, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
    })
    expect(status).not.toContain('scan.pdf')
    expect(status).toContain('normalized.md')

    const manifest = JSON.parse(fs.readFileSync(path.join(vault, JOB, 'manifest.json'), 'utf8')) as {
      localOnly?: Array<{ path: string; bytes: number }>
      notes?: string[]
    }
    expect(manifest.localOnly).toEqual([{ path: `${JOB}/scan.pdf`, bytes: 4000 }])
    expect(manifest.notes?.[0]).toContain('payload not versioned')
  })

  it('does nothing at all under the cap', () => {
    write(`${JOB}/small.pdf`, 500)
    expect(keepPayloadLocal(vault, JOB, path.join(vault, JOB, 'manifest.json'), 1000)).toEqual([])
    const manifest = JSON.parse(fs.readFileSync(path.join(vault, JOB, 'manifest.json'), 'utf8')) as Record<string, unknown>
    expect(manifest['localOnly']).toBeUndefined()
    expect(
      execFileSync('git', ['-C', vault, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }),
    ).toContain('small.pdf')
  })

  it('leaves the payload committable when the vault has no git to exclude from', () => {
    // A vault without git keeps the behaviour it had: excluding is hygiene, never a gate.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-plain-'))
    fs.mkdirSync(path.join(plain, JOB), { recursive: true })
    fs.writeFileSync(path.join(plain, JOB, 'manifest.json'), '{}')
    fs.writeFileSync(path.join(plain, JOB, 'scan.pdf'), Buffer.alloc(4000, 1))
    expect(keepPayloadLocal(plain, JOB, path.join(plain, JOB, 'manifest.json'), 1000)).toEqual([])
    fs.rmSync(plain, { recursive: true, force: true })
  })

  it('survives a manifest it cannot parse: the exclude is what matters', () => {
    write(`${JOB}/scan.pdf`, 4000)
    fs.writeFileSync(path.join(vault, JOB, 'manifest.json'), 'not json at all')
    expect(keepPayloadLocal(vault, JOB, path.join(vault, JOB, 'manifest.json'), 1000)).toHaveLength(1)
    expect(
      execFileSync('git', ['-C', vault, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }),
    ).not.toContain('scan.pdf')
  })
})
