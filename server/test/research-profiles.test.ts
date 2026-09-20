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
  RESEARCH_PREFIX,
  TITLE_MAX_CHARS,
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

  it('carries a short line per lens that fits one dropdown row, and serves it', () => {
    // "lens - what it reaches for" on one line: the words, not a sentence, and never long.
    for (const p of RESEARCH_PROFILES) {
      expect(p.short.length).toBeGreaterThan(0)
      expect(p.short.length).toBeLessThan(45)
      expect(p.short).not.toMatch(/[.\n]/)
    }
    expect(researchProfileList().map((p) => p.short)).toEqual(RESEARCH_PROFILES.map((p) => p.short))
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
    expect(researchTargetTitle(broad, 'tidal turbines')).toBe('Research - tidal turbines')
    expect(researchTargetTitle(sota, 'tidal turbines')).toBe('Research - tidal turbines - State of the Art')
    expect(researchTargetTitle(patents, 'tidal turbines')).toBe('Research - tidal turbines - Patent Landscape')
    // No two lenses share a synthesis title for the same topic.
    const titles = RESEARCH_PROFILES.map((p) => researchTargetTitle(p, 'x'))
    expect(new Set(titles).size).toBe(titles.length)
  })

  /*
   * The title, decoupled from the topic but still pinned before the run
   * (docs/tasks/TASKS-QUESTIONS.md, phase 2, decision D5). A reformulated question gives the
   * service a NAME as well as a sentence, so the synthesis page stops being called after a
   * paragraph cut mid-clause - and the name still has to be computed here, before the prompt,
   * or `isSynthesisPath` and the post-run warning lose the thing they agree on.
   */
  describe('a title of its own', () => {
    const sota = getResearchProfile('sota')
    const broad = getResearchProfile('broad')

    it('uses the given title and falls back to the topic without one', () => {
      const topic = 'What is the installed cost per megawatt of rack-mounted tidal arrays?'
      expect(researchTargetTitle(broad, topic, 'Tidal Array Installed Cost')).toBe('Research - Tidal Array Installed Cost')
      expect(researchTargetTitle(sota, topic, 'Tidal Array Installed Cost')).toBe('Research - Tidal Array Installed Cost - State of the Art')
      // Absent, empty and whitespace all mean "no title given": the old behaviour, unchanged.
      for (const none of [undefined, '', '   ']) {
        expect(researchTargetTitle(broad, 'tidal turbines', none)).toBe('Research - tidal turbines')
      }
    })

    it('makes an unsafe title safe, the same way a topic-derived one is made safe', () => {
      expect(researchTargetTitle(broad, 'ignored', 'Cost/MW: the question?')).toBe('Research - Cost-MW - the question')
      expect(researchTargetTitle(broad, 'ignored', '../escape')).toBe('Research - escape')
    })

    it('fits the whole NAME into the cap, prefix and lens suffix included', () => {
      const long = 'Tidal array installed cost per megawatt across every rack-mounted deployment in the North Sea and the Pentland Firth'
      for (const p of RESEARCH_PROFILES) {
        const title = researchTargetTitle(p, 'ignored', long)
        expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS)
        // Cut on a word boundary, not mid-word, and with no dangling separator.
        expect(title.endsWith(p.titleSuffix)).toBe(true)
        const middle = title.slice(RESEARCH_PREFIX.length, title.length - p.titleSuffix.length)
        expect(long.startsWith(middle)).toBe(true)
        expect(middle).not.toMatch(/[\s,;:-]$/)
      }
    })

    it('stays recognisable to the post-run check, which is the pair D5 protects', () => {
      // The prompt pins a title; the run files a page under it; the post-run warning fires
      // when no page it committed is a synthesis. If these two ever stop agreeing, a run that
      // did its job reports that it did not - so every shape goes through both.
      const titles = ['Tidal Array Installed Cost', 'Cost/MW: the question?', 'A'.repeat(200), '...', undefined]
      for (const p of RESEARCH_PROFILES) {
        for (const title of titles) {
          const pinned = researchTargetTitle(p, 'a topic with a / and a : in it', title)
          expect(isSynthesisPath(`wiki/questions/${pinned}.md`), `${p.key} / ${String(title)}`).toBe(true)
          // And the mandate pins exactly that name, rather than computing a second one.
          expect(renderSynthesisMandate(p, 'a topic with a / and a : in it', title)).toContain(`"${pinned}"`)
        }
      }
    })
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
      expect(mandate).toContain('"Research - tidal turbines"')
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
      expect(researchTargetTitle(getResearchProfile('broad'), 'A/B')).toBe('Research - A-B')
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
      expect(isSynthesisPath('wiki/questions/Research: kelp farming - State of the Art.md')).toBe(true)
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

/**
 * The title template that mints the dead links (B3, 4.1). `Research: [Topic]` put a colon in
 * every synthesis title, and the topic is whatever the user asked - which in this vault's
 * worst cases is a whole question, producing file names of 213 to 221 characters.
 */
describe('a synthesis title is a name', () => {
  const profile = getResearchProfile(undefined)

  it('carries no colon any more', () => {
    expect(researchTargetTitle(profile, 'Sodium-ion cathodes')).not.toContain(':')
    expect(RESEARCH_PREFIX).not.toContain(':')
  })

  it('turns a colon in the topic into a separator rather than keeping it', () => {
    expect(researchTargetTitle(profile, 'ADCs: what 2026 added')).toBe('Research - ADCs - what 2026 added')
  })

  it('handles the other characters a file name cannot carry', () => {
    for (const bad of ['?', '*', '"', '<', '>', '|']) {
      expect(researchTargetTitle(profile, `A${bad}B`)).not.toContain(bad)
    }
  })

  it('cuts a whole question down to a name, on a word boundary', () => {
    const question =
      'As of September 2026, is any of the three named approaches measurably closer to the milestone in question than the others are, and what would settle it'
    const title = researchTargetTitle(profile, question)
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS + RESEARCH_PREFIX.length)
    expect(title.endsWith(' ')).toBe(false)
    // A cut in the middle of a word would also make two runs on one topic collide differently.
    expect(question.startsWith(title.slice(RESEARCH_PREFIX.length))).toBe(true)
  })

  it('is deterministic: the same topic gives the same name twice', () => {
    const topic = 'A topic that is quite a lot longer than the cap allows, going on and on past it'
    expect(researchTargetTitle(profile, topic)).toBe(researchTargetTitle(profile, topic))
  })

  it('still recognises the 31 pages filed under the old spelling', () => {
    // A run that stops recognising them files a second page beside one it should have extended.
    expect(isSynthesisPath('wiki/questions/Research: Something old.md')).toBe(true)
    expect(isSynthesisPath('wiki/questions/Research - Something new.md')).toBe(true)
  })
})
