/**
 * Re-reading the pages the standing list still names (2026-09-21).
 *
 * A finding is cleared when a run looks at its page again. Pages no run touches - a Fellow
 * notebook, a dated recap - were never looked at again, so a repair made elsewhere stayed on
 * the list forever: 11 of 66 findings on the morning this was written.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { ValidationStore } from '../src/db/validation.js'
import { recheckStanding } from '../src/pipeline/standing-recheck.js'
import type { ValidationFinding } from '../src/pipeline/validator.js'

let db: Db
let store: ValidationStore
const f = (rule: string, path: string, message = 'x'): ValidationFinding => ({ rule, path, message }) as ValidationFinding

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new ValidationStore(db)
})

describe('rechecking the standing list', () => {
  it('clears what a fresh read no longer reports', () => {
    store.record([f('em-dash', 'wiki/concepts/A.md')], null)
    expect(recheckStanding(store, () => [])).toBe(1)
    expect(store.list()).toEqual([])
  })

  it('leaves what it still reports', () => {
    const dash = f('em-dash', 'wiki/concepts/A.md')
    store.record([dash], null)
    expect(recheckStanding(store, () => [dash])).toBe(0)
    expect(store.list()).toHaveLength(1)
  })

  it('skips the pages the caller already checked itself', () => {
    store.record([f('em-dash', 'wiki/concepts/A.md'), f('em-dash', 'wiki/concepts/B.md')], null)
    const seen: string[][] = []
    recheckStanding(
      store,
      (paths) => {
        seen.push([...paths])
        return []
      },
      { exclude: ['wiki/concepts/A.md'] },
    )
    expect(seen).toEqual([['wiki/concepts/B.md']])
  })

  it('claims no rule that reading a page cannot answer', () => {
    // `quote` needs the job's artifact. This pass has none, so it must not clear one.
    store.record([f('quote', 'wiki/concepts/A.md', 'quote not found in the source: "x"')], null)
    expect(recheckStanding(store, () => [])).toBe(0)
    expect(store.list().map((r) => r.rule)).toEqual(['quote'])
  })

  it('leaves the entries that name no page alone', () => {
    // A `.raw/` job directory is named by a whole-vault rule, which this pass does not claim.
    store.record([f('address-map', '.raw/01JOB', 'named in no source entry')], null)
    expect(recheckStanding(store, () => [])).toBe(0)
    expect(store.list()).toHaveLength(1)
  })

  it('reports nothing rather than throwing when the check blows up', () => {
    store.record([f('em-dash', 'wiki/concepts/A.md')], null)
    expect(
      recheckStanding(store, () => {
        throw new Error('unreadable')
      }),
    ).toBe(0)
    expect(store.list()).toHaveLength(1)
  })
})
