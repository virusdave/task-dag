import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../../server/db/pool.js'
import {
  applyGeocodeResult,
  queueGeocodePending,
  upsertAddress,
  type GeocodeResult,
} from './addressesQueries.js'

interface RecordedCall {
  text: string
  params: unknown[] | undefined
}

function buildMockDb(rowsToReturn: Array<Record<string, unknown>>): {
  db: Queryable
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const db: Queryable = {
    async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
      calls.push({ text, params })
      return {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: rowsToReturn.length,
        rows: rowsToReturn as unknown as TResult[],
      } as QueryResult<TResult>
    },
  }
  return { db, calls }
}

describe('upsertAddress', () => {
  it('returns null without issuing SQL when input collapses to an empty normalized key', async () => {
    const { db, calls } = buildMockDb([])
    const result = await upsertAddress(db, { line1: '   ', city: '', state: null, zip: '' })
    expect(result).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('inserts and returns isNew=true for a brand-new normalized key', async () => {
    const { db, calls } = buildMockDb([
      { id: 17, geocode_status: 'pending', is_new: true },
    ])
    const result = await upsertAddress(db, {
      line1: '123 Main St',
      city: 'Brooklyn',
      state: 'NY',
      zip: '11201',
    })
    expect(result).toEqual({ addressId: 17, isNew: true, geocodeStatus: 'pending' })
    expect(calls).toHaveLength(1)
    // The query must (a) hit `addresses`, (b) be an ON CONFLICT upsert
    // on the `normalized` unique index, and (c) return `is_new` via
    // the standard `(xmax = 0)` trick.
    expect(calls[0].text).toMatch(/insert into addresses/i)
    expect(calls[0].text).toMatch(/on conflict\s*\(\s*normalized\s*\)/i)
    expect(calls[0].text).toMatch(/xmax\s*=\s*0/i)
    // The params should carry the raw casing and the normalized key.
    expect(calls[0].params).toEqual([
      '123 Main St',
      null,
      'Brooklyn',
      'NY',
      '11201',
      '123 main st brooklyn ny 11201',
    ])
  })

  it('reports the existing geocode_status when the row already existed', async () => {
    const { db } = buildMockDb([
      { id: 9, geocode_status: 'ok', is_new: false },
    ])
    const result = await upsertAddress(db, {
      line1: '450 Broadway',
      city: 'NY',
      state: 'NY',
      zip: '10013',
    })
    expect(result).toEqual({ addressId: 9, isNew: false, geocodeStatus: 'ok' })
  })

  it('throws if the upsert RETURNING clause comes back empty (programmer error / schema drift)', async () => {
    const { db } = buildMockDb([])
    await expect(
      upsertAddress(db, {
        line1: '1 World Trade',
        city: 'NY',
        state: 'NY',
        zip: '10007',
      }),
    ).rejects.toThrow(/ON CONFLICT upsert returned no row/i)
  })
})

describe('queueGeocodePending', () => {
  it('emits a SKIP LOCKED select that honors the batch size and maps rows to PendingGeocodeAddress', async () => {
    const { db, calls } = buildMockDb([
      { id: 1, normalized: 'addr a' },
      { id: 4, normalized: 'addr b' },
    ])
    const result = await queueGeocodePending(db, 50)
    expect(result).toEqual([
      { addressId: 1, normalized: 'addr a' },
      { addressId: 4, normalized: 'addr b' },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toMatch(/from addresses/i)
    expect(calls[0].text).toMatch(/where geocode_status\s*=\s*'pending'/i)
    expect(calls[0].text).toMatch(/order by id/i)
    expect(calls[0].text).toMatch(/for update skip locked/i)
    expect(calls[0].params).toEqual([50])
  })

  it('rejects non-positive or non-integer batch sizes', async () => {
    const { db } = buildMockDb([])
    await expect(queueGeocodePending(db, 0)).rejects.toThrow(/positive integer/i)
    await expect(queueGeocodePending(db, -3)).rejects.toThrow(/positive integer/i)
    await expect(queueGeocodePending(db, 1.5)).rejects.toThrow(/positive integer/i)
  })
})

describe('applyGeocodeResult', () => {
  const okResult: GeocodeResult = {
    latitude: 40.7,
    longitude: -73.99,
    zip5: '11201',
    city: 'BROOKLYN',
    county: 'Kings County',
    stateCode: 'NY',
    status: 'ok',
  }

  it('writes every geocode column atomically and defaults the source label', async () => {
    const { db, calls } = buildMockDb([])
    await applyGeocodeResult(db, 42, okResult)
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toMatch(/update addresses/i)
    expect(calls[0].text).toMatch(/last_geocoded_at\s*=\s*now\(\)/i)
    expect(calls[0].params).toEqual([
      42,
      40.7,
      -73.99,
      '11201',
      'BROOKLYN',
      'Kings County',
      'NY',
      'ok',
      'census-onelineaddress',
    ])
  })

  it('honors a custom source label when the caller provides one', async () => {
    const { db, calls } = buildMockDb([])
    await applyGeocodeResult(db, 42, { ...okResult, source: 'manual-fixup' })
    expect(calls[0].params?.[8]).toBe('manual-fixup')
  })

  it('persists a "failed" outcome with null lat/lng (so the row leaves the pending queue)', async () => {
    const { db, calls } = buildMockDb([])
    await applyGeocodeResult(db, 99, {
      latitude: null,
      longitude: null,
      zip5: null,
      city: null,
      county: null,
      stateCode: null,
      status: 'failed',
    })
    expect(calls[0].params).toEqual([
      99, null, null, null, null, null, null, 'failed', 'census-onelineaddress',
    ])
  })

  it('refuses to write "pending" as an outcome (programmer error guard)', async () => {
    const { db, calls } = buildMockDb([])
    await expect(
      applyGeocodeResult(db, 1, { ...okResult, status: 'pending' as never }),
    ).rejects.toThrow(/refusing to write 'pending'/i)
    expect(calls).toHaveLength(0)
  })
})
