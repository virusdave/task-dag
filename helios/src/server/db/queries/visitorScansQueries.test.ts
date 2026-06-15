import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import {
  insertVisitorScan,
  listVisitorScans,
} from './visitorScansQueries.js'
import { envelopeToRowInput, VeriScanEnvelopeSchema } from '../../visitorScans/envelope.js'

function mockPool(handleQuery: (text: string, params: unknown[] | undefined) => unknown[]): {
  db: Queryable
  calls: Array<{ text: string; params: unknown[] | undefined }>
} {
  const calls: Array<{ text: string; params: unknown[] | undefined }> = []
  const db: Queryable = {
    async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
      calls.push({ text, params })
      const rows = handleQuery(text, params)
      return {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows: rows as unknown as TResult[],
      } as QueryResult<TResult>
    },
  }
  return { db, calls }
}

const SAMPLE_ENVELOPE = {
  Type: 'CreateCard',
  EventId: 42,
  WebHookId: 7,
  Created: '2026-05-27T00:00:00Z',
  Sent: '2026-05-27T00:00:00Z',
  Data: {
    HashId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    FirstName: 'Smoke',
    LastName: 'Test',
    State: 'NY',
    PostalCode: '10451',
  },
}

describe('insertVisitorScan', () => {
  it('returns inserted=true when the row is new', async () => {
    const { db, calls } = mockPool(() => [{ id: 1 }])
    const envelope = VeriScanEnvelopeSchema.parse(SAMPLE_ENVELOPE)
    const row = envelopeToRowInput({
      envelope,
      ingestSource: 'webhook',
      siteSlug: 'bx',
      provider: 'veriscan',
      rawEnvelope: SAMPLE_ENVELOPE,
    })
    const result = await insertVisitorScan(db, row)
    expect(result.inserted).toBe(true)
    // The first query MUST be the visitor_scans insert with the
    // (provider, hash_id) ON CONFLICT idempotency clause. Helper
    // best-effort calls (visitor_scan_link seed, addresses upsert,
    // visitor_scans.address_id link) follow it but are out-of-scope
    // for this assertion.
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0].text).toMatch(/on conflict \(provider, hash_id\) do nothing/i)
    expect(calls[0].text).toMatch(/insert into visitor_scans/i)
    expect(calls[0].text).toMatch(/returning id/i)
  })

  it('returns inserted=false when ON CONFLICT swallowed the insert', async () => {
    const { db } = mockPool(() => [])
    const envelope = VeriScanEnvelopeSchema.parse(SAMPLE_ENVELOPE)
    const row = envelopeToRowInput({
      envelope,
      ingestSource: 'backfill',
      siteSlug: 'mh',
      provider: 'veriscan',
      rawEnvelope: SAMPLE_ENVELOPE,
    })
    const result = await insertVisitorScan(db, row)
    expect(result.inserted).toBe(false)
  })
})

describe('listVisitorScans', () => {
  it('applies site / state / postalPrefix / cursor filters', async () => {
    const { db, calls } = mockPool(() => [])
    await listVisitorScans(db, {
      siteSlugs: ['bx', 'mh'],
      ingestSources: ['webhook'],
      states: ['NY'],
      postalPrefix: '104',
      documentType: null,
      authenticationStatus: null,
      scanStatus: null,
      scannedAfter: '2026-05-27T00:00:00Z',
      scannedBefore: null,
      beforeId: 1000,
      limit: 50,
    })
    expect(calls).toHaveLength(1)
    const sql = calls[0].text
    const params = calls[0].params as unknown[]
    expect(sql).toMatch(/site_slug = any\(\$1\)/)
    expect(sql).toMatch(/ingest_source = any\(\$2\)/)
    expect(sql).toMatch(/state = any\(\$3\)/)
    expect(sql).toMatch(/postal_code like \$4/)
    expect(sql).toMatch(/scanned_at >= \$5/)
    expect(sql).toMatch(/id < \$6/)
    // The over-fetch-by-one trick:
    expect(params[params.length - 1]).toBe(51)
  })

  it('reports hasMore=true when results exceed limit', async () => {
    const { db } = mockPool(() => {
      return Array.from({ length: 3 }, (_, i) => ({
        id: i + 1,
        ingested_at: new Date('2026-05-27T00:00:00Z'),
        ingest_source: 'webhook',
        site_slug: 'bx',
        provider: 'veriscan',
        scanned_at: new Date('2026-05-27T00:00:00Z'),
        created_at: null,
        webhook_type: 'CreateCard',
        hash_id: `00000000-0000-0000-0000-00000000000${i}`,
        first_name: null,
        middle_name: null,
        last_name: null,
        state: null,
        postal_code: null,
        city: null,
        address: null,
        country: null,
        document_type: null,
        authentication_status: null,
        scan_status: null,
        latitude: null,
        longitude: null,
        scan_latitude: null,
        scan_longitude: null,
        raw_envelope: {},
      }))
    })
    const result = await listVisitorScans(db, {
      siteSlugs: null,
      ingestSources: null,
      states: null,
      postalPrefix: null,
      documentType: null,
      authenticationStatus: null,
      scanStatus: null,
      scannedAfter: null,
      scannedBefore: null,
      beforeId: null,
      limit: 2,
    })
    expect(result.items).toHaveLength(2)
    expect(result.hasMore).toBe(true)
  })

  it('attaches marketing-segment chips via one batch query for linked rows', async () => {
    const { db, calls } = mockPool((text) => {
      if (/from sweed_customer_segments/i.test(text)) {
        return [
          {
            sweed_customer_id: 428378,
            segment_id: '10282',
            scope_dealer_id: 210249,
            segment_name: 'Bronx Local',
            segment_type_id: 1,
            scope_dealer_name: 'Bronx',
            total_count: 4,
          },
        ]
      }
      return [
        {
          id: 7,
          ingested_at: new Date('2026-05-27T00:00:00Z'),
          ingest_source: 'webhook',
          site_slug: 'bx',
          provider: 'veriscan',
          scanned_at: new Date('2026-05-27T00:00:00Z'),
          created_at: null,
          webhook_type: 'CreateCard',
          hash_id: '00000000-0000-0000-0000-000000000007',
          first_name: null,
          middle_name: null,
          last_name: null,
          state: null,
          postal_code: null,
          city: null,
          address: null,
          country: null,
          document_type: null,
          authentication_status: null,
          scan_status: null,
          latitude: null,
          longitude: null,
          scan_latitude: null,
          scan_longitude: null,
          raw_envelope: {},
          link_dealer_id: 210249,
          link_customer_id: 428378,
          link_status: 'linked',
        },
      ]
    })
    const result = await listVisitorScans(db, {
      siteSlugs: null,
      ingestSources: null,
      states: null,
      postalPrefix: null,
      documentType: null,
      authenticationStatus: null,
      scanStatus: null,
      scannedAfter: null,
      scannedBefore: null,
      beforeId: null,
      limit: 50,
    })
    // List query + exactly one batch chip query.
    expect(calls).toHaveLength(2)
    expect(calls[1].text).toMatch(/from sweed_customer_segments/i)
    expect(calls[1].params?.[0]).toEqual([428378])
    const seg = result.items[0].marketingSegments
    expect(seg).not.toBeNull()
    expect(seg?.totalCount).toBe(4)
    expect(seg?.items).toHaveLength(1)
    expect(seg?.items[0]).toMatchObject({
      segmentId: '10282',
      name: 'Bronx Local',
      type: 'static',
      scopeLabel: 'Bronx',
    })
  })
})
