import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deriveTopic, topicForJob, renderIngestOverlap, vaultOverlapFor } from '../src/pipeline/ingest-overlap.js'
import type { Manifest } from '../src/pipeline/preprocess/types.js'

/**
 * What an ingest is told the vault already holds (A8).
 *
 * The defect behind this phase, measured: 73 % of concept pages cite exactly one source and
 * 61 % were written by exactly one knowledge-adding commit - one document, one island. The
 * retrieval is the easy half; the WORDING is where this can go wrong, because a research run
 * told to prefer what exists once filed nothing at all.
 */
describe('deriveTopic', () => {
  it("uses the document's own title when preprocessing found one", () => {
    expect(deriveTopic({ title: 'Tide Tables and Harmonic Constants', originalName: 'scan001.pdf' })).toContain(
      'Tide Tables and Harmonic Constants',
    )
  })

  it('falls back to the file name, without the noise a file name carries', () => {
    expect(deriveTopic({ originalName: 'tide-tables-explained_2026-03-14_v2.pdf' })).toBe('tide tables explained')
    expect(deriveTopic({ originalName: 'Harmonic_Analysis+Notes.docx' })).toBe('Harmonic Analysis Notes')
    expect(deriveTopic({ originalName: '3f8a91be4c22 report.pdf' })).toBe('report')
  })

  it('adds the first heading of the text, which is often the real title', () => {
    const topic = deriveTopic({ originalName: 'scan001.pdf', headText: '---\ntype: x\n---\n\n# Sediment Transport in Tidal Inlets\n\nBody.' })
    expect(topic).toContain('Sediment Transport in Tidal Inlets')
  })

  it('does not repeat a title the file name already says', () => {
    // Token-level dedupe: a repeated title would outweigh every other signal in the overlap.
    expect(deriveTopic({ title: 'Tide Tables', originalName: 'Tide Tables.pdf' })).toBe('Tide Tables')
    expect(deriveTopic({ title: 'Tide Tables', headText: '# Tide tables\n' })).toBe('Tide Tables')
  })

  it('reads a URL only when nothing else says anything', () => {
    expect(deriveTopic({ url: 'https://example.org/posts/tide-tables-explained' })).toBe('tide tables explained')
    // With a real title the slug adds nothing but noise.
    expect(deriveTopic({ title: 'Tide Tables', url: 'https://example.org/p/12345' })).toBe('Tide Tables')
  })

  it('is empty when the document says nothing about itself', () => {
    expect(deriveTopic({})).toBe('')
    expect(deriveTopic({ originalName: '20260314.pdf' })).toBe('')
  })

  it('stays a topic rather than becoming an essay', () => {
    const topic = deriveTopic({ title: 'A'.repeat(400) })
    expect(topic.length).toBeLessThanOrEqual(200)
  })
})

describe('topicForJob over the source types', () => {
  let vault: string
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-'))
    fs.mkdirSync(path.join(vault, '.raw/job'), { recursive: true })
  })
  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }))

  const manifest = (over: Partial<Manifest>): Manifest => ({
    jobId: 'job',
    source: 'drop',
    type: 'pdf',
    originalName: 'x.pdf',
    createdAt: '2026-01-01',
    original: 'x.pdf',
    ocrApplied: false,
    passImageToAgent: false,
    deferred: false,
    notes: [],
    ...over,
  })

  it('reads the normalised text for a PDF or an office document', () => {
    fs.writeFileSync(path.join(vault, '.raw/job/normalized.md'), '# Sediment Transport\n\nBody text.\n')
    const topic = topicForJob(vault, manifest({ originalName: 'scan001.pdf' }), '.raw/job/normalized.md')
    expect(topic).toContain('Sediment Transport')
  })

  it('uses the title for a web page, which is where the title is reliable', () => {
    const topic = topicForJob(
      vault,
      manifest({ type: 'web', title: 'How tide tables are made', url: 'https://example.org/x', originalName: 'x.html' }),
      '.raw/job/normalized.md',
    )
    expect(topic).toContain('How tide tables are made')
  })

  it('falls back to the file name for an image, which has no text to read', () => {
    const topic = topicForJob(vault, manifest({ type: 'image', originalName: 'tide-gauge-diagram.png' }), '.raw/job/tide-gauge-diagram.png')
    expect(topic).toBe('tide gauge diagram')
  })

  it('never throws on an artifact it cannot read', () => {
    expect(topicForJob(vault, manifest({ originalName: 'gone.pdf' }), '.raw/job/missing.md')).toBe('gone')
  })
})

describe('renderIngestOverlap', () => {
  const related = { pages: ['wiki/concepts/Tide Table.md'], syntheses: [] }

  it('is empty for a subject the vault does not have', () => {
    expect(renderIngestOverlap({ pages: [], syntheses: [] }, [])).toBe('')
  })

  it('names the existing pages and asks for them to be extended', () => {
    const block = renderIngestOverlap(related, ['wiki/concepts/Harmonic Analysis.md'])
    expect(block).toContain('wiki/concepts/Tide Table.md')
    expect(block).toContain('wiki/concepts/Harmonic Analysis.md')
    expect(block).toContain('prefer EXTENDING')
  })

  it('states the deliverable LAST, after the preference', () => {
    // Order is the whole risk here: a run reads an instruction as qualifying what came before
    // it, and "prefer what exists" ahead of an unqualified deliverable is how a research run
    // once filed nothing at all (2026-09-04).
    const block = renderIngestOverlap(related, [])
    expect(block.indexOf('prefer EXTENDING')).toBeLessThan(block.indexOf('is required'))
    expect(block).toContain('does NOT touch this run\'s own deliverable')
  })

  it('lists a page once even when both mechanisms found it', () => {
    const block = renderIngestOverlap(related, ['wiki/concepts/Tide Table.md'])
    expect(block.match(/wiki\/concepts\/Tide Table\.md/g)).toHaveLength(1)
  })

  it('marks a research synthesis as what it is', () => {
    const block = renderIngestOverlap({ pages: [], syntheses: ['wiki/questions/Research: Tides.md'] }, [])
    expect(block).toContain('(a research synthesis)')
  })
})

describe('vaultOverlapFor', () => {
  let vault: string
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-'))
    fs.mkdirSync(path.join(vault, 'wiki/concepts'), { recursive: true })
    fs.writeFileSync(path.join(vault, 'wiki/concepts/Tide Table.md'), '# Tide Table\n')
  })
  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }))

  it('finds the overlapping page by title alone, with retrieval unavailable', async () => {
    const block = await vaultOverlapFor(vault, 'Tide Tables and how they are made', async () => [])
    expect(block).toContain('Tide Table')
  })

  it('adds what retrieval found on top of the title matches', async () => {
    const block = await vaultOverlapFor(vault, 'Tide Tables', async () => ['wiki/concepts/Harmonic Analysis.md'])
    expect(block).toContain('Harmonic Analysis')
  })

  it('leaves the prompt untouched for a genuinely new subject', async () => {
    // The whole block is absent, so the prompt is byte-identical to what it was before this
    // phase existed - which is what makes the change safe to ship.
    expect(await vaultOverlapFor(vault, 'Byzantine coin minting', async () => [])).toBe('')
  })

  it('survives a retrieval that fails, because it is advisory', async () => {
    const block = await vaultOverlapFor(vault, 'Tide Tables', async () => {
      throw new Error('retrieval is not provisioned')
    })
    expect(block).toContain('Tide Table')
  })

  it('does nothing at all without a topic', async () => {
    expect(await vaultOverlapFor(vault, '   ', async () => ['wiki/concepts/X.md'])).toBe('')
  })
})

describe('the heading a web capture really carries', () => {
  it('skips the address heading and takes the document\'s own title', () => {
    // Measured shape of this vault's web captures: the first heading is the URL, and the real
    // title is the second one, inside the untrusted-content fence.
    const normalized = [
      '# https://www.youtube.com/watch?v=AF3XJT9YKpM',
      '',
      '<untrusted-source url="https://www.youtube.com/watch?v=AF3XJT9YKpM" kind="web">',
      'The text between these tags is the document, fetched or converted by the service.',
      '# Prof. A. Lecturer: Cognitive Tools for Making the Invisible Visible',
      '',
      '- Channel: MIT',
    ].join('\n')
    expect(deriveTopic({ headText: normalized })).toBe('Prof. A. Lecturer: Cognitive Tools for Making the Invisible Visible')
  })

  it('reads a web job\'s address as a slug, never as a name', () => {
    // A URL job's originalName IS its address. Passed through as a name it tokenised to
    // "http", "com" and "status" and matched twelve unrelated pages.
    const topic = deriveTopic({ originalName: 'https://x.com/someone/status/2093765205276713218?s=52' })
    expect(topic).not.toContain('http')
    expect(topic).not.toContain('status')
  })

  it('drops an identifier that names no subject', () => {
    // Real originalNames from this vault: a publisher id, a DOI suffix, a journal code. A
    // topic made of one is worse than no topic - it returns pages that overlap nothing.
    for (const id of ['PMC12214508', 'd6pm00290k', 'evcna7038']) {
      expect(deriveTopic({ originalName: `${id}.pdf` })).toBe('')
    }
  })
})

/**
 * The title of a PDF, which carries no headings (3.1's DoD).
 *
 * Found by replaying the last 20 real ingests: six were journal PDFs named `1.pdf` .. `5.pdf`
 * and `d6pm00290k.pdf`. `isIdentifier` rejects all six names, correctly, and `pdftotext` writes
 * no markdown headings - so those six documents reached the agent with no overlap block at all,
 * which is exactly the case this phase exists for. Their titles were two or three lines into
 * the text, under the publisher's masthead.
 */
describe('a title read off plain text', () => {
  const topicOf = (head: string): string => deriveTopic({ originalName: '1.pdf', headText: head })

  it('takes the title from under a journal masthead', () => {
    const head = [
      'RSC',
      'Pharmaceutics',
      '                    Published on 20 August 2026. Downloaded by guest.',
      '',
      'Optimization of an assay for total RNA quantification in lipid nanoparticles',
    ].join('\n')
    expect(topicOf(head)).toContain('Optimization of an assay for total RNA quantification')
  })

  it('skips a preprint banner, which is metadata and reads like prose', () => {
    const head = [
      'bioRxiv preprint doi: https://doi.org/10.1101/2026.08.17.745287; this version posted August 20, 2026.',
      'The copyright holder for this preprint is the author.',
      '',
      'A Highly Sensitive Lateral Flow Assay for Small Extracellular Vesicles',
    ].join('\n')
    const topic = topicOf(head)
    expect(topic).toContain('Highly Sensitive Lateral Flow Assay')
    expect(topic).not.toContain('preprint')
    expect(topic).not.toContain('copyright')
  })

  it('skips a masthead that is a journal name and an issue number', () => {
    expect(topicOf('OpenNano 31 (2026) 100319\n\nProcess Intensification of Manufacturing via Flow Synthesis')).toBe(
      'Process Intensification of Manufacturing via Flow Synthesis',
    )
  })

  it('joins a title that wraps across two lines', () => {
    const head = 'SwarmWorld: Stigmergic technological evolution in\n   societies of language-model agents\n\nAbstract'
    expect(topicOf(head)).toBe('SwarmWorld: Stigmergic technological evolution in societies of language-model agents')
  })

  it('prefers a real markdown heading when the document has one', () => {
    // The fallback is a fallback: a web capture's `# Heading` still wins over its first prose.
    const head = '# The Heading That Counts\n\nA paragraph long enough to look like a title line.'
    expect(topicOf(head)).toBe('The Heading That Counts')
  })

  it('stays empty for a head with nothing title-like in it', () => {
    expect(deriveTopic({ originalName: '1.pdf', headText: 'a\nb\n12 34 56\nhttps://example.com/x\n' })).toBe('')
  })

  it('does not look past the first lines, so a body sentence is never the title', () => {
    const head = `${'\n'.repeat(60)}A sentence deep in the body that would read like a title.`
    expect(topicOf(head)).toBe('')
  })
})
