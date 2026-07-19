import { describe, expect, it, vi } from 'vitest'

import type { Queryable } from '../../server/db/pool.js'
import {
  inferPendingPurchaseVendorEvidence,
  loadPendingPurchaseVendorEvidence,
  type PendingPurchaseVendorEvidenceRow,
} from './pendingPurchaseVendorEvidence.js'

const associations = [
  { vendorId: 1, vendorName: 'Curaleaf', brandName: 'Select', isPrimary: true },
  { vendorId: 1, vendorName: 'Curaleaf', brandName: 'Grass Roots', isPrimary: true },
  { vendorId: 2, vendorName: 'Hemp Hunter', brandName: 'Camino', isPrimary: true },
  { vendorId: 2, vendorName: 'Hemp Hunter', brandName: 'Kiva', isPrimary: true },
  { vendorId: 3, vendorName: 'Secondary Distributor', brandName: 'Select', isPrimary: false },
]

function row(overrides: Partial<PendingPurchaseVendorEvidenceRow> = {}): PendingPurchaseVendorEvidenceRow {
  return {
    rowKey: 'bronx:ambiguous',
    purchaseRefs: [{ dealerId: 10, poId: '100' }],
    parsedBrand: null,
    parsedCategory: null,
    explicitBrandOverride: null,
    ...overrides,
  }
}

function infer(input: {
  rows?: PendingPurchaseVendorEvidenceRow[]
  manifestLines?: Array<{
    dealerId: number
    poId: string
    brandName: string | null
    categoryName: string | null
  }>
  categoryObservations?: Array<{ brandName: string; categoryName: string; count: number }>
} = {}) {
  return inferPendingPurchaseVendorEvidence({
    rows: input.rows ?? [row()],
    associations,
    manifestLines: input.manifestLines ?? [],
    categoryObservations: input.categoryObservations ?? [],
  })
}

describe('inferPendingPurchaseVendorEvidence', () => {
  it('keeps one distributor’s separate vendor purchases isolated by purchase id', () => {
    const result = infer({
      rows: [
        row({ rowKey: 'po-100', purchaseRefs: [{ dealerId: 10, poId: '100' }] }),
        row({ rowKey: 'po-200', purchaseRefs: [{ dealerId: 10, poId: '200' }] }),
      ],
      manifestLines: [
        { dealerId: 10, poId: '100', brandName: 'Select', categoryName: 'Vapes' },
        { dealerId: 10, poId: '200', brandName: 'Kiva', categoryName: 'Edibles' },
      ],
    })

    expect(result.get('po-100')).toMatchObject({ vendorName: 'Curaleaf', confidence: 'high' })
    expect(result.get('po-200')).toMatchObject({ vendorName: 'Hemp Hunter', confidence: 'high' })
  })

  it('uses a known sibling brand to constrain an ambiguous line to the primary vendor', () => {
    const result = infer({
      rows: [row(), row({ rowKey: 'known', parsedBrand: 'Select' })],
    }).get('bronx:ambiguous')

    expect(result).toMatchObject({
      status: 'matched',
      vendorName: 'Curaleaf',
      confidence: 'medium',
      allowedBrandNames: ['Grass Roots', 'Select'],
    })
  })

  it('narrows sibling brands to historically observed category specialization', () => {
    const result = infer({
      rows: [row({ parsedCategory: 'Edibles' }), row({ rowKey: 'known', parsedBrand: 'Kiva' })],
      categoryObservations: [
        { brandName: 'Kiva', categoryName: 'Edibles', count: 40 },
        { brandName: 'Camino', categoryName: 'Vapes', count: 20 },
      ],
    }).get('bronx:ambiguous')

    expect(result?.allowedBrandNames).toEqual(['Kiva'])
    expect(result?.evidence.at(-1)).toContain('Edibles purchase history')
  })

  it('leaves unknown vendors unconstrained instead of inventing a mapping', () => {
    expect(infer({ rows: [row({ parsedBrand: 'Unlisted Brand' })] }).get('bronx:ambiguous')).toEqual({
      status: 'unknown',
      vendorId: null,
      vendorName: null,
      confidence: 'none',
      allowedBrandNames: [],
      allowedCatalogProductIds: [],
      evidence: ['No canonical vendor could be inferred from known brands in this purchase.'],
    })
  })

  it('refuses to constrain a purchase when known brands conflict across vendors', () => {
    const result = infer({
      manifestLines: [
        { dealerId: 10, poId: '100', brandName: 'Select', categoryName: 'Vapes' },
        { dealerId: 10, poId: '100', brandName: 'Kiva', categoryName: 'Edibles' },
      ],
    }).get('bronx:ambiguous')

    expect(result).toMatchObject({ status: 'conflicting', confidence: 'none', allowedBrandNames: [] })
    expect(result?.evidence).toHaveLength(2)
  })

  it('keeps an explicit brand override authoritative over conflicting vendor evidence', () => {
    const result = infer({
      rows: [row({ explicitBrandOverride: 'Operator Brand' })],
      manifestLines: [
        { dealerId: 10, poId: '100', brandName: 'Select', categoryName: 'Vapes' },
        { dealerId: 10, poId: '100', brandName: 'Kiva', categoryName: 'Edibles' },
      ],
    }).get('bronx:ambiguous')

    expect(result).toMatchObject({
      status: 'explicit-override',
      confidence: 'high',
      allowedBrandNames: ['Operator Brand'],
    })
  })

  it('retains a non-primary sibling brand when its category history specializes it', () => {
    const result = inferPendingPurchaseVendorEvidence({
      rows: [row({ parsedCategory: 'Edibles' }), row({ rowKey: 'known', parsedBrand: 'Select' })],
      associations: [
        { vendorId: 1, vendorName: 'Primary Vendor', brandName: 'Select', isPrimary: true },
        { vendorId: 1, vendorName: 'Primary Vendor', brandName: 'Shared Brand', isPrimary: false },
        { vendorId: 2, vendorName: 'Other Primary', brandName: 'Shared Brand', isPrimary: true },
      ],
      manifestLines: [],
      categoryObservations: [{ brandName: 'Shared Brand', categoryName: 'Edibles', count: 12 }],
    }).get('bronx:ambiguous')

    expect(result).toMatchObject({
      vendorName: 'Primary Vendor',
      allowedBrandNames: ['Shared Brand'],
    })
  })
})

describe('loadPendingPurchaseVendorEvidence', () => {
  it('returns explicit unavailable evidence without querying pending vendor tables', async () => {
    const query = vi.fn(async () => ({ rows: [{ applied: false }] }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await loadPendingPurchaseVendorEvidence(
      { query } as unknown as Queryable,
      [row()],
    )

    expect(query).toHaveBeenCalledTimes(1)
    expect(result.get('bronx:ambiguous')).toMatchObject({
      status: 'unknown',
      confidence: 'none',
      allowedBrandNames: [],
      evidence: [expect.stringContaining('migration is pending')],
    })
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
