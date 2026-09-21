import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkTransport, detectTransport, readTransportPin, refreshTransportPin } from '../src/pipeline/transport.js'

/**
 * The transport pin (task 9's `detect-transport.sh` decision).
 *
 * The vault's own detector hangs in one branch: with `obsidian` on PATH and no `obsidian-cli`
 * it runs `obsidian --version`, which launches a GUI. The service kept it away from that branch
 * by bumping the pin's mtime, which works and leaves a hole - a pin that never expires can never
 * self-correct. So the service asks the one question that cannot hang, and reports.
 */
let root = ''
const pinDir = (): string => path.join(root, '.vault-meta')
const writePin = (body: unknown): void => {
  fs.mkdirSync(pinDir(), { recursive: true })
  fs.writeFileSync(path.join(pinDir(), 'transport.json'), JSON.stringify(body))
}
/** A PATH with, or without, an executable called `obsidian-cli` on it. */
const pathWith = (present: boolean): NodeJS.ProcessEnv => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-bin-'))
  if (present) {
    const f = path.join(bin, 'obsidian-cli')
    fs.writeFileSync(f, '#!/bin/sh\necho 1.0\n')
    fs.chmodSync(f, 0o755)
  }
  return { PATH: bin }
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('detectTransport', () => {
  it('says cli when obsidian-cli is on PATH', () => {
    expect(detectTransport(pathWith(true))).toBe('cli')
  })

  it('says filesystem when it is not', () => {
    expect(detectTransport(pathWith(false))).toBe('filesystem')
  })

  it('never executes the binary, which is the whole difference from the vault\'s script', () => {
    // `obsidian --version` launches a GUI and never returns. `command -v` resolves a name.
    // A binary that would hang if RUN must still be detected instantly.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-bin-'))
    const f = path.join(bin, 'obsidian-cli')
    fs.writeFileSync(f, '#!/bin/sh\nsleep 600\n')
    fs.chmodSync(f, 0o755)
    const started = Date.now()
    expect(detectTransport({ PATH: bin })).toBe('cli')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('readTransportPin', () => {
  it('reads the value and the override flag', () => {
    writePin({ preferred: 'filesystem', manual_override: true })
    expect(readTransportPin(root)).toEqual({ pinned: 'filesystem', manualOverride: true })
  })

  it('falls back to the head of the chain when preferred is absent', () => {
    // The script writes both. Reading only one of them is how the first draft of this reported
    // `unknown` against the live vault's perfectly good pin.
    writePin({ fallback_chain: ['filesystem'], manual_override: true })
    expect(readTransportPin(root).pinned).toBe('filesystem')
  })

  it('reads the shape the vault actually writes', () => {
    writePin({
      schema_version: 1,
      manual_override: true,
      preferred: 'filesystem',
      fallback_chain: ['filesystem'],
      available: { cli: { present: false }, filesystem: { present: true } },
    })
    expect(readTransportPin(root)).toEqual({ pinned: 'filesystem', manualOverride: true })
  })

  it('is unknown for a missing, unparseable or unexpected pin', () => {
    expect(readTransportPin(root).pinned).toBe('unknown')
    fs.mkdirSync(pinDir(), { recursive: true })
    fs.writeFileSync(path.join(pinDir(), 'transport.json'), 'not json')
    expect(readTransportPin(root).pinned).toBe('unknown')
    writePin({ preferred: 'carrier pigeon' })
    expect(readTransportPin(root).pinned).toBe('unknown')
  })
})

describe('checkTransport', () => {
  it('warns when the pin says filesystem and the binary has appeared', () => {
    writePin({ preferred: 'filesystem' })
    const out = checkTransport(root, pathWith(true))
    expect(out.warning).toContain('obsidian-cli is now on PATH')
    // The warning has to say what it costs us, or nobody connects a commit to a pin.
    expect(out.warning).toContain('Write/Edit')
  })

  it('says so differently when a person pinned it by hand', () => {
    writePin({ preferred: 'filesystem', manual_override: true })
    const out = checkTransport(root, pathWith(true))
    expect(out.warning).toContain('manual_override')
    expect(out.manualOverride).toBe(true)
  })

  it('is quiet when the pin and the host agree', () => {
    writePin({ preferred: 'filesystem' })
    expect(checkTransport(root, pathWith(false)).warning).toBeNull()
  })

  it('is quiet in the other direction, which is the vault\'s problem and fails loudly there', () => {
    writePin({ preferred: 'cli' })
    expect(checkTransport(root, pathWith(false)).warning).toBeNull()
  })

  it('still bumps the mtime, because that is what keeps the vault\'s script from hanging', () => {
    writePin({ preferred: 'filesystem' })
    const file = path.join(pinDir(), 'transport.json')
    fs.utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'))
    expect(checkTransport(root, pathWith(false)).pin).toBe('refreshed')
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(new Date('2024-01-01').getTime())
  })

  it('reports an absent pin rather than creating one', () => {
    const out = checkTransport(root, pathWith(false))
    expect(out.pin).toBe('absent')
    expect(fs.existsSync(path.join(pinDir(), 'transport.json'))).toBe(false)
  })
})

describe('refreshTransportPin', () => {
  it('is a no-op without a pin', () => {
    expect(refreshTransportPin(root)).toBe('absent')
  })
})
