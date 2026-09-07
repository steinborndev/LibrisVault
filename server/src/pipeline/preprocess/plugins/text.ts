/**
 * Markdown / text / code passthrough (SPEC.md §5: "Durchreichen"). No conversion — the
 * agent reads the original directly. The Obsidian Web Clipper's `.md` files are handled
 * here too; their frontmatter URL is left for the agent to read (SPEC.md §4.2).
 */

import type { PreprocessPlugin, Probe, NormalizeResult } from '../types.js'

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

export const textPlugin: PreprocessPlugin = {
  name: 'text',
  type: 'text',
  matches: (probe: Probe): boolean => TEXT_EXTS.has(probe.ext),
  normalize: async (): Promise<NormalizeResult> => ({
    notes: ['text passthrough — original ingested as-is'],
  }),
}
