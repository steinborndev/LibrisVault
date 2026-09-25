import { describe, it, expect } from 'vitest'
import { formTagsOf, thematicTest } from '../src/lib/tagSignal.ts'
import { detectClusters } from '../src/lib/communities.ts'
import { pageLinks } from '../src/tabs/Vault.tsx'
import type { GraphNode, VaultGraph } from '../src/api/types.ts'

let seq = 0
const node = (type: string, domain: string | null, tags: string[]): GraphNode => ({
  path: `wiki/${type}/p${seq++}.md`,
  title: `p${seq}`,
  type,
  tags,
  domain,
  kind: 'knowledge',
  out: 0,
  in: 0,
})

describe('formTagsOf', () => {
  it('finds a tag that stays on one page type across five domains', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((d) => node('sources', d, ['clip', d]))
    expect(formTagsOf(nodes)).toEqual(new Set(['clip']))
  })

  it('leaves a subject alone: four domains, or two page types', () => {
    const four = ['a', 'b', 'c', 'd'].map((d) => node('sources', d, ['clip']))
    expect(formTagsOf(four).size).toBe(0)
    const mixed = ['a', 'b', 'c', 'd', 'e'].map((d, i) => node(i === 0 ? 'concepts' : 'sources', d, ['topic']))
    expect(formTagsOf(mixed).size).toBe(0)
  })
})

describe('thematicTest', () => {
  it('drops the named forms whatever their case, and keeps subjects', () => {
    const t = thematicTest([])
    expect(t('Organization')).toBe(false)
    expect(t('trade-press')).toBe(false)
    expect(t('source')).toBe(false)
    expect(t('recycling')).toBe(true)
  })
})

describe('related by tag', () => {
  const graph = (nodes: GraphNode[]): VaultGraph => ({ nodes, edges: [] }) as unknown as VaultGraph

  it('shares no form tag: a video is not related to every other video', () => {
    const me = node('sources', 'talk', ['video', 'dialogue'])
    const other = node('sources', 'space', ['video', 'rockets'])
    const filler = Array.from({ length: 10 }, (_, i) => node('concepts', 'x', [`t${i}`]))
    expect(pageLinks(graph([me, other, ...filler]), me.path, false).related).toEqual([])
  })

  it('takes one shared subject inside the domain, and two across it', () => {
    const me = node('concepts', 'alpha', ['cells', 'dosing'])
    const sameOne = node('concepts', 'alpha', ['cells'])
    const otherOne = node('concepts', 'beta', ['cells'])
    const otherTwo = node('concepts', 'beta', ['cells', 'dosing'])
    const filler = Array.from({ length: 10 }, (_, i) => node('concepts', 'x', [`t${i}`]))
    const related = pageLinks(graph([me, sameOne, otherOne, otherTwo, ...filler]), me.path, false).related
    expect(related.map((n) => n.path).sort()).toEqual([sameOne.path, otherTwo.path].sort())
  })
})

describe('area captions', () => {
  it('never name an area by a form tag', () => {
    const clique = (base: number): Array<[number, number]> => {
      const e: Array<[number, number]> = []
      for (let i = base; i < base + 5; i++) for (let j = i + 1; j < base + 5; j++) e.push([i, j])
      return e
    }
    const nodes = [
      ...Array.from({ length: 5 }, () => node('entities', 'alpha', ['organization', 'funding'])),
      ...Array.from({ length: 5 }, () => node('concepts', 'alpha', ['cells'])),
    ]
    const { clusterIds, clusterLabels } = detectClusters(nodes, [...clique(0), ...clique(5), [0, 5]], nodes.length, thematicTest(nodes))
    expect(clusterLabels.get(clusterIds[0]!)).toBe('#funding')
  })
})
