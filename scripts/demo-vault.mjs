/**
 * Build a synthetic vault + operational database, so the dashboard can be screenshotted
 * without a single line of anyone's real notes.
 *
 * The README's screenshots used to come from the author's own vault. That leaked page
 * titles, people and sources into a public repo, and it also aged badly: a screenshot is
 * only re-shootable if the data behind it can be recreated. This script recreates it.
 *
 *   node scripts/demo-vault.mjs [--out DIR] [--db PATH]
 *
 * It is sized and shaped like a real vault on purpose - about 1,400 pages across 25 subject
 * domains, one of them far deeper than the rest, cut into sub-areas with a page each that the
 * rest leads back to. A hundred-page vault cannot show what the graph, the domain filters or
 * the library are FOR; the interesting behaviour (areas, landmarks, bridges, gaps, orphans, a
 * crowded colour legend) only appears at scale, and only when the links have the uneven shape
 * real ones have. Re-shaped on 2026-09-25 against the numbers of a real vault (see `P` below):
 * the first version linked every page to its next few neighbours, and a graph where every page
 * has the same six links has nothing for the Landmarks or Areas overlays to find.
 *
 * Subject matter lives in `demo-vault-topics.mjs`. Everything is invented: textbook topics,
 * generic document titles, no real people or organisations. Page bodies are assembled from
 * templates - the titles are what a screenshot shows, and 1,400 hand-written bodies nobody
 * looks at would be busywork.
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { DOMAINS, GAPS, CROSS_LINKS, NEIGHBOURS } from './demo-vault-topics.mjs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const OUT = argOf('--out', join(homedir(), '.local/share/vault-service/demo-vault'))
const DB = argOf('--db', join(homedir(), '.local/share/vault-service/demo-jobs.db'))

/**
 * "Now", rounded down to the hour. Dates are all relative to it, so a re-shot screenshot
 * shows a vault that was worked on recently rather than one frozen in the past - and no
 * date can land in the future, which is what silently empties the growth chart.
 */
const TODAY = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000)
const day = (offset) => new Date(TODAY.getTime() - offset * 86_400_000)
const iso = (d) => d.toISOString().slice(0, 10)
/**
 * A moment inside the night that BELONGS to `iso(day(offset))` - the window the service calls
 * a cycle, 01:00 to 06:00 of that date. Runs seeded with `day()` alone land at the current
 * hour, which is the afternoon, and the recap of that date would not see them: it reads from
 * the previous recap forward. Without this the demo's most recent night is always empty.
 */
const nightOf = (offset, hour, minute = 0) => {
  const d = day(offset)
  d.setHours(hour, minute, 0, 0)
  return d
}

/**
 * The vault predates the growth chart's 30-day window, the way a real one does: five months,
 * about how long the vault this one is sized after took to reach its size.
 */
const SPAN_DAYS = 150

/* --------------------------------------------------------------------------- page text */

/**
 * A page's filename IS its title in a claude-obsidian vault - that is also the label the
 * graph renders and the target `[[wikilinks]]` resolve against. Only characters the
 * filesystem dislikes get dropped.
 */
const fileName = (title) => title.replace(/[\\/:*?"<>|]/g, '').trim()

/** Rotating openers, so 500 concept pages do not all begin with the same sentence. */
const LEADS = [
  (t, d) => `${t} is one of the load-bearing ideas in ${d}: get it wrong and everything downstream inherits the error.`,
  (t, d) => `Within ${d}, ${t} is the piece that decides what a measurement can actually tell you.`,
  (t, d) => `${t} names a specific effect, not a general one. It matters in ${d} because the correction it demands is not optional.`,
  (t, d) => `The short version: ${t} is what happens when the idealised description of ${d} meets a real instrument.`,
  (t, d) => `${t} is usually introduced as a definition and then used as a constraint. Both readings show up across ${d}.`,
  (t, d) => `Most treatments of ${d} reach for ${t} at the point where the simple model stops predicting the data.`,
]

const DETAILS = [
  'The practical consequence is a trade-off rather than a rule. Push one side and the neighbouring effect starts to dominate; push the other and the measurement stops being sensitive to what you wanted to know.',
  'Two groups reporting different values are frequently both right and simply not measuring the same thing, which is why the method section matters more than the headline figure.',
  'The usual failure is to treat a convention as a fact. The number is only comparable to another taken under the same convention, and that convention is often unstated.',
  'It is cheap to state and expensive to satisfy. Most working practice sits at a compromise point and says so explicitly; the write-ups that do not are the ones later reanalyses disagree with.',
  'Where it breaks down is well characterised, which makes it useful: the failure mode is diagnostic, so an anomaly here usually points at a specific cause rather than at noise.',
]

const PRACTICE = [
  ['State the assumption that makes the simple form valid, and check it holds.',
   'Report the quantity actually measured, not the one it is usually converted into.',
   'Keep the raw observable: conversions are lossy and conventions change.'],
  ['Separate the systematic term from the statistical one before quoting an uncertainty.',
   'Say which correction was applied, and in which order.',
   'When results disagree, compare methods before comparing numbers.'],
  ['Record the configuration alongside the result - it is the part nobody can reconstruct later.',
   'Prefer a stated range over a single number with an implied precision.',
   'Re-derive at least one known value before trusting a new pipeline.'],
]

const pick = (arr, i) => arr[i % arr.length]

/* ------------------------------------------------------------------------ page building */

const pages = []

/**
 * Pages are collected without a date and stamped later - see `assignTimeline()`. Building
 * domain by domain and dating as you go produces a vault whose last month is one subject,
 * which is not how anyone reads: the library's "recently changed" view then shows a single
 * domain and the growth curve is a straight line.
 */
function page({ dir, title, type, domain, area = null, tags, body, related = [], sources = [], status = 'evergreen' }) {
  const rel = dir === '.' ? `wiki/${fileName(title)}.md` : `wiki/${dir}/${fileName(title)}.md`
  pages.push({ path: rel, domain, area, type, title, tags, body, related, sources, status, created: null })
}

/** Renders the frontmatter once the page has a date. */
function render(p) {
  return [
    '---',
    `type: ${p.type}`,
    `title: "${p.title}"`,
    `domain: ${p.domain}`,
    `created: ${iso(p.created)}`,
    `updated: ${iso(p.created)}`,
    'tags:',
    ...p.tags.map((t) => `  - ${t}`),
    `status: ${p.status}`,
    ...(p.related.length ? ['related:', ...p.related.map((r) => `  - "[[${r}]]"`)] : []),
    ...(p.sources.length ? ['sources:', ...p.sources.map((x) => `  - "[[${x}]]"`)] : []),
    '---',
    '',
  ].join('\n') + p.body + '\n'
}

/* ---------------------------------------------------------------------- the link model */

/**
 * A seeded generator: the same script builds the same vault, and so the same screenshot.
 *
 * The links used to be a fixed ring, each page pointing at its next few neighbours in the
 * topic list. That gave every page the same five or six links and every domain one round
 * blob: no page the others lead back to, so the authority lens and the Landmarks overlay had
 * nothing to rank; no sub-area inside a domain, so Areas found one community per domain and
 * captioned four of them identically; and almost nothing crossing a domain, so Bridges had
 * nothing to draw.
 */
function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = seeded(20260925)
const chance = (p) => rand() < p
const oneOf = (arr) => arr[Math.floor(rand() * arr.length)]
/** Early entries far more often than late ones: an area's first pages are the ones it leans on. */
const leaning = (arr) => arr[Math.floor(arr.length * rand() ** 2)]

/**
 * How often each kind of link is drawn. Tuned against the shape of a real vault of about 1,350
 * knowledge pages (measured 2026-09-25, numbers only): 5.7 links a page, a most-linked page
 * with about 130 inbound links, 7 % of links crossing a domain boundary, about 40 communities
 * over 25 domains, and 470 distinct tags of which a hundred occur once.
 */
const P = {
  /** A link to a later page of the same area, so the area is not a tree hanging off its hub. */
  forward: 0.55,
  /** A link into another area of the same domain: what holds a domain together. */
  sibling: 0.3,
  /** A link to the page the whole domain leads back to. */
  domainHub: 0.36,
  /** A link into a neighbouring domain (`NEIGHBOURS`): what the Bridges overlay draws. */
  cross: 0.38,
  /** A concept naming one of its area's entities. */
  entity: 0.4,
  /** A concept carrying one of its domain's secondary tags. */
  facet: 0.3,
  /** A concept tagged with a tag of its own: the long tail every real tag list has. */
  ownTag: 0.14,
}

/**
 * The forms an ingested document comes in, and the tag each gets. Most are "form" tags that
 * say what kind of page it is rather than what it is about, which the graph keeps out of the
 * Areas captions (`web/src/lib/tagSignal.ts`); a demo whose sources carried none would never
 * show that rule doing anything.
 */
const FORMS = [
  { tag: 'paper', w: 30, title: (t, i) => `${t} ${pick(['(review)', '(methods paper)', '(survey)', '(technical note)', '(analysis)', '(benchmark study)'], i)}` },
  { tag: 'preprint', w: 8, title: (t) => `${t} (preprint)` },
  { tag: 'lecture', w: 14, title: (t, i) => `${t} ${pick(['(lecture notes)', '(handbook chapter)', '(course module)'], i)}` },
  { tag: 'video', w: 12, title: (t) => `${t}, explained (video)` },
  { tag: 'podcast', w: 7, title: (t) => `A conversation on ${t} (podcast)` },
  { tag: 'trade-press', w: 9, title: (t) => `${t} in practice (trade press)` },
  { tag: 'blog', w: 12, title: (t, i) => `${t} ${pick(['(blog post)', '(retrospective)', '(field notes)'], i)}` },
  { tag: 'report', w: 8, title: (t) => `${t} (working group report)` },
]
const FORM_TOTAL = FORMS.reduce((s, f) => s + f.w, 0)
const pickForm = () => {
  let r = rand() * FORM_TOTAL
  for (const f of FORMS) if ((r -= f.w) < 0) return f
  return FORMS[0]
}

const slugTag = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const POPULATED = Object.entries(DOMAINS).filter(([, s]) => (s.areas ?? []).some((a) => a.concepts.length > 0))
const conceptsOf = (key) => DOMAINS[key].areas.flatMap((a) => a.concepts)

/**
 * Two pages nothing links to and that link to nothing, so the orphan lens has something to find:
 * the last concept of the two smallest populated domains, the kind of one-afternoon note a real
 * vault leaves lying about.
 */
const ORPHANS = new Set(
  [...POPULATED].sort((a, b) => conceptsOf(a[0]).length - conceptsOf(b[0]).length).slice(0, 2)
    .map(([key]) => conceptsOf(key).at(-1)),
)
const linkable = (t) => !ORPHANS.has(t)

/** A page in a neighbouring domain: one of its area hubs more often than not. */
function crossTarget(neighbours) {
  const key = oneOf(neighbours)
  return chance(0.6) ? oneOf(DOMAINS[key].areas).concepts[0] : leaning(conceptsOf(key).filter(linkable))
}

/** Rotating question forms, so forty open questions do not all begin with the same words. */
const QUESTION_FORMS = [
  (t) => `What actually limits ${t.toLowerCase()}?`,
  (t) => `Where does the standard account of ${t.toLowerCase()} break down?`,
  (t) => `How far can ${t.toLowerCase()} be trusted outside the textbook case?`,
  (t) => `What would it take to settle the disagreement over ${t.toLowerCase()}?`,
]

/**
 * A paragraph per source and entity page beyond the template's minimum. Without it every one of
 * them fell under the stub size (1 KB), and the stub count read 40 % of the vault where a real
 * one has about 1 %.
 */
const METHODS = [
  'Compares three established approaches on a shared set of cases, holding the inputs fixed so that the differences come from the methods rather than from the data. The comparison is the useful part; the recommendation at the end is more tentative than the abstract suggests.',
  'Builds a simple model first and adds one complication at a time, reporting how much each changes the answer. Most of the effect turns out to come from the first two additions, which is itself the finding worth keeping.',
  'Re-analyses data that were published for a different purpose, which makes the result cheap to check and also limits it: the original selection was not designed for this question, and the text is candid about where that bites.',
  'Walks through a worked example in enough detail to reproduce it, then generalises. The general statement needs assumptions the example happened to satisfy, and the section that lists them is the one to read twice.',
  'Surveys the literature on the question and sorts it by method rather than by conclusion, which shows that most of the apparent disagreement is two methods measuring slightly different things.',
]
const ENTITY_NOTES = [
  'Its published figures change between releases, so a page that quotes one says which release it came from. Older pages in this wiki do not always, and those are the ones to check first when numbers disagree.',
  'Access is open for the summary products and by request for the underlying records. Most pages here rest on the summaries, which is fine for the headline numbers and not for anything that depends on the tails.',
  'It is referred to under several names in the material, which is why the pages that cite it do not always link to it. A search for the older name finds a few more.',
  'Coverage is best for the recent period and thins out further back, so trends that start early lean on fewer, less comparable records than the later part of the same curve.',
]
let entitySeq = 0

let gapSeq = 0
const usedSourceTitles = new Set()

for (const [domain, spec] of POPULATED) {
  const own = spec.tags[0]
  const facets = spec.tags.slice(1)
  const { areas } = spec
  const domainHub = areas[0].concepts[0]
  const neighbours = (NEIGHBOURS[domain] ?? []).filter((k) => DOMAINS[k] !== undefined && conceptsOf(k).length > 0)
  const otherArea = (a) => areas[(a + 1 + Math.floor(rand() * (areas.length - 1))) % areas.length]

  areas.forEach((area, a) => {
    const L = area.concepts
    if (L.length === 0) return
    const areaKey = `${domain}/${area.tag}`
    const entityTitles = spec.entities.filter((e) => e.area === area.tag).map((e) => e.title)

    // The area's documents first: which concepts each one supports.
    const sourceCount = Math.max(1, Math.round(L.length / 1.6))
    const sources = []
    for (let i = 0; i < sourceCount; i++) {
      const form = pickForm()
      let title = null
      for (let k = 0; k < L.length && title === null; k++) {
        const candidate = form.title(L[(Math.floor((i * L.length) / sourceCount) + k) % L.length], i + a)
        if (!usedSourceTitles.has(candidate)) title = candidate
      }
      title ??= `${form.title(L[i % L.length], i)} part ${i + 1}`
      usedSourceTitles.add(title)
      const cited = new Set([L[0]])
      const more = 3 + Math.floor(rand() * 5)
      for (let k = 0; k < more; k++) cited.add(leaning(L))
      if (areas.length > 1 && chance(0.15)) cited.add(leaning(otherArea(a).concepts))
      if (chance(0.3)) cited.add(domainHub)
      if (neighbours.length > 0 && chance(0.2)) cited.add(crossTarget(neighbours))
      sources.push({ title, form, cited: [...cited].filter(linkable) })
    }

    L.forEach((title, j) => {
      if (ORPHANS.has(title)) {
        page({
          dir: 'concepts', title, type: 'concept', domain, area: areaKey,
          tags: ['concept', own, area.tag], status: 'stub',
          body: [`# ${title}`, '', pick(LEADS, j)(title, spec.blurb), '',
            'A note taken in passing and not yet connected to anything else in the wiki.'].join('\n'),
        })
        return
      }
      const rel = new Set()
      if (j > 0) rel.add(L[0])
      else if (a > 0) rel.add(domainHub)
      else for (let k = 0; k < Math.min(2, areas.length - 1); k++) rel.add(areas[k + 1].concepts[0])
      const inward = 2 + (chance(0.6) ? 1 : 0) + (chance(0.3) ? 1 : 0)
      for (let k = 0; k < inward && j > 1; k++) rel.add(L[1 + Math.floor((j - 1) * rand() ** 1.6)])
      // And a page or two of the area picked evenly, so the area is a mesh and not a star.
      const lateral = 1 + (chance(0.6) ? 1 : 0) + (chance(0.3) ? 1 : 0)
      for (let k = 0; k < lateral && L.length > 2; k++) rel.add(oneOf(L))
      if (j < L.length - 1 && chance(P.forward)) rel.add(L[j + 1 + Math.floor(rand() * (L.length - j - 1))])
      if (areas.length > 1 && chance(j === 0 ? 0.6 : P.sibling)) {
        const other = otherArea(a)
        rel.add(chance(0.55) ? other.concepts[0] : leaning(other.concepts))
      }
      if (chance(P.domainHub)) rel.add(domainHub)
      if (neighbours.length > 0 && chance(j === 0 ? P.cross * 2 : P.cross)) rel.add(crossTarget(neighbours))
      for (const [from, to] of CROSS_LINKS) if (from === title) rel.add(to)
      if (entityTitles.length > 0 && chance(P.entity)) rel.add(oneOf(entityTitles))
      rel.delete(title)
      const related = [...rel].filter(linkable)

      const citing = sources.filter((s) => s.cited.includes(title)).map((s) => s.title)
      const named = citing.length > 0 ? citing.slice(0, chance(0.25) ? 2 : 1) : [sources[j % sources.length].title]
      // Every fifth concept points at a page nobody has written - the Gaps overlay counts these.
      const gap = j % 5 === 2 ? GAPS[gapSeq++ % GAPS.length] : null
      const under = related.slice(0, 2)
      const tags = ['concept', own, area.tag]
      // Per page, not per area: a secondary tag handed to a whole area would caption it, and the
      // domain's secondary tags say nothing about which area they land on.
      if (facets.length > 0 && chance(P.facet)) tags.push(oneOf(facets))
      if (chance(P.ownTag)) tags.push(slugTag(title))
      page({
        dir: 'concepts', title, type: 'concept', domain, area: areaKey,
        tags: [...new Set(tags)],
        related,
        sources: named,
        status: j % 17 === 5 ? 'stub' : 'evergreen',
        body: [
          `# ${title}`,
          '',
          pick(LEADS, j + a)(title, spec.blurb),
          '',
          '## Why it matters',
          '',
          `It sits directly under ${under.map((l) => `[[${l}]]`).join(' and ')}, which is why it turns up`,
          `whenever ${spec.blurb} is discussed at any depth.`,
          '',
          '## Detail',
          '',
          pick(DETAILS, j + a),
          pick(DETAILS, j + a + 3),
          '',
          '## In practice',
          '',
          ...pick(PRACTICE, j + a).map((l) => `- ${l}`),
          '',
          '## See also',
          '',
          ...related.map((r) => `- [[${r}]]`),
          ...(gap ? ['', `Still to write: [[${gap}]].`] : []),
        ].join('\n'),
      })
    })

    for (const s of sources) {
      page({
        dir: 'sources', title: s.title, type: 'source', domain, area: areaKey,
        tags: ['source', s.form.tag, own, area.tag],
        related: s.cited,
        status: 'reference',
        body: [
          `# ${s.title}`,
          '',
          `A synthetic stand-in for an ingested document about ${spec.blurb}. It exists so the`,
          'dashboard has provenance to show: the pages below were written from it.',
          '',
          '## Summary',
          '',
          'Reviews the established method, states where it breaks down, and proposes a correction that',
          'trades a little precision for a good deal of robustness. The useful contribution is the',
          'failure catalogue rather than the correction itself.',
          '',
          '## Extracted claims',
          '',
          ...s.cited.map((c) => `- Supports [[${c}]].`),
          '',
          '## Method',
          '',
          pick(METHODS, sources.indexOf(s) + a),
          '',
          '## Caveats',
          '',
          '- The sample is convenient rather than representative.',
          '- Uncertainties are quoted as statistical only; the systematic term is larger.',
        ].join('\n'),
      })
    }

    spec.entities.filter((x) => x.area === area.tag).forEach((e) => {
      const rel = new Set([L[0]])
      const more = 3 + Math.floor(rand() * 4)
      for (let k = 0; k < more; k++) rel.add(leaning(L))
      const related = [...rel].filter(linkable)
      page({
        dir: 'entities', title: e.title, type: 'entity', domain, area: areaKey,
        tags: ['entity', e.kind, own, area.tag],
        related,
        body: [
          `# ${e.title}`,
          '',
          `Appears throughout the ${domain} material as the thing that produced, holds or standardises`,
          'the data other pages argue about.',
          '',
          '## Role',
          '',
          'Pages cite it when the provenance of a number matters: what was measured, under which',
          'programme, and which release the figure came from.',
          '',
          '## What it constrains',
          '',
          'Its coverage and cadence set what questions can be asked at all. A gap in the record is not',
          'a null result, and treating it as one is the most common way conclusions drift from what the',
          'data can support.',
          '',
          // A few entities stay a stub on purpose: a real vault has a handful of pages that were
          // started and never filled, and the stub filter should find something.
          ...(++entitySeq % 25 === 0 ? [] : ['', '## Notes', '', pick(ENTITY_NOTES, entitySeq)]),
          '',
          '## Related',
          '',
          ...related.map((c) => `- [[${c}]]`),
        ].join('\n'),
      })
    })
  })

  // Open questions, about one per fourteen concepts, each on an area's hub.
  const all = conceptsOf(domain).filter(linkable)
  const questionCount = Math.min(8, Math.max(1, Math.round(all.length / 14)))
  for (let i = 0; i < questionCount; i++) {
    const area = areas[i % areas.length]
    const anchor = area.concepts[0]
    const cited = [...new Set([leaning(area.concepts), leaning(area.concepts), leaning(all)])].filter((c) => c !== anchor && linkable(c))
    const title = pick(QUESTION_FORMS, i + domain.length)(anchor)
    page({
      dir: 'questions', title, type: 'question', domain, area: `${domain}/${area.tag}`,
      tags: ['question', own, area.tag],
      related: [anchor, ...cited],
      status: 'open',
      body: [
        `# ${title}`,
        '',
        'Asked while reading, answered from the pages below.',
        '',
        '## Working answer',
        '',
        'Not one mechanism but two that are easy to confuse, because they leave the same signature in',
        'the usual summary plot and separate only when the raw observable is kept. The pages below',
        'cover each in turn; the comparison between them is where the answer is.',
        '',
        '## Sources of the answer',
        '',
        `- [[${anchor}]]`,
        ...cited.map((c) => `- [[${c}]]`),
        '',
        '',
        '## Why it is not settled',
        '',
        'The two candidate explanations predict the same thing everywhere the usual data set has',
        'coverage, and differ only in the regime that is hardest to measure. Ruling one out needs',
        'either a longer baseline or an instrument that does not share the systematic, and neither',
        'is available on the timescale most projects work to.',
        '',
        'Still open: whether the distinction matters at the precision most work reports.',
      ].join('\n'),
    })
  }

  // One comparison per domain that has enough to compare, from its core area.
  const core = areas.find((x) => x.concepts.filter(linkable).length >= 3)
  if (all.length >= 12 && core !== undefined) {
    const [a, b, c] = core.concepts.filter(linkable)
    page({
      dir: 'comparisons',
      title: `${a} vs ${b}`,
      type: 'comparison',
      domain,
      area: `${domain}/${core.tag}`,
      tags: ['comparison', own, core.tag],
      related: [a, b, c],
      body: [
        `# ${a} vs ${b}`,
        '',
        'Two approaches to the same problem, with different failure modes.',
        '',
        `| | [[${a}]] | [[${b}]] |`,
        '|---|---|---|',
        '| Measures | the direct observable | the indirect one |',
        '| Needs | a favourable configuration | a quiet baseline |',
        '| Fails on | edge geometry | correlated noise |',
        '',
        `Where they disagree, [[${c}]] is usually the reason.`,
        '',
        '## When to reach for which',
        '',
        `Use [[${a}]] when the configuration cooperates and you want the quantity directly; the`,
        'result is then easy to defend and needs little modelling. Its weakness is that the',
        'favourable case is rare, so a survey built on it alone measures a biased subset.',
        '',
        `[[${b}]] applies far more widely and is correspondingly harder to interpret: what it`,
        'returns is a lower bound rather than the quantity itself, and the correction between the',
        'two carries the assumption most disagreements turn out to be about.',
        '',
        'In practice the two are complementary rather than competing, and the pages that combine',
        'them report the tightest constraints.',
      ].join('\n'),
    })
  }
}

/* Two pages deliberately unfiled, so the `unassigned` bucket is not empty. */
for (const title of ['Signal Averaging Across Instruments', 'Calibration Drift']) {
  page({
    dir: 'concepts',
    title,
    type: 'concept',
    domain: 'unassigned',
    tags: ['concept', 'measurement'],
    related: ['Photometric Precision', 'Proxy Calibration'],
    body: [
      `# ${title}`,
      '',
      'Belongs to measurement in general rather than to one subject, so it is filed nowhere yet.',
      '',
      'Related: [[Photometric Precision]], [[Proxy Calibration]].',
    ].join('\n'),
  })
}

/* References and meta: the wiki's own machinery, which the System toggle hides in the graph. */
page({
  dir: 'references',
  title: 'Unit Conventions',
  type: 'reference',
  domain: 'meta',
  tags: ['reference', 'meta'],
  status: 'reference',
  body: ['# Unit Conventions', '',
    'Which units pages use when a field could reasonably take several.', '',
    '- Radii in Earth radii for rocky planets, Jupiter radii above.',
    '- Temperatures in kelvin in [[Equilibrium Temperature]] contexts, Celsius in [[Maillard Reaction]] ones.',
    '- Byte sizes are powers of ten unless a page says otherwise.'].join('\n'),
})
page({
  dir: 'references',
  title: 'Citation Style',
  type: 'reference',
  domain: 'meta',
  tags: ['reference', 'meta'],
  status: 'reference',
  body: ['# Citation Style', '',
    'Sources are pages. A claim cites the source page, which links back to the raw document.', '',
    'See [[Unit Conventions]] for the other house rule.'].join('\n'),
})
page({
  dir: '.',
  title: 'index',
  type: 'meta',
  domain: 'meta',
  tags: ['meta', 'index'],
  body: ['# Index', '', 'Entry point to the wiki.', '',
    ...Object.entries(DOMAINS).map(([d, s]) => `- **${d}** - ${s.blurb}`)].join('\n'),
})
page({
  dir: '.',
  title: 'hot',
  type: 'meta',
  domain: 'meta',
  tags: ['meta', 'hot-cache'],
  body: ['# Hot Cache', '', 'A digest of the vault, refreshed after ingests.', '',
    `Currently ${pages.length + 2} pages across ${Object.keys(DOMAINS).length} domains.`, '',
    'One subject is far deeper than the others; the long tail is one-afternoon detours.'].join('\n'),
})

/** The domain registry, in the shape install-domain-registry.sh seeds. */
const registry = [
  '---', 'type: meta', 'title: "Domain Registry"', 'domain: meta',
  `created: ${iso(day(SPAN_DAYS))}`, `updated: ${iso(day(4))}`,
  'tags:', '  - meta', '  - domains', 'status: evergreen', '---', '',
  '# Domain Registry', '',
  'The list of meta-categories this wiki uses. Every page carries exactly one of these keys in',
  'its `domain:` frontmatter field. This page is the single source of truth for that list.', '',
  '## Domains', '',
  ...Object.entries(DOMAINS).flatMap(([key, spec]) => [
    `## ${key}`, '',
    spec.blurb.charAt(0).toUpperCase() + spec.blurb.slice(1) + '.', '',
    `**Tags:** ${spec.tags.map((t) => `\`${t}\``).join(', ')}`, '',
  ]),
  '## meta', '',
  "The wiki's own machinery rather than a subject: index and overview pages, the hot cache, and",
  'this page.', '', '**Tags:** `meta`, `index`, `hot-cache`', '',
].join('\n')
pages.push({
  path: 'wiki/meta/domains.md', domain: 'meta', type: 'meta', title: 'Domain Registry',
  tags: ['meta', 'domains'], related: [], sources: [], status: 'evergreen',
  body: registry, created: day(SPAN_DAYS), prerendered: true,
})

/* ------------------------------------------------------------------------- the Fellows
 *
 * Defined here rather than beside the database writes below, because both need them: the
 * vault gets a notebook page per Fellow and the recap pages of the last nights, and the
 * database gets the records that make them appear in the dashboard. One definition, so a
 * screenshot cannot show a Fellow whose notebook says something else.
 */
const FELLOWS = [
  {
    name: 'Ada', domain: 'astronomy', art: 'watch', autonomy: 'veto', nightly: 'sweep',
    model: 'sonnet-5', quota: 2, priority: 2, state: 'waiting', age: 46,
    scope: 'Instruments and detections, not the underlying stellar physics.',
    tasks: [
      { kind: 'watch', text: 'New transit detections around bright host stars' },
      { kind: 'watch', text: 'Adaptive optics upgrades on ground-based instruments' },
    ],
  },
  {
    name: 'Casper', domain: 'climate-science', art: 'custom', autonomy: 'veto', nightly: 'sweep',
    model: 'sonnet-5', quota: 3, priority: 1, state: 'waiting', age: 31,
    scope: 'The carbon cycle and the records that constrain it.',
    tasks: [
      { kind: 'watch', text: 'Revisions to ocean carbon sink estimates' },
      { kind: 'explore', text: 'How far do proxy records narrow climate sensitivity?' },
      { kind: 'deepen', text: 'Feedback mechanisms, which the wiki names more than it explains' },
    ],
  },
  {
    name: 'Mira', domain: 'machine-learning', art: 'explore', autonomy: 'auto', nightly: 'rotate',
    model: 'opus-5', quota: 1, priority: 0, state: 'waiting', age: 19,
    scope: null,
    tasks: [
      { kind: 'explore', text: 'When does retrieval beat a longer context window?' },
      { kind: 'explore', text: 'What makes an evaluation set go stale?' },
    ],
  },
  {
    name: 'Milo', domain: 'materials-science', art: 'deepen', autonomy: 'veto', nightly: 'sweep',
    model: 'sonnet-5', quota: 1, priority: 0, state: 'sleeping', age: 12,
    sleep_code: 'covered', sleep_reason: 'the theme is built out; nothing thin enough to deepen',
    scope: 'Processing and failure modes, not crystallography.',
    tasks: [{ kind: 'deepen', text: 'Sintering and the defects it leaves behind' }],
  },
]

/**
 * What each Fellow has written down as unanswered - its own, because the recap lists them per
 * Fellow and four identical lists read as a template rather than as work.
 */
const FELLOW_QUESTIONS = {
  Ada: [
    'Which follow-up would settle the ambiguous candidate first, spectroscopy or a second transit?',
    'Does the scintillation floor move enough between sites to be worth travelling for?',
  ],
  Casper: [
    'Does the coastal treatment explain the whole spread between the products, or only most of it?',
    'Is there a proxy record that avoids the shared calibration step entirely?',
  ],
  Mira: [
    'Can an evaluation set be built so that fitting its distribution IS the task?',
    'What is the earliest observable sign that a benchmark has stopped ranking?',
  ],
  Milo: [
    'Which of the defect classes actually survives into service, and which anneal out?',
  ],
}

/**
 * A notebook page per Fellow: `type: meta` on purpose, the way the service writes them, so
 * the vault's own tiling and address rules leave them alone.
 */
for (const f of FELLOWS) {
  const slug = f.name.toLowerCase()
  const created = day(f.age)
  pages.push({
    path: `wiki/meta/agents/${slug}.md`, domain: 'meta', type: 'meta',
    title: f.name, tags: ['meta', 'agent'], related: [], sources: [], status: 'evergreen',
    created, prerendered: true,
    body: [
      '---', 'type: meta', `title: "${f.name}"`, 'domain: meta',
      `created: ${iso(created)}`, `updated: ${iso(day(1))}`,
      'tags:', '  - meta', '  - agent', 'status: evergreen', '---', '',
      `# ${f.name}`, '',
      `Home domain: \`${f.domain}\`. Works as a ${f.art === 'custom' ? 'custom mix' : f.art} Fellow, `
        + `${f.nightly === 'sweep' ? 'every standing task each night' : 'one task a night in turn'}, `
        + `at most ${f.quota} run${f.quota === 1 ? '' : 's'} a day, autonomy \`${f.autonomy}\`.`,
      ...(f.scope ? ['', `Scope: ${f.scope}`] : []),
      '', '## Standing work', '',
      ...f.tasks.map((t) => `- **${t.kind}** - ${t.text}`),
      '', '## Log', '',
      '| date | kind | topic | pages | cost |',
      '| --- | --- | --- | --- | --- |',
      `| ${iso(day(1))} | research-step | ${f.tasks[0].text.slice(0, 48)} | 2 | 1.94 |`,
      `| ${iso(day(5))} | research | ${f.tasks[f.tasks.length - 1].text.slice(0, 48)} | 6 | 4.12 |`,
      '', '## Open Questions', '',
      ...FELLOW_QUESTIONS[f.name].map((q) => `- ${q}`),
      '', '## Plan', '',
      '- Standing, undecided: one step on the question the last run left behind.',
      '',
    ].join('\n'),
  })
}

/*
 * ------------------------------------------------------- the real research runs
 *
 * Five of the research runs this demo shows are REAL: they cost money, took ten minutes each
 * and searched the actual web. `capture-research-run.mjs` froze each into
 * `scripts/demo-research/<slug>/`, and this reads them back, because the vault is rebuilt from
 * scratch every time this script runs and anything an agent wrote would otherwise live exactly
 * until the next rebuild.
 *
 * The hub pages a run touches on its way (`hot.md`, `index.md`, `log.md`, the reading list,
 * the domain registry) are deliberately NOT restored: this generator writes those itself, for
 * the whole vault rather than for one run, and a run's copy of them describes a vault that had
 * only that run in it.
 */
const RESEARCH_DIR = join(process.cwd(), 'scripts/demo-research')
/** Pages the generator owns; a captured run's copy of them is its snapshot, not the vault's. */
const HUB_PAGES = new Set(['wiki/hot.md', 'wiki/index.md', 'wiki/log.md', 'wiki/meta/reading-list.md', 'wiki/meta/domains.md'])

const capturedRuns = []
/** Entries the real runs put on the reading list, kept out of their hub-page snapshot. */
const realReadingEntries = []
const seenReadingUrls = new Set()
if (existsSync(RESEARCH_DIR)) {
  for (const slug of readdirSync(RESEARCH_DIR).sort()) {
    const runFile = join(RESEARCH_DIR, slug, 'run.json')
    if (!existsSync(runFile)) continue
    const run = JSON.parse(readFileSync(runFile, 'utf8'))
    const kept = []
    for (const rel of run.pages) {
      if (HUB_PAGES.has(rel)) continue
      const file = join(RESEARCH_DIR, slug, 'pages', rel)
      if (!existsSync(file)) continue
      const body = readFileSync(file, 'utf8')
      const title = /^title:\s*"?(.+?)"?\s*$/m.exec(body)?.[1] ?? rel.split('/').pop().replace(/\.md$/, '')
      pages.push({
        path: rel,
        domain: /^domain:\s*(\S+)\s*$/m.exec(body)?.[1] ?? 'meta',
        type: /^type:\s*(\S+)/m.exec(body)?.[1] ?? 'concept',
        title, tags: [], related: [], sources: [], status: 'evergreen',
        // Dated by the run that wrote it, so the vault's timeline stays honest.
        created: new Date(Date.parse(run.capturedAt) - (run.durationMs ?? 0)),
        prerendered: true, body,
      })
      kept.push(rel)
    }
    /*
     * The reading list is a hub page and is not restored wholesale - but the ENTRIES a run
     * added to it are its own output and are worth keeping: real publications it could not
     * read, with real addresses. They are pulled out here and appended to the generated list
     * further down, so the demo's reading list has something on it that was genuinely asked
     * for rather than only invented.
     */
    const listFile = join(RESEARCH_DIR, slug, 'pages/wiki/meta/reading-list.md')
    if (existsSync(listFile)) {
      const blocks = readFileSync(listFile, 'utf8').split(/\n(?=- title:)/).slice(1)
      for (const b of blocks) {
        // Only what a RESEARCH run asked for. A run's snapshot also contains whatever was on
        // the list when it ran, including entries this generator wrote itself, and taking
        // those back would both duplicate them and resurrect ones since removed.
        if (!/^\s*by:\s*research\s*$/m.test(b)) continue
        const url = /^\s*url:\s*(\S+)/m.exec(b)?.[1] ?? ''
        // Two runs that ran after each other snapshot the same earlier entries; keep one.
        if (url === '' || seenReadingUrls.has(url)) continue
        seenReadingUrls.add(url)
        realReadingEntries.push('- ' + b.trim().replace(/^- /, '').trimEnd())
      }
    }
    capturedRuns.push({ ...run, keptPages: kept })
  }
}

/** The recap pages of the last three nights, as the recap service renders them. */
for (let d = 1; d <= 3; d++) {
  const night = day(d)
  const cycle = iso(night)
  pages.push({
    path: `wiki/meta/recaps/Recap ${cycle}.md`, domain: 'meta', type: 'meta',
    title: `Recap ${cycle}`, tags: ['meta', 'recap'], related: [], sources: [],
    status: 'evergreen', created: night, prerendered: true,
    body: [
      '---', 'type: meta', `title: "Recap ${cycle}"`, 'domain: meta',
      `created: ${cycle}`, `updated: ${cycle}`,
      'tags:', '  - meta', '  - recap', 'status: evergreen', '---', '',
      `# Recap ${cycle}`, '',
      `The night ran ${2 + (d % 2)} of 3 planned runs and spent about ${(2.1 * (2 + (d % 2))).toFixed(2)} USD.`, '',
      '## Ada - astronomy', '',
      '- **research-step** - a bright-host transit candidate and its follow-up photometry (2 pages)',
      '', 'Open question: which follow-up would settle the ambiguous candidate?', '',
      '## Casper - climate-science', '',
      '- **research-expand** - feedback pages, built out from their own open questions (4 pages)',
      '', '## Waiting for you', '',
      '- **1a** research-step: follow-up spectroscopy on the brightest candidate. Runs tonight unless vetoed.',
      '- **1b** research-expand: the three feedback pages the wiki links to most and explains least.',
      '', '## Asleep', '',
      '- Milo: the theme is built out; nothing thin enough to deepen.', '',
    ].join('\n'),
  })
}

/** The reading list: publications a run could not read, two with an open copy found. */
pages.push({
  path: 'wiki/meta/reading-list.md', domain: 'meta', type: 'meta', title: 'Reading list',
  tags: ['meta', 'reading-list'], related: [], sources: [], status: 'evergreen',
  created: day(40), prerendered: true,
  body: [
    '---', 'type: meta', 'title: "Reading list"', 'domain: meta',
    `created: ${iso(day(40))}`, `updated: ${iso(day(1))}`,
    'tags:', '  - meta', '  - reading-list', 'status: evergreen', '---', '',
    '# Reading list', '',
    'Publications worth having in the original. A run adds an entry when it could not read one',
    'itself; the nightly sweep looks for a legal open copy and marks what it finds.', '',
    '## Entries', '',
    // What the real runs asked for: actual publications at actual addresses.
    ...realReadingEntries.flatMap((e) => [e, '']),
  ].join('\n'),
})

/* --------------------------------------------------------------------------- timeline */

/**
 * Stamp every page with a creation date, in reading order rather than build order.
 *
 * Pages are built area by area, but nobody reads that way: a real vault interleaves subjects,
 * a few pages at a sitting. So each area is cut into sittings (a source page plus the concepts
 * around it stay together, which is also what one ingest writes), and the sittings are laid
 * down across the span with an uneven cadence - busy weeks and quiet ones - so the growth curve
 * has a shape.
 *
 * An area is read in a stretch rather than scattered evenly over five months: it gets a time
 * of its own and its sittings fall around it. That is what gives the recency lens something to
 * show inside one domain, the area read last month beside the one read in spring, instead of
 * every area the same even mix of old and new.
 */
function assignTimeline() {
  const undated = pages.filter((p) => p.created === null)
  const byArea = new Map()
  for (const p of undated) {
    const key = p.area ?? `${p.domain}/`
    if (!byArea.has(key)) byArea.set(key, [])
    byArea.get(key).push(p)
  }
  // Its own generator, so a change to the link model does not reshuffle the calendar.
  const next = seeded(20260827)
  const sittings = []
  for (const group of byArea.values()) {
    const era = next()
    const count = Math.ceil(group.length / 6)
    for (let i = 0; i < group.length; i += 6) {
      const c = i / 6
      sittings.push({ pages: group.slice(i, i + 6), key: era * 0.7 + (c / count) * 0.12 + next() * 0.3 })
    }
  }
  sittings.sort((a, b) => a.key - b.key)

  // Uneven cadence: weight each sitting so some days take several and others none.
  const weights = sittings.map((_, i) => 0.35 + Math.abs(Math.sin(i * 0.7)) + (i % 11 === 0 ? 1.6 : 0))
  const total = weights.reduce((a, b) => a + b, 0)
  let acc = 0
  sittings.forEach((sitting, i) => {
    acc += weights[i]
    const daysAgo = Math.max(2, Math.round(SPAN_DAYS - (acc / total) * (SPAN_DAYS - 2)))
    for (const pg of sitting.pages) pg.created = day(daysAgo)
  })
}
assignTimeline()

/* --------------------------------------------- one question, on every page it was left on */

/*
 * A vault writes a gap down wherever it meets it: a run that cannot settle something leaves the
 * same open item on its notebook, on the page it filed and on the concept page it touched, in
 * the wording each page invited. That is the shape the pinboard's clustering exists for - one
 * card, with the other pages as "also on" links - and without it every card is a singleton and
 * that half of the board never appears in a screenshot.
 *
 * The wordings are checked against the board's own rule rather than eyeballed: `questionOverlap`
 * over the significant tokens puts both of these at 1.00 against the notebook's wording, where
 * `CLUSTER_THRESHOLD` is 0.7. The lead is Ada's first standing question because she is the
 * astronomy Fellow and these are her pages.
 */
const SPREAD_QUESTIONS = [
  ['Candidate Vetting Pipeline',
   'Would spectroscopy or a second transit settle the ambiguous candidate first?'],
  ['Blended Eclipsing Binary',
   'For the ambiguous candidate, which follow-up settles it first: spectroscopy or a second transit?'],
]
for (const [title, question] of SPREAD_QUESTIONS) {
  const target = pages.find((p) => p.title === title && p.prerendered !== true)
  // Loudly, not silently: the topic list is hand-written and a renamed concept would otherwise
  // just quietly stop producing the cluster the screenshot exists to show.
  if (!target) throw new Error(`demo vault: no page titled "${title}" to leave an open question on`)
  target.body = `${target.body}\n\n## Open Questions\n\n- ${question}\n`
}

/* ------------------------------------------------------------------------- write it out */

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
for (const dir of ['wiki/concepts', 'wiki/entities', 'wiki/sources', 'wiki/questions',
                   'wiki/comparisons', 'wiki/references', 'wiki/meta', 'skills/ingest', '.raw']) {
  mkdirSync(join(OUT, dir), { recursive: true })
}
writeFileSync(join(OUT, 'skills/ingest/SKILL.md'),
  '---\nname: ingest\ndescription: Demo placeholder so the vault shape validates.\n---\n\n# ingest\n\nPlaceholder.\n')
writeFileSync(join(OUT, 'README.md'),
  '# Demo vault\n\nGenerated by `scripts/demo-vault.mjs`. Every page here is synthetic.\n')

for (const p of pages) {
  p.content = p.prerendered === true ? p.body : render(p)
  mkdirSync(dirname(join(OUT, p.path)), { recursive: true })
  writeFileSync(join(OUT, p.path), p.content)
  // Without this every page reads "1 min ago" in the library's Changed column.
  utimesSync(join(OUT, p.path), p.created, p.created)
}

/* --------------------------------------------------------------------------- provenance */

/**
 * `.raw/<job>/` holds the document an ingest read, and `.raw/.manifest.json` maps each raw
 * file to the pages it created. That tracker - not SQLite - is what the Library's Source
 * column reads, because provenance has to survive losing the operational database.
 */
const STUB_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj',
  '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  '5 0 obj<</Length 58>>stream',
  'BT /F1 10 Tf 16 64 Td (Synthetic demo document.) Tj ET',
  'endstream endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
].join('\n')

const slugFile = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
const rawSources = {}
const sourcePageList = pages.filter((p) => p.path.startsWith('wiki/sources/'))
const jobRecords = []

sourcePageList.forEach((sp, i) => {
  const jobId = `demo-${String(i + 1).padStart(3, '0')}`
  const title = /^title: "(.+)"$/m.exec(sp.content)?.[1] ?? 'document'
  const isWeb = i % 9 === 4
  const isText = i % 17 === 7
  const name = `${slugFile(title)}.${isWeb ? 'html' : isText ? 'md' : 'pdf'}`
  mkdirSync(join(OUT, '.raw', jobId), { recursive: true })
  writeFileSync(join(OUT, '.raw', jobId, name),
    isWeb ? '<!doctype html><title>Synthetic demo document</title><p>Generated for screenshots.</p>\n'
      : isText ? '# Synthetic demo document\n\nGenerated for screenshots.\n' : STUB_PDF)
  const url = isWeb ? `https://example.invalid/${slugFile(title)}` : null
  writeFileSync(join(OUT, '.raw', jobId, 'manifest.json'),
    JSON.stringify({ original: name, type: isWeb ? 'web' : isText ? 'text' : 'pdf', url }, null, 2) + '\n')
  // The source page itself, plus the concepts that cite it.
  const created = [
    sp.path,
    ...pages
      .filter((q) => q.path.startsWith('wiki/concepts/') && q.content.includes(`[[${title}]]`))
      .slice(0, 5)
      .map((q) => q.path),
  ]
  rawSources[`.raw/${jobId}/${name}`] = { ingested_at: sp.created.toISOString(), pages_created: created }
  jobRecords.push({ jobId, name, url, type: isWeb ? 'web' : isText ? 'text' : 'pdf', created, at: sp.created })
})
writeFileSync(join(OUT, '.raw', '.manifest.json'), JSON.stringify({ sources: rawSources }, null, 2) + '\n')

/* --------------------------------------------------------------- backdated git history */

const git = (a, env = {}) => execFileSync('git', a, { cwd: OUT, env: { ...process.env, ...env }, stdio: 'pipe' })

git(['init', '-q', '-b', 'vault-main'])
git(['config', 'user.name', 'LibrisVault Demo'])
git(['config', 'user.email', 'demo@example.invalid'])

/**
 * Chronological, because `git log --since` walks the parent chain and stops at the first
 * commit older than the window. A single out-of-order date (the registry page is built last
 * but dated first) truncates the history the growth chart can see to one day.
 */
const ordered = [...pages].sort((a, b) => a.created - b.created)
/*
 * Commits. A real research run's pages get a commit of their OWN, labelled as that run, rather
 * than being swept into an ingest's bucket - which is what happened first, and put a patent
 * synthesis under "ingest: some-file.pdf" in the activity stream. A commit message is how the
 * stream says which kind of work produced a page, so getting it wrong misattributes the whole
 * run at the one place a reader looks.
 */
const realPagePaths = new Map()
for (const run of capturedRuns) for (const rel of run.keptPages) realPagePaths.set(rel, run)

const commitPlan = []
let bucket = []
for (const p of ordered) {
  if (realPagePaths.has(p.path)) continue
  bucket.push(p)
  // An ingest typically writes a source page plus a handful of concepts.
  if (bucket.length >= 6) {
    commitPlan.push(bucket)
    bucket = []
  }
}
if (bucket.length) commitPlan.push(bucket)

git(['add', 'README.md', 'skills', '.raw'])
git(['commit', '-q', '-m', 'chore: vault scaffold'], {
  GIT_AUTHOR_DATE: day(SPAN_DAYS + 1).toISOString(),
  GIT_COMMITTER_DATE: day(SPAN_DAYS + 1).toISOString(),
})

const commitNames = jobRecords.map((j) => j.name)
commitPlan.forEach((group, i) => {
  const when = group[group.length - 1].created
  const stamp = new Date(when.getTime() + (i % 9) * 3_600_000).toISOString()
  for (const p of group) git(['add', '--', p.path])
  const name = commitNames[i % commitNames.length]
  git(['commit', '-q', '-m', `ingest: ${name}`], { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp })
})

/** One commit per real run, in the message shape the service itself writes for one. */
for (const run of capturedRuns) {
  const theirs = ordered.filter((p) => realPagePaths.get(p.path) === run)
  if (theirs.length === 0) continue
  for (const p of theirs) git(['add', '--', p.path])
  const stamp = new Date(Date.parse(run.capturedAt)).toISOString()
  git(['commit', '-q', '-m', `research: ${run.topic}`], { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp })
}

console.log(`vault:  ${OUT}`)
console.log(`        ${pages.length} pages, ${Object.keys(DOMAINS).length} domains, ${commitPlan.length + 1} commits`)

/* ------------------------------------------------------------- the operational database */

const { default: Database } = await import('better-sqlite3')
mkdirSync(dirname(DB), { recursive: true })
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true })

const { migrate } = await import(join(process.cwd(), 'server/dist/db/index.js'))
const db = new Database(DB)
migrate(db)

const ulid = (n) => `01DEMO${String(n).padStart(20, '0')}`
const at = (d) => d.toISOString()

const jobStmt = db.prepare(
  `INSERT INTO jobs (id, user_id, source, type, original_name, url, sha256, status, created_pages,
                     attempts, tokens_in, tokens_out, cost_usd, created_at, started_at, finished_at, error)
   VALUES (@id, 'local', @source, @type, @original_name, @url, @sha256, @status, @created_pages,
           @attempts, @tokens_in, @tokens_out, @cost_usd, @created_at, @started_at, @finished_at, @error)`,
)

/**
 * Only recent ingests get a job row. The dashboard's history is operational state with a
 * 30-day view; an older vault has pages whose job record was long since cleared, which is
 * exactly the state a real install is in.
 */
const recentJobs = jobRecords.filter((j) => j.at >= day(30))
recentJobs.forEach((j, i) => {
  jobStmt.run({
    id: ulid(i + 1),
    source: i % 6 === 0 ? 'watch' : j.type === 'web' ? 'url' : 'drop',
    type: j.type,
    original_name: j.name,
    url: j.url,
    sha256: `demo${String(i).padStart(60, '0')}`,
    status: 'done',
    created_pages: JSON.stringify(j.created),
    attempts: 1,
    tokens_in: 34_000 + ((i * 2_411) % 60_000),
    tokens_out: 4_800 + ((i * 317) % 9_000),
    cost_usd: Number((0.18 + ((i * 37) % 210) / 400).toFixed(3)),
    created_at: at(j.at),
    started_at: at(new Date(j.at.getTime() + 20_000)),
    finished_at: at(new Date(j.at.getTime() + 190_000 + (i % 11) * 9_000)),
    error: null,
  })
})

/* One failure and one duplicate, so the filters and the status vocabulary are visible. */
jobStmt.run({
  id: ulid(900), source: 'drop', type: 'pdf', original_name: 'scanned-handout.pdf', url: null,
  sha256: `demo${String(900).padStart(60, '0')}`, status: 'failed', created_pages: '[]', attempts: 2,
  tokens_in: 4_100, tokens_out: 200, cost_usd: 0.02,
  created_at: at(day(3)), started_at: at(day(3)), finished_at: at(new Date(day(3).getTime() + 64_000)),
  error: 'preprocessing: no extractable text layer (OCR produced 12 characters)',
})
jobStmt.run({
  id: ulid(901), source: 'watch', type: 'pdf',
  original_name: recentJobs[2]?.name ?? 'duplicate.pdf', url: null,
  sha256: `dup${String(901).padStart(61, '0')}`, status: 'duplicate', created_pages: '[]', attempts: 1,
  tokens_in: null, tokens_out: null, cost_usd: null,
  created_at: at(day(2)), started_at: at(day(2)), finished_at: at(new Date(day(2).getTime() + 1_400)),
  error: null,
})

/** Agent runs: what System's usage section and Home's stream read. */
const runStmt = db.prepare(
  `INSERT INTO agent_runs (id, user_id, kind, label, profile_key, ok, pages, tokens_in, tokens_out,
                           cost_usd, error, started_at, finished_at)
   VALUES (@id, 'local', @kind, @label, @profile_key, @ok, @pages, @tokens_in, @tokens_out,
           @cost_usd, NULL, @started_at, @finished_at)`,
)
const conceptPaths = pages.filter((p) => p.path.startsWith('wiki/concepts/')).map((p) => p.path)
const MAINT_SECONDS = { research: 610, lint: 512, 'hot-cache': 21, 'domain-backfill': 140, 'lint-fix': 205, 'domain-review': 96 }
const RUNS = [
  ['lint', null, null, 0, 118_000, 3_900, 0.52, 1],
  ['hot-cache', null, null, 1, 47_000, 2_300, 0.21, 1],
  ['domain-backfill', null, null, 23, 104_000, 7_800, 0.63, 6],
  ['lint-fix', null, null, 8, 88_000, 6_400, 0.51, 2],
  ['domain-review', null, null, 0, 39_000, 2_100, 0.18, 8],
]
RUNS.forEach(([kind, label, profile, pageCount, tin, tout, cost, daysAgo], i) => {
  const started = day(daysAgo)
  runStmt.run({
    id: ulid(200 + i), kind, label, profile_key: profile, ok: 1,
    /*
     * A research run's own synthesis page first, then the concept pages it wrote along the
     * way. The order is what the Research tab shows: the result, and then the material. A run
     * with no synthesis in its page list is one whose result cannot be opened.
     */
    pages: JSON.stringify(conceptPaths.slice(i * 17, i * 17 + pageCount)),
    tokens_in: tin, tokens_out: tout, cost_usd: cost,
    // Same rule as the Fellow runs below: the length follows the KIND. These used to be one
  // rising series, which put a full research run at five minutes and skewed every median
  // drawn from this vault.
  started_at: at(started),
  finished_at: at(new Date(started.getTime() + ((MAINT_SECONDS[kind] ?? 300) + i * 11) * 1000)),
  })
})

/*
 * The real runs in the ledger, with the numbers they actually produced: their own cost, their
 * own duration, their own token counts, and the pages they actually wrote. Nothing here is
 * rounded or prettied - a demo whose figures are invented cannot be used to check the
 * arithmetic the schedule does with them.
 */
capturedRuns.forEach((run, i) => {
  const finished = new Date(Date.parse(run.capturedAt))
  const started = new Date(finished.getTime() - (run.durationMs ?? 600_000))
  // Spread them over the recent weeks rather than stacking them on the capture date, which
  // would put five ten-minute runs inside the same afternoon.
  const shift = (i * 3 + 2) * 86_400_000
  runStmt.run({
    id: ulid(900 + i),
    kind: run.kind ?? 'research',
    label: run.topic,
    profile_key: run.profileKey ?? null,
    ok: 1,
    pages: JSON.stringify(run.keptPages),
    tokens_in: run.tokensIn,
    tokens_out: run.tokensOut,
    cost_usd: run.costUsd,
    started_at: at(new Date(started.getTime() - shift)),
    finished_at: at(new Date(finished.getTime() - shift)),
  })
})

/*
 * Settings the demo needs to be internally consistent.
 *
 * `rosterShare` prices the whole roster against the week's research budget - four Fellows at
 * their quotas is 49 runs a week, and at the REAL costs the captured runs established (three
 * to four dollars a piece, not the reference constants) that is about $196. Against the
 * default share of ten percent of a $1000 plan, the command centre correctly reports 206% and
 * paints it red. The figure is right; the configuration is what is wrong for a demo, where a
 * standing red warning reads as a broken screen rather than as the guard working.
 *
 * So the demo gives the Fellows a quarter of the plan, which is what someone running four of
 * them in earnest would do, and the banner lands near 80%: visibly near the limit, which is
 * the honest picture, without crossing it.
 */
const setting = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
setting.run('researchShareWeekPct', '25')
setting.run('researchShare5hPct', '30')

/** Saved conversations, so Research opens with a ledger rather than an empty state. */
const sess = db.prepare(`INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES (?, 'local', ?, ?, ?)`)
const msg = db.prepare(`INSERT INTO messages (session_id, role, content, citations, ts) VALUES (?, ?, ?, ?, ?)`)
/**
 * Each conversation cites the pages its question is about. They used to cite whichever three
 * concepts came next in build order, so a question about fermentation answered with stellar
 * physics; a cited title that does not exist fails the build rather than citing nothing.
 */
const CONVOS = [
  ['What sets the noise floor of a transit survey?', 3, ['Photometric Precision', 'Stellar Activity Noise', 'Readout Noise']],
  ['How do proxy records constrain climate sensitivity?', 7, ['Climate Sensitivity', 'Proxy Calibration', 'Emergent Constraint']],
  ['Why prefix chunks before indexing them?', 11, ['Contextual Retrieval', 'Chunking Strategy', 'Inverted Index']],
  ['When is a log-structured store the wrong choice?', 16, ['Log-Structured Merge Tree', 'Write Amplification', 'Compaction Policy']],
  ['What makes a fermentation stall?', 22, ['Bulk Fermentation', 'Lactic Acid Bacteria', 'Wild Yeast Culture']],
]
CONVOS.forEach(([title, daysAgo, cites], i) => {
  const id = ulid(300 + i)
  const when = day(daysAgo)
  sess.run(id, title, at(when), at(new Date(when.getTime() + 120_000)))
  msg.run(id, 'user', title, '[]', at(when))
  msg.run(id, 'assistant',
    'Short answer first, then the pages it came from.\n\nThe limit is set by a combination of the instrument and the source itself; see the linked pages for the split between the two.',
    JSON.stringify(
      cites.map((t) => {
        const cited = pages.find((p) => p.title === t && p.path.startsWith('wiki/concepts/'))
        if (!cited) throw new Error(`demo vault: conversation cites "${t}", which has no page`)
        return { path: cited.path, title: t }
      }),
    ),
    at(new Date(when.getTime() + 60_000)))
})

/*
 * ---------------------------------------------------------------- the research agents
 *
 * Four Fellows, so the Library screen and the command centre have something to draw. They
 * exist only in the database; nothing here runs an agent. The shapes are picked to cover the
 * range a screenshot should show rather than to be typical: one observer sweeping two watch
 * tasks, one custom Fellow mixing all three arts, one researcher on auto, and one librarian
 * asleep because its theme is built out. Names follow the product's own suggestion rule -
 * the initial matches the domain - and the subject matter is invented like everything else.
 */
const fellowStmt = db.prepare(
  `INSERT INTO agents (id, user_id, name, slug, intent, scope, home_domain, extra_domains, lens,
                       model, effort, step, quota_runs_per_day, autonomy, priority, state,
                       sleep_reason, sleep_code, notebook_path, created_at, updated_at,
                       tasks, task_cursor, art, nightly)
   VALUES (@id, 'local', @name, @slug, @intent, @scope, @home_domain, '[]', @lens,
           @model, 'high', 'standard', @quota, @autonomy, @priority, @state,
           @sleep_reason, @sleep_code, @notebook_path, @created_at, @updated_at,
           @tasks, 0, @art, @nightly)`,
)


const fellowIds = {}
FELLOWS.forEach((f, i) => {
  const slug = f.name.toLowerCase()
  const id = ulid(400 + i)
  fellowIds[f.name] = id
  const created = day(f.age)
  fellowStmt.run({
    id, name: f.name, slug, intent: f.tasks[0].text, scope: f.scope,
    home_domain: f.domain, lens: 'broad', model: f.model, quota: f.quota,
    autonomy: f.autonomy, priority: f.priority, state: f.state,
    sleep_reason: f.sleep_reason ?? null, sleep_code: f.sleep_code ?? null,
    notebook_path: `wiki/meta/agents/${slug}.md`,
    created_at: at(created), updated_at: at(day(1)),
    tasks: JSON.stringify(f.tasks.map((t, k) => ({ id: `t${k + 1}`, text: t.text, kind: t.kind, state: 'active' }))),
    art: f.art, nightly: f.nightly,
  })
})

/** The order the night walks the shelves, which the command centre's arrows set. */
const shelfStmt = db.prepare(`INSERT INTO shelf_order (user_id, domain, rank, updated_at) VALUES ('local', ?, ?, ?)`)
;['astronomy', 'climate-science', 'machine-learning', 'materials-science'].forEach((d, i) => shelfStmt.run(d, i, at(day(3))))

/**
 * Two of the main room's four favorite places are taken (2026-09-18): the home domains of the
 * two sweeping Fellows, side by side in the pair left of the wing door. Only the user fills
 * these, so the rows say so; every other department is placed into the wings on the first
 * scene build, the way a real instance does it. With all four empty the room read as nobody's.
 * The pair must differ in colour, and the colour is a hash of the name: astronomy and
 * machine-learning land on the same hue (196), astronomy and climate-science (84) do not.
 */
const placeStmt = db.prepare(
  `INSERT INTO library_layout (domain, user_id, room, slot, placed_by, updated_at) VALUES (?, 'local', 'main', ?, 'user', ?)`,
)
placeStmt.run('astronomy', 0, at(day(9)))
placeStmt.run('climate-science', 1, at(day(9)))

/** Runs the Fellows made, which the ledger, the dossier and the night's arithmetic read. */
/*
 * Durations follow the KIND, because that is what the night's schedule is drawn from: a full
 * research run is twice a step, a deepening sits between them, and a planning run is a couple
 * of minutes. Seeded from one index they came out backwards - an expand longer than a research
 * - and the bar would have drawn a plausible night nobody ever had.
 */
const RUN_SECONDS = { 'research-step': 320, research: 615, 'research-expand': 310, plan: 86 }
const FELLOW_RUNS = [
  // The last night is deliberately full: every Fellow that can run did, each inside its own
  // quota (Ada 2, Casper 3, Mira 1, Milo asleep). A recap of one run shows the layout but not
  // what the layout is for.
  ['Ada', 'research-step', 'A bright-host transit candidate and its follow-up photometry', ['Candidate Vetting Pipeline', 'Blended Eclipsing Binary'], 1.94, 1],
  ['Ada', 'research-step', 'Wavefront sensing upgrades reported this quarter', ['Adaptive Optics'], 1.71, 1],
  ['Casper', 'research-step', 'Where the sink estimates disagree, and on what data', ['Ocean Carbon Sink', 'Biological Pump', 'Solubility Pump'], 2.08, 1],
  ['Casper', 'research-expand', 'Feedback pages, built out from their own open questions', ['Feedback Loops', 'Cloud Feedback', 'Water Vapour Feedback', 'Lapse Rate Feedback'], 2.31, 1],
  ['Mira', 'research-step', 'Retrieval against long context, on the cases where it loses', ['Retrieval-Augmented Generation', 'Context Window'], 2.22, 1],
  ['Milo', 'research-expand', 'Sintering defects, built out where the wiki was thinnest', ['Vacancy Migration', 'Grain Boundary', 'Diffusion Coefficient'], 2.19, 11],
  // A third of each kind, because `typicalRunMs` needs three samples before it trusts a
  // measurement over its reference constant - and a schedule drawn from constants is exactly
  // what the command centre exists to replace.
  ['Ada', 'research-expand', 'Instrument pages, built out from the detections that named them', ['Echelle Spectrograph', 'Wavelength Calibration', 'Laser Frequency Comb'], 2.27, 14],
  ['Mira', 'research-step', 'Where a stale evaluation set still flatters a model', ['Benchmark Contamination', 'Evaluation Harness'], 2.06, 15],
]
const fellowRunIds = {}
/**
 * The pages a run wrote, by title. They used to be a slice of whatever concepts came next in
 * build order, so a climate Fellow's run listed spectrograph pages; a title that does not exist
 * fails the build rather than listing nothing.
 */
const pathOf = (title) => {
  const hit = pages.find((p) => p.title === title && p.path.startsWith('wiki/concepts/'))
  if (!hit) throw new Error(`demo vault: a Fellow run names "${title}", which has no page`)
  return hit.path
}
FELLOW_RUNS.forEach(([who, kind, topic, wrote, cost, daysAgo], i) => {
  // Runs of the last three nights sit INSIDE the night window; older ones keep the hour they
  // had, since nothing reads them by night any more.
  const started = daysAgo <= 4 ? nightOf(daysAgo - 1, 1 + (i % 4), (i * 13) % 60) : day(daysAgo)
  const id = ulid(500 + i)
  fellowRunIds[`${who}:${i}`] = id
  db.prepare(
    `INSERT INTO agent_runs (id, user_id, agent_id, kind, label, model, ok, pages, tokens_in, tokens_out,
                             cost_usd, error, started_at, finished_at, answer)
     VALUES (?, 'local', ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    id, fellowIds[who], kind, topic, who === 'Mira' ? 'opus-5' : 'sonnet-5',
    JSON.stringify(wrote.map(pathOf)),
    140_000 + i * 9_000, 11_000 + i * 700, cost,
    at(started), at(new Date(started.getTime() + (RUN_SECONDS[kind] + (i % 4) * 17) * 1000)),
    'Filed what it found and left the open questions on the page.',
  )
})

/** One planning run per Fellow per night, which is what a sweep costs before any work. */
FELLOWS.forEach((f, i) => {
  for (let d = 1; d <= 3; d++) {
    const started = nightOf(d - 1, 1, (i * 7) % 50)
    db.prepare(
      `INSERT INTO agent_runs (id, user_id, agent_id, kind, label, model, ok, pages, tokens_in, tokens_out,
                               cost_usd, error, started_at, finished_at, answer)
       VALUES (?, 'local', ?, 'plan', ?, 'sonnet-5', 1, '[]', ?, ?, ?, NULL, ?, ?, NULL)`,
    ).run(
      ulid(800 + i * 10 + d), fellowIds[f.name], `planning ${f.name}`,
      38_000 + d * 1_400, 2_100 + d * 90, 0.38 + d * 0.02,
      at(started), at(new Date(started.getTime() + (RUN_SECONDS.plan + d * 6) * 1000)),
    )
  }
})

/*
 * Proposals. Three standing and undecided, which is what a veto window looks like from the
 * outside: they will run tonight unless someone says otherwise. One vetoed, so the dossier
 * has a decision in it, and one already executed and tied to its run.
 */
const propStmt = db.prepare(
  `INSERT INTO agent_proposals (id, user_id, agent_id, created_at, cycle_date, kind, topic, lens,
                                rationale, provenance, page_set, est_cost_usd, est_plan_pct,
                                scope_score, rank, status, decided_at, decided_via, run_id)
   VALUES (@id, 'local', @agent_id, @created_at, @cycle_date, @kind, @topic, 'broad',
           @rationale, @provenance, '[]', @est_cost_usd, @est_plan_pct,
           @scope_score, @rank, @status, @decided_at, @decided_via, @run_id)`,
)
const taskText = (who, i) => FELLOWS.find((f) => f.name === who).tasks[i].text
const PROPOSALS = [
  ['Ada', 0, 'research-step', 'Follow-up spectroscopy on the brightest of this quarter\'s candidates',
   'The watch filed three candidates and the wiki has no page on what follow-up would settle them.',
   'open-question', 0.81, 1, 'proposed'],
  ['Casper', 2, 'research-expand', 'The three feedback pages the wiki links to most and explains least',
   'Ranked by backlinks against page length: much demanded, little substance.',
   'stub', 0.74, 1, 'proposed'],
  ['Casper', 0, 'research-step', 'Which sink estimate the newer inventories actually support',
   'Left over from the last run as its own open question.',
   'open-question', 0.69, 1, 'proposed'],
  ['Ada', 1, 'research', 'A survey of every detection method at once',
   'Broad enough to restate what the wiki already holds; the scope score says so.',
   'sweep', 0.17, 2, 'vetoed'],
  ['Mira', 0, 'research-step', 'Retrieval against long context, on the cases where it loses',
   'The open question its own last run left behind.',
   'open-question', 0.88, 1, 'executed'],
]
PROPOSALS.forEach(([who, taskIndex, kind, topic, rationale, candidate, score, rank, status], i) => {
  const created = day(status === 'executed' ? 3 : 1)
  propStmt.run({
    id: ulid(600 + i), agent_id: fellowIds[who], created_at: at(created), cycle_date: iso(created),
    kind, topic, rationale,
    // `task` is the task's TEXT, which is what the planner writes and what the night's
    // schedule groups a Fellow's standing proposals by.
    provenance: JSON.stringify({ candidate, text: topic, sourcePages: conceptPaths.slice(i * 7, i * 7 + 2), task: taskText(who, taskIndex) }),
    est_cost_usd: kind === 'research' ? 4.2 : kind === 'research-expand' ? 2.3 : 2.0,
    est_plan_pct: kind === 'research' ? 1.1 : 0.6,
    scope_score: score, rank, status,
    decided_at: status === 'proposed' ? null : at(day(status === 'executed' ? 2 : 1)),
    decided_via: status === 'proposed' ? null : 'dashboard',
    run_id: status === 'executed' ? fellowRunIds['Mira:6'] : null,
  })
})

/** One row per night, so the shift board has a week to walk. */
const shiftStmt = db.prepare(
  `INSERT INTO agent_shifts (cycle_date, user_id, trigger, started_at, finished_at, summary)
   VALUES (?, 'local', 'timer', ?, ?, ?)`,
)
for (let d = 0; d <= 6; d++) {
  const night = day(d)
  const started = nightOf(d, 1)
  const executed = d === 4 ? 0 : 2 + (d % 2)
  shiftStmt.run(
    iso(night), at(started), at(new Date(started.getTime() + (25 + d * 4) * 60_000)),
    JSON.stringify({
      executed, planned: 3, skipped: d === 4 ? [{ agentName: 'Milo', reason: 'nothing to deepen' }] : [],
      costUsd: Math.round(executed * 2.1 * 100) / 100,
    }),
  )
}

/*
 * The recap, as a database row AND as the vault page it renders to. The model carries the
 * fields the dashboard reads; it is a rendering, never read back, so a demo row only has to
 * be shaped right.
 */
const recapStmt = db.prepare(
  `INSERT INTO recaps (cycle_date, user_id, generated_at, path, quiet, model, delivered)
   VALUES (?, 'local', ?, ?, 0, ?, '{}')`,
)
/*
 * What a summary run would have written. These lines are the only part of a recap that is
 * MODEL output rather than bookkeeping - the service asks a read-only run to turn the night's
 * results into three sentences per Fellow - so a demo has to supply them the same way it
 * supplies the synthesis pages: invented, and written as that run would write them. One short
 * sentence each, most useful finding first, plain English.
 */
const FOUND = {
  Ada: [
    'The brightest of this quarter\'s candidates has a second transit on record and the depths agree.',
    'Two of the three follow-ups can be done from the existing site; the third needs a bigger aperture.',
    'A wavefront-sensing upgrade shipped that changes what counts as a faint host.',
  ],
  Casper: [
    'The sink estimates part over the coastal margin, not over the open ocean.',
    'The three feedback pages the wiki leaned on hardest now say what the feedback actually does.',
    'One product excludes shelf seas entirely, which explains about half the spread on its own.',
  ],
  Mira: [
    'Retrieval loses to a long context exactly where the answer is spread across the document.',
    'The cases where it wins are the ones with a single passage that settles the question.',
    'The crossover moves with the chunking, which is why published comparisons disagree.',
  ],
  Milo: [],
}

for (let d = 0; d <= 3; d++) {
  const night = day(d)
  const cycle = iso(night)
  const runsOfNight = FELLOW_RUNS.filter(([, , , , , ago]) => ago === d + 1)
  const model = {
    cycleDate: cycle, generatedAt: at(nightOf(d, 7)), quiet: false, since: at(nightOf(d + 1, 7)),
    window: { start: '01:00', end: '06:00' },
    shift: { trigger: 'timer', startedAt: at(night), finishedAt: at(night), executed: runsOfNight.length, planned: 3, skipped: [], costUsd: 4.2 },
    totals: {
      runs: runsOfNight.length, failed: 0,
      costUsd: Math.round(runsOfNight.reduce((a, r) => a + r[4], 0) * 100) / 100,
      pages: runsOfNight.reduce((a, r) => a + r[3].length, 0),
    },
    // Service-wide, so it is larger than the night's own total: ingests and manual runs count.
    usage: {
      today: { costUsd: Math.round((runsOfNight.reduce((a, r) => a + r[4], 0) + 2.4) * 100) / 100, runs: runsOfNight.length + 1 },
      week: { costUsd: 41.8 - d * 4, runs: 14 - d },
    },
    value: { pageOpens: 11 - d, recapLinks: 4 },
    fellows: FELLOWS.filter((f) => runsOfNight.some((r) => r[0] === f.name)).map((f, k) => ({
      index: k + 1, agentId: fellowIds[f.name], name: f.name, homeDomain: f.domain,
      model: f.model, autonomy: f.autonomy, state: f.state, sleepCode: f.sleep_code ?? null,
      sleepReason: f.sleep_reason ?? null, skipUntil: null,
      notebookPath: `wiki/meta/agents/${f.name.toLowerCase()}.md`,
      runs: runsOfNight.filter((r) => r[0] === f.name).map(([, kind, topic, wrote, cost], j) => ({
        runId: ulid(700 + d * 10 + j), kind, topic, ok: true, error: null,
        pagesCreated: wrote.map(pathOf), pagesUpdated: [],
        commit: null, costUsd: cost, startedAt: at(night), proposalId: null,
        planPct: { week: Math.round(cost * 12) / 100, '5h': Math.round(cost * 31) / 100 },
      })),
      found: FOUND[f.name] ?? [],
      openQuestions: FELLOW_QUESTIONS[f.name] ?? [],
      // The decisions the morning offers, coded the way the recap codes them: the Fellow's
      // position in the list, then a letter per proposal.
      proposals: PROPOSALS.filter(([who, , , , , , , , status]) => who === f.name && status === 'proposed')
        .map(([, taskIndex, kind, topic, rationale, candidate, score], j) => ({
          code: `${k + 1}${'abc'[j]}`, proposalId: ulid(600 + j), kind, topic, rationale,
          provenance: { candidate, text: topic, sourcePages: [] },
          estCostUsd: kind === 'research' ? 4.2 : 2.0,
          scopeScore: score, drift: score < 0.2, status: 'proposed', rank: j + 1,
        })),
      value: { pageOpens: 3, recapLinks: 1 },
    })),
    sleeping: FELLOWS.filter((f) => !runsOfNight.some((r) => r[0] === f.name))
      .map((f) => ({ name: f.name, reason: f.sleep_reason ?? 'nothing it could run tonight' })),
    summaryNote: null, summaryCostUsd: 0.31, unclaimed: [],
    // Every list the model declares has to BE a list, empty or not: the recap view reads
    // `.length` on them without a guard, and one missing key takes the whole screen down.
    dedupe: { merged: [], overlaps: [] },
    plan: {
      available: true, reason: null, calibrated: true,
      windows: [
        { window: 'week', utilization: 31 + d, resetsAt: at(day(d - 5)) },
        { window: '5h', utilization: 12 + d * 3, resetsAt: at(nightOf(d, 18)) },
      ],
      shares: { unit: 'points', week: 10, fiveHour: 15, reserveWeek: 80, reserveFiveHour: 60 },
    },
    /*
     * What the reading list gained and lost that night. Taken from the real runs' own
     * entries rather than invented, so the recap and the list agree: an invented line here
     * would name a publication the list does not carry.
     */
    readingFiled: [],
    readingAdded:
      d === 0 && realReadingEntries.length > 0
        ? realReadingEntries.slice(0, 2).map((e) => ({
            title: (/^- title:\s*(.+)$/m.exec(e)?.[1] ?? 'a publication').replace(/^"|"$/g, ''),
            url: /^\s*url:\s*(\S+)/m.exec(e)?.[1] ?? '',
            by: /^\s*by:\s*(\S+)/m.exec(e)?.[1] ?? 'research',
            page: null,
          }))
        : [],
    sinceBuilt: { runs: 0, proposals: 0 },
  }
  const path = `wiki/meta/recaps/Recap ${cycle}.md`
  // The column and the model must agree: a recap is written the morning after its night.
  recapStmt.run(cycle, at(nightOf(d, 7)), path, JSON.stringify(model))
}

db.close()
console.log(`db:     ${DB}`)
console.log(`        ${recentJobs.length + 2} jobs, ${RUNS.length + FELLOW_RUNS.length} runs, ${CONVOS.length} conversations`)
console.log(`        ${FELLOWS.length} Fellows, ${PROPOSALS.length} proposals, 7 nights, 3 recaps`)
console.log(
  `        ${capturedRuns.length} real research run(s) restored` +
    (capturedRuns.length
      ? `: ${capturedRuns.reduce((n, r) => n + r.keptPages.length, 0)} pages, $${capturedRuns.reduce((n, r) => n + r.costUsd, 0).toFixed(2)}`
      : ' (none captured yet)'),
)
