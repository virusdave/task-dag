import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { LowInventoryCountCaptureBodySchema } from '../../shared/contracts/index.js'
import { describeRequiresTestDb } from '../__tests__/requiresTestDb.js'
import { getMigrationSentinel } from '../db/pendingMigrations.js'
import { withClient } from '../db/pool.js'
import {
  captureLowInventoryCount,
  classifyLowInventoryCount,
  LowInventoryCountCaptureError,
} from './lowInventoryCounts.js'

function capturedRow() {
  return {
    id: '20c4a7fe-ea9f-45ad-98d2-437d7378579d',
    request_id: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
    dealer_id: '210705',
    inventory_item_id: 'package-1',
    product_id: '101',
    product_sku: 'SKU-1',
    product_name: 'Product',
    physical_qty: '0',
    classification: 'zero-held',
    resolution_status: 'pending',
    actor_user_id: '7',
    actor_email: 'editor@example.com',
    actor_name: 'Editor',
    captured_at: new Date('2026-07-11T14:00:00.000Z'),
    sweed_current_qty: '2',
    sweed_hold_qty: '1',
    sweed_available_qty: '1',
    sweed_stock_location: 'FOR SALE - Midtown',
    sweed_internal_track_code: 'PRE-A-1',
    sweed_metrc_tag: 'TAG-1',
    sweed_observed_at: new Date('2026-07-11T13:55:00.000Z'),
  } as const
}

const actor = {
  active: true,
  email: 'editor@example.com',
  id: 7,
  metricGrants: [],
  name: 'Editor',
  role: 'editor',
} as const

describe('low-inventory physical counts', () => {
  it.each([
    [{ physicalQty: 2, currentQty: 2, holdQty: 0 }, 'equal'],
    [{ physicalQty: 1, currentQty: 2, holdQty: 0 }, 'short'],
    [{ physicalQty: 0, currentQty: 2, holdQty: 0 }, 'zero'],
    [{ physicalQty: 0, currentQty: 2, holdQty: 1 }, 'zero-held'],
    [{ physicalQty: 3, currentQty: 2, holdQty: 0 }, 'over'],
  ] as const)('classifies %o as %s', (input, expected) => {
    expect(classifyLowInventoryCount(input)).toBe(expected)
  })

  it('rejects physical counts finer than the stored thousandth precision', () => {
    expect(LowInventoryCountCaptureBodySchema.safeParse({
      dealerId: 210705,
      inventoryItemId: 'package-1',
      physicalQty: 1.2345,
      requestId: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
    }).success).toBe(false)
  })

  it('writes one immutable actor and Sweed snapshot through a narrow insert-select', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [capturedRow()] }),
    }

    const result = await captureLowInventoryCount({
      actor,
      dealerId: 210705,
      inventoryItemId: 'package-1',
      physicalQty: 0,
      requestId: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
      db,
    })

    expect(result).toMatchObject({
      actor: { email: 'editor@example.com', name: 'Editor', userId: 7 },
      classification: 'zero-held',
      resolutionStatus: 'pending',
      sweedSnapshot: { currentQty: 2, holdQty: 1, metrcTag: 'TAG-1' },
    })
    const sql = String(db.query.mock.calls[0]?.[0])
    expect(sql).toContain('insert into low_inventory_physical_counts')
    expect(sql).toContain('from sweed_package_current c')
    expect(sql).toContain('observed_at_max >= now() - make_interval(mins => $8)')
    expect(sql).not.toContain('store.inventory')
    expect(sql).not.toContain('page_dave')
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [
      210705,
      'package-1',
      0,
      'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
      7,
      'editor@example.com',
      'Editor',
      15,
    ])
  })

  it('fails closed when the package has no eligible current snapshot', async () => {
    await expect(captureLowInventoryCount({
      actor,
      dealerId: 210705,
      inventoryItemId: 'missing',
      physicalQty: 1,
      requestId: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
      db: { query: vi.fn().mockResolvedValue({ rows: [] }) },
    })).rejects.toBeInstanceOf(LowInventoryCountCaptureError)
  })

  it('returns the committed row after a concurrent exact replay', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [capturedRow()] })
    await expect(captureLowInventoryCount({
      actor,
      dealerId: 210705,
      inventoryItemId: 'package-1',
      physicalQty: 0,
      requestId: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
      db: { query },
    })).resolves.toMatchObject({
      id: '20c4a7fe-ea9f-45ad-98d2-437d7378579d',
      requestId: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
    })
    expect(query).toHaveBeenCalledTimes(2)
    expect(String(query.mock.calls[1]?.[0])).toContain('actor_user_id = $2')
  })

  it('rejects a reused request id with different request details without returning the row', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
    await expect(captureLowInventoryCount({
      actor,
      dealerId: 210705,
      inventoryItemId: 'different-package',
      physicalQty: 1,
      requestId: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
      db: { query },
    })).rejects.toMatchObject({ statusCode: 409 })
  })
})

describeRequiresTestDb('low-inventory physical-count schema', () => {
  it('accepts a valid pending held-zero row in an isolated transaction', async () => {
    const schemaSql = readFileSync(
      resolve(process.cwd(), 'src/server/db/schema/lowInventoryPhysicalCounts.sql'),
      'utf8',
    )
    await withClient(async (client) => {
      await client.query('begin')
      try {
        await client.query('create table users (id bigint primary key)')
        await client.query('insert into users (id) values (7)')
        await client.query(schemaSql)
        const inserted = await client.query<{ classification: string; resolution_status: string }>(`
          insert into low_inventory_physical_counts (
            request_id, dealer_id, inventory_item_id, product_id, physical_qty,
            classification, resolution_status, actor_user_id, actor_email,
            actor_name, sweed_current_qty, sweed_hold_qty,
            sweed_stock_location, sweed_observed_at
          ) values (
            'd1dc2c24-bca5-4c44-ad05-07f254e3a554', 210705, 'package-1', 101, 0,
            'zero-held', 'pending', 7, 'editor@example.com',
            'Editor', 2, 1, 'FOR SALE - Midtown', now()
          ) returning classification, resolution_status
        `)
        expect(inserted.rows).toEqual([{ classification: 'zero-held', resolution_status: 'pending' }])
        const sentinel = getMigrationSentinel('103_low_inventory_physical_counts')
        expect(sentinel).not.toBeNull()
        await expect(sentinel!.check(client)).resolves.toBe(true)
        await client.query('alter table low_inventory_physical_counts alter column id drop default')
        await expect(sentinel!.check(client)).resolves.toBe(false)
        await client.query('alter table low_inventory_physical_counts alter column id set default gen_random_uuid()')
        await client.query('alter table low_inventory_physical_counts alter column captured_at drop default')
        await expect(sentinel!.check(client)).resolves.toBe(false)
        await client.query('alter table low_inventory_physical_counts alter column captured_at set default now()')
        await expect(sentinel!.check(client)).resolves.toBe(true)
        await client.query('savepoint invalid_classification')
        await expect(client.query(`
          insert into low_inventory_physical_counts (
            request_id, dealer_id, inventory_item_id, product_id, physical_qty,
            classification, resolution_status, actor_user_id, actor_email,
            actor_name, sweed_current_qty, sweed_stock_location, sweed_observed_at
          ) values (
            '0be30563-c020-49f0-b134-e21c9701e7bb', 210705, 'package-2', 102, 2,
            'short', 'pending', 7, 'editor@example.com',
            'Editor', 2, 'FOR SALE - Midtown', now()
          )
        `)).rejects.toMatchObject({ constraint: 'low_inventory_physical_counts_classification_matches_snapshot' })
        await client.query('rollback to savepoint invalid_classification')
      } finally {
        await client.query('rollback')
      }
    })
  })
})
