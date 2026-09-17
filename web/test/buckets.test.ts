import { describe, it, expect } from 'vitest'
import { bucketLabel } from '../src/lib/buckets.ts'

describe('the buckets as a reader sees them', () => {
  it('reads the questions folder as Research, the rename of 2026-09-16', () => {
    expect(bucketLabel('questions')).toBe('Research')
  })
  it('keeps a folder it does not know under its own name', () => {
    expect(bucketLabel('recipes')).toBe('recipes')
  })
})
