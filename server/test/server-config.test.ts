import { describe, it, expect } from 'vitest'
import { isLoopbackHost, assertBindAllowed, ConfigError, type ServerConfig } from '../src/config.js'

const base: ServerConfig = {
  host: '127.0.0.1',
  port: 8420,
  watchFolder: '/mnt/c/inbox',
  maxUploadBytes: 200 * 1024 * 1024,
  authMode: 'local-single-user',
}

describe('isLoopbackHost', () => {
  it('recognises loopback addresses', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
  })
})

describe('assertBindAllowed (hard rule 2 / SPEC §9)', () => {
  it('allows a loopback bind in local-single-user mode', () => {
    expect(() => assertBindAllowed(base)).not.toThrow()
  })

  it('refuses a non-loopback bind without a token', () => {
    expect(() => assertBindAllowed({ ...base, host: '0.0.0.0' })).toThrow(ConfigError)
    expect(() => assertBindAllowed({ ...base, host: '192.168.1.10' })).toThrow(/non-localhost bind requires/)
  })

  it('refuses a non-loopback bind in token mode with no token set', () => {
    expect(() => assertBindAllowed({ ...base, host: '0.0.0.0', authMode: 'token' })).toThrow(ConfigError)
  })

  it('allows a non-loopback bind in token mode with a token', () => {
    expect(() =>
      assertBindAllowed({ ...base, host: '0.0.0.0', authMode: 'token', authToken: 'secret' }),
    ).not.toThrow()
  })
})

/*
 * Token mode without a token (2026-09-08 review). The config only sets `authToken` when the
 * variable is filled; the middleware then compared against '', and sha256('') === sha256(''),
 * so `Authorization: Bearer ` authenticated. The bind guard caught the non-loopback half, and
 * a loopback service reported `httpAuth: token` while being open.
 */
describe('token mode needs a token', () => {
  const base = { host: '127.0.0.1', port: 8420, watchFolder: '/w', maxUploadBytes: 1, authMode: 'local-single-user' as const }

  it('refuses to start whatever the bind, and refuses an empty expected token', () => {
    expect(() => assertBindAllowed({ ...base, authMode: 'token' })).toThrow(/needs HTTP_AUTH_TOKEN/)
    expect(() => assertBindAllowed({ ...base, host: '0.0.0.0', authMode: 'token' })).toThrow(/needs HTTP_AUTH_TOKEN/)
    expect(() => assertBindAllowed({ ...base, authMode: 'token', authToken: 'secret' })).not.toThrow()
    // The mode itself stays optional: without it, loopback is the documented default.
    expect(() => assertBindAllowed(base)).not.toThrow()
  })
})
