import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import { appendAuditEvent } from './appendAuditEvent.js'
import type { Queryable } from '../db/pool.js'

describe('appendAuditEvent', () => {
  it('binds one value expression for every inserted audit_events column', async () => {
    let queryText = ''
    let values: unknown[] | undefined
    const db: Queryable = {
      async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
        queryText = text
        values = params
        return {
          command: 'INSERT',
          fields: [],
          oid: 0,
          rowCount: 1,
          rows: [{ id: 123 }] as unknown as TResult[],
        } as QueryResult<TResult>
      },
    }

    const eventId = await appendAuditEvent(db, {
      actorType: 'user',
      actorUserId: 1,
      entityId: '1',
      entityType: 'user',
      eventType: 'auth.user.signed_in',
      module: 'catalog',
      payload: { hello: 'world' },
      requestId: 'req-123',
      scope: null,
      undoPayload: null,
    })

    expect(eventId).toBe(123)
    expect(values).toHaveLength(12)
    expect(queryText).toContain('values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)')
  })
})
