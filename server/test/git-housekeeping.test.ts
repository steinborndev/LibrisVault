/**
 * The test run switches git's housekeeping off (vitest.config.ts): a detached `git gc --auto`
 * after a commit keeps writing `.git` while a test deletes its vault, and the teardown fails
 * with ENOTEMPTY. Pinned here because the setting lives in the environment, where nothing else
 * would notice it going.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

describe('git in the test run', () => {
  it('runs no automatic housekeeping in a fresh repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-housekeeping-'))
    try {
      execFileSync('git', ['-C', dir, 'init', '-q'])
      const get = (key: string): string => execFileSync('git', ['-C', dir, 'config', '--get', key], { encoding: 'utf8' }).trim()
      expect(get('gc.auto')).toBe('0')
      expect(get('maintenance.auto')).toBe('false')
      expect(get('gc.autoDetach')).toBe('false')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
