import { describe, expect, it } from 'vitest'

import {
  BatchPendingPurchaseFamilyOverrideRequestSchema,
  BatchPendingPurchaseFamilyOverrideResponseSchema,
} from './pendingPurchases.js'

describe('BatchPendingPurchaseFamilyOverrideRequestSchema', () => {
  it('accepts a sparse single-field override and coerces row ids', () => {
    const parsed = BatchPendingPurchaseFamilyOverrideRequestSchema.parse({
      packetId: 50,
      rowIds: ['676', 677, '680'],
      structuredOverride: { targetBrand: 'Jeeter' },
    })
    expect(parsed.packetId).toBe(50)
    expect(parsed.rowIds).toEqual([676, 677, 680])
    expect(parsed.structuredOverride).toEqual({ targetBrand: 'Jeeter' })
    expect(parsed.reason).toBeUndefined()
  })

  it('allows an explicit null to clear a field at apply time', () => {
    const parsed = BatchPendingPurchaseFamilyOverrideRequestSchema.parse({
      packetId: 50,
      rowIds: [1],
      structuredOverride: { targetBrand: null },
    })
    expect(parsed.structuredOverride).toEqual({ targetBrand: null })
  })

  it('rejects an empty structured override (no field to set)', () => {
    expect(() =>
      BatchPendingPurchaseFamilyOverrideRequestSchema.parse({
        packetId: 50,
        rowIds: [1],
        structuredOverride: {},
      }),
    ).toThrow()
  })

  it('rejects an empty row-id list and enforces the 500-row cap', () => {
    expect(() =>
      BatchPendingPurchaseFamilyOverrideRequestSchema.parse({
        packetId: 50,
        rowIds: [],
        structuredOverride: { targetBrand: 'Jeeter' },
      }),
    ).toThrow()

    expect(() =>
      BatchPendingPurchaseFamilyOverrideRequestSchema.parse({
        packetId: 50,
        rowIds: Array.from({ length: 501 }, (_, index) => index + 1),
        structuredOverride: { targetBrand: 'Jeeter' },
      }),
    ).toThrow()
  })

  it('rejects unknown structured-override keys (strict shape)', () => {
    expect(() =>
      BatchPendingPurchaseFamilyOverrideRequestSchema.parse({
        packetId: 50,
        rowIds: [1],
        structuredOverride: { notAField: 'x' },
      }),
    ).toThrow()
  })
})

describe('BatchPendingPurchaseFamilyOverrideResponseSchema', () => {
  it('parses updated + skipped rows with reasons', () => {
    const parsed = BatchPendingPurchaseFamilyOverrideResponseSchema.parse({
      requestId: 'req-1',
      skippedRows: [
        { reason: 'approved', rowId: 9 },
        { reason: 'apply_locked', rowId: 10 },
        { reason: 'no_change', rowId: 11 },
      ],
      updatedRowIds: [1, 2, 3],
    })
    expect(parsed.updatedRowIds).toEqual([1, 2, 3])
    expect(parsed.skippedRows).toHaveLength(3)
  })

  it('rejects an unknown skip reason', () => {
    expect(() =>
      BatchPendingPurchaseFamilyOverrideResponseSchema.parse({
        requestId: 'req-1',
        skippedRows: [{ reason: 'mystery', rowId: 1 }],
        updatedRowIds: [],
      }),
    ).toThrow()
  })
})
