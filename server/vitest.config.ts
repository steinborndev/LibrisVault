import { defineConfig } from 'vitest/config'

/*
 * No git housekeeping in any test (2026-09-25). `git commit` ends with `git gc --auto` (and on
 * newer git `git maintenance run --auto`), and with `gc.autoDetach` on - the default - that work
 * FORKS and keeps writing `.git` after the commit has returned. A test that then deletes its
 * throwaway vault races a process it never started and loses on a slow disk: the teardown dies
 * with `ENOTEMPTY: rmdir '.git'`, nowhere near an assertion. CI lost runs to it in the queue,
 * shift and recap suites (2026-09-16, 2026-09-16, 2026-09-25). shift.test switched it off for
 * its own repos that first time; thirty other files make repos of their own, so it is switched
 * off here, for every git the tests and the service under test start.
 *
 * Through git's environment config (GIT_CONFIG_COUNT/KEY/VALUE, git >= 2.31) rather than a
 * `git config` per repo: the service's own git calls inherit the environment (`runTool` passes
 * none of its own), and a new test cannot forget it. test/git-housekeeping.test.ts pins it.
 */
export default defineConfig({
  test: {
    env: {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'gc.auto',
      GIT_CONFIG_VALUE_0: '0',
      GIT_CONFIG_KEY_1: 'maintenance.auto',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'gc.autoDetach',
      GIT_CONFIG_VALUE_2: 'false',
    },
  },
})
