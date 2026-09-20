import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runMarkerPath,
  hasRunMarker,
  reapRunMarkers,
  RUN_MARKER_DIR,
  RUN_MARKER_MAX_AGE_MS,
} from '../src/pipeline/run-marker.js'
import { RUN_STATE_EXCLUDE_ENTRIES } from '../src/pipeline/vault-excludes.js'

/**
 * How the service tells a finished run from an interrupted one (A6 contract 1).
 *
 * The old answer read `wiki/log.md` and looked for the job's `.raw` directory, because the
 * vault skill wrote that entry last. Two things ended that: a skill's prose template cannot be
 * the basis of crash recovery, and the service writes the log entry itself now, so the marker
 * the old check looked for would never appear again.
 */
let vault: string

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-'))
  fs.mkdirSync(path.join(vault, RUN_MARKER_DIR), { recursive: true })
})
afterEach(() => fs.rmSync(vault, { recursive: true, force: true }))

const touch = (jobId: string, ageMs = 0): string => {
  const abs = path.join(vault, runMarkerPath(jobId)!)
  fs.writeFileSync(abs, '')
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(abs, when, when)
  }
  return abs
}

describe('runMarkerPath', () => {
  it('puts the marker under the vault state directory, named for the job', () => {
    expect(runMarkerPath('01JOBID')).toBe('.vault-meta/runs/01JOBID.done')
  })

  it('refuses an id that is not a plain identifier', () => {
    // The id is ours, but a path built from an untrusted-looking string is how a traversal
    // gets in, and the cost of checking is one regex.
    for (const bad of ['../../etc/passwd', 'a/b', '', '.', 'x\0y']) expect(runMarkerPath(bad)).toBeNull()
  })
})

describe('hasRunMarker', () => {
  it('is true once the run has left its marker', () => {
    expect(hasRunMarker(vault, '01JOBID')).toBe(false)
    touch('01JOBID')
    expect(hasRunMarker(vault, '01JOBID')).toBe(true)
  })

  it('answers false rather than throwing for a vault without the directory', () => {
    fs.rmSync(path.join(vault, RUN_MARKER_DIR), { recursive: true })
    expect(hasRunMarker(vault, '01JOBID')).toBe(false)
  })

  it('is not fooled by a directory of the same name', () => {
    fs.mkdirSync(path.join(vault, RUN_MARKER_DIR, '01JOBID.done'))
    expect(hasRunMarker(vault, '01JOBID')).toBe(false)
  })
})

describe('reapRunMarkers', () => {
  it('removes markers past the age and keeps the rest', () => {
    touch('fresh')
    touch('yesterday', RUN_MARKER_MAX_AGE_MS + 60_000)
    expect(reapRunMarkers(vault)).toBe(1)
    expect(hasRunMarker(vault, 'fresh')).toBe(true)
    expect(hasRunMarker(vault, 'yesterday')).toBe(false)
  })

  it('leaves anything that is not a marker alone', () => {
    fs.writeFileSync(path.join(vault, RUN_MARKER_DIR, 'notes.txt'), 'someone put this here')
    touch('old', RUN_MARKER_MAX_AGE_MS + 60_000)
    expect(reapRunMarkers(vault)).toBe(1)
    expect(fs.existsSync(path.join(vault, RUN_MARKER_DIR, 'notes.txt'))).toBe(true)
  })

  it('is a no-op on a vault with no markers at all', () => {
    fs.rmSync(path.join(vault, RUN_MARKER_DIR), { recursive: true })
    expect(reapRunMarkers(vault)).toBe(0)
  })
})

describe('the marker never reaches the vault\'s history', () => {
  it('is excluded next to the locks', () => {
    // BOOKKEEPING_PATHS stages `.vault-meta` wholesale on every commit, so an exclude is the
    // only mechanism that holds regardless of what a run does.
    expect([...RUN_STATE_EXCLUDE_ENTRIES]).toEqual(['.vault-meta/runs/', '.vault-meta/locks/'])
  })
})
