# Inventory item quantity adjustment

The operator-verified Sweed contract for zeroing one trade-sample inventory item is:

```json
{
  "name": "store.inventory.item.adjust",
  "params": {
    "reasonId": 20,
    "integrationReasonId": 197,
    "note": "sample use",
    "items": [{ "qty": -12.5, "id": "ITEM_ID", "externalTrackCode": "TAG" }],
    "isInternal": false
  }
}
```

`qty` is a delta, not the resulting quantity, and must be the negative of the live `currentQty`. Helios sends one item per RPC and never retries an unknown failure. Immediately before the write it strictly reads `store.inventory.item.get` and checks the item ID, tag, trade-sample flag, and preview quantity. After a returned success it reads that same item again and requires the exact ID/tag and `currentQty: 0`; absence, malformed data, and every non-zero quantity are unknown outcomes. Dealer context must be pinned through `withSweedSession`; never use a static or embedded credential.
