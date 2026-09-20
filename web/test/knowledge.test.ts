import { describe, it, expect } from 'vitest'
import { isKnowledgeNode, isSystemNode, UPSTREAM_DEMO } from '../src/lib/knowledge.ts'

/**
 * What counts as this vault's own knowledge (task 8.7).
 *
 * Two unrelated reasons a page does not, sharing one toggle: it is the vault's machinery
 * (`kind`), or it came with the plugin (`origin: upstream-demo`). Seventeen pages of the
 * working vault are the second kind, and counting them made every number slightly false.
 */
describe('isKnowledgeNode', () => {
  it('is true for an ordinary page', () => {
    expect(isKnowledgeNode({ kind: 'knowledge', origin: null })).toBe(true)
  })

  it('treats a missing kind as knowledge, which is right for a ghost node', () => {
    // A gap the graph mints for a page other pages link to has no frontmatter to classify.
    expect(isKnowledgeNode({})).toBe(true)
  })

  it('is false for the vault\'s own scaffolding and artifacts', () => {
    expect(isKnowledgeNode({ kind: 'structural' })).toBe(false)
    expect(isKnowledgeNode({ kind: 'artifact' })).toBe(false)
  })

  it('is false for the material the plugin shipped with', () => {
    expect(isKnowledgeNode({ kind: 'knowledge', origin: UPSTREAM_DEMO })).toBe(false)
  })

  it('does not hide a page for stating some other origin', () => {
    // The field is not a blocklist: only this one value means "not ours".
    expect(isKnowledgeNode({ kind: 'knowledge', origin: 'a-conference-handout' })).toBe(true)
  })

  it('isSystemNode is exactly its complement, so a System view shows what the other hides', () => {
    for (const n of [{}, { kind: 'knowledge' as const }, { kind: 'artifact' as const }, { origin: UPSTREAM_DEMO }]) {
      expect(isSystemNode(n)).toBe(!isKnowledgeNode(n))
    }
  })
})
