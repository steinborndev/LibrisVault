import { describe, it, expect } from 'vitest'
import { concurrencyWarning } from '../src/components/SettingsEditor.tsx'

/**
 * The one settings field where the right value is not a preference (SPEC.md §3.1, corrected
 * 2026-09-19). The vault's ingest skill was built for a single writer and says so; the service
 * now follows it, and the field still accepts more because a different vault is a different
 * question. The warning is what turns "we changed the default" into something the reader can
 * decide against.
 */
describe('concurrencyWarning', () => {
  it('says nothing at the single-writer default', () => {
    expect(concurrencyWarning(1)).toBeNull()
  })

  it('fires from 2 upwards', () => {
    for (const n of [2, 3, 8]) expect(concurrencyWarning(n)).toBeTruthy()
  })

  it("quotes the vault's own rule rather than inventing a policy, and names the measurement", () => {
    const text = concurrencyWarning(2) ?? ''
    expect(text).toContain('Do not run parallel ingests')
    expect(text).toContain('13 of 31')
  })

  it('treats an empty or nonsense field as nothing to warn about', () => {
    // The input is a number field; a cleared one arrives as 0 and must not warn.
    expect(concurrencyWarning(0)).toBeNull()
    expect(concurrencyWarning(Number.NaN)).toBeNull()
  })
})
