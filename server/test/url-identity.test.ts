import { describe, it, expect } from 'vitest'
import { canonicalUrl } from '../src/pipeline/url-identity.js'

/**
 * The identity of a link (SPEC.md §12.9, stage 2 for URL jobs): two addresses of one source
 * must canonicalize to the same string, two different sources must not - and when in doubt,
 * they must NOT, because a wrong match costs a source while a missed one costs a run.
 */
describe('canonicalUrl', () => {
  it('identifies a post by its status id, whatever host, handle or share tag the link carries', () => {
    const forms = [
      'https://x.com/someone/status/1234567890123456789?s=52&t=shareTagAbc123',
      'https://twitter.com/someone/status/1234567890123456789',
      'https://mobile.twitter.com/renamed_handle/status/1234567890123456789?s=20',
      'https://x.com/i/status/1234567890123456789',
      'https://x.com/i/web/status/1234567890123456789',
    ]
    expect(new Set(forms.map(canonicalUrl))).toEqual(new Set(['https://x.com/i/status/1234567890123456789']))
    expect(canonicalUrl('https://x.com/someone/status/1')).not.toBe(canonicalUrl('https://x.com/someone/status/2'))
  })

  it('identifies a video by its id across watch, short-link and mobile forms', () => {
    const forms = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'https://youtu.be/dQw4w9WgXcQ?si=shareTag123',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    ]
    expect(new Set(forms.map(canonicalUrl))).toEqual(new Set(['https://www.youtube.com/watch?v=dQw4w9WgXcQ']))
  })

  it('normalizes scheme, host case, www, fragment, trailing slash and known tracking parameters', () => {
    expect(canonicalUrl('HTTP://WWW.Example.org/Path/?utm_source=x&utm_medium=y&fbclid=z#frag')).toBe(
      'https://example.org/Path',
    )
    expect(canonicalUrl('https://example.org/')).toBe('https://example.org')
    expect(canonicalUrl('https://example.org')).toBe('https://example.org')
    expect(canonicalUrl('https://example.org/a?b=2&a=1')).toBe('https://example.org/a?a=1&b=2')
    expect(canonicalUrl('  https://example.org/a  ')).toBe('https://example.org/a')
  })

  it('keeps parameters it does not know, because a query string can carry identity', () => {
    expect(canonicalUrl('https://example.org/view?id=7')).toBe('https://example.org/view?id=7')
    expect(canonicalUrl('https://example.org/view?id=7')).not.toBe(canonicalUrl('https://example.org/view?id=8'))
    // `ref` is usually tracking, but not always - it stays, and the two links differ.
    expect(canonicalUrl('https://example.org/x?ref=home')).toBe('https://example.org/x?ref=home')
  })

  it('drops default ports and credentials, keeps a real port and the path case', () => {
    expect(canonicalUrl('http://example.org:80/X')).toBe('https://example.org/X')
    expect(canonicalUrl('https://user:pw@example.org:8443/x')).toBe('https://example.org:8443/x')
  })

  it('returns undefined for anything that is not an http(s) URL', () => {
    expect(canonicalUrl('not a url')).toBeUndefined()
    expect(canonicalUrl('mailto:someone@example.org')).toBeUndefined()
    expect(canonicalUrl('file:///etc/hosts')).toBeUndefined()
    expect(canonicalUrl('')).toBeUndefined()
  })
})
