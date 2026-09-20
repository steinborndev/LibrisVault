/**
 * Vault contract probe. The third of the three probes, for the same reason as the other two:
 * unit tests read our own policy, and only a probe proves the OTHER side still behaves the way
 * we parse it. `permprobe` asks whether the SDK still consults our guard; `preprocprobe` asks
 * whether a converter still runs contained; this one asks whether the VAULT still writes the
 * four texts we read back (A6).
 *
 *   npm run vaultprobe                  # against VAULT_ROOT
 *   npm run vaultprobe -- ~/some-vault  # against a specific vault
 *   npm run vaultprobe -- --ingest      # additionally run one live ingest, see below
 *
 * Re-run it after every vault upgrade. All four checks read files and write nothing, so the
 * default form is safe against the live vault and takes milliseconds.
 *
 * `--ingest` is the opt-in half: it provisions a SCRATCH vault (the real vault's machinery -
 * skills, commands, scripts, plugin manifest - plus an empty wiki, never the real wiki), runs
 * one minimal ingest through the real runner, and asserts that what the run wrote into the
 * scratch `wiki/log.md` is the shape crash recovery keys on. It costs an agent run, needs a
 * credential, and never touches the live vault.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, requireAuth, ConfigError } from '../config.js'
import { checkVaultContracts, type ContractCheck } from '../pipeline/vault-contracts.js'
import { runAgent } from '../pipeline/agent-runner.js'

/** The vault's machinery, which a run needs, without a single page of its content. */
const MACHINERY = ['skills', 'commands', 'scripts', 'agents', '.claude-plugin', '.claude', 'CLAUDE.md']

function provisionScratchVault(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultprobe-'))
  for (const entry of MACHINERY) {
    const from = path.join(source, entry)
    if (fs.existsSync(from)) fs.cpSync(from, path.join(root, entry), { recursive: true })
  }
  for (const dir of ['wiki/concepts', 'wiki/entities', 'wiki/sources', 'wiki/meta', '.vault-meta', '.raw/probe']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(root, 'wiki/index.md'), '# Wiki Index\n\n## Concepts\n')
  fs.writeFileSync(path.join(root, 'wiki/log.md'), '# Operation Log\n')
  fs.writeFileSync(path.join(root, 'wiki/hot.md'), '# Hot Cache\n')
  // The allocator resumes from the counter; a scratch vault starts at one.
  fs.writeFileSync(path.join(root, '.vault-meta/address-counter.txt'), '1\n')
  fs.copyFileSync(path.join(source, '.vault-meta/legacy-pages.txt'), path.join(root, '.vault-meta/legacy-pages.txt'))
  return root
}

/**
 * One tiny document, ingested for real. The assertion is on the FILE the run left behind, not
 * on what the run said it did: crash recovery reads the file, and a run's own account of its
 * work has been wrong before.
 */
async function liveIngestProbe(source: string): Promise<number> {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`--ingest needs a credential: ${err.message}`)
      return 2
    }
    throw err
  }

  const root = provisionScratchVault(source)
  const rel = '.raw/probe/note.md'
  fs.writeFileSync(
    path.join(root, rel),
    [
      '# A Short Note On Tide Tables',
      '',
      'Tide tables are published a year ahead from harmonic constants derived from past',
      'observations at one station. The constants change slowly, so a table is a prediction',
      'rather than a measurement, and a storm surge is exactly the part it cannot carry.',
      '',
    ].join('\n'),
  )

  console.log(`  scratch vault: ${root}`)
  console.log(`  ingesting:     ${rel}`)
  const run = await runAgent({ vaultRoot: root, prompt: `ingest ${rel}`, auth: requireAuth(config) })
  if (!run.ok) {
    console.error(`  the run failed: ${run.error ?? 'no error given'}`)
    fs.rmSync(root, { recursive: true, force: true })
    return 1
  }

  const log = fs.readFileSync(path.join(root, 'wiki/log.md'), 'utf8')
  const namesSource = log.includes(rel) || /^\s*-\s*Source:\s*`?\.raw\//m.test(log)
  console.log(`  live ingest: log entry names its .raw source: ${namesSource ? 'yes' : 'NO'}`)
  if (!namesSource) {
    console.error('  contract completion-marker: the run wrote a log entry the queue cannot key on')
    console.error(`  the scratch vault is kept for inspection: ${root}`)
    return 1
  }
  fs.rmSync(root, { recursive: true, force: true })
  return 0
}

function printCheck(check: ContractCheck, verbose: boolean): void {
  console.log(`  ${check.contract.padEnd(20)} ${check.ok ? 'ok  ' : 'FAIL'}  ${check.detail}`)
  for (const e of check.evidence) {
    if (verbose || !e.ok) console.log(`      ${e.ok ? '✓' : '✗'} ${e.what}`)
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const wantIngest = args.includes('--ingest')
  const verbose = args.includes('--verbose')
  const given = args.find((a) => !a.startsWith('--'))
  const vaultRoot = given ?? process.env['VAULT_ROOT'] ?? path.join(os.homedir(), 'vault')

  if (!fs.existsSync(path.join(vaultRoot, 'wiki'))) {
    console.error(`no wiki/ under ${vaultRoot} - not a vault`)
    return 2
  }

  console.log(`vaultprobe: ${vaultRoot}`)
  const checks = checkVaultContracts(vaultRoot)
  for (const check of checks) printCheck(check, verbose)

  let code = checks.every((c) => c.ok) ? 0 : 1
  if (code === 0) console.log('\nall four text contracts hold')
  else console.log(`\n${checks.filter((c) => !c.ok).length} of 4 contracts drifted - the parser on our side is now reading something else`)

  if (wantIngest) {
    console.log('\nlive ingest into a scratch vault:')
    const ingestCode = await liveIngestProbe(vaultRoot)
    if (ingestCode !== 0) code = ingestCode
  }
  return code
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main()
    .then((c) => process.exit(c))
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
