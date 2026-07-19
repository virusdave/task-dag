import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import type { Queryable } from '../pool.js'
import { listVendors, replaceVendorAssociations, updateVendor } from './vendorsQueries.js'

function result<TResult extends QueryResultRow>(rows: TResult[]): QueryResult<TResult> {
  return { command: 'SELECT', fields: [], oid: 0, rowCount: rows.length, rows }
}

describe('vendorsQueries', () => {
  it('lists bounded vendors with association metadata and observed distributor history', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = []
    const db: Queryable = {
      async query<TResult extends QueryResultRow>(text: string, values?: unknown[]) {
        calls.push({ text, values })
        if (text.includes('from vendors order by')) {
          return result([{ id: 4, name: 'Vendor', is_mso: false, is_micro: true, cod_only: false,
            created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-02T00:00:00.000Z' }] as unknown as TResult[])
        }
        if (text.includes('from vendor_brand_associations') && !text.includes('with history')) {
          return result([{ id: 9, vendor_id: 4, brand_name: 'Brand', is_primary: true,
            target_days_on_hand: 18, asset_url: null, cod_required: false,
            cod_discount_source: null, minimum_order_dollars: '500.00', comments: 'Call first' }] as unknown as TResult[])
        }
        return result([{ vendor_id: 4, distributor_name: 'Observed Distributor', purchase_count: 3,
          last_delivery_date: '2026-07-03', site_keys: ['bronx', 'midtown'] }] as unknown as TResult[])
      },
    }

    const vendors = await listVendors(db)

    expect(vendors[0]?.name).toBe('Vendor')
    expect(vendors[0]?.associations[0]).toMatchObject({ brandName: 'Brand', minimumOrderDollars: 500 })
    expect(vendors[0]?.observedDistributors[0]).toEqual({
      name: 'Observed Distributor', purchaseCount: 3, lastDeliveryDate: '2026-07-03',
      siteKeys: ['bronx', 'midtown'],
    })
    expect(calls[0]?.text).toContain('limit 500')
    expect(calls.find((call) => call.text.includes('with history'))?.text).toContain('history_rank <= 20')
    expect(calls.find((call) => call.text.includes('with history'))?.text)
      .toContain('join sweed_purchase_line_items l on l.brand_name = a.brand_name')
  })

  it('batch-upserts ordering metadata and deletes associations omitted from replacement', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = []
    const db: Queryable = {
      async query<TResult extends QueryResultRow>(text: string, values?: unknown[]) {
        calls.push({ text, values })
        return result([] as TResult[])
      },
    }

    await replaceVendorAssociations(db, 7, [{
      brandName: 'Brand', isPrimary: true, targetDaysOnHand: 18, assetUrl: null,
      codRequired: true, codDiscountSource: 'invoice', minimumOrderDollars: 500, comments: null,
    }])

    expect(calls).toHaveLength(2)
    expect(calls[0]?.text).toContain('from unnest(')
    expect(calls[0]?.text).toContain('is distinct from')
    expect(calls[1]?.text).toContain('delete from vendor_brand_associations')
    expect(calls[1]?.values).toEqual([7, ['brand']])
  })

  it('does not touch vendor updated_at when labels and name are unchanged', async () => {
    const calls: string[] = []
    const db: Queryable = {
      async query<TResult extends QueryResultRow>(text: string) {
        calls.push(text)
        if (text.includes('for update')) {
          return result([{ id: 1, name: 'Same', is_mso: false, is_micro: false, cod_only: false,
            created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z' }] as unknown as TResult[])
        }
        return result([] as TResult[])
      },
    }

    expect(await updateVendor(db, 1, { name: 'Same' })).toBe(true)
    expect(calls[1]).toContain('is distinct from')
  })
})
