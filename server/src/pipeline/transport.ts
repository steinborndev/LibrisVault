/**
 * The vault's transport pin: `.vault-meta/transport.json` (TASKS-M1 F1 / TASKS-M2 §0,
 * revisited 2026-09-19 as task 9's `detect-transport.sh` decision).
 *
 * WHAT THE PIN IS. The vault decides how a skill writes a page: through `obsidian-cli`
 * (`cli`) or by writing the file directly (`filesystem`). Five of its skills read the pin.
 * The SERVICE never reads it - but it depends on the answer, which is the part that was not
 * written down anywhere: `written-paths.ts` learns which pages a run wrote by reading the
 * Write/Edit calls out of the SDK message stream, and that works because the filesystem
 * transport writes pages with the Write tool. Under `cli` the same pages would be written by
 * a Bash call, `extractWrittenPaths` would return nothing for them, and the run's own commit
 * would stage nothing and surface as `committed: false`. Loud rather than silent, but nobody
 * would connect it back to a transport pin.
 *
 * WHY WE DO NOT RUN THE VAULT'S OWN DETECTOR. `scripts/detect-transport.sh` hangs on this
 * host, in one branch: with `obsidian` on PATH but no `obsidian-cli`, it runs
 * `obsidian --version`, which launches the WSLg GUI instead of returning. Its freshness check
 * short-circuits while the pin is younger than seven days, so the service bumped the pin's
 * mtime on every startup and the script never reached the hang.
 *
 * That bump WORKS and it stays, but on its own it was the whole answer, and as the whole
 * answer it had a hole: a pin that never expires is a pin that can never self-correct. Install
 * `obsidian-cli` tomorrow and the vault would keep using the filesystem transport forever,
 * with nothing saying why.
 *
 * SO WE DETECT THE SAME THING, HANG-PROOF. The script's decision is `obsidian-cli` on PATH,
 * or not; the branch that hangs is the one that asks a GUI binary to identify itself, and that
 * question has no answer we need. `command -v` cannot hang.
 *
 * AND WE ONLY REPORT. The pin is the vault's file, written by the vault's script, and this one
 * carries `manual_override: true` - a person's decision, which is not ours to overwrite (hard
 * rule 5, and hard rule 1's writer list does not name this file). A disagreement is a warning
 * at startup, with what to do about it.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export type TransportPinResult = 'refreshed' | 'absent'

/** What the vault's pin can say. `unknown` covers a missing or unreadable file. */
export type Transport = 'cli' | 'filesystem' | 'unknown'

export interface TransportCheck {
  /** Whether the pin's mtime was bumped, which is what keeps the vault's script hang-proof. */
  readonly pin: TransportPinResult
  /** What the pin currently claims. */
  readonly pinned: Transport
  /** What this host actually offers, detected without running anything that can hang. */
  readonly detected: Transport
  /** A person pinned it by hand; then a disagreement is a choice and not a drift. */
  readonly manualOverride: boolean
  /** Set when the two disagree and the difference would change how runs write pages. */
  readonly warning: string | null
}

export function transportPinPath(vaultRoot: string): string {
  return path.join(vaultRoot, '.vault-meta', 'transport.json')
}

/** Bumps the pin's mtime so detect-transport.sh stays hang-proof. No-op if absent. */
export function refreshTransportPin(vaultRoot: string): TransportPinResult {
  const p = transportPinPath(vaultRoot)
  if (!fs.existsSync(p)) return 'absent'
  const now = new Date()
  fs.utimesSync(p, now, now)
  return 'refreshed'
}

/**
 * What this host offers, by the one question the vault's script asks that cannot hang.
 *
 * `command -v` resolves a name on PATH and exits; it never executes the binary, which is
 * exactly the difference from `obsidian --version`. A missing shell, a timeout or any other
 * failure reads as `unknown`, never as an answer.
 */
export function detectTransport(env: NodeJS.ProcessEnv = process.env): Transport {
  try {
    const probe = spawnSync('/bin/sh', ['-c', 'command -v obsidian-cli'], {
      timeout: 2000,
      encoding: 'utf8',
      env,
    })
    if (probe.error !== undefined || probe.status === null) return 'unknown'
    return probe.status === 0 && probe.stdout.trim() !== '' ? 'cli' : 'filesystem'
  } catch {
    return 'unknown'
  }
}

/**
 * What the pin says, and whether a person put it there.
 *
 * The field is `preferred`, with `fallback_chain[0]` saying the same thing; the script writes
 * both. Read off the live pin rather than guessed - an earlier draft of this read a field
 * called `transport`, which does not exist, and reported `unknown` against a perfectly good
 * pin. `available.cli.present` is the script's OWN detection and is deliberately not read
 * here: it is exactly the stale answer this function exists to second-guess.
 */
export function readTransportPin(vaultRoot: string): { pinned: Transport; manualOverride: boolean } {
  const asTransport = (value: unknown): Transport | null =>
    value === 'cli' || value === 'filesystem' ? value : null
  try {
    const raw = JSON.parse(fs.readFileSync(transportPinPath(vaultRoot), 'utf8')) as Record<string, unknown>
    const chain = raw['fallback_chain']
    const pinned =
      asTransport(raw['preferred']) ?? (Array.isArray(chain) ? asTransport(chain[0]) : null) ?? 'unknown'
    return { pinned, manualOverride: raw['manual_override'] === true }
  } catch {
    return { pinned: 'unknown', manualOverride: false }
  }
}

/**
 * Keeps the pin fresh, and says so when what it claims no longer matches this host.
 *
 * Only ONE direction is worth a warning. A pin that says `filesystem` on a host that has since
 * grown an `obsidian-cli` is the case that would change how runs write pages, and therefore
 * whether this service can see what they wrote; the reverse - a `cli` pin on a host without the
 * binary - is the vault's own problem and its skills fail loudly on it.
 */
export function checkTransport(vaultRoot: string, env: NodeJS.ProcessEnv = process.env): TransportCheck {
  const pin = refreshTransportPin(vaultRoot)
  const { pinned, manualOverride } = readTransportPin(vaultRoot)
  const detected = detectTransport(env)

  const drifted = pinned === 'filesystem' && detected === 'cli'
  const warning = drifted
    ? `vault transport: the pin says "filesystem" but obsidian-cli is now on PATH.` +
      (manualOverride
        ? ' The pin carries manual_override, so this is your choice and nothing will change it.'
        : ' The service bumps the pin\'s mtime on every startup, so the vault\'s own detector never re-runs;' +
          ' delete .vault-meta/transport.json to let it re-detect.') +
      ' Worth knowing before you do: under the cli transport a run writes pages through Bash rather than' +
      ' the Write tool, and this service scopes each run\'s commit by watching Write/Edit calls.'
    : null

  return { pin, pinned, detected, manualOverride, warning }
}
