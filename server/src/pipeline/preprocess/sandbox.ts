/**
 * Containment for the converters (docs/agents/ideas.md, proposal 2026-09-07).
 *
 * The agent stage is contained at the OS level - bubblewrap, writes confined to the vault, no
 * web outside the research profile - and the stage BEFORE it was contained by nothing. Every
 * ingest hands an attacker-chosen file to a parser written in C, C++, Haskell, Perl, Python or
 * JavaScript, and until now those parsers ran as the service: able to read the credential file,
 * the database, the whole vault, and the unauthenticated API on localhost.
 *
 * `runTool`'s timeout and output cap are a liveness guard, not a boundary. A parser bug does not
 * time out; it executes. And the weakest link runs FIRST - a document reaches these tools before
 * any agent sees it.
 *
 * So a converter now runs the way an agent run does: in a bubblewrap jail with no network, no
 * home, a read-only view of the system directories it needs, exactly the input file it was given,
 * and one writable directory. Nothing else about `runTool` changes - the same timeout, the same
 * output cap, the same argument array that is never a shell string.
 *
 * WHAT THIS IS NOT: a converter can still burn CPU inside its jail until the timeout, and
 * bubblewrap is not a hypervisor. It is the same boundary the agent runs already rely on
 * (CLAUDE.md hard rule 4), applied one stage earlier.
 */

import fs from 'node:fs'
import path from 'node:path'
import { runTool, type RunResult } from './tools.js'

/** The binary. Absent means no containment is available and the caller must decide. */
export const BWRAP = 'bwrap'

export interface SandboxSpec {
  /** Paths the tool may READ. Everything else - the vault, `$HOME`, the DB - is not there. */
  readonly reads: readonly string[]
  /** The one directory it may write to; absent = it writes nothing. */
  readonly writes?: string
  /**
   * Egress. Converters get none. Only a tool whose JOB is to fetch may ask for it, and the one
   * that does (`yt-dlp`) is documented as such where it is called.
   */
  readonly net?: boolean
  readonly timeoutMs?: number
  readonly maxBuffer?: number
}

/**
 * The system directories a converter needs to exist at all: its own binary, the shared
 * libraries, and `/etc` for fonts, locale and CA certificates. All read-only.
 *
 * On a merged-`/usr` system `/bin`, `/lib`, `/lib64` and `/sbin` are symlinks INTO `/usr`, so
 * they are recreated as symlinks rather than bound - binding a symlink's target over its name
 * gives a jail where `/lib/x` and `/usr/lib/x` are two different files.
 */
function systemArgs(): string[] {
  const out = ['--ro-bind', '/usr', '/usr']
  if (fs.existsSync('/etc')) out.push('--ro-bind', '/etc', '/etc')
  for (const dir of ['/bin', '/sbin', '/lib', '/lib64']) {
    let stat: fs.Stats | undefined
    try {
      stat = fs.lstatSync(dir)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) out.push('--symlink', fs.readlinkSync(dir), dir)
    else if (stat.isDirectory()) out.push('--ro-bind', dir, dir)
  }
  return out
}

/**
 * The bubblewrap arguments for one converter run. Exported so a test can read the policy
 * without spawning anything: what is bound, what is not, and that the network is gone.
 */
export function bwrapArgs(spec: SandboxSpec, bin: string, args: readonly string[]): string[] {
  /*
   * The jail's PATH carries the system directories and the `bin/` of anything bound for the
   * tool's sake. A tool outside `/usr` usually starts with a shebang that looks its runtime up
   * by name - `#!/usr/bin/env node` - and without this it finds the system PATH, which is
   * exactly where that runtime is not.
   */
  const extraBins = spec.reads.map((r) => path.join(r, 'bin')).filter((b) => fs.existsSync(b))
  const jailPath = [...extraBins, '/usr/local/bin', '/usr/bin', '/bin'].join(':')
  const out = [
    // The jail dies with the service; an orphaned parser holding an input file is not a thing
    // anyone wants to find later.
    '--die-with-parent',
    // Its own session, so it cannot push characters into the parent's terminal (TIOCSTI).
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup',
    // No inherited environment: no credential that happens to sit in one, no LD_PRELOAD.
    '--clearenv',
    '--setenv',
    'PATH',
    jailPath,
    // A home that is a tmpfs, so a tool that insists on writing a dotfile can, and it is gone
    // when the jail is.
    '--setenv',
    'HOME',
    '/tmp',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    ...systemArgs(),
  ]
  if (spec.net !== true) out.push('--unshare-net')
  for (const read of spec.reads) out.push('--ro-bind', read, read)
  if (spec.writes !== undefined) out.push('--bind', spec.writes, spec.writes)
  return [...out, '--', bin, ...args]
}

/**
 * Runs a converter inside the jail. The signature mirrors `runTool` on purpose: a call site
 * that gains containment should not have to change shape to get it.
 */
export function runToolSandboxed(bin: string, args: readonly string[], spec: SandboxSpec): Promise<RunResult> {
  const opts: { timeoutMs?: number; maxBuffer?: number } = {}
  if (spec.timeoutMs !== undefined) opts.timeoutMs = spec.timeoutMs
  if (spec.maxBuffer !== undefined) opts.maxBuffer = spec.maxBuffer
  return runTool(BWRAP, bwrapArgs(spec, bin, args), opts)
}

/**
 * The directory a tool needs beyond the system ones, or null when it needs none.
 *
 * Not every converter lives in `/usr`: this machine's `defuddle` is an npm global under `.nvm`
 * and its `python3` is a pyenv shim, whose interpreter and packages sit under `.pyenv`. Binding
 * `$HOME` to reach them would hand back everything this jail exists to take away - the
 * credential file among it - so what is bound is the tool's own PREFIX: the directory holding
 * its `bin/`, which for a pyenv shim is `.pyenv` and for an nvm binary that node version. Read
 * only, and nothing else of the home comes with it.
 */
export function toolPrefix(binPath: string): string[] {
  const real = ((): string => {
    try {
      return fs.realpathSync(binPath)
    } catch {
      return binPath
    }
  })()
  const roots: string[] = []
  /*
   * Both paths matter, and taking only one of them was wrong. `defuddle` is a symlink from an
   * npm `bin/` into `lib/node_modules/...`: bind only the target's prefix and the SYMLINK is
   * missing, so the jail cannot even find the binary it was told to run. Bind only the invoked
   * prefix and a tool whose link points elsewhere loses its target. So: the prefix of each,
   * with the nested one dropped - for an npm global both land inside the node version anyway.
   */
  for (const p of [binPath, real]) {
    if (p.startsWith('/usr/') || p.startsWith('/bin/')) continue
    const prefix = path.dirname(path.dirname(p))
    // A binary directly in `/` or one level down has no prefix worth binding; skip it rather
    // than bind something enormous by accident.
    if (prefix === '/' || prefix === '' || roots.includes(prefix)) continue
    roots.push(prefix)
  }
  return roots.filter((r, _i, all) => !all.some((other) => other !== r && r.startsWith(`${other}/`)))
}

/**
 * The read set for a converter that turns one file into one output: the input, and the
 * directory the output goes in. Both are inside the job's own staging directory, which is the
 * only part of the vault tree an ingest owns.
 */
export function fileSpec(input: string, outDir?: string, extra: Partial<SandboxSpec> = {}): SandboxSpec {
  const spec: SandboxSpec = { reads: [input], ...extra }
  const dir = outDir ?? path.dirname(input)
  return { ...spec, writes: dir }
}

/** Resolved once: the absolute path of a tool on the host, for working out what to bind. */
const resolved = new Map<string, string | null>()

/** Where `bin` actually is, using PATH; null when it is not on it. No shell involved. */
export function resolveTool(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (bin.includes('/')) return bin
  const hit = resolved.get(bin)
  if (hit !== undefined) return hit
  const found =
    (env['PATH'] ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, bin))
      .find((candidate) => {
        try {
          return fs.statSync(candidate).isFile()
        } catch {
          return false
        }
      }) ?? null
  resolved.set(bin, found)
  return found
}

let bwrapPresent: boolean | undefined

/** Whether containment is available at all. Cached: it does not change while the service runs. */
export function sandboxAvailable(): boolean {
  bwrapPresent ??= resolveTool(BWRAP) !== null
  return bwrapPresent
}

/**
 * Whether a machine without bubblewrap may still convert.
 *
 * Default NO, the same answer the agent runner gives (`failIfUnavailable`): a boundary that
 * disappears when it is inconvenient is not one. `PREPROCESS_SANDBOX=off` brings the old
 * behaviour back for a machine that cannot provide it, and says so in the error rather than
 * degrading quietly.
 */
export const sandboxRequired = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env['PREPROCESS_SANDBOX'] ?? '').trim().toLowerCase() !== 'off'

/**
 * Runs one converter over one file, contained.
 *
 * The tool sees: the system directories, its own runtime prefix when it lives outside `/usr`,
 * the input file, and the one directory its output goes in. It does not see the vault, the
 * database, `$HOME`, the credential file, or any network - the service's own API included,
 * which is unauthenticated on loopback and would otherwise be one `connect()` away.
 */
export async function runConverter(
  bin: string,
  args: readonly string[],
  opts: { readonly reads: readonly string[]; readonly writes?: string; readonly timeoutMs?: number; readonly maxBuffer?: number },
): Promise<RunResult> {
  const host = resolveTool(bin)
  if (!sandboxAvailable()) {
    if (sandboxRequired()) {
      throw new Error(
        `${bin} would run without containment: bubblewrap (bwrap) is not installed. Install it, or set PREPROCESS_SANDBOX=off to convert unsandboxed.`,
      )
    }
    const plain: { timeoutMs?: number; maxBuffer?: number } = {}
    if (opts.timeoutMs !== undefined) plain.timeoutMs = opts.timeoutMs
    if (opts.maxBuffer !== undefined) plain.maxBuffer = opts.maxBuffer
    return runTool(bin, args, plain)
  }
  const spec: SandboxSpec = {
    reads: [...new Set([...(host === null ? [] : toolPrefix(host)), ...opts.reads])],
    ...(opts.writes !== undefined ? { writes: opts.writes } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
  }
  /*
   * The RESOLVED path, not the bare name. The jail's PATH is not the host's, and a name can
   * land on a different binary inside: `python3` found `/usr/bin/python3` there while the host
   * would have run a pyenv shim, and the system interpreter has none of the packages the
   * extractor imports. Handing bubblewrap the path the host resolved removes the question.
   */
  return runToolSandboxed(host ?? bin, args, spec)
}
