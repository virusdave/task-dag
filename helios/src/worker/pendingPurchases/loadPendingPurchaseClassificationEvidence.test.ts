import { describe, expect, it, vi } from 'vitest'

import type { Queryable } from '../../server/db/pool.js'
import { loadPendingPurchaseClassificationEvidence } from './loadPendingPurchaseClassificationEvidence.js'

const descriptor = {
  rowKey: 'r1',
  siteDealerId: 1,
  distributorProductId: 'dp-1',
  distributorProductName: 'Acme Pink Runtz 3.5g',
  brandNames: ['Acme'],
}

describe('loadPendingPurchaseClassificationEvidence', () => {
  it('loads exact sanctioned history and ranks bounded typed LitAlerts candidates', async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes('pending_purchase_rows')) return { rows: [{
        source_row_key: 'r1', distributor_product_id: 'dp-1', distributor_product_name: 'old',
        target_brand: 'Acme', expected_category: 'Flower', expected_subcategory: 'Eighth',
        target_group_name: 'Pink Runtz', target_variant_name: 'Pink Runtz 3.5g',
        target_variant_tab: 'Flower', target_strain_name: 'Pink Runtz', target_size: '3.5g',
        target_pack_count: 1, updated_at: new Date('2026-07-24T12:00:00Z'),
      }] }
      if (text.includes('litalerts_brands')) return { rows: [{
        brand_id: '9', name: 'Acme', last_seen_at: new Date('2026-07-25T00:00:00Z'),
      }] }
      return { rows: [
        { product_id: '102', brand_id: '9', brand_name: 'Acme', product_name: 'Other Gummies', category: 'Edible', amount: '10', units: 'mg', observed_at: new Date('2026-07-25T00:00:00Z') },
        { product_id: '101', brand_id: '9', brand_name: 'Acme', product_name: 'Old Pink Runtz', category: 'Flower', amount: '3.5', units: 'g', observed_at: new Date('2026-07-22T00:00:00Z') },
        { product_id: '101', brand_id: '9', brand_name: 'Acme', product_name: 'Pink Runtz 3.5g', category: 'Flower', amount: '3.5', units: 'g', observed_at: new Date('2026-07-23T00:00:00Z') },
      ] }
    })
    const evidence = await loadPendingPurchaseClassificationEvidence(
      { query } as unknown as Queryable,
      [descriptor],
      [
        { sweedBrandId: 88, brandName: 'Acme' },
        { sweedBrandId: 89, brandName: 'Unrelated Brand' },
        { sweedBrandId: 90, brandName: 'Runtz' },
      ],
    )
    expect(evidence.get('r1')?.priorOutcome?.targetBrand).toBe('Acme')
    expect(evidence.get('r1')?.priorOutcome).toMatchObject({
      targetVariantTab: 'Flower', targetStrainName: 'Pink Runtz',
    })
    expect(evidence.get('r1')?.marketBrandCandidates[0]).toMatchObject({
      litalertsBrandId: '9', brandName: 'Acme',
    })
    expect(evidence.get('r1')?.sweedBrandCandidates).toEqual([
      { sweedBrandId: 88, brandName: 'Acme' },
    ])
    expect(evidence.get('r1')?.marketCandidates[0]).toMatchObject({ litalertsProductId: '101', units: 'g' })
    const productCall = query.mock.calls.find(([text]) => text.includes('litalerts_products'))
    expect(productCall?.[0]).not.toMatch(/raw_(config|product)_json/i)
    expect(productCall?.[0]).toMatch(/limit \$2/i)
    expect(productCall?.[0]).toMatch(/distinct on \(product_id, amount, units\)/i)
    expect(evidence.get('r1')?.marketCandidates.filter((candidate) => candidate.litalertsProductId === '101')).toHaveLength(1)
    const priorCall = query.mock.calls.find(([text]) => text.includes('pending_purchase_rows'))
    expect(priorCall?.[0]).toMatch(/edited_structured_fields \? 'targetBrand'/)
    expect(priorCall?.[0]).toMatch(/edited_structured_fields \? 'targetVariantTab'/)
    expect(priorCall?.[0]).toMatch(/else p\.raw_row_json ->> 'targetVariantTab'/)
    expect(priorCall?.[0]).toMatch(/edited_structured_fields \? 'targetStrainName'/)
    expect(priorCall?.[0]).toMatch(/else p\.raw_row_json ->> 'targetStrain'/)
    expect(priorCall?.[0]).toMatch(/match_rank asc/)
    expect(priorCall?.[0]).toMatch(/p\.site_dealer_id = i\.site_dealer_id/)
  })

  it('degrades each failed provider independently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = { query: vi.fn(async () => { throw new Error('provider offline') }) } as unknown as Queryable
    const evidence = await loadPendingPurchaseClassificationEvidence(db, [descriptor])
    expect(evidence.get('r1')).toEqual({
      priorOutcome: null,
      marketBrandCandidates: [],
      marketCandidates: [],
      sweedBrandCandidates: [],
    })
    expect(warn).toHaveBeenCalled()
  })

  it('does not emit arbitrary zero-overlap market brands', async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes('pending_purchase_rows')) return { rows: [] }
      if (text.includes('litalerts_brands')) return { rows: [{
        brand_id: '9', name: 'Unrelated Brand', last_seen_at: new Date('2026-07-25T00:00:00Z'),
      }] }
      return { rows: [] }
    })
    const evidence = await loadPendingPurchaseClassificationEvidence(
      { query } as unknown as Queryable,
      [{
        ...descriptor,
        distributorProductName: 'ZXQ 3.5G',
        brandNames: [],
      }],
      [{ sweedBrandId: 89, brandName: 'Unrelated Brand' }],
    )
    expect(evidence.get('r1')?.marketBrandCandidates).toEqual([])
    expect(evidence.get('r1')?.marketCandidates).toEqual([])
    expect(evidence.get('r1')?.sweedBrandCandidates).toEqual([])
    expect(query.mock.calls.some(([text]) => text.includes('litalerts_products'))).toBe(false)
  })

  it('rejects an oversized unbatched call instead of silently dropping rows', async () => {
    const db = { query: vi.fn() } as unknown as Queryable
    const descriptors = Array.from({ length: 86 }, (_unused, index) => ({
      ...descriptor,
      rowKey: `r${index}`,
    }))
    await expect(loadPendingPurchaseClassificationEvidence(db, descriptors)).rejects.toThrow(/batch by classifier chunk/)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('allocates the bounded product-brand pool fairly across a large chunk', async () => {
    const brands = Array.from({ length: 128 }, (_unused, index) => ({
      brand_id: String(index + 1),
      name: `Brand ${index + 1}`,
      last_seen_at: new Date('2026-07-25T00:00:00Z'),
    }))
    const descriptors = Array.from({ length: 16 }, (_unused, rowIndex) => ({
      ...descriptor,
      rowKey: `r${rowIndex}`,
      distributorProductName: `Opaque item ${rowIndex}`,
      brandNames: brands.slice(rowIndex * 8, rowIndex * 8 + 8).map((brand) => brand.name),
    }))
    const query = vi.fn(async (text: string) => {
      if (text.includes('pending_purchase_rows')) return { rows: [] }
      if (text.includes('litalerts_brands')) return { rows: brands }
      return { rows: [] }
    })

    await loadPendingPurchaseClassificationEvidence({ query } as unknown as Queryable, descriptors)

    const productCall = query.mock.calls.find(([text]) => text.includes('litalerts_products'))
    const selectedBrandIds = productCall?.[1]?.[0] as string[]
    expect(selectedBrandIds).toHaveLength(120)
    expect(selectedBrandIds).toContain('121')
  })
})
