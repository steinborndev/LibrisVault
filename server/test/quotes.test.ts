/**
 * Quote integrity (docs/sources/SPEC.md section 7): what counts as a quotation, what the two
 * sides are reduced to before they are compared, and what the check says about a job.
 *
 * The normalization cases are not invented: each one is an extraction artifact or a typography
 * the calibration over the live vault produced (section 7.6, and the record in
 * docs/tasks/TASKS-SOURCES.md).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  checkQuotes,
  extractQuotes,
  isBookkeepingPage,
  jobCorpus,
  normalizeQuoteText,
  quotableBody,
  quoteHolds,
  wordIndex,
  wordsOf,
  longestRun,
} from '../src/pipeline/quotes.js'
import { fenceArtifact, FENCE_NOTICE } from '../src/pipeline/preprocess/fence.js'

describe('what counts as a quotation (7.1)', () => {
  const quotes = (markdown: string): string[] => extractQuotes('wiki/sources/A.md', markdown).map((q) => q.text)

  it('reads all four typographies and nothing single-quoted', () => {
    expect(quotes('He wrote "the measurement held across every site" in the abstract.')).toEqual([
      'the measurement held across every site',
    ])
    expect(quotes('She wrote “the measurement held across every site” there.')).toEqual(['the measurement held across every site'])
    expect(quotes('Er schrieb „die Messung hielt an jedem Standort“ dort.')).toEqual(['die Messung hielt an jedem Standort'])
    expect(quotes('Il écrit «la mesure a tenu sur chaque site» ici.')).toEqual(['la mesure a tenu sur chaque site'])
    // Single quotes are not quotations: an apostrophe would make every sentence one.
    expect(quotes("He called it 'the measurement that held everywhere' once.")).toEqual([])
  })

  it('takes the text of a quote callout without its header line', () => {
    const page = [
      '## A claim',
      '',
      '> [!quote] The author, page 4',
      '> the measurement held across every site,',
      '> and the residual scatter stayed under one per cent',
      '',
      'Then the page goes on.',
    ].join('\n')
    expect(quotes(page)).toEqual(['the measurement held across every site, and the residual scatter stayed under one per cent'])
  })

  it('holds the five-word floor and drops a repeat', () => {
    expect(quotes('It was "four words only" here.')).toEqual([])
    expect(quotes('It was "exactly five words here now" once.')).toEqual(['exactly five words here now'])
    expect(quotes('Twice: "exactly five words here now" and "exactly five words here now".')).toHaveLength(1)
  })

  it('never reads a code fence, inline code or a callout header as a quotation', () => {
    const page = [
      '---',
      'title: "a page title in the frontmatter that is five words long"',
      '---',
      '',
      '```json',
      '{ "key": "a value that is five words long" }',
      '```',
      '',
      'Run `grep -o "five words of a pattern" file` over it.',
      '',
      '> [!contradiction] the page says "five words of a claim"',
      '> The source says otherwise.',
    ].join('\n')
    expect(quotes(page)).toEqual([])
  })

  it('does not let a stray quotation mark swallow a page', () => {
    const page = 'A sentence with one " mark.\n\nA second paragraph.\n\nA third " one much later.'
    expect(quotes(page)).toEqual([])
    expect(quotableBody('---\na: b\n---\n\nbody text').trim()).toBe('body text')
  })
})

describe('normalization (7.3)', () => {
  it('folds what an extraction changed and nothing that carries meaning', () => {
    // Hyphenation at a line end, a soft hyphen, a ligature, an en dash, curly quotes, and the
    // whitespace `pdftotext -layout` pads a column with.
    expect(normalizeQuoteText('transpor-\n   tation of the ﬁrst kind')).toBe('transportation of the first kind')
    expect(normalizeQuoteText('soft­hyphen inside')).toBe('softhyphen inside')
    expect(normalizeQuoteText('a range of 10–20 tokens')).toBe('a range of 10-20 tokens')
    expect(normalizeQuoteText('it’s the author’s "own" word')).toBe('it\'s the author\'s "own" word')
    expect(normalizeQuoteText('as shown [12] in the trial')).toBe('as shown in the trial')
    expect(normalizeQuoteText('as shown [12, 14] in the trial')).toBe('as shown in the trial')
    expect(normalizeQuoteText('  TWO   spaces\tand a tab ')).toBe('two spaces and a tab')
    // A number in brackets that is not a citation marker is left alone.
    expect(normalizeQuoteText('the array [0] holds it')).toBe('the array holds it')
  })
})

describe('matching (7.3)', () => {
  const corpus = wordIndex(
    'The trial enrolled 412 adults. The measurement held across every site, and the residual scatter stayed under one per cent. A later section repeats the figure.',
  )

  it('takes a verbatim quote and refuses an invented one', () => {
    expect(quoteHolds(('the measurement held across every site'), corpus)).toBe(true)
    expect(quoteHolds(('the measurement failed at two of the sites'), corpus)).toBe(false)
  })

  it('takes an ellipsis quote in order and refuses one out of order', () => {
    expect(quoteHolds(('the trial enrolled 412 adults ... the residual scatter stayed under one per cent'), corpus)).toBe(true)
    expect(quoteHolds(('the trial enrolled 412 adults […] the residual scatter stayed under one per cent'), corpus)).toBe(true)
    // Backwards: the second half comes BEFORE the first in the document.
    expect(quoteHolds(('the residual scatter stayed under one per cent ... the trial enrolled 412 adults'), corpus)).toBe(false)
  })

  it('skips a fragment of fewer than three words instead of failing on it', () => {
    expect(quoteHolds(('the measurement held across every site ... repeats'), corpus)).toBe(true)
  })

  it('ignores punctuation at the edges of a quotation, which belongs to the quoting page', () => {
    // The comma inside the marks is the page's ("A Paper Title Someone Cited,").
    expect(quoteHolds(('the measurement held across every site,'), corpus)).toBe(true)
    expect(quoteHolds(('the trial enrolled 412 adults.'), corpus)).toBe(true)
  })
})

describe('what the second calibration round found (7.6)', () => {
  it('ignores the quotation marks the source puts around one word of the sentence', () => {
    // The source marks a term mid-sentence; the page quotes the sentence without the marks.
    const corpus = wordIndex('The trial called this the “index” event of the series.')
    expect(quoteHolds('the index event of the series', corpus)).toBe(true)
  })

  it('ignores punctuation inside a quotation as well as at its edges', () => {
    const corpus = wordIndex('It held everywhere - and the scatter stayed small.')
    expect(quoteHolds('It held everywhere, and the scatter stayed small', corpus)).toBe(true)
    expect(quoteHolds('"It held everywhere - and the scatter stayed small."', corpus)).toBe(true)
  })

  it('reads a word broken across a column, and a number the way both sides write it', () => {
    const corpus = wordIndex('about 1,500 pull requests in one-tenth of the time')
    expect(quoteHolds('about 1,500 pull requests in one tenth of the time', corpus)).toBe(true)
  })

  it('says how much of a failing quote IS there', () => {
    const corpus = wordIndex('The measurement held across every site in the campaign.')
    // One word wrong at the end: a misquote, and the number says so.
    // Eight of nine: the corpus continues "in the campaign", so only the last word differs.
    expect(longestRun('the measurement held across every site in the trial', corpus)).toBe(8)
    // Not one word of it: an invention.
    expect(longestRun('a completely different sentence nobody wrote', corpus)).toBe(0)
    expect(wordsOf('the measurement held across every site in the trial')).toHaveLength(9)
  })

  it('does not let a German closing mark pair with an English one across a page', () => {
    /*
     * `„…“` closes with the character `“…”` opens with, so a German quotation followed later by
     * an English closing mark could form one span over everything between them.
     */
    const page = [
      'Er schrieb „die Messung hielt an jedem Standort“ dort.',
      '',
      'Much later the page writes “an English quotation of five words” as well.',
    ].join('\n')
    const found = extractQuotes('wiki/sources/A.md', page).map((q) => q.text)
    expect(found).toContain('die Messung hielt an jedem Standort')
    expect(found).toContain('an English quotation of five words')
    // Nothing in between was swallowed: two quotations, neither reaching across the page.
    expect(found).toHaveLength(2)
    expect(found.some((q) => q.includes('Much later') || q.includes('as well'))).toBe(false)
  })
})

describe('the check over a job (7.2, 7.4)', () => {
  let vaultRoot: string

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-'))
  })
  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  /** Writes a job's artifact the way preprocessing does, fence and all. */
  const artifact = (jobId: string, text: string, name = 'normalized.md'): void => {
    const dir = path.join(vaultRoot, '.raw', jobId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ jobId, type: 'web', original: 'raw.html', normalized: name }))
    // The real fence, so the corpus is taken off the artifact the pipeline actually writes.
    fs.writeFileSync(
      path.join(dir, name),
      fenceArtifact({
        title: 'https://publisher.example/a',
        banner: ['Text from an open-access copy (publishedVersion) at repository.example: https://repository.example/x.'],
        source: 'https://publisher.example/a',
        kind: 'web',
        text,
      }),
    )
  }
  const page = (rel: string, body: string): string => {
    fs.mkdirSync(path.dirname(path.join(vaultRoot, rel)), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, rel), body)
    return rel
  }

  it('reports the invented quote, keeps the held one, and counts both', async () => {
    artifact('job-1', 'The measurement held across every site, and the scatter stayed under one per cent.')
    const rel = page(
      'wiki/sources/A.md',
      '# A\n\nThe author states that "the measurement held across every site" and adds that "the funding came from three agencies".\n',
    )
    const out = await checkQuotes({ vaultRoot, jobIds: ['job-1'], pages: [rel], before: async () => null })
    expect(out.summary).toEqual({ checked: 2, unverified: 1 })
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]).toMatchObject({ rule: 'quote', path: rel })
    // The longest run rides along, so a misquote reads differently from an invention (7.4).
    expect(out.findings[0]!.message).toBe(
      'quote not found in the source: "the funding came from three agencies" (longest match 1 of 6 words)',
    )
  })

  it('checks only what THIS run added to a page', async () => {
    artifact('job-1', 'The measurement held across every site.')
    const rel = page(
      'wiki/concepts/B.md',
      '# B\n\nAn earlier run wrote "a quote nobody can check any more" here.\n\nThis run adds "the measurement held across every site".\n',
    )
    const before = async (): Promise<string> => '# B\n\nAn earlier run wrote "a quote nobody can check any more" here.\n'
    const out = await checkQuotes({ vaultRoot, jobIds: ['job-1'], pages: [rel], before })
    // The older quote is not this job's business, and its document is long gone.
    expect(out.summary).toEqual({ checked: 1, unverified: 0 })
  })

  it('says why it checked nothing: no commit, no artifact, and a bookkeeping page', async () => {
    const rel = page('wiki/sources/C.md', '# C\n\nIt says "five words of a quotation here".\n')
    expect((await checkQuotes({ vaultRoot, jobIds: ['job-1'], pages: [rel] })).summary.note).toMatch(/no commit/)
    // A commit, but the job's `.raw/` is gone (an old job, an image, a deferred file).
    expect((await checkQuotes({ vaultRoot, jobIds: ['job-1'], pages: [rel], before: async () => null })).summary).toEqual({
      checked: 0,
      unverified: 0,
      note: 'no readable artifact for this job',
    })
    // The vault's journal and indexes are out of scope: a run narrates there in quotation marks.
    artifact('job-1', 'nothing relevant')
    const log = page('wiki/log.md', '# Log\n\nThe run decided to "fold this into an overlapping page".\n')
    expect((await checkQuotes({ vaultRoot, jobIds: ['job-1'], pages: [log], before: async () => null })).summary.checked).toBe(0)
    expect(isBookkeepingPage('wiki/log.md')).toBe(true)
    expect(isBookkeepingPage('wiki/meta/reading-list.md')).toBe(true)
    expect(isBookkeepingPage('wiki/sources/_index.md')).toBe(true)
    expect(isBookkeepingPage('wiki/sources/A Paper.md')).toBe(false)
  })

  it('reads the union of a batch and strips the fence and the banner from each member', async () => {
    artifact('job-1', 'The first document states the measurement held across every site.')
    artifact('job-2', 'The second document reports that the scatter stayed under one per cent.')
    const rel = page(
      'wiki/sources/D.md',
      '# D\n\nOne says "the measurement held across every site" and the other "the scatter stayed under one per cent".\n',
    )
    const out = await checkQuotes({ vaultRoot, jobIds: ['job-1', 'job-2'], pages: [rel], before: async () => null })
    expect(out.summary).toEqual({ checked: 2, unverified: 0 })
    // The service's own words inside the artifact are not part of the corpus.
    const corpus = (await jobCorpus(vaultRoot, ['job-1'])).index
    expect(corpus).not.toContain(wordIndex(FENCE_NOTICE.slice(0, 60)).trim())
    expect(corpus).not.toMatch(/untrusted/)
    // Nor is the banner: the copy's address is the service's note, not the document's words.
    expect(corpus).not.toMatch(/open-access copy/)
  })
})
