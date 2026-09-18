/**
 * The identity of a web source by its address (SPEC.md §12.9, stage 2 for URL jobs, 2026-09-18).
 *
 * A URL job carries no content hash, and a page fetched twice rarely hashes the same anyway
 * (view counters, ads, timestamps). What stays stable is the address, once the noise a share
 * button appends is stripped. Two forms of the same address must compare equal:
 *
 *   - X/Twitter: identified by the status id alone. Host (x.com, twitter.com, mobile.*) and
 *     the handle in the path vary between links to one post; `?s=…&t=…` is the app's share tag.
 *   - YouTube: identified by the video id (`watch?v=`, `youtu.be/`, `shorts/`, `live/`).
 *   - Everything else: https, lowercase host without `www.`, no fragment, no trailing slash,
 *     a known list of click-tracking parameters removed, the remaining query sorted.
 *
 * Deliberately conservative, the same stance as the DOI stage: only parameters KNOWN to name
 * the click rather than the page are dropped, because a query string can carry identity
 * (`?id=`, `?p=`, `?v=`), and a wrong match costs a source while a missed one costs a run.
 * Unknown parameters stay and simply make the two addresses differ.
 */

import { matchTweetUrl, matchYoutubeUrl } from './preprocess/url-handlers.js'

/** Query parameters that identify the click, not the page. `utm_*` is matched by prefix. */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'twclid',
  'ttclid',
  'igshid',
  'yclid',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  '_hsenc',
  '_hsmi',
  '_ga',
  '_gl',
  'ref_src',
  'ref_url',
  'si',
  'utm',
])
const TRACKING_PREFIXES = ['utm_'] as const

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase()
  return TRACKING_PARAMS.has(key) || TRACKING_PREFIXES.some((p) => key.startsWith(p))
}

/** `x.com/i/web/status/<id>`, the one status form `matchTweetUrl` does not read. */
const TWEET_WEB_PATH = /^\/i\/web\/status\/(\d+)/

/**
 * The canonical form of `raw`, or undefined when it is not an http(s) URL. Equal results mean
 * the same source; nothing else is implied. Never throws.
 */
export function canonicalUrl(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined

  const tweet = matchTweetUrl(url)
  if (tweet !== undefined) return `https://x.com/i/status/${tweet.id}`
  const tweetWeb = TWEET_WEB_PATH.exec(url.pathname)
  if (tweetWeb !== null && matchTweetUrl(new URL(`https://x.com/i/status/${tweetWeb[1]}`)) !== undefined) {
    return `https://x.com/i/status/${tweetWeb[1]}`
  }
  const video = matchYoutubeUrl(url)
  if (video !== undefined) return video.videoUrl

  url.protocol = 'https:'
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  if (url.port === '80' || url.port === '443') url.port = ''
  url.hash = ''
  url.username = ''
  url.password = ''
  const kept = [...url.searchParams]
    .filter(([name]) => !isTrackingParam(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  url.search = ''
  for (const [name, value] of kept) url.searchParams.append(name, value)
  // No trailing slash, the root included: `https://host/` and `https://host` are one address.
  return url.toString().replace(/\/+(?=\?|$)/, '')
}
