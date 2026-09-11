import { describe, it, expect } from 'vitest'
import { isPrivateAddress, validateUrl, htmlToText, fetchFailureMessage, canonicalUrlOf } from '../src/pipeline/preprocess/web.js'
import { PreprocessError } from '../src/pipeline/preprocess/index.js'

describe('isPrivateAddress', () => {
  it('flags RFC1918, loopback and link-local v4', () => {
    for (const ip of ['10.0.0.1', '172.16.5.5', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })
  it('allows public v4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })
  it('flags loopback/ULA/link-local v6 and mapped v4', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
  })
})

describe('validateUrl', () => {
  const publicResolver = async () => ['93.184.216.34']

  it('accepts a public https URL', async () => {
    const { url } = await validateUrl('https://example.com/page', publicResolver)
    expect(url.hostname).toBe('example.com')
  })

  it('refuses file:// and other schemes', async () => {
    await expect(validateUrl('file:///etc/passwd', publicResolver)).rejects.toThrow(/scheme/)
    await expect(validateUrl('ftp://example.com', publicResolver)).rejects.toThrow(/scheme/)
  })

  it('refuses a host that resolves to a private address (SSRF guard)', async () => {
    const privateResolver = async () => ['192.168.0.10']
    await expect(validateUrl('http://intranet.local', privateResolver)).rejects.toThrow(/SSRF/)
  })

  it('refuses when any resolved address is private', async () => {
    const mixed = async () => ['93.184.216.34', '10.0.0.1']
    await expect(validateUrl('http://sneaky.example', mixed)).rejects.toThrow(/private/)
  })

  it('rejects malformed URLs', async () => {
    await expect(validateUrl('not a url', publicResolver)).rejects.toThrow(PreprocessError)
  })
})

describe('htmlToText', () => {
  it('strips scripts, styles and tags', () => {
    const html = '<html><style>a{}</style><body><script>x()</script><h1>Hi</h1><p>Body&nbsp;text</p></body></html>'
    const text = htmlToText(html)
    expect(text).toContain('Hi')
    expect(text).toContain('Body text')
    expect(text).not.toContain('x()')
    expect(text).not.toContain('<')
  })
})

describe('fetchFailureMessage', () => {
  it('tells a refused fetch how to get through, and says nothing more for other statuses', () => {
    // A 403 in front of a public page is bot protection; the job's error is the one line the
    // user reads, and the browser is the way through.
    expect(fetchFailureMessage(403, 'https://publisher.example/posts/an-article')).toMatch(/save the page from your browser and drop the \.html file/)
    expect(fetchFailureMessage(401, 'https://publisher.example/x')).toMatch(/refuses automated fetches/)
    expect(fetchFailureMessage(500, 'https://publisher.example/x')).toBe('fetch failed: HTTP 500 for https://publisher.example/x')
    expect(fetchFailureMessage(404, 'https://publisher.example/x')).not.toMatch(/browser/)
  })
})

describe('canonicalUrlOf', () => {
  it('reads the canonical link in either attribute order, then the Open Graph URL, and only http(s)', () => {
    expect(canonicalUrlOf('<link rel="canonical" href="https://publisher.example/a">')).toBe('https://publisher.example/a')
    expect(canonicalUrlOf("<link href='https://publisher.example/b' rel='canonical'>")).toBe('https://publisher.example/b')
    expect(canonicalUrlOf('<meta property="og:url" content="https://publisher.example/c">')).toBe('https://publisher.example/c')
    expect(canonicalUrlOf('<link rel="canonical" href="https://publisher.example/a"><meta property="og:url" content="https://publisher.example/c">')).toBe('https://publisher.example/a')
    expect(canonicalUrlOf('<link rel="canonical" href="javascript:void(0)">')).toBeUndefined()
    expect(canonicalUrlOf('<link rel="stylesheet" href="https://publisher.example/x.css">')).toBeUndefined()
    expect(canonicalUrlOf('<p>no head at all</p>')).toBeUndefined()
  })
})
