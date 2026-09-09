/**
 * The address-repair tool's judgment (cli/backfill-sources.ts).
 *
 * The tool edits frontmatter in pages it did not write, and each edit becomes a commit in the
 * user's vault. What is tested here is therefore mostly what it REFUSES: values that look like
 * addresses but are not, positions it will not invent, and rewrites that reach past the one
 * line they are allowed to touch.
 */

import { describe, it, expect } from 'vitest'
import {
  addressFromReadingList,
  addressInside,
  isUsableAddress,
  subjectAddress,
  touchesOnlyUrl,
  urlField,
  withAddress,
} from '../src/cli/backfill-sources.js'

const page = (front: string): string => `---\n${front}\n---\n\n# Title\n\nBody text.\n`

describe('urlField', () => {
  it('reads the value unquoted, and tells "empty" apart from "absent"', () => {
    expect(urlField(page('type: source\nurl: "https://example.org/a"'))).toBe('https://example.org/a')
    expect(urlField(page('type: source\nurl: ""'))).toBe('')
    expect(urlField(page('type: source\ntitle: x'))).toBeNull()
  })

  it('does not read a url out of the body', () => {
    // The body cites other people's addresses; only the frontmatter states the page's own.
    const p = `---\ntype: source\n---\n\nSee https://example.org/somebody-elses-paper for context.\n`
    expect(urlField(p)).toBeNull()
  })
})

describe('isUsableAddress', () => {
  it('accepts a bare address and nothing else', () => {
    expect(isUsableAddress('https://example.org/a')).toBe(true)
    expect(isUsableAddress('http://example.org/a')).toBe(true)
  })

  it('rejects the shapes that actually occurred', () => {
    // Readable by a human, invisible to a matcher that compares the field literally.
    expect(isUsableAddress('local file: .raw/j1/x.pdf (example.org/media/123)')).toBe(false)
    expect(isUsableAddress('unknown')).toBe(false)
    expect(isUsableAddress('null')).toBe(false)
    expect(isUsableAddress('')).toBe(false)
    expect(isUsableAddress(null)).toBe(false)
  })
})

describe('addressInside', () => {
  it('promotes a bracketed host/path to a real address', () => {
    expect(addressInside('local file: .raw/j1/x.pdf (example.org/media/123)')).toBe('https://example.org/media/123')
  })

  it('will not read a filename as a host', () => {
    // The bracket has to hold a host AND a path. `(report.pdf)` is a file, not an address, and
    // a tool that turns it into `https://report.pdf` has invented one.
    expect(addressInside('local file: .raw/j1/report.pdf (report.pdf)')).toBeUndefined()
    expect(addressInside('unknown')).toBeUndefined()
    expect(addressInside('see the appendix (page 4)')).toBeUndefined()
  })

  it('has nothing to do on a value that is already an address', () => {
    expect(addressInside('https://example.org/a')).toBeUndefined()
  })
})

describe('addressFromReadingList', () => {
  const list = [
    'https://www.example.org/media/155931/download',
    'https://www.elsewhere.org/en/documents/report_en.pdf',
    'https://www.example.org/other',
  ]

  it('completes a fragment the page states into the address the list holds', () => {
    // The page says `example.org/media/155931`; the list says the same address WITH the `www.`
    // and the trailing segment. Promoting the fragment alone would produce a url that no
    // longer matches the entry, which is the whole point of repairing the field.
    expect(addressFromReadingList('local file: .raw/j1/x.pdf (example.org/media/155931)', list)).toBe(
      'https://www.example.org/media/155931/download',
    )
  })

  it('matches on the filename of the raw document', () => {
    // A browser names a download after the last segment of the url it came from.
    expect(addressFromReadingList('local file: .raw/j1/report_en.pdf', list)).toBe(
      'https://www.elsewhere.org/en/documents/report_en.pdf',
    )
  })

  it('treats two matches as no evidence at all', () => {
    expect(addressFromReadingList('local file: .raw/j1/x.pdf (example.org/)', list)).toBeUndefined()
  })

  it('has nothing to say about a value with no fragment, or an empty list', () => {
    expect(addressFromReadingList('unknown', list)).toBeUndefined()
    expect(addressFromReadingList('local file: .raw/j1/x.pdf (example.org/media/155931)', [])).toBeUndefined()
    expect(addressFromReadingList('https://www.example.org/other', list)).toBeUndefined()
  })
})

describe('subjectAddress', () => {
  it('takes the address from an ingest commit and only from one', () => {
    expect(subjectAddress('ingest: https://example.org/a')).toBe('https://example.org/a')
    // A file ingest names a file. There is no address to take, and the filename is not one.
    expect(subjectAddress('ingest: some-report.pdf')).toBeUndefined()
    // A research run writes source pages too, and its subject says nothing about an origin.
    expect(subjectAddress('maintenance: research')).toBeUndefined()
    expect(subjectAddress('edit: Some Page')).toBeUndefined()
  })
})

describe('withAddress', () => {
  it('replaces an existing url line in place', () => {
    const before = page('type: source\nurl: "unknown"\nconfidence: medium')
    const after = withAddress(before, 'https://example.org/a')!
    expect(after).toContain('url: "https://example.org/a"')
    expect(after).not.toContain('unknown')
    expect(after).toContain('confidence: medium')
  })

  it('inserts a missing url where the schema puts it', () => {
    const before = page('type: source\nsource_type: paper\ndate_published: 2026-01-01\nconfidence: medium')
    const after = withAddress(before, 'https://example.org/a')!
    expect(after).toContain('date_published: 2026-01-01\nurl: "https://example.org/a"\nconfidence: medium')
  })

  it('falls back through the anchors, and gives up rather than guessing a position', () => {
    expect(withAddress(page('type: source\nsource_type: paper'), 'https://example.org/a')).toContain(
      'source_type: paper\nurl: "https://example.org/a"',
    )
    // No frontmatter at all: there is no right place to put it, so the tool declines.
    expect(withAddress('# Just a heading\n', 'https://example.org/a')).toBeUndefined()
    expect(withAddress(page('type: source'), 'https://example.org/a')).toBeUndefined()
  })
})

describe('touchesOnlyUrl', () => {
  it('passes a replacement and an insertion of the url line', () => {
    const a = page('type: source\nurl: "unknown"')
    expect(touchesOnlyUrl(a, withAddress(a, 'https://example.org/a')!)).toBe(true)
    const b = page('type: source\ndate_published: 2026-01-01')
    expect(touchesOnlyUrl(b, withAddress(b, 'https://example.org/a')!)).toBe(true)
  })

  it('refuses a rewrite that reached past the url line', () => {
    const before = page('type: source\nurl: "unknown"\nconfidence: medium')
    // What a too-greedy regex produces: the url is right and the body is gone.
    expect(touchesOnlyUrl(before, `---\ntype: source\nurl: "https://example.org/a"\n---\n`)).toBe(false)
    // A second field changed alongside it, which this tool has no business doing.
    const twoLines = before.replace('url: "unknown"', 'url: "https://example.org/a"').replace('medium', 'high')
    expect(touchesOnlyUrl(before, twoLines)).toBe(false)
  })

  it('refuses a no-op, so an empty commit is never proposed', () => {
    const a = page('type: source\nurl: "https://example.org/a"')
    expect(touchesOnlyUrl(a, a)).toBe(false)
  })
})
