/**
 * Markdown / text / code passthrough (SPEC.md §5: "Durchreichen"). No conversion — the
 * agent reads the original directly. The Obsidian Web Clipper's `.md` files are handled
 * here too; their frontmatter URL is left for the agent to read (SPEC.md §4.2).
 *
 * One exception since 2026-09-12: a page saved from the browser (`.html`, `.htm`) is the
 * same HTML a URL job fetches, so it takes the same extraction (see `extractSavedPage`).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { PreprocessPlugin, Probe, NormalizeContext, NormalizeResult } from '../types.js'
import { runConverter } from '../sandbox.js'
import { fenceWithWarnings } from '../fence.js'
import { assessExtractedContent, canonicalUrlOf, htmlToText } from '../html.js'

/**
 * Extensions treated as ingestible text with no normalization step.
 *
 * `rtf` stays here as the FALLBACK (2026-09-07). The office plugin runs first and converts a
 * real Rich Text file through pandoc - passing it through meant handing an agent
 * `{\rtf1\ansi...}` control codes. A file that only CLAIMS to be RTF fails that plugin's
 * magic check and lands here, which is what this list is for. Dropping it from this list made
 * such a file `other` instead, which is worse than reading it as the text it is.
 */
const TEXT_EXTS = new Set([
  'md',
  'markdown',
  'txt',
  'text',
  'rtf',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'log',
  'xml',
  'html',
  'htm',
  // code
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'sh',
  'bash',
  'zsh',
  'sql',
])

const HTML_EXTS = new Set(['html', 'htm'])

/**
 * A page saved from the browser - the way through a site that refuses automated fetches
 * (an HTTP 403 on a night ingest, 2026-09-12). The file is the same HTML a URL job fetches,
 * so it takes the same extraction, `defuddle` when installed and the built-in fallback
 * otherwise, and the agent reads the article rather than half a megabyte of markup. Passed
 * through as text, the agent ran defuddle by hand, could not read its own scratch output,
 * and wrote the extraction into the vault root to read it back. The page's own address
 * (canonical link, Open Graph URL) rides along as the manifest's `url`, so the source page
 * and the reading list can still name where it came from.
 *
 * An extraction the sanity gate calls junk falls back to the passthrough rather than
 * failing: the user chose this file, and the agent can still read it whole.
 */
async function extractSavedPage({ probe, jobDir, tools }: NormalizeContext): Promise<NormalizeResult> {
  const html = fs.readFileSync(probe.filePath, 'utf8')
  const url = canonicalUrlOf(html)
  const notes: string[] = []
  let markdown: string
  if (tools.defuddle) {
    try {
      const { stdout } = await runConverter('defuddle', ['parse', probe.filePath, '--md'], { reads: [probe.filePath], timeoutMs: 30_000 })
      markdown = stdout.trim()
      notes.push('saved web page: extracted via defuddle')
    } catch {
      markdown = htmlToText(html)
      notes.push('saved web page: defuddle failed — used built-in HTML-to-text fallback')
    }
  } else {
    markdown = htmlToText(html)
    notes.push('saved web page: defuddle not installed — used built-in HTML-to-text fallback')
  }
  if (url !== undefined) notes.push(`saved web page: names ${url} as its address`)

  const problem = assessExtractedContent(markdown)
  if (problem !== null) {
    return { ...(url !== undefined ? { url } : {}), notes: [`saved web page: extraction looked like junk (${problem}) — original passed through as-is`] }
  }
  const normalizedPath = path.join(jobDir, 'normalized.md')
  // The extraction is a stranger's page, so it is fenced as data (docs/sources/SPEC.md 4.1).
  const fenced = fenceWithWarnings({
    title: probe.originalName,
    ...(url !== undefined ? { savedFrom: url } : {}),
    source: url ?? probe.originalName,
    kind: 'saved-page',
    text: markdown,
  })
  fs.writeFileSync(normalizedPath, fenced.text, 'utf8')
  return {
    normalizedPath,
    normalizedChars: markdown.length,
    ...(url !== undefined ? { url } : {}),
    notes,
    ...(fenced.warnings.length > 0 ? { warnings: fenced.warnings } : {}),
  }
}

export const textPlugin: PreprocessPlugin = {
  name: 'text',
  type: 'text',
  matches: (probe: Probe): boolean => TEXT_EXTS.has(probe.ext),
  normalize: async (ctx: NormalizeContext): Promise<NormalizeResult> =>
    HTML_EXTS.has(ctx.probe.ext)
      ? extractSavedPage(ctx)
      : // Passthrough originals are NOT rewritten (docs/sources/SPEC.md D7): a Markdown file the
        // user wrote, or a clipper page with its own frontmatter, is read whole and a fence
        // inserted into it would be an edit of the user's own file. The prompt rule covers them.
        { notes: ['text passthrough — original ingested as-is', 'passthrough, unfenced'] },
}
