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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasWikiLock, withWikiLock, withWikiLocks, WikiLockBusy } from '../src/pipeline/wiki-lock.js'

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
      ['acquire', 'wiki/concepts/A.md'],
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
    expect(calls).toEqual([
      ['acquire', 'wiki/concepts/A.md'],
      ['acquire', 'wiki/concepts/A.md'],
    ])
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
    expect(calls).toEqual([['acquire', 'wiki/concepts/A.md']])
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
  it('hands the writer what it holds and what somebody else does, and releases only its own', async () => {
    const calls: string[][] = []
    const seen: { held: readonly string[]; busy: readonly string[] }[] = []
    await withWikiLocks(vaultRoot, ['wiki/a.md', 'wiki/b.md', 'wiki/c.md'], (held, busy) => {
      seen.push({ held, busy })
    }, {
      exec: async (args) => {
        calls.push([...args])
        return args[1] === 'wiki/b.md' ? 75 : 0
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
f="$d/$(printf '%s' "$2" | cksum | cut -d' ' -f1).lock"
case "$1" in
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
