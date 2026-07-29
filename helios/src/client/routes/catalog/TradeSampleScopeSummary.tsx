import {
  getHeliosPendingPurchaseSiteDealer,
  type TradeSampleLocationSchema,
  type TradeSampleZeroItem,
} from '../../../shared/contracts/index.js'
import type { z } from 'zod'

export function TradeSampleScopeSummary({
  destination,
  items,
  showSource = false,
  siteDealerId,
}: {
  destination: z.infer<typeof TradeSampleLocationSchema>
  items: TradeSampleZeroItem[]
  showSource?: boolean
  siteDealerId: number
}) {
  const site = getHeliosPendingPurchaseSiteDealer(siteDealerId)
  const totalQuantity = items.reduce((sum, item) => sum + item.currentQty, 0)

  return <>
    <p>
      <strong>{site?.siteLabel ?? 'Unknown site'} (dealer #{siteDealerId})</strong><br />
      {items.length} package{items.length === 1 ? '' : 's'} · {totalQuantity} total quantity<br />
      Destination: <strong>{destination.name}</strong> (location #{destination.id}, stock type #{destination.stockTypeId})
    </p>
    <ul style={{ minWidth: 0, paddingInlineStart: '1.25rem' }}>
      {items.map((item) => <li key={item.inventoryItemId} style={{ marginBottom: '0.65rem', overflowWrap: 'anywhere' }}>
        <strong>{item.productName ?? 'Unnamed product'}</strong>{item.productSku ? ` · SKU ${item.productSku}` : ''}<br />
        <span className="subtle-copy">
          Package {item.inventoryItemId} · METRC tag {item.externalTrackCode} · Qty {item.currentQty}
          {showSource ? ` · Source ${item.sourceLocationName} (#${item.sourceLocationId}, stock type #${item.sourceStockTypeId})` : ''}
        </span>
      </li>)}
    </ul>
  </>
}
