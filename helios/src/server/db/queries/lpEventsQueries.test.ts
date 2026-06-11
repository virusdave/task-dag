import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import { bulkInsertLpEvents } from './lpEventsQueries.js'
import type { LpEvent } from '../../lp/contracts.js'

function buildMockDb(returnedEventIds: string[]): {
  db: Queryable
  calls: Array<{ text: string; params: unknown[] | undefined }>
} {
  const calls: Array<{ text: string; params: unknown[] | undefined }> = []
  const db: Queryable = {
    async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
      calls.push({ text, params })
      const rows = returnedEventIds.map((event_id) => ({ event_id })) as unknown as TResult[]
      return {
        command: 'INSERT',
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows,
      } as QueryResult<TResult>
    },
  }
  return { db, calls }
}

function makeEvent(overrides: Partial<LpEvent> = {}): LpEvent {
  return {
    event_id: 'evt-1',
    event_type: 'lp_impression',
    event_ts: '2026-06-11T00:00:00.000Z',
    replica_id: 'mss-replica-a',
    bundle_id: 'lpb_2026-06-11_000000_abcdef',
    policy_id: 'pol-1',
    site: 'freshlybaked.nyc',
    ...overrides,
  }
}

describe('bulkInsertLpEvents', () => {
  it('returns zeros and issues no query for an empty batch', async () => {
    const { db, calls } = buildMockDb([])
    const result = await bulkInsertLpEvents(db, [])
    expect(result).toEqual({ received: 0, inserted: 0, duplicates: 0 })
    expect(calls).toHaveLength(0)
  })

  it('emits one multi-row INSERT ... ON CONFLICT DO NOTHING with 22 params per event', async () => {
    const events = [makeEvent({ event_id: 'a' }), makeEvent({ event_id: 'b' })]
    const { db, calls } = buildMockDb(['a', 'b'])
    const result = await bulkInsertLpEvents(db, events)

    expect(calls).toHaveLength(1)
    expect(calls[0].text).toMatch(/insert into lp_events/i)
    expect(calls[0].text).toMatch(/on conflict \(event_id\) do nothing/i)
    expect(calls[0].text).toMatch(/returning event_id/i)
    // 22 columns × 2 events = 44 bound params, contiguous $1..$44.
    expect(calls[0].params).toHaveLength(44)
    expect(calls[0].text).toContain('$1,')
    expect(calls[0].text).toContain('$44)')

    expect(result).toEqual({ received: 2, inserted: 2, duplicates: 0 })
  })

  it('counts duplicates as received minus rows returned', async () => {
    const events = [makeEvent({ event_id: 'a' }), makeEvent({ event_id: 'b' })]
    // Only 'a' inserted; 'b' already existed (conflict skipped).
    const { db } = buildMockDb(['a'])
    const result = await bulkInsertLpEvents(db, events)
    expect(result).toEqual({ received: 2, inserted: 1, duplicates: 1 })
  })

  it('binds optional fields as null and stringifies jsonb columns', async () => {
    const event = makeEvent({
      event_id: 'a',
      selected_variants: { X1: 'v1' },
      traffic_flags: ['internal'],
    })
    const { db, calls } = buildMockDb(['a'])
    await bulkInsertLpEvents(db, [event])

    const params = calls[0].params as unknown[]
    // event_id first, raw_event last.
    expect(params[0]).toBe('a')
    // selected_variants (index 11) is JSON-stringified.
    expect(params[11]).toBe(JSON.stringify({ X1: 'v1' }))
    // policy_rule_id (index 6) absent → null.
    expect(params[6]).toBeNull()
    // traffic_flags (index 20) JSON-stringified array.
    expect(params[20]).toBe(JSON.stringify(['internal']))
    // raw_event (index 21) is the verbatim event object.
    expect(JSON.parse(params[21] as string)).toMatchObject({ event_id: 'a' })
  })
})
