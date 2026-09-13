/**
 * Live containment probe for the preprocessing chain, the counterpart to `permprobe`.
 *
 * Not a unit test, for the same reason that one is not: the tests read the argument list and
 * prove the POLICY, and a policy that is never applied still passes them. This spawns the real
 * converters against real canaries and asks what they can actually reach.
 *
 * Re-run it after any change to the converter wiring, after a bubblewrap upgrade, and on a new
 * machine - a jail is a property of the host as much as of the code.
 *
 * Run: npx tsx server/src/cli/preprocprobe.ts
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bwrapArgs, resolveTool, sandboxAvailable, toolPrefix } from '../pipeline/preprocess/sandbox.js'
import { runTool } from '../pipeline/preprocess/tools.js'

const HOME = os.homedir()
/** The three things an uncontained converter could read, and the one it could talk to. */
const CREDENTIAL = path.join(HOME, '.config', 'vault-service', 'env')
const VAULT = process.env['VAULT_ROOT'] ?? path.join(HOME, 'vault')
const API = process.env['PORT'] ?? '8421'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preprocprobe-'))
const input = path.join(dir, 'input.txt')
fs.writeFileSync(input, 'a canary the converter is allowed to read\n')

/*
 * A minimal JATS article, for the converter the open-access lane added (docs/sources/SPEC.md
 * 2.3): Europe PMC hands out full text as JATS, and pandoc reads it - inside the jail like
 * every other converter, because it is a stranger's XML.
 */
const jats = path.join(dir, 'article.xml')
fs.writeFileSync(
  jats,
  '<?xml version="1.0"?><article><front><article-meta><title-group><article-title>A paper</article-title>' +
    '</title-group></article-meta></front><body><sec><p>One paragraph of the full text.</p></sec></body></article>\n',
)

let failures = 0
const check = async (what: string, expected: 'blocked' | 'allowed', bin: string, args: string[]): Promise<void> => {
  const host = resolveTool(bin)
  if (host === null) {
    console.log(`  ?  ${what.padEnd(38)} ${bin} is not installed, skipped`)
    return
  }
  const spec = { reads: [...toolPrefix(host), input], writes: dir }
  let reached: boolean
  try {
    // The RESOLVED path: inside the jail a bare name can find a different binary than the
    // host would (`python3` finds the system one where the host runs a pyenv shim).
    await runTool('bwrap', bwrapArgs(spec, host, args), { timeoutMs: 20_000 })
    reached = true
  } catch {
    reached = false
  }
  const got = reached ? 'allowed' : 'blocked'
  const ok = got === expected
  if (!ok) failures++
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${what.padEnd(38)} ${got} (expected ${expected})`)
}

const run = async (): Promise<void> => {
  console.log(`bubblewrap: ${sandboxAvailable() ? 'available' : 'MISSING - nothing below is contained'}`)
  if (!sandboxAvailable()) process.exit(1)
  console.log(`\ncanaries: ${CREDENTIAL}, ${VAULT}, 127.0.0.1:${API}\n`)

  // What a converter must still be able to do, or the jail is useless.
  await check('reads the file it was given', 'allowed', 'cat', [input])
  // `touch`, not `tee`: tee waits on a stdin nobody writes, and a probe that hangs reads as a
  // jail that blocks.
  await check('writes into its output directory', 'allowed', 'touch', [path.join(dir, 'out.txt')])

  // What it must not.
  await check('reads the credential file', 'blocked', 'cat', [CREDENTIAL])
  await check('lists the vault', 'blocked', 'ls', [VAULT])
  await check('reads its own home', 'blocked', 'ls', [HOME])
  /*
   * Not "does the command fail" - `/tmp` inside the jail is a tmpfs, so the write SUCCEEDS
   * there and reaches nothing. What matters is whether anything of it exists on the host
   * afterwards, so that is what is asked.
   */
  const escape = path.join(os.tmpdir(), `preprocprobe-escape-${process.pid}`)
  await check('tries to write outside its directory', 'allowed', 'touch', [escape])
  const escaped = fs.existsSync(escape)
  if (escaped) failures++
  console.log(`  ${escaped ? 'FAIL' : 'ok'} ${'...and nothing of it reached the host'.padEnd(38)} ${escaped ? 'a file appeared' : 'nothing appeared'}`)
  fs.rmSync(escape, { force: true })
  await check(
    'reaches the service API',
    'blocked',
    'python3',
    ['-c', `import socket;s=socket.socket();s.settimeout(3);s.connect(("127.0.0.1",${API}))`],
  )
  await check('reaches the internet', 'blocked', 'python3', ['-c', 'import socket;socket.create_connection(("1.1.1.1",443),3)'])

  // And the converters themselves still work in there.
  await check('pandoc runs', 'allowed', 'pandoc', ['--version'])
  // Not just "pandoc starts": the JATS reader is what the open-access lane depends on.
  await check('pandoc converts JATS', 'allowed', 'pandoc', ['-f', 'jats', '-t', 'gfm', jats, '-o', path.join(dir, 'article.md')])
  await check('pdftotext runs', 'allowed', 'pdftotext', ['-v'])
  await check('python3 finds its packages', 'allowed', 'python3', ['-c', 'import pptx, openpyxl'])
  await check('defuddle runs', 'allowed', 'defuddle', ['--version'])

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'PASS - the jail holds.' : `FAIL - ${failures} check(s) came out wrong.`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void run().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
