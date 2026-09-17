/**
 * Where a document came from, told to the ingest run (system-prompt.ts `renderProvenance`).
 *
 * Written 2026-09-09 after a hand-dropped regulatory report was ingested and the reading list
 * never noticed it had arrived. All five of its matching routes failed, and the one that
 * should have caught it - a source page recording the document's address - failed for a
 * reason worth encoding in tests: the page HAD the address, written into `url:` as a sentence
 * with the address in brackets inside it. A reader sees it; the duplicate check compares the
 * field literally and matches nothing.
 *
 * Hence the two things asserted here: the address reaches the run at all, and the run is told
 * the shape to write it in.
 */

import { describe, it, expect } from 'vitest'
import { renderProvenance } from '../src/pipeline/system-prompt.js'

describe('renderProvenance', () => {
  it('states the address the service knows, against the artifact it belongs to', () => {
    const block = renderProvenance([{ artifact: '.raw/j1/normalized.md', url: 'https://example.org/media/155931/download' }])
    expect(block).toContain('<provenance>')
    expect(block).toContain('</provenance>')
    expect(block).toContain('.raw/j1/normalized.md: https://example.org/media/155931/download')
    // `url:` is the source schema's own field for the page's address.
    expect(block).toContain('`url:`')
  })

  it('says plainly when there is no address, rather than leaving the run to guess', () => {
    const block = renderProvenance([{ artifact: '.raw/j2/normalized.md', url: null }])
    expect(block).toContain('handed over as a file; the service has no address for it')
    // A file drop can still carry its own address on its title page - that is worth having.
    expect(block).toMatch(/canonical address/i)
    expect(block).toMatch(/never a guess/i)
  })

  it('rules out the shapes that actually turned up in the vault', () => {
    const block = renderProvenance([{ artifact: 'a', url: null }])
    // A sentence with the address inside it - three pages had exactly this.
    expect(block).toContain('bare address and nothing else')
    // Placeholder words where an empty field was meant.
    expect(block).toContain('`unknown`')
    // The staging path: a location on this disk, not an address.
    expect(block).toContain('`.raw/`')
  })

  it('leaves `sources:` alone, because the vault schema already uses it', () => {
    // `sources:` is the universal field holding the `[[.raw/...]]` link to the raw file the
    // page was made from. An address written there would be in the wrong field AND would
    // displace the link the schema asks for.
    const block = renderProvenance([{ artifact: 'a', url: 'https://example.org/x' }])
    expect(block).toContain('do not\nput an address there')
  })

  it('keeps each member of a batch on its own origin', () => {
    /*
     * A batch is several documents in one run. One shared address would file the wrong origin
     * on all but one of them, which is worse than filing none.
     */
    const block = renderProvenance([
      { artifact: '.raw/j1/a.md', url: 'https://example.org/a.pdf' },
      { artifact: '.raw/j2/b.md', url: null },
      { artifact: '.raw/j3/c.md', url: 'https://example.org/c.pdf' },
    ])
    expect(block).toContain('.raw/j1/a.md: https://example.org/a.pdf')
    expect(block).toContain('.raw/j2/b.md: handed over as a file')
    expect(block).toContain('.raw/j3/c.md: https://example.org/c.pdf')
  })

  it('renders nothing at all when there is nothing to say', () => {
    // An empty block would still cost tokens and would read as an instruction with no content.
    expect(renderProvenance([])).toBe('')
  })
})
