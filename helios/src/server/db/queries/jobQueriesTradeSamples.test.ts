import { describe, expect, it, vi } from 'vitest'

import type { Queryable } from '../pool.js'
import { getJobStatus } from './jobQueries.js'

const destination = { id: 88, name: 'NOT FOR SALE - Samples' as const, stockTypeId: 7 }
const items = [
  { currentQty: 2, availableQty: 2, externalTrackCode: 'TAG-44', inventoryItemId: '44', packageLabel: null,
    productId: 9, productName: 'Sample', productSku: null, sourceLocationId: 12, sourceLocationName: 'Back', sourceStockTypeId: 3 },
  { currentQty: 1, availableQty: 1, externalTrackCode: 'TAG-45', inventoryItemId: '45', packageLabel: null,
    productId: 10, productName: 'Sample 2', productSku: null, sourceLocationId: 12, sourceLocationName: 'Back', sourceStockTypeId: 3 },
]

function jobRow(jobType: 'catalog.inventory.stage_trade_samples' | 'catalog.inventory.zero_trade_samples', payload: unknown) {
  return {
    attempt_count: 1,
    catalog_group_id: null,
    created_at: new Date('2026-07-29T10:00:00Z'),
    finished_at: new Date('2026-07-29T10:01:00Z'),
    id: 9,
    job_type: jobType,
    last_error: 'Worker lease expired.',
    module_code: 'catalog',
    payload_json: payload,
    priority: 500,
    requested_by_label: 'Operator',
    requested_by_user_id: 17,
    run_at: new Date('2026-07-29T10:00:00Z'),
    scope_entity_id: null,
    scope_entity_type: null,
    started_at: new Date('2026-07-29T10:00:10Z'),
    status: 'failed',
  }
}

describe('trade sample job status reconstruction', () => {
  it('reconstructs unknown and not-applied zero outcomes after process death', async () => {
    const requestId = 'catalog.inventory.zero_trade_samples:stage:8'
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [jobRow('catalog.inventory.zero_trade_samples', {
        siteDealerId: 210249, destination, items, confirmation: 'I VERIFIED ONLY TRADE SAMPLES',
        stageJobId: 8, actorUserId: 17, requestId,
      })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ entity_id: '210249:44', event_type: 'trade_sample.zero.attempted' }] })

    const result = await getJobStatus({ query } as unknown as Queryable, 9)

    expect(result?.tradeSampleZeroResult).toMatchObject({
      stageJobId: 8,
      outcomes: [
        { inventoryItemId: '44', status: 'failed_unknown' },
        { inventoryItemId: '45', status: 'not_applied_stale' },
      ],
    })
    expect(String(query.mock.calls[1]?.[0])).toContain("entity_type = 'trade_sample_zero_batch'")
  })

  it('reconstructs incomplete staging and never exposes approval after process death', async () => {
    const requestId = 'catalog.inventory.stage_trade_samples:210249:preview'
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [jobRow('catalog.inventory.stage_trade_samples', {
        siteDealerId: 210249, destination, items, digest: 'a'.repeat(64),
        previewId: '123e4567-e89b-42d3-a456-426614174000', confirmation: 'STAGE TRADE SAMPLES',
        actorUserId: 17, requestId,
      })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ entity_id: '210249:44', event_type: 'trade_sample.stage.completed' }] })

    const result = await getJobStatus({ query } as unknown as Queryable, 9)

    expect(result?.tradeSampleStageResult).toMatchObject({
      complete: false,
      outcomes: [
        { inventoryItemId: '44', status: 'completed' },
        { inventoryItemId: '45', status: 'not_applied_stale' },
      ],
    })
  })
})
