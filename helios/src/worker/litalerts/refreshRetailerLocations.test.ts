import { describe, expect, it } from 'vitest'

import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../../server/db/pool.js'
import type { LitAlertsRetailer } from './partnerClient.js'
import {
  refreshLitalertsRetailerLocations,
  type RetailerGeocodeCoordinates,
} from './refreshRetailerLocations.js'

interface RecordedQuery {
  sql: string
  values: unknown[]
}

/**
 * Deterministic fake `Queryable`. The upsert statement (the one whose
 * SQL contains `insert into litalerts_retailer_locations`) returns a
 * caller-controlled `needs_geocode` flag keyed by the retailer_id in
 * `values[0]`; every other statement returns an empty result. No real
 * database, partner API, or Census service is touched.
 */
function makeFakeDb(needsGeocodeByRetailerId: Map<number, boolean>): {
  db: Queryable
  queries: RecordedQuery[]
} {
  const queries: RecordedQuery[] = []
  const db: Queryable = {
    async query<TResult extends QueryResultRow>(
      sql: string,
      values?: unknown[],
    ): Promise<QueryResult<TResult>> {
      queries.push({ sql, values: values ?? [] })
      const isUpsert = sql.includes('insert into litalerts_retailer_locations')
      const rows: TResult[] = []
      if (isUpsert) {
        const retailerId = Number(values?.[0])
        const needsGeocode = needsGeocodeByRetailerId.get(retailerId) ?? false
        rows.push({ needs_geocode: needsGeocode } as unknown as TResult)
      }
      return {
        rows,
        command: isUpsert ? 'INSERT' : 'UPDATE',
        rowCount: rows.length,
        oid: 0,
        fields: [],
      }
    },
  }
  return { db, queries }
}

function retailer(overrides: Partial<LitAlertsRetailer> & { id: number }): LitAlertsRetailer {
  return {
    name: `Retailer ${overrides.id}`,
    address: `${overrides.id} Main St, New York, NY 10001`,
    medical: null,
    recreational: null,
    ...overrides,
  }
}

describe('refreshLitalertsRetailerLocations', () => {
  it('upserts every retailer and geocodes only the rows that need it', async () => {
    const retailers: LitAlertsRetailer[] = [
      retailer({ id: 1 }), // already geocoded → no geocode call
      retailer({ id: 2 }), // needs geocode, geocoder resolves
      retailer({ id: 3, address: null }), // needs geocode but has no address
      retailer({ id: 4 }), // needs geocode, geocoder fails to resolve
    ]
    const needs = new Map<number, boolean>([
      [1, false],
      [2, true],
      [3, true],
      [4, true],
    ])
    const { db, queries } = makeFakeDb(needs)

    const geocodeCalls: string[] = []
    const geocode = async (address: string): Promise<RetailerGeocodeCoordinates | null> => {
      geocodeCalls.push(address)
      if (address.startsWith('2 ')) return { latitude: 40.5, longitude: -73.9 }
      return null
    }

    const totals = await refreshLitalertsRetailerLocations('ny', {
      db,
      listRetailers: async (stateCode) => {
        expect(stateCode).toBe('NY') // normalized to uppercase
        return retailers
      },
      geocode,
    })

    expect(totals).toEqual({
      retailersSeen: 4,
      upserted: 4,
      newlyGeocoded: 1,
      alreadyGeocoded: 1,
      missingAddress: 1,
      geocodeFailures: 1,
    })

    // Geocode only attempted for retailers 2 and 4 (both need it AND have
    // an address); retailer 1 is already geocoded and retailer 3 has no
    // address, so neither burns a Census call.
    expect(geocodeCalls).toEqual([
      '2 Main St, New York, NY 10001',
      '4 Main St, New York, NY 10001',
    ])

    // Four upserts, and exactly one persist-geocode UPDATE (retailer 2).
    const upserts = queries.filter((q) => q.sql.includes('insert into litalerts_retailer_locations'))
    const geoUpdates = queries.filter((q) => q.sql.includes('set latitude'))
    expect(upserts).toHaveLength(4)
    expect(geoUpdates).toHaveLength(1)
    expect(geoUpdates[0]?.values).toEqual([2, 40.5, -73.9, 'census-onelineaddress'])

    // Upsert normalizes the state code and trims the name.
    expect(upserts[0]?.values?.[3]).toBe('NY')
  })

  it('handles an empty retailer directory without any DB writes beyond zero upserts', async () => {
    const { db, queries } = makeFakeDb(new Map())
    let geocodeCount = 0

    const totals = await refreshLitalertsRetailerLocations('NY', {
      db,
      listRetailers: async () => [],
      geocode: async () => {
        geocodeCount++
        return null
      },
    })

    expect(totals).toEqual({
      retailersSeen: 0,
      upserted: 0,
      newlyGeocoded: 0,
      alreadyGeocoded: 0,
      missingAddress: 0,
      geocodeFailures: 0,
    })
    expect(queries).toHaveLength(0)
    expect(geocodeCount).toBe(0)
  })
})
