import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { ValidationStore, findingIdentity } from '../src/db/validation.js'

/**
 * The standing defect list (A9, 5.1).
 *
 * The measured population this replaces: 406 warnings in job logs, one dead link reported 109
 * times and one counter drift 58 times, every one of them labelled "advisory only". A defect
 * reported again on every run cannot be told apart from a defect that was just introduced,
 * which is why nothing ever acted on one.
 */
let db: Db
let store: ValidationStore

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new ValidationStore(db)
})

const f = (rule: string, path: string, message: string): { rule: string; path: string; message: string } => ({
  rule,
  path,
  message,
})

describe('findingIdentity', () => {
  it('is the same for the same defect reported twice', () => {
    const one = f('dead-link', 'wiki/concepts/A.md', '[[Missing]] does not resolve to any file in the vault')
    expect(findingIdentity(one)).toBe(findingIdentity({ ...one }))
  })

  it('ignores the parts of a message that are values rather than the defect', () => {
    // A counter that drifts by one more page every week is one defect, not a new one weekly.
    const a = f('stale-counter', 'wiki/overview.md', 'header claims 487 pages but the vault has 805')
    const b = f('stale-counter', 'wiki/overview.md', 'header claims 487 pages but the vault has 806')
    expect(findingIdentity(a)).toBe(findingIdentity(b))

    const addrA = f('address-map', 'wiki/concepts/A.md', 'address_map says c-000123 but the page says c-000124')
    const addrB = f('address-map', 'wiki/concepts/A.md', 'address_map says c-000999 but the page says c-001000')
    expect(findingIdentity(addrA)).toBe(findingIdentity(addrB))
  })

  it('separates two defects of the same rule on one page', () => {
    const a = f('dead-link', 'wiki/concepts/A.md', 'a link into a folder that does not exist')
    const b = f('dead-link', 'wiki/concepts/A.md', 'a title the file name cannot carry')
    expect(findingIdentity(a)).not.toBe(findingIdentity(b))
  })

  it('separates the same defect on two pages', () => {
    const a = f('em-dash', 'wiki/concepts/A.md', '3 em-dashes outside code')
    const b = f('em-dash', 'wiki/concepts/B.md', '3 em-dashes outside code')
    expect(findingIdentity(a)).not.toBe(findingIdentity(b))
  })
})

describe('ValidationStore.record', () => {
  it('reports a finding once and counts it afterwards', () => {
    const finding = [f('dead-link', 'wiki/concepts/A.md', '[[Missing]] does not resolve')]
    const first = store.record(finding, 'job-1')
    expect(first.created).toHaveLength(1)
    expect(first.repeated).toBe(0)

    // This is the 109-times case: the next hundred runs add a number, not a hundred log lines.
    for (let i = 0; i < 108; i++) store.record(finding, `job-${i + 2}`)
    const second = store.record(finding, 'job-110')
    expect(second.created).toEqual([])
    expect(second.repeated).toBe(1)

    const standing = store.list()
    expect(standing).toHaveLength(1)
    expect(standing[0]?.count).toBe(110)
    expect(standing[0]?.lastJobId).toBe('job-110')
  })

  it('keeps the first-seen date while the message follows the latest report', () => {
    store.record([f('stale-counter', 'wiki/overview.md', 'header claims 487 pages but the vault has 805')], 'job-1', '2026-01-01T00:00:00Z')
    store.record([f('stale-counter', 'wiki/overview.md', 'header claims 487 pages but the vault has 900')], 'job-2', '2026-03-01T00:00:00Z')
    const [row] = store.list()
    expect(row?.firstSeen).toBe('2026-01-01T00:00:00Z')
    expect(row?.lastSeen).toBe('2026-03-01T00:00:00Z')
    // The message is the newest one: a reader wants the current numbers, not January's.
    expect(row?.message).toContain('900')
    expect(row?.count).toBe(2)
  })

  it('orders the list loudest first, then oldest', () => {
    store.record([f('dead-link', 'wiki/a.md', 'x')], 'j', '2026-01-01T00:00:00Z')
    store.record([f('dead-link', 'wiki/a.md', 'x')], 'j', '2026-01-02T00:00:00Z')
    store.record([f('em-dash', 'wiki/b.md', 'y')], 'j', '2025-01-01T00:00:00Z')
    store.record([f('page-schema', 'wiki/c.md', 'z')], 'j', '2026-06-01T00:00:00Z')
    expect(store.list().map((r) => r.rule)).toEqual(['dead-link', 'em-dash', 'page-schema'])
  })

  it('counts the backlog by rule', () => {
    store.record(
      [f('em-dash', 'wiki/a.md', 'x'), f('em-dash', 'wiki/b.md', 'x'), f('dead-link', 'wiki/a.md', 'y')],
      'j',
    )
    store.record([f('em-dash', 'wiki/a.md', 'x')], 'j')
    expect(store.countsByRule()).toEqual([
      { rule: 'em-dash', findings: 2, occurrences: 3 },
      { rule: 'dead-link', findings: 1, occurrences: 1 },
    ])
  })
})

/** Everything the caller in these tests is pretending to have checked. */
const ALL = new Set(['dead-link', 'em-dash', 'quote', 'near-duplicate', 'address-map'])

describe('ValidationStore.resolveMissing', () => {
  it('takes a fixed finding off the standing list', () => {
    const dead = f('dead-link', 'wiki/concepts/A.md', '[[Missing]] does not resolve')
    const dash = f('em-dash', 'wiki/concepts/A.md', '3 em-dashes outside code')
    store.record([dead, dash], 'job-1')
    expect(store.list()).toHaveLength(2)

    // The run looked at the page again and only found the dash: the link was repaired.
    expect(store.resolveMissing(['wiki/concepts/A.md'], [dash], { checked: ALL })).toBe(1)
    expect(store.list().map((r) => r.rule)).toEqual(['em-dash'])
  })

  it('touches only the pages it was given', () => {
    store.record([f('em-dash', 'wiki/a.md', 'x'), f('em-dash', 'wiki/b.md', 'x')], 'job-1')
    expect(store.resolveMissing(['wiki/a.md'], [], { checked: ALL })).toBe(1)
    expect(store.list().map((r) => r.path)).toEqual(['wiki/b.md'])
  })

  it('brings a finding back, with its history, when the repair did not hold', () => {
    const dead = f('dead-link', 'wiki/concepts/A.md', '[[Missing]] does not resolve')
    store.record([dead], 'job-1')
    store.resolveMissing(['wiki/concepts/A.md'], [], { checked: ALL })
    expect(store.list()).toEqual([])

    store.record([dead], 'job-2')
    const [row] = store.list()
    // Not a fresh row: the count is how often this vault has had this defect, and a repair
    // that did not hold is worth seeing as a return rather than as a first sighting.
    expect(row?.count).toBe(2)
    expect(row?.resolvedAt).toBeNull()
  })

  it('does nothing when it is given no pages', () => {
    store.record([f('em-dash', 'wiki/a.md', 'x')], 'job-1')
    expect(store.resolveMissing([], [], { checked: ALL })).toBe(0)
    expect(store.list()).toHaveLength(1)
  })
})

describe('a rule the caller never ran', () => {
  /*
   * `quote` and `near-duplicate` are not raised by `createValidator`: they need a job's
   * artifact and the commit before the run. A maintenance run touching a page that carries one
   * would have cleared it as repaired, without a single quote being compared.
   */
  it('is left standing, however quiet the run was about it', () => {
    const quote = f('quote', 'wiki/concepts/A.md', 'quote not found in the source: "x"')
    const dash = f('em-dash', 'wiki/concepts/A.md', '3 em-dashes outside code')
    store.record([quote, dash], 'job-1')

    // A run that checks pages only, finding nothing: the dash goes, the quote stays.
    expect(store.resolveMissing(['wiki/concepts/A.md'], [], { checked: new Set(['em-dash']) })).toBe(1)
    expect(store.list().map((r) => r.rule)).toEqual(['quote'])
  })

  it('is cleared once a run that CAN raise it says nothing', () => {
    const quote = f('quote', 'wiki/concepts/A.md', 'quote not found in the source: "x"')
    store.record([quote], 'job-1')
    expect(store.resolveMissing(['wiki/concepts/A.md'], [], { checked: new Set(['quote']) })).toBe(1)
    expect(store.list()).toEqual([])
  })

  it('does not let a whole-vault rule through the back door either', () => {
    // `fullyChecked` widens the reach of a rule the caller checked; it cannot add one it did not.
    const map = f('address-map', '.raw/01JOB', 'named in no source entry')
    store.record([map], 'job-1')
    const n = store.resolveMissing([], [], { checked: new Set(['em-dash']), fullyChecked: new Set(['address-map']) })
    expect(n).toBe(0)
    expect(store.list()).toHaveLength(1)
  })
})
