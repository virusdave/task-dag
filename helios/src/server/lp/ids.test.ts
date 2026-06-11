import { describe, expect, it } from 'vitest'

import { BUNDLE_ID_RE } from './contracts.js'
import { isBundleId, newBundleId } from './ids.js'

describe('newBundleId', () => {
  it('produces the canonical lpb_ format in UTC', () => {
    const id = newBundleId(new Date('2026-06-10T14:03:12Z'))
    expect(id).toMatch(/^lpb_2026-06-10_140312_[0-9a-f]{6}$/)
    expect(BUNDLE_ID_RE.test(id)).toBe(true)
  })

  it('is unique across calls in the same second', () => {
    const now = new Date('2026-06-10T14:03:12Z')
    const ids = new Set(Array.from({ length: 50 }, () => newBundleId(now)))
    expect(ids.size).toBe(50)
  })

  it('isBundleId rejects malformed ids', () => {
    expect(isBundleId('not-a-bundle')).toBe(false)
    expect(isBundleId('lpb_2026-6-10_140312_7f3a91')).toBe(false)
    expect(isBundleId(newBundleId())).toBe(true)
  })
})
