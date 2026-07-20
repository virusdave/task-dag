import { describe, expect, it } from 'vitest'

import {
  invoiceStatusNameForIngest,
  SWEED_ORDERS_UPSERT_CHANGE_PREDICATE_SQL,
} from './configWorkersSweedOrdersIngestJob.js'

describe('Sweed order invoice-status projection', () => {
  it('retains a valid status when an unrelated envelope field is malformed', () => {
    expect(
      invoiceStatusNameForIngest({
        invoiceStatus: { name: ' Cancelled ' },
        subtotalAmount: { malformed: true },
      }),
    ).toBe('Cancelled')
  })

  it('maps absent and blank status names to unknown', () => {
    expect(invoiceStatusNameForIngest({})).toBeNull()
    expect(invoiceStatusNameForIngest({ invoiceStatus: { name: '   ' } })).toBeNull()
  })

  it('repairs a missing projection even when the raw envelope is unchanged', () => {
    expect(SWEED_ORDERS_UPSERT_CHANGE_PREDICATE_SQL).toContain(
      'sweed_orders.raw_json is distinct from excluded.raw_json',
    )
    expect(SWEED_ORDERS_UPSERT_CHANGE_PREDICATE_SQL).toContain(
      'or sweed_orders.invoice_status_name is distinct from excluded.invoice_status_name',
    )
  })
})
