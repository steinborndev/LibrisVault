/**
 * The Markdown renderer's inline layer, and the one thing it got wrong: a construct inside
 * another construct.
 *
 * Found in the wild (2026-09-14): a source page written as `**[[Carbamoyl Phosphate Synthetase 1
 * (CPS1) Deficiency]]**` showed the brackets, because the bold alternative matched first and its
 * branch emitted the inner text raw. 404 wikilinks on 156 pages of the live vault are written
 * that way, and Obsidian, the graph and the dead-link check all read them correctly - the
 * renderer was the only reader that did not.
 *
 * The component is called directly and its element tree walked: no DOM, the same style the
 * linkify tests use.
 */

import { describe, it, expect } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { Markdown, type WikilinkRenderer } from '../src/components/Markdown.tsx'

/** Every string in the tree, in order: what a reader would see. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

/** Every element of one type in the tree. */
function find(node: ReactNode, type: string): ReactElement[] {
  const out: ReactElement[] = []
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    if (!isValidElement(n)) return
    if (n.type === type) out.push(n)
    walk((n.props as { children?: ReactNode }).children)
  }
  walk(node)
  return out
}

/** A renderer that marks what it was asked to link, so a test can see it was asked at all. */
const asLink: WikilinkRenderer = (target, label, key) => (
  <a key={key} className="wikilink" href={`/catalog/page/${target}`}>
    {label}
  </a>
)

const render = (source: string, wiki?: WikilinkRenderer): ReactElement =>
  Markdown(wiki ? { source, renderWikilink: wiki } : { source })

describe('a wikilink inside other inline markup', () => {
  it('links a bold wikilink instead of showing its brackets', () => {
    const tree = render('to a single infant with **[[Carbamoyl Phosphate Synthetase 1 (CPS1) Deficiency]]**, from birth.', asLink)
    expect(textOf(tree)).not.toContain('[[')
    const links = find(tree, 'a')
    expect(links).toHaveLength(1)
    expect((links[0]!.props as { href: string }).href).toBe('/catalog/page/Carbamoyl Phosphate Synthetase 1 (CPS1) Deficiency')
    // Still bold: the emphasis the page asked for is kept around the link.
    expect(find(tree, 'strong')).toHaveLength(1)
    expect(textOf(find(tree, 'strong')[0])).toBe('Carbamoyl Phosphate Synthetase 1 (CPS1) Deficiency')
  })

  it('does the same inside italic, and in a list item', () => {
    expect(find(render('an *[[Italic Target]]* here', asLink), 'a')).toHaveLength(1)
    expect(find(render('- see **[[A Page]]** for it', asLink), 'a')).toHaveLength(1)
    expect(textOf(render('- see **[[A Page]]** for it', asLink))).not.toContain('[[')
  })

  it('keeps a bold link and bold code working', () => {
    const tree = render('**a [link](https://example.com/x) in bold** and **`code`**', asLink)
    const links = find(tree, 'a')
    expect(links).toHaveLength(1)
    expect((links[0]!.props as { href: string }).href).toBe('https://example.com/x')
    expect(find(tree, 'code')).toHaveLength(1)
  })

  it('leaves a wikilink inside inline code exactly as written', () => {
    // Code is code: a page that shows the syntax must keep its brackets.
    const tree = render('write `[[Page Name]]` to link it', asLink)
    expect(find(tree, 'a')).toHaveLength(0)
    expect(textOf(tree)).toContain('[[Page Name]]')
  })

  it('falls back to emphasis when no renderer is given, brackets gone either way', () => {
    const tree = render('see **[[A Page]]** now')
    expect(textOf(tree)).toBe('see A Page now')
    expect(find(tree, 'a')).toHaveLength(0)
  })
})

describe('what the renderer already did, held in place', () => {
  it('renders a plain wikilink, bold, italic, code and a link', () => {
    const tree = render('a [[Page]] and **bold** and *italic* and `code` and [x](https://example.com)', asLink)
    expect(find(tree, 'a').map((a) => (a.props as { href: string }).href)).toEqual(['/catalog/page/Page', 'https://example.com'])
    expect(find(tree, 'strong')).toHaveLength(1)
    expect(find(tree, 'em')).toHaveLength(1)
    expect(find(tree, 'code')).toHaveLength(1)
  })

  it('reads an alias and a heading in a wikilink', () => {
    expect(textOf(render('[[Target|the label]]', asLink))).toBe('the label')
    expect(textOf(render('[[Target#A Heading]]', asLink))).toBe('Target')
  })

  it('still renders headings, lists, quotes, tables and fences', () => {
    const tree = render(['## A heading', '', '- one', '- two', '', '> quoted', '', '| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'))
    expect(find(tree, 'h2')).toHaveLength(1)
    expect(find(tree, 'li')).toHaveLength(2)
    expect(find(tree, 'blockquote')).toHaveLength(1)
    expect(find(tree, 'td')).toHaveLength(2)
  })
})
