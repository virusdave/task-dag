import {
  getHeliosPendingPurchaseSiteDealer,
  type TradeSampleLocationSchema,
  type TradeSampleZeroItem,
} from '../../../shared/contracts/index.js'
import type { z } from 'zod'

export function TradeSampleScopeSummary({
  destination,
  items,
  itemKind,
  showSource = false,
  siteDealerId,
}: {
  destination: z.infer<typeof TradeSampleLocationSchema>
  items: TradeSampleZeroItem[]
  itemKind?: 'fresh live lots' | 'recorded transfer rows' | 'reviewed source rows'
  showSource?: boolean
  siteDealerId: number
}) {
  const site = getHeliosPendingPurchaseSiteDealer(siteDealerId)
  const totalQuantity = items.reduce((sum, item) => sum + item.currentQty, 0)
  const countLabel = itemKind ?? `package${items.length === 1 ? '' : 's'}`

  return <>
    <p>
      <strong>{site?.siteLabel ?? 'Unknown site'} (dealer #{siteDealerId})</strong><br />
      {items.length} {countLabel} · {totalQuantity} total quantity<br />
      Destination: <strong>{destination.name}</strong> (location #{destination.id}, stock type #{destination.stockTypeId})
    </p>
    <ul style={{ minWidth: 0, paddingInlineStart: '1.25rem' }}>
      {items.map((item, index) => <li key={`${item.inventoryItemId}-${index}`} style={{ marginBottom: '0.65rem', overflowWrap: 'anywhere' }}>
        <strong>{item.productName ?? 'Unnamed product'}</strong>{item.productSku ? ` · SKU ${item.productSku}` : ''}<br />
        <span className="subtle-copy">
          Package {item.inventoryItemId} · METRC tag {item.externalTrackCode} · Qty {item.currentQty}
          {showSource ? ` · Source ${item.sourceLocationName} (#${item.sourceLocationId}, stock type #${item.sourceStockTypeId})` : ''}
        </span>
      </li>)}
    </ul>
  </>
}
