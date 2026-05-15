/**
 * Input adapter for purchase-triggered catalog updates.
 *
 * Transforms purchase metrics (sell-through, margin, recommended pricing)
 * into catalog update proposals.
 */

import type {
  CatalogUpdateInputAdapter,
  CatalogUpdateTriggerContext,
} from './CatalogUpdateInputAdapter.js'
import type { CatalogUpdateBatchDraft } from '../domain/proposals.js'
import type { PricingLadder } from '../domain/entities.js'
import { getFieldDescriptor } from '../domain/changes.js'

export interface PurchaseMetric {
  sweedGroupId: number
  skuId?: number | null
  siteId: number
  groupName: string
  brandName?: string | null
  currentPrice: number | null
  recommendedPriceLadder: PricingLadder
  wholesaleCost: number | null
  evidence: {
    invoiceIds?: number[]
    sellThroughDays?: number
    last30DaysSales?: number
    onHand?: number
  }
}

export interface PurchasesTriggerPayload {
  purchaseMetrics: PurchaseMetric[]
  runDate: string
  source: string // e.g., 'pending-purchases-v2'
}

export class PurchasesInputAdapter
  implements CatalogUpdateInputAdapter<PurchasesTriggerPayload>
{
  triggerType = 'purchase' as const

  async prepareBatch(
    ctx: CatalogUpdateTriggerContext,
    payload: PurchasesTriggerPayload,
  ): Promise<CatalogUpdateBatchDraft> {
    const rows = payload.purchaseMetrics.map((metric) => ({
      target: {
        entityType: 'catalog_group' as const,
        entityId: null,
        externalKey: {
          provider: 'sweed' as const,
          id: metric.sweedGroupId,
        },
        hierarchy: {
          site: {
            siteId: metric.siteId,
            dealerId: ctx.dealerId,
          },
          catalogId: metric.sweedGroupId,
          brandId: null,
          itemId: metric.skuId ?? null,
        },
      },
      rowTitle: `${metric.brandName ?? 'Unknown Brand'} - ${metric.groupName}`,
      merchandisingContext: {
        brandName: metric.brandName,
        groupName: metric.groupName,
        wholesaleCost: metric.wholesaleCost,
      },
      evidence: metric.evidence,
      lineItems: [
        {
          target: {
            entityType: 'catalog_group' as const,
            entityId: null,
            externalKey: {
              provider: 'sweed' as const,
              id: metric.sweedGroupId,
            },
            hierarchy: {
              site: {
                siteId: metric.siteId,
                dealerId: ctx.dealerId,
              },
              catalogId: metric.sweedGroupId,
              brandId: null,
              itemId: metric.skuId ?? null,
            },
          },
          field: getFieldDescriptor('pricing.ladder'),
          baselineValue: null, // TODO: fetch current ladder from catalog
          suggestedValue: metric.recommendedPriceLadder,
          notes: `Generated from purchase run on ${payload.runDate}`,
          merchandisingContext: {
            wholesaleCost: metric.wholesaleCost,
            sellThroughDays: metric.evidence.sellThroughDays,
          },
          evidence: metric.evidence,
        },
      ],
    }))

    return {
      type: 'pricing',
      triggerType: 'purchase',
      source: payload.source,
      triggerMode: 'auto',
      dealerId: ctx.dealerId,
      siteId: ctx.siteId ?? null,
      createdByUserId: ctx.createdByUserId,
      jobId: ctx.jobId ?? null,
      summary: {
        runDate: payload.runDate,
        totalMetrics: payload.purchaseMetrics.length,
        source: payload.source,
      },
      config: {
        runDate: payload.runDate,
      },
      rows,
    }
  }
}
