import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { ValidationStore } from '../src/db/validation.js'
import { ALL_RULES, type ValidationRule } from '../src/pipeline/validator.js'
import { MECHANICAL_RULES, JUDGEMENT_RULES } from '../src/pipeline/maintenance.js'
import { DEFECT_PATHS, DEFECT_GUIDANCE, RULE_PASSES, RUN_RULES } from '../src/pipeline/defect-paths.js'
import { evidenceFor, vaultReader, EVIDENCE_CHARS } from '../src/pipeline/defect-evidence.js'
import { resolveSubject } from '../src/api/routes/validation.js'

/**
 * Every defect has a path out of the list (TASKS-DEFECT-PATHS phase 1).
 *
 * The exhaustiveness the tables promise is a COMPILE-time property - `Record<ValidationRule, …>`
 * fails to build when a rule is added and not classified. What a test can still add is the
 * runtime half of it: that the record's keys and the rule union have not drifted apart through
 * a cast, and that the new classification and the old mechanical/judgement split disagree only
 * where they are meant to.
 */
describe('the repair-path classification', () => {
  it('covers every rule and nothing else', () => {
    expect(Object.keys(DEFECT_PATHS).sort()).toEqual([...ALL_RULES].sort())
    expect(Object.keys(DEFECT_GUIDANCE).sort()).toEqual([...ALL_RULES].sort())
  })

  it('agrees with itself: the guidance carries the same path as the table', () => {
    for (const rule of ALL_RULES) expect(DEFECT_GUIDANCE[rule].path, rule).toBe(DEFECT_PATHS[rule])
  })

  it('names a pass for exactly the rules classified as having one', () => {
    const withPass = ALL_RULES.filter((r) => DEFECT_PATHS[r] === 'pass').sort()
    expect(Object.keys(RULE_PASSES).sort()).toEqual(withPass)
    // `open-question-form` has a prompt and is NOT offered: its threshold run came in short
    // of the bar agreed before it (see the record in `defect-paths.ts`).
    expect([...RUN_RULES].sort()).toEqual(['page-schema', 'quote'])
  })

  /**
   * The two axes CROSS, and that is the point of building a third classification rather than
   * widening the existing one. Widening `MECHANICAL_RULES` to get the "fixable" block would
   * put judgement calls into a lint-fix agent prompt, which `lint-fix-routing.test.ts` exists
   * to prevent.
   */
  it('is a different question from the mechanical / judgement split', () => {
    // Judgement rules that nevertheless have a deterministic pass.
    for (const rule of ['tag-singleton', 'run-protocol'] as ValidationRule[]) {
      expect(JUDGEMENT_RULES.has(rule), rule).toBe(true)
      expect(DEFECT_PATHS[rule], rule).toBe('pass')
    }
    // Judgement rules phase 4 gives a bound run.
    for (const rule of ['quote', 'page-schema'] as ValidationRule[]) {
      expect(JUDGEMENT_RULES.has(rule), rule).toBe(true)
      expect(DEFECT_PATHS[rule], rule).toBe('run')
    }
    // Mechanical rules that get no button here at all: the lint-fix prompt is their path.
    for (const rule of ['frontmatter', 'dates', 'wrapped-link'] as ValidationRule[]) {
      expect(MECHANICAL_RULES.has(rule), rule).toBe(true)
      expect(DEFECT_PATHS[rule], rule).toBe('decision')
    }
  })

  it('never offers a button for the two the measurement showed reach nothing', () => {
    // `titleLinkPass` edits the pages that LINK to a drifted title, never the page the finding
    // stands on; the manifest repair cannot invent what an unnamed job directory held.
    expect(DEFECT_PATHS['title-name']).toBe('decision')
    expect(DEFECT_PATHS['address-map']).toBe('decision')
    expect(DEFECT_PATHS['near-duplicate']).toBe('decision')
  })

  it('keeps a rule whose run fell short of its threshold as a decision', () => {
    // The bar was agreed BEFORE the run precisely so it could be failed. The guidance says
    // what the run achieved and what was asked for, rather than hiding either.
    expect(DEFECT_PATHS['open-question-form']).toBe('decision')
    expect(DEFECT_GUIDANCE['open-question-form'].limit).toMatch(/agreed\s+before the run/)
  })

  it('says out loud what each partial path does not reach', () => {
    expect(DEFECT_GUIDANCE['run-protocol'].limit).toMatch(/five of the seven/)
    expect(DEFECT_GUIDANCE['title-name'].limit).toMatch(/LINKS/)
    expect(DEFECT_GUIDANCE['address-map'].limit).toMatch(/not derivable/)
    expect(DEFECT_GUIDANCE['quote'].limit).toMatch(/clears its own finding/)
  })
})

describe('the evidence column', () => {
  let db: Db
  let store: ValidationStore
  beforeEach(() => {
    db = openDb(MEMORY_DB)
    store = new ValidationStore(db)
  })

  it('is stored and read back', () => {
    store.record([{ rule: 'quote', path: 'wiki/a.md', message: 'quote not found', evidence: '{"quote":"x"}' }], 'job-1')
    expect(store.list()[0]!.evidence).toBe('{"quote":"x"}')
  })

  /**
   * THE LOAD-BEARING LINE. A producer that has no evidence must not erase what one that had it
   * wrote: the quote check holds the source text for the length of one ingest, and every later
   * reporter of the same finding - a maintenance run, the standing re-check - holds nothing.
   */
  it('is not erased by a later run that reports the same finding without it', () => {
    const withEvidence = { rule: 'quote', path: 'wiki/a.md', message: 'quote not found', evidence: '{"quote":"x"}' }
    store.record([withEvidence], 'job-1')
    store.record([{ rule: 'quote', path: 'wiki/a.md', message: 'quote not found' }], 'job-2')
    const row = store.list()[0]!
    expect(row.evidence).toBe('{"quote":"x"}')
    expect(row.count).toBe(2)
    expect(row.lastJobId).toBe('job-2')
  })

  it('is replaced when a later run DOES have one', () => {
    store.record([{ rule: 'quote', path: 'wiki/a.md', message: 'q', evidence: 'first' }], 'job-1')
    store.record([{ rule: 'quote', path: 'wiki/a.md', message: 'q', evidence: 'second' }], 'job-2')
    expect(store.list()[0]!.evidence).toBe('second')
  })

  it('backfills only where it is still empty, and moves no count', () => {
    store.record([{ rule: 'quote', path: 'wiki/a.md', message: 'q' }], 'job-1')
    const id = store.list()[0]!.id
    expect(store.setEvidence(id, 'filled')).toBe(true)
    expect(store.setEvidence(id, 'again')).toBe(false)
    const row = store.list()[0]!
    expect(row.evidence).toBe('filled')
    expect(row.count).toBe(1)
  })

  it('finds a finding by id whether or not it is resolved', () => {
    store.record([{ rule: 'orphan', path: 'wiki/a.md', message: 'nothing links here' }], 'job-1')
    const id = store.list()[0]!.id
    store.resolveMissing(['wiki/a.md'], [], { checked: new Set(['orphan']) })
    expect(store.list()).toHaveLength(0)
    expect(store.byId(id)?.id).toBe(id)
    expect(store.byId('nope')).toBeUndefined()
  })
})

describe('the paging the UI was missing', () => {
  it('returns the 51st row', () => {
    const db = openDb(MEMORY_DB)
    const store = new ValidationStore(db)
    store.record(
      Array.from({ length: 57 }, (_, i) => ({ rule: 'orphan', path: `wiki/p${i}.md`, message: 'nothing links here' })),
      'job-1',
    )
    expect(store.list({ limit: 50 })).toHaveLength(50)
    const tail = store.list({ limit: 50, offset: 50 })
    expect(tail).toHaveLength(7)
    // And no row appears in both halves.
    const first = new Set(store.list({ limit: 50 }).map((f) => f.id))
    for (const f of tail) expect(first.has(f.id)).toBe(false)
  })
})

describe('where a finding points', () => {
  const exists = (id: string): boolean => id === 'job-here'

  it('links a wiki page to the page', () => {
    expect(resolveSubject({ path: 'wiki/concepts/a.md' }, exists)).toEqual({ kind: 'page', path: 'wiki/concepts/a.md' })
  })

  it('links a .raw directory to the job the DIRECTORY NAME is', () => {
    expect(resolveSubject({ path: '.raw/job-here/' }, exists)).toEqual({ kind: 'job', jobId: 'job-here', exists: true })
    expect(resolveSubject({ path: '.raw/job-here' }, exists)).toEqual({ kind: 'job', jobId: 'job-here', exists: true })
  })

  it('says the job history no longer holds a run rather than rendering a dead link', () => {
    expect(resolveSubject({ path: '.raw/job-gone/' }, exists)).toEqual({ kind: 'job', jobId: 'job-gone', exists: false })
  })

  it('has no target for a finding about the vault as a whole', () => {
    const subject = resolveSubject({ path: '.vault-meta/hot.md' }, exists)
    expect(subject.kind).toBe('none')
  })
})

describe('the evidence one row shows', () => {
  let vault: string
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'))
    fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true })
  })

  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true })
    fs.writeFileSync(path.join(vault, rel), text, 'utf8')
  }

  it('shows the quotation in full and the part of it that does stand in the source', () => {
    const ev = evidenceFor(
      {
        rule: 'quote',
        path: 'wiki/a.md',
        message: 'quote not found in the source',
        evidence: JSON.stringify({ quote: 'the whole sentence as the page has it', matched: 'the whole sentence', words: 8, matchedWords: 3 }),
      },
      () => undefined,
    )
    expect(ev.source).toBe('stored')
    expect(ev.blocks[0]!.text).toBe('the whole sentence as the page has it')
    expect(ev.blocks[1]!.label).toMatch(/3 of 8 words/)
    expect(ev.blocks[1]!.text).toBe('the whole sentence')
  })

  it('says why a quote finding from before the column has nothing to show', () => {
    const ev = evidenceFor({ rule: 'quote', path: 'wiki/a.md', message: 'quote not found', evidence: null }, () => 'page')
    expect(ev.source).toBe('none')
    expect(ev.note).toMatch(/only the ingest holds/)
  })

  it('shows the headings a page has against the ones its type needs', () => {
    write('wiki/concepts/a.md', '---\ntype: concept\n---\n\n## Overview\n\ntext\n')
    const ev = evidenceFor(
      { rule: 'page-schema', path: 'wiki/concepts/a.md', message: 'a concept page needs ## Connections' },
      vaultReader(vault),
    )
    expect(ev.source).toBe('page')
    expect(ev.blocks[0]!.text).toContain('## Overview')
    expect(ev.blocks[1]!.text).toContain('## Connections')
  })

  it('names the offending open-question bullets, which the message only counts', () => {
    write(
      'wiki/concepts/b.md',
      '---\ntype: concept\n---\n\n## Open questions\n\n- What did the second trial measure?\n- Unclear in this pass whether the figure holds.\n',
    )
    const ev = evidenceFor(
      { rule: 'open-question-form', path: 'wiki/concepts/b.md', message: 'of 2 open question(s) on this page, 1 do(es) not ask anything' },
      vaultReader(vault),
    )
    expect(ev.blocks[0]!.label).toMatch(/1 of 2 open question/)
    expect(ev.blocks[0]!.text).toContain('Unclear in this pass')
    expect(ev.blocks[0]!.text).not.toContain('What did the second trial measure?')
  })

  it('names the tag and what dropping it does', () => {
    write('wiki/concepts/c.md', '---\ntype: concept\ntags: [solo]\n---\n\ntext\n')
    const ev = evidenceFor(
      { rule: 'tag-singleton', path: 'wiki/concepts/c.md', message: 'tag "solo" names exactly one page' },
      vaultReader(vault),
    )
    expect(ev.blocks[0]!.text).toBe('solo')
    expect(ev.blocks[1]!.text).toMatch(/groups one page with itself/)
  })

  it('falls back to the lines of the page the message names', () => {
    write('wiki/concepts/d.md', '---\ntype: concept\nstatus: ongoing\n---\n\ntext about "the thing" here\n')
    const ev = evidenceFor(
      { rule: 'status-vocabulary', path: 'wiki/concepts/d.md', message: 'status "the thing" is outside the vocabulary' },
      vaultReader(vault),
    )
    expect(ev.source).toBe('page')
    expect(ev.blocks[0]!.text).toContain('the thing')
  })

  it('cuts a long excerpt and says it was cut', () => {
    const ev = evidenceFor(
      { rule: 'quote', path: 'wiki/a.md', message: 'q', evidence: JSON.stringify({ quote: 'x'.repeat(900), matchedWords: 0 }) },
      () => undefined,
    )
    expect(ev.blocks[0]!.truncated).toBe(true)
    expect(ev.blocks[0]!.text).toHaveLength(EVIDENCE_CHARS + 1)
  })

  /**
   * The vault names its files after their titles, so a page path normally CONTAINS SPACES.
   * Measured against the live list: a pattern that stopped at the first space found nothing on
   * all six near-duplicate rows, which then rendered as "names no second page".
   */
  it('finds the other page of a near-duplicate even when its name has spaces in it', () => {
    const ev = evidenceFor(
      {
        rule: 'near-duplicate',
        path: 'wiki/concepts/One Page.md',
        message:
          'reads as the same subject as wiki/concepts/Another Page Name.md (similarity 0.913, above the vault\u2019s own error threshold) - one of them should extend the other',
        evidence: null,
      },
      () => undefined,
    )
    expect(ev.blocks[0]!.text).toBe('wiki/concepts/Another Page Name.md')
  })

  it('prefers a wikilink where the message writes one', () => {
    const ev = evidenceFor(
      { rule: 'near-duplicate', path: 'wiki/a.md', message: 'reads like [[Another Page]] does', evidence: null },
      () => undefined,
    )
    expect(ev.blocks[0]!.text).toBe('Another Page')
  })

  it('says a .raw directory has no page text rather than rendering empty', () => {
    const ev = evidenceFor({ rule: 'address-map', path: '.raw/job-1/', message: 'named in no source entry' }, vaultReader(vault))
    expect(ev.source).toBe('none')
    expect(ev.note).toMatch(/directory rather than a page/)
  })

  it('never reads outside the vault, whatever a stored path says', () => {
    expect(vaultReader(vault)('../../etc/passwd')).toBeUndefined()
  })
})
