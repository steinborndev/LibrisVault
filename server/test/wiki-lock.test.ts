/**
 * The vault's own per-file write lock, as the service takes it (`wiki-lock.ts`).
 *
 * claude-obsidian makes this a rule and not an offer: "Every wiki page write MUST be preceded
 * by `wiki-lock acquire <path>` … Skills that don't acquire locks are racing against any other
 * writer." Our agent runs obeyed it because they execute those skills; our own writers did not,
 * which left the one pairing neither mechanism covered - a dashboard edit and an agent run on
 * the same page.
 *
 * Two layers here. The exit-code contract is tested with an injected `exec`, because 75 versus
 * 4 versus 0 is a decision table and a decision table wants a table. The wiring to a REAL
 * subprocess is tested against a stub script the test writes itself, with the same exit codes
 * and the same atomic-create semantics: it proves the wrapper spawns, passes the path, honours
 * the code and releases, without pinning the suite to a vault that CI does not have.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  hasWikiLock,
  withWikiLock,
  withWikiLocks,
  WikiLockBusy,
  normaliseLockPath,
  WIKI_LOCK_STALE_SEC,
} from '../src/pipeline/wiki-lock.js'

let vaultRoot: string

/** A vault with the script in it, or without - the two shapes the wrapper must handle. */
const makeVault = (withScript: boolean, body?: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wikilock-'))
  fs.mkdirSync(path.join(root, 'wiki'), { recursive: true })
  if (withScript) {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts/wiki-lock.sh'), body ?? '', { mode: 0o755 })
  }
  return root
}

beforeEach(() => {
  vaultRoot = makeVault(true, '#!/usr/bin/env bash\nexit 0\n')
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

describe('the exit-code contract', () => {
  it('runs the write unlocked when the vault has no such script', async () => {
    const older = makeVault(false)
    const calls: string[][] = []
    try {
      expect(hasWikiLock(older)).toBe(false)
      const out = await withWikiLock(older, 'wiki/concepts/A.md', () => 'written', {
        exec: async (args) => {
          calls.push([...args])
          return 0
        },
      })
      // A vault below v1.7 keeps the behaviour it already had rather than refusing to be
      // written to at all, which would be the worse of the two answers.
      expect(out).toBe('written')
      expect(calls).toEqual([])
    } finally {
      fs.rmSync(older, { recursive: true, force: true })
    }
  })

  it('acquires, runs, and releases the same page', async () => {
    const calls: string[][] = []
    const out = await withWikiLock(vaultRoot, 'wiki/concepts/A.md', () => 'written', {
      exec: async (args) => {
        calls.push([...args])
        return 0
      },
    })
    expect(out).toBe('written')
    expect(calls).toEqual([
      // The window goes on every acquire (A2): the script's own default of 60 s was shorter
      // than 9.6 % of this vault's measured holds, and a lock that outlives its threshold is
      // reaped by the next acquirer while its holder is still writing.
      ['acquire', '--stale-after-sec', String(WIKI_LOCK_STALE_SEC), 'wiki/concepts/A.md'],
      ['release', 'wiki/concepts/A.md'],
    ])
  })

  it('retries a held lock once, then gives up with WikiLockBusy and never writes', async () => {
    let ran = false
    const calls: string[][] = []
    await expect(
      withWikiLock(vaultRoot, 'wiki/concepts/A.md', () => { ran = true }, {
        retryMs: 1,
        exec: async (args) => {
          calls.push([...args])
          return 75
        },
      }),
    ).rejects.toBeInstanceOf(WikiLockBusy)
    expect(ran).toBe(false)
    // Two acquires and NO release: releasing a lock we never took would hand the page to a
    // third writer while its real holder is still writing (the script's release is `rm -f`).
    const acquire = ['acquire', '--stale-after-sec', String(WIKI_LOCK_STALE_SEC), 'wiki/concepts/A.md']
    expect(calls).toEqual([acquire, acquire])
  })

  it('writes when the retry wins', async () => {
    let n = 0
    const out = await withWikiLock(vaultRoot, 'wiki/concepts/A.md', () => 'written', {
      retryMs: 1,
      exec: async () => (n++ === 0 ? 75 : 0),
    })
    expect(out).toBe('written')
  })

  it('writes unlocked when the script fails for a reason that is not contention', async () => {
    // Exit 4 is the script's "invalid vault-relative path"; 3 is "lock dir creation failed".
    // Retrying cannot change either, and a broken vault script must not make page editing
    // impossible - that would be a new failure mode in exchange for an old one.
    const calls: string[][] = []
    const out = await withWikiLock(vaultRoot, 'wiki/concepts/A.md', () => 'written', {
      exec: async (args) => {
        calls.push([...args])
        return 3
      },
    })
    expect(out).toBe('written')
    expect(calls).toEqual([['acquire', '--stale-after-sec', String(WIKI_LOCK_STALE_SEC), 'wiki/concepts/A.md']])
  })

  it('releases even when the write throws', async () => {
    const calls: string[][] = []
    await expect(
      withWikiLock(
        vaultRoot,
        'wiki/concepts/A.md',
        () => {
          throw new Error('disk full')
        },
        {
          exec: async (args) => {
            calls.push([...args])
            return 0
          },
        },
      ),
    ).rejects.toThrow('disk full')
    // Without the `finally` the page stays locked until the script reaps it 60 seconds later.
    expect(calls.map((c) => c[0])).toEqual(['acquire', 'release'])
  })
})

describe('the batch form', () => {
  it('writes a page the script refuses as a request unlocked, like the single form, and never releases it', async () => {
    // Exit 4: the script's "path may not contain '..'" - a title ending in a full stop is enough.
    const calls: string[][] = []
    const seen: { held: readonly string[]; busy: readonly string[] }[] = []
    await withWikiLocks(vaultRoot, ['wiki/a.md', 'wiki/b etc..md', 'wiki/c.md'], (held, busy) => {
      seen.push({ held, busy })
    }, {
      exec: async (args) => {
        calls.push([...args])
        if (args[0] === 'acquire' && args.at(-1) === 'wiki/b etc..md') return 4
        if (args[0] === 'acquire' && args.at(-1) === 'wiki/c.md') return 75
        return 0
      },
    })
    expect(seen).toEqual([{ held: ['wiki/a.md', 'wiki/b etc..md'], busy: ['wiki/c.md'] }])
    expect(calls.filter((c) => c[0] === 'release')).toEqual([['release', 'wiki/a.md']])
  })

  it('hands the writer what it holds and what somebody else does, and releases only its own', async () => {
    const calls: string[][] = []
    const seen: { held: readonly string[]; busy: readonly string[] }[] = []
    await withWikiLocks(vaultRoot, ['wiki/a.md', 'wiki/b.md', 'wiki/c.md'], (held, busy) => {
      seen.push({ held, busy })
    }, {
      exec: async (args) => {
        calls.push([...args])
        return args.at(-1) === 'wiki/b.md' ? 75 : 0
      },
    })
    expect(seen).toEqual([{ held: ['wiki/a.md', 'wiki/c.md'], busy: ['wiki/b.md'] }])
    // b is never released: it belongs to whoever is writing it.
    expect(calls.filter((c) => c[0] === 'release').map((c) => c[1])).toEqual(['wiki/a.md', 'wiki/c.md'])
  })

  it('releases what it took even when the writer throws', async () => {
    const released: string[] = []
    await expect(
      withWikiLocks(vaultRoot, ['wiki/a.md', 'wiki/b.md'], () => {
        throw new Error('boom')
      }, {
        exec: async (args) => {
          if (args[0] === 'release') released.push(args[1]!)
          return 0
        },
      }),
    ).rejects.toThrow('boom')
    expect(released).toEqual(['wiki/a.md', 'wiki/b.md'])
  })
})

describe('the window and the path (A2)', () => {
  it('hands the script the window on every acquire, and never on release', async () => {
    const calls: string[][] = []
    await withWikiLock(vaultRoot, 'wiki/concepts/A.md', () => null, {
      staleAfterSec: 900,
      exec: async (args) => {
        calls.push([...args])
        return 0
      },
    })
    expect(calls[0]).toEqual(['acquire', '--stale-after-sec', '900', 'wiki/concepts/A.md'])
    // Release is an unconditional `rm -f` in the script; a threshold there would mean nothing.
    expect(calls[1]).toEqual(['release', 'wiki/concepts/A.md'])
  })

  it('locks one page for four spellings of its path', async () => {
    // The script hashes the RAW string, so an un-normalised caller opens a SECOND lock
    // namespace on the same page - two locks that do not see each other are not locking.
    const seen: string[] = []
    for (const spelling of ['wiki/concepts/A.md', './wiki/concepts/A.md', 'wiki//concepts/A.md', `${vaultRoot}/wiki/concepts/A.md`]) {
      await withWikiLock(vaultRoot, spelling, () => null, {
        exec: async (args) => {
          if (args[0] === 'acquire') seen.push(args[3]!)
          return 0
        },
      })
    }
    expect(new Set(seen)).toEqual(new Set(['wiki/concepts/A.md']))
  })

  it('normalises a windows separator and a repeated slash without touching a real name', () => {
    expect(normaliseLockPath('wiki\\concepts\\A.md')).toBe('wiki/concepts/A.md')
    expect(normaliseLockPath('././wiki//concepts///A.md')).toBe('wiki/concepts/A.md')
    expect(normaliseLockPath('/wiki/concepts/A.md')).toBe('wiki/concepts/A.md')
    // A page whose own title carries a dot or a space is left exactly as it is.
    expect(normaliseLockPath('wiki/concepts/A. Thing (v2).md')).toBe('wiki/concepts/A. Thing (v2).md')
  })

  it('keeps a long batch from outliving its own first lock', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[][] = []
      let release!: () => void
      const writing = new Promise<void>((r) => {
        release = r
      })
      const batch = withWikiLocks(vaultRoot, ['wiki/a.md', 'wiki/b.md'], async () => await writing, {
        staleAfterSec: 600,
        exec: async (args) => {
          calls.push([...args])
          return 0
        },
      })
      await vi.advanceTimersByTimeAsync(299_000)
      expect(calls.filter((c) => c[2] === '0')).toHaveLength(0)
      // Half the window: every held lock is re-acquired with a zero threshold, which reaps and
      // re-creates a lock this process already holds and puts its age back to zero.
      await vi.advanceTimersByTimeAsync(2_000)
      expect(calls.filter((c) => c[2] === '0').map((c) => c[3])).toEqual(['wiki/a.md', 'wiki/b.md'])
      await vi.advanceTimersByTimeAsync(300_000)
      expect(calls.filter((c) => c[2] === '0')).toHaveLength(4)
      release()
      await batch
      // And the refreshing stops with the batch rather than running for the process's life.
      const after = calls.length
      await vi.advanceTimersByTimeAsync(600_000)
      expect(calls).toHaveLength(after)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops refreshing a lock it has lost, and does not release it at the end', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[][] = []
      let release!: () => void
      const writing = new Promise<void>((r) => {
        release = r
      })
      const batch = withWikiLocks(vaultRoot, ['wiki/a.md', 'wiki/b.md'], async () => await writing, {
        staleAfterSec: 600,
        exec: async (args) => {
          calls.push([...args])
          // The refresh on b loses: somebody else holds that page now.
          return args[2] === '0' && args[3] === 'wiki/b.md' ? 75 : 0
        },
      })
      await vi.advanceTimersByTimeAsync(301_000)
      await vi.advanceTimersByTimeAsync(300_000)
      // b is refreshed once, fails, and is never touched again.
      expect(calls.filter((c) => c[2] === '0' && c[3] === 'wiki/b.md')).toHaveLength(1)
      release()
      await batch
      // Releasing is unconditional in the script, so releasing b here would take the page away
      // from the writer that legitimately holds it now.
      expect(calls.filter((c) => c[0] === 'release').map((c) => c[1])).toEqual(['wiki/a.md'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('against a real subprocess', () => {
  /**
   * A stand-in with the script's contract: atomic create via `noclobber` (so a second acquire
   * loses), exit 75 when held, `rm -f` to release. Not the vault's script - that lives in a
   * vault CI does not have - but the same interface, spawned the same way.
   */
  const STUB = `#!/usr/bin/env bash
set -u
d="$WIKI_LOCK_VAULT/.vault-meta/locks"
mkdir -p "$d"
cmd="$1"; shift
# The flag the wrapper now passes on every acquire, consumed the way the real script does.
while [ $# -gt 1 ]; do case "$1" in --stale-after-sec) shift 2 ;; *) break ;; esac; done
f="$d/$(printf '%s' "$1" | cksum | cut -d' ' -f1).lock"
case "$cmd" in
  acquire) set -o noclobber; { : > "$f"; } 2>/dev/null || exit 75 ;;
  release) rm -f "$f" ;;
  *) exit 2 ;;
esac
`

  it('takes a real lock, keeps a second writer out while it holds it, and frees it after', async () => {
    const root = makeVault(true, STUB)
    try {
      const order: string[] = []
      await withWikiLock(root, 'wiki/concepts/Contended.md', async () => {
        order.push('first writer is in')
        // A second writer arriving mid-write is refused - this is the case neither our commit
        // mutex nor an mtime comparison can see, and the whole reason for taking this lock.
        await expect(
          withWikiLock(root, 'wiki/concepts/Contended.md', () => order.push('second writer is in'), { attempts: 1 }),
        ).rejects.toBeInstanceOf(WikiLockBusy)
        order.push('first writer is out')
      })
      expect(order).toEqual(['first writer is in', 'first writer is out'])

      // And the lock is gone afterwards, so the next writer gets it.
      await withWikiLock(root, 'wiki/concepts/Contended.md', () => order.push('third writer is in'))
      expect(order.at(-1)).toBe('third writer is in')

      // A different page is never blocked by this one: the locks are per file.
      await withWikiLock(root, 'wiki/concepts/Other.md', () => order.push('other page is in'))
      expect(order.at(-1)).toBe('other page is in')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * The window, against the VAULT'S OWN script rather than the stub above. A stub can be made to
 * agree with any threshold we like; the question here is what the real script does with the
 * flag we now pass it, and that is the whole of task 1.3.
 *
 * Ages are FORGED rather than waited for: the script decides staleness from the epoch written
 * inside the lockfile, so a lock "held for 610 seconds" is one whose stored epoch is 610
 * seconds ago. Skipped on a machine with no claude-obsidian vault to borrow the script from.
 */
describe("against the vault's real lock script", () => {
  const source = path.join(process.env['VAULT_ROOT'] ?? path.join(os.homedir(), 'vault'), 'scripts/wiki-lock.sh')
  const available = fs.existsSync(source)

  /** A temp vault carrying the real script, and one lockfile aged `ageSec` seconds. */
  const vaultWithAgedLock = (page: string, ageSec: number): string => {
    const root = makeVault(true, fs.readFileSync(source, 'utf8'))
    fs.mkdirSync(path.join(root, 'wiki/concepts'), { recursive: true })
    fs.writeFileSync(path.join(root, page), '# Held\n')
    const locks = path.join(root, '.vault-meta/locks')
    fs.mkdirSync(locks, { recursive: true })
    const hash = crypto.createHash('sha1').update(page).digest('hex')
    const epoch = Math.floor(Date.now() / 1000) - ageSec
    fs.writeFileSync(path.join(locks, `${hash}.lock`), `424242 ${epoch} ${page}\n`)
    return root
  }

  it.skipIf(!available)('hashes a page the same way the script does', () => {
    // If this ever fails, every assertion below is testing a lockfile the script never reads.
    const root = makeVault(true, fs.readFileSync(source, 'utf8'))
    try {
      fs.mkdirSync(path.join(root, 'wiki'), { recursive: true })
      execFileSync('bash', [path.join(root, 'scripts/wiki-lock.sh'), 'acquire', 'wiki/x.md'], {
        cwd: root,
        env: { ...process.env, WIKI_LOCK_VAULT: root },
      })
      const hash = crypto.createHash('sha1').update('wiki/x.md').digest('hex')
      expect(fs.existsSync(path.join(root, '.vault-meta/locks', `${hash}.lock`))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!available)('leaves a lock held for 90 seconds alone, where the default would have reaped it', async () => {
    const page = 'wiki/concepts/Held.md'
    const root = vaultWithAgedLock(page, 90)
    try {
      // 90 s is past the script's own 60 s default and well inside the measured p90-to-max
      // band (59 s to 108 s), which is exactly the population that used to be reaped mid-write.
      let ran = false
      await expect(
        withWikiLock(root, page, () => {
          ran = true
        }, { attempts: 1 }),
      ).rejects.toBeInstanceOf(WikiLockBusy)
      expect(ran).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!available)('still reaps a lock held past the window, so a crash cannot wedge the page', async () => {
    const page = 'wiki/concepts/Held.md'
    const root = vaultWithAgedLock(page, WIKI_LOCK_STALE_SEC + 10)
    try {
      // The point of an age-based lock: a holder that died leaves one behind, and the window
      // is a bound on how long that can block a page, not a promise never to reap.
      const out = await withWikiLock(root, page, () => 'written', { attempts: 1 })
      expect(out).toBe('written')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
