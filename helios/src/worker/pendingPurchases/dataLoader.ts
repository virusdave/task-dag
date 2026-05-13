/**
 * Pending Purchases Data Loader
 * Fetches pending purchase orders from Sweed API and prepares for processing
 */

import type { Pool } from 'pg'
import type { HeliosPendingPurchaseSiteDealer } from '../../shared/contracts/domain/pendingPurchases.js'

export interface SweedOrder {
  id: string
  dealerId: number
  distributorId: number
  orderStatusId: number
  positions: SweedOrderPosition[]
  unresolvedPositionCount?: number
}

export interface SweedOrderPosition {
  id: string
  orderId: string
  distributorProductName: string
  quantity: number
  costPerUnit: number
  suggestedProduct: unknown | null
  orderPositionIntegrationData?: {
    wholesalePrice?: number
  }
}

export interface SweedSuggestedProduct {
  orderId: string
  positionId: string
  suggestedProductId: number | null
  suggestedProductName: string | null
}

/**
 * Fetch all pending purchase orders for a site
 */
export async function fetchPendingOrdersForSite(
  sweedClient: unknown, // SweedClient instance
  siteDealer: HeliosPendingPurchaseSiteDealer
): Promise<SweedOrder[]> {
  // Set dealer context
  await (sweedClient as any).call('store.auth.dealer.set', { dealerId: siteDealer.dealerId })
  
  // Verify dealer context
  const dealerCheck = await (sweedClient as any).call('store.auth.dealer.get', {})
  if (dealerCheck.result?.currentDealerId !== siteDealer.dealerId) {
    throw new Error(`Failed to set dealer context to ${siteDealer.dealerId}`)
  }
  
  // Fetch pending orders (orderStatusId = 2)
  const ordersResult = await (sweedClient as any).call('store.purchase.order.list', {
    orderStatusId: 2,
    fromDate: '2026-01-01', // Adjust based on needs
    toDate: '2026-12-31',
    page: 1,
    pageSize: 100,
  })
  
  const orders: SweedOrder[] = ordersResult.result?.data || []
  
  // Fetch details for each order
  const detailedOrders: SweedOrder[] = []
  for (const order of orders) {
    const orderDetail = await (sweedClient as any).call('store.purchase.order.get', { id: order.id })
    const suggestions = await (sweedClient as any).call('store.distributor.product.suggestion', { orderId: order.id })
    
    const orderWithDetails = {
      ...orderDetail.result,
      suggestions: suggestions.result || [],
    }
    
    detailedOrders.push(orderWithDetails)
  }
  
  return detailedOrders
}

/**
 * Filter positions that need catalog mapping
 */
export function filterUnmappedPositions(order: SweedOrder, suggestions: SweedSuggestedProduct[]): SweedOrderPosition[] {
  return order.positions.filter((pos) => {
    const suggestion = suggestions.find((s) => s.positionId === pos.id)
    
    // Include if no suggestion
    if (!suggestion || !suggestion.suggestedProductId) {
      return true
    }
    
    // Include if mapped to placeholder (e.g., "Preroll Samples Samples")
    if (suggestion.suggestedProductName?.includes('Samples')) {
      return true
    }
    
    return false
  })
}

/**
 * Extract cost from position
 * Preference: Metrc wholesale price > costPerUnit
 */
export function extractCostPerUnit(position: SweedOrderPosition): number | null {
  // Try Metrc wholesale price first
  if (position.orderPositionIntegrationData?.wholesalePrice && position.quantity > 0) {
    return position.orderPositionIntegrationData.wholesalePrice / position.quantity
  }
  
  // Fall back to costPerUnit
  if (position.costPerUnit && position.costPerUnit > 0) {
    return position.costPerUnit
  }
  
  return null
}

/**
 * Prepare row for insertion into pending_purchase_rows
 */
export function prepareRowForInsertion(
  packetId: number,
  rowIndex: number,
  siteDealer: HeliosPendingPurchaseSiteDealer,
  order: SweedOrder,
  position: SweedOrderPosition
) {
  return {
    packetId,
    rowIndex,
    siteKey: siteDealer.siteKey,
    siteDealerId: siteDealer.dealerId,
    orderId: order.id,
    positionId: position.id,
    distributorProductName: position.distributorProductName,
    costPerUnit: extractCostPerUnit(position),
    approvalStatus: 'pending' as const,
    applyStatus: 'not_requested' as const,
    createProduct: false, // Will be set during enrichment
    createGroup: false, // Will be set during enrichment
  }
}
