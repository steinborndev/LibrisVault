/**
 * Turning a page's source reference into the link the Library renders (2026-08-26).
 *
 * Three routes to a source, and which one a page gets is a security decision, not a
 * preference:
 *
 *  - A WEB ingest links to its live URL. Its stored payload is the scraped `raw.html`, and
 *    rendering that from the dashboard's origin would run whatever script the page carried,
 *    with the dashboard's storage and API behind it. The server refuses to serve HTML
 *    inline for the same reason (api/routes/sources.ts); the live site is also what a
 *    reader wants from a web source anyway.
 *  - Everything else links to the document the ingest stored, served out of `.raw/`.
 *  - A page with no ingested document behind it links to the address it states itself. A
 *    research run reads the web and writes the page; there is no stored copy to serve, and
 *    the live address is the only record of where the page came from.
 */

import type { IconName } from '../components/Icon.tsx'
import type { SourceRef } from '../api/types.ts'

export interface SourceLink {
  /** The type, as the column shows it: PDF, Web, Image… */
  label: string
  icon: IconName
  href: string
  /** True when the link leaves the dashboard - it gets `target="_blank"`. */
  external: boolean
  /** Tooltip: which document, or which site. */
  title: string
}

const LABELS: Record<string, string> = {
  pdf: 'PDF',
  web: 'Web',
  image: 'Image',
  text: 'Text',
  office: 'Office',
  av: 'Media',
  other: 'File',
}

const ICONS: Record<string, IconName> = {
  pdf: 'file',
  web: 'globe',
  image: 'image',
  text: 'file',
  office: 'file',
  av: 'play',
  other: 'file',
}

/** Host without `www.`, for the tooltip of a web source. */
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * The link for a page that states its own address (`GraphNode.url`), or null.
 *
 * Only reached when no ingest claims the page: the stored document is the better answer
 * where there is one, because it is the copy the vault holds and the copy the run read.
 */
export function addressLink(url: string | null | undefined): SourceLink | null {
  if (url === undefined || url === null || url === '') return null
  return {
    label: LABELS['web']!,
    icon: ICONS['web']!,
    href: url,
    external: true,
    title: `Open the source at ${host(url)}`,
  }
}

/** The link for one page's source, or null when there is nothing to open. */
export function sourceLink(ref: SourceRef | undefined): SourceLink | null {
  if (ref === undefined) return null
  const label = LABELS[ref.type] ?? LABELS['other']!
  const icon = ICONS[ref.type] ?? ICONS['other']!

  if (ref.type === 'web' && ref.url !== null) {
    return { label, icon, href: ref.url, external: true, title: `Open the source at ${host(ref.url)}` }
  }
  if (ref.file === null) return null
  const path = `${ref.dir}/${ref.file}`
  return {
    label,
    icon,
    href: `/api/v1/sources/raw?path=${encodeURIComponent(path)}`,
    external: false,
    title: `Open the ingested document: ${ref.file}`,
  }
}
