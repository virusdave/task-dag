import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import type { Queryable } from '../pool.js'
import { getCustomerVisitorDetails } from './customerVisitorDetailsQueries.js'

// Regression for the user-reported customer-details bug: a customer with a
// cancelled invoice showed "2 invoices / $283.02" instead of "1 / $207.31".
// The fix excludes cancelled orders from EVERY sweed_orders read behind the
// details page. The lifetime total is summed in JS (so the central
// header-dollar-sum guard can't see it), so we assert it here at the SQL level:
// every sweed_orders read this endpoint issues must carry the cancelled guard.

const LINKED_ANCHOR = {
  id: 42,
  ingested_at: new Date('2026-06-21T12:00:00Z'),
  ingest_source: 'webhook',
  site_slug: 'bronx',
  provider: 'veriscan',
  link_dealer_id: 7,
  link_customer_id: 7304106,
  link_status: 'linked',
}

function captureMockPool(captured: string[]): Queryable {
  return {
    async query<R extends QueryResultRow>(sql: string): Promise<QueryResult<R>> {
      captured.push(sql)
      const isAnchor = /from\s+visitor_scans\s+vs/i.test(sql) && /visitor_scan_links/i.test(sql)
      const rows = (isAnchor ? [LINKED_ANCHOR] : []) as unknown as R[]
      return { rows, command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] }
    },
  } as unknown as Queryable
}

describe('customer-details summary/details load excludes cancelled orders', () => {
  // Covers the getCustomerVisitorDetails load path (invoice history, prior-visit
  // rollup, address spend). The lazy per-invoice item-expansion path is a
  // display/ownership lookup, not a spend aggregate, so it is out of scope here.
  it('every sweed_orders read in the details load carries the header cancelled guard', async () => {
    const captured: string[] = []
    const result = await getCustomerVisitorDetails(captureMockPool(captured), 42)
    expect(result).not.toBeNull()

    const sweedOrderReads = captured.filter((sql) => /\bsweed_orders\b/i.test(sql))
    // The page issues at least the invoice-history, prior-visit rollup, and
    // address-spend reads against sweed_orders.
    expect(sweedOrderReads.length).toBeGreaterThanOrEqual(3)

    const unguarded = sweedOrderReads.filter(
      (sql) => !/invoiceStatus/.test(sql) && !/sweed-cancelled-intentional/.test(sql),
    )
    expect(unguarded, `unguarded sweed_orders reads:\n${unguarded.join('\n---\n')}`).toEqual([])
  })
})
