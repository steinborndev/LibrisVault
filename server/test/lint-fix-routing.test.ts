import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { ValidationStore } from '../src/db/validation.js'
import { renderStandingDefects, MECHANICAL_RULES, JUDGEMENT_RULES } from '../src/pipeline/maintenance.js'
import { ALL_RULES } from '../src/pipeline/validator.js'

/**
 * Which standing defects a repair run is allowed to be told about (A9, 5.3).
 *
 * The split is the whole of it. A wrapped link, a title its file name cannot carry, a page
 * missing from the address map, a tag repeating its own type: one correct repair each, no
 * judgement in any of them. A near-duplicate pair, a single-source entity, a contradiction: no
 * repair without somebody deciding, and a run that "fixes" one of those is exactly the silent
 * rewrite that report-only lint exists to prevent.
 */
let db: Db
let validation: ValidationStore

beforeEach(() => {
  db = openDb(MEMORY_DB)
  validation = new ValidationStore(db)
})

describe('the mechanical / judgement split', () => {
  it('puts every rule on exactly one side', () => {
    // A rule on neither side is a rule nobody decided about, which is how a judgement call
    // ends up in a prompt by accident.
    for (const rule of MECHANICAL_RULES) expect(JUDGEMENT_RULES.has(rule), rule).toBe(false)
    for (const rule of JUDGEMENT_RULES) expect(MECHANICAL_RULES.has(rule), rule).toBe(false)
  })

  it('keeps the classes that need a person out of the mechanical set', () => {
    for (const rule of ['near-duplicate', 'single-source-entity', 'page-schema', 'run-protocol']) {
      expect(MECHANICAL_RULES.has(rule), rule).toBe(false)
    }
  })

  it('keeps dead links out of it too', () => {
    // A dead link has two repairs - write the missing page, or repoint the link - and the
    // existing lint-fix scope forbids the second. It stays a finding for a person.
    expect(MECHANICAL_RULES.has('dead-link')).toBe(false)
  })
})

describe('renderStandingDefects', () => {
  it('is empty without a store, so the prompt is unchanged', () => {
    expect(renderStandingDefects(undefined)).toBe('')
  })

  it('is empty when nothing mechanical is standing', () => {
    validation.record([{ rule: 'near-duplicate', path: 'wiki/a.md', message: 'reads like wiki/b.md' }], 'job')
    expect(renderStandingDefects(validation)).toBe('')
  })

  it('names the mechanical findings and leaves the judgement ones out', () => {
    validation.record(
      [
        { rule: 'wrapped-link', path: 'wiki/a.md', message: 'a link split across a line' },
        { rule: 'near-duplicate', path: 'wiki/b.md', message: 'reads like wiki/c.md' },
        { rule: 'address-map', path: 'wiki/d.md', message: 'no entry for it' },
      ],
      'job',
    )
    const block = renderStandingDefects(validation)
    expect(block).toContain('[wrapped-link] wiki/a.md')
    expect(block).toContain('[address-map] wiki/d.md')
    expect(block).not.toContain('near-duplicate')
    expect(block).not.toContain('wiki/b.md')
  })

  it('bounds how much of the backlog reaches one prompt', () => {
    // 1051 tag mirrors are standing on this vault. A prompt that listed them all would be the
    // 514 kB index problem again, one layer up.
    for (let i = 0; i < 100; i++) {
      validation.record([{ rule: 'em-dash', path: `wiki/page-${i}.md`, message: 'three of them' }], 'job')
    }
    const lines = renderStandingDefects(validation).split('\n').filter((l) => l.startsWith('- ['))
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('takes the loudest first, because the list is ordered by count', () => {
    validation.record([{ rule: 'em-dash', path: 'wiki/quiet.md', message: 'one of them' }], 'job')
    for (let i = 0; i < 5; i++) {
      validation.record([{ rule: 'em-dash', path: 'wiki/loud.md', message: 'many of them' }], 'job')
    }
    const block = renderStandingDefects(validation)
    expect(block.indexOf('wiki/loud.md')).toBeLessThan(block.indexOf('wiki/quiet.md'))
  })
})

/**
 * Every rule has to be on one of the two lists (2026-09-21).
 *
 * A rule that is on neither reaches no fix run, because the prompt is built from
 * MECHANICAL_RULES, and is on nobody's list either, because JUDGEMENT_RULES is what says "this
 * one is for a person". `open-question-form` was in exactly that state from the day it shipped:
 * 15 standing findings that nothing would ever act on, found by reading the System screen
 * rather than by any check. This is the check.
 */
describe('the two lists together', () => {
  it('cover every rule, once each', () => {
    const unplaced = ALL_RULES.filter((r) => !MECHANICAL_RULES.has(r) && !JUDGEMENT_RULES.has(r))
    expect(unplaced, 'rules on neither list - a fix run never sees them and nobody owns them').toEqual([])
    const both = ALL_RULES.filter((r) => MECHANICAL_RULES.has(r) && JUDGEMENT_RULES.has(r))
    expect(both, 'rules on both lists - a fix run would repair what was reserved for a person').toEqual([])
  })

  it('claim no rule that does not exist', () => {
    const known = new Set<string>(ALL_RULES)
    expect([...MECHANICAL_RULES, ...JUDGEMENT_RULES].filter((r) => !known.has(r))).toEqual([])
  })
})
