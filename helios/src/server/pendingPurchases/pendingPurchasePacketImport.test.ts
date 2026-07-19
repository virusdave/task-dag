import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isPendingPurchaseRefinementSchemaAvailable } from '../db/queries/pendingPurchaseRefinementQueries.js'
import {
  persistPendingPurchasePacket,
  type ImportPendingPurchasePacketInput,
} from './pendingPurchasePacketImport.js'

vi.mock('../db/queries/pendingPurchaseRefinementQueries.js', () => ({
  isPendingPurchaseRefinementSchemaAvailable: vi.fn(),
}))

const migrationApplied = vi.mocked(isPendingPurchaseRefinementSchemaAvailable)

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
}

function input(source: 'generated' | 'import' = 'generated'): ImportPendingPurchasePacketInput {
  return {
    createdByUserId: 17,
    importFileName: source === 'import' ? 'packet.json' : null,
    jobId: 42,
    packet: {
      generatedAt: '2026-07-19T12:00:00.000Z',
      orders: [],
      packetTitle: 'Lineage test packet',
      rows: [{
        actionType: 'mapping-only',
        catalogAction: 'link',
        distributorProductId: 'dp-1',
        distributorProductName: 'Blue Dream 3.5g',
        orderIds: [],
        positionIds: [],
        reviewFlags: [],
        siteKey: 'bronx',
        siteLabel: 'Bronx',
      }],
      siteKeys: ['bronx'],
      siteLabels: ['Bronx'],
      stateContext: {},
      summary: {},
    },
    requestId: 'request-1',
    source,
    sourcePath: source === 'import' ? '/tmp/packet.json' : null,
  }
}

function recordingClient(existingPackets: Array<{
  audit_event_id: number | null
  audit_row_count: number | null
  id: number
  row_count: number
}> = []) {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values })
    if (/where p\.job_id = \$1/i.test(text)) return result(existingPackets)
    if (/insert into pending_purchase_packets/i.test(text)) return result([{ id: 74 }])
    if (/insert into pending_purchase_packet_roots/i.test(text)) return result([{ id: 91 }])
    if (/insert into audit_events/i.test(text)) return result([{ id: 123 }])
    return result([])
  })
  return { calls, client: { query } as unknown as PoolClient }
}

describe('persistPendingPurchasePacket refinement lineage', () => {
  beforeEach(() => {
    migrationApplied.mockReset()
  })

  it.each(['generated', 'import'] as const)('creates revision-one lineage for a %s packet', async (source) => {
    migrationApplied.mockResolvedValue(true)
    const { calls, client } = recordingClient()

    const persisted = await persistPendingPurchasePacket(client, input(source))

    expect(persisted).toEqual({ auditEventId: 123, importedRowCount: 1, packetId: 74 })
    expect(migrationApplied).toHaveBeenCalledWith(client)
    expect(calls.map((call) => call.text)).toEqual(expect.arrayContaining([
      expect.stringMatching(/lock table pending_purchase_packets in exclusive mode/i),
      expect.stringMatching(/update pending_purchase_packets[\s\S]*packet_root_id in[\s\S]*root_status = 'active'/i),
      expect.stringMatching(/update pending_purchase_packet_roots[\s\S]*root_status = 'superseded'/i),
      expect.stringMatching(/update pending_purchase_rows[\s\S]*row_lineage_id = 'pprline_' \|\| id::text/i),
      expect.stringMatching(/insert into pending_purchase_packet_roots/i),
      expect.stringMatching(/update pending_purchase_packets[\s\S]*packet_root_id = \$2[\s\S]*revision_number = 1/i),
    ]))
    expect(calls.find((call) => /insert into pending_purchase_packet_roots/i.test(call.text))?.values).toEqual([74, 17])
    expect(calls.find((call) => /packet_root_id = \$2/i.test(call.text))?.values).toEqual([74, 91, 17])
  })

  it('preserves the legacy write path when migration 102 is unavailable', async () => {
    migrationApplied.mockResolvedValue(false)
    const { calls, client } = recordingClient()

    await persistPendingPurchasePacket(client, input())

    const sql = calls.map((call) => call.text).join('\n')
    expect(sql).toMatch(/lock table pending_purchase_packets in exclusive mode/i)
    expect(sql).not.toMatch(/pending_purchase_packet_roots/i)
    expect(sql).not.toMatch(/row_lineage_id/i)
    expect(sql).not.toMatch(/revision_status = 'superseded'/i)
    expect(sql).toMatch(/update pending_purchase_packets[\s\S]*where status = 'ready'/i)
  })

  it('returns the completed packet without superseding or inserting on a same-job retry', async () => {
    migrationApplied.mockResolvedValue(true)
    const { calls, client } = recordingClient([{ audit_event_id: 123, audit_row_count: 1, id: 74, row_count: 1 }])
    const changedRetryInput = input()
    changedRetryInput.packet.rows = []

    await expect(persistPendingPurchasePacket(client, changedRetryInput)).resolves.toEqual({
      auditEventId: 123,
      importedRowCount: 1,
      packetId: 74,
    })

    const sql = calls.map((call) => call.text).join('\n')
    expect(sql).toMatch(/lock table pending_purchase_packets in exclusive mode/i)
    expect(sql).not.toMatch(/set status = 'superseded'/i)
    expect(sql).not.toMatch(/insert into pending_purchase_packets/i)
    expect(sql).not.toMatch(/insert into audit_events/i)
  })

  it('fails loudly when a same-job packet audit count does not match persisted rows', async () => {
    migrationApplied.mockResolvedValue(true)
    const { client } = recordingClient([{ audit_event_id: 123, audit_row_count: 2, id: 74, row_count: 1 }])

    await expect(persistPendingPurchasePacket(client, input())).rejects.toThrow(
      'Pending-purchase job 42 has incomplete persisted packet 74.',
    )
  })

  it('fails loudly when a job already has multiple packets', async () => {
    migrationApplied.mockResolvedValue(true)
    const { client } = recordingClient([
      { audit_event_id: 123, audit_row_count: 1, id: 74, row_count: 1 },
      { audit_event_id: 124, audit_row_count: 1, id: 75, row_count: 1 },
    ])

    await expect(persistPendingPurchasePacket(client, input())).rejects.toThrow(
      'Pending-purchase job 42 already has multiple persisted packets.',
    )
  })

  it('propagates a root insert failure before packet linking or audit', async () => {
    migrationApplied.mockResolvedValue(true)
    const { calls, client } = recordingClient()
    vi.mocked(client.query).mockImplementation(async (text: string, values?: unknown[]) => {
      calls.push({ text, values })
      if (/insert into pending_purchase_packets/i.test(text)) return result([{ id: 74 }])
      if (/insert into pending_purchase_packet_roots/i.test(text)) throw new Error('root insert failed')
      return result([])
    })

    await expect(persistPendingPurchasePacket(client, input())).rejects.toThrow('root insert failed')
    expect(calls.some((call) => /insert into audit_events/i.test(call.text))).toBe(false)
    expect(calls.some((call) => /packet_root_id = \$2/i.test(call.text))).toBe(false)
  })
})
