/**
 * Research lens profiles ("Achse A"): a CLOSED set of selectable lenses that shape WHAT a
 * research run searches for and HOW it frames the synthesis — state of the art, patent
 * landscape, startup landscape — on top of the vault's global `references/program.md`.
 *
 * WHY A CLOSED SET IN CODE, NOT FREE TEXT OR A VAULT FILE
 * ------------------------------------------------------
 * The design review (this repo, research-profiles analysis) landed on three load-bearing
 * constraints, and a code-side closed union satisfies all three by construction:
 *   1. The lens is a closed list, never free text — free text is the "domain free-for-all"
 *      the domain registry exists to end. `isResearchProfileKey` is the gate.
 *   2. The SERVICE decides the synthesis page's title deterministically (a per-lens suffix),
 *      so two lenses on one topic file `Research: X — State of the Art` and `Research: X —
 *      Patent Landscape` instead of colliding on one `Research: X`. The agent never picks.
 *   3. The lens block is SUBORDINATE to the page-hygiene, entity-notability and domain rules
 *      the system prompt already injects: it refines search + framing only, and adds no new
 *      page types and no new domains. That subordination is stated in the injected text.
 *
 * These profiles are a stable product capability, not the user's evolving taxonomy (which is
 * what the vault-editable domain registry is for) — so, unlike domains, they live in code and
 * are unit-testable. `broad` is the default and renders NO LENS block, so a default run keeps
 * the pre-profile framing. It does still get the synthesis mandate below: that one is not a
 * lens refinement but the definition of what a research run owes, and withholding it from the
 * default lens is exactly what let a broad run finish with no synthesis page (2026-09-04).
 */

/** The closed lens set. Extend deliberately; each key is validated against this union. */
export type ResearchProfileKey = 'broad' | 'sota' | 'patents' | 'startups'

export interface ResearchProfile {
  readonly key: ResearchProfileKey
  /** Human label for the UI chip. */
  readonly label: string
  /** One-line description shown in the run-plan preview and injected as the lens intent. */
  readonly blurb: string
  /**
   * What the lens reaches for, in a few words, for a dropdown that shows "lens - what it
   * reaches for" on one line (second sweep, chunk 6). Under 45 characters, never a sentence.
   */
  readonly short: string
  /** Optional chip badge, e.g. 'default'. */
  readonly badge?: string
  /** Source preferences — shown as pills in the UI and injected into the lens block. */
  readonly sources: readonly string[]
  /** Rough WebFetch-count expectation for the cost hint (e.g. '30-45'). */
  readonly fetchEstimate: string
  /**
   * Deterministic suffix appended after the topic in the synthesis page title. Empty for
   * `broad` (keeps the classic `Research: <topic>`), distinct per lens otherwise.
   */
  readonly titleSuffix: string
  /** How the synthesis should be framed under this lens (injected). */
  readonly emphasis: string
  /** Optional extra guardrail injected for this lens (e.g. startups ↔ entity-notability). */
  readonly guard?: string
}

export const RESEARCH_PROFILES: readonly ResearchProfile[] = [
  {
    key: 'broad',
    label: 'Broad sweep',
    blurb: 'General authoritative coverage - the standard research loop.',
    short: 'every kind of source, the standard loop',
    badge: 'default',
    sources: ['peer-reviewed papers', 'official documentation', 'primary sources'],
    fetchEstimate: '30-45',
    titleSuffix: '',
    emphasis: 'a balanced overview of the topic',
  },
  {
    key: 'sota',
    label: 'State of the art',
    blurb: 'Latest developments, results and benchmarks - weighted to the last ~2 years.',
    short: 'the last two years of results',
    sources: ['arXiv', 'official releases and changelogs', 'recent conference / peer-reviewed papers'],
    fetchEstimate: '30-40',
    titleSuffix: ' — State of the Art',
    emphasis:
      'what has changed recently, the current best results, and the open frontiers; treat ' +
      'sources older than ~2 years as background context only',
  },
  {
    key: 'patents',
    label: 'Recent patents',
    blurb: 'The IP landscape - filings, assignees and claim scope.',
    short: 'filings, assignees and claim scope',
    sources: ['Google Patents', 'USPTO', 'EPO Espacenet'],
    fetchEstimate: '25-35',
    titleSuffix: ' — Patent Landscape',
    emphasis:
      'the intellectual-property landscape: notable filings and grants, their assignees, ' +
      'priority dates, and what the claims actually cover; note where a patent family is ' +
      'still pending vs granted',
  },
  {
    key: 'startups',
    label: 'Startups & funding',
    blurb: 'Companies, funding rounds and commercial traction around the topic.',
    short: 'who builds it and who funds it',
    sources: ['company sites', 'funding trackers', 'trade press'],
    fetchEstimate: '25-35',
    titleSuffix: ' — Startup Landscape',
    emphasis:
      'the commercial landscape: which companies are active, their funding stage and backers, ' +
      'and their product traction',
    guard:
      'A company or founder becomes its own wiki/entities/ page ONLY when the entity-notability ' +
      'rules above already allow it; a single funding-round mention is inline attribution on ' +
      'the source page, not a new entity page.',
  },
]

/** The default lens — a run with no `profileKey` behaves exactly as before profiles existed. */
export const DEFAULT_PROFILE_KEY: ResearchProfileKey = 'broad'

const BY_KEY = new Map<string, ResearchProfile>(RESEARCH_PROFILES.map((p) => [p.key, p]))

/** True when `key` names a real lens (route validation gate). */
export function isResearchProfileKey(key: string): key is ResearchProfileKey {
  return BY_KEY.has(key)
}

/** The profile for `key`, falling back to the default lens for anything unknown/omitted. */
export function getResearchProfile(key: string | undefined): ResearchProfile {
  return (key !== undefined && BY_KEY.get(key)) || BY_KEY.get(DEFAULT_PROFILE_KEY)!
}

/**
 * The prefix every synthesis page title (and file name) carries.
 *
 * Colon-free since 2026-09-19 (B3). `Research: ` was the machine that minted the worst of this
 * vault's dead links: a colon survives in `title:`, a filer that replaces it produces
 * `Research - Foo`, and every link written from the title then resolves to nothing. Two pages
 * account for 43 of the 55 colon-class dead-link occurrences.
 */
export const RESEARCH_PREFIX = 'Research - '

/**
 * The spelling used before 2026-09-19. Recognition has to accept both forever: 31 synthesis
 * pages carry it, and a run that no longer recognises them files a second page beside one it
 * should have extended.
 */
export const LEGACY_RESEARCH_PREFIX = 'Research: '

/**
 * How long a page title may be.
 *
 * This vault holds five file names between 213 and 221 characters - within a few bytes of the
 * 255-byte limit every common filesystem has, and already past what some sync tools accept.
 * A title is a name, and a name that cannot be written down is not one. 120 leaves room for
 * the prefix, a lens suffix and the `.md`.
 */
export const TITLE_MAX_CHARS = 120

/** The deterministic synthesis-page title the service pins for this lens + topic. */
/**
 * Characters that cannot survive a title becoming a filename (2026-09-10).
 *
 * The synthesis title is PINNED in the prompt and the run files a page under that name, so
 * whatever the topic carries ends up in a path. A topic with a slash in it - "durability/
 * dosing-advantage", the usual "A or B" shorthand - was written as a directory and a page one
 * level down under the half of the title after the slash, and all five wikilinks aimed at the
 * full title resolved to nothing. Nothing noticed: the page WAS under `wiki/questions/` and
 * WAS prefixed `Research: `, which is all the post-run check asked (see `isSynthesisPath`,
 * which now also asks that it sit directly in the folder).
 *
 * Both separators become a hyphen rather than being dropped, which is what the shorthand
 * meant anyway. Control characters and a leading dot or hyphen go, the same set the vault's
 * own `safe_name()` strips, so a title can neither escape its folder nor read as a flag.
 */
export function titleSafe(topic: string): string {
  const cleaned = [...topic.replace(/[/\\]+/g, '-').replace(/\s*[:?*"<>|]+\s*/g, ' - ')]
    // Control characters, the other half of what the vault's own `safe_name()` strips. A
    // character class would say this more directly, but the lint rule that forbids control
    // characters in a regex is right about every other use of one.
    .filter((c) => (c.codePointAt(0) ?? 0) > 0x1f)
    .join('')
    .trim()
    // After the trim, not before: leading whitespace used to shelter the dot behind it.
    .replace(/^[.-]+/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/(?:\s-\s){2,}/g, ' - ')
    .trim()
  return cleaned === '' ? 'untitled' : shortenTitle(cleaned)
}

/**
 * Cuts a title to {@link TITLE_MAX_CHARS} on a word boundary, deterministically.
 *
 * The autoresearch template is `Research: [Topic]`, and the topic is whatever the user asked -
 * a whole question, in this vault's worst cases. Truncating on a word keeps the name readable
 * and keeps two runs on one topic from colliding on a cut in the middle of a word.
 */
export function shortenTitle(title: string, max: number = TITLE_MAX_CHARS): string {
  const trimmed = title.trim()
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, '').trim()
}

/**
 * The title the run is told to file its synthesis under. The one place a topic becomes a
 * name, so it is the one place the name has to be safe to be a filename.
 */
export function researchTargetTitle(profile: ResearchProfile, topic: string): string {
  return `${RESEARCH_PREFIX}${titleSafe(topic)}${profile.titleSuffix}`
}

/**
 * True for a vault path that is a research synthesis page.
 *
 * Deliberately the same test the dashboard applies when it looks for the page a run was FOR
 * (`web/src/lib/researchRuns.ts`), so the post-run warning fires exactly when the run detail
 * would otherwise show its empty state - the two can never disagree about whether a run has a
 * synthesis. `wiki/questions/` alone is not enough: that folder also holds ordinary question
 * pages, which are not what a research run owes.
 */
export function isSynthesisPath(relPath: string): boolean {
  const prefix = 'wiki/questions/'
  if (!relPath.startsWith(prefix) || !relPath.endsWith('.md')) return false
  const name = relPath.slice(prefix.length)
  // Directly in the folder, not one level down. A title with a path separator in it used to
  // land as `<first half>/<second half>.md` and pass this check, so the run reported a
  // synthesis filed and the warning that would have caught it never fired (see `titleSafe`).
  if (name.includes('/')) return false
  // Both spellings: the colon-free one this service pins now, and the one 31 pages carry.
  return name.startsWith(RESEARCH_PREFIX) || name.startsWith(LEGACY_RESEARCH_PREFIX)
}

/**
 * The synthesis mandate appended to EVERY research prompt, whatever the lens (2026-09-04).
 *
 * This sentence used to live inside `renderProfileBlock`, which returns nothing for `broad` -
 * so the default lens, the one most runs use, was the only one never told to file a synthesis
 * page. The vault skill asks for one too, but only as one bullet among its filing rules, and
 * the overlap block appended right after it argues in the opposite direction ("prefer
 * extending what exists over creating new pages"). A broad run on a topic the vault already
 * covered followed the overlap block, filed twelve concept and source pages, updated three
 * more, reported success - and wrote no synthesis at all, leaving the run detail with nothing
 * to show and the Library with no research entry for it.
 *
 * So the mandate is unconditional, it names the exact title the SERVICE pinned (which is also
 * the title the dashboard predicts, so the two can no longer drift apart), and it states the
 * one legitimate alternative - folding into an existing synthesis - as an alternative TARGET
 * rather than as permission to skip the deliverable.
 */
export function renderSynthesisMandate(profile: ResearchProfile, topic: string): string {
  const title = researchTargetTitle(profile, topic)
  return (
    `\n\n<synthesis_page>\n` +
    `This run is NOT finished until exactly one synthesis page under wiki/questions/ carries ` +
    `its findings. File it with EXACTLY this title, do not choose another: "${title}".\n` +
    `The one alternative is to fold the findings into an existing synthesis page this prompt ` +
    `lists as overlapping (keep its title, refresh its \`updated:\` date). Doing NEITHER is a ` +
    `failed run, however many concept, entity and source pages you wrote along the way.\n` +
    `</synthesis_page>`
  )
}

/**
 * The lens block appended to the research prompt. Empty for `broad`, so a default run keeps
 * the base prompt verbatim. For a real lens it states the intent, the source preferences, the
 * synthesis framing and — explicitly — its subordination to the hygiene/notability/domain
 * rules the system prompt already carries. The synthesis TITLE is pinned separately, by
 * `renderSynthesisMandate`, because every lens needs that and this block is lens-only.
 */
export function renderProfileBlock(profile: ResearchProfile): string {
  if (profile.key === DEFAULT_PROFILE_KEY) return ''
  const guard = profile.guard ? `\n- ${profile.guard}` : ''
  return (
    `\n\n<research_lens name="${profile.label}">\n` +
    `Approach this topic through the "${profile.label}" lens: ${profile.blurb}\n` +
    `- Prefer these sources: ${profile.sources.join(', ')}.\n` +
    `- Emphasise in the synthesis: ${profile.emphasis}.${guard}\n` +
    `This lens only refines what you search for and how you frame the synthesis. It does NOT ` +
    `override the page-hygiene, entity-notability, or domain rules given above; it adds no new ` +
    `page types and invents no new domains. Concepts, entities and sources are still filed into ` +
    `the existing wiki buckets with full frontmatter.\n` +
    `</research_lens>`
  )
}

/** UI-facing shape (no prompt internals) for `GET /maintenance/research/profiles`. */
export interface ResearchProfileInfo {
  readonly key: ResearchProfileKey
  readonly label: string
  readonly blurb: string
  readonly short: string
  readonly badge?: string
  readonly sources: readonly string[]
  readonly fetchEstimate: string
  readonly titleSuffix: string
}

/** The lens list for the client, default first. */
export function researchProfileList(): ResearchProfileInfo[] {
  return RESEARCH_PROFILES.map(({ key, label, blurb, short, badge, sources, fetchEstimate, titleSuffix }) => ({
    key,
    label,
    blurb,
    short,
    ...(badge ? { badge } : {}),
    sources,
    fetchEstimate,
    titleSuffix,
  }))
}
