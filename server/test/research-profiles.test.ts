import { describe, it, expect } from 'vitest'
import {
  RESEARCH_PROFILES,
  DEFAULT_PROFILE_KEY,
  getResearchProfile,
  isResearchProfileKey,
  renderProfileBlock,
  renderSynthesisMandate,
  isSynthesisPath,
  researchTargetTitle,
  researchProfileList,
  titleSafe,
} from '../src/pipeline/research-profiles.js'

describe('research profiles (Achse A)', () => {
  it('exposes a closed set with broad as the default', () => {
    expect(DEFAULT_PROFILE_KEY).toBe('broad')
    expect(RESEARCH_PROFILES.map((p) => p.key)).toContain('broad')
    expect(isResearchProfileKey('sota')).toBe(true)
    expect(isResearchProfileKey('patents')).toBe(true)
    expect(isResearchProfileKey('startups')).toBe(true)
    expect(isResearchProfileKey('made-up-lens')).toBe(false)
  })

  it('falls back to the default lens for an unknown or omitted key', () => {
    expect(getResearchProfile(undefined).key).toBe('broad')
    expect(getResearchProfile('nope').key).toBe('broad')
    expect(getResearchProfile('sota').key).toBe('sota')
  })

  it('pins a distinct, deterministic synthesis title per lens so two lenses never collide', () => {
    const broad = getResearchProfile('broad')
    const sota = getResearchProfile('sota')
    const patents = getResearchProfile('patents')
    expect(researchTargetTitle(broad, 'tidal turbines')).toBe('Research: tidal turbines')
    expect(researchTargetTitle(sota, 'tidal turbines')).toBe('Research: tidal turbines — State of the Art')
    expect(researchTargetTitle(patents, 'tidal turbines')).toBe('Research: tidal turbines — Patent Landscape')
    // No two lenses share a synthesis title for the same topic.
    const titles = RESEARCH_PROFILES.map((p) => researchTargetTitle(p, 'x'))
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('renders NO lens block for the default lens, so a plain run keeps the base framing', () => {
    expect(renderProfileBlock(getResearchProfile('broad'))).toBe('')
  })

  it('renders a subordinate lens block that forbids new page types/domains', () => {
    const block = renderProfileBlock(getResearchProfile('sota'))
    expect(block).toContain('research_lens')
    // The lens LABEL; the pinned title now rides on the synthesis mandate instead.
    expect(block).toContain('State of the art')
    expect(block).toContain('arXiv')
    // The subordination clause is load-bearing (analysis point 3).
    expect(block).toMatch(/does NOT\s+override the page-hygiene, entity-notability, or domain rules/)
    expect(block).toContain('adds no new')
    expect(block).toContain('invents no new domains')
  })

  it('carries the entity-notability guardrail on the startups lens', () => {
    const block = renderProfileBlock(getResearchProfile('startups'))
    expect(block).toMatch(/entity-notability rules above already allow it/)
  })

  /**
   * The regression this set exists for (2026-09-04): the synthesis mandate used to live inside
   * the lens block, which renders nothing for `broad` - so the DEFAULT lens was the only one
   * never told to file a synthesis page, and a broad run duly filed none.
   */
  describe('synthesis mandate', () => {
    it('is rendered for EVERY lens, the default one included', () => {
      for (const p of RESEARCH_PROFILES) {
        const mandate = renderSynthesisMandate(p, 'tidal turbines')
        expect(mandate).not.toBe('')
        expect(mandate).toContain('wiki/questions/')
        expect(mandate).toContain(researchTargetTitle(p, 'tidal turbines'))
      }
    })

    it('pins the exact title and forbids choosing another', () => {
      const mandate = renderSynthesisMandate(getResearchProfile('broad'), 'tidal turbines')
      expect(mandate).toContain('"Research: tidal turbines"')
      expect(mandate).toMatch(/EXACTLY this title, do not choose another/)
    })

    it('offers folding into an existing synthesis as the ONLY alternative, not as an opt-out', () => {
      const mandate = renderSynthesisMandate(getResearchProfile('sota'), 'kelp farming')
      expect(mandate).toMatch(/one alternative is to fold the findings into an existing synthesis/i)
      expect(mandate).toMatch(/Doing NEITHER is a failed run/)
    })
  })

  /**
   * A title becomes a file name, so a topic that cannot be one has to be repaired before the
   * prompt pins it. This is the bug that was found the long way round: a slash in a topic was
   * written as a directory, the page landed one level down under the second half of its own
   * title, and all five wikilinks aimed at the whole title resolved to nothing.
   */
  describe('titleSafe', () => {
    it('turns a path separator into a hyphen rather than a directory', () => {
      expect(titleSafe('durability/dosing-advantage versus X')).toBe('durability-dosing-advantage versus X')
      expect(titleSafe('a\\b')).toBe('a-b')
      expect(researchTargetTitle(getResearchProfile('broad'), 'A/B')).toBe('Research: A-B')
    })

    it('leaves an ordinary topic exactly as it was typed', () => {
      expect(titleSafe('quantum error correction in 2026')).toBe('quantum error correction in 2026')
    })

    it('drops control characters and a leading dot or hyphen, however it is padded', () => {
      expect(titleSafe('a\u0000b\u001fc')).toBe('abc')
      expect(titleSafe('  .hidden topic')).toBe('hidden topic')
      expect(titleSafe('--flag-shaped')).toBe('flag-shaped')
    })

    it('never returns an empty name', () => {
      expect(titleSafe('///')).toBe('untitled')
      expect(titleSafe('   ')).toBe('untitled')
    })
  })

  describe('isSynthesisPath', () => {
    it('accepts a research synthesis, whatever the lens suffix', () => {
      expect(isSynthesisPath('wiki/questions/Research: tidal turbines.md')).toBe(true)
      expect(isSynthesisPath('wiki/questions/Research: kelp farming — State of the Art.md')).toBe(true)
    })

    it('rejects a page a folder below the bucket - the shape a slashed title makes', () => {
      expect(isSynthesisPath('wiki/questions/Research: A/b.md')).toBe(false)
      expect(isSynthesisPath('wiki/questions/Research: A-b.md')).toBe(true)
    })

    it('rejects an ordinary question page and pages outside wiki/questions', () => {
      expect(isSynthesisPath('wiki/questions/How does the wiki pattern work.md')).toBe(false)
      expect(isSynthesisPath('wiki/concepts/Research: not here.md')).toBe(false)
      expect(isSynthesisPath('wiki/questions/Research: no extension')).toBe(false)
    })
  })

  it('lists lenses for the UI without leaking prompt internals', () => {
    const list = researchProfileList()
    expect(list[0]?.key).toBe('broad')
    for (const info of list) {
      expect(info).toHaveProperty('label')
      expect(info).toHaveProperty('sources')
      expect(info).toHaveProperty('fetchEstimate')
      expect(info).toHaveProperty('titleSuffix')
      // `emphasis`/`guard` are prompt-only and must not reach the client shape.
      expect(info).not.toHaveProperty('emphasis')
      expect(info).not.toHaveProperty('guard')
    }
  })
})
