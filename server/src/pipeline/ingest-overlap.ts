/**
 * What the vault already holds on the subject of an incoming document (A8).
 *
 * THE DEFECT THIS ADDRESSES. Measured over 1208 content pages: 73 % of concept pages cite
 * exactly one source, and 61 % were written by exactly one knowledge-adding commit. The vault
 * is mostly one document, one page - a shelf of summaries rather than a knowledge base where a
 * second source on a subject deepens the first.
 *
 * The service already has two mechanisms for "what do we have on this": `findRelatedPages`
 * (title-token overlap) feeds the research prompt, and `retrieveCandidates` (chunk-level BM25)
 * feeds chat. The ONE run type that never got either is the ingest - whose job is literally
 * "create or update". Its only pointer to existing knowledge was "read wiki/index.md", a file
 * that had grown to 514 kB, which no run reads in any meaningful sense.
 *
 * So an ingest now gets the same two mechanisms, from a topic derived from the document itself.
 *
 * THE WORDING IS THE RISK, not the retrieval. A research run was once told to prefer extending
 * what exists and filed nothing at all (2026-09-04, see `renderSynthesisMandate`). The block
 * below therefore states the deliverable LAST and in its own sentence: the source page for THIS
 * document is required whatever overlaps it, and the preference applies to the concept, entity
 * and further source pages around it.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Manifest } from './preprocess/types.js'
import { findRelatedPages, type RelatedPages } from './related-pages.js'

/** How much of the normalised text is read for the topic. A first heading is near the top. */
const HEAD_CHARS = 2000

/** The topic string handed to retrieval. Long enough to be specific, short enough to be a topic. */
const MAX_TOPIC_CHARS = 200

/** At most this many retrieved pages reach the prompt, on top of the title matches. */
const MAX_RETRIEVED = 6

/**
 * Filenames carry more than a subject: a download id, a date, a version, a scanner's prefix.
 * Stripping them is what makes the token overlap in `findRelatedPages` mean anything.
 */
function cleanFileName(name: string): string {
  return name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[_+]+/g, ' ')
    .replace(/(^|[\s-])\d{4}[-.]\d{2}[-.]\d{2}([\s-]|$)/g, ' ')
    .replace(/(^|[\s-])(?:v?\d+(?:\.\d+)*|[0-9a-f]{8,})([\s-]|$)/gi, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * The first markdown heading of the normalised text that says something.
 *
 * Measured on this vault's own `.raw/` directories: a web capture's first heading is the
 * ADDRESS (`# https://x.com/...`), and the document's real title is the second one, inside the
 * untrusted-content fence (`# Prof. A. Lecturer: A Talk Title With a Colon In It`, invented
 * here - the real one is a page in the vault). Taking the first heading therefore produced a
 * topic made of "http" and "com",
 * which matched pages by accident and named nothing useful.
 *
 * The fenced text is read here as DATA for a vault lookup, never as instruction - the same
 * stance the quote check takes when it reads the same file (SPEC.md §12.11).
 */
function firstHeading(text: string): string {
  for (const m of text.matchAll(/^#{1,3}[ \t]+(.+?)[ \t]*$/gm)) {
    const heading = m[1]!.trim()
    if (heading === '' || isUrlLike(heading)) continue
    return heading
  }
  return firstTitleLines(text)
}

/**
 * Lines a publisher puts above a title. Every one of these is a real first line from this
 * vault's own `.raw/`, and each would otherwise be mistaken for the document's subject.
 */
const PUBLISHER_BOILERPLATE =
  /\b(?:doi|issn|isbn|preprint|copyright|licen[cs]e|all rights reserved|published (?:on|online|by)|downloaded (?:from|by)|view article online|available (?:online|at)|received[: ]|accepted[: ]|vol\.?\s*\d|https?:\/\/|www\.)/i

/**
 * The title of a document that has no markdown headings, read off the top of its plain text.
 *
 * WHY THIS EXISTS. `pdftotext` writes no headings, so `firstHeading` returned nothing for every
 * PDF, and the file name was then the only signal left. Measured by replaying the last 20 real
 * ingests (task 3.1's DoD): six of them were journal PDFs named `1.pdf` .. `5.pdf` and
 * `q4zt00817b.pdf`, all of which `isIdentifier` correctly rejects - so those six documents
 * reached the agent with NO overlap block at all, and a journal PDF on a subject the vault
 * already covers is the case this whole phase exists for. Their normalised text carried the
 * real title two or three lines down, under the journal's masthead.
 *
 * WHAT IT TAKES. Up to two lines that read like a title: long enough, several real words, and
 * not one of the metadata lines a publisher stacks above it. Two rather than one because a
 * title wraps, and the topic is token overlap, so a half-title still matches and a full one
 * matches better.
 */
function firstTitleLines(text: string, max = 2): string {
  const taken: string[] = []
  for (const raw of text.split(/\r?\n/).slice(0, TITLE_SCAN_LINES)) {
    const line = raw.trim().replace(/\s+/g, ' ')
    if (line.length < TITLE_MIN_CHARS || line.length > TITLE_MAX_CHARS) continue
    if (PUBLISHER_BOILERPLATE.test(line) || isUrlLike(line) || isIdentifier(line)) continue
    // Several words that are actually words: a masthead ("OpenNano 31 (2026) 100319") has
    // numbers where a title has language.
    if ((line.match(/\b[A-Za-z]{3,}\b/g) ?? []).length < TITLE_MIN_WORDS) continue
    taken.push(line)
    if (taken.length === max) break
  }
  return taken.join(' ')
}

/** Whether a string is an address rather than a file name - a URL job's `originalName` is one. */
const isUrlLike = (value: string): boolean => /^https?:\/\//i.test(value.trim())

/**
 * An identifier is not a subject. `q4zt00817b` and `kbxlq2291` have the SHAPE of the
 * `originalName`s this vault's history really carries - a publisher's id, a DOI suffix, a
 * journal's article code - and are INVENTED, because a real one points at a real document and
 * this repo is public (hard rule 7). Keep it that way when adding a case.
 *
 * As a topic each is noise, and a topic that is noise is worse than no topic: it produces a
 * block of pages that overlap nothing.
 */
function isIdentifier(value: string): boolean {
  const words = value.split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return true
  // Every word is either short, or a letter/digit soup with no vowel to read it by.
  return words.every((w) => w.length < 3 || (/\d/.test(w) && !/^[A-Za-z]+$/.test(w)))
}

/** A URL's last meaningful path segment, read as words: `/posts/tide-tables-explained` -> the title. */
function urlSlug(url: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter((p) => p !== '' && !/^\d+$/.test(p))
    // Route words are not subjects: `/watch`, `/status/<id>`, `/p/<id>` say nothing at all.
    const ROUTE = new Set(['watch', 'status', 'video', 'videos', 'post', 'posts', 'p', 'article', 'articles', 'abs', 'pdf', 'html'])
    const words = segments.filter((seg) => !ROUTE.has(seg.toLowerCase()))
    const last = words[words.length - 1] ?? ''
    const slug = cleanFileName(last.replace(/\.[a-z]{2,5}$/i, ''))
    return isIdentifier(slug) ? '' : slug
  } catch {
    return ''
  }
}

/** How far into a plain-text head to look for a title, and what makes a line look like one. */
const TITLE_SCAN_LINES = 40
const TITLE_MIN_CHARS = 18
const TITLE_MAX_CHARS = 200
const TITLE_MIN_WORDS = 3

export interface TopicInput {
  /** The document's own title, when preprocessing found one. */
  readonly title?: string | undefined
  readonly originalName?: string | undefined
  readonly url?: string | undefined
  /** The first characters of the normalised text, when there is one. */
  readonly headText?: string | undefined
}

/**
 * One topic string for an incoming document, from the strongest signals it carries.
 *
 * Deliberately a CONCATENATION rather than a choice: the retrieval underneath is token overlap,
 * so a filename and a first heading that say the same thing cost nothing, and one that adds a
 * word the other lacks is exactly what makes the difference. Duplicated tokens are dropped so a
 * repeated title does not outweigh everything else.
 *
 * Input quality decides whether this phase works at all, which is why it is its own function
 * with its own tests rather than three lines inside the queue.
 */
export function deriveTopic(input: TopicInput): string {
  const parts: string[] = []
  const seen = new Set<string>()
  const add = (raw: string): void => {
    const value = raw.trim()
    if (value === '') return
    // Token-level dedupe: "Tide Tables.pdf" after "Tide Tables" adds nothing.
    const key = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (key === '' || seen.has(key) || isIdentifier(value)) return
    for (const previous of seen) {
      if (previous.includes(key) || key.includes(previous)) return
    }
    seen.add(key)
    parts.push(value)
  }

  add(input.title ?? '')
  add(firstHeading(input.headText ?? ''))
  // A URL job's "original name" IS its address. Measured on the last 20 real ingests: passing
  // it through as a name made the topic `https://x.com/<handle>/status/<id>`, which tokenises
  // to "http", "com" and "status" and matched twelve unrelated pages by accident. The slug is
  // the only part of an address that ever says what it is about.
  const name = input.originalName ?? ''
  add(isUrlLike(name) ? urlSlug(name) : cleanFileName(name))
  if (parts.length === 0 && input.url) add(urlSlug(input.url))

  return parts.join(' - ').slice(0, MAX_TOPIC_CHARS).trim()
}

/** The topic for one job, reading the normalised text's head when there is one. */
export function topicForJob(vaultRoot: string, manifest: Manifest, primaryArtifact: string): string {
  let headText = ''
  try {
    if (primaryArtifact.endsWith('.md') || primaryArtifact.endsWith('.txt')) {
      const fd = fs.openSync(path.join(vaultRoot, primaryArtifact), 'r')
      try {
        const buffer = Buffer.alloc(HEAD_CHARS)
        const read = fs.readSync(fd, buffer, 0, HEAD_CHARS, 0)
        headText = buffer.subarray(0, read).toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    }
  } catch {
    /* an unreadable artifact still has a title and a filename to go on */
  }
  return deriveTopic({
    title: manifest.title,
    originalName: manifest.originalName,
    url: manifest.url,
    headText,
  })
}

/**
 * The block that tells an ingest what the vault already holds on this subject.
 *
 * Order is load-bearing and asserted in the tests: the overlap first, the DELIVERABLE last. A
 * run reads an instruction as qualifying everything before it, and "prefer what exists" ahead
 * of an unqualified deliverable is how a research run once filed nothing at all.
 */
export function renderIngestOverlap(related: RelatedPages, retrieved: readonly string[] = []): string {
  // A page both mechanisms found is the STRONGEST signal there is, so it is listed once -
  // filtering it out of both lists (which an earlier version did) dropped it entirely.
  const titles = related.pages
  const extra = retrieved.filter((p) => !related.pages.includes(p))
  if (titles.length === 0 && extra.length === 0 && related.syntheses.length === 0) return ''

  let block = '\n\n<vault_overlap>\nThe vault ALREADY holds pages on this subject:\n'
  for (const p of [...titles, ...extra]) block += `- ${p}\n`
  for (const p of related.syntheses) block += `- ${p} (a research synthesis)\n`
  block +=
    '\nRead the ones that look relevant BEFORE writing, and prefer EXTENDING them over creating ' +
    'a second page on the same thing. A concept, entity or source page that already covers this ' +
    "material gets this document's findings folded into it - keep its title and its frontmatter, " +
    'add what is new, refresh its `updated:` date, and cite this document as a further source. ' +
    'A vault where each document produces its own island of pages is a shelf of summaries; the ' +
    'second source on a subject is what turns it into knowledge.\n' +
    '\nThis preference does NOT touch this run\'s own deliverable: the source page for THIS ' +
    'document is required, whatever overlaps it, and so are any genuinely new concepts and ' +
    'entities it introduces.\n</vault_overlap>'
  return block
}

/** Both mechanisms for one topic: title overlap, plus chunk retrieval when it is provisioned. */
export async function vaultOverlapFor(
  vaultRoot: string,
  topic: string,
  retrieve: (topic: string) => Promise<readonly string[]>,
): Promise<string> {
  if (topic.trim() === '') return ''
  const related = findRelatedPages(vaultRoot, topic)
  let retrieved: readonly string[]
  try {
    retrieved = (await retrieve(topic)).slice(0, MAX_RETRIEVED)
  } catch {
    // Advisory, always: a retrieval failure must never fail an ingest, and the title overlap
    // above already carries most of the signal.
    retrieved = []
  }
  return renderIngestOverlap(related, retrieved)
}
