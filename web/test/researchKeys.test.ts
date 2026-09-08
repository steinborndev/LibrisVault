/**
 * The Research screen's keys, checked against the source the way the navigation guard next
 * door is.
 *
 * Three properties matter and none of them is visible in a rendered tree: that the keys exist
 * at all, that they are the SAME keys the Library gives its rooms - left and right for the two
 * sides of one thing, Escape to walk back out - and that they stand down while the caret is in
 * a field, where the arrows move text and Escape belongs to the browser.
 *
 * The last one is the reason this is a test. A global key handler that forgets it is not a bug
 * anyone sees in review; it is a bug the first person to type an arrow key into the composer
 * finds, and by then it has shipped.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const chat = readFileSync(join(here, '..', 'src', 'tabs', 'Chat.tsx'), 'utf8')

/** The body of the effect that owns the window key listener. */
const handler = (() => {
  const start = chat.indexOf("const onKey = (e: KeyboardEvent)")
  expect(start, 'no window key handler in Chat.tsx').toBeGreaterThan(-1)
  const end = chat.indexOf("window.addEventListener('keydown', onKey)", start)
  return chat.slice(start, end)
})()

describe('the Research screen answers the keys the Library taught', () => {
  it('switches mode with left and right', () => {
    expect(handler).toContain("e.key === 'ArrowLeft'")
    expect(handler).toContain("e.key === 'ArrowRight'")
    expect(handler).toContain('setMode(')
  })

  it('walks back out with Escape', () => {
    expect(handler).toContain("e.key === 'Escape'")
    expect(handler).toContain("{ kind: 'start' }")
  })

  it('stands down while the caret is in a field', () => {
    // All three, because two of them would leave the third kind of field broken: a
    // contenteditable is not an input, and a textarea is not either.
    expect(handler).toContain('HTMLInputElement')
    expect(handler).toContain('HTMLTextAreaElement')
    expect(handler).toContain('isContentEditable')
    // And it returns BEFORE any key is read, rather than checking per branch.
    const guard = handler.indexOf('isContentEditable')
    const firstKey = handler.indexOf("e.key ===")
    expect(guard).toBeLessThan(firstKey)
  })

  it('unbinds the listener when the screen goes away', () => {
    const effect = chat.slice(chat.indexOf("const onKey = (e: KeyboardEvent)"))
    expect(effect).toContain("removeEventListener('keydown', onKey)")
  })
})
