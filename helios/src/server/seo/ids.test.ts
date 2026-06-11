import { describe, expect, it } from 'vitest'

import { SEO_BUNDLE_ID_RE } from './contracts.js'
import { isSeoBundleId, newSeoBundleId } from './ids.js'

describe('SEO bundle id', () => {
  it('mints a canonical, UTC, sortable id', () => {
    const id = newSeoBundleId(new Date('2026-06-11T12:00:00Z'))
    expect(id).toMatch(SEO_BUNDLE_ID_RE)
    expect(id.startsWith('seob_2026-06-11_120000_')).toBe(true)
  })

  it('recognises valid and invalid ids', () => {
    expect(isSeoBundleId('seob_2026-06-11_120000_abcd12')).toBe(true)
    expect(isSeoBundleId('lpb_2026-06-11_120000_abcd12')).toBe(false)
    expect(isSeoBundleId('seob_2026-06-11_120000_ABCD12')).toBe(false)
  })

  it('mints unique ids within the same second', () => {
    const now = new Date('2026-06-11T12:00:00Z')
    const a = newSeoBundleId(now)
    const b = newSeoBundleId(now)
    expect(a).not.toBe(b)
  })
})
