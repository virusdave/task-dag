import { describe, expect, it } from 'vitest'

import {
  CatalogPendingPurchasesApplyJobPayloadSchema,
  CatalogPendingPurchasesQueueRepriceJobPayloadSchema,
} from '../../shared/contracts/index.js'
import { mayIssueCreatedSkuAdd, PENDING_PURCHASE_TEMPORARY_UNSELLABLE_PRICE } from './applyPendingPurchaseRequestJob.js'
import { __test__ } from './queuePendingPurchaseRepriceJob.js'

describe('pending-purchase created SKU repricing contract', () => {
  it('exports the exact global sentinel and keeps compatibility false parseable', () => {
    expect(PENDING_PURCHASE_TEMPORARY_UNSELLABLE_PRICE).toBe(1000.00)
    expect(CatalogPendingPurchasesApplyJobPayloadSchema.parse({
      pendingPurchaseApplyRequestId: 4,
      enqueueMarketRefreshForCreatedProducts: false,
    }).enqueueMarketRefreshForCreatedProducts).toBe(false)
  })

  it('fails closed after an ambiguous external create instead of issuing a second add', () => {
    expect(mayIssueCreatedSkuAdd('group', null)).toBe(true)
    expect(mayIssueCreatedSkuAdd('group', { phase: 'group_create_pending' })).toBe(false)
    expect(mayIssueCreatedSkuAdd('product', { phase: 'group_created' })).toBe(true)
    expect(mayIssueCreatedSkuAdd('product', { phase: 'product_create_pending' })).toBe(false)
    expect(mayIssueCreatedSkuAdd('product', { phase: 'product_create_pending', requestId: 46 }, 46)).toBe(false)
    expect(mayIssueCreatedSkuAdd('product', { phase: 'product_create_pending', requestId: 46 }, 47)).toBe(true)
    expect(mayIssueCreatedSkuAdd('product', { phase: 'product_created' })).toBe(false)
  })

  it('binds queue work to stable row/product identities and rejects checkpoint drift', () => {
    const payload = CatalogPendingPurchasesQueueRepriceJobPayloadSchema.parse({
      createdProducts: [{ productId: 22, rowId: 11 }],
      pendingPurchaseApplyRequestId: 4,
    })
    expect(payload.createdProducts).toEqual([{ productId: 22, rowId: 11 }])
    expect(() => __test__.assertExpectedCreatedRows([
      { group_id: 33, mirror_repair_requested_at: null, product_id: 22, reprice_batch_id: null, row_id: 11 },
    ], new Map([[11, 22]]))).not.toThrow()
    expect(() => __test__.assertExpectedCreatedRows([
      { group_id: 33, mirror_repair_requested_at: null, product_id: 23, reprice_batch_id: null, row_id: 11 },
    ], new Map([[11, 22]]))).toThrow('do not match')
    expect(__test__.CREATED_ROWS_SQL).toContain('pendingPurchaseCreatedSku,productId')
    expect(__test__.CREATED_ROWS_SQL).not.toContain('last_apply_status')
    expect(__test__.CREATED_ROWS_SQL).not.toContain('last_apply_request_id')
  })

  it('requires one mirror mapping to the checkpointed Sweed group for every product', () => {
    const rows = [
      { group_id: 33, mirror_repair_requested_at: null, product_id: 22, reprice_batch_id: null, row_id: 11 },
      { group_id: 44, mirror_repair_requested_at: null, product_id: 23, reprice_batch_id: null, row_id: 12 },
    ]
    expect(__test__.mappingsMatchCreatedRows(rows, [
      { catalog_group_id: 101, product_id: 22, sweed_group_id: 33 },
      { catalog_group_id: 102, product_id: 23, sweed_group_id: 44 },
    ])).toBe(true)
    expect(__test__.mappingsMatchCreatedRows(rows, [
      { catalog_group_id: 101, product_id: 22, sweed_group_id: 999 },
      { catalog_group_id: 102, product_id: 23, sweed_group_id: 44 },
    ])).toBe(false)
    expect(__test__.mappingsMatchCreatedRows(rows, [
      { catalog_group_id: 101, product_id: 22, sweed_group_id: 33 },
    ])).toBe(false)
  })
})
