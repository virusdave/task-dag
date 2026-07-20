import { describe, expect, it } from 'vitest'

import {
  budtenderCashierBlockedStatus,
  isBudtenderCashierDisabled,
} from './budtenderAnalytics.js'

describe('isBudtenderCashierDisabled', () => {
  it('does not disable an active user merely because userStatus is nonzero', () => {
    expect(isBudtenderCashierDisabled({ blocked: false, userStatus: 1 })).toBe(false)
    expect(budtenderCashierBlockedStatus({ blocked: false })).toBe('not_blocked')
  })

  it('disables a user explicitly blocked by Sweed', () => {
    expect(isBudtenderCashierDisabled({ blocked: true, userStatus: 0 })).toBe(true)
    expect(budtenderCashierBlockedStatus({ blocked: true })).toBe('blocked')
  })

  it('keeps an uncached cashier in an unknown status group', () => {
    expect(budtenderCashierBlockedStatus({ blocked: null })).toBe('unknown')
  })
})
