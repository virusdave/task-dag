import { describe, expect, it } from 'vitest'

import {
  VendorCreateRequestSchema,
  VendorUpdateRequestSchema,
} from './vendors.js'

describe('vendor API contracts', () => {
  it('bounds and normalizes vendor ordering metadata', () => {
    const parsed = VendorCreateRequestSchema.parse({
      name: '  Acme Supply  ',
      isMso: true,
      associations: [{ brandName: '  Acme Flower  ', targetDaysOnHand: 18 }],
    })

    expect(parsed).toEqual({
      name: 'Acme Supply',
      isMso: true,
      isMicro: false,
      codOnly: false,
      associations: [
        {
          brandName: 'Acme Flower',
          isPrimary: true,
          targetDaysOnHand: 18,
          assetUrl: null,
          codRequired: null,
          codDiscountSource: null,
          minimumOrderDollars: null,
          comments: null,
        },
      ],
    })
  })

  it('rejects duplicate brands case-insensitively and empty patches', () => {
    expect(() =>
      VendorCreateRequestSchema.parse({
        name: 'Acme',
        associations: [{ brandName: 'Brand A' }, { brandName: 'brand a' }],
      }),
    ).toThrow(/same brand/i)
    expect(() => VendorUpdateRequestSchema.parse({})).toThrow(/at least one/i)
  })

  it('rejects unbounded association values', () => {
    expect(() =>
      VendorCreateRequestSchema.parse({
        name: 'Acme',
        associations: [{ brandName: 'Brand A', targetDaysOnHand: 3_651 }],
      }),
    ).toThrow()
  })
})
