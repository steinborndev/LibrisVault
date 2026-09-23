/**
 * The naming pass of a domain split (docs/tasks/TASKS-DOMAIN-SPLIT.md 6.2): its prompt carries
 * the shelves and the existing keys and asks for no edit, and its parser reads the fixed block
 * format leniently, like `parseDomainReview`. That the run is read-only is proven at the route
 * (`domain-split-route.test.ts`, the `query` profile through the read-only path), not here: the
 * sentence in the prompt is courtesy, the profile is the guarantee.
 */
import { describe, it, expect } from 'vitest'
import { parseSplitNaming, plainText, splitNamingPrompt, SPLIT_NAMING_FORMAT, type NamingInput } from '../src/pipeline/split-naming.js'

const INPUT: NamingInput = {
  parent: { key: 'alpha', description: 'Everything alpha.', tags: ['one', 'two'] },
  otherKeys: ['beta', 'gamma'],
  shelves: [
    { n: 1, size: 40, tags: ['one'], frequentTags: ['one'], landmarks: [{ title: 'Page A01', path: 'wiki/concepts/Page A01.md' }] },
    { n: 2, size: 30, tags: ['two'], frequentTags: [], landmarks: [{ title: 'Page B01', path: 'wiki/concepts/Page B01.md' }] },
  ],
}

describe('splitNamingPrompt', () => {
  const prompt = splitNamingPrompt(INPUT)

  it('carries every shelf with its evidence, the parent, and every existing key', () => {
    expect(prompt).toContain('## shelf 1\n40 pages')
    expect(prompt).toContain('## shelf 2\n30 pages')
    expect(prompt).toContain('Page A01 (wiki/concepts/Page A01.md)')
    expect(prompt).toContain('tags too frequent to be the key: one')
    expect(prompt).toContain('`alpha` - Everything alpha.')
    expect(prompt).toContain('- beta\n- gamma')
  })

  it('asks for no edit, coined keys, plain text, and the fixed answer format', () => {
    expect(prompt).toContain('Do NOT edit any file')
    expect(prompt).toContain('No wikilinks')
    expect(prompt).toMatch(/do NOT copy a tag/)
    expect(prompt.endsWith(SPLIT_NAMING_FORMAT)).toBe(true)
  })
})

describe('parseSplitNaming', () => {
  it('reads a well-formed answer', () => {
    const out = parseSplitNaming(
      [
        '## shelf 1',
        'key: first-subject',
        'description: The first subject, not the second.',
        'tags: one, `extra`',
        '',
        '## shelf 2',
        'key: second-subject',
        'description: The second.',
        'tags: two',
        '',
        '## parent',
        'description: Alpha without the two shelves.',
        'tags: three',
      ].join('\n'),
    )
    expect(out.shelves[1]).toEqual({ key: 'first-subject', description: 'The first subject, not the second.', tags: ['one', 'extra'] })
    expect(out.shelves[2]!.key).toBe('second-subject')
    expect(out.parent).toEqual({ description: 'Alpha without the two shelves.', tags: ['three'] })
  })

  it('tolerates drift: bold headings and fields, bullets, a preamble, a Key in capitals', () => {
    const out = parseSplitNaming(
      [
        'Here are my proposals.',
        '',
        '### **Shelf 1**',
        '- **Key:** `First-Subject`',
        '- **description**: The first.',
        '',
        '## The parent',
        '* description: What stays.',
      ].join('\n'),
    )
    expect(out.shelves[1]).toEqual({ key: 'first-subject', description: 'The first.' })
    expect(out.parent).toEqual({ description: 'What stays.' })
  })

  it('keeps what a partial answer has, and yields nothing from prose', () => {
    expect(parseSplitNaming('## shelf 2\nkey: only-a-key').shelves).toEqual({ 2: { key: 'only-a-key' } })
    expect(parseSplitNaming('I would call the first one something broad.')).toEqual({ shelves: {}, parent: {} })
  })
})

describe('plain text in the answer', () => {
  it('turns wikilinks and Markdown links back into their words, in descriptions and tags', () => {
    // The first real pass on a live vault put four wikilinks into the parent's description,
    // one to the new domain key: a dead link on the registry page, brackets in every ingest prompt.
    const out = parseSplitNaming(
      [
        '## shelf 1',
        'key: first-subject',
        'description: Covers [[Page A01]] and [[Page B02|the second page]], see [the guide](https://example.invalid).',
        'tags: [[t-one]], t-two',
        '## parent',
        'description: What stays; [[first-subject]] has its own domain.',
      ].join('\n'),
    )
    expect(out.shelves[1]!.description).toBe('Covers Page A01 and the second page, see the guide.')
    expect(out.shelves[1]!.tags).toEqual(['t-one', 't-two'])
    expect(out.parent.description).toBe('What stays; first-subject has its own domain.')
    expect(plainText('  no   links\there ')).toBe('no links here')
  })
})
