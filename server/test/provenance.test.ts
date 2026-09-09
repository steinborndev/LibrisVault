/**
 * Where a document came from, told to the ingest run (system-prompt.ts `renderProvenance`).
 *
 * Written 2026-09-09 after a hand-dropped regulatory report was ingested and the reading list
 * never noticed it had arrived. All five of its matching routes failed, each for its own reason,
 * and the one that would have caught it - a source page recording the document's address -
 * failed because the page recorded none. It could not: the ingest prompt is `ingest <path>` and
 * nothing else, so the run was never told the address even when the job had one.
 *
 * Measured on the vault before this block existed: 210 of 281 source pages carried no address
 * under `sources:`, and of the pages whose job DID know a url, only about half carried it.
 */

import { describe, it, expect } from 'vitest'
import { renderProvenance } from '../src/pipeline/system-prompt.js'

describe('renderProvenance', () => {
  it('states the address the service knows, against the artifact it belongs to', () => {
    const block = renderProvenance([{ artifact: '.raw/j1/normalized.md', url: 'https://example.org/media/155931/download' }])
    expect(block).toContain('<provenance>')
    expect(block).toContain('</provenance>')
    expect(block).toContain('.raw/j1/normalized.md: https://example.org/media/155931/download')
    expect(block).toContain('`sources:`')
  })

  it('says plainly when there is no address, rather than leaving the run to guess', () => {
    const block = renderProvenance([{ artifact: '.raw/j2/normalized.md', url: null }])
    expect(block).toContain('handed over as a file; the service has no address for it')
    // A file drop can still carry its own address on its title page - that is worth having.
    expect(block).toMatch(/canonical address/i)
    expect(block).toMatch(/never a guess/i)
  })

  it('forbids the staging path, which one page had recorded as its source', () => {
    // A `- "[[.raw/<job-id>/normalized.md]]"` line stood under `sources:` on a real page: not
    // an address, and deleted with the job.
    expect(renderProvenance([{ artifact: 'a', url: null }])).toContain('`.raw/`')
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
